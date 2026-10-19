package bridge

import (
	"encoding/base64"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestValidateMediaURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "facebook CDN", url: "https://scontent.fsgn5-1.fna.fbcdn.net/file.jpg"},
		{name: "lookaside", url: "https://lookaside.fbsbx.com/file"},
		{name: "reject HTTP", url: "http://scontent.fbcdn.net/file", wantErr: true},
		{name: "reject private host", url: "https://127.0.0.1/admin", wantErr: true},
		{name: "reject suffix trick", url: "https://evilfbcdn.net/file", wantErr: true},
		{name: "reject user info", url: "https://user@facebook.com/file", wantErr: true},
		{name: "reject custom port", url: "https://facebook.com:8443/file", wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateMediaURL(test.url)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateMediaURL(%q) error = %v, wantErr = %v", test.url, err, test.wantErr)
			}
		})
	}
}

func TestValidateDownloadE2EEMediaOptionsEnforcesDeclaredSize(t *testing.T) {
	tests := []struct {
		name    string
		opts    *DownloadE2EEMediaOptions
		wantErr bool
	}{
		{name: "unknown size remains bounded by downloader", opts: &DownloadE2EEMediaOptions{}},
		{name: "maximum size", opts: &DownloadE2EEMediaOptions{FileSize: maxDownloadedMediaSize}},
		{name: "missing options", wantErr: true},
		{name: "negative size", opts: &DownloadE2EEMediaOptions{FileSize: -1}, wantErr: true},
		{name: "over limit", opts: &DownloadE2EEMediaOptions{FileSize: maxDownloadedMediaSize + 1}, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateDownloadE2EEMediaOptions(test.opts)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateDownloadE2EEMediaOptions() error = %v, wantErr = %v", err, test.wantErr)
			}
		})
	}
}

func TestDecodeBase64FieldCapsInputBeforeDecode(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(make([]byte, mediaKeyDecodedSize))
	decoded, err := decodeBase64Field("mediaKey", encoded, mediaKeyDecodedSize)
	if err != nil {
		t.Fatalf("decodeBase64Field() error = %v", err)
	}
	if len(decoded) != mediaKeyDecodedSize {
		t.Fatalf("decoded length = %d, want %d", len(decoded), mediaKeyDecodedSize)
	}

	oversized := strings.Repeat("A", base64.StdEncoding.EncodedLen(mediaKeyDecodedSize)+1)
	if _, err = decodeBase64Field("mediaKey", oversized, mediaKeyDecodedSize); err == nil {
		t.Fatal("decodeBase64Field() accepted oversized encoded input")
	}
}

func TestBoundedMediaFileRejectsWritesAndTruncatesPastLimit(t *testing.T) {
	boundedFile, err := createE2EEMediaTempFile(4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = boundedFile.Close()
		_ = os.Remove(boundedFile.Name())
	})

	if _, err = boundedFile.Write([]byte("1234")); err != nil {
		t.Fatalf("bounded Write() within limit error = %v", err)
	}
	if _, err = boundedFile.Write([]byte("5")); !errors.Is(err, errDownloadedMediaTooLarge) {
		t.Fatalf("bounded Write() error = %v, want %v", err, errDownloadedMediaTooLarge)
	}
	if _, err = boundedFile.WriteAt([]byte("5"), 4); !errors.Is(err, errDownloadedMediaTooLarge) {
		t.Fatalf("bounded WriteAt() error = %v, want %v", err, errDownloadedMediaTooLarge)
	}
	if err = boundedFile.Truncate(5); !errors.Is(err, errDownloadedMediaTooLarge) {
		t.Fatalf("bounded Truncate() error = %v, want %v", err, errDownloadedMediaTooLarge)
	}
}

func TestBoundedMediaFileReadFromCannotBypassWriteLimit(t *testing.T) {
	boundedFile, err := createE2EEMediaTempFile(4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = boundedFile.Close()
		_ = os.Remove(boundedFile.Name())
	})

	_, err = io.Copy(boundedFile, strings.NewReader("12345"))
	if !errors.Is(err, errDownloadedMediaTooLarge) {
		t.Fatalf("io.Copy() error = %v, want %v", err, errDownloadedMediaTooLarge)
	}
	info, statErr := boundedFile.Stat()
	if statErr != nil {
		t.Fatal(statErr)
	}
	if info.Size() > boundedFile.maxSize {
		t.Fatalf("bounded file size = %d, limit = %d", info.Size(), boundedFile.maxSize)
	}
}
