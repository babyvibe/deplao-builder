package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	"google.golang.org/protobuf/proto"
)

var errTestRandom = errors.New("test random source failed")

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errTestRandom
}

func TestDeviceGenerationUsesInjectedRandomnessAndPropagatesErrors(t *testing.T) {
	t.Run("deterministic input", func(t *testing.T) {
		advSecret := bytes.Repeat([]byte{0xa5}, 32)
		input := append([]byte{0, 1}, advSecret...)
		device, err := newE2EEDevice(bytes.NewReader(input))
		if err != nil {
			t.Fatalf("newE2EEDevice() error = %v", err)
		}
		if device.RegistrationID != 2 {
			t.Fatalf("RegistrationID = %d, want 2", device.RegistrationID)
		}
		if !bytes.Equal(device.AdvSecretKey, advSecret) {
			t.Fatal("ADV secret key was not read from the injected random source")
		}
	})

	t.Run("registration ID error", func(t *testing.T) {
		_, err := newDeviceStoreMemoryOnly(failingReader{})
		if !errors.Is(err, errTestRandom) || !strings.Contains(err.Error(), "registration ID") {
			t.Fatalf("newDeviceStoreMemoryOnly() error = %v, want wrapped registration ID error", err)
		}
	})

	t.Run("ADV secret error", func(t *testing.T) {
		_, err := newDeviceStoreMemoryOnly(io.MultiReader(bytes.NewReader([]byte{0, 1}), failingReader{}))
		if !errors.Is(err, errTestRandom) || !strings.Contains(err.Error(), "ADV secret key") {
			t.Fatalf("newDeviceStoreMemoryOnly() error = %v, want wrapped ADV secret error", err)
		}
	})

	t.Run("disk constructor does not persist partial state", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "nested", "device.json")
		_, err := newDeviceStore(path, failingReader{})
		if !errors.Is(err, errTestRandom) {
			t.Fatalf("newDeviceStore() error = %v, want wrapped random source error", err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatalf("partial device store exists after random source failure: %v", statErr)
		}
	})
}

func TestDeviceStoreLifecycleDeletion(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()

	var identityA, identityB, identityOther [32]byte
	identityA[0], identityB[0], identityOther[0] = 1, 2, 3
	for address, identity := range map[string][32]byte{
		"15551234:1":  identityA,
		"15551234:2":  identityB,
		"155512345:1": identityOther,
	} {
		if err := ds.PutIdentity(ctx, address, identity); err != nil {
			t.Fatalf("PutIdentity(%q) error = %v", address, err)
		}
	}
	for address, session := range map[string][]byte{
		"15551234:1":  {1},
		"15551234:2":  {2},
		"155512345:1": {3},
	} {
		if err := ds.PutSession(ctx, address, session); err != nil {
			t.Fatalf("PutSession(%q) error = %v", address, err)
		}
	}

	if err := ds.DeleteAllIdentities(ctx, "15551234"); err != nil {
		t.Fatalf("DeleteAllIdentities() error = %v", err)
	}
	if err := ds.DeleteAllSessions(ctx, "15551234"); err != nil {
		t.Fatalf("DeleteAllSessions() error = %v", err)
	}

	ds.mu.RLock()
	defer ds.mu.RUnlock()
	if _, exists := ds.identities["15551234:1"]; exists {
		t.Error("first identity was not deleted")
	}
	if _, exists := ds.identities["15551234:2"]; exists {
		t.Error("second identity was not deleted")
	}
	if _, exists := ds.identities["155512345:1"]; !exists {
		t.Error("prefix-adjacent identity was incorrectly deleted")
	}
	if _, exists := ds.sessions["15551234:1"]; exists {
		t.Error("first session was not deleted")
	}
	if _, exists := ds.sessions["15551234:2"]; exists {
		t.Error("second session was not deleted")
	}
	if _, exists := ds.sessions["155512345:1"]; !exists {
		t.Error("prefix-adjacent session was incorrectly deleted")
	}
}

