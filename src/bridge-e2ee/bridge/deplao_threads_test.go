package bridge

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const (
	testHybridKey = int64(7_400_000_000_000_001)
	testPersonID  = int64(100012345678901)
	testGroupID   = int64(120363000000000001)
)

func nextEvent(t *testing.T, client *Client) *Event {
	t.Helper()
	select {
	case evt := <-client.eventChan:
		return evt
	case <-time.After(time.Second):
		t.Fatal("no event")
		return nil
	}
}

func noMoreEvents(t *testing.T, client *Client) {
	t.Helper()
	select {
	case evt := <-client.eventChan:
		t.Fatalf("unexpected event %q: %#v", evt.Type, evt.Data)
	default:
	}
}

func TestHybridThreadLinks(t *testing.T) {
	var h hybridThreads
	if h.chatOf(testHybridKey) != testHybridKey || h.keyOf(testPersonID) != 0 || !h.empty() {
		t.Fatal("empty map must answer the ids themselves")
	}
	if !h.put(testHybridKey, testPersonID) || h.put(testHybridKey, testPersonID) {
		t.Fatal("put must report only new links")
	}
	if h.put(5, 5) || h.put(0, 1) {
		t.Fatal("a key equal to the chat id or a zero id is no link")
	}
	if h.chatOf(testHybridKey) != testPersonID || h.keyOf(testPersonID) != testHybridKey {
		t.Fatal("link not kept in both directions")
	}
	// A chat that gets a new key forgets the old one
	h.put(testHybridKey+1, testPersonID)
	if h.chatOf(testHybridKey) != testHybridKey || h.keyOf(testPersonID) != testHybridKey+1 {
		t.Fatal("old key still linked")
	}
}

func TestTaskThreadKeyUsesTheFacebookKeyOfEncryptedChats(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.hybrid.put(testHybridKey, testPersonID)
	if got := client.taskThreadKey(testPersonID, true); got != testHybridKey {
		t.Fatalf("encrypted chat key = %d", got)
	}
	if got := client.taskThreadKey(testPersonID, false); got != testPersonID {
		t.Fatalf("ordinary chat key = %d", got)
	}
	if got := client.taskThreadKey(42, true); got != 42 {
		t.Fatalf("unknown encrypted chat key = %d", got)
	}
	if !isEncryptedThread(int64(table.ENCRYPTED_OVER_WA_ONE_TO_ONE), false) || isEncryptedThread(int64(table.ONE_TO_ONE), false) {
		t.Fatal("thread type 15 is encrypted, 1 is not")
	}
}

func TestSetHybridThreadsRestoresSavedLinks(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	added := client.SetHybridThreads([]*HybridThread{
		{ThreadKey: "7400000000000001", ThreadID: "100012345678901"},
		{ThreadKey: "bad", ThreadID: "1"},
		nil,
	})
	if added != 1 || client.hybrid.keyOf(testPersonID) != testHybridKey {
		t.Fatalf("added = %d", added)
	}
}

func TestHandleTableLearnsAndRemapsHybridThreads(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	client.handleTable(&table.LSTable{
		LSVerifyHybridThreadExists: []*table.LSVerifyHybridThreadExists{{
			ThreadKey: testHybridKey, ThreadJID: testPersonID, ThreadType: table.ENCRYPTED_OVER_WA_ONE_TO_ONE,
		}},
		LSUpdateThreadMuteSetting: []*table.LSUpdateThreadMuteSetting{{ThreadKey: testHybridKey, MuteExpireTimeMS: -1}},
	})
	learned := nextEvent(t, client)
	if learned.Type != EventTypeHybridThreads {
		t.Fatalf("first event = %q", learned.Type)
	}
	links := learned.Data.(map[string]any)["threads"].([]*HybridThread)
	if len(links) != 1 || links[0].ThreadKey != "7400000000000001" || links[0].ThreadID != "100012345678901" || links[0].IsGroup {
		t.Fatalf("links = %#v", links[0])
	}
	mute := nextEvent(t, client)
	if mute.Type != EventTypeThreadMute || mute.Data.(map[string]any)["threadId"] != "100012345678901" {
		t.Fatalf("mute event = %#v", mute)
	}
	// Known links are not reported again
	client.learnHybridThreads(&table.LSTable{
		LSUpdateThreadAuthorityAndMappingWithOTIDFromJID: []*table.LSUpdateThreadAuthorityAndMappingWithOTIDFromJID{{ThreadJID: testPersonID, ThreadKey: testHybridKey}},
	})
	noMoreEvents(t, client)
}

