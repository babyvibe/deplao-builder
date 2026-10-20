/**
 * Mốc "app đã ổn định" sau khi mở app (main process): giao diện đã tải xong danh sách hội thoại (renderer gửi
 * app:uiSettled) và luồng chính hết bận. Việc nền nặng — đồng bộ bù / tải lại tin nhắn cũ của Telegram, quét danh sách
 * hội thoại, khôi phục hàng đợi kênh… — chờ mốc này: chạy ngay lúc mở app tranh CPU / IPC với lúc giao diện đang dựng
 * nên app giật. Tin mới đến trực tiếp (socket) không phải chờ.
 *
 * Renderer không báo (lỗi, cửa sổ chưa tải…) → tự mở sau armStartupSettleFallback. Đã mở thì giữ mở cả phiên (kết nối lại
 * giữa chừng không phải chờ nữa).
 */
import Logger from './Logger';

type SettledTask = () => void;

let settled = false;
let waiting: SettledTask[] = [];
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let idleWatchStarted = false;

export function isStartupSettled(): boolean {
  return settled;
}

/** Chạy `task` khi app đã ổn định (ngay lập tức nếu đã ổn định). */
export function whenStartupSettled(task: SettledTask): void {
  if (settled) {
    task();
    return;
  }
  waiting.push(task);
}

export function markStartupSettled(reason: string): void {
  if (settled) return;
  settled = true;
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  const tasks = waiting;
  waiting = [];
  Logger.log(`[startup] App settled (${reason}); starting ${tasks.length} deferred background task(s)`);
  for (const task of tasks) {
    try {
      task();
    } catch (err: any) {
      Logger.warn(`[startup] Deferred task failed: ${err?.message || err}`);
    }
  }
}

/** Lưới an toàn: renderer không báo giao diện đã tải xong trong `ms` → vẫn mở mốc. */
export function armStartupSettleFallback(ms: number): void {
  if (settled || fallbackTimer) return;
  fallbackTimer = setTimeout(() => markStartupSettled('fallback'), ms);
  (fallbackTimer as any).unref?.();
}

const IDLE_SAMPLE_MS = 250;
const IDLE_MAX_LAG_MS = 40;
const IDLE_CALM_SAMPLES = 4;

/**
 * Giao diện đã tải xong: mở mốc khi luồng chính cũng rảnh (độ trễ hẹn giờ < 40ms trong 4 lần đo liên tiếp, sau tối
 * thiểu `minDelayMs`) — đăng nhập Zalo / Facebook lúc khởi động có thể vẫn đang chạy. Chờ tối đa `maxWaitMs`.
 */
export function settleWhenMainIdle(reason: string, opts: { minDelayMs?: number; maxWaitMs?: number } = {}): void {
  if (settled || idleWatchStarted) return;
  idleWatchStarted = true;
  const minDelayMs = opts.minDelayMs ?? 2_000;
  const maxWaitMs = opts.maxWaitMs ?? 20_000;
  const startedAt = Date.now();
  let calm = 0;
  let expectedAt = startedAt + IDLE_SAMPLE_MS;
  const sample = () => {
    if (settled) return;
    const now = Date.now();
    calm = now - expectedAt < IDLE_MAX_LAG_MS ? calm + 1 : 0;
    const elapsed = now - startedAt;
    if ((elapsed >= minDelayMs && calm >= IDLE_CALM_SAMPLES) || elapsed >= maxWaitMs) {
      markStartupSettled(elapsed >= maxWaitMs && calm < IDLE_CALM_SAMPLES ? `${reason}, main still busy` : reason);
      return;
    }
    expectedAt = now + IDLE_SAMPLE_MS;
    const timer = setTimeout(sample, IDLE_SAMPLE_MS);
    (timer as any).unref?.();
  };
  const timer = setTimeout(sample, IDLE_SAMPLE_MS);
  (timer as any).unref?.();
}

/** Chỉ cho test. */
export function __resetStartupSettleForTests(): void {
  settled = false;
  waiting = [];
  idleWatchStarted = false;
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}
