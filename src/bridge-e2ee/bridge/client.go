package bridge

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	"google.golang.org/protobuf/proto"

	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

type messageEventSource uint8

const (
	messageEventSourceInsert messageEventSource = iota + 1
	messageEventSourceStandaloneUpsert
)

type recentMessageEvent struct {
	emittedAt int64
	source    messageEventSource
}

// Client wraps the messagix client and e2ee client
type Client struct {
	ID          uint64
	Messagix    *messagix.Client
	E2EE        *whatsmeow.Client
	DeviceStore *DeviceStore
	Logger      zerolog.Logger
	FBID        int64
	Platform    types.Platform

	eventChan           chan *Event
	eventMu             sync.RWMutex
	eventsClosed        bool
	disconnectOnce      sync.Once
	connectMu           sync.Mutex
	lifecycleMu         sync.RWMutex
	disconnected        bool
	ctx                 context.Context
	cancel              context.CancelFunc
	mu                  sync.RWMutex
	threadCache         map[int64]*Thread
	recentUnreactions   map[string]int64 // key: messageId+actorId, value: timestamp
	recentUnreactionsMu sync.RWMutex
	recentMessages      map[string]recentMessageEvent
	recentMessagesMu    sync.Mutex
	recentMessageSweep  int64
	liveMessageCutoffMs int64
	regularConnected    atomic.Bool
}

// ClientConfig for creating a new client
type ClientConfig struct {
	Cookies        map[string]string `json:"cookies"`
	Platform       string            `json:"platform"` // "facebook", "messenger", "instagram"
	DevicePath     string            `json:"devicePath"`
	DeviceData     string            `json:"deviceData,omitempty"`     // JSON string of device data (optional, takes priority over DevicePath)
	E2EEMemoryOnly bool              `json:"e2eeMemoryOnly,omitempty"` // If true, E2EE state is stored in memory only (no file, no events)
	LogLevel       string            `json:"logLevel"`
}

// NewClient creates a new messagix client
func NewClient(cfg *ClientConfig) (*Client, error) {
	// Parse platform
	var platform types.Platform
	switch cfg.Platform {
	case "facebook":
		platform = types.Facebook
	case "messenger":
		platform = types.Messenger
	case "instagram":
		platform = types.Instagram
	default:
		platform = types.Facebook
	}

	// Create cookies
	cks := &cookies.Cookies{Platform: platform}
	valMap := make(map[cookies.MetaCookieName]string)
	for k, v := range cfg.Cookies {
		valMap[cookies.MetaCookieName(k)] = v
	}
	cks.UpdateValues(valMap)

	// Setup logger
	logLevel := zerolog.InfoLevel
	switch cfg.LogLevel {
	case "debug":
		logLevel = zerolog.DebugLevel
	case "trace":
		logLevel = zerolog.TraceLevel
	case "warn":
		logLevel = zerolog.WarnLevel
	case "error":
		logLevel = zerolog.ErrorLevel
	case "none":
		logLevel = zerolog.Disabled
	}
	zerolog.SetGlobalLevel(logLevel)
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).With().Timestamp().Logger()

	// Create messagix client
	msgClient := messagix.NewClient(cks, logger, &messagix.Config{
		ClientSettings: exhttp.ClientSettings{},
	})

	// Create device store
	var deviceStore *DeviceStore
	var err error
	if cfg.E2EEMemoryOnly {
		// Memory only mode - no persistence
		deviceStore, err = NewDeviceStoreMemoryOnly()
	} else if cfg.DeviceData != "" {
		// Use provided device data (no file I/O)
		deviceStore, err = NewDeviceStoreFromData(cfg.DeviceData)
	} else if cfg.DevicePath == "" {
		// DEPLAO_ADAPTER: Electron persists state through safeStorage. Keep the
		// first device in memory and publish snapshots instead of creating an
		// unencrypted e2ee_device.json in the process working directory.
		deviceStore, err = NewDeviceStoreMemoryOnly()
	} else {
		// Use file path
		devicePath := cfg.DevicePath
		if devicePath == "" {
			devicePath = "e2ee_device.json"
		}
		deviceStore, err = NewDeviceStore(devicePath)
	}
	if err != nil {
		return nil, err
	}

	// Set device on client
	msgClient.SetDevice(deviceStore.Device)

	ctx, cancel := context.WithCancel(context.Background())

	client := &Client{
		Messagix:          msgClient,
		DeviceStore:       deviceStore,
		Logger:            logger,
		Platform:          platform,
		eventChan:         make(chan *Event, 100),
		ctx:               ctx,
		cancel:            cancel,
		threadCache:       make(map[int64]*Thread),
		recentUnreactions: make(map[string]int64),
		recentMessages:    make(map[string]recentMessageEvent),
	}

	// Electron uses either DeviceData or an empty DevicePath with safeStorage.
	// In both cases publish every changed snapshot to the main process.
	if !cfg.E2EEMemoryOnly && (cfg.DeviceData != "" || cfg.DevicePath == "") {
		deviceStore.setOnDataChanged(func(data string) {
			client.emitEvent(EventDeviceDataChanged, map[string]interface{}{
				"deviceData": data,
			})
		})
	}

	// Set event handler
	msgClient.SetEventHandler(client.handleMessagixEvent)

	return client, nil
}

