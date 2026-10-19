/**
 * Chat constants — dùng chung cho ChatWindow, ConversationList, và các component liên quan.
 */

// ─── Pagination / Limits ─────────────────────────────────────────────────────

/** Số tin nhắn tải mỗi trang khi scroll hoặc mở hội thoại */
export const MESSAGE_LOAD_LIMIT = 20;

/** Số tin nhắn restore khi chuyển lại hội thoại */
export const MESSAGE_RESTORE_LIMIT = 50;

/** Số tin nhắn khi search/trong hội thoại */
export const MESSAGE_SEARCH_LIMIT = 80;

/** Số tin nhắn load khi scroll quanh 1 tin nhắn cụ thể */
export const MESSAGE_AROUND_LIMIT = 200;

/** Số contact/tin nhắn mỗi page khi query DB */
export const PAGE_SIZE = 200;

/**
 * Số hội thoại hiển thị thêm mỗi lần trong danh sách (DB vẫn query PAGE_SIZE). Dựng 200 hàng (avatar ghép, nhãn…)
 * mỗi lần đổi tài khoản / bộ lọc làm chuyển tài khoản bị khựng; cuộn gần cuối danh sách thì hiện thêm.
 */
export const CONVERSATION_DISPLAY_STEP = 60;

/** Số tin nhắn tải thêm mỗi lần cuộn lên (tin đầu tiên khi mở hội thoại vẫn là MESSAGE_LOAD_LIMIT) */
export const MESSAGE_LOAD_MORE_LIMIT = 40;

/** Cuộn lên còn cách đỉnh danh sách bấy nhiêu px thì tự tải trang tin cũ hơn (tải trước khi chạm đỉnh) */
export const LOAD_OLDER_PREFETCH_PX = 800;

/** Số page tối đa khi load tin nhắn cũ */
export const MAX_PAGES = 100;

/** Số thành viên nhóm tải tối đa khi query */
export const GROUP_MEMBER_LIMIT = 200;

// ─── Batch loading ───────────────────────────────────────────────────────────

/** Số item load batch đầu tiên khi mở conversation */
export const INITIAL_BATCH = 10;

/** Số item load batch tiếp theo (nền) */
export const BACKGROUND_BATCH = 5;

/** Số item mỗi batch khi load avatar/peer */
export const BATCH_SIZE = 5;

/** Delay giữa các batch tải nền (ms) */
export const BATCH_DELAY_MS = 300;

// ─── Timing ──────────────────────────────────────────────────────────────────

/** Timeout hiển thị loading ban đầu (ms) */
export const INITIAL_LOADING_TIMEOUT_MS = 8000;

/** Delay giữa các batch tải nền (ms) */
export const BACKGROUND_LOAD_DELAY_MS = 500;

/** Cache TTL cho group info (ms) — 5 phút */
export const GROUP_INFO_CACHE_TTL_MS = 5 * 60 * 1000;

/** Debounce interval cho labels load (ms) — 1 giờ */
export const LABELS_DEBOUNCE_MS = 3_600_000;

/** Timeout khi load tin nhắn cũ (ms) */
export const LOAD_MORE_TIMEOUT_MS = 10_000;
