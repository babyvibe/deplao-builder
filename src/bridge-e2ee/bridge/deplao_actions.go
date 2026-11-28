package bridge

// DEPLAO_ADAPTER: conversation and people actions Deplao needs on top of
// fbchat-v2: people search, starting a chat, message requests, mute, delete,
// delete for me, group members / admins / photo, polls and end-to-end
// encrypted read receipts. Ids cross the Electron boundary as strings
// (JavaScript number precision); LightSpeed tasks take int64.

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	waTypes "go.mau.fi/whatsmeow/types"

	"go.mau.fi/mautrix-meta/pkg/messagix/httpclient"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// e2eeSyncGroup is the LightSpeed sync group of end-to-end encrypted
// (WhatsApp-backed) threads. Ordinary threads use sync group 1.
const e2eeSyncGroup = 95

// MaxSearchResults caps one people search answer.
const MaxSearchResults = 30

// ParseFBID parses a Facebook id sent as a string. A JID ("123@msgr",
// "123.0:5@msgr") is accepted and reduced to its user part.
func ParseFBID(raw string) (int64, error) {
	value := strings.TrimSpace(raw)
	if at := strings.IndexByte(value, '@'); at >= 0 {
		value = value[:at]
	}
	if cut := strings.IndexAny(value, ".:"); cut >= 0 {
		value = value[:cut]
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id %q", raw)
	}
	return id, nil
}

// ThreadSyncGroup returns the sync group a thread task must use: encrypted
// threads (thread type 15 / 16, or encrypted=true when the caller only knows
// the chat is end-to-end encrypted) live in group 95.
func ThreadSyncGroup(threadType int64, encrypted bool) int64 {
	if encrypted || table.ThreadType(threadType).IsWhatsApp() {
		return e2eeSyncGroup
	}
	return 1
}

// isEncryptedThread: the thread is end-to-end encrypted (type 15 / 16, or the caller says so).
func isEncryptedThread(threadType int64, encrypted bool) bool {
	return encrypted || table.ThreadType(threadType).IsWhatsApp()
}

// taskIssueError returns the rejection Facebook attached to a task response.
func taskIssueError(resp *table.LSTable, fallback string) error {
	if resp == nil || len(resp.LSIssueNewError) == 0 {
		return nil
	}
	issue := resp.LSIssueNewError[0]
	message := strings.TrimSpace(issue.ErrorMessage)
	if message == "" {
		message = strings.TrimSpace(issue.ErrorTitle)
	}
	if message == "" {
		message = fallback
	}
	return fmt.Errorf("%s", message)
}

func (c *Client) requireMessagix() error {
	if err := c.lifecycleError(); err != nil {
		return err
	}
	if c.Messagix == nil {
		return fmt.Errorf("client not connected")
	}
	return nil
}

// runThreadTask executes one task and turns an issued error into a Go error.
func (c *Client) runThreadTask(task socket.Task, fallback string) error {
	if err := c.requireMessagix(); err != nil {
		return err
	}
	resp, err := c.Messagix.ExecuteTasks(c.ctx, task)
	if err != nil {
		return err
	}
	return taskIssueError(resp, fallback)
}

// PersonResult is one people search answer.
type PersonResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	ContextLine string `json:"contextLine,omitempty"`
	// Kind: "contact", "non_contact", "page", "group" or "other".
	Kind       string `json:"kind"`
	IsGroup    bool   `json:"isGroup,omitempty"`
	CanMessage bool   `json:"canMessage"`
	Verified   bool   `json:"verified,omitempty"`
}

func searchKind(kind table.SearchType) string {
	switch kind {
	case table.SearchTypeContact:
		return "contact"
	case table.SearchTypeNonContact:
		return "non_contact"
	case table.SearchTypePage:
		return "page"
	case table.SearchTypeGroup:
		return "group"
	default:
		return "other"
	}
}

