package bridge

// DEPLAO_ADAPTER: Facebook Page templates / XMA cards.
//
// Upstream fbchat-v2 turns an XMA into a "link" attachment only when it has a
// URL or a preview image, keeps a single CTA per attachment (WrapMessages maps
// CTAs by attachment fbid) and ignores carousel items and legacy attachments.
// Button templates, marketing opt-in requests ("Offers and updates") and
// carousels from Pages therefore reached Deplao as empty messages. This file
// keeps every XMA as a structured "template" attachment with its texts, image,
// all buttons and carousel items. Plain URL previews stay "link" attachments.

import (
	"sort"
	"strconv"
	"strings"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// TemplateButton is one call-to-action of a template card.
type TemplateButton struct {
	Title     string `json:"title"`
	Type      string `json:"type,omitempty"` // raw Meta CTA type, e.g. xma_web_url
	URL       string `json:"url,omitempty"`
	NativeURL string `json:"nativeUrl,omitempty"`
	// IDs are strings: they can exceed the 2^53 precision of JSON numbers.
	CtaID    string `json:"ctaId,omitempty"`
	TargetID string `json:"targetId,omitempty"`
}

// TemplateItem is one element of a carousel (generic template with many cards).
type TemplateItem struct {
	Title    string            `json:"title,omitempty"`
	Subtitle string            `json:"subtitle,omitempty"`
	ImageURL string            `json:"imageUrl,omitempty"`
	URL      string            `json:"url,omitempty"`
	Buttons  []*TemplateButton `json:"buttons,omitempty"`
}

// tableExtras indexes the rows of one LightSpeed table that WrapMessages does
// not attach to messages: every CTA (not only the last per attachment), the
// CTAs of each message (button templates have no card) and the carousel items.
type tableExtras struct {
	ctaByID          map[int64]*table.LSInsertAttachmentCta
	ctasByAttachment map[string][]*table.LSInsertAttachmentCta
	ctasByMessage    map[string][]*table.LSInsertAttachmentCta
	itemsByMessage   map[string][]*table.LSInsertAttachmentItem
}

func newTableExtras(tbl *table.LSTable) *tableExtras {
	extras := &tableExtras{
		ctaByID:          map[int64]*table.LSInsertAttachmentCta{},
		ctasByAttachment: map[string][]*table.LSInsertAttachmentCta{},
		ctasByMessage:    map[string][]*table.LSInsertAttachmentCta{},
		itemsByMessage:   map[string][]*table.LSInsertAttachmentItem{},
	}
	if tbl == nil {
		return extras
	}
	for _, cta := range tbl.LSInsertAttachmentCta {
		if cta == nil {
			continue
		}
		if cta.CtaId != 0 {
			extras.ctaByID[cta.CtaId] = cta
		}
		if cta.AttachmentFbid != "" {
			extras.ctasByAttachment[cta.AttachmentFbid] = append(extras.ctasByAttachment[cta.AttachmentFbid], cta)
		}
		if cta.MessageId != "" {
			extras.ctasByMessage[cta.MessageId] = append(extras.ctasByMessage[cta.MessageId], cta)
		}
	}
	for _, item := range tbl.LSInsertAttachmentItem {
		if item == nil || item.MessageId == "" {
			continue
		}
		extras.itemsByMessage[item.MessageId] = append(extras.itemsByMessage[item.MessageId], item)
	}
	for _, items := range extras.itemsByMessage {
		sort.SliceStable(items, func(i, j int) bool { return items[i].AttachmentIndex < items[j].AttachmentIndex })
	}
	return extras
}

type ctaRef struct {
	id    int64
	title string
	kind  string
}

func normalizeActionURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	return extractURLFromLPHP(raw)
}

func (x *tableExtras) button(ref ctaRef) *TemplateButton {
	title := strings.TrimSpace(ref.title)
	var cta *table.LSInsertAttachmentCta
	if x != nil && ref.id != 0 {
		cta = x.ctaByID[ref.id]
	}
	if title == "" && cta != nil {
		title = strings.TrimSpace(cta.Title)
	}
	if title == "" {
		return nil
	}
	button := &TemplateButton{Title: title, Type: ref.kind}
	if ref.id != 0 {
		button.CtaID = strconv.FormatInt(ref.id, 10)
	}
	if cta != nil {
		if button.Type == "" {
			button.Type = cta.Type_
		}
		button.URL = normalizeActionURL(cta.ActionUrl)
		button.NativeURL = strings.TrimSpace(cta.NativeUrl)
		if cta.TargetId != 0 {
			button.TargetID = strconv.FormatInt(cta.TargetId, 10)
		}
	}
	return button
}

