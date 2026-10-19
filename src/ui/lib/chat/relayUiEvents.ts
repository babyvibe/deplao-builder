/**
 * relayUiEvents.ts — window event mà useZaloEvents phát lại từ event realtime (Boss emit / relay cho nhân viên), dùng
 * chung cho các màn hình nghe chúng (phần thuần, test: relaySyncContract.test.ts).
 *
 *  - 'ui:threadLabelsChanged' — db:localLabelThreadChanged { action: assign|remove|bulkAssign, ownerZaloId, labelId(s),
 *    threadId | threadIds }
 *  - 'local-pin-changed'      — { zaloId, threadId?, isPinned? } (Ctrl+P chỉ có zaloId; relay có đủ)
 *  - 'library:changed'        — thư viện media đổi ở máy khác / kết nối lại (cache đã bị xoá, màn hình mở thì tải lại)
 */

export const THREAD_LABELS_CHANGED_EVENT = 'ui:threadLabelsChanged';
export const LOCAL_PIN_CHANGED_EVENT = 'local-pin-changed';
export const LIBRARY_CHANGED_EVENT = 'library:changed';

/** Id tài khoản trong payload (IPC Boss phát ownerZaloId, vài lệnh REST phát zaloId). */
export function relayEventAccount(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const record = detail as Record<string, unknown>;
  const id = record.ownerZaloId ?? record.zaloId;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * Event gán / bỏ nhãn có chạm hội thoại (accountId, threadId) đang mở không. Thiếu thông tin (không rõ tài khoản /
 * hội thoại) → coi là có (tải lại thừa còn hơn hiện nhãn cũ).
 */
export function threadLabelsEventTouches(detail: unknown, accountId: string | null | undefined, threadId: string | null | undefined): boolean {
  if (!accountId || !threadId) return false;
  const owner = relayEventAccount(detail);
  if (owner && owner !== String(accountId)) return false;
  const record = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
  if (record.threadId !== undefined && record.threadId !== null && record.threadId !== '') {
    return String(record.threadId) === String(threadId);
  }
  if (Array.isArray(record.threadIds)) {
    return record.threadIds.some((id) => String(id) === String(threadId));
  }
  return true;
}
