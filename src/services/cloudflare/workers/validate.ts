/**
 * validate.ts: naming rules + input checks for an app's (plugin) Worker / D1, shared by
 * PluginApiBridge (checks BEFORE calling IPC), the IPC handler cloudflare:workers:* and WorkersDeployer (checked again in main).
 *
 * Contract: fintrack-deplao-app/docs/CONTRACTS.md §1.
 *  - Resource prefix = pluginShortName(id) (the last part of the app id). An app can only read / create / change Workers and D1 whose name
 *    is EXACTLY the prefix or starts with "<prefix>-". prefix null = the machine owner's UI (no prefix limit).
 *  - Errors throw CloudError with the contract codes: CF_NAME_FORBIDDEN, VALIDATION_ERROR (CF_BUNDLE_INVALID is in bundle.ts).
 *  - An error message never contains a secret / variable value.
 *
 * This file has no Electron dependency (the bridge, IPC and tests can all load it).
 */
import { CloudError } from '../contracts';
import { tr } from '../../../shared/i18n';

/** The app manifest permission for deplao.cloudflare.*. */
export const WORKERS_PERMISSION = 'cloudflare:workers';

/** Permission names exactly as on Cloudflare's token creation page (English Dashboard). */
export const WORKERS_PERMISSION_LABELS = {
    workers: 'Account · Workers Scripts · Edit',
    d1: 'Account · D1 · Edit',
} as const;

/**
 * Extra permissions needed when attaching a domain to a Worker: list domains (zones) and read DNS records so no existing record is overwritten.
 * Deplao's sample token-creation link already has both (Zone Read, DNS Edit). Not part of `missing` in status: only needed when
 * an app attaches a domain.
 */
export const DOMAIN_PERMISSION_LABELS = {
    zone: 'Zone · Zone · Read',
    dns: 'Zone · DNS · Read',
} as const;

/**
 * Error codes returned to the app → HTTP status of DeplaoApiError. Contract codes: CF_NOT_CONNECTED, CF_PERMISSION,
 * CF_NAME_FORBIDDEN, CF_BUNDLE_INVALID, CF_API, PLUGIN_PERMISSION; plus the shared API codes VALIDATION_ERROR, NOT_FOUND, CONFLICT.
 */
export const WORKERS_ERROR_STATUS: Readonly<Record<string, number>> = {
    CF_NOT_CONNECTED: 409,
    CF_PERMISSION: 403,
    CF_NAME_FORBIDDEN: 403,
    CF_BUNDLE_INVALID: 400,
    CF_API: 502,
    PLUGIN_PERMISSION: 403,
    /** The user clicks "Không" (No) in Deplao's confirmation dialog (attaching a domain). */
    CF_DECLINED: 403,
    VALIDATION_ERROR: 400,
    NOT_FOUND: 404,
    CONFLICT: 409,
};

/** Worker / D1 name: 1–63 characters a-z, 0-9, '-', must not start or end with '-' (it is the DNS label of <name>.<sub>.workers.dev). */
export const RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Binding name (env variable of the Worker): DB, AI, ASSETS, DEPLAO_INTEGRATION_SECRET… */
export const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Cloudflare: each variable / secret ≤ 5 KB, total variables + secrets ≤ 64 (Free plan). */
export const DEPLOY_LIMITS = {
    maxD1Bindings: 10,
    maxVars: 40,
    maxVarBytes: 5 * 1024,
    maxSecrets: 20,
    maxSecretBytes: 5 * 1024,
} as const;

export const QUERY_LIMITS = {
    maxSqlChars: 100_000,
    maxParams: 100,
    maxParamChars: 100_000,
} as const;

function bad(message: string): CloudError {
    return new CloudError('VALIDATION_ERROR', message);
}

function preview(v: unknown): string {
    return String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
}

export function isNameInPrefix(name: string, prefix: string): boolean {
    return !!prefix && (name === prefix || name.startsWith(`${prefix}-`));
}

/** Valid resource name (and the exact prefix when prefix is not null). Returns the name; invalid → CloudError('CF_NAME_FORBIDDEN'). */
export function assertResourceName(value: unknown, prefix: string | null, kind: 'Worker' | 'D1'): string {
    const name = typeof value === 'string' ? value : '';
    if (!RESOURCE_NAME_RE.test(name)) {
        throw new CloudError(
            'CF_NAME_FORBIDDEN',
            tr('Tên {{kind}} "{{v1}}" không hợp lệ: 1–63 ký tự chữ thường a-z, số, dấu "-", không bắt đầu / kết thúc bằng "-"', { kind, v1: preview(value) }),
        );
    }
    if (prefix !== null && !isNameInPrefix(name, prefix)) {
        throw new CloudError('CF_NAME_FORBIDDEN', tr('Ứng dụng chỉ được dùng {{kind}} tên "{{prefix}}" hoặc bắt đầu bằng "{{prefix}}-" (nhận "{{name}}")', { kind, prefix, name }));
    }
    return name;
}

/** Domain name for a Worker: ≥ 2 DNS labels (a-z, 0-9, '-' not at the start / end, ≤ 63 characters each), total ≤ 253 characters, no '*'. */
export const DOMAIN_HOSTNAME_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Domain the app wants to attach / detach for a Worker, e.g. "fintrack.tenmien.vn" → lowercase, trailing dot removed. Only checks the
 * format; the name must be a subdomain of a domain in the account (WorkersDeployer checks against the zone list).
 */
export function normalizeDomainHostname(value: unknown): string {
    const name = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.+$/, '') : '';
    if (!DOMAIN_HOSTNAME_RE.test(name)) {
        throw bad(tr('Tên miền "{{v1}}" không hợp lệ, vd fintrack.tenmien.vn (chữ thường a-z, số, "-" và ".")', { v1: preview(value) }));
    }
    return name;
}