func TestEmitThreadExtras(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.emitThreadExtras(&table.LSTable{
		LSMoveThreadToE2EECutoverFolder: []*table.LSMoveThreadToE2EECutoverFolder{{ThreadKey: testPersonID}},
		LSCreateOpenToE2EEThreadLink: []*table.LSCreateOpenToE2EEThreadLink{
			{OpenThreadID: testPersonID, ArmadilloThreadID: testPersonID},
			{OpenThreadID: 5, ArmadilloThreadID: testGroupID, ShowOpenMessageHistory: true},
		},
		LSSyncUpdateThreadName: []*table.LSSyncUpdateThreadName{{ThreadKey: 9, ThreadName: "  Nhóm mới "}, {ThreadKey: 10}},
		LSSetThreadImageURL:    []*table.LSSetThreadImageURL{{ThreadKey: 9, ImageFallbackURL: "https://cdn/x.jpg"}},
		LSChangeViewerStatus:   []*table.LSChangeViewerStatus{{ThreadKey: testPersonID, CannotReplyReason: "blocked"}},
	})
	moved := nextEvent(t, client)
	if moved.Type != EventTypeThreadEncrypted || moved.Data.(map[string]any)["threadId"] != "100012345678901" {
		t.Fatalf("moved = %#v", moved)
	}
	same := nextEvent(t, client).Data.(map[string]any)
	if _, has := same["openThreadId"]; has || same["threadId"] != "100012345678901" {
		t.Fatalf("one-to-one link = %#v", same)
	}
	group := nextEvent(t, client).Data.(map[string]any)
	if group["threadId"] != "120363000000000001" || group["openThreadId"] != "5" || group["showOpenHistory"] != true {
		t.Fatalf("group link = %#v", group)
	}
	name := nextEvent(t, client)
	if name.Type != EventTypeThreadInfo || name.Data.(map[string]any)["name"] != "Nhóm mới" {
		t.Fatalf("name = %#v", name)
	}
	picture := nextEvent(t, client)
	if picture.Type != EventTypeThreadInfo || picture.Data.(map[string]any)["pictureUrl"] != "https://cdn/x.jpg" {
		t.Fatalf("picture = %#v", picture)
	}
	viewer := nextEvent(t, client)
	if viewer.Type != EventTypeViewerStatus || viewer.Data.(map[string]any)["cannotReplyReason"] != "blocked" {
		t.Fatalf("viewer = %#v", viewer)
	}
	noMoreEvents(t, client)
}

func TestBlockAnswerError(t *testing.T) {
	if err := blockAnswerError(nil, 1); err != nil {
		t.Fatalf("no answer = %v", err)
	}
	ok := &table.LSTable{LSResetUserBlockStatus: []*table.LSResetUserBlockStatus{{ContactID: 1, Success: true}}}
	if err := blockAnswerError(ok, 1); err != nil {
		t.Fatalf("success = %v", err)
	}
	refused := &table.LSTable{LSResetUserBlockStatus: []*table.LSResetUserBlockStatus{{ContactID: 1, Success: false}}}
	if err := blockAnswerError(refused, 1); err == nil {
		t.Fatal("a failed reset row must be an error")
	}
	issued := &table.LSTable{LSIssueNewError: []*table.LSIssueNewError{{ErrorMessage: "Không thể chặn"}}}
	if err := blockAnswerError(issued, 1); err == nil || !strings.Contains(err.Error(), "Không thể chặn") {
		t.Fatalf("issued = %v", err)
	}
}

