/**
 * Thông báo tin nhắn trong app: cài đặt bật / tắt (lưu trên máy) + các thẻ đang hiện. Quy tắc: lib/chat/inAppNotify.
 *
 * Tin tới dồn dập (nhóm đông, nhiều tài khoản) không làm giao diện vẽ lại theo từng tin: tin mới gom lại và đưa vào
 * danh sách tối đa mỗi IN_APP_TOAST_FLUSH_MS một lần; một bộ hẹn giờ chung cho mọi thẻ (hết giờ, mờ dần, rê chuột thì
 * dừng). Một tin chỉ thông báo một lần (sự kiện cập nhật lại cùng tin không bật thẻ mới).
 */
import { create } from 'zustand';
import { useAccountStore } from './accountStore';
import {
  IN_APP_TOAST_LEAVE_MS, IN_APP_TOAST_RESUME_MS, inAppToastKey, isInAppNotifyEnabled, mergeInAppToasts,
  normalizeInAppNotifyPrefs, shouldShowInAppToast, withAccount, withAllAccounts,
  type InAppNotifyPrefs, type InAppToast, type InAppToastInput,
} from '../lib/chat/inAppNotify';

const PREFS_KEY = 'app_inAppNotify';
export const IN_APP_TOAST_FLUSH_MS = 60;
/** Nhớ tin đã thông báo trong chừng này để sự kiện lặp của cùng tin không bật lại thẻ. */
const RECENT_MS = 60_000;

function loadPrefs(): InAppNotifyPrefs {
  try {
    return normalizeInAppNotifyPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'));
  } catch {
    return normalizeInAppNotifyPrefs(null);
  }
}

function savePrefs(prefs: InAppNotifyPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

/** Khoá cài đặt của tài khoản: Facebook gửi sự kiện theo facebook_id, cài đặt lưu theo zalo_id của tài khoản. */
export function inAppNotifyAccountKey(accountId: string): string {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId || a.facebook_id === accountId);
  return account?.zalo_id || accountId;
}

interface InAppNotifyState {
  prefs: InAppNotifyPrefs;
  toasts: InAppToast[];
  /** App đang khoá màn hình: không hiện, bỏ thẻ đang hiện. */
  suspended: boolean;
  setAllAccounts: (on: boolean) => void;
  setAccount: (accountId: string, on: boolean) => void;
  push: (input: InAppToastInput) => void;
  /** Bấm ✕: mờ dần rồi bỏ. */
  dismiss: (key: string) => void;
  /** Hội thoại vừa được mở: bỏ thẻ của nó ngay. */
  dismissConversation: (accountId: string, threadId: string) => void;
  setHovering: (hovering: boolean) => void;
  setSuspended: (suspended: boolean) => void;
}

/** Rê chuột giữ thẻ lâu nhất chừng này (phòng sự kiện rời chuột bị mất). */
const HOVER_MAX_MS = 15_000;

let pending: InAppToastInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let hoverGuard: ReturnType<typeof setTimeout> | null = null;
let hovering = false;
const recent = new Map<string, number>();

export const useInAppNotifyStore = create<InAppNotifyState>((set, get) => ({
  prefs: loadPrefs(),
  toasts: [],
  suspended: false,

  setAllAccounts: (on) => {
    const prefs = withAllAccounts(on);
    savePrefs(prefs);
    set({ prefs });
  },

  setAccount: (accountId, on) => {
    if (!accountId) return;
    const prefs = withAccount(get().prefs, accountId, on);
    savePrefs(prefs);
    set({ prefs });
  },

  push: (input) => {
    if (get().suspended || !input.accountId || !input.threadId) return;
    const now = Date.now();
    if (input.msgId) {
      const seenKey = `${inAppToastKey(input.accountId, input.threadId)}:${input.msgId}`;
      const seenAt = recent.get(seenKey);
      if (seenAt !== undefined && now - seenAt < RECENT_MS) return;
      recent.set(seenKey, now);
      if (recent.size > 300) {
        for (const [key, at] of recent) if (now - at >= RECENT_MS) recent.delete(key);
      }
    }
    pending.push(input);
    if (!flushTimer) flushTimer = setTimeout(flush, IN_APP_TOAST_FLUSH_MS);
  },

  dismiss: (key) => {
    const now = Date.now();
    set((state) => {
      let changed = false;
      const toasts = state.toasts.map((toast) => {
        if (toast.key !== key || toast.leavingAt !== undefined) return toast;
        changed = true;
        return { ...toast, leavingAt: now };
      });
      return changed ? { toasts } : state;
    });
    scheduleTick();
  },

  dismissConversation: (accountId, threadId) => {
    const key = inAppToastKey(accountId, threadId);
    pending = pending.filter((input) => inAppToastKey(input.accountId, input.threadId) !== key);
    set((state) => (state.toasts.some((toast) => toast.key === key)
      ? { toasts: state.toasts.filter((toast) => toast.key !== key) }
      : state));
    scheduleTick();
  },

  setHovering: (next) => {
    if (hoverGuard) { clearTimeout(hoverGuard); hoverGuard = null; }
    // Phòng khi trình duyệt không báo rời chuột (thẻ dưới con trỏ bị bỏ): giữ lâu nhất HOVER_MAX_MS
    if (next) hoverGuard = setTimeout(() => useInAppNotifyStore.getState().setHovering(false), HOVER_MAX_MS);
    if (hovering === next) return;
    hovering = next;
    if (!next) {
      // Rời chuột: thẻ sắp hết giờ được thêm chút thời gian để không biến mất ngay dưới con trỏ vừa rời
      const floor = Date.now() + IN_APP_TOAST_RESUME_MS;
      set((state) => ({
        toasts: state.toasts.map((toast) => (toast.leavingAt === undefined && toast.expiresAt < floor
          ? { ...toast, expiresAt: floor }
          : toast)),
      }));
    }
    scheduleTick();
  },

  setSuspended: (suspended) => {
    if (get().suspended === suspended) return;
    if (suspended) {
      pending = [];
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
      if (hoverGuard) { clearTimeout(hoverGuard); hoverGuard = null; }
      hovering = false;
      set({ suspended: true, toasts: [] });
      return;
    }
    set({ suspended: false });
  },
}));

