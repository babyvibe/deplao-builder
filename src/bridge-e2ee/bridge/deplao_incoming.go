package bridge

// DEPLAO_ADAPTER: incoming Messenger events mautrix-meta handles and fbchat-v2
// does not (mautrix-meta pkg/connector handlemeta.go / handlewhatsapp.go,
// pkg/msgconv/from-whatsapp.go):
//   - thread rows sent as LSUpdateOrInsertThread (name, picture, folder, mute);
//   - message request status changes (LSDeleteThenInsertMessageRequest);
//   - block state of contacts (LSDeleteThenInsertContact / LSVerifyContactRowExists);
//   - encrypted messages that could not be decrypted: a placeholder with the
//     message id, replaced when the sender's re-send arrives;
//   - encrypted content: view-once media (consumer ViewOnceMessage, Armadillo
//     Raven), "bumped" messages, location shares sent as an XMA card, story
//     replies and the text of XMA cards;
//   - the LightSpeed app state (foreground while a chat is on screen), which
//     Messenger web reports so that typing reaches the client.

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow/proto/armadilloutil"
	"go.mau.fi/whatsmeow/proto/waArmadilloApplication"
	"go.mau.fi/whatsmeow/proto/waArmadilloXMA"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	"go.mau.fi/whatsmeow/types/events"

	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const EventTypeContactBlocks EventType = "contactBlocks"

// Unsupported kinds the app shows as a line of text.
const (
	unsupportedUndecryptable = "undecryptable"
	unsupportedBump          = "bump"
)

// ─── Thread rows, message requests, contact blocks ───────────────────────────

// threadUpdateFromUpsertRow is threadUpdateFromRow for LSUpdateOrInsertThread rows.
func threadUpdateFromUpsertRow(row *table.LSUpdateOrInsertThread) *ThreadUpdate {
	if row == nil || row.ThreadKey == 0 {
		return nil
	}
	return &ThreadUpdate{
		ThreadID:         strconv.FormatInt(row.ThreadKey, 10),
		Type:             int(row.ThreadType),
		Name:             row.ThreadName,
		Snippet:          row.Snippet,
		LastActivityMs:   row.LastActivityTimestampMs,
		FolderName:       row.FolderName,
		PictureURL:       firstNonEmpty(row.ThreadPictureUrl, row.ThreadPictureUrlFallback),
		MuteExpireTimeMs: row.MuteExpireTimeMs,
		IsMessageRequest: row.FolderName == FolderPending,
	}
}

// upsertThreadUpdates converts the LSUpdateOrInsertThread rows of a table that
// have no LSDeleteThenInsertThread row (the full row wins, like mautrix-meta).
func upsertThreadUpdates(tbl *table.LSTable) []*ThreadUpdate {
	if tbl == nil || len(tbl.LSUpdateOrInsertThread) == 0 {
		return nil
	}
	full := make(map[int64]bool, len(tbl.LSDeleteThenInsertThread))
	for _, row := range tbl.LSDeleteThenInsertThread {
		if row != nil {
			full[row.ThreadKey] = true
		}
	}
	updates := make([]*ThreadUpdate, 0, len(tbl.LSUpdateOrInsertThread))
	for _, row := range tbl.LSUpdateOrInsertThread {
		if row == nil || full[row.ThreadKey] {
			continue
		}
		if update := threadUpdateFromUpsertRow(row); update != nil {
			updates = append(updates, update)
		}
	}
	return updates
}

// emitIncomingThreadTables reports message request status changes and the block
// state of the contacts in a table.
func (c *Client) emitIncomingThreadTables(tbl *table.LSTable) {
	if tbl == nil {
		return
	}
	for _, row := range tbl.LSDeleteThenInsertMessageRequest {
		if row == nil || row.ThreadKey <= 0 {
			continue
		}
		// Status 1 = in the message request folder (mautrix-meta handleDeleteThenInsertMessageRequest)
		folder := FolderInbox
		if row.MessageRequestStatus == 1 {
			folder = FolderPending
		}
		c.emitEvent(EventTypeThreadFolder, map[string]any{
			"threadId":   strconv.FormatInt(row.ThreadKey, 10),
			"folderName": folder,
		})
	}
	if blocked, unblocked := contactBlocksOf(tbl); len(blocked)+len(unblocked) > 0 {
		c.emitEvent(EventTypeContactBlocks, map[string]any{"blocked": blocked, "unblocked": unblocked})
	}
}

