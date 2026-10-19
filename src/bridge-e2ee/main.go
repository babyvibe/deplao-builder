// Standalone E2EE bridge for fbchat-v2.
//
// Communicates with the Python parent process over stdin/stdout using
// line-delimited JSON. Single-client per process (Python spawns one).
//
// Protocol
// --------
// Request  (Python -> bridge): one JSON object per line:
//
//	{"id": <int>, "method": "<name>", "params": {...}}
//
// Response (bridge -> Python): one JSON object per line:
//
//	{"id": <int>, "ok": true,  "data": {...}}
//	{"id": <int>, "ok": false, "error": "..."}
//
// Async event (bridge -> Python): one JSON object per line, no id:
//
//	{"event": {"type": "<name>", "data": {...}, "timestamp": <ms>}}
//
// Methods: hello, newClient, connect, connectE2EE, isConnected, disconnect,
// sendMessage, sendReaction, sendE2EEMessage, sendE2EEReaction,
// sendImage, sendFile, sendE2EESticker, sendE2EEAudio, sendE2EEVideo, sendE2EEDocument,
// getUserInfo.
//
// DEPLAO_ADAPTER: the credential login wizard is not served here. It needs a
// newer mautrix/meta than fbchat-v2 pins and runs in the separate
// fbchat-login-bridge (./login), which only returns session cookies.
//
// Build:
//
//	go mod tidy
//	go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee.exe .
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"fbchat-bridge-e2ee/bridge"
)

var (
	// bridgeVersion is set via -ldflags "-X main.bridgeVersion=..."
	// Default fallback for local builds without build script.
	bridgeVersion = "2.3.3-dev"
)

const (
	protocolVersion      = 2
	maxDecodedMediaBytes = 25 * 1024 * 1024 // 25 MiB
	// fbchat-v2 2.3.2: hard cap for a single JSON-RPC request line.
	maxRPCRequestBytes = 150 * 1024 * 1024
)

// DEPLAO_ADAPTER: localPath media transport — Electron-only adapter.
// Upstream expects base64 `data` in JSON-RPC. Electron passes `localPath`
// (filesystem path) to avoid copying large buffers across IPC.
// This adapter reads the file, validates it, then passes bytes to bridge/.
// See: docs/fbchat-v2.3.3-vendor-manifest.json
func readAndValidateLocalPath(localPath string, label string) ([]byte, error) {
	if localPath == "" {
		return nil, fmt.Errorf("%s: localPath is empty", label)
	}

	// Reject directory, FIFO, symlink-to-directory, etc.
	info, err := os.Stat(localPath)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot stat file: %w", label, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%s: path is a directory, not a file", label)
	}
	if info.Mode()&os.ModeNamedPipe != 0 || info.Mode()&os.ModeSocket != 0 {
		return nil, fmt.Errorf("%s: path is not a regular file (pipe/socket)", label)
	}

	// Reject files exceeding media limit
	if info.Size() > int64(maxDecodedMediaBytes) {
		return nil, fmt.Errorf("%s: file too large (%d bytes > %d limit)", label, info.Size(), maxDecodedMediaBytes)
	}

	// Reject paths with null bytes or obviously malicious patterns
	cleaned := filepath.Clean(localPath)
	if strings.ContainsAny(cleaned, "\x00") {
		return nil, fmt.Errorf("%s: invalid path (null byte)", label)
	}

	data, err := os.ReadFile(cleaned)
	if err != nil {
		return nil, fmt.Errorf("%s: read failed: %w", label, err)
	}
	return data, nil
}

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID    uint64      `json:"id"`
	OK    bool        `json:"ok"`
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

type eventEnvelope struct {
	Event *bridge.Event `json:"event"`
}

var (
	client   *bridge.Client
	stdoutMu sync.Mutex
)

func writeJSON(v interface{}) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func ok(id uint64, data interface{}) {
	writeJSON(response{ID: id, OK: true, Data: data})
}

func fail(id uint64, err error) {
	writeJSON(response{ID: id, OK: false, Error: err.Error()})
}

// pumpEvents copies events from the client to stdout asynchronously.
func pumpEvents(c *bridge.Client) {
	for evt := range c.Events() {
		if evt == nil {
			continue
		}
		writeJSON(eventEnvelope{Event: evt})
	}
}

