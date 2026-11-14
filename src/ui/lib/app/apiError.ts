/**
 * apiError.ts - Shared API error handling utility
 *
 * Shared across the whole app to:
 * 1. Extract the error message from an IPC response (success: false, error, errorCode, message...)
 * 2. Wrap an IPC call and throw automatically if it fails
 * 3. Run an IPC call and show the error notification automatically via appStore
 */

import { useAppStore } from '../../store/app/appStore';
import { tr } from '../../../shared/i18n';

// ─── Extract error message from IPC response ──────────────────────────────────

/** Gets the error message as a string from any IPC response / Error */
export function extractApiError(res: any, fallback = tr('Lỗi không xác định')): string {
  if (!res) return fallback;
  if (typeof res === 'string') return res;
  if (res instanceof Error) return res.message || fallback;
  if (typeof res === 'object') {
    // Priority order: error > message > errorMessage > errorCode
    if (res.error && typeof res.error === 'string' && res.error.trim()) return res.error;
    if (res.error && typeof res.error === 'object') return extractApiError(res.error, fallback);
    if (res.message && typeof res.message === 'string' && res.message.trim()) return res.message;
    if (res.errorMessage) return String(res.errorMessage);
    if (res.errorCode != null) return tr('Lỗi {{errorCode}}', { errorCode: res.errorCode });
  }
  return fallback;
}

/** Checks whether the response is an error */
export function isApiError(res: any): boolean {
  if (!res) return true;
  if (typeof res === 'object' && 'success' in res) return res.success === false;
  return false;
}

// ─── Wrap IPC call: throw on failure ─────────────────────────────────────────

/**
 * Wraps an IPC call and throws an Error with a clear message if it fails.
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
    const msg = e?.message || String(e) || tr('Lỗi không xác định');
    throw new Error(errorPrefix ? `${errorPrefix}: ${msg}` : msg);
  }

  if (res && typeof res === 'object' && res.success === false) {
    const msg = extractApiError(res, tr('Lỗi không xác định'));
    throw new Error(errorPrefix ? `${errorPrefix}: ${msg}` : msg);
  }

  return res as T;
}

// ─── Run IPC call + auto show notification ────────────────────────────────────

type NotifyType = 'success' | 'error' | 'info' | 'warning';

/**
 * Runs an async callback and shows an error notification automatically if it fails.
 * Returns true on success, false on error.
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
    const raw = e?.message || String(e) || tr('Lỗi không xác định');
    notify(`${label}: ${raw}`, 'error');
    return false;
  }
}

/**
 * Hook-free version: gets showNotification directly from the store snapshot.
 * Can be used outside a React component.
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