// personFromSearchRow converts one LSInsertSearchResult row; nil when the row
// is neither a person nor a group thread.
func personFromSearchRow(row *table.LSInsertSearchResult) *PersonResult {
	if row == nil {
		return nil
	}
	if row.ThreadType.IsOneToOne() || row.OtherUserId != 0 {
		fbid := row.GetFBID()
		if fbid == 0 {
			return nil
		}
		return &PersonResult{
			ID:          strconv.FormatInt(fbid, 10),
			Name:        strings.TrimSpace(row.DisplayName),
			AvatarURL:   row.ProfilePicUrl,
			ContextLine: strings.TrimSpace(row.ContextLine),
			Kind:        searchKind(row.Type_),
			CanMessage:  row.CanViewerMessage || row.BlockedByViewerStatus == 0,
			Verified:    row.IsVerified,
		}
	}
	if row.Type_ != table.SearchTypeGroup {
		return nil
	}
	threadKey, err := strconv.ParseInt(strings.TrimSpace(row.ResultId), 10, 64)
	if err != nil || threadKey == 0 {
		return nil
	}
	return &PersonResult{
		ID:          strconv.FormatInt(threadKey, 10),
		Name:        strings.TrimSpace(row.DisplayName),
		AvatarURL:   row.ProfilePicUrl,
		ContextLine: strings.TrimSpace(row.ContextLine),
		Kind:        "group",
		IsGroup:     true,
		CanMessage:  true,
	}
}

// SearchPeople runs Messenger's people search (friends, other people, Pages and
// the account's groups).
func (c *Client) SearchPeople(query string) ([]*PersonResult, error) {
	if err := c.requireMessagix(); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	results := make([]*PersonResult, 0)
	if query == "" {
		return results, nil
	}
	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.SearchUserTask{
		Query: query,
		SupportedTypes: []table.SearchType{
			table.SearchTypeContact, table.SearchTypeGroup, table.SearchTypePage, table.SearchTypeNonContact,
		},
		SurfaceType: 5,
	})
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return results, nil
	}
	seen := make(map[string]bool)
	for _, row := range resp.LSInsertSearchResult {
		person := personFromSearchRow(row)
		if person == nil || person.ID == strconv.FormatInt(c.FBID, 10) || seen[person.ID] {
			continue
		}
		seen[person.ID] = true
		results = append(results, person)
		if len(results) >= MaxSearchResults {
			break
		}
	}
	return results, nil
}

// StartChatResult is returned by StartChat. ThreadID equals the person's id
// (Messenger keys 1:1 threads by the other person).
type StartChatResult struct {
	ThreadID  string `json:"threadId"`
	Encrypted bool   `json:"encrypted"`
}

// StartChat opens (creates when missing) the 1:1 thread with userID and, when
// the encrypted socket is up, the end-to-end encrypted chat used for sending.
func (c *Client) StartChat(userID int64) (*StartChatResult, error) {
	if err := c.requireMessagix(); err != nil {
		return nil, err
	}
	if userID == c.FBID {
		return nil, fmt.Errorf("cannot start a chat with the account itself")
	}
	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.CreateThreadTask{
		ThreadFBID: userID,
		SyncGroup:  1,
	})
	if err != nil {
		return nil, err
	}
	if err := taskIssueError(resp, "Facebook rejected the chat"); err != nil {
		return nil, err
	}
	result := &StartChatResult{ThreadID: strconv.FormatInt(userID, 10)}
	if c.IsE2EEConnected() {
		chatJID := waTypes.NewJID(strconv.FormatInt(userID, 10), waTypes.MessengerServer)
		if err := c.ensureE2EEDM(chatJID); err != nil {
			c.Logger.Warn().Err(err).Msg("Could not open the encrypted chat; the first message will open it")
		} else {
			result.Encrypted = true
		}
	}
	return result, nil
}

// SetThreadMute mutes a thread until muteUntilMs (Unix ms). -1 mutes until the
// user turns notifications back on, 0 unmutes.
func (c *Client) SetThreadMute(threadID, muteUntilMs, threadType int64, encrypted bool) error {
	if muteUntilMs < -1 {
		return fmt.Errorf("invalid mute time %d", muteUntilMs)
	}
	return c.runThreadTask(&socket.MuteThreadTask{
		ThreadKey:        c.taskThreadKey(threadID, isEncryptedThread(threadType, encrypted)),
		MailboxType:      0,
		MuteExpireTimeMS: muteUntilMs,
		SyncGroup:        ThreadSyncGroup(threadType, encrypted),
	}, "Facebook rejected the mute change")
}

