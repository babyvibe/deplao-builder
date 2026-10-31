/**
 * Hàng tải file Telegram theo tài khoản (ảnh, video, file, sticker, ảnh đại diện).
 *
 * Mỗi tài khoản tải LẦN LƯỢT một file: GramJS mượn sender của DC chứa file — cho đường ảnh đại diện và đường media tải
 * song song từng gây bão "Not connected" ở các forum nhiều media. Nhưng không còn theo thứ tự xếp hàng: trước đây
 * (chuỗi promise FIFO) lúc mở app phần bắt kịp xếp hàng trăm ảnh / video cũ của mọi hội thoại trước, video của hội thoại
 * đang mở phải chờ hết, và tin mới nhất (bong bóng dưới cùng xin tải sau cùng) lại có file sau cùng.
 *
 * Thứ tự chọn lượt kế tiếp — tính lúc chọn, nên mở hội thoại khác là đổi thứ tự ngay:
 *   0. Người dùng bấm tải / thử lại (`urgent`).
 *   1. Hội thoại đang mở: bong bóng trên màn hình xin tải (`visible`).
 *   2. Hội thoại đang mở: mọi file khác (tin realtime, bắt kịp, lịch sử, ảnh đại diện).
 *   3. Giao diện xin cho chỗ khác (hồ sơ, thông tin nhóm, ảnh đại diện đang hiện…).
 *   4. Nền: bắt kịp tin lúc offline, lịch sử, tin realtime của hội thoại khác, quét ảnh đại diện.
 * Cùng mức: tin mới nhất trước (`sortKey` = giờ tin, ms), bằng nhau thì theo thứ tự xếp hàng.
 *
 * Nhường: lượt mức 3–4 đang tải mà còn hơn `preemptMinRemainingBytes` thì khi có việc mức 0–2 sẽ dừng ở mảnh kế tiếp
 * (progress callback ném TelegramDownloadPreempted), quay lại hàng và tải lại từ đầu sau (GramJS không tải tiếp được).
 * Mỗi lượt nhường tối đa `maxPreemptions` lần để file lớn không bị tải dở mãi. Lượt không có progress callback (ảnh,
 * ảnh đại diện — nhỏ) không bao giờ bị dừng.
 *
 * Hạn chót: một lượt quá `deadlineMs` thì hàng đi tiếp (lượt đó báo lỗi hết giờ, việc tải thật của GramJS vẫn chạy nốt):
 * GramJS không có timeout phía client, một lượt kẹt trên sender chết từng chặn mọi ảnh / sticker / avatar sau nó.
 */

export type TelegramDownloadUrgency = 'background' | 'visible' | 'urgent';

export interface TelegramDownloadOptions {
  /** Hội thoại của file — được ưu tiên khi đang mở. Bỏ trống: không gắn hội thoại nào. */
  threadId?: string;
  /** Mặc định `background`. Xin lại cùng file với mức cao hơn thì nâng mức. */
  urgency?: TelegramDownloadUrgency;
  /** Lớn hơn = tải trước trong cùng mức (giờ tin, ms). Mặc định: lúc xếp hàng. */
  sortKey?: number;
}

/** Tham số truyền cho thao tác tải. */
export interface TelegramDownloadRun {
  /** Gọi trong progress callback của GramJS: ghi tiến độ; ném TelegramDownloadPreempted khi phải nhường. */
  progress(downloaded: unknown, total: unknown): void;
}

export const TELEGRAM_DOWNLOAD_PREEMPTED = 'TELEGRAM_DOWNLOAD_PREEMPTED';

export class TelegramDownloadPreempted extends Error {
  readonly code = TELEGRAM_DOWNLOAD_PREEMPTED;

  constructor(key: string) {
    super(`${TELEGRAM_DOWNLOAD_PREEMPTED} ${key}`);
    this.name = 'TelegramDownloadPreempted';
  }
}

export function isTelegramDownloadPreempted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === TELEGRAM_DOWNLOAD_PREEMPTED;
}

export interface TelegramDownloadPreemptInfo {
  accountId: string;
  key: string;
  downloaded: number;
  total: number;
  /** Việc làm lượt này phải nhường. */
  forKey: string;
}

export interface TelegramDownloadQueueOptions {
  deadlineMs: number;
  /** Còn ít hơn chừng này byte thì tải nốt, không nhường. */
  preemptMinRemainingBytes?: number;
  maxPreemptions?: number;
  now?: () => number;
  onPreempt?: (info: TelegramDownloadPreemptInfo) => void;
}

