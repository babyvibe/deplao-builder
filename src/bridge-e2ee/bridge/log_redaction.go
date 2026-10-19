package bridge

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"sync"
)

const (
	redactedLogValue = "[redacted]"
	// Raw lines must stay intact until redaction. Emitting chunks of an oversized
	// JSON line could expose a credential whose key was in an earlier chunk.
	maxRedactingLogLineBytes = 64 * 1024
	oversizedLogDiagnostic   = "{\"level\":\"warn\",\"message\":\"discarded oversized bridge log line\"}\n"
)

var (
	logCookiePattern = regexp.MustCompile(`(?i)\b(c_user|xs|fr|datr|sb|presence|access_token)=([^;\s]+)`)
	logJIDPattern    = regexp.MustCompile(`\b[0-9]{5,}:[0-9]+@[A-Za-z0-9._-]+\b|\b[0-9]{5,}@[A-Za-z0-9._-]+\b`)
	logIDPattern     = regexp.MustCompile(`\b[0-9]{7,}\b`)
	logUUIDPattern   = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`)
	logURLQuery      = regexp.MustCompile(`(https?://[^\s?"']+)\?[^\s"']+`)
	logXMLTagPattern = regexp.MustCompile(`(?i)</?[a-z][^>]*>`)
)

type redactingLogWriter struct {
	mu       sync.Mutex
	out      io.Writer
	pending  []byte
	dropping bool
}

func newRedactingLogWriter(out io.Writer) io.Writer {
	return &redactingLogWriter{out: out}
}

func normalizeLogKey(key string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
}

func isSensitiveLogKey(key string) bool {
	normalized := normalizeLogKey(key)
	if strings.HasSuffix(normalized, "id") && normalized != "databaseid" && normalized != "streamid" {
		return true
	}
	if strings.Contains(normalized, "cookie") ||
		strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "password") ||
		strings.Contains(normalized, "authorization") ||
		strings.Contains(normalized, "cursor") ||
		strings.Contains(normalized, "prekey") {
		return true
	}
	switch normalized {
	case "id", "fbid", "facebookid", "userid", "senderid", "threadid", "messageid", "chatjid", "senderjid", "jid", "deviceid", "registrationid", "epochid", "sessionid", "name", "threadname", "sendername", "username", "displayname", "url", "imageurl", "profileurl", "attachments", "payload", "body", "text", "content", "raw", "request", "response", "data", "val", "value", "config", "configs", "database", "syncparams", "blockresponse", "fullblock", "ptks", "key", "identity", "identitykey", "signature", "registration", "routinginfo":
		return true
	default:
		return false
	}
}

func redactLogString(value string) string {
	if logXMLTagPattern.MatchString(value) {
		return redactedLogValue
	}
	value = logCookiePattern.ReplaceAllString(value, `$1=`+redactedLogValue)
	value = logURLQuery.ReplaceAllString(value, `$1?`+redactedLogValue)
	value = logJIDPattern.ReplaceAllString(value, redactedLogValue)
	value = logUUIDPattern.ReplaceAllString(value, redactedLogValue)
	return logIDPattern.ReplaceAllString(value, redactedLogValue)
}

func redactLogObject(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			if isSensitiveLogKey(key) {
				typed[key] = redactedLogValue
			} else {
				typed[key] = redactLogObject(nested)
			}
		}
		return typed
	case []any:
		for index, nested := range typed {
			typed[index] = redactLogObject(nested)
		}
		return typed
	case string:
		return redactLogString(typed)
	default:
		return value
	}
}

func redactLogLine(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return []byte("\n")
	}
	var payload map[string]any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return append([]byte(redactLogString(string(trimmed))), '\n')
	}
	redacted, err := json.Marshal(redactLogObject(payload))
	if err != nil {
		return []byte("{\"level\":\"error\",\"message\":\"log redaction failed\"}\n")
	}
	return append(redacted, '\n')
}

func (writer *redactingLogWriter) Write(input []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()

	total := len(input)
	consumed := 0
	for len(input) > 0 {
		newline := bytes.IndexByte(input, '\n')
		if writer.dropping {
			if newline < 0 {
				return total, nil
			}
			consumed += newline + 1
			input = input[newline+1:]
			writer.dropping = false
			continue
		}

		fragmentLength := len(input)
		if newline >= 0 {
			fragmentLength = newline
		}
		if fragmentLength > maxRedactingLogLineBytes-len(writer.pending) {
			// Discard the entire raw line, including any earlier fragments. Do not
			// redact fragments independently or retain an arbitrarily large Write.
			writer.pending = nil
			writer.dropping = newline < 0
			consumed += fragmentLength
			input = input[fragmentLength:]
			if newline >= 0 {
				consumed++
				input = input[1:]
			}
			if err := writer.writeOutput([]byte(oversizedLogDiagnostic)); err != nil {
				return consumed, err
			}
			continue
		}

		if newline < 0 {
			if writer.pending == nil {
				// Reserve an explicit upper bound; append growth must never retain
				// a larger backing array even when a line arrives in many chunks.
				writer.pending = make([]byte, 0, maxRedactingLogLineBytes)
			}
			writer.pending = append(writer.pending, input...)
			return total, nil
		}

		line := input[:newline]
		if len(writer.pending) > 0 {
			writer.pending = append(writer.pending, line...)
			line = writer.pending
		}
		redacted := redactLogLine(line)
		clear(writer.pending)
		writer.pending = writer.pending[:0]
		consumed += newline + 1
		input = input[newline+1:]
		if err := writer.writeOutput(redacted); err != nil {
			return consumed, err
		}
	}
	return total, nil
}

func (writer *redactingLogWriter) writeOutput(output []byte) error {
	written, err := writer.out.Write(output)
	if err == nil && written != len(output) {
		return io.ErrShortWrite
	}
	return err
}
