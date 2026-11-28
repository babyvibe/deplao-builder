package bridge

// DEPLAO_ADAPTER: extra events and message data Deplao shows: thread folders
// (message requests), mute and delete of threads, polls, call logs, Bloks
// template cards and typing / calls in end-to-end encrypted chats. Ids that can
// exceed 2^53 are JSON strings.

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/socket"

	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"go.mau.fi/mautrix-meta/pkg/messagix/bloks"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const (
	EventTypePins               EventType = "pins"
	EventTypeParticipants       EventType = "participants"
	EventTypeParticipantRemoved EventType = "participantRemoved"
	EventTypeContacts           EventType = "contacts"
	EventTypeThreads            EventType = "threads"
	EventTypeThreadMute         EventType = "threadMute"
	EventTypeThreadDeleted      EventType = "threadDeleted"
	EventTypeThreadFolder       EventType = "threadFolder"
	EventTypeCall               EventType = "call"
)

// Messenger folder names (LSDeleteThenInsertThread.FolderName).
const (
	FolderInbox   = "inbox"
	FolderPending = "pending"
	FolderSpam    = "spam"
)

// ThreadUpdate is a thread row with the fields Deplao keeps.
type ThreadUpdate struct {
	ThreadID         string `json:"threadId"`
	Type             int    `json:"type"`
	Name             string `json:"name,omitempty"`
	Snippet          string `json:"snippet,omitempty"`
	LastActivityMs   int64  `json:"lastActivityTimestampMs,omitempty"`
	FolderName       string `json:"folderName,omitempty"`
	ParentThreadKey  int64  `json:"parentThreadKey,omitempty"`
	PictureURL       string `json:"pictureUrl,omitempty"`
	MuteExpireTimeMs int64  `json:"muteExpireTimeMs,omitempty"`
	IsMessageRequest bool   `json:"isMessageRequest,omitempty"`
}

// threadUpdatesOf converts the thread rows of a table.
func threadUpdatesOf(tbl *table.LSTable) []*ThreadUpdate {
	updates := make([]*ThreadUpdate, 0)
	if tbl == nil {
		return updates
	}
	for _, row := range tbl.LSDeleteThenInsertThread {
		if update := threadUpdateFromRow(row); update != nil {
			updates = append(updates, update)
		}
	}
	return append(updates, upsertThreadUpdates(tbl)...)
}

// ThreadInfoResult is a thread's full info as Messenger sent it.
type ThreadInfoResult struct {
	Threads      []*ThreadUpdate       `json:"threads"`
	Participants []*ThreadParticipants `json:"participants"`
	People       []*PersonRow          `json:"people"`
}

// FetchThreadInfo asks Messenger for a thread's full info (name, picture, members) and returns it.
func (c *Client) FetchThreadInfo(threadID int64) (*ThreadInfoResult, error) {
	if err := c.requireMessagix(); err != nil {
		return nil, err
	}
	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.CreateThreadTask{ThreadFBID: threadID, SyncGroup: 1})
	if err != nil {
		return nil, err
	}
	if resp != nil {
		for _, row := range resp.LSDeleteThenInsertThread {
			c.cacheThread(convertThread(row))
		}
	}
	return &ThreadInfoResult{
		Threads:      threadUpdatesOf(resp),
		Participants: c.participantsOf(resp),
		People:       peopleOf(resp),
	}, nil
}

// requestThreadInfoOnce fetches a thread's full info in the background (once per run) and reports it
// as the usual threads / participants / contacts events.
func (c *Client) requestThreadInfoOnce(threadID int64) {
	if _, requested := c.requestedThreadInfo.LoadOrStore(threadID, true); requested {
		return
	}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				c.Logger.Warn().Interface("panic", recovered).Int64("thread_id", threadID).Msg("Thread info request panicked")
			}
		}()
		info, err := c.FetchThreadInfo(threadID)
		if err != nil {
			c.requestedThreadInfo.Delete(threadID)
			c.Logger.Warn().Err(err).Int64("thread_id", threadID).Msg("Could not fetch thread info")
			return
		}
		if len(info.Threads) > 0 {
			c.emitEvent(EventTypeThreads, map[string]any{"threads": info.Threads})
		}
		for _, group := range info.Participants {
			c.emitEvent(EventTypeParticipants, map[string]any{
				"threadId": group.ThreadID, "threadType": group.ThreadType, "members": group.Members,
			})
		}
		if len(info.People) > 0 {
			c.emitEvent(EventTypeContacts, map[string]any{"contacts": info.People})
		}
	}()
}

