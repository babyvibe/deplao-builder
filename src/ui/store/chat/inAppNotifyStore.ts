/**
 * In-app message notifications: on / off setting (saved on this machine) + the cards currently shown. Rules: lib/chat/notifications/inAppNotify.
 *
 * Messages arriving in bursts (large groups, many accounts) do not redraw the UI for each message: new messages are batched and added to the
 * list at most once every IN_APP_TOAST_FLUSH_MS; one shared timer for all cards (expire, fade out, paused while the mouse hovers). A message
 * notifies only once (an update event for the same message does not show a new card).
 */
import { create } from 'zustand';
import { useAccountStore } from '../accounts/accountStore';
import {
  IN_APP_TOAST_LEAVE_MS, IN_APP_TOAST_RESUME_MS, inAppToastKey, isInAppNotifyEnabled, mergeInAppToasts,
  normalizeInAppNotifyPrefs, shouldShowInAppToast, withAccount, withAllAccounts,
  type InAppNotifyPrefs, type InAppToast, type InAppToastInput,
} from '../../lib/chat/notifications/inAppNotify';

const PREFS_KEY = 'app_inAppNotify';
export const IN_APP_TOAST_FLUSH_MS = 60;
/** Remember notified messages for this long so that repeated events for the same message do not show the card again. */
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

/** Account settings key: Facebook sends events by facebook_id, settings are saved by the account's zalo_id. */
export function inAppNotifyAccountKey(accountId: string): string {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId || a.facebook_id === accountId);
  return account?.zalo_id || accountId;
}

interface InAppNotifyState {
  prefs: InAppNotifyPrefs;
  toasts: InAppToast[];
  /** App is locked: nothing is shown, cards currently shown are removed. */
  suspended: boolean;
  setAllAccounts: (on: boolean) => void;
  setAccount: (accountId: string, on: boolean) => void;
  push: (input: InAppToastInput) => void;
  /** Click ✕: fade out, then remove. */
  dismiss: (key: string) => void;
  /** Conversation just opened: remove its card right away. */
  dismissConversation: (accountId: string, threadId: string) => void;
  setHovering: (hovering: boolean) => void;
  setSuspended: (suspended: boolean) => void;
}

/** Hovering keeps a card up at most this long (in case the mouse-leave event is lost). */
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
    // In case the browser does not report mouse-leave (the card under the cursor was dropped): keep it at most HOVER_MAX_MS
    if (next) hoverGuard = setTimeout(() => useInAppNotifyStore.getState().setHovering(false), HOVER_MAX_MS);
    if (hovering === next) return;
    hovering = next;
    if (!next) {
      // Mouse leave: a card about to expire gets a little extra time so it does not vanish right under the cursor that just left
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

/** One timer for all cards: schedules the nearest deadline (expire or fade-out done). While hovering, the card does not expire. */
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
 * Whether an in-app notification should be shown for this message (account setting, window visible, app not locked, message is recent,
 * not a system notification). The caller passes the rest: my own message / reloaded, notifications turned off, the "Khác" folder,
 * hidden conversation, currently open on screen.
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

/** Test: clear the module's internal state. */
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