export interface DeployOptions {
    name: string;
    d1: Array<{ binding: string; database: string }>;
    /** Workers AI binding name (e.g. "AI"), null = not attached. */
    ai: string | null;
    vars: Array<{ name: string; value: string }>;
    secrets: Array<{ name: string; value: string }>;
    /** Enable the route <name>.<subdomain>.workers.dev (default true). */
    workersDev: boolean;
}

function plainObject(v: unknown, label: string): Record<string, unknown> {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw bad(tr('{{label}} phải là object', { label }));
    return v as Record<string, unknown>;
}

/** Name → string pairs (vars / secrets). Error messages only name the key, never the value. */
function stringEntries(v: unknown, label: string, maxCount: number, maxBytes: number): Array<[string, string]> {
    const entries = Object.entries(plainObject(v, label));
    if (entries.length > maxCount) throw bad(tr('{{label}}: tối đa {{maxCount}} mục', { label, maxCount }));
    for (const [key, value] of entries) {
        if (typeof value !== 'string') throw bad(tr('{{label}}.{{v1}} phải là chuỗi', { label, v1: preview(key) }));
        if (Buffer.byteLength(value, 'utf8') > maxBytes) throw bad(tr('{{label}}.{{v1}} vượt {{v2}} KB', { label, v1: preview(key), v2: Math.round(maxBytes / 1024) }));
    }
    return entries as Array<[string, string]>;
}

/**
 * deployBundle parameters (except bundleDir: the bridge / handler resolves the path itself). Checks the Worker name + the D1 names in bindings
 * against the prefix, that binding names are valid and unique, and the size of variables / secrets.
 */
export function normalizeDeployOptions(raw: unknown, prefix: string | null): DeployOptions {
    const input = plainObject(raw, tr('Tham số triển khai'));
    const name = assertResourceName(input.name, prefix, 'Worker');
    const bindings = plainObject(input.bindings, 'bindings');
    const unknownKeys = Object.keys(bindings).filter(k => !['d1', 'ai', 'vars'].includes(k));
    if (unknownKeys.length) throw bad(tr('bindings chỉ nhận d1, ai, vars (có "{{v1}}")', { v1: preview(unknownKeys[0]) }));

    const used = new Set<string>();
    const claim = (binding: string, label: string): string => {
        if (!BINDING_NAME_RE.test(binding)) {
            throw bad(tr('Tên binding {{label}} "{{v1}}" chỉ gồm chữ, số, "_" và không bắt đầu bằng số', { label, v1: preview(binding) }));
        }
        if (used.has(binding)) throw bad(tr('Trùng tên binding "{{binding}}"', { binding }));
        used.add(binding);
        return binding;
    };

    const d1Entries = Object.entries(plainObject(bindings.d1, 'bindings.d1'));
    if (d1Entries.length > DEPLOY_LIMITS.maxD1Bindings) throw bad(tr('bindings.d1: tối đa {{maxD1Bindings}} cơ sở dữ liệu', { maxD1Bindings: DEPLOY_LIMITS.maxD1Bindings }));
    const d1 = d1Entries.map(([binding, database]) => ({
        binding: claim(binding, 'D1'),
        database: assertResourceName(database, prefix, 'D1'),
    }));

    let ai: string | null = null;
    const aiRaw = bindings.ai;
    if (aiRaw !== undefined && aiRaw !== null && aiRaw !== '') {
        if (typeof aiRaw !== 'string') throw bad(tr('bindings.ai phải là tên binding (chuỗi), vd "AI"'));
        ai = claim(aiRaw, 'Workers AI');
    }

    const vars = stringEntries(bindings.vars, 'bindings.vars', DEPLOY_LIMITS.maxVars, DEPLOY_LIMITS.maxVarBytes)
        .map(([key, value]) => ({ name: claim(key, tr('biến')), value }));
    const secrets = stringEntries(input.secrets, 'secrets', DEPLOY_LIMITS.maxSecrets, DEPLOY_LIMITS.maxSecretBytes)
        .map(([key, value]) => ({ name: claim(key, 'secret'), value }));

    let workersDev = true;
    const workersDevRaw = input.workersDev;
    if (workersDevRaw !== undefined && workersDevRaw !== null) {
        if (typeof workersDevRaw !== 'boolean') throw bad(tr('workersDev phải là true / false'));
        workersDev = workersDevRaw;
    }
    return { name, d1, ai, vars, secrets, workersDev };
}

/** One SQL statement + parameters for d1.query. */
export function normalizeQuery(sql: unknown, params: unknown): { sql: string; params: Array<string | number | null> } {
    if (typeof sql !== 'string' || !sql.trim()) throw bad(tr('Thiếu câu SQL'));
    if (sql.length > QUERY_LIMITS.maxSqlChars) throw bad(tr('Câu SQL tối đa {{maxSqlChars}} ký tự', { maxSqlChars: QUERY_LIMITS.maxSqlChars }));
    if (params === undefined || params === null) return { sql, params: [] };
    if (!Array.isArray(params) || params.length > QUERY_LIMITS.maxParams) throw bad(tr('params phải là mảng tối đa {{maxParams}} giá trị', { maxParams: QUERY_LIMITS.maxParams }));
    const out: Array<string | number | null> = [];
    params.forEach((v, i) => {
        if (v === null || (typeof v === 'number' && Number.isFinite(v))) out.push(v);
        else if (typeof v === 'string' && v.length <= QUERY_LIMITS.maxParamChars) out.push(v);
        else throw bad(tr('params[{{i}}] phải là chuỗi, số hoặc null', { i }));
    });
    return { sql, params: out };
}
