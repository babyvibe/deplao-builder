/**
 * Chat constants: shared by ChatWindow, ConversationList and related components.
 */

// ─── Pagination / Limits ─────────────────────────────────────────────────────

/** Number of messages loaded per page when scrolling or opening a conversation */
export const MESSAGE_LOAD_LIMIT = 20;

/** Number of messages restored when switching back to a conversation */
export const MESSAGE_RESTORE_LIMIT = 50;

/** Number of messages when searching / inside a conversation */
export const MESSAGE_SEARCH_LIMIT = 80;

/** Number of messages loaded when scrolling around one specific message */
export const MESSAGE_AROUND_LIMIT = 200;

/** Number of contacts/messages per page when querying the DB */
export const PAGE_SIZE = 200;

/**
 * Number of conversations shown more per step in the list (the DB still queries PAGE_SIZE). Building 200 rows (merged avatars, labels…)
 * each time the account / filter changes makes the switch stutter; near the bottom of the list, more are shown.
 */
export const CONVERSATION_DISPLAY_STEP = 60;

/** Number of messages loaded more each time you scroll up (the first message when a conversation opens is still MESSAGE_LOAD_LIMIT) */
export const MESSAGE_LOAD_MORE_LIMIT = 40;

/** When scrolled up this many px from the top of the list, older messages load automatically (loads before reaching the top) */
export const LOAD_OLDER_PREFETCH_PX = 800;

/** Max number of pages when loading old messages */
export const MAX_PAGES = 100;

/** Max number of group members loaded per query */
export const GROUP_MEMBER_LIMIT = 200;

// ─── Batch loading ───────────────────────────────────────────────────────────

/** Number of items in the first batch loaded when a conversation opens */
export const INITIAL_BATCH = 10;

/** Number of items in each following batch (background) */
export const BACKGROUND_BATCH = 5;

/** Number of items per batch when loading avatars / peers */
export const BATCH_SIZE = 5;

/** Delay between background load batches (ms) */
export const BATCH_DELAY_MS = 300;

// ─── Timing ──────────────────────────────────────────────────────────────────

/** Timeout for showing the initial loading state (ms) */
export const INITIAL_LOADING_TIMEOUT_MS = 8000;

/** Delay between background load batches (ms) */
export const BACKGROUND_LOAD_DELAY_MS = 500;

/** Cache TTL for group info (ms): 5 minutes */
export const GROUP_INFO_CACHE_TTL_MS = 5 * 60 * 1000;

/** Debounce interval for labels load (ms): 1 hour */
export const LABELS_DEBOUNCE_MS = 3_600_000;

/** Timeout when loading old messages (ms) */
export const LOAD_MORE_TIMEOUT_MS = 10_000;
