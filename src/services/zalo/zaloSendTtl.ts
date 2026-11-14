/**
 * zaloSendTtl.ts: FR-ZL05.7 (Deplao SRS ZL-05). When auto-delete is on for a Zalo conversation, messages sent from Deplao carry the conversation's ttl
 * like the Zalo app does (each message sets its own ttl). It is installed once on the zca-js api object in ConnectionManager, so every send path has it: the UI, employee machines (Boss sends on their behalf), Public API, workflows, CRM campaigns, Apps.
 *
 * - The caller already passed a ttl → kept as is. Conversation with auto-delete off (or a DB lookup error) → called as before, parameters unchanged.
 * - It is not yet checked whether the Zalo server applies the conversation's ttl by itself: setting the same value is harmless in both cases.
 * - zca-js 2.2.0 accepts ttl (ms) in sendMessage (text, images, files, GIF), sendLink, sendVideo, sendVoice, sendCard, forwardMessage;
 *   sendSticker does not accept it, so stickers do not auto-delete.
 */
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

/** threadId → ttl (ms) of the conversation; 0 = no auto-delete. */
export type ZaloTtlLookup = (threadId: string) => number;

const INSTALLED = Symbol.for('deplao.zaloSendTtl');
const SINGLE_THREAD_SENDS = ['sendMessage', 'sendLink', 'sendVideo', 'sendVoice', 'sendCard'] as const;

/** The conversation's ttl that is on in Boss's DB (the right DB even when Boss is viewing an employee workspace). */
export function zaloTtlLookupFor(zaloId: string): ZaloTtlLookup {
  return (threadId) => EventBroadcaster.withBossDb((db) => db.getContactAutoDeleteTtl(zaloId, threadId));
}

function ttlOf(lookup: ZaloTtlLookup, threadId: unknown): number {
  if (threadId === undefined || threadId === null || threadId === '') return 0;
  try {
    const ttl = Number(lookup(String(threadId))) || 0;
    return ttl > 0 ? ttl : 0;
  } catch (err: any) {
    Logger.warn(`[ZaloSendTtl] tra tự xoá của ${threadId} lỗi: ${err?.message || err}`);
    return 0;
  }
}

function hasTtl(content: any): boolean {
  return content?.ttl !== undefined && content?.ttl !== null;
}

/** Content sent with a ttl: a string → { msg, ttl } the way zca-js does it itself. Already has a ttl / is not message content → kept as is. */
export function withZaloTtl<T>(content: T, ttl: number): T {
  if (!(ttl > 0)) return content;
  if (typeof content === 'string') return { msg: content, ttl } as any;
  if (!content || typeof content !== 'object' || hasTtl(content)) return content;
  return { ...(content as any), ttl };
}

function forwardWithTtl(original: (...args: any[]) => Promise<any>, lookup: ZaloTtlLookup) {
  return async (payload: any, threadIds: any, ...rest: any[]) => {
    const ids: string[] = Array.isArray(threadIds) ? threadIds.map(String) : [];
    if (!payload || typeof payload !== 'object' || hasTtl(payload) || ids.length === 0) {
      return original(payload, threadIds, ...rest);
    }
    const groups = new Map<number, string[]>();
    for (const id of ids) {
      const ttl = ttlOf(lookup, id);
      groups.set(ttl, [...(groups.get(ttl) || []), id]);
    }
    if (groups.size === 1) {
      const [ttl] = groups.keys();
      return original(withZaloTtl(payload, ttl), threadIds, ...rest);
    }
    // Targets have different auto-delete levels: zca-js accepts only one ttl per call → one call per level, then merge the results
    const merged: { success: any[]; fail: any[] } = { success: [], fail: [] };
    for (const [ttl, groupIds] of groups) {
      const res = await original(withZaloTtl(payload, ttl), groupIds, ...rest);
      if (Array.isArray(res?.success)) merged.success.push(...res.success);
      if (Array.isArray(res?.fail)) merged.fail.push(...res.fail);
    }
    return merged;
  };
}

/** Wraps the send functions of a zca-js api (once per api object). */
export function installZaloSendTtl(api: any, lookup: ZaloTtlLookup): void {
  if (!api || typeof api !== 'object' || api[INSTALLED]) return;
  for (const name of SINGLE_THREAD_SENDS) {
    const original = api[name];
    if (typeof original !== 'function') continue;
    api[name] = (content: any, threadId: any, ...rest: any[]) =>
      original.call(api, withZaloTtl(content, ttlOf(lookup, threadId)), threadId, ...rest);
  }
  if (typeof api.forwardMessage === 'function') api.forwardMessage = forwardWithTtl(api.forwardMessage.bind(api), lookup);
  Object.defineProperty(api, INSTALLED, { value: true, enumerable: false });
}
