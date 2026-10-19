module fbchat-bridge-e2ee

go 1.26.9

require (
	github.com/google/uuid v1.6.0
	github.com/rs/zerolog v1.35.1
	go.mau.fi/mautrix-meta v0.0.0
	go.mau.fi/util v0.10.2-0.20260918225449-a4c0d5b86aa8
	go.mau.fi/whatsmeow v0.0.0-20260919103545-0057a822e79a
	golang.org/x/sys v0.48.0
	google.golang.org/protobuf v1.36.12
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/andybalholm/brotli v1.2.4 // indirect
	github.com/beeper/argo-go v1.1.2 // indirect
	github.com/beeper/poly1305 v0.0.0-20250815183548-d4eede7bbf3c // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/coreos/go-systemd/v22 v22.7.0 // indirect
	github.com/elliotchance/orderedmap/v3 v3.1.0 // indirect
	github.com/google/go-querystring v1.2.0 // indirect
	github.com/gtank/ristretto255 v0.2.0 // indirect
	github.com/icholy/digest v1.2.0 // indirect
	github.com/imroc/req/v3 v3.56.0 // indirect
	github.com/klauspost/compress v1.20.0 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/petermattis/goid v0.0.0-20260820044319-269ab09b5261 // indirect
	github.com/quic-go/qpack v0.6.0 // indirect
	github.com/quic-go/quic-go v0.61.0 // indirect
	github.com/refraction-networking/utls v1.8.2 // indirect
	github.com/rs/xid v1.6.0 // indirect
	github.com/tidwall/gjson v1.19.0 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	github.com/vektah/gqlparser/v2 v2.5.27 // indirect
	github.com/yuin/goldmark v1.8.6 // indirect
	go.mau.fi/libsignal v0.2.2 // indirect
	go.mau.fi/zeroconfig v0.2.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/exp v0.0.0-20260908205506-85c1c2202aba // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.2.1 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	maunium.net/go/mautrix v0.31.1-0.20261005141226-f14e6b5fc009 // indirect
)

// E2EE Messenger requires a forked mautrix-meta. Clone it next to bridge-e2ee:
//     git clone https://github.com/mautrix/meta.git ./meta
// Or change the path below to point at an existing checkout.
replace go.mau.fi/mautrix-meta => ./meta

// Upstream mautrix-meta relies on Beeper's req fork for the current QUIC API.
// Replace directives are not inherited through dependencies, so the bridge
// module must mirror the upstream directive explicitly.
replace github.com/imroc/req/v3 => github.com/beeper/req/v3 v3.0.0-20260925135712-b49593750e56
