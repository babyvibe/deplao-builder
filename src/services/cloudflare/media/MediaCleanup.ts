/**
 * MediaCleanup — công cụ dọn file trên R2. Chỉ chạy khi người dùng chủ động bấm (xoá tin trong app KHÔNG tự xoá gì trên R2).
 *
 *  1. preview(req) — chỉ đọc, không xoá gì: rà chỉ mục cloud_media của workspace đang mở (dòng 'uploaded' / 'evicted')
 *     theo trang khoá chính, chọn file khớp MỘT trong các tiêu chí đã bật:
 *       • orphans     file media của tài khoản (không bao giờ là file dùng chung) mà không còn dòng nào trong DB trỏ tới.
 *                     Rà MỌI bảng thật (trừ chỉ mục R2 / bảng đồng bộ / FTS), mọi cột không phải số, theo lô rowid ≤ 500
 *                     dòng + nhường vòng lặp (DB khách có hàng triệu tin). Thừa tham chiếu = dọn ít đi (an toàn). File sửa
 *                     trong 24 giờ qua không xét. DatabaseService trả [] khi truy vấn lỗi → kiểm lại bằng MAX(rowid),
 *                     lệch là dừng hẳn (không bao giờ đoán "mồ côi").
 *       • accounts    mọi file của các tài khoản này (keys.accountOfRelPath, kể cả thư mục Facebook theo fb_accounts.id).
 *       • olderThan   thời điểm file (mtime, kẹp theo thư mục ngày) < mốc.
 *       • outOfScope  ngoài phạm vi lưu hiện tại (tài khoản không chọn, trước "từ ngày", file chung khi đã tắt).
 *     File chỉ còn trên R2 (đã dọn khỏi máy / máy không còn file) bị bỏ qua trừ khi includeCloudOnly (đếm skippedCloudOnly).
 *     Nhớ danh sách 15 phút dưới một mã ngẫu nhiên (chỉ lần quét mới nhất).
 *  2. run(previewId) — xoá đúng danh sách đã xem: kiểm lại từng dòng ngay trước khi xoá (đổi từ lúc quét → bỏ qua; file
 *     còn trên máy lúc quét mà nay mất → bỏ qua trừ khi đã cho xoá file chỉ còn trên R2), DeleteObjects ≤ 1000 khoá / lần
 *     (không có thì xoá từng object, 4 song song), R2 bận → lùi chung với hàng đợi rồi thử lại. Dòng → 'removed' (không xoá
 *     dòng; không tự tải lên lại trừ khi file đổi). deleteLocalOrphans → xoá luôn bản trên máy của file mồ côi đã xoá
 *     trên R2 (chỉ file mồ côi, chỉ trong thư mục media, đúng bản đã quét). Chạy trong hàng của MediaEvictor.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import type { R2CleanupPreview, R2CleanupProgress, R2CleanupRequest, R2CleanupResult } from '../../../shared/cloudContracts';
import type { R2Client } from '../contracts';
import { CloudError } from '../contracts';
import type { MediaDb } from './CloudMediaIndex';
import {
    absPathFor, accountOfRelPath, collectMediaRefs, MediaScopeFilter, mediaRefKey, mediaTimeOf, objectKeyFor, relInScope,
    relPathInRoot,
} from './keys';
import type { ContextSource, MediaContext } from './MediaContext';
import { classifyR2Error, DAY, errorText, LogFn, MINUTE, noLog, SECOND, sleep, storeLabelNow, yieldToLoop } from './util';

export const CLEANUP_PREVIEW_TTL_MS = 15 * MINUTE;
/** File mồ côi phải cũ hơn 24 giờ (file vừa lưu có thể chưa kịp ghi vào DB). */
export const ORPHAN_MIN_AGE_MS = DAY;
const INDEX_PAGE = 1000;
const REF_PAGE = 500;
const STAT_CHUNK = 200;
const DELETE_BATCH = 1000;
const PER_OBJECT_CONCURRENCY = 4;
const MAX_DELETE_ATTEMPTS = 6;
const MAX_SAMPLES = 20;
const PROGRESS_EVERY_MS = 300;
/**
 * Bảng không rà tham chiếu: chỉ mục R2 (chứa rel của MỌI file — rà vào thì không file nào còn mồ côi) và bảng của đồng
 * bộ DB. Bảng ảo (FTS) và bảng bóng của nó bị bỏ theo kiểu bảng.
 */
