/**
 * Reconnect the Zalo websocket like Zalo Web: zca-js `listener.start({ retryOnClose: true })` (zca-js#386). When Zalo PC
 * logs in / logs out, it closes the connection of Zalo Web and zca-js. Zalo Web reconnects right away on the same session, whereas Deplao used to wait
 * 5 s and then log the whole session in again with cookies (up to 5 times, then gave up).
 *
 * zca-js retries by itself according to the config Zalo sends (`settings.features.socket.close_and_retry_codes` + `retries`): the connection
 * closes → "disconnected" → (for a code that is retried) schedules `start()` again; when the attempts run out or the code is not retried → "closed". It does not change
 * zca-js; it only attaches to the listener object itself:
 * - `canRetry`: only allows a retry while Deplao still uses this listener (not disconnected manually, account not deleted, connection not replaced by
 *   a new login). Otherwise zca-js emits "closed" as before.
 * - `start`: a retry already scheduled is dropped when the connection is disconnected / replaced, so the old listener does not reconnect (messages would arrive twice).
 * - When it reconnects successfully, the retry attempts are restored (zca-js never counts them again, so a long session would run out of attempts).
 */
import { tr } from '../../shared/i18n';

export interface ZaloListenerRetryGuard {
  /** Reconnected: restore the retry attempts for every close code. */
  resetRetryBudget(): void;
}

export function installZaloListenerRetryGuard(listener: any, options: {
  /** Whether Deplao still uses this listener */
  allowRetry: () => boolean;
  /** Retry blocked (old listener) */
  onBlocked?: () => void;
}): ZaloListenerRetryGuard {
  const originalCanRetry = listener?.canRetry;
  const originalStart = listener?.start;
  if (typeof originalCanRetry === 'function') {
    listener.canRetry = function guardedCanRetry(this: any, code: number) {
      if (!options.allowRetry()) return false;
      return originalCanRetry.call(this, code);
    };
  }
  if (typeof originalStart === 'function') {
    let started = false;
    listener.start = function guardedStart(this: any, ...args: any[]) {
      // The first attempt is made by Deplao; later attempts are retried by zca-js itself
      if (started && !options.allowRetry()) {
        options.onBlocked?.();
        return undefined;
      }
      started = true;
      return originalStart.apply(this, args);
    };
  }
  return {
    resetRetryBudget() {
      const counts = listener?.retryCount;
      if (!counts || typeof counts !== 'object') return;
      for (const key of Object.keys(counts)) {
        if (counts[key] && typeof counts[key].count === 'number') counts[key].count = 0;
      }
    },
  };
}

/** Close code, retry attempts, and the wait time Zalo configured for this session (logged, so you can see which codes reconnect by themselves). */
export function describeZaloSocketRetry(api: any): string {
  try {
    const socket = api?.getContext?.()?.settings?.features?.socket;
    if (!socket) return tr('không có cấu hình socket');
    const codes = Array.isArray(socket.close_and_retry_codes) ? socket.close_and_retry_codes.join(',') : '-';
    const retries = socket.retries && typeof socket.retries === 'object'
      ? Object.entries(socket.retries).map(([code, value]: [string, any]) => {
        const times = Array.isArray(value?.times) ? value.times.join('/') : value?.times;
        return `${code}:${value?.max ?? 0}x(${times ?? '-'}ms)`;
      }).join(' ')
      : '-';
    return `close_and_retry_codes=[${codes}] retries=${retries}`;
  } catch {
    return tr('không đọc được cấu hình socket');
  }
}
