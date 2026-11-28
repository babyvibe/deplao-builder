package bridge

// DEPLAO_ADAPTER: Messenger thread features mautrix-meta bridges and fbchat-v2
// does not (mautrix-meta pkg/connector handlemeta.go, handlewhatsapp.go,
// handlematrix.go, msgconv/to-whatsapp.go):
//   - the separate Facebook thread key of an encrypted chat ("hybrid thread"):
//     LightSpeed rows of that key are reported under the chat's id, and thread
//     tasks of an encrypted chat (mute, delete, accept, read) use the key;
//   - a one-to-one chat Messenger moved to end-to-end encryption;
//   - group renamed / new group picture / "cannot reply" (blocked) state;
//   - encrypted groups: members, admins, name and timer changes, their info,
//     and adding / removing members or leaving through the encrypted socket;
//   - the disappearing-message timer of encrypted chats, read from incoming
//     messages and attached to the messages Deplao sends;
//   - block / unblock through LightSpeed.

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

const (
	EventTypeHybridThreads   EventType = "hybridThreads"
	EventTypeThreadEncrypted EventType = "threadEncrypted"
	EventTypeThreadInfo      EventType = "threadInfo"
	EventTypeViewerStatus    EventType = "viewerStatus"
	EventTypeDisappearing    EventType = "disappearing"
)

// seenOnceSeconds is the timer mautrix-meta gives "seen once" messages.
const seenOnceSeconds = 300

// ─── Hybrid threads ──────────────────────────────────────────────────────────

// HybridThread links the Facebook thread key of an encrypted chat to the chat's
// id (the other person's id, or the encrypted group's id).
type HybridThread struct {
	ThreadKey string `json:"threadKey"`
	ThreadID  string `json:"threadId"`
	IsGroup   bool   `json:"isGroup,omitempty"`
}

// hybridThreads keeps both directions of the links. The zero value is ready.
type hybridThreads struct {
	mu    sync.RWMutex
	byKey map[int64]int64
	byID  map[int64]int64
}

// put records a link; false when it was already known (or is not a link).
func (h *hybridThreads) put(key, chatID int64) bool {
	if key <= 0 || chatID <= 0 || key == chatID {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byKey == nil {
		h.byKey = make(map[int64]int64)
		h.byID = make(map[int64]int64)
	}
	if h.byKey[key] == chatID && h.byID[chatID] == key {
		return false
	}
	if old, ok := h.byID[chatID]; ok && old != key {
		delete(h.byKey, old)
	}
	if old, ok := h.byKey[key]; ok && old != chatID {
		delete(h.byID, old)
	}
	h.byKey[key] = chatID
	h.byID[chatID] = key
	return true
}

// chatOf returns the chat id of a Facebook thread key (the key itself when it is not a hybrid key).
func (h *hybridThreads) chatOf(key int64) int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if chatID, ok := h.byKey[key]; ok {
		return chatID
	}
	return key
}

// keyOf returns the Facebook thread key of an encrypted chat, 0 when unknown.
func (h *hybridThreads) keyOf(chatID int64) int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.byID[chatID]
}

func (h *hybridThreads) empty() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byKey) == 0
}

// SetHybridThreads restores links Deplao saved in an earlier run; returns how many were new.
func (c *Client) SetHybridThreads(links []*HybridThread) int {
	added := 0
	for _, link := range links {
		if link == nil {
			continue
		}
		key, errKey := ParseFBID(link.ThreadKey)
		chatID, errID := ParseFBID(link.ThreadID)
		if errKey != nil || errID != nil {
			continue
		}
		if c.hybrid.put(key, chatID) {
			added++
		}
	}
	return added
}

// taskThreadKey is the thread key a LightSpeed task of a chat must use: an
// encrypted chat with a known Facebook thread key uses that key (mautrix-meta
// FBThreadKey with sync group 95), everything else its own id.
func (c *Client) taskThreadKey(threadID int64, encrypted bool) int64 {
	if !encrypted {
		return threadID
	}
	if key := c.hybrid.keyOf(threadID); key != 0 {
		return key
	}
	return threadID
}

