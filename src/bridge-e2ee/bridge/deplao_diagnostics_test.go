package bridge

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

type recordingLogger struct {
	waLog.Logger
	warnings []string
}

func (l *recordingLogger) Warnf(msg string, args ...any) { l.warnings = append(l.warnings, msg) }

// collectDropped reads the e2eeDropped events reported within the wait.
func collectDropped(t *testing.T, client *Client, wait time.Duration) []E2EEDropped {
	t.Helper()
	var out []E2EEDropped
	deadline := time.After(wait)
	for {
		select {
		case evt := <-client.eventChan:
			if dropped, ok := evt.Data.(*E2EEDropped); ok && evt.Type == EventTypeE2EEDropped {
				out = append(out, *dropped)
			}
		case <-deadline:
			return out
		}
	}
}

func TestWatchE2EEDropsReportsUndecodableMessages(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	inner := &recordingLogger{Logger: waLog.Noop}
	e2eeClient := &whatsmeow.Client{Log: inner}
	client.watchE2EEDrops(e2eeClient)
	client.watchE2EEDrops(e2eeClient) // wrapping twice keeps one wrapper
	if _, ok := e2eeClient.Log.(*dropWatchLogger); !ok || e2eeClient.Log.(*dropWatchLogger).Logger != inner {
		t.Fatalf("logger = %#v", e2eeClient.Log)
	}
	e2eeClient.Log.Warnf("Failed to decode armadillo message from %s: %v", "100012345678901@msgr", "unsupported signal payload")
	e2eeClient.Log.Warnf("Ignoring message %s from %s: %v", "m1", "100012345678901@msgr", "old counter")
	e2eeClient.Log.Debugf("Unhandled notification with type %s", "disappearing_mode")
	e2eeClient.Log.Debugf("Decrypting message from %s", "100012345678901@msgr")
	if len(inner.warnings) != 2 {
		t.Fatalf("warnings must still reach the real logger: %v", inner.warnings)
	}
	want := map[E2EEDropped]bool{
		{Reason: "undecodable", Detail: "Failed to decode armadillo message from 100012345678901@msgr: unsupported signal payload"}: true,
		{Reason: "whatsmeow-warn", Detail: "Ignoring message m1 from 100012345678901@msgr: old counter"}:                            true,
		{Reason: "whatsmeow-debug", Detail: "Unhandled notification with type disappearing_mode"}:                                   true,
	}
	got := collectDropped(t, client, 300*time.Millisecond)
	if len(got) != len(want) {
		t.Fatalf("dropped = %#v", got)
	}
	for _, dropped := range got {
		if !want[dropped] {
			t.Fatalf("unexpected %#v", dropped)
		}
	}
	// A burst is capped per minute
	logger := e2eeClient.Log.(*dropWatchLogger)
	for i := 0; i < whatsmeowReportsPerMinute+5; i++ {
		logger.Errorf("burst %d", i)
	}
	if reported := len(collectDropped(t, client, 500*time.Millisecond)); reported != whatsmeowReportsPerMinute-len(want) {
		t.Fatalf("reported %d lines in the minute", reported)
	}
}

func TestReportMetadataOnlyMessage(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	threadType := waMsgApplication.MessageApplication_Metadata_DEFAULT
	msg := &events.FBMessage{FBApplication: &waMsgApplication.MessageApplication{
		Metadata: &waMsgApplication.MessageApplication_Metadata{
			ThreadType:      &threadType,
			FrankingKey:     []byte("secret"),
			Ephemeral:       &waMsgApplication.MessageApplication_Metadata_EphemeralSharedSecret{EphemeralSharedSecret: []byte("secret")},
			ForwardingScore: proto.Uint32(2),
		},
	}}
	msg.Info.ID = "notice-1"
	msg.Info.StanzaTag = "message"
	msg.Info.Chat = chat
	msg.Info.Sender = waTypes.NewJID("100000000000009", waTypes.MessengerServer)
	msg.Info.IsFromMe = true
	client.handleE2EEEvent(msg)
	evt := nextEvent(t, client)
	dropped, ok := evt.Data.(*E2EEDropped)
	if evt.Type != EventTypeE2EEDropped || !ok || dropped.Reason != "metadataOnly" || dropped.MessageID != "notice-1" ||
		dropped.ChatJID != chat.String() || dropped.SenderID != "100000000000009" || !dropped.FromMe {
		t.Fatalf("dropped = %#v", evt)
	}
	for _, want := range []string{"message metadata{", "ephemeralSharedSecret", "threadType=DEFAULT", "forwardingScore=2", "frankingKey"} {
		if !strings.Contains(dropped.Detail, want) {
			t.Fatalf("detail %q lacks %q", dropped.Detail, want)
		}
	}
	if strings.Contains(dropped.Detail, "secret") {
		t.Fatalf("bytes leaked into the detail: %q", dropped.Detail)
	}
	noMoreEvents(t, client)
}

func TestReportWAMessage(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	protocolType := waE2E.ProtocolMessage_EPHEMERAL_SETTING
	msg := &events.Message{Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type:                &protocolType,
		EphemeralExpiration: proto.Uint32(0),
	}}}
	msg.Info.ID = "wa-1"
	msg.Info.Chat = chat
	msg.Info.Sender = chat
	client.handleE2EEEvent(msg)
	evt := nextEvent(t, client)
	dropped := evt.Data.(*E2EEDropped)
	if evt.Type != EventTypeE2EEDropped || dropped.Reason != "waMessage" ||
		!strings.Contains(dropped.Detail, "protocolMessage{") || !strings.Contains(dropped.Detail, "type=EPHEMERAL_SETTING") ||
		!strings.Contains(dropped.Detail, "ephemeralExpiration=0") {
		t.Fatalf("dropped = %#v", dropped)
	}
	// Key distribution alone is protocol traffic
	keys := &events.Message{Message: &waE2E.Message{SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{GroupID: proto.String("g")}}}
	keys.Info.Chat = chat
	client.handleE2EEEvent(keys)
	noMoreEvents(t, client)
}