func (c *Client) handleMessagixEvent(ctx context.Context, evt any) {
	switch evt.(type) {
	case *messagix.Event_Ready, *messagix.Event_Reconnected:
		c.regularConnected.Store(true)
	case *messagix.Event_SocketError, *messagix.Event_PermanentError:
		c.regularConnected.Store(false)
	}
	c.handleEvent(ctx, evt)
}

// Connect connects to Messenger
func (c *Client) Connect() (*UserInfo, *InitialData, error) {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()
	c.regularConnected.Store(false)
	if err := c.lifecycleError(); err != nil {
		return nil, nil, err
	}
	// Mở cửa sổ trước page load để không làm rơi message được gửi trong lúc
	// bootstrap; cutoff zero-grace vẫn loại mọi message có trước Connect().
	c.openRealtimeMessageWindow(0)

	// Load messages page
	currentUser, initialTable, err := c.Messagix.LoadMessagesPage(c.ctx)
	if err != nil {
		return nil, nil, err
	}
	if initialTable != nil {
		for _, thread := range initialTable.LSDeleteThenInsertThread {
			c.cacheThread(convertThread(thread))
		}
	}

	// Extract user info
	userInfo := &UserInfo{
		Name:     currentUser.GetName(),
		Username: currentUser.GetUsername(),
		ID:       currentUser.GetFBID(),
	}
	c.FBID = userInfo.ID

	// Connect socket
	if err := c.lifecycleError(); err != nil {
		return nil, nil, err
	}
	if err := c.Messagix.Connect(c.ctx); err != nil {
		c.regularConnected.Store(false)
		return nil, nil, err
	}
	if err := c.lifecycleError(); err != nil {
		return nil, nil, err
	}

	return userInfo, nil, nil
}

// ConnectE2EE sets up and connects the E2EE client
func (c *Client) ConnectE2EE() error {
	c.connectMu.Lock()
	defer c.connectMu.Unlock()
	if err := c.lifecycleError(); err != nil {
		return err
	}

	currentE2EE := c.snapshotE2EEClient()
	if currentE2EE != nil && currentE2EE.IsConnected() {
		return nil
	}

	// Prepare E2EE client
	e2eeClient, err := c.Messagix.PrepareE2EEClient()
	if err != nil {
		return err
	}
	if err := c.lifecycleError(); err != nil {
		return err
	}
	c.lifecycleMu.Lock()
	if c.disconnected || c.ctx.Err() != nil {
		c.lifecycleMu.Unlock()
		return context.Canceled
	}
	c.E2EE = e2eeClient
	c.lifecycleMu.Unlock()

	// Register E2EE
	if err := c.Messagix.RegisterE2EE(c.ctx, c.FBID); err != nil {
		return err
	}
	if err := c.DeviceStore.Save(); err != nil {
		return fmt.Errorf("failed to persist E2EE device after registration: %w", err)
	}
	if err := c.lifecycleError(); err != nil {
		return err
	}

	// Register before connecting: ConnectContext may synchronously deliver queued
	// messages, so registering afterwards creates a message-loss window.
	e2eeClient.AddEventHandler(c.handleE2EEEvent)

	// Connect E2EE
	if err := e2eeClient.ConnectContext(c.ctx); err != nil {
		return err
	}
	if err := c.lifecycleError(); err != nil {
		e2eeClient.Disconnect()
		return err
	}

	return nil
}

// Disconnect disconnects from Messenger
func (c *Client) Disconnect() {
	c.disconnectOnce.Do(func() {
		c.regularConnected.Store(false)
		if c.cancel != nil {
			c.cancel()
		}

		// Mark the lifecycle closed without holding the state lock across calls
		// into messagix/whatsmeow, whose callbacks may re-enter this client.
		c.lifecycleMu.Lock()
		c.disconnected = true
		c.lifecycleMu.Unlock()

		// Cancel before waiting for an in-flight connection. Network operations
		// receive the cancellation, and new connection attempts fail the closed
		// lifecycle check after this serialization point.
		c.connectMu.Lock()
		c.lifecycleMu.RLock()
		deviceStore := c.DeviceStore
		e2eeClient := c.E2EE
		messagixClient := c.Messagix
		c.lifecycleMu.RUnlock()
		c.connectMu.Unlock()

		if deviceStore != nil {
			deviceStore.stopDataChangedDispatcher()
		}
		if e2eeClient != nil && e2eeClient.IsConnected() {
			e2eeClient.Disconnect()
		}
		if messagixClient != nil {
			messagixClient.Disconnect()
		}

		// Closing the stream under the write lock prevents late callbacks from
		// racing a send against close(eventChan). Canceling first releases any
		// emitter blocked on a full channel before this lock is acquired.
		c.eventMu.Lock()
		if !c.eventsClosed {
			c.eventsClosed = true
			close(c.eventChan)
		}
		c.eventMu.Unlock()
	})
}

