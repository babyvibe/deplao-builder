package bridge

// DEPLAO_ADAPTER: diagnostics of encrypted traffic that shows nothing in Deplao,
// so a Messenger notice missing from a chat can be traced in the app log:
//   - whatsmeow's warnings and errors (a message it gave up decoding or
//     decrypting, a stanza it ignored) and its "Unhandled ..." debug lines; it
//     only logs them, and Deplao runs the bridge with logging off;
//   - messages without content whose metadata changes no setting Deplao knows;
//   - WhatsApp-format messages, which Messenger accounts do not show.
// Only field names, enum names, integers (timers, times, versions) and ids are
// reported, never text, links or keys (whatsmeow's lines carry ids and errors).

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const EventTypeE2EEDropped EventType = "e2eeDropped"

// E2EEDropped is an encrypted message Deplao received but does not show.
type E2EEDropped struct {
	Reason    string `json:"reason"`
	Detail    string `json:"detail,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	ChatJID   string `json:"chatJid,omitempty"`
	SenderID  string `json:"senderId,omitempty"`
	FromMe    bool   `json:"fromMe,omitempty"`
}

const droppedDetailLimit = 400

// whatsmeowReportsPerMinute caps the whatsmeow lines reported (a reconnect can
// log a burst).
const whatsmeowReportsPerMinute = 30

// droppedMessageLogPrefixes are whatsmeow's warnings for a decrypted message it could not decode.
var droppedMessageLogPrefixes = []string{
	"Failed to decode armadillo message",
	"Error unmarshaling decrypted message",
	"Unknown version",
}

// dropWatchLogger passes whatsmeow's log lines on and reports its warnings,
// errors and "Unhandled ..." / "Didn't handle ..." debug lines.
type dropWatchLogger struct {
	waLog.Logger
	report func(reason, detail string)

	mu          sync.Mutex
	windowStart time.Time
	inWindow    int
}

func (l *dropWatchLogger) Warnf(msg string, args ...any) {
	l.Logger.Warnf(msg, args...)
	l.reportLine("warn", msg, args)
}

func (l *dropWatchLogger) Errorf(msg string, args ...any) {
	l.Logger.Errorf(msg, args...)
	l.reportLine("error", msg, args)
}

func (l *dropWatchLogger) Debugf(msg string, args ...any) {
	l.Logger.Debugf(msg, args...)
	if strings.HasPrefix(msg, "Unhandled ") || strings.HasPrefix(msg, "Didn't handle") {
		l.reportLine("debug", msg, args)
	}
}

func (l *dropWatchLogger) reportLine(level, msg string, args []any) {
	if !l.allow(time.Now()) {
		return
	}
	reason := "whatsmeow-" + level
	for _, prefix := range droppedMessageLogPrefixes {
		if strings.HasPrefix(msg, prefix) {
			reason = "undecodable"
			break
		}
	}
	l.report(reason, fmt.Sprintf(msg, args...))
}

// allow keeps at most whatsmeowReportsPerMinute reports in each minute.
func (l *dropWatchLogger) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.windowStart) >= time.Minute {
		l.windowStart, l.inWindow = now, 0
	}
	if l.inWindow >= whatsmeowReportsPerMinute {
		return false
	}
	l.inWindow++
	return true
}

// watchE2EEDrops makes the encrypted client report the messages it drops. Called
// before the client connects (the logger field is read without locking).
func (c *Client) watchE2EEDrops(e2eeClient *whatsmeow.Client) {
	if e2eeClient == nil {
		return
	}
	if _, wrapped := e2eeClient.Log.(*dropWatchLogger); wrapped {
		return
	}
	inner := e2eeClient.Log
	if inner == nil {
		inner = waLog.Noop
	}
	// Reported from its own goroutine: whatsmeow logs inside its socket and
	// decrypt paths, which must never wait for the event channel
	e2eeClient.Log = &dropWatchLogger{Logger: inner, report: func(reason, detail string) {
		go c.emitEvent(EventTypeE2EEDropped, &E2EEDropped{Reason: reason, Detail: shortDetail(detail)})
	}}
}

// reportMetadataOnly reports a message without content whose metadata changes no
// setting Deplao knows (a disappearing timer notice is handled, not reported).
func (c *Client) reportMetadataOnly(e *events.FBMessage) {
	if e == nil || e.Message != nil || e.FBApplication == nil {
		return
	}
	c.emitEvent(EventTypeE2EEDropped, &E2EEDropped{
		Reason:    "metadataOnly",
		Detail:    shortDetail(e.Info.StanzaTag + " " + describeFields(e.FBApplication)),
		MessageID: e.Info.ID,
		ChatJID:   e.Info.Chat.String(),
		SenderID:  jidUserID(e.Info.Sender),
		FromMe:    e.Info.IsFromMe,
	})
}

// reportWAMessage reports a WhatsApp-format message; key distribution alone is
// protocol traffic and stays quiet.
func (c *Client) reportWAMessage(e *events.Message) {
	if e == nil || e.Message == nil {
		return
	}
	detail := describeFields(e.Message)
	if detail == "" || strings.HasPrefix(detail, "senderKeyDistributionMessage") && !strings.Contains(detail, "} ") {
		return
	}
	c.emitEvent(EventTypeE2EEDropped, &E2EEDropped{
		Reason:    "waMessage",
		Detail:    detail,
		MessageID: e.Info.ID,
		ChatJID:   e.Info.Chat.String(),
		SenderID:  jidUserID(e.Info.Sender),
		FromMe:    e.Info.IsFromMe,
	})
}

// describeFields lists the fields a protobuf message carries, nested messages in
// braces, e.g. "metadata{ephemeralSettingList{chatJID}} payload{}". Integers,
// booleans and enum names are shown; text and bytes only by name.
func describeFields(msg proto.Message) string {
	if msg == nil {
		return ""
	}
	reflected := msg.ProtoReflect()
	if !reflected.IsValid() {
		return ""
	}
	var b strings.Builder
	describeInto(&b, reflected, 0)
	return shortDetail(b.String())
}

func describeInto(b *strings.Builder, m protoreflect.Message, depth int) {
	first := true
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		if b.Len() > droppedDetailLimit {
			return false
		}
		if !first {
			b.WriteByte(' ')
		}
		first = false
		b.WriteString(string(fd.Name()))
		switch {
		case fd.IsList():
			fmt.Fprintf(b, "[%d]", v.List().Len())
		case fd.IsMap():
			fmt.Fprintf(b, "[%d]", v.Map().Len())
		case fd.Kind() == protoreflect.MessageKind || fd.Kind() == protoreflect.GroupKind:
			b.WriteByte('{')
			if depth < 4 {
				describeInto(b, v.Message(), depth+1)
			}
			b.WriteByte('}')
		case fd.Kind() == protoreflect.EnumKind:
			if value := fd.Enum().Values().ByNumber(v.Enum()); value != nil {
				b.WriteString("=" + string(value.Name()))
			} else {
				fmt.Fprintf(b, "=%d", v.Enum())
			}
		case fd.Kind() == protoreflect.BoolKind:
			fmt.Fprintf(b, "=%t", v.Bool())
		case isIntegerKind(fd.Kind()):
			b.WriteString("=" + v.String())
		}
		return true
	})
}

func isIntegerKind(kind protoreflect.Kind) bool {
	switch kind {
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind,
		protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind,
		protoreflect.Uint32Kind, protoreflect.Fixed32Kind, protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return true
	}
	return false
}

func shortDetail(detail string) string {
	if len(detail) <= droppedDetailLimit {
		return detail
	}
	return detail[:droppedDetailLimit] + "..."
}
