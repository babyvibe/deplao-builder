/**
 * bundle.ts — đọc + kiểm tra gói Worker dựng sẵn nằm trong thư mục ứng dụng (CONTRACTS.md §1.3), và thư mục migration D1.
 *
 *   <bundleDir>/bundle.json       { mainModule, modules: [{ name, type }], compatibilityDate, compatibilityFlags?,
 *                                    assets?: { dir, binding?, config? }, migrations?, …trường khác bỏ qua }
 *   <bundleDir>/worker/<name>     mã Worker (esm | cjs | text | data | wasm | sourcemap)
 *   <bundleDir>/<assets.dir>/**   file tĩnh (Workers static assets)
 *
 * Giới hạn: cả gói ≤ 50 MB, ≤ 5000 file asset, mỗi asset ≤ 25 MiB; chỉ đường dẫn tương đối an toàn, không symlink, mọi
 * file phải nằm trong gói (kiểm realpath). Hash asset như wrangler / tài liệu Direct Upload của Cloudflare
 * (developers.cloudflare.com/workers/static-assets/direct-upload): sha256(base64(nội dung) + đuôi file không dấu chấm),
 * lấy 32 ký tự hex đầu.
 * Lỗi: CloudError('CF_BUNDLE_INVALID', câu tiếng Việt nêu đúng trường / file). Không phụ thuộc Electron.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CloudError } from '../contracts';
import { BINDING_NAME_RE } from './validate';

export const BUNDLE_FILE = 'bundle.json';
export const BUNDLE_WORKER_DIR = 'worker';

export interface BundleLimits {
    maxTotalBytes: number;
    maxAssetFiles: number;
    maxAssetBytes: number;
    maxModules: number;
    maxBundleJsonBytes: number;
}

export const BUNDLE_LIMITS: BundleLimits = {
    maxTotalBytes: 50 * 1024 * 1024,
    maxAssetFiles: 5000,
    maxAssetBytes: 25 * 1024 * 1024,
    maxModules: 100,
    maxBundleJsonBytes: 256 * 1024,
};

export const MIGRATION_LIMITS = { maxFiles: 1000, maxFileBytes: 1024 * 1024 };

export type BundleModuleType = 'esm' | 'cjs' | 'text' | 'data' | 'wasm' | 'sourcemap';

/** Content-Type từng loại module khi tải script lên (multipart) — các loại Cloudflare chấp nhận. */
export const MODULE_CONTENT_TYPES: Readonly<Record<BundleModuleType, string>> = {
    esm: 'application/javascript+module',
    cjs: 'application/javascript',
    text: 'text/plain',
    data: 'application/octet-stream',
    wasm: 'application/wasm',
    sourcemap: 'application/source-map',
};

/** Khoá assets.config được chuyển nguyên cho Cloudflare (metadata.assets.config của Script Upload API). */
export const ASSET_CONFIG_KEYS = ['html_handling', 'not_found_handling', 'run_worker_first', '_headers', '_redirects'] as const;
const HTML_HANDLING = ['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'];
const NOT_FOUND_HANDLING = ['none', '404-page', 'single-page-application'];

/** File do hệ điều hành / công cụ tự sinh — không đưa lên. */
const IGNORED_ASSET_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.assetsignore']);

const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPAT_FLAG_RE = /^[a-z0-9_]{1,64}$/;
const MIGRATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface BundleSpec {
    mainModule: string;
    modules: Array<{ name: string; type: BundleModuleType }>;
    compatibilityDate: string;
    compatibilityFlags: string[];
    assets: { dir: string; binding: string | null; config: Record<string, unknown> | null } | null;
    migrations: string | null;
}

export interface BundleModule {
    name: string;
    type: BundleModuleType;
    contentType: string;
    absPath: string;
    size: number;
}

export interface BundleAsset {
    /** Khoá trong manifest: "/index.html", "/assets/app-1a2b.js". */
    path: string;
    absPath: string;
    size: number;
    hash: string;
    contentType: string;
}

