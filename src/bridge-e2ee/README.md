# fbchat-v2 :: bridge-e2ee

Standalone Go binary that handles Facebook Messenger E2EE (Secret Conversations
/ Labyrinth) and exposes a tiny line-delimited JSON RPC over stdin/stdout. The
Python listener (`src/_messaging/_listening_e2ee.py`) launches this binary as a
subprocess.

This package is fully independent from the `meta-messenger.js/` folder. The
underlying Go code (Signal Protocol via `whatsmeow`, Meta protocol via
`mautrix-meta`) is the same - there is no pure-Python alternative.

## Build

You need Go ≥ 1.24 installed (https://go.dev/dl/).

```powershell
cd fbchat-v2/bridge-e2ee

# 1. fetch the mautrix-meta source (referenced by go.mod via `replace`)
git clone https://github.com/mautrix/meta.git ./meta

# 2. download deps and build
go mod tidy
go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee.exe .
```

On Linux/macOS:

```bash
go build -ldflags="-s -w" -o ../build/fbchat-bridge-e2ee .
```

## Where Python looks for the binary

The Python wrapper looks in this order:

1. `$FBCHAT_E2EE_BIN` environment variable
2. `fbchat-v2/build/fbchat-bridge-e2ee[.exe]` (relative to the package)

## Protocol

Request (one JSON object per line):

```json
{"id": 1, "method": "newClient", "params": {"cookies": {...}, "platform": "facebook"}}
```

Response:

```json
{"id": 1, "ok": true, "data": {"ready": true}}
```

Async event (no id):

```json
{"event": {"type": "e2eeMessage", "data": {...}, "timestamp": 1715508423000}}
```

Methods: `newClient`, `connect`, `connectE2EE`, `isConnected`, `sendMessage`,
`sendE2EEMessage`, `disconnect`.

Python wrappers exposed today:

- `_messaging._listening_e2ee.listeningE2EEEvent` - drives `newClient` →
  `connect` → `connectE2EE` and streams async events back to the caller.
- `_messaging._send_e2ee.api` - drives `sendE2EEMessage` (text only). Can
  reuse the listener's bridge process or spawn its own in standalone mode.

Methods present in `bridge/` but **not yet wired** through `main.go` /
Python: `sendReaction`, `editMessage`, `unsendMessage`, `sendTyping`,
`markRead`, `MxDownloadE2EEMedia`, `SendE2EEImage`, `SendE2EEVideo`,
`SendE2EEAudio`. To expose, add a `case "..."` in `handle(req)` of `main.go`
and rebuild.

## Deplao: credential login helper (`login/`)

`login/` is a separate Go module (its own `go.mod`) that
`scripts/build-bridge-e2ee.js` builds into `build/fbchat-login-bridge[.exe]`
next to the E2EE bridge. It was split off when fbchat-v2 2.3.2 pinned mautrix-meta
3ed7bfa, whose Bloks interpreter crashes on Facebook's current Messenger Lite login
pages. The E2EE bridge now pins cea2e38 (fbchat-v2 2.3.3), still older than the
helper's mautrix-meta, so the helper keeps its own newer copy and only runs the
login wizard. It returns session cookies; the account then connects through the
E2EE bridge.

Methods: `hello`, `startNativeLogin`, `submitNativeLogin`, `waitNativeLogin`
(approval on another device), `backNativeLogin` ("Try another way"),
`cancelNativeLogin`, `disconnect`. Errors carry `errorCode` (mautrix login
error codes).

To move it to another mautrix-meta revision: run
`go get go.mau.fi/mautrix-meta@<commit>` and `go mod tidy` inside `login/`
only, copy any `replace` lines from mautrix-meta's own `go.mod` (currently
`github.com/imroc/req/v3 => github.com/beeper/req/v3`), and update
`loginHelper` in `docs/fbchat-v2.3.3-vendor-manifest.json`; the build checks
that the two agree.

## License

The `bridge/` directory contains code copied from
[meta-messenger.js](https://github.com/yumi-team/meta-messenger.js), © 2026
Yumi Team, AGPL-3.0. The `main.go` and Python wrapper are original.
