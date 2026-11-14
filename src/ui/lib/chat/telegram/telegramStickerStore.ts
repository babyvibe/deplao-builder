/**
 * Telegram sticker / GIF on the renderer side: data shared between the Sticker · GIF panel in the input box and the sticker-set popup,
 * kept for the whole session (reopening the panel shows what is already there at once, and also asks main again: main compares `hash` with Telegram, so changes made from
 * another Telegram app still come back). Sticker images load through a queue (in the order the cells appear), at most 4 requests at once; a cell that was
 * scrolled past before its turn is dropped (the whole set of 120 stickers is not loaded just because the user scrolled past).
 */
import React from 'react';
import ipc from '../../ipc';
import { toLocalMediaUrl } from '../../media/localMedia';
import { useAccountStore } from '../../../store/accounts/accountStore';
import { useAppStore } from '../../../store/app/appStore';
import { useChatStore } from '../../../store/chat/chatStore';
import { forgetReplyDraft } from '../composer/replyDrafts';
import type {
  TelegramCoveredStickerSet,
  TelegramStickerFileKind,
  TelegramStickerItem,
  TelegramStickerSetInfo,
  TelegramStickerSetRef,
} from '../../../../shared/telegram/telegramStickers';
import { tr } from '../../../../shared/i18n';

export type { TelegramCoveredStickerSet, TelegramStickerItem, TelegramStickerSetInfo, TelegramStickerSetRef };

export interface StickerPanelData {
  sets: TelegramStickerSetInfo[];
  recent: TelegramStickerItem[];
  faved: TelegramStickerItem[];
}

export interface LoadedStickerSet {
  set: TelegramStickerSetInfo;
  stickers: TelegramStickerItem[];
}

interface AccountState {
  panel?: StickerPanelData;
  panelError?: string;
  panelRequest?: Promise<void>;
  sets: Map<string, LoadedStickerSet>;
  setRequests: Map<string, Promise<LoadedStickerSet | { error: string }>>;
  savedGifs?: TelegramStickerItem[];
  gifsRequest?: Promise<void>;
}

// ── Change subscription (useSyncExternalStore) ───────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-render when the sticker / GIF data changes. */
export function useTelegramStickerData(): number {
  return React.useSyncExternalStore(subscribe, () => version);
}

const accounts = new Map<string, AccountState>();

function account(accountId: string): AccountState {
  let state = accounts.get(accountId);
  if (!state) accounts.set(accountId, (state = { sets: new Map(), setRequests: new Map() }));
  return state;
}

/** Test only. */
export function __resetTelegramStickerStore(): void {
  accounts.clear();
  fileCache.clear();
  fileJobs.clear();
  fileQueue.length = 0;
  activeFileRequests = 0;
  modalState = null;
  version = 0;
}

export function stickerSetKey(ref: TelegramStickerSetRef): string {
  return ref.id ? `id:${ref.id}` : `name:${String(ref.shortName || '').toLowerCase()}`;
}

// ── Sticker panel ──────────────────────────────────────────────────────────────────────────────────────────────────

export function getStickerPanel(accountId: string): StickerPanelData | undefined {
  return accounts.get(accountId)?.panel;
}

export function getStickerPanelError(accountId: string): string | undefined {
  return accounts.get(accountId)?.panelError;
}

/** Loads (or re-checks) the sticker panel: installed sets + recent + favourites. */
export function loadStickerPanel(accountId: string): Promise<void> {
  const state = account(accountId);
  if (state.panelRequest) return state.panelRequest;
  const request = (async () => {
    try {
      const res = await ipc.telegramUser?.getStickerPanel?.({ accountId });
      if (res?.success) {
        state.panel = { sets: res.sets || [], recent: res.recent || [], faved: res.faved || [] };
        state.panelError = undefined;
      } else {
        state.panelError = res?.error || tr('Không tải được sticker');
      }
    } catch (err: any) {
      state.panelError = err?.message || String(err);
    } finally {
      state.panelRequest = undefined;
      notify();
    }
  })();
  state.panelRequest = request;
  return request;
}

