/**
 * CloudMediaIndex — bảng `cloud_media` trong DB của workspace đang mở: mỗi file media một dòng.
 *
 *   rel_path       đường dẫn trong thư mục media/ ('/', đúng tên trên đĩa) — khoá chính
 *   size, mtime_ms kích thước / thời điểm sửa (ms, làm tròn xuống) lúc lập chỉ mục hoặc lúc tải lên
 *   sha256, etag   băm nội dung đã tải lên; ETag lấy từ HEAD sau khi tải (cùng dạng với HEAD lúc dọn file)
 *   state          pending → uploading → uploaded (→ evicted khi đã dọn khỏi máy) | missing (file biến mất trước khi tải)
 *                  | excluded (ngoài phạm vi lưu — tài khoản / từ ngày / file chung; không tải, không tính vào tổng)
 *                  | removed (người dùng đã dọn khỏi R2 bằng công cụ dọn: không tự tải lên lại trừ khi file đổi
 *                    kích thước / mtime, không tải về, không tính vào tổng)
 *   uploaded_at, last_access_at, attempts, last_error
 *   priority       (thêm) 1 = media Zalo đã hết hạn trên CDN (tải trước), 0 = thường, -1 = lỗi quá số lần ("failed")
 *   next_try_at    (thêm) thời điểm được thử lại file lỗi (lùi theo từng file)
 *
 * Ghi theo lô ≤ 500 dòng / transaction. Không bao giờ xoá dòng (R2 là kho lưu trữ: xoá tin trong app không xoá trên R2;
 * chỉ công cụ dọn R2 do người dùng chạy mới xoá object, dòng chuyển 'removed').
 */
import { ALL_SCOPE, CloudScope, normalizeScope } from '../../../shared/cloud/cloudContracts';
import { HOUR, MINUTE } from './util';

export type MediaState = 'pending' | 'uploading' | 'uploaded' | 'evicted' | 'missing' | 'excluded' | 'removed';

/** Truy cập SQL vào DB của workspace đang mở (DatabaseService ở app; node:sqlite trong test). */
export interface MediaDb {
    exec(sql: string): void;
    /** Trả số dòng thay đổi. */
    run(sql: string, params?: unknown[]): number;
    all<T = any>(sql: string, params?: unknown[]): T[];
    get<T = any>(sql: string, params?: unknown[]): T | undefined;
    transaction<T>(fn: () => T): T;
}

export interface MediaRow {
    rel_path: string;
    size: number;
    mtime_ms: number;
    sha256: string | null;
    state: MediaState;
    etag: string | null;
    uploaded_at: number | null;
    last_access_at: number | null;
    attempts: number;
    last_error: string | null;
    priority: number;
    next_try_at: number;
}

export interface ScannedFile {
    rel: string;
    size: number;
    /** ms, đã làm tròn xuống (Math.floor(stat.mtimeMs)). */
    mtimeMs: number;
    priority?: number;
}

export interface MediaTotals {
    files: number;
    uploaded: number;
    pending: number;
    failed: number;
    evicted: number;
    bytesTotal: number;
    bytesUploaded: number;
}

export const EMPTY_TOTALS: Readonly<MediaTotals> = Object.freeze({
    files: 0, uploaded: 0, pending: 0, failed: 0, evicted: 0, bytesTotal: 0, bytesUploaded: 0,
});

export const INDEX_BATCH = 500;
export const PRIORITY_EXPIRED = 1;
export const PRIORITY_NORMAL = 0;
export const PRIORITY_PARKED = -1;
export const MAX_FILE_ATTEMPTS = 5;