func threadUpdateFromRow(row *table.LSDeleteThenInsertThread) *ThreadUpdate {
	if row == nil || row.ThreadKey == 0 {
		return nil
	}
	update := &ThreadUpdate{
		ThreadID:         strconv.FormatInt(row.ThreadKey, 10),
		Type:             int(row.ThreadType),
		Name:             row.ThreadName,
		Snippet:          row.Snippet,
		LastActivityMs:   row.LastActivityTimestampMs,
		FolderName:       row.FolderName,
		ParentThreadKey:  row.ParentThreadKey,
		PictureURL:       firstNonEmpty(row.ThreadPictureUrl, row.ThreadPictureUrlFallback),
		MuteExpireTimeMs: row.MuteExpireTimeMs,
		IsMessageRequest: row.FolderName == FolderPending,
	}
	return update
}

// Participant is one member row of a group thread.
type Participant struct {
	ID           string `json:"id"`
	IsAdmin      bool   `json:"isAdmin,omitempty"`
	IsSuperAdmin bool   `json:"isSuperAdmin,omitempty"`
	Nickname     string `json:"nickname,omitempty"`
}

// PersonRow is a person (or Page) Messenger sent with a table: name and picture.
type PersonRow struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// ThreadParticipants are the member rows of one thread in a table.
type ThreadParticipants struct {
	ThreadID string `json:"threadId"`
	// ThreadType of the thread when the table or the cache knows it (0 = unknown).
	ThreadType int            `json:"threadType,omitempty"`
	Members    []*Participant `json:"members"`
}

// participantsOf groups the member rows of a table by thread.
func (c *Client) participantsOf(tbl *table.LSTable) []*ThreadParticipants {
	if tbl == nil || len(tbl.LSAddParticipantIdToGroupThread) == 0 {
		return nil
	}
	types := make(map[int64]int)
	for _, row := range tbl.LSDeleteThenInsertThread {
		if row != nil {
			types[row.ThreadKey] = int(row.ThreadType)
		}
	}
	byThread := make(map[int64]*ThreadParticipants)
	order := make([]int64, 0)
	type memberKey struct{ thread, contact int64 }
	seen := make(map[memberKey]bool)
	for _, row := range tbl.LSAddParticipantIdToGroupThread {
		if row == nil || row.ThreadKey == 0 || row.ContactId == 0 || seen[memberKey{row.ThreadKey, row.ContactId}] {
			continue
		}
		seen[memberKey{row.ThreadKey, row.ContactId}] = true
		group := byThread[row.ThreadKey]
		if group == nil {
			threadType, known := types[row.ThreadKey]
			if !known {
				_, threadType = c.threadMeta(row.ThreadKey)
			}
			group = &ThreadParticipants{ThreadID: strconv.FormatInt(row.ThreadKey, 10), ThreadType: threadType}
			byThread[row.ThreadKey] = group
			order = append(order, row.ThreadKey)
		}
		group.Members = append(group.Members, &Participant{
			ID:           strconv.FormatInt(row.ContactId, 10),
			IsAdmin:      row.IsAdmin || row.IsSuperAdmin,
			IsSuperAdmin: row.IsSuperAdmin,
			Nickname:     strings.TrimSpace(row.Nickname),
		})
	}
	result := make([]*ThreadParticipants, 0, len(order))
	for _, threadKey := range order {
		result = append(result, byThread[threadKey])
	}
	return result
}

// peopleOf returns the people (name, picture) a table carries.
func peopleOf(tbl *table.LSTable) []*PersonRow {
	contacts := make([]*PersonRow, 0)
	if tbl == nil {
		return contacts
	}
	seen := make(map[int64]bool)
	add := func(id int64, name, avatar string) {
		if id == 0 || seen[id] || (strings.TrimSpace(name) == "" && avatar == "") {
			return
		}
		seen[id] = true
		contacts = append(contacts, &PersonRow{ID: strconv.FormatInt(id, 10), Name: strings.TrimSpace(name), AvatarURL: avatar})
	}
	for _, row := range tbl.LSDeleteThenInsertContact {
		if row != nil {
			add(row.Id, row.Name, row.ProfilePictureUrl)
		}
	}
	for _, row := range tbl.LSVerifyContactRowExists {
		if row != nil {
			add(row.ContactId, row.Name, row.ProfilePictureUrl)
		}
	}
	return contacts
}

