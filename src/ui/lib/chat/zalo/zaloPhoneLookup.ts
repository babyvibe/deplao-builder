/**
 * Finds a Zalo user by phone number (findUser + getUserInfo): shared by the search box of the conversation list and
 * GlobalSearchPanel. When a number is typed, both search together (before, each search called findUser twice, and Zalo limits the number of
 * phone-number searches per day): a duplicate call (same account + number) while the earlier one is still running shares that call's result.
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';

/** The user found (with isFr / isBlocked if the profile could be read, _searchZaloId = the account that searched) or `{ _notFound: true }`. */
export type ZaloPhoneLookupResult = Record<string, any>;

type LookupAccount = { zalo_id: string; cookies?: string; imei?: string; user_agent?: string };

const inFlight = new Map<string, Promise<ZaloPhoneLookupResult>>();

/** Zalo call error → the promise is rejected (the caller keeps its old handling: shows nothing). */
export function lookupZaloUserByPhone(acc: LookupAccount, phone: string): Promise<ZaloPhoneLookupResult> {
  const number = phone.trim();
  const key = `${acc.zalo_id}|${number}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<ZaloPhoneLookupResult> => {
    const auth = buildZaloAuth(acc, acc.zalo_id);
    const res = await ipc.zalo?.findUser({ auth, phone: number });
    const user = res?.response;
    if (!user?.uid) return { _notFound: true };
    try {
      const infoRes = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
      const profile = infoRes?.response?.changed_profiles?.[user.uid];
      return profile
        ? { ...user, isFr: profile.isFr ?? 0, isBlocked: profile.isBlocked ?? 0, _searchZaloId: acc.zalo_id }
        : { ...user, _searchZaloId: acc.zalo_id };
    } catch {
      return { ...user, _searchZaloId: acc.zalo_id };
    }
  })();
  inFlight.set(key, request);
  const done = () => { if (inFlight.get(key) === request) inFlight.delete(key); };
  request.then(done, done);
  return request;
}
