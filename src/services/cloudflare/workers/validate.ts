/**
 * validate.ts — luật đặt tên + kiểm tra đầu vào cho Worker / D1 của ứng dụng (plugin), dùng chung cho
 * PluginApiBridge (kiểm TRƯỚC khi gọi IPC), handler IPC cloudflare:workers:* và WorkersDeployer (kiểm lại ở main).
 *
 * Hợp đồng: fintrack-deplao-plugin/docs/CONTRACTS.md §1.
 *  - Tiền tố tài nguyên = pluginShortName(id) (phần cuối id ứng dụng). Ứng dụng chỉ đọc / tạo / sửa Worker và D1 có tên
 *    ĐÚNG BẰNG tiền tố hoặc bắt đầu bằng "<tiền tố>-". prefix null = giao diện của chủ máy (không giới hạn tiền tố).
 *  - Lỗi ném CloudError với mã của hợp đồng: CF_NAME_FORBIDDEN, VALIDATION_ERROR (CF_BUNDLE_INVALID ở bundle.ts).
 *  - Câu lỗi không bao giờ chứa giá trị secret / biến.
 *
 * File này không phụ thuộc Electron (bridge, IPC và test đều nạp được).
 */
import { CloudError } from '../contracts';

/** Quyền manifest của ứng dụng cho deplao.cloudflare.*. */
export const WORKERS_PERMISSION = 'cloudflare:workers';

/** Tên quyền đúng như trên trang tạo token của Cloudflare (Dashboard tiếng Anh). */
export const WORKERS_PERMISSION_LABELS = {
    workers: 'Account · Workers Scripts · Edit',
    d1: 'Account · D1 · Edit',
} as const;

/**
 * Quyền thêm khi gắn tên miền cho Worker: liệt kê tên miền (zone) và đọc bản ghi DNS để không đè bản ghi đang có.
 * Link mẫu tạo token của Deplao đã có cả hai (Zone Read, DNS Edit). Không nằm trong `missing` của status: chỉ cần khi
 * ứng dụng gắn tên miền.
 */
export const DOMAIN_PERMISSION_LABELS = {
    zone: 'Zone · Zone · Read',
    dns: 'Zone · DNS · Read',
} as const;

/**
 * Mã lỗi trả cho ứng dụng → HTTP status của DeplaoApiError. Mã của hợp đồng: CF_NOT_CONNECTED, CF_PERMISSION,
 * CF_NAME_FORBIDDEN, CF_BUNDLE_INVALID, CF_API, PLUGIN_PERMISSION; thêm mã API chung VALIDATION_ERROR, NOT_FOUND, CONFLICT.
 */
export const WORKERS_ERROR_STATUS: Readonly<Record<string, number>> = {
    CF_NOT_CONNECTED: 409,
    CF_PERMISSION: 403,
    CF_NAME_FORBIDDEN: 403,
    CF_BUNDLE_INVALID: 400,
    CF_API: 502,
    PLUGIN_PERMISSION: 403,
    /** Người dùng bấm "Không" ở hộp thoại xác nhận của Deplao (gắn tên miền). */
    CF_DECLINED: 403,
    VALIDATION_ERROR: 400,
    NOT_FOUND: 404,
    CONFLICT: 409,
};

/** Tên Worker / D1: 1–63 ký tự a-z, 0-9, '-', không bắt đầu / kết thúc bằng '-' (là nhãn DNS của <tên>.<sub>.workers.dev). */
export const RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Tên binding (biến env của Worker): DB, AI, ASSETS, DEPLAO_INTEGRATION_SECRET… */
export const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Cloudflare: mỗi biến / secret ≤ 5 KB, tổng biến + secret ≤ 64 (gói Free). */
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

/** Tên tài nguyên hợp lệ (+ đúng tiền tố khi prefix khác null). Trả tên; sai → CloudError('CF_NAME_FORBIDDEN'). */
export function assertResourceName(value: unknown, prefix: string | null, kind: 'Worker' | 'D1'): string {
    const name = typeof value === 'string' ? value : '';
    if (!RESOURCE_NAME_RE.test(name)) {
        throw new CloudError(
            'CF_NAME_FORBIDDEN',
            `Tên ${kind} "${preview(value)}" không hợp lệ: 1–63 ký tự chữ thường a-z, số, dấu "-", không bắt đầu / kết thúc bằng "-"`,
        );
    }
    if (prefix !== null && !isNameInPrefix(name, prefix)) {
        throw new CloudError('CF_NAME_FORBIDDEN', `Ứng dụng chỉ được dùng ${kind} tên "${prefix}" hoặc bắt đầu bằng "${prefix}-" (nhận "${name}")`);
    }
    return name;
}

/** Tên miền cho Worker: ≥ 2 nhãn DNS (a-z, 0-9, '-' không ở đầu / cuối, ≤ 63 ký tự), tổng ≤ 253 ký tự, không có '*'. */
export const DOMAIN_HOSTNAME_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Tên miền ứng dụng muốn gắn / gỡ cho Worker, vd "fintrack.tenmien.vn" → chữ thường, bỏ dấu chấm cuối. Chỉ kiểm định
 * dạng; tên phải là tên con của một tên miền trong tài khoản (WorkersDeployer kiểm bằng danh sách zone).
 */
export function normalizeDomainHostname(value: unknown): string {
    const name = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.+$/, '') : '';
    if (!DOMAIN_HOSTNAME_RE.test(name)) {
        throw bad(`Tên miền "${preview(value)}" không hợp lệ, vd fintrack.tenmien.vn (chữ thường a-z, số, "-" và ".")`);
    }
    return name;
}

