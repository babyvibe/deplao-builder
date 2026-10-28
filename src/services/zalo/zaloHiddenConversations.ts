/**
 * zaloHiddenConversations.ts — hội thoại ẩn bằng PIN của Zalo (ZL-03, SRS Deplao) ở main process (máy Boss).
 *
 * - Danh sách ẩn và PIN nằm trên máy chủ Zalo, dùng chung mọi thiết bị. getHiddenConversations trả PIN dạng MD5 của 4 chữ
 *   số, không salt → chỉ chống nhìn trộm, không phải mã hoá. MD5 chỉ giữ trong bộ nhớ main của Boss: không IPC nào trả
 *   nó cho giao diện, máy nhân viên, Public API hay Ứng dụng.
 * - contacts.zalo_hidden = 1 cho hội thoại đang ẩn (thay cả tập mỗi lần đọc) → giao diện lọc khi đang khoá; báo qua
 *   db:contactFlagsChanged (relay cho nhân viên). API / workflow / Ứng dụng giữ nguyên hành vi (quyết định Q2).
 * - Mở khoá: so MD5 của 4 số gõ vào ô tìm kiếm; sai 5 lần trong 1 phút → ngừng so 30 s (như khoá màn hình).
 * - Listener zca-js không báo khi ẩn / đổi / xoá PIN trên điện thoại → đọc lại khi kết nối (tối đa 6 giờ / lần), khi bấm
 *   kính lúp đỏ của ô tìm kiếm / mở Cài đặt, và khi gõ PIN không khớp mà lần đọc gần nhất đã quá 30 s (PIN vừa đổi trên điện thoại).
 * - Zalo không còn mã PIN (xoá / đặt lại trên điện thoại) → không còn gì để khoá: mọi hội thoại hiện như thường.
 * - Quên PIN → đặt lại (resetHiddenConversPin): Zalo có thể xoá tin của các hội thoại đang ẩn trên thiết bị Zalo; Deplao
 *   giữ tin trên máy. Giao diện hỏi xác nhận 2 lần (quyết định Q5, chủ dự án đổi ngày 22/10/2026: mở cho mọi người).
 */
import * as crypto from 'crypto';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

export const HIDDEN_PIN_PATTERN = /^\d{4}$/;
export const HIDDEN_UNLOCK_MAX_FAILS = 5;
export const HIDDEN_UNLOCK_WINDOW_MS = 60_000;
export const HIDDEN_UNLOCK_LOCK_MS = 30_000;
export const HIDDEN_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Gõ PIN không khớp → đọc lại từ Zalo nếu lần đọc gần nhất cũ hơn mốc này (không hỏi Zalo mỗi lần gõ 4 chữ số). */
export const HIDDEN_RECHECK_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Cầu nối tới zca-js (ZaloService dựng) — để test thay được. */
export interface ZaloHiddenApi {
  getHiddenConversations(): Promise<any>;
  /** isGroup: true = nhóm. Một lần gọi chỉ một loại hội thoại. */
  setHiddenConversations(hidden: boolean, threadIds: string[], isGroup: boolean): Promise<any>;
  updateHiddenConversPin(pin: string): Promise<any>;
  /** Quên PIN: Zalo xoá PIN (và có thể cả tin của hội thoại đang ẩn trên thiết bị Zalo). */
  resetHiddenConversPin(): Promise<any>;
}

/** Cầu nối từ API zca-js (ThreadType: 0 = người dùng, 1 = nhóm). */
export function zaloHiddenApiOf(api: any): ZaloHiddenApi {
  return {
    getHiddenConversations: () => api.getHiddenConversations(),
    setHiddenConversations: (hidden, threadIds, isGroup) => api.setHiddenConversations(hidden, threadIds, isGroup ? 1 : 0),
    updateHiddenConversPin: (pin) => api.updateHiddenConversPin(pin),
    resetHiddenConversPin: () => api.resetHiddenConversPin(),
  };
}

export interface HiddenStatus {
  /** Đã đọc danh sách từ Zalo trong phiên này. */
  known: boolean;
  hasPin: boolean;
  hiddenCount: number;
}

export type UnlockResult =
  | { ok: true; threadIds: string[] }
  | { ok: false; reason: 'wrong' | 'locked' | 'no-pin' | 'invalid'; retryAfterMs?: number };

interface HiddenState { pinHash: string; threads: Map<string, boolean>; readAt: number }

const states = new Map<string, HiddenState>();
const attempts = new Map<string, { fails: number[]; lockedUntil: number }>();
const lastRefreshAt = new Map<string, number>();

