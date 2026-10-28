/**
 * WorkersDeployer — Worker + D1 trên tài khoản Cloudflare đã kết nối, cho ứng dụng (plugin) có quyền cloudflare:workers
 * (fintrack-deplao-plugin/docs/CONTRACTS.md §1). Chạy ở main; token Cloudflare chỉ nằm trong CloudflareApi
 * (cloudflare.api()), không bao giờ đi ra ứng dụng.
 *
 * Chỉ dùng qua scoped(prefix): MỌI tên Worker / D1 (kể cả D1 trong bindings) phải là prefix hoặc "<prefix>-…"
 * (prefix null = giao diện của chủ máy: chỉ kiểm định dạng tên).
 *  - status: không gọi Cloudflare khi chưa kết nối; thử quyền bằng 2 GET rẻ (Workers Scripts, D1) + đọc subdomain
 *    workers.dev; nhớ 60 s vì ngân sách 100 request / 5 phút (CloudflareApi) là của CẢ app.
 *  - d1.ensure: tìm theo tên, chưa có thì tạo (location hint 'apac').
 *  - d1.migrate: như `wrangler d1 migrations apply` — bảng d1_migrations(id, name, applied_at), file *.sql sắp theo tên,
 *    bỏ file đã áp; mỗi file MỘT lần gọi /query, INSERT tên file nằm cuối cùng lô (D1 chạy các câu của một lần gọi như
 *    một lô trong giao dịch → file lỗi không bị ghi là đã áp). Lỗi → dừng, câu lỗi nêu tên file.
 *  - d1.query: một câu SQL (đọc kiểm tra).
 *  - workers.get / workers.deployBundle: gói dựng sẵn (bundle.ts) → [asset: upload-session → từng bucket bằng JWT của
 *    phiên tải lên (fetch riêng, KHÔNG dùng token tài khoản)] → PUT script multipart → bật / tắt workers.dev → secrets.
 *    Mỗi request (kể cả tải asset) đi qua ngân sách chung; tiến độ chỉ ghi nhật ký.
 *  - Lỗi: CloudError mã hợp đồng CF_NOT_CONNECTED | CF_PERMISSION | CF_NAME_FORBIDDEN | CF_BUNDLE_INVALID | CF_API
 *    (+ VALIDATION_ERROR, NOT_FOUND, CONFLICT). Không log token, JWT, secret hay câu SQL.
 */
import * as fs from 'fs';
import { CloudError } from '../contracts';
import type { CloudflareApi, CloudflareCore } from '../contracts';
import { CF_API_BASE, CloudApiError, cloudflareBudget } from '../CloudflareApi';
import type { FetchLike, RequestBudget } from '../CloudflareApi';
import Logger from '../../../utils/Logger';
import { listMigrationFiles, readBundle, stripBom } from './bundle';
import type { BundleAsset } from './bundle';
import { buildMultipart } from './multipart';
import type { MultipartPart } from './multipart';
import {
    assertResourceName, normalizeDeployOptions, normalizeQuery, RESOURCE_NAME_RE, WORKERS_PERMISSION_LABELS,
} from './validate';
import type { DeployOptions } from './validate';

export interface WorkersStatus {
    connected: boolean;
    accountId: string | null;
    accountName: string | null;
    /** <subdomain>.workers.dev của tài khoản; null nếu chưa có / chưa đọc được. */
    workersSubdomain: string | null;
    /** Tiền tố tên tài nguyên của ứng dụng. */
    prefix: string;
    /** Quyền token còn thiếu, vd ["Account · D1 · Edit"]; rỗng = đủ. */
    missing: string[];
}

export interface WorkerInfo { exists: boolean; modifiedOn: string | null; url: string | null }
export interface DeployResult { name: string; url: string | null; deployedAt: number }
export interface D1Info { uuid: string; name: string; created: boolean }
export interface MigrateResult { applied: string[]; skipped: string[] }
export type Progress = (message: string) => void;