export interface WorkerBundle {
    dir: string;
    mainModule: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
    modules: BundleModule[];
    assets: { dir: string; binding: string | null; config: Record<string, unknown> | null; files: BundleAsset[] } | null;
    migrations: string | null;
    totalBytes: number;
}

function invalid(message: string): CloudError {
    return new CloudError('CF_BUNDLE_INVALID', message);
}

function preview(v: unknown): string {
    return String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
}

function mb(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Bỏ BOM UTF-8 đầu file (U+FEFF). */
export function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Đường dẫn tương đối an toàn trong gói: "a/b.js" — không tuyệt đối, không "\\", ":", ký tự điều khiển, ".", "..", đoạn rỗng. */
export function isSafeBundlePath(p: unknown, max = 300): p is string {
    if (typeof p !== 'string' || !p || p.length > max) return false;
    if (p.startsWith('/') || /[\\:]/.test(p) || /[\u0000-\u001f\u007f]/.test(p)) return false;
    return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

/** Hash asset (32 hex) như wrangler: sha256(base64(nội dung) + đuôi file không dấu chấm). */
export function assetHash(content: Buffer, filePath: string): string {
    const extension = path.extname(filePath).slice(1);
    return crypto.createHash('sha256').update(content.toString('base64') + extension).digest('hex').slice(0, 32);
}

const ASSET_TYPES: Record<string, string> = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json', txt: 'text/plain',
    xml: 'application/xml', csv: 'text/csv', md: 'text/markdown',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    wasm: 'application/wasm', pdf: 'application/pdf', zip: 'application/zip',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
};

/**
 * Content-Type gửi kèm từng file asset (Cloudflare giữ để phục vụ file). text/* thêm charset=utf-8 như wrangler;
 * không biết loại → 'application/null' (Cloudflare: không gửi Content-Type khi phục vụ).
 */
export function assetContentType(filePath: string): string {
    const type = ASSET_TYPES[path.extname(filePath).slice(1).toLowerCase()];
    if (!type) return 'application/null';
    return type.startsWith('text/') ? `${type}; charset=utf-8` : type;
}

function inferModuleType(name: string): BundleModuleType | null {
    if (/\.m?js$/i.test(name)) return 'esm';
    if (/\.cjs$/i.test(name)) return 'cjs';
    if (/\.wasm$/i.test(name)) return 'wasm';
    if (/\.map$/i.test(name)) return 'sourcemap';
    return null;
}

function checkAssetConfig(cfg: unknown, errors: string[]): Record<string, unknown> | null {
    if (cfg === undefined || cfg === null) return null;
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
        errors.push('assets.config phải là object');
        return null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(cfg as Record<string, unknown>)) {
        switch (key) {
            case 'html_handling':
                if (typeof v === 'string' && HTML_HANDLING.includes(v)) out[key] = v;
                else errors.push(`assets.config.html_handling phải là ${HTML_HANDLING.join(' | ')}`);
                break;
            case 'not_found_handling':
                if (typeof v === 'string' && NOT_FOUND_HANDLING.includes(v)) out[key] = v;
                else errors.push(`assets.config.not_found_handling phải là ${NOT_FOUND_HANDLING.join(' | ')}`);
                break;
            case 'run_worker_first':
                if (typeof v === 'boolean') out[key] = v;
                else if (Array.isArray(v) && v.length >= 1 && v.length <= 100
                    && v.every(r => typeof r === 'string' && r.length <= 200 && (r.startsWith('/') || r.startsWith('!/')))) out[key] = [...v];
                else errors.push('assets.config.run_worker_first phải là true / false hoặc mảng đường dẫn bắt đầu bằng "/" hoặc "!/"');
                break;
            case '_headers':
            case '_redirects':
                if (typeof v === 'string' && v.length <= 100_000) out[key] = v;
                else errors.push(`assets.config.${key} phải là chuỗi tối đa 100000 ký tự`);
                break;
            default:
                errors.push(`assets.config.${preview(key)} không được hỗ trợ (chỉ ${ASSET_CONFIG_KEYS.join(', ')})`);
        }
    }
    return out;
}

