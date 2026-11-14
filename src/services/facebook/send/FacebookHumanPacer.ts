/**
 * Throttles Facebook history loading "like a real user" to keep Facebook from treating the account as a bot and asking for verification (checkpoint).
 *
 * One account = one pacer (kept by FacebookService), shared by background sync (popup) and loading on scroll / when opening a
 * conversation, so every history request for the account draws on the same budget:
 *  - Random pauses between pages (log-normal distribution around ~3.5 s, like someone scrolling and reading), occasionally pausing longer
 *    as if reading; switching conversations pauses 5-15 s; conversation-list pages 2-5 s.
 *  - Rest breaks: after 30-50 pages rest 1-2.5 min; after 250-350 pages rest 6-12 min.
 *  - Hard caps: ≤ 10 pages / min, ≤ 240 pages / hour (sliding window); when exceeded, wait (background) or report busy (scroll).
 *  - Facebook slow / errors → slow down further (×1.6, max ×4), then gradually speed back up.
 *  - Errors that look like blocking / checkpoint / expired session → pause all history requests for the account for 30 minutes.
 * Pure logic (clock and randomness injected). Test: src/__tests__/facebook/facebookHumanPacer.test.ts.
 */

export type PacerWaitReason = 'pace' | 'reading' | 'thread' | 'list' | 'break' | 'long_break' | 'budget' | 'slowdown';

export interface PacerWait {
  ms: number;
  reason: PacerWaitReason;
}

export const HUMAN_HISTORY_PACING = {
  /** Between two history pages during background sync: log-normal around the median, clamped to [min, max]. */
  page: { medianMs: 3_500, sigma: 0.35, minMs: 2_000, maxMs: 12_000 },
  /** Occasionally pause longer, as if reading. */
  reading: { chance: 0.1, minMs: 6_000, maxMs: 15_000 },
  /** Switching to another conversation. */
  thread: { minMs: 5_000, maxMs: 15_000 },
  /** Between two conversation-list pages. */
  list: { minMs: 2_000, maxMs: 5_000 },
  /** Loading when the user scrolls / opens a conversation. */
  interactive: { minMs: 1_200, maxMs: 2_800 },
  shortBreak: { everyMin: 30, everyMax: 50, minMs: 60_000, maxMs: 150_000 },
  longBreak: { everyMin: 250, everyMax: 350, minMs: 360_000, maxMs: 720_000 },
  perMinute: 10,
  perHour: 240,
  /** If Facebook answers slower than this, treat it as being throttled and slow down further. */
  slowResponseMs: 8_000,
  slowdownOnFailure: 1.6,
  slowdownOnSlow: 1.2,
  slowdownMax: 4,
  slowdownDecay: 0.9,
  riskCooldownMs: 30 * 60_000,
} as const;

export type HumanPacingProfile = typeof HUMAN_HISTORY_PACING;

/** Errors that look like Facebook is blocking / requiring verification / session expired → stop completely, do not retry. */
const RISK_PATTERN = /checkpoint|1357001|1357004|1390008|login_required|not logged in|unauthori[sz]ed|account (?:is )?(?:locked|suspended|disabled|restricted)|rate.?limit|too many requests|temporarily (?:blocked|restricted)|try again later|spam|feature (?:is )?(?:temporarily )?(?:blocked|unavailable)/i;

