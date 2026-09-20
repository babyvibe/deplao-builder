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
// sendImage, sendFile, sendE2EESticker, sendE2EEAudio, sendE2EEVideo, sendE2EEDocument.
//
// Build:
//
//	go mod tidy
//	go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee.exe .
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"fbchat-bridge-e2ee/bridge"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
	"maunium.net/go/mautrix/bridgev2"
)

var (
	// bridgeVersion is set via -ldflags "-X main.bridgeVersion=..."
	// Default fallback for local builds without build script.
	bridgeVersion = "2.3.1-dev"
)

const (
	protocolVersion      = 2
	maxDecodedMediaBytes = 25 * 1024 * 1024 // 25 MiB
)

// DEPLAO_ADAPTER: localPath media transport — Electron-only adapter.
// Upstream expects base64 `data` in JSON-RPC. Electron passes `localPath`
// (filesystem path) to avoid copying large buffers across IPC.
// This adapter reads the file, validates it, then passes bytes to bridge/.
// See: docs/fbchat-v2.3.1-vendor-manifest.json
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
	client *bridge.Client
	// nativeLoginClient is deliberately separate from the connected chat client.
	// It only exists while the Messenger Lite login wizard is active, so an
	// experimental credential login can never replace a live account session.
	nativeLoginClient *messagix.Client
	stdoutMu          sync.Mutex
)

type nativeLoginStartParams struct {
	ProxyURL string `json:"proxyUrl,omitempty"`
}

type nativeLoginSubmitParams struct {
	Input map[string]string `json:"input"`
}

type nativeLoginResult struct {
	Complete bool                `json:"complete"`
	Step     *bridgev2.LoginStep `json:"step,omitempty"`
	Cookies  map[string]string   `json:"cookies,omitempty"`
}

// advanceNativeLogin delegates the complete state machine (password encryption,
// captcha, TOTP, SMS, email and checkpoint choices) to fbchat-v2's Messenger
// Lite implementation. Do not log input values: they may contain credentials.
func advanceNativeLogin(input map[string]string) (*nativeLoginResult, error) {
	if nativeLoginClient == nil || nativeLoginClient.MessengerLite == nil {
		return nil, fmt.Errorf("native login is not initialised")
	}

	step, loginCookies, err := nativeLoginClient.MessengerLite.DoLoginSteps(context.Background(), input)
	if err != nil {
		return nil, err
	}
	if step != nil {
		return &nativeLoginResult{Step: step}, nil
	}
	if loginCookies == nil {
		return nil, fmt.Errorf("native login completed without session cookies")
	}

	values := loginCookies.GetAll()
	resultCookies := make(map[string]string, len(values))
	for key, value := range values {
		resultCookies[string(key)] = value
	}
	// Cookies are returned exactly once to Electron. The client is discarded so
	// another call cannot accidentally continue an already-completed login.
	nativeLoginClient = nil
	return &nativeLoginResult{Complete: true, Cookies: resultCookies}, nil
}

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
				"connectE2EE", "sendMessage", "sendE2EEMessage", "sendE2EEImage",
				"sendE2EEVideo", "sendE2EEAudio", "sendE2EEDocument", "mediaLocalPath",
				"sendTypingIndicator", "sendE2EETyping", "markRead",
				"editMessage", "unsendMessage", "editE2EEMessage", "unsendE2EEMessage",
				"nativeLogin",
			},
			"maxDecodedMediaBytes": maxDecodedMediaBytes,
		})

	case "newClient":
		// DEPLAO_ADAPTER: deviceData transport — Electron passes device state
		// as a JSON string via secureStorage instead of file I/O.
		// Upstream uses DevicePath (file); Electron uses DeviceData (string).
		// See: docs/fbchat-v2.3.1-vendor-manifest.json
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

	case "startNativeLogin":
		if nativeLoginClient != nil {
			fail(req.ID, fmt.Errorf("native login is already active"))
			return
		}
		var params nativeLoginStartParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			fail(req.ID, err)
			return
		}
		loginCookies := &cookies.Cookies{Platform: types.MessengerLite}
		loginCookies.UpdateValues(map[cookies.MetaCookieName]string{})
		loginLogger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).With().Timestamp().Logger()
		nativeLoginClient = messagix.NewClient(loginCookies, loginLogger, &messagix.Config{})
		if params.ProxyURL != "" {
			if err := nativeLoginClient.SetProxy(params.ProxyURL); err != nil {
				nativeLoginClient = nil
				fail(req.ID, fmt.Errorf("invalid login proxy: %w", err))
				return
			}
		}
		result, err := advanceNativeLogin(nil)
		if err != nil {
			nativeLoginClient = nil
			fail(req.ID, err)
			return
		}
		ok(req.ID, result)

	case "submitNativeLogin":
		var params nativeLoginSubmitParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			fail(req.ID, err)
			return
		}
		if len(params.Input) > 8 {
			fail(req.ID, fmt.Errorf("too many native login inputs"))
			return
		}
		for key, value := range params.Input {
			if len(key) > 128 || len(value) > 4096 {
				fail(req.ID, fmt.Errorf("native login input exceeds size limit"))
				return
			}
		}
		result, err := advanceNativeLogin(params.Input)
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, result)

	case "cancelNativeLogin":
		nativeLoginClient = nil
		ok(req.ID, map[string]interface{}{})

	case "connect":
		if client == nil {
			fail(req.ID, fmt.Errorf("client not initialised"))
			return
		}
		user, _, err := client.Connect()
		if err != nil {
			fail(req.ID, err)
			return
		}
		ok(req.ID, map[string]interface{}{
			"user": user,
		})

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

	case "disconnect":
		if client != nil {
			client.Disconnect()
			client = nil
		}
		nativeLoginClient = nil
		ok(req.ID, map[string]interface{}{})

	default:
		fail(req.ID, fmt.Errorf("unknown method: %s", req.Method))
	}
}

func main() {
	// Use a large buffer because initial sync data can be substantial.
	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var req request
			if jerr := json.Unmarshal(line, &req); jerr != nil {
				fail(0, fmt.Errorf("invalid json: %w", jerr))
			} else {
				handle(&req)
			}
		}
		if err != nil {
			if err == io.EOF {
				if client != nil {
					client.Disconnect()
				}
				nativeLoginClient = nil
				return
			}
			fmt.Fprintln(os.Stderr, "stdin error:", err)
			return
		}
	}
}
