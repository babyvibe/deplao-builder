package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadAndValidateLocalPath_ValidFile(t *testing.T) {
	// Create a temp file
	dir := t.TempDir()
	path := filepath.Join(dir, "test.bin")
	data := []byte("hello world")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	got, err := readAndValidateLocalPath(path, "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("data mismatch: got %q, want %q", got, data)
	}
}

func TestReadAndValidateLocalPath_EmptyPath(t *testing.T) {
	_, err := readAndValidateLocalPath("", "test")
	if err == nil {
		t.Fatal("expected error for empty path")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected 'empty' in error, got: %v", err)
	}
}

func TestReadAndValidateLocalPath_Directory(t *testing.T) {
	dir := t.TempDir()
	_, err := readAndValidateLocalPath(dir, "test")
	if err == nil {
		t.Fatal("expected error for directory")
	}
	if !strings.Contains(err.Error(), "directory") {
		t.Fatalf("expected 'directory' in error, got: %v", err)
	}
}

func TestReadAndValidateLocalPath_NotFound(t *testing.T) {
	_, err := readAndValidateLocalPath("/nonexistent/file/path.bin", "test")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestReadAndValidateLocalPath_Oversize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	// Write a file that exceeds the limit (25 MiB + 1 byte)
	bigData := make([]byte, maxDecodedMediaBytes+1)
	if err := os.WriteFile(path, bigData, 0600); err != nil {
		t.Fatal(err)
	}

	_, err := readAndValidateLocalPath(path, "test")
	if err == nil {
		t.Fatal("expected error for oversize file")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected 'too large' in error, got: %v", err)
	}
}

func TestReadAndValidateLocalPath_ExactlyAtLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exact.bin")
	data := make([]byte, maxDecodedMediaBytes)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	got, err := readAndValidateLocalPath(path, "test")
	if err != nil {
		t.Fatalf("unexpected error for file at exact limit: %v", err)
	}
	if len(got) != maxDecodedMediaBytes {
		t.Fatalf("expected %d bytes, got %d", maxDecodedMediaBytes, len(got))
	}
}

func TestHelloResponse(t *testing.T) {
	// Verify constants are reasonable
	if protocolVersion != 2 {
		t.Fatalf("expected protocolVersion=2, got %d", protocolVersion)
	}
	if maxDecodedMediaBytes != 25*1024*1024 {
		t.Fatalf("expected maxDecodedMediaBytes=25MiB, got %d", maxDecodedMediaBytes)
	}
	if bridgeVersion == "" {
		t.Fatal("bridgeVersion must not be empty")
	}
}

func TestServeRequestsRejectsOversizedLine(t *testing.T) {
	input := strings.NewReader(strings.Repeat("x", 65) + "\n")

	err := serveRequests(input, 64)

	if err == nil {
		t.Fatal("serveRequests() accepted a request larger than its hard limit")
	}
}

// captureStdout runs fn and returns what it wrote to os.Stdout.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = original }()
	fn()
	writer.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// DEPLAO_ADAPTER: a panic inside one request (seen in the Messenger Lite Bloks
// interpreter) must become an error response instead of killing the bridge.
func TestHandleSafelyTurnsPanicIntoErrorResponse(t *testing.T) {
	originalHandler := handleRequest
	t.Cleanup(func() { handleRequest = originalHandler })
	handleRequest = func(*request) { panic("nil pointer dereference") }

	output := captureStdout(t, func() {
		handleSafely(&request{ID: 7, Method: "syncHistory"})
	})

	var response struct {
		ID    uint64 `json:"id"`
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &response); err != nil {
		t.Fatalf("response is not JSON: %q (%v)", output, err)
	}
	if response.ID != 7 || response.OK || !strings.Contains(response.Error, "syncHistory") {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestServeRequestsKeepsServingAfterPanic(t *testing.T) {
	originalHandler := handleRequest
	t.Cleanup(func() { handleRequest = originalHandler })
	calls := 0
	handleRequest = func(req *request) {
		calls++
		if req.ID == 1 {
			panic("boom")
		}
		ok(req.ID, map[string]interface{}{})
	}

	output := captureStdout(t, func() {
		input := strings.NewReader("{\"id\":1,\"method\":\"hello\"}\n\n{\"id\":2,\"method\":\"hello\"}\n")
		if err := serveRequests(input, 1024); err != nil {
			t.Errorf("serveRequests() error = %v", err)
		}
	})

	if calls != 2 {
		t.Fatalf("handled %d requests, want 2 (blank lines skipped, panic survived)", calls)
	}
	if !strings.Contains(output, "\"id\":2,\"ok\":true") {
		t.Fatalf("second request was not answered: %q", output)
	}
}
