/**
 * MessageQueue: Optimistic message sending queue.
 *
 * Manages the message send queue per thread with FIFO, cross-thread concurrency,
 * auto-retry with exponential backoff, and timeout detection.
 *
 * Flow:
 *   1. MessageInput.addMessage(temp_*) → shown at once (status: 'pending')
 *   2. messageQueue.enqueue(item) → put into the queue
 *   3. Worker dequeue → ipc.zalo.sendMessage() → update status
 *   4. The API returns { messageId } → update temp: real_msg_id, status: 'sent'
 *   5. Webhook echo → addMessage(real) → dedup by real_msg_id
 *
 * Usage:
 *   import { messageQueue } from '@/lib/chat/send/MessageQueue';
 *   messageQueue.enqueue({ tempId, zaloId, threadId, ... });
 */

import { getMessageCacheKeysForThread, useChatStore, type MessageItem } from '@/store/chat/chatStore';
import { CHANNEL, isFacebook } from '@/lib/channels/channelHelper';
import { tr } from '../../../../shared/i18n';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  /** Real message ID from the API response (single message/attachment) */
  msgId?: string;
  /** Several msgIds when sending several attachments (multi-image), so the webhook can dedupe */
  msgIds?: string[];
  error?: string;
  /**
   * Facebook E2EE: the server did not acknowledge in time and the message may
   * have been delivered (fbchat-v2 2.3.2). Never retried; `msgId` lets a later
   * echo replace the placeholder.
   */
  uncertain?: boolean;
}

export interface QueueItem {
  tempId: string;
  zaloId: string;
  threadId: string;
  threadType: number;
  channel: 'zalo' | 'facebook' | 'telegram_bot' | 'telegram_user';

  /** Function that calls the send-message API (ipc.zalo.sendMessage, ipc.fb.sendMessage, etc.) */
  sendFn: () => Promise<SendResult>;

  /** Callback when the upload progress changes (0-100) */
  onProgress?: (progress: number) => void;
  /** Callback on successful send (first msgId, full result to handle multi-attachment) */
  onSuccess?: (msgId: string, result?: SendResult) => void;
  /** Callback when the send fails (after all retries are used) */
  onFailed?: (error: string) => void;

  enqueuedAt: number;
  retryCount: number;
  maxRetries: number;
}