/** app_settings: mã workspace (tiền tố khoá R2) — DB khôi phục ở máy khác vẫn tìm được media của nó. */
export const SETTING_WORKSPACE_UID = 'cloud_workspace_uid';
/** app_settings: con trỏ quét toàn bộ (JSON, quét tiếp được sau khi tắt app). */
export const SETTING_SCAN_CURSOR = 'cloud_media_scan_cursor';
/** app_settings: bucket chứa media của workspace này (giữ khi khôi phục DB sang máy khác). */
export const SETTING_MEDIA_BUCKET = 'cloud_media_bucket';
/**
 * app_settings: kho mà trạng thái các dòng cloud_media đang nói tới ('r2' | 'gdrive'; chưa có = 'r2' — bản cũ chỉ có R2).
 * Khác kho đang chọn → file đã lên kho cũ phải tải lên lại kho mới (resetForNewStore).
 */
export const SETTING_MEDIA_PROVIDER = 'cloud_media_provider';
/** app_settings: phạm vi lưu (keys.scopeSignature) mà chỉ mục đang theo — khác phạm vi hiện tại → quét lại từ đầu. */
export const SETTING_MEDIA_SCOPE = 'cloud_media_scope';
/**
 * app_settings: phạm vi lưu người dùng chọn cho workspace NÀY (JSON { scope, includeShared }) — tài khoản thuộc workspace
 * nên phạm vi theo workspace (đổi workspace không loại hết tài khoản của nó). Chưa có = tất cả, có file chung.
 */
export const SETTING_MEDIA_SCOPE_CHOICE = 'cloud_media_scope_choice';

/** Phạm vi lưu media của một workspace. */
export interface MediaScopeChoice {
    scope: CloudScope;
    includeShared: boolean;
}

export const ALL_MEDIA_SCOPE: Readonly<MediaScopeChoice> = Object.freeze({ scope: ALL_SCOPE, includeShared: true });

const ROW_COLUMNS = 'rel_path, size, mtime_ms, sha256, state, etag, uploaded_at, last_access_at, attempts, last_error, priority, next_try_at';

function marks(n: number): string {
    return new Array(n).fill('?').join(', ');
}

function num(v: unknown): number {
    return Number(v) || 0;
}

/** Lùi thử lại theo từng file: 1, 4, 16, 64 phút… tối đa 6 giờ. */
export function fileRetryDelayMs(attempts: number): number {
    return Math.min(6 * HOUR, MINUTE * Math.pow(4, Math.max(0, attempts - 1)));
}

export class CloudMediaIndex {
    constructor(readonly db: MediaDb) {}

    // ─── Lược đồ / cài đặt ─────────────────────────────────────────────

    /**
     * Đổi kho (R2 ↔ Google Drive): file đã lên kho cũ → chờ tải lên kho mới. File người dùng đã dọn khỏi kho cũ
     * ('removed') giữ nguyên (không tự đưa lên lại); file chỉ còn trên kho cũ ('evicted') không đổi được — gọi
     * countEvicted() trước, còn thì không đổi kho cho workspace này. Trả số dòng đổi.
     */
    resetForNewStore(): number {
        return this.db.run(
            `UPDATE cloud_media SET state = 'pending', etag = NULL, uploaded_at = NULL, attempts = 0, last_error = NULL,
                priority = CASE WHEN priority < 0 THEN 0 ELSE priority END, next_try_at = 0
             WHERE state IN ('uploaded', 'uploading')`,
        );
    }

    /** Số file chỉ còn trên kho (đã dọn khỏi máy). */
    countEvicted(): number {
        return num(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cloud_media WHERE state = 'evicted'`)?.n);
    }

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cloud_media (
                rel_path TEXT PRIMARY KEY,
                size INTEGER NOT NULL DEFAULT 0,
                mtime_ms INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                etag TEXT,
                uploaded_at INTEGER,
                last_access_at INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                next_try_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cloud_media_state ON cloud_media(state, priority, mtime_ms);
            CREATE INDEX IF NOT EXISTS idx_cloud_media_state_mtime ON cloud_media(state, mtime_ms, size);
        `);
    }

