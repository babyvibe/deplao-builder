/**
 * WorkersDeployer: Worker + D1 on the connected Cloudflare account, for apps (plugins) with the cloudflare:workers permission
 * (fintrack-deplao-app/docs/CONTRACTS.md §1). Runs in main; the Cloudflare token only lives in CloudflareApi
 * (cloudflare.api()) and never goes out to an app.
 *
 * Only used through scoped(prefix): EVERY Worker / D1 name (including D1 in bindings) must be the prefix or "<prefix>-…"
 * (prefix null = the machine owner's UI: only the name format is checked).
 *  - status: does not call Cloudflare when not connected; checks permissions with 2 cheap GETs (Workers Scripts, D1) + reads the workers.dev subdomain;
 *    cached for 60 s because the budget of 100 requests / 5 minutes (CloudflareApi) is shared by the WHOLE app.
 *  - d1.ensure: finds by name, creates it if missing (location hint 'apac').
 *  - d1.migrate: like `wrangler d1 migrations apply`: table d1_migrations(id, name, applied_at), *.sql files sorted by name,
 *    applied files skipped; one /query call per file, the INSERT of the file name at the end of that batch (D1 runs the statements of one call as
 *    a batch in a transaction → a file that fails is not recorded as applied). Error → stop; the error message names the file.
 *  - d1.query: one SQL statement (read check).
 *  - workers.get / workers.deployBundle: prebuilt bundle (bundle.ts) → [asset: upload-session → each bucket with the JWT of the
 *    upload session (separate fetch, NOT the account token)] → PUT script multipart → enable / disable workers.dev → secrets
 *    → Cron Triggers (PUT …/schedules, only when bundle.json declares `crons`; the result then carries the active `crons`,
 *    or `cronsError` when Cloudflare refused them: not fatal, the Worker is live and the app falls back to plugin jobs).
 *    Every request (including asset uploads) goes through the shared budget; progress is only logged.
 *  - zones / domain*: custom domains (Workers Custom Domain) for the app's Worker. Only attaches a NEW SUBDOMAIN of a domain
 *    in the account: never the root domain, never overwrites existing DNS records (Deplao's Internet address, website, mail…),
 *    never takes a name already attached to another Worker; detach only touches the name attached to that same Worker. Cloudflare creates the DNS record +
 *    certificate itself. When an app calls it → the IPC handler passes `confirm` (Deplao's dialog), which runs AFTER the checks and BEFORE the write.
 *  - Errors: CloudError with contract codes CF_NOT_CONNECTED | CF_PERMISSION | CF_NAME_FORBIDDEN | CF_BUNDLE_INVALID | CF_API
 *    (+ VALIDATION_ERROR, NOT_FOUND, CONFLICT). Never logs the token, JWT, secret or SQL statement.
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
    assertResourceName, DOMAIN_PERMISSION_LABELS, normalizeDeployOptions, normalizeDomainHostname, normalizeQuery,
    RESOURCE_NAME_RE, WORKERS_PERMISSION_LABELS,
} from './validate';
import type { DeployOptions } from './validate';
import { listRecordsByName } from '../tunnel/dns';
import { normalizeHostname } from '../tunnel/ingress';
import { tr } from '../../../shared/i18n';

export interface WorkersStatus {
    connected: boolean;
    accountId: string | null;
    accountName: string | null;
    /** The account's <subdomain>.workers.dev; null if not yet set up / not readable. */
    workersSubdomain: string | null;
    /** Resource name prefix of the app. */
    prefix: string;
    /** Token permissions still missing, e.g. ["Account · D1 · Edit"]; empty = all present. */
    missing: string[];
}

