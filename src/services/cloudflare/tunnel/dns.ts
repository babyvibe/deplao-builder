/**
 * Bản ghi DNS cho "Cloudflare tự động": mỗi tên một CNAME `<tunnelId>.cfargotunnel.com`, proxied, ttl auto,
 * comment `deplao:<tunnelId>` (đánh dấu bản ghi do Deplao tạo — chỉ bản ghi có dấu này mới được sửa / xoá).
 *
 * Quyết định theo bản ghi đang có của tên (GET /zones/{z}/dns_records?name.exact=<fqdn>):
 *   không có                                         → tạo mới
 *   CNAME trỏ đúng tunnel này                         → dùng lại (thiếu proxied / comment thì sửa cho đúng)
 *   CNAME trỏ *.cfargotunnel.com khác, comment deplao: → sửa trỏ về tunnel này (đổi máy)
 *   còn lại (A/AAAA, CNAME khác, tunnel không phải Deplao…) → CloudError('DNS_CONFLICT') — không ghi gì cả
 * Kiểm tra hết mọi tên trước rồi mới ghi; ghi lỗi giữa chừng → xoá các bản ghi vừa tạo trong lần này.
 */
import { CloudError, type CloudflareApi } from '../contracts';
import { normalizeHostname } from './ingress';

export interface DnsRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
    comment?: string | null;
}

export const DNS_COMMENT_PREFIX = 'deplao:';

export function dnsComment(tunnelId: string): string {
    return `${DNS_COMMENT_PREFIX}${tunnelId}`;
}

export function tunnelCnameTarget(tunnelId: string): string {
    return `${tunnelId}.cfargotunnel.com`;
}

export function cnameBody(hostname: string, tunnelId: string): Record<string, unknown> {
    return {
        type: 'CNAME',
        name: hostname,
        content: tunnelCnameTarget(tunnelId),
        proxied: true,
        ttl: 1,
        comment: dnsComment(tunnelId),
    };
}

function isCname(record: DnsRecord): boolean {
    return String(record?.type || '').toUpperCase() === 'CNAME';
}

function contentOf(record: DnsRecord): string {
    return normalizeHostname(record?.content);
}

/** Bản ghi thuộc tunnel này: mang comment của Deplao cho tunnel này, hoặc CNAME trỏ đúng tunnel này. */
export function isRecordOfTunnel(record: DnsRecord, tunnelId: string): boolean {
    if (!record) return false;
    if (String(record.comment || '') === dnsComment(tunnelId)) return true;
    return isCname(record) && contentOf(record) === tunnelCnameTarget(tunnelId).toLowerCase();
}

export type DnsPlan =
    | { action: 'create'; hostname: string }
    | { action: 'reuse'; hostname: string; recordId: string }
    | { action: 'patch'; hostname: string; recordId: string; from: string }
    | { action: 'conflict'; hostname: string; detail: string };

export function planRecord(hostname: string, records: DnsRecord[] | null | undefined, tunnelId: string): DnsPlan {
    const name = normalizeHostname(hostname);
    const target = tunnelCnameTarget(tunnelId).toLowerCase();
    const tag = dnsComment(tunnelId);
    // name.exact lọc ở phía Cloudflare; lọc lại phòng khi bộ lọc bị bỏ qua
    const list = (Array.isArray(records) ? records : []).filter((r) => r && normalizeHostname(r.name) === name);
    if (!list.length) return { action: 'create', hostname: name };
    const mine = list.find((r) => isCname(r) && contentOf(r) === target);
    if (mine) {
        if (mine.proxied === true && String(mine.comment || '') === tag) return { action: 'reuse', hostname: name, recordId: mine.id };
        return { action: 'patch', hostname: name, recordId: mine.id, from: contentOf(mine) };
    }
    if (list.length === 1) {
        const only = list[0];
        if (isCname(only) && contentOf(only).endsWith('.cfargotunnel.com') && String(only.comment || '').startsWith(DNS_COMMENT_PREFIX)) {
            return { action: 'patch', hostname: name, recordId: only.id, from: contentOf(only) };
        }
    }
    const detail = list.map((r) => `${String(r.type || '?').toUpperCase()} ${r.content || ''}`.trim()).join(', ');
    return { action: 'conflict', hostname: name, detail };
}

export function dnsConflictError(hostname: string): CloudError {
    return new CloudError('DNS_CONFLICT', `Tên ${hostname} đã được dùng cho bản ghi khác, hãy chọn tên khác`);
}