const URGENCY_LEVEL: Record<TelegramDownloadUrgency, number> = { background: 0, visible: 1, urgent: 2 };
/** Việc mức 0–2 (người dùng bấm, hội thoại đang mở) làm lượt mức 3–4 đang tải phải nhường. */
const PREEMPTING_RANK = 2;

interface Task {
  accountId: string;
  key: string;
  threadId?: string;
  urgency: TelegramDownloadUrgency;
  sortKey: number;
  seq: number;
  run: (run: TelegramDownloadRun) => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  attempts: number;
  preemptions: number;
  /** Đã xin lượt đang chạy dừng lại. */
  stopRequested: boolean;
  downloaded: number;
  total: number;
}

interface AccountQueue {
  pending: Task[];
  running: Task | null;
}

function toBytes(value: unknown): number {
  const n = Number((value as any)?.toString?.() ?? value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} (deadline ${Math.round(ms / 1000)}s)`)), ms);
      // Hạn chót của một lượt tải không bao giờ được giữ tiến trình sống
      (timer as { unref?: () => void }).unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createTelegramDownloadQueue(options: TelegramDownloadQueueOptions) {
  const deadlineMs = options.deadlineMs;
  const preemptMinRemainingBytes = options.preemptMinRemainingBytes ?? 1024 * 1024;
  const maxPreemptions = options.maxPreemptions ?? 3;
  const now = options.now ?? (() => Date.now());
  const queues = new Map<string, AccountQueue>();
  const tasks = new Map<string, Task>();
  let focus: { accountId: string; threadId: string } | null = null;
  let seq = 0;

  const taskId = (accountId: string, key: string) => `${accountId}\u0000${key}`;

  function rank(task: Task): number {
    if (task.urgency === 'urgent') return 0;
    const focused = !!focus && !!task.threadId
      && task.accountId === focus.accountId && task.threadId === focus.threadId;
    if (focused) return task.urgency === 'visible' ? 1 : 2;
    return task.urgency === 'visible' ? 3 : 4;
  }

  /** Âm = `a` tải trước. */
  function compare(a: Task, b: Task): number {
    return rank(a) - rank(b) || b.sortKey - a.sortKey || a.seq - b.seq;
  }

  function bestPendingIndex(queue: AccountQueue): number {
    let best = -1;
    for (let i = 0; i < queue.pending.length; i++) {
      if (best < 0 || compare(queue.pending[i], queue.pending[best]) < 0) best = i;
    }
    return best;
  }

  function raise(task: Task, opts: TelegramDownloadOptions): void {
    const urgency = opts.urgency ?? 'background';
    if (URGENCY_LEVEL[urgency] > URGENCY_LEVEL[task.urgency]) task.urgency = urgency;
    if (opts.threadId && !task.threadId) task.threadId = String(opts.threadId);
    if (typeof opts.sortKey === 'number' && Number.isFinite(opts.sortKey) && opts.sortKey > task.sortKey) {
      task.sortKey = opts.sortKey;
    }
  }

  /** Việc đang chờ mà lượt đang tải phải nhường, nếu có. */
  function yieldTo(queue: AccountQueue, running: Task): Task | null {
    if (running.preemptions >= maxPreemptions || rank(running) <= PREEMPTING_RANK) return null;
    // Chưa biết dung lượng (chưa có mảnh nào) / sắp xong → tải nốt; mảnh kế tiếp sẽ xét lại.
    if (running.total <= 0 || running.total - running.downloaded < preemptMinRemainingBytes) return null;
    const index = bestPendingIndex(queue);
    const waiting = index < 0 ? null : queue.pending[index];
    return waiting && rank(waiting) <= PREEMPTING_RANK ? waiting : null;
  }

  /** Xét lại lượt đang tải: xin dừng, hoặc bỏ lệnh dừng khi lý do đã hết (chính file đó được xin, đổi hội thoại…). */
  function maybePreempt(queue: AccountQueue): void {
    const running = queue.running;
    if (!running) return;
    const waiting = yieldTo(queue, running);
    if (!waiting) {
      running.stopRequested = false;
      return;
    }
    if (running.stopRequested) return;
    running.stopRequested = true;
    try {
      options.onPreempt?.({
        accountId: running.accountId,
        key: running.key,
        downloaded: running.downloaded,
        total: running.total,
        forKey: waiting.key,
      });
    } catch {
      // Ghi log không bao giờ được làm hỏng hàng tải
    }
  }

  function finish(queue: AccountQueue, task: Task, settle: () => void): void {
    if (queue.running === task) queue.running = null;
    if (tasks.get(taskId(task.accountId, task.key)) === task) tasks.delete(taskId(task.accountId, task.key));
    settle();
    pump(task.accountId);
  }

  function start(queue: AccountQueue, task: Task): void {
    queue.running = task;
    task.stopRequested = false;
    task.downloaded = 0;
    task.total = 0;
    const attempt = ++task.attempts;
    const current = () => queue.running === task && task.attempts === attempt;
    const run: TelegramDownloadRun = {
      progress: (downloaded, total) => {
        // Lượt đã hết giờ (hàng đã đi tiếp) vẫn có thể báo tiến độ — kệ nó tải nốt như trước.
        if (!current()) return;
        task.downloaded = toBytes(downloaded);
        const size = toBytes(total);
        if (size > 0) task.total = size;
        maybePreempt(queue);
        if (task.stopRequested) throw new TelegramDownloadPreempted(task.key);
      },
    };
    const work = Promise.resolve().then(() => task.run(run));
    withDeadline(work, deadlineMs, `TELEGRAM_DOWNLOAD_TIMEOUT ${task.key}`).then(
      value => {
        if (current()) finish(queue, task, () => task.resolve(value));
      },
      error => {
        if (!current()) return;
        if (task.stopRequested && isTelegramDownloadPreempted(error)) {
          // Nhường: về hàng (giữ promise, mức, thứ tự) — tải lại từ đầu khi tới lượt
          queue.running = null;
          task.stopRequested = false;
          task.preemptions += 1;
          queue.pending.push(task);
          pump(task.accountId);
          return;
        }
        finish(queue, task, () => task.reject(error));
      },
    );
  }

  function pump(accountId: string): void {
    const queue = queues.get(accountId);
    if (!queue || queue.running) return;
    const index = bestPendingIndex(queue);
    if (index < 0) {
      queues.delete(accountId);
      return;
    }
    const [task] = queue.pending.splice(index, 1);
    start(queue, task);
  }

  function enqueue<T>(
    accountId: string,
    key: string,
    operation: (run: TelegramDownloadRun) => Promise<T>,
    opts: TelegramDownloadOptions = {},
  ): Promise<T> {
    const id = taskId(accountId, key);
    const existing = tasks.get(id);
    if (existing) {
      raise(existing, opts);
      const queue = queues.get(accountId);
      if (queue) maybePreempt(queue);
      return existing.promise as Promise<T>;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: Task = {
      accountId,
      key,
      threadId: opts.threadId ? String(opts.threadId) : undefined,
      urgency: opts.urgency ?? 'background',
      sortKey: typeof opts.sortKey === 'number' && Number.isFinite(opts.sortKey) ? opts.sortKey : now(),
      seq: ++seq,
      run: operation as (run: TelegramDownloadRun) => Promise<unknown>,
      promise,
      resolve,
      reject,
      attempts: 0,
      preemptions: 0,
      stopRequested: false,
      downloaded: 0,
      total: 0,
    };
    tasks.set(id, task);
    let queue = queues.get(accountId);
    if (!queue) {
      queue = { pending: [], running: null };
      queues.set(accountId, queue);
    }
    queue.pending.push(task);
    pump(accountId);
    maybePreempt(queue);
    return promise as Promise<T>;
  }

  /** File đã có trong hàng (đang chờ / đang tải) → nâng mức, trả promise của lượt đó; chưa có → undefined. */
  function promote(accountId: string, key: string, opts: TelegramDownloadOptions = {}): Promise<unknown> | undefined {
    const task = tasks.get(taskId(accountId, key));
    if (!task) return undefined;
    raise(task, opts);
    const queue = queues.get(accountId);
    if (queue) maybePreempt(queue);
    return task.promise;
  }

  /** Hội thoại đang mở (renderer báo). Không có → bỏ ưu tiên hội thoại. */
  function setFocus(accountId?: string | null, threadId?: string | null): void {
    focus = accountId && threadId ? { accountId: String(accountId), threadId: String(threadId) } : null;
    for (const queue of queues.values()) maybePreempt(queue);
  }

  return {
    enqueue,
    promote,
    setFocus,
    getFocus: () => (focus ? { ...focus } : null),
    has: (accountId: string, key: string) => tasks.has(taskId(accountId, key)),
    /** Số lượt đang chờ + đang tải của tài khoản. */
    size: (accountId: string) => {
      const queue = queues.get(accountId);
      return queue ? queue.pending.length + (queue.running ? 1 : 0) : 0;
    },
    /** Khoá các lượt đang chờ theo thứ tự sẽ tải (test / log). */
    pendingKeys: (accountId: string) => [...(queues.get(accountId)?.pending ?? [])].sort(compare).map(task => task.key),
    runningKey: (accountId: string) => queues.get(accountId)?.running?.key ?? null,
  };
}

export type TelegramDownloadQueue = ReturnType<typeof createTelegramDownloadQueue>;