func (c *Client) lifecycleError() error {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	if c.disconnected || c.ctx == nil {
		return context.Canceled
	}
	return c.ctx.Err()
}

func (c *Client) snapshotE2EEClient() *whatsmeow.Client {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	if c.disconnected {
		return nil
	}
	return c.E2EE
}

type e2eeConnectionState interface {
	IsConnected() bool
	IsLoggedIn() bool
}

func isE2EEReady(state e2eeConnectionState) bool {
	return state != nil && state.IsConnected() && state.IsLoggedIn()
}

// IsConnected returns true if connected
func (c *Client) IsConnected() bool {
	c.lifecycleMu.RLock()
	defer c.lifecycleMu.RUnlock()
	return !c.disconnected && c.Messagix != nil && c.ctx != nil && c.ctx.Err() == nil && c.regularConnected.Load()
}

// IsE2EEConnected returns true if E2EE is connected
func (c *Client) IsE2EEConnected() bool {
	e2eeClient := c.snapshotE2EEClient()
	if e2eeClient == nil {
		return false
	}
	return isE2EEReady(e2eeClient)
}

// Events returns the event channel
func (c *Client) Events() <-chan *Event {
	return c.eventChan
}

// DeviceStore manages the E2EE device persistently
type DeviceStore struct {
	Device       *store.Device
	path         string
	mu           sync.RWMutex
	saveMu       sync.Mutex
	identities   map[string][32]byte
	sessions     map[string][]byte
	preKeys      map[uint32]*keys.PreKey
	uploadedKeys map[uint32]struct{}
	senderKeys   map[string][]byte
	nextPreKeyID uint32
	deleted      bool
	dataChanges  *deviceDataDispatcher
}

var errDeviceDataDispatcherStopped = errors.New("device data dispatcher is stopped")

// deviceDataDispatcher keeps persistence notifications off the cryptographic
// store's locks. A single worker preserves delivery order, while the one-slot
// pending snapshot coalesces intermediate states when the consumer is slow.
// Every delivered snapshot is therefore newer than the previous one, and the
// latest committed state is retained without spawning an unbounded goroutine.
type deviceDataDispatcher struct {
	callback func(string)
	wake     chan struct{}
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once

	mu         sync.Mutex
	pending    string
	hasPending bool
	stopped    bool
}

