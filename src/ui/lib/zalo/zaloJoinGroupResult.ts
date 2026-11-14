/**
 * Result of `ipc.zalo.joinGroupLink` → one single status, shared by CRM → Groups (Join via link, Member scan tab) and
 * "Tham gia nhóm bằng link" (Join group by link) in the chat.
 *
 * zca-js throws ZaloApiError code 178 (already a member) / 172 (group full) / 240 (pending approval); the `zalo:` IPC returns
 * `{ success:false, error, errorCode }`, while ZaloService turns 240 into `{ success:true, response:{ pendingApproval,
 * errorCode:240 } }`. Previously the screens only read `res.errorCode` / `response.msg` (which never existed) and had no `else`
 * between the two branches → "Đã tham gia nhóm thành công!" (Joined the group successfully!) for every case, and the group-full branch wrote into another modal's state.
 * Pure function. Test: src/__tests__/zalo/zaloJoinGroupResult.test.ts.
 */

export type ZaloJoinOutcome = 'joined' | 'already' | 'pending' | 'full' | 'error';

export interface ZaloJoinResult {
  outcome: ZaloJoinOutcome;
  /** Zalo error code (non-zero), if any. */
  code?: number;
  /** Original error message (only when outcome = 'error'). */
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