func TestGetManySessionsPreservesRequestedMissingAddresses(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()
	if err := ds.PutSession(ctx, "present:1", []byte("session")); err != nil {
		t.Fatalf("PutSession() error = %v", err)
	}

	sessions, err := ds.GetManySessions(ctx, []string{"present:1", "missing:2"})
	if err != nil {
		t.Fatalf("GetManySessions() error = %v", err)
	}
	if got := sessions["present:1"]; !bytes.Equal(got, []byte("session")) {
		t.Fatalf("present session = %q, want %q", got, "session")
	}
	missing, exists := sessions["missing:2"]
	if !exists {
		t.Fatal("missing requested address was omitted from the result")
	}
	if missing != nil {
		t.Fatalf("missing session = %q, want nil", missing)
	}
}

func TestDeviceStoreMigratePNToLID(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()
	pn := waTypes.JID{User: "15551234", Server: waTypes.DefaultUserServer}
	lid := waTypes.JID{User: "987654", Server: waTypes.HiddenUserServer}
	pnAddress := pn.SignalAddressUser() + ":7"
	lidAddress := lid.SignalAddressUser() + ":7"
	group := "group:" + pn.SignalAddressUser() + ":0"

	var identity [32]byte
	identity[0] = 42
	if err := ds.PutIdentity(ctx, pnAddress, identity); err != nil {
		t.Fatalf("PutIdentity() error = %v", err)
	}
	if err := ds.PutSession(ctx, pnAddress, []byte("session")); err != nil {
		t.Fatalf("PutSession() error = %v", err)
	}
	if err := ds.PutSenderKey(ctx, group, pnAddress, []byte("sender")); err != nil {
		t.Fatalf("PutSenderKey() error = %v", err)
	}

	if err := ds.MigratePNToLID(ctx, pn, lid); err != nil {
		t.Fatalf("MigratePNToLID() error = %v", err)
	}
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	if _, exists := ds.identities[pnAddress]; exists {
		t.Error("old PN identity still exists")
	}
	if got := ds.identities[lidAddress]; got != identity {
		t.Error("identity was not migrated to LID")
	}
	if _, exists := ds.sessions[pnAddress]; exists {
		t.Error("old PN session still exists")
	}
	if got := ds.sessions[lidAddress]; !bytes.Equal(got, []byte("session")) {
		t.Errorf("migrated session = %q, want %q", got, "session")
	}
	if got := ds.senderKeys[group+":"+lidAddress]; !bytes.Equal(got, []byte("sender")) {
		t.Errorf("migrated sender key = %q, want %q", got, "sender")
	}
}

func TestPreKeyUploadLifecyclePersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	ctx := context.Background()

	first, err := ds.GetOrGenPreKeys(ctx, 3)
	if err != nil {
		t.Fatalf("GetOrGenPreKeys() error = %v", err)
	}
	if got := preKeyIDs(first); !slices.Equal(got, []uint32{1, 2, 3}) {
		t.Fatalf("first pre-key IDs = %v, want [1 2 3]", got)
	}
	reused, err := ds.GetOrGenPreKeys(ctx, 3)
	if err != nil {
		t.Fatalf("second GetOrGenPreKeys() error = %v", err)
	}
	if got := preKeyIDs(reused); !slices.Equal(got, []uint32{1, 2, 3}) {
		t.Fatalf("unuploaded pre-key IDs = %v, want [1 2 3]", got)
	}
	if err := ds.MarkPreKeysAsUploaded(ctx, 2); err != nil {
		t.Fatalf("MarkPreKeysAsUploaded() error = %v", err)
	}
	if count, err := ds.UploadedPreKeyCount(ctx); err != nil || count != 2 {
		t.Fatalf("UploadedPreKeyCount() = %d, %v; want 2, nil", count, err)
	}

	reloaded, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	if count, err := reloaded.UploadedPreKeyCount(ctx); err != nil || count != 2 {
		t.Fatalf("reloaded UploadedPreKeyCount() = %d, %v; want 2, nil", count, err)
	}
	next, err := reloaded.GetOrGenPreKeys(ctx, 3)
	if err != nil {
		t.Fatalf("reloaded GetOrGenPreKeys() error = %v", err)
	}
	if got := preKeyIDs(next); !slices.Equal(got, []uint32{3, 4, 5}) {
		t.Fatalf("next pre-key IDs = %v, want [3 4 5]", got)
	}
	uploaded, err := reloaded.GenOnePreKey(ctx)
	if err != nil {
		t.Fatalf("GenOnePreKey() error = %v", err)
	}
	if uploaded.KeyID != 6 {
		t.Fatalf("GenOnePreKey().KeyID = %d, want 6", uploaded.KeyID)
	}
	if count, err := reloaded.UploadedPreKeyCount(ctx); err != nil || count != 3 {
		t.Fatalf("UploadedPreKeyCount() after GenOnePreKey = %d, %v; want 3, nil", count, err)
	}
	if err := reloaded.RemovePreKey(ctx, 1); err != nil {
		t.Fatalf("RemovePreKey() error = %v", err)
	}
	if count, err := reloaded.UploadedPreKeyCount(ctx); err != nil || count != 2 {
		t.Fatalf("UploadedPreKeyCount() after removal = %d, %v; want 2, nil", count, err)
	}
}