func newDeviceDataDispatcher(callback func(string)) *deviceDataDispatcher {
	dispatcher := &deviceDataDispatcher{
		callback: callback,
		wake:     make(chan struct{}, 1),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go dispatcher.run()
	return dispatcher
}

func (dispatcher *deviceDataDispatcher) enqueue(data string) error {
	dispatcher.mu.Lock()
	defer dispatcher.mu.Unlock()
	if dispatcher.stopped {
		return errDeviceDataDispatcherStopped
	}
	dispatcher.pending = data
	dispatcher.hasPending = true
	select {
	case dispatcher.wake <- struct{}{}:
	default:
	}
	return nil
}

func (dispatcher *deviceDataDispatcher) run() {
	defer close(dispatcher.done)
	for {
		select {
		case <-dispatcher.wake:
			for {
				dispatcher.mu.Lock()
				if dispatcher.stopped {
					dispatcher.mu.Unlock()
					return
				}
				if !dispatcher.hasPending {
					dispatcher.mu.Unlock()
					break
				}
				data := dispatcher.pending
				dispatcher.hasPending = false
				dispatcher.mu.Unlock()
				dispatcher.callback(data)
			}
		case <-dispatcher.stop:
			return
		}
	}
}

func (dispatcher *deviceDataDispatcher) shutdown() {
	dispatcher.stopOnce.Do(func() {
		dispatcher.mu.Lock()
		dispatcher.stopped = true
		dispatcher.mu.Unlock()
		close(dispatcher.stop)
	})
	<-dispatcher.done
}

func (ds *DeviceStore) setOnDataChanged(callback func(string)) {
	if callback == nil {
		return
	}
	ds.saveMu.Lock()
	ds.mu.Lock()
	previous := ds.dataChanges
	ds.dataChanges = newDeviceDataDispatcher(callback)
	ds.mu.Unlock()
	ds.saveMu.Unlock()
	if previous != nil {
		previous.shutdown()
	}
}

func (ds *DeviceStore) stopDataChangedDispatcher() {
	ds.mu.RLock()
	dispatcher := ds.dataChanges
	ds.mu.RUnlock()
	if dispatcher != nil {
		dispatcher.shutdown()
	}
}

// DeviceJSON for JSON serialization
type DeviceJSON struct {
	NoiseKeyPriv     string            `json:"noise_key_priv"`
	IdentityKeyPriv  string            `json:"identity_key_priv"`
	SignedPreKeyPriv string            `json:"signed_pre_key_priv"`
	SignedPreKeyID   uint32            `json:"signed_pre_key_id"`
	SignedPreKeySig  string            `json:"signed_pre_key_sig"`
	RegistrationID   uint32            `json:"registration_id"`
	AdvSecretKey     string            `json:"adv_secret_key"`
	FacebookUUID     string            `json:"facebook_uuid"`
	JIDUser          string            `json:"jid_user,omitempty"`
	JIDDevice        uint16            `json:"jid_device,omitempty"`
	LID              string            `json:"lid,omitempty"`
	LIDMigrationTS   int64             `json:"lid_migration_timestamp,omitempty"`
	PushName         string            `json:"push_name,omitempty"`
	BusinessName     string            `json:"business_name,omitempty"`
	Platform         string            `json:"platform,omitempty"`
	Account          string            `json:"account,omitempty"`
	Identities       map[string]string `json:"identities,omitempty"`
	Sessions         map[string]string `json:"sessions,omitempty"`
	PreKeys          map[string]string `json:"pre_keys,omitempty"`
	UploadedPreKeys  []uint32          `json:"uploaded_pre_keys"`
	SenderKeys       map[string]string `json:"sender_keys,omitempty"`
	NextPreKeyID     uint32            `json:"next_pre_key_id"`
}

const maxRegistrationID = 16380

func newEmptyDeviceStore(path string) *DeviceStore {
	return &DeviceStore{
		path:         path,
		identities:   make(map[string][32]byte),
		sessions:     make(map[string][]byte),
		preKeys:      make(map[uint32]*keys.PreKey),
		uploadedKeys: make(map[uint32]struct{}),
		senderKeys:   make(map[string][]byte),
		nextPreKeyID: 1,
	}
}

func newE2EEDevice(randomReader io.Reader) (*store.Device, error) {
	if randomReader == nil {
		return nil, errors.New("crypto random reader is nil")
	}

	registrationValue, err := cryptorand.Int(randomReader, big.NewInt(maxRegistrationID))
	if err != nil {
		return nil, fmt.Errorf("generate registration ID: %w", err)
	}
	advSecretKey := make([]byte, 32)
	if _, err = io.ReadFull(randomReader, advSecretKey); err != nil {
		return nil, fmt.Errorf("generate ADV secret key: %w", err)
	}

	device := &store.Device{
		NoiseKey:       keys.NewKeyPair(),
		IdentityKey:    keys.NewKeyPair(),
		RegistrationID: uint32(registrationValue.Uint64()) + 1,
		AdvSecretKey:   advSecretKey,
		FacebookUUID:   uuid.New(),
	}
	device.SignedPreKey = device.IdentityKey.CreateSignedPreKey(1)
	return device, nil
}

func (ds *DeviceStore) configureInterfaces() {
	ds.Device.SetAllStores(ds)
	ds.Device.LIDs = ds
	ds.Device.Container = ds
	ds.Device.Initialized = true

	if ds.Device.Account == nil {
		ds.Device.Account = &waAdv.ADVSignedDeviceIdentity{
			Details: make([]byte, 0), AccountSignatureKey: make([]byte, 32),
			AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
		}
	}
}

func decodeStoredBytes(fieldName, encoded string, expectedLength int) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", fieldName, err)
	}
	if expectedLength >= 0 && len(decoded) != expectedLength {
		return nil, fmt.Errorf("invalid %s length: got %d, want %d", fieldName, len(decoded), expectedLength)
	}
	return decoded, nil
}

