/**
 * Ảnh Zalo chỉ có link (máy Boss chưa lưu): nhờ máy Boss tải về bằng phiên của tài khoản (file:ensureMessageImage — máy
 * nhân viên chuyển lên Boss) rồi đổi sang bản đã lưu, để link Zalo hết hạn vẫn còn ảnh. Máy nhân viên không có cookie
 * Zalo nên chỉ đọc được ảnh qua Boss (/api/media).
 *
 * Boss chỉ tự tải ảnh lúc nhận tin; tin đồng bộ lịch sử (Boss tắt máy lúc nhận), đồng bộ từ điện thoại, lần tải lỗi thì
 * không có bản trên máy. Trước đây máy nhân viên hiện thẳng link Zalo cho các ảnh đó, link hết hạn là mất ảnh.
 *
 * - Hàng đợi chung: tối đa ENSURE_CONCURRENCY yêu cầu cùng lúc (mở hội thoại nhiều ảnh không dồn cả loạt lên Boss / CDN).
 * - Mỗi tin một lần mỗi phiên (thành công / hết hạn / không phải ảnh); lỗi tạm (mất kết nối Boss, mạng) thử lại sau
 *   ENSURE_RETRY_AFTER_MS. `force` (bấm Thử tải lại) hỏi lại ngay.
 * - Có đường dẫn mới → ghi vào store: bong bóng của tin vẽ lại bằng bản đã lưu.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';

export interface EnsureImageResult {
  success: boolean;
  /** Đường dẫn trên máy Boss (local_paths.main) */
  newLocalPath?: string;
  expired?: boolean;
  /** Boss đã có sẵn file, không tải lại */
  cached?: boolean;
  error?: string;
  code?: string;
}

export const ENSURE_CONCURRENCY = 2;
/** Tin vừa nhận: Boss đang tự tải ảnh (lúc nhận tin, thử lại sau 20 s) — chờ chừng này rồi mới nhờ tải. */
export const ENSURE_MIN_AGE_MS = 90_000;
/** Lỗi tạm (mất kết nối Boss, CDN chập chờn): sau chừng này mới hỏi lại cho cùng tin. */
export const ENSURE_RETRY_AFTER_MS = 60_000;
/** Vừa mở hội thoại: nhường việc tải tin / vẽ khung chat trước. */
export const ENSURE_OPEN_DELAY_MS = 1_500;

/**
 * Lỗi không đổi khi hỏi lại — nhớ cả phiên như thành công: tin không phải ảnh Zalo / không có link (imageRepair), Boss từ
 * chối (không được giao tài khoản, không có quyền chat, Boss bản cũ chưa có kênh này — proxyActionPolicy).
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND', 'NOT_ZALO_IMAGE', 'NO_IMAGE_URL', 'ACCOUNT_FORBIDDEN', 'MODULE_FORBIDDEN', 'CHANNEL_FORBIDDEN',
]);

const settled = new Map<string, { result: EnsureImageResult; at: number }>();
const inFlight = new Map<string, Promise<EnsureImageResult>>();
const queue: Array<() => Promise<void>> = [];
let running = 0;

function pump(): void {
  while (running < ENSURE_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function currentMainPath(msg: any): string {
  try {
    const lp = typeof msg?.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg?.local_paths || {});
    return String(lp?.main || lp?.hd || '');
  } catch {
    return '';
  }
}

function remembered(key: string, now: number): EnsureImageResult | null {
  const entry = settled.get(key);
  if (!entry) return null;
  const { result } = entry;
  const permanent = result.success || result.expired || PERMANENT_CODES.has(String(result.code || ''));
  if (permanent || now - entry.at < ENSURE_RETRY_AFTER_MS) return result;
  settled.delete(key);
  return null;
}

/**
 * Ảnh của tin `msg` (Zalo) phải có trên máy Boss. Trả đường dẫn của Boss (`newLocalPath`) khi đã có / vừa tải xong,
 * `expired` khi Zalo không còn lưu ảnh. Đường dẫn khác bản đang có trong tin → cập nhật store.
 */
export function ensureMessageImage(msg: any, opts: { force?: boolean } = {}): Promise<EnsureImageResult> {
  const zaloId = String(msg?.owner_zalo_id || '');
  const msgId = String(msg?.msg_id || '');
  const threadId = String(msg?.thread_id || '');
  if (!zaloId || !msgId) return Promise.resolve({ success: false, error: 'Thiếu thông tin tin nhắn' });
  const key = `${zaloId}:${msgId}`;
  if (!opts.force) {
    const done = remembered(key, Date.now());
    if (done) return Promise.resolve(done);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = new Promise<EnsureImageResult>((resolve) => {
    queue.push(async () => {
      let result: EnsureImageResult;
      try {
        result = (await ipc.file?.ensureMessageImage?.({
          zaloId, msgId, threadId: threadId || undefined, force: !!opts.force,
        })) || { success: false, error: 'Không gọi được tiến trình chính' };
      } catch (err: any) {
        result = { success: false, error: err?.message || String(err) };
      }
      resolve(result);
    });
    pump();
  }).then((result) => {
    inFlight.delete(key);
    settled.set(key, { result, at: Date.now() });
    if (result.success && result.newLocalPath && threadId && result.newLocalPath !== currentMainPath(msg)) {
      useChatStore.getState().updateMessageLocalPath(zaloId, threadId, msgId, { main: result.newLocalPath });
    }
    return result;
  });
  inFlight.set(key, task);
  return task;
}

/**
 * Bong bóng ảnh: ảnh chỉ có link Zalo (`enabled`) → ensureMessageImage sau ENSURE_OPEN_DELAY_MS, tin vừa nhận thì đợi đủ
 * ENSURE_MIN_AGE_MS (Boss đang tự tải lúc nhận tin). Tin đã có bản lưu / bong bóng gỡ khỏi màn hình → huỷ hẹn giờ.
 */
export function useEnsureMessageImage(msg: any, enabled: boolean): void {
  const msgRef = React.useRef(msg);
  msgRef.current = msg;
  const msgId = String(msg?.msg_id || '');
  const receivedAt = Number(msg?.timestamp) || 0;
  React.useEffect(() => {
    if (!enabled || !msgId) return undefined;
    const wait = Math.max(ENSURE_OPEN_DELAY_MS, ENSURE_MIN_AGE_MS - (Date.now() - receivedAt));
    const timer = window.setTimeout(() => { void ensureMessageImage(msgRef.current); }, wait);
    return () => window.clearTimeout(timer);
  }, [enabled, msgId, receivedAt]);
}

/** Chỉ dùng trong test. */
export function __resetEnsureMessageImage(): void {
  settled.clear();
  inFlight.clear();
  queue.length = 0;
  running = 0;
}
