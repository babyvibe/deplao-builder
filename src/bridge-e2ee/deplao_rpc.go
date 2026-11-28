package main

// DEPLAO_ADAPTER: JSON-RPC methods for the conversation and people actions in
// bridge/deplao_actions.go. Ids are strings across the Electron boundary.
// Methods that wait for a LightSpeed answer run in a goroutine (like
// fetchMessages) so that sends are not held up behind them.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"strings"

	"fbchat-bridge-e2ee/bridge"
)

// deplaoCapabilities are announced in hello next to fbchat-v2's.
var deplaoCapabilities = []string{
	"searchUsers", "startChat", "muteThread", "deleteThread", "acceptMessageRequest",
	"deleteMessageForMe", "groupMembers", "setGroupPhoto", "renameGroup", "polls",
	"markE2EERead", "markReadSyncGroup", "threadEvents", "callEvents", "pollEvents", "peopleEvents", "proxy",
	"encryptedHistory", "pinEvents", "threadInfo", "e2eePresence",
	// deplao_threads.go
	"hybridThreads", "threadEncryptedEvents", "threadInfoEvents", "viewerStatus", "blockUser",
	"e2eeGroups", "disappearing",
	// deplao_incoming.go
	"appState", "incomingExtras",
}

// errEncryptedGroupUnsupported: Messenger's encrypted socket has no admin / name / picture change for encrypted groups.
var errEncryptedGroupUnsupported = errors.New("not supported for encrypted groups")

// runAsync answers a request from a goroutine, turning a panic into an error.
func runAsync(reqID uint64, method string, work func(*bridge.Client) (interface{}, error)) {
	current := client
	if current == nil {
		fail(reqID, fmt.Errorf("client not initialised"))
		return
	}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				fmt.Fprintf(os.Stderr, "panic in %s: %v\n%s\n", method, recovered, debug.Stack())
				fail(reqID, fmt.Errorf("internal bridge error in %s: %v", method, recovered))
			}
		}()
		data, err := work(current)
		if err != nil {
			fail(reqID, err)
			return
		}
		if data == nil {
			data = map[string]interface{}{}
		}
		ok(reqID, data)
	}()
}

type threadRef struct {
	ThreadID   string `json:"threadId"`
	ThreadType int64  `json:"threadType"`
	Encrypted  bool   `json:"encrypted"`
}

