/**
 * Báo "đã đọc" lên nền tảng cho hội thoại người dùng đang xem (Zalo "đã xem", Telegram ReadHistory / ReadDiscussion,
 * Facebook read receipt). Một chỗ chung cho mọi đường mở hội thoại và cho tin mới khi đang chat liên tục:
 *
 *  - Mở hội thoại chủ động (bấm danh sách, thông báo, Tab, QuickChat, nhắc hẹn) → báo ngay (`syncOpenedThread`).
 *  - Tin mới vào hội thoại đang hiện (trang Chat, cửa sổ đang focus) khi người dùng có thao tác chuột / phím trong 60 s →
 *    báo sau 0,8 s, gom cả loạt tin; mỗi hội thoại tối đa 1 lần / 1,5–3 s (`noteIncoming`). Không thao tác (bỏ máy đi)
 *    → ghi nhớ, báo khi người dùng thao tác lại (`noteUserActivity`).
 *  - Focus lại cửa sổ khi hội thoại đang mở → báo khi người dùng thao tác (`noteThreadShown`): lúc mở app, chưa động vào
 *    thì chưa báo.
 * Trước đây (từ 26.8.1) Telegram / Facebook chỉ báo khi bấm vào hội thoại: đang chat thì điện thoại vẫn hiện chưa đọc,
 * khách không thấy "đã xem"; Zalo báo theo tin mới nhất kể cả tin của mình / tin hệ thống nên Zalo không nhận.
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

/** Kết quả IPC `{ success: false }` = nền tảng từ chối → không ghi nhớ mốc, lần sau báo lại. */
type IpcResult = { success?: boolean } | null | undefined | void;

export interface LiveReadEnv {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Hội thoại đang hiện trên màn hình: trang Chat, khung chat hiện, cửa sổ focus, đúng tài khoản / hội thoại / topic. */
  isThreadOnScreen(ref: ReadThreadRef): boolean;
  channelOf(accountId: string): string | undefined;
  /** Tin đang có trong bộ nhớ của hội thoại (store), nếu có. */
  storeRows(ref: ReadThreadRef): ReadonlyArray<ReadRow> | undefined;
  /** Tin mới nhất trong DB (Zalo cần tin thật của khách làm mốc khi bộ nhớ chưa có). */
  dbRows(ref: ReadThreadRef): Promise<ReadonlyArray<ReadRow>>;
  zaloSeen(ref: ReadThreadRef, payload: ReturnType<typeof zaloSeenPayload>): Promise<IpcResult>;
  telegramRead(ref: ReadThreadRef, opts: { historyOnly: boolean }): Promise<IpcResult>;
  telegramTopicRead(ref: ReadThreadRef, readMaxId?: string): Promise<IpcResult>;
  facebookRead(ref: ReadThreadRef): Promise<IpcResult>;
}

interface PendingRead {
  ref: ReadThreadRef;
  /** Tin nhận mới nhất chưa báo (null = chưa biết → lấy từ bộ nhớ lúc báo). */
  latest: IncomingRef | null;
  /** Telegram: đọc cả @ / reaction (mở hội thoại, focus lại, có tin nhắc tới mình) thay vì chỉ ReadHistory. */
  full: boolean;
}

const MAX_REMEMBERED_THREADS = 300;

export function createLiveReadSync(env: LiveReadEnv) {
  let pending: PendingRead | null = null;
  let timer: unknown = null;
  let lastInputAt = 0;
  /** Mốc đã báo của từng hội thoại: lúc báo + id tin nhận mới nhất đã báo. */
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
    // Không có tin nhận nào: Zalo không có gì để "xem"; Telegram / Facebook chỉ báo khi mở hội thoại chủ động
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
      // best effort — lần tin / thao tác sau báo lại
    } finally {
      busy.delete(key);
    }
  }

  async function flushPending(): Promise<void> {
    const read = pending;
    if (!read) return;
    // Không còn hiện / người dùng không ở máy → giữ lại, báo khi họ xem lại (focus + thao tác)
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
     * Tin của người khác vào hội thoại đang hiện trên màn hình (cửa sổ đang focus) — người gọi đã kiểm. `msg` null khi
     * tin không có id (lấy tin mới nhất trong bộ nhớ lúc báo).
     */
    noteIncoming(ref: ReadThreadRef, msg: IncomingRef | null, opts: { mention?: boolean } = {}): void {
      if (!supported(ref)) return;
      if (!pending || keyOf(pending.ref) !== keyOf(ref)) pending = { ref, latest: null, full: false };
      if (msg?.msgId) pending.latest = newerIncoming(pending.latest, msg);
      if (opts.mention) pending.full = true;
      if (isUserPresent(env.now(), lastInputAt)) schedule(LIVE_READ_DELAY_MS);
    },

    /** Cửa sổ vừa focus lại khi hội thoại đang mở: báo khi người dùng có thao tác. */
    noteThreadShown(ref: ReadThreadRef): void {
      if (!supported(ref)) return;
      if (!pending || keyOf(pending.ref) !== keyOf(ref)) pending = { ref, latest: null, full: true };
      else pending.full = true;
      if (isUserPresent(env.now(), lastInputAt)) schedule(PRESENCE_RESUME_DELAY_MS);
    },

    /** Chuột / phím / cuộn trong cửa sổ. */
    noteUserActivity(): void {
      lastInputAt = env.now();
      if (pending && timer === null && env.isThreadOnScreen(pending.ref)) schedule(PRESENCE_RESUME_DELAY_MS);
    },

    /**
     * Người dùng chủ động mở hội thoại → báo ngay (không chờ, không bỏ qua dù đã báo tới cùng tin). `rows` = tin vừa tải
     * (Zalo chọn tin nhận mới nhất làm mốc; không có thì đọc bộ nhớ / DB).
     */
    async syncOpenedThread(ref: ReadThreadRef, rows?: ReadonlyArray<ReadRow>): Promise<void> {
      if (!supported(ref)) return;
      let latest: IncomingRef | null = null;
      if (pending) {
        // Mở hội thoại khác: tin chưa báo của hội thoại cũ giữ nguyên chưa đọc trên nền tảng (người dùng đã rời đi)
        if (keyOf(pending.ref) === keyOf(ref)) latest = pending.latest;
        pending = null;
        stopTimer();
      }
      await send({ ref, latest, full: true }, { force: true, rows });
    },

    /** Test: trạng thái nội bộ. */
    _debug: () => ({ pending: pending ? { ...pending } : null, hasTimer: timer !== null, lastInputAt }),
  };
}

export type LiveReadSync = ReturnType<typeof createLiveReadSync>;

/** Khung chat đang hiện: trang Chat (màn hẹp thì phải đang ở màn chat, không phải danh sách). */
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
    // Popup Nhắn tin nhanh đang hiện hội thoại này (ở trang nào cũng được)
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

/** Theo dõi người dùng có đang thao tác trong cửa sổ không (chuột di chuyển: tối đa 1 lần / giây). Trả hàm gỡ. */
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