// emitPeopleTables reports group members (added / removed) and contact rows.
func (c *Client) emitPeopleTables(tbl *table.LSTable) {
	for _, group := range c.participantsOf(tbl) {
		c.emitEvent(EventTypeParticipants, map[string]any{
			"threadId":   group.ThreadID,
			"threadType": group.ThreadType,
			"members":    group.Members,
		})
	}
	for _, row := range tbl.LSRemoveParticipantFromThread {
		if row == nil || row.ThreadKey == 0 || row.ParticipantId == 0 {
			continue
		}
		c.emitEvent(EventTypeParticipantRemoved, map[string]any{
			"threadId": strconv.FormatInt(row.ThreadKey, 10),
			"userId":   strconv.FormatInt(row.ParticipantId, 10),
		})
	}
	if contacts := peopleOf(tbl); len(contacts) > 0 {
		c.emitEvent(EventTypeContacts, map[string]any{"contacts": contacts})
	}
}

// emitThreadTables reports thread rows, mute changes, deletes and folder moves
// of one table. It runs before the table's messages so that a message request
// is known as one when its first message is saved.
func (c *Client) emitThreadTables(tbl *table.LSTable) {
	if tbl == nil {
		return
	}
	c.emitPeopleTables(tbl)
	c.emitPinTables(tbl)
	updates := threadUpdatesOf(tbl)
	// A message in a thread this client has not loaded comes with a verify row only: its folder and
	// type now, the full info (name, picture, members) is requested once for groups.
	listed := make(map[int64]bool, len(tbl.LSDeleteThenInsertThread))
	for _, row := range tbl.LSDeleteThenInsertThread {
		if row != nil {
			listed[row.ThreadKey] = true
		}
	}
	for _, row := range tbl.LSVerifyThreadExists {
		if row == nil || row.ThreadKey == 0 || listed[row.ThreadKey] {
			continue
		}
		updates = append(updates, &ThreadUpdate{
			ThreadID:         strconv.FormatInt(row.ThreadKey, 10),
			Type:             int(row.ThreadType),
			FolderName:       row.FolderName,
			ParentThreadKey:  row.ParentThreadKey,
			IsMessageRequest: row.FolderName == FolderPending,
		})
		if !row.ThreadType.IsOneToOne() {
			c.requestThreadInfoOnce(row.ThreadKey)
		}
	}
	if len(updates) > 0 {
		c.emitEvent(EventTypeThreads, map[string]any{"threads": updates})
	}
	for _, mute := range tbl.LSUpdateThreadMuteSetting {
		if mute == nil || mute.ThreadKey == 0 {
			continue
		}
		c.emitEvent(EventTypeThreadMute, map[string]any{
			"threadId":         strconv.FormatInt(mute.ThreadKey, 10),
			"muteExpireTimeMs": mute.MuteExpireTimeMS,
		})
	}
	for _, deleted := range tbl.LSDeleteThread {
		if deleted == nil || deleted.ThreadKey == 0 {
			continue
		}
		c.emitEvent(EventTypeThreadDeleted, map[string]any{
			"threadId": strconv.FormatInt(deleted.ThreadKey, 10),
		})
	}
	for _, moved := range tbl.LSMoveThreadToInboxAndUpdateParent {
		if moved == nil || moved.ThreadKey == 0 {
			continue
		}
		c.emitEvent(EventTypeThreadFolder, map[string]any{
			"threadId":        strconv.FormatInt(moved.ThreadKey, 10),
			"folderName":      FolderInbox,
			"parentThreadKey": moved.ParentThreadKey,
		})
	}
	c.emitThreadExtras(tbl)
	c.emitIncomingThreadTables(tbl)
}

