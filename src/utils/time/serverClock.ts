/**
 * Estimated server time (main process). Computer clocks often drift a few seconds from the standard time (the project owner's machine was 6.4 s fast
 * (measured with w32tm on 22/10/2026)). Received messages carry the server time, but messages sent from Deplao used to be stamped with the machine time, so
 * a customer who replied within a few seconds was sorted BEFORE the message just sent (Telegram Desktop compensates for the drift itself, so its order stays correct).
 *
 * Sent messages always use the server time the platform returns (Telegram `date`, Facebook `timestamp`); this module is the fallback when
 * the platform does not return one, and it writes to Logs when the machine clock drifts. The drift (server time − machine time) is learned only from MY sent messages that carry
 * a server time: sent at ≤ server time ≤ result received → an interval [lower bound, upper bound]; the intersection of the intervals from the last 15 minutes
 * is used. It is not learned from received messages: catch-up / reconnect messages arrive minutes late and would make the estimate wrong without any way to detect it.
 */
import Logger from '../Logger';

/** A drift larger than this is treated as bad unit data (seconds ↔ milliseconds) and ignored. */
const MAX_ABS_OFFSET_MS = 60 * 60_000;
const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 128;
/** A drift above this level is written to Logs (at most once every 6 hours). */
export const CLOCK_SKEW_WARN_MS = 2_000;
const WARN_INTERVAL_MS = 6 * 60 * 60_000;

interface Sample { at: number; lower: number; upper: number }

export interface ServerClock {
  /**
   * A message I sent that has a server time returned: sending started at `sentAt`, the result came back at `ackAt` (machine time); the server time, rounded
   * down to `precisionMs` (Telegram only has seconds → 1000).
   */
  noteSent(serverMs: number, sentAt: number, ackAt: number, precisionMs?: number): void;
  /** Drift of server time − machine time (ms); null when there is no sample yet. */
  offsetMs(): number | null;
  /** Estimated server time (ms); without a sample it is the machine time. */
  now(): number;
}

export function createServerClock(clock: () => number = () => Date.now()): ServerClock {
  let samples: Sample[] = [];
  let lastWarnAt = 0;

  const valid = (value: number) => Number.isFinite(value) && value > 0;

  /** Intersect the intervals still in the window; a new interval that contradicts the old intersection (the machine clock was just changed) → drop the old samples. */
  const bounds = (now: number): { lower: number; upper: number } | null => {
    samples = samples.filter(sample => now - sample.at <= WINDOW_MS);
    let lower = -Infinity;
    let upper = Infinity;
    for (let i = samples.length - 1; i >= 0; i--) {
      const nextLower = Math.max(lower, samples[i].lower);
      const nextUpper = Math.min(upper, samples[i].upper);
      if (nextLower > nextUpper) {
        samples = samples.slice(i + 1);
        break;
      }
      lower = nextLower;
      upper = nextUpper;
    }
    return samples.length ? { lower, upper } : null;
  };

  const estimate = (now: number): number | null => {
    const range = bounds(now);
    return range ? Math.round((range.lower + range.upper) / 2) : null;
  };

  return {
    noteSent(serverMs, sentAt, ackAt, precisionMs = 1) {
      if (!valid(serverMs) || !valid(sentAt) || !valid(ackAt) || ackAt < sentAt) return;
      const lower = serverMs - ackAt;
      const upper = serverMs + Math.max(1, precisionMs) - sentAt;
      if (Math.abs(lower) > MAX_ABS_OFFSET_MS || Math.abs(upper) > MAX_ABS_OFFSET_MS) return;
      samples.push({ at: ackAt, lower, upper });
      if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);

      const range = bounds(ackAt);
      if (!range) return;
      const offset = Math.round((range.lower + range.upper) / 2);
      // Only report when sure: the whole interval is off by more than the threshold (not just because the interval is still wide)
      const sure = Math.min(Math.abs(range.lower), Math.abs(range.upper)) >= CLOCK_SKEW_WARN_MS
        && Math.sign(range.lower) === Math.sign(range.upper);
      if (!sure || ackAt - lastWarnAt < WARN_INTERVAL_MS) return;
      lastWarnAt = ackAt;
      const seconds = (Math.abs(offset) / 1000).toFixed(1).replace('.', ',');
      Logger.warn(
        `[Đồng hồ] Đồng hồ máy tính đang ${offset < 0 ? 'nhanh' : 'chậm'} khoảng ${seconds} giây so với giờ server. `
        + 'Deplao ghi giờ tin nhắn theo giờ server; bật "Đặt giờ tự động" rồi bấm "Đồng bộ ngay" trong Cài đặt Windows '
        + '(Thời gian & ngôn ngữ → Ngày & giờ) để giờ hiển thị khớp các app khác trên máy.',
      );
    },
    offsetMs() {
      return estimate(clock());
    },
    now() {
      const now = clock();
      return now + (estimate(now) ?? 0);
    },
  };
}

/** The shared clock of the main process. */
export const serverClock = createServerClock();

/** Seconds (Telegram / Bot API `date`) → ms; invalid → null. */
export function secondsToMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 1e9 && n < 1e11 ? Math.floor(n) * 1000 : null;
}

/**
 * Server time (ms) of a Telegram message just sent, from the GramJS result: Api.Message.date, UpdateShortSentMessage.date, or the message
 * inside Updates (`updates[].message.date`). None → null.
 */
export function telegramSentDateMs(result: unknown): number | null {
  const value: any = result;
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const ms = telegramSentDateMs(item);
      if (ms) return ms;
    }
    return null;
  }
  if (Array.isArray(value.updates)) {
    for (const update of value.updates) {
      const ms = secondsToMs(update?.message?.date);
      if (ms) return ms;
    }
  }
  return secondsToMs(value.date);
}

/**
 * Stored timestamp for a Telegram message (user / bot) just sent: the server time in the result (also records the clock drift
 * when the send start time is known), or the estimated server time if there is none. The machine time is not used: if the machine is a few seconds fast,
 * a customer who replies right away would be sorted before this message.
 */
export function telegramSentTimestamp(result: unknown, sentAt?: number, ackAt: number = Date.now()): number {
  const serverMs = telegramSentDateMs(result);
  if (serverMs === null) return serverClock.now();
  if (sentAt) serverClock.noteSent(serverMs, sentAt, ackAt, 1000);
  return serverMs;
}