    tableExists(): boolean {
        return !!this.db.get(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'cloud_media'`);
    }

    getSetting(key: string): string | null {
        const row = this.db.get<{ value: unknown }>('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row && typeof row.value === 'string' ? row.value : null;
    }

    setSetting(key: string, value: string): void {
        this.db.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, value],
        );
    }

    /** Phạm vi lưu người dùng chọn cho workspace này (chỉ đọc; chưa chọn / hỏng → tất cả, có file chung). */
    readScopeChoice(): MediaScopeChoice {
        try {
            const raw = this.getSetting(SETTING_MEDIA_SCOPE_CHOICE);
            if (!raw) return { scope: { ...ALL_SCOPE }, includeShared: true };
            const v = JSON.parse(raw) as { scope?: unknown; includeShared?: unknown };
            return {
                scope: normalizeScope(v && typeof v === 'object' ? v.scope : null),
                includeShared: !(v && typeof v === 'object' && v.includeShared === false),
            };
        } catch {
            return { scope: { ...ALL_SCOPE }, includeShared: true };
        }
    }

    writeScopeChoice(choice: MediaScopeChoice): void {
        const scope = normalizeScope(choice.scope);
        this.setSetting(SETTING_MEDIA_SCOPE_CHOICE, JSON.stringify({ v: 1, scope, includeShared: choice.includeShared !== false }));
    }

    // ─── Lập chỉ mục ───────────────────────────────────────────────────

    /**
     * Thêm / cập nhật file thấy trên đĩa (≤ 500 dòng mỗi transaction). Nơi gọi chỉ đưa file TRONG phạm vi lưu:
     *  - chưa có → pending;  missing → pending;  excluded (phạm vi nay gồm file này) → pending;
     *  - uploaded mà size/mtime đổi → pending (tải lại cùng khoá); evicted mà file có lại trên máy → uploaded (hoặc pending nếu khác);
     *  - removed (đã dọn khỏi R2): giữ nguyên, chỉ khi size/mtime đổi (file mới cùng tên) → pending;
     *  - pending: cập nhật size/mtime, nâng priority, lỗi quá số lần mà file đổi → thử lại; uploading: để bộ tải lên tự xử lý.
     */
    upsertScanned(files: ScannedFile[]): { inserted: number; requeued: number } {
        let inserted = 0;
        let requeued = 0;
        for (let i = 0; i < files.length; i += INDEX_BATCH) {
            const unique = new Map<string, ScannedFile>();
            for (const f of files.slice(i, i + INDEX_BATCH)) if (f && f.rel) unique.set(f.rel, f);
            const batch = Array.from(unique.values());
            if (!batch.length) continue;
            this.db.transaction(() => {
                const existing = new Map<string, MediaRow>();
                for (const row of this.db.all<MediaRow>(
                    `SELECT rel_path, size, mtime_ms, state, priority FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`,
                    batch.map((f) => f.rel),
                )) existing.set(row.rel_path, row);

                const fresh: ScannedFile[] = [];
                for (const f of batch) {
                    const r = existing.get(f.rel);
                    const priority = Math.max(PRIORITY_NORMAL, num(f.priority));
                    if (!r) { fresh.push(f); continue; }
                    const changed = num(r.size) !== f.size || num(r.mtime_ms) !== f.mtimeMs;
                    if (r.state === 'missing' || r.state === 'excluded'
                        || (changed && (r.state === 'uploaded' || r.state === 'evicted' || r.state === 'removed'))) {
                        requeued += this.db.run(
                            `UPDATE cloud_media SET state = 'pending', size = ?, mtime_ms = ?, attempts = 0, last_error = NULL,
                                    next_try_at = 0, priority = ? WHERE rel_path = ?`,
                            [f.size, f.mtimeMs, priority, f.rel],
                        );
                    } else if (r.state === 'evicted') {
                        // File đã dọn nay có lại trên máy, đúng bản đã tải lên
                        this.db.run(`UPDATE cloud_media SET state = 'uploaded' WHERE rel_path = ? AND state = 'evicted'`, [f.rel]);
                    } else if (r.state === 'pending') {
                        // File lỗi quá số lần (priority < 0) chỉ được thử lại khi nội dung đổi
                        const parked = num(r.priority) < 0;
                        if (changed || (!parked && priority > num(r.priority))) {
                            this.db.run(
                                `UPDATE cloud_media SET size = ?, mtime_ms = ?, priority = ?,
                                        attempts = CASE WHEN ? THEN 0 ELSE attempts END,
                                        next_try_at = CASE WHEN ? THEN 0 ELSE next_try_at END
                                 WHERE rel_path = ? AND state = 'pending'`,
                                [f.size, f.mtimeMs, Math.max(priority, num(r.priority), PRIORITY_NORMAL),
                                    parked ? 1 : 0, changed ? 1 : 0, f.rel],
                            );
                            if (parked) requeued++;
                        }
                    }
                }
                for (let j = 0; j < fresh.length; j += 100) {
                    const chunk = fresh.slice(j, j + 100);
                    inserted += this.db.run(
                        `INSERT OR IGNORE INTO cloud_media (rel_path, size, mtime_ms, state, priority, attempts, next_try_at)
                         VALUES ${chunk.map(() => `(?, ?, ?, 'pending', ?, 0, 0)`).join(', ')}`,
                        chunk.flatMap((f) => [f.rel, f.size, f.mtimeMs, Math.max(PRIORITY_NORMAL, num(f.priority))]),
                    );
                }
            });
        }
        return { inserted, requeued };
    }

    /** rel chưa có trong chỉ mục (tra theo lô 500). */
    filterUnknown(rels: string[]): string[] {
        const out: string[] = [];
        for (let i = 0; i < rels.length; i += INDEX_BATCH) {
            const batch = rels.slice(i, i + INDEX_BATCH);
            if (!batch.length) continue;
            const known = new Set(this.db.all<{ rel_path: string }>(
                `SELECT rel_path FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`, batch,
            ).map((r) => r.rel_path));
            for (const rel of batch) if (!known.has(rel)) out.push(rel);
        }
        return out;
    }

    // ─── Hàng đợi tải lên ──────────────────────────────────────────────

    /** File chờ tải: ưu tiên cao trước, mới nhất trước; chỉ file đã sửa xong ≥ 10 s (mtime ≤ maxMtime). */
    pickPending(limit: number, now: number, maxMtime: number): MediaRow[] {
        if (!(limit > 0)) return [];
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = 'pending' AND priority >= 0 AND mtime_ms <= ? AND next_try_at <= ?
             ORDER BY priority DESC, mtime_ms DESC LIMIT ?`,
            [maxMtime, now, Math.floor(limit)],
        );
    }

