package bridge

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/store"
	waTypes "go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
)

// Implement all the store interfaces for DeviceStore

var ErrUnsupportedStoreOperation = errors.New("device store operation is unsupported")

var _ store.AllStores = (*DeviceStore)(nil)
var _ store.DeviceContainer = (*DeviceStore)(nil)

func unsupportedStoreOperation(ctx context.Context, operation string) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return fmt.Errorf("%w: %s", ErrUnsupportedStoreOperation, operation)
}

func cloneBytes(value []byte) []byte {
	return append([]byte(nil), value...)
}

func signalAddressHasPhone(address, phone string) bool {
	return strings.HasPrefix(address, phone+":")
}

func (ds *DeviceStore) PutIdentity(ctx context.Context, address string, key [32]byte) error {
	return ds.mutateAndSave(ctx, func() {
		ds.identities[address] = key
	})
}

func (ds *DeviceStore) DeleteAllIdentities(ctx context.Context, phone string) error {
	return ds.mutateAndSave(ctx, func() {
		for address := range ds.identities {
			if signalAddressHasPhone(address, phone) {
				delete(ds.identities, address)
			}
		}
	})
}

func (ds *DeviceStore) DeleteIdentity(ctx context.Context, address string) error {
	return ds.mutateAndSave(ctx, func() {
		delete(ds.identities, address)
	})
}

func (ds *DeviceStore) IsTrustedIdentity(ctx context.Context, address string, key [32]byte) (bool, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	existing, ok := ds.identities[address]
	if !ok {
		return true, nil
	}
	return existing == key, nil
}

func (ds *DeviceStore) GetSession(ctx context.Context, address string) ([]byte, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return cloneBytes(ds.sessions[address]), nil
}

func (ds *DeviceStore) HasSession(ctx context.Context, address string) (bool, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	_, ok := ds.sessions[address]
	return ok, nil
}

func (ds *DeviceStore) GetManySessions(ctx context.Context, addresses []string) (map[string][]byte, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	result := make(map[string][]byte, len(addresses))
	for _, addr := range addresses {
		// whatsmeow distinguishes a requested device with a nil session from a
		// device omitted from the result. Keep missing addresses so proactive
		// sends trigger pre-key fetch instead of failing with no Signal session.
		result[addr] = cloneBytes(ds.sessions[addr])
	}
	return result, nil
}

func (ds *DeviceStore) PutSession(ctx context.Context, address string, session []byte) error {
	return ds.mutateAndSave(ctx, func() {
		ds.sessions[address] = cloneBytes(session)
	})
}

func (ds *DeviceStore) PutManySessions(ctx context.Context, sessions map[string][]byte) error {
	return ds.mutateAndSave(ctx, func() {
		for addr, sess := range sessions {
			ds.sessions[addr] = cloneBytes(sess)
		}
	})
}

func (ds *DeviceStore) DeleteAllSessions(ctx context.Context, phone string) error {
	return ds.mutateAndSave(ctx, func() {
		for address := range ds.sessions {
			if signalAddressHasPhone(address, phone) {
				delete(ds.sessions, address)
			}
		}
	})
}

func (ds *DeviceStore) DeleteSession(ctx context.Context, address string) error {
	return ds.mutateAndSave(ctx, func() {
		delete(ds.sessions, address)
	})
}

