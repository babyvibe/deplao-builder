package bridge

import (
	"context"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"

	"go.mau.fi/mautrix-meta/pkg/messagix/methods"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// SendMessageOptions for sending messages
type SendMessageOptions struct {
	ThreadID        int64   `json:"threadId"`
	Text            string  `json:"text"`
	ReplyToID       string  `json:"replyToId,omitempty"`
	MentionIDs      []int64 `json:"mentionIds,omitempty"`
	MentionOffsets  []int   `json:"mentionOffsets,omitempty"`
	MentionLengths  []int   `json:"mentionLengths,omitempty"`
	AttachmentFbIds []int64 `json:"attachmentFbIds,omitempty"`
	StickerID       int64   `json:"stickerId,omitempty"`
	Url             string  `json:"url,omitempty"`
	IsE2EE          bool    `json:"isE2EE,omitempty"`
	E2EEChatJID     string  `json:"e2eeChatJid,omitempty"`
	// E2EE Reply fields
	E2EEReplyToID        string `json:"e2eeReplyToId,omitempty"`
	E2EEReplyToSenderJID string `json:"e2eeReplyToSenderJid,omitempty"`
}

// SendMessageResult result of sending a message
type SendMessageResult struct {
	MessageID   string `json:"messageId"`
	TimestampMs int64  `json:"timestampMs"`
}

// SendMessage sends a text message
func (c *Client) SendMessage(opts *SendMessageOptions) (*SendMessageResult, error) {
	if opts.IsE2EE {
		if !c.IsE2EEConnected() {
			return nil, ErrE2EENotConnected
		}
		return c.sendE2EEMessage(opts)
	}
	return c.sendRegularMessage(opts)
}

func (c *Client) sendRegularMessage(opts *SendMessageOptions) (*SendMessageResult, error) {
	if err := c.Messagix.WaitUntilCanSendMessages(c.ctx, 10*time.Second); err != nil {
		return nil, err
	}

	otid := time.Now().UnixNano()
	sendType := table.TEXT

	if opts.StickerID > 0 {
		sendType = table.STICKER
	} else if len(opts.AttachmentFbIds) > 0 {
		sendType = table.MEDIA
	} else if opts.Url != "" {
		sendType = table.EXTERNAL_MEDIA
	}

	task := &socket.SendMessageTask{
		ThreadId:        opts.ThreadID,
		Otid:            otid,
		Text:            opts.Text,
		Source:          table.MESSENGER_INBOX_IN_THREAD,
		SendType:        sendType,
		SyncGroup:       1,
		StickerId:       opts.StickerID,
		Url:             opts.Url,
		AttachmentFBIds: opts.AttachmentFbIds,
	}

	// Handle reply
	if opts.ReplyToID != "" {
		task.ReplyMetaData = &socket.ReplyMetaData{
			ReplyMessageId:  opts.ReplyToID,
			ReplySourceType: 1,
			ReplyType:       0,
		}
	}

	// Handle mentions
	if len(opts.MentionIDs) > 0 {
		task.MentionData = buildMentionData(opts.MentionIDs, opts.MentionOffsets, opts.MentionLengths)
	}

	resp, err := c.Messagix.ExecuteTasks(c.ctx, task)
	if err != nil {
		return nil, err
	}

	result := &SendMessageResult{
		MessageID:   generateMID(otid),
		TimestampMs: time.Now().UnixMilli(),
	}

	// Try to get actual message ID from response
	otidStr := strconv.FormatInt(otid, 10)
	if resp != nil {
		for _, r := range resp.LSReplaceOptimsiticMessage {
			if r.OfflineThreadingId == otidStr {
				result.MessageID = r.MessageId
				break
			}
		}
	}

	return result, nil
}

func (c *Client) sendE2EEMessage(opts *SendMessageOptions) (*SendMessageResult, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return nil, ErrE2EENotConnected
	}

	chatJID, err := parseJID(opts.E2EEChatJID)
	if err != nil {
		return nil, err
	}
	if err = c.ensureE2EEDM(chatJID); err != nil {
		return nil, err
	}

	waMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_MessageText{
						MessageText: &waCommon.MessageText{Text: &opts.Text},
					},
				},
			},
		},
	}

	// Build metadata for reply if specified
	var metadata *waMsgApplication.MessageApplication_Metadata
	if opts.E2EEReplyToID != "" {
		metadata = &waMsgApplication.MessageApplication_Metadata{
			QuotedMessage: &waMsgApplication.MessageApplication_Metadata_QuotedMessage{
				StanzaID: &opts.E2EEReplyToID,
			},
		}
		if opts.E2EEReplyToSenderJID != "" {
			metadata.QuotedMessage.Participant = &opts.E2EEReplyToSenderJID
		}
	}

	msgID := strconv.FormatInt(time.Now().UnixNano(), 10)
	resp, err := e2eeClient.SendFBMessage(c.ctx, chatJID, waMsg, metadata, whatsmeow.SendRequestExtra{ID: msgID})
	if err != nil {
		if isE2EESendResponseTimeout(err) {
			return &SendMessageResult{
				MessageID:   msgID,
				TimestampMs: time.Now().UnixMilli(),
			}, nil
		}
		return nil, err
	}

	return &SendMessageResult{
		MessageID:   msgID,
		TimestampMs: resp.Timestamp.UnixMilli(),
	}, nil
}