func (ds *DeviceStore) loadDeviceJSON(deviceJSON *DeviceJSON) error {
	noisePriv, err := decodeStoredBytes("noise private key", deviceJSON.NoiseKeyPriv, 32)
	if err != nil {
		return err
	}
	identityPriv, err := decodeStoredBytes("identity private key", deviceJSON.IdentityKeyPriv, 32)
	if err != nil {
		return err
	}
	signedPreKeyPriv, err := decodeStoredBytes("signed pre-key private key", deviceJSON.SignedPreKeyPriv, 32)
	if err != nil {
		return err
	}
	signedPreKeySig, err := decodeStoredBytes("signed pre-key signature", deviceJSON.SignedPreKeySig, 64)
	if err != nil {
		return err
	}
	advSecretKey, err := decodeStoredBytes("ADV secret key", deviceJSON.AdvSecretKey, 32)
	if err != nil {
		return err
	}
	if deviceJSON.RegistrationID < 1 || deviceJSON.RegistrationID > maxRegistrationID {
		return fmt.Errorf("invalid registration ID %d", deviceJSON.RegistrationID)
	}

	var noiseKey, identityKey, signedPreKey [32]byte
	var signedPreKeySignature [64]byte
	copy(noiseKey[:], noisePriv)
	copy(identityKey[:], identityPriv)
	copy(signedPreKey[:], signedPreKeyPriv)
	copy(signedPreKeySignature[:], signedPreKeySig)
	ds.Device = &store.Device{
		NoiseKey:    keys.NewKeyPairFromPrivateKey(noiseKey),
		IdentityKey: keys.NewKeyPairFromPrivateKey(identityKey),
		SignedPreKey: &keys.PreKey{
			KeyPair:   *keys.NewKeyPairFromPrivateKey(signedPreKey),
			KeyID:     deviceJSON.SignedPreKeyID,
			Signature: &signedPreKeySignature,
		},
		RegistrationID:        deviceJSON.RegistrationID,
		AdvSecretKey:          append([]byte(nil), advSecretKey...),
		PushName:              deviceJSON.PushName,
		BusinessName:          deviceJSON.BusinessName,
		Platform:              deviceJSON.Platform,
		LIDMigrationTimestamp: deviceJSON.LIDMigrationTS,
	}

	if deviceJSON.FacebookUUID != "" {
		ds.Device.FacebookUUID, err = uuid.Parse(deviceJSON.FacebookUUID)
		if err != nil {
			return fmt.Errorf("parse Facebook UUID: %w", err)
		}
	}
	if deviceJSON.JIDUser != "" {
		ds.Device.ID = &waTypes.JID{User: deviceJSON.JIDUser, Device: deviceJSON.JIDDevice, Server: waTypes.MessengerServer}
	}
	if deviceJSON.LID != "" {
		ds.Device.LID, err = waTypes.ParseJID(deviceJSON.LID)
		if err != nil {
			return fmt.Errorf("parse LID: %w", err)
		}
	}
	if deviceJSON.Account != "" {
		accountData, decodeErr := decodeStoredBytes("account", deviceJSON.Account, -1)
		if decodeErr != nil {
			return decodeErr
		}
		account := &waAdv.ADVSignedDeviceIdentity{}
		if unmarshalErr := proto.Unmarshal(accountData, account); unmarshalErr != nil {
			return fmt.Errorf("decode account: %w", unmarshalErr)
		}
		ds.Device.Account = account
	}

	for address, encoded := range deviceJSON.Identities {
		decoded, decodeErr := decodeStoredBytes("identity", encoded, 32)
		if decodeErr != nil {
			return fmt.Errorf("identity %q: %w", address, decodeErr)
		}
		var identity [32]byte
		copy(identity[:], decoded)
		ds.identities[address] = identity
	}
	for address, encoded := range deviceJSON.Sessions {
		decoded, decodeErr := decodeStoredBytes("session", encoded, -1)
		if decodeErr != nil {
			return fmt.Errorf("session %q: %w", address, decodeErr)
		}
		ds.sessions[address] = decoded
	}
	for idString, encoded := range deviceJSON.PreKeys {
		idValue, parseErr := strconv.ParseUint(idString, 10, 32)
		if parseErr != nil {
			return fmt.Errorf("parse pre-key ID %q: %w", idString, parseErr)
		}
		decoded, decodeErr := decodeStoredBytes("pre-key private key", encoded, 32)
		if decodeErr != nil {
			return fmt.Errorf("pre-key %d: %w", idValue, decodeErr)
		}
		var privateKey [32]byte
		copy(privateKey[:], decoded)
		id := uint32(idValue)
		ds.preKeys[id] = &keys.PreKey{KeyPair: *keys.NewKeyPairFromPrivateKey(privateKey), KeyID: id}
	}
	for storageKey, encoded := range deviceJSON.SenderKeys {
		decoded, decodeErr := decodeStoredBytes("sender key", encoded, -1)
		if decodeErr != nil {
			return fmt.Errorf("sender key %q: %w", storageKey, decodeErr)
		}
		ds.senderKeys[storageKey] = decoded
	}

	if deviceJSON.UploadedPreKeys == nil {
		// Legacy stores did not distinguish uploaded pre-keys. Treat existing
		// keys as uploaded so one-time keys are never re-uploaded after upgrade.
		for id := range ds.preKeys {
			ds.uploadedKeys[id] = struct{}{}
		}
	} else {
		for _, id := range deviceJSON.UploadedPreKeys {
			if _, exists := ds.preKeys[id]; exists {
				ds.uploadedKeys[id] = struct{}{}
			}
		}
	}

	ds.nextPreKeyID = deviceJSON.NextPreKeyID
	if ds.nextPreKeyID == 0 {
		ds.nextPreKeyID = 1
	}
	for id := range ds.preKeys {
		if id >= ds.nextPreKeyID {
			ds.nextPreKeyID = id + 1
		}
	}
	return nil
}

// NewDeviceStore creates or loads a device store
func NewDeviceStore(path string) (*DeviceStore, error) {
	return newDeviceStore(path, cryptorand.Reader)
}

func newDeviceStore(path string, randomReader io.Reader) (*DeviceStore, error) {
	if path == "" {
		return nil, errors.New("device store path is empty")
	}
	ds := newEmptyDeviceStore(path)
	created := false

	if data, err := os.ReadFile(path); err == nil {
		var deviceJSON DeviceJSON
		if err := json.Unmarshal(data, &deviceJSON); err != nil {
			return nil, fmt.Errorf("decode device store: %w", err)
		}
		if err := ds.loadDeviceJSON(&deviceJSON); err != nil {
			return nil, fmt.Errorf("load device store: %w", err)
		}
	} else if os.IsNotExist(err) {
		created = true
		ds.Device, err = newE2EEDevice(randomReader)
		if err != nil {
			return nil, err
		}
		if dir := filepath.Dir(path); dir != "." && dir != "" {
			if err := os.MkdirAll(dir, 0700); err != nil {
				return nil, fmt.Errorf("create device store directory: %w", err)
			}
		}
	} else {
		return nil, fmt.Errorf("read device store: %w", err)
	}

	ds.configureInterfaces()
	if created {
		if err := ds.Save(); err != nil {
			return nil, err
		}
	}
	return ds, nil
}