func TestTimerSettingListWithoutSettingMeansOff(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	client.rememberChatTimer(chat.String(), 86400, 0)
	msg := &events.FBMessage{FBApplication: &waMsgApplication.MessageApplication{
		Metadata: &waMsgApplication.MessageApplication_Metadata{
			Ephemeral: &waMsgApplication.MessageApplication_Metadata_EphemeralSettingList{
				EphemeralSettingList: &waMsgApplication.MessageApplication_Metadata_EphemeralSettingMap{ChatJID: proto.String(chat.String())},
			},
		},
	}}
	msg.Info.ID = "sync-1"
	// Sent by one of the account's own devices, to its own chat id: the list entry names the chat
	own := waTypes.NewJID("100000000000009", waTypes.MessengerServer)
	msg.Info.Chat = own
	msg.Info.Sender = own
	msg.Info.IsFromMe = true
	client.handleE2EEEvent(msg)
	evt := nextEvent(t, client)
	setting, ok := evt.Data.(*DisappearingSetting)
	if evt.Type != EventTypeDisappearing || !ok || setting.Seconds != 0 || setting.ThreadID != "100012345678901" ||
		setting.Form != "list" || !setting.Notice || !setting.FromMe || setting.MessageID != "sync-1" || setting.Implicit {
		t.Fatalf("setting = %#v", evt.Data)
	}
	if client.withChatTimer(chat, nil) != nil {
		t.Fatal("timer still attached to sends")
	}
	noMoreEvents(t, client)
}

func TestTimerEventFields(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	notice := timedMessage(86400, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_000)
	notice.Info.ID = "timer-1"
	client.handleE2EEEvent(notice)
	on := nextEvent(t, client).Data.(*DisappearingSetting)
	if !on.Notice || on.Implicit || on.Form != "chat" || on.MessageID != "timer-1" || on.SettingTimestamp != 1_700_000_000 {
		t.Fatalf("notice = %#v", on)
	}
	noMoreEvents(t, client)
	// A message with content and a new setting: implicit
	changed := timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_100)
	changed.Message = &waConsumerApplication.ConsumerApplication{}
	client.handleE2EEEvent(changed)
	var implicit *DisappearingSetting
	for implicit == nil {
		if evt := nextEvent(t, client); evt.Type == EventTypeDisappearing {
			implicit = evt.Data.(*DisappearingSetting)
		}
	}
	if implicit.Notice || !implicit.Implicit || implicit.Seconds != 3600 {
		t.Fatalf("implicit = %#v", implicit)
	}
}

func TestLateTimerCopyIsStale(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	off := timedMessage(0, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_200_000)
	client.handleE2EEEvent(off)
	if first := nextEvent(t, client).Data.(*DisappearingSetting); first.Stale || first.Seconds != 0 {
		t.Fatalf("first = %#v", first)
	}
	// A late copy of the earlier "on" change
	late := timedMessage(86400, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_100_000)
	client.handleE2EEEvent(late)
	copyEvent := nextEvent(t, client).Data.(*DisappearingSetting)
	if !copyEvent.Stale || copyEvent.Seconds != 86400 {
		t.Fatalf("late copy = %#v", copyEvent)
	}
	if client.withChatTimer(waTypes.NewJID("100012345678901", waTypes.MessengerServer), nil) != nil {
		t.Fatal("a late copy turned the timer back on")
	}
	noMoreEvents(t, client)
}

func TestCopyOfTimerTurnedOffStaysStale(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	chat := waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	client.handleE2EEEvent(timedMessage(86400, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_100_000))
	nextEvent(t, client)
	// A real message without a timer: turned off
	plain := &events.FBMessage{Message: &waConsumerApplication.ConsumerApplication{}}
	plain.Info.Chat = chat
	plain.Info.Sender = chat
	client.handleE2EEEvent(plain)
	var off *DisappearingSetting
	for off == nil {
		if evt := nextEvent(t, client); evt.Type == EventTypeDisappearing {
			off = evt.Data.(*DisappearingSetting)
		}
	}
	if off.Seconds != 0 || !off.Implicit {
		t.Fatalf("off = %#v", off)
	}
	// Then a device sends a copy of the change that was turned off: stale, the timer stays off
	client.handleE2EEEvent(timedMessage(86400, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_100_000))
	var copied *DisappearingSetting
	for copied == nil {
		if evt := nextEvent(t, client); evt.Type == EventTypeDisappearing {
			copied = evt.Data.(*DisappearingSetting)
		}
	}
	if !copied.Stale || client.withChatTimer(chat, nil) != nil {
		t.Fatalf("copy = %#v", copied)
	}
	// A newer change turns it on again
	client.handleE2EEEvent(timedMessage(3600, waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN, 1_700_000_200_000))
	var again *DisappearingSetting
	for again == nil {
		if evt := nextEvent(t, client); evt.Type == EventTypeDisappearing {
			again = evt.Data.(*DisappearingSetting)
		}
	}
	if again.Stale || client.withChatTimer(chat, nil).GetChatEphemeralSetting().GetEphemeralExpiration() != 3600 {
		t.Fatalf("again = %#v", again)
	}
}
