/**
 * zaloAutoDeleteSync.ts — tự xoá tin nhắn trên Zalo (ZL-05) ở main process: ghi thời gian tự xoá của từng hội thoại vào
 * contacts.zalo_auto_delete_ttl để giao diện hiện đồng hồ, báo giao diện qua db:contactFlagsChanged (relay cho nhân viên).
 *
 * Listener zca-js không báo khi bật / tắt tự xoá trên điện thoại → đọc lại getAutoDeleteChat khi tài khoản kết nối (tối
 * đa 6 giờ một lần) và khi người dùng mở mục "Tự xoá tin nhắn". Deplao không xoá tin theo TTL.
 */
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import { zaloAutoDeleteMap } from '../../shared/zaloAutoDelete';

export const ZALO_AUTO_DELETE_REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** zaloId → lần đọc danh sách gần nhất (ms) trong phiên app này. */
const lastSyncAt = new Map<string, number>();

function emitTtl(zaloId: string, contactId: string, ttl: number): void {
  EventBroadcaster.emit('db:contactFlagsChanged', { ownerZaloId: zaloId, contactId, flags: { zalo_auto_delete_ttl: ttl } });
}

/** Ghi danh sách hội thoại đang bật (thay cả tập của tài khoản); báo giao diện các hội thoại có giá trị đổi. */
export function applyZaloAutoDeleteList(zaloId: string, res: any, now: number = Date.now()): Map<string, number> {
  const ttls = zaloAutoDeleteMap(res);
  if (!zaloId) return ttls;
  lastSyncAt.set(zaloId, now);
  const changed = EventBroadcaster.withBossDb((db) => db.replaceContactAutoDeleteTtls(zaloId, ttls));
  for (const item of changed) emitTtl(zaloId, item.contactId, item.ttl);
  return ttls;
}

/** Một hội thoại vừa được đổi trên Zalo từ Deplao: ghi DB + báo giao diện. */
export function applyZaloAutoDeleteOne(zaloId: string, threadId: string, ttl: number): void {
  if (!zaloId || !threadId) return;
  if (EventBroadcaster.withBossDb((db) => db.setContactAutoDeleteTtl(zaloId, threadId, ttl))) emitTtl(zaloId, threadId, ttl);
}

/** Sau khi kết nối: đọc danh sách nếu phiên này chưa đọc trong 6 giờ. Chạy nền, không ném lỗi. */
export async function refreshZaloAutoDelete(
  zaloId: string,
  api: { getAutoDeleteChat: () => Promise<any> },
  now: number = Date.now(),
): Promise<Map<string, number> | null> {
  if (!zaloId) return null;
  const last = lastSyncAt.get(zaloId);
  if (last !== undefined && now - last < ZALO_AUTO_DELETE_REFRESH_MS) return null;
  lastSyncAt.set(zaloId, now); // giữ chỗ: nhiều lần kết nối dồn dập không cùng hỏi Zalo
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      api.getAutoDeleteChat(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS); }),
    ]);
    return applyZaloAutoDeleteList(zaloId, res, now);
  } catch (err: any) {
    lastSyncAt.delete(zaloId);
    Logger.warn(`[ZaloAutoDelete] ${zaloId}: getAutoDeleteChat failed: ${err?.message || err}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Chỉ dùng trong test. */
export function resetZaloAutoDeleteSync(): void {
  lastSyncAt.clear();
}
