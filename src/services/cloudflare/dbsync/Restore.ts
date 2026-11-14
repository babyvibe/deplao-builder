/**
 * Restore: rebuilds the DB file from the copy on R2 (or from the followed copy of a standby machine).
 *
 *  download manifest → check the password (DPLC1 header in the manifest, nothing downloaded yet) → download + decrypt + decompress the base snapshot
 *  → apply the segments in order (≤ untilTs if set; delete first, upsert after) → rebuild FTS → PRAGMA integrity_check
 *  + compare row counts with the manifest → make safe after restore (postRestore) → file ready to put in place of the real DB.
 *
 * Swapping the file into the workspace (closing/opening the app's DB) is in index.ts: this file does not touch Electron/DatabaseService
 * so the tests can run with a fake R2 + real encryption.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RestoreProgress } from '../../../shared/cloud/cloudContracts';
import { CloudError } from '../contracts';
import { storeLabelNow } from '../storeLabel';
import type { CloudCrypto, R2Client } from '../contracts';
import type { DbOps } from './DbOpsClient';
import { DbManifest, ManifestSegment, loadAllSegments, segmentsUntil } from './Manifest';
import type { PostRestoreInfo, PostRestoreReport } from './postRestore';
import type { VerifyResult } from './restoreDb';
import type { ApplyStats } from './Segment';

export interface RestoreSource {
    bucket: string;
    uid: string;
    r2: R2Client;
    manifest: DbManifest;
}

export interface BuildRestoreDeps {
    ops: DbOps;
    crypto: CloudCrypto;
    passphrase: string;
    /** Working folder (ideally on the same drive as the target DB, so the file can be replaced with a rename). */
    workDir: string;
    /** workspaceId written to the 'restore' log row of the restored copy. */
    logWorkspaceId: string;
    onProgress?: (p: RestoreProgress) => void;
    now?: () => number;
    log?: (msg: string) => void;
    /** Source machine info written to app_settings.cloud_restore_source. */
    sourceMachineId?: string;
}

export interface FollowCopyRef {
    path: string;
    baseKey: string;
    /** Number of first segments (in manifest order) already applied to the followed copy. */
    appliedCount: number;
}

export interface BuildRestoreOptions {
    untilTs?: number | null;
    fromFollowCopy?: FollowCopyRef | null;
}

export interface BuildRestoreResult {
    dbPath: string;
    appliedSegments: number;
    downloadedBytes: number;
    lastAppliedAt: number | null;
    verify: VerifyResult;
    report: PostRestoreReport;
    warnings: string[];
    usedFollowCopy: boolean;
}

const RETRYABLE = new Set(['R2_BUSY', 'R2_NETWORK', 'R2_TIMEOUT']);

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    let lastErr: any = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            if (!RETRYABLE.has(String(err?.code || '')) || i === attempts - 1) throw err;
            const wait = Math.min(30_000, Math.max(Number(err?.retryAfterMs) || 0, 2000 * 2 ** i));
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr;
}

function fmtTime(ts: number): string {
    try {
        return new Date(ts).toLocaleString('vi-VN');
    } catch {
        return new Date(ts).toISOString();
    }
}

/** Is the password correct for this copy chain? (reads the DPLC1 header stored in the manifest; no data is downloaded). */
export async function checkPassphrase(crypto: CloudCrypto, m: DbManifest, passphrase: string): Promise<boolean | null> {
    if (!m.passCheck) return null;
    try {
        return await crypto.verifyPassphrase(Buffer.from(m.passCheck, 'base64'), passphrase);
    } catch {
        return false;
    }
}

