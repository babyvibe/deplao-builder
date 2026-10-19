package bridge

// DEPLAO_ADAPTER: per-thread message history.
//
// fbchat-v2 has no history fetch: its bridge only reloads the inbox page
// (LoadMessagesPage = roughly the last message of recent threads) and drops
// range-backed upserts as backfill. Messenger web loads older messages with
// the LightSpeed FetchMessagesTask (label 228), anchored on a timestamp and a
// message id; the answer arrives later in the event stream as an upsert batch
// (LSUpsertMessage + LSInsertNewMessageRange) or, when nothing is left, as
// LSUpdateExistingMessageRange. This mirrors mautrix-meta's backfill collector
// (meta/pkg/connector/backfill.go) but returns one page per call so the app can
// stop at the start of the time range the user picked and save page by page.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// HistoryPage is one page of a thread's history, newest first.
type HistoryPage struct {
	ThreadID       string     `json:"threadId"`
	Messages       []*Message `json:"messages"`
	HasMoreBefore  bool       `json:"hasMoreBefore"`
	MinTimestampMs int64      `json:"minTimestampMs"`
	MinMessageID   string     `json:"minMessageId,omitempty"`
}

type historyCollector struct {
	mu       sync.Mutex
	messages []*Message
	seen     map[string]bool
	rangeSet bool
	hasMore  bool
	minTs    int64
	minID    string
	// referenceTs is the ReferenceTimestampMs of the request; an "existing
	// range" answer carries it back (mautrix-meta ignores ranges that differ).
	referenceTs int64
	// endedBy records how the page completed, for the diagnostic log line.
	endedBy string
	done    chan struct{}
	once    sync.Once
}

func newHistoryCollector() *historyCollector {
	return &historyCollector{seen: map[string]bool{}, done: make(chan struct{})}
}

func (h *historyCollector) finish() {
	h.once.Do(func() { close(h.done) })
}

func (c *Client) historyCollector(threadID int64) *historyCollector {
	c.historyMu.Lock()
	defer c.historyMu.Unlock()
	if c.historyCollectors == nil {
		return nil
	}
	return c.historyCollectors[threadID]
}

// deliverHistory hands the range-backed upserts of a table to the thread's
// waiting history request (if any). Called for every table from the event
// stream and for the direct task response.
func (c *Client) deliverHistory(tbl *table.LSTable, upsert map[int64]*table.UpsertMessages, extras *tableExtras) {
	if tbl == nil {
		return
	}
	c.historyMu.Lock()
	active := len(c.historyCollectors) > 0
	c.historyMu.Unlock()
	if !active {
		return
	}
	for threadID, batch := range upsert {
		collector := c.historyCollector(threadID)
		if collector == nil || batch == nil {
			continue
		}
		collector.mu.Lock()
		for _, wrapped := range batch.Messages {
			if wrapped == nil || wrapped.MessageId == "" || collector.seen[wrapped.MessageId] {
				continue
			}
			collector.seen[wrapped.MessageId] = true
			collector.messages = append(collector.messages, c.convertWrappedMessage(wrapped, extras))
		}
		if batch.Range != nil {
			collector.rangeSet = true
			collector.hasMore = batch.Range.HasMoreBefore
			collector.minTs = batch.Range.MinTimestampMs
			collector.minID = batch.Range.MinMessageId
		}
		if collector.endedBy == "" {
			collector.endedBy = "range"
		}
		collector.mu.Unlock()
		collector.finish()
	}
	for _, rng := range tbl.LSUpdateExistingMessageRange {
		if rng == nil {
			continue
		}
		collector := c.historyCollector(rng.ThreadKey)
		if collector == nil {
			continue
		}
		collector.mu.Lock()
		if collector.referenceTs != 0 && rng.TimestampMS != 0 && rng.TimestampMS != collector.referenceTs {
			// Not the answer to this request (same rule as mautrix-meta's
			// handleUpdateExistingMessageRange): keep waiting.
			collector.mu.Unlock()
			c.Logger.Info().Int64("thread", rng.ThreadKey).Int64("range_ts", rng.TimestampMS).
				Int64("reference_ts", collector.referenceTs).Msg("History: ignored existing-range answer for another anchor")
			continue
		}
		if len(collector.messages) == 0 {
			// Nothing older than the anchor: the start of the chat is reached.
			collector.rangeSet = true
			collector.hasMore = false
		}
		if collector.endedBy == "" {
			collector.endedBy = "existing_range"
		}
		collector.mu.Unlock()
		collector.finish()
	}
	// WrapMessages drops upserts whose table has no message range for the
	// thread; log them for a waiting request so a missing page shows up in the
	// logs instead of a silent timeout.
	orphans := map[int64]int{}
	for _, msg := range tbl.LSUpsertMessage {
		if msg == nil || upsert[msg.ThreadKey] != nil || c.historyCollector(msg.ThreadKey) == nil {
			continue
		}
		orphans[msg.ThreadKey]++
	}
	for threadID, count := range orphans {
		c.Logger.Info().Int64("thread", threadID).Int("messages", count).
			Msg("History: upserts without a message range while a page is pending (not used)")
	}
}

