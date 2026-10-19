/**
 * Sticker / GIF Telegram phía renderer — dữ liệu dùng chung giữa bảng Sticker · GIF trong ô nhập và popup bộ sticker,
 * giữ suốt phiên (mở lại bảng hiện ngay bản đã có, đồng thời hỏi lại main — main so `hash` với Telegram nên thay đổi từ
 * app Telegram khác vẫn về). Ảnh sticker tải theo hàng đợi (thứ tự ô hiện ra), tối đa 4 yêu cầu cùng lúc; ô đã cuộn
 * qua mà chưa tới lượt thì bỏ (không tải cả bộ 120 sticker khi chỉ lướt qua).
 */
import React from 'react';
import ipc from '../ipc';
import { toLocalMediaUrl } from '../localMedia';
import { useAccountStore } from '../../store/accountStore';
import { useAppStore } from '../../store/appStore';
import { useChatStore } from '../../store/chatStore';
import { forgetReplyDraft } from './replyDrafts';
import type {
  TelegramCoveredStickerSet,
  TelegramStickerFileKind,
  TelegramStickerItem,
  TelegramStickerSetInfo,
  TelegramStickerSetRef,
} from '../../../shared/telegramStickers';

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

// ── Đăng ký thay đổi (useSyncExternalStore) ───────────────────────────────────────────────────────────────────────

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

/** Re-render khi dữ liệu sticker / GIF đổi. */
export function useTelegramStickerData(): number {
  return React.useSyncExternalStore(subscribe, () => version);
}

const accounts = new Map<string, AccountState>();

function account(accountId: string): AccountState {
  let state = accounts.get(accountId);
  if (!state) accounts.set(accountId, (state = { sets: new Map(), setRequests: new Map() }));
  return state;
}

/** Chỉ dùng trong test. */
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

// ── Bảng sticker ──────────────────────────────────────────────────────────────────────────────────────────────────

export function getStickerPanel(accountId: string): StickerPanelData | undefined {
  return accounts.get(accountId)?.panel;
}

export function getStickerPanelError(accountId: string): string | undefined {
  return accounts.get(accountId)?.panelError;
}

/** Tải (hoặc kiểm tra lại) bảng sticker: bộ đã cài + gần đây + yêu thích. */
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
        state.panelError = res?.error || 'Không tải được sticker';
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

/** Nội dung 1 bộ (theo id + access hash hoặc short name). */
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
      if (!res?.success || !res.set) return { error: res?.error || 'Không tải được bộ sticker' };
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

/** Bộ sticker của 1 tin sticker cũ (chưa lưu thông tin bộ): main hỏi lại Telegram tin đó. */
export async function loadStickerSetOfMessage(accountId: string, chatId: string, messageId: string): Promise<LoadedStickerSet | { error: string }> {
  try {
    const res = await ipc.telegramUser?.getStickerSetOfMessage?.({ accountId, chatId, messageId });
    if (!res?.success || !res.set) return { error: res?.error || 'Không tải được bộ sticker' };
    const loaded = { set: res.set, stickers: res.stickers || [] };
    rememberSet(account(accountId), loaded);
    notify();
    return loaded;
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Tải lần lượt nội dung các bộ đã cài (2 bộ cùng lúc, theo thứ tự trong bảng) — để có biểu tượng bộ ở thanh dưới và các
 * mục sticker khi cuộn. Mỗi bộ 1 lần / phiên (main kiểm tra hash).
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

/** Thêm / gỡ bộ khỏi tài khoản; cập nhật ngay bảng (thêm lên đầu như Telegram, gỡ thì bỏ khỏi bảng). */
export async function setStickerSetInstalled(accountId: string, set: TelegramStickerSetInfo, installed: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await ipc.telegramUser?.setStickerSetInstalled?.({
      accountId, setId: set.id, accessHash: set.accessHash, shortName: set.shortName, installed,
    });
    if (!res?.success) return { success: false, error: res?.error || 'Không thực hiện được' };
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

/** Tìm bộ sticker (từ khoá rỗng = bộ thịnh hành). Kết quả không lưu lại — trạng thái "đã thêm" lấy từ bảng hiện tại. */
export async function searchTelegramStickerSets(accountId: string, query: string): Promise<{ sets: TelegramCoveredStickerSet[]; error?: string }> {
  try {
    const res = await ipc.telegramUser?.searchStickerSets?.({ accountId, query });
    if (!res?.success) return { sets: [], error: res?.error || 'Không tìm được bộ sticker' };
    return { sets: res.sets || [] };
  } catch (err: any) {
    return { sets: [], error: err?.message || String(err) };
  }
}

/** Bộ đã có trong bảng của tài khoản chưa (sau khi thêm / gỡ ở đây cập nhật ngay). */
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
      // giữ danh sách cũ
    } finally {
      state.gifsRequest = undefined;
      notify();
    }
  })();
  state.gifsRequest = request;
  return request;
}