// RemoveThread deletes a conversation from the account's inbox (Messenger's
// "Delete chat"; it is not deleted for the other people).
func (c *Client) RemoveThread(threadID, threadType int64, encrypted bool) error {
	return c.runThreadTask(&socket.DeleteThreadTask{
		ThreadKey:  c.taskThreadKey(threadID, isEncryptedThread(threadType, encrypted)),
		RemoveType: 0,
		SyncGroup:  ThreadSyncGroup(threadType, encrypted),
	}, "Facebook rejected deleting the chat")
}

// AcceptMessageRequest moves a message request into the inbox.
func (c *Client) AcceptMessageRequest(threadID, threadType int64, encrypted bool) error {
	return c.runThreadTask(&socket.AcceptMessageRequestTask{
		ThreadKey: c.taskThreadKey(threadID, isEncryptedThread(threadType, encrypted)),
		SyncGroup: ThreadSyncGroup(threadType, encrypted),
	}, "Facebook rejected accepting the request")
}

// DeleteMessageForMe removes an ordinary (not encrypted) message for the account
// only; the other people still see it.
func (c *Client) DeleteMessageForMe(threadID int64, messageID string) error {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return fmt.Errorf("messageId is empty")
	}
	return c.runThreadTask(&socket.DeleteMessageMeOnlyTask{
		ThreadKey: threadID,
		MessageId: messageID,
	}, "Facebook rejected deleting the message")
}

// AddGroupMembers adds people to a group thread.
func (c *Client) AddGroupMembers(threadID int64, userIDs []int64) error {
	if len(userIDs) == 0 {
		return fmt.Errorf("no people to add")
	}
	return c.runThreadTask(&socket.AddParticipantsTask{
		ThreadKey:  threadID,
		ContactIDs: userIDs,
		SyncGroup:  1,
	}, "Facebook rejected adding the members")
}

// RemoveGroupMember removes one person from a group. Removing the account
// itself leaves the group.
func (c *Client) RemoveGroupMember(threadID, userID int64) error {
	return c.runThreadTask(&socket.RemoveParticipantTask{
		ThreadID:  threadID,
		ContactID: userID,
	}, "Facebook rejected removing the member")
}

// SetGroupAdmin grants or revokes group admin rights.
func (c *Client) SetGroupAdmin(threadID, userID int64, isAdmin bool) error {
	value := 0
	if isAdmin {
		value = 1
	}
	return c.runThreadTask(&socket.UpdateAdminTask{
		ThreadKey: threadID,
		ContactID: userID,
		IsAdmin:   value,
	}, "Facebook rejected the admin change")
}

// ChangeGroupPhoto uploads an image and sets it as the group picture.
func (c *Client) ChangeGroupPhoto(threadID int64, data []byte, mimeType string) error {
	if err := c.requireMessagix(); err != nil {
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("image is empty")
	}
	if mimeType == "" {
		mimeType = "image/jpeg"
	}
	resp, err := c.Messagix.GetHTTP().SendMercuryUploadRequest(c.ctx, threadID, &httpclient.MercuryUploadMedia{
		Filename:  "group_photo.jpg",
		MimeType:  mimeType,
		MediaData: data,
	})
	if err != nil {
		return fmt.Errorf("failed to upload group photo: %w", err)
	}
	var imageID int64
	if resp != nil && resp.Payload.RealMetadata != nil {
		imageID = resp.Payload.RealMetadata.GetFbId()
	}
	if imageID == 0 {
		return fmt.Errorf("no image id received from upload")
	}
	return c.runThreadTask(&socket.SetThreadImageTask{
		ThreadKey: threadID,
		ImageID:   imageID,
		SyncGroup: 1,
	}, "Facebook rejected the group photo")
}

// MaxPollOptions is Messenger's limit of options in one poll.
const MaxPollOptions = 10