func (x *tableExtras) buttons(refs []ctaRef, attachmentFbid string, defaultCtaID int64) []*TemplateButton {
	buttons := []*TemplateButton{}
	seen := map[int64]bool{}
	for _, ref := range refs {
		if ref.id != 0 {
			if seen[ref.id] {
				continue
			}
			seen[ref.id] = true
		}
		if button := x.button(ref); button != nil {
			buttons = append(buttons, button)
		}
	}
	// CTA rows the card did not reference by index (the card's own CTA fields
	// can be empty while the rows exist). The default CTA is the tap action of
	// the whole card, not a visible button.
	if x != nil && attachmentFbid != "" {
		for _, cta := range x.ctasByAttachment[attachmentFbid] {
			if cta.CtaId == 0 || seen[cta.CtaId] || cta.CtaId == defaultCtaID {
				continue
			}
			if isNonButtonCta(cta.Type_) {
				continue
			}
			seen[cta.CtaId] = true
			if button := x.button(ctaRef{id: cta.CtaId, title: cta.Title, kind: cta.Type_}); button != nil {
				buttons = append(buttons, button)
			}
		}
	}
	if len(buttons) == 0 {
		return nil
	}
	return buttons
}

// isNonButtonCta reports CTA rows that are never visible buttons (poll
// metadata, map / live-location taps).
func isNonButtonCta(kind string) bool {
	return strings.HasPrefix(kind, "xma_poll_") || kind == "xma_map" || kind == "xma_live_location_sharing"
}

