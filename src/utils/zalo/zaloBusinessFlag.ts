/**
 * zaloBusinessFlag.ts: the account's own Zalo Business flag (accounts.is_business), read from
 * fetchAccountInfo().profile.bizPkg.pkgId (> 0 = Business).
 *
 * One place for every read of the account's own profile: QR / cookie login, reconnect (app open, connect button, auto-reconnect)
 * and avatar refresh. Previously each place computed it itself: saveAccount without the flag wrote 0 (QR login saves the account before
 * asking for bizPkg), and after login the flag was only refreshed when the avatar changed → a Business account kept losing its "Business" label.
 */
import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import Logger from '../Logger';

/** Reconnecting only asks Zalo when the account's last read is more than 6 hours old (each app open always asks once). */
export const ZALO_BUSINESS_REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** zaloId → time of the most recent bizPkg read (ms) in this app session. */
const lastReadAt = new Map<string, number>();

/** 1 / 0 by Business package; null = the response has no pkgId → do not guess, keep the saved value. */
export function zaloBusinessFlag(accountInfo: any): 0 | 1 | null {
  const pkgId = accountInfo?.profile?.bizPkg?.pkgId ?? accountInfo?.bizPkg?.pkgId;
  if (pkgId === undefined || pkgId === null || pkgId === '' || !Number.isFinite(Number(pkgId))) return null;
  return Number(pkgId) > 0 ? 1 : 0;
}

/** Save the read flag to the DB; if it actually changed, tell the UI (event:accountProfile; employee machines receive it through the relay). */
export function applyZaloBusinessFlag(zaloId: string, accountInfo: any, now: number = Date.now()): 0 | 1 | null {
  const flag = zaloBusinessFlag(accountInfo);
  if (!zaloId || flag === null) return null;
  lastReadAt.set(zaloId, now);
  if (DatabaseService.getInstance().setAccountBusiness(zaloId, flag)) {
    Logger.log(`[ZaloBusiness] ${zaloId}: is_business → ${flag}`);
    EventBroadcaster.broadcastAccountProfile(zaloId, { is_business: flag });
  }
  return flag;
}

/**
 * After a reconnect (not a new login, which already read the profile): read bizPkg again if it has not been read for 6 hours.
 * Runs in the background and does not throw; on a network error or after 15 s, the next connection asks again.
 */
export async function refreshZaloBusinessFlag(
  zaloId: string,
  api: { fetchAccountInfo: () => Promise<any> },
  now: number = Date.now(),
): Promise<0 | 1 | null> {
  if (!zaloId) return null;
  const last = lastReadAt.get(zaloId);
  if (last !== undefined && now - last < ZALO_BUSINESS_REFRESH_MS) return null;
  lastReadAt.set(zaloId, now); // placeholder: many connections in a row do not all ask Zalo at the same time
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accountInfo = await Promise.race([
      api.fetchAccountInfo(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS); }),
    ]);
    return applyZaloBusinessFlag(zaloId, accountInfo, now);
  } catch (err: any) {
    lastReadAt.delete(zaloId);
    Logger.warn(`[ZaloBusiness] ${zaloId}: fetchAccountInfo failed: ${err?.message || err}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test only. */
export function resetZaloBusinessFlagCache(): void {
  lastReadAt.clear();
}