export interface WorkerInfo { exists: boolean; modifiedOn: string | null; url: string | null }
export interface DeployResult {
    name: string;
    url: string | null;
    deployedAt: number;
    /**
     * The Worker's active Cron Triggers after the deploy. Present only when bundle.json declares `crons`; an app that finds no
     * `crons` (field not declared, or an older Deplao that ignores it) must run its periodic jobs from the plugin instead.
     */
    crons?: string[];
    /**
     * Why the declared Cron Triggers could not be set (e.g. the account already uses all its triggers). The Worker is
     * deployed anyway and `crons` is absent, so the app falls back to plugin-driven jobs; show this to the user.
     */
    cronsError?: string;
}
export interface D1Info { uuid: string; name: string; created: boolean }
export interface MigrateResult { applied: string[]; skipped: string[] }
export type Progress = (message: string) => void;
/** Active domains (zones) of the account. */
export interface DomainZone { id: string; name: string }
/** Custom domain attached to a Worker (Workers Custom Domain). */
export interface WorkerDomain { id: string; hostname: string; zoneId: string; zoneName: string }
/** created = just attached; false = the name was already attached to this same Worker (calling again changes nothing). */
export interface DomainAttachResult extends WorkerDomain { created: boolean }
/** Ask the user before attaching (called by the app); false → CF_DECLINED, nothing is written. */
export type DomainConfirm = (info: { worker: string; hostname: string; zoneName: string }) => Promise<boolean>;

/** API with the prefix already applied: the IPC handler creates one scope per call. */
export interface WorkersScope {
    readonly prefix: string | null;
    /** displayPrefix: the prefix shown in results when the scope has no prefix (the machine owner's UI). */
    status(displayPrefix?: string): Promise<WorkersStatus>;
    workerGet(name: unknown): Promise<WorkerInfo>;
    /** bundleDir: absolute path already location-checked by the caller (apps: must be inside the app folder). */
    deployBundle(input: unknown, bundleDir: string, onProgress?: Progress): Promise<DeployResult>;
    d1Ensure(name: unknown): Promise<D1Info>;
    /** dir: absolute folder containing *.sql files; the caller has already checked its location. */
    d1Migrate(name: unknown, dir: string, onProgress?: Progress): Promise<MigrateResult>;
    d1Query(name: unknown, sql: unknown, params?: unknown): Promise<{ results: any[] }>;
    /** Active domains of the account (cached 5 minutes). */
    zones(): Promise<DomainZone[]>;
    /** Custom domain attached to Worker `name`. */
    domainList(name: unknown): Promise<WorkerDomain[]>;
    domainAttach(name: unknown, hostname: unknown, confirm?: DomainConfirm): Promise<DomainAttachResult>;
    /** removed=false: the name is not attached to this Worker (another Worker's name is not touched). */
    domainDetach(name: unknown, hostname: unknown): Promise<{ removed: boolean }>;
}

export interface WorkersDeployerDeps {
    core: () => CloudflareCore;
    /** fetch for the asset upload step (Bearer = upload-session JWT). Defaults to globalThis.fetch. */
    uploadFetch?: FetchLike;
    /** Shared request budget (default: the cloudflareBudget of the whole app). */
    budget?: RequestBudget;
    apiBase?: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Wait between retries when an asset upload fails with a network error / 5xx / 429. */
    retryDelaysMs?: ReadonlyArray<number>;
    log?: (message: string) => void;
}

const STATUS_TTL_MS = 60_000;
const SUBDOMAIN_TTL_MS = 10 * 60_000;
const D1_TTL_MS = 10 * 60_000;
const ZONES_TTL_MS = 5 * 60_000;
/** Domain list of a Worker: the app's Options page reads it on every status check. */
const DOMAINS_TTL_MS = 60_000;
const DOMAIN_WRITE_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const SCRIPT_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 60_000;
const UPLOAD_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 3000];

/** Migration log table identical to wrangler's (default table name d1_migrations). */
export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

const NOT_CONNECTED_MESSAGE = tr('Chưa kết nối Cloudflare — kết nối ở Cài đặt → Internet & Cloud trên máy chủ');
const TOKEN_INVALID_MESSAGE = tr('Token Cloudflare không còn hợp lệ — kết nối lại ở Cài đặt → Internet & Cloud');
const OWN_CODES = new Set(['CF_NOT_CONNECTED', 'CF_PERMISSION', 'CF_NAME_FORBIDDEN', 'CF_BUNDLE_INVALID', 'CF_API', 'CF_DECLINED', 'VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT']);

