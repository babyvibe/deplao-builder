/**
 * Reports "read" to the platform for the conversation the user is viewing (Zalo "đã xem" (seen), Telegram ReadHistory / ReadDiscussion,
 * Facebook read receipt). One shared place for every way a conversation is opened and for new messages while chatting continuously:
 *
 *  - Opening a conversation on purpose (tapping the list, a notification, Tab, QuickChat, a reminder) → reports at once (`syncOpenedThread`).
 *  - A new message arrives in the conversation on screen (Chat page, focused window) while the user has used the mouse / keyboard within 60 s →
 *    reports after 0.8 s, grouping the whole batch; each conversation at most once per 1.5–3 s (`noteIncoming`). No activity (user walked away)
 *    → remembered, reported when the user acts again (`noteUserActivity`).
 *  - The window regains focus while a conversation is open → reported when the user acts (`noteThreadShown`): on app start, nothing is
 *    reported until the user touches it.
 * Before (from 26.8.1) Telegram / Facebook only reported when a conversation was tapped: while chatting, the phone still showed unread,
 * and the customer did not see "đã xem"; Zalo reported based on the newest message even if it was the user's own / a system message, so Zalo did not receive it.
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { isTelegramForumGeneral } from '@/lib/channels/channelHelper';
import { MOBILE_BREAKPOINT } from '@/hooks/layout/useIsMobile';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { getMessageCacheKey, useChatStore } from '@/store/chat/chatStore';
import {
  LIVE_READ_DELAY_MS, PRESENCE_RESUME_DELAY_MS, isUserPresent, minReadIntervalMs, newerIncoming, newestIncoming,
  readSyncDelay, supportsPlatformRead, zaloSeenPayload,
  type IncomingRef, type ReadRow, type ReadThreadRef,
} from './readSyncRules';

export type { IncomingRef, ReadRow, ReadThreadRef } from './readSyncRules';

/** IPC result `{ success: false }` = the platform refused → the mark is not remembered, reported again next time. */
type IpcResult = { success?: boolean } | null | undefined | void;

export interface LiveReadEnv {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Conversation shown on screen: Chat page, chat window visible, window focused, the right account / conversation / topic. */
  isThreadOnScreen(ref: ReadThreadRef): boolean;
  channelOf(accountId: string): string | undefined;
  /** Messages of the conversation already in memory (store), if any. */
  storeRows(ref: ReadThreadRef): ReadonlyArray<ReadRow> | undefined;
  /** Newest message in the DB (Zalo needs a real message from the customer as the mark when memory has none). */
  dbRows(ref: ReadThreadRef): Promise<ReadonlyArray<ReadRow>>;
  zaloSeen(ref: ReadThreadRef, payload: ReturnType<typeof zaloSeenPayload>): Promise<IpcResult>;
  telegramRead(ref: ReadThreadRef, opts: { historyOnly: boolean }): Promise<IpcResult>;
  telegramTopicRead(ref: ReadThreadRef, readMaxId?: string): Promise<IpcResult>;
  facebookRead(ref: ReadThreadRef): Promise<IpcResult>;
}

interface PendingRead {
  ref: ReadThreadRef;
  /** Newest received message not yet reported (null = unknown → taken from memory when reporting). */
  latest: IncomingRef | null;
  /** Telegram: also reads @ mentions / reactions (opening a conversation, refocusing, a message mentioning me) instead of only ReadHistory. */
  full: boolean;
}

const MAX_REMEMBERED_THREADS = 300;

