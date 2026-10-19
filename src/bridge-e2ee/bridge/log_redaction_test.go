package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
)

func TestRedactingLogWriterHidesProviderIdentifiersAndCredentials(t *testing.T) {
	var output bytes.Buffer
	writer := newRedactingLogWriter(&output)
	input := `{"level":"warn","database_id":1,"readerId":"opaque-reader","threadName":"private group","thread_id":123456789012345,"message_id":"mid.123456789012345","cookie":"c_user=123456789; xs=secret","new_cursor":"opaque-sync-cursor","data":["private row"],"val":"private value","payload":{"text":"private message"},"error":"request https://example.test/path?access_token=secret for 123456789@msgr failed; <iq id=\"short-id\" from=\"12345@msgr\"><enc>ciphertext</enc></iq>"}` + "\n"
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(output.Bytes(), &payload); err != nil {
		t.Fatalf("decode redacted log: %v", err)
	}
	if payload["database_id"] != float64(1) {
		t.Fatalf("database_id = %v, want 1", payload["database_id"])
	}
	for _, field := range []string{"readerId", "threadName", "thread_id", "message_id", "cookie", "new_cursor", "data", "val", "payload"} {
		if payload[field] != redactedLogValue {
			t.Errorf("%s = %v, want redacted", field, payload[field])
		}
	}
	serialized := output.String()
	for _, secret := range []string{"opaque-reader", "private group", "123456789012345", "123456789@msgr", "access_token=secret", "xs=secret", "private message", "opaque-sync-cursor", "private row", "private value", "short-id", "ciphertext"} {
		if strings.Contains(serialized, secret) {
			t.Errorf("redacted log still contains %q", secret)
		}
	}
}

func TestRedactingLogWriterHidesCompleteProtocolStanzas(t *testing.T) {
	var output bytes.Buffer
	writer := newRedactingLogWriter(&output)
	input := `{"level":"debug","message":"<iq id=\"short-id\"><identity>private-key-material</identity><list><key><value>prekey-material</value></key></list></iq>","component":"whatsmeow"}` + "\n"
	if _, err := writer.Write([]byte(input)); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	serialized := output.String()
	for _, secret := range []string{"short-id", "private-key-material", "prekey-material"} {
		if strings.Contains(serialized, secret) {
			t.Errorf("redacted stanza still contains %q", secret)
		}
	}
	if !strings.Contains(serialized, redactedLogValue) {
		t.Fatal("redacted stanza does not contain the redaction marker")
	}
}

