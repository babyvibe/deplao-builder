/**
 * ApiKeyService — cấp, xác thực, thu hồi API key.
 *
 * Key = "dpk_" + 43 ký tự base62 ngẫu nhiên (~256 bit). DB chỉ lưu SHA-256 của key và
 * 12 ký tự đầu (key_prefix) để tra cứu. Key đầy đủ chỉ trả về một lần khi tạo.
 */
import * as crypto from 'crypto';
import { apiDb } from '../dbSchema';
import { isValidIpRule } from '../http/ip';
import {
    ApiError, ApiScope, ErpRoleName, Principal, isApiScope,
} from '../types';
import { getApiSettingNumber } from '../settings';

export const KEY_PREFIX = 'dpk_';
const KEY_BODY_LENGTH = 43;
const LOOKUP_PREFIX_LENGTH = 12;
const VERIFY_CACHE_MS = 60_000;
const TOUCH_INTERVAL_MS = 60_000;
const ERP_ROLES: ErpRoleName[] = ['owner', 'admin', 'manager', 'member', 'guest'];
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export interface ApiKeyRecord {
    id: string;
    name: string;
    key_prefix: string;
    scopes: ApiScope[];
    account_ids: string[] | null;
    allowed_ips: string[] | null;
    rate_limit_per_min: number;
    erp_role: ErpRoleName;
    plugin_id: string | null;
    note: string;
    created_by: string;
    created_at: number;
    last_used_at: number | null;
    last_used_ip: string | null;
    expires_at: number | null;
    revoked_at: number | null;
}

export interface ApiKeyInput {
    name: string;
    scopes: string[];
    accountIds?: string[] | null;
    allowedIps?: string[] | null;
    rateLimitPerMin?: number;
    erpRole?: string;
    note?: string;
    expiresAt?: number | null;
    pluginId?: string | null;
    createdBy?: string;
}

interface Row {
    id: string; name: string; key_prefix: string; key_hash: string; scopes_json: string;
    account_ids_json: string | null; allowed_ips_json: string | null; rate_limit_per_min: number;
    erp_role: string; plugin_id: string | null; note: string; created_by: string; created_at: number;
    last_used_at: number | null; last_used_ip: string | null; expires_at: number | null; revoked_at: number | null;
}

function parseJsonArray(raw: string | null): string[] | null {
    if (raw === null || raw === undefined || raw === '') return null;
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : null;
    } catch {
        return null;
    }
}

