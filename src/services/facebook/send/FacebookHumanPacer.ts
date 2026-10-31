/**
 * Điều tốc tải lịch sử Facebook "giống người dùng thật" — tránh Facebook coi là bot và bắt xác minh (checkpoint).
 *
 * Một tài khoản = một bộ điều tốc (FacebookService giữ), dùng chung cho đồng bộ nền (popup) và tải khi cuộn / mở hội
 * thoại, nên mọi yêu cầu lịch sử của tài khoản cùng chịu một ngân sách:
 *  - Khoảng nghỉ ngẫu nhiên giữa các trang (phân phối log-normal quanh ~3,5 s, như người cuộn đọc), thỉnh thoảng
 *    dừng lâu hơn như đang đọc; chuyển hội thoại nghỉ 5–15 s; trang danh sách hội thoại 2–5 s.
 *  - Nghỉ giải lao: sau 30–50 trang nghỉ 1–2,5 phút; sau 250–350 trang nghỉ 6–12 phút.
 *  - Trần cứng: ≤ 10 trang / phút, ≤ 240 trang / giờ (cửa sổ trượt) — vượt thì chờ (nền) / báo bận (cuộn).
 *  - Facebook chậm / lỗi → giãn thêm (×1,6, tối đa ×4), ổn định lại thì giảm dần.
 *  - Lỗi có dấu hiệu bị chặn / checkpoint / phiên hết hạn → tạm dừng mọi yêu cầu lịch sử của tài khoản 30 phút.
 * Thuần (đồng hồ, ngẫu nhiên tiêm vào) — test: src/__tests__/facebook/facebookHumanPacer.test.ts.
 */

export type PacerWaitReason = 'pace' | 'reading' | 'thread' | 'list' | 'break' | 'long_break' | 'budget' | 'slowdown';

export interface PacerWait {
  ms: number;
  reason: PacerWaitReason;
}

export const HUMAN_HISTORY_PACING = {
  /** Giữa hai trang lịch sử khi đồng bộ nền: log-normal quanh trung vị, kẹp [min, max]. */
  page: { medianMs: 3_500, sigma: 0.35, minMs: 2_000, maxMs: 12_000 },
  /** Thỉnh thoảng dừng lâu hơn như đang đọc. */
  reading: { chance: 0.1, minMs: 6_000, maxMs: 15_000 },
  /** Chuyển sang hội thoại khác. */
  thread: { minMs: 5_000, maxMs: 15_000 },
  /** Giữa hai trang danh sách hội thoại. */
  list: { minMs: 2_000, maxMs: 5_000 },
  /** Tải khi người dùng cuộn / mở hội thoại. */
  interactive: { minMs: 1_200, maxMs: 2_800 },
  shortBreak: { everyMin: 30, everyMax: 50, minMs: 60_000, maxMs: 150_000 },
  longBreak: { everyMin: 250, everyMax: 350, minMs: 360_000, maxMs: 720_000 },
  perMinute: 10,
  perHour: 240,
  /** Facebook trả lời chậm hơn mức này → coi như đang bị bóp, giãn thêm. */
  slowResponseMs: 8_000,
  slowdownOnFailure: 1.6,
  slowdownOnSlow: 1.2,
  slowdownMax: 4,
  slowdownDecay: 0.9,
  riskCooldownMs: 30 * 60_000,
} as const;

export type HumanPacingProfile = typeof HUMAN_HISTORY_PACING;

/** Lỗi có dấu hiệu Facebook đang chặn / bắt xác minh / phiên hết hạn → dừng hẳn, không thử tiếp. */
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

  /** Log-normal (Box–Muller) quanh trung vị: phần lớn gần trung vị, thỉnh thoảng lâu hơn — như nhịp người thật. */
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

  /** Chờ tới khi ngân sách phút / giờ cho phép thêm một yêu cầu (0 = được ngay). */
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

  /** Còn bao lâu nữa mới được tải lịch sử (sau dấu hiệu bị chặn). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /** Thời gian chờ trước trang lịch sử kế tiếp khi đồng bộ nền. */
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

  /** Chuyển sang hội thoại kế tiếp (mở hội thoại khác như người dùng). */
  planThreadSwitch(): PacerWait {
    return { ms: Math.round(this.between(this.profile.thread.minMs, this.profile.thread.maxMs) * this.slowdown), reason: 'thread' };
  }

  /** Giữa hai trang danh sách hội thoại. */
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
   * Tải khi người dùng cuộn / mở hội thoại: chỉ giãn ngắn (vài giây). Hết ngân sách / đang tạm dừng → `busy`
   * (không bắt người dùng chờ cả phút; cuộn lại sau).
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

  /** Gọi ngay trước khi gửi một yêu cầu lịch sử / danh sách. */
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

  /** Kết quả một yêu cầu: lỗi / chậm → giãn thêm; dấu hiệu bị chặn → tạm dừng 30 phút ('risk'). */
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

  /** Hệ số giãn hiện tại (1 = bình thường). */
  currentSlowdown(): number {
    return this.slowdown;
  }
}

/** Ngủ `ms` nhưng dừng sớm khi `shouldStop()` (huỷ đồng bộ). Trả false nếu bị dừng. */
export async function sleepUnlessStopped(ms: number, shouldStop?: () => boolean, tickMs = 250): Promise<boolean> {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (shouldStop?.()) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(tickMs, Math.max(0, end - Date.now()))));
  }
  return !shouldStop?.();
}
