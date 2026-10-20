/**
 * Tìm người dùng Zalo theo số điện thoại (findUser + getUserInfo) — dùng chung cho ô tìm kiếm của danh sách hội thoại và
 * GlobalSearchPanel. Gõ một số thì cả hai cùng tìm (trước đây mỗi lần tìm gọi findUser 2 lần, mà Zalo giới hạn số lần tìm
 * SĐT mỗi ngày): lần gọi trùng (cùng tài khoản + số) khi lần trước chưa xong dùng chung kết quả của lần đó.
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';

/** Người dùng tìm được (kèm isFr / isBlocked nếu đọc được hồ sơ, _searchZaloId = tài khoản đã tìm) hoặc `{ _notFound: true }`. */
export type ZaloPhoneLookupResult = Record<string, any>;

type LookupAccount = { zalo_id: string; cookies?: string; imei?: string; user_agent?: string };

const inFlight = new Map<string, Promise<ZaloPhoneLookupResult>>();

/** Lỗi gọi Zalo → promise bị từ chối (người gọi giữ cách xử lý cũ: không hiện gì). */
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
