package bridge

// DEPLAO_ADAPTER: old end-to-end encrypted messages from Messenger's secure
// history backup, unlocked once with the Messenger PIN (same flow as
// mautrix-meta connector/login_history.go + history.go). The PIN is used for
// one recovery call and never kept; what is kept is the enrolled history
// device (keys), which the app stores encrypted and hands back on connect.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waMsgApplication"
	waTypes "go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix/securehistory"
)

// EventTypeHistoryDeviceChanged carries the history device after new epochs
// were saved (the app persists it like deviceData).
const EventTypeHistoryDeviceChanged EventType = "historyDeviceChanged"

// MaxHistoryPage caps one page of the encrypted history.
const MaxHistoryPage = 50

var historyMu sync.Mutex

// historyDeviceOf returns the enrolled history device, nil when none.
func (c *Client) historyDeviceOf() *securehistory.Device {
	historyMu.Lock()
	defer historyMu.Unlock()
	return c.historyDevice
}

func (c *Client) storeHistoryDevice(device *securehistory.Device, announce bool) {
	historyMu.Lock()
	c.historyDevice = device
	historyMu.Unlock()
	if !announce || device == nil {
		return
	}
	if data, err := json.Marshal(device); err == nil {
		c.emitEvent(EventTypeHistoryDeviceChanged, map[string]any{"device": string(data)})
	}
}

// SetHistoryDevice restores a device enrolled in an earlier run.
func (c *Client) SetHistoryDevice(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		c.storeHistoryDevice(nil, false)
		return nil
	}
	var device securehistory.Device
	if err := json.Unmarshal([]byte(raw), &device); err != nil {
		return fmt.Errorf("invalid history device: %w", err)
	}
	if device.ID == "" || device.BackupID == "" {
		return errors.New("history device is not enrolled")
	}
	c.storeHistoryDevice(&device, false)
	return nil
}

// HistoryRestoreResult is returned by RestoreHistoryWithPIN.
type HistoryRestoreResult struct {
	// Device is the enrolled history device (JSON) the app keeps encrypted.
	Device string `json:"device"`
}

// HistoryPinError explains a refused PIN; AttemptsRemaining is -1 when unknown.
type HistoryPinError struct {
	Code              string `json:"code"`
	AttemptsRemaining int    `json:"attemptsRemaining"`
}

func (e *HistoryPinError) Error() string {
	if e.AttemptsRemaining >= 0 {
		return fmt.Sprintf("Messenger PIN rejected (%s, %d attempts remaining)", e.Code, e.AttemptsRemaining)
	}
	return fmt.Sprintf("Messenger PIN rejected (%s)", e.Code)
}

// RestoreHistoryWithPIN unlocks the secure history backup with the Messenger
// PIN and enrolls a history device for this bridge. Needs the encrypted socket.
func (c *Client) RestoreHistoryWithPIN(pin string) (*HistoryRestoreResult, error) {
	if err := c.requireMessagix(); err != nil {
		return nil, err
	}
	pin = strings.TrimSpace(pin)
	if pin == "" {
		return nil, errors.New("PIN is empty")
	}
	if !c.IsE2EEConnected() || c.DeviceStore == nil || c.DeviceStore.Device == nil || c.DeviceStore.Device.IdentityKey == nil {
		return nil, ErrE2EENotConnected
	}
	if existing := c.historyDeviceOf(); existing != nil && existing.ID != "" {
		data, err := json.Marshal(existing)
		if err != nil {
			return nil, err
		}
		return &HistoryRestoreResult{Device: string(data)}, nil
	}
	history := c.Messagix.GetSecureHistoryClient()
	backup, err := history.GetBackup(c.ctx)
	if err != nil {
		return nil, fmt.Errorf("could not read the Messenger backup: %w", err)
	}
	recovery, err := history.RecoverPIN(c.ctx, backup, []byte(pin))
	if err != nil {
		var refused *securehistory.RecoveryError
		if errors.As(err, &refused) {
			attempts := -1
			if refused.AttemptsRemaining != nil {
				attempts = *refused.AttemptsRemaining
			}
			return nil, &HistoryPinError{Code: refused.Code, AttemptsRemaining: attempts}
		}
		return nil, err
	}
	virtual, err := history.GetVirtualDevice(c.ctx, backup, c.FBID, recovery.Code)
	if err != nil {
		return nil, err
	}
	epochs, err := virtual.DeriveEpochs()
	if err != nil {
		return nil, err
	}
	enrollment, err := virtual.PrepareDevice(backup.ID, history.RegistrationID, c.DeviceStore.Device.IdentityKey, epochs)
	if err != nil {
		return nil, err
	}
	device, err := history.AddDevice(c.ctx, enrollment)
	if err != nil {
		return nil, err
	}
	c.storeHistoryDevice(device, false)
	data, err := json.Marshal(device)
	if err != nil {
		return nil, err
	}
	return &HistoryRestoreResult{Device: string(data)}, nil
}