/** API đã gắn tiền tố — handler IPC tạo một scope cho mỗi lời gọi. */
export interface WorkersScope {
    readonly prefix: string | null;
    /** displayPrefix: tiền tố hiện trong kết quả khi scope không có tiền tố (giao diện chủ máy). */
    status(displayPrefix?: string): Promise<WorkersStatus>;
    workerGet(name: unknown): Promise<WorkerInfo>;
    /** bundleDir: đường dẫn tuyệt đối người gọi đã kiểm vị trí (ứng dụng: nằm trong thư mục ứng dụng). */
    deployBundle(input: unknown, bundleDir: string, onProgress?: Progress): Promise<DeployResult>;
    d1Ensure(name: unknown): Promise<D1Info>;
    /** dir: thư mục tuyệt đối chứa *.sql, người gọi đã kiểm vị trí. */
    d1Migrate(name: unknown, dir: string, onProgress?: Progress): Promise<MigrateResult>;
    d1Query(name: unknown, sql: unknown, params?: unknown): Promise<{ results: any[] }>;
}

export interface WorkersDeployerDeps {
    core: () => CloudflareCore;
    /** fetch cho bước tải asset (Bearer = JWT phiên tải lên). Mặc định globalThis.fetch. */
    uploadFetch?: FetchLike;
    /** Ngân sách request dùng chung (mặc định cloudflareBudget của cả app). */
    budget?: RequestBudget;
    apiBase?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Chờ giữa các lần thử lại khi tải asset lỗi mạng / 5xx / 429. */
    retryDelaysMs?: ReadonlyArray<number>;
    log?: (message: string) => void;
}

const STATUS_TTL_MS = 60_000;
const SUBDOMAIN_TTL_MS = 10 * 60_000;
const D1_TTL_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const SCRIPT_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 60_000;
const UPLOAD_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 3000];

/** Bảng ghi migration giống hệt wrangler (tên bảng mặc định d1_migrations). */
export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