export function isFacebookRiskError(message: unknown): boolean {
  return RISK_PATTERN.test(String(message ?? ''));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class FacebookHumanPacer {
  private requestTimes: number[] = [];
  private lastRequestAt = 0;
  private pagesSinceShortBreak = 0;
  private pagesSinceLongBreak = 0;
  private nextShortBreakAt: number;
  private nextLongBreakAt: number;
  private slowdown = 1;
  private cooldownUntil = 0;

  constructor(
    private readonly profile: HumanPacingProfile = HUMAN_HISTORY_PACING,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.nextShortBreakAt = this.between(profile.shortBreak.everyMin, profile.shortBreak.everyMax);
    this.nextLongBreakAt = this.between(profile.longBreak.everyMin, profile.longBreak.everyMax);
  }

  private between(min: number, max: number): number {
    return Math.round(min + (max - min) * this.random());
  }

  /** Log-normal (Box-Muller) around the median: mostly close to the median, sometimes longer, like a real person's rhythm. */
  private humanGap(): number {
    const { medianMs, sigma, minMs, maxMs } = this.profile.page;
    const u1 = Math.max(this.random(), 1e-9);
    const u2 = this.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(maxMs, Math.max(minMs, medianMs * Math.exp(sigma * normal)));
  }

  private prune(now: number): void {
    while (this.requestTimes.length && this.requestTimes[0] <= now - HOUR) this.requestTimes.shift();
  }

  /** Wait until the minute / hour budget allows another request (0 = allowed immediately). */
  private budgetWait(now: number): number {
    this.prune(now);
    let wait = 0;
    if (this.requestTimes.length >= this.profile.perHour) {
      wait = Math.max(wait, this.requestTimes[this.requestTimes.length - this.profile.perHour] + HOUR - now);
    }
    const lastMinute = this.requestTimes.filter(t => t > now - MINUTE);
    if (lastMinute.length >= this.profile.perMinute) {
      wait = Math.max(wait, lastMinute[lastMinute.length - this.profile.perMinute] + MINUTE - now);
    }
    return Math.max(0, Math.ceil(wait));
  }

  /** How much longer until history can be loaded again (after a sign of blocking). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /** Wait time before the next history page during background sync. */
  planBackgroundPage(): PacerWait {
    const now = this.now();
    if (this.pagesSinceLongBreak >= this.nextLongBreakAt) {
      this.pagesSinceLongBreak = 0;
      this.pagesSinceShortBreak = 0;
      this.nextLongBreakAt = this.between(this.profile.longBreak.everyMin, this.profile.longBreak.everyMax);
      return { ms: this.between(this.profile.longBreak.minMs, this.profile.longBreak.maxMs), reason: 'long_break' };
    }
    if (this.pagesSinceShortBreak >= this.nextShortBreakAt) {
      this.pagesSinceShortBreak = 0;
      this.nextShortBreakAt = this.between(this.profile.shortBreak.everyMin, this.profile.shortBreak.everyMax);
      return { ms: this.between(this.profile.shortBreak.minMs, this.profile.shortBreak.maxMs), reason: 'break' };
    }
    let reason: PacerWaitReason = this.slowdown > 1.05 ? 'slowdown' : 'pace';
    let gap = this.humanGap() * this.slowdown;
    if (this.random() < this.profile.reading.chance) {
      gap += this.between(this.profile.reading.minMs, this.profile.reading.maxMs);
      reason = 'reading';
    }
    const sinceLast = this.lastRequestAt ? now - this.lastRequestAt : Infinity;
    let wait = Math.max(0, Math.round(gap - sinceLast));
    const budget = this.budgetWait(now);
    if (budget > wait) {
      wait = budget + this.between(500, 3_000);
      reason = 'budget';
    }
    return { ms: wait, reason };
  }

  /** Switch to the next conversation (open another conversation like a user). */
  planThreadSwitch(): PacerWait {
    return { ms: Math.round(this.between(this.profile.thread.minMs, this.profile.thread.maxMs) * this.slowdown), reason: 'thread' };
  }

  /** Between two conversation-list pages. */
  planListPage(): PacerWait {
    const now = this.now();
    let wait = Math.round(this.between(this.profile.list.minMs, this.profile.list.maxMs) * this.slowdown);
    let reason: PacerWaitReason = 'list';
    const budget = this.budgetWait(now);
    if (budget > wait) {
      wait = budget + this.between(500, 3_000);
      reason = 'budget';
    }
    return { ms: wait, reason };
  }

  /**
   * Loading when the user scrolls / opens a conversation: only a short delay (a few seconds). When the budget is used up / paused → `busy`
   * (the user is not made to wait a full minute; scroll again later).
   */
  planInteractivePage(): PacerWait | { busy: true; retryInMs: number } {
    const now = this.now();
    const cooldown = this.cooldownRemaining();
    if (cooldown > 0) return { busy: true, retryInMs: cooldown };
    const budget = this.budgetWait(now);
    if (budget > 0) return { busy: true, retryInMs: budget };
    const gap = this.between(this.profile.interactive.minMs, this.profile.interactive.maxMs) * this.slowdown;
    const sinceLast = this.lastRequestAt ? now - this.lastRequestAt : Infinity;
    return { ms: Math.max(0, Math.round(gap - sinceLast)), reason: 'pace' };
  }

  /** Called right before sending a history / list request. */
  recordRequest(countsAsPage = true): void {
    const now = this.now();
    this.lastRequestAt = now;
    this.requestTimes.push(now);
    this.prune(now);
    if (countsAsPage) {
      this.pagesSinceShortBreak += 1;
      this.pagesSinceLongBreak += 1;
    }
  }

  /** Result of a request: errors / slowness → slow down further; signs of blocking → pause 30 minutes ('risk'). */
  recordResult(ok: boolean, latencyMs: number, error?: unknown): 'ok' | 'risk' {
    if (!ok && isFacebookRiskError(error)) {
      this.cooldownUntil = this.now() + this.profile.riskCooldownMs;
      this.slowdown = this.profile.slowdownMax;
      return 'risk';
    }
    if (!ok) {
      this.slowdown = Math.min(this.profile.slowdownMax, this.slowdown * this.profile.slowdownOnFailure);
    } else if (latencyMs > this.profile.slowResponseMs) {
      this.slowdown = Math.min(this.profile.slowdownMax, this.slowdown * this.profile.slowdownOnSlow);
    } else {
      this.slowdown = Math.max(1, this.slowdown * this.profile.slowdownDecay);
    }
    return 'ok';
  }

  /** Current slowdown factor (1 = normal). */
  currentSlowdown(): number {
    return this.slowdown;
  }
}

/** Sleep for `ms` but stop early when `shouldStop()` returns true (sync cancelled). Returns false if it was stopped. */
export async function sleepUnlessStopped(ms: number, shouldStop?: () => boolean, tickMs = 250): Promise<boolean> {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (shouldStop?.()) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(tickMs, Math.max(0, end - Date.now()))));
  }
  return !shouldStop?.();
}
