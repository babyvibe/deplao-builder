/**
 * Thông báo tin nhắn mới ngay trong app (thẻ ở góc trên bên phải, dưới thanh tiêu đề): quy tắc thuần, dùng chung cho
 * Zalo / Telegram (event:message, hooks/chat/useZaloEvents) và Facebook (fb:onMessage, hooks/chat/useChatEvents).
 *
 * - Bật / tắt theo từng tài khoản; "Tất cả tài khoản" là mặc định cho mọi tài khoản chưa chỉnh riêng, kể cả tài khoản
 *   thêm sau. Lưu trên máy (localStorage): máy Boss và máy nhân viên chỉnh riêng.
 * - Chỉ tin nhắn thật, mới nhận: không phải tin của mình, tin tải lại / đồng bộ bù (cờ _silent / _silentNotification,
 *   hoặc cũ hơn IN_APP_TOAST_FRESH_MS), thông báo hệ thống; hội thoại không tắt thông báo, không ở thư mục Khác, không
 *   ẩn; không phải hội thoại đang mở trên màn hình; cửa sổ đang hiện; app không khoá.
 * - Mỗi hội thoại một thẻ (tin mới của cùng hội thoại cập nhật thẻ đang hiện), tối đa IN_APP_TOAST_MAX thẻ: thẻ mới
 *   đẩy thẻ cũ nhất ra ngay. Mỗi thẻ hiện IN_APP_TOAST_MS kể từ tin mới nhất của nó.
 */

export const IN_APP_TOAST_MS = 2_000;
export const IN_APP_TOAST_MAX = 3;
/** Tin cũ hơn mốc này (so với giờ máy) không bật thông báo: tin tải bù sau khi mất mạng / mở app, đồng bộ lại. */
export const IN_APP_TOAST_FRESH_MS = 3 * 60_000;
/** Thời gian mờ dần khi thẻ hết giờ / bấm ✕. */
export const IN_APP_TOAST_LEAVE_MS = 160;
/** Rê chuột vào thẻ thì dừng đếm giờ; rời chuột còn ít nhất chừng này mới ẩn. */
export const IN_APP_TOAST_RESUME_MS = 1_200;

export interface InAppNotifyPrefs {
  /** Mặc định cho mọi tài khoản chưa chỉnh riêng (cả tài khoản thêm sau). */
  all: boolean;
  /** Tài khoản chỉnh khác mặc định. */
  accounts: Record<string, boolean>;
}

export const DEFAULT_IN_APP_NOTIFY_PREFS: InAppNotifyPrefs = Object.freeze({ all: true, accounts: Object.freeze({}) }) as InAppNotifyPrefs;

export function normalizeInAppNotifyPrefs(raw: unknown): InAppNotifyPrefs {
  if (!raw || typeof raw !== 'object') return { all: true, accounts: {} };
  const value = raw as { all?: unknown; accounts?: unknown };
  const all = value.all !== false;
  const accounts: Record<string, boolean> = {};
  if (value.accounts && typeof value.accounts === 'object') {
    for (const [id, on] of Object.entries(value.accounts as Record<string, unknown>)) {
      if (id && typeof on === 'boolean' && on !== all) accounts[id] = on;
    }
  }
  return { all, accounts };
}

export function isInAppNotifyEnabled(prefs: InAppNotifyPrefs, accountId: string): boolean {
  const own = prefs.accounts[accountId];
  return typeof own === 'boolean' ? own : prefs.all;
}

/** Bật / tắt cho tất cả: mọi tài khoản (cả tài khoản thêm sau) theo một giá trị, bỏ chỉnh riêng. */
export function withAllAccounts(on: boolean): InAppNotifyPrefs {
  return { all: on, accounts: {} };
}

/** Chỉnh một tài khoản: trùng mặc định thì bỏ chỉnh riêng (đổi "Tất cả" sau này vẫn áp cho tài khoản đó). */
export function withAccount(prefs: InAppNotifyPrefs, accountId: string, on: boolean): InAppNotifyPrefs {
  const accounts = { ...prefs.accounts };
  if (on === prefs.all) delete accounts[accountId];
  else accounts[accountId] = on;
  return { all: prefs.all, accounts };
}

export interface InAppNotifySummary {
  enabled: number;
  total: number;
  /** Công tắc "Tất cả tài khoản": bật khi mọi tài khoản đang bật (chưa có tài khoản: theo mặc định). */
  allOn: boolean;
  allOff: boolean;
}

export function summarizeInAppNotify(prefs: InAppNotifyPrefs, accountIds: readonly string[]): InAppNotifySummary {
  const total = accountIds.length;
  const enabled = accountIds.filter((id) => isInAppNotifyEnabled(prefs, id)).length;
  if (total === 0) return { enabled: 0, total: 0, allOn: prefs.all, allOff: !prefs.all };
  return { enabled, total, allOn: enabled === total, allOff: enabled === 0 };
}

/** Loại tin không phải tin nhắn của người (thông báo hệ thống, tin đã xoá). */
const NOT_A_MESSAGE = new Set(['system', 'deleted']);