export function getLoadedStickerSet(accountId: string, ref: TelegramStickerSetRef): LoadedStickerSet | undefined {
  return accounts.get(accountId)?.sets.get(stickerSetKey(ref));
}

function rememberSet(state: AccountState, loaded: LoadedStickerSet, requested?: TelegramStickerSetRef): void {
  state.sets.set(stickerSetKey({ id: loaded.set.id }), loaded);
  if (loaded.set.shortName) state.sets.set(stickerSetKey({ shortName: loaded.set.shortName }), loaded);
  if (requested) state.sets.set(stickerSetKey(requested), loaded);
}

/** Contents of 1 set (by id + access hash or short name). */
export function loadStickerSet(accountId: string, ref: TelegramStickerSetRef, force = false): Promise<LoadedStickerSet | { error: string }> {
  const state = account(accountId);
  const key = stickerSetKey(ref);
  const existing = state.sets.get(key);
  if (existing && !force) return Promise.resolve(existing);
  const running = state.setRequests.get(key);
  if (running) return running;
  const request = (async (): Promise<LoadedStickerSet | { error: string }> => {
    try {
      const res = await ipc.telegramUser?.getStickerSet?.({
        accountId,
        ...(ref.id && ref.accessHash ? { setId: ref.id, accessHash: ref.accessHash } : {}),
        ...(ref.shortName ? { shortName: ref.shortName } : {}),
      });
      if (!res?.success || !res.set) return { error: res?.error || tr('Không tải được bộ sticker') };
      const loaded = { set: res.set, stickers: res.stickers || [] };
      rememberSet(state, loaded, ref);
      notify();
      return loaded;
    } catch (err: any) {
      return { error: err?.message || String(err) };
    } finally {
      state.setRequests.delete(key);
    }
  })();
  state.setRequests.set(key, request);
  return request;
}