// learnHybridThreads records the links a table carries and reports the new ones.
func (c *Client) learnHybridThreads(tbl *table.LSTable) {
	if tbl == nil {
		return
	}
	var learned []*HybridThread
	note := func(key, chatID int64, isGroup bool) {
		if c.hybrid.put(key, chatID) {
			learned = append(learned, &HybridThread{
				ThreadKey: strconv.FormatInt(key, 10),
				ThreadID:  strconv.FormatInt(chatID, 10),
				IsGroup:   isGroup,
			})
		}
	}
	for _, row := range tbl.LSVerifyHybridThreadExists {
		if row != nil {
			note(row.ThreadKey, row.ThreadJID, row.IsGroupThread || row.ThreadType == table.ENCRYPTED_OVER_WA_GROUP)
		}
	}
	for _, row := range tbl.LSUpdateThreadAuthorityAndMappingWithOTIDFromJID {
		if row != nil {
			note(row.ThreadKey, row.ThreadJID, false)
		}
	}
	if len(learned) > 0 {
		c.emitEvent(EventTypeHybridThreads, map[string]any{"threads": learned})
	}
}

// remapHybridThreadKeys rewrites the hybrid thread keys of a table to their chat
// ids, so every row Deplao reports names the conversation Deplao knows
// (mautrix-meta MapWhatsAppThreadKey). It runs before the table is handled.
func (c *Client) remapHybridThreadKeys(tbl *table.LSTable) {
	if tbl == nil || c.hybrid.empty() {
		return
	}
	m := c.hybrid.chatOf
	for _, r := range tbl.LSDeleteThenInsertThread {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSVerifyThreadExists {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpdateOrInsertThread {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSDeleteThenInsertMessageRequest {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpdateThreadMuteSetting {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSDeleteThread {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSMoveThreadToInboxAndUpdateParent {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSSetPinnedMessage {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSClearPinnedMessages {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpdateReadReceipt {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSMarkThreadReadV2 {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpdateTypingIndicator {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSAddParticipantIdToGroupThread {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSRemoveParticipantFromThread {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSSyncUpdateThreadName {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSSetThreadImageURL {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSChangeViewerStatus {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSMoveThreadToE2EECutoverFolder {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	// Admin texts and reactions LightSpeed sends for the thread key
	for _, r := range tbl.LSInsertMessage {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpsertMessage {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSDeleteThenInsertMessage {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSDeleteMessage {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSUpsertReaction {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
	for _, r := range tbl.LSDeleteReaction {
		if r != nil {
			r.ThreadKey = m(r.ThreadKey)
		}
	}
}

// ─── Thread changes ──────────────────────────────────────────────────────────

// emitThreadExtras reports chats moved to encryption, renames, new group
// pictures and "cannot reply" states of one table.
func (c *Client) emitThreadExtras(tbl *table.LSTable) {
	if tbl == nil {
		return
	}
	for _, row := range tbl.LSMoveThreadToE2EECutoverFolder {
		if row == nil || row.ThreadKey <= 0 {
			continue
		}
		c.emitEvent(EventTypeThreadEncrypted, map[string]any{"threadId": strconv.FormatInt(row.ThreadKey, 10)})
	}
	for _, row := range tbl.LSCreateOpenToE2EEThreadLink {
		if row == nil || row.ArmadilloThreadID <= 0 {
			continue
		}
		evt := map[string]any{"threadId": strconv.FormatInt(row.ArmadilloThreadID, 10)}
		if row.OpenThreadID > 0 && row.OpenThreadID != row.ArmadilloThreadID {
			evt["openThreadId"] = strconv.FormatInt(row.OpenThreadID, 10)
			evt["showOpenHistory"] = row.ShowOpenMessageHistory
		}
		c.emitEvent(EventTypeThreadEncrypted, evt)
	}
	for _, row := range tbl.LSSyncUpdateThreadName {
		if row == nil || row.ThreadKey <= 0 {
			continue
		}
		if name := strings.TrimSpace(firstNonEmpty(row.ThreadName, row.ThreadName1)); name != "" {
			c.emitEvent(EventTypeThreadInfo, map[string]any{"threadId": strconv.FormatInt(row.ThreadKey, 10), "name": name})
		}
	}
	for _, row := range tbl.LSSetThreadImageURL {
		if row == nil || row.ThreadKey <= 0 {
			continue
		}
		if url := firstNonEmpty(row.ImageURL, row.ImageFallbackURL); url != "" {
			c.emitEvent(EventTypeThreadInfo, map[string]any{"threadId": strconv.FormatInt(row.ThreadKey, 10), "pictureUrl": url})
		}
	}
	for _, row := range tbl.LSChangeViewerStatus {
		if row == nil || row.ThreadKey <= 0 {
			continue
		}
		// "blocked" = the account blocked the other person (mautrix-meta UserBlocked); "" = can reply again
		c.emitEvent(EventTypeViewerStatus, map[string]any{
			"threadId":          strconv.FormatInt(row.ThreadKey, 10),
			"cannotReplyReason": strings.TrimSpace(row.CannotReplyReason),
		})
	}
}

// ─── Block ───────────────────────────────────────────────────────────────────

// SetUserBlock blocks or unblocks a person's messages (LightSpeed, like Messenger web).
func (c *Client) SetUserBlock(userID int64, block bool) error {
	if err := c.requireMessagix(); err != nil {
		return err
	}
	action := 0
	if block {
		action = 1
	}
	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.SetUserBlockStatusTask{
		BlockeeID:       userID,
		RequestID:       uuid.NewString(),
		UserBlockAction: action,
	})
	if err != nil {
		return err
	}
	return blockAnswerError(resp, userID)
}

// blockAnswerError is the refusal of a block change: an issued error or a reset row that failed.
func blockAnswerError(resp *table.LSTable, userID int64) error {
	if err := taskIssueError(resp, "Facebook rejected the block change"); err != nil {
		return err
	}
	if resp == nil {
		return nil
	}
	for _, reset := range resp.LSResetUserBlockStatus {
		if reset != nil && reset.ContactID == userID && !reset.Success {
			return fmt.Errorf("Facebook rejected the block change")
		}
	}
	return nil
}

// ─── Encrypted groups ────────────────────────────────────────────────────────

func e2eeGroupJID(groupID int64) waTypes.JID {
	return waTypes.NewJID(strconv.FormatInt(groupID, 10), waTypes.GroupServer)
}

func messengerUserJID(userID int64) waTypes.JID {
	return waTypes.NewJID(strconv.FormatInt(userID, 10), waTypes.MessengerServer)
}

// E2EEGroupInfo is an encrypted group as the encrypted socket reports it.
type E2EEGroupInfo struct {
	ThreadID            string         `json:"threadId"`
	Name                string         `json:"name,omitempty"`
	Members             []*Participant `json:"members"`
	DisappearingSeconds int64          `json:"disappearingSeconds,omitempty"`
}

func groupMembersOf(participants []waTypes.GroupParticipant) []*Participant {
	members := make([]*Participant, 0, len(participants))
	for _, p := range participants {
		id := jidUserID(p.JID)
		if id == "" {
			continue
		}
		members = append(members, &Participant{ID: id, IsAdmin: p.IsAdmin || p.IsSuperAdmin, IsSuperAdmin: p.IsSuperAdmin})
	}
	return members
}

// FetchE2EEGroupInfo asks the encrypted socket for a group's name, members and timer.
func (c *Client) FetchE2EEGroupInfo(groupID int64) (*E2EEGroupInfo, error) {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !c.IsE2EEConnected() {
		return nil, ErrE2EENotConnected
	}
	info, err := e2eeClient.GetGroupInfo(c.ctx, e2eeGroupJID(groupID))
	if err != nil {
		return nil, err
	}
	result := &E2EEGroupInfo{
		ThreadID: strconv.FormatInt(groupID, 10),
		Name:     strings.TrimSpace(info.Name),
		Members:  groupMembersOf(info.Participants),
	}
	if info.IsEphemeral {
		result.DisappearingSeconds = int64(info.DisappearingTimer)
	}
	c.rememberChatTimer(e2eeGroupJID(groupID).String(), result.DisappearingSeconds, 0)
	return result, nil
}

// UpdateE2EEGroupMembers adds or removes people of an encrypted group (WhatsApp group participants, as mautrix-meta).
func (c *Client) UpdateE2EEGroupMembers(groupID int64, userIDs []int64, add bool) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !c.IsE2EEConnected() {
		return ErrE2EENotConnected
	}
	if len(userIDs) == 0 {
		return fmt.Errorf("no people to change")
	}
	jids := make([]waTypes.JID, 0, len(userIDs))
	for _, id := range userIDs {
		jids = append(jids, messengerUserJID(id))
	}
	action := whatsmeow.ParticipantChangeRemove
	if add {
		action = whatsmeow.ParticipantChangeAdd
	}
	resp, err := e2eeClient.UpdateGroupParticipants(c.ctx, e2eeGroupJID(groupID), jids, action)
	if err != nil {
		return err
	}
	return participantChangeError(resp)
}

func participantChangeError(resp []waTypes.GroupParticipant) error {
	if len(resp) == 0 {
		return fmt.Errorf("no answer for the member change")
	}
	for _, p := range resp {
		if p.Error != 0 {
			return fmt.Errorf("Messenger refused the member change (code %d)", p.Error)
		}
	}
	return nil
}

// LeaveE2EEGroup leaves an encrypted group.
func (c *Client) LeaveE2EEGroup(groupID int64) error {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil || !c.IsE2EEConnected() {
		return ErrE2EENotConnected
	}
	return e2eeClient.LeaveGroup(c.ctx, e2eeGroupJID(groupID))
}

// emitE2EEGroupInfo reports the changes of an encrypted group: members joined /
// left, admins, name and disappearing timer.
func (c *Client) emitE2EEGroupInfo(e *events.GroupInfo) {
	if e == nil {
		return
	}
	groupID := jidUserID(e.JID)
	if groupID == "" {
		return
	}
	groupType := int(table.ENCRYPTED_OVER_WA_GROUP)
	if e.Name != nil {
		if name := strings.TrimSpace(e.Name.Name); name != "" {
			c.emitEvent(EventTypeThreadInfo, map[string]any{"threadId": groupID, "name": name, "threadType": groupType})
		}
	}
	members := make([]*Participant, 0, len(e.Join)+len(e.Promote)+len(e.Demote))
	for _, jid := range e.Join {
		if id := jidUserID(jid); id != "" {
			members = append(members, &Participant{ID: id})
		}
	}
	for _, jid := range e.Promote {
		if id := jidUserID(jid); id != "" {
			members = append(members, &Participant{ID: id, IsAdmin: true})
		}
	}
	for _, jid := range e.Demote {
		if id := jidUserID(jid); id != "" {
			members = append(members, &Participant{ID: id})
		}
	}
	if len(members) > 0 {
		c.emitEvent(EventTypeParticipants, map[string]any{"threadId": groupID, "threadType": groupType, "members": members})
	}
	for _, jid := range e.Leave {
		if id := jidUserID(jid); id != "" {
			c.emitEvent(EventTypeParticipantRemoved, map[string]any{"threadId": groupID, "userId": id})
		}
	}
	if e.Ephemeral != nil {
		seconds := int64(0)
		if e.Ephemeral.IsEphemeral {
			seconds = int64(e.Ephemeral.DisappearingTimer)
		}
		at := e.Timestamp
		if at.IsZero() {
			at = time.Now()
		}
		// A group change is a notice of its own (the line Messenger shows in the group)
		setting := &DisappearingSetting{ThreadID: groupID, ChatJID: e.JID.String(), Seconds: seconds, TimestampMs: at.UnixMilli(), Notice: true, Form: "group"}
		if e.Sender != nil {
			setting.ActorID = jidUserID(*e.Sender)
		}
		c.rememberChatTimer(setting.ChatJID, seconds, 0)
		c.emitEvent(EventTypeDisappearing, setting)
	}
}

// ─── Disappearing messages ───────────────────────────────────────────────────

// DisappearingSetting is the self-delete timer of an encrypted chat (0 = off).
type DisappearingSetting struct {
	ThreadID    string `json:"threadId"`
	ChatJID     string `json:"chatJid,omitempty"`
	Seconds     int64  `json:"seconds"`
	AfterRead   bool   `json:"afterRead,omitempty"`
	ActorID     string `json:"actorId,omitempty"`
	TimestampMs int64  `json:"timestampMs,omitempty"`
	// MessageID is the message that carried the setting; Notice = a message without content that only changes it
	MessageID string `json:"messageId,omitempty"`
	Notice    bool   `json:"notice,omitempty"`
	// FromMe = sent by one of the account's own devices
	FromMe bool `json:"fromMe,omitempty"`
	// Form is where the metadata carried the setting: "chat" (chat setting) or "list" (entry of the setting list)
	Form string `json:"form,omitempty"`
	// SettingTimestamp is the time of the change itself, the same on every copy of one change
	SettingTimestamp int64 `json:"settingTimestamp,omitempty"`
	// Implicit = learned from a message with content (it carried a new setting, or none in a timed chat)
	Implicit bool `json:"implicit,omitempty"`
	// SenderDevice is the device that sent the message (copies of one change come from several devices)
	SenderDevice string `json:"senderDevice,omitempty"`
	// Stale = an older change than the one already known (a late copy): only its chat line is still useful
	Stale bool `json:"stale,omitempty"`
}

// chatTimer is the timer Deplao's own messages to a chat carry. inferredOff = turned
// off as learned from a message without a timer; settingTs then stays the time of
// the change it ended.
type chatTimer struct {
	seconds     int64
	settingTs   int64
	inferredOff bool
}

// messageDisappearing returns the timer an encrypted message carries (nil = none).
func messageDisappearing(e *events.FBMessage) *DisappearingSetting {
	if e == nil || e.FBApplication == nil {
		return nil
	}
	setting, form, listChat := messageTimerSettingForm(e)
	if setting == nil {
		return nil
	}
	// A setting list entry names its chat
	chat := e.Info.Chat
	if listChat != "" {
		if parsed, err := waTypes.ParseJID(listChat); err == nil && parsed.User != "" {
			chat = parsed.ToNonAD()
		}
	}
	out := &DisappearingSetting{
		ThreadID:         jidUserID(chat),
		ChatJID:          chat.String(),
		Seconds:          int64(setting.GetEphemeralExpiration()),
		ActorID:          jidUserID(e.Info.Sender),
		TimestampMs:      e.Info.Timestamp.UnixMilli(),
		MessageID:        e.Info.ID,
		Notice:           e.Message == nil,
		FromMe:           e.Info.IsFromMe,
		Form:             form,
		SettingTimestamp: setting.GetEphemeralSettingTimestamp(),
		SenderDevice:     e.Info.Sender.String(),
	}
	switch setting.GetEphemeralityType() {
	case waMsgApplication.MessageApplication_EphemeralSetting_SEEN_BASED_WITH_TIMER:
		out.AfterRead = true
	case waMsgApplication.MessageApplication_EphemeralSetting_SEEN_ONCE:
		out.Seconds, out.AfterRead = seenOnceSeconds, true
	}
	// A reset setting turns the timer off
	if setting.GetIsEphemeralSettingReset() {
		out.Seconds, out.AfterRead = 0, false
	}
	return out
}

// messageTimerSettingForm is the chat timer a message carries: the chat setting
// ("chat"), or the setting list entry of a chat ("list", the other form of the
// metadata oneof) with the chat it names. A list entry without a setting means
// the chat has no timer.
func messageTimerSettingForm(e *events.FBMessage) (*waMsgApplication.MessageApplication_EphemeralSetting, string, string) {
	metadata := e.FBApplication.GetMetadata()
	if setting := metadata.GetChatEphemeralSetting(); setting != nil {
		return setting, "chat", ""
	}
	if list := metadata.GetEphemeralSettingList(); list != nil {
		if setting := list.GetEphemeralSetting(); setting != nil {
			return setting, "list", list.GetChatJID()
		}
		return &waMsgApplication.MessageApplication_EphemeralSetting{}, "list", list.GetChatJID()
	}
	return nil, "", ""
}

// rememberChatTimer keeps a chat's timer for the messages Deplao sends; an older
// setting (by its timestamp) never replaces a newer one. True when the timer changed.
func (c *Client) rememberChatTimer(chatJID string, seconds, settingTs int64) bool {
	if chatJID == "" || seconds < 0 {
		return false
	}
	known := false
	if prev, ok := c.chatTimers.Load(chatJID); ok {
		old := prev.(chatTimer)
		if settingTs > 0 && old.settingTs > settingTs {
			return false
		}
		known = old.seconds == seconds
	}
	c.chatTimers.Store(chatJID, chatTimer{seconds: seconds, settingTs: settingTs})
	return !known
}

// SetChatTimers restores the timers Deplao saved in an earlier run (chat JID → seconds).
func (c *Client) SetChatTimers(timers map[string]int64) {
	for chatJID, seconds := range timers {
		if _, known := c.chatTimers.Load(chatJID); !known {
			c.rememberChatTimer(chatJID, seconds, 0)
		}
	}
}

// noteMessageTimer learns a chat's timer from an incoming message and reports it
// when it changed or when the message is a setting notice without content; a
// message with content can carry the new setting too (mautrix-meta updates the
// chat from any message whose setting differs).
func (c *Client) noteMessageTimer(e *events.FBMessage) {
	setting := messageDisappearing(e)
	if setting == nil {
		if e == nil {
			return
		}
		if e.Message == nil {
			// Neither content nor a timer: nothing Deplao shows, reported for the log (deplao_diagnostics.go)
			c.reportMetadataOnly(e)
			return
		}
		// A real message without a timer in a chat known as timed means the timer was turned off (messages of a
		// timed chat always carry the setting); the change itself may not reach linked devices
		if !isE2EEReactionMessage(e) && !isE2EEEditMessage(e) && !isE2EERevokeMessage(e) {
			chat := e.Info.Chat.String()
			if value, ok := c.chatTimers.Load(chat); ok && value.(chatTimer).seconds > 0 {
				c.chatTimers.Store(chat, chatTimer{settingTs: value.(chatTimer).settingTs, inferredOff: true})
				c.emitEvent(EventTypeDisappearing, &DisappearingSetting{
					ThreadID: jidUserID(e.Info.Chat), ChatJID: chat, Seconds: 0,
					ActorID: jidUserID(e.Info.Sender), TimestampMs: e.Info.Timestamp.UnixMilli(),
					MessageID: e.Info.ID, FromMe: e.Info.IsFromMe, Implicit: true,
				})
			}
		}
		return
	}
	stale := c.olderThanKnownTimer(setting.ChatJID, setting.SettingTimestamp)
	changed := false
	if !stale {
		changed = c.rememberChatTimer(setting.ChatJID, setting.Seconds, setting.SettingTimestamp)
	}
	if e.Message == nil || changed {
		setting.Implicit = e.Message != nil
		setting.Stale = stale
		c.emitEvent(EventTypeDisappearing, setting)
	}
}

// olderThanKnownTimer reports a setting older (by its timestamp) than the one
// already known for the chat, or the very change a later message showed was
// turned off: after a change Messenger's devices send copies of the previous one.
func (c *Client) olderThanKnownTimer(chatJID string, settingTs int64) bool {
	if settingTs <= 0 {
		return false
	}
	prev, ok := c.chatTimers.Load(chatJID)
	if !ok {
		return false
	}
	known := prev.(chatTimer)
	return known.settingTs > settingTs || known.inferredOff && known.settingTs == settingTs
}

// withChatTimer adds the chat's timer to the metadata of a message Deplao sends,
// so it disappears for the other people like Messenger's own messages
// (mautrix-meta msgconv/to-whatsapp.go).
func (c *Client) withChatTimer(chatJID waTypes.JID, metadata *waMsgApplication.MessageApplication_Metadata) *waMsgApplication.MessageApplication_Metadata {
	value, ok := c.chatTimers.Load(chatJID.String())
	if !ok {
		return metadata
	}
	timer := value.(chatTimer)
	if timer.seconds <= 0 {
		return metadata
	}
	if metadata == nil {
		metadata = &waMsgApplication.MessageApplication_Metadata{}
	}
	kind := waMsgApplication.MessageApplication_EphemeralSetting_UNKNOWN
	setting := &waMsgApplication.MessageApplication_EphemeralSetting{
		EphemeralExpiration: proto.Uint32(uint32(timer.seconds)),
		EphemeralityType:    &kind,
	}
	if timer.settingTs > 0 {
		setting.EphemeralSettingTimestamp = proto.Int64(timer.settingTs)
	}
	metadata.Ephemeral = &waMsgApplication.MessageApplication_Metadata_ChatEphemeralSetting{ChatEphemeralSetting: setting}
	return metadata
}
