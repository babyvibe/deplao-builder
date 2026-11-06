/**
 * Khi nào được TỰ chụp bản gốc DB. Chụp gốc = chép + lọc + đếm + nén cả DB: DB 2,9 GB ≈ 9 GB đọc / ghi ổ đĩa. Đo 11/2026
 * trên máy thật: 66 s lúc máy rảnh ban đêm, nhưng 17 phút lúc vừa mở máy buổi sáng (RAM đầy, Windows đang nạp lại bộ
 * nhớ từ ổ đĩa, các kênh đồng bộ bù) → ổ đĩa 100 %, app đơ. Lúc đó gốc đã quá 30 giờ nên chu kỳ đến hạn ngay khi máy
 * thức dậy là chụp luôn; Modern Standby còn đánh thức máy vài giây ban đêm → chụp dở, đóng băng tới sáng rồi chạy nốt
 * đúng lúc người dùng quay lại.
 *
 * Luật chung "chỉ khi máy rảnh" (utils/startup/systemIdle.ts):
 *  - 15 phút sau khi máy thức dậy / mở khoá / mở app: không chụp;
 *  - người dùng không chạm máy ≥ 10 phút, đang cắm sạc;
 *  - chờ quá lâu thì vẫn chụp: gốc định kỳ (lúc chờ đoạn thay đổi vẫn đẩy lên gốc cũ) 72 giờ; gốc bắt buộc tự phát (đổi
 *    schema, cài lại theo dõi… — lúc chờ không đẩy được đoạn, thay đổi nằm chờ trong DB) 6 giờ.
 * Chụp do người dùng vừa thao tác (bật đồng bộ, "Đồng bộ ngay", đổi phạm vi / kho / mật khẩu / thư mục) không phải chờ.
 */
import {
    IDLE_MIN_MS, IDLE_WAIT_LABEL, IdleWaitReason, SystemIdleInfo, WAKE_QUIET_MS, idleWaitReason,
} from '../../../utils/startup/systemIdle';

export type BaseWindowInfo = SystemIdleInfo;
export type BaseWaitReason = IdleWaitReason;

export const BASE_WAKE_QUIET_MS = WAKE_QUIET_MS;
export const BASE_IDLE_MS = IDLE_MIN_MS;
export const BASE_OPTIONAL_MAX_WAIT_MS = 72 * 3_600_000;
export const BASE_REQUIRED_MAX_WAIT_MS = 6 * 3_600_000;
/** Đang chờ máy rảnh để chụp gốc: kiểm lại mỗi 10 phút (chu kỳ không có thay đổi gần như không tốn gì). */
export const BASE_WAIT_RECHECK_MS = 10 * 60_000;

export const BASE_WAIT_LABEL = IDLE_WAIT_LABEL;

/** Gốc định kỳ: chờ được, đoạn thay đổi vẫn áp lên gốc cũ ('bulk': lúc chờ đẩy thành đoạn thay vì chụp gốc). */
export function isOptionalRebase(reason: string): boolean {
    return reason === 'age' || reason === 'age-night' || reason === 'segments-size' || reason === 'bulk';
}

/** Gốc bắt buộc nhưng tự phát (không do người dùng vừa thao tác: bản cập nhật đổi schema / chính sách phạm vi…). */
const DEFERRABLE_REQUIRED = new Set(['schema', 'tracking', 'db-replaced', 'older-db', 'scope-policy']);

export function isDeferrableRebase(reason: string): boolean {
    return isOptionalRebase(reason) || DEFERRABLE_REQUIRED.has(reason);
}

/**
 * null = được chụp ngay; còn lại = lý do phải chờ. window null (không có Electron: test, bản cũ) hoặc lý do do người dùng
 * vừa thao tác (bản gốc đầu tiên, đổi thư mục / mật khẩu / phạm vi) = như trước, không chờ.
 */
export function baseWaitReason(p: {
    reason: string;
    /** Lúc bắt đầu cần chụp gốc (0 = vừa xong). */
    dueSince: number;
    now: number;
    /** Mốc thức dậy / mở khoá / mở app gần nhất. */
    lastWakeAt: number;
    window: BaseWindowInfo | null;
}): BaseWaitReason | null {
    if (!isDeferrableRebase(p.reason)) return null;
    return idleWaitReason({
        now: p.now,
        wakeAt: p.lastWakeAt,
        dueSince: p.dueSince,
        maxWaitMs: isOptionalRebase(p.reason) ? BASE_OPTIONAL_MAX_WAIT_MS : BASE_REQUIRED_MAX_WAIT_MS,
        info: p.window,
    });
}