// GetDeviceData returns the device data as a JSON string
func (ds *DeviceStore) GetDeviceData() (string, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	if ds.deleted {
		return "", store.ErrDeviceDeleted
	}
	data, err := ds.marshalDeviceDataLocked()
	return string(data), err
}

func (ds *DeviceStore) marshalDeviceDataLocked() ([]byte, error) {
	if ds.Device == nil || ds.Device.NoiseKey == nil || ds.Device.IdentityKey == nil || ds.Device.SignedPreKey == nil || ds.Device.SignedPreKey.Signature == nil {
		return nil, errors.New("device store contains incomplete key material")
	}
	var encodedAccount string
	if ds.Device.Account != nil {
		accountData, err := proto.Marshal(ds.Device.Account)
		if err != nil {
			return nil, fmt.Errorf("encode account: %w", err)
		}
		encodedAccount = base64.StdEncoding.EncodeToString(accountData)
	}
	deviceJSON := DeviceJSON{
		NoiseKeyPriv:     base64.StdEncoding.EncodeToString(ds.Device.NoiseKey.Priv[:]),
		IdentityKeyPriv:  base64.StdEncoding.EncodeToString(ds.Device.IdentityKey.Priv[:]),
		SignedPreKeyPriv: base64.StdEncoding.EncodeToString(ds.Device.SignedPreKey.Priv[:]),
		SignedPreKeyID:   ds.Device.SignedPreKey.KeyID,
		SignedPreKeySig:  base64.StdEncoding.EncodeToString(ds.Device.SignedPreKey.Signature[:]),
		RegistrationID:   ds.Device.RegistrationID,
		AdvSecretKey:     base64.StdEncoding.EncodeToString(ds.Device.AdvSecretKey),
		FacebookUUID:     ds.Device.FacebookUUID.String(),
		LIDMigrationTS:   ds.Device.LIDMigrationTimestamp,
		PushName:         ds.Device.PushName,
		BusinessName:     ds.Device.BusinessName,
		Platform:         ds.Device.Platform,
		Account:          encodedAccount,
		NextPreKeyID:     ds.nextPreKeyID,
		Identities:       make(map[string]string),
		Sessions:         make(map[string]string),
		PreKeys:          make(map[string]string),
		UploadedPreKeys:  make([]uint32, 0, len(ds.uploadedKeys)),
		SenderKeys:       make(map[string]string),
	}

	if ds.Device.ID != nil {
		deviceJSON.JIDUser = ds.Device.ID.User
		deviceJSON.JIDDevice = ds.Device.ID.Device
	}
	if !ds.Device.LID.IsEmpty() {
		deviceJSON.LID = ds.Device.LID.String()
	}

	// Save identities
	for k, v := range ds.identities {
		deviceJSON.Identities[k] = base64.StdEncoding.EncodeToString(v[:])
	}

	// Save sessions
	for k, v := range ds.sessions {
		deviceJSON.Sessions[k] = base64.StdEncoding.EncodeToString(v)
	}

	// Save pre-keys
	for id, pk := range ds.preKeys {
		deviceJSON.PreKeys[fmt.Sprintf("%d", id)] = base64.StdEncoding.EncodeToString(pk.Priv[:])
	}
	for id := range ds.uploadedKeys {
		if _, exists := ds.preKeys[id]; exists {
			deviceJSON.UploadedPreKeys = append(deviceJSON.UploadedPreKeys, id)
		}
	}
	sort.Slice(deviceJSON.UploadedPreKeys, func(i, j int) bool {
		return deviceJSON.UploadedPreKeys[i] < deviceJSON.UploadedPreKeys[j]
	})

	// Save sender keys
	for k, v := range ds.senderKeys {
		deviceJSON.SenderKeys[k] = base64.StdEncoding.EncodeToString(v)
	}

	return json.MarshalIndent(deviceJSON, "", "  ")
}

type mutableDeviceStoreState struct {
	identities   map[string][32]byte
	sessions     map[string][]byte
	preKeys      map[uint32]*keys.PreKey
	uploadedKeys map[uint32]struct{}
	senderKeys   map[string][]byte
	nextPreKeyID uint32
}

