/**
 * zaloHiddenConversations.ts: Zalo PIN-hidden conversations (ZL-03, Deplao SRS) in the main process (the Boss machine).
 *
 * - The hidden list and the PIN live on Zalo's servers, shared by all devices. getHiddenConversations returns the PIN as an MD5 of the 4
 *   digits, with no salt, so it only prevents peeking and is not encryption. The MD5 is kept only in the memory of the Boss main process: no IPC returns
 *   it to the UI, the employee machines, the Public API or Apps.
 * - contacts.zalo_hidden = 1 for hidden conversations (the whole set is replaced on each read), so the UI filters them while locked; it is reported via
 *   db:contactFlagsChanged (relayed to employees). API / workflow / Apps keep their behavior.
 * - Unlock: compare the MD5 of the 4 digits typed in the search box; 5 wrong tries within 1 minute → comparisons paused for 30 s (like a screen lock).
 * - The zca-js listener does not report when the PIN is hidden / changed / deleted on the phone, so it is read again on connect (at most every 6 hours), when
 *   the red magnifier icon of the search box is clicked or Settings is opened, and when a PIN does not match while the last read is more than 30 s old (PIN just changed on the phone).
 * - If Zalo no longer has a PIN (deleted / reset on the phone), there is nothing to lock: all conversations show as normal.
 * - Forgot PIN → reset (resetHiddenConversPin): Zalo may delete the messages of the hidden conversations on the Zalo device; Deplao
 *   keeps the messages on the machine. The UI asks for confirmation twice (open to everyone).
 */
import * as crypto from 'crypto';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

export const HIDDEN_PIN_PATTERN = /^\d{4}$/;
export const HIDDEN_UNLOCK_MAX_FAILS = 5;
export const HIDDEN_UNLOCK_WINDOW_MS = 60_000;
export const HIDDEN_UNLOCK_LOCK_MS = 30_000;
export const HIDDEN_REFRESH_MS = 6 * 60 * 60 * 1000;
/** A typed PIN that does not match → read again from Zalo if the last read is older than this mark (not asking Zalo on every 4-digit entry). */
export const HIDDEN_RECHECK_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Bridge to zca-js (built by ZaloService), so tests can replace it. */
export interface ZaloHiddenApi {
  getHiddenConversations(): Promise<any>;
  /** isGroup: true = group. One call handles only one type of conversation. */
  setHiddenConversations(hidden: boolean, threadIds: string[], isGroup: boolean): Promise<any>;
  updateHiddenConversPin(pin: string): Promise<any>;
  /** Forgot PIN: Zalo deletes the PIN (and possibly the messages of the hidden conversations on the Zalo device). */
  resetHiddenConversPin(): Promise<any>;
}

/** Bridge from the zca-js API (ThreadType: 0 = user, 1 = group). */
export function zaloHiddenApiOf(api: any): ZaloHiddenApi {
  return {
    getHiddenConversations: () => api.getHiddenConversations(),
    setHiddenConversations: (hidden, threadIds, isGroup) => api.setHiddenConversations(hidden, threadIds, isGroup ? 1 : 0),
    updateHiddenConversPin: (pin) => api.updateHiddenConversPin(pin),
    resetHiddenConversPin: () => api.resetHiddenConversPin(),
  };
}

export interface HiddenStatus {
  /** The list has already been read from Zalo in this session. */
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
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(tr('Zalo không phản hồi'))), FETCH_TIMEOUT_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Response of getHiddenConversations → MD5 of the PIN ('' = not set) + conversation ids → whether each one is a group. */
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
 * Writes the state that was read: memory (MD5) + DB (the whole set is replaced) + notifies the UI of the conversations that changed. With no PIN, no
 * conversation is locked (there is nothing to type to unlock), even if Zalo still returns an old list.
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

/** Read again from Zalo right away (unlock, refresh button, settings). */
export async function syncZaloHidden(zaloId: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<HiddenStatus> {
  applyState(zaloId, await withTimeout(api.getHiddenConversations()), now);
  return hiddenStatus(zaloId);
}

/** After connecting: read if this session has not read within 6 hours. Runs in the background, does not throw. */
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
 * Compare the PIN typed in the search box. If the list has not been read in this session → read it from Zalo first; no match and the last read is more than 30 s old → read
 * once more and compare again (PIN changed / deleted on the phone). A wrong PIN shows nothing in the UI (4 digits are still a normal search);
 * 5 wrong tries within 1 minute → comparisons paused for 30 s.
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

/** Hide / unhide a conversation on Zalo, then write the DB + notify the UI. Hiding without a PIN → error (the UI asks to set a PIN first). */
export async function setZaloConversationHidden(
  zaloId: string, threadId: string, isGroup: boolean, hidden: boolean, api: ZaloHiddenApi, now: number = Date.now(),
): Promise<HiddenStatus> {
  if (!threadId) throw new Error(tr('Thiếu threadId'));
  let state = states.get(zaloId);
  if (!state) {
    await syncZaloHidden(zaloId, api, now);
    state = states.get(zaloId);
  }
  if (hidden && !state?.pinHash) throw new Error(tr('Chưa đặt mã PIN cho hội thoại ẩn'));
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
 * Set / change the PIN. If a PIN exists, the old PIN must be correct (zca-js does not require it, Deplao checks it itself; a wrong one counts like a wrong unlock attempt).
 * Forgot the old PIN → resetZaloHiddenPin, then set the new PIN.
 */
export async function setZaloHiddenPin(
  zaloId: string, pin: string, oldPin: string | undefined, api: ZaloHiddenApi, now: number = Date.now(),
): Promise<HiddenStatus> {
  if (!HIDDEN_PIN_PATTERN.test(pin)) throw new Error(tr('Mã PIN phải gồm 4 chữ số'));
  const wait = lockedFor(zaloId, now);
  if (wait > 0) throw new Error(tr('Thử lại sau {{v1}} giây', { v1: Math.ceil(wait / 1000) }));
  let state = states.get(zaloId);
  if (!state) {
    await syncZaloHidden(zaloId, api, now);
    state = states.get(zaloId);
  }
  if (state?.pinHash) {
    if (!oldPin || !HIDDEN_PIN_PATTERN.test(oldPin) || !sameHash(md5Pin(oldPin), state.pinHash)) {
      recordFail(zaloId, now);
      throw new Error(tr('Mã PIN hiện tại không đúng'));
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
 * Forgot PIN → reset it on Zalo, then read the list again right away so the UI matches the new state (normally: no PIN, no
 * hidden conversations left). If the re-read fails → forget the state in memory, and the next read comes from Zalo. There is no limit on wrong tries; only
 * a user with account management permission (settings_accounts) can call it.
 */
export async function resetZaloHiddenPin(zaloId: string, api: ZaloHiddenApi, now: number = Date.now()): Promise<HiddenStatus> {
  if (!zaloId) throw new Error(tr('Thiếu tài khoản'));
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

/** Only used in tests. */
export function resetZaloHiddenState(): void {
  states.clear();
  attempts.clear();
  lastRefreshAt.clear();
}
