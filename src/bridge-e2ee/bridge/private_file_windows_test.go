//go:build windows

package bridge

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestCreatePrivateTempFileUsesOwnerAndSystemOnly(t *testing.T) {
	file, err := createPrivateTempFile(t.TempDir(), "private-device-*.json", 0600)
	if err != nil {
		t.Fatalf("createPrivateTempFile() error = %v", err)
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	assertPrivateWindowsACL(t, path)
}

func TestE2EEMediaTempFileIsPrivateBeforePlaintextWrite(t *testing.T) {
	file, err := createE2EEMediaTempFile(16)
	if err != nil {
		t.Fatalf("createE2EEMediaTempFile() error = %v", err)
	}
	t.Cleanup(func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	})
	descriptor, err := windows.GetSecurityInfo(
		windows.Handle(file.Fd()),
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		t.Fatalf("GetSecurityInfo() error = %v", err)
	}
	assertPrivateWindowsSecurityDescriptor(t, file.Name(), descriptor)
	if _, err := file.Write([]byte("plaintext")); err != nil {
		t.Fatalf("private media Write() error = %v", err)
	}
}

func TestDeviceStoreProtectsExistingAndAtomicallyReplacedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	assertPrivateWindowsACL(t, path)

	world, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(WinWorldSid) error = %v", err)
	}
	permissiveACL, err := windows.ACLFromEntries(
		[]windows.EXPLICIT_ACCESS{fullControlEntry(world, windows.TRUSTEE_IS_WELL_KNOWN_GROUP)},
		nil,
	)
	if err != nil {
		t.Fatalf("ACLFromEntries() error = %v", err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		permissiveACL,
		nil,
	); err != nil {
		t.Fatalf("make test file permissive: %v", err)
	}

	ds, err = NewDeviceStore(path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	assertPrivateWindowsACL(t, path)

	if err := ds.PutSession(context.Background(), "123:1", []byte("session")); err != nil {
		t.Fatalf("PutSession() error = %v", err)
	}
	assertPrivateWindowsACL(t, path)
}

func assertPrivateWindowsACL(t *testing.T, path string) {
	t.Helper()
	descriptor, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo(%q) error = %v", path, err)
	}
	assertPrivateWindowsSecurityDescriptor(t, path, descriptor)
}

func assertPrivateWindowsSecurityDescriptor(t *testing.T, path string, descriptor *windows.SECURITY_DESCRIPTOR) {
	t.Helper()
	control, _, err := descriptor.Control()
	if err != nil {
		t.Fatalf("Control(%q) error = %v", path, err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("DACL for %q is not protected: control=%#x", path, control)
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		t.Fatalf("Owner(%q) error = %v", path, err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatalf("GetTokenUser() error = %v", err)
	}
	if !owner.Equals(user.User.Sid) {
		t.Fatalf("owner for %q = %s, want process user %s", path, owner.String(), user.User.Sid.String())
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(WinLocalSystemSid) error = %v", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatalf("DACL(%q) error = %v", path, err)
	}
	if dacl == nil {
		t.Fatalf("DACL for %q is nil", path)
	}
	expectedCount := uint16(2)
	if owner.Equals(system) {
		expectedCount = 1
	}
	if dacl.AceCount != expectedCount {
		t.Fatalf("DACL for %q has %d ACEs, want %d", path, dacl.AceCount, expectedCount)
	}

	seenOwner := false
	seenSystem := false
	for index := uint16(0); index < dacl.AceCount; index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(index), &ace); err != nil {
			t.Fatalf("GetAce(%d) error = %v", index, err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("ACE %d type = %d, want ACCESS_ALLOWED_ACE_TYPE", index, ace.Header.AceType)
		}
		const fileAllAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff
		if ace.Mask&fileAllAccess != fileAllAccess {
			t.Fatalf("ACE %d mask = %#x, want FILE_ALL_ACCESS", index, ace.Mask)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		switch {
		case owner.Equals(sid):
			seenOwner = true
		case system.Equals(sid):
			seenSystem = true
		default:
			t.Fatalf("DACL for %q contains unexpected SID %s", path, sid.String())
		}
	}
	if !seenOwner {
		t.Fatalf("DACL for %q does not grant its owner access", path)
	}
	if !owner.Equals(system) && !seenSystem {
		t.Fatalf("DACL for %q does not grant LocalSystem access", path)
	}
}
