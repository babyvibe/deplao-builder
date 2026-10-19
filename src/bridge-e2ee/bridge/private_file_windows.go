//go:build windows

package bridge

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// protectPrivateFile replaces inherited permissions with a protected DACL that
// grants full control only to the file owner and LocalSystem. Windows ignores
// Unix-style mode bits for access control, so os.Chmod alone is insufficient.
func protectPrivateFile(path string, _ os.FileMode) error {
	descriptor, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION,
	)
	if err != nil {
		return fmt.Errorf("read owner: %w", err)
	}
	if descriptor == nil {
		return fmt.Errorf("read owner: empty security descriptor")
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return fmt.Errorf("read owner SID: %w", err)
	}
	if owner == nil {
		return fmt.Errorf("read owner SID: owner is missing")
	}

	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fmt.Errorf("read process user: %w", err)
	}
	if user == nil || user.User.Sid == nil {
		return fmt.Errorf("read process user: user SID is missing")
	}

	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return fmt.Errorf("create LocalSystem SID: %w", err)
	}

	entries := []windows.EXPLICIT_ACCESS{fullControlEntry(user.User.Sid, windows.TRUSTEE_IS_USER)}
	if !user.User.Sid.Equals(system) {
		entries = append(entries, fullControlEntry(system, windows.TRUSTEE_IS_WELL_KNOWN_GROUP))
	}
	acl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return fmt.Errorf("build private DACL: %w", err)
	}
	securityInformation := windows.SECURITY_INFORMATION(
		windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION,
	)
	var replacementOwner *windows.SID
	if !owner.Equals(user.User.Sid) {
		securityInformation |= windows.OWNER_SECURITY_INFORMATION
		replacementOwner = user.User.Sid
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		securityInformation,
		replacementOwner,
		nil,
		acl,
		nil,
	); err != nil {
		return fmt.Errorf("apply private DACL: %w", err)
	}
	return nil
}

func fullControlEntry(sid *windows.SID, trusteeType windows.TRUSTEE_TYPE) windows.EXPLICIT_ACCESS {
	return windows.EXPLICIT_ACCESS{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.SET_ACCESS,
		Inheritance:       windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  trusteeType,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}
}

// createPrivateTempFile applies the private security descriptor as part of
// CREATE_NEW. This avoids a window where another account could open the empty
// temp file before its ACL is restricted and keep that handle through writes.
func createPrivateTempFile(directory, pattern string, _ os.FileMode) (*os.File, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("read process user: %w", err)
	}
	if user == nil || user.User.Sid == nil {
		return nil, fmt.Errorf("read process user: user SID is missing")
	}

	ownerSID := user.User.Sid.String()
	sddl := "O:" + ownerSID + "D:P(A;;FA;;;" + ownerSID + ")"
	if !user.User.Sid.IsWellKnown(windows.WinLocalSystemSid) {
		sddl += "(A;;FA;;;SY)"
	}
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, fmt.Errorf("build private security descriptor: %w", err)
	}
	securityAttributes := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: descriptor,
	}

	wildcard := strings.LastIndex(pattern, "*")
	prefix := pattern
	suffixPattern := ""
	if wildcard >= 0 {
		prefix = pattern[:wildcard]
		suffixPattern = pattern[wildcard+1:]
	}
	for attempt := 0; attempt < 100; attempt++ {
		suffix := make([]byte, 16)
		if _, err := rand.Read(suffix); err != nil {
			return nil, fmt.Errorf("generate temporary file name: %w", err)
		}
		path := filepath.Join(directory, prefix+hex.EncodeToString(suffix)+suffixPattern)
		pathUTF16, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return nil, fmt.Errorf("encode temporary file path: %w", err)
		}
		handle, err := windows.CreateFile(
			pathUTF16,
			windows.GENERIC_READ|windows.GENERIC_WRITE,
			0,
			&securityAttributes,
			windows.CREATE_NEW,
			windows.FILE_ATTRIBUTE_NORMAL,
			0,
		)
		if errors.Is(err, windows.ERROR_FILE_EXISTS) || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			continue
		}
		if err != nil {
			return nil, err
		}
		file := os.NewFile(uintptr(handle), path)
		if file == nil {
			_ = windows.CloseHandle(handle)
			_ = os.Remove(path)
			return nil, fmt.Errorf("wrap temporary file handle")
		}
		return file, nil
	}
	return nil, fmt.Errorf("create unique temporary file after 100 attempts")
}
