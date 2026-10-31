/**
 * Follow — chế độ máy dự phòng: giữ bản sao CHỈ ĐỌC của một workspace máy khác tại
 * userData/cloud-follow/<workspaceUid>.db. Tải bản gốc một lần; mỗi 60 s đọc manifest (Class B) và áp các đoạn mới;
 * ghi nhịp tim <uid>/db/followers/<machineId>.json {machine, lagMs, seenAt} mỗi 5 phút (Class A — thưa).
 * Máy nguồn chụp gốc mới → tải lại gốc. Chuyển sang máy này = khôi phục từ bản sao theo dõi (không phải tải lại).
 * Không đụng DB đang dùng của app; mọi thao tác SQLite chạy trên worker phụ.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SyncLogEntry } from '../../../shared/cloud/cloudContracts';
import { CloudError } from '../contracts';
import type { CloudflareCore, R2Client } from '../contracts';
import { storeLabelNow } from '../storeLabel';
import type { DbOps } from './DbOpsClient';
import { DbManifest, ManifestSegment, followerKey, loadAllSegments, manifestKey, parseManifest } from './Manifest';
import { FollowCopyRef, checkPassphrase, withRetry } from './Restore';
import type { ApplyStats } from './Segment';
import type { FollowState, StateStore } from './state';

export const FOLLOW_INTERVAL_MS = 60_000;
export const FOLLOW_MAX_BACKOFF_MS = 5 * 60_000;
export const HEARTBEAT_MS = 5 * 60_000;
const FOLLOW_LOG_KEEP = 200;

export interface FollowContext {
    core: CloudflareCore;
    ops: () => DbOps;
    state: StateStore;
    /** Thư mục userData/cloud-follow. */
    dir: () => string;
    machineId(): string;
    machineName(): string;
    /** Mật khẩu để giải mã bản sao đang theo dõi (null = chưa có). */
    passphrase(): string | null;
    log(level: 'log' | 'warn' | 'error', msg: string): void;
    notify(urgent?: boolean): void;
    now(): number;
}

function safeFileName(s: string): string {
    return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'copy';
}

function startOfLocalHour(ts: number): number {
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}

export function newFollowState(p: { copyId: string; bucket: string; workspaceUid: string; sourceMachine: string; passEnc: string | null }): FollowState {
    return {
        copyId: p.copyId,
        bucket: p.bucket,
        workspaceUid: p.workspaceUid,
        sourceMachine: p.sourceMachine,
        baseKey: null,
        appliedCount: 0,
        lastAppliedKey: null,
        appliedUpTo: null,
        lastCheckAt: null,
        lastHeartbeatAt: null,
        lagMs: null,
        pendingSince: null,
        logSeq: 0,
        passEnc: p.passEnc,
        lastError: null,
        log: [],
    };
}

export class Follower {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running: Promise<void> | null = null;
    private active = false;
    private held = false;
    private failures = 0;
    private readonly pageCache = new Map<string, ManifestSegment[]>();

    constructor(private readonly ctx: FollowContext) {}

    private get st(): FollowState | null {
        return this.ctx.state.follow();
    }

    isActive(): boolean {
        return this.active;
    }

    isBusy(): boolean {
        return !!this.running;
    }

    followingCopyId(): string | null {
        return this.st?.copyId ?? null;
    }

    copyPath(uid?: string): string | null {
        const u = uid ?? this.st?.workspaceUid;
        return u ? path.join(this.ctx.dir(), `${safeFileName(u)}.db`) : null;
    }

    /** Bắt đầu / tiếp tục theo dõi theo trạng thái đã lưu (lần chạy đầu sau ~2 s). */
    start(firstDelayMs = 2_000): void {
        if (!this.st) return;
        this.active = true;
        this.held = false;
        this.schedule(firstDelayMs);
    }