// StartPoll creates a poll in a group thread.
func (c *Client) StartPoll(threadID int64, question string, options []string) error {
	question = strings.TrimSpace(question)
	if question == "" {
		return fmt.Errorf("poll question is empty")
	}
	cleaned := make([]string, 0, len(options))
	for _, option := range options {
		if option = strings.TrimSpace(option); option != "" {
			cleaned = append(cleaned, option)
		}
	}
	if len(cleaned) < 2 || len(cleaned) > MaxPollOptions {
		return fmt.Errorf("a poll needs 2 to %d options", MaxPollOptions)
	}
	return c.runThreadTask(&socket.CreatePollTask{
		ThreadKey:    threadID,
		QuestionText: question,
		Options:      cleaned,
		SyncGroup:    1,
	}, "Facebook rejected the poll")
}

// VoteOnPoll replaces the account's choices in a poll (an empty list removes
// the vote).
func (c *Client) VoteOnPoll(threadID, pollID int64, optionIDs []int64) error {
	if pollID == 0 {
		return fmt.Errorf("invalid poll id")
	}
	selected := make([]int64, 0, len(optionIDs))
	seen := make(map[int64]bool, len(optionIDs))
	for _, id := range optionIDs {
		if id != 0 && !seen[id] {
			seen[id] = true
			selected = append(selected, id)
		}
	}
	return c.runThreadTask(&socket.UpdatePollTask{
		ThreadKey:       threadID,
		PollID:          pollID,
		SelectedOptions: selected,
		SyncGroup:       1,
	}, "Facebook rejected the vote")
}

// MarkThreadRead marks a thread read up to watermarkMs in the given sync group
// (95 for encrypted threads).
func (c *Client) MarkThreadRead(threadID, watermarkMs, syncGroup int64) error {
	if watermarkMs <= 0 {
		watermarkMs = time.Now().UnixMilli()
	}
	if syncGroup <= 0 {
		syncGroup = 1
	}
	if syncGroup == e2eeSyncGroup {
		threadID = c.taskThreadKey(threadID, true)
	}
	return c.runThreadTask(&socket.ThreadMarkReadTask{
		ThreadId:            threadID,
		LastReadWatermarkTs: watermarkMs,
		SyncGroup:           syncGroup,
	}, "Facebook rejected the read receipt")
}

// SetE2EEPresence sets the WhatsApp presence of the encrypted chats. Encrypted
// chats only exchange typing with a client that is "available" (mautrix-meta
// sets it while an encrypted chat is viewed); the wanted state is sent again
// after the encrypted socket reconnects (handleE2EEExtras).
func (c *Client) SetE2EEPresence(available bool) error {
	c.e2eeAvailable.Store(available)
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !c.IsE2EEConnected() {
		return ErrE2EENotConnected
	}
	presence := waTypes.PresenceUnavailable
	if available {
		presence = waTypes.PresenceAvailable
	}
	return e2eeClient.SendPresence(c.ctx, presence)
}

// MarkE2EERead sends "Seen" for end-to-end encrypted messages of one sender.
func (c *Client) MarkE2EERead(chatJIDStr, senderJIDStr string, messageIDs []string, timestampMs int64) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !c.IsE2EEConnected() {
		return ErrE2EENotConnected
	}
	ids := make([]waTypes.MessageID, 0, len(messageIDs))
	for _, id := range messageIDs {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, waTypes.MessageID(id))
		}
	}
	if len(ids) == 0 {
		return fmt.Errorf("no message ids")
	}
	chatJID, err := waTypes.ParseJID(chatJIDStr)
	if err != nil || chatJID.IsEmpty() {
		return fmt.Errorf("invalid chatJid %q", chatJIDStr)
	}
	var senderJID waTypes.JID
	if strings.TrimSpace(senderJIDStr) != "" {
		senderJID, err = waTypes.ParseJID(senderJIDStr)
		if err != nil {
			return fmt.Errorf("invalid senderJid %q", senderJIDStr)
		}
	}
	at := time.Now()
	if timestampMs > 0 {
		at = time.UnixMilli(timestampMs)
	}
	return e2eeClient.MarkRead(c.ctx, ids, at, chatJID, senderJID)
}