func TestRedactingLogWriterBuffersPartialLines(t *testing.T) {
	var output bytes.Buffer
	writer := newRedactingLogWriter(&output)
	if _, err := writer.Write([]byte(`{"message":"user 123456789`)); err != nil {
		t.Fatalf("first Write() error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatal("partial JSON line was emitted before newline")
	}
	if _, err := writer.Write([]byte(` connected"}` + "\n")); err != nil {
		t.Fatalf("second Write() error = %v", err)
	}
	if strings.Contains(output.String(), "123456789") {
		t.Fatal("partial log line identifier was not redacted")
	}
}

func assertRedactingLogWriterBound(t *testing.T, writer *redactingLogWriter) {
	t.Helper()
	if len(writer.pending) > maxRedactingLogLineBytes || cap(writer.pending) > maxRedactingLogLineBytes {
		t.Fatalf("pending length/capacity = %d/%d, limit = %d", len(writer.pending), cap(writer.pending), maxRedactingLogLineBytes)
	}
}

func writeRedactingLogInput(t *testing.T, writer *redactingLogWriter, input []byte) {
	t.Helper()
	if written, err := writer.Write(input); err != nil || written != len(input) {
		t.Fatalf("Write() = %d, %v, want %d, nil", written, err, len(input))
	}
	assertRedactingLogWriterBound(t, writer)
}

func TestRedactingLogWriterDropsHugeSingleWriteAndRecovers(t *testing.T) {
	var output bytes.Buffer
	writer := &redactingLogWriter{out: &output}
	input := append([]byte(`{"cookie":"private-secret-`), bytes.Repeat([]byte("x"), 8*1024*1024)...)
	input = append(input, []byte("\"}\n{\"database_id\":1,\"message\":\"ready\"}\n")...)
	writeRedactingLogInput(t, writer, input)
	if want := oversizedLogDiagnostic + "{\"database_id\":1,\"message\":\"ready\"}\n"; output.String() != want {
		t.Fatalf("oversized log recovery output = %q, want %q", output.String(), want)
	}
	if len(writer.pending) != 0 || writer.dropping {
		t.Fatalf("writer did not finish the dropped line: pending = %d, dropping = %v", len(writer.pending), writer.dropping)
	}
}

func TestRedactingLogWriterDrainsOversizedChunksWithoutNewline(t *testing.T) {
	var output bytes.Buffer
	writer := &redactingLogWriter{out: &output}
	writeRedactingLogInput(t, writer, []byte(`{"cookie":"private-secret-`))
	chunk := bytes.Repeat([]byte("x"), 997)
	for range 2048 {
		writeRedactingLogInput(t, writer, chunk)
	}
	if output.String() != oversizedLogDiagnostic {
		t.Fatalf("unterminated oversized line output = %q, want one fixed diagnostic", output.String())
	}
	if len(writer.pending) != 0 || cap(writer.pending) != 0 || !writer.dropping {
		t.Fatalf("dropped raw fragments retained: length/capacity = %d/%d, dropping = %v", len(writer.pending), cap(writer.pending), writer.dropping)
	}
	writeRedactingLogInput(t, writer, []byte("private-tail\"}\n{\"database_id\":1,\"cookie\":\"later-secret\",\"message\":\"recovered\"}\n"))
	if want := oversizedLogDiagnostic + "{\"cookie\":\"[redacted]\",\"database_id\":1,\"message\":\"recovered\"}\n"; output.String() != want {
		t.Fatalf("chunk recovery output = %q, want %q", output.String(), want)
	}
}

func TestRedactingLogWriterLineLimitBoundary(t *testing.T) {
	for _, extra := range []int{0, 1} {
		t.Run(fmt.Sprintf("extra_%d", extra), func(t *testing.T) {
			var output bytes.Buffer
			writer := &redactingLogWriter{out: &output}
			prefix := []byte(`{"cookie":"boundary-secret","message":"at limit"}`)
			input := append(prefix, bytes.Repeat([]byte(" "), maxRedactingLogLineBytes-len(prefix)+extra)...)
			for len(input) > 0 {
				length := min(379, len(input))
				writeRedactingLogInput(t, writer, input[:length])
				input = input[length:]
			}
			if extra == 0 && output.Len() != 0 {
				t.Fatal("exact-limit partial line emitted before newline")
			}
			writeRedactingLogInput(t, writer, []byte("\n"))
			want := "{\"cookie\":\"[redacted]\",\"message\":\"at limit\"}\n"
			if extra > 0 {
				want = oversizedLogDiagnostic
			}
			if output.String() != want {
				t.Fatalf("boundary output = %q, want %q", output.String(), want)
			}
		})
	}
}

func TestRedactingLogWriterPreservesRedactionAtEverySplit(t *testing.T) {
	input := []byte("{\"cookie\":\"split-secret\",\"thread_id\":123456789,\"database_id\":1,\"message\":\"connected\"}\n")
	for split := 0; split <= len(input); split++ {
		var output bytes.Buffer
		writer := &redactingLogWriter{out: &output}
		writeRedactingLogInput(t, writer, input[:split])
		writeRedactingLogInput(t, writer, input[split:])
		if want := "{\"cookie\":\"[redacted]\",\"database_id\":1,\"message\":\"connected\",\"thread_id\":\"[redacted]\"}\n"; output.String() != want {
			t.Fatalf("split %d output = %q, want %q", split, output.String(), want)
		}
	}
}

func TestRedactingLogWriterOversizedLineStorm(t *testing.T) {
	var output bytes.Buffer
	writer := &redactingLogWriter{out: &output}
	oversized := bytes.Repeat([]byte("private-storm-secret"), maxRedactingLogLineBytes/20+1)
	oversized = append(oversized, '\n')
	valid := []byte("{\"database_id\":1,\"message\":\"survived\"}\n")
	for range 256 {
		writeRedactingLogInput(t, writer, oversized)
		writeRedactingLogInput(t, writer, valid)
	}
	if got := strings.Count(output.String(), oversizedLogDiagnostic); got != 256 {
		t.Fatalf("oversized storm diagnostics = %d, want 256", got)
	}
	if got := strings.Count(output.String(), "survived"); got != 256 {
		t.Fatalf("valid storm lines = %d, want 256", got)
	}
	if strings.Contains(output.String(), "private-storm-secret") {
		t.Fatal("oversized storm secret was emitted")
	}
}

type redactingLogTestOutput struct {
	bytes.Buffer
	err   error
	short bool
}

func (output *redactingLogTestOutput) Write(input []byte) (int, error) {
	if output.err != nil {
		return 0, output.err
	}
	if output.short {
		return len(input) - 1, nil
	}
	return output.Buffer.Write(input)
}

func TestRedactingLogWriterReportsOutputFailuresWithConsumedInput(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(fmt.Sprintf("short_%v", short), func(t *testing.T) {
			failure := errors.New("output unavailable")
			output := &redactingLogTestOutput{short: short}
			if !short {
				output.err = failure
			} else {
				failure = io.ErrShortWrite
			}
			writer := &redactingLogWriter{out: output}
			writeRedactingLogInput(t, writer, []byte(`{"message":"part`))
			input := []byte("ial\"}\n{\"message\":\"next\"}\n")
			written, err := writer.Write(input)
			if want := bytes.IndexByte(input, '\n') + 1; written != want || !errors.Is(err, failure) {
				t.Fatalf("Write() = %d, %v, want %d, %v", written, err, want, failure)
			}
			output.err = nil
			output.short = false
			writeRedactingLogInput(t, writer, input[written:])
			if output.String() != "{\"message\":\"next\"}\n" {
				t.Fatalf("output after retrying unconsumed suffix = %q", output.String())
			}
		})
	}
}

