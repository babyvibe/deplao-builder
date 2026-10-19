/**
 * Snapshot — bản gốc (base) của DB workspace.
 *
 *  1. backup API của SQLite sang file tạm (chép nguyên trang → giữ rowid; KHÔNG dùng VACUUM INTO vì có thể đánh số
 *     lại rowid của bảng không có INTEGER PRIMARY KEY, làm đoạn thay đổi sau đó áp sai dòng).
 *  2. Trên BẢN SAO: đọc mốc H = id lớn nhất của _cloud_dirty, xoá sạch _cloud_dirty, lọc theo phạm vi đồng bộ nếu có
 *     (scope.applyScopeToCopy — tài khoản + từ ngày, secure_delete), đếm dòng từng bảng, chuyển journal về DELETE
 *     (file tự đủ, không kèm -wal).
 *  3. Nén gzip (stream). Mã hoá + tải lên làm ở main (bất đồng bộ).
 *  Sau khi bản gốc lên R2 và manifest trỏ tới nó: DB sống xoá các dòng bẩn id ≤ H (đã nằm trong bản gốc).
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { CloudScope } from '../../../shared/cloudContracts';
import { getMeta } from './DirtyTracker';
import { ScopeApplyReport, applyScopeToCopy, readAccountNames, resolveScope } from './scope';
import { SqlConn, quoteIdent, tableExists, toNumber } from './sqlConn';
import { schemaFingerprint, selectTables } from './tableSelection';

export interface SnapshotInfo {
    highWater: number;
    /** Số dòng từng bảng SAU khi lọc theo phạm vi. */
    rowCounts: Record<string, number>;
    fingerprint: string;
    dbUid: string | null;
    included: string[];
    unsupported: string[];
    /** Tài khoản còn trong bản sao (id = accounts.zalo_id). */
    accountNames: Array<{ id: string; name: string; channel: string }>;
    /** Kết quả lọc theo phạm vi (null = toàn bộ, không lọc). */
    scopeReport: ScopeApplyReport | null;
}

/** Gọi trên bản sao vừa backup (KHÔNG phải DB sống). scope: phạm vi đồng bộ (thiếu / null = toàn bộ). */
export function prepareSnapshotCopy(copy: SqlConn, opts: { scope?: Partial<CloudScope> | null } = {}): SnapshotInfo {
    const sel = selectTables(copy);
    const fingerprint = schemaFingerprint(copy, sel);
    let highWater = 0;
    if (tableExists(copy, '_cloud_dirty')) {
        const row = copy.prepare('SELECT coalesce(max(id), 0) AS h FROM _cloud_dirty').get();
        highWater = toNumber(row?.h);
        try {
            const seq = copy.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_cloud_dirty'").get();
            highWater = Math.max(highWater, toNumber(seq?.seq));
        } catch { /* không có sqlite_sequence */ }
        copy.exec('DELETE FROM _cloud_dirty');
    }
    const dbUid = getMeta(copy, 'db_uid');
    const scope = resolveScope(opts.scope);
    const scopeReport = scope ? applyScopeToCopy(copy, scope) : null;
    const rowCounts: Record<string, number> = {};
    for (const t of sel.included) {
        rowCounts[t.name] = toNumber(copy.prepare(`SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get()?.n);
    }
    const accountNames = readAccountNames(copy);
    copy.exec('PRAGMA journal_mode = DELETE');
    return {
        highWater, rowCounts, fingerprint, dbUid, included: sel.included.map(t => t.name), unsupported: sel.unsupported,
        accountNames, scopeReport,
    };
}

/** Nén gzip theo luồng. onProgress(byte đã đọc, tổng byte) gọi tối đa 2 lần/giây + một lần khi xong. */
export async function gzipFile(
    src: string, dst: string, level = 6, onProgress?: (done: number, total: number) => void,
): Promise<number> {
    const total = onProgress ? (await fs.promises.stat(src)).size : 0;
    let done = 0;
    let last = 0;
    const report = (force: boolean) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - last < 500) return;
        last = now;
        try { onProgress(done, total); } catch { /* callback lỗi không làm hỏng nén */ }
    };
    const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            done += chunk.length;
            report(false);
            cb(null, chunk);
        },
    });
    await pipeline(fs.createReadStream(src), counter, zlib.createGzip({ level }), fs.createWriteStream(dst));
    report(true);
    return (await fs.promises.stat(dst)).size;
}

export async function gunzipFile(src: string, dst: string): Promise<number> {
    await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dst));
    return (await fs.promises.stat(dst)).size;
}

export async function removeQuietly(...files: string[]): Promise<void> {
    for (const f of files) {
        if (!f) continue;
        try { await fs.promises.rm(f, { force: true }); } catch { /* bỏ qua */ }
    }
}