const SKIP_REF_TABLES = new Set(['cloud_media', '_cloud_dirty', '_cloud_meta', 'cloud_sync_log']);

export interface CleanupFs {
    stat(p: string): Promise<fs.Stats>;
    unlink(p: string): Promise<void>;
    realpath(p: string): Promise<string>;
}

export interface CleanupDeps {
    ctx: ContextSource;
    r2(bucket: string): R2Client;
    /** Phạm vi lưu hiện tại (tiêu chí "ngoài phạm vi"); null = mọi file đều trong phạm vi. */
    scope(ctx: MediaContext): MediaScopeFilter | null;
    /** Bí danh thư mục tài khoản (Facebook: fb_accounts.id → facebook_id). */
    aliases(ctx: MediaContext): ReadonlyMap<string, string> | null;
    /** Hàng đợi đang lùi chung vì R2 bận. */
    isBackingOff(): boolean;
    /** ms còn lại của đợt lùi (0 = không lùi). */
    backoffRemainingMs(): number;
    /** R2 bận khi xoá → lùi chung với hàng đợi tải lên. */
    onBusy(retryAfterMs?: number): void;
    /** Chạy fn trong hàng dọn file (không chồng với MediaEvictor). */
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
    now?(): number;
    fs?: CleanupFs;
    sleep?(ms: number): Promise<void>;
    log?: LogFn;
}

interface CleanupItem {
    rel: string;
    size: number;
    mtimeMs: number;
    /** Khớp tiêu chí orphans — chỉ những file này mới được xoá bản trên máy (deleteLocalOrphans). */
    orphan: boolean;
    /** Còn bản trên máy lúc quét. */
    local: boolean;
}

interface Candidate {
    rel: string;
    size: number;
    mtimeMs: number;
    evicted: boolean;
    accounts: boolean;
    olderThan: boolean;
    outOfScope: boolean;
    orphan: boolean;
}

interface StoredPreview {
    id: string;
    createdAt: number;
    dbPath: string;
    workspaceUid: string;
    bucket: string;
    includeCloudOnly: boolean;
    deleteLocalOrphans: boolean;
    items: CleanupItem[];
}

export interface RefTable {
    name: string;
    /** Cột có thể chứa chữ (không khai báo kiểu số). */
    columns: string[];
    /** Tên rowid dùng được; null = WITHOUT ROWID (phân trang OFFSET). */
    rowid: string | null;
    /** MAX(rowid) (hoặc COUNT(*)) — cho thanh tiến độ. */
    estimate: number;
}

type Report = (phase: R2CleanupProgress['phase'], done: number, total: number, message?: string, force?: boolean) => void;

function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function scanFailed(table: string): CloudError {
    return new CloudError('CLEANUP_SCAN_FAILED', `Không đọc được bảng ${table} để kiểm tra file còn được dùng — chưa dọn gì, hãy thử lại.`);
}

function abortedError(): CloudError {
    return new CloudError('CLEANUP_ABORTED', `Đã đổi workspace hoặc tắt lưu media trong lúc dọn ${storeLabelNow()} — hãy quét lại.`);
}

function busyError(): CloudError {
    return new CloudError('CLEANUP_BUSY', `Đang quét / dọn file trên ${storeLabelNow()} — chờ lượt này xong rồi thử lại.`);
}

function expiredError(): CloudError {
    return new CloudError('PREVIEW_EXPIRED', 'Kết quả quét đã cũ, hãy quét lại');
}

function reporter(onProgress?: (p: R2CleanupProgress) => void): Report {
    let last = 0;
    return (phase, done, total, message, force = false) => {
        if (!onProgress) return;
        const t = Date.now();
        if (!force && t - last < PROGRESS_EVERY_MS) return;
        last = t;
        const safeTotal = Math.max(0, Math.floor(total) || 0);
        const p: R2CleanupProgress = { phase, done: Math.min(safeTotal, Math.max(0, Math.floor(done) || 0)), total: safeTotal };
        if (message) p.message = message;
        try { onProgress(p); } catch { /* cửa sổ đã đóng */ }
    };
}