func (ds *DeviceStore) MigratePNToLID(ctx context.Context, pn, lid waTypes.JID) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	pnSignal := pn.SignalAddressUser()
	lidSignal := lid.SignalAddressUser()
	if pnSignal == "" || lidSignal == "" {
		return errors.New("cannot migrate empty PN or LID signal address")
	}
	if pnSignal == lidSignal {
		return nil
	}

	return ds.mutateAndSave(ctx, func() {
		for address, session := range ds.sessions {
			if signalAddressHasPhone(address, pnSignal) {
				newAddress := lidSignal + strings.TrimPrefix(address, pnSignal)
				ds.sessions[newAddress] = session
				delete(ds.sessions, address)
			}
		}
		for address, identity := range ds.identities {
			if signalAddressHasPhone(address, pnSignal) {
				newAddress := lidSignal + strings.TrimPrefix(address, pnSignal)
				ds.identities[newAddress] = identity
				delete(ds.identities, address)
			}
		}
		oldSenderFragment := ":" + pnSignal + ":"
		newSenderFragment := ":" + lidSignal + ":"
		type senderKeyMigration struct {
			oldKey string
			newKey string
			value  []byte
		}
		senderKeyMigrations := make([]senderKeyMigration, 0)
		for storageKey, senderKey := range ds.senderKeys {
			if fragmentIndex := strings.LastIndex(storageKey, oldSenderFragment); fragmentIndex >= 0 &&
				!strings.Contains(storageKey[fragmentIndex+len(oldSenderFragment):], ":") {
				newStorageKey := storageKey[:fragmentIndex] + newSenderFragment + storageKey[fragmentIndex+len(oldSenderFragment):]
				senderKeyMigrations = append(senderKeyMigrations, senderKeyMigration{
					oldKey: storageKey,
					newKey: newStorageKey,
					value:  senderKey,
				})
			}
		}
		for _, migration := range senderKeyMigrations {
			delete(ds.senderKeys, migration.oldKey)
		}
		for _, migration := range senderKeyMigrations {
			ds.senderKeys[migration.newKey] = migration.value
		}
	})
}

func (ds *DeviceStore) GetOrGenPreKeys(ctx context.Context, count uint32) ([]*keys.PreKey, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	if count == 0 {
		return []*keys.PreKey{}, nil
	}
	result := make([]*keys.PreKey, 0, count)
	err := ds.mutateAndSave(ctx, func() {
		unuploadedIDs := make([]uint32, 0, len(ds.preKeys))
		for id := range ds.preKeys {
			if _, uploaded := ds.uploadedKeys[id]; !uploaded {
				unuploadedIDs = append(unuploadedIDs, id)
			}
		}
		sort.Slice(unuploadedIDs, func(i, j int) bool { return unuploadedIDs[i] < unuploadedIDs[j] })
		for _, id := range unuploadedIDs {
			if uint32(len(result)) == count {
				break
			}
			result = append(result, ds.preKeys[id])
		}
		for uint32(len(result)) < count {
			preKey := keys.NewPreKey(ds.nextPreKeyID)
			ds.preKeys[ds.nextPreKeyID] = preKey
			result = append(result, preKey)
			ds.nextPreKeyID++
		}
	})
	return result, err
}

func (ds *DeviceStore) GenOnePreKey(ctx context.Context) (*keys.PreKey, error) {
	var preKey *keys.PreKey
	err := ds.mutateAndSave(ctx, func() {
		preKey = keys.NewPreKey(ds.nextPreKeyID)
		ds.preKeys[ds.nextPreKeyID] = preKey
		ds.uploadedKeys[ds.nextPreKeyID] = struct{}{}
		ds.nextPreKeyID++
	})
	return preKey, err
}

func (ds *DeviceStore) GetPreKey(ctx context.Context, id uint32) (*keys.PreKey, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.preKeys[id], nil
}

func (ds *DeviceStore) RemovePreKey(ctx context.Context, id uint32) error {
	return ds.mutateAndSave(ctx, func() {
		delete(ds.preKeys, id)
		delete(ds.uploadedKeys, id)
	})
}

func (ds *DeviceStore) MarkPreKeysAsUploaded(ctx context.Context, upToID uint32) error {
	return ds.mutateAndSave(ctx, func() {
		for id := range ds.preKeys {
			if id <= upToID {
				ds.uploadedKeys[id] = struct{}{}
			}
		}
	})
}

func (ds *DeviceStore) UploadedPreKeyCount(ctx context.Context) (int, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
	}
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return len(ds.uploadedKeys), nil
}

func (ds *DeviceStore) PutSenderKey(ctx context.Context, group, user string, session []byte) error {
	return ds.mutateAndSave(ctx, func() {
		ds.senderKeys[group+":"+user] = cloneBytes(session)
	})
}

func (ds *DeviceStore) GetSenderKey(ctx context.Context, group, user string) ([]byte, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return cloneBytes(ds.senderKeys[group+":"+user]), nil
}

func (ds *DeviceStore) PutDevice(ctx context.Context, device *store.Device) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if device != ds.Device {
		return errors.New("cannot persist a device owned by another store")
	}
	return ds.Save()
}

func (ds *DeviceStore) DeleteDevice(ctx context.Context, device *store.Device) error {
	return ds.deletePersistedDevice(ctx, device)
}