function flush(): void {
  flushTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length || useInAppNotifyStore.getState().suspended) return;
  const now = Date.now();
  useInAppNotifyStore.setState((state) => ({ toasts: mergeInAppToasts(state.toasts, batch, now) }));
  scheduleTick();
}

/** Một bộ hẹn giờ cho mọi thẻ: hẹn tới mốc gần nhất (hết giờ hoặc mờ xong). Đang rê chuột thì không cho hết giờ. */
function scheduleTick(): void {
  if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  const { toasts } = useInAppNotifyStore.getState();
  let next = Infinity;
  for (const toast of toasts) {
    if (toast.leavingAt !== undefined) next = Math.min(next, toast.leavingAt + IN_APP_TOAST_LEAVE_MS);
    else if (!hovering) next = Math.min(next, toast.expiresAt);
  }
  if (next === Infinity) return;
  tickTimer = setTimeout(tick, Math.max(0, next - Date.now()));
}

function tick(): void {
  tickTimer = null;
  const now = Date.now();
  useInAppNotifyStore.setState((state) => {
    let changed = false;
    const toasts: InAppToast[] = [];
    for (const toast of state.toasts) {
      if (toast.leavingAt !== undefined) {
        if (now >= toast.leavingAt + IN_APP_TOAST_LEAVE_MS) { changed = true; continue; }
      } else if (!hovering && now >= toast.expiresAt) {
        changed = true;
        toasts.push({ ...toast, leavingAt: now });
        continue;
      }
      toasts.push(toast);
    }
    return changed ? { toasts } : state;
  });
  scheduleTick();
}

/**
 * Có hiện thông báo trong app cho tin này không (cài đặt của tài khoản, cửa sổ đang hiện, app không khoá, tin còn mới,
 * không phải thông báo hệ thống). Người gọi truyền phần còn lại: tin của mình / tải lại, tắt thông báo, thư mục Khác,
 * hội thoại ẩn, đang mở trên màn hình.
 */
export function inAppToastAllowed(params: {
  accountId: string;
  msgType?: string | null;
  timestamp?: number | null;
  onScreen: boolean;
  isSelf?: boolean;
  silent?: boolean;
  muted?: boolean;
  inOthers?: boolean;
  hidden?: boolean;
}): boolean {
  const state = useInAppNotifyStore.getState();
  const windowVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return shouldShowInAppToast({
    ...params,
    enabled: isInAppNotifyEnabled(state.prefs, inAppNotifyAccountKey(params.accountId)),
    suspended: state.suspended,
    windowVisible,
    now: Date.now(),
  });
}

/** Test: xoá trạng thái nội bộ của module. */
export function __resetInAppNotifyForTests(): void {
  pending = [];
  if (flushTimer) clearTimeout(flushTimer);
  if (tickTimer) clearTimeout(tickTimer);
  if (hoverGuard) clearTimeout(hoverGuard);
  flushTimer = null;
  tickTimer = null;
  hoverGuard = null;
  hovering = false;
  recent.clear();
  useInAppNotifyStore.setState({ toasts: [], suspended: false, prefs: normalizeInAppNotifyPrefs(null) });
}
