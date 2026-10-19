package bridge

// DEPLAO_ADAPTER: Messenger group creation for Deplao's quick "Tạo nhóm" action
// (same LightSpeed task as mautrix-meta connector/startchat.go CreateGroup).

import (
	"fmt"
	"strconv"
	"strings"

	"go.mau.fi/mautrix-meta/pkg/messagix/methods"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

// MinGroupParticipants: a Messenger group needs at least two people besides the account
// (with one it is a 1:1 chat).
const MinGroupParticipants = 2

// CreateGroupResult is returned by CreateGroup. The thread id is a JSON string: Messenger ids
// exceed JavaScript's safe integer range.
type CreateGroupResult struct {
	ThreadID int64 `json:"threadId,string"`
	// RenameError is set when the group was created but naming it failed.
	RenameError string `json:"renameError,omitempty"`
}

// ParseParticipantIDs converts Facebook user ids sent by Electron (strings) to int64.
func ParseParticipantIDs(raw []string) ([]int64, error) {
	ids := make([]int64, 0, len(raw))
	seen := make(map[int64]bool, len(raw))
	for _, value := range raw {
		id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("invalid participant id %q", value)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// createGroupError extracts the rejection Facebook returned for the create task, if any.
func createGroupError(resp *table.LSTable) error {
	if resp == nil || len(resp.LSIssueNewError) == 0 {
		return nil
	}
	issue := resp.LSIssueNewError[0]
	message := issue.ErrorMessage
	if message == "" {
		message = issue.ErrorTitle
	}
	if message == "" {
		message = "Facebook rejected the group"
	}
	return fmt.Errorf("%s", message)
}

// CreateGroup creates a group thread with the given participants (the account itself is added by
// Facebook) and names it when name is not empty.
func (c *Client) CreateGroup(participants []int64, name string) (*CreateGroupResult, error) {
	if c.Messagix == nil {
		return nil, fmt.Errorf("client not connected")
	}
	if len(participants) < MinGroupParticipants {
		return nil, fmt.Errorf("a group needs at least %d other people", MinGroupParticipants)
	}
	threadID := methods.GenerateEpochID()
	otid := methods.GenerateEpochID()
	resp, err := c.Messagix.ExecuteTasks(c.ctx, &socket.CreateGroupTask{
		Participants: participants,
		SendPayload: socket.CreateGroupPayload{
			ThreadID: threadID,
			OTID:     strconv.FormatInt(otid, 10),
			Source:   0,
			SendType: 8,
		},
	})
	if err != nil {
		return nil, err
	}
	if err := createGroupError(resp); err != nil {
		return nil, err
	}
	if len(resp.LSReplaceOptimisticThread) == 0 {
		return nil, fmt.Errorf("no thread in create group response")
	}
	replaced := resp.LSReplaceOptimisticThread[0]
	if replaced.ThreadKey1 != threadID {
		return nil, fmt.Errorf("unexpected thread key in response: %d != %d", replaced.ThreadKey1, threadID)
	}
	result := &CreateGroupResult{ThreadID: replaced.ThreadKey2}
	if name = strings.TrimSpace(name); name != "" {
		if _, err := c.Messagix.ExecuteTasks(c.ctx, &socket.RenameThreadTask{
			ThreadKey:  result.ThreadID,
			ThreadName: name,
			SyncGroup:  1,
		}); err != nil {
			result.RenameError = err.Error()
		}
	}
	return result, nil
}