// PinnedRef is one pinned message of a thread.
type PinnedRef struct {
	MessageID  string `json:"messageId"`
	PinnedAtMs int64  `json:"pinnedAtMs"`
}

// emitPinTables reports pinned messages: a clear row starts a full list of the
// thread's pins; a pin row with no time is an unpin.
func (c *Client) emitPinTables(tbl *table.LSTable) {
	if len(tbl.LSClearPinnedMessages) == 0 && len(tbl.LSSetPinnedMessage) == 0 {
		return
	}
	type pinChange struct {
		clear    bool
		pinned   []*PinnedRef
		unpinned []string
	}
	byThread := make(map[int64]*pinChange)
	order := make([]int64, 0)
	get := func(threadKey int64) *pinChange {
		change := byThread[threadKey]
		if change == nil {
			change = &pinChange{}
			byThread[threadKey] = change
			order = append(order, threadKey)
		}
		return change
	}
	for _, row := range tbl.LSClearPinnedMessages {
		if row != nil && row.ThreadKey != 0 {
			get(row.ThreadKey).clear = true
		}
	}
	for _, row := range tbl.LSSetPinnedMessage {
		if row == nil || row.ThreadKey == 0 || row.MessageId == "" {
			continue
		}
		change := get(row.ThreadKey)
		if row.PinnedTimestampMs > 0 {
			change.pinned = append(change.pinned, &PinnedRef{MessageID: row.MessageId, PinnedAtMs: row.PinnedTimestampMs})
		} else {
			change.unpinned = append(change.unpinned, row.MessageId)
		}
	}
	for _, threadKey := range order {
		change := byThread[threadKey]
		c.emitEvent(EventTypePins, map[string]any{
			"threadId": strconv.FormatInt(threadKey, 10),
			"clear":    change.clear,
			"pinned":   change.pinned,
			"unpinned": change.unpinned,
		})
	}
}

// PollChoice is one option of a poll.
type PollChoice struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// PollVote is one option a voter added or removed.
type PollVote struct {
	OptionID  string `json:"optionId"`
	VoterID   string `json:"voterId"`
	VoteCount int64  `json:"voteCount,omitempty"`
}

// PollInfo is attached to the admin message that created or changed a poll.
// EventType: 1 created, 2 option added and voted, 3 option added, 4 vote,
// 5 several changes (table.PollEventType).
type PollInfo struct {
	PollID          string        `json:"pollId"`
	EventType       int64         `json:"eventType"`
	Question        string        `json:"question,omitempty"`
	Options         []*PollChoice `json:"options,omitempty"`
	OptionsComplete bool          `json:"optionsComplete,omitempty"`
	Votes           []*PollVote   `json:"votes,omitempty"`
	Removals        []*PollVote   `json:"removals,omitempty"`
}

func pollVotes(rows []*table.LSAddPollVote) []*PollVote {
	if len(rows) == 0 {
		return nil
	}
	votes := make([]*PollVote, 0, len(rows))
	for _, row := range rows {
		if row == nil || row.OptionID == 0 {
			continue
		}
		votes = append(votes, &PollVote{
			OptionID:  strconv.FormatInt(row.OptionID, 10),
			VoterID:   strconv.FormatInt(row.ContactID, 10),
			VoteCount: row.VoteCount,
		})
	}
	return votes
}

// pollInfoOf returns the poll data of a wrapped message, nil when it has none.
func pollInfoOf(msg *table.WrappedMessage) *PollInfo {
	if msg == nil || msg.PollID == 0 {
		return nil
	}
	info := &PollInfo{
		PollID:          strconv.FormatInt(msg.PollID, 10),
		EventType:       int64(msg.PollEventType),
		Question:        strings.TrimSpace(msg.PollQuestion),
		OptionsComplete: msg.PollOptionsComplete,
		Votes:           pollVotes(msg.PollVotes),
		Removals:        pollVotes(msg.PollRemovals),
	}
	for _, option := range msg.PollOptions {
		info.Options = append(info.Options, &PollChoice{
			ID:   strconv.FormatInt(option.OptionID, 10),
			Text: option.Text,
		})
	}
	return info
}

// isCallLogXMA reports the XMA Messenger uses for call logs ("xma_rtc_…").
func isCallLogXMA(xma *table.WrappedXMA) bool {
	return xma != nil && xma.CTA != nil && strings.HasPrefix(xma.CTA.Type_, "xma_rtc_")
}

