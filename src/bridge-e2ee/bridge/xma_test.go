package bridge

// DEPLAO_ADAPTER: tests for Page template / XMA conversion (xma.go).

import (
	"testing"

	"go.mau.fi/whatsmeow/types/events"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func optInTable(now int64) *table.LSTable {
	return &table.LSTable{
		LSInsertMessage: []*table.LSInsertMessage{{
			MessageId:   "mid.optin",
			ThreadKey:   306170189246702,
			SenderId:    306170189246702,
			TimestampMs: now,
		}},
		LSInsertXmaAttachment: []*table.LSInsertXmaAttachment{{
			MessageId:        "mid.optin",
			AttachmentFbid:   "att.optin",
			TitleText:        "Ưu đãi và thông báo",
			SubtitleText:     "Bạn không muốn bỏ lỡ đợt giảm giá mới nhất?",
			AttachmentCta1Id: 11,
			Cta1Title:        "Nhận tin nhắn",
			Cta1Type:         "xma_postback",
			AttachmentCta2Id: 12,
			Cta2Title:        "Xem cửa hàng",
			Cta2Type:         "xma_web_url",
			AttachmentCta3Id: 13,
			Cta3Title:        "Gọi cho shop",
			Cta3Type:         "xma_call",
		}},
		LSInsertAttachmentCta: []*table.LSInsertAttachmentCta{
			{CtaId: 11, AttachmentFbid: "att.optin", MessageId: "mid.optin", Title: "Nhận tin nhắn", Type_: "xma_postback"},
			{CtaId: 12, AttachmentFbid: "att.optin", MessageId: "mid.optin", Title: "Xem cửa hàng", Type_: "xma_web_url",
				ActionUrl: "https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2Fsale&h=x"},
			{CtaId: 13, AttachmentFbid: "att.optin", MessageId: "mid.optin", Title: "Gọi cho shop", Type_: "xma_call",
				NativeUrl: "tel:+84901234567"},
		},
	}
}

func TestButtonTemplateWithoutURLIsKeptWithAllButtons(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(optInTable(now))

	if got := len(client.eventChan); got != 1 {
		t.Fatalf("emitted %d events, want 1", got)
	}
	msg, ok := (<-client.eventChan).Data.(*Message)
	if !ok {
		t.Fatalf("event data is not a message")
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("attachments = %d, want 1 template (the old code dropped it)", len(msg.Attachments))
	}
	att := msg.Attachments[0]
	if att.Type != "template" || att.Title != "Ưu đãi và thông báo" || att.Subtitle == "" {
		t.Fatalf("template = %#v", att)
	}
	if len(att.Buttons) != 3 {
		t.Fatalf("buttons = %d, want 3 (WrapMessages keeps only one CTA per attachment)", len(att.Buttons))
	}
	if att.Buttons[1].URL != "https://shop.example/sale" {
		t.Fatalf("web button url = %q, want l.php unwrapped", att.Buttons[1].URL)
	}
	if att.Buttons[2].NativeURL != "tel:+84901234567" || att.Buttons[0].URL != "" {
		t.Fatalf("buttons = %#v %#v", att.Buttons[0], att.Buttons[2])
	}
	if att.Buttons[0].CtaID != "11" {
		t.Fatalf("cta id = %q, want string id", att.Buttons[0].CtaID)
	}
}

func TestPlainURLPreviewStaysLink(t *testing.T) {
	extras := newTableExtras(nil)
	att := extras.convertXMA(&table.WrappedXMA{
		LSInsertXmaAttachment: &table.LSInsertXmaAttachment{
			TitleText:  "Example",
			PreviewUrl: "https://cdn.example/p.jpg",
		},
		CTA: &table.LSInsertAttachmentCta{Type_: "xma_web_url", ActionUrl: "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com"},
	})
	if att == nil || att.Type != "link" || att.URL != "https://example.com" || att.FileName != "Example" {
		t.Fatalf("link preview = %#v", att)
	}
}

func TestCarouselItemsAttachToTemplateInOrder(t *testing.T) {
	now := timeNowMs()
	tbl := optInTable(now)
	tbl.LSInsertAttachmentItem = []*table.LSInsertAttachmentItem{
		{MessageId: "mid.optin", AttachmentIndex: 1, TitleText: "Thẻ 2", ImageUrl: "https://cdn.example/2.jpg"},
		{MessageId: "mid.optin", AttachmentIndex: 0, TitleText: "Thẻ 1", SubtitleText: "199k",
			DefaultActionUrl: "https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F1",
			AttachmentCta1Id: 21, Cta1Title: "Mua ngay", Cta1Type: "xma_postback"},
	}
	extras := newTableExtras(tbl)
	_, insert := tbl.WrapMessages()
	msg := (&Client{threadCache: map[int64]*Thread{}}).convertWrappedMessage(insert[0], extras)
	if len(msg.Attachments) != 1 || len(msg.Attachments[0].Items) != 2 {
		t.Fatalf("attachments = %#v", msg.Attachments)
	}
	first := msg.Attachments[0].Items[0]
	if first.Title != "Thẻ 1" || first.URL != "https://shop.example/1" || len(first.Buttons) != 1 || first.Buttons[0].Title != "Mua ngay" {
		t.Fatalf("first item = %#v", first)
	}
}

func TestLegacyAttachmentsAreConverted(t *testing.T) {
	extras := newTableExtras(nil)
	card := extras.convertLegacyAttachment(&table.LSInsertAttachment{
		HasXma:    true,
		TitleText: "Đã thêm sản phẩm vào giỏ hàng",
		Cta1Title: "Xem giỏ hàng",
		Cta1Type:  "xma_postback",
	})
	if card == nil || card.Type != "template" || len(card.Buttons) != 1 {
		t.Fatalf("legacy card = %#v", card)
	}
	image := extras.convertLegacyAttachment(&table.LSInsertAttachment{
		HasMedia:       true,
		AttachmentType: table.AttachmentTypeImage,
		PreviewUrl:     "https://cdn.example/a.jpg",
	})
	if image == nil || image.Type != "image" || image.URL != "https://cdn.example/a.jpg" {
		t.Fatalf("legacy image = %#v", image)
	}
}

func TestEmptyCardIsDropped(t *testing.T) {
	if att := newTableExtras(nil).convertXMA(&table.WrappedXMA{LSInsertXmaAttachment: &table.LSInsertXmaAttachment{}}); att != nil {
		t.Fatalf("empty card = %#v, want nil", att)
	}
}

func TestHistoryKeepsUnsentFlag(t *testing.T) {
	data := (&Client{threadCache: map[int64]*Thread{}}).collectInitialData(&table.LSTable{
		LSInsertMessage: []*table.LSInsertMessage{{MessageId: "mid.gone", ThreadKey: 1, SenderId: 2, IsUnsent: true}},
	})
	if len(data.Messages) != 1 || !data.Messages[0].IsUnsent {
		t.Fatalf("history = %#v", data.Messages)
	}
}

func TestE2EEMessageWithoutContentIsDropped(t *testing.T) {
	client := newEventPipelineTestClient(t, timeNowMs()-1_000)
	if msg := client.extractE2EEMessage(&events.FBMessage{}, 1); msg != nil {
		t.Fatalf("empty E2EE message = %#v, want nil", msg)
	}
}

// buttonTemplateTable: a Page button template as LightSpeed sends it without an
// XMA card — the text is the message text, the buttons are CTA rows of the
// message (the MQTT copy is only "Attachment unavailable").
func buttonTemplateTable(now int64) *table.LSTable {
	return &table.LSTable{
		LSInsertMessage: []*table.LSInsertMessage{{
			MessageId:   "mid.button",
			ThreadKey:   1372031469316548,
			SenderId:    1372031469316548,
			TimestampMs: now,
			Text:        "Hãy chọn dịch vụ mà bạn đang quan tâm",
		}},
		LSInsertAttachmentCta: []*table.LSInsertAttachmentCta{
			{CtaId: 31, AttachmentFbid: "att.button", MessageId: "mid.button", Title: "Tư vấn sản phẩm", Type_: "xma_postback"},
			{CtaId: 32, AttachmentFbid: "att.button", MessageId: "mid.button", Title: "Đặt hàng sản phẩm", Type_: "xma_postback"},
			{CtaId: 33, AttachmentFbid: "att.button", MessageId: "mid.button", Title: "Tra cứu đơn hàng", Type_: "xma_postback"},
		},
	}
}

func TestButtonTemplateWithoutCardKeepsTextAndButtons(t *testing.T) {
	now := timeNowMs()
	client := newEventPipelineTestClient(t, now-1_000)
	client.handleTable(buttonTemplateTable(now))

	if got := len(client.eventChan); got != 1 {
		t.Fatalf("emitted %d events, want 1", got)
	}
	msg := (<-client.eventChan).Data.(*Message)
	if msg.Text != "Hãy chọn dịch vụ mà bạn đang quan tâm" {
		t.Fatalf("text = %q", msg.Text)
	}
	if len(msg.Attachments) != 1 || msg.Attachments[0].Type != "template" {
		t.Fatalf("attachments = %#v, want one template (the buttons were dropped before)", msg.Attachments)
	}
	att := msg.Attachments[0]
	if att.Title != "" || len(att.Buttons) != 3 {
		t.Fatalf("template = %#v", att)
	}
	for i, want := range []string{"Tư vấn sản phẩm", "Đặt hàng sản phẩm", "Tra cứu đơn hàng"} {
		if att.Buttons[i].Title != want || att.Buttons[i].Type != "xma_postback" {
			t.Fatalf("button %d = %#v, want %q in table order", i, att.Buttons[i], want)
		}
	}
	if att.Buttons[0].CtaID != "31" {
		t.Fatalf("cta id = %q", att.Buttons[0].CtaID)
	}
}

func TestButtonsOfAttachmentRowWithoutCardFields(t *testing.T) {
	now := timeNowMs()
	tbl := buttonTemplateTable(now)
	// CTA rows only point at an attachment row that has no card fields
	for _, cta := range tbl.LSInsertAttachmentCta {
		cta.MessageId = ""
	}
	tbl.LSInsertAttachment = []*table.LSInsertAttachment{{MessageId: "mid.button", AttachmentFbid: "att.button"}}
	extras := newTableExtras(tbl)
	_, insert := tbl.WrapMessages()
	msg := (&Client{threadCache: map[int64]*Thread{}}).convertWrappedMessage(insert[0], extras)
	if len(msg.Attachments) != 1 || len(msg.Attachments[0].Buttons) != 3 {
		t.Fatalf("attachments = %#v", msg.Attachments)
	}
}

func TestCardButtonsAreNotRepeatedAndPollRowsIgnored(t *testing.T) {
	now := timeNowMs()
	tbl := optInTable(now)
	tbl.LSInsertAttachmentCta = append(tbl.LSInsertAttachmentCta,
		&table.LSInsertAttachmentCta{CtaId: 41, MessageId: "mid.optin", Title: "Bình chọn", Type_: "xma_poll_vote"})
	extras := newTableExtras(tbl)
	_, insert := tbl.WrapMessages()
	msg := (&Client{threadCache: map[int64]*Thread{}}).convertWrappedMessage(insert[0], extras)
	if len(msg.Attachments) != 1 || len(msg.Attachments[0].Buttons) != 3 {
		t.Fatalf("attachments = %#v, want the card's 3 buttons only", msg.Attachments)
	}

	plain := &table.LSTable{LSInsertMessage: []*table.LSInsertMessage{{MessageId: "mid.plain", ThreadKey: 1, SenderId: 2, TimestampMs: now, Text: "hi"}}}
	_, insert = plain.WrapMessages()
	if got := (&Client{threadCache: map[int64]*Thread{}}).convertWrappedMessage(insert[0], newTableExtras(plain)); len(got.Attachments) != 0 {
		t.Fatalf("plain text got attachments %#v", got.Attachments)
	}
}
