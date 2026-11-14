/**
 * In-app notification for new messages (a card at the top right, under the title bar): pure rules, shared by
 * Zalo / Telegram (event:message, hooks/chat/useZaloEvents) and Facebook (fb:onMessage, hooks/chat/useChatEvents).
 *
 * - On / off per account; "Tất cả tài khoản" (All accounts) is the default for every account without its own setting, including accounts
 *   added later. Saved on this machine (localStorage): the Boss machine and an employee machine are set separately.
 * - Only real, new messages: not my own, not reloaded / catch-up sync (flags _silent / _silentNotification,
 *   or older than IN_APP_TOAST_FRESH_MS), not system notices; the conversation has notifications on, is not in the "Khác" (Other) folder, is not
 *   hidden; not the conversation open on screen; the window is visible; the app is not locked.
 * - One card per conversation (a new message in the same conversation updates the card on screen), at most IN_APP_TOAST_MAX cards: a new card
 *   pushes the oldest card out at once. Each card shows for IN_APP_TOAST_MS from its newest message.
 */

export const IN_APP_TOAST_MS = 2_000;
export const IN_APP_TOAST_MAX = 3;
/** Messages older than this mark (compared with the machine clock) do not trigger a notification: messages loaded to catch up after losing the network / opening the app, re-synced. */
export const IN_APP_TOAST_FRESH_MS = 3 * 60_000;
/** Fade-out time when the card expires / is closed with ✕. */
export const IN_APP_TOAST_LEAVE_MS = 160;
/** Hovering over a card pauses the timer; after the mouse leaves it stays for at least this long before hiding. */
export const IN_APP_TOAST_RESUME_MS = 1_200;

export interface InAppNotifyPrefs {
  /** Default for every account without its own setting (including accounts added later). */
  all: boolean;
  /** Account set differently from the default. */
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

/** On / off for all: every account (including accounts added later) gets the same value, own settings are removed. */
export function withAllAccounts(on: boolean): InAppNotifyPrefs {
  return { all: on, accounts: {} };
}

/** Change one account: if it equals the default, its own setting is removed (a later change to "Tất cả" (All) still applies to that account). */
export function withAccount(prefs: InAppNotifyPrefs, accountId: string, on: boolean): InAppNotifyPrefs {
  const accounts = { ...prefs.accounts };
  if (on === prefs.all) delete accounts[accountId];
  else accounts[accountId] = on;
  return { all: prefs.all, accounts };
}

export interface InAppNotifySummary {
  enabled: number;
  total: number;
  /** The "Tất cả tài khoản" (All accounts) switch: on when every account is on (no accounts yet: follows the default). */
  allOn: boolean;
  allOff: boolean;
}

export function summarizeInAppNotify(prefs: InAppNotifyPrefs, accountIds: readonly string[]): InAppNotifySummary {
  const total = accountIds.length;
  const enabled = accountIds.filter((id) => isInAppNotifyEnabled(prefs, id)).length;
  if (total === 0) return { enabled: 0, total: 0, allOn: prefs.all, allOff: !prefs.all };
  return { enabled, total, allOn: enabled === total, allOff: enabled === 0 };
}

/** Message types that are not messages from a person (system notices, deleted messages). */
const NOT_A_MESSAGE = new Set(['system', 'deleted']);

export interface InAppToastCheck {
  /** Settings of the account that receives the message. */
  enabled: boolean;
  /** The app is locked. */
  suspended?: boolean;
  /** The app window is visible (not minimised / hidden). */
  windowVisible: boolean;
  isSelf?: boolean;
  /** Reloaded / catch-up sync / history messages (flags _silent, _silentNotification, _commentOnly). */
  silent?: boolean;
  muted?: boolean;
  inOthers?: boolean;
  /** Hidden conversation (PIN code). */
  hidden?: boolean;
  /** Conversation open on screen (Chat page, the right account / conversation / topic). */
  onScreen: boolean;
  msgType?: string | null;
  /** Time of the message (ms). */
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

/** One message to notify about (the caller has already filtered it with shouldShowInAppToast). */
export interface InAppToastInput {
  /** Account ID as in the event (Facebook: facebook_id), used to open the conversation. */
  accountId: string;
  threadId: string;
  threadType: number;
  msgId?: string;
  /** Conversation name. */
  conversation: string;
  /** Sender (group message). */
  sender?: string;
  /** Preview text of the message. */
  text: string;
}

export interface InAppToast extends InAppToastInput {
  /** React key: stays the same when the card is updated with a new message from the same conversation (the animation does not run again). */
  id: string;
  key: string;
  /** Number of messages in the conversation since the card appeared. */
  count: number;
  updatedAt: number;
  expiresAt: number;
  /** Fading out (expired / ✕ pressed). */
  leavingAt?: number;
}

export const inAppToastKey = (accountId: string, threadId: string): string => `${accountId}:${threadId}`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Content line: "Hội thoại: Người gửi: tin" (Conversation: Sender: message) (1:1 messages / channels do not repeat the name). */
export function inAppToastBody(toast: Pick<InAppToastInput, 'conversation' | 'sender' | 'text'>): { conversation: string; rest: string } {
  const conversation = toast.conversation.trim();
  const sender = (toast.sender || '').trim();
  const text = toast.text.replace(/\s+/g, ' ').trim();
  const rest = sender && sender !== conversation ? `${sender}: ${text}` : text;
  return { conversation, rest };
}

/**
 * Merges new messages into the list of cards on screen (old → new in order of arrival): same conversation → update that card
 * (keeps its place and id, counts up if it is a different message); new conversation → add a card; above `max` → drop at once the card whose newest
 * message is oldest (a card already fading out goes first).
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
