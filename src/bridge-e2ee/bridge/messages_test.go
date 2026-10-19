package bridge

import (
	"context"
	"errors"
	"testing"
	"time"

	waTypes "go.mau.fi/whatsmeow/types"
)

func TestUnknownE2EESendResultDoesNotClaimDelivery(t *testing.T) {
	timestamp := time.UnixMilli(1_700_000_000_123)

	result := newUnknownE2EESendResult("mid-timeout", timestamp)

	if result.MessageID != "mid-timeout" {
		t.Fatalf("MessageID = %q, want mid-timeout", result.MessageID)
	}
	if result.TimestampMs != timestamp.UnixMilli() {
		t.Fatalf("TimestampMs = %d, want %d", result.TimestampMs, timestamp.UnixMilli())
	}
	if result.DeliveryStatus != DeliveryStatusUnknown {
		t.Fatalf("DeliveryStatus = %q, want %q", result.DeliveryStatus, DeliveryStatusUnknown)
	}
}

type fakeE2EETypingSender struct {
	fakeE2EEConnectionState
	send func(context.Context, waTypes.JID, waTypes.ChatPresence, waTypes.ChatPresenceMedia) error
}

func (sender *fakeE2EETypingSender) SendChatPresence(ctx context.Context, jid waTypes.JID, presence waTypes.ChatPresence, media waTypes.ChatPresenceMedia) error {
	return sender.send(ctx, jid, presence, media)
}

func TestE2EETypingUsesLifecycleContextAndBoundedDeadline(t *testing.T) {
	type contextKey struct{}
	parent := context.WithValue(context.Background(), contextKey{}, "lifecycle")
	client := &Client{ctx: parent}
	expectedErr := errors.New("presence send failed")
	for _, isTyping := range []bool{false, true} {
		t.Run(map[bool]string{false: "paused", true: "composing"}[isTyping], func(t *testing.T) {
			var usedContext context.Context
			sender := &fakeE2EETypingSender{
				fakeE2EEConnectionState: fakeE2EEConnectionState{connected: true, loggedIn: true},
				send: func(ctx context.Context, jid waTypes.JID, presence waTypes.ChatPresence, media waTypes.ChatPresenceMedia) error {
					usedContext = ctx
					if ctx.Value(contextKey{}) != "lifecycle" {
						t.Fatal("presence context does not inherit the client lifecycle")
					}
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > e2eeTypingTimeout {
						t.Fatalf("presence deadline = %v, want a deadline within %s", deadline, e2eeTypingTimeout)
					}
					if jid.String() != "12345@msgr" {
						t.Fatalf("presence JID = %q", jid.String())
					}
					expectedPresence := waTypes.ChatPresencePaused
					if isTyping {
						expectedPresence = waTypes.ChatPresenceComposing
					}
					if presence != expectedPresence || media != waTypes.ChatPresenceMediaText {
						t.Fatalf("presence = %q/%q, want %q/text", presence, media, expectedPresence)
					}
					return expectedErr
				},
			}
			if err := client.sendE2EETyping(sender, "12345@msgr", isTyping); !errors.Is(err, expectedErr) {
				t.Fatalf("sendE2EETyping() error = %v, want original transport error", err)
			}
			if !errors.Is(usedContext.Err(), context.Canceled) {
				t.Fatal("presence context is not released after send returns")
			}
		})
	}
}

func TestE2EETypingDisconnectCancelsInFlightSend(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	client := &Client{ctx: ctx, cancel: cancel, eventChan: make(chan *Event)}
	started := make(chan struct{})
	sender := &fakeE2EETypingSender{
		fakeE2EEConnectionState: fakeE2EEConnectionState{connected: true, loggedIn: true},
		send: func(ctx context.Context, _ waTypes.JID, _ waTypes.ChatPresence, _ waTypes.ChatPresenceMedia) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	done := make(chan error, 1)
	go func() { done <- client.sendE2EETyping(sender, "12345@msgr", true) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("presence send did not start")
	}
	client.Disconnect()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("sendE2EETyping() error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("presence send did not stop after disconnect")
	}
}

func TestE2EETypingRejectsUnreadyClientsWithoutSending(t *testing.T) {
	if err := (&Client{}).SendE2EETyping("12345@msgr", true); !errors.Is(err, ErrE2EENotConnected) {
		t.Fatalf("SendE2EETyping() without E2EE error = %v", err)
	}
	tests := []struct {
		name  string
		state fakeE2EEConnectionState
	}{
		{name: "disconnected"},
		{name: "not authenticated", state: fakeE2EEConnectionState{connected: true}},
		{name: "authentication without socket", state: fakeE2EEConnectionState{loggedIn: true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := &Client{ctx: context.Background()}
			sender := &fakeE2EETypingSender{
				fakeE2EEConnectionState: test.state,
				send: func(context.Context, waTypes.JID, waTypes.ChatPresence, waTypes.ChatPresenceMedia) error {
					t.Fatal("presence sent before E2EE readiness")
					return nil
				},
			}
			if err := client.sendE2EETyping(sender, "12345@msgr", true); !errors.Is(err, ErrE2EENotConnected) {
				t.Fatalf("sendE2EETyping() error = %v, want ErrE2EENotConnected", err)
			}
		})
	}
}

func TestE2EETypingRejectsCanceledLifecycleAndInvalidJID(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sender := &fakeE2EETypingSender{
		fakeE2EEConnectionState: fakeE2EEConnectionState{connected: true, loggedIn: true},
		send: func(context.Context, waTypes.JID, waTypes.ChatPresence, waTypes.ChatPresenceMedia) error {
			t.Fatal("invalid presence request reached transport")
			return nil
		},
	}
	client := &Client{ctx: ctx}
	if err := client.sendE2EETyping(sender, "12345@msgr", true); !errors.Is(err, context.Canceled) {
		t.Fatalf("sendE2EETyping() error = %v, want context.Canceled", err)
	}
	client = &Client{ctx: context.Background()}
	if err := client.sendE2EETyping(sender, "invalid:jid:device@msgr", true); err == nil {
		t.Fatal("sendE2EETyping() accepted an invalid JID")
	}
}
