/**
 * zaloSendTtl.ts — FR-ZL05.7 (SRS Deplao ZL-05): hội thoại Zalo đang bật tự xoá → tin gửi từ Deplao mang ttl của hội thoại
 * như app Zalo (mỗi tin tự gắn ttl). Cài một lần lên đối tượng api zca-js trong ConnectionManager nên mọi lối gửi đều có:
 * giao diện, máy nhân viên (Boss gửi hộ), Public API, workflow, chiến dịch CRM, Ứng dụng.
 *
 * - Người gọi đã truyền ttl → giữ nguyên. Hội thoại tắt tự xoá (hoặc tra DB lỗi) → gọi như cũ, không đổi tham số.
 * - Máy chủ Zalo có tự áp ttl của hội thoại hay không chưa kiểm: gắn đúng giá trị đó nên vô hại cả hai trường hợp.
 * - zca-js 2.2.0 nhận ttl (ms) ở sendMessage (chữ, ảnh, file, GIF), sendLink, sendVideo, sendVoice, sendCard, forwardMessage;
 *   sendSticker không nhận → sticker không tự xoá.
 */
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

/** threadId → ttl (ms) của hội thoại; 0 = không tự xoá. */
export type ZaloTtlLookup = (threadId: string) => number;

const INSTALLED = Symbol.for('deplao.zaloSendTtl');
const SINGLE_THREAD_SENDS = ['sendMessage', 'sendLink', 'sendVideo', 'sendVoice', 'sendCard'] as const;

/** ttl đang bật của hội thoại trong DB của Boss (đúng DB cả khi Boss đang xem workspace nhân viên). */
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

/** Nội dung gửi kèm ttl; chuỗi → { msg, ttl } như zca-js tự làm. Đã có ttl / không phải nội dung → giữ nguyên. */
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
    // Đích có mức tự xoá khác nhau: zca-js chỉ nhận một ttl cho cả lượt → mỗi mức một lượt, gộp kết quả
    const merged: { success: any[]; fail: any[] } = { success: [], fail: [] };
    for (const [ttl, groupIds] of groups) {
      const res = await original(withZaloTtl(payload, ttl), groupIds, ...rest);
      if (Array.isArray(res?.success)) merged.success.push(...res.success);
      if (Array.isArray(res?.fail)) merged.fail.push(...res.fail);
    }
    return merged;
  };
}

/** Bọc các hàm gửi của một api zca-js (một lần cho mỗi đối tượng api). */
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