func TestLegacyPreKeysAreNotReuploaded(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	if _, err := ds.GetOrGenPreKeys(context.Background(), 2); err != nil {
		t.Fatalf("GetOrGenPreKeys() error = %v", err)
	}
	data, err := ds.GetDeviceData()
	if err != nil {
		t.Fatalf("GetDeviceData() error = %v", err)
	}
	var legacy map[string]any
	if err := json.Unmarshal([]byte(data), &legacy); err != nil {
		t.Fatalf("decode device data: %v", err)
	}
	delete(legacy, "uploaded_pre_keys")
	legacyData, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("encode legacy device data: %v", err)
	}

	reloaded, err := NewDeviceStoreFromData(string(legacyData))
	if err != nil {
		t.Fatalf("NewDeviceStoreFromData() error = %v", err)
	}
	if count, err := reloaded.UploadedPreKeyCount(context.Background()); err != nil || count != 2 {
		t.Fatalf("legacy UploadedPreKeyCount() = %d, %v; want 2, nil", count, err)
	}
}

func TestConcurrentPersistenceProducesCompleteAtomicSnapshots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	ctx := context.Background()

	stopReader := make(chan struct{})
	readErr := make(chan error, 1)
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		for {
			select {
			case <-stopReader:
				return
			default:
			}
			data, readFileErr := readFileWithWindowsRetry(path)
			if readFileErr != nil {
				select {
				case readErr <- fmt.Errorf("read snapshot: %w", readFileErr):
				default:
				}
				return
			}
			var snapshot DeviceJSON
			if unmarshalErr := json.Unmarshal(data, &snapshot); unmarshalErr != nil {
				select {
				case readErr <- fmt.Errorf("decode snapshot: %w", unmarshalErr):
				default:
				}
				return
			}
			if snapshot.NoiseKeyPriv == "" || snapshot.IdentityKeyPriv == "" {
				select {
				case readErr <- errors.New("snapshot contains incomplete key material"):
				default:
				}
				return
			}
			runtime.Gosched()
		}
	}()

	const writers = 8
	const sessionsPerWriter = 12
	writeErr := make(chan error, writers)
	var writes sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		writer := writer
		writes.Add(1)
		go func() {
			defer writes.Done()
			for index := 0; index < sessionsPerWriter; index++ {
				address := fmt.Sprintf("%d:%d", writer, index)
				if putErr := ds.PutSession(ctx, address, []byte(address)); putErr != nil {
					writeErr <- putErr
					return
				}
			}
		}()
	}
	writes.Wait()
	close(stopReader)
	reader.Wait()
	close(writeErr)
	for err := range writeErr {
		t.Errorf("concurrent PutSession() error = %v", err)
	}
	select {
	case err := <-readErr:
		t.Fatal(err)
	default:
	}

	reloaded, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	for writer := 0; writer < writers; writer++ {
		for index := 0; index < sessionsPerWriter; index++ {
			address := fmt.Sprintf("%d:%d", writer, index)
			session, getErr := reloaded.GetSession(ctx, address)
			if getErr != nil {
				t.Fatalf("GetSession(%q) error = %v", address, getErr)
			}
			if !bytes.Equal(session, []byte(address)) {
				t.Errorf("GetSession(%q) = %q, want %q", address, session, address)
			}
		}
	}
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*"))
	if err != nil {
		t.Fatalf("Glob() error = %v", err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("temporary snapshots were not cleaned up: %v", leftovers)
	}
}