export async function buildRestoredDb(src: RestoreSource, deps: BuildRestoreDeps, opts: BuildRestoreOptions = {}): Promise<BuildRestoreResult> {
    const now = deps.now || Date.now;
    const startedAt = now();
    const progress = (step: RestoreProgress['step'], percent: number, message?: string) => {
        try { deps.onProgress?.({ step, percent: Math.max(0, Math.min(100, Math.round(percent))), message }); } catch { /* UI */ }
    };
    const m = src.manifest;
    if (!m.base) throw new CloudError('RESTORE_NO_BASE', 'Bản sao này chưa có bản gốc — chưa khôi phục được.');
    const untilTs = opts.untilTs && opts.untilTs > 0 ? opts.untilTs : null;
    if (untilTs && m.base.at > untilTs) {
        throw new CloudError('RESTORE_TOO_EARLY', `Bản gốc gần nhất được tạo lúc ${fmtTime(m.base.at)} — không khôi phục được về thời điểm sớm hơn.`);
    }
    const pass = await checkPassphrase(deps.crypto, m, deps.passphrase);
    if (pass === false) throw new CloudError('BAD_PASSPHRASE', 'Sai mật khẩu sao lưu.');

    await fs.promises.mkdir(deps.workDir, { recursive: true });
    const dbPath = path.join(deps.workDir, 'restored.db');
    const warnings: string[] = [];
    let downloaded = 0;

    progress('download', 1, 'Đang đọc danh sách thay đổi');
    const all: ManifestSegment[] = await withRetry(() => loadAllSegments(src.r2, m));
    const segs = segmentsUntil(all, untilTs);

    let startIndex = 0;
    const follow = opts.fromFollowCopy && !untilTs && opts.fromFollowCopy.baseKey === m.base.key
        && opts.fromFollowCopy.appliedCount <= segs.length && fs.existsSync(opts.fromFollowCopy.path)
        ? opts.fromFollowCopy
        : null;
    if (follow) {
        progress('download', 10, 'Dùng bản sao theo dõi có sẵn trên máy');
        await fs.promises.copyFile(follow.path, dbPath);
        startIndex = follow.appliedCount;
    } else {
        progress('download', 3, 'Đang tải bản gốc');
        const encPath = path.join(deps.workDir, 'base.dplc');
        const got = await withRetry(() => src.r2.getObjectToFile(m.base!.key, encPath));
        if (!got) throw new CloudError('RESTORE_MISSING', `Không tìm thấy bản gốc trên ${storeLabelNow()} (có thể vừa được thay bằng bản mới) — hãy thử lại.`);
        downloaded += got.size;
        progress('decrypt', 40, 'Đang giải mã bản gốc');
        const gzPath = path.join(deps.workDir, 'base.db.gz');
        await deps.crypto.decryptFile(encPath, gzPath, deps.passphrase);
        await fs.promises.rm(encPath, { force: true });
        await deps.ops.call('gunzipFile', { src: gzPath, dst: dbPath });
        await fs.promises.rm(gzPath, { force: true });
    }

    progress('apply', 50, 'Đang áp các thay đổi');
    await deps.ops.call('restorePrepare', { dbPath });
    const touched: Record<string, number> = {};
    let applied = 0;
    let lastAppliedAt: number | null = startIndex > 0 ? segs[startIndex - 1].at : m.base.at;
    const todo = segs.slice(startIndex);
    const BATCH = 4;
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const bodies = await Promise.all(batch.map(s => withRetry(() => src.r2.getObject(s.key))));
        for (let j = 0; j < batch.length; j++) {
            const body = bodies[j];
            if (!body) throw new CloudError('RESTORE_MISSING', `Thiếu đoạn thay đổi ${batch[j].key} trên ${storeLabelNow()} — hãy thử lại sau ít phút.`);
            downloaded += body.length;
            const gz = await deps.crypto.decryptBuffer(body, deps.passphrase);
            const stats = await deps.ops.call<ApplyStats>('applySegment', { dbPath, gz });
            for (const [t, n] of Object.entries(stats.tables || {})) touched[t] = (touched[t] || 0) + Number(n || 0);
            applied++;
            lastAppliedAt = batch[j].at;
        }
        progress('apply', 50 + 35 * ((i + batch.length) / Math.max(1, todo.length)));
    }

    progress('verify', 86, 'Đang kiểm tra toàn vẹn dữ liệu');
    const res = await deps.ops.call<{ fts: { warnings: string[] }; verify: VerifyResult }>('restoreVerify', {
        dbPath,
        // Followed copy: it is not known how many rows per table were applied before → only the integrity check runs.
        expect: follow ? {} : { rowCounts: m.rowCounts, touched },
    });
    const verify = res.verify;
    for (const w of res.fts?.warnings || []) warnings.push(`FTS: ${w}`);
    if (!verify.integrityOk) {
        await deps.ops.call('close', { dbPath }).catch(() => undefined);
        throw new CloudError('RESTORE_CORRUPT', `Bản khôi phục không qua kiểm tra toàn vẹn (${verify.integrity[0] || 'lỗi'}) — đã huỷ, DB hiện tại giữ nguyên.`);
    }
    const fatal = verify.mismatches.filter(x => x.actual < 0 || (x.expected > 0 && x.actual === 0 && x.tolerance < x.expected));
    if (fatal.length) {
        await deps.ops.call('close', { dbPath }).catch(() => undefined);
        throw new CloudError('RESTORE_MISMATCH', `Bản khôi phục thiếu dữ liệu ở bảng ${fatal.map(x => x.table).join(', ')} — đã huỷ, DB hiện tại giữ nguyên.`);
    }
    for (const x of verify.mismatches) warnings.push(`Số dòng ${x.table}: ${x.actual} (gốc ${x.expected}, cho phép lệch ${x.tolerance})`);
    if (warnings.length) deps.log?.(`[CloudDb] Khôi phục: ${warnings.join('; ')}`);

    progress('verify', 92, 'Đang gỡ phiên đăng nhập cũ khỏi bản khôi phục');
    const totalRows = Object.values(verify.counts).reduce((s, n) => s + (Number(n) || 0), 0);
    const info: PostRestoreInfo = {
        source: {
            bucket: src.bucket,
            workspaceUid: src.uid,
            machineId: deps.sourceMachineId || m.machineId,
            machineName: m.machineName,
            baseAt: m.base.at,
            untilTs,
            appliedSegments: startIndex + applied,
        },
        restoredAt: now(),
        logEntry: {
            workspaceId: deps.logWorkspaceId,
            at: startedAt,
            endAt: now(),
            kind: 'restore',
            pushes: applied + (follow ? 0 : 1),
            rows: totalRows,
            bytes: downloaded,
            durationMs: Math.max(0, now() - startedAt),
            result: 'ok',
            error: null,
        },
    };
    const report = await deps.ops.call<PostRestoreReport>('postRestore', { dbPath, info });
    await deps.ops.call('close', { dbPath });
    return {
        dbPath,
        appliedSegments: startIndex + applied,
        downloadedBytes: downloaded,
        lastAppliedAt,
        verify,
        report,
        warnings,
        usedFollowCopy: !!follow,
    };
}

