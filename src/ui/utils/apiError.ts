/**
 * apiError.ts — Shared API error handling utility
 *
 * Dùng chung cho toàn bộ hệ thống để:
 * 1. Extract thông báo lỗi từ IPC response (success: false, error, errorCode, message...)
 * 2. Wrap IPC call và tự throw nếu thất bại
 * 3. Chạy IPC call + tự show notification lỗi qua appStore
 */

import { useAppStore } from '../store/appStore';

// ─── Extract error message from IPC response ──────────────────────────────────

/** Lấy message lỗi dạng string từ bất kỳ IPC response/Error nào */
export function extractApiError(res: any, fallback = 'Lỗi không xác định'): string {
  if (!res) return fallback;
  if (typeof res === 'string') return res;
  if (res instanceof Error) return res.message || fallback;
  if (typeof res === 'object') {
    // Thứ tự ưu tiên: error > message > errorMessage > errorCode
    if (res.error && typeof res.error === 'string' && res.error.trim()) return res.error;
    if (res.error && typeof res.error === 'object') return extractApiError(res.error, fallback);
    if (res.message && typeof res.message === 'string' && res.message.trim()) return res.message;
    if (res.errorMessage) return String(res.errorMessage);
    if (res.errorCode != null) return `Lỗi ${res.errorCode}`;
  }
  return fallback;
}

/** Kiểm tra xem response có phải lỗi không */
export function isApiError(res: any): boolean {
  if (!res) return true;
  if (typeof res === 'object' && 'success' in res) return res.success === false;
  return false;
}

// ─── Wrap IPC call: throw on failure ─────────────────────────────────────────

/**
 * Wrap một IPC call, tự throw Error với message rõ ràng nếu thất bại.
 *
 * @example
 * const res = await callApi(
 *   () => ipc.zalo?.addQuickMessage({ auth, keyword, title }),
 *   'Tạo tin nhắn nhanh thất bại'
 * );
 */
export async function callApi<T = any>(
  fn: () => Promise<T> | undefined,
  errorPrefix?: string
): Promise<T> {
  let res: any;
  try {
    res = await fn();
  } catch (e: any) {
    const msg = e?.message || String(e) || 'Lỗi không xác định';
    throw new Error(errorPrefix ? `${errorPrefix}: ${msg}` : msg);
  }

  if (res && typeof res === 'object' && res.success === false) {
    const msg = extractApiError(res, 'Lỗi không xác định');
    throw new Error(errorPrefix ? `${errorPrefix}: ${msg}` : msg);
  }

  return res as T;
}

// ─── Run IPC call + auto show notification ────────────────────────────────────

type NotifyType = 'success' | 'error' | 'info' | 'warning';

/**
 * Chạy một async callback, tự show notification lỗi nếu thất bại.
 * Trả về true nếu thành công, false nếu lỗi.
 *
 * @example
 * const ok = await runWithErrorNotify(
 *   async () => {
 *     const res = await ipc.zalo?.sendMessage(...);
 *     if (!res?.success) throw new Error(res?.error || 'Gửi thất bại');
 *   },
 *   'Gửi tin nhắn',
 *   showNotification
 * );
 */
export async function runWithErrorNotify(
  fn: () => Promise<void>,
  label: string,
  notify: (msg: string, type: NotifyType) => void
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    const raw = e?.message || String(e) || 'Lỗi không xác định';
    notify(`${label}: ${raw}`, 'error');
    return false;
  }
}

/**
 * Hook-free version: lấy showNotification trực tiếp từ store snapshot.
 * Dùng được ngoài React component.
 *
 * @example
 * await runWithErrorNotifyStore(
 *   () => ipc.zalo?.deleteMessage({ auth, msgId }),
 *   'Xóa tin nhắn'
 * );
 */
export async function runWithErrorNotifyStore(
  fn: () => Promise<void>,
  label: string
): Promise<boolean> {
  const { showNotification } = useAppStore.getState();
  return runWithErrorNotify(fn, label, showNotification);
}

