/**
 * chatLoadFailures.ts - chế độ nhân viên, các màn bên chat (panel Ảnh/Video · File · Link, Nhãn Local của hội thoại):
 * lần đọc lỗi (DataAccessor trả `success: false`, xem agents/REFERENCES/EMPLOYEE_MODE.md §2.2) GIỮ dữ liệu đang có
 * thay vì biến thành danh sách trống, và không làm danh sách dừng hẳn / nhảy trang.
 * Thuần (không store / IPC / DataAccessor). Test: src/__tests__/chat/conversations/chatLoadFailures.test.ts.
 */

/** Cùng điều kiện với `isReadFailure` của DataAccessor (module này không import DataAccessor để giữ thuần). */
function isFailure(res: unknown): boolean {
  return !!res && typeof res === 'object' && (res as { success?: unknown }).success === false;
}

// ── Panel Ảnh/Video · File · Link (MediaSection) ──────────────────────────────

export type MediaPanelTab = 'image' | 'file' | 'link';

/** Một trang của panel, cùng hình dạng `nextConversationPaging` (DataAccessor) nhận. */
export interface MediaPanelPage {
  success: boolean;
  error?: string;
  /** Các dòng server trả (chưa lọc dòng không hiển thị được): offset trang sau = tổng số dòng đã nhận. */
  items: any[];
  /** Trang đầy → có thể còn trang sau. */
  hasMore: boolean;
}

/**
 * Chuẩn hoá phản hồi một trang: getMediaMessages / getFileMessages → `messages` (REST có thêm `items`), getLinks →
 * `links`. Lỗi (`success: false`, hoặc không có phản hồi vì lời gọi ném lỗi) → `success: false` — KHÔNG phải "hết".
 */
export function toMediaPanelPage(tab: MediaPanelTab, res: unknown, limit: number): MediaPanelPage {
  if (!res || typeof res !== 'object' || isFailure(res)) {
    const error = (res as { error?: unknown } | null | undefined)?.error;
    return { success: false, error: typeof error === 'string' && error ? error : undefined, items: [], hasMore: false };
  }
  const r = res as { messages?: unknown; items?: unknown; links?: unknown };
  const raw = tab === 'link' ? r.links : (r.messages ?? r.items);
  const items = Array.isArray(raw) ? raw : [];
  return { success: true, items, hasMore: items.length >= Math.max(1, Math.floor(limit) || 1) };
}

/** Khoá một dòng của panel (tin nhắn: msg_id; link: id, nếu không có thì msg_id + url). '' = không xác định. */
export function mediaPanelRowKey(tab: MediaPanelTab, row: any): string {
  if (!row || typeof row !== 'object') return '';
  if (tab === 'link') {
    if (row.id !== undefined && row.id !== null && row.id !== '') return `l:${row.id}`;
    return row.url ? `l:${row.msg_id ?? ''}:${row.url}` : '';
  }
  return row.msg_id !== undefined && row.msg_id !== null && row.msg_id !== '' ? `m:${row.msg_id}` : '';
}

/**
 * Nối trang sau vào danh sách đang có, bỏ dòng đã có (media mới tới trong lúc cuộn đẩy offset lệch đi → trang sau
 * lặp lại vài dòng cuối). Dòng không có khoá luôn được thêm. Trả `prev` khi không thêm được dòng nào.
 */
export function appendMediaPanelRows(tab: MediaPanelTab, prev: any[], rows: any[]): any[] {
  if (!rows || !rows.length) return prev;
  const seen = new Set<string>();
  for (const row of prev) {
    const key = mediaPanelRowKey(tab, row);
    if (key) seen.add(key);
  }
  const added: any[] = [];
  for (const row of rows) {
    const key = mediaPanelRowKey(tab, row);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    added.push(row);
  }
  return added.length ? [...prev, ...added] : prev;
}

/**
 * Trang mới nhất tải lại (kết nối BOSS phục hồi): thêm lên đầu những dòng chưa có (media mới trong lúc mất kết nối),
 * giữ nguyên phần đã tải. `added` = số dòng thêm → offset trang sau tăng đúng chừng đó. `gap`: cả trang đầy đều là
 * dòng mới → giữa trang này và danh sách cũ có thể còn dòng chưa tải → người gọi tải lại từ đầu.
 * Dòng không có khoá bị bỏ qua (không biết đã có hay chưa). Trả `items === prev` khi không có gì mới.
 */