func handle(req *request) {
	switch req.Method {
	case "hello":
		ok(req.ID, map[string]interface{}{
			"protocolVersion": protocolVersion,
			"bridgeVersion":   bridgeVersion,
			"capabilities": []string{
				"connectE2EE", "sendMessage", "sendReaction", "sendImage", "sendFile",
				"sendE2EEMessage", "sendE2EEReaction", "sendE2EESticker", "sendE2EEImage",
				"sendE2EEVideo", "sendE2EEAudio", "sendE2EEDocument", "downloadE2EEAttachment",
				"mediaLocalPath", "sendTypingIndicator", "sendE2EETyping", "markRead",
				"editMessage", "unsendMessage", "editE2EEMessage", "unsendE2EEMessage", "syncHistory", "fetchMessages", "getUserInfo",
				"createGroup",
			},
			"maxDecodedMediaBytes": maxDecodedMediaBytes,
		})

	case "newClient":
		// DEPLAO_ADAPTER: deviceData transport — Electron passes device state
		// as a JSON string via secureStorage instead of file I/O.
		// Upstream uses DevicePath (file); Electron uses DeviceData (string).
		// See: docs/fbchat-v2.3.3-vendor-manifest.json
		if client != nil {
			fail(req.ID, fmt.Errorf("client already created"))
			return
		}
		var cfg bridge.ClientConfig
		if err := json.Unmarshal(req.Params, &cfg); err != nil {
			fail(req.ID, err)
			return
		}
		c, err := bridge.NewClient(&cfg)
		if err != nil {
			fail(req.ID, err)
			return
		}
		client = c
		go pumpEvents(client)
		initialDeviceData := ""
		if !cfg.E2EEMemoryOnly && cfg.DeviceData == "" && cfg.DevicePath == "" {
			initialDeviceData, err = client.DeviceStore.GetDeviceData()
			if err != nil {
				client.Disconnect()
				client = nil
				fail(req.ID, fmt.Errorf("serialize initial device state: %w", err))
				return
			}
		}
		ok(req.ID, map[string]interface{}{"ready": true, "deviceData": initialDeviceData})

	case "connect":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		user, initialData, err := client.Connect()
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{
			"user":        user,
			"initialData": initialData,
		})

	case "syncHistory":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		initialData, err := client.SyncHistory()
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, initialData)

	case "fetchMessages":
		// DEPLAO_ADAPTER: one page of a thread's history (bridge/history.go).
		// The answer arrives asynchronously on the LightSpeed socket, so the wait
		// runs in a goroutine: requests are served one at a time and a blocking
		// wait would hold up sends.
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var params struct {
			ThreadID          string `json:"threadId"`
			BeforeTimestampMs int64  `json:"beforeTimestampMs"`
			BeforeMessageID   string `json:"beforeMessageId"`
			TimeoutMs         int64  `json:"timeoutMs"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			fail(req.ID, err)
			return
		}
		threadID, err := strconv.ParseInt(strings.TrimSpace(strings.SplitN(params.ThreadID, "@", 2)[0]), 10, 64)
		if err != nil || threadID == 0 {
			fail(req.ID, fmt.Errorf("invalid threadId %q", params.ThreadID))
			return
		}
		current, reqID := client, req.ID
		timeout := time.Duration(params.TimeoutMs) * time.Millisecond
		go func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					fmt.Fprintf(os.Stderr, "panic in fetchMessages: %v\n%s\n", recovered, debug.Stack())
					fail(reqID, fmt.Errorf("internal bridge error in fetchMessages: %v", recovered))
				}
			}()
			page, err := current.FetchThreadHistory(context.Background(), threadID, params.BeforeTimestampMs, params.BeforeMessageID, timeout)
			if err != nil {
				fail(reqID, err)
				return
			}
			ok(reqID, page)
		}()

	case "connectE2EE":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		if err := client.ConnectE2EE(); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "isConnected":
		if client == nil {
			ok(req.ID, map[string]interface{}{"connected": false, "e2eeConnected": false})
			return
		}
		ok(req.ID, map[string]interface{}{
			"connected":     client.IsConnected(),
			"e2eeConnected": client.IsE2EEConnected(),
		})

	case "sendMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var opts bridge.SendMessageOptions
		if err := json.Unmarshal(req.Params, &opts); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendMessage(&opts)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendReaction":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ThreadID  int64  `json:"threadId"`
			MessageID string `json:"messageId"`
			Emoji     string `json:"emoji"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendReaction(p.ThreadID, p.MessageID, p.Emoji); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "sendImage":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var imgP struct {
			ThreadID  int64  `json:"threadId"`
			ImagePath string `json:"imagePath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &imgP); err != nil {
			fail(req.ID, err)
			return
		}
		imgData, err := readAndValidateLocalPath(imgP.ImagePath, "sendImage")
		if err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendImage(&bridge.SendImageOptions{
			ThreadID: imgP.ThreadID,
			Data:     imgData,
			Filename: imgP.ImagePath,
			Caption:  imgP.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendFile":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var fileP struct {
			ThreadID int64  `json:"threadId"`
			FilePath string `json:"filePath"`
			FileName string `json:"fileName"`
		}
		if err := json.Unmarshal(req.Params, &fileP); err != nil {
			fail(req.ID, err)
			return
		}
		fileData, err := readAndValidateLocalPath(fileP.FilePath, "sendFile")
		if err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendFile(&bridge.SendFileOptions{
			ThreadID: fileP.ThreadID,
			Data:     fileData,
			Filename: fileP.FileName,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID          string `json:"chatJid"`
			Text             string `json:"text"`
			ReplyToID        string `json:"replyToId,omitempty"`
			ReplyToSenderJID string `json:"replyToSenderJid,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendMessage(&bridge.SendMessageOptions{
			Text:                 p.Text,
			IsE2EE:               true,
			E2EEChatJID:          p.ChatJID,
			E2EEReplyToID:        p.ReplyToID,
			E2EEReplyToSenderJID: p.ReplyToSenderJID,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEReaction":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID   string `json:"chatJid"`
			MessageID string `json:"messageId"`
			SenderJID string `json:"senderJid"`
			Emoji     string `json:"emoji"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendE2EEReaction(p.ChatJID, p.MessageID, p.SenderJID, p.Emoji); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "sendE2EESticker":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var opts bridge.SendE2EEStickerOptions
		if err := json.Unmarshal(req.Params, &opts); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendE2EESticker(&opts)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEAudio":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var ap struct {
			ChatJID   string `json:"chatJid"`
			AudioPath string `json:"audioPath"`
			MimeType  string `json:"mimeType"`
		}
		if err := json.Unmarshal(req.Params, &ap); err != nil {
			fail(req.ID, err)
			return
		}
		aData, err := readAndValidateLocalPath(ap.AudioPath, "sendE2EEAudio")
		if err != nil {
			fail(req.ID, err)
			return
		}
		mimeType := ap.MimeType
		if mimeType == "" {
			mimeType = "audio/mpeg"
		}
		res, err := client.SendE2EEAudio(&bridge.SendE2EEAudioOptions{
			ChatJID:  ap.ChatJID,
			Data:     aData,
			MimeType: mimeType,
			PTT:      false,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEVideo":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var vp struct {
			ChatJID   string `json:"chatJid"`
			VideoPath string `json:"videoPath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &vp); err != nil {
			fail(req.ID, err)
			return
		}
		vData, err := readAndValidateLocalPath(vp.VideoPath, "sendE2EEVideo")
		if err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendE2EEVideo(&bridge.SendE2EEVideoOptions{
			ChatJID:  vp.ChatJID,
			Data:     vData,
			MimeType: "video/mp4",
			Caption:  vp.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEImage":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			ChatJID   string `json:"chatJid"`
			ImagePath string `json:"imagePath"`
			Caption   string `json:"caption"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		data, err := readAndValidateLocalPath(p.ImagePath, "sendE2EEImage")
		if err != nil {
			fail(req.ID, err)
			return
		}
		mimeType := "image/jpeg"
		if strings.HasSuffix(strings.ToLower(p.ImagePath), ".png") {
			mimeType = "image/png"
		} else if strings.HasSuffix(strings.ToLower(p.ImagePath), ".gif") {
			mimeType = "image/gif"
		} else if strings.HasSuffix(strings.ToLower(p.ImagePath), ".webp") {
			mimeType = "image/webp"
		}
		res, err := client.SendE2EEImage(&bridge.SendE2EEImageOptions{
			ChatJID:  p.ChatJID,
			Data:     data,
			MimeType: mimeType,
			Caption:  p.Caption,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendE2EEDocument":
		// DEPLAO_ADAPTER: localPath media transport (see readAndValidateLocalPath)
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var docP struct {
			ChatJID  string `json:"chatJid"`
			FilePath string `json:"filePath"`
			FileName string `json:"fileName"`
		}
		if err := json.Unmarshal(req.Params, &docP); err != nil {
			fail(req.ID, err)
			return
		}
		docData, err := readAndValidateLocalPath(docP.FilePath, "sendE2EEDocument")
		if err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.SendE2EEDocument(&bridge.SendE2EEDocumentOptions{
			ChatJID:  docP.ChatJID,
			Data:     docData,
			Filename: docP.FileName,
		})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "sendTypingIndicator":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var tp struct {
			ThreadID   int64 `json:"threadId"`
			IsTyping   bool  `json:"isTyping"`
			IsGroup    bool  `json:"isGroup"`
			ThreadType int64 `json:"threadType"`
		}
		if err := json.Unmarshal(req.Params, &tp); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendTypingIndicator(tp.ThreadID, tp.IsTyping, tp.IsGroup, tp.ThreadType); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "sendE2EETyping":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var etp struct {
			ChatJID  string `json:"chatJid"`
			IsTyping bool   `json:"isTyping"`
		}
		if err := json.Unmarshal(req.Params, &etp); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.SendE2EETyping(etp.ChatJID, etp.IsTyping); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "markRead":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var mrp struct {
			ThreadID    int64 `json:"threadId"`
			WatermarkTs int64 `json:"watermarkTs"`
		}
		if err := json.Unmarshal(req.Params, &mrp); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.MarkRead(mrp.ThreadID, mrp.WatermarkTs); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "editMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			MessageID string `json:"messageId"`
			NewText   string `json:"newText"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.EditMessage(p.MessageID, p.NewText); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "unsendMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.UnsendMessage(p.MessageID); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "editE2EEMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var emp struct {
			ChatJID   string `json:"chatJid"`
			MessageID string `json:"messageId"`
			NewText   string `json:"newText"`
		}
		if err := json.Unmarshal(req.Params, &emp); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.EditE2EEMessage(emp.ChatJID, emp.MessageID, emp.NewText); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "unsendE2EEMessage":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var ump struct {
			ChatJID   string `json:"chatJid"`
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(req.Params, &ump); err != nil {
			fail(req.ID, err)
			return
		}
		if err := client.UnsendE2EEMessage(ump.ChatJID, ump.MessageID); err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{})

	case "downloadE2EEAttachment":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var dlP bridge.DownloadE2EEMediaOptions
		if err := json.Unmarshal(req.Params, &dlP); err != nil {
			fail(req.ID, err)
			return
		}
		res, err := client.DownloadE2EEMedia(&dlP)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, res)

	case "getUserInfo":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		// IDs are strings across the Electron boundary to avoid JavaScript number
		// precision loss. The Messenger task itself requires a signed int64.
		var p struct {
			UserID string `json:"userId"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		userID, err := strconv.ParseInt(p.UserID, 10, 64)
		if err != nil || userID <= 0 {
			fail(req.ID, fmt.Errorf("invalid userId"))
			return
		}
		info, err := client.GetUserInfo(&bridge.GetUserInfoOptions{UserID: userID})
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, info)

	case "createGroup":
		// DEPLAO_ADAPTER: quick "Tạo nhóm" action. Participant ids are strings across the
		// Electron boundary (JavaScript number precision); the task needs int64.
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		var p struct {
			Participants []string `json:"participants"`
			Name         string   `json:"name"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			fail(req.ID, err)
			return
		}
		participants, err := bridge.ParseParticipantIDs(p.Participants)
		if err != nil {
			fail(req.ID, err)
			return
		}
		created, err := client.CreateGroup(participants, p.Name)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, created)

	case "disconnect":
		if client != nil {
			client.Disconnect()
			client = nil
		}
		ok(req.ID, map[string]interface{}{})

	default:
		fail(req.ID, fmt.Errorf("unknown method: %s", req.Method))
	}
}

