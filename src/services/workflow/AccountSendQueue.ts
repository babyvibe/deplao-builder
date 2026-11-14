import Logger from '../../utils/Logger';

/**
 * AccountSendQueue - per-account FIFO queue for sending messages (zaloId).
 *
 * Problem: when many customers message the same Zalo account at the same time, the workflow auto-reply
 * runs in parallel and fires many api.sendMessage() calls almost at once → Zalo suspects spam → locks the account.
 *
 * Solution: every send goes through this queue. Tasks for the SAME account are chained one after another
 * (promise-chain), with a random min..max delay between 2 tasks. Different accounts run in parallel.
 *
 * A promise-chain is used instead of a token bucket (like CRMQueueService) because auto-reply is on-demand:
 * the task is already in RAM, so no dispatcher loop has to poll the DB → less code, no background CPU cost.
 */
class AccountSendQueue {
  private static instance: AccountSendQueue;
  /** Tail of each account's queue. New tasks are chained after this promise. */
  private tails: Map<string, Promise<unknown>> = new Map();

  public static getInstance(): AccountSendQueue {
    if (!AccountSendQueue.instance) AccountSendQueue.instance = new AccountSendQueue();
    return AccountSendQueue.instance;
  }

  /**
   * Queue a task on the account's queue. Returns the task's result promise so the caller can await it.
   * @param minMs/maxMs random wait range applied AFTER the task finishes, BEFORE the next task is released.
   *                    <=0 for both → no wait (backward compatible).
   */
  public enqueue<T>(accountId: string, task: () => Promise<T>, minMs = 0, maxMs = 0): Promise<T> {
    const key = accountId || '__default__';
    const prev = this.tails.get(key) ?? Promise.resolve();

    // Wait for the previous turn to finish (swallow its error so one failed task does not break the whole queue), then run this task.
    const result = prev.then(() => task(), () => task());

    // New tail: after this task finishes (success or failure), wait the delay to space it out from the next task.
    const tail = result
      .catch(() => { /* the task error is already returned to the caller via `result`; here we only keep the chain alive */ })
      .then(() => this.wait(minMs, maxMs))
      .finally(() => {
        // If no more tasks are chained → remove the entry so the Map does not grow without bound.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });

    this.tails.set(key, tail);
    return result;
  }

  /**
   * Resolves when the account's turns that are CURRENTLY queued finish, including the wait after the last turn (never rejects).
   * A bulk send waits on this before queuing the next recipient → auto-reply messages queued during that wait go first.
   */
  public whenIdle(accountId: string): Promise<void> {
    const tail = this.tails.get(accountId || '__default__');
    return tail ? tail.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private wait(minMs: number, maxMs: number): Promise<void> {
    const lo = Math.max(0, minMs);
    const hi = Math.max(lo, maxMs);
    if (hi <= 0) return Promise.resolve();
    const ms = lo + Math.random() * (hi - lo);
    Logger.log(`[AccountSendQueue] wait ${Math.round(ms)}ms before next send`);
    return new Promise(r => setTimeout(r, ms));
  }
}

export default AccountSendQueue;