export async function listRecordsByName(api: CloudflareApi, zoneId: string, hostname: string): Promise<DnsRecord[]> {
    const records = await api.request<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records`, undefined, {
        query: { 'name.exact': normalizeHostname(hostname), per_page: 50 },
    });
    return Array.isArray(records) ? records : [];
}

export interface EnsureRecordsResult {
    /** fqdn → id bản ghi. */
    recordIds: Record<string, string>;
    created: string[];
    patched: string[];
}

/** Đảm bảo mỗi tên có CNAME tới tunnel này. Xung đột → CloudError('DNS_CONFLICT') trước khi ghi bất cứ gì. */
export async function ensureRecords(api: CloudflareApi, zoneId: string, hostnames: string[], tunnelId: string): Promise<EnsureRecordsResult> {
    const names = Array.from(new Set(hostnames.map(normalizeHostname).filter(Boolean)));
    const plans: DnsPlan[] = [];
    for (const hostname of names) plans.push(planRecord(hostname, await listRecordsByName(api, zoneId, hostname), tunnelId));
    const conflict = plans.find((plan) => plan.action === 'conflict');
    if (conflict) throw dnsConflictError(conflict.hostname);

    const result: EnsureRecordsResult = { recordIds: {}, created: [], patched: [] };
    try {
        for (const plan of plans) {
            if (plan.action === 'reuse') {
                result.recordIds[plan.hostname] = plan.recordId;
            } else if (plan.action === 'create') {
                const record = await api.request<DnsRecord>('POST', `/zones/${zoneId}/dns_records`, cnameBody(plan.hostname, tunnelId));
                result.recordIds[plan.hostname] = record?.id;
                result.created.push(plan.hostname);
            } else if (plan.action === 'patch') {
                const record = await api.request<DnsRecord>('PATCH', `/zones/${zoneId}/dns_records/${plan.recordId}`, cnameBody(plan.hostname, tunnelId));
                result.recordIds[plan.hostname] = record?.id || plan.recordId;
                result.patched.push(plan.hostname);
            }
        }
    } catch (err) {
        // Không để lại bản ghi dở: xoá bản ghi vừa tạo trong lần này (bản ghi đã sửa thì đã trỏ về máy này — giữ)
        for (const hostname of result.created) {
            const id = result.recordIds[hostname];
            if (id) await api.request('DELETE', `/zones/${zoneId}/dns_records/${id}`).catch(() => undefined);
        }
        throw err;
    }
    return result;
}

function isNotFound(err: unknown): boolean {
    return err instanceof CloudError ? err.status === 404 : (err as any)?.status === 404;
}

/**
 * Xoá bản ghi DNS của tunnel này (comment `deplao:<id>` hoặc CNAME trỏ đúng tunnel). Bản ghi đã được máy khác sửa
 * trỏ sang tunnel của nó (comment khác) KHÔNG bị xoá.
 *  - sweep (mặc định true): một GET lọc theo comment cho cả zone.
 *  - hostnames: tên cần kiểm tra riêng (khi sweep tắt / lỗi / không thấy tên đó).
 * Trả về các tên đã xoá.
 */
export async function removeRecords(
    api: CloudflareApi,
    zoneId: string,
    tunnelId: string,
    opts: { hostnames?: string[]; sweep?: boolean } = {},
): Promise<string[]> {
    const found = new Map<string, DnsRecord>();
    if (opts.sweep !== false) {
        try {
            const swept = await api.request<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records`, undefined, {
                query: { 'comment.exact': dnsComment(tunnelId), per_page: 100 },
            });
            for (const record of Array.isArray(swept) ? swept : []) {
                if (record?.id && isRecordOfTunnel(record, tunnelId)) found.set(record.id, record);
            }
        } catch {
            /* bộ lọc comment không dùng được → dò theo từng tên bên dưới */
        }
    }
    const seenNames = new Set(Array.from(found.values(), (r) => normalizeHostname(r.name)));
    for (const hostname of Array.from(new Set((opts.hostnames ?? []).map(normalizeHostname).filter(Boolean)))) {
        if (seenNames.has(hostname)) continue;
        for (const record of await listRecordsByName(api, zoneId, hostname)) {
            if (record?.id && normalizeHostname(record.name) === hostname && isRecordOfTunnel(record, tunnelId)) found.set(record.id, record);
        }
    }
    const removed: string[] = [];
    for (const record of found.values()) {
        try {
            await api.request('DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
        } catch (err) {
            if (!isNotFound(err)) throw err;
        }
        removed.push(normalizeHostname(record.name));
    }
    return removed;
}

export type RecordOwnership = 'ours' | 'missing' | 'elsewhere';

/** Tên đang trỏ về tunnel này, chưa có bản ghi, hay đã trỏ sang nơi khác (máy khác đã "chuyển về máy này"). */
export async function inspectOwnership(api: CloudflareApi, zoneId: string, hostnames: string[], tunnelId: string): Promise<Record<string, RecordOwnership>> {
    const result: Record<string, RecordOwnership> = {};
    const target = tunnelCnameTarget(tunnelId).toLowerCase();
    for (const hostname of Array.from(new Set(hostnames.map(normalizeHostname).filter(Boolean)))) {
        const records = (await listRecordsByName(api, zoneId, hostname)).filter((r) => normalizeHostname(r?.name) === hostname);
        if (!records.length) result[hostname] = 'missing';
        else result[hostname] = records.some((r) => isCname(r) && contentOf(r) === target) ? 'ours' : 'elsewhere';
    }
    return result;
}