function toRecord(row: Row): ApiKeyRecord {
    return {
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        scopes: (parseJsonArray(row.scopes_json) || []).filter(isApiScope),
        account_ids: parseJsonArray(row.account_ids_json),
        allowed_ips: parseJsonArray(row.allowed_ips_json),
        rate_limit_per_min: Number(row.rate_limit_per_min) || 0,
        erp_role: (ERP_ROLES.includes(row.erp_role as ErpRoleName) ? row.erp_role : 'manager') as ErpRoleName,
        plugin_id: row.plugin_id || null,
        note: row.note || '',
        created_by: row.created_by || 'boss',
        created_at: Number(row.created_at) || 0,
        last_used_at: row.last_used_at ?? null,
        last_used_ip: row.last_used_ip ?? null,
        expires_at: row.expires_at ?? null,
        revoked_at: row.revoked_at ?? null,
    };
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomBase62(length: number): string {
    let out = '';
    while (out.length < length) {
        const bytes = crypto.randomBytes(length * 2);
        for (const b of bytes) {
            // Bỏ byte >= 248 để không lệch phân phối (248 = 62 * 4).
            if (b >= 248) continue;
            out += BASE62[b % 62];
            if (out.length === length) break;
        }
    }
    return out;
}

export function sanitizeScopes(input: string[] | undefined | null): ApiScope[] {
    const list = Array.isArray(input) ? input : [];
    const invalid = list.filter(s => !isApiScope(s));
    if (invalid.length > 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Scope không hợp lệ: ${invalid.join(', ')}`);
    }
    const unique = Array.from(new Set(list)) as ApiScope[];
    if (unique.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Cần ít nhất một scope');
    return unique;
}

function sanitizeIps(input: string[] | null | undefined): string[] | null {
    if (input === null || input === undefined) return null;
    const list = input.map(s => String(s).trim()).filter(Boolean);
    if (list.length === 0) return null;
    const invalid = list.filter(r => !isValidIpRule(r));
    if (invalid.length > 0) throw new ApiError(400, 'VALIDATION_ERROR', `IP/CIDR không hợp lệ: ${invalid.join(', ')}`);
    return list;
}

function sanitizeAccounts(input: string[] | null | undefined): string[] | null {
    if (input === null || input === undefined) return null;
    const list = Array.from(new Set(input.map(s => String(s).trim()).filter(Boolean)));
    return list.length === 0 ? null : list;
}

function sanitizeErpRole(input: string | undefined): ErpRoleName {
    if (!input) return 'manager';
    if (!ERP_ROLES.includes(input as ErpRoleName)) {
        throw new ApiError(400, 'VALIDATION_ERROR', `erp_role phải là: ${ERP_ROLES.join(', ')}`);
    }
    return input as ErpRoleName;
}

class ApiKeyService {
    private static instance: ApiKeyService | null = null;
    private verifyCache = new Map<string, { rows: Row[]; at: number }>();
    private lastTouch = new Map<string, number>();

    static getInstance(): ApiKeyService {
        if (!ApiKeyService.instance) ApiKeyService.instance = new ApiKeyService();
        return ApiKeyService.instance;
    }

    /** Test: reset cache giữa các test. */
    static resetForTests(): void {
        ApiKeyService.instance = null;
    }

    looksLikeApiKey(token: string): boolean {
        return typeof token === 'string' && token.startsWith(KEY_PREFIX) && token.length === KEY_PREFIX.length + KEY_BODY_LENGTH;
    }

    create(input: ApiKeyInput): { key: string; record: ApiKeyRecord } {
        const name = String(input.name || '').trim();
        if (!name) throw new ApiError(400, 'VALIDATION_ERROR', 'Thiếu tên key');
        if (name.length > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'Tên key tối đa 100 ký tự');
        const scopes = sanitizeScopes(input.scopes);
        const accountIds = sanitizeAccounts(input.accountIds);
        const allowedIps = sanitizeIps(input.allowedIps);
        const rate = Math.max(0, Math.floor(Number(input.rateLimitPerMin) || 0));
        const erpRole = sanitizeErpRole(input.erpRole);
        const expiresAt = input.expiresAt ? Number(input.expiresAt) : null;
        if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'expires_at phải là thời điểm trong tương lai (epoch ms)');
        }

        const body = randomBase62(KEY_BODY_LENGTH);
        const key = KEY_PREFIX + body;
        const id = crypto.randomUUID();
        const now = Date.now();
        apiDb().run(
            `INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes_json, account_ids_json, allowed_ips_json,
               rate_limit_per_min, erp_role, plugin_id, note, created_by, created_at, expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                id, name, body.slice(0, LOOKUP_PREFIX_LENGTH), sha256(key), JSON.stringify(scopes),
                accountIds ? JSON.stringify(accountIds) : null, allowedIps ? JSON.stringify(allowedIps) : null,
                rate, erpRole, input.pluginId || null, String(input.note || '').slice(0, 500),
                input.createdBy || 'boss', now, expiresAt,
            ],
        );
        this.verifyCache.clear();
        return { key, record: this.get(id)! };
    }

    list(opts: { includeRevoked?: boolean; includePluginKeys?: boolean } = {}): ApiKeyRecord[] {
        const where: string[] = [];
        if (!opts.includeRevoked) where.push('revoked_at IS NULL');
        if (!opts.includePluginKeys) where.push('plugin_id IS NULL');
        const sql = `SELECT * FROM api_keys ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
        return apiDb().query<Row>(sql).map(toRecord);
    }

    get(id: string): ApiKeyRecord | null {
        const row = apiDb().queryOne<Row>('SELECT * FROM api_keys WHERE id = ?', [id]);
        return row ? toRecord(row) : null;
    }

    update(id: string, patch: Partial<Omit<ApiKeyInput, 'pluginId' | 'createdBy'>>): ApiKeyRecord {
        const current = this.get(id);
        if (!current) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy key');
        if (current.revoked_at) throw new ApiError(409, 'CONFLICT', 'Key đã bị thu hồi');
        const sets: string[] = [];
        const params: any[] = [];
        if (patch.name !== undefined) {
            const name = String(patch.name).trim();
            if (!name || name.length > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'Tên key 1–100 ký tự');
            sets.push('name = ?'); params.push(name);
        }
        if (patch.scopes !== undefined) { sets.push('scopes_json = ?'); params.push(JSON.stringify(sanitizeScopes(patch.scopes))); }
        if (patch.accountIds !== undefined) {
            const v = sanitizeAccounts(patch.accountIds);
            sets.push('account_ids_json = ?'); params.push(v ? JSON.stringify(v) : null);
        }
        if (patch.allowedIps !== undefined) {
            const v = sanitizeIps(patch.allowedIps);
            sets.push('allowed_ips_json = ?'); params.push(v ? JSON.stringify(v) : null);
        }
        if (patch.rateLimitPerMin !== undefined) {
            sets.push('rate_limit_per_min = ?'); params.push(Math.max(0, Math.floor(Number(patch.rateLimitPerMin) || 0)));
        }
        if (patch.erpRole !== undefined) { sets.push('erp_role = ?'); params.push(sanitizeErpRole(patch.erpRole)); }
        if (patch.note !== undefined) { sets.push('note = ?'); params.push(String(patch.note || '').slice(0, 500)); }
        if (patch.expiresAt !== undefined) {
            const v = patch.expiresAt ? Number(patch.expiresAt) : null;
            if (v !== null && (!Number.isFinite(v) || v <= Date.now())) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'expires_at phải là thời điểm trong tương lai');
            }
            sets.push('expires_at = ?'); params.push(v);
        }
        if (sets.length > 0) {
            apiDb().run(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
            this.verifyCache.clear();
        }
        return this.get(id)!;
    }

    revoke(id: string): boolean {
        const changed = apiDb().runChanges('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), id]);
        this.verifyCache.clear();
        return changed > 0;
    }

    revokeAll(): number {
        const changed = apiDb().runChanges('UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL AND plugin_id IS NULL', [Date.now()]);
        this.verifyCache.clear();
        return changed;
    }

    revokeByPlugin(pluginId: string): number {
        const changed = apiDb().runChanges('UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL AND plugin_id = ?', [Date.now(), pluginId]);
        this.verifyCache.clear();
        return changed;
    }

    /** Xoá hẳn key đã thu hồi (dọn danh sách). */
    purge(id: string): boolean {
        const changed = apiDb().runChanges('DELETE FROM api_keys WHERE id = ? AND revoked_at IS NOT NULL', [id]);
        this.verifyCache.clear();
        return changed > 0;
    }

    /** Trả record nếu key hợp lệ (chưa thu hồi, chưa hết hạn), ngược lại null. */
    verify(rawKey: string): ApiKeyRecord | null {
        if (!this.looksLikeApiKey(rawKey)) return null;
        const prefix = rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + LOOKUP_PREFIX_LENGTH);
        const now = Date.now();
        let cached = this.verifyCache.get(prefix);
        if (!cached || now - cached.at > VERIFY_CACHE_MS) {
            const rows = apiDb().query<Row>('SELECT * FROM api_keys WHERE key_prefix = ?', [prefix]);
            cached = { rows, at: now };
            this.verifyCache.set(prefix, cached);
            if (this.verifyCache.size > 1000) {
                const first = this.verifyCache.keys().next().value;
                if (first !== undefined) this.verifyCache.delete(first);
            }
        }
        const hash = Buffer.from(sha256(rawKey), 'hex');
        for (const row of cached.rows) {
            const stored = Buffer.from(String(row.key_hash || ''), 'hex');
            if (stored.length !== hash.length || !crypto.timingSafeEqual(stored, hash)) continue;
            if (row.revoked_at) return null;
            if (row.expires_at && Number(row.expires_at) <= now) return null;
            return toRecord(row);
        }
        return null;
    }

    /** Ghi last_used_at tối đa 1 lần/phút mỗi key. */
    touch(id: string, ip: string): void {
        const now = Date.now();
        const last = this.lastTouch.get(id) || 0;
        if (now - last < TOUCH_INTERVAL_MS) return;
        this.lastTouch.set(id, now);
        try {
            apiDb().run('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?', [now, ip || null, id]);
        } catch { /* không chặn request vì lỗi ghi thống kê */ }
    }

    toPrincipal(record: ApiKeyRecord): Principal {
        const fallbackLimit = getApiSettingNumber('api_default_rate_limit');
        return {
            kind: 'apikey',
            id: record.id,
            name: record.name,
            scopes: new Set(record.scopes),
            accountIds: record.account_ids,
            rateLimitPerMin: record.rate_limit_per_min > 0 ? record.rate_limit_per_min : Math.max(0, fallbackLimit),
            erp: { employeeId: 'boss', role: record.erp_role },
            allowedIps: record.allowed_ips,
        };
    }
}

export default ApiKeyService;
