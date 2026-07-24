/**
 * MessageQueue — Optimistic message sending queue.
 *
 * Quản lý hàng đợi gửi tin nhắn per-thread với FIFO, cross-thread concurrency,
 * auto-retry exponential backoff, và timeout detection.
 *
 * Flow:
 *   1. MessageInput.addMessage(temp_*) → hiển thị ngay (status: 'pending')
 *   2. messageQueue.enqueue(item) → đưa vào queue
 *   3. Worker dequeue → ipc.zalo.sendMessage() → update status
 *   4. API trả về { messageId } → update temp: real_msg_id, status: 'sent'
 *   5. Webhook echo → addMessage(real) → dedup by real_msg_id
 *
 * Usage:
 *   import { messageQueue } from '@/lib/MessageQueue';
 *   messageQueue.enqueue({ tempId, zaloId, threadId, ... });
 */

import { useChatStore, type MessageItem } from '@/store/chatStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  /** Message ID thật từ API response (single message/attachment) */
  msgId?: string;
  /** Nhiều msgIds khi gửi nhiều attachment (multi-image) — để webhook xử lý dedup */
  msgIds?: string[];
  error?: string;
}

export interface QueueItem {
  tempId: string;
  zaloId: string;
  threadId: string;
  threadType: number;
  channel: 'zalo' | 'facebook';

  /** Hàm gọi API gửi tin nhắn (ipc.zalo.sendMessage, ipc.fb.sendMessage, etc.) */
  sendFn: () => Promise<SendResult>;

  /** Callback khi upload progress thay đổi (0-100) */
  onProgress?: (progress: number) => void;
  /** Callback khi gửi thành công (msgId đầu tiên, full result để xử lý multi-attachment) */
  onSuccess?: (msgId: string, result?: SendResult) => void;
  /** Callback khi gửi thất bại (sau khi hết retry) */
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

// ─── MessageQueue ────────────────────────────────────────────────────────────

class MessageQueue {
  /** Queue per thread: threadKey → items[] */
  private queues = new Map<string, QueueItem[]>();
  /** Active send promise per thread (FIFO: chỉ 1 send/thread tại 1 thời điểm) */
  private active = new Map<string, Promise<void>>();
  /** Set tempId đang gửi cross-thread (giới hạn concurrency) */
  private crossThreadActive = new Set<string>();
  /** Timers cho timeout detection */
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Pending image batches (giữ preview temp cho đến khi webhooks đủ) ──
  private pendingImageBatches: Array<{
    batchTempId: string;
    zaloId: string;
    threadId: string;
    expectedCount: number;
    receivedCount: number;
    sentAt: number;
    onAllReceived: () => void;
  }> = [];

  /** Đăng ký 1 batch image gửi đi — giữ preview temp cho đến khi webhooks đủ */
  registerImageBatch(batchTempId: string, zaloId: string, threadId: string, expectedCount: number, onAllReceived: () => void): void {
    this.pendingImageBatches.push({
      batchTempId, zaloId, threadId, expectedCount, receivedCount: 0, sentAt: Date.now(), onAllReceived,
    });
    // Safety timeout: nếu webhook không đến đủ trong 30s → xóa preview
    setTimeout(() => {
      this.removeImageBatch(batchTempId);
    }, 30_000);
  }

  /** Webhook báo 1 image message đã đến — xóa batch temp ngay (tránh duplicate) */
  onImageMessageReceived(zaloId: string, threadId: string): void {
    const now = Date.now();
    const batch = this.pendingImageBatches.find(b =>
      b.zaloId === zaloId &&
      b.threadId === threadId &&
      b.receivedCount < b.expectedCount &&
      now - b.sentAt < 30_000
    );
    if (!batch) return;

    batch.receivedCount++;
    console.log(`[MessageQueue] Image webhook received: ${batch.receivedCount}/${batch.expectedCount} for batch ${batch.batchTempId}`);

    // Xóa batch temp ngay khi webhook đầu tiên đến
    // (webhook đã thêm message thật vào store → temp sẽ duplicate nếu giữ lại)
    if (batch.receivedCount === 1) {
      console.log(`[MessageQueue] First image webhook → removing batch preview ${batch.batchTempId}`);
      batch.onAllReceived();
      this.removeImageBatch(batch.batchTempId);
    }
  }

