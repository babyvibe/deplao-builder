package bridge

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/armadilloutil"
	"go.mau.fi/whatsmeow/proto/waArmadilloApplication"
	"go.mau.fi/whatsmeow/proto/waArmadilloXMA"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func TestUpsertThreadRowsBecomeThreadUpdates(t *testing.T) {
	tbl := &table.LSTable{
		LSDeleteThenInsertThread: []*table.LSDeleteThenInsertThread{{ThreadKey: 1, ThreadName: "Đầy đủ"}},
		LSUpdateOrInsertThread: []*table.LSUpdateOrInsertThread{
			{ThreadKey: 1, ThreadName: "Bỏ qua"},
			{ThreadKey: 2, ThreadType: table.GROUP_THREAD, ThreadName: "Nhóm A", FolderName: FolderPending, ThreadPictureUrlFallback: "https://cdn/a.jpg", MuteExpireTimeMs: -1},
		},
	}
	updates := threadUpdatesOf(tbl)
	if len(updates) != 2 || updates[0].Name != "Đầy đủ" {
		t.Fatalf("updates = %#v", updates)
	}
	upsert := updates[1]
	if upsert.ThreadID != "2" || upsert.Name != "Nhóm A" || !upsert.IsMessageRequest || upsert.PictureURL != "https://cdn/a.jpg" || upsert.MuteExpireTimeMs != -1 {
		t.Fatalf("upsert = %#v", upsert)
	}
}

func TestMessageRequestStatusAndContactBlocks(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.emitIncomingThreadTables(&table.LSTable{
		LSDeleteThenInsertMessageRequest: []*table.LSDeleteThenInsertMessageRequest{{ThreadKey: 5, MessageRequestStatus: 1}, {ThreadKey: 6}},
		LSDeleteThenInsertContact:        []*table.LSDeleteThenInsertContact{{Id: 11, BlockedByViewerStatus: 2}, {Id: 12}},
		LSVerifyContactRowExists:         []*table.LSVerifyContactRowExists{{ContactId: 13, IsBlocked: true}, {ContactId: 11}},
	})
	pending := nextEvent(t, client)
	if pending.Type != EventTypeThreadFolder || pending.Data.(map[string]any)["folderName"] != FolderPending {
		t.Fatalf("pending = %#v", pending)
	}
	if inbox := nextEvent(t, client).Data.(map[string]any); inbox["threadId"] != "6" || inbox["folderName"] != FolderInbox {
		t.Fatalf("inbox = %#v", inbox)
	}
	blocks := nextEvent(t, client)
	data := blocks.Data.(map[string]any)
	blocked, unblocked := data["blocked"].([]string), data["unblocked"].([]string)
	if blocks.Type != EventTypeContactBlocks || len(blocked) != 2 || blocked[0] != "11" || blocked[1] != "13" || len(unblocked) != 1 || unblocked[0] != "12" {
		t.Fatalf("blocks = %#v", blocks)
	}
	noMoreEvents(t, client)
}

func TestUndecryptableMessageBecomesPlaceholder(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.quietRaw = true
	evt := &events.UndecryptableMessage{}
	evt.Info.ID = "3EB0ABC"
	evt.Info.Chat = waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	evt.Info.Sender = waTypes.NewJID("100012345678901", waTypes.MessengerServer)
	evt.Info.Timestamp = time.UnixMilli(1_700_000_000_000)
	client.handleE2EEEvent(evt)
	got := nextEvent(t, client)
	msg, ok := got.Data.(*E2EEMessage)
	if got.Type != EventTypeE2EEMessage || !ok || msg.ID != "3EB0ABC" || msg.Unsupported != unsupportedUndecryptable || msg.ThreadID != 100012345678901 {
		t.Fatalf("placeholder = %#v", got)
	}
	if diagnostic := nextEvent(t, client); diagnostic.Type != EventTypeError {
		t.Fatalf("diagnostic = %#v", diagnostic)
	}
	// A failure meant to stay hidden gets no placeholder
	evt.DecryptFailMode = events.DecryptFailHide
	client.handleE2EEEvent(evt)
	if diagnostic := nextEvent(t, client); diagnostic.Type != EventTypeError {
		t.Fatalf("hidden = %#v", diagnostic)
	}
	noMoreEvents(t, client)
}