export interface InAppToastCheck {
  /** Cài đặt của tài khoản nhận tin. */
  enabled: boolean;
  /** App đang khoá màn hình. */
  suspended?: boolean;
  /** Cửa sổ app đang hiện (không thu nhỏ / ẩn). */
  windowVisible: boolean;
  isSelf?: boolean;
  /** Tin tải lại / đồng bộ bù / lịch sử (cờ _silent, _silentNotification, _commentOnly). */
  silent?: boolean;
  muted?: boolean;
  inOthers?: boolean;
  /** Hội thoại ẩn (mã PIN). */
  hidden?: boolean;
  /** Hội thoại đang mở trên màn hình (trang Chat, đúng tài khoản / hội thoại / chủ đề). */
  onScreen: boolean;
  msgType?: string | null;
  /** Giờ của tin (ms). */
  timestamp?: number | null;
  now: number;
}

export function shouldShowInAppToast(check: InAppToastCheck): boolean {
  if (!check.enabled || check.suspended || !check.windowVisible) return false;
  if (check.isSelf || check.silent || check.muted || check.inOthers || check.hidden || check.onScreen) return false;
  if (NOT_A_MESSAGE.has(String(check.msgType ?? ''))) return false;
  const ts = Number(check.timestamp) || 0;
  if (ts > 0 && check.now - ts > IN_APP_TOAST_FRESH_MS) return false;
  return true;
}

/** Một tin cần thông báo (người gọi đã lọc bằng shouldShowInAppToast). */
export interface InAppToastInput {
  /** ID tài khoản như trong sự kiện (Facebook: facebook_id) — dùng để mở hội thoại. */
  accountId: string;
  threadId: string;
  threadType: number;
  msgId?: string;
  /** Tên hội thoại. */
  conversation: string;
  /** Người gửi (tin nhóm). */
  sender?: string;
  /** Nội dung xem trước của tin. */
  text: string;
}

export interface InAppToast extends InAppToastInput {
  /** React key: giữ nguyên khi thẻ được cập nhật bằng tin mới của cùng hội thoại (không chạy lại hiệu ứng). */
  id: string;
  key: string;
  /** Số tin của hội thoại từ lúc thẻ hiện. */
  count: number;
  updatedAt: number;
  expiresAt: number;
  /** Đang mờ dần (hết giờ / bấm ✕). */
  leavingAt?: number;
}

export const inAppToastKey = (accountId: string, threadId: string): string => `${accountId}:${threadId}`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Dòng nội dung: "Hội thoại: Người gửi: tin" (tin 1:1 / kênh không lặp tên). */
export function inAppToastBody(toast: Pick<InAppToastInput, 'conversation' | 'sender' | 'text'>): { conversation: string; rest: string } {
  const conversation = toast.conversation.trim();
  const sender = (toast.sender || '').trim();
  const text = toast.text.replace(/\s+/g, ' ').trim();
  const rest = sender && sender !== conversation ? `${sender}: ${text}` : text;
  return { conversation, rest };
}

/**
 * Gộp các tin mới vào danh sách thẻ đang hiện (cũ → mới theo thứ tự xuất hiện): cùng hội thoại thì cập nhật thẻ đó
 * (giữ chỗ, giữ id, đếm thêm nếu là tin khác), hội thoại mới thì thêm thẻ; quá `max` thì bỏ ngay thẻ lâu không có tin
 * mới nhất (thẻ đang mờ dần bỏ trước).
 */
export function mergeInAppToasts(
  current: readonly InAppToast[],
  incoming: readonly InAppToastInput[],
  now: number,
  max: number = IN_APP_TOAST_MAX,
): InAppToast[] {
  const toasts = current.slice();
  for (const input of incoming) {
    const key = inAppToastKey(input.accountId, input.threadId);
    const base = {
      ...input,
      conversation: clip(input.conversation, 120),
      sender: input.sender ? clip(input.sender, 80) : input.sender,
      text: clip(input.text, 240),
    };
    const index = toasts.findIndex((toast) => toast.key === key);
    if (index >= 0) {
      const previous = toasts[index];
      const sameMessage = !!input.msgId && input.msgId === previous.msgId;
      toasts[index] = {
        ...base,
        id: previous.id,
        key,
        count: sameMessage ? previous.count : previous.count + 1,
        updatedAt: now,
        expiresAt: now + IN_APP_TOAST_MS,
      };
    } else {
      toasts.push({ ...base, id: `${key}@${now}`, key, count: 1, updatedAt: now, expiresAt: now + IN_APP_TOAST_MS });
    }
  }
  while (toasts.length > max) {
    let drop = 0;
    for (let i = 1; i < toasts.length; i++) {
      const a = toasts[i];
      const b = toasts[drop];
      const aLeaving = a.leavingAt !== undefined;
      const bLeaving = b.leavingAt !== undefined;
      if (aLeaving !== bLeaving ? aLeaving : a.updatedAt < b.updatedAt) drop = i;
    }
    toasts.splice(drop, 1);
  }
  return toasts;
}