func TestPersistenceErrorsAndUnsupportedStoresAreVisible(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ds.path = filepath.Join(t.TempDir(), "missing", "device.json")
	if err := ds.PutSession(context.Background(), "123:1", []byte("session")); err == nil {
		t.Fatal("PutSession() error = nil, want persistence failure")
	}

	ds.path = ""
	_, err = ds.GetContact(context.Background(), waTypes.JID{User: "123"})
	if !errors.Is(err, ErrUnsupportedStoreOperation) {
		t.Fatalf("GetContact() error = %v, want ErrUnsupportedStoreOperation", err)
	}
	if err := ds.PutAppStateSyncKey(context.Background(), nil, store.AppStateSyncKey{}); err == nil {
		t.Fatal("PutAppStateSyncKey() error = nil, want unsupported operation error")
	}

	// Event buffering is explicitly optional in whatsmeow and intentionally
	// retains the upstream NoopStore behavior.
	if event, err := ds.GetBufferedEvent(context.Background(), [32]byte{}); err != nil || event != nil {
		t.Fatalf("GetBufferedEvent() = %v, %v; want nil, nil", event, err)
	}
}

func TestPersistenceFailureRollsBackInMemoryMutation(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()
	if err := ds.PutSession(ctx, "baseline:1", []byte("baseline")); err != nil {
		t.Fatalf("PutSession(baseline) error = %v", err)
	}

	root := t.TempDir()
	ds.path = filepath.Join(root, "missing", "device.json")
	if err := ds.PutSession(ctx, "failed:1", []byte("must-roll-back")); err == nil {
		t.Fatal("PutSession(failed) error = nil, want persistence failure")
	}
	if session, err := ds.GetSession(ctx, "failed:1"); err != nil || session != nil {
		t.Fatalf("GetSession(failed) = %q, %v; want nil, nil after rollback", session, err)
	}
	if hasSession, err := ds.HasSession(ctx, "failed:1"); err != nil || hasSession {
		t.Fatalf("HasSession(failed) = %t, %v; want false, nil after rollback", hasSession, err)
	}

	ds.mu.RLock()
	nextPreKeyID := ds.nextPreKeyID
	ds.mu.RUnlock()
	if _, err := ds.GetOrGenPreKeys(ctx, 2); err == nil {
		t.Fatal("GetOrGenPreKeys() error = nil, want persistence failure")
	}
	ds.mu.RLock()
	if len(ds.preKeys) != 0 || ds.nextPreKeyID != nextPreKeyID {
		t.Errorf("pre-key state survived failed persistence: count=%d next=%d, want count=0 next=%d", len(ds.preKeys), ds.nextPreKeyID, nextPreKeyID)
	}
	ds.mu.RUnlock()

	ds.path = filepath.Join(root, "device.json")
	if err := ds.PutSession(ctx, "committed:1", []byte("committed")); err != nil {
		t.Fatalf("PutSession(committed) error = %v", err)
	}
	reloaded, err := NewDeviceStore(ds.path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	sessions, err := reloaded.GetManySessions(ctx, []string{"baseline:1", "failed:1", "committed:1", "missing:1"})
	if err != nil {
		t.Fatalf("GetManySessions() error = %v", err)
	}
	if session := sessions["failed:1"]; session != nil {
		t.Error("failed mutation leaked into a later successful snapshot")
	}
	if session, exists := sessions["missing:1"]; !exists || session != nil {
		t.Error("GetManySessions() must preserve a requested missing address with a nil session")
	}
	if !bytes.Equal(sessions["baseline:1"], []byte("baseline")) || !bytes.Equal(sessions["committed:1"], []byte("committed")) {
		t.Fatalf("persisted sessions = %v, want baseline and committed values", sessions)
	}
}

func TestDeviceDataDispatcherDoesNotBlockStoreOnFullEventQueue(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	client := &Client{eventChan: make(chan *Event, 1), ctx: ctx, cancel: cancel}
	client.eventChan <- &Event{Type: EventDeviceDataChanged}

	callbackStarted := make(chan struct{})
	var callbackStartedOnce sync.Once
	ds.setOnDataChanged(func(data string) {
		callbackStartedOnce.Do(func() { close(callbackStarted) })
		client.emitEvent(EventDeviceDataChanged, map[string]interface{}{"deviceData": data})
	})
	t.Cleanup(func() {
		cancel()
		ds.stopDataChangedDispatcher()
	})

	if err := ds.PutSession(ctx, "first:1", []byte("first")); err != nil {
		t.Fatalf("PutSession(first) error = %v", err)
	}
	select {
	case <-callbackStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("device data callback did not start")
	}

	done := make(chan error, 1)
	go func() {
		done <- ds.PutSession(ctx, "second:1", []byte("second"))
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("PutSession(second) error = %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("PutSession blocked behind a full event queue")
	}
}

func TestClientDisconnectIsIdempotentAndClosesEventStreamSafely(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	client := &Client{
		eventChan: make(chan *Event, 1),
		ctx:       ctx,
		cancel:    cancel,
	}
	client.eventChan <- &Event{Type: EventDeviceDataChanged}

	emitterDone := make(chan struct{})
	emitterStarted := make(chan struct{})
	go func() {
		defer close(emitterDone)
		close(emitterStarted)
		client.emitEvent(EventDeviceDataChanged, map[string]interface{}{"deviceData": "late"})
	}()
	<-emitterStarted

	deadline := time.Now().Add(2 * time.Second)
	for client.eventMu.TryLock() {
		client.eventMu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("event emitter did not acquire the stream read lock")
		}
		runtime.Gosched()
	}

	client.Disconnect()
	client.Disconnect()

	select {
	case <-emitterDone:
	case <-time.After(2 * time.Second):
		t.Fatal("event emitter remained blocked after disconnect")
	}

	for range client.Events() {
	}
	client.emitEvent(EventDeviceDataChanged, map[string]interface{}{"deviceData": "after-close"})
}

func TestClientCannotReconnectAfterDisconnectStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	client := &Client{
		eventChan: make(chan *Event),
		ctx:       ctx,
		cancel:    cancel,
	}

	client.connectMu.Lock()
	disconnectDone := make(chan struct{})
	go func() {
		defer close(disconnectDone)
		client.Disconnect()
	}()

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Disconnect did not cancel an in-flight lifecycle operation")
	}
	select {
	case <-disconnectDone:
		t.Fatal("Disconnect completed before the in-flight lifecycle operation released")
	default:
	}
	client.connectMu.Unlock()

	select {
	case <-disconnectDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Disconnect did not finish after the lifecycle operation released")
	}

	if _, _, err := client.Connect(); !errors.Is(err, context.Canceled) {
		t.Fatalf("Connect() error = %v, want context.Canceled", err)
	}
	if err := client.ConnectE2EE(); !errors.Is(err, context.Canceled) {
		t.Fatalf("ConnectE2EE() error = %v, want context.Canceled", err)
	}
	if client.IsConnected() || client.IsE2EEConnected() {
		t.Fatal("disconnected client reported an active connection")
	}
}

