//go:build !windows

package bridge

import (
	"os"
)

func protectPrivateFile(path string, mode os.FileMode) error {
	return os.Chmod(path, mode)
}

func createPrivateTempFile(directory, pattern string, mode os.FileMode) (*os.File, error) {
	file, err := os.CreateTemp(directory, pattern)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	return file, nil
}
