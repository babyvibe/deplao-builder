package bridge

import (
	"encoding/json"
	"testing"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func TestParseParticipantIDs(t *testing.T) {
	ids, err := ParseParticipantIDs([]string{" 100001 ", "100002", "100001"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 2 || ids[0] != 100001 || ids[1] != 100002 {
		t.Fatalf("unexpected ids: %v", ids)
	}
	for _, bad := range [][]string{{"abc"}, {"0"}, {"-5"}, {""}} {
		if _, err := ParseParticipantIDs(bad); err == nil {
			t.Fatalf("expected an error for %q", bad)
		}
	}
}

func TestCreateGroupError(t *testing.T) {
	if err := createGroupError(nil); err != nil {
		t.Fatalf("nil response must not be an error: %v", err)
	}
	if err := createGroupError(&table.LSTable{}); err != nil {
		t.Fatalf("empty response must not be an error: %v", err)
	}
	resp := &table.LSTable{LSIssueNewError: []*table.LSIssueNewError{{ErrorTitle: "Không tạo được nhóm"}}}
	if err := createGroupError(resp); err == nil || err.Error() != "Không tạo được nhóm" {
		t.Fatalf("expected the title as error, got %v", err)
	}
	resp = &table.LSTable{LSIssueNewError: []*table.LSIssueNewError{{ErrorTitle: "t", ErrorMessage: "m"}}}
	if err := createGroupError(resp); err == nil || err.Error() != "m" {
		t.Fatalf("expected the message to win, got %v", err)
	}
}

func TestCreateGroupNeedsConnectionAndMembers(t *testing.T) {
	c := &Client{}
	if _, err := c.CreateGroup([]int64{1, 2}, "x"); err == nil {
		t.Fatalf("expected an error without a messagix client")
	}
}

func TestCreateGroupResultKeepsThreadIDAsString(t *testing.T) {
	data, err := json.Marshal(&CreateGroupResult{ThreadID: 9007199254740993})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(data) != `{"threadId":"9007199254740993"}` {
		t.Fatalf("unexpected json: %s", data)
	}
}