// contactBlocksOf splits the contacts of a table by whether the account blocked them.
func contactBlocksOf(tbl *table.LSTable) (blocked, unblocked []string) {
	seen := make(map[int64]bool)
	add := func(id int64, isBlocked bool) {
		if id <= 0 || seen[id] {
			return
		}
		seen[id] = true
		if isBlocked {
			blocked = append(blocked, strconv.FormatInt(id, 10))
		} else {
			unblocked = append(unblocked, strconv.FormatInt(id, 10))
		}
	}
	for _, row := range tbl.LSDeleteThenInsertContact {
		if row != nil {
			add(row.GetFBID(), row.BlockedByViewerStatus != 0)
		}
	}
	for _, row := range tbl.LSVerifyContactRowExists {
		if row != nil {
			add(row.GetFBID(), row.IsBlocked || row.BlockedByViewerStatus != 0)
		}
	}
	return blocked, unblocked
}

// ─── App state (typing) ──────────────────────────────────────────────────────

// SetAppState reports Messenger's app state: foreground while a chat is on
// screen (Messenger web does this for a visible tab; typing indicators are only
// sent to foreground clients), background otherwise.
func (c *Client) SetAppState(foreground bool) error {
	state := table.BACKGROUND
	if foreground {
		state = table.FOREGROUND
	}
	return c.runThreadTask(&socket.ReportAppStateTask{AppState: state, RequestID: uuid.NewString()}, "Facebook rejected the app state")
}

// ─── Encrypted messages ──────────────────────────────────────────────────────

// undecryptablePlaceholder is the message shown for an encrypted message whose
// decryption failed; whatsmeow asks the sender to send it again, and the
// re-sent copy (same id) replaces it in the app (mautrix-meta
// WAUndecryptableMessage). nil when the failure is meant to be hidden.
func undecryptablePlaceholder(e *events.UndecryptableMessage) *E2EEMessage {
	if e == nil || e.DecryptFailMode == events.DecryptFailHide || e.Info.ID == "" {
		return nil
	}
	msg := &E2EEMessage{
		ID:          e.Info.ID,
		ChatJID:     e.Info.Chat.String(),
		SenderJID:   e.Info.Sender.String(),
		TimestampMs: e.Info.Timestamp.UnixMilli(),
		Attachments: []*Attachment{},
		Mentions:    []*Mention{},
		Unsupported: unsupportedUndecryptable,
	}
	msg.ThreadID, _ = strconv.ParseInt(jidUserID(e.Info.Chat), 10, 64)
	msg.SenderID, _ = strconv.ParseInt(jidUserID(e.Info.Sender), 10, 64)
	return msg
}

// viewOnceAttachment is the image / video of a consumer view-once message.
func (c *Client) viewOnceAttachment(viewOnce *waConsumerApplication.ConsumerApplication_ViewOnceMessage) (*Attachment, *waCommon.MessageText) {
	if viewOnce == nil {
		return nil, nil
	}
	if img := viewOnce.GetImageMessage(); img != nil {
		att := c.extractE2EEImageAttachment(img)
		att.ViewOnce = true
		return att, img.GetCaption()
	}
	if vid := viewOnce.GetVideoMessage(); vid != nil {
		att := c.extractE2EEVideoAttachment(vid)
		att.ViewOnce = true
		return att, vid.GetCaption()
	}
	return nil, nil
}

// ravenAttachment is the image / video of an Armadillo "Raven" (view once / replayable) message.
func ravenAttachment(raven *waArmadilloApplication.Armadillo_Content_RavenMessage) *Attachment {
	if raven == nil {
		return nil
	}
	var att *Attachment
	switch raven.GetMediaContent().(type) {
	case *waArmadilloApplication.Armadillo_Content_RavenMessage_ImageMessage:
		if img, err := raven.DecodeImageMessage(); err == nil {
			att = e2eeImageAttachmentFromTransport(img)
		}
	case *waArmadilloApplication.Armadillo_Content_RavenMessage_VideoMessage:
		if video, err := raven.DecodeVideoMessage(); err == nil {
			att = e2eeVideoAttachmentFromTransport(video)
		}
	}
	if att != nil {
		att.ViewOnce = raven.GetEphemeralType() != waArmadilloApplication.Armadillo_Content_RavenMessage_KEEP_IN_CHAT
	}
	return att
}

// e2eeVideoAttachmentFromTransport builds a video attachment (download fields included) from a decoded transport.
func e2eeVideoAttachmentFromTransport(transport *waMediaTransport.VideoTransport) *Attachment {
	att := &Attachment{Type: "video"}
	if transport == nil {
		return att
	}
	if ancillary := transport.GetAncillary(); ancillary != nil {
		att.Width = int(ancillary.GetWidth())
		att.Height = int(ancillary.GetHeight())
		att.Duration = int(ancillary.GetSeconds())
	}
	if integral := transport.GetIntegral(); integral != nil {
		if waTransport := integral.GetTransport(); waTransport != nil {
			if ancillary := waTransport.GetAncillary(); ancillary != nil {
				att.MimeType = ancillary.GetMimetype()
				att.FileSize = int64(ancillary.GetFileLength())
			}
			if integral := waTransport.GetIntegral(); integral != nil {
				att.MediaKey = integral.GetMediaKey()
				att.MediaSHA256 = integral.GetFileSHA256()
				att.MediaEncSHA256 = integral.GetFileEncSHA256()
				att.DirectPath = integral.GetDirectPath()
			}
		}
	}
	return att
}

