/**
 * Kết quả `ipc.zalo.joinGroupLink` → một trạng thái duy nhất, dùng chung cho CRM → Nhóm (Join theo link, tab Quét
 * thành viên) và "Tham gia nhóm bằng link" ở chat.
 *
 * zca-js ném ZaloApiError mã 178 (đã là thành viên) / 172 (nhóm đầy) / 240 (chờ duyệt); `zalo:` IPC trả
 * `{ success:false, error, errorCode }`, còn ZaloService đổi 240 thành `{ success:true, response:{ pendingApproval,
 * errorCode:240 } }`. Trước đây các màn chỉ đọc `res.errorCode` / `response.msg` (không bao giờ có) và thiếu `else`
 * giữa hai nhánh → "Đã tham gia nhóm thành công!" cho mọi trường hợp, nhánh nhóm đầy ghi vào state của modal khác.
 * Thuần — test: src/__tests__/zaloJoinGroupResult.test.ts.
 */

export type ZaloJoinOutcome = 'joined' | 'already' | 'pending' | 'full' | 'error';

export interface ZaloJoinResult {
  outcome: ZaloJoinOutcome;
  /** Mã lỗi Zalo (khác 0) nếu có. */
  code?: number;
  /** Thông báo lỗi gốc (chỉ khi outcome = 'error'). */
  error?: string;
}

function errorCode(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') continue;
    const code = Number(value);
    if (Number.isFinite(code) && code !== 0) return code;
  }
  return undefined;
}

export function classifyZaloJoinResult(res: any): ZaloJoinResult {
  const response = res?.response;
  const code = errorCode(res?.errorCode, res?.error_code, response?.errorCode, response?.error_code, response?.error);
  const text = [res?.error, response?.msg, response?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (code === 178 || text.includes('already')) return { outcome: 'already', code };
  if (code === 172 || text.includes('vượt quá số thành viên')) return { outcome: 'full', code };
  if (code === 240 || response?.pendingApproval === true || text.includes('pending') || text.includes('approval')
    || text.includes('waiting for approve')) {
    return { outcome: 'pending', code };
  }
  if (!res || res.success === false || code !== undefined) {
    return { outcome: 'error', code, error: typeof res?.error === 'string' && res.error.trim() ? res.error : undefined };
  }
  return { outcome: 'joined' };
}