// callLogAttachment turns a call log XMA into a "call" attachment.
func callLogAttachment(xma *table.WrappedXMA) *Attachment {
	kind := xma.CTA.Type_
	callType := "audio"
	if strings.Contains(kind, "video") {
		callType = "video"
	}
	return &Attachment{
		Type:     "call",
		Title:    strings.TrimSpace(xma.TitleText),
		Subtitle: strings.TrimSpace(xma.SubtitleText),
		XmaType:  kind,
		CallType: callType,
		Missed:   strings.Contains(kind, "_missed_"),
	}
}

// boundedXmaType keeps the XMA type label short: XmaDataclass can hold a whole
// JSON template.
func boundedXmaType(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || strings.HasPrefix(value, "{") {
			continue
		}
		if len(value) > 120 {
			value = value[:120]
		}
		return value
	}
	return ""
}

type xmaTemplateDataclass struct {
	Content struct {
		CustomTemplateData *struct {
			Payload string `json:"payload"`
		} `json:"custom_template_data"`
	} `json:"content"`
}

// bloksCard is what a Bloks XMA template shows: its texts, the texts of its
// reply buttons, a link and an image.
type bloksCard struct {
	Lines    []string
	Buttons  []string
	URL      string
	ImageURL string
}

func findBloksCall(node *bloks.BloksScriptNode, fn bloks.BloksFunctionID) *bloks.BloksScriptFuncall {
	if node == nil {
		return nil
	}
	call, ok := node.Content.(*bloks.BloksScriptFuncall)
	if !ok {
		return nil
	}
	if call.Function == fn {
		return call
	}
	for idx := range call.Args {
		if found := findBloksCall(&call.Args[idx], fn); found != nil {
			return found
		}
	}
	return nil
}

func findBloksOnClick(comp *bloks.BloksTreeComponent, fn bloks.BloksFunctionID) *bloks.BloksScriptFuncall {
	script := comp.GetScript("on_click")
	if script == nil {
		return nil
	}
	return findBloksCall(&script.AST, fn)
}

// parseBloksCard reads a custom Bloks template (same reading as mautrix-meta
// msgconv xmaBloksTemplateToMatrix). It never panics: a template it cannot read
// returns nil.
func parseBloksCard(dataclass string) (card *bloksCard) {
	if !strings.Contains(dataclass, "custom_template_data") {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "panic while reading a Bloks card: %v\n%s\n", recovered, debug.Stack())
			card = nil
		}
	}()
	var dc xmaTemplateDataclass
	if err := json.Unmarshal([]byte(dataclass), &dc); err != nil || dc.Content.CustomTemplateData == nil {
		return nil
	}
	var bundle bloks.BloksBundle
	if err := json.Unmarshal([]byte(dc.Content.CustomTemplateData.Payload), &bundle); err != nil {
		return nil
	}
	card = &bloksCard{}
	texts := bundle.FindDescendants(func(comp *bloks.BloksTreeComponent) bool {
		return comp.ComponentID == "bk.components.Text"
	})
	for _, text := range texts {
		str := strings.TrimSpace(text.GetAttribute("text"))
		if str == "" {
			continue
		}
		isButton := text.FindAncestor(func(comp *bloks.BloksTreeComponent) bool {
			return findBloksOnClick(comp, "bk.action.xs.SendTextMessageCTA") != nil
		}) != nil
		if isButton {
			card.Buttons = append(card.Buttons, str)
		} else {
			card.Lines = append(card.Lines, str)
		}
	}
	bundle.FindDescendant(func(comp *bloks.BloksTreeComponent) bool {
		if call := findBloksOnClick(comp, "bk.action.navigation.OpenUrlV2"); call != nil && len(call.Args) > 0 {
			if lit, ok := call.Args[0].Content.(*bloks.BloksScriptLiteral); ok {
				card.URL, _ = lit.Value().(string)
			}
		}
		return card.URL != ""
	})
	if image := bundle.FindDescendant(func(comp *bloks.BloksTreeComponent) bool {
		return comp.ComponentID == "bk.components.Image"
	}); image != nil {
		card.ImageURL = image.GetAttribute("url")
	}
	if len(card.Lines) == 0 && len(card.Buttons) == 0 && card.ImageURL == "" {
		return nil
	}
	return card
}