func TestRedactingLogWriterKeepsDroppingWhenDiagnosticFails(t *testing.T) {
	failure := errors.New("output unavailable")
	output := &redactingLogTestOutput{err: failure}
	writer := &redactingLogWriter{out: output}
	input := bytes.Repeat([]byte("private-oversized-secret"), maxRedactingLogLineBytes/24+2)
	if written, err := writer.Write(input); written != len(input) || !errors.Is(err, failure) {
		t.Fatalf("Write() = %d, %v, want %d, %v", written, err, len(input), failure)
	}
	output.err = nil
	writeRedactingLogInput(t, writer, []byte("private-tail\n{\"message\":\"recovered\"}\n"))
	if output.String() != "{\"message\":\"recovered\"}\n" {
		t.Fatalf("failed diagnostic exposed dropped suffix: %q", output.String())
	}
}

func TestRedactingLogWriterConcurrentWrites(t *testing.T) {
	var output bytes.Buffer
	writer := &redactingLogWriter{out: &output}
	var group sync.WaitGroup
	failures := make(chan error, 32)
	for worker := range 32 {
		group.Go(func() {
			input := fmt.Appendf(nil, "{\"cookie\":\"worker-secret-%d\",\"database_id\":1}\n", worker)
			for range 64 {
				if written, err := writer.Write(input); err != nil || written != len(input) {
					failures <- fmt.Errorf("Write() = %d, %v", written, err)
					return
				}
			}
		})
	}
	group.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	assertRedactingLogWriterBound(t, writer)
	if got := bytes.Count(output.Bytes(), []byte("\n")); got != 32*64 {
		t.Fatalf("concurrent output lines = %d, want %d", got, 32*64)
	}
	if strings.Contains(output.String(), "worker-secret") {
		t.Fatal("concurrent output exposed credentials")
	}
}