  /** Xóa batch (khi đủ hoặc timeout) */
  private removeImageBatch(batchTempId: string): void {
    const idx = this.pendingImageBatches.findIndex(b => b.batchTempId === batchTempId);
    if (idx >= 0) {
      const batch = this.pendingImageBatches[idx];
      // Gọi callback nếu chưa đủ (timeout case)
      if (batch.receivedCount < batch.expectedCount) {
        console.warn(`[MessageQueue] Image batch ${batchTempId} timeout: received ${batch.receivedCount}/${batch.expectedCount}`);
        batch.onAllReceived();
      }
      this.pendingImageBatches.splice(idx, 1);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Thêm tin nhắn vào queue. Không block — return ngay.
   * Tin nhắn sẽ được gửi trong background.
   */
  enqueue(input: EnqueueInput): void {
    const item: QueueItem = {
      ...input,
      enqueuedAt: Date.now(),
      retryCount: input.retryCount ?? 0,
      maxRetries: input.maxRetries ?? MAX_RETRIES_DEFAULT,
    };

    const threadKey = `${item.zaloId}_${item.threadId}`;

    // Thêm vào queue
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
   * Retry 1 tin nhắn thất bại. Đưa lại vào queue với retry_count++.
   */
  retry(tempId: string, zaloId: string, threadId: string, sendFn: () => Promise<SendResult>): void {
    this.enqueue({
      tempId,
      zaloId,
      threadId,
      threadType: 0, // không quan trọng cho retry
      channel: 'zalo',
      sendFn,
      retryCount: 1,
      maxRetries: MAX_RETRIES_DEFAULT,
    });
  }

  /**
   * Hủy tất cả tin đang chờ trong 1 thread.
   */
  cancelThread(threadKey: string): void {
    const queue = this.queues.get(threadKey);
    if (!queue) return;
    // Mark tất cả pending → failed
    for (const item of queue) {
      this.updateStatus(item.zaloId, item.threadId, item.tempId, 'failed', {
        send_error: 'Đã hủy',
      });
    }
    this.queues.delete(threadKey);
    this.clearTimeout(threadKey);
  }

  /**
   * Lấy trạng thái queue hiện tại.
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

  /** Số tin đang gửi cross-thread */
  get activeCount(): number {
    return this.crossThreadActive.size;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private processThread(threadKey: string): void {
    // Nếu đã có worker chạy cho thread này → skip (worker sẽ tự dequeue tiếp)
    if (this.active.has(threadKey)) return;

    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) return;

    // Cross-thread concurrency limit
    if (this.crossThreadActive.size >= MAX_CONCURRENT_CROSS_THREAD) {
      console.log(`[MessageQueue] Cross-thread limit reached (${MAX_CONCURRENT_CROSS_THREAD}), waiting...`);
      return;
    }

    // Bắt đầu worker
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
      // Nếu còn item trong queue → restart worker
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
      const result = await Promise.race([sendFn(), timeoutPromise]);
      this.clearTimeout(tempId);

      if (result.success && result.msgId) {
        // ── SUCCESS: API trả về single msgId ──
        this.updateStatus(zaloId, threadId, tempId, 'sent', {
          real_msg_id: result.msgId,
        });
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} → realMsgId=${result.msgId}`);
        item.onSuccess?.(result.msgId, result);
      } else if (result.success && result.msgIds && result.msgIds.length > 0) {
        // ── SUCCESS: Multi-attachment (multi-image) — nhiều msgIds ──
        this.updateStatus(zaloId, threadId, tempId, 'sent', {
          real_msg_id: result.msgIds[0],
        });
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} → ${result.msgIds.length} attachments: [${result.msgIds.join(', ')}]`);
        item.onSuccess?.(result.msgIds[0], result);
      } else if (result.success) {
        this.updateStatus(zaloId, threadId, tempId, 'sent');
        console.log(`[MessageQueue] ✅ Sent tempId=${tempId} (no msgId in response)`);
        item.onSuccess?.('', result);
      } else {
        // ── API trả về error ──
        throw new Error(result.error || 'Send failed');
      }
    } catch (err: any) {
      this.clearTimeout(tempId);
      const errorMsg = err?.message || String(err);
      const isTimeout = errorMsg.includes('timeout');
      const newStatus = isTimeout ? 'timeout' : 'failed';

      // Retry logic
      if (item.retryCount < maxRetries && !isTimeout) {
        const delay = RETRY_DELAYS[item.retryCount] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.warn(`[MessageQueue] ⚠️ Retry ${item.retryCount + 1}/${maxRetries} for tempId=${tempId} in ${delay}ms: ${errorMsg}`);

        this.updateStatus(zaloId, threadId, tempId, 'pending', {
          retry_count: item.retryCount + 1,
          send_error: errorMsg,
        });

        // Delay rồi đưa lại vào queue
        setTimeout(() => {
          const retryItem: QueueItem = {
            ...item,
            retryCount: item.retryCount + 1,
            enqueuedAt: Date.now(),
          };
          const threadKey = `${zaloId}_${threadId}`;
          const queue = this.queues.get(threadKey) || [];
          queue.unshift(retryItem); // unshift = ưu tiên retry
          this.queues.set(threadKey, queue);
          this.processThread(threadKey);
        }, delay);
      } else {
        // ── FAILED: hết retry hoặc timeout ──
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
 * Trích xuất message ID thật từ response của Zalo/Facebook API.
 *
 * Xử lý theo logic PHP:
 * 1. response.msgId → direct
 * 2. response.message.msgId → single message
 * 3. response.attachment[] → single attachment: lấy msgId, multi: trả msgIds[] (webhook xử lý)
 *
 * @returns { msgId?, msgIds? } — msgId cho single, msgIds cho multi-attachment
 */
export function extractMsgIdFromResponse(res: any, channel: string = 'zalo'): { msgId?: string; msgIds?: string[] } {
  if (!res) return {};

  if (channel === 'facebook') {
    const id = res.messageId || res.msgId;
    return id ? { msgId: String(id) } : {};
  }

  // Zalo — theo đúng logic PHP
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
      // Single attachment → lấy msgId luôn
      const id = attachments[0]?.msgId || attachments[0]?.messageId;
      return id ? { msgId: String(id) } : {};
    } else {
      // Multi attachment (multi-image) → collect tất cả msgIds, để webhook xử lý dedup
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
 * Sinh temp_id unique cho optimistic message.
 * Format: temp_{timestamp}_{random} — đảm bảo unique ngay cả khi gửi nhanh.
 */
export function generateTempId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