    /** Dừng hẳn (chờ nhịp đang chạy tối đa 30 s). Không xoá trạng thái — index.ts quyết định. */
    async stop(): Promise<void> {
        this.active = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.running) {
            await Promise.race([this.running.catch(() => undefined), new Promise(r => setTimeout(r, 30_000))]);
        }
    }

    view(): { workspaceId: string; sourceMachine: string; lagMs: number | null } | null {
        const st = this.st;
        if (!st) return null;
        const now = this.ctx.now();
        let lagMs: number | null = null;
        if (st.pendingSince) lagMs = Math.max(0, now - st.pendingSince);
        else if (st.lastCheckAt) lagMs = Math.max(0, now - st.lastCheckAt);
        return { workspaceId: st.copyId, sourceMachine: st.sourceMachine, lagMs };
    }

    logs(): SyncLogEntry[] {
        return (this.st?.log || []).slice();
    }

    private schedule(delayMs: number): void {
        if (!this.active || this.held) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick().catch(() => undefined).finally(() => {
                if (!this.active) return;
                const delay = this.failures > 0
                    ? Math.min(FOLLOW_MAX_BACKOFF_MS, FOLLOW_INTERVAL_MS * 2 ** Math.min(3, this.failures - 1))
                    : FOLLOW_INTERVAL_MS;
                this.schedule(delay);
            });
        }, Math.max(0, delayMs));
        (this.timer as any)?.unref?.();
    }

    /** Một nhịp theo dõi (tuần tự — gọi chồng thì dùng chung nhịp đang chạy). */
    tick(): Promise<void> {
        if (this.running) return this.running;
        const p = this.doTick().finally(() => {
            if (this.running === p) this.running = null;
        });
        this.running = p;
        return p;
    }

    /**
     * Chuẩn bị chuyển sang máy này: dừng lịch, chạy một nhịp cuối (bỏ qua lỗi mạng), trả về bản sao đã có để khôi phục.
     * null = chưa có bản sao dùng được (khôi phục sẽ tải từ R2).
     */
    async prepareSwitchOver(): Promise<FollowCopyRef | null> {
        const st = this.st;
        if (!st) return null;
        // Giữ lịch: không nhịp nào ghi vào bản sao trong lúc khôi phục chép nó (start() nhả ra).
        this.held = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            await this.tick();
        } catch (err: any) {
            this.ctx.log('warn', `[CloudDb] Theo dõi: nhịp cuối trước khi chuyển máy lỗi: ${err?.message || err}`);
        }
        const cur = this.st;
        const file = this.copyPath();
        if (!cur || !cur.baseKey || !file || !fs.existsSync(file)) return null;
        return { path: file, baseKey: cur.baseKey, appliedCount: cur.appliedCount };
    }

    /** Xoá file bản sao theo dõi (khi tắt theo dõi / đổi nguồn). */
    removeCopy(uid?: string): void {
        const file = this.copyPath(uid);
        if (!file) return;
        for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
            try { fs.rmSync(f, { force: true }); } catch { /* bỏ qua */ }
        }
    }

    // ─── Nhịp theo dõi ────────────────────────────────────────────────────────

    private async doTick(): Promise<void> {
        const st = this.st;
        if (!st) return;
        const started = this.ctx.now();
        let applied = 0;
        let bytes = 0;
        try {
            const passphrase = this.ctx.passphrase();
            if (!passphrase) throw new CloudError('PASSPHRASE_REQUIRED', 'Cần nhập lại mật khẩu sao lưu của máy nguồn để tiếp tục theo dõi.');
            const r2 = this.ctx.core.r2(st.bucket);
            const m = parseManifest(await withRetry(() => r2.getObject(manifestKey(st.workspaceUid))));
            if (!m || !m.base) throw new CloudError('FOLLOW_NO_COPY', `Máy nguồn chưa có bản sao trên ${storeLabelNow()}.`);
            if (m.machineName) st.sourceMachine = m.machineName;
            const copy = this.copyPath(st.workspaceUid) as string;

            if (st.baseKey !== m.base.key || !fs.existsSync(copy)) {
                if ((await checkPassphrase(this.ctx.core.crypto, m, passphrase)) === false) {
                    throw new CloudError('BAD_PASSPHRASE', 'Mật khẩu sao lưu của máy nguồn đã đổi — hãy bật lại máy dự phòng với mật khẩu mới.');
                }
                bytes += await this.downloadBase(r2, m, passphrase, copy);
                st.baseKey = m.base.key;
                st.appliedCount = 0;
                st.lastAppliedKey = null;
                st.appliedUpTo = m.base.at;
                this.pageCache.clear();
                this.ctx.state.save();
            }

            const all = await withRetry(() => loadAllSegments(r2, m, this.pageCache));
            if (st.appliedCount > all.length || (st.appliedCount > 0 && all[st.appliedCount - 1]?.key !== st.lastAppliedKey)) {
                // Chuỗi trên R2 không còn khớp phần đã áp (hiếm: manifest bị ghi lại) → nhịp sau tải lại bản gốc.
                st.baseKey = null;
                this.ctx.state.save();
                throw new CloudError('FOLLOW_RESYNC', 'Bản sao nguồn vừa thay đổi cấu trúc — sẽ tải lại bản gốc.');
            }
            const pending = all.slice(st.appliedCount);
            if (pending.length) {
                await this.ctx.ops().call('restorePrepare', { dbPath: copy });
                try {
                    for (const seg of pending) {
                        if (!this.active) break; // vừa tắt theo dõi
                        const body = await withRetry(() => r2.getObject(seg.key));
                        if (!body) throw new CloudError('FOLLOW_MISSING', `Thiếu đoạn thay đổi trên ${storeLabelNow()} (máy nguồn vừa chụp gốc mới?) — sẽ thử lại.`);
                        const gz = await this.ctx.core.crypto.decryptBuffer(body, passphrase);
                        await this.ctx.ops().call<ApplyStats>('applySegment', { dbPath: copy, gz });
                        st.appliedCount++;
                        st.lastAppliedKey = seg.key;
                        st.appliedUpTo = seg.at;
                        applied++;
                        bytes += body.length;
                        this.ctx.state.save();
                    }
                } finally {
                    await this.ctx.ops().call('close', { dbPath: copy }).catch(() => undefined);
                }
            }
            const now = this.ctx.now();
            st.lastCheckAt = now;
            st.pendingSince = st.appliedCount < all.length ? all[st.appliedCount].at : null;
            st.lagMs = st.pendingSince ? Math.max(0, now - st.pendingSince) : 0;
            st.lastError = null;
            const hadFailures = this.failures > 0;
            this.failures = 0;
            if (!st.lastHeartbeatAt || now - st.lastHeartbeatAt >= HEARTBEAT_MS) {
                try {
                    const hb = { machine: this.ctx.machineName(), machineId: this.ctx.machineId(), lagMs: st.lagMs, seenAt: now };
                    await r2.putObject(followerKey(st.workspaceUid, this.ctx.machineId()), JSON.stringify(hb), { contentType: 'application/json' });
                    st.lastHeartbeatAt = now;
                } catch (err: any) {
                    this.ctx.log('warn', `[CloudDb] Theo dõi: không ghi được nhịp tim: ${err?.message || err}`);
                }
            }
            if (applied > 0 || bytes > 0 || hadFailures) this.logTick(started, applied, bytes, hadFailures ? 'retried' : 'ok', null);
            this.ctx.state.save();
            this.ctx.notify(hadFailures);
        } catch (err: any) {
            this.failures++;
            const message = String(err?.message || err);
            st.lastError = message;
            this.logTick(started, applied, bytes, 'error', message);
            this.ctx.state.save();
            this.ctx.log('warn', `[CloudDb] Theo dõi bản sao ${st.copyId} lỗi: ${message}`);
            if (this.failures === 2 || err?.code === 'BAD_PASSPHRASE') this.ctx.notify(true);
            throw err;
        }
    }

    /** Tải + giải mã + giải nén bản gốc vào thư mục tạm rồi thay file bản sao theo dõi. Trả số byte đã tải. */
    private async downloadBase(r2: R2Client, m: DbManifest, passphrase: string, copyPath: string): Promise<number> {
        const dir = this.ctx.dir();
        const work = path.join(dir, `.dl-${safeFileName(m.workspaceUid)}-${this.ctx.now()}`);
        await fs.promises.mkdir(work, { recursive: true });
        try {
            const enc = path.join(work, 'base.dplc');
            const gz = path.join(work, 'base.db.gz');
            const db = path.join(work, 'base.db');
            const got = await withRetry(() => r2.getObjectToFile(m.base!.key, enc));
            if (!got) throw new CloudError('FOLLOW_MISSING', `Không tìm thấy bản gốc của máy nguồn trên ${storeLabelNow()} — sẽ thử lại.`);
            await this.ctx.core.crypto.decryptFile(enc, gz, passphrase);
            await fs.promises.rm(enc, { force: true });
            await this.ctx.ops().call('gunzipFile', { src: gz, dst: db });
            await fs.promises.rm(gz, { force: true });
            // Bản sao không ghi _cloud_dirty: gỡ trigger/bảng theo dõi chụp kèm bản gốc.
            await this.ctx.ops().call('restorePrepare', { dbPath: db });
            await this.ctx.ops().call('close', { dbPath: db });
            await this.ctx.ops().call('close', { dbPath: copyPath }).catch(() => undefined);
            for (const sfx of ['-wal', '-shm', '-journal']) {
                try { fs.rmSync(copyPath + sfx, { force: true }); } catch { /* bỏ qua */ }
            }
            fs.renameSync(db, copyPath);
            return got.size;
        } finally {
            await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private logTick(at: number, applied: number, bytes: number, result: SyncLogEntry['result'], error: string | null): void {
        const st = this.st;
        if (!st) return;
        const now = this.ctx.now();
        const hourStart = startOfLocalHour(now);
        const last = st.log[0];
        // Gộp theo giờ như realtime: một dòng 'follow' mỗi giờ.
        if (last && startOfLocalHour(last.at) === hourStart) {
            last.endAt = now;
            last.pushes += applied;
            last.bytes += bytes;
            last.durationMs += Math.max(0, now - at);
            if (result === 'error') {
                last.result = 'error';
                last.error = error;
            } else if (last.result === 'error' || last.result === 'retried' || result === 'retried') {
                last.result = 'retried';
            }
        } else {
            st.logSeq = (st.logSeq || 0) + 1;
            st.log.unshift({
                id: -st.logSeq,
                workspaceId: st.copyId,
                at,
                endAt: now,
                kind: 'follow',
                pushes: applied,
                rows: 0,
                bytes,
                durationMs: Math.max(0, now - at),
                result,
                error,
            });
            if (st.log.length > FOLLOW_LOG_KEEP) st.log.length = FOLLOW_LOG_KEEP;
        }
    }
}