/** Kiểm nội dung bundle.json (không đọc file khác). */
export function validateBundleJson(raw: unknown, limits: BundleLimits = BUNDLE_LIMITS): { ok: true; spec: BundleSpec } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['phải là một object JSON'] };
    const o = raw as Record<string, any>;

    const modules: BundleSpec['modules'] = [];
    if (!Array.isArray(o.modules) || o.modules.length === 0 || o.modules.length > limits.maxModules) {
        errors.push(`modules phải là mảng 1–${limits.maxModules} phần tử`);
    } else {
        const seen = new Set<string>();
        o.modules.forEach((m: any, i: number) => {
            const name = m?.name;
            if (!isSafeBundlePath(name, 200)) {
                errors.push(`modules[${i}].name phải là đường dẫn tương đối an toàn trong ${BUNDLE_WORKER_DIR}/ (không "..", không tuyệt đối)`);
                return;
            }
            if (seen.has(name)) {
                errors.push(`modules[${i}].name trùng "${name}"`);
                return;
            }
            seen.add(name);
            const type = m?.type === undefined ? inferModuleType(name) : m.type;
            if (!type || !Object.prototype.hasOwnProperty.call(MODULE_CONTENT_TYPES, type)) {
                errors.push(`modules[${i}].type phải là ${Object.keys(MODULE_CONTENT_TYPES).join(' | ')}`);
                return;
            }
            modules.push({ name, type: type as BundleModuleType });
        });
    }

    const mainModule = o.mainModule;
    if (typeof mainModule !== 'string' || !mainModule) errors.push('thiếu mainModule');
    else if (Array.isArray(o.modules) && !o.modules.some((m: any) => m?.name === mainModule)) errors.push(`mainModule "${preview(mainModule)}" không có trong modules`);
    else if (modules.length && !['esm', 'cjs'].includes(modules.find(m => m.name === mainModule)?.type || 'esm')) errors.push('mainModule phải là module mã (esm hoặc cjs)');

    const date = o.compatibilityDate;
    if (typeof date !== 'string' || !COMPAT_DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        errors.push('compatibilityDate phải có dạng YYYY-MM-DD');
    }

    let flags: string[] = [];
    if (o.compatibilityFlags !== undefined) {
        if (!Array.isArray(o.compatibilityFlags) || o.compatibilityFlags.length > 20 || o.compatibilityFlags.some((f: any) => typeof f !== 'string' || !COMPAT_FLAG_RE.test(f))) {
            errors.push('compatibilityFlags phải là mảng tối đa 20 cờ (a-z, 0-9, _)');
        } else {
            flags = Array.from(new Set(o.compatibilityFlags as string[]));
        }
    }

    let assets: BundleSpec['assets'] = null;
    if (o.assets !== undefined && o.assets !== null) {
        const a = o.assets;
        if (typeof a !== 'object' || Array.isArray(a)) errors.push('assets phải là object');
        else {
            if (!isSafeBundlePath(a.dir, 200)) errors.push('assets.dir phải là thư mục tương đối an toàn trong gói, vd "assets"');
            let binding: string | null = null;
            if (a.binding !== undefined && a.binding !== null && a.binding !== '') {
                if (typeof a.binding !== 'string' || !BINDING_NAME_RE.test(a.binding)) errors.push('assets.binding chỉ gồm chữ, số, "_" và không bắt đầu bằng số');
                else binding = a.binding;
            }
            const config = checkAssetConfig(a.config, errors);
            if (isSafeBundlePath(a.dir, 200)) assets = { dir: a.dir, binding, config };
        }
    }

    let migrations: string | null = null;
    if (o.migrations !== undefined && o.migrations !== null) {
        if (!isSafeBundlePath(o.migrations, 200)) errors.push('migrations phải là thư mục tương đối an toàn trong gói');
        else migrations = o.migrations;
    }

    if (errors.length) return { ok: false, errors };
    return {
        ok: true,
        spec: { mainModule, modules, compatibilityDate: date, compatibilityFlags: flags, assets, migrations },
    };
}

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent + path.sep);
}