// applyBloksCard fills an empty template attachment from its Bloks payload.
func applyBloksCard(att *Attachment, dataclass string) bool {
	card := parseBloksCard(dataclass)
	if card == nil {
		return false
	}
	if len(card.Lines) > 0 {
		if att.Title == "" {
			att.Title = card.Lines[0]
			card.Lines = card.Lines[1:]
		}
		if len(card.Lines) > 0 && att.Body == "" {
			att.Body = strings.Join(card.Lines, "\n")
		}
	}
	for _, title := range card.Buttons {
		att.Buttons = append(att.Buttons, &TemplateButton{Title: title, Type: "xma_quick_reply"})
	}
	if att.URL == "" {
		att.URL = normalizeActionURL(card.URL)
	}
	if att.ImageURL == "" {
		att.ImageURL = card.ImageURL
	}
	return true
}

// CallEvent is a call log of an end-to-end encrypted chat (missed or ended).
type CallEvent struct {
	ID          string `json:"id"`
	ThreadID    string `json:"threadId"`
	ChatJID     string `json:"chatJid"`
	ActorID     string `json:"actorId"`
	CallType    string `json:"callType"`
	EventType   string `json:"eventType"`
	DurationSec int64  `json:"durationSec,omitempty"`
	TimestampMs int64  `json:"timestampMs"`
}

func jidUserID(jid waTypes.JID) string {
	user := jid.User
	if cut := strings.IndexAny(user, ".:"); cut >= 0 {
		user = user[:cut]
	}
	return user
}

// handleE2EEExtras covers whatsmeow events fbchat-v2 ignores. It returns true
// when it handled the event.
func (c *Client) handleE2EEExtras(evt interface{}) bool {
	switch e := evt.(type) {
	case *events.Connected:
		// A reconnected socket starts "unavailable": restore what Deplao asked for (the usual handler still runs)
		if c.e2eeAvailable.Load() {
			go func() {
				if err := c.SetE2EEPresence(true); err != nil {
					c.Logger.Warn().Err(err).Msg("Could not restore the encrypted presence")
				}
			}()
		}
		return false
	case *events.FBMessage:
		// The chat's disappearing timer; the message itself goes the usual way
		c.noteMessageTimer(e)
		return false
	case *events.Message:
		// WhatsApp-format messages are not shown for Messenger accounts: reported for the log
		c.reportWAMessage(e)
		return false
	case *events.GroupInfo:
		c.emitE2EEGroupInfo(e)
		return true
	case *events.UndecryptableMessage:
		// A placeholder the re-sent copy replaces (deplao_incoming.go); the usual diagnostic still follows
		if placeholder := undecryptablePlaceholder(e); placeholder != nil {
			c.emitEvent(EventTypeE2EEMessage, placeholder)
		}
		return false
	case *events.ChatPresence:
		threadID, err := strconv.ParseInt(jidUserID(e.Chat), 10, 64)
		if err != nil {
			return true
		}
		senderID, _ := strconv.ParseInt(jidUserID(e.Sender), 10, 64)
		c.emitEvent(EventTypeTyping, &TypingEvent{
			ThreadID: threadID,
			SenderID: senderID,
			IsTyping: e.State == waTypes.ChatPresenceComposing,
		})
		return true
	case *events.FBCallEvent:
		if e.EventType != "missed" && e.EventType != "ended" {
			return true
		}
		callType := "audio"
		if e.CallType == "video" {
			callType = "video"
		}
		id := e.ParentID
		if id == "" {
			id = e.ID
		}
		at := e.Timestamp
		if at.IsZero() {
			at = time.Now()
		}
		c.emitEvent(EventTypeCall, &CallEvent{
			ID:          "call-" + id,
			ThreadID:    jidUserID(e.Chat),
			ChatJID:     e.Chat.String(),
			ActorID:     jidUserID(e.Actor),
			CallType:    callType,
			EventType:   e.EventType,
			DurationSec: int64(e.Duration / time.Second),
			TimestampMs: at.UnixMilli(),
		})
		return true
	}
	return false
}
