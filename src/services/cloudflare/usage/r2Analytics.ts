/**
 * r2Analytics — số liệu R2 TOÀN TÀI KHOẢN qua Cloudflare GraphQL Analytics
 * (developers.cloudflare.com/r2/platform/metrics-analytics):
 *  - r2OperationsAdaptiveGroups: số request theo actionType → Class A / B / miễn phí (costModel.classifyR2Action).
 *  - r2StorageAdaptiveGroups: mẫu dung lượng (payloadSize + metadataSize) theo thời điểm + bucket → GB-tháng
 *    (costModel.r2StorageStats).
 * Một request GraphQL cho cả hai (tính vào ngân sách 100 request / 5 phút của app). Mỗi truy vấn tối đa 31 ngày — một
 * tháng dương lịch vừa đủ. Token cần quyền "Account Analytics: Read"; thiếu → permission = true.
 * Không ném: mọi lỗi trả về { ok: false, permission, reason }.
 */
import type { CloudflareApi } from '../contracts';
import { R2OpTotals, R2StorageSample, sumR2Operations } from './costModel';

/** Số dòng tối đa mỗi dataset (limit của truy vấn). */
export const R2_ANALYTICS_LIMIT = 10_000;

export const R2_USAGE_QUERY = `query DeplaoR2Usage($accountTag: string!, $start: Time, $end: Time) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(limit: ${R2_ANALYTICS_LIMIT}, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { actionType }
      }
      r2StorageAdaptiveGroups(limit: ${R2_ANALYTICS_LIMIT}, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize }
        dimensions { datetime bucketName }
      }
    }
  }
}`;

export interface R2AnalyticsData extends R2OpTotals {
    /** Mẫu dung lượng (mọi bucket của tài khoản). */
    samples: R2StorageSample[];
    /** Mẫu dung lượng chạm giới hạn dòng (sắp xếp mới → cũ nên mẫu cũ nhất có thể thiếu). */
    truncated: boolean;
}

export type R2AnalyticsResult =
    | { ok: true; data: R2AnalyticsData }
    | { ok: false; permission: boolean; reason: string };

/** Biến Time của GraphQL: RFC 3339 không phần ms ('2026-10-01T00:00:00Z'). */
export function graphqlTime(ts: number): string {
    return new Date(Math.floor(ts / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const PERMISSION_RE = /authori[sz]|permission|forbidden|access denied|not allowed/i;

/** Lỗi GraphQL do token thiếu quyền (vd "not authorized for that account", extensions.code 'authz'). */
export function isGraphqlPermissionError(errors: ReadonlyArray<{ message?: unknown; [k: string]: unknown }>): boolean {
    return (errors || []).some(e => {
        const ext = e && typeof e.extensions === 'object' && e.extensions ? (e.extensions as Record<string, unknown>) : {};
        const code = String(ext.code ?? '').toLowerCase();
        return code === 'authz' || code === 'unauthorized' || code === 'forbidden' || PERMISSION_RE.test(String(e?.message ?? ''));
    });
}

/** Câu lỗi ngắn để ghép vào ghi chú cho người dùng. */
export function shortReason(value: unknown): string {
    const s = String((value as any)?.message ?? value ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return 'lỗi không rõ';
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Đọc phần data của phản hồi; null khi không có tài khoản (token không thấy tài khoản này). */
export function parseR2Analytics(data: any): R2AnalyticsData | null {
    const accounts = data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0] || typeof accounts[0] !== 'object') return null;
    const acct = accounts[0];
    const opRows: any[] = Array.isArray(acct.r2OperationsAdaptiveGroups) ? acct.r2OperationsAdaptiveGroups : [];
    const storageRows: any[] = Array.isArray(acct.r2StorageAdaptiveGroups) ? acct.r2StorageAdaptiveGroups : [];
    const totals = sumR2Operations(opRows.map(r => ({
        actionType: String(r?.dimensions?.actionType ?? ''),
        requests: Number(r?.sum?.requests) || 0,
    })));
    const samples: R2StorageSample[] = [];
    for (const r of storageRows) {
        const ts = Date.parse(String(r?.dimensions?.datetime ?? ''));
        if (!Number.isFinite(ts)) continue;
        const payload = Number(r?.max?.payloadSize);
        const meta = Number(r?.max?.metadataSize);
        const bytes = (Number.isFinite(payload) && payload > 0 ? payload : 0) + (Number.isFinite(meta) && meta > 0 ? meta : 0);
        samples.push({ bucket: String(r?.dimensions?.bucketName ?? ''), ts, bytes });
    }
    return { ...totals, samples, truncated: storageRows.length >= R2_ANALYTICS_LIMIT };
}

/** Lỗi HTTP 401 / 403 (CloudError của CloudflareApi mang status). */
function isPermissionStatus(err: unknown): boolean {
    const status = (err as any)?.status;
    return status === 401 || status === 403;
}

/**
 * Truy vấn số liệu R2 của tài khoản trong [startTs, endTs] (≤ 31 ngày). Không ném.
 * Lỗi HTTP 401/403 hoặc lỗi GraphQL về quyền → permission = true; còn lại permission = false + lý do ngắn.
 */
export async function fetchR2Analytics(
    api: CloudflareApi,
    accountTag: string,
    range: { startTs: number; endTs: number },
): Promise<R2AnalyticsResult> {
    try {
        const res = await api.graphql(R2_USAGE_QUERY, {
            accountTag,
            start: graphqlTime(range.startTs),
            end: graphqlTime(Math.max(range.startTs, range.endTs)),
        });
        const errors = Array.isArray(res?.errors) ? res.errors : [];
        if (errors.length) return { ok: false, permission: isGraphqlPermissionError(errors), reason: shortReason(errors[0]?.message) };
        const data = parseR2Analytics(res?.data);
        if (!data) return { ok: false, permission: true, reason: 'Cloudflare không trả về số liệu của tài khoản này' };
        return { ok: true, data };
    } catch (err) {
        return { ok: false, permission: isPermissionStatus(err), reason: shortReason(err) };
    }
}