func (c *Client) ensureE2EEDM(chatJID waTypes.JID) error {
	if chatJID.Server != waTypes.MessengerServer || chatJID.User == "" {
		return nil
	}

	threadID, err := strconv.ParseInt(chatJID.User, 10, 64)
	if err != nil {
		return err
	}

	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.CreateWhatsAppThreadTask{
		WAJID:            threadID,
		OfflineThreadKey: methods.GenerateEpochID(),
		ThreadType:       table.ENCRYPTED_OVER_WA_ONE_TO_ONE,
		FolderType:       table.INBOX,
		BumpTimestampMS:  time.Now().UnixMilli(),
		TAMThreadSubtype: 0,
	})
	if err != nil {
		return err
	}

	if resp == nil || len(resp.LSIssueNewTask) == 0 {
		return nil
	}
	tasks := make([]socket.Task, len(resp.LSIssueNewTask))
	for idx, task := range resp.LSIssueNewTask {
		tasks[idx] = task
	}
	_, err = c.Messagix.ExecuteTasks(c.ctx, tasks...)
	return err
}

func isE2EESendResponseTimeout(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "timed out waiting for message send response")
}

// SendReaction sends a reaction to a message
func (c *Client) SendReaction(threadID int64, messageID, emoji string) error {
	task := &socket.SendReactionTask{
		ThreadKey:       threadID,
		MessageID:       messageID,
		Reaction:        emoji,
		ActorID:         c.FBID,
		SendAttribution: table.MESSENGER_INBOX_IN_THREAD,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// SendE2EEReaction sends an E2EE reaction
func (c *Client) SendE2EEReaction(chatJIDStr, messageID, senderJIDStr, emoji string) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return ErrE2EENotConnected
	}

	chatJID, err := parseJID(chatJIDStr)
	if err != nil {
		return err
	}
	senderJID, err := parseJID(senderJIDStr)
	if err != nil {
		return err
	}

	msgKey := e2eeClient.BuildMessageKey(chatJID, senderJID, messageID)
	reactionMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_ReactionMessage{
						ReactionMessage: &waConsumerApplication.ConsumerApplication_ReactionMessage{
							Key:  msgKey,
							Text: &emoji,
						},
					},
				},
			},
		},
	}

	reactionID := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, err = e2eeClient.SendFBMessage(c.ctx, chatJID, reactionMsg, nil, whatsmeow.SendRequestExtra{ID: reactionID})
	return err
}