    /** pending → uploading (một transaction); trả các dòng nhận được. */
    claim(rows: MediaRow[]): MediaRow[] {
        if (!rows.length) return [];
        return this.db.transaction(() => rows.filter((r) =>
            this.db.run(`UPDATE cloud_media SET state = 'uploading' WHERE rel_path = ? AND state = 'pending'`, [r.rel_path]) > 0));
    }

    markUploaded(rel: string, v: { size: number; mtimeMs: number; sha256: string | null; etag: string | null; uploadedAt: number }): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'uploaded', size = ?, mtime_ms = ?, sha256 = ?, etag = ?, uploaded_at = ?,
                    attempts = 0, last_error = NULL, priority = 0, next_try_at = 0
             WHERE rel_path = ?`,
            [v.size, v.mtimeMs, v.sha256 ?? null, v.etag ?? null, v.uploadedAt, rel],
        );
    }

    /** uploading → pending, không tính là lỗi (R2 bận, đổi workspace, file đang ghi dở / vừa đổi…). */
    release(rel: string, patch: { size?: number; mtimeMs?: number; nextTryAt?: number } = {}): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', size = COALESCE(?, size), mtime_ms = COALESCE(?, mtime_ms),
                    next_try_at = COALESCE(?, next_try_at)
             WHERE rel_path = ? AND state IN ('uploading', 'pending')`,
            [patch.size ?? null, patch.mtimeMs ?? null, patch.nextTryAt ?? null, rel],
        );
    }

    /** Lỗi riêng của file: thử lại sau (lùi dần); quá MAX_FILE_ATTEMPTS lần → priority -1 ("failed", chờ thử lại hằng ngày). */
    markFailed(rel: string, error: string, now: number, prevAttempts: number): void {
        const attempts = num(prevAttempts) + 1;
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', attempts = ?, last_error = ?, next_try_at = ?,
                    priority = CASE WHEN ? THEN ${PRIORITY_PARKED} ELSE priority END
             WHERE rel_path = ? AND state IN ('uploading', 'pending')`,
            [attempts, String(error || '').slice(0, 300), now + fileRetryDelayMs(attempts), attempts >= MAX_FILE_ATTEMPTS ? 1 : 0, rel],
        );
    }

    markMissing(rel: string, reason: string): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'missing', last_error = ?, next_try_at = 0
             WHERE rel_path = ? AND state NOT IN ('missing', 'removed')`,
            [String(reason || '').slice(0, 300), rel],
        );
    }

    /** uploaded → pending (file trên máy đã đổi, hoặc bản trên R2 không khớp): tải lại, giữ file trên máy. */
    requeueUploaded(rel: string, patch: { size?: number; mtimeMs?: number } = {}): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'pending', size = COALESCE(?, size), mtime_ms = COALESCE(?, mtime_ms),
                    attempts = 0, last_error = NULL, next_try_at = 0, priority = 0
             WHERE rel_path = ? AND state = 'uploaded'`,
            [patch.size ?? null, patch.mtimeMs ?? null, rel],
        );
    }

    markEvicted(rel: string): void {
        this.db.run(`UPDATE cloud_media SET state = 'evicted' WHERE rel_path = ? AND state = 'uploaded'`, [rel]);
    }

    /** Đã tải về từ R2 (hoặc có lại trên máy): uploaded + ghi lần mở. */
    markRestored(rel: string, now: number): void {
        this.db.run(
            `UPDATE cloud_media SET state = 'uploaded', last_access_at = ? WHERE rel_path = ? AND state IN ('evicted', 'uploaded')`,
            [now, rel],
        );
    }

    /** Dòng 'uploading' còn sót (app tắt giữa chừng / đổi workspace) → pending. */
    resetUploading(): number {
        return this.db.run(`UPDATE cloud_media SET state = 'pending' WHERE state = 'uploading'`);
    }

    /** File lỗi quá số lần → thử lại từ đầu (hằng ngày / khi người dùng bấm Tiếp tục). */
    unparkFailed(): number {
        return this.db.run(
            `UPDATE cloud_media SET priority = 0, attempts = 0, next_try_at = 0 WHERE state = 'pending' AND priority < 0`,
        );
    }

    // ─── Phạm vi lưu ───────────────────────────────────────────────────

    /** pending → excluded (ngoài phạm vi: không tải lên). Dòng đang tải / đã lên R2 không đổi. ≤ 500 dòng / transaction. */
    markExcluded(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'excluded' WHERE state = 'pending' AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    /** excluded → pending (phạm vi nay gồm lại file này): thử lại từ đầu. ≤ 500 dòng / transaction. */
    includeExcluded(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'pending', attempts = 0, last_error = NULL, next_try_at = 0,
                    priority = MAX(priority, ${PRIORITY_NORMAL})
             WHERE state = 'excluded' AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    /**
     * Một trang dòng theo rel_path (khoá chính; mỗi truy vấn đọc ≤ limit dòng, không quét cả bảng) — rà lại chỉ mục khi
     * đổi phạm vi, quét file cần dọn trên R2.
     */
    pageByRel(afterRel: string, limit: number): Array<Pick<MediaRow, 'rel_path' | 'state' | 'size' | 'mtime_ms'>> {
        return this.db.all<Pick<MediaRow, 'rel_path' | 'state' | 'size' | 'mtime_ms'>>(
            'SELECT rel_path, state, size, mtime_ms FROM cloud_media WHERE rel_path > ? ORDER BY rel_path LIMIT ?',
            [afterRel || '', Math.max(1, Math.floor(limit))],
        );
    }

    /** Ước lượng số dòng (MAX(rowid), không đếm cả bảng) — cho thanh tiến độ. */
    rowCountEstimate(): number {
        return num(this.db.get<{ m: unknown }>('SELECT MAX(rowid) AS m FROM cloud_media')?.m);
    }

    /** uploaded / evicted → removed (object đã xoá khỏi R2 bằng công cụ dọn). ≤ 500 dòng / transaction. */
    markRemoved(rels: string[]): number {
        return this.updateInBatches(rels, (batch) => this.db.run(
            `UPDATE cloud_media SET state = 'removed', last_error = NULL
             WHERE state IN ('uploaded', 'evicted') AND rel_path IN (${marks(batch.length)})`, batch,
        ));
    }

    private updateInBatches(rels: string[], fn: (batch: string[]) => number): number {
        let changed = 0;
        const list = Array.from(new Set(rels.filter(Boolean)));
        for (let i = 0; i < list.length; i += INDEX_BATCH) {
            const batch = list.slice(i, i + INDEX_BATCH);
            changed += this.db.transaction(() => fn(batch));
        }
        return changed;
    }

    /**
     * Thư mục media đặt theo id nội bộ Facebook (fb_accounts.id — FacebookService lưu theo id này khi chưa biết
     * facebook_id) → accounts.zalo_id (= facebook_id). Không có bảng fb_accounts → rỗng. Chỉ đọc.
     */
    accountFolderAliases(): Map<string, string> {
        const out = new Map<string, string>();
        try {
            const rows = this.db.all<{ id: unknown; facebook_id: unknown }>(
                `SELECT id, facebook_id FROM fb_accounts WHERE facebook_id IS NOT NULL AND facebook_id != ''`,
            );
            for (const r of rows) {
                const id = String(r.id ?? '').trim();
                const fbId = String(r.facebook_id ?? '').trim();
                if (!id || !fbId || id === fbId) continue;
                out.set(id, fbId);
                if (!out.has(id.toLowerCase())) out.set(id.toLowerCase(), fbId);
            }
        } catch { /* DB chưa có bảng fb_accounts */ }
        return out;
    }

    // ─── Tra cứu ───────────────────────────────────────────────────────

    getRow(rel: string): MediaRow | undefined {
        return this.db.get<MediaRow>(`SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path = ?`, [rel]);
    }

    /** Dòng đầu tiên khớp một trong các biến thể (NFC/NFD…). */
    findRow(variants: string[]): MediaRow | undefined {
        const list = Array.from(new Set(variants.filter(Boolean)));
        if (!list.length) return undefined;
        return this.db.get<MediaRow>(`SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path IN (${marks(list.length)}) LIMIT 1`, list);
    }

    /** Không phân biệt hoa/thường (ASCII), giới hạn trong thư mục cha của rel (khoảng khoá chính → không quét cả bảng). */
    findRowCaseInsensitive(rel: string): MediaRow | undefined {
        const slash = rel.lastIndexOf('/');
        if (slash <= 0) return undefined;
        const dir = rel.slice(0, slash);
        return this.db.get<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path >= ? AND rel_path < ? AND lower(rel_path) = lower(?) LIMIT 1`,
            [`${dir}/`, `${dir}0`, rel],
        );
    }

    getRows(rels: string[]): Map<string, MediaRow> {
        const out = new Map<string, MediaRow>();
        for (let i = 0; i < rels.length; i += INDEX_BATCH) {
            const batch = rels.slice(i, i + INDEX_BATCH);
            if (!batch.length) continue;
            for (const row of this.db.all<MediaRow>(
                `SELECT ${ROW_COLUMNS} FROM cloud_media WHERE rel_path IN (${marks(batch.length)})`, batch,
            )) out.set(row.rel_path, row);
        }
        return out;
    }

    /** Ứng viên dọn khỏi máy: uploaded, cũ hơn mtimeBefore, không mở từ accessBefore; cũ nhất trước (phân trang theo con trỏ). */
    evictCandidates(o: { mtimeBefore: number; accessBefore: number; limit: number; after?: { mtime: number; rel: string } }): MediaRow[] {
        const after = o.after || { mtime: -1, rel: '' };
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = 'uploaded' AND mtime_ms < ? AND (last_access_at IS NULL OR last_access_at < ?)
               AND (mtime_ms > ? OR (mtime_ms = ? AND rel_path > ?))
             ORDER BY mtime_ms ASC, rel_path ASC LIMIT ?`,
            [o.mtimeBefore, o.accessBefore, after.mtime, after.mtime, after.rel, Math.floor(o.limit)],
        );
    }

    /** Dòng theo trạng thái, mới nhất trước (phân trang theo con trỏ) — dùng khi tải lại toàn bộ. */
    rowsByStateNewestFirst(state: MediaState, limit: number, before?: { mtime: number; rel: string }): MediaRow[] {
        const b = before || { mtime: Number.MAX_SAFE_INTEGER, rel: '' };
        return this.db.all<MediaRow>(
            `SELECT ${ROW_COLUMNS} FROM cloud_media
             WHERE state = ? AND (mtime_ms < ? OR (mtime_ms = ? AND rel_path < ?))
             ORDER BY mtime_ms DESC, rel_path DESC LIMIT ?`,
            [state, b.mtime, b.mtime, b.rel, Math.floor(limit)],
        );
    }

    /**
     * Tổng hợp cho trạng thái (đọc chỉ mục phủ, rẻ). uploaded gồm cả evicted (đều đã có trên R2);
     * pending gồm uploading; failed = pending đã lỗi quá số lần; missing, excluded (ngoài phạm vi lưu) và removed (đã dọn
     * khỏi R2) không tính — tổng = file trong phạm vi + file đang có trên R2.
     */
    totals(): MediaTotals {
        const t: MediaTotals = { ...EMPTY_TOTALS };
        const rows = this.db.all<{ state: string; n: unknown; bytes: unknown }>(
            'SELECT state, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cloud_media GROUP BY state',
        );
        for (const r of rows) {
            if (r.state === 'missing' || r.state === 'excluded' || r.state === 'removed') continue;
            const n = num(r.n);
            const bytes = num(r.bytes);
            t.files += n;
            t.bytesTotal += bytes;
            if (r.state === 'uploaded' || r.state === 'evicted') { t.uploaded += n; t.bytesUploaded += bytes; }
            if (r.state === 'evicted') t.evicted += n;
            if (r.state === 'pending' || r.state === 'uploading') t.pending += n;
        }
        t.failed = num(this.db.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM cloud_media WHERE state = 'pending' AND priority < 0`)?.n);
        t.pending = Math.max(0, t.pending - t.failed);
        return t;
    }

    // ─── Media Zalo hết hạn trên CDN (ưu tiên sao lưu) ──────────────────

    maxMessageId(): number {
        return num(this.db.get<{ m: unknown }>('SELECT MAX(id) AS m FROM messages')?.m);
    }

    /** Giá trị local_paths (chuỗi) của tin có media_expired = 1 trong khoảng id (afterId, toId]. */
    expiredLocalPaths(afterId: number, toId: number): string[] {
        const rows = this.db.all<{ local_paths: unknown }>(
            `SELECT local_paths FROM messages
             WHERE id > ? AND id <= ? AND media_expired = 1
               AND local_paths IS NOT NULL AND local_paths NOT IN ('', '{}', 'null', '[]')`,
            [afterId, toId],
        );
        const out: string[] = [];
        const collect = (v: unknown, depth: number) => {
            if (typeof v === 'string') { if (v) out.push(v); return; }
            if (depth > 2 || !v || typeof v !== 'object') return;
            for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) collect(x, depth + 1);
        };
        for (const r of rows) {
            if (typeof r.local_paths !== 'string') continue;
            try { collect(JSON.parse(r.local_paths), 0); } catch { /* JSON hỏng → bỏ qua */ }
        }
        return out;
    }
}