// ─── Thay file ──────────────────────────────────────────────────────────────

const SIDECARS = ['-wal', '-shm', '-journal'];

function moveFileSync(src: string, dst: string): void {
    try {
        fs.renameSync(src, dst);
    } catch (err: any) {
        if (err?.code !== 'EXDEV') throw err;
        fs.copyFileSync(src, dst);
        fs.rmSync(src, { force: true });
    }
}

/**
 * Replace the DB at dbPath with restoredPath (synchronous: called between closing and reopening the app's DB, with no await in between).
 * The old DB is renamed to backupPath (with -wal/-shm if they still exist, so the old copy can be reopened); if an error happens midway → put the old DB back in place.
 */
export function swapFilesSync(dbPath: string, restoredPath: string, backupPath: string): void {
    const had = fs.existsSync(dbPath);
    if (had) fs.renameSync(dbPath, backupPath); // Windows: a connection is still open → EBUSY/EPERM, nothing changed yet
    const movedSidecars: string[] = [];
    try {
        for (const sfx of SIDECARS) {
            const p = dbPath + sfx;
            if (!fs.existsSync(p)) continue;
            if (had) {
                fs.renameSync(p, backupPath + sfx);
                movedSidecars.push(sfx);
            } else {
                fs.rmSync(p, { force: true });
            }
        }
        moveFileSync(restoredPath, dbPath);
    } catch (err) {
        if (had && !fs.existsSync(dbPath)) {
            try { fs.renameSync(backupPath, dbPath); } catch { /* keep the backup */ }
            for (const sfx of movedSidecars) {
                try { fs.renameSync(backupPath + sfx, dbPath + sfx); } catch { /* ignore */ }
            }
        }
        throw err;
    }
}

export function isBusyFsError(err: any): boolean {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(String(err?.code || ''));
}
