//go:build !windows

package bridge

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDeviceStoreUsesPrivatePOSIXPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")
	ds, err := NewDeviceStore(path)
	if err != nil {
		t.Fatalf("NewDeviceStore() error = %v", err)
	}
	assertPOSIXPermissions(t, path, 0600)

	if err := os.Chmod(path, 0644); err != nil {
		t.Fatalf("Chmod() error = %v", err)
	}
	ds, err = NewDeviceStore(path)
	if err != nil {
		t.Fatalf("reload NewDeviceStore() error = %v", err)
	}
	assertPOSIXPermissions(t, path, 0600)

	if err := ds.PutSession(context.Background(), "123:1", []byte("session")); err != nil {
		t.Fatalf("PutSession() error = %v", err)
	}
	assertPOSIXPermissions(t, path, 0600)
}

func TestE2EEMediaTempFileUsesPrivatePOSIXPermissions(t *testing.T) {
	file, err := createE2EEMediaTempFile(16)
	if err != nil {
		t.Fatalf("createE2EEMediaTempFile() error = %v", err)
	}
	t.Cleanup(func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	})
	assertPOSIXPermissions(t, file.Name(), 0600)
	if _, err := file.Write([]byte("plaintext")); err != nil {
		t.Fatalf("private media Write() error = %v", err)
	}
}

func assertPOSIXPermissions(t *testing.T, path string, expected os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat(%q) error = %v", path, err)
	}
	if actual := info.Mode().Perm(); actual != expected {
		t.Fatalf("permissions for %q = %04o, want %04o", path, actual, expected)
	}
}