export type EnqueueInput = Omit<QueueItem, 'enqueuedAt' | 'retryCount' | 'maxRetries'> & {
  maxRetries?: number;
  retryCount?: number;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CONCURRENT_CROSS_THREAD = 5;
const MAX_RETRIES_DEFAULT = 3;
const SEND_TIMEOUT_MS = 60_000;
const RETRY_DELAYS = [1_000, 2_000, 4_000]; // exponential backoff
/** How long the real IDs of a sent message are kept for matching its image webhooks. */
const SENT_IDS_TTL_MS = 2 * 60_000;

// ─── MessageQueue ────────────────────────────────────────────────────────────

class MessageQueue {
  /** Queue per thread: threadKey → items[] */
  private queues = new Map<string, QueueItem[]>();
  /** Active send promise per thread (FIFO: only 1 send per thread at a time) */
  private active = new Map<string, Promise<void>>();
  /** Set of tempIds being sent across threads (concurrency limit) */
  private crossThreadActive = new Set<string>();
  /** Timers cho timeout detection */
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Pending image batches (keeps the temp preview until all webhooks have arrived) ──
  private pendingImageBatches: Array<{
    batchTempId: string;
    zaloId: string;
    threadId: string;
    expectedCount: number;
    receivedCount: number;
    sentAt: number;
    onAllReceived: () => void;
    /** Message IDs the send API returned for this batch (empty when it returned none). */
    realIds: string[];
  }> = [];
  /** Real message IDs returned by the send API, by temp ID (see SENT_IDS_TTL_MS). */
  private sentIdsByTempId = new Map<string, { ids: string[]; at: number }>();

  /** Registers 1 outgoing image batch: keeps the temp preview until all webhooks have arrived */
  registerImageBatch(batchTempId: string, zaloId: string, threadId: string, expectedCount: number, onAllReceived: () => void): void {
    const realIds = this.sentIdsByTempId.get(batchTempId)?.ids || [];
    // The webhook can arrive before the send API answers. sendItem then
    // already replaced the preview with the real message, and a batch
    // registered now would wait for webhooks that came already (and could
    // take the next batch's webhook instead).
    if (!this.hasMessage(zaloId, threadId, batchTempId)) {
      this.sentIdsByTempId.delete(batchTempId);
      return;
    }
    this.pendingImageBatches.push({
      batchTempId, zaloId, threadId, expectedCount, receivedCount: 0, sentAt: Date.now(), onAllReceived, realIds,
    });
    // Safety timeout: if the webhooks do not all arrive within 30s → remove the preview
    setTimeout(() => {
      this.removeImageBatch(batchTempId);
    }, 30_000);
  }

  /** Webhook reports that 1 image message has arrived → remove the temp batch at once (avoids duplicates) */
  onImageMessageReceived(zaloId: string, threadId: string, msgId?: string): void {
    const now = Date.now();
    const candidates = this.pendingImageBatches.filter(b =>
      b.zaloId === zaloId &&
      b.threadId === threadId &&
      b.receivedCount < b.expectedCount &&
      now - b.sentAt < 30_000
    );
    // Prefer the batch whose send returned this message ID: the webhook of a
    // later batch can arrive while an earlier one still waits. Otherwise end
    // the oldest batch as before (the IDs are not guaranteed to match).
    const batch = (msgId ? candidates.find(b => b.realIds.includes(msgId)) : undefined) || candidates[0];
    if (!batch) return;

    batch.receivedCount++;
    console.log(`[MessageQueue] Image webhook received: ${batch.receivedCount}/${batch.expectedCount} for batch ${batch.batchTempId}`);

    // Remove the temp batch as soon as the first webhook arrives
    // (the webhook has already added the real message to the store → the temp would be a duplicate if kept)
    if (batch.receivedCount === 1) {
      console.log(`[MessageQueue] First image webhook → removing batch preview ${batch.batchTempId}`);
      batch.onAllReceived();
      this.removeImageBatch(batch.batchTempId);
    }
  }

  /** Removes the batch (when complete or on timeout) */
  private removeImageBatch(batchTempId: string): void {
    const idx = this.pendingImageBatches.findIndex(b => b.batchTempId === batchTempId);
    if (idx >= 0) {
      const batch = this.pendingImageBatches[idx];
      // Call the callback if the batch is incomplete (timeout case)
      if (batch.receivedCount < batch.expectedCount) {
        console.warn(`[MessageQueue] Image batch ${batchTempId} timeout: received ${batch.receivedCount}/${batch.expectedCount}`);
        batch.onAllReceived();
      }
      this.pendingImageBatches.splice(idx, 1);
    }
    this.sentIdsByTempId.delete(batchTempId);
  }

  private hasMessage(zaloId: string, threadId: string, msgId: string): boolean {
    const all = useChatStore.getState().messages;
    return getMessageCacheKeysForThread(all, zaloId, threadId)
      .some(key => (all[key] || []).some(m => String(m.msg_id) === msgId));
  }

  /** Whether a real (non-temp) message with one of these IDs is already listed. */
  private hasRealMessage(zaloId: string, threadId: string, ids: string[]): boolean {
    if (ids.length === 0) return false;
    const wanted = new Set(ids);
    const all = useChatStore.getState().messages;
    return getMessageCacheKeysForThread(all, zaloId, threadId)
      .some(key => (all[key] || []).some(m => !String(m.msg_id).startsWith('temp_') && wanted.has(String(m.msg_id))));
  }

  private rememberSentIds(tempId: string, ids: string[]): void {
    const now = Date.now();
    for (const [key, entry] of this.sentIdsByTempId) {
      if (now - entry.at > SENT_IDS_TTL_MS) this.sentIdsByTempId.delete(key);
    }
    if (ids.length > 0) this.sentIdsByTempId.set(tempId, { ids, at: now });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Adds a message to the queue. Does not block: returns at once.
   * The message is sent in the background.
   */
  enqueue(input: EnqueueInput): void {
    const item: QueueItem = {
      ...input,
      enqueuedAt: Date.now(),
      retryCount: input.retryCount ?? 0,
      maxRetries: input.maxRetries ?? MAX_RETRIES_DEFAULT,
    };

    const threadKey = `${item.zaloId}_${item.threadId}`;

    // Add to the queue
    const queue = this.queues.get(threadKey) || [];
    queue.push(item);
    this.queues.set(threadKey, queue);

    // Note: addMessage() already sets send_status='pending'. Only patch enqueued_at
    // if the message exists (avoid redundant full status update).
    const msgs = useChatStore.getState().messages[threadKey];
    if (msgs) {
      const idx = msgs.findIndex(m => m.msg_id === item.tempId);
      if (idx >= 0 && !msgs[idx].enqueued_at) {
        const updated = [...msgs];
        updated[idx] = { ...updated[idx], enqueued_at: item.enqueuedAt };
        useChatStore.setState((s) => ({ messages: { ...s.messages, [threadKey]: updated } }));
      }
    }

    console.log(`[MessageQueue] Enqueued tempId=${item.tempId} thread=${threadKey} queueSize=${queue.length}`);

    // Trigger processing
    this.processThread(threadKey);
  }

  /**
   * Retries 1 failed message. Puts it back into the queue with retry_count++.
   */
  retry(tempId: string, zaloId: string, threadId: string, sendFn: () => Promise<SendResult>): void {
    this.enqueue({
      tempId,
      zaloId,
      threadId,
      threadType: 0, // not important for the retry
      channel: 'zalo',
      sendFn,
      retryCount: 1,
      maxRetries: MAX_RETRIES_DEFAULT,
    });
  }

  /**
   * Cancels all pending messages in 1 thread.
   */
  cancelThread(threadKey: string): void {
    const queue = this.queues.get(threadKey);
    if (!queue) return;
    // Mark all pending → failed
    for (const item of queue) {
      this.updateStatus(item.zaloId, item.threadId, item.tempId, 'failed', {
        send_error: tr('Đã hủy'),
      });
    }
    this.queues.delete(threadKey);
    this.clearTimeout(threadKey);
  }

  /**
   * Gets the current queue state.
   */
  getStatus(): Record<string, { pending: number; sending: number }> {
    const result: Record<string, { pending: number; sending: number }> = {};
    for (const [key, items] of this.queues) {
      result[key] = {
        pending: items.filter(i => this.getStatusOf(i) === 'pending').length,
        sending: items.filter(i => this.getStatusOf(i) === 'sending').length,
      };
    }
    return result;
  }

  /** Number of messages being sent across threads */
  get activeCount(): number {
    return this.crossThreadActive.size;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private processThread(threadKey: string): void {
    // If a worker is already running for this thread → skip (the worker dequeues the next item itself)
    if (this.active.has(threadKey)) return;

    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) return;

    // Cross-thread concurrency limit
    if (this.crossThreadActive.size >= MAX_CONCURRENT_CROSS_THREAD) {
      console.log(`[MessageQueue] Cross-thread limit reached (${MAX_CONCURRENT_CROSS_THREAD}), waiting...`);
      return;
    }

    // Start the worker
    const worker = this.runWorker(threadKey);
    this.active.set(threadKey, worker);
  }

  private async runWorker(threadKey: string): Promise<void> {
    try {
      while (true) {
        const queue = this.queues.get(threadKey);
        if (!queue || queue.length === 0) break;

        // Cross-thread limit check
        if (this.crossThreadActive.size >= MAX_CONCURRENT_CROSS_THREAD) {
          console.log(`[MessageQueue] Cross-thread limit reached during worker, pausing`);
          break;
        }

        const item = queue.shift()!;
        this.crossThreadActive.add(item.tempId);

        try {
          await this.sendItem(item);
        } finally {
          this.crossThreadActive.delete(item.tempId);
        }
      }
    } finally {
      this.active.delete(threadKey);
      // If items are still in the queue → restart the worker
      const remaining = this.queues.get(threadKey);
      if (remaining && remaining.length > 0) {
        this.processThread(threadKey);
      }
    }
  }

  private async sendItem(item: QueueItem): Promise<void> {
    const { tempId, zaloId, threadId, sendFn, maxRetries } = item;

    // Update status → 'sending'
    this.updateStatus(zaloId, threadId, tempId, 'sending');

    // Timeout timer
    const timeoutPromise = new Promise<SendResult>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Send timeout (60s)'));
      }, SEND_TIMEOUT_MS);
      this.timeoutTimers.set(tempId, timer);
    });

    try {
      // Race: send vs timeout
      console.log(`[MessageQueue] Sending tempId=${tempId} channel=${item.channel}`);
      const result = await Promise.race([sendFn(), timeoutPromise]);
      console.log(`[MessageQueue] sendFn result: success=${result?.success} msgId=${result?.msgId} error=${result?.error}`);
      this.clearTimeout(tempId);

      // The webhook/echo of this send can arrive before the API response (it
      // is pushed over the socket while the HTTP reply is still in flight).
      // Then the real message is already listed and the optimistic copy would
      // stay as a duplicate: the echo could not be matched to it yet (no
      // real_msg_id, and an image preview has no comparable content).
      const realIds = result.success
        ? (result.msgId ? [String(result.msgId)] : (result.msgIds || []).map(String))
        : [];
      this.rememberSentIds(tempId, realIds);
      const echoArrivedFirst = this.hasRealMessage(zaloId, threadId, realIds);

      if (result.success && result.msgId) {
        // ── SUCCESS: the API returns a single msgId ──
        this.updateStatus(zaloId, threadId, tempId, 'sent', {
          real_msg_id: result.msgId,
        });
        if (echoArrivedFirst) this.dropDuplicatePreview(zaloId, threadId, tempId);
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} → realMsgId=${result.msgId} (before onSuccess)`);
        item.onSuccess?.(result.msgId, result);
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} → realMsgId=${result.msgId} (after onSuccess)`);
      } else if (result.success && result.msgIds && result.msgIds.length > 0) {
        // ── SUCCESS: Multi-attachment (multi-image): several msgIds ──
        this.updateStatus(zaloId, threadId, tempId, 'sent', {
          real_msg_id: result.msgIds[0],
        });
        if (echoArrivedFirst) this.dropDuplicatePreview(zaloId, threadId, tempId);
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} → ${result.msgIds.length} attachments: [${result.msgIds.join(', ')}]`);
        item.onSuccess?.(result.msgIds[0], result);
      } else if (result.success) {
        this.updateStatus(zaloId, threadId, tempId, 'sent');
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} (no msgId in response)`);
        item.onSuccess?.('', result);
      } else if (result.uncertain) {
        // ── UNCERTAIN: maybe delivered — neither "sent" nor retried ──
        const errorMsg = result.error || tr('Chưa xác nhận được tin nhắn đã gửi.');
        console.warn(`[MessageQueue] ⚠️ Unacknowledged tempId=${tempId} msgId=${result.msgId}: ${errorMsg}`);
        this.updateStatus(zaloId, threadId, tempId, 'timeout', {
          ...(result.msgId ? { real_msg_id: result.msgId } : {}),
          send_error: errorMsg,
        });
        item.onFailed?.(errorMsg);
      } else {
        // ── The API returns an error ──
        throw new Error(result.error || 'Send failed');
      }
    } catch (err: any) {
      this.clearTimeout(tempId);
      const errorMsg = err?.message || String(err);
      const isTimeout = errorMsg.includes('timeout');
      const newStatus = isTimeout ? 'timeout' : 'failed';

      // Facebook/E2EE sends are not idempotent: a lost response can mean the
      // message was accepted remotely. Retrying automatically can duplicate a
      // message (one click previously produced four IPC send requests).
      // Surface the failure and let the user explicitly retry after checking
      // the conversation instead.
      const canAutoRetry = item.channel !== 'facebook' && !isTimeout;
      if (item.retryCount < maxRetries && canAutoRetry) {
        const delay = RETRY_DELAYS[item.retryCount] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.warn(`[MessageQueue] ⚠️ Retry ${item.retryCount + 1}/${maxRetries} for tempId=${tempId} in ${delay}ms: ${errorMsg}`);

        this.updateStatus(zaloId, threadId, tempId, 'pending', {
          retry_count: item.retryCount + 1,
          send_error: errorMsg,
        });

        // Delay, then put back into the queue
        setTimeout(() => {
          const retryItem: QueueItem = {
            ...item,
            retryCount: item.retryCount + 1,
            enqueuedAt: Date.now(),
          };
          const threadKey = `${zaloId}_${threadId}`;
          const queue = this.queues.get(threadKey) || [];
          queue.unshift(retryItem); // unshift = retries get priority
          this.queues.set(threadKey, queue);
          this.processThread(threadKey);
        }, delay);
      } else {
        // ── FAILED: retries used up, timeout, or a Facebook ambiguous send ──
        console.error(`[MessageQueue] ❌ Failed tempId=${tempId}: ${errorMsg} (retries=${item.retryCount})`);
        this.updateStatus(zaloId, threadId, tempId, newStatus, {
          send_error: errorMsg,
        });
        item.onFailed?.(errorMsg);
      }
    }
  }

  private updateStatus(
    zaloId: string,
    threadId: string,
    tempId: string,
    status: MessageItem['send_status'],
    extra?: Partial<MessageItem>,
  ): void {
    useChatStore.getState().updateMessageStatus(zaloId, threadId, tempId, status, extra);
  }

  private dropDuplicatePreview(zaloId: string, threadId: string, tempId: string): void {
    console.log(`[MessageQueue] Echo arrived before the send response → removing duplicate preview ${tempId}`);
    useChatStore.getState().removeMessage(zaloId, threadId, tempId);
  }

  private getStatusOf(item: QueueItem): string {
    const msgs = useChatStore.getState().messages[`${item.zaloId}_${item.threadId}`] || [];
    const msg = msgs.find(m => m.msg_id === item.tempId);
    return msg?.send_status || 'pending';
  }

  private clearTimeout(key: string): void {
    const timer = this.timeoutTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(key);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const messageQueue = new MessageQueue();

// ─── Helper: extract real msgId from API response ────────────────────────────

/**
 * Extracts the real message ID from the Zalo / Facebook API response.
 *
 * Handled with the same logic as the PHP version:
 * 1. response.msgId → direct
 * 2. response.message.msgId → single message
 * 3. response.attachment[] → single attachment: take the msgId; multi: return msgIds[] (the webhook handles it)
 *
 * @returns { msgId?, msgIds? }: msgId for single, msgIds for multi-attachment
 */
export function extractMsgIdFromResponse(res: any, channel: string = CHANNEL.ZALO): { msgId?: string; msgIds?: string[] } {
  if (!res) return {};

  if (isFacebook(channel)) {
    const id = res.messageId || res.msgId;
    return id ? { msgId: String(id) } : {};
  }

  // Zalo: same logic as the PHP version
  const r = res?.response || res;

  // 1. response.msgId (direct)
  if (r?.msgId) return { msgId: String(r.msgId) };

  // 2. response.message.msgId (single message)
  if (r?.message?.msgId) return { msgId: String(r.message.msgId) };
  if (r?.message?.messageId) return { msgId: String(r.message.messageId) };

  // 3. response.attachment[] (file/image attachments)
  const attachments = r?.attachment;
  if (Array.isArray(attachments) && attachments.length > 0) {
    if (attachments.length === 1) {
      // Single attachment → take the msgId right away
      const id = attachments[0]?.msgId || attachments[0]?.messageId;
      return id ? { msgId: String(id) } : {};
    } else {
      // Multi attachment (multi-image) → collect all msgIds, so the webhook handles dedupe
      const ids: string[] = [];
      for (const att of attachments) {
        const id = att?.msgId || att?.messageId;
        if (id) ids.push(String(id));
      }
      return ids.length > 0 ? { msgIds: ids } : {};
    }
  }

  return {};
}

/**
 * Generates a unique temp_id for an optimistic message.
 * Format: temp_{timestamp}_{random}: stays unique even when sending quickly.
 */
export function generateTempId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