func TestSendMessageDoesNotDowngradeE2EEToRegularTransport(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	client := &Client{
		eventChan: make(chan *Event),
		ctx:       ctx,
		cancel:    cancel,
	}

	result, err := client.SendMessage(&SendMessageOptions{
		IsE2EE:      true,
		Text:        "private",
		ThreadID:    123,
		E2EEChatJID: "123@msgr",
	})
	if !errors.Is(err, ErrE2EENotConnected) {
		t.Fatalf("SendMessage() error = %v, want ErrE2EENotConnected", err)
	}
	if result != nil {
		t.Fatalf("SendMessage() result = %#v, want nil", result)
	}
}

func TestDeviceDataDispatcherCoalescesLatestSnapshotInOrder(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	latestSeen := make(chan struct{})
	callbackErr := make(chan error, 1)
	var releaseOnce sync.Once
	var latestOnce sync.Once
	var snapshotsMu sync.Mutex
	var snapshots []DeviceJSON
	ds.setOnDataChanged(func(data string) {
		var snapshot DeviceJSON
		if err := json.Unmarshal([]byte(data), &snapshot); err != nil {
			select {
			case callbackErr <- err:
			default:
			}
			return
		}
		snapshotsMu.Lock()
		snapshots = append(snapshots, snapshot)
		position := len(snapshots)
		snapshotsMu.Unlock()
		if position == 1 {
			close(firstStarted)
			<-releaseFirst
		}
		if _, exists := snapshot.Sessions["final:1"]; exists {
			latestOnce.Do(func() { close(latestSeen) })
		}
	})
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseFirst) })
		ds.stopDataChangedDispatcher()
	})

	if err := ds.PutSession(context.Background(), "first:1", []byte("first")); err != nil {
		t.Fatalf("PutSession(first) error = %v", err)
	}
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first device data callback did not start")
	}
	for index := 0; index < 20; index++ {
		address := fmt.Sprintf("pending:%d", index)
		if err := ds.PutSession(context.Background(), address, []byte(address)); err != nil {
			t.Fatalf("PutSession(%s) error = %v", address, err)
		}
	}
	if err := ds.PutSession(context.Background(), "final:1", []byte("final")); err != nil {
		t.Fatalf("PutSession(final) error = %v", err)
	}
	releaseOnce.Do(func() { close(releaseFirst) })

	select {
	case err := <-callbackErr:
		t.Fatalf("decode callback snapshot: %v", err)
	case <-latestSeen:
	case <-time.After(2 * time.Second):
		t.Fatal("latest coalesced device snapshot was not delivered")
	}
	ds.stopDataChangedDispatcher()
	snapshotsMu.Lock()
	defer snapshotsMu.Unlock()
	if len(snapshots) != 2 {
		t.Fatalf("delivered %d snapshots, want first and latest coalesced snapshots", len(snapshots))
	}
	if _, exists := snapshots[0].Sessions["final:1"]; exists {
		t.Error("first snapshot contains state committed later")
	}
	if _, exists := snapshots[1].Sessions["final:1"]; !exists {
		t.Error("last snapshot does not contain the latest committed state")
	}
}

func TestMutableDeviceFieldsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	wantLID := waTypes.JID{User: "987654321", Server: waTypes.HiddenUserServer}
	wantAccount := &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: []byte("account-key"),
		AccountSignature:    []byte("account-signature"),
		DeviceSignature:     []byte("device-signature"),
	}
	ds.Device.LID = wantLID
	ds.Device.LIDMigrationTimestamp = 1_723_456_789
	ds.Device.PushName = "Bridge User"
	ds.Device.BusinessName = "Bridge Business"
	ds.Device.Platform = "facebook"
	ds.Device.Account = wantAccount
	if err := ds.Device.Save(context.Background()); err != nil {
		t.Fatalf("Device.Save() error = %v", err)
	}

	reloaded, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	if reloaded.Device.LID != wantLID {
		t.Errorf("LID = %s, want %s", reloaded.Device.LID, wantLID)
	}
	if reloaded.Device.LIDMigrationTimestamp != ds.Device.LIDMigrationTimestamp {
		t.Errorf("LIDMigrationTimestamp = %d, want %d", reloaded.Device.LIDMigrationTimestamp, ds.Device.LIDMigrationTimestamp)
	}
	if reloaded.Device.PushName != ds.Device.PushName || reloaded.Device.BusinessName != ds.Device.BusinessName || reloaded.Device.Platform != ds.Device.Platform {
		t.Errorf("mutable names/platform = (%q, %q, %q), want (%q, %q, %q)", reloaded.Device.PushName, reloaded.Device.BusinessName, reloaded.Device.Platform, ds.Device.PushName, ds.Device.BusinessName, ds.Device.Platform)
	}
	if !proto.Equal(reloaded.Device.Account, wantAccount) {
		t.Errorf("Account = %v, want %v", reloaded.Device.Account, wantAccount)
	}

	data, err := reloaded.GetDeviceData()
	if err != nil {
		t.Fatalf("GetDeviceData() error = %v", err)
	}
	var legacy map[string]any
	if err := json.Unmarshal([]byte(data), &legacy); err != nil {
		t.Fatalf("decode device data: %v", err)
	}
	for _, field := range []string{"lid", "lid_migration_timestamp", "push_name", "business_name", "platform", "account"} {
		delete(legacy, field)
	}
	legacyData, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("encode legacy device data: %v", err)
	}
	legacyStore, err := NewDeviceStoreFromData(string(legacyData))
	if err != nil {
		t.Fatalf("NewDeviceStoreFromData(legacy) error = %v", err)
	}
	if !legacyStore.Device.LID.IsEmpty() || legacyStore.Device.LIDMigrationTimestamp != 0 || legacyStore.Device.PushName != "" || legacyStore.Device.BusinessName != "" || legacyStore.Device.Platform != "" {
		t.Fatal("legacy store did not use zero-value defaults for newly added fields")
	}
}

