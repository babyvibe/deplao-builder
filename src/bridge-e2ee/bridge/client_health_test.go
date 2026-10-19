package bridge

import (
	"context"
	"errors"
	"testing"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/whatsmeow"
)

type fakeE2EEConnectionState struct {
	connected bool
	loggedIn  bool
}

func (state *fakeE2EEConnectionState) IsConnected() bool { return state.connected }
func (state *fakeE2EEConnectionState) IsLoggedIn() bool  { return state.loggedIn }

func TestClientConnectionHealthTracksSocketEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	client := &Client{
		Messagix:  &messagix.Client{},
		eventChan: make(chan *Event, 8),
		ctx:       ctx,
		cancel:    cancel,
	}

	if client.IsConnected() {
		t.Fatal("new client reported connected before a socket ready event")
	}

	client.handleMessagixEvent(ctx, &messagix.ConnectedEvent{})
	if !client.IsConnected() {
		t.Fatal("client did not report connected after a socket ready event")
	}

	client.handleMessagixEvent(ctx, &messagix.TransientDisconnectEvent{Err: errors.New("socket closed")})
	if client.IsConnected() {
		t.Fatal("client remained connected after a socket error")
	}

	client.handleMessagixEvent(ctx, &messagix.ReconnectedEvent{})
	if !client.IsConnected() {
		t.Fatal("client did not report connected after a socket reconnect event")
	}
}

func TestConnectClearsStaleSocketReadinessBeforeBootstrap(t *testing.T) {
	client := &Client{disconnected: true}
	client.regularConnected.Store(true)

	if _, _, err := client.Connect(); err == nil {
		t.Fatal("Connect() unexpectedly succeeded for a disconnected client")
	}
	if client.regularConnected.Load() {
		t.Fatal("Connect() retained stale socket readiness")
	}
}

func TestE2EEReadinessRequiresTransportAndAuthentication(t *testing.T) {
	tests := []struct {
		name      string
		state     e2eeConnectionState
		wantReady bool
	}{
		{name: "nil", state: nil, wantReady: false},
		{
			name:      "transport only",
			state:     &fakeE2EEConnectionState{connected: true},
			wantReady: false,
		},
		{
			name:      "authentication only",
			state:     &fakeE2EEConnectionState{loggedIn: true},
			wantReady: false,
		},
		{
			name: "transport and authentication",
			state: &fakeE2EEConnectionState{
				connected: true,
				loggedIn:  true,
			},
			wantReady: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isE2EEReady(test.state); got != test.wantReady {
				t.Fatalf("isE2EEReady() = %v, want %v", got, test.wantReady)
			}
		})
	}
}

func TestConnectE2EERollsBackPartialClientOnFailure(t *testing.T) {
	tests := []struct {
		name        string
		failureStep string
	}{
		{name: "prepare", failureStep: "prepare"},
		{name: "register", failureStep: "register"},
		{name: "save", failureStep: "save"},
		{name: "connect", failureStep: "connect"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			candidate := &whatsmeow.Client{}
			expectedError := errors.New(test.failureStep + " failed")
			client := &Client{ctx: ctx, cancel: cancel}
			disconnectCalls := 0
			var operationOrder []string

			operations := e2eeConnectOperations{
				prepare: func() (*whatsmeow.Client, error) {
					operationOrder = append(operationOrder, "prepare")
					if test.failureStep == "prepare" {
						return nil, expectedError
					}
					return candidate, nil
				},
				register: func() error {
					operationOrder = append(operationOrder, "register")
					if test.failureStep == "register" {
						return expectedError
					}
					return nil
				},
				save: func() error {
					operationOrder = append(operationOrder, "save")
					if test.failureStep == "save" {
						return expectedError
					}
					return nil
				},
				connect: func(*whatsmeow.Client) error {
					operationOrder = append(operationOrder, "connect")
					if test.failureStep == "connect" {
						return expectedError
					}
					return nil
				},
				disconnect: func(*whatsmeow.Client) {
					disconnectCalls++
				},
			}

			err := client.connectE2EE(operations)

			if !errors.Is(err, expectedError) {
				t.Fatalf("connectE2EE() error = %v, want %v", err, expectedError)
			}
			if client.E2EE != nil {
				t.Fatal("connectE2EE() retained a partially initialized client")
			}
			// DEPLAO_ADAPTER: first-time registration runs before prepare, so a
			// register/save failure leaves no prepared client to disconnect.
			wantDisconnectCalls := 0
			if test.failureStep == "connect" {
				wantDisconnectCalls = 1
			}
			if disconnectCalls != wantDisconnectCalls {
				t.Fatalf("disconnect calls = %d, want %d", disconnectCalls, wantDisconnectCalls)
			}
			wantOrder := map[string][]string{
				"register": {"register"},
				"save":     {"register", "save"},
				"prepare":  {"register", "save", "prepare"},
				"connect":  {"register", "save", "prepare", "connect"},
			}[test.failureStep]
			if len(operationOrder) != len(wantOrder) {
				t.Fatalf("operation order = %v, want %v", operationOrder, wantOrder)
			}
			for index := range wantOrder {
				if operationOrder[index] != wantOrder[index] {
					t.Fatalf("operation order = %v, want %v", operationOrder, wantOrder)
				}
			}
		})
	}
}

// DEPLAO_ADAPTER: a restored device keeps its server identity; connecting it
// must not register it again.
func TestConnectE2EESkipsRegistrationForRestoredDevice(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	client := &Client{ctx: ctx, cancel: cancel}
	registerCalls := 0
	waitCalls := 0

	err := client.connectE2EE(e2eeConnectOperations{
		needsRegistration: func() bool { return false },
		prepare:           func() (*whatsmeow.Client, error) { return &whatsmeow.Client{}, nil },
		register: func() error {
			registerCalls++
			return nil
		},
		save:    func() error { return nil },
		connect: func(*whatsmeow.Client) error { return nil },
		waitReady: func(*whatsmeow.Client) error {
			waitCalls++
			return nil
		},
		disconnect: func(*whatsmeow.Client) {},
	})

	if err != nil {
		t.Fatalf("connectE2EE() error = %v", err)
	}
	if registerCalls != 0 {
		t.Fatalf("register calls = %d, want 0 for a restored device", registerCalls)
	}
	if waitCalls != 1 {
		t.Fatalf("waitReady calls = %d, want 1", waitCalls)
	}
	if client.E2EE == nil {
		t.Fatal("connectE2EE() did not keep the connected client")
	}
}