/** Thư mục gốc (gói / migration) do người gọi đã kiểm vị trí: phải tồn tại và là thư mục; trả realpath. */
function realRoot(p: string, label: string): string {
    let real: string;
    try {
        real = fs.realpathSync(p);
    } catch {
        throw invalid(`Không thấy ${label}`);
    }
    if (!fs.statSync(real).isDirectory()) throw invalid(`${label} không phải thư mục`);
    return real;
}

/** Thư mục con trong gói: không symlink, realpath phải nằm trong `within`. */
function subDirectory(within: string, rel: string, label: string): string {
    const full = path.join(within, ...rel.split('/'));
    let st: fs.Stats;
    try {
        st = fs.lstatSync(full);
    } catch {
        throw invalid(`Không thấy ${label}`);
    }
    if (st.isSymbolicLink()) throw invalid(`${label} không được là symlink`);
    if (!st.isDirectory()) throw invalid(`${label} không phải thư mục`);
    const real = fs.realpathSync(full);
    if (!isInside(real, within)) throw invalid(`${label} nằm ngoài gói Worker`);
    return real;
}

function regularFileInside(base: string, rel: string, label: string): string {
    const full = path.join(base, ...rel.split('/'));
    let st: fs.Stats;
    try {
        st = fs.lstatSync(full);
    } catch {
        throw invalid(`Không thấy file ${label}`);
    }
    if (st.isSymbolicLink() || !st.isFile()) throw invalid(`${label} phải là file thường (không symlink)`);
    const real = fs.realpathSync(full);
    if (!isInside(real, base)) throw invalid(`${label} nằm ngoài gói Worker`);
    return real;
}

function walkAssets(dirAbs: string, rel: string, out: BundleAsset[], limits: BundleLimits, addBytes: (n: number) => void): void {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
        if (IGNORED_ASSET_NAMES.has(ent.name)) continue;
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (!isSafeBundlePath(relPath, 1000)) throw invalid(`Tên file asset không hợp lệ: "${preview(relPath)}"`);
        const abs = path.join(dirAbs, ent.name);
        if (ent.isSymbolicLink()) throw invalid(`Asset "${relPath}" là symlink — gói chỉ được chứa file thường`);
        if (ent.isDirectory()) {
            walkAssets(abs, relPath, out, limits, addBytes);
            continue;
        }
        if (!ent.isFile()) throw invalid(`Asset "${relPath}" không phải file thường`);
        const size = fs.statSync(abs).size;
        if (size > limits.maxAssetBytes) throw invalid(`Asset "${relPath}" vượt ${mb(limits.maxAssetBytes)} (giới hạn mỗi file của Cloudflare)`);
        if (out.length >= limits.maxAssetFiles) throw invalid(`Gói có quá ${limits.maxAssetFiles} file asset`);
        addBytes(size);
        const content = fs.readFileSync(abs);
        out.push({ path: `/${relPath}`, absPath: abs, size, hash: assetHash(content, ent.name), contentType: assetContentType(ent.name) });
    }
}

/**
 * Đọc + kiểm gói: bundle.json, module trong worker/, toàn bộ asset (tính hash). `dir` là thư mục gói đã được người gọi
 * kiểm vị trí (bridge: nằm trong thư mục ứng dụng). Nội dung asset không giữ trong RAM (đọc lại khi tải lên).
 */