// bumpReply is the message a "bump" brings back to the top (Messenger's
// "bump"), shown as a reply to it (mautrix-meta replyOverride).
func (c *Client) bumpReply(key *waCommon.MessageKey) *ReplyTo {
	if key == nil || key.GetID() == "" {
		return nil
	}
	reply := &ReplyTo{MessageID: key.GetID()}
	if key.GetFromMe() {
		reply.SenderID = c.FBID
	} else if sender := firstNonEmpty(key.GetParticipant(), key.GetRemoteJID()); sender != "" {
		reply.SenderID, _ = strconv.ParseInt(jidStringUser(sender), 10, 64)
	}
	return reply
}

// jidStringUser is the user part of a JID string ("123.0:5@msgr" → "123").
func jidStringUser(jid string) string {
	user := jid
	if at := strings.IndexByte(user, '@'); at >= 0 {
		user = user[:at]
	}
	if cut := strings.IndexAny(user, ".:"); cut >= 0 {
		user = user[:cut]
	}
	return user
}

// locationShareAttachment is the location of an XMA card whose button opens
// messenger://location_share?lat=…&long=… (mautrix-meta waLocationMessageToMatrix).
func locationShareAttachment(extMsg *waArmadilloXMA.ExtendedContentMessage) *Attachment {
	for _, cta := range extMsg.GetCtas() {
		parsed, err := url.Parse(cta.GetNativeURL())
		if err != nil || parsed.Scheme != "messenger" || parsed.Host != "location_share" {
			continue
		}
		lat, errLat := strconv.ParseFloat(parsed.Query().Get("lat"), 64)
		long, errLong := strconv.ParseFloat(parsed.Query().Get("long"), 64)
		if errLat != nil || errLong != nil {
			continue
		}
		return &Attachment{
			Type:      "location",
			Latitude:  lat,
			Longitude: long,
			FileName:  strings.TrimSpace(strings.Join(nonEmpty(extMsg.GetTitleText(), extMsg.GetSubtitleText()), "\n")),
		}
	}
	return nil
}

func nonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

// storyReplyText is the reply someone wrote to a Facebook story, carried in the
// card's associated message (mautrix-meta waStoryReplyMessageToMatrix).
func storyReplyText(extMsg *waArmadilloXMA.ExtendedContentMessage) string {
	if extMsg.GetAssociatedMessage() == nil {
		return ""
	}
	var assoc waMsgApplication.MessageApplication
	if _, err := armadilloutil.Unmarshal(&assoc, extMsg.GetAssociatedMessage(), 2); err != nil {
		return ""
	}
	var consumer waConsumerApplication.ConsumerApplication
	if _, err := armadilloutil.Unmarshal(&consumer, assoc.GetPayload().GetSubProtocol().GetConsumerMessage(), 1); err != nil {
		return ""
	}
	content := consumer.GetPayload().GetContent()
	if text := content.GetMessageText().GetText(); text != "" {
		return text
	}
	return content.GetExtendedTextMessage().GetText().GetText()
}

// applyExtendedContent fills a message from an XMA card: the card's text, a
// location share, a story reply. It returns false when the card is a signal to
// drop (a live location update without a position).
func (c *Client) applyExtendedContent(msg *E2EEMessage, extMsg *waArmadilloXMA.ExtendedContentMessage) bool {
	if loc := locationShareAttachment(extMsg); loc != nil {
		msg.Attachments = append(msg.Attachments, loc)
		return true
	}
	switch extMsg.GetTargetType() {
	case waArmadilloXMA.ExtendedContentMessage_MSG_LOCATION_SHARING_V2:
		return false
	case waArmadilloXMA.ExtendedContentMessage_FB_STORY_REPLY, waArmadilloXMA.ExtendedContentMessage_IG_STORY_REPLY:
		if text := storyReplyText(extMsg); text != "" && msg.Text == "" {
			msg.Text = text
		}
		if att := c.extractArmadilloLinkAttachment(extMsg); att != nil {
			att.XmaType = "story_reply"
			msg.Attachments = append(msg.Attachments, att)
		}
		return true
	}
	if msg.Text == "" {
		msg.Text = extMsg.GetMessageText()
	}
	if att := c.extractArmadilloLinkAttachment(extMsg); att != nil {
		msg.Attachments = append(msg.Attachments, att)
	}
	return true
}