export function createLiveReadSync(env: LiveReadEnv) {
  let pending: PendingRead | null = null;
  let timer: unknown = null;
  let lastInputAt = 0;
  /** Mark already reported for each conversation: the time it was reported + the id of the newest received message reported. */
  const synced = new Map<string, { at: number; marker: string }>();
  const busy = new Set<string>();

  const keyOf = (ref: ReadThreadRef) => `${ref.accountId}|${ref.threadId}|${ref.topicId || ''}`;

  const stopTimer = () => {
    if (timer !== null) {
      env.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (baseDelay: number) => {
    if (!pending) return;
    const last = synced.get(keyOf(pending.ref));
    const delay = readSyncDelay(env.now(), last?.at || 0, minReadIntervalMs(env.channelOf(pending.ref.accountId)), baseDelay);
    stopTimer();
    timer = env.setTimer(() => {
      timer = null;
      void flushPending();
    }, delay);
  };

  const remember = (key: string, marker: string) => {
    synced.delete(key);
    synced.set(key, { at: env.now(), marker });
    if (synced.size > MAX_REMEMBERED_THREADS) {
      const oldest = synced.keys().next().value;
      if (oldest !== undefined) synced.delete(oldest);
    }
  };

  async function send(read: PendingRead, opts: { force: boolean; rows?: ReadonlyArray<ReadRow> }): Promise<void> {
    const { ref } = read;
    const channel = env.channelOf(ref.accountId);
    if (!supportsPlatformRead(channel)) return;
    const key = keyOf(ref);
    let target = read.latest || newestIncoming(opts.rows ?? env.storeRows(ref), ref.accountId);
    if (!target && channel === 'zalo') target = newestIncoming(await env.dbRows(ref).catch(() => []), ref.accountId);
    // No received message: Zalo has nothing to "xem" (view); Telegram / Facebook only report when a conversation is opened on purpose
    if (!target && (channel === 'zalo' || !opts.force)) return;
    const marker = target ? target.msgId : `open:${env.now()}`;
    if (!opts.force && synced.get(key)?.marker === marker) return;

    busy.add(key);
    try {
      let result: IpcResult;
      if (channel === 'zalo') {
        result = await env.zaloSeen(ref, zaloSeenPayload(target!, ref));
      } else if (channel === 'telegram_user') {
        result = ref.topicId
          ? await env.telegramTopicRead(ref, target?.msgId)
          : await env.telegramRead(ref, { historyOnly: !read.full });
      } else {
        result = await env.facebookRead(ref);
      }
      if (!result || result.success !== false) remember(key, marker);
    } catch {
      // best effort: reported again on the next message / action
    } finally {
      busy.delete(key);
    }
  }

  async function flushPending(): Promise<void> {
    const read = pending;
    if (!read) return;
    // No longer shown / the user is away from the machine → keep it, report when they look again (focus + action)
    if (!env.isThreadOnScreen(read.ref) || !isUserPresent(env.now(), lastInputAt)) return;
    if (busy.has(keyOf(read.ref))) {
      schedule(LIVE_READ_DELAY_MS);
      return;
    }
    pending = null;
    await send(read, { force: false });
  }

  const supported = (ref: ReadThreadRef) => supportsPlatformRead(env.channelOf(ref.accountId));

  return {
    /**
     * A message from someone else arrives in the conversation on screen (focused window): the caller has already checked. `msg` is null when
     * the message has no id (the newest message in memory is used when reporting).
     */
    noteIncoming(ref: ReadThreadRef, msg: IncomingRef | null, opts: { mention?: boolean } = {}): void {
      if (!supported(ref)) return;
      if (!pending || keyOf(pending.ref) !== keyOf(ref)) pending = { ref, latest: null, full: false };
      if (msg?.msgId) pending.latest = newerIncoming(pending.latest, msg);
      if (opts.mention) pending.full = true;
      if (isUserPresent(env.now(), lastInputAt)) schedule(LIVE_READ_DELAY_MS);
    },

    /** The window just regained focus while a conversation is open: reported when the user acts. */
    noteThreadShown(ref: ReadThreadRef): void {
      if (!supported(ref)) return;
      if (!pending || keyOf(pending.ref) !== keyOf(ref)) pending = { ref, latest: null, full: true };
      else pending.full = true;
      if (isUserPresent(env.now(), lastInputAt)) schedule(PRESENCE_RESUME_DELAY_MS);
    },

    /** Mouse / keyboard / scroll in the window. */
    noteUserActivity(): void {
      lastInputAt = env.now();
      if (pending && timer === null && env.isThreadOnScreen(pending.ref)) schedule(PRESENCE_RESUME_DELAY_MS);
    },

    /**
     * The user opens a conversation on purpose → reports at once (no waiting, no skipping even if it was already reported up to the same message). `rows` = the messages just loaded
     * (Zalo picks the newest received message as the mark; if there is none, memory / DB is read).
     */
    async syncOpenedThread(ref: ReadThreadRef, rows?: ReadonlyArray<ReadRow>): Promise<void> {
      if (!supported(ref)) return;
      let latest: IncomingRef | null = null;
      if (pending) {
        // Another conversation is opened: unreported messages of the old conversation stay unread on the platform (the user has left it)
        if (keyOf(pending.ref) === keyOf(ref)) latest = pending.latest;
        pending = null;
        stopTimer();
      }
      await send({ ref, latest, full: true }, { force: true, rows });
    },

    /** Test: internal state. */
    _debug: () => ({ pending: pending ? { ...pending } : null, hasTimer: timer !== null, lastInputAt }),
  };
}

export type LiveReadSync = ReturnType<typeof createLiveReadSync>;

/** The chat window is visible: Chat page (on a narrow screen it must be on the chat view, not the list). */
export function isChatPaneVisible(): boolean {
  const app = useAppStore.getState();
  if (app.view !== 'chat') return false;
  if (typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT && !app.mobileShowChat) return false;
  return true;
}

const notConnected = () => Promise.resolve({ success: false });

const browserEnv: LiveReadEnv = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  isThreadOnScreen(ref) {
    if (typeof document !== 'undefined' && (document.visibilityState === 'hidden' || !document.hasFocus())) return false;
    // The Quick Message popup shows this conversation (any page)
    const quick = useAppStore.getState().quickChatThread;
    if (quick && quick.zaloId === ref.accountId && quick.threadId === ref.threadId && !ref.topicId) return true;
    if (!isChatPaneVisible()) return false;
    const chat = useChatStore.getState();
    return useAccountStore.getState().activeAccountId === ref.accountId
      && chat.activeThreadId === ref.threadId
      && (chat.activeTopicId || null) === (ref.topicId || null);
  },
  channelOf: (accountId) => useAccountStore.getState().accounts.find(a => a.zalo_id === accountId)?.channel || 'zalo',
  storeRows(ref) {
    const topicKey = ref.topicId ? (isTelegramForumGeneral(ref.topicId) ? '1' : ref.topicId) : undefined;
    return useChatStore.getState().messages[getMessageCacheKey(ref.accountId, ref.threadId, topicKey)];
  },
  async dbRows(ref) {
    const res: any = await DataAccessor.getMessages({ zaloId: ref.accountId, threadId: ref.threadId, limit: 20, offset: 0 });
    return res?.messages || [];
  },
  zaloSeen(ref, payload) {
    const account = useAccountStore.getState().accounts.find(a => a.zalo_id === ref.accountId);
    if (!account || !ipc.zalo?.sendSeenEvent) return notConnected();
    return ipc.zalo.sendSeenEvent({ auth: buildZaloAuth(account, ref.accountId), messages: [payload], type: ref.threadType });
  },
  telegramRead(ref, opts) {
    return ipc.telegramUser?.readChatHistory({ accountId: ref.accountId, chatId: ref.threadId, historyOnly: opts.historyOnly }) ?? notConnected();
  },
  telegramTopicRead(ref, readMaxId) {
    return ipc.telegramUser?.readForumTopic({ accountId: ref.accountId, chatId: ref.threadId, topMsgId: String(ref.topicId), readMaxId }) ?? notConnected();
  },
  facebookRead(ref) {
    return ipc.fb?.markAsRead({ accountId: ref.accountId, threadId: ref.threadId }) ?? notConnected();
  },
};

export const liveReadSync = createLiveReadSync(browserEnv);

/** Tracks whether the user is acting in the window (mouse move: at most once per second). Returns an unsubscribe function. */
export function installLiveReadPresence(sync: Pick<LiveReadSync, 'noteUserActivity'> = liveReadSync): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let lastMove = 0;
  const onInput = () => sync.noteUserActivity();
  const onMove = () => {
    const now = Date.now();
    if (now - lastMove < 1_000) return;
    lastMove = now;
    sync.noteUserActivity();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  for (const type of inputEvents) window.addEventListener(type, onInput, options);
  window.addEventListener('pointermove', onMove, options);
  return () => {
    for (const type of inputEvents) window.removeEventListener(type, onInput, options);
    window.removeEventListener('pointermove', onMove, options);
  };
}