func TestPrivacyTokensAndNCTSaltRoundTrip(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()
	user := waTypes.JID{User: "15551234567", Device: 9, Server: waTypes.DefaultUserServer}
	timestamp := time.Unix(1_723_456_789, 0)
	senderTimestamp := time.Unix(1_723_456_700, 0)
	tokenBytes := []byte("private-token")
	if err := ds.PutPrivacyTokens(ctx, store.PrivacyToken{
		User: user, Token: tokenBytes, Timestamp: timestamp, SenderTimestamp: senderTimestamp,
	}); err != nil {
		t.Fatalf("PutPrivacyTokens() error = %v", err)
	}
	tokenBytes[0] = 'X'
	salt := []byte("nct-salt")
	if err := ds.PutNCTSalt(ctx, salt); err != nil {
		t.Fatalf("PutNCTSalt() error = %v", err)
	}
	salt[0] = 'X'

	data, err := ds.GetDeviceData()
	if err != nil {
		t.Fatalf("GetDeviceData() error = %v", err)
	}
	reloaded, err := NewDeviceStoreFromData(data)
	if err != nil {
		t.Fatalf("NewDeviceStoreFromData() error = %v", err)
	}
	gotToken, err := reloaded.GetPrivacyToken(ctx, user.ToNonAD())
	if err != nil {
		t.Fatalf("GetPrivacyToken() error = %v", err)
	}
	if gotToken == nil || string(gotToken.Token) != "private-token" || !gotToken.Timestamp.Equal(timestamp) || !gotToken.SenderTimestamp.Equal(senderTimestamp) {
		t.Fatalf("privacy token = %#v, want persisted token and timestamps", gotToken)
	}
	gotSalt, err := reloaded.GetNCTSalt(ctx)
	if err != nil {
		t.Fatalf("GetNCTSalt() error = %v", err)
	}
	if string(gotSalt) != "nct-salt" {
		t.Fatalf("NCT salt = %q, want nct-salt", gotSalt)
	}
	gotToken.Token[0] = 'X'
	gotSalt[0] = 'X'
	again, _ := reloaded.GetPrivacyToken(ctx, user)
	againSalt, _ := reloaded.GetNCTSalt(ctx)
	if string(again.Token) != "private-token" || string(againSalt) != "nct-salt" {
		t.Fatal("store returned mutable aliases for privacy token or NCT salt")
	}
}