export interface DeployOptions {
    name: string;
    d1: Array<{ binding: string; database: string }>;
    /** Tên binding Workers AI (vd "AI"), null = không gắn. */
    ai: string | null;
    vars: Array<{ name: string; value: string }>;
    secrets: Array<{ name: string; value: string }>;
    /** Bật route <tên>.<subdomain>.workers.dev (mặc định true). */
    workersDev: boolean;
}

function plainObject(v: unknown, label: string): Record<string, unknown> {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${label} phải là object`);
    return v as Record<string, unknown>;
}

/** Cặp tên → chuỗi (vars / secrets). Câu lỗi chỉ nêu tên, không nêu giá trị. */
function stringEntries(v: unknown, label: string, maxCount: number, maxBytes: number): Array<[string, string]> {
    const entries = Object.entries(plainObject(v, label));
    if (entries.length > maxCount) throw bad(`${label}: tối đa ${maxCount} mục`);
    for (const [key, value] of entries) {
        if (typeof value !== 'string') throw bad(`${label}.${preview(key)} phải là chuỗi`);
        if (Buffer.byteLength(value, 'utf8') > maxBytes) throw bad(`${label}.${preview(key)} vượt ${Math.round(maxBytes / 1024)} KB`);
    }
    return entries as Array<[string, string]>;
}

/**
 * Tham số deployBundle (trừ bundleDir — bridge / handler tự giải đường dẫn). Kiểm tên Worker + tên D1 trong bindings
 * theo tiền tố, tên binding hợp lệ và không trùng nhau, kích thước biến / secret.
 */
export function normalizeDeployOptions(raw: unknown, prefix: string | null): DeployOptions {
    const input = plainObject(raw, 'Tham số triển khai');
    const name = assertResourceName(input.name, prefix, 'Worker');
    const bindings = plainObject(input.bindings, 'bindings');
    const unknownKeys = Object.keys(bindings).filter(k => !['d1', 'ai', 'vars'].includes(k));
    if (unknownKeys.length) throw bad(`bindings chỉ nhận d1, ai, vars (có "${preview(unknownKeys[0])}")`);

    const used = new Set<string>();
    const claim = (binding: string, label: string): string => {
        if (!BINDING_NAME_RE.test(binding)) {
            throw bad(`Tên binding ${label} "${preview(binding)}" chỉ gồm chữ, số, "_" và không bắt đầu bằng số`);
        }
        if (used.has(binding)) throw bad(`Trùng tên binding "${binding}"`);
        used.add(binding);
        return binding;
    };

    const d1Entries = Object.entries(plainObject(bindings.d1, 'bindings.d1'));
    if (d1Entries.length > DEPLOY_LIMITS.maxD1Bindings) throw bad(`bindings.d1: tối đa ${DEPLOY_LIMITS.maxD1Bindings} cơ sở dữ liệu`);
    const d1 = d1Entries.map(([binding, database]) => ({
        binding: claim(binding, 'D1'),
        database: assertResourceName(database, prefix, 'D1'),
    }));

    let ai: string | null = null;
    const aiRaw = bindings.ai;
    if (aiRaw !== undefined && aiRaw !== null && aiRaw !== '') {
        if (typeof aiRaw !== 'string') throw bad('bindings.ai phải là tên binding (chuỗi), vd "AI"');
        ai = claim(aiRaw, 'Workers AI');
    }

    const vars = stringEntries(bindings.vars, 'bindings.vars', DEPLOY_LIMITS.maxVars, DEPLOY_LIMITS.maxVarBytes)
        .map(([key, value]) => ({ name: claim(key, 'biến'), value }));
    const secrets = stringEntries(input.secrets, 'secrets', DEPLOY_LIMITS.maxSecrets, DEPLOY_LIMITS.maxSecretBytes)
        .map(([key, value]) => ({ name: claim(key, 'secret'), value }));

    let workersDev = true;
    const workersDevRaw = input.workersDev;
    if (workersDevRaw !== undefined && workersDevRaw !== null) {
        if (typeof workersDevRaw !== 'boolean') throw bad('workersDev phải là true / false');
        workersDev = workersDevRaw;
    }
    return { name, d1, ai, vars, secrets, workersDev };
}

/** Một câu SQL + tham số cho d1.query. */
export function normalizeQuery(sql: unknown, params: unknown): { sql: string; params: Array<string | number | null> } {
    if (typeof sql !== 'string' || !sql.trim()) throw bad('Thiếu câu SQL');
    if (sql.length > QUERY_LIMITS.maxSqlChars) throw bad(`Câu SQL tối đa ${QUERY_LIMITS.maxSqlChars} ký tự`);
    if (params === undefined || params === null) return { sql, params: [] };
    if (!Array.isArray(params) || params.length > QUERY_LIMITS.maxParams) throw bad(`params phải là mảng tối đa ${QUERY_LIMITS.maxParams} giá trị`);
    const out: Array<string | number | null> = [];
    params.forEach((v, i) => {
        if (v === null || (typeof v === 'number' && Number.isFinite(v))) out.push(v);
        else if (typeof v === 'string' && v.length <= QUERY_LIMITS.maxParamChars) out.push(v);
        else throw bad(`params[${i}] phải là chuỗi, số hoặc null`);
    });
    return { sql, params: out };
}
