/**
 * Restore — dựng lại file DB từ bản sao trên R2 (hoặc từ bản sao theo dõi của máy dự phòng).
 *
 *  tải manifest → kiểm mật khẩu (header DPLC1 trong manifest, chưa tải gì) → tải + giải mã + giải nén bản gốc
 *  → áp lần lượt các đoạn (≤ untilTs nếu có; xoá trước, upsert sau) → dựng lại FTS → PRAGMA integrity_check
 *  + so số dòng với manifest → an toàn sau khôi phục (postRestore) → file sẵn sàng thay vào chỗ DB thật.
 *
 * Phần thay file vào workspace (đóng/mở DB của app) nằm ở index.ts — file này không đụng Electron/DatabaseService
 * để test chạy được với R2 giả + mã hoá thật.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RestoreProgress } from '../../../shared/cloudContracts';
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
    /** Thư mục làm việc (nên cùng ổ với DB đích để thay file bằng rename). */
    workDir: string;
    /** workspaceId ghi vào dòng nhật ký 'restore' của bản khôi phục. */
    logWorkspaceId: string;
    onProgress?: (p: RestoreProgress) => void;
    now?: () => number;
    log?: (msg: string) => void;
    /** Thông tin máy nguồn ghi vào app_settings.cloud_restore_source. */
    sourceMachineId?: string;
}

export interface FollowCopyRef {
    path: string;
    baseKey: string;
    /** Số đoạn đầu (theo thứ tự manifest) đã áp lên bản sao theo dõi. */
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

/** Mật khẩu đúng với chuỗi bản sao này không (đọc header DPLC1 lưu trong manifest — không tải dữ liệu). */
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
        // Bản sao theo dõi: không biết đã áp bao nhiêu dòng mỗi bảng trước đó → chỉ kiểm tra toàn vẹn.
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
 * Thay DB tại dbPath bằng restoredPath (đồng bộ — gọi giữa lúc đóng và mở lại DB của app, không có await xen giữa).
 * DB cũ đổi tên thành backupPath (kèm -wal/-shm nếu còn, để bản cũ mở lại được); lỗi giữa chừng → trả DB cũ về chỗ.
 */
export function swapFilesSync(dbPath: string, restoredPath: string, backupPath: string): void {
    const had = fs.existsSync(dbPath);
    if (had) fs.renameSync(dbPath, backupPath); // Windows: còn connection mở → EBUSY/EPERM, chưa đổi gì
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
            try { fs.renameSync(backupPath, dbPath); } catch { /* giữ bản backup */ }
            for (const sfx of movedSidecars) {
                try { fs.renameSync(backupPath + sfx, dbPath + sfx); } catch { /* bỏ qua */ }
            }
        }
        throw err;
    }
}

export function isBusyFsError(err: any): boolean {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(String(err?.code || ''));
}