/** Sticker set of an old sticker message (set info not saved yet): main asks Telegram for that message again. */
export async function loadStickerSetOfMessage(accountId: string, chatId: string, messageId: string): Promise<LoadedStickerSet | { error: string }> {
  try {
    const res = await ipc.telegramUser?.getStickerSetOfMessage?.({ accountId, chatId, messageId });
    if (!res?.success || !res.set) return { error: res?.error || tr('Không tải được bộ sticker') };
    const loaded = { set: res.set, stickers: res.stickers || [] };
    rememberSet(account(accountId), loaded);
    notify();
    return loaded;
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Loads the contents of the installed sets one after another (2 sets at a time, in the panel's order), so the set icons in the bottom bar and the
 * sticker sections are available when scrolling. Each set once per session (main checks the hash).
 */
export async function preloadStickerSets(accountId: string, sets: TelegramStickerSetInfo[], isCancelled: () => boolean): Promise<void> {
  const queue = sets.filter((set) => !getLoadedStickerSet(accountId, { id: set.id }));
  const worker = async () => {
    while (queue.length > 0 && !isCancelled()) {
      const set = queue.shift()!;
      await loadStickerSet(accountId, { id: set.id, accessHash: set.accessHash, shortName: set.shortName });
    }
  };
  await Promise.all([worker(), worker()]);
}

/** Adds / removes a set from the account; updates the panel at once (added at the top as in Telegram, removed sets are taken off the panel). */
export async function setStickerSetInstalled(accountId: string, set: TelegramStickerSetInfo, installed: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await ipc.telegramUser?.setStickerSetInstalled?.({
      accountId, setId: set.id, accessHash: set.accessHash, shortName: set.shortName, installed,
    });
    if (!res?.success) return { success: false, error: res?.error || tr('Không thực hiện được') };
    const state = account(accountId);
    const updated = { ...set, installed, archived: false };
    for (const [key, loaded] of state.sets) {
      if (loaded.set.id === set.id) state.sets.set(key, { ...loaded, set: updated });
    }
    if (state.panel) {
      const others = state.panel.sets.filter((item) => item.id !== set.id);
      state.panel = { ...state.panel, sets: installed ? [updated, ...others] : others };
    }
    notify();
    loadStickerPanel(accountId).catch(() => {});
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Searches sticker sets (an empty keyword = trending sets). Results are not saved: the "đã thêm" (added) state comes from the current panel. */
export async function searchTelegramStickerSets(accountId: string, query: string): Promise<{ sets: TelegramCoveredStickerSet[]; error?: string }> {
  try {
    const res = await ipc.telegramUser?.searchStickerSets?.({ accountId, query });
    if (!res?.success) return { sets: [], error: res?.error || tr('Không tìm được bộ sticker') };
    return { sets: res.sets || [] };
  } catch (err: any) {
    return { sets: [], error: err?.message || String(err) };
  }
}

/** Whether the set is already in the account's panel (updated at once after adding / removing here). */
export function isStickerSetInstalled(accountId: string, setId: string): boolean {
  const state = accounts.get(accountId);
  if (state?.panel) return state.panel.sets.some((set) => set.id === setId);
  return !!state?.sets.get(stickerSetKey({ id: setId }))?.set.installed;
}

// ── GIF ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function getSavedGifs(accountId: string): TelegramStickerItem[] | undefined {
  return accounts.get(accountId)?.savedGifs;
}

export function loadSavedGifs(accountId: string): Promise<void> {
  const state = account(accountId);
  if (state.gifsRequest) return state.gifsRequest;
  const request = (async () => {
    try {
      const res = await ipc.telegramUser?.getGifs?.({ accountId });
      if (res?.success) state.savedGifs = res.gifs || [];
    } catch {
      // keep the old list
    } finally {
      state.gifsRequest = undefined;
      notify();
    }
  })();
  state.gifsRequest = request;
  return request;
}

/** Removes a GIF from the account's "GIF đã lưu" (saved GIFs) (hidden at once, the list is fetched again later). */
export async function removeSavedGif(accountId: string, docId: string): Promise<boolean> {
  const state = account(accountId);
  const previous = state.savedGifs;
  if (previous) {
    state.savedGifs = previous.filter((gif) => gif.id !== docId);
    notify();
  }
  try {
    const res = await ipc.telegramUser?.saveGif?.({ accountId, docId, saved: false });
    if (!res?.success) throw new Error(res?.error || tr('Không bỏ được GIF'));
    loadSavedGifs(accountId).catch(() => {});
    return true;
  } catch (err: any) {
    state.savedGifs = previous;
    notify();
    useAppStore.getState().showNotification(tr('Không bỏ được GIF: {{v1}}', { v1: err?.message || String(err) }), 'error');
    return false;
  }
}

export async function searchTelegramGifs(accountId: string, query: string, offset = ''): Promise<{ gifs: TelegramStickerItem[]; nextOffset: string; error?: string }> {
  try {
    const res = await ipc.telegramUser?.searchGifs?.({ accountId, query, offset });
    if (!res?.success) return { gifs: [], nextOffset: '', error: res?.error || tr('Không tìm được GIF') };
    return { gifs: res.gifs || [], nextOffset: res.nextOffset || '' };
  } catch (err: any) {
    return { gifs: [], nextOffset: '', error: err?.message || String(err) };
  }
}

// ── Files to draw ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StickerFile {
  url: string;
  kind: TelegramStickerFileKind;
  localPath: string;
}

const MAX_FILE_REQUESTS = 4;
const fileCache = new Map<string, StickerFile | null>();
interface FileJob { key: string; run: () => Promise<StickerFile | null>; waiters: Set<(file: StickerFile | null) => void>; started: boolean }
const fileJobs = new Map<string, FileJob>();
const fileQueue: FileJob[] = [];
let activeFileRequests = 0;

function fileKey(accountId: string, docId: string, variant: 'thumb' | 'full'): string {
  return `${accountId}:${docId}:${variant}`;
}

export function getCachedStickerFile(accountId: string, docId: string, variant: 'thumb' | 'full'): StickerFile | null | undefined {
  return fileCache.get(fileKey(accountId, docId, variant));
}

function pumpFileQueue(): void {
  while (activeFileRequests < MAX_FILE_REQUESTS && fileQueue.length > 0) {
    // In the order the cells appear (top → bottom); a job nobody waits for any more (the cell was scrolled past, cancelled itself) is dropped
    const job = fileQueue.shift()!;
    if (job.waiters.size === 0) { fileJobs.delete(job.key); continue; }
    job.started = true;
    activeFileRequests++;
    job.run()
      .catch(() => null)
      .then((file) => {
        // Errors (network loss, timeout) are not remembered: the cell tries again when it shows again
        if (file) fileCache.set(job.key, file);
        fileJobs.delete(job.key);
        job.waiters.forEach((waiter) => waiter(file));
      })
      .finally(() => {
        activeFileRequests--;
        pumpFileQueue();
      });
  }
}

/**
 * Requests the drawable file of a sticker / GIF; `onReady` is called when it is available (null = error). Returns a cancel function: when the cell leaves the screen, cancel it so
 * the job that has not run yet does not take a turn.
 */
export function requestStickerFile(
  accountId: string,
  docId: string,
  variant: 'thumb' | 'full',
  onReady: (file: StickerFile | null) => void,
): () => void {
  const key = fileKey(accountId, docId, variant);
  if (fileCache.has(key)) {
    onReady(fileCache.get(key) ?? null);
    return () => {};
  }
  let job = fileJobs.get(key);
  if (!job) {
    job = {
      key,
      started: false,
      waiters: new Set(),
      run: async () => {
        const res = await ipc.telegramUser?.getStickerFile?.({ accountId, docId, variant });
        if (!res?.success || !res.localPath) return null;
        return { url: toLocalMediaUrl(res.localPath), kind: res.kind || 'image', localPath: res.localPath };
      },
    };
    fileJobs.set(key, job);
    fileQueue.push(job);
  }
  job.waiters.add(onReady);
  const current = job;
  pumpFileQueue();
  return () => { current.waiters.delete(onReady); };
}

/** Hook: the sticker's file when `enabled` (the cell is shown / hovered). */
export function useStickerFile(accountId: string, docId: string, variant: 'thumb' | 'full', enabled: boolean): StickerFile | null | undefined {
  const [file, setFile] = React.useState<StickerFile | null | undefined>(() => getCachedStickerFile(accountId, docId, variant));
  React.useEffect(() => {
    const cached = getCachedStickerFile(accountId, docId, variant);
    setFile(cached);
    if (cached !== undefined || !enabled || !accountId || !docId) return undefined;
    return requestStickerFile(accountId, docId, variant, setFile);
  }, [accountId, docId, variant, enabled]);
  return file;
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StickerSendTarget {
  accountId: string;
  chatId: string;
  topicId?: string | null;
  /**
   * A composer sending to a place other than the open conversation (the comments of a channel post → the discussion group): the message that composer is replying to.
   * None → the general quote, only when sending to the conversation that is open.
   */
  replyTo?: import('../../../store/chat/chatStore').MessageItem | null;
}

/** The open conversation (personal Telegram account). */
export function activeStickerTarget(): StickerSendTarget | null {
  const accountId = useAccountStore.getState().activeAccountId;
  const { activeThreadId, activeTopicId } = useChatStore.getState();
  if (!accountId || !activeThreadId) return null;
  return { accountId, chatId: activeThreadId, topicId: activeTopicId };
}

/**
 * Sends a sticker / GIF to the conversation (if a message is being replied to, it is sent as a reply to that message, as in Telegram). The message appears through
 * an event from main (saved like my own message sent from another device).
 */
export async function sendTelegramStickerItem(item: TelegramStickerItem, target: StickerSendTarget | null = activeStickerTarget()): Promise<boolean> {
  const notifyError = (message: string) => useAppStore.getState().showNotification(message, 'error');
  if (!target) { notifyError(tr('Chưa mở hội thoại')); return false; }
  const chat = useChatStore.getState();
  const reply = target.replyTo !== undefined
    ? target.replyTo
    : chat.activeThreadId === target.chatId ? chat.replyTo : null;
  const replyToMsgId = reply?.msg_id && /^\d+$/.test(String(reply.msg_id)) ? String(reply.msg_id) : undefined;
  const common = {
    accountId: target.accountId,
    chatId: target.chatId,
    ...(replyToMsgId ? { replyToMsgId } : {}),
    ...(target.topicId ? { topicRootMessageId: String(target.topicId) } : {}),
  };
  try {
    const res = item.format === 'gif'
      ? await ipc.telegramUser?.sendGif?.({ ...common, documentId: item.id })
      : await ipc.telegramUser?.sendSticker?.({ ...common, stickerId: item.id });
    if (!res?.success) {
      notifyError(tr('{{v1}} thất bại: {{v2}}', { v1: item.format === 'gif' ? tr('Gửi GIF') : tr('Gửi sticker'), v2: res?.error || tr('lỗi không rõ') }));
      return false;
    }
    if (reply) {
      forgetReplyDraft(reply);
      if (useChatStore.getState().replyTo === reply) useChatStore.getState().setReplyTo(null);
    }
    // Recent / saved GIFs changed on the account → fetched again the next time the panel opens
    if (item.format === 'gif') loadSavedGifs(target.accountId).catch(() => {});
    else loadStickerPanel(target.accountId).catch(() => {});
    return true;
  } catch (err: any) {
    notifyError(tr('Gửi thất bại: {{v1}}', { v1: err?.message || String(err) }));
    return false;
  }
}

// ── Sticker set popup ──────────────────────────────────────────────────────────────────────────────────────────────

export interface StickerSetModalRequest {
  accountId: string;
  /** If set, a sticker tapped in the popup is sent to this conversation. */
  target?: StickerSendTarget | null;
  ref?: TelegramStickerSetRef;
  /** Old sticker message without set info → ask Telegram again for that message. */
  message?: { chatId: string; messageId: string };
}

let modalState: StickerSetModalRequest | null = null;
const modalListeners = new Set<() => void>();

export function openTelegramStickerSet(request: StickerSetModalRequest): void {
  modalState = request;
  modalListeners.forEach((listener) => listener());
}

export function closeTelegramStickerSet(): void {
  modalState = null;
  modalListeners.forEach((listener) => listener());
}

export function getTelegramStickerSetRequest(): StickerSetModalRequest | null {
  return modalState;
}

export function useTelegramStickerSetModal(): StickerSetModalRequest | null {
  return React.useSyncExternalStore(
    (listener) => { modalListeners.add(listener); return () => { modalListeners.delete(listener); }; },
    () => modalState,
  );
}

/**
 * Opens the sticker-set popup of 1 Telegram sticker message (personal). Messages saved from this version already have the set info; for old messages main asks
 * Telegram again for that message. A sticker tapped in the popup is sent to the open conversation.
 */
export function openStickerSetOfMessage(msg: { owner_zalo_id?: string; thread_id?: string; msg_id?: string; attachments?: any; channel?: string }): void {
  const accountId = String(msg.owner_zalo_id || '');
  if (!accountId) return;
  let attachments: any[] = [];
  try {
    attachments = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg.attachments || []);
  } catch {
    attachments = [];
  }
  const sticker = (Array.isArray(attachments) ? attachments : []).find((item: any) => item?.is_sticker === true || item?.type === 'sticker');
  const ref = stickerSetRefOfAttachment(sticker);
  const messageId = String(msg.msg_id || '');
  openTelegramStickerSet({
    accountId,
    target: activeStickerTarget(),
    ...(ref ? { ref } : {}),
    ...(msg.thread_id && /^\d+$/.test(messageId) ? { message: { chatId: String(msg.thread_id), messageId } } : {}),
  });
}

/** Set info of a Telegram sticker message (the attachment has set_id / set_short_name from this version on). */
export function stickerSetRefOfAttachment(attachment: any): TelegramStickerSetRef | null {
  if (!attachment) return null;
  const id = attachment.set_id ? String(attachment.set_id) : '';
  const accessHash = attachment.set_access_hash ? String(attachment.set_access_hash) : '';
  const shortName = attachment.set_short_name ? String(attachment.set_short_name) : '';
  if (id && accessHash) return { id, accessHash, ...(shortName ? { shortName } : {}) };
  if (shortName) return { shortName };
  return null;
}