/** Token permissions needed for a group of operations (Worker, D1, listing domains, reading DNS). */
export type WorkersNeed = 'workers' | 'd1' | 'zone' | 'dns';
const NEED_LABELS: Record<WorkersNeed, string> = { ...WORKERS_PERMISSION_LABELS, ...DOMAIN_PERMISSION_LABELS };

export function permissionError(need: WorkersNeed, status?: number): CloudError {
    const label = NEED_LABELS[need];
    return new CloudError(
        'CF_PERMISSION',
        tr('Token Cloudflare thiếu quyền "{{label}}" — thêm quyền này cho token (hoặc tạo token mới bằng link mẫu ở Cài đặt → Internet & Cloud) rồi bấm Kiểm tra lại token', { label }),
        status,
    );
}

/** Any error → CloudError with a contract code (need: the permission to name when Cloudflare reports a missing permission). */
export function toWorkersError(err: unknown, need: WorkersNeed): CloudError {
    if (err instanceof CloudApiError) {
        // The Cloudflare error code takes precedence over the HTTP status: a missing permission for one API (code 10000 "Authentication error") makes many endpoints
        // return HTTP 401, e.g. listing D1 when the token has no D1 permission: that is a missing permission, not a broken token / not connected.
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
    return new CloudError('CF_API', tr('Lỗi khi gọi Cloudflare: {{v1}}', { v1: String((err as any)?.message || err).slice(0, 300) }));
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

/** The longest domain in the account that contains `hostname` (the root domain or one of its subdomains). */
export function zoneOf(hostname: string, zones: DomainZone[]): DomainZone | null {
    let best: DomainZone | null = null;
    for (const z of zones) {
        if (hostname !== z.name && !hostname.endsWith(`.${z.name}`)) continue;
        if (!best || z.name.length > best.name.length) best = z;
    }
    return best;
}

/** Cloudflare Workers Custom Domain record → WorkerDomain (missing id / hostname → null). */
function toDomain(raw: any): (WorkerDomain & { service: string }) | null {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    const hostname = normalizeHostname(raw?.hostname);
    if (!id || !hostname) return null;
    return {
        id,
        hostname,
        zoneId: typeof raw?.zone_id === 'string' ? raw.zone_id : '',
        zoneName: normalizeHostname(raw?.zone_name),
        service: typeof raw?.service === 'string' ? raw.service : '',
    };
}

const publicDomain = (d: WorkerDomain): WorkerDomain => ({ id: d.id, hostname: d.hostname, zoneId: d.zoneId, zoneName: d.zoneName });

/** SQL sent for one migration file: the file content + INSERT of the file name into d1_migrations (same batch). */
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
    return String(err?.cause?.message || err?.message || tr('lỗi mạng')).slice(0, 120);
}

function safeJson(text: string): any {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

export class WorkersDeployer {
    private statusCache: { accountId: string; at: number; subdomain: string | null; missing: string[] } | null = null;
    private subdomainCache: { accountId: string; at: number; value: string | null } | null = null;
    private readonly d1Cache = new Map<string, { uuid: string; at: number }>();
    private zonesCache: { accountId: string; at: number; zones: DomainZone[] } | null = null;
    /** `${accountId}/${worker}` → the domain currently attached. */
    private readonly domainsCache = new Map<string, { at: number; domains: WorkerDomain[] }>();
    private readonly busy = new Set<string>();
    private unwatch: (() => void) | null = null;

    constructor(private readonly deps: WorkersDeployerDeps) {}

    /** API that applies the resource prefix (null = the machine owner's UI, only the name format is checked). */
    scoped(prefix: string | null): WorkersScope {
        if (prefix !== null && (typeof prefix !== 'string' || !prefix)) {
            throw new CloudError('CF_NAME_FORBIDDEN', tr('Thiếu tiền tố tài nguyên của ứng dụng'));
        }
        return {
            prefix,
            status: async displayPrefix => this.status(prefix ?? (typeof displayPrefix === 'string' ? displayPrefix : '')),
            workerGet: async name => this.workerGet(assertResourceName(name, prefix, 'Worker')),
            deployBundle: async (input, bundleDir, onProgress) => this.deployBundle(normalizeDeployOptions(input, prefix), bundleDir, onProgress),
            d1Ensure: async name => this.d1Ensure(assertResourceName(name, prefix, 'D1')),
            d1Migrate: async (name, dir, onProgress) => this.d1Migrate(assertResourceName(name, prefix, 'D1'), dir, onProgress),
            d1Query: async (name, sql, params) => this.d1Query(assertResourceName(name, prefix, 'D1'), normalizeQuery(sql, params)),
            zones: async () => (await this.zoneList()).map(z => ({ ...z })),
            domainList: async name => this.domainList(assertResourceName(name, prefix, 'Worker')),
            domainAttach: async (name, hostname, confirm) =>
                this.domainAttach(assertResourceName(name, prefix, 'Worker'), normalizeDomainHostname(hostname), confirm),
            domainDetach: async (name, hostname) =>
                this.domainDetach(assertResourceName(name, prefix, 'Worker'), normalizeDomainHostname(hostname)),
        };
    }

    // ── shared internals ──

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
        } catch { /* if logging fails, just move on */ }
    }

    private progress(onProgress: Progress | undefined, message: string): void {
        this.log(message);
        if (!onProgress) return;
        try { onProgress(message); } catch { /* error sink: ignore */ }
    }

    /** Change / disconnect Cloudflare → forget the permissions, subdomain and D1 uuids that were cached. Lazy registration on first use. */
    private watchConnection(): void {
        if (this.unwatch) return;
        try {
            this.unwatch = this.core().onChanged(area => {
                if (area !== 'connection') return;
                this.statusCache = null;
                this.subdomainCache = null;
                this.d1Cache.clear();
                this.zonesCache = null;
                this.domainsCache.clear();
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

    /** One write operation per Worker / D1 at a time (two clicks do not deploy on top of each other). */
    private async exclusive<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(key)) throw new CloudError('CONFLICT', tr('{{label}} đang chạy — chờ xong rồi thử lại', { label }));
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
        if (!st.connected || !st.accountId) return base; // do not call Cloudflare when not connected
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
            if (mapped.code !== 'CF_PERMISSION') throw mapped; // network / broken token: cannot conclude anything about permissions
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
        } catch { /* cannot read the address: still report that the Worker exists */ }
        return { exists: true, modifiedOn: typeof script.modified_on === 'string' ? script.modified_on : null, url };
    }

    private async deployBundle(opts: DeployOptions, bundleDir: string, onProgress?: Progress): Promise<DeployResult> {
        if (typeof bundleDir !== 'string' || !bundleDir) throw new CloudError('CF_BUNDLE_INVALID', tr('Thiếu thư mục gói Worker'));
        const bundle = readBundle(bundleDir);
        const assetBinding = bundle.assets?.binding ?? null;
        if (assetBinding && bindingNames(opts).includes(assetBinding)) {
            throw new CloudError('VALIDATION_ERROR', tr('Binding "{{assetBinding}}" của asset (bundle.json) trùng với binding khác', { assetBinding }));
        }
        const { api, accountId } = this.ctx();
        return this.exclusive(`${accountId}:worker:${opts.name}`, tr('Triển khai Worker "{{name}}"', { name: opts.name }), async () => {
            const step = (message: string) => this.progress(onProgress, `${opts.name}: ${message}`);

            // 1. Check before changing anything on Cloudflare: the account's workers.dev address, the D1 that needs binding.
            let subdomain: string | null = null;
            if (opts.workersDev) {
                subdomain = await this.accountSubdomain(api, accountId);
                if (!subdomain) {
                    throw new CloudError('CF_API', tr('Tài khoản Cloudflare chưa có địa chỉ workers.dev — mở Cloudflare → Workers & Pages một lần để tạo, rồi triển khai lại'));
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
                // Keep secrets set earlier (e.g. DEPLAO_INTEGRATION_SECRET) when redeploying without secrets.
                keep_bindings: ['secret_text', 'secret_key'],
            };
            if (bundle.compatibilityFlags.length) metadata.compatibility_flags = bundle.compatibilityFlags;
            if (assetsJwt) metadata.assets = bundle.assets?.config ? { jwt: assetsJwt, config: bundle.assets.config } : { jwt: assetsJwt };
            const parts: MultipartPart[] = [{ name: 'metadata', contentType: 'application/json', data: JSON.stringify(metadata) }];
            for (const m of bundle.modules) parts.push({ name: m.name, filename: m.name, contentType: m.contentType, data: fs.readFileSync(m.absPath) });
            const form = buildMultipart(parts);
            step(tr('tải mã Worker ({{v1}})…', { v1: fmtBytes(form.body.length) }));
            try {
                await api.request('PUT', `/accounts/${accountId}/workers/scripts/${opts.name}`, form.body, { contentType: form.contentType, timeoutMs: SCRIPT_TIMEOUT_MS });
            } catch (err) {
                throw toWorkersError(err, 'workers');
            }

            // 4. Route <name>.<subdomain>.workers.dev.
            try {
                await api.request('POST', `/accounts/${accountId}/workers/scripts/${opts.name}/subdomain`, { enabled: opts.workersDev, previews_enabled: false });
            } catch (err) {
                throw toWorkersError(err, 'workers');
            }

            // 5. Secrets: the values are only in the request body, never logged.
            for (const s of opts.secrets) {
                try {
                    await api.request('PUT', `/accounts/${accountId}/workers/scripts/${opts.name}/secrets`, { name: s.name, text: s.value, type: 'secret_text' });
                } catch (err) {
                    throw toWorkersError(err, 'workers');
                }
            }
            if (opts.secrets.length) step(tr('đã đặt {{count}} secret', { count: opts.secrets.length }));

            // 6. Cron Triggers: only when bundle.json declares crons. The PUT replaces the whole list ([] turns every schedule off).
            //    Not fatal: the Worker is already live, and an app that gets no `crons` back runs its jobs from the plugin.
            //    Typical failure: the account's trigger limit (Cloudflare Free: 5 for the WHOLE account).
            let crons: string[] | null = null;
            let cronsError: string | null = null;
            if (bundle.crons) {
                try {
                    const res = await api.request<any>('PUT', `/accounts/${accountId}/workers/scripts/${opts.name}/schedules`, bundle.crons.map(cron => ({ cron })));
                    const active = Array.isArray(res?.schedules)
                        ? res.schedules.map((s: any) => s?.cron).filter((c: unknown): c is string => typeof c === 'string')
                        : null;
                    crons = active ?? [...bundle.crons];
                    step(crons.length ? tr('đã đặt lịch chạy {{v1}}', { v1: crons.join(', ') }) : tr('đã tắt lịch chạy'));
                } catch (err) {
                    cronsError = toWorkersError(err, 'workers').message;
                    step(tr('chưa đặt được lịch chạy ({{v1}}), ứng dụng sẽ tự chạy việc định kỳ khi Deplao mở', { v1: cronsError }));
                }
            }

            const url = opts.workersDev && subdomain ? workersDevUrl(opts.name, subdomain) : null;
            this.statusCache = null;
            step(tr('đã triển khai{{v1}}', { v1: url ? ` → ${url}` : '' }));
            const result: DeployResult = { name: opts.name, url, deployedAt: this.now() };
            if (crons) result.crons = crons;
            if (cronsError) result.cronsError = cronsError;
            return result;
        });
    }

    /** Workers static assets (Direct Upload): manifest → buckets as requested by Cloudflare → completion JWT. */
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
        if (!jwt) throw new CloudError('CF_API', tr('Cloudflare không trả mã phiên tải asset — thử triển khai lại'));
        const buckets: string[][] = Array.isArray(session?.buckets)
            ? session.buckets.filter((b: unknown) => Array.isArray(b) && b.length > 0)
            : [];
        const count = buckets.reduce((n, b) => n + b.length, 0);
        // Nothing to upload (files already there from last time) → the session's jwt is the completion token.
        if (!count) {
            step(tr('asset không đổi ({{count}} file), bỏ qua bước tải', { count: files.length }));
            return jwt;
        }
        step(tr('tải {{count}}/{{count1}} file asset ({{count2}} lượt)…', { count, count1: files.length, count2: buckets.length }));
        const remaining = this.budget().remaining();
        if (buckets.length > remaining) {
            step(tr('cần {{count}} lượt tải, ngân sách Cloudflare chung còn {{remaining}} — các lượt sau sẽ chờ tới khi có lượt', { count: buckets.length, remaining }));
        }
        let completion = '';
        for (let i = 0; i < buckets.length; i++) {
            const parts: MultipartPart[] = buckets[i].map(hash => {
                const file = byHash.get(String(hash));
                if (!file) throw new CloudError('CF_API', tr('Cloudflare yêu cầu một file không có trong gói (hash {{v1}}…) — thử triển khai lại', { v1: String(hash).slice(0, 8) }));
                return { name: file.hash, filename: file.hash, contentType: file.contentType, data: fs.readFileSync(file.absPath).toString('base64') };
            });
            const next = await this.uploadBucket(accountId, jwt, parts);
            if (next) completion = next;
            step(tr('đã tải lượt {{v1}}/{{count}}', { v1: i + 1, count: buckets.length }));
        }
        if (!completion) throw new CloudError('CF_API', tr('Cloudflare không trả mã hoàn tất sau khi tải asset — thử triển khai lại'));
        return completion;
    }

    /**
     * POST /accounts/{a}/workers/assets/upload?base64=true: the Bearer is the upload session's JWT (not the account token),
     * so it does not go through CloudflareApi; it still takes calls from the shared budget. Retries on network error / 5xx / 429. Never logs the JWT.
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
                    ? tr('Tải asset lên Cloudflare quá lâu — thử triển khai lại')
                    : tr('Không kết nối được Cloudflare khi tải asset ({{v1}})', { v1: networkReason(err) }));
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
            const detail = first ? tr(', mã {{code}}{{v1}}', { code: first.code, v1: first.message ? `: ${String(first.message).replace(/\s+/g, ' ').slice(0, 160)}` : '' }) : '';
            throw new CloudError('CF_API', tr('Cloudflare từ chối tải asset (HTTP {{status}}{{detail}})', { status, detail }), status);
        }
    }

    // ── Custom domains (Workers Custom Domain) ──

    private async zoneList(fresh = false): Promise<DomainZone[]> {
        const { accountId } = this.ctx();
        const c = this.zonesCache;
        if (!fresh && c && c.accountId === accountId && this.now() - c.at < ZONES_TTL_MS) return c.zones;
        let raw: Array<{ id?: unknown; name?: unknown; status?: unknown }>;
        try {
            raw = await this.core().listZones();
        } catch (err) {
            throw toWorkersError(err, 'zone');
        }
        const zones = (Array.isArray(raw) ? raw : [])
            .filter(z => z && typeof z.id === 'string' && z.id && typeof z.name === 'string' && z.name && (!z.status || z.status === 'active'))
            .map(z => ({ id: String(z.id), name: normalizeHostname(z.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
        this.zonesCache = { accountId, at: this.now(), zones };
        return zones;
    }

    /** GET …/workers/domains by Worker or by name; Cloudflare's filter may be fuzzy → exact match is done here. */
    private async domainsWhere(api: CloudflareApi, accountId: string, query: { service?: string; hostname?: string }): Promise<Array<WorkerDomain & { service: string }>> {
        let list: any;
        try {
            list = await api.request<any>('GET', `/accounts/${accountId}/workers/domains`, undefined, { query });
        } catch (err) {
            throw toWorkersError(err, 'workers');
        }
        return (Array.isArray(list) ? list : [])
            .map(toDomain)
            .filter((d): d is WorkerDomain & { service: string } => !!d)
            .filter(d => (!query.service || d.service === query.service) && (!query.hostname || d.hostname === query.hostname));
    }

    private async domainList(name: string): Promise<WorkerDomain[]> {
        const { api, accountId } = this.ctx();
        const key = `${accountId}/${name}`;
        const c = this.domainsCache.get(key);
        if (c && this.now() - c.at < DOMAINS_TTL_MS) return c.domains.map(publicDomain);
        const domains = (await this.domainsWhere(api, accountId, { service: name }))
            .map(publicDomain)
            .sort((a, b) => a.hostname.localeCompare(b.hostname));
        this.domainsCache.set(key, { at: this.now(), domains });
        return domains.map(publicDomain);
    }

    private async domainAttach(name: string, hostname: string, confirm?: DomainConfirm): Promise<DomainAttachResult> {
        const { api, accountId } = this.ctx();
        return this.exclusive(`${accountId}:domain:${hostname}`, tr('Gắn tên miền {{hostname}}', { hostname }), async () => {
            // 1. A subdomain of a domain in the account (the list is cached for 5 minutes; if not found, re-read once).
            let zones = await this.zoneList();
            let zone = zoneOf(hostname, zones);
            if (!zone) {
                zones = await this.zoneList(true);
                zone = zoneOf(hostname, zones);
            }
            if (!zone) {
                const known = zones.map(z => z.name).slice(0, 5).join(', ');
                throw new CloudError('VALIDATION_ERROR', tr('{{hostname}} không thuộc tên miền nào của tài khoản Cloudflare đã kết nối{{v1}}', { hostname, v1: known ? tr(' (đang có: {{known}})', { known }) : '' }));
            }
            if (zone.name === hostname) {
                throw new CloudError('VALIDATION_ERROR', tr('Chỉ gắn được tên con, vd {{name}}.{{name1}}; tên miền gốc {{name1}} thường đang dùng cho việc khác', { name, name1: zone.name }));
            }
            // 2. Already attached to this same Worker → return it, no prompt, no write. Attached to another Worker → do not take it.
            const existing = await this.domainsWhere(api, accountId, { hostname });
            const mine = existing.find(d => d.service === name);
            if (mine) return { ...publicDomain(mine), created: false };
            if (existing.length) throw new CloudError('CONFLICT', tr('{{hostname}} đang được dùng cho một Worker khác, hãy chọn tên khác', { hostname }));
            // 3. Do not overwrite existing DNS records (Deplao's Internet address, website, mail…).
            let records: Array<{ type?: string }>;
            try {
                records = await listRecordsByName(api, zone.id, hostname);
            } catch (err) {
                throw toWorkersError(err, 'dns');
            }
            if (records.length) {
                const types = Array.from(new Set(records.map(r => String(r?.type || '?').toUpperCase()))).join(', ');
                throw new CloudError('CONFLICT', tr('{{hostname}} đã có bản ghi DNS ({{types}}), hãy chọn tên khác hoặc xoá bản ghi đó trên Cloudflare trước', { hostname, types }));
            }
            // 4. The user agrees (called by the app: Deplao's dialog), after the checks and before the write.
            if (confirm && !(await confirm({ worker: name, hostname, zoneName: zone.name }))) {
                throw new CloudError('CF_DECLINED', tr('Chưa gắn {{hostname}}: bạn đã chọn "Không" ở hộp thoại của Deplao', { hostname }));
            }
            // 5. Attach: Cloudflare creates the DNS record + certificate (the new name answers a few minutes later).
            let res: any;
            try {
                res = await api.request<any>('PUT', `/accounts/${accountId}/workers/domains`, { hostname, service: name, zone_id: zone.id }, { timeoutMs: DOMAIN_WRITE_TIMEOUT_MS });
            } catch (err) {
                throw toWorkersError(err, 'workers');
            }
            this.domainsCache.delete(`${accountId}/${name}`);
            const saved = toDomain(res);
            this.log(`Đã gắn ${hostname} cho Worker ${name}`);
            return { id: saved?.id || '', hostname, zoneId: saved?.zoneId || zone.id, zoneName: saved?.zoneName || zone.name, created: true };
        });
    }

    private async domainDetach(name: string, hostname: string): Promise<{ removed: boolean }> {
        const { api, accountId } = this.ctx();
        return this.exclusive(`${accountId}:domain:${hostname}`, tr('Gỡ tên miền {{hostname}}', { hostname }), async () => {
            const mine = (await this.domainsWhere(api, accountId, { hostname })).find(d => d.service === name);
            if (!mine) return { removed: false };
            try {
                await api.request('DELETE', `/accounts/${accountId}/workers/domains/${encodeURIComponent(mine.id)}`, undefined, { timeoutMs: DOMAIN_WRITE_TIMEOUT_MS });
            } catch (err) {
                if (!isNotFound(err)) throw toWorkersError(err, 'workers');
            }
            this.domainsCache.delete(`${accountId}/${name}`);
            this.log(`Đã gỡ ${hostname} khỏi Worker ${name}`);
            return { removed: true };
        });
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
        // Cloudflare's `name` filter is fuzzy → the exact name is matched here.
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
        if (!db) throw new CloudError('NOT_FOUND', tr('Chưa có cơ sở dữ liệu D1 "{{name}}" — gọi d1.ensure("{{name}}") trước', { name }));
        return db;
    }

    private async d1Ensure(name: string): Promise<D1Info> {
        const { api, accountId } = this.ctx();
        const found = await this.d1Find(api, accountId, name, true);
        if (found) return { ...found, created: false };
        try {
            const res = await api.request<any>('POST', `/accounts/${accountId}/d1/database`, { name, primary_location_hint: 'apac' });
            const uuid = typeof res?.uuid === 'string' ? res.uuid : '';
            if (!uuid) throw new CloudError('CF_API', tr('Cloudflare không trả mã (uuid) của cơ sở dữ liệu D1 vừa tạo'));
            this.d1Cache.set(`${accountId}/${name}`, { uuid, at: this.now() });
            this.log(`Đã tạo D1 ${name} (apac)`);
            return { uuid, name, created: true };
        } catch (err) {
            // Just created in parallel / name already exists: re-read once before reporting an error.
            const again = await this.d1Find(api, accountId, name, true).catch(() => null);
            if (again) return { ...again, created: false };
            throw toWorkersError(err, 'd1');
        }
    }

    /** POST …/d1/database/{uuid}/query: returns an array of results (one element per statement). */
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
        if (failed) throw new CloudError('CF_API', tr('D1 báo lỗi{{v1}}', { v1: failed.error ? `: ${String(failed.error).slice(0, 300)}` : '' }));
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
        if (typeof dir !== 'string' || !dir) throw new CloudError('CF_BUNDLE_INVALID', tr('Thiếu thư mục migration'));
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
                    const before = applied.length ? tr(' Đã áp trước đó: {{v1}}.', { v1: applied.join(', ') }) : '';
                    throw new CloudError(e.code, tr('Migration "{{name}}" lỗi — dừng, các file sau chưa áp.{{before}} {{message}}', { name: file.name, before, message: e.message }), e.status, e.retryAfterMs);
                }
                applied.push(file.name);
                this.progress(onProgress, tr('D1 {{name}}: đã áp {{name1}}', { name, name1: file.name }));
            }
            return { applied, skipped };
        });
    }
}

/** Shared in main (IPC handlers cloudflare:workers:*). The Cloudflare core is loaded lazily so the module can load in tests. */
export const workersDeployer = new WorkersDeployer({
    core: () => (require('../CloudflareService') as typeof import('../CloudflareService')).cloudflare,
});