/** Bỏ GIF khỏi "GIF đã lưu" của tài khoản (ẩn ngay, lấy lại danh sách sau). */
export async function removeSavedGif(accountId: string, docId: string): Promise<boolean> {
  const state = account(accountId);
  const previous = state.savedGifs;
  if (previous) {
    state.savedGifs = previous.filter((gif) => gif.id !== docId);
    notify();
  }
  try {
    const res = await ipc.telegramUser?.saveGif?.({ accountId, docId, saved: false });
    if (!res?.success) throw new Error(res?.error || 'Không bỏ được GIF');
    loadSavedGifs(accountId).catch(() => {});
    return true;
  } catch (err: any) {
    state.savedGifs = previous;
    notify();
    useAppStore.getState().showNotification(`Không bỏ được GIF: ${err?.message || String(err)}`, 'error');
    return false;
  }
}

export async function searchTelegramGifs(accountId: string, query: string, offset = ''): Promise<{ gifs: TelegramStickerItem[]; nextOffset: string; error?: string }> {
  try {
    const res = await ipc.telegramUser?.searchGifs?.({ accountId, query, offset });
    if (!res?.success) return { gifs: [], nextOffset: '', error: res?.error || 'Không tìm được GIF' };
    return { gifs: res.gifs || [], nextOffset: res.nextOffset || '' };
  } catch (err: any) {
    return { gifs: [], nextOffset: '', error: err?.message || String(err) };
  }
}

// ── File để vẽ ────────────────────────────────────────────────────────────────────────────────────────────────────

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
    // Theo thứ tự ô hiện ra (trên → dưới); việc không còn ai chờ (ô đã cuộn qua, tự huỷ) thì bỏ
    const job = fileQueue.shift()!;
    if (job.waiters.size === 0) { fileJobs.delete(job.key); continue; }
    job.started = true;
    activeFileRequests++;
    job.run()
      .catch(() => null)
      .then((file) => {
        // Lỗi (mất mạng, quá hạn) không ghi nhớ: ô hiện lại thì thử lại
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
 * Xin file vẽ sticker / GIF; `onReady` được gọi khi có (null = lỗi). Trả về hàm huỷ — ô rời khỏi màn hình thì huỷ để
 * việc chưa chạy không chiếm lượt.
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

/** Hook: file của sticker khi `enabled` (ô đang hiện / đang rê chuột). */
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

// ── Gửi ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StickerSendTarget {
  accountId: string;
  chatId: string;
  topicId?: string | null;
}

/** Hội thoại đang mở (tài khoản Telegram cá nhân). */
export function activeStickerTarget(): StickerSendTarget | null {
  const accountId = useAccountStore.getState().activeAccountId;
  const { activeThreadId, activeTopicId } = useChatStore.getState();
  if (!accountId || !activeThreadId) return null;
  return { accountId, chatId: activeThreadId, topicId: activeTopicId };
}

/**
 * Gửi sticker / GIF vào hội thoại (đang trả lời tin nào thì gửi dạng trả lời tin đó, như Telegram). Tin hiện ra qua
 * event của main (lưu như tin của mình gửi từ thiết bị khác).
 */
export async function sendTelegramStickerItem(item: TelegramStickerItem, target: StickerSendTarget | null = activeStickerTarget()): Promise<boolean> {
  const notifyError = (message: string) => useAppStore.getState().showNotification(message, 'error');
  if (!target) { notifyError('Chưa mở hội thoại'); return false; }
  const chat = useChatStore.getState();
  const reply = chat.activeThreadId === target.chatId ? chat.replyTo : null;
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
      notifyError(`${item.format === 'gif' ? 'Gửi GIF' : 'Gửi sticker'} thất bại: ${res?.error || 'lỗi không rõ'}`);
      return false;
    }
    if (reply) {
      forgetReplyDraft(reply);
      if (useChatStore.getState().replyTo === reply) useChatStore.getState().setReplyTo(null);
    }
    // Gần đây / GIF đã lưu đổi trên tài khoản → lần mở bảng sau lấy lại
    if (item.format === 'gif') loadSavedGifs(target.accountId).catch(() => {});
    else loadStickerPanel(target.accountId).catch(() => {});
    return true;
  } catch (err: any) {
    notifyError(`Gửi thất bại: ${err?.message || String(err)}`);
    return false;
  }
}

// ── Popup bộ sticker ──────────────────────────────────────────────────────────────────────────────────────────────

export interface StickerSetModalRequest {
  accountId: string;
  /** Có thì gửi sticker bấm trong popup vào hội thoại này. */
  target?: StickerSendTarget | null;
  ref?: TelegramStickerSetRef;
  /** Tin sticker cũ chưa có thông tin bộ → hỏi lại Telegram theo tin. */
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
 * Mở popup bộ sticker của 1 tin sticker Telegram (cá nhân). Tin lưu từ bản này có sẵn thông tin bộ; tin cũ thì main hỏi
 * lại Telegram theo tin. Sticker bấm trong popup gửi vào hội thoại đang mở.
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

/** Thông tin bộ của tin sticker Telegram (attachment có set_id / set_short_name từ bản này trở đi). */
export function stickerSetRefOfAttachment(attachment: any): TelegramStickerSetRef | null {
  if (!attachment) return null;
  const id = attachment.set_id ? String(attachment.set_id) : '';
  const accessHash = attachment.set_access_hash ? String(attachment.set_access_hash) : '';
  const shortName = attachment.set_short_name ? String(attachment.set_short_name) : '';
  if (id && accessHash) return { id, accessHash, ...(shortName ? { shortName } : {}) };
  if (shortName) return { shortName };
  return null;
}