// EncryptedHistoryPage is one page of old encrypted messages, newest first.
type EncryptedHistoryPage struct {
	Messages []*E2EEMessage `json:"messages"`
	HasMore  bool           `json:"hasMore"`
	// Before is the cursor for the next (older) page, Unix ms.
	Before int64 `json:"before"`
}

// FetchEncryptedHistory reads one page of the secure history of a chat
// ("123@msgr" or "456@g.us") before beforeMs (0 = now).
func (c *Client) FetchEncryptedHistory(chatJIDStr string, beforeMs int64, count int) (*EncryptedHistoryPage, error) {
	if err := c.requireMessagix(); err != nil {
		return nil, err
	}
	device := c.historyDeviceOf()
	if device == nil || device.ID == "" {
		return nil, errors.New("encrypted history is not unlocked")
	}
	chatJID, err := waTypes.ParseJID(chatJIDStr)
	if err != nil || chatJID.User == "" {
		return nil, fmt.Errorf("invalid chatJid %q", chatJIDStr)
	}
	if count <= 0 || count > MaxHistoryPage {
		count = MaxHistoryPage
	}
	if beforeMs <= 0 {
		beforeMs = time.Now().Add(time.Minute).UnixMilli()
	}
	history := c.Messagix.GetSecureHistoryClient()
	page, err := history.FetchMessages(c.ctx, device, chatJID.User, true, beforeMs, count)
	if err != nil {
		return nil, err
	}
	if page.Epochs != nil && len(page.Epochs.Edges) > 0 {
		updated, err := device.WithEpochs(page.Epochs)
		if err != nil {
			return nil, err
		}
		device = updated
		c.storeHistoryDevice(device, true)
	}
	result := &EncryptedHistoryPage{Messages: make([]*E2EEMessage, 0, len(page.Messages))}
	if page.Range != nil {
		result.Before = page.Range.Before
		result.HasMore = page.Range.HasMoreBefore != nil && *page.Range.HasMoreBefore && page.Range.Before < beforeMs
	}
	decrypted := page.Decrypt(c.ctx, device, chatJID.User, c.FBID, chatJID.Server == waTypes.GroupServer)
	for _, message := range decrypted {
		if converted := c.convertArchiveMessage(chatJID, message); converted != nil {
			result.Messages = append(result.Messages, converted)
		}
	}
	return result, nil
}

// convertArchiveMessage decodes one archived message into the bridge's E2EE
// message shape (same fields as a live encrypted message). Reactions, edits and
// events stored as supplementals are not replayed.
func (c *Client) convertArchiveMessage(chat waTypes.JID, message *securehistory.DecryptedMessage) (converted *E2EEMessage) {
	if message == nil || message.Message == nil || message.Message.Message == nil {
		return nil
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			c.Logger.Warn().Interface("panic", recovered).Msg("Could not read an archived encrypted message")
			converted = nil
		}
	}()
	backup := message.Message.Message
	transport := backup.GetEncryptedTransportMessage()
	if len(transport) == 0 {
		return nil
	}
	var application waMsgApplication.MessageApplication
	if err := proto.Unmarshal(transport, &application); err != nil {
		return nil
	}
	decoded, err := whatsmeow.DecodeFBApplication(&application)
	if err != nil {
		return nil
	}
	metadata := backup.GetMetadata()
	if metadata.GetMessageID() == "" || metadata.GetSenderID() == "" {
		return nil
	}
	senderID, _ := strconv.ParseInt(metadata.GetSenderID(), 10, 64)
	decoded.Info = waTypes.MessageInfo{
		MessageSource: waTypes.MessageSource{
			Chat:     chat,
			Sender:   waTypes.NewJID(metadata.GetSenderID(), waTypes.MessengerServer),
			IsFromMe: senderID != 0 && senderID == c.FBID,
			IsGroup:  chat.Server == waTypes.GroupServer,
		},
		ID:        metadata.GetMessageID(),
		Timestamp: time.UnixMilli(message.Message.TimestampMS),
	}
	if isE2EEReactionMessage(&decoded) || isE2EEEditMessage(&decoded) || isE2EERevokeMessage(&decoded) {
		return nil
	}
	return c.extractE2EEMessage(&decoded, senderID)
}
