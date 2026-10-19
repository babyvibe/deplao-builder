package bridge

// DEPLAO_ADAPTER: tests for per-thread history pages (history.go).

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func waitingHistoryClient(t *testing.T, threadID int64) (*Client, *historyCollector) {
	t.Helper()
	client := newEventPipelineTestClient(t, timeNowMs()-1_000)
	collector := newHistoryCollector()
	client.historyCollectors = map[int64]*historyCollector{threadID: collector}
	return client, collector
}

func TestHistoryPageCollectsRangeBackedUpserts(t *testing.T) {
	client, collector := waitingHistoryClient(t, 100)
	now := timeNowMs()
	client.handleTable(&table.LSTable{
		LSInsertNewMessageRange: []*table.LSInsertNewMessageRange{{
			ThreadKey: 100, MinTimestampMs: now - 60_000, MinMessageId: "mid.old", HasMoreBefore: true,
		}},
		LSUpsertMessage: []*table.LSUpsertMessage{
			{MessageId: "mid.old", ThreadKey: 100, SenderId: 7, Text: "cũ", TimestampMs: now - 60_000},
			{MessageId: "mid.card", ThreadKey: 100, SenderId: 7, TimestampMs: now - 30_000},
		},
		LSInsertXmaAttachment: []*table.LSInsertXmaAttachment{{
			MessageId: "mid.card", AttachmentFbid: "att.1", TitleText: "Đã thêm sản phẩm vào giỏ hàng",
			AttachmentCta1Id: 5, Cta1Title: "Xem giỏ hàng", Cta1Type: "xma_postback",
		}},
	})

	select {
	case <-collector.done:
	case <-time.After(time.Second):
		t.Fatal("history collector was not completed")
	}
	if got := len(client.eventChan); got != 0 {
		t.Fatalf("history upserts emitted %d live events, want 0", got)
	}
	if len(collector.messages) != 2 || !collector.hasMore || collector.minID != "mid.old" {
		t.Fatalf("collector = %+v", collector)
	}
	var card *Message
	for _, m := range collector.messages {
		if m.ID == "mid.card" {
			card = m
		}
	}
	if card == nil || len(card.Attachments) != 1 || card.Attachments[0].Type != "template" {
		t.Fatalf("history card = %#v", card)
	}
}

func TestHistoryEndOfChatCompletesEmptyPage(t *testing.T) {
	client, collector := waitingHistoryClient(t, 200)
	client.handleTable(&table.LSTable{
		LSUpdateExistingMessageRange: []*table.LSUpdateExistingMessageRange{{ThreadKey: 200}},
	})
	select {
	case <-collector.done:
	case <-time.After(time.Second):
		t.Fatal("end of chat did not complete the request")
	}
	if collector.hasMore || !collector.rangeSet || len(collector.messages) != 0 {
		t.Fatalf("collector = %+v", collector)
	}
}

func TestHistoryExistingRangeMustMatchTheAnchor(t *testing.T) {
	client, collector := waitingHistoryClient(t, 250)
	collector.referenceTs = 1_700_000_000_000

	// Range update for another anchor (e.g. a sync of the same thread): not this page's answer
	client.handleTable(&table.LSTable{
		LSUpdateExistingMessageRange: []*table.LSUpdateExistingMessageRange{{ThreadKey: 250, TimestampMS: 1_700_000_500_000}},
	})
	select {
	case <-collector.done:
		t.Fatal("an existing range for another anchor completed the request")
	default:
	}

	client.handleTable(&table.LSTable{
		LSUpdateExistingMessageRange: []*table.LSUpdateExistingMessageRange{{ThreadKey: 250, TimestampMS: 1_700_000_000_000}},
	})
	select {
	case <-collector.done:
	case <-time.After(time.Second):
		t.Fatal("the matching existing range did not complete the request")
	}
	if collector.hasMore || collector.endedBy != "existing_range" {
		t.Fatalf("collector = %+v", collector)
	}
}

func TestHistoryIgnoresOtherThreads(t *testing.T) {
	client, collector := waitingHistoryClient(t, 300)
	client.handleTable(&table.LSTable{
		LSInsertNewMessageRange: []*table.LSInsertNewMessageRange{{ThreadKey: 301, HasMoreBefore: true}},
		LSUpsertMessage:         []*table.LSUpsertMessage{{MessageId: "mid.x", ThreadKey: 301, SenderId: 1}},
	})
	select {
	case <-collector.done:
		t.Fatal("another thread's page completed this request")
	default:
	}
}

func TestFetchThreadHistoryRequiresClient(t *testing.T) {
	client := newEventPipelineTestClient(t, timeNowMs())
	if _, err := client.FetchThreadHistory(context.Background(), 1, 0, "", time.Second); err == nil {
		t.Fatal("expected an error without a Messenger client")
	}
	if _, err := client.FetchThreadHistory(context.Background(), 0, 0, "", time.Second); err == nil {
		t.Fatal("expected an error without a thread id")
	}
}