// Unsupported implementations for unrelated store interfaces return an
// explicit error instead of pretending that state was persisted.
func (ds *DeviceStore) PutAppStateSyncKey(ctx context.Context, id []byte, key store.AppStateSyncKey) error {
	return unsupportedStoreOperation(ctx, "PutAppStateSyncKey")
}

func (ds *DeviceStore) GetAppStateSyncKey(ctx context.Context, id []byte) (*store.AppStateSyncKey, error) {
	return nil, unsupportedStoreOperation(ctx, "GetAppStateSyncKey")
}

func (ds *DeviceStore) GetLatestAppStateSyncKeyID(ctx context.Context) ([]byte, error) {
	return nil, unsupportedStoreOperation(ctx, "GetLatestAppStateSyncKeyID")
}

func (ds *DeviceStore) GetAllAppStateSyncKeys(ctx context.Context) ([]*store.AppStateSyncKey, error) {
	return nil, unsupportedStoreOperation(ctx, "GetAllAppStateSyncKeys")
}

func (ds *DeviceStore) PutAppStateVersion(ctx context.Context, name string, version uint64, hash [128]byte) error {
	return unsupportedStoreOperation(ctx, "PutAppStateVersion")
}

func (ds *DeviceStore) GetAppStateVersion(ctx context.Context, name string) (uint64, [128]byte, error) {
	return 0, [128]byte{}, unsupportedStoreOperation(ctx, "GetAppStateVersion")
}

func (ds *DeviceStore) DeleteAppStateVersion(ctx context.Context, name string) error {
	return unsupportedStoreOperation(ctx, "DeleteAppStateVersion")
}

func (ds *DeviceStore) PutAppStateMutationMACs(ctx context.Context, name string, version uint64, mutations []store.AppStateMutationMAC) error {
	return unsupportedStoreOperation(ctx, "PutAppStateMutationMACs")
}

func (ds *DeviceStore) DeleteAppStateMutationMACs(ctx context.Context, name string, indexMACs [][]byte) error {
	return unsupportedStoreOperation(ctx, "DeleteAppStateMutationMACs")
}

func (ds *DeviceStore) GetAppStateMutationMAC(ctx context.Context, name string, indexMAC []byte) (valueMAC []byte, err error) {
	return nil, unsupportedStoreOperation(ctx, "GetAppStateMutationMAC")
}

func (ds *DeviceStore) PutPushName(ctx context.Context, user waTypes.JID, pushName string) (bool, string, error) {
	return false, "", unsupportedStoreOperation(ctx, "PutPushName")
}

func (ds *DeviceStore) PutBusinessName(ctx context.Context, user waTypes.JID, businessName string) (bool, string, error) {
	return false, "", unsupportedStoreOperation(ctx, "PutBusinessName")
}

func (ds *DeviceStore) PutContactName(ctx context.Context, user waTypes.JID, firstName, fullName string) error {
	return unsupportedStoreOperation(ctx, "PutContactName")
}

func (ds *DeviceStore) PutAllContactNames(ctx context.Context, contacts []store.ContactEntry) error {
	return unsupportedStoreOperation(ctx, "PutAllContactNames")
}

func (ds *DeviceStore) PutManyRedactedPhones(ctx context.Context, entries []store.RedactedPhoneEntry) error {
	return unsupportedStoreOperation(ctx, "PutManyRedactedPhones")
}

func (ds *DeviceStore) GetContact(ctx context.Context, user waTypes.JID) (waTypes.ContactInfo, error) {
	return waTypes.ContactInfo{}, unsupportedStoreOperation(ctx, "GetContact")
}

func (ds *DeviceStore) GetAllContacts(ctx context.Context) (map[waTypes.JID]waTypes.ContactInfo, error) {
	return nil, unsupportedStoreOperation(ctx, "GetAllContacts")
}

func (ds *DeviceStore) PutMutedUntil(ctx context.Context, chat waTypes.JID, mutedUntil time.Time) error {
	return unsupportedStoreOperation(ctx, "PutMutedUntil")
}

func (ds *DeviceStore) PutPinned(ctx context.Context, chat waTypes.JID, pinned bool) error {
	return unsupportedStoreOperation(ctx, "PutPinned")
}