func TestViewOnceMediaIsShown(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	att, caption := client.viewOnceAttachment(&waConsumerApplication.ConsumerApplication_ViewOnceMessage{
		ViewOnceContent: &waConsumerApplication.ConsumerApplication_ViewOnceMessage_ImageMessage{
			ImageMessage: &waConsumerApplication.ConsumerApplication_ImageMessage{Caption: &waCommon.MessageText{Text: proto.String("xem nhé")}},
		},
	})
	if att == nil || att.Type != "image" || !att.ViewOnce || caption.GetText() != "xem nhé" {
		t.Fatalf("view once = %#v %#v", att, caption)
	}

	raven := &waArmadilloApplication.Armadillo_Content_RavenMessage{
		EphemeralType: waArmadilloApplication.Armadillo_Content_RavenMessage_VIEW_ONCE.Enum(),
	}
	direct := "/v/t62.7118-24/abc"
	if err := raven.SetVideoMessage(&waMediaTransport.VideoTransport{
		Integral: &waMediaTransport.VideoTransport_Integral{Transport: &waMediaTransport.WAMediaTransport{
			Integral: &waMediaTransport.WAMediaTransport_Integral{DirectPath: &direct, MediaKey: []byte{1}},
		}},
		Ancillary: &waMediaTransport.VideoTransport_Ancillary{Seconds: proto.Uint32(7)},
	}); err != nil {
		t.Fatal(err)
	}
	video := ravenAttachment(raven)
	if video == nil || video.Type != "video" || !video.ViewOnce || video.DirectPath != direct || video.Duration != 7 {
		t.Fatalf("raven = %#v", video)
	}
	raven.EphemeralType = waArmadilloApplication.Armadillo_Content_RavenMessage_KEEP_IN_CHAT.Enum()
	if kept := ravenAttachment(raven); kept == nil || kept.ViewOnce {
		t.Fatalf("kept in chat = %#v", kept)
	}
}

func TestBumpReplyPointsAtTheBumpedMessage(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	client.FBID = 111
	if reply := client.bumpReply(&waCommon.MessageKey{ID: proto.String("m1"), FromMe: proto.Bool(true)}); reply == nil || reply.MessageID != "m1" || reply.SenderID != 111 {
		t.Fatalf("own = %#v", reply)
	}
	other := client.bumpReply(&waCommon.MessageKey{ID: proto.String("m2"), Participant: proto.String("100012345678901.0:3@msgr")})
	if other == nil || other.SenderID != 100012345678901 {
		t.Fatalf("other = %#v", other)
	}
	if client.bumpReply(&waCommon.MessageKey{}) != nil {
		t.Fatal("a key without id is no reply")
	}
}

func TestExtendedContentCards(t *testing.T) {
	client := newEventPipelineTestClient(t, 0)
	location := &waArmadilloXMA.ExtendedContentMessage{
		TargetType: waArmadilloXMA.ExtendedContentMessage_MSG_LOCATION_SHARING_V2.Enum(),
		TitleText:  proto.String("Hồ Gươm"),
		Ctas:       []*waArmadilloXMA.ExtendedContentMessage_CTA{{NativeURL: proto.String("messenger://location_share?lat=21.0287&long=105.8524")}},
	}
	msg := &E2EEMessage{}
	if !client.applyExtendedContent(msg, location) || len(msg.Attachments) != 1 || msg.Attachments[0].Type != "location" || msg.Attachments[0].Latitude != 21.0287 || msg.Attachments[0].FileName != "Hồ Gươm" {
		t.Fatalf("location = %#v", msg.Attachments)
	}
	// A live location update without a position is dropped
	if client.applyExtendedContent(&E2EEMessage{}, &waArmadilloXMA.ExtendedContentMessage{TargetType: waArmadilloXMA.ExtendedContentMessage_MSG_LOCATION_SHARING_V2.Enum()}) {
		t.Fatal("empty live location kept")
	}
	// The text of a card is kept
	card := &E2EEMessage{}
	client.applyExtendedContent(card, &waArmadilloXMA.ExtendedContentMessage{
		MessageText: proto.String("Xem bài này"),
		Ctas:        []*waArmadilloXMA.ExtendedContentMessage_CTA{{ActionURL: proto.String("https://example.com/post")}},
	})
	if card.Text != "Xem bài này" || len(card.Attachments) != 1 || card.Attachments[0].URL != "https://example.com/post" {
		t.Fatalf("card = %#v", card)
	}
	// Story reply: the reply text comes from the associated consumer message
	consumer, err := armadilloutil.Marshal(&waConsumerApplication.ConsumerApplication{Payload: &waConsumerApplication.ConsumerApplication_Payload{
		Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{Content: &waConsumerApplication.ConsumerApplication_Content{
			Content: &waConsumerApplication.ConsumerApplication_Content_MessageText{MessageText: &waCommon.MessageText{Text: proto.String("Đẹp quá!")}},
		}},
	}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	assoc, err := armadilloutil.Marshal(&waMsgApplication.MessageApplication{Payload: &waMsgApplication.MessageApplication_Payload{
		Content: &waMsgApplication.MessageApplication_Payload_SubProtocol{SubProtocol: &waMsgApplication.MessageApplication_SubProtocolPayload{
			SubProtocol: &waMsgApplication.MessageApplication_SubProtocolPayload_ConsumerMessage{ConsumerMessage: consumer},
		}},
	}}, 2)
	if err != nil {
		t.Fatal(err)
	}
	story := &E2EEMessage{}
	client.applyExtendedContent(story, &waArmadilloXMA.ExtendedContentMessage{
		TargetType:        waArmadilloXMA.ExtendedContentMessage_FB_STORY_REPLY.Enum(),
		AssociatedMessage: assoc,
		Ctas:              []*waArmadilloXMA.ExtendedContentMessage_CTA{{ActionURL: proto.String("https://www.facebook.com/stories/1")}},
	})
	if story.Text != "Đẹp quá!" || len(story.Attachments) != 1 || story.Attachments[0].XmaType != "story_reply" {
		t.Fatalf("story = %#v", story)
	}
}