func (ds *DeviceStore) captureMutableStateLocked() mutableDeviceStoreState {
	state := mutableDeviceStoreState{
		identities:   make(map[string][32]byte, len(ds.identities)),
		sessions:     make(map[string][]byte, len(ds.sessions)),
		preKeys:      make(map[uint32]*keys.PreKey, len(ds.preKeys)),
		uploadedKeys: make(map[uint32]struct{}, len(ds.uploadedKeys)),
		senderKeys:   make(map[string][]byte, len(ds.senderKeys)),
		nextPreKeyID: ds.nextPreKeyID,
	}
	for address, identity := range ds.identities {
		state.identities[address] = identity
	}
	for address, session := range ds.sessions {
		state.sessions[address] = session
	}
	for id, preKey := range ds.preKeys {
		state.preKeys[id] = preKey
	}
	for id := range ds.uploadedKeys {
		state.uploadedKeys[id] = struct{}{}
	}
	for key, senderKey := range ds.senderKeys {
		state.senderKeys[key] = senderKey
	}
	return state
}

func (ds *DeviceStore) restoreMutableStateLocked(state mutableDeviceStoreState) {
	ds.identities = state.identities
	ds.sessions = state.sessions
	ds.preKeys = state.preKeys
	ds.uploadedKeys = state.uploadedKeys
	ds.senderKeys = state.senderKeys
	ds.nextPreKeyID = state.nextPreKeyID
}

func (ds *DeviceStore) mutateAndSave(ctx context.Context, mutate func()) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	ds.saveMu.Lock()
	defer ds.saveMu.Unlock()
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	ds.mu.Lock()
	if ds.deleted {
		ds.mu.Unlock()
		return store.ErrDeviceDeleted
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			ds.mu.Unlock()
			return err
		}
	}
	previousState := ds.captureMutableStateLocked()
	mutate()
	path := ds.path
	dataChanges := ds.dataChanges
	if path == "" && dataChanges == nil {
		ds.mu.Unlock()
		return nil
	}
	data, err := ds.marshalDeviceDataLocked()
	if err != nil {
		ds.restoreMutableStateLocked(previousState)
		ds.mu.Unlock()
		return err
	}
	err = persistDeviceSnapshot(path, dataChanges, data)
	if err != nil {
		ds.restoreMutableStateLocked(previousState)
	}
	ds.mu.Unlock()
	return err
}

// Save serializes persistence so an older snapshot can never overwrite a
// newer mutation. Memory-only stores remain a no-op when no callback is set.
func (ds *DeviceStore) Save() error {
	ds.saveMu.Lock()
	defer ds.saveMu.Unlock()

	ds.mu.RLock()
	if ds.deleted {
		ds.mu.RUnlock()
		return store.ErrDeviceDeleted
	}
	path := ds.path
	dataChanges := ds.dataChanges
	if path == "" && dataChanges == nil {
		ds.mu.RUnlock()
		return nil
	}
	data, err := ds.marshalDeviceDataLocked()
	ds.mu.RUnlock()
	if err != nil {
		return err
	}
	return persistDeviceSnapshot(path, dataChanges, data)
}

func persistDeviceSnapshot(path string, dataChanges *deviceDataDispatcher, data []byte) error {
	if path == "" {
		if dataChanges != nil {
			return dataChanges.enqueue(string(data))
		}
		return nil
	}
	return atomicWriteFile(path, data, 0600)
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temporaryFile, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary device store: %w", err)
	}
	temporaryPath := temporaryFile.Name()
	closed := false
	defer func() {
		if !closed {
			_ = temporaryFile.Close()
		}
		if temporaryPath != "" {
			_ = os.Remove(temporaryPath)
		}
	}()

	if err := temporaryFile.Chmod(mode); err != nil {
		return fmt.Errorf("set temporary device store permissions: %w", err)
	}
	if written, err := temporaryFile.Write(data); err != nil {
		return fmt.Errorf("write temporary device store: %w", err)
	} else if written != len(data) {
		return io.ErrShortWrite
	}
	if err := temporaryFile.Sync(); err != nil {
		return fmt.Errorf("sync temporary device store: %w", err)
	}
	if err := temporaryFile.Close(); err != nil {
		return fmt.Errorf("close temporary device store: %w", err)
	}
	closed = true

	if err := replaceDeviceStoreFile(temporaryPath, path); err != nil {
		return fmt.Errorf("replace device store: %w", err)
	}
	temporaryPath = ""
	return syncDeviceStoreDirectory(directory)
}

func replaceDeviceStoreFile(temporaryPath, destinationPath string) error {
	const maxAttempts = 20
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		err = os.Rename(temporaryPath, destinationPath)
		if err == nil {
			return nil
		}
		if runtime.GOOS != "windows" || !isWindowsFileBusyError(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * time.Millisecond)
	}
	return err
}

func isWindowsFileBusyError(err error) bool {
	// ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, and ERROR_LOCK_VIOLATION
	// are transient when another process has the destination open without
	// FILE_SHARE_DELETE. Retrying preserves same-directory atomic replacement.
	return errors.Is(err, syscall.Errno(5)) ||
		errors.Is(err, syscall.Errno(32)) ||
		errors.Is(err, syscall.Errno(33))
}

func syncDeviceStoreDirectory(directory string) error {
	if runtime.GOOS == "windows" {
		return nil
	}

	directoryHandle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open device store directory for sync: %w", err)
	}
	defer directoryHandle.Close()
	if err := directoryHandle.Sync(); err != nil {
		return fmt.Errorf("sync device store directory: %w", err)
	}
	return nil
}

