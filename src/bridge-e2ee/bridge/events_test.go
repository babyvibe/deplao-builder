package bridge

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/whatsmeow/types/events"
)

func newEventPipelineTestClient(t *testing.T, liveCutoffMs int64) *Client {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Client{
		eventChan:           make(chan *Event, 16),
		ctx:                 ctx,
		cancel:              cancel,
		threadCache:         make(map[int64]*Thread),
		recentMessages:      make(map[string]recentMessageEvent),
		liveMessageCutoffMs: liveCutoffMs,
	}
}

func TestHandleSocketErrorsWithoutUnderlyingError(t *testing.T) {
	tests := []struct {
		name  string
		event any
		code  int
	}{
		{name: "socket disconnected", event: &messagix.TransientDisconnectEvent{}},
		{name: "permanent failure", event: &messagix.PermanentErrorEvent{}, code: 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := newEventPipelineTestClient(t, 0)
			client.regularConnected.Store(true)
			client.handleMessagixEvent(context.Background(), test.event)
			if client.IsConnected() {
				t.Fatal("client remained connected after a socket failure")
			}

			raw := <-client.eventChan
			if raw.Type != EventTypeRaw {
				t.Fatalf("first event type = %q, want %q", raw.Type, EventTypeRaw)
			}
			diagnostic := <-client.eventChan
			if diagnostic.Type != EventTypeError {
				t.Fatalf("diagnostic event type = %q, want %q", diagnostic.Type, EventTypeError)
			}
			errorEvent, ok := diagnostic.Data.(*ErrorEvent)
			if !ok || errorEvent.Message == "" || errorEvent.Code != test.code {
				t.Fatalf("diagnostic event data = %#v, want fallback message and code %d", diagnostic.Data, test.code)
			}
		})
	}
}

func TestHandleE2EEUndecryptableMessageEmitsDiagnostic(t *testing.T) {
	client := newEventPipelineTestClient(t, timeNowMs()-1_000)
	client.handleE2EEEvent(&events.UndecryptableMessage{})

	raw := <-client.eventChan
	if raw.Type != EventTypeRaw {
		t.Fatalf("first event type = %q, want %q", raw.Type, EventTypeRaw)
	}
	diagnostic := <-client.eventChan
	if diagnostic.Type != EventTypeError {
		t.Fatalf("diagnostic event type = %q, want %q", diagnostic.Type, EventTypeError)
	}
	errorEvent, ok := diagnostic.Data.(*ErrorEvent)
	if !ok || errorEvent.Code != 2 {
		t.Fatalf("diagnostic event data = %#v, want decrypt error", diagnostic.Data)
	}
}

func TestHandleTableEmitsRecentStandaloneUpsert(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{{
		MessageId:   "mid.live",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "/ping",
		TimestampMs: now,
	}}})

	select {
	case event := <-client.eventChan:
		if event.Type != EventTypeMessage {
			t.Fatalf("event type = %q, want %q", event.Type, EventTypeMessage)
		}
		message, ok := event.Data.(*Message)
		if !ok || message.ID != "mid.live" || message.Text != "/ping" {
			t.Fatalf("event data = %#v, want converted live message", event.Data)
		}
	default:
		t.Fatal("recent standalone upsert did not emit a message event")
	}
}

func TestHandleTableDoesNotEmitRangeBackedOrStaleUpserts(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{
		LSInsertNewMessageRange: []*table.LSInsertNewMessageRange{{ThreadKey: 100}},
		LSUpsertMessage: []*table.LSUpsertMessage{
			{
				MessageId:   "mid.backfill",
				ThreadKey:   100,
				SenderId:    200,
				Text:        "/old-command",
				TimestampMs: now,
			},
			{
				MessageId:   "mid.stale",
				ThreadKey:   101,
				SenderId:    200,
				Text:        "/old-command",
				TimestampMs: now - 2_000,
			},
		},
	})

	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d message events for backfill/stale upserts, want 0", got)
	}
}

func TestCollectInitialDataPreservesHistoryWithoutLiveEvent(t *testing.T) {
	client := newEventPipelineTestClient(t, timeNowMs()-1_000)
	data := client.collectInitialData(&table.LSTable{
		LSDeleteThenInsertThread: []*table.LSDeleteThenInsertThread{{
			ThreadKey:  100,
			ThreadName: "History chat",
		}},
		LSInsertNewMessageRange: []*table.LSInsertNewMessageRange{{ThreadKey: 100}},
		LSUpsertMessage: []*table.LSUpsertMessage{{
			MessageId:   "mid.history",
			ThreadKey:   100,
			SenderId:    200,
			Text:        "old message",
			TimestampMs: timeNowMs() - 10_000,
		}},
	})

	if len(data.Threads) != 1 || data.Threads[0].ID != 100 {
		t.Fatalf("history threads = %#v, want one cached thread", data.Threads)
	}
	if len(data.Messages) != 1 || data.Messages[0].ID != "mid.history" {
		t.Fatalf("history messages = %#v, want the range-backed message", data.Messages)
	}
	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d live events while collecting history, want 0", got)
	}
}

