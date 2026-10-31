/**
 * FacebookEventPipeline.ts
 * Phase 5: Sequential event queue per account.
 *
 * Guarantees:
 * - Events processed one-at-a-time (no parallel DB mutations)
 * - Stale generation events discarded
 * - Bounded queue with priority-based dropping
 * - Duplicate events (same messageId) deduped by durable identity
 * - Stop/close flushes or cancels cleanly
 */

import Logger from '../../utils/Logger';
import { metricInc } from './FacebookMetrics';

/** Priority levels — lower = more important, dropped first when queue is full */
enum EventPriority {
  LOW = 0,     // typing, presence, seen
  NORMAL = 1,  // reaction, edit
  HIGH = 2,    // message, unsend
}

interface PipelineEvent {
  id: string;               // Unique key for dedup (messageId or generated)
  generation: number;       // Generation that produced this event
  priority: EventPriority;
  process: () => Promise<void>; // The actual processing function
  receivedAt: number;       // Timestamp for monitoring
}

/** Max queue size before dropping low-priority events */
const MAX_QUEUE_SIZE = 500;
/** Only message-critical events may use the emergency headroom. */
const MAX_CRITICAL_QUEUE_SIZE = 2000;

/** Dedup window — events with same ID within this window are dropped */
const DEDUP_WINDOW_MS = 5000;

/**
 * Khoá chống trùng của một sự kiện bridge: loại + id tin; cảm xúc thêm người thả, cảm xúc, thời điểm; sửa tin thêm lần
 * sửa. Trước đây chỉ là id tin → cảm xúc / sửa / thu hồi tới trong 5 s sau chính tin đó bị coi là bản trùng và bỏ (thu
 * hồi là sự kiện quan trọng nên còn làm khởi động lại bridge).
 */
export function bridgeEventKey(evt: any): string {
  const type = String(evt?.type || '');
  const data = evt?.data || {};
  const id = data.messageId || data.id;
  if (!id) return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (type === 'reaction' || type === 'e2eeReaction') {
    const actor = data.userId ?? data.senderId ?? data.senderJid ?? '';
    return `${type}:${id}:${actor}:${data.emoji ?? data.reaction ?? ''}:${data.timestampMs ?? ''}`;
  }
  if (type === 'messageEdit') return `${type}:${id}:${data.editCount ?? ''}:${data.newText ?? ''}`;
  return `${type}:${id}`;
}

export class FacebookEventPipeline {
  private accountId: string;
  private queue: PipelineEvent[] = [];
  private processing = false;
  private currentGeneration = 0;
  /** Seen event IDs for dedup — auto-cleaned */
  private seenEvents = new Map<string, number>();
  /** IDs waiting in the queue; do not mark them durable until processing succeeds. */
  private queuedEventIds = new Set<string>();
  private seenCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Metrics */
  private droppedCount = 0;
  private processedCount = 0;

  constructor(accountId: string) {
    this.accountId = accountId;
    // Clean seen events every 30s
    this.seenCleanupTimer = setInterval(() => this.cleanSeenEvents(), 30000);
  }

  /**
   * Set the current generation. Events from older generations are discarded.
   */
  setGeneration(gen: number): void {
    this.currentGeneration = gen;
    // Discard stale events from old generations
    const before = this.queue.length;
    this.queue = this.queue.filter(e => e.generation >= gen);
    if (before !== this.queue.length) {
      Logger.log(`[EventPipeline:${this.accountId}] Discarded ${before - this.queue.length} stale events (gen < ${gen})`);
    }
  }

