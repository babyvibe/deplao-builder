/**
 * Chiến dịch CRM tự dừng khi lỗi liên tiếp (cài ở từng chiến dịch, Zalo + Telegram; mặc định không dừng). Tài khoản bị
 * chặn / giới hạn gửi tin / mất phiên thì liên hệ nào cũng gửi lỗi — trước đây chiến dịch cứ thế chạy hết danh sách, đánh
 * dấu lỗi cả nghìn liên hệ (chiến dịch gửi thành viên nhóm quét được, toàn người lạ, dễ bị giới hạn nhất).
 *
 * Đếm theo liên hệ (CRMQueueService.trackFailureStreak): gửi lỗi / không tìm thấy SĐT trên Zalo +1; gửi được (kể cả lỗi
 * một phần của chiến dịch Hỗn hợp) về 0; người nhận "phone:…" ở kênh không tra SĐT (không gọi tới nền tảng) không đổi.
 * Đủ N → chiến dịch sang Tạm dừng, lưu lý do + lỗi cuối (hiện ở màn chiến dịch); bấm Tiếp tục thì đếm lại từ 0. Đủ giới
 * hạn ngày KHÔNG phải lỗi: chiến dịch chờ sang hôm sau như cũ, không dừng.
 *
 * Hai tuỳ chọn (chỉ có nghĩa khi N > 0):
 *  - "Chỉ tính người lạ" (Zalo): Zalo chặn spam theo tin nhắn cho người lạ, nhắn bạn bè / nhóm vẫn được → bạn bè và nhóm
 *    gửi được hay lỗi đều không đổi chuỗi (không thì một bạn bè gửi được xen giữa là đếm lại, không bao giờ dừng).
 *  - "Mai gửi tiếp": Zalo mở chặn sau một ngày → tự dừng tới Giờ bắt đầu chạy hôm sau rồi tự gửi tiếp
 *    (CRMQueueService.scheduleAutoResume); bấm Tiếp tục để gửi ngay.
 */

/** Mốc chọn được (liên hệ lỗi liên tiếp); 0 = không tự dừng. */
export const CAMPAIGN_STOP_AFTER_FAILURES_CHOICES: readonly number[] = [0, 3, 5, 10, 20];
export const MAX_CAMPAIGN_STOP_AFTER_FAILURES = 100;

/** Giá trị lưu được: số nguyên 0..100 (lạ / âm → 0 = không dừng). */
export function normalizeStopAfterFailures(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_CAMPAIGN_STOP_AFTER_FAILURES);
}

/** Cờ bật / tắt lưu trong DB (0 / 1): true, 1, '1' → 1. */
export function campaignFlag(value: unknown): 0 | 1 {
  return value === true || Number(value) === 1 ? 1 : 0;
}

/** Đủ số lỗi liên tiếp để tự dừng chưa. */
export function shouldAutoStopCampaign(consecutiveFailures: number, stopAfterFailures: unknown): boolean {
  const limit = normalizeStopAfterFailures(stopAfterFailures);
  return limit > 0 && consecutiveFailures >= limit;
}

function startTimeOf(dailyStartTime?: string | null): [number, number] {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(dailyStartTime || '').trim());
  const hours = match ? Number(match[1]) : 8;
  const minutes = match ? Number(match[2]) : 0;
  return hours <= 23 && minutes <= 59 ? [hours, minutes] : [8, 0];
}

/** "Mai gửi tiếp": ngày hôm sau (giờ máy) lúc Giờ bắt đầu chạy của chiến dịch (mặc định 08:00). */
export function campaignAutoResumeAt(stoppedAt: number, dailyStartTime?: string | null): number {
  const [hours, minutes] = startTimeOf(dailyStartTime);
  const day = new Date(stoppedAt);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, hours, minutes, 0, 0).getTime();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "08:00 · 05/11" (giờ máy). */
export function formatAutoResumeAt(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())} · ${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`;
}

const MAX_ERROR_TEXT = 160;

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** "5 liên hệ lỗi liên tiếp" / "5 người lạ lỗi liên tiếp". */
function failuresText(failures: number, strangersOnly?: unknown): string {
  return `${failures} ${strangersOnly ? 'người lạ' : 'liên hệ'} lỗi liên tiếp`;
}

/** Lý do lưu cùng chiến dịch + hiện ở màn chiến dịch: "5 liên hệ lỗi liên tiếp (lỗi cuối: …)". */
export function campaignAutoStopReason(failures: number, lastError?: string, opts: { strangersOnly?: boolean } = {}): string {
  const error = oneLine(lastError);
  const shortError = error.length > MAX_ERROR_TEXT ? `${error.slice(0, MAX_ERROR_TEXT - 1)}…` : error;
  return `${failuresText(failures, opts.strangersOnly)}${shortError ? ` (lỗi cuối: ${shortError})` : ''}`;
}

/** Nhãn cài đặt ở màn chiến dịch: "Tự dừng khi 5 người lạ lỗi liên tiếp, mai gửi tiếp" / "Không tự dừng khi lỗi". */
export function stopAfterFailuresLabel(value: unknown, opts: { strangersOnly?: unknown; resumeNextDay?: unknown } = {}): string {
  const limit = normalizeStopAfterFailures(value);
  if (limit <= 0) return 'Không tự dừng khi lỗi';
  const who = campaignFlag(opts.strangersOnly) ? 'người lạ ' : '';
  return `Tự dừng khi ${limit} ${who}lỗi liên tiếp${campaignFlag(opts.resumeNextDay) ? ', mai gửi tiếp' : ''}`;
}

/** Thông báo khi chiến dịch tự dừng: thông báo nổi trong app (`toast`) / popup hệ điều hành (`title` + `body`). */
export function campaignAutoStopNotice(input: {
  name?: unknown; accountName?: unknown; failures?: unknown; strangersOnly?: unknown; resumeAt?: unknown;
}): { title: string; body: string; toast: string } {
  const name = oneLine(input.name);
  const account = oneLine(input.accountName);
  const failures = Math.max(1, Math.round(Number(input.failures) || 0));
  const resumeAt = Number(input.resumeAt) || 0;
  const campaign = name ? `Chiến dịch "${name}"` : 'Chiến dịch';
  const what = failuresText(failures, input.strangersOnly);
  const resume = resumeAt > 0 ? formatAutoResumeAt(resumeAt) : '';
  return {
    title: `⏸ ${campaign} đã tự dừng`,
    body: `${account ? `${account}: ` : ''}${what}. ${resume ? `Tự gửi tiếp lúc ${resume}.` : 'Kiểm tra tài khoản rồi bấm Tiếp tục.'}`,
    // Thông báo nổi kiểu "Cảnh báo" đã có biểu tượng riêng
    toast: `${campaign}${account ? ` (${account})` : ''} đã tự dừng: ${what}${resume ? `, gửi tiếp lúc ${resume}` : ''}`,
  };
}