// orphanButtons returns the CTA rows of a message that no card used. A Page
// button template ("text + up to 3 buttons", e.g. "Hãy chọn dịch vụ…" with
// "Tư vấn sản phẩm") has no XMA card: the text is the message text and the
// buttons are CTA rows tied to the message, or to an attachment row without
// card fields. Upstream drops them, and the MQTT copy of the same message is
// only Facebook's "Attachment unavailable" placeholder, so Deplao showed
// nothing usable. cardFbids are attachments already turned into cards (their
// CTAs were considered there); used are CTA ids already shown as buttons.
func (x *tableExtras) orphanButtons(msg *table.WrappedMessage, cardFbids map[string]bool, used map[string]bool) []*TemplateButton {
	if x == nil || msg == nil || msg.LSInsertMessage == nil || msg.MessageId == "" {
		return nil
	}
	candidates := append([]*table.LSInsertAttachmentCta{}, x.ctasByMessage[msg.MessageId]...)
	for _, legacy := range msg.Attachments {
		if legacy != nil && legacy.AttachmentFbid != "" && !cardFbids[legacy.AttachmentFbid] {
			candidates = append(candidates, x.ctasByAttachment[legacy.AttachmentFbid]...)
		}
	}
	buttons := []*TemplateButton{}
	seen := map[string]bool{}
	for _, cta := range candidates {
		if cta == nil || isNonButtonCta(cta.Type_) {
			continue
		}
		if cta.AttachmentFbid != "" && cardFbids[cta.AttachmentFbid] {
			continue
		}
		key := "title:" + strings.TrimSpace(cta.Title)
		if cta.CtaId != 0 {
			key = "id:" + strconv.FormatInt(cta.CtaId, 10)
			if used[strconv.FormatInt(cta.CtaId, 10)] {
				continue
			}
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if button := x.button(ctaRef{id: cta.CtaId, title: cta.Title, kind: cta.Type_}); button != nil {
			buttons = append(buttons, button)
		}
	}
	if len(buttons) == 0 {
		return nil
	}
	return buttons
}

// usedCtaIDs collects the CTA ids already shown as buttons on the cards.
func usedCtaIDs(attachments []*Attachment) map[string]bool {
	used := map[string]bool{}
	add := func(buttons []*TemplateButton) {
		for _, button := range buttons {
			if button != nil && button.CtaID != "" {
				used[button.CtaID] = true
			}
		}
	}
	for _, att := range attachments {
		if att == nil {
			continue
		}
		add(att.Buttons)
		for _, item := range att.Items {
			if item != nil {
				add(item.Buttons)
			}
		}
	}
	return used
}

// attachOrphanButtons puts the orphan CTA rows of a message on its first
// template, or on a new text-less template (the text stays the message text).
func attachOrphanButtons(attachments []*Attachment, buttons []*TemplateButton) []*Attachment {
	if len(buttons) == 0 {
		return attachments
	}
	for _, att := range attachments {
		if att != nil && att.Type == "template" {
			att.Buttons = append(att.Buttons, buttons...)
			return attachments
		}
	}
	return append(attachments, &Attachment{Type: "template", Buttons: buttons})
}

func (x *tableExtras) defaultActionURL(defaultCtaID int64, fallback string) string {
	if x != nil && defaultCtaID != 0 {
		if cta := x.ctaByID[defaultCtaID]; cta != nil {
			if url := normalizeActionURL(cta.ActionUrl); url != "" {
				return url
			}
		}
	}
	return normalizeActionURL(fallback)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// templateItems converts the carousel rows of a message.
func (x *tableExtras) templateItems(messageID string) []*TemplateItem {
	if x == nil || messageID == "" {
		return nil
	}
	rows := x.itemsByMessage[messageID]
	if len(rows) == 0 {
		return nil
	}
	items := make([]*TemplateItem, 0, len(rows))
	for _, row := range rows {
		item := &TemplateItem{
			Title:    strings.TrimSpace(row.TitleText),
			Subtitle: strings.TrimSpace(row.SubtitleText),
			ImageURL: firstNonEmpty(row.ImageUrl, row.PreviewUrlLarge, row.PreviewUrl),
			URL:      x.defaultActionURL(row.DefaultCtaId, row.DefaultActionUrl),
			Buttons: x.buttons([]ctaRef{
				{row.AttachmentCta1Id, row.Cta1Title, row.Cta1Type},
				{row.AttachmentCta2Id, row.Cta2Title, row.Cta2Type},
				{row.AttachmentCta3Id, row.Cta3Title, row.Cta3Type},
			}, "", row.DefaultCtaId),
		}
		if item.Title == "" && item.Subtitle == "" && item.ImageURL == "" && len(item.Buttons) == 0 {
			continue
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil
	}
	return items
}

// isPlainURLPreview reports a link preview (pasted URL): no buttons and no
// carousel. Those keep the "link" type the app already renders.
func isPlainURLPreview(att *Attachment) bool {
	return att.URL != "" && len(att.Buttons) == 0 && len(att.Items) == 0 &&
		att.Header == "" && att.Footer == ""
}

// convertXMA turns an XMA attachment into a "template" (or "link" for a plain
// URL preview). It never drops the card: a card without any text, image,
// button or link returns nil.
func (x *tableExtras) convertXMA(xma *table.WrappedXMA) *Attachment {
	if xma == nil || xma.LSInsertXmaAttachment == nil {
		return nil
	}
	refs := []ctaRef{
		{xma.AttachmentCta1Id, xma.Cta1Title, xma.Cta1Type},
		{xma.AttachmentCta2Id, xma.Cta2Title, xma.Cta2Type},
		{xma.AttachmentCta3Id, xma.Cta3Title, xma.Cta3Type},
	}
	if xma.CTA != nil && xma.CTA.CtaId == 0 && strings.TrimSpace(xma.CTA.Title) != "" {
		// A CTA row without an id cannot be found by index: keep its title.
		refs = append(refs, ctaRef{title: xma.CTA.Title, kind: xma.CTA.Type_})
	}
	linkURL := ""
	if xma.CTA != nil {
		linkURL = normalizeActionURL(xma.CTA.ActionUrl)
	}
	if linkURL == "" {
		linkURL = x.defaultActionURL(xma.DefaultCtaId, xma.ActionUrl)
	}
	att := &Attachment{
		Type:        "template",
		URL:         linkURL,
		PreviewURL:  firstNonEmpty(xma.PreviewUrl, xma.PreviewUrlLarge),
		Title:       firstNonEmpty(xma.TitleText, xma.HeaderTitle),
		Subtitle:    strings.TrimSpace(xma.SubtitleText),
		Header:      strings.TrimSpace(xma.HeaderTitle),
		Body:        firstNonEmpty(xma.BodyText, xma.CaptionBodyText, xma.DescriptionText),
		Footer:      strings.TrimSpace(xma.FooterTitle),
		SourceText:  strings.TrimSpace(xma.SourceText),
		ImageURL:    firstNonEmpty(xma.ImageUrl, xma.PreviewUrl, xma.PreviewUrlLarge, xma.HeaderImageUrl),
		Width:       int(xma.PreviewWidth),
		Height:      int(xma.PreviewHeight),
		Buttons:     x.buttons(refs, xma.AttachmentFbid, xma.DefaultCtaId),
		XmaType:     firstNonEmpty(xma.XmaDataclass, xma.XMATypeOne, xma.XMATypeTwo),
		FileName:    strings.TrimSpace(xma.TitleText),
		Description: strings.TrimSpace(xma.SubtitleText),
	}
	if att.Header == att.Title {
		att.Header = ""
	}
	if att.Body == att.Subtitle {
		att.Body = ""
	}
	// Short list templates carry their rows in the card itself.
	for _, line := range []string{xma.ListItemTitleText1, xma.ListItemTitleText2, xma.ListItemTitleText3} {
		if line = strings.TrimSpace(line); line != "" {
			if att.Body != "" {
				att.Body += "\n"
			}
			att.Body += line
		}
	}
	if isPlainURLPreview(att) {
		att.Type = "link"
	}
	if att.Title == "" && att.Subtitle == "" && att.Body == "" && att.Header == "" && att.Footer == "" &&
		att.ImageURL == "" && att.URL == "" && len(att.Buttons) == 0 {
		return nil
	}
	return att
}

// convertLegacyAttachment handles LSInsertAttachment rows: XMA-like cards
// (HasXma or button titles) become templates, media becomes the usual types.
func (x *tableExtras) convertLegacyAttachment(legacy *table.LSInsertAttachment) *Attachment {
	if legacy == nil {
		return nil
	}
	hasCard := legacy.HasXma || legacy.AttachmentType == table.AttachmentTypeXMA ||
		strings.TrimSpace(legacy.Cta1Title) != "" || strings.TrimSpace(legacy.TitleText) != ""
	mediaURL := firstNonEmpty(legacy.PlayableUrl, legacy.PreviewUrl)
	if !hasCard || (legacy.HasMedia && legacy.AttachmentType != table.AttachmentTypeXMA && mediaURL != "") {
		att := &Attachment{
			FileName: legacy.Filename,
			FileSize: legacy.Filesize,
			MimeType: firstNonEmpty(legacy.AttachmentMimeType, legacy.PlayableUrlMimeType, legacy.PreviewUrlMimeType),
			Width:    int(legacy.PreviewWidth),
			Height:   int(legacy.PreviewHeight),
		}
		switch legacy.AttachmentType {
		case table.AttachmentTypeImage, table.AttachmentTypeEphemeralImage:
			att.Type = "image"
			att.URL = firstNonEmpty(legacy.PreviewUrl, legacy.PlayableUrl)
		case table.AttachmentTypeAnimatedImage:
			att.Type = "gif"
			att.URL = mediaURL
			att.PreviewURL = legacy.PreviewUrl
		case table.AttachmentTypeVideo, table.AttachmentTypeEphemeralVideo:
			att.Type = "video"
			att.URL = legacy.PlayableUrl
			att.PreviewURL = legacy.PreviewUrl
			att.Duration = int(legacy.PlayableDurationMs / 1000)
		case table.AttachmentTypeAudio, table.AttachmentTypeSoundBite:
			att.Type = "audio"
			att.URL = legacy.PlayableUrl
			att.Duration = int(legacy.PlayableDurationMs / 1000)
		default:
			att.Type = "file"
			att.URL = mediaURL
		}
		if att.URL == "" {
			return nil
		}
		return att
	}
	wrapped := &table.WrappedXMA{LSInsertXmaAttachment: &table.LSInsertXmaAttachment{
		PreviewUrl:       legacy.PreviewUrl,
		PreviewWidth:     legacy.PreviewWidth,
		PreviewHeight:    legacy.PreviewHeight,
		AttachmentFbid:   legacy.AttachmentFbid,
		MessageId:        legacy.MessageId,
		DefaultCtaId:     legacy.DefaultCtaId,
		AttachmentCta1Id: legacy.AttachmentCta1Id,
		Cta1Title:        legacy.Cta1Title,
		Cta1Type:         legacy.Cta1Type,
		AttachmentCta2Id: legacy.AttachmentCta2Id,
		Cta2Title:        legacy.Cta2Title,
		Cta2Type:         legacy.Cta2Type,
		AttachmentCta3Id: legacy.AttachmentCta3Id,
		Cta3Title:        legacy.Cta3Title,
		Cta3Type:         legacy.Cta3Type,
		ImageUrl:         legacy.ImageUrl,
		ActionUrl:        legacy.ActionUrl,
		TitleText:        legacy.TitleText,
		SubtitleText:     legacy.SubtitleText,
		DescriptionText:  legacy.DescriptionText,
		SourceText:       legacy.SourceText,
	}}
	return x.convertXMA(wrapped)
}

// attachTemplateItems puts a message's carousel rows on its first template
// (or creates one when the message has no other card).
func (x *tableExtras) attachTemplateItems(messageID string, attachments []*Attachment) []*Attachment {
	items := x.templateItems(messageID)
	if len(items) == 0 {
		return attachments
	}
	for _, att := range attachments {
		if att.Type == "template" || att.Type == "link" {
			att.Type = "template"
			att.Items = append(att.Items, items...)
			return attachments
		}
	}
	return append(attachments, &Attachment{Type: "template", Items: items})
}
