/**
 * Bù tin Telegram sau khi máy thức dậy / mở khoá: từng tài khoản LẦN LƯỢT (tài khoản đang mở hội thoại trước), lượt sau
 * cách lượt trước vài giây. Trước đây mọi tài khoản cùng bù đầy đủ một lúc (GetDifference, lịch sử kênh, đồng bộ lại
 * hội thoại) đúng lúc Windows đang nạp lại bộ nhớ từ ổ đĩa → app đơ. Việc bù tin của từng tài khoản không đổi, chỉ đổi
 * lúc bắt đầu.
 *
 * Ngoài khoảng sau khi thức dậy (windowMs) mà không còn ai chờ: chạy ngay như cũ. Một lượt bù quá maxTurnMs thì tài
 * khoản kế không chờ nữa (lượt dài vẫn chạy tiếp).
 */

export const RESUME_TURN_WINDOW_MS = 5 * 60_000;
export const RESUME_TURN_GAP_MS = 3_000;
export const RESUME_TURN_MAX_MS = 60_000;

export interface ResumeTurns {
  /** Máy vừa thức dậy / mở khoá: các lượt bù tin trong windowMs tới chạy lần lượt. */
  noteWake(at?: number): void;
  /** Chờ tới lượt của tài khoản; trả hàm nhả lượt (gọi khi bù xong; gọi lại không sao). */
  turn(accountId: string): Promise<() => void>;
  /** Số tài khoản đang chờ lượt. */
  waiting(): number;
}

type Timer = unknown;

export function createResumeTurns(opts: {
  /** Tài khoản có hội thoại Telegram đang mở (lên trước). */
  focusedAccount: () => string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  windowMs?: number;
  gapMs?: number;
  maxTurnMs?: number;
}): ResumeTurns {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as any)?.unref?.();
    return t;
  });
  const clearTimer = opts.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const windowMs = opts.windowMs ?? RESUME_TURN_WINDOW_MS;
  const gapMs = opts.gapMs ?? RESUME_TURN_GAP_MS;
  const maxTurnMs = opts.maxTurnMs ?? RESUME_TURN_MAX_MS;

  let windowUntil = 0;
  let nextAt = 0;
  let holder: { release: () => void } | null = null;
  let pumpTimer: Timer | null = null;
  const queue: Array<{ accountId: string; grant: (release: () => void) => void }> = [];
  const noop = () => undefined;

  const pump = (): void => {
    if (holder || !queue.length || pumpTimer) return;
    const wait = nextAt - now();
    if (wait > 0) {
      pumpTimer = setTimer(() => {
        pumpTimer = null;
        pump();
      }, wait);
      return;
    }
    const focused = opts.focusedAccount();
    const idx = focused ? queue.findIndex(w => w.accountId === focused) : -1;
    const [next] = queue.splice(idx >= 0 ? idx : 0, 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimer(maxTimer);
      if (holder === current) holder = null;
      nextAt = now() + gapMs;
      pump();
    };
    const current = { release };
    holder = current;
    const maxTimer = setTimer(release, maxTurnMs);
    next.grant(release);
  };

  return {
    noteWake(at = now()) {
      windowUntil = Math.max(windowUntil, at + windowMs);
    },
    turn(accountId: string) {
      if (now() >= windowUntil && !holder && !queue.length) return Promise.resolve(noop);
      return new Promise<() => void>(resolve => {
        queue.push({ accountId: String(accountId), grant: resolve });
        pump();
      });
    },
    waiting: () => queue.length,
  };
}
