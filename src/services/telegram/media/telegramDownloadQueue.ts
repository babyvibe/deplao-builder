/**
 * Telegram file download queue per account (images, videos, files, stickers, avatars).
 *
 * Each account downloads ONE file at a time: GramJS borrows the sender of the DC that holds the file. The avatar path and the media path running in parallel
 * used to cause a storm of "Not connected" errors in forums with many media. But there is no longer a first-in-first-out order: previously
 * (a FIFO promise chain) when the app opened, the catch-up queued hundreds of old images / videos from every conversation first, the video of the open conversation had to wait for all of them,
 * and the newest message (the bubble at the bottom asks for its file last) got its file last.
 *
 * Choosing the next pass, computed at pick time, so opening another conversation changes the order at once:
 *   0. The user clicked download / retry (`urgent`).
 *   1. Open conversation: the bubble on screen asks for the download (`visible`).
 *   2. Open conversation: every other file (realtime messages, catch-up, history, avatars).
 *   3. The UI asked for something else (profile, group info, avatars currently shown…).
 *   4. Background: catch-up of messages while offline, history, realtime messages of other conversations, avatar scan.
 * Same level: newest message first (`sortKey` = message time, ms); if equal, queue order.
 *
 * Yielding: a pass at level 3–4 that is downloading, with more than `preemptMinRemainingBytes` left, stops at the next chunk when level 0–2 work arrives
 * (the progress callback throws TelegramDownloadPreempted), goes back to the queue and downloads again from the start later (GramJS cannot resume a download).
 * Each pass yields at most `maxPreemptions` times, so a large file is not downloaded partially forever. A pass without a progress callback (images,
 * avatars: small) is never stopped.
 *
 * Deadline: a pass longer than `deadlineMs` lets the queue move on (that pass reports a timeout error, but GramJS's real download keeps running to the end):
 * GramJS has no client-side timeout, and a pass stuck on a dead sender used to block every image / sticker / avatar behind it.
 */

export type TelegramDownloadUrgency = 'background' | 'visible' | 'urgent';

export interface TelegramDownloadOptions {
  /** The conversation the file belongs to, given priority while it is open. Leave empty: not attached to any conversation. */
  threadId?: string;
  /** Default `background`. Requesting the same file again at a higher level raises the level. */
  urgency?: TelegramDownloadUrgency;
  /** Larger = downloads first within the same level (message time, ms). Default: the time it was queued. */
  sortKey?: number;
}

/** Parameters passed to the download operation. */
export interface TelegramDownloadRun {
  /** Called in GramJS's progress callback: records progress; throws TelegramDownloadPreempted when it has to yield. */
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
  /** The work of this pass has to yield. */
  forKey: string;
}

export interface TelegramDownloadQueueOptions {
  deadlineMs: number;
  /** Fewer than this many bytes left: finish the download, do not yield. */
  preemptMinRemainingBytes?: number;
  maxPreemptions?: number;
  now?: () => number;
  onPreempt?: (info: TelegramDownloadPreemptInfo) => void;
}

const URGENCY_LEVEL: Record<TelegramDownloadUrgency, number> = { background: 0, visible: 1, urgent: 2 };
/** Work at level 0–2 (user clicks, the open conversation) makes a running level 3–4 pass yield. */
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
  /** Asked the running pass to stop. */
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
      // The deadline of a download pass must never keep the process alive
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

  /** Negative = `a` (downloads first). */
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

  /** Pending work that the running pass must yield to, if any. */
  function yieldTo(queue: AccountQueue, running: Task): Task | null {
    if (running.preemptions >= maxPreemptions || rank(running) <= PREEMPTING_RANK) return null;
    // Size unknown (no chunk yet) / almost done → finish the download; the next chunk will check again.
    if (running.total <= 0 || running.total - running.downloaded < preemptMinRemainingBytes) return null;
    const index = bestPendingIndex(queue);
    const waiting = index < 0 ? null : queue.pending[index];
    return waiting && rank(waiting) <= PREEMPTING_RANK ? waiting : null;
  }

  /** Re-check the running pass: request a stop, or clear the stop request once its reason is gone (the same file was requested, the conversation changed…). */
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
      // Logging must never break the download queue
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
        // A pass that already timed out (the queue has moved on) can still report progress: let it finish as before.
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
          // Yield: back to the queue (keeps the promise, level, order); downloads again from the start when its turn comes
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

  /** File already in the queue (waiting / downloading) → raise its level and return that pass's promise; not there → undefined. */
  function promote(accountId: string, key: string, opts: TelegramDownloadOptions = {}): Promise<unknown> | undefined {
    const task = tasks.get(taskId(accountId, key));
    if (!task) return undefined;
    raise(task, opts);
    const queue = queues.get(accountId);
    if (queue) maybePreempt(queue);
    return task.promise;
  }

  /** Open conversation (reported by the renderer). None → drop the conversation priority. */
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
    /** Number of waiting + downloading passes of the account. */
    size: (accountId: string) => {
      const queue = queues.get(accountId);
      return queue ? queue.pending.length + (queue.running ? 1 : 0) : 0;
    },
    /** Keys of the waiting passes in the order they will be downloaded (tests / logs). */
    pendingKeys: (accountId: string) => [...(queues.get(accountId)?.pending ?? [])].sort(compare).map(task => task.key),
    runningKey: (accountId: string) => queues.get(accountId)?.running?.key ?? null,
  };
}

export type TelegramDownloadQueue = ReturnType<typeof createTelegramDownloadQueue>;
