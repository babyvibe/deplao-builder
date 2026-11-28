package bridge

import (
	"context"
	"testing"
	"time"

	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func TestParseFBIDAcceptsJIDs(t *testing.T) {
	cases := map[string]int64{
		"100012345678901":          100012345678901,
		" 42 ":                     42,
		"100012345678901@msgr":     100012345678901,
		"100012345678901.0:5@msgr": 100012345678901,
	}
	for raw, want := range cases {
		got, err := ParseFBID(raw)
		if err != nil || got != want {
			t.Fatalf("ParseFBID(%q) = %d, %v; want %d", raw, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "-5", "0"} {
		if _, err := ParseFBID(bad); err == nil {
			t.Fatalf("ParseFBID(%q) accepted a bad id", bad)
		}
	}
}

func TestThreadSyncGroup(t *testing.T) {
	if got := ThreadSyncGroup(int64(table.ONE_TO_ONE), false); got != 1 {
		t.Fatalf("ordinary 1:1 sync group = %d", got)
	}
	if got := ThreadSyncGroup(int64(table.ENCRYPTED_OVER_WA_ONE_TO_ONE), false); got != e2eeSyncGroup {
		t.Fatalf("encrypted 1:1 sync group = %d", got)
	}
	if got := ThreadSyncGroup(0, true); got != e2eeSyncGroup {
		t.Fatalf("encrypted flag sync group = %d", got)
	}
}

func TestPersonFromSearchRow(t *testing.T) {
	person := personFromSearchRow(&table.LSInsertSearchResult{
		ResultId:         "100012345678901",
		Type_:            table.SearchTypeNonContact,
		ThreadType:       table.ONE_TO_ONE,
		DisplayName:      " Lan ",
		ProfilePicUrl:    "https://example.test/a.jpg",
		CanViewerMessage: true,
	})
	if person == nil || person.ID != "100012345678901" || person.Name != "Lan" || person.Kind != "non_contact" || !person.CanMessage {
		t.Fatalf("person = %#v", person)
	}
	group := personFromSearchRow(&table.LSInsertSearchResult{
		ResultId:    "7000000000000001",
		Type_:       table.SearchTypeGroup,
		ThreadType:  table.GROUP_THREAD,
		DisplayName: "Nhóm bán hàng",
	})
	if group == nil || !group.IsGroup || group.ID != "7000000000000001" {
		t.Fatalf("group = %#v", group)
	}
	if personFromSearchRow(&table.LSInsertSearchResult{Type_: table.SearchTypePage, ThreadType: table.GROUP_THREAD, ResultId: "x"}) != nil {
		t.Fatal("a non-person, non-group row must be skipped")
	}
}

func TestEmitThreadTablesReportsRequestsMuteAndDeletes(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.emitThreadTables(&table.LSTable{
		LSDeleteThenInsertThread: []*table.LSDeleteThenInsertThread{{
			ThreadKey:  100012345678901,
			ThreadType: table.ONE_TO_ONE,
			ThreadName: "Khách mới",
			FolderName: FolderPending,
		}},
		LSUpdateThreadMuteSetting:          []*table.LSUpdateThreadMuteSetting{{ThreadKey: 5, MuteExpireTimeMS: -1}},
		LSDeleteThread:                     []*table.LSDeleteThread{{ThreadKey: 6}},
		LSMoveThreadToInboxAndUpdateParent: []*table.LSMoveThreadToInboxAndUpdateParent{{ThreadKey: 7, ParentThreadKey: -1}},
	})
	threads := <-client.eventChan
	if threads.Type != EventTypeThreads {
		t.Fatalf("first event = %q", threads.Type)
	}
	updates := threads.Data.(map[string]any)["threads"].([]*ThreadUpdate)
	if len(updates) != 1 || !updates[0].IsMessageRequest || updates[0].ThreadID != "100012345678901" {
		t.Fatalf("thread updates = %#v", updates)
	}
	for _, want := range []EventType{EventTypeThreadMute, EventTypeThreadDeleted, EventTypeThreadFolder} {
		evt := <-client.eventChan
		if evt.Type != want {
			t.Fatalf("event = %q, want %q", evt.Type, want)
		}
	}
}

func TestPollInfoOf(t *testing.T) {
	msg := &table.WrappedMessage{
		LSInsertMessage: &table.LSInsertMessage{MessageId: "mid.1", SenderId: 9},
		PollID:          77,
		PollEventType:   table.PollEventCreate,
		PollQuestion:    " Ăn gì? ",
		PollOptions:     []table.PollOption{{OptionID: 1, Text: "Phở"}, {OptionID: 2, Text: "Bún"}},
		PollVotes:       []*table.LSAddPollVote{{OptionID: 2, ContactID: 9}},
	}
	info := pollInfoOf(msg)
	if info == nil || info.PollID != "77" || info.Question != "Ăn gì?" || len(info.Options) != 2 || info.Options[1].ID != "2" {
		t.Fatalf("poll = %#v", info)
	}
	if len(info.Votes) != 1 || info.Votes[0].VoterID != "9" || info.Votes[0].OptionID != "2" {
		t.Fatalf("votes = %#v", info.Votes)
	}
	if pollInfoOf(&table.WrappedMessage{LSInsertMessage: &table.LSInsertMessage{}}) != nil {
		t.Fatal("a message without a poll must have no poll info")
	}
}

func TestCallLogAttachment(t *testing.T) {
	xma := &table.WrappedXMA{
		LSInsertXmaAttachment: &table.LSInsertXmaAttachment{TitleText: "Cuộc gọi video bị lỡ"},
		CTA:                   &table.LSInsertAttachmentCta{Type_: "xma_rtc_missed_video"},
	}
	if !isCallLogXMA(xma) {
		t.Fatal("xma_rtc_ CTA must be a call log")
	}
	att := callLogAttachment(xma)
	if att.Type != "call" || att.CallType != "video" || !att.Missed || att.Title == "" {
		t.Fatalf("call attachment = %#v", att)
	}
}

func TestBoundedXmaTypeSkipsJSON(t *testing.T) {
	if got := boundedXmaType(`{"content":{}}`, "xma_share", ""); got != "xma_share" {
		t.Fatalf("boundedXmaType = %q", got)
	}
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	if got := boundedXmaType(string(long)); len(got) != 120 {
		t.Fatalf("boundedXmaType kept %d chars", len(got))
	}
}

func TestParseBloksCardIgnoresOtherDataclasses(t *testing.T) {
	if parseBloksCard(`{"content":{"other":1}}`) != nil {
		t.Fatal("a dataclass without custom template data must give no card")
	}
	if parseBloksCard(`{"content":{"custom_template_data":{"payload":"not json"}}}`) != nil {
		t.Fatal("an unreadable payload must give no card")
	}
}

func TestE2EEChatPresenceBecomesTyping(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	presence := &events.ChatPresence{State: waTypes.ChatPresenceComposing}
	presence.Chat = waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	presence.Sender = waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	client.handleE2EEEvent(presence)
	evt := <-client.eventChan
	typing, ok := evt.Data.(*TypingEvent)
	if evt.Type != EventTypeTyping || !ok || !typing.IsTyping || typing.ThreadID != 100012345678901 {
		t.Fatalf("typing event = %#v", evt)
	}
}

func TestE2EECallEventBecomesCallLog(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	client.handleE2EEEvent(&events.FBCallEvent{
		ID:        "abc",
		Chat:      waTypes.NewJID("100012345678901", waTypes.MessengerServer),
		Actor:     waTypes.NewJID("100012345678901", waTypes.MessengerServer),
		CallType:  "video",
		EventType: "ended",
		Duration:  95 * time.Second,
		Timestamp: time.UnixMilli(1_700_000_000_000),
	})
	evt := <-client.eventChan
	call, ok := evt.Data.(*CallEvent)
	if evt.Type != EventTypeCall || !ok || call.DurationSec != 95 || call.CallType != "video" || call.ThreadID != "100012345678901" {
		t.Fatalf("call event = %#v", evt)
	}
}

func TestQuietRawSkipsRawEvents(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	client.handleEvent(context.Background(), &table.LSTable{})
	select {
	case evt := <-client.eventChan:
		t.Fatalf("unexpected event %q", evt.Type)
	default:
	}
}