  /**
   * Enqueue an event for sequential processing.
   * Returns false if the event was dropped (queue full + low priority, or duplicate).
   */
  enqueue(
    id: string,
    priority: EventPriority,
    generation: number,
    processFn: () => Promise<void>,
  ): boolean {
    // Discard stale generation
    if (generation < this.currentGeneration) {
      Logger.log(`[EventPipeline:${this.accountId}] Discarded stale event gen=${generation} < current=${this.currentGeneration}`);
      return false;
    }

    // Dedup by durable identity
    const now = Date.now();
    if (this.isDuplicate(id)) {
      Logger.log(`[EventPipeline:${this.accountId}] Deduped event id=${id}`);
      return false;
    }
    // Bounded queue — drop low-priority when full
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Try to drop a low-priority event to make room
      const lowIdx = this.queue.findIndex(e => e.priority <= EventPriority.LOW);
      if (lowIdx >= 0) {
        this.queue.splice(lowIdx, 1);
        this.droppedCount++;
        metricInc('fb_event_queue_drop_low_priority', this.accountId);
        Logger.warn(`[EventPipeline:${this.accountId}] Queue full - dropped LOW priority event`);
      } else {
        // Queue full of NORMAL/HIGH events — still drop this one if it's low priority
        if (priority <= EventPriority.LOW) {
          this.droppedCount++;
          Logger.warn(`[EventPipeline:${this.accountId}] Queue full of important events - dropping this LOW event`);
          return false;
        }
        // Never silently evict a reaction/edit/message to admit another
        // important event. Use bounded emergency headroom; once exhausted the
        // caller is told explicitly so it can trigger recovery/catch-up.
        if (this.queue.length >= MAX_CRITICAL_QUEUE_SIZE) {
          this.droppedCount++;
          metricInc('fb_event_processing_failure', this.accountId, { reason: 'critical_queue_overflow' });
          Logger.error(`[EventPipeline:${this.accountId}] Critical queue overflow; recovery is required`);
          return false;
        }
      }
    }

    this.queuedEventIds.add(id);
    this.queue.push({
      id,
      generation,
      priority,
      process: processFn,
      receivedAt: now,
    });

    this.drain();
    return true;
  }

  /**
   * Stop accepting new events. Existing events are drained or cancelled.
   * @param cancel If true, discard remaining queue. If false, drain.
   */
  async stop(cancel: boolean = false): Promise<void> {
    if (cancel) {
      this.queue = [];
    } else {
      // Wait for queue to drain (with timeout)
      const deadline = Date.now() + 10000;
      while (this.processing && this.queue.length > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (this.seenCleanupTimer) {
      clearInterval(this.seenCleanupTimer);
      this.seenCleanupTimer = null;
    }
    Logger.log(`[EventPipeline:${this.accountId}] Stopped. Processed=${this.processedCount} Dropped=${this.droppedCount}`);
  }

  /**
   * Sự kiện cùng khoá đang chờ hoặc vừa xử lý xong (trong DEDUP_WINDOW_MS): enqueue sẽ bỏ như bản trùng. Người gọi dùng
   * để phân biệt "bỏ vì trùng" (đã xử lý rồi) với "bỏ vì hàng đợi đầy" (cần khôi phục).
   */
  isDuplicate(id: string): boolean {
    const lastSeen = this.seenEvents.get(id);
    return this.queuedEventIds.has(id) || (lastSeen !== undefined && (Date.now() - lastSeen) < DEDUP_WINDOW_MS);
  }

  /**
   * Get current queue depth for monitoring.
   */
  getDepth(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const event = this.queue.shift()!;

      // Double-check generation before processing
      if (event.generation < this.currentGeneration) {
        continue;
      }

      try {
        await event.process();
        this.seenEvents.set(event.id, Date.now());
        this.processedCount++;
      } catch (err: any) {
        metricInc('fb_event_processing_failure', this.accountId, { eventTypeId: event.id.slice(0, 20) });
        Logger.error(`[EventPipeline:${this.accountId}] Event ${event.id} failed: ${err.message}`);
        // Don't let one failed event kill the queue
      } finally {
        this.queuedEventIds.delete(event.id);
      }
    }

    this.processing = false;
  }

  private cleanSeenEvents(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenEvents) {
      if (now - ts > DEDUP_WINDOW_MS * 2) {
        this.seenEvents.delete(id);
      }
    }
  }
}

export { EventPriority };