func TestPrivacyTokenUpdateAndExpirySemantics(t *testing.T) {
	ds, err := NewDeviceStoreMemoryOnly()
	if err != nil {
		t.Fatalf("NewDeviceStoreMemoryOnly() error = %v", err)
	}
	ctx := context.Background()
	user := waTypes.JID{User: "15550001111", Server: waTypes.DefaultUserServer}
	base := time.Unix(1_700_000_000, 0)
	if err := ds.PutPrivacyTokens(ctx, store.PrivacyToken{
		User: user, Token: []byte("newer"), Timestamp: base.Add(time.Minute), SenderTimestamp: base,
	}); err != nil {
		t.Fatalf("PutPrivacyTokens(newer) error = %v", err)
	}
	if err := ds.PutPrivacyTokens(ctx, store.PrivacyToken{
		User: user, Token: []byte("stale"), Timestamp: base,
	}); err != nil {
		t.Fatalf("PutPrivacyTokens(stale) error = %v", err)
	}
	got, _ := ds.GetPrivacyToken(ctx, user)
	if got == nil || string(got.Token) != "newer" || !got.SenderTimestamp.Equal(base) {
		t.Fatalf("stale update replaced token: %#v", got)
	}

	deleted, err := ds.DeleteExpiredPrivacyTokens(ctx, base.Add(time.Minute))
	if err != nil || deleted != 0 {
		t.Fatalf("DeleteExpiredPrivacyTokens(equal cutoff) = (%d, %v), want (0, nil)", deleted, err)
	}
	deleted, err = ds.DeleteExpiredPrivacyTokens(ctx, base.Add(2*time.Minute))
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteExpiredPrivacyTokens() = (%d, %v), want (1, nil)", deleted, err)
	}
	if got, _ = ds.GetPrivacyToken(ctx, user); got != nil {
		t.Fatalf("expired privacy token still exists: %#v", got)
	}
	if err := ds.DeleteNCTSalt(ctx); err != nil {
		t.Fatalf("DeleteNCTSalt() error = %v", err)
	}
	if gotSalt, _ := ds.GetNCTSalt(ctx); gotSalt != nil {
		t.Fatalf("NCT salt after delete = %q, want nil", gotSalt)
	}
}

func TestDeleteDeviceRemovesPersistedState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	if err := ds.Device.Delete(context.Background()); err != nil {
		t.Fatalf("Device.Delete() error = %v", err)
	}
	if !ds.Device.Deleted {
		t.Error("Device.Delete() did not mark device as deleted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("device store still exists after delete: %v", err)
	}
	if err := ds.PutSession(context.Background(), "123:1", []byte("session")); !errors.Is(err, store.ErrDeviceDeleted) {
		t.Fatalf("PutSession() after delete error = %v, want store.ErrDeviceDeleted", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("deleted device store was recreated: %v", err)
	}
}

func preKeyIDs(preKeys []*keys.PreKey) []uint32 {
	ids := make([]uint32, len(preKeys))
	for index, preKey := range preKeys {
		ids[index] = preKey.KeyID
	}
	return ids
}

func readFileWithWindowsRetry(path string) ([]byte, error) {
	const maxAttempts = 20
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		var data []byte
		data, err = os.ReadFile(path)
		if err == nil {
			return data, nil
		}
		if runtime.GOOS != "windows" || !isWindowsFileBusyError(err) {
			return nil, err
		}
		time.Sleep(time.Duration(attempt+1) * time.Millisecond)
	}
	return nil, err
}