export function md5Pin(pin: string): string {
  return crypto.createHash('md5').update(pin).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function withTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Zalo không phản hồi')), FETCH_TIMEOUT_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Phản hồi getHiddenConversations → MD5 PIN ('' = chưa đặt) + id hội thoại → là nhóm. */
export function parseHiddenConversations(res: any): { pinHash: string; threads: Map<string, boolean> } {
  const pinHash = typeof res?.pin === 'string' ? res.pin.trim().toLowerCase() : '';
  const threads = new Map<string, boolean>();
  for (const item of Array.isArray(res?.threads) ? res.threads : []) {
    const id = String(item?.thread_id ?? '').trim();
    if (id) threads.set(id, Number(item?.is_group) === 1);
  }
  return { pinHash: /^[0-9a-f]{32}$/.test(pinHash) ? pinHash : '', threads };
}

function emitHidden(zaloId: string, contactId: string, hidden: boolean): void {
  EventBroadcaster.emit('db:contactFlagsChanged', { ownerZaloId: zaloId, contactId, flags: { zalo_hidden: hidden ? 1 : 0 } });
}

/**
 * Ghi trạng thái đọc được: bộ nhớ (MD5) + DB (thay cả tập) + báo giao diện các hội thoại đổi. Không có PIN thì không
 * hội thoại nào bị khoá (không có gì để gõ mở) — kể cả khi Zalo còn trả danh sách cũ.
 */
function applyState(zaloId: string, res: any, now: number): HiddenState {
  const parsed = parseHiddenConversations(res);
  const threads = parsed.pinHash ? parsed.threads : new Map<string, boolean>();
  if (!parsed.pinHash && parsed.threads.size > 0) {
    Logger.warn(`[ZaloHidden] ${zaloId}: Zalo không còn mã PIN nhưng còn ${parsed.threads.size} hội thoại trong danh sách ẩn — hiện lại như thường`);
  }
  const state: HiddenState = { pinHash: parsed.pinHash, threads, readAt: now };
  states.set(zaloId, state);
  lastRefreshAt.set(zaloId, now);
  const changed = EventBroadcaster.withBossDb((db) => db.replaceContactHidden(zaloId, new Set(threads.keys())));
  for (const item of changed) emitHidden(zaloId, item.contactId, item.hidden);
  return state;
}

export function hiddenStatus(zaloId: string): HiddenStatus {
  const state = states.get(zaloId);
  return { known: !!state, hasPin: !!state?.pinHash, hiddenCount: state?.threads.size ?? 0 };
}

/** Đọc lại từ Zalo ngay (mở khoá, bấm làm mới, cài đặt). */
export async function syncZaloHidden(zaloId: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<HiddenStatus> {
  applyState(zaloId, await withTimeout(api.getHiddenConversations()), now);
  return hiddenStatus(zaloId);
}

/** Sau khi kết nối: đọc nếu phiên này chưa đọc trong 6 giờ. Chạy nền, không ném lỗi. */
export async function refreshZaloHidden(zaloId: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<HiddenStatus | null> {
  if (!zaloId) return null;
  const last = lastRefreshAt.get(zaloId);
  if (last !== undefined && now - last < HIDDEN_REFRESH_MS) return null;
  lastRefreshAt.set(zaloId, now);
  try {
    return await syncZaloHidden(zaloId, api, now);
  } catch (err: any) {
    lastRefreshAt.delete(zaloId);
    Logger.warn(`[ZaloHidden] ${zaloId}: getHiddenConversations failed: ${err?.message || err}`);
    return null;
  }
}

function lockedFor(zaloId: string, now: number): number {
  const entry = attempts.get(zaloId);
  return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
}

function recordFail(zaloId: string, now: number): void {
  const entry = attempts.get(zaloId) || { fails: [], lockedUntil: 0 };
  entry.fails = entry.fails.filter((t) => now - t < HIDDEN_UNLOCK_WINDOW_MS);
  entry.fails.push(now);
  if (entry.fails.length >= HIDDEN_UNLOCK_MAX_FAILS) {
    entry.lockedUntil = now + HIDDEN_UNLOCK_LOCK_MS;
    entry.fails = [];
    Logger.warn(`[ZaloHidden] ${zaloId}: ${HIDDEN_UNLOCK_MAX_FAILS} lần sai PIN — ngừng so ${HIDDEN_UNLOCK_LOCK_MS / 1000} s`);
  }
  attempts.set(zaloId, entry);
}

function pinMatches(pin: string, state: HiddenState | undefined): boolean {
  return !!state?.pinHash && sameHash(md5Pin(pin), state.pinHash);
}

/**
 * So PIN gõ vào ô tìm kiếm. Chưa đọc danh sách trong phiên → đọc từ Zalo trước; không khớp mà lần đọc đã quá 30 s → đọc
 * lại một lần rồi so tiếp (PIN đổi / xoá trên điện thoại). Sai không báo gì ở giao diện (4 chữ số vẫn là tìm kiếm thường);
 * 5 lần sai / 1 phút → ngừng so 30 s.
 */
export async function unlockZaloHidden(zaloId: string, pin: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<UnlockResult> {
  if (!HIDDEN_PIN_PATTERN.test(pin)) return { ok: false, reason: 'invalid' };
  const wait = lockedFor(zaloId, now);
  if (wait > 0) return { ok: false, reason: 'locked', retryAfterMs: wait };
  let state = states.get(zaloId);
  if (!state || now - state.readAt > HIDDEN_REFRESH_MS) {
    await syncZaloHidden(zaloId, api, now);
    state = states.get(zaloId);
  } else if (!pinMatches(pin, state) && now - state.readAt >= HIDDEN_RECHECK_MS) {
    try {
      await syncZaloHidden(zaloId, api, now);
      state = states.get(zaloId);
    } catch (err: any) {
      Logger.warn(`[ZaloHidden] ${zaloId}: đọc lại khi so PIN lỗi: ${err?.message || err}`);
    }
  }
  if (!state?.pinHash) return { ok: false, reason: 'no-pin' };
  if (!pinMatches(pin, state)) {
    recordFail(zaloId, now);
    return { ok: false, reason: 'wrong' };
  }
  attempts.delete(zaloId);
  return { ok: true, threadIds: Array.from(state.threads.keys()) };
}

/** Ẩn / bỏ ẩn một hội thoại trên Zalo rồi ghi DB + báo giao diện. Ẩn khi chưa có PIN → lỗi (giao diện đặt PIN trước). */
export async function setZaloConversationHidden(
  zaloId: string, threadId: string, isGroup: boolean, hidden: boolean, api: ZaloHiddenApi, now: number = Date.now(),
): Promise<HiddenStatus> {
  if (!threadId) throw new Error('Thiếu threadId');
  let state = states.get(zaloId);
  if (!state) {
    await syncZaloHidden(zaloId, api, now);
    state = states.get(zaloId);
  }
  if (hidden && !state?.pinHash) throw new Error('Chưa đặt mã PIN cho hội thoại ẩn');
  await withTimeout(api.setHiddenConversations(hidden, [threadId], isGroup));
  const current = states.get(zaloId);
  if (current) {
    if (hidden) current.threads.set(threadId, isGroup);
    else current.threads.delete(threadId);
  }
  if (EventBroadcaster.withBossDb((db) => db.setContactHidden(zaloId, threadId, hidden))) emitHidden(zaloId, threadId, hidden);
  return hiddenStatus(zaloId);
}

/**
 * Đặt / đổi PIN. Đã có PIN → phải đúng PIN cũ (zca-js không đòi, Deplao tự kiểm; sai tính như gõ sai khi mở khoá).
 * Quên PIN cũ → resetZaloHiddenPin rồi đặt PIN mới.
 */
export async function setZaloHiddenPin(
  zaloId: string, pin: string, oldPin: string | undefined, api: ZaloHiddenApi, now: number = Date.now(),
): Promise<HiddenStatus> {
  if (!HIDDEN_PIN_PATTERN.test(pin)) throw new Error('Mã PIN phải gồm 4 chữ số');
  const wait = lockedFor(zaloId, now);
  if (wait > 0) throw new Error(`Thử lại sau ${Math.ceil(wait / 1000)} giây`);
  let state = states.get(zaloId);
  if (!state) {
    await syncZaloHidden(zaloId, api, now);
    state = states.get(zaloId);
  }
  if (state?.pinHash) {
    if (!oldPin || !HIDDEN_PIN_PATTERN.test(oldPin) || !sameHash(md5Pin(oldPin), state.pinHash)) {
      recordFail(zaloId, now);
      throw new Error('Mã PIN hiện tại không đúng');
    }
  }
  await withTimeout(api.updateHiddenConversPin(pin));
  const current = states.get(zaloId);
  if (current) current.pinHash = md5Pin(pin);
  attempts.delete(zaloId);
  Logger.log(`[ZaloHidden] ${zaloId}: ${state?.pinHash ? 'đổi' : 'đặt'} mã PIN hội thoại ẩn`);
  return hiddenStatus(zaloId);
}

/**
 * Quên PIN → đặt lại trên Zalo rồi đọc lại danh sách ngay để giao diện theo trạng thái mới (thường: chưa có PIN, không
 * còn hội thoại ẩn). Không đọc lại được → quên trạng thái trong bộ nhớ, lần sau đọc từ Zalo. Không giới hạn gõ sai: chỉ
 * người có quyền quản lý tài khoản (settings_accounts) gọi được.
 */
export async function resetZaloHiddenPin(zaloId: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<HiddenStatus> {
  if (!zaloId) throw new Error('Thiếu tài khoản');
  const before = states.get(zaloId)?.threads.size;
  await withTimeout(api.resetHiddenConversPin());
  attempts.delete(zaloId);
  Logger.warn(`[ZaloHidden] ${zaloId}: đặt lại mã PIN hội thoại ẩn (trước đó ${before ?? '?'} hội thoại ẩn)`);
  try {
    return await syncZaloHidden(zaloId, api, now);
  } catch (err: any) {
    states.delete(zaloId);
    lastRefreshAt.delete(zaloId);
    Logger.warn(`[ZaloHidden] ${zaloId}: đọc lại sau khi đặt lại PIN lỗi: ${err?.message || err}`);
    return hiddenStatus(zaloId);
  }
}

/** Chỉ dùng trong test. */
export function resetZaloHiddenState(): void {
  states.clear();
  attempts.clear();
  lastRefreshAt.clear();
}