func TestParticipantChangeError(t *testing.T) {
	if participantChangeError(nil) == nil {
		t.Fatal("no answer must be an error")
	}
	if err := participantChangeError([]waTypes.GroupParticipant{{Error: 0}}); err != nil {
		t.Fatalf("accepted = %v", err)
	}
	if err := participantChangeError([]waTypes.GroupParticipant{{Error: 403}}); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("refused = %v", err)
	}
}

func TestE2EEGroupInfoEvents(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	sender := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	client.handleE2EEEvent(&events.GroupInfo{
		JID:       waTypes.NewJID("120363000000000001", waTypes.GroupServer),
		Sender:    &sender,
		Timestamp: time.UnixMilli(1_700_000_000_000),
		Name:      &waTypes.GroupName{Name: "Nhóm kín"},
		Join:      []waTypes.JID{waTypes.NewJID("100000000000002", waTypes.MessengerServer)},
		Promote:   []waTypes.JID{waTypes.NewJID("100000000000003", waTypes.MessengerServer)},
		Leave:     []waTypes.JID{waTypes.NewJID("100000000000004", waTypes.MessengerServer)},
		Ephemeral: &waTypes.GroupEphemeral{IsEphemeral: true, DisappearingTimer: 86400},
	})
	name := nextEvent(t, client)
	if name.Type != EventTypeThreadInfo || name.Data.(map[string]any)["name"] != "Nhóm kín" {
		t.Fatalf("name = %#v", name)
	}
	members := nextEvent(t, client)
	list := members.Data.(map[string]any)["members"].([]*Participant)
	if members.Type != EventTypeParticipants || len(list) != 2 || list[0].ID != "100000000000002" || !list[1].IsAdmin {
		t.Fatalf("members = %#v", members)
	}
	removed := nextEvent(t, client)
	if removed.Type != EventTypeParticipantRemoved || removed.Data.(map[string]any)["userId"] != "100000000000004" {
		t.Fatalf("removed = %#v", removed)
	}
	timer := nextEvent(t, client)
	setting, ok := timer.Data.(*DisappearingSetting)
	if timer.Type != EventTypeDisappearing || !ok || setting.Seconds != 86400 || setting.ThreadID != "120363000000000001" || setting.ActorID != "100012345678901" || !setting.Notice {
		t.Fatalf("timer = %#v", timer)
	}
	noMoreEvents(t, client)
}

func timedMessage(seconds uint32, kind waMsgApplication.MessageApplication_EphemeralSetting_EphemeralityType, settingTs int64) *events.FBMessage {
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	msg := &events.FBMessage{
		FBApplication: &waMsgApplication.MessageApplication{
			Metadata: &waMsgApplication.MessageApplication_Metadata{
				Ephemeral: &waMsgApplication.MessageApplication_Metadata_ChatEphemeralSetting{
					ChatEphemeralSetting: &waMsgApplication.MessageApplication_EphemeralSetting{
						EphemeralExpiration:       proto.Uint32(seconds),
						EphemeralityType:          &kind,
						EphemeralSettingTimestamp: proto.Int64(settingTs),
					},
				},
			},
		},
	}
	msg.Info.Chat = chat
	msg.Info.Sender = chat
	msg.Info.Timestamp = time.UnixMilli(1_700_000_000_000)
	return msg
}