/**
 * Bảng thật có thể chứa đường dẫn media (cột không khai báo kiểu số). PRAGMA table_list (SQLite ≥ 3.37) phân biệt sẵn
 * bảng ảo / bảng bóng / WITHOUT ROWID; bản cũ hơn → đọc sqlite_master. Đọc lỗi → ném (không đoán).
 */
export function listReferenceTables(db: MediaDb): RefTable[] {
    let entries: Array<{ name: string; type: string; wr: number }> = [];
    try {
        entries = db.all<{ schema?: unknown; name: unknown; type: unknown; wr?: unknown }>('PRAGMA table_list')
            .filter((t) => !t.schema || t.schema === 'main')
            .map((t) => ({ name: String(t.name), type: String(t.type), wr: Number(t.wr) || 0 }));
    } catch {
        entries = [];
    }
    if (!entries.length) {
        const rows = db.all<{ name: unknown; sql: unknown }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`);
        const virtuals = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(r.sql || ''))).map((r) => String(r.name));
        entries = rows.map((r) => {
            const name = String(r.name);
            const type = virtuals.includes(name) ? 'virtual' : virtuals.some((v) => name.startsWith(`${v}_`)) ? 'shadow' : 'table';
            return { name, type, wr: /\bWITHOUT\s+ROWID\b/i.test(String(r.sql || '')) ? 1 : 0 };
        });
    }
    if (!entries.length) throw scanFailed('sqlite_master');
    const out: RefTable[] = [];
    for (const t of entries) {
        if (t.type !== 'table' || /^sqlite_/i.test(t.name) || SKIP_REF_TABLES.has(t.name)) continue;
        const q = quoteIdent(t.name);
        const info = db.all<{ name: unknown; type: unknown }>(`PRAGMA table_info(${q})`);
        // Bảng nào cũng có cột: rỗng = đọc lỗi
        if (!info.length) throw scanFailed(t.name);
        const columns = info.filter((c) => !/INT|REAL|FLOA|DOUB/i.test(String(c.type || ''))).map((c) => String(c.name));
        if (!columns.length) continue;
        const names = new Set(info.map((c) => String(c.name).toLowerCase()));
        const rowid = t.wr ? null : (['rowid', '_rowid_', 'oid'].find((a) => !names.has(a)) ?? null);
        const est = db.get<{ m: unknown }>(rowid ? `SELECT MAX(${rowid}) AS m FROM ${q}` : `SELECT COUNT(*) AS m FROM ${q}`);
        if (!est) throw scanFailed(t.name);
        out.push({ name: t.name, columns, rowid, estimate: Math.max(0, Number(est.m) || 0) });
    }
    return out;
}

export class MediaCleanup {
    private stored: StoredPreview | null = null;
    private busy = false;
    private readonly fs: CleanupFs;
    private readonly log: LogFn;

    constructor(private readonly deps: CleanupDeps) {
        this.fs = deps.fs || (fs.promises as unknown as CleanupFs);
        this.log = deps.log || noLog;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private sleep(ms: number): Promise<void> {
        return this.deps.sleep ? this.deps.sleep(ms) : sleep(ms);
    }

    /** Dừng lưu media: bỏ danh sách đã quét. */
    reset(): void {
        this.stored = null;
    }

    get running(): boolean {
        return this.busy;
    }

    // ─── Bước 1: quét ──────────────────────────────────────────────────

    async preview(req: R2CleanupRequest, isCurrent: () => boolean, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupPreview> {
        const r = (req && typeof req === 'object' ? req : {}) as R2CleanupRequest;
        const accounts = new Set((Array.isArray(r.accounts) ? r.accounts : []).map((a) => String(a ?? '').trim()).filter(Boolean));
        const olderThanTs = typeof r.olderThanTs === 'number' && Number.isFinite(r.olderThanTs) && r.olderThanTs > 0 ? r.olderThanTs : null;
        const wantOrphans = r.orphans === true;
        const wantOutOfScope = r.outOfScope === true;
        const includeCloudOnly = r.includeCloudOnly === true;
        const deleteLocalOrphans = r.deleteLocalOrphans === true;
        if (!wantOrphans && !accounts.size && olderThanTs === null && !wantOutOfScope) {
            throw new CloudError('BAD_INPUT', 'Chọn ít nhất một tiêu chí dọn.');
        }
        if (this.busy) throw busyError();
        this.busy = true;
        const report = reporter(onProgress);
        try {
            const ctx = await this.deps.ctx.get();
            if (!ctx) throw new CloudError('MEDIA_UNAVAILABLE', 'Chưa mở được chỉ mục media của workspace này — thử lại sau ít phút.');
            const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
            if (!alive()) throw abortedError();
            const startedAt = this.now();
            const aliases = this.deps.aliases(ctx);
            const filter = wantOutOfScope ? this.deps.scope(ctx) : null;
            const orphanBefore = startedAt - ORPHAN_MIN_AGE_MS;
            const tables = wantOrphans ? listReferenceTables(ctx.index.db) : [];
            const indexTotal = ctx.index.rowCountEstimate();
            const total = indexTotal + tables.reduce((s, t) => s + t.estimate, 0);
            let done = 0;
            report('scan', 0, total, undefined, true);

            // 1. Chỉ mục: file đã lên R2 khớp tiêu chí + ứng viên mồ côi (file của tài khoản, sửa trước 24 giờ)
            const matched = new Map<string, Candidate>();
            const orphanCandidates: Candidate[] = [];
            const candidateKeys = new Set<string>();
            let after = '';
            for (;;) {
                if (!alive()) throw abortedError();
                const rows = ctx.index.pageByRel(after, INDEX_PAGE);
                if (!rows.length) break;
                after = rows[rows.length - 1].rel_path;
                for (const row of rows) {
                    if (row.state !== 'uploaded' && row.state !== 'evicted') continue;
                    const rel = row.rel_path;
                    const mtimeMs = Number(row.mtime_ms) || 0;
                    const account = accountOfRelPath(rel, aliases);
                    const c: Candidate = {
                        rel,
                        size: Number(row.size) || 0,
                        mtimeMs,
                        evicted: row.state === 'evicted',
                        accounts: account !== null && accounts.has(account),
                        olderThan: olderThanTs !== null && mediaTimeOf(rel, mtimeMs) < olderThanTs,
                        outOfScope: !!filter && !relInScope(rel, mtimeMs, filter),
                        orphan: false,
                    };
                    if (c.accounts || c.olderThan || c.outOfScope) matched.set(rel, c);
                    if (wantOrphans && account !== null && mtimeMs < orphanBefore) {
                        orphanCandidates.push(c);
                        candidateKeys.add(mediaRefKey(rel));
                    }
                }
                done += rows.length;
                report('scan', done, total);
                await yieldToLoop();
            }
            done = Math.max(done, indexTotal);

            // 2. Mồ côi: không dòng nào trong DB trỏ tới (rà hết bảng, hoặc dừng sớm khi mọi ứng viên đều có tham chiếu)
            if (orphanCandidates.length) {
                const found = new Set<string>();
                for (const t of tables) {
                    const base = done;
                    const complete = await this.scanTable(ctx.index.db, t, candidateKeys, found, alive,
                        (pos) => report('scan', base + Math.min(pos, t.estimate), total));
                    done = base + t.estimate;
                    if (complete) break;
                }
                for (const c of orphanCandidates) {
                    if (found.has(mediaRefKey(c.rel))) continue;
                    c.orphan = true;
                    matched.set(c.rel, c);
                }
            }

            // 3. File chỉ còn trên R2 (đã dọn khỏi máy / máy không còn file): bỏ trừ khi được phép
            const list = Array.from(matched.values()).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
            const items: CleanupItem[] = [];
            const byReason = { orphans: 0, accounts: 0, olderThan: 0, outOfScope: 0 };
            let bytes = 0;
            let cloudOnlyFiles = 0;
            let cloudOnlyBytes = 0;
            let skippedCloudOnly = 0;
            let localOrphans = 0;
            for (let i = 0; i < list.length; i += STAT_CHUNK) {
                if (!alive()) throw abortedError();
                const chunk = list.slice(i, i + STAT_CHUNK);
                const present = await Promise.all(chunk.map((c) => (c.evicted ? Promise.resolve(false) : this.isLocalFile(ctx, c.rel))));
                chunk.forEach((c, k) => {
                    const local = present[k];
                    if (!local && !includeCloudOnly) { skippedCloudOnly++; return; }
                    items.push({ rel: c.rel, size: c.size, mtimeMs: c.mtimeMs, orphan: c.orphan, local });
                    bytes += c.size;
                    if (!local) { cloudOnlyFiles++; cloudOnlyBytes += c.size; }
                    if (c.orphan) { byReason.orphans++; if (local) localOrphans++; }
                    if (c.accounts) byReason.accounts++;
                    if (c.olderThan) byReason.olderThan++;
                    if (c.outOfScope) byReason.outOfScope++;
                });
                await yieldToLoop();
            }
            if (!alive()) throw abortedError();

            // 4. Nhớ danh sách (chỉ lần quét mới nhất, 15 phút)
            const createdAt = this.now();
            const id = randomBytes(12).toString('hex');
            this.stored = {
                id, createdAt, dbPath: ctx.dbPath, workspaceUid: ctx.workspaceUid, bucket: ctx.bucket,
                includeCloudOnly, deleteLocalOrphans, items,
            };
            report('done', total, total, undefined, true);
            this.log('log', `[CloudMedia] Quét dọn R2: ${items.length} file (${(bytes / 1024 / 1024).toFixed(1)} MB), `
                + `bỏ qua ${skippedCloudOnly} file chỉ còn trên R2`);
            return {
                previewId: id,
                scannedAt: createdAt,
                files: items.length,
                bytes,
                cloudOnlyFiles,
                cloudOnlyBytes,
                skippedCloudOnly,
                localFiles: deleteLocalOrphans ? localOrphans : 0,
                byReason,
                samples: items.slice(0, MAX_SAMPLES).map((it) => it.rel),
            };
        } catch (err) {
            report('error', 0, 0, errorText(err), true);
            throw err;
        } finally {
            this.busy = false;
        }
    }

    private async isLocalFile(ctx: MediaContext, rel: string): Promise<boolean> {
        try {
            return (await this.fs.stat(absPathFor(ctx.realRoot, rel))).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Rà một bảng theo lô (rowid tăng dần, ≤ 500 dòng / truy vấn, nhường vòng lặp giữa các lô), ghi tham chiếu tìm được.
     * true = mọi ứng viên đã có tham chiếu (khỏi rà tiếp). Trang rỗng mà MAX(rowid) còn lớn hơn = truy vấn lỗi → thử lại
     * một lần rồi ném.
     */
    private async scanTable(db: MediaDb, t: RefTable, candidates: Set<string>, found: Set<string>, alive: () => boolean,
        onPosition: (pos: number) => void): Promise<boolean> {
        const cols = t.columns.map(quoteIdent).join(', ');
        const q = quoteIdent(t.name);
        const scanRows = (rows: Array<Record<string, unknown>>) => {
            for (const row of rows) {
                for (const c of t.columns) {
                    const v = row[c];
                    if (typeof v === 'string') collectMediaRefs(v, candidates, found);
                }
            }
        };
        let retried = false;
        if (t.rowid) {
            let last = Number.MIN_SAFE_INTEGER;
            for (;;) {
                if (!alive()) throw abortedError();
                const rows = db.all<Record<string, unknown>>(
                    `SELECT ${t.rowid} AS "__cleanup_rowid", ${cols} FROM ${q} WHERE ${t.rowid} > ? ORDER BY ${t.rowid} LIMIT ${REF_PAGE}`,
                    [last],
                );
                if (!rows.length) {
                    const max = db.get<{ m: unknown }>(`SELECT MAX(${t.rowid}) AS m FROM ${q}`);
                    if (!max) throw scanFailed(t.name);
                    const m = max.m === null || max.m === undefined ? null : Number(max.m);
                    if (m !== null && m > last) {
                        if (retried) throw scanFailed(t.name);
                        retried = true;
                        continue;
                    }
                    return false;
                }
                retried = false;
                scanRows(rows);
                last = Number(rows[rows.length - 1].__cleanup_rowid);
                onPosition(last);
                if (found.size >= candidates.size) return true;
                await yieldToLoop();
            }
        }
        let offset = 0;
        for (;;) {
            if (!alive()) throw abortedError();
            const rows = db.all<Record<string, unknown>>(`SELECT ${cols} FROM ${q} LIMIT ${REF_PAGE} OFFSET ?`, [offset]);
            if (!rows.length) {
                const count = db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${q}`);
                if (!count) throw scanFailed(t.name);
                if (Number(count.n) > offset) {
                    if (retried) throw scanFailed(t.name);
                    retried = true;
                    continue;
                }
                return false;
            }
            retried = false;
            scanRows(rows);
            offset += rows.length;
            onPosition(offset);
            if (found.size >= candidates.size) return true;
            await yieldToLoop();
        }
    }

    // ─── Bước 2: xoá ───────────────────────────────────────────────────

    async run(previewId: string, isCurrent: () => boolean, onProgress?: (p: R2CleanupProgress) => void): Promise<R2CleanupResult> {
        const p = this.stored;
        const now = this.now();
        if (!p || !previewId || p.id !== previewId || now - p.createdAt > CLEANUP_PREVIEW_TTL_MS || now < p.createdAt - MINUTE) {
            throw expiredError();
        }
        if (this.busy) throw busyError();
        this.busy = true;
        const report = reporter(onProgress);
        try {
            const ctx = await this.deps.ctx.get();
            if (!ctx || ctx.dbPath !== p.dbPath || ctx.workspaceUid !== p.workspaceUid || ctx.bucket !== p.bucket) throw expiredError();
            // Dùng một lần: chạy lại phải quét lại
            this.stored = null;
            return await this.deps.exclusive(() => this.deleteAll(ctx, p, isCurrent, report));
        } catch (err) {
            report('error', 0, 0, errorText(err), true);
            throw err;
        } finally {
            this.busy = false;
        }
    }

    private async deleteAll(ctx: MediaContext, p: StoredPreview, isCurrent: () => boolean, report: Report): Promise<R2CleanupResult> {
        const result: R2CleanupResult = { deleted: 0, bytes: 0, failed: 0, localDeleted: 0 };
        const alive = () => isCurrent() && this.deps.ctx.isValid(ctx);
        const r2 = this.deps.r2(ctx.bucket);
        const total = p.items.length;
        let processed = 0;
        let skipped = 0;
        let stopError: unknown = null;
        report('delete', 0, total, undefined, true);
        for (let i = 0; i < total && !stopError; i += DELETE_BATCH) {
            if (!alive()) { stopError = abortedError(); break; }
            const batch = p.items.slice(i, i + DELETE_BATCH);
            // Kiểm lại ngay trước khi xoá: dòng vẫn đã lên R2 và đúng bản đã quét; file còn trên máy lúc quét mà nay đã mất
            // (bị dọn khỏi máy từ lúc đó) → bản trên R2 thành bản duy nhất → chỉ xoá khi người dùng cho xoá cả loại đó
            const stats = await Promise.all(batch.map((b) => (b.local ? this.statOrNull(absPathFor(ctx.realRoot, b.rel)) : Promise.resolve(null))));
            if (!alive()) { stopError = abortedError(); break; }
            const rows = ctx.index.getRows(batch.map((b) => b.rel));
            const ready: CleanupItem[] = [];
            batch.forEach((b, k) => {
                const row = rows.get(b.rel);
                const same = !!row && (row.state === 'uploaded' || row.state === 'evicted')
                    && Number(row.size) === b.size && Number(row.mtime_ms) === b.mtimeMs;
                const st = stats[k];
                const stillLocal = !!st && st.isFile() && st.size === b.size && Math.floor(st.mtimeMs) === b.mtimeMs;
                if (!same || (b.local && !stillLocal && !p.includeCloudOnly)) { skipped++; return; }
                ready.push(b);
            });
            const keys = ready.map((b) => objectKeyFor(ctx.workspaceUid, b.rel));
            const out = await this.deleteKeys(r2, keys, alive);
            const removed = ready.filter((_, k) => out.deleted.has(keys[k]));
            // Workspace đã đổi giữa chừng: không ghi DB của workspace khác (lần sau HEAD / tải về thấy thiếu sẽ tự sửa)
            if (removed.length && this.deps.ctx.isValid(ctx)) ctx.index.markRemoved(removed.map((b) => b.rel));
            result.deleted += removed.length;
            for (const b of removed) result.bytes += b.size;
            if (out.error) stopError = out.error;
            if (p.deleteLocalOrphans) {
                for (const b of removed) {
                    if (b.orphan && b.local && (await this.removeLocal(ctx, b, alive))) result.localDeleted++;
                }
            }
            processed += batch.length;
            report('delete', processed, total);
            await yieldToLoop();
        }
        result.failed = Math.max(0, total - result.deleted);
        const mb = (result.bytes / 1024 / 1024).toFixed(1);
        if (stopError) {
            this.log('warn', `[CloudMedia] Dọn R2 dừng: ${errorText(stopError)} — đã xoá ${result.deleted} file (${mb} MB), còn ${result.failed} file`);
            // Chưa xoá được gì → báo lỗi thẳng cho người dùng (vd token thiếu quyền); đã xoá một phần → trả kết quả
            if (!result.deleted) throw stopError;
            report('error', processed, total, errorText(stopError), true);
        } else {
            report('done', total, total, undefined, true);
        }
        this.log('log', `[CloudMedia] Dọn R2: đã xoá ${result.deleted} file (${mb} MB), không xoá ${result.failed} file `
            + `(${skipped} đã đổi từ lúc quét), xoá trên máy ${result.localDeleted} file`);
        return result;
    }

    private async statOrNull(p: string): Promise<fs.Stats | null> {
        try { return await this.fs.stat(p); } catch { return null; }
    }

    /** Xoá bản trên máy của file mồ côi: chỉ trong thư mục media (không theo junction ra ngoài), đúng bản đã quét. */
    private async removeLocal(ctx: MediaContext, b: CleanupItem, alive: () => boolean): Promise<boolean> {
        try {
            const real = await this.fs.realpath(absPathFor(ctx.realRoot, b.rel));
            if (relPathInRoot(ctx.realRoot, real) !== b.rel) return false;
            const st = await this.fs.stat(real);
            if (!st.isFile() || st.size !== b.size || Math.floor(st.mtimeMs) !== b.mtimeMs) return false;
            if (!alive()) return false;
            await this.fs.unlink(real);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Xoá các khoá trên R2: DeleteObjects một lần (≤ 1000 khoá), không có thì từng object (4 song song). R2 bận / mất mạng →
     * lùi chung rồi thử lại phần còn lại (tối đa 6 lần); lỗi khác (token, bucket…) → dừng, trả lỗi.
     */
    private async deleteKeys(r2: R2Client, keys: string[], alive: () => boolean): Promise<{ deleted: Set<string>; error: unknown }> {
        const deleted = new Set<string>();
        let attempts = 0;
        while (deleted.size < keys.length) {
            while (this.deps.isBackingOff()) {
                if (!alive()) return { deleted, error: abortedError() };
                await this.sleep(Math.min(5 * SECOND, Math.max(SECOND, this.deps.backoffRemainingMs())));
            }
            if (!alive()) return { deleted, error: abortedError() };
            const todo = keys.filter((k) => !deleted.has(k));
            try {
                if (typeof r2.deleteObjects === 'function') {
                    const res = await r2.deleteObjects(todo);
                    for (const k of res.deleted) deleted.add(k);
                    if (res.errors.length) {
                        this.log('warn', `[CloudMedia] Dọn R2: ${res.errors.length} file không xoá được (${res.errors[0].code || 'lỗi'})`);
                    }
                    return { deleted, error: null };
                }
                for (let i = 0; i < todo.length; i += PER_OBJECT_CONCURRENCY) {
                    if (!alive()) return { deleted, error: abortedError() };
                    const group = todo.slice(i, i + PER_OBJECT_CONCURRENCY);
                    const settled = await Promise.allSettled(group.map((k) => r2.deleteObject(k)));
                    let firstError: unknown = null;
                    settled.forEach((s, j) => {
                        if (s.status === 'fulfilled') deleted.add(group[j]);
                        else if (firstError === null) firstError = s.reason ?? new Error('Xoá trên R2 lỗi');
                    });
                    if (firstError !== null) throw firstError;
                }
                return { deleted, error: null };
            } catch (err) {
                const kind = classifyR2Error(err);
                if ((kind === 'busy' || kind === 'network') && ++attempts < MAX_DELETE_ATTEMPTS) {
                    this.deps.onBusy((err as { retryAfterMs?: number })?.retryAfterMs);
                    if (!this.deps.isBackingOff()) await this.sleep(5 * SECOND);
                    continue;
                }
                return { deleted, error: err };
            }
        }
        return { deleted, error: null };
    }
}