func TestHandleTableRejectsOldUpsertOnLongLivedConnection(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-int64(time.Hour/time.Millisecond))
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{{
		MessageId:   "mid.old-live",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "/old-command",
		TimestampMs: now - int64(10*time.Minute/time.Millisecond),
	}}})

	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d events for old standalone upsert, want 0", got)
	}
}

func TestHandleTableRejectsStandaloneUpsertBeforeRealtimeWindow(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, 0)
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{{
		MessageId:   "mid.before-connect",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "/ping",
		TimestampMs: now,
	}}})

	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d events before realtime window opened, want 0", got)
	}
}

func TestInitialRealtimeWindowDoesNotReplayPreConnectUpsert(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, 0)
	client.openRealtimeMessageWindow(0)
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{{
		MessageId:   "mid.before-start",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "/old-command",
		TimestampMs: now - 1_000,
	}}})

	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d events for pre-connect upsert, want 0", got)
	}
}

func TestHandleTableEmitsEmptyIDInsertOnlyOnce(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{
		ThreadKey:   100,
		SenderId:    200,
		Text:        "no id",
		TimestampMs: now,
	}}})

	if got := len(client.eventChan); got != 1 {
		t.Fatalf("emitted %d events for one empty-ID insert, want 1", got)
	}
}

func TestConvertThumbsUpDoesNotMutateWrappedMessage(t *testing.T) {
	client := newEventPipelineTestClient(t, timeNowMs()-1_000)
	wrapped := &table.WrappedMessage{
		LSInsertMessage: &table.LSInsertMessage{MessageId: "mid.thumb"},
		Stickers: []*table.LSInsertStickerAttachment{{
			TargetId: facebookThumbsUpSmallStickerID,
		}},
	}

	converted := client.convertWrappedMessage(wrapped, nil)

	if converted.Text != "👍" || len(converted.Attachments) != 0 {
		t.Fatalf("converted thumbs-up = %#v, want emoji without sticker", converted)
	}
	if wrapped.Text != "" || len(wrapped.Stickers) != 1 {
		t.Fatalf("converter mutated wrapped input: %#v", wrapped)
	}
}

func TestHandleTableRejectsInvalidStandaloneUpserts(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{
		{ThreadKey: 100, SenderId: 200, TimestampMs: now},
		{MessageId: "mid.no-thread", SenderId: 200, TimestampMs: now},
		{MessageId: "mid.no-sender", ThreadKey: 100, TimestampMs: now},
		{
			MessageId:   "mid.unsent",
			ThreadKey:   100,
			SenderId:    200,
			TimestampMs: now,
			IsUnsent:    true,
		},
	}})

	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d message events for invalid upserts, want 0", got)
	}
}

func TestHandleTableDeduplicatesUpsertAndInsertMessageID(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{
		LSUpsertMessage: []*table.LSUpsertMessage{{
			MessageId:   "mid.same",
			ThreadKey:   100,
			SenderId:    200,
			Text:        "upsert",
			TimestampMs: now,
		}},
		LSInsertMessage: []*table.LSInsertMessage{{
			MessageId:   "mid.same",
			ThreadKey:   100,
			SenderId:    200,
			Text:        "insert",
			TimestampMs: now,
		}},
	})

	if got := len(client.eventChan); got != 1 {
		t.Fatalf("emitted %d events for duplicate message ID, want 1", got)
	}
	event := <-client.eventChan
	message := event.Data.(*Message)
	if message.Text != "insert" {
		t.Fatalf("deduplicated message text = %q, want insert payload", message.Text)
	}

	client.handleTable(&table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{
		MessageId:   "mid.same",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "replayed",
		TimestampMs: now,
	}}})
	if got := len(client.eventChan); got != 0 {
		t.Fatalf("emitted %d events for cross-table duplicate, want 0", got)
	}
}

func TestAuthoritativeInsertSupersedesEarlierStandaloneUpsert(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(&table.LSTable{LSUpsertMessage: []*table.LSUpsertMessage{{
		MessageId:   "mid.upgraded",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "Encrypted placeholder",
		TimestampMs: now,
	}}})

	first := <-client.eventChan
	if message := first.Data.(*Message); message.Text != "Encrypted placeholder" {
		t.Fatalf("standalone payload text = %q", message.Text)
	}

	client.handleTable(&table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{
		MessageId:   "mid.upgraded",
		ThreadKey:   100,
		SenderId:    200,
		Text:        "/ping",
		TimestampMs: now,
	}}})

	if got := len(client.eventChan); got != 1 {
		t.Fatalf("authoritative insert emitted %d events, want 1", got)
	}
	upgraded := (<-client.eventChan).Data.(*Message)
	if upgraded.Text != "/ping" {
		t.Fatalf("authoritative payload text = %q, want /ping", upgraded.Text)
	}
}
