/**
 * r2Analytics: R2 figures for the WHOLE ACCOUNT via Cloudflare GraphQL Analytics
 * (developers.cloudflare.com/r2/platform/metrics-analytics):
 *  - r2OperationsAdaptiveGroups: request count by actionType → Class A / B / free (costModel.classifyR2Action).
 *  - r2StorageAdaptiveGroups: storage samples (payloadSize + metadataSize) by time + bucket → GB-month
 *    (costModel.r2StorageStats).
 * One GraphQL request covers both (counted against the app budget of 100 requests / 5 minutes). Each query covers at most 31 days, just
 * enough for one UTC calendar month. The token needs the "Account Analytics: Read" permission; if missing → permission = true.
 * Never throws: every error returns { ok: false, permission, reason }.
 */
import type { CloudflareApi } from '../contracts';
import { R2OpTotals, R2StorageSample, sumR2Operations } from './costModel';
import { tr } from '../../../shared/i18n';

/** Max rows per dataset (the query limit). */
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
    /** Storage samples (all buckets in the account). */
    samples: R2StorageSample[];
    /** Storage samples hit the row limit (sorted newest → oldest, so the oldest sample may be missing). */
    truncated: boolean;
}

export type R2AnalyticsResult =
    | { ok: true; data: R2AnalyticsData }
    | { ok: false; permission: boolean; reason: string };

/** GraphQL Time variable: RFC 3339 without ms ('2026-10-01T00:00:00Z'). */
export function graphqlTime(ts: number): string {
    return new Date(Math.floor(ts / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const PERMISSION_RE = /authori[sz]|permission|forbidden|access denied|not allowed/i;

/** GraphQL error caused by a token missing the permission (e.g. "not authorized for that account", extensions.code 'authz'). */
export function isGraphqlPermissionError(errors: ReadonlyArray<{ message?: unknown; [k: string]: unknown }>): boolean {
    return (errors || []).some(e => {
        const ext = e && typeof e.extensions === 'object' && e.extensions ? (e.extensions as Record<string, unknown>) : {};
        const code = String(ext.code ?? '').toLowerCase();
        return code === 'authz' || code === 'unauthorized' || code === 'forbidden' || PERMISSION_RE.test(String(e?.message ?? ''));
    });
}

/** Short error sentence to add to the note for the user. */
export function shortReason(value: unknown): string {
    const s = String((value as any)?.message ?? value ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return tr('lỗi không rõ');
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Read the data part of the response; null when there is no account (the token cannot see this account). */
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

/** HTTP 401 / 403 error (CloudError from CloudflareApi carries the status). */
function isPermissionStatus(err: unknown): boolean {
    const status = (err as any)?.status;
    return status === 401 || status === 403;
}

/**
 * Query the account's R2 figures in [startTs, endTs] (≤ 31 days). Never throws.
 * HTTP 401/403 or a GraphQL permission error → permission = true; otherwise permission = false + a short reason.
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
        if (!data) return { ok: false, permission: true, reason: tr('Cloudflare không trả về số liệu của tài khoản này') };
        return { ok: true, data };
    } catch (err) {
        return { ok: false, permission: isPermissionStatus(err), reason: shortReason(err) };
    }
}
