/**
 * zaloAutoDeleteSync.ts: auto-deletes messages on Zalo (ZL-05) in the main process: writes the auto-delete time of each conversation to
 * contacts.zalo_auto_delete_ttl so the UI can show the countdown, and notifies the UI through db:contactFlagsChanged (relayed to employees).
 *
 * The zca-js listener does not report turning auto-delete on / off on the phone, so getAutoDeleteChat is read again when the account connects (at most
 * once every 6 hours) and when the user opens the "Tự xoá tin nhắn" (Auto-delete messages) section. Deplao does not delete messages by TTL.
 */
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import { zaloAutoDeleteMap } from '../../shared/zalo/zaloAutoDelete';

export const ZALO_AUTO_DELETE_REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** zaloId → time of the last list read (ms) in this app session. */
const lastSyncAt = new Map<string, number>();

function emitTtl(zaloId: string, contactId: string, ttl: number): void {
  EventBroadcaster.emit('db:contactFlagsChanged', { ownerZaloId: zaloId, contactId, flags: { zalo_auto_delete_ttl: ttl } });
}

/** Writes the list of conversations with auto-delete on (replaces the whole set of the account); notifies the UI of the conversations whose value changed. */
export function applyZaloAutoDeleteList(zaloId: string, res: any, now: number = Date.now()): Map<string, number> {
  const ttls = zaloAutoDeleteMap(res);
  if (!zaloId) return ttls;
  lastSyncAt.set(zaloId, now);
  const changed = EventBroadcaster.withBossDb((db) => db.replaceContactAutoDeleteTtls(zaloId, ttls));
  for (const item of changed) emitTtl(zaloId, item.contactId, item.ttl);
  return ttls;
}

/** One conversation was changed on Zalo from Deplao: write the DB + notify the UI. */
export function applyZaloAutoDeleteOne(zaloId: string, threadId: string, ttl: number): void {
  if (!zaloId || !threadId) return;
  if (EventBroadcaster.withBossDb((db) => db.setContactAutoDeleteTtl(zaloId, threadId, ttl))) emitTtl(zaloId, threadId, ttl);
}

/** After connecting: read the list if this session has not read it within 6 hours. Runs in the background, does not throw. */
export async function refreshZaloAutoDelete(
  zaloId: string,
  api: { getAutoDeleteChat: () => Promise<any> },
  now: number = Date.now(),
): Promise<Map<string, number> | null> {
  if (!zaloId) return null;
  const last = lastSyncAt.get(zaloId);
  if (last !== undefined && now - last < ZALO_AUTO_DELETE_REFRESH_MS) return null;
  lastSyncAt.set(zaloId, now); // reserve the slot: many rapid connections must not all ask Zalo at the same time
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

/** Only used in tests. */
export function resetZaloAutoDeleteSync(): void {
  lastSyncAt.clear();
}