func (ds *DeviceStore) PutArchived(ctx context.Context, chat waTypes.JID, archived bool) error {
	return unsupportedStoreOperation(ctx, "PutArchived")
}

func (ds *DeviceStore) GetChatSettings(ctx context.Context, chat waTypes.JID) (waTypes.LocalChatSettings, error) {
	return waTypes.LocalChatSettings{}, unsupportedStoreOperation(ctx, "GetChatSettings")
}

func (ds *DeviceStore) PutMessageSecrets(ctx context.Context, inserts []store.MessageSecretInsert) error {
	return unsupportedStoreOperation(ctx, "PutMessageSecrets")
}

func (ds *DeviceStore) PutMessageSecret(ctx context.Context, chat, sender waTypes.JID, id waTypes.MessageID, secret []byte) error {
	return unsupportedStoreOperation(ctx, "PutMessageSecret")
}

func (ds *DeviceStore) GetMessageSecret(ctx context.Context, chat, sender waTypes.JID, id waTypes.MessageID) ([]byte, waTypes.JID, error) {
	return nil, waTypes.JID{}, unsupportedStoreOperation(ctx, "GetMessageSecret")
}

func (ds *DeviceStore) PutPrivacyTokens(ctx context.Context, tokens ...store.PrivacyToken) error {
	return unsupportedStoreOperation(ctx, "PutPrivacyTokens")
}

func (ds *DeviceStore) GetPrivacyToken(ctx context.Context, user waTypes.JID) (*store.PrivacyToken, error) {
	return nil, unsupportedStoreOperation(ctx, "GetPrivacyToken")
}

func (ds *DeviceStore) PutLIDMapping(ctx context.Context, lid, pn waTypes.JID) error {
	return unsupportedStoreOperation(ctx, "PutLIDMapping")
}

func (ds *DeviceStore) PutManyLIDMappings(ctx context.Context, mappings []store.LIDMapping) error {
	return unsupportedStoreOperation(ctx, "PutManyLIDMappings")
}

func (ds *DeviceStore) GetPNForLID(ctx context.Context, lid waTypes.JID) (waTypes.JID, error) {
	return waTypes.JID{}, unsupportedStoreOperation(ctx, "GetPNForLID")
}

func (ds *DeviceStore) GetLIDForPN(ctx context.Context, pn waTypes.JID) (waTypes.JID, error) {
	return waTypes.JID{}, unsupportedStoreOperation(ctx, "GetLIDForPN")
}

func (ds *DeviceStore) GetManyLIDsForPNs(ctx context.Context, pns []waTypes.JID) (map[waTypes.JID]waTypes.JID, error) {
	return nil, unsupportedStoreOperation(ctx, "GetManyLIDsForPNs")
}

// The event buffer is intentionally stateless. These methods mirror
// whatsmeow's NoopStore semantics: buffering is an optional retry optimization,
// not durable cryptographic/session state.
func (ds *DeviceStore) GetBufferedEvent(ctx context.Context, ciphertextHash [32]byte) (*store.BufferedEvent, error) {
	return nil, nil
}

func (ds *DeviceStore) PutBufferedEvent(ctx context.Context, ciphertextHash [32]byte, plaintext []byte, serverTimestamp time.Time) error {
	return nil
}

func (ds *DeviceStore) DoDecryptionTxn(ctx context.Context, fn func(context.Context) error) error {
	return fn(ctx)
}

func (ds *DeviceStore) ClearBufferedEventPlaintext(ctx context.Context, ciphertextHash [32]byte) error {
	return nil
}

func (ds *DeviceStore) DeleteOldBufferedHashes(ctx context.Context) error {
	return nil
}

// EventBuffer outgoing-event methods (added in newer whatsmeow). We don't
// persist outgoing events — the bridge is stateless w.r.t. retries.

func (ds *DeviceStore) GetOutgoingEvent(ctx context.Context, chatJID, altChatJID waTypes.JID, id waTypes.MessageID) (string, []byte, error) {
	return "", nil, nil
}

func (ds *DeviceStore) AddOutgoingEvent(ctx context.Context, chatJID waTypes.JID, id waTypes.MessageID, format string, plaintext []byte) error {
	return nil
}

func (ds *DeviceStore) DeleteOldOutgoingEvents(ctx context.Context) error {
	return nil
}