export function prependMediaPanelRows(
  tab: MediaPanelTab,
  prev: any[],
  rows: any[],
  limit: number,
): { items: any[]; added: number; gap: boolean } {
  const seen = new Set<string>();
  for (const row of prev) {
    const key = mediaPanelRowKey(tab, row);
    if (key) seen.add(key);
  }
  const fresh: any[] = [];
  for (const row of rows || []) {
    const key = mediaPanelRowKey(tab, row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(row);
  }
  const full = (rows || []).length >= Math.max(1, Math.floor(limit) || 1);
  return {
    items: fresh.length ? [...fresh, ...prev] : prev,
    added: fresh.length,
    gap: prev.length > 0 && full && fresh.length === rows.length,
  };
}

// ── Nhãn Local của hội thoại đang mở (ChatHeader, MessageInput) ───────────────

export interface ThreadLocalLabelsState<L> {
  /** Tài khoản của danh mục nhãn `labels` (null = chưa tải được cho tài khoản nào). */
  labelsAccountId: string | null;
  labels: L[];
  /** Hội thoại (threadLabelsKey) của `threadLabelIds` (null = chưa tải được). */
  threadKey: string | null;
  /** Id các Nhãn Local đang gắn cho hội thoại. */
  threadLabelIds: Set<number>;
  /** Lần tải gần nhất có phần lỗi → hiện "Thử lại". */
  failed: boolean;
}

const NO_LABELS: never[] = [];
const NO_LABEL_IDS: Set<number> = new Set();

/** Chưa có hội thoại / tài khoản (hoặc vừa đặt lại). Dùng chung: không sửa trực tiếp `threadLabelIds`. */
export const EMPTY_THREAD_LOCAL_LABELS: ThreadLocalLabelsState<never> = Object.freeze({
  labelsAccountId: null,
  labels: NO_LABELS,
  threadKey: null,
  threadLabelIds: NO_LABEL_IDS,
  failed: false,
}) as ThreadLocalLabelsState<never>;

export function threadLabelsKey(accountId: string, threadId: string): string {
  return `${accountId}\u0001${threadId}`;
}

/** Nhãn Local đang bật, theo sort_order rồi tên (thứ tự trên thanh nhãn của ô nhập / header). */
export function sortActiveLocalLabels<L = any>(raw: unknown): L[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  return list
    .filter((l: any) => (l?.is_active ?? 1) === 1)
    .sort((a: any, b: any) => {
      const sa = Number(a?.sort_order ?? 0);
      const sb = Number(b?.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    }) as L[];
}

/** Id các nhãn của getThreadLocalLabels (`labels: [{ id }]`). */
export function toLabelIdSet(raw: unknown): Set<number> {
  const list: any[] = Array.isArray(raw) ? raw : [];
  return new Set(list.map((l: any) => Number(l?.id)));
}

/**
 * Trạng thái sau một lần tải Nhãn Local của hội thoại. `labels` / `threadLabelIds` = null khi lần đọc tương ứng lỗi:
 * giữ dữ liệu cũ nếu cùng tài khoản (danh mục nhãn) / cùng hội thoại (nhãn đã gắn); khác → rỗng = "chưa biết" (không
 * lấy nhãn của hội thoại trước gán cho hội thoại này). Trả `prev` khi không có gì đổi (React bỏ qua render).
 */
export function nextThreadLocalLabels<L>(
  prev: ThreadLocalLabelsState<L>,
  accountId: string,
  threadId: string,
  labels: L[] | null,
  threadLabelIds: Set<number> | null,
): ThreadLocalLabelsState<L> {
  const key = threadLabelsKey(accountId, threadId);
  const sameAccount = prev.labelsAccountId === accountId;
  const sameThread = prev.threadKey === key;
  const next: ThreadLocalLabelsState<L> = {
    labelsAccountId: labels || sameAccount ? accountId : null,
    labels: labels ?? (sameAccount ? prev.labels : NO_LABELS),
    threadKey: threadLabelIds || sameThread ? key : null,
    threadLabelIds: threadLabelIds ?? (sameThread ? prev.threadLabelIds : NO_LABEL_IDS),
    failed: !labels || !threadLabelIds,
  };
  return next.labelsAccountId === prev.labelsAccountId && next.labels === prev.labels
    && next.threadKey === prev.threadKey && next.threadLabelIds === prev.threadLabelIds && next.failed === prev.failed
    ? prev
    : next;
}
