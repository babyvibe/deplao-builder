/**
 * zaloBusinessFlag.ts — cờ Zalo Business của chính tài khoản (accounts.is_business), đọc từ
 * fetchAccountInfo().profile.bizPkg.pkgId (> 0 = Business).
 *
 * Một nơi cho mọi lần đọc hồ sơ của chính mình: đăng nhập QR / cookie, kết nối lại (mở app, nút kết nối, tự kết nối lại)
 * và làm mới avatar. Trước đây mỗi nơi tự tính, saveAccount không có cờ thì ghi 0 (đăng nhập QR lưu tài khoản trước khi
 * hỏi bizPkg), còn sau đăng nhập cờ chỉ được làm mới khi avatar đổi → tài khoản Business mất nhãn "Business" mãi.
 */
import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import Logger from '../Logger';

/** Kết nối lại chỉ hỏi Zalo khi lần đọc gần nhất của tài khoản đã quá 6 giờ (mỗi lần mở app luôn hỏi một lần). */
export const ZALO_BUSINESS_REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** zaloId → thời điểm đọc bizPkg gần nhất (ms) trong phiên app này. */
const lastReadAt = new Map<string, number>();

/** 1 / 0 theo gói Business; null = phản hồi không có pkgId → không đoán, giữ giá trị đang lưu. */
export function zaloBusinessFlag(accountInfo: any): 0 | 1 | null {
  const pkgId = accountInfo?.profile?.bizPkg?.pkgId ?? accountInfo?.bizPkg?.pkgId;
  if (pkgId === undefined || pkgId === null || pkgId === '' || !Number.isFinite(Number(pkgId))) return null;
  return Number(pkgId) > 0 ? 1 : 0;
}

/** Ghi cờ đọc được vào DB; đổi thật thì báo giao diện (event:accountProfile — máy nhân viên nhận qua relay). */
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
 * Sau khi kết nối lại (không phải đăng nhập mới — đăng nhập đã tự đọc hồ sơ): đọc lại bizPkg nếu chưa đọc trong 6 giờ.
 * Chạy nền, không ném lỗi; lỗi mạng hoặc quá 15 s thì lần kết nối sau hỏi lại.
 */
export async function refreshZaloBusinessFlag(
  zaloId: string,
  api: { fetchAccountInfo: () => Promise<any> },
  now: number = Date.now(),
): Promise<0 | 1 | null> {
  if (!zaloId) return null;
  const last = lastReadAt.get(zaloId);
  if (last !== undefined && now - last < ZALO_BUSINESS_REFRESH_MS) return null;
  lastReadAt.set(zaloId, now); // giữ chỗ: nhiều lần kết nối dồn dập không cùng hỏi Zalo
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

/** Chỉ dùng trong test. */
export function resetZaloBusinessFlagCache(): void {
  lastReadAt.clear();
}