// handleDeplaoRequest serves the Deplao methods; false means "not one of them".
func handleDeplaoRequest(req *request) bool {
	switch req.Method {
	case "searchUsers":
		var p struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			results, err := c.SearchPeople(p.Query)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"results": results}, nil
		})

	case "startChat":
		var p struct {
			UserID string `json:"userId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		userID, err := bridge.ParseFBID(p.UserID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return c.StartChat(userID)
		})

	case "muteThread":
		var p struct {
			threadRef
			MuteUntilMs int64 `json:"muteUntilMs"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.SetThreadMute(threadID, p.MuteUntilMs, p.ThreadType, p.Encrypted)
		})

	case "deleteThread", "acceptMessageRequest":
		var p threadRef
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		method := req.Method
		runAsync(req.ID, method, func(c *bridge.Client) (interface{}, error) {
			if method == "deleteThread" {
				return nil, c.RemoveThread(threadID, p.ThreadType, p.Encrypted)
			}
			return nil, c.AcceptMessageRequest(threadID, p.ThreadType, p.Encrypted)
		})

	case "deleteMessageForMe":
		var p struct {
			ThreadID  string `json:"threadId"`
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.DeleteMessageForMe(threadID, p.MessageID)
		})

	case "addGroupMembers":
		var p struct {
			ThreadID  string   `json:"threadId"`
			UserIDs   []string `json:"userIds"`
			Encrypted bool     `json:"encrypted"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		userIDs, err := bridge.ParseParticipantIDs(p.UserIDs)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			if p.Encrypted {
				return nil, c.UpdateE2EEGroupMembers(threadID, userIDs, true)
			}
			return nil, c.AddGroupMembers(threadID, userIDs)
		})

	case "removeGroupMember", "setGroupAdmin":
		var p struct {
			ThreadID  string `json:"threadId"`
			UserID    string `json:"userId"`
			IsAdmin   bool   `json:"isAdmin"`
			Encrypted bool   `json:"encrypted"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		userID, err := bridge.ParseFBID(p.UserID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		method := req.Method
		runAsync(req.ID, method, func(c *bridge.Client) (interface{}, error) {
			if method == "setGroupAdmin" {
				if p.Encrypted {
					return nil, errEncryptedGroupUnsupported
				}
				return nil, c.SetGroupAdmin(threadID, userID, p.IsAdmin)
			}
			if p.Encrypted {
				// Removing the account itself leaves the group (mautrix-meta LeaveGroup)
				if userID == c.FBID {
					return nil, c.LeaveE2EEGroup(threadID)
				}
				return nil, c.UpdateE2EEGroupMembers(threadID, []int64{userID}, false)
			}
			return nil, c.RemoveGroupMember(threadID, userID)
		})

	case "setGroupPhoto":
		var p struct {
			ThreadID  string `json:"threadId"`
			LocalPath string `json:"localPath"`
			MimeType  string `json:"mimeType"`
			Encrypted bool   `json:"encrypted"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		if p.Encrypted {
			fail(req.ID, errEncryptedGroupUnsupported)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		data, err := readAndValidateLocalPath(p.LocalPath, "setGroupPhoto")
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.ChangeGroupPhoto(threadID, data, p.MimeType)
		})

	case "renameGroup":
		var p struct {
			ThreadID  string `json:"threadId"`
			Name      string `json:"name"`
			Encrypted bool   `json:"encrypted"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		if p.Encrypted {
			fail(req.ID, errEncryptedGroupUnsupported)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			fail(req.ID, fmt.Errorf("group name is empty"))
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.RenameThread(&bridge.RenameThreadOptions{ThreadID: threadID, NewName: name})
		})

	case "createPoll":
		var p struct {
			ThreadID string   `json:"threadId"`
			Question string   `json:"question"`
			Options  []string `json:"options"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.StartPoll(threadID, p.Question, p.Options)
		})

	case "votePoll":
		var p struct {
			ThreadID  string   `json:"threadId"`
			PollID    string   `json:"pollId"`
			OptionIDs []string `json:"optionIds"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		pollID, err := bridge.ParseFBID(p.PollID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		optionIDs := make([]int64, 0, len(p.OptionIDs))
		for _, raw := range p.OptionIDs {
			optionID, parseErr := bridge.ParseFBID(raw)
			if parseErr != nil {
				fail(req.ID, parseErr)
				return true
			}
			optionIDs = append(optionIDs, optionID)
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.VoteOnPoll(threadID, pollID, optionIDs)
		})

	case "setHybridThreads":
		var p struct {
			Threads []*bridge.HybridThread `json:"threads"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return true
		}
		ok(req.ID, map[string]interface{}{"added": client.SetHybridThreads(p.Threads)})

	case "setChatTimers":
		var p struct {
			Timers map[string]int64 `json:"timers"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return true
		}
		client.SetChatTimers(p.Timers)
		ok(req.ID, map[string]interface{}{})

	case "setAppState":
		var p struct {
			Foreground bool `json:"foreground"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.SetAppState(p.Foreground)
		})

	case "setUserBlock":
		var p struct {
			UserID string `json:"userId"`
			Block  bool   `json:"block"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		userID, err := bridge.ParseFBID(p.UserID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.SetUserBlock(userID, p.Block)
		})

	case "fetchE2EEGroupInfo":
		var p struct {
			ThreadID string `json:"threadId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return c.FetchE2EEGroupInfo(threadID)
		})

	case "setE2EEPresence":
		var p struct {
			Available bool `json:"available"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.SetE2EEPresence(p.Available)
		})

	case "markE2EERead":
		var p struct {
			ChatJID     string   `json:"chatJid"`
			SenderJID   string   `json:"senderJid"`
			MessageIDs  []string `json:"messageIds"`
			TimestampMs int64    `json:"timestampMs"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return nil, c.MarkE2EERead(p.ChatJID, p.SenderJID, p.MessageIDs, p.TimestampMs)
		})

	case "fetchThreadInfo":
		var p struct {
			ThreadID string `json:"threadId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		threadID, err := bridge.ParseFBID(p.ThreadID)
		if err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return c.FetchThreadInfo(threadID)
		})

	case "restoreHistoryPin":
		// The PIN is used for this one recovery call and never stored.
		var p struct {
			PIN string `json:"pin"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			res, err := c.RestoreHistoryWithPIN(p.PIN)
			var refused *bridge.HistoryPinError
			if errors.As(err, &refused) {
				return nil, fmt.Errorf("pin_rejected|%s|%d", refused.Code, refused.AttemptsRemaining)
			}
			return res, err
		})

	case "setHistoryDevice":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return true
		}
		var p struct {
			Device string `json:"device"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		if err := client.SetHistoryDevice(p.Device); err != nil {
			fail(req.ID, err)
			return true
		}
		ok(req.ID, map[string]interface{}{})

	case "fetchEncryptedHistory":
		var p struct {
			ChatJID  string `json:"chatJid"`
			BeforeMs int64  `json:"beforeMs"`
			Count    int    `json:"count"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return true
		}
		runAsync(req.ID, req.Method, func(c *bridge.Client) (interface{}, error) {
			return c.FetchEncryptedHistory(p.ChatJID, p.BeforeMs, p.Count)
		})

	default:
		return false
	}
	return true
}