// EditMessage edits a message
func (c *Client) EditMessage(messageID, newText string) error {
	task := &socket.EditMessageTask{
		MessageID: messageID,
		Text:      newText,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// UnsendMessage unsends/deletes a message
func (c *Client) UnsendMessage(messageID string) error {
	task := &socket.DeleteMessageTask{
		MessageId: messageID,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// SendTypingIndicator sends a typing indicator
func (c *Client) SendTypingIndicator(threadID int64, isTyping bool, isGroup bool, threadType int64) error {
	typingVal, groupVal := int64(0), int64(0)
	if isTyping {
		typingVal = 1
	}
	if isGroup {
		groupVal = 1
	}

	task := &socket.UpdatePresenceTask{
		ThreadKey:     threadID,
		IsGroupThread: groupVal,
		IsTyping:      typingVal,
		Attribution:   0,
		SyncGroup:     1,
		ThreadType:    threadType,
	}
	return c.Messagix.ExecuteStatelessTask(c.ctx, task)
}

// MarkRead marks messages as read
func (c *Client) MarkRead(threadID int64, watermarkTs int64) error {
	if watermarkTs == 0 {
		watermarkTs = time.Now().UnixMilli()
	}
	task := &socket.ThreadMarkReadTask{
		ThreadId:            threadID,
		LastReadWatermarkTs: watermarkTs,
		SyncGroup:           1,
	}
	_, err := c.Messagix.ExecuteTasks(c.ctx, task)
	return err
}

// Helper functions
func buildMentionData(ids []int64, offsets, lengths []int) *socket.MentionData {
	var idStrs, offsetStrs, lengthStrs, typeStrs []string
	for i, id := range ids {
		idStrs = append(idStrs, strconv.FormatInt(id, 10))
		if i < len(offsets) {
			offsetStrs = append(offsetStrs, strconv.Itoa(offsets[i]))
		}
		if i < len(lengths) {
			lengthStrs = append(lengthStrs, strconv.Itoa(lengths[i]))
		}
		typeStrs = append(typeStrs, "p")
	}
	return &socket.MentionData{
		MentionIDs:     joinStrings(idStrs),
		MentionOffsets: joinStrings(offsetStrs),
		MentionLengths: joinStrings(lengthStrs),
		MentionTypes:   joinStrings(typeStrs),
	}
}

func joinStrings(strs []string) string {
	result := ""
	for i, s := range strs {
		if i > 0 {
			result += ","
		}
		result += s
	}
	return result
}

func generateMID(otid int64) string {
	return "mid.$" + strconv.FormatInt(otid, 10)
}

func parseJID(jidStr string) (waTypes.JID, error) {
	if jidStr == "" {
		return waTypes.EmptyJID, nil
	}
	return waTypes.ParseJID(jidStr)
}

// E2EE send typing
func (c *Client) SendE2EETyping(chatJIDStr string, isTyping bool) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return ErrE2EENotConnected
	}

	chatJID, err := parseJID(chatJIDStr)
	if err != nil {
		return err
	}

	presence := waTypes.ChatPresencePaused
	if isTyping {
		presence = waTypes.ChatPresenceComposing
	}
	return e2eeClient.SendChatPresence(context.Background(), chatJID, presence, waTypes.ChatPresenceMediaText)
}

// EditE2EEMessage edits an E2EE message
func (c *Client) EditE2EEMessage(chatJIDStr, messageID, newText string) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return ErrE2EENotConnected
	}

	chatJID, err := parseJID(chatJIDStr)
	if err != nil {
		return err
	}

	msgKey := e2eeClient.BuildMessageKey(chatJID, waTypes.EmptyJID, messageID)
	ts := time.Now().UnixMilli()
	editMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_Content{
				Content: &waConsumerApplication.ConsumerApplication_Content{
					Content: &waConsumerApplication.ConsumerApplication_Content_EditMessage{
						EditMessage: &waConsumerApplication.ConsumerApplication_EditMessage{
							Key:         msgKey,
							Message:     &waCommon.MessageText{Text: &newText},
							TimestampMS: &ts,
						},
					},
				},
			},
		},
	}

	editID := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, err = e2eeClient.SendFBMessage(c.ctx, chatJID, editMsg, nil, whatsmeow.SendRequestExtra{ID: editID})
	return err
}

// UnsendE2EEMessage unsends/deletes an E2EE message
func (c *Client) UnsendE2EEMessage(chatJIDStr, messageID string) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !e2eeClient.IsConnected() {
		return ErrE2EENotConnected
	}

	chatJID, err := parseJID(chatJIDStr)
	if err != nil {
		return err
	}

	msgKey := e2eeClient.BuildMessageKey(chatJID, waTypes.EmptyJID, messageID)
	revokeMsg := &waConsumerApplication.ConsumerApplication{
		Payload: &waConsumerApplication.ConsumerApplication_Payload{
			Payload: &waConsumerApplication.ConsumerApplication_Payload_ApplicationData{
				ApplicationData: &waConsumerApplication.ConsumerApplication_ApplicationData{
					ApplicationContent: &waConsumerApplication.ConsumerApplication_ApplicationData_Revoke{
						Revoke: &waConsumerApplication.ConsumerApplication_RevokeMessage{Key: msgKey},
					},
				},
			},
		},
	}

	revokeID := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, err = e2eeClient.SendFBMessage(c.ctx, chatJID, revokeMsg, nil, whatsmeow.SendRequestExtra{ID: revokeID})
	return err
}