func TestMessageDisappearing(t *testing.T) {
	if messageDisappearing(&events.FBMessage{}) != nil {
		t.Fatal("a message without metadata has no timer")
	}
	after := messageDisappearing(timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_SEEN_BASED_WITH_TIMER, 1))
	if after.Seconds != 3600 || !after.AfterRead || after.ThreadID != "100012345678901" {
		t.Fatalf("seen based = %#v", after)
	}
	once := messageDisappearing(timedMessage(0, waMsgApplication.MessageApplication_EphemeralSetting_SEEN_ONCE, 1))
	if once.Seconds != seenOnceSeconds || !once.AfterRead {
		t.Fatalf("seen once = %#v", once)
	}
	// The setting list form and a reset setting (timer off)
	listed := timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 2)
	inner := listed.FBApplication.Metadata.GetChatEphemeralSetting()
	inner.IsEphemeralSettingReset = proto.Bool(true)
	listed.FBApplication.Metadata.Ephemeral = &waMsgApplication.MessageApplication_Metadata_EphemeralSettingList{
		EphemeralSettingList: &waMsgApplication.MessageApplication_Metadata_EphemeralSettingMap{ChatJID: proto.String("100012345678901@msgr"), EphemeralSetting: inner},
	}
	if reset := messageDisappearing(listed); reset == nil || reset.Seconds != 0 {
		t.Fatalf("reset = %#v", reset)
	}
}

func TestChatTimerNoticeAndSends(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	if client.withChatTimer(chat, nil) != nil {
		t.Fatal("no timer known: metadata stays nil")
	}
	// A notice (no content) turns the timer on: reported, and Deplao's sends carry it
	client.handleE2EEEvent(timedMessage(86400, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 50))
	notice := nextEvent(t, client)
	if notice.Type != EventTypeDisappearing || notice.Data.(*DisappearingSetting).Seconds != 86400 {
		t.Fatalf("notice = %#v", notice)
	}
	noMoreEvents(t, client)
	metadata := client.withChatTimer(chat, nil)
	setting := metadata.GetChatEphemeralSetting()
	if setting.GetEphemeralExpiration() != 86400 || setting.GetEphemeralSettingTimestamp() != 50 {
		t.Fatalf("send metadata = %#v", setting)
	}
	// An older setting never replaces a newer one; turning it off drops it from sends
	client.rememberChatTimer(chat.String(), 60, 10)
	if client.withChatTimer(chat, nil).GetChatEphemeralSetting().GetEphemeralExpiration() != 86400 {
		t.Fatal("older setting replaced a newer one")
	}
	client.rememberChatTimer(chat.String(), 0, 60)
	if client.withChatTimer(chat, nil) != nil {
		t.Fatal("timer off: metadata stays nil")
	}
	// A message with content that carries a different setting reports it too; the same setting does not
	withContent := timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 70)
	withContent.Message = &waConsumerApplication.ConsumerApplication{}
	client.handleE2EEEvent(withContent)
	if changed := nextEvent(t, client); changed.Type != EventTypeDisappearing || changed.Data.(*DisappearingSetting).Seconds != 3600 {
		t.Fatalf("changed = %#v", changed)
	}
	again := timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 70)
	again.Message = &waConsumerApplication.ConsumerApplication{}
	client.handleE2EEEvent(again)
	for {
		select {
		case evt := <-client.eventChan:
			if evt.Type == EventTypeDisappearing {
				t.Fatalf("unchanged setting reported again: %#v", evt)
			}
			continue
		default:
		}
		break
	}
	// A real message without a timer in a timed chat: the timer was turned off
	plain := &events.FBMessage{Message: &waConsumerApplication.ConsumerApplication{}}
	plain.Info.Chat = chat
	plain.Info.Sender = chat
	client.handleE2EEEvent(plain)
	offEvent := (*Event)(nil)
	for offEvent == nil {
		evt := nextEvent(t, client)
		if evt.Type == EventTypeDisappearing {
			offEvent = evt
		}
	}
	if offEvent.Data.(*DisappearingSetting).Seconds != 0 || client.withChatTimer(chat, nil) != nil {
		t.Fatalf("off = %#v", offEvent.Data)
	}
	client.rememberChatTimer(chat.String(), 3600, 90)
	// Saved timers only fill chats this run has not seen
	client.SetChatTimers(map[string]int64{chat.String(): 7200, "1@msgr": 600})
	if client.withChatTimer(chat, nil).GetChatEphemeralSetting().GetEphemeralExpiration() != 3600 ||
		client.withChatTimer(waTypes.NewJID("1", waTypes.MessengerServer), nil) == nil {
		t.Fatal("saved timers")
	}
}