// FetchThreadHistory returns one page of messages older than (beforeTs,
// beforeID). beforeTs <= 0 means "now" (the newest page).
func (c *Client) FetchThreadHistory(ctx context.Context, threadID, beforeTs int64, beforeID string, timeout time.Duration) (*HistoryPage, error) {
	if threadID == 0 {
		return nil, errors.New("threadId is required")
	}
	if err := c.lifecycleError(); err != nil {
		return nil, err
	}
	if c.Messagix == nil {
		return nil, errors.New("Messenger client is not initialised")
	}
	if !c.regularConnected.Load() {
		return nil, errors.New("Messenger LightSpeed socket is not connected")
	}
	if beforeTs <= 0 {
		beforeTs = time.Now().UnixMilli()
	}
	if timeout <= 0 {
		timeout = 25 * time.Second
	}

	collector := newHistoryCollector()
	collector.referenceTs = beforeTs
	c.historyMu.Lock()
	if c.historyCollectors == nil {
		c.historyCollectors = map[int64]*historyCollector{}
	}
	if _, busy := c.historyCollectors[threadID]; busy {
		c.historyMu.Unlock()
		return nil, fmt.Errorf("history request already running for thread %d", threadID)
	}
	c.historyCollectors[threadID] = collector
	c.historyMu.Unlock()
	defer func() {
		c.historyMu.Lock()
		if c.historyCollectors[threadID] == collector {
			delete(c.historyCollectors, threadID)
		}
		c.historyMu.Unlock()
	}()

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := c.Messagix.ExecuteTasks(reqCtx, &socket.FetchMessagesTask{
		ThreadKey:            threadID,
		Direction:            0,
		ReferenceTimestampMs: beforeTs,
		ReferenceMessageId:   beforeID,
		SyncGroup:            1,
		Cursor:               c.Messagix.GetCursor(1),
	})
	if err != nil {
		return nil, fmt.Errorf("fetch messages task: %w", err)
	}
	if resp != nil {
		upsert, _ := resp.WrapMessages()
		c.deliverHistory(resp, upsert, newTableExtras(resp))
	}

	select {
	case <-collector.done:
	case <-reqCtx.Done():
		c.Logger.Warn().Int64("thread", threadID).Int64("reference_ts", beforeTs).Bool("reference_id", beforeID != "").
			Msg("History: timed out waiting for Messenger history")
		return nil, errors.New("timed out waiting for Messenger history")
	}

	collector.mu.Lock()
	defer collector.mu.Unlock()
	c.Logger.Info().Int64("thread", threadID).Int64("reference_ts", beforeTs).Bool("reference_id", beforeID != "").
		Int("messages", len(collector.messages)).Bool("range", collector.rangeSet).Bool("has_more_before", collector.hasMore).
		Str("ended_by", collector.endedBy).Msg("History page")
	page := &HistoryPage{
		ThreadID:       strconv.FormatInt(threadID, 10),
		Messages:       append([]*Message(nil), collector.messages...),
		HasMoreBefore:  collector.hasMore,
		MinTimestampMs: collector.minTs,
		MinMessageID:   collector.minID,
	}
	sort.SliceStable(page.Messages, func(i, j int) bool { return page.Messages[i].TimestampMs > page.Messages[j].TimestampMs })
	if !collector.rangeSet && len(page.Messages) > 0 {
		oldest := page.Messages[len(page.Messages)-1]
		page.MinTimestampMs, page.MinMessageID, page.HasMoreBefore = oldest.TimestampMs, oldest.ID, true
	}
	if page.Messages == nil {
		page.Messages = []*Message{}
	}
	return page, nil
}