export function readBundle(dir: string, limits: BundleLimits = BUNDLE_LIMITS): WorkerBundle {
    const root = realRoot(dir, 'thư mục gói Worker');
    const jsonPath = path.join(root, BUNDLE_FILE);
    let st: fs.Stats;
    try {
        st = fs.lstatSync(jsonPath);
    } catch {
        throw invalid(`Không thấy ${BUNDLE_FILE} trong thư mục gói Worker`);
    }
    if (!st.isFile()) throw invalid(`${BUNDLE_FILE} phải là file thường`);
    if (st.size > limits.maxBundleJsonBytes) throw invalid(`${BUNDLE_FILE} quá lớn`);
    let raw: unknown;
    try {
        raw = JSON.parse(stripBom(fs.readFileSync(jsonPath, 'utf8')));
    } catch (err: any) {
        throw invalid(`${BUNDLE_FILE} không phải JSON hợp lệ: ${preview(err?.message || err)}`);
    }
    const res = validateBundleJson(raw, limits);
    if (res.ok === false) throw invalid(`${BUNDLE_FILE} không hợp lệ: ${res.errors.slice(0, 5).join('; ')}`);
    const spec = res.spec;

    let total = 0;
    const addBytes = (n: number) => {
        total += n;
        if (total > limits.maxTotalBytes) throw invalid(`Gói Worker vượt ${mb(limits.maxTotalBytes)}`);
    };

    const workerRoot = subDirectory(root, BUNDLE_WORKER_DIR, `thư mục ${BUNDLE_WORKER_DIR}/ của gói`);
    const modules: BundleModule[] = spec.modules.map(m => {
        const absPath = regularFileInside(workerRoot, m.name, `module "${m.name}" (${BUNDLE_WORKER_DIR}/${m.name})`);
        const size = fs.statSync(absPath).size;
        addBytes(size);
        return { name: m.name, type: m.type, contentType: MODULE_CONTENT_TYPES[m.type], absPath, size };
    });

    let assets: WorkerBundle['assets'] = null;
    if (spec.assets) {
        const assetsRoot = subDirectory(root, spec.assets.dir, `thư mục asset "${spec.assets.dir}"`);
        const files: BundleAsset[] = [];
        walkAssets(assetsRoot, '', files, limits, addBytes);
        if (!files.length) throw invalid(`Thư mục asset "${spec.assets.dir}" không có file nào`);
        assets = { dir: assetsRoot, binding: spec.assets.binding, config: spec.assets.config, files };
    }

    return {
        dir: root,
        mainModule: spec.mainModule,
        compatibilityDate: spec.compatibilityDate,
        compatibilityFlags: spec.compatibilityFlags,
        modules,
        assets,
        migrations: spec.migrations,
        totalBytes: total,
    };
}

/**
 * File migration *.sql trong thư mục (sắp theo tên như wrangler). Tên được ghi vào d1_migrations nên chỉ nhận chữ, số,
 * ". _ -"; mỗi file ≤ 1 MB, không symlink. `dir` đã được người gọi kiểm vị trí.
 */
export function listMigrationFiles(dir: string, limits = MIGRATION_LIMITS): Array<{ name: string; absPath: string; size: number }> {
    const root = realRoot(dir, 'thư mục migration');
    const out: Array<{ name: string; absPath: string; size: number }> = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.name.endsWith('.sql')) continue;
        if (!MIGRATION_NAME_RE.test(ent.name)) throw invalid(`Tên file migration "${preview(ent.name)}" chỉ được gồm chữ, số, ". _ -"`);
        if (ent.isSymbolicLink() || !ent.isFile()) throw invalid(`Migration "${ent.name}" phải là file thường (không symlink)`);
        const absPath = path.join(root, ent.name);
        const size = fs.statSync(absPath).size;
        if (size > limits.maxFileBytes) throw invalid(`Migration "${ent.name}" vượt ${mb(limits.maxFileBytes)}`);
        out.push({ name: ent.name, absPath, size });
        if (out.length > limits.maxFiles) throw invalid(`Quá ${limits.maxFiles} file migration`);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