// handleSafely turns a panic in one request into an error response for that
// request. Without it, a nil dereference inside a dependency (seen in the
// Messenger Lite Bloks interpreter) killed the whole process, and Electron only
// saw "Bridge exited". DEPLAO_ADAPTER.
func handleSafely(req *request) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		fmt.Fprintf(os.Stderr, "panic in %s: %v\n%s\n", req.Method, recovered, debug.Stack())
		fail(req.ID, fmt.Errorf("internal bridge error in %s: %v", req.Method, recovered))
	}()
	handleRequest(req)
}

// handleRequest is a test seam for handleSafely.
var handleRequest = handle

// serveRequests reads one JSON-RPC request per line, rejecting any line larger
// than maxRequestBytes (fbchat-v2 2.3.2) instead of buffering it without bound.
func serveRequests(input io.Reader, maxRequestBytes int) error {
	if maxRequestBytes <= 0 {
		return fmt.Errorf("max request size must be positive")
	}
	initialBufferSize := 64 * 1024
	if maxRequestBytes < initialBufferSize {
		initialBufferSize = maxRequestBytes
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, initialBufferSize), maxRequestBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			fail(0, fmt.Errorf("invalid json: %w", err))
			continue
		}
		handleSafely(&req)
	}
	return scanner.Err()
}

func disconnectClient() {
	if client != nil {
		client.Disconnect()
		client = nil
	}
}

func main() {
	defer disconnectClient()
	if err := serveRequests(os.Stdin, maxRPCRequestBytes); err != nil {
		fail(0, fmt.Errorf("stdin request exceeds the 150 MiB limit or could not be read: %w", err))
	}
}