func (ds *DeviceStore) deletePersistedDevice(ctx context.Context, device *store.Device) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	ds.saveMu.Lock()
	defer ds.saveMu.Unlock()
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}

	ds.mu.RLock()
	if device != ds.Device {
		ds.mu.RUnlock()
		return errors.New("cannot delete a device owned by another store")
	}
	if ds.deleted {
		ds.mu.RUnlock()
		return nil
	}
	path := ds.path
	dataChanges := ds.dataChanges
	ds.mu.RUnlock()

	if path != "" {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove device store: %w", err)
		}
		if err := syncDeviceStoreDirectory(filepath.Dir(path)); err != nil {
			return err
		}
	} else if dataChanges != nil {
		if err := dataChanges.enqueue(""); err != nil {
			return err
		}
	}

	ds.mu.Lock()
	ds.deleted = true
	clear(ds.identities)
	clear(ds.sessions)
	clear(ds.preKeys)
	clear(ds.uploadedKeys)
	clear(ds.senderKeys)
	ds.nextPreKeyID = 1
	ds.mu.Unlock()
	return nil
}

// NewDeviceStoreFromData creates a device store from JSON data string (no file I/O)
func NewDeviceStoreFromData(dataStr string) (*DeviceStore, error) {
	ds := newEmptyDeviceStore("")
	var deviceJSON DeviceJSON
	if err := json.Unmarshal([]byte(dataStr), &deviceJSON); err != nil {
		return nil, fmt.Errorf("decode device data: %w", err)
	}
	if err := ds.loadDeviceJSON(&deviceJSON); err != nil {
		return nil, fmt.Errorf("load device data: %w", err)
	}
	ds.configureInterfaces()
	return ds, nil
}

// NewDeviceStoreMemoryOnly creates a new device store that only lives in memory
// No file saving, no events emitted - state is lost when client disconnects
func NewDeviceStoreMemoryOnly() (*DeviceStore, error) {
	return newDeviceStoreMemoryOnly(cryptorand.Reader)
}

func newDeviceStoreMemoryOnly(randomReader io.Reader) (*DeviceStore, error) {
	ds := newEmptyDeviceStore("")
	device, err := newE2EEDevice(randomReader)
	if err != nil {
		return nil, err
	}
	ds.Device = device
	ds.configureInterfaces()
	return ds, nil
}

// GetCookies returns the current cookies from the messagix client
func (c *Client) GetCookies() map[string]string {
	if c.Messagix == nil {
		return nil
	}
	cks := c.Messagix.GetCookies()
	if cks == nil {
		return nil
	}
	result := make(map[string]string)
	for k, v := range cks.GetAll() {
		result[string(k)] = v
	}
	return result
}

// PushKeys holds the web push notification keys
type PushKeys struct {
	P256DH []byte `json:"p256dh"`
	Auth   []byte `json:"auth"`
}

// RegisterPushNotificationsOptions holds options for push notification registration
type RegisterPushNotificationsOptions struct {
	Endpoint string `json:"endpoint"`
	P256DH   string `json:"p256dh"` // base64 encoded
	Auth     string `json:"auth"`   // base64 encoded
}

// RegisterPushNotifications registers web push notification endpoint
func (c *Client) RegisterPushNotifications(ctx context.Context, opts *RegisterPushNotificationsOptions) error {
	if c.Messagix == nil {
		return fmt.Errorf("client not connected")
	}

	// Decode base64 keys
	p256dh, err := base64.RawURLEncoding.DecodeString(opts.P256DH)
	if err != nil {
		return fmt.Errorf("invalid p256dh key: %w", err)
	}
	auth, err := base64.RawURLEncoding.DecodeString(opts.Auth)
	if err != nil {
		return fmt.Errorf("invalid auth key: %w", err)
	}

	return c.Messagix.Facebook.RegisterPushNotifications(ctx, opts.Endpoint, messagix.PushKeys{
		P256DH: p256dh,
		Auth:   auth,
	})
}

// Helper to convert thread
func convertThread(t *table.LSDeleteThenInsertThread) *Thread {
	return &Thread{
		ID:                      t.ThreadKey,
		Type:                    int(t.ThreadType),
		Name:                    t.ThreadName,
		LastActivityTimestampMs: t.LastActivityTimestampMs,
		Snippet:                 t.Snippet,
	}
}

// Helper to convert message from LSUpsertMessage
func convertMessage(m *table.LSUpsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}

// Helper to convert message from LSInsertMessage
func convertInsertMessage(m *table.LSInsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}

// Helper to convert message from LSDeleteThenInsertMessage
func convertDeleteThenInsertMessage(m *table.LSDeleteThenInsertMessage) *Message {
	return &Message{
		ID:          m.MessageId,
		ThreadID:    m.ThreadKey,
		SenderID:    m.SenderId,
		Text:        m.Text,
		TimestampMs: m.TimestampMs,
	}
}