const NOT_CONNECTED_MESSAGE = 'Chưa kết nối Cloudflare — kết nối ở Cài đặt → Internet & Đám mây trên máy chủ';
const TOKEN_INVALID_MESSAGE = 'Token Cloudflare không còn hợp lệ — kết nối lại ở Cài đặt → Internet & Đám mây';
const OWN_CODES = new Set(['CF_NOT_CONNECTED', 'CF_PERMISSION', 'CF_NAME_FORBIDDEN', 'CF_BUNDLE_INVALID', 'CF_API', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT']);

export function permissionError(need: 'workers' | 'd1', status?: number): CloudError {
    const label = WORKERS_PERMISSION_LABELS[need];
    return new CloudError(
        'CF_PERMISSION',
        `Token Cloudflare thiếu quyền "${label}" — thêm quyền này cho token (hoặc tạo token mới bằng link mẫu ở Cài đặt → Internet & Đám mây) rồi bấm Kiểm tra lại token`,
        status,
    );
}

/** Lỗi bất kỳ → CloudError mã hợp đồng (need: quyền cần nêu khi Cloudflare báo thiếu quyền). */
export function toWorkersError(err: unknown, need: 'workers' | 'd1'): CloudError {
    if (err instanceof CloudApiError) {
        // Mã Cloudflare quyết định trước HTTP status: thiếu quyền một API (mã 10000 "Authentication error") nhiều endpoint
        // trả HTTP 401 — vd liệt kê D1 khi token chưa có D1 — đó là thiếu quyền, không phải token hỏng / chưa kết nối.
        if (err.code === 'FORBIDDEN') return permissionError(need, err.status);
        if (err.code === 'INVALID_TOKEN' || err.status === 401) return new CloudError('CF_NOT_CONNECTED', TOKEN_INVALID_MESSAGE, err.status);
        if (err.status === 403) return permissionError(need, err.status);
        return new CloudError('CF_API', err.message, err.status, err.retryAfterMs);
    }
    if (err instanceof CloudError) {
        if (OWN_CODES.has(err.code)) return err;
        if (err.code === 'NOT_CONNECTED') return new CloudError('CF_NOT_CONNECTED', NOT_CONNECTED_MESSAGE);
        if (err.code === 'INVALID_TOKEN' || err.code === 'TOKEN_INACTIVE') return new CloudError('CF_NOT_CONNECTED', TOKEN_INVALID_MESSAGE, err.status);
        return new CloudError('CF_API', err.message, err.status, err.retryAfterMs);
    }
    return new CloudError('CF_API', `Lỗi khi gọi Cloudflare: ${String((err as any)?.message || err).slice(0, 300)}`);
}

function isNotFound(err: unknown): boolean {
    return err instanceof CloudError && (err.status === 404 || err.code === 'NOT_FOUND');
}

function cleanSubdomain(v: unknown): string | null {
    return typeof v === 'string' && RESOURCE_NAME_RE.test(v) ? v : null;
}

export function workersDevUrl(name: string, subdomain: string): string {
    return `https://${name}.${subdomain}.workers.dev`;
}

/** SQL gửi cho một file migration: nội dung file + INSERT tên file vào d1_migrations (cùng một lô). */
export function migrationSql(content: string, fileName: string): string {
    const body = stripBom(content).trimEnd();
    const insert = `INSERT INTO d1_migrations (name) VALUES ('${fileName.replace(/'/g, "''")}');`;
    if (!body) return insert;
    return `${body}${body.endsWith(';') ? '' : ';'}\n${insert}`;
}

function bindingNames(opts: DeployOptions): string[] {
    return [
        ...opts.d1.map(b => b.binding),
        ...(opts.ai ? [opts.ai] : []),
        ...opts.vars.map(v => v.name),
        ...opts.secrets.map(s => s.name),
    ];
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function networkReason(err: any): string {
    const code = err?.cause?.code || err?.code;
    if (typeof code === 'string' && code) return code;
    return String(err?.cause?.message || err?.message || 'lỗi mạng').slice(0, 120);
}

function safeJson(text: string): any {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export class WorkersDeployer {
    private statusCache: { accountId: string; at: number; subdomain: string | null; missing: string[] } | null = null;
    private subdomainCache: { accountId: string; at: number; value: string | null } | null = null;
    private readonly d1Cache = new Map<string, { uuid: string; at: number }>();
    private readonly busy = new Set<string>();
    private unwatch: (() => void) | null = null;

    constructor(private readonly deps: WorkersDeployerDeps) {}

    /** API gắn tiền tố tài nguyên (null = giao diện chủ máy, chỉ kiểm định dạng tên). */
    scoped(prefix: string | null): WorkersScope {
        if (prefix !== null && (typeof prefix !== 'string' || !prefix)) {
            throw new CloudError('CF_NAME_FORBIDDEN', 'Thiếu tiền tố tài nguyên của ứng dụng');
        }
        return {
            prefix,
            status: async displayPrefix => this.status(prefix ?? (typeof displayPrefix === 'string' ? displayPrefix : '')),
            workerGet: async name => this.workerGet(assertResourceName(name, prefix, 'Worker')),
            deployBundle: async (input, bundleDir, onProgress) => this.deployBundle(normalizeDeployOptions(input, prefix), bundleDir, onProgress),
            d1Ensure: async name => this.d1Ensure(assertResourceName(name, prefix, 'D1')),
            d1Migrate: async (name, dir, onProgress) => this.d1Migrate(assertResourceName(name, prefix, 'D1'), dir, onProgress),
            d1Query: async (name, sql, params) => this.d1Query(assertResourceName(name, prefix, 'D1'), normalizeQuery(sql, params)),
        };
    }

    // ── nội bộ chung ──

    private core(): CloudflareCore {
        return this.deps.core();
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private budget(): RequestBudget {
        return this.deps.budget ?? cloudflareBudget;
    }

    private sleep(ms: number): Promise<void> {
        if (this.deps.sleep) return this.deps.sleep(ms);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private log(message: string): void {
        try {
            if (this.deps.log) this.deps.log(message);
            else Logger.log(`[CloudflareWorkers] ${message}`);
        } catch { /* ghi log không được thì thôi */ }
    }

    private progress(onProgress: Progress | undefined, message: string): void {
        this.log(message);
        if (!onProgress) return;
        try { onProgress(message); } catch { /* nơi nhận lỗi: bỏ qua */ }
    }

    /** Đổi / ngắt kết nối Cloudflare → quên quyền, subdomain, uuid D1 đã nhớ. Đăng ký lười ở lần dùng đầu. */
    private watchConnection(): void {
        if (this.unwatch) return;
        try {
            this.unwatch = this.core().onChanged(area => {
                if (area !== 'connection') return;
                this.statusCache = null;
                this.subdomainCache = null;
                this.d1Cache.clear();
            });
        } catch {
            this.unwatch = () => undefined;
        }
    }

    private ctx(): { api: CloudflareApi; accountId: string } {
        this.watchConnection();
        const st = this.core().status();
        if (!st.connected || !st.accountId) throw new CloudError('CF_NOT_CONNECTED', NOT_CONNECTED_MESSAGE);
        try {
            return { api: this.core().api(), accountId: st.accountId };
        } catch (err) {
            throw toWorkersError(err, 'workers');
        }
    }

    /** Một thao tác ghi cho mỗi Worker / D1 tại một thời điểm (bấm hai lần không triển khai chồng nhau). */
    private async exclusive<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(key)) throw new CloudError('CONFLICT', `${label} đang chạy — chờ xong rồi thử lại`);
        this.busy.add(key);
        try {
            return await fn();
        } finally {
            this.busy.delete(key);
        }
    }

    // ── status ──

    private async status(prefix: string): Promise<WorkersStatus> {
        const st = this.core().status();
        const base: WorkersStatus = {
            connected: !!st.connected,
            accountId: st.accountId ?? null,
            accountName: st.accountName ?? null,
            workersSubdomain: null,
            prefix,
            missing: [],
        };
        if (!st.connected || !st.accountId) return base; // không gọi Cloudflare khi chưa kết nối
        const { api, accountId } = this.ctx();
        const cached = this.statusCache;
        if (cached && cached.accountId === accountId && this.now() - cached.at < STATUS_TTL_MS) {
            return { ...base, workersSubdomain: cached.subdomain, missing: [...cached.missing] };
        }
        const [scripts, d1, sub] = await Promise.allSettled([
            api.request('GET', `/accounts/${accountId}/workers/scripts`, undefined, { query: { per_page: 1 } }),
            api.request('GET', `/accounts/${accountId}/d1/database`, undefined, { query: { per_page: 1 } }),
            api.request<any>('GET', `/accounts/${accountId}/workers/subdomain`),
        ]);
        const missing: string[] = [];
        const probes: Array<[PromiseSettledResult<unknown>, 'workers' | 'd1']> = [[scripts, 'workers'], [d1, 'd1']];
        for (const [res, need] of probes) {
            if (res.status === 'fulfilled') continue;
            const mapped = toWorkersError(res.reason, need);
            if (mapped.code !== 'CF_PERMISSION') throw mapped; // mạng / token hỏng: không kết luận được về quyền
            missing.push(WORKERS_PERMISSION_LABELS[need]);
        }
        const subdomain = sub.status === 'fulfilled' ? cleanSubdomain(sub.value?.subdomain) : null;
        if (sub.status === 'fulfilled' || isNotFound(sub.reason)) this.subdomainCache = { accountId, at: this.now(), value: subdomain };
        this.statusCache = { accountId, at: this.now(), subdomain, missing };
        return { ...base, workersSubdomain: subdomain, missing: [...missing] };
    }

    private async accountSubdomain(api: CloudflareApi, accountId: string): Promise<string | null> {
        const c = this.subdomainCache;
        if (c && c.accountId === accountId && this.now() - c.at < SUBDOMAIN_TTL_MS) return c.value;
        let value: string | null = null;
        try {
            const res = await api.request<any>('GET', `/accounts/${accountId}/workers/subdomain`);
            value = cleanSubdomain(res?.subdomain);
        } catch (err) {
            if (!isNotFound(err)) throw toWorkersError(err, 'workers');
        }
        this.subdomainCache = { accountId, at: this.now(), value };
        return value;
    }

    // ── Worker ──

    private async workerGet(name: string): Promise<WorkerInfo> {
        const { api, accountId } = this.ctx();
        let list: any;
        try {
            list = await api.request<any>('GET', `/accounts/${accountId}/workers/scripts`);
        } catch (err) {
            throw toWorkersError(err, 'workers');
        }
        const script = (Array.isArray(list) ? list : []).find((s: any) => s && s.id === name);
        if (!script) return { exists: false, modifiedOn: null, url: null };
        let url: string | null = null;
        try {
            const [sub, route] = await Promise.all([
                this.accountSubdomain(api, accountId),
                api.request<any>('GET', `/accounts/${accountId}/workers/scripts/${name}/subdomain`),
            ]);
            if (sub && route?.enabled) url = workersDevUrl(name, sub);
        } catch { /* không đọc được địa chỉ: vẫn báo Worker đã có */ }
        return { exists: true, modifiedOn: typeof script.modified_on === 'string' ? script.modified_on : null, url };
    }

    private async deployBundle(opts: DeployOptions, bundleDir: string, onProgress?: Progress): Promise<DeployResult> {
        if (typeof bundleDir !== 'string' || !bundleDir) throw new CloudError('CF_BUNDLE_INVALID', 'Thiếu thư mục gói Worker');
        const bundle = readBundle(bundleDir);
        const assetBinding = bundle.assets?.binding ?? null;
        if (assetBinding && bindingNames(opts).includes(assetBinding)) {
            throw new CloudError('VALIDATION_ERROR', `Binding "${assetBinding}" của asset (bundle.json) trùng với binding khác`);
        }
        const { api, accountId } = this.ctx();
        return this.exclusive(`${accountId}:worker:${opts.name}`, `Triển khai Worker "${opts.name}"`, async () => {
            const step = (message: string) => this.progress(onProgress, `${opts.name}: ${message}`);

            // 1. Kiểm trước khi đổi gì trên Cloudflare: địa chỉ workers.dev của tài khoản, D1 cần gắn.
            let subdomain: string | null = null;
            if (opts.workersDev) {
                subdomain = await this.accountSubdomain(api, accountId);
                if (!subdomain) {
                    throw new CloudError('CF_API', 'Tài khoản Cloudflare chưa có địa chỉ workers.dev — mở Cloudflare → Workers & Pages một lần để tạo, rồi triển khai lại');
                }
            }
            const bindings: Array<Record<string, unknown>> = [];
            for (const b of opts.d1) {
                const db = await this.requireD1(api, accountId, b.database);
                bindings.push({ type: 'd1', name: b.binding, id: db.uuid });
            }
            if (opts.ai) bindings.push({ type: 'ai', name: opts.ai });
            for (const v of opts.vars) bindings.push({ type: 'plain_text', name: v.name, text: v.value });
            if (assetBinding) bindings.push({ type: 'assets', name: assetBinding });

            // 2. Asset.
            const assetsJwt = bundle.assets ? await this.uploadAssets(api, accountId, opts.name, bundle.assets.files, step) : null;

            // 3. Script (multipart: metadata + module).
            const metadata: Record<string, unknown> = {
                main_module: bundle.mainModule,
                compatibility_date: bundle.compatibilityDate,
                bindings,
                // Giữ secret đã đặt trước (vd DEPLAO_INTEGRATION_SECRET) khi triển khai lại không kèm secrets.
                keep_bindings: ['secret_text', 'secret_key'],
            };
            if (bundle.compatibilityFlags.length) metadata.compatibility_flags = bundle.compatibilityFlags;
            if (assetsJwt) metadata.assets = bundle.assets?.config ? { jwt: assetsJwt, config: bundle.assets.config } : { jwt: assetsJwt };
            const parts: MultipartPart[] = [{ name: 'metadata', contentType: 'application/json', data: JSON.stringify(metadata) }];
            for (const m of bundle.modules) parts.push({ name: m.name, filename: m.name, contentType: m.contentType, data: fs.readFileSync(m.absPath) });
            const form = buildMultipart(parts);
            step(`tải mã Worker (${fmtBytes(form.body.length)})…`);
            try {
                await api.request('PUT', `/accounts/${accountId}/workers/scripts/${opts.name}`, form.body, { contentType: form.contentType, timeoutMs: SCRIPT_TIMEOUT_MS });
            } catch (err) {
                throw toWorkersError(err, 'workers');
            }

            // 4. Route <tên>.<subdomain>.workers.dev.
            try {
                await api.request('POST', `/accounts/${accountId}/workers/scripts/${opts.name}/subdomain`, { enabled: opts.workersDev, previews_enabled: false });
            } catch (err) {
                throw toWorkersError(err, 'workers');
            }

            // 5. Secrets — giá trị chỉ nằm trong body request, không log.
            for (const s of opts.secrets) {
                try {
                    await api.request('PUT', `/accounts/${accountId}/workers/scripts/${opts.name}/secrets`, { name: s.name, text: s.value, type: 'secret_text' });
                } catch (err) {
                    throw toWorkersError(err, 'workers');
                }
            }
            if (opts.secrets.length) step(`đã đặt ${opts.secrets.length} secret`);

            const url = opts.workersDev && subdomain ? workersDevUrl(opts.name, subdomain) : null;
            this.statusCache = null;
            step(`đã triển khai${url ? ` → ${url}` : ''}`);
            return { name: opts.name, url, deployedAt: this.now() };
        });
    }

    /** Workers static assets (Direct Upload): manifest → bucket theo yêu cầu của Cloudflare → JWT hoàn tất. */
    private async uploadAssets(api: CloudflareApi, accountId: string, scriptName: string, files: BundleAsset[], step: Progress): Promise<string> {
        const manifest: Record<string, { hash: string; size: number }> = {};
        const byHash = new Map<string, BundleAsset>();
        for (const f of files) {
            manifest[f.path] = { hash: f.hash, size: f.size };
            if (!byHash.has(f.hash)) byHash.set(f.hash, f);
        }
        let session: any;
        try {
            session = await api.request<any>('POST', `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, { manifest }, { timeoutMs: 60_000 });
        } catch (err) {
            throw toWorkersError(err, 'workers');
        }
        const jwt = typeof session?.jwt === 'string' ? session.jwt : '';
        if (!jwt) throw new CloudError('CF_API', 'Cloudflare không trả mã phiên tải asset — thử triển khai lại');
        const buckets: string[][] = Array.isArray(session?.buckets)
            ? session.buckets.filter((b: unknown) => Array.isArray(b) && b.length > 0)
            : [];
        const count = buckets.reduce((n, b) => n + b.length, 0);
        // Không có gì cần tải (file đã có từ lần trước) → jwt của phiên chính là mã hoàn tất.
        if (!count) {
            step(`asset không đổi (${files.length} file), bỏ qua bước tải`);
            return jwt;
        }
        step(`tải ${count}/${files.length} file asset (${buckets.length} lượt)…`);
        const remaining = this.budget().remaining();
        if (buckets.length > remaining) {
            step(`cần ${buckets.length} lượt tải, ngân sách Cloudflare chung còn ${remaining} — các lượt sau sẽ chờ tới khi có lượt`);
        }
        let completion = '';
        for (let i = 0; i < buckets.length; i++) {
            const parts: MultipartPart[] = buckets[i].map(hash => {
                const file = byHash.get(String(hash));
                if (!file) throw new CloudError('CF_API', `Cloudflare yêu cầu một file không có trong gói (hash ${String(hash).slice(0, 8)}…) — thử triển khai lại`);
                return { name: file.hash, filename: file.hash, contentType: file.contentType, data: fs.readFileSync(file.absPath).toString('base64') };
            });
            const next = await this.uploadBucket(accountId, jwt, parts);
            if (next) completion = next;
            step(`đã tải lượt ${i + 1}/${buckets.length}`);
        }
        if (!completion) throw new CloudError('CF_API', 'Cloudflare không trả mã hoàn tất sau khi tải asset — thử triển khai lại');
        return completion;
    }

    /**
     * POST /accounts/{a}/workers/assets/upload?base64=true — Bearer là JWT của phiên tải lên (không phải token tài khoản)
     * nên không đi qua CloudflareApi; vẫn lấy lượt từ ngân sách chung. Thử lại khi lỗi mạng / 5xx / 429. Không log JWT.
     */
    private async uploadBucket(accountId: string, jwt: string, parts: MultipartPart[]): Promise<string | null> {
        const form = buildMultipart(parts);
        const url = `${(this.deps.apiBase ?? CF_API_BASE).replace(/\/+$/, '')}/accounts/${accountId}/workers/assets/upload?base64=true`;
        const fetchImpl: FetchLike = this.deps.uploadFetch ?? ((u, init) => (globalThis as any).fetch(u, init));
        const delays = this.deps.retryDelaysMs ?? UPLOAD_RETRY_DELAYS_MS;
        for (let attempt = 0; ; attempt++) {
            await this.budget().acquire();
            const controller = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, UPLOAD_TIMEOUT_MS);
            let status = 0;
            let text = '';
            try {
                const res = await fetchImpl(url, {
                    method: 'POST',
                    headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}`, 'Content-Type': form.contentType },
                    body: form.body,
                    signal: controller.signal,
                });
                status = res.status;
                text = await res.text();
            } catch (err) {
                clearTimeout(timer);
                if (attempt < delays.length) {
                    this.log(`tải asset lỗi mạng (${timedOut ? 'quá giờ' : networkReason(err)}), thử lại sau ${delays[attempt]} ms`);
                    await this.sleep(delays[attempt]);
                    continue;
                }
                throw new CloudError('CF_API', timedOut
                    ? 'Tải asset lên Cloudflare quá lâu — thử triển khai lại'
                    : `Không kết nối được Cloudflare khi tải asset (${networkReason(err)})`);
            }
            clearTimeout(timer);
            const env = safeJson(text);
            if ((status >= 500 || status === 429) && attempt < delays.length) {
                this.log(`tải asset → HTTP ${status}, thử lại sau ${delays[attempt]} ms`);
                await this.sleep(delays[attempt]);
                continue;
            }
            if (status >= 200 && status < 300 && env && env.success !== false) {
                const next = env.result?.jwt;
                return typeof next === 'string' && next ? next : null;
            }
            const first = Array.isArray(env?.errors) ? env.errors[0] : null;
            const detail = first ? `, mã ${first.code}${first.message ? `: ${String(first.message).replace(/\s+/g, ' ').slice(0, 160)}` : ''}` : '';
            throw new CloudError('CF_API', `Cloudflare từ chối tải asset (HTTP ${status}${detail})`, status);
        }
    }

    // ── D1 ──

    private async d1Find(api: CloudflareApi, accountId: string, name: string, fresh = false): Promise<{ uuid: string; name: string } | null> {
        const key = `${accountId}/${name}`;
        const c = this.d1Cache.get(key);
        if (!fresh && c && this.now() - c.at < D1_TTL_MS) return { uuid: c.uuid, name };
        let list: any;
        try {
            list = await api.request<any>('GET', `/accounts/${accountId}/d1/database`, undefined, { query: { name, per_page: 100 } });
        } catch (err) {
            throw toWorkersError(err, 'd1');
        }
        // `name` của Cloudflare là tìm gần đúng → so khớp đúng tên ở đây.
        const hit = (Array.isArray(list) ? list : []).find((d: any) => d && d.name === name && typeof d.uuid === 'string' && d.uuid);
        if (!hit) {
            this.d1Cache.delete(key);
            return null;
        }
        this.d1Cache.set(key, { uuid: hit.uuid, at: this.now() });
        return { uuid: hit.uuid, name };
    }

    private async requireD1(api: CloudflareApi, accountId: string, name: string): Promise<{ uuid: string; name: string }> {
        const db = await this.d1Find(api, accountId, name);
        if (!db) throw new CloudError('NOT_FOUND', `Chưa có cơ sở dữ liệu D1 "${name}" — gọi d1.ensure("${name}") trước`);
        return db;
    }

    private async d1Ensure(name: string): Promise<D1Info> {
        const { api, accountId } = this.ctx();
        const found = await this.d1Find(api, accountId, name, true);
        if (found) return { ...found, created: false };
        try {
            const res = await api.request<any>('POST', `/accounts/${accountId}/d1/database`, { name, primary_location_hint: 'apac' });
            const uuid = typeof res?.uuid === 'string' ? res.uuid : '';
            if (!uuid) throw new CloudError('CF_API', 'Cloudflare không trả mã (uuid) của cơ sở dữ liệu D1 vừa tạo');
            this.d1Cache.set(`${accountId}/${name}`, { uuid, at: this.now() });
            this.log(`Đã tạo D1 ${name} (apac)`);
            return { uuid, name, created: true };
        } catch (err) {
            // Vừa được tạo song song / tên đã có: đọc lại một lần trước khi báo lỗi.
            const again = await this.d1Find(api, accountId, name, true).catch(() => null);
            if (again) return { ...again, created: false };
            throw toWorkersError(err, 'd1');
        }
    }

    /** POST …/d1/database/{uuid}/query — trả mảng kết quả (mỗi câu một phần tử). */
    private async d1Exec(api: CloudflareApi, accountId: string, name: string, uuid: string, sql: string, params: Array<string | number | null> = []): Promise<any[]> {
        const body: Record<string, unknown> = { sql };
        if (params.length) body.params = params;
        let res: any;
        try {
            res = await api.request<any>('POST', `/accounts/${accountId}/d1/database/${uuid}/query`, body, { timeoutMs: QUERY_TIMEOUT_MS });
        } catch (err) {
            if (isNotFound(err)) this.d1Cache.delete(`${accountId}/${name}`);
            throw toWorkersError(err, 'd1');
        }
        const list = Array.isArray(res) ? res : [];
        const failed = list.find((r: any) => r && r.success === false);
        if (failed) throw new CloudError('CF_API', `D1 báo lỗi${failed.error ? `: ${String(failed.error).slice(0, 300)}` : ''}`);
        return list;
    }

    private async d1Query(name: string, q: { sql: string; params: Array<string | number | null> }): Promise<{ results: any[] }> {
        const { api, accountId } = this.ctx();
        const db = await this.requireD1(api, accountId, name);
        const list = await this.d1Exec(api, accountId, name, db.uuid, q.sql, q.params);
        const first = list[0];
        return { results: Array.isArray(first?.results) ? first.results : [] };
    }

    private async d1Migrate(name: string, dir: string, onProgress?: Progress): Promise<MigrateResult> {
        if (typeof dir !== 'string' || !dir) throw new CloudError('CF_BUNDLE_INVALID', 'Thiếu thư mục migration');
        const files = listMigrationFiles(dir);
        const { api, accountId } = this.ctx();
        return this.exclusive(`${accountId}:d1:${name}`, `Migration D1 "${name}"`, async () => {
            const db = await this.requireD1(api, accountId, name);
            await this.d1Exec(api, accountId, name, db.uuid, MIGRATIONS_TABLE_SQL);
            const rows = await this.d1Exec(api, accountId, name, db.uuid, 'SELECT name FROM d1_migrations ORDER BY id');
            const done = new Set<string>((Array.isArray(rows[0]?.results) ? rows[0].results : []).map((r: any) => String(r?.name ?? '')));
            const applied: string[] = [];
            const skipped: string[] = [];
            for (const file of files) {
                if (done.has(file.name)) {
                    skipped.push(file.name);
                    continue;
                }
                const sql = migrationSql(fs.readFileSync(file.absPath, 'utf8'), file.name);
                try {
                    await this.d1Exec(api, accountId, name, db.uuid, sql);
                } catch (err) {
                    const e = toWorkersError(err, 'd1');
                    const before = applied.length ? ` Đã áp trước đó: ${applied.join(', ')}.` : '';
                    throw new CloudError(e.code, `Migration "${file.name}" lỗi — dừng, các file sau chưa áp.${before} ${e.message}`, e.status, e.retryAfterMs);
                }
                applied.push(file.name);
                this.progress(onProgress, `D1 ${name}: đã áp ${file.name}`);
            }
            return { applied, skipped };
        });
    }
}

/** Dùng chung ở main (handler IPC cloudflare:workers:*). Lõi Cloudflare nạp lười để module nạp được trong test. */
export const workersDeployer = new WorkersDeployer({
    core: () => (require('../CloudflareService') as typeof import('../CloudflareService')).cloudflare,
});
