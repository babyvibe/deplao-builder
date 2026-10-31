/**
 * dbsync — đồng bộ DB workspace lên Cloudflare R2 (tuỳ chọn, mặc định tắt). Hợp đồng: CloudDbModule (../contracts).
 *
 *  - Một SyncEngine cho mỗi workspace LOCAL có file DB; bucket của máy: deplao-backup-<8 ký tự machineId>.
 *  - Mọi thao tác SQLite chạy trong worker_threads (connection riêng) — main không chờ SQLite lâu.
 *  - 'off' = không trigger (gỡ khi tắt), không hẹn giờ, không worker.
 *  - pauseFor(): bọc thao tác thay file DB (đổi thư mục lưu trữ, đổi/xoá workspace, khôi phục).
 *  - Khôi phục vào workspace đang mở: đóng DB của app → thay file → mở lại NGAY trong cùng một nhịp (DatabaseService
 *    close()/reinitialize() không có await bên trong) → báo renderer 'workspace:switched' để nạp lại. Workspace khác:
 *    chỉ thay file (lần mở sau chạy migration như thường). Không khớp workspace nào → workspace DB trống / workspace mới.
 *  - Phạm vi đồng bộ (tài khoản + từ ngày) THEO WORKSPACE (tài khoản thuộc từng workspace): cloud-settings.json →
 *    db.scopes[workspaceId], thiếu = tất cả. setScope đặt cho workspace local đang mở; chỉ engine của workspace đó chụp
 *    gốc mới theo phạm vi mới (gốc + đoạn cũ trên R2 bị thay như mọi lần chụp gốc). Mỗi engine lọc theo phạm vi của mình.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
    CloudScope, DbSyncMode, DbSyncStatus, DbSyncWorkspaceStatus, RemoteDbCopy, RestoreProgress, RestoreRequest, SyncLogEntry,
} from '../../../shared/cloud/cloudContracts';
import { isAllScope, normalizeScope, sameScope, storageLabel } from '../../../shared/cloud/cloudContracts';
import { CloudError } from '../contracts';
import type { CloudDbModule, R2Client } from '../contracts';
import { cloudflare } from '../CloudflareService';
import { invalidateRestoreGate } from '../restoreGate';
import DatabaseService from '../../database/DatabaseService';
import WorkspaceManager, { Workspace } from '../../../utils/app/WorkspaceManager';
import Logger from '../../../utils/Logger';
import { DbOps, createWorkerOps } from './DbOpsClient';
import type { DbOpsEvent } from './ops';
import { Follower, newFollowState } from './Follow';
import {
    DbIndex, DbManifest, INDEX_KEY, backupBucketName, copyIdOf, dbPrefix, followerKey, followersPrefix, manifestKey, parseCopyId,
    parseIndex, parseManifest,
} from './Manifest';
import { FollowCopyRef, buildRestoredDb, checkPassphrase, isBusyFsError, swapFilesSync, withRetry } from './Restore';
import { StateStore } from './state';
import { EngineContext, Mutex, RECHECK_DELAY_MS, SyncEngine, describeScope, pool, userMessage } from './SyncEngine';
import { rowToEntry } from './syncLog';

const DEFAULT_DB = 'deplao-tool.db';
const FOLLOWERS_REFRESH_MS = 10 * 60_000;
const FOLLOWER_MAX_AGE_MS = 7 * 24 * 3600_000;
const PAUSE_WAIT_MS = 30_000;

// ─── Tiện ích ───────────────────────────────────────────────────────────────

function logLine(level: 'log' | 'warn' | 'error', msg: string): void {
    try {
        if (level === 'error') Logger.error(msg);
        else if (level === 'warn') Logger.warn(msg);
        else Logger.log(msg);
    } catch { /* Logger chưa sẵn sàng */ }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const t = setTimeout(resolve, ms);
        (t as any)?.unref?.();
    });
}

/** true nếu xong trước hạn. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
        (timer as any)?.unref?.();
    });
    const res = await Promise.race([p.then(() => true, () => true), timeout]);
    if (timer) clearTimeout(timer);
    return res;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const x = path.resolve(a);
    const y = path.resolve(b);
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function userDataDir(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('electron').app.getPath('userData');
    } catch {
        return WorkspaceManager.getInstance().getUserDataPath() || process.cwd();
    }
}

/** Cùng nguồn với API / plugin (dev đọc package.json — electron.exe dev mang version cũ). */
function appVersion(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const v = String(require('../../api/runtime').appVersion() || '');
        return v && v !== 'dev' ? v : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/** Mã hoá cục bộ bằng safeStorage (mật khẩu theo dõi khác mật khẩu đồng bộ của máy này). null = không mã hoá được. */
function encryptLocal(value: string): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { safeStorage } = require('electron');
        if (!safeStorage?.isEncryptionAvailable?.()) return null;
        if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
        return safeStorage.encryptString(value).toString('base64');
    } catch {
        return null;
    }
}

function decryptLocal(b64: string | null | undefined): string | null {
    if (!b64) return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { safeStorage } = require('electron');
        return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch {
        return null;
    }
}

function settingsSafe() {
    try {
        return cloudflare.settings.get();
    } catch {
        return null;
    }
}

function currentMode(): DbSyncMode {
    const m = settingsSafe()?.db?.mode;
    return m === 'hourly' || m === 'realtime' ? m : 'off';
}

/** Phạm vi đồng bộ của một workspace trong cấu hình đã đọc (thiếu / sai kiểu = tất cả). */
function scopeIn(s: ReturnType<typeof settingsSafe>, workspaceId: string): CloudScope {
    const scopes = s?.db?.scopes;
    return normalizeScope(scopes && typeof scopes === 'object' ? scopes[workspaceId] : undefined);
}

function scopeOf(workspaceId: string): CloudScope {
    return scopeIn(settingsSafe(), workspaceId);
}

/** Workspace đang mở nếu là workspace local (phạm vi chỉ đặt được cho workspace có DB trên máy này). */
function activeLocalWorkspaceId(): string | null {
    try {
        const id = WorkspaceManager.getInstance().getActiveWorkspaceId();
        return localWorkspaces().some(w => w.id === id) ? id : null;
    } catch {
        return null;
    }
}

function storedPassphrase(): string | null {
    try {
        return cloudflare.settings.getPassphrase() || null;
    } catch {
        return null;
    }
}

function ownBucket(): string {
    const s = cloudflare.settings.get();
    return s.db.bucket || backupBucketName(s.machineId);
}

/** Kho đang chọn (R2 / Google Drive) dùng được — tên hàm giữ từ khi chỉ có Cloudflare. */
function requireConnected(): void {
    const s = cloudflare.storageReady();
    if (!s.ready) throw new CloudError('NOT_CONNECTED', s.reason || 'Chưa kết nối kho lưu.');
}

/** Tên kho đang chọn cho câu báo ("R2" / "Google Drive"). */
function storeName(): string {
    try {
        return storageLabel(cloudflare.storageProvider());
    } catch {
        return 'R2';
    }
}

interface LocalWs {
    ws: Workspace;
    id: string;
    name: string;
    dbPath: string;
}

function localWorkspaces(): LocalWs[] {
    const wm = WorkspaceManager.getInstance();
    return wm.listWorkspaces()
        .filter(w => w.type === 'local')
        .map(w => ({ ws: w, id: w.id, name: w.name, dbPath: wm.resolveDbPath(w.dbPath || DEFAULT_DB) }));
}

// ─── Trạng thái module ──────────────────────────────────────────────────────

const store = new StateStore(() => path.join(userDataDir(), 'cloud-dbsync-state.json'));
const engines = new Map<string, SyncEngine>();
const uidOwners = new Map<string, string>();
const baseLock = new Mutex();
let initialized = false;
let shuttingDown = false;
let pauseDepth = 0;
let restoring = false;
let unsubscribe: (() => void) | null = null;
let bucketPromise: Promise<string> | null = null;
let indexChain: Promise<void> = Promise.resolve();
let followersCache: DbSyncStatus['followers'] = [];
let followersAt = 0;
let followersBusy = false;
let memoryFollowPass: string | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotify = 0;

let mainOps: DbOps | null = null;
function ops(): DbOps {
    if (!mainOps) {
        mainOps = createWorkerOps({ log: m => logLine('warn', m) });
        mainOps.onEvent(onOpsEvent);
    }
    return mainOps;
}

/** Worker phụ cho khôi phục / máy dự phòng — không chặn đồng bộ của các workspace. */
let auxOpsInst: DbOps | null = null;
function auxOps(): DbOps {
    if (!auxOpsInst) auxOpsInst = createWorkerOps({ log: m => logLine('warn', m) });
    return auxOpsInst;
}

function terminateAuxIfIdle(): void {
    if (!auxOpsInst || restoring || follower.isActive() || follower.isBusy()) return;
    void auxOpsInst.terminate(2000);
}

function onOpsEvent(ev: DbOpsEvent): void {
    if (ev?.type === 'progress') {
        for (const e of engines.values()) if (samePath(e.dbPath, ev.dbPath)) e.onSnapshotProgress(ev.phase, ev.done, ev.total);
        return;
    }
    if (ev?.type !== 'dirty') return;
    for (const e of engines.values()) if (samePath(e.dbPath, ev.dbPath)) e.onDirty();
}

function notify(urgent = false): void {
    const fire = () => {
        lastNotify = Date.now();
        try { cloudflare.notifyChanged('db'); } catch { /* bỏ qua */ }
    };
    const now = Date.now();
    if (urgent || now - lastNotify >= 2000) {
        if (notifyTimer) {
            clearTimeout(notifyTimer);
            notifyTimer = null;
        }
        fire();
        return;
    }
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
        notifyTimer = null;
        fire();
    }, Math.max(0, 2000 - (now - lastNotify)));
    (notifyTimer as any)?.unref?.();
}

function ensureBucket(): Promise<string> {
    if (!bucketPromise) {
        const p = (async () => {
            const s = cloudflare.settings.get();
            const name = s.db.bucket || backupBucketName(s.machineId);
            await cloudflare.ensureBucket(name);
            if (s.db.bucket !== name) cloudflare.settings.update(d => { d.db.bucket = name; });
            return name;
        })();
        bucketPromise = p;
        p.catch(() => {
            if (bucketPromise === p) bucketPromise = null;
        });
    }
    return bucketPromise;
}

function claimUid(uid: string, engineId: string): string | null {
    const cur = uidOwners.get(uid);
    if (cur && cur !== engineId && engines.has(cur)) return cur;
    uidOwners.set(uid, engineId);
    return engineId;
}

function releaseUid(engineId: string): void {
    for (const [uid, owner] of uidOwners) if (owner === engineId) uidOwners.delete(uid);
}

/** db-index.json của bucket: danh sách workspace có bản sao (máy mới tìm bản sao không cần List). */
function onBaseDone(_engine: SyncEngine, m: DbManifest, bucket: string): void {
    indexChain = indexChain
        .then(async () => {
            const r2 = cloudflare.r2(bucket);
            const s = cloudflare.settings.get();
            const cur: DbIndex = parseIndex(await r2.getObject(INDEX_KEY))
                || { version: 1, machineId: s.machineId, machineName: s.machineName, updatedAt: 0, workspaces: [] };
            const entry: DbIndex['workspaces'][number] = {
                workspaceUid: m.workspaceUid,
                workspaceName: m.workspaceName,
                manifestKey: manifestKey(m.workspaceUid),
                baseAt: m.base?.at ?? null,
                updatedAt: Date.now(),
                scope: normalizeScope(m.scope),
                accountNames: m.accountNames || [],
            };
            cur.workspaces = [...cur.workspaces.filter(w => w.workspaceUid !== m.workspaceUid), entry];
            cur.machineId = s.machineId;
            cur.machineName = s.machineName;
            cur.updatedAt = Date.now();
            await r2.putObject(INDEX_KEY, JSON.stringify(cur), { contentType: 'application/json' });
        })
        .catch(err => logLine('warn', `[CloudDb] không cập nhật được ${INDEX_KEY}: ${err?.message || err}`));
}

/** Lúc tiến trình app khởi động — chu kỳ đồng bộ tự động chờ STARTUP_QUIET_MS sau mốc này (SyncEngine.scheduleAt). */
const APP_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

const engineCtx: EngineContext = {
    core: cloudflare,
    get ops() { return ops(); },
    state: store,
    mode: currentMode,
    scope: scopeOf,
    ensureBucket,
    appVersion,
    log: logLine,
    notify,
    baseLock,
    now: () => Date.now(),
    appStartedAt: () => APP_STARTED_AT,
    claimUid,
    onBaseDone,
} as EngineContext;

// ─── Engine ─────────────────────────────────────────────────────────────────

/** Khớp danh sách engine với workspace local hiện có (tạo / thay khi đổi đường dẫn / bỏ khi xoá). */
function reconcileEngines(): void {
    if (currentMode() === 'off' || shuttingDown) return;
    const seen = new Set<string>();
    const locals = localWorkspaces();
    // Workspace đã xoá → bỏ trạng thái đồng bộ của nó (bản sao trên R2 vẫn giữ, khôi phục được từ listRemote).
    const known = new Set(locals.map(w => w.id));
    for (const id of store.workspaceIds()) if (!known.has(id)) store.removeWorkspace(id);
    for (const w of locals) {
        if (!fs.existsSync(w.dbPath)) continue; // workspace chưa từng mở → chưa có DB
        seen.add(w.id);
        const cur = engines.get(w.id);
        if (cur && samePath(cur.dbPath, w.dbPath)) {
            cur.updateWorkspace({ id: w.id, name: w.name, dbPath: w.dbPath });
            continue;
        }
        if (cur) {
            engines.delete(w.id);
            releaseUid(w.id);
            void cur.stop(5_000);
        }
        const engine = new SyncEngine({ id: w.id, name: w.name, dbPath: w.dbPath }, engineCtx);
        engines.set(w.id, engine);
        engine.start();
    }
    for (const [id, e] of [...engines]) {
        if (seen.has(id)) continue;
        engines.delete(id);
        releaseUid(id);
        void e.stop(5_000);
    }
}

async function dropTrackingEverywhere(): Promise<void> {
    for (const w of localWorkspaces()) {
        const st = store.hasWorkspace(w.id) ? store.workspace(w.id) : null;
        if (!fs.existsSync(w.dbPath)) continue;
        try {
            await ops().call('dropTracking', { dbPath: w.dbPath });
            if (st) {
                st.trackingInstalled = false;
                st.lastAckedId = 0;
            }
        } catch (err: any) {
            logLine('warn', `[CloudDb] ${w.id}: không gỡ được trigger đồng bộ: ${err?.message || err}`);
        }
    }
    store.flush();
}

async function stopAllEngines(dropTracking: boolean): Promise<void> {
    const list = [...engines.values()];
    engines.clear();
    uidOwners.clear();
    await Promise.all(list.map(e => e.stop(PAUSE_WAIT_MS)));
    if (dropTracking) await dropTrackingEverywhere();
    if (mainOps) await mainOps.terminate();
}

/** Mode 'off' lúc khởi động mà lần trước gỡ trigger dở (app tắt giữa chừng) → gỡ nốt, rồi dừng worker. */
async function cleanupLeftoverTracking(): Promise<void> {
    const pending = localWorkspaces().filter(w => store.hasWorkspace(w.id) && store.workspace(w.id).trackingInstalled);
    if (!pending.length) return;
    await sleep(15_000);
    if (currentMode() !== 'off' || shuttingDown) return;
    await dropTrackingEverywhere();
    if (mainOps && !engines.size) await mainOps.terminate();
}

// ─── Người theo dõi (máy dự phòng) & followers phía máy nguồn ───────────────

function followPassphrase(): string | null {
    const st = store.follow();
    return memoryFollowPass || decryptLocal(st?.passEnc) || storedPassphrase();
}

const follower = new Follower({
    core: cloudflare,
    ops: auxOps,
    state: store,
    dir: () => path.join(userDataDir(), 'cloud-follow'),
    machineId: () => cloudflare.settings.get().machineId,
    machineName: () => cloudflare.settings.get().machineName,
    passphrase: followPassphrase,
    log: logLine,
    notify,
    now: () => Date.now(),
});

async function stopFollowing(deleteCopy: boolean): Promise<void> {
    const st = store.follow();
    await follower.stop();
    if (st) {
        try {
            await cloudflare.r2(st.bucket).deleteObject(followerKey(st.workspaceUid, cloudflare.settings.get().machineId));
        } catch { /* nhịp tim tự cũ đi */ }
        if (deleteCopy) {
            if (auxOpsInst && auxOpsInst.isActive()) {
                await auxOpsInst.call('close', { dbPath: follower.copyPath(st.workspaceUid) }).catch(() => undefined);
            }
            follower.removeCopy(st.workspaceUid);
        }
    }
    store.setFollow(null);
    store.flush();
    memoryFollowPass = null;
    try {
        if (cloudflare.settings.get().db.following) cloudflare.settings.update(d => { d.db.following = null; });
    } catch { /* bỏ qua */ }
    terminateAuxIfIdle();
}

/** Khởi động lại theo dõi đã bật từ phiên trước. */
function resumeFollowing(): void {
    const following = settingsSafe()?.db?.following;
    if (!following) return;
    let st = store.follow();
    if (!st || st.copyId !== following.workspaceId) {
        const ref = parseCopyId(following.workspaceId);
        if (!ref) return;
        st = newFollowState({ copyId: following.workspaceId, bucket: ref.bucket, workspaceUid: ref.uid, sourceMachine: following.sourceMachine, passEnc: null });
        store.setFollow(st);
    }
    follower.start(30_000);
}

/** status() đọc nhịp tim máy dự phòng tối đa 10 phút/lần (List là Class A). */
function maybeRefreshFollowers(): void {
    if (currentMode() === 'off' || followersBusy || !engines.size || Date.now() - followersAt < FOLLOWERS_REFRESH_MS) return;
    const bucket = settingsSafe()?.db?.bucket;
    if (!bucket || !cloudflare.storageReady().ready) return;
    followersBusy = true;
    followersAt = Date.now();
    void (async () => {
        try {
            const r2 = cloudflare.r2(bucket);
            const out: DbSyncStatus['followers'] = [];
            for (const e of engines.values()) {
                const uid = e.workspaceUid;
                if (!uid) continue;
                const res = await r2.listObjects(followersPrefix(uid), { maxKeys: 50 });
                for (const o of res.objects) {
                    const raw = await r2.getObject(o.key);
                    if (!raw) continue;
                    try {
                        const hb = JSON.parse(raw.toString('utf8'));
                        const seenAt = Number(hb?.seenAt) || 0;
                        if (!seenAt || Date.now() - seenAt > FOLLOWER_MAX_AGE_MS) continue;
                        const lag = hb?.lagMs === null || hb?.lagMs === undefined ? null : Number(hb.lagMs);
                        out.push({ machine: String(hb?.machine || hb?.machineId || 'máy dự phòng'), lagMs: Number.isFinite(lag as number) ? lag : null, seenAt });
                    } catch { /* bỏ qua nhịp tim hỏng */ }
                }
            }
            out.sort((a, b) => b.seenAt - a.seenAt);
            const changed = JSON.stringify(out) !== JSON.stringify(followersCache);
            followersCache = out;
            if (changed) notify();
        } catch (err: any) {
            logLine('warn', `[CloudDb] không đọc được danh sách máy dự phòng: ${err?.message || err}`);
        } finally {
            followersBusy = false;
        }
    })();
}

// ─── Bản sao trên R2 ────────────────────────────────────────────────────────

interface ResolvedCopy {
    bucket: string;
    uid: string;
    manifest: DbManifest;
}

async function discoverBuckets(): Promise<string[]> {
    const names = new Set<string>();
    try {
        // R2: bucket của tài khoản; Google Drive: thư mục con của thư mục Deplao
        for (const n of await cloudflare.listBuckets('deplao-backup-')) {
            if (/^deplao-backup-[a-z0-9-]+$/.test(n)) names.add(n);
        }
    } catch (err: any) {
        logLine('warn', `[CloudDb] không liệt kê được bản sao trên ${storeName()} (chỉ xem bản của máy này): ${err?.message || err}`);
        names.add(ownBucket());
    }
    return [...names];
}

/** Mã workspace (cloud_workspace_uid) của một workspace local: engine → trạng thái đã lưu → dò file DB (không tạo). */
async function localWorkspaceUid(id: string): Promise<string | null> {
    const e = engines.get(id);
    let uid = e?.workspaceUid || (store.hasWorkspace(id) ? store.workspace(id).workspaceUid : null);
    if (!uid) {
        const w = localWorkspaces().find(x => x.id === id);
        if (w && fs.existsSync(w.dbPath)) {
            const probe = await auxOps().call<{ workspaceUid: string | null } | null>('probe', { dbPath: w.dbPath }).catch(() => null);
            uid = probe?.workspaceUid || null;
        }
    }
    return uid || null;
}

/** id = "<bucket>/<workspaceUid>" (RemoteDbCopy.workspaceId) hoặc id workspace local (bản sao của chính máy này). */
async function resolveCopy(id: string): Promise<ResolvedCopy> {
    let ref = parseCopyId(id);
    if (!ref) {
        const uid = await localWorkspaceUid(id);
        if (!uid) throw new CloudError('RESTORE_NOT_FOUND', `Không tìm thấy bản sao của workspace này trên ${storeName()}.`);
        ref = { bucket: ownBucket(), uid };
    }
    const r2 = cloudflare.r2(ref.bucket);
    const manifest = parseManifest(await withRetry(() => r2.getObject(manifestKey(ref!.uid))));
    if (!manifest || !manifest.base) throw new CloudError('RESTORE_NOT_FOUND', `Không tìm thấy bản sao này trên ${storeName()} (có thể đã bị xoá).`);
    return { bucket: ref.bucket, uid: ref.uid, manifest };
}

// ─── Xoá bản sao trên R2 ────────────────────────────────────────────────────

/** Mọi khoá dưới prefix (List phân trang — Class A, chỉ dùng cho thao tác người dùng bấm). */
async function listAllKeys(r2: R2Client, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    for (let page = 0; page < 1000; page++) {
        const res = await withRetry(() => r2.listObjects(prefix, { continuationToken: token || undefined, maxKeys: 1000 }));
        for (const o of res.objects) keys.push(o.key);
        token = res.nextToken;
        if (!token) break;
    }
    return keys;
}

/**
 * Xoá nhiều object: DeleteObjects (≤ 1000 khoá/lần) nếu client R2 có — khoá báo lỗi riêng thì thử lại từng object;
 * client không có (bản giả / cũ) → từng object (6 song song).
 */
async function deleteKeys(r2: R2Client, keys: string[]): Promise<void> {
    if (!keys.length) return;
    // Hàm mũi tên thay cho bind (bind mất kiểu khi strictBindCallApply tắt ở tsconfig renderer).
    const multi = typeof r2.deleteObjects === 'function' ? (chunk: string[]) => r2.deleteObjects!(chunk) : null;
    if (!multi) {
        await pool(keys, 6, key => withRetry(() => r2.deleteObject(key)));
        return;
    }
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        const res = await withRetry(() => multi(chunk));
        for (const e of res?.errors || []) if (e?.key) failed.push(e.key);
    }
    if (failed.length) await pool(failed, 6, key => withRetry(() => r2.deleteObject(key)));
}

/** Bỏ mục của bản sao khỏi db-index.json của bucket (xếp hàng chung với onBaseDone). Lỗi chỉ ghi log. */
function removeIndexEntry(bucket: string, uid: string): Promise<void> {
    const run = indexChain.then(async () => {
        const r2 = cloudflare.r2(bucket);
        const cur = parseIndex(await withRetry(() => r2.getObject(INDEX_KEY)));
        if (!cur || !cur.workspaces.some(w => w.workspaceUid === uid)) return;
        cur.workspaces = cur.workspaces.filter(w => w.workspaceUid !== uid);
        cur.updatedAt = Date.now();
        await withRetry(() => r2.putObject(INDEX_KEY, JSON.stringify(cur), { contentType: 'application/json' }));
    });
    const settled = run.catch(err => logLine('warn', `[CloudDb] không cập nhật được ${bucket}/${INDEX_KEY} sau khi xoá bản sao: ${err?.message || err}`));
    indexChain = settled;
    return settled;
}

/** Máy này đang đẩy bản sao (bucket, uid) không: đồng bộ bật + một workspace local có cùng mã workspace. */
async function pushedFromHere(bucket: string, uid: string): Promise<boolean> {
    if (currentMode() === 'off' || bucket !== ownBucket()) return false;
    for (const e of engines.values()) if (e.workspaceUid === uid) return true;
    for (const w of localWorkspaces()) {
        if (!fs.existsSync(w.dbPath)) continue;
        if ((await localWorkspaceUid(w.id)) === uid) return true;
    }
    return false;
}

// ─── Khôi phục ──────────────────────────────────────────────────────────────

async function resolveTargetWorkspace(src: ResolvedCopy): Promise<{ ws: Workspace; created: boolean }> {
    const wm = WorkspaceManager.getInstance();
    const all = wm.listWorkspaces();
    const activeId = wm.getActiveWorkspaceId();
    let empty: Workspace | null = null;
    for (const w of localWorkspaces()) {
        let uid = engines.get(w.id)?.workspaceUid || null;
        let isEmpty = true;
        if (fs.existsSync(w.dbPath)) {
            const probe = await auxOps().call<{ workspaceUid: string | null; empty: boolean } | null>('probe', { dbPath: w.dbPath }).catch(() => null);
            uid = uid || probe?.workspaceUid || null;
            isEmpty = !!probe?.empty;
        }
        // Cùng mã workspace (khôi phục trên chính máy này / làm mới bản đã khôi phục) → thay tại chỗ.
        if (uid && uid === src.uid) return { ws: w.ws, created: false };
        if (isEmpty && (!empty || w.id === activeId)) empty = w.ws;
    }
    // Máy mới: workspace còn trống (ưu tiên workspace đang mở) nhận dữ liệu khôi phục.
    if (empty) return { ws: empty, created: false };
    const base = `${(src.manifest.workspaceName || 'Workspace').slice(0, 40)} (khôi phục)`;
    let name = base;
    for (let i = 2; all.some(w => w.name === name) && i < 100; i++) name = `${base} ${i}`;
    const res = wm.createWorkspace({ name, type: 'local', icon: '☁️' });
    if (!res.success || !res.workspace) {
        throw new CloudError('RESTORE_NO_SLOT', `Không tạo được workspace mới để khôi phục${res.error ? `: ${res.error}` : ''}.`);
    }
    return { ws: res.workspace, created: true };
}

function broadcastWorkspaceReload(ws: Workspace): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('workspace:switched', { workspace: { ...ws } });
        }
    } catch { /* không có cửa sổ */ }
}

async function swapIntoWorkspace(ws: Workspace, dbPath: string, restoredPath: string): Promise<{ active: boolean; backupPath: string }> {
    const backupPath = `${dbPath}.before-restore-${Date.now()}`;
    return cloudDb.pauseFor('restore', async () => {
        const dbs = DatabaseService.getInstance();
        if (samePath(dbs.getDbPath(), dbPath)) {
            // Workspace đang mở: đóng → thay → mở lại trong CÙNG một nhịp (không await xen giữa) — không lệnh DB nào chen vào.
            dbs.close();
            let swapErr: any = null;
            try {
                swapFilesSync(dbPath, restoredPath, backupPath);
            } catch (err) {
                swapErr = err;
            }
            await dbs.reinitialize();
            try { invalidateRestoreGate(); } catch { /* bỏ qua */ }
            if (swapErr) {
                throw new CloudError('RESTORE_SWAP_FAILED', `Không thay được file DB (${swapErr?.code || swapErr?.message || swapErr}) — dữ liệu hiện tại giữ nguyên.`);
            }
            broadcastWorkspaceReload(ws);
            return { active: true, backupPath };
        }
        // Workspace khác: file có thể đang bị relay/nhân viên mở ngắn (DB phụ tự đóng sau 30 s) → thử lại ≤ 40 s.
        const deadline = Date.now() + 40_000;
        for (;;) {
            try {
                swapFilesSync(dbPath, restoredPath, backupPath);
                return { active: false, backupPath };
            } catch (err: any) {
                if (!isBusyFsError(err) || Date.now() > deadline) {
                    throw new CloudError('RESTORE_SWAP_FAILED', `Không thay được file DB của workspace "${ws.name}" (${err?.code || err?.message || err}) — có tiến trình đang mở file, hãy thử lại.`);
                }
                await sleep(2000);
            }
        }
    });
}

// ─── Nhật ký ────────────────────────────────────────────────────────────────

/** Nhật ký của workspace đang mở đọc thẳng qua DB của app (khi chưa có engine, vd đồng bộ đang tắt). */
function readActiveLogDirect(workspaceId: string): SyncLogEntry[] {
    try {
        if (WorkspaceManager.getInstance().getActiveWorkspaceId() !== workspaceId) return [];
        const db = DatabaseService.getInstance();
        const exists = db.queryOne<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_sync_log'");
        if (!exists) return [];
        return db.query<any>('SELECT * FROM cloud_sync_log ORDER BY id DESC LIMIT 500').map(rowToEntry);
    } catch {
        return [];
    }
}

function mergeLogs(sources: SyncLogEntry[][], limit: number): SyncLogEntry[] {
    const nonEmpty = sources.filter(s => s.length);
    const multi = nonEmpty.length > 1;
    const out: SyncLogEntry[] = [];
    nonEmpty.forEach((list, i) => {
        for (const e of list) {
            // Mỗi DB có dãy id riêng → gộp nhiều nguồn thì dời id để không trùng (UI dùng id làm khoá).
            out.push(multi ? { ...e, id: e.id < 0 ? e.id - i * 1e9 : e.id + i * 1e9 } : e);
        }
    });
    out.sort((a, b) => b.at - a.at || b.id - a.id);
    return out.slice(0, limit);
}

// ─── Module ─────────────────────────────────────────────────────────────────

function idleWorkspaceView(w: LocalWs, mode: DbSyncMode, scope: CloudScope): DbSyncWorkspaceStatus {
    const st = store.hasWorkspace(w.id) ? store.workspace(w.id) : null;
    const m = st?.manifest || null;
    const segments = m ? m.segmentPages.reduce((s, p) => s + p.count, 0) + m.segments.length : 0;
    return {
        workspaceId: w.id,
        name: w.name,
        lastSyncAt: st?.lastSyncAt ?? null,
        lastChanges: st?.lastChanges ?? 0,
        baseAt: m?.base?.at ?? null,
        segments,
        bytes: m ? (m.base?.bytes || 0) + (m.segmentsBytes || 0) : 0,
        state: mode === 'off' || pauseDepth > 0 ? 'paused' : 'idle',
        lastError: mode === 'off' ? null : st?.lastError ?? null,
        scope,
    };
}

export const cloudDb: CloudDbModule = {
    async init(): Promise<void> {
        if (initialized) return;
        initialized = true;
        shuttingDown = false;
        try {
            unsubscribe = cloudflare.onChanged(area => {
                if (area !== 'connection') return;
                bucketPromise = null;
                // Kết nối Cloudflare / đăng nhập Google / đổi kho đều báo 'connection'
                if (!cloudflare.storageReady().ready) return;
                // Vừa kết nối lại → thử ngay thay vì chờ hết thời gian lùi do lỗi quyền.
                for (const e of engines.values()) e.recheck(true);
                if (store.follow() && !follower.isActive()) follower.start();
            });
        } catch (err: any) {
            logLine('warn', `[CloudDb] không nghe được thay đổi kết nối: ${err?.message || err}`);
        }
        try {
            if (currentMode() === 'off') void cleanupLeftoverTracking();
            else reconcileEngines();
            resumeFollowing();
        } catch (err: any) {
            logLine('error', `[CloudDb] init lỗi: ${err?.message || err}`);
        }
    },

    status(): DbSyncStatus {
        const s = settingsSafe();
        const mode = currentMode();
        const workspaces: DbSyncWorkspaceStatus[] = [];
        try {
            for (const w of localWorkspaces()) {
                const e = mode !== 'off' ? engines.get(w.id) : undefined;
                const view = e ? e.view() : idleWorkspaceView(w, mode, scopeIn(s, w.id));
                // Mã bản sao (bucket/uid) — giao diện so với RemoteDbCopy.workspaceId để nhận ra bản của chính máy này.
                const uid = e?.workspaceUid ?? (store.hasWorkspace(w.id) ? store.workspace(w.id).workspaceUid : null);
                const bucket = s?.db?.bucket ?? null;
                view.copyId = bucket && uid ? copyIdOf(bucket, uid) : null;
                workspaces.push(view);
            }
        } catch { /* WorkspaceManager chưa sẵn sàng */ }
        maybeRefreshFollowers();
        // Phạm vi chung của trạng thái = phạm vi của workspace local đang mở (workspace nhân viên / không có → tất cả).
        const active = activeLocalWorkspaceId();
        return {
            mode,
            passphraseSet: !!storedPassphrase(),
            bucket: s?.db?.bucket ?? null,
            scope: active ? scopeIn(s, active) : normalizeScope(null),
            workspaces,
            followers: mode === 'off' ? [] : followersCache.slice(),
            following: follower.view(),
        };
    },

    async setMode(mode: DbSyncMode): Promise<DbSyncStatus> {
        if (mode !== 'off' && mode !== 'hourly' && mode !== 'realtime') throw new CloudError('BAD_INPUT', 'Chế độ đồng bộ không hợp lệ.');
        const prev = currentMode();
        if (mode !== 'off') {
            requireConnected();
            if (!storedPassphrase()) throw new CloudError('NO_PASSPHRASE', 'Hãy đặt mật khẩu sao lưu trước khi bật đồng bộ DB.');
            await ensureBucket();
        }
        cloudflare.settings.update(d => { d.db.mode = mode; });
        if (mode === 'off') {
            await stopAllEngines(true);
        } else if (prev === 'off' || !engines.size) {
            reconcileEngines();
        } else {
            for (const e of engines.values()) e.applyMode(RECHECK_DELAY_MS);
        }
        logLine('log', `[CloudDb] chế độ đồng bộ: ${prev} → ${mode}`);
        notify(true);
        return cloudDb.status();
    },

    async setScope(scope: CloudScope): Promise<DbSyncStatus> {
        // Tài khoản thuộc từng workspace (UI chọn tài khoản của workspace đang mở) → phạm vi lưu theo workspace.
        const wsId = activeLocalWorkspaceId();
        if (!wsId) {
            throw new CloudError('NO_LOCAL_WORKSPACE', 'Chỉ đặt được phạm vi đồng bộ cho workspace trên máy này — hãy mở workspace cần đặt.');
        }
        const next = normalizeScope(scope);
        const prev = scopeOf(wsId);
        if (sameScope(prev, next)) return cloudDb.status();
        cloudflare.settings.update(d => {
            const scopes = { ...(d.db.scopes || {}) };
            if (isAllScope(next)) delete scopes[wsId]; // thiếu = tất cả
            else scopes[wsId] = next;
            d.db.scopes = scopes;
        });
        logLine('log', `[CloudDb] ${wsId}: phạm vi đồng bộ ${describeScope(prev)} → ${describeScope(next)}`);
        // Chỉ engine của workspace này chụp gốc mới ngay (gốc + đoạn cũ dọn sau khi gốc mới lên, như mọi lần chụp gốc).
        // Chưa có engine (đồng bộ tắt / workspace chưa có DB) → chu kỳ đầu tự thấy manifest khác phạm vi (rebaseReason).
        engines.get(wsId)?.requestBase('scope');
        notify(true);
        return cloudDb.status();
    },

    async setPassphrase(passphrase: string): Promise<void> {
        const pass = typeof passphrase === 'string' ? passphrase : '';
        if (pass.length < 8) throw new CloudError('PASSPHRASE_WEAK', 'Mật khẩu sao lưu cần ít nhất 8 ký tự.');
        const prev = storedPassphrase();
        cloudflare.settings.setPassphrase(pass);
        if (prev && prev !== pass) {
            // Chuỗi trên R2 mã hoá bằng mật khẩu cũ → chụp gốc mới bằng mật khẩu mới (gốc/đoạn cũ bị dọn sau đó).
            for (const e of engines.values()) e.requestBase('passphrase');
            logLine('log', '[CloudDb] đổi mật khẩu sao lưu → chụp bản gốc mới');
        }
        notify(true);
    },

    async syncNow(): Promise<void> {
        if (currentMode() === 'off') throw new CloudError('DBSYNC_OFF', 'Đồng bộ DB đang tắt — hãy chọn chế độ đồng bộ trước.');
        if (pauseDepth > 0) throw new CloudError('DBSYNC_PAUSED', 'Đang thay dữ liệu workspace — thử lại sau ít giây.');
        requireConnected();
        reconcileEngines();
        const results = await Promise.allSettled([...engines.values()].map(e => e.syncNow()));
        const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed) {
            const err = failed.reason;
            throw err instanceof CloudError ? err : new CloudError(String(err?.code || 'DBSYNC_ERROR'), userMessage(err));
        }
    },

    log(opts?: { workspaceId?: string; limit?: number }): SyncLogEntry[] {
        const limit = Math.max(1, Math.min(2000, Math.floor(Number(opts?.limit) || 200)));
        const sources: SyncLogEntry[][] = [];
        const wsId = opts?.workspaceId;
        const followId = follower.followingCopyId();
        if (wsId) {
            const e = engines.get(wsId);
            if (e) sources.push(e.logs());
            else sources.push(readActiveLogDirect(wsId));
            if (followId && followId === wsId) sources.push(follower.logs());
        } else {
            for (const e of engines.values()) sources.push(e.logs());
            if (!engines.size) {
                try { sources.push(readActiveLogDirect(WorkspaceManager.getInstance().getActiveWorkspaceId())); } catch { /* bỏ qua */ }
            }
            sources.push(follower.logs());
        }
        return mergeLogs(sources, limit);
    },

    async listRemote(): Promise<RemoteDbCopy[]> {
        requireConnected();
        const out: RemoteDbCopy[] = [];
        const own = ownBucket();
        for (const bucket of await discoverBuckets()) {
            const r2 = cloudflare.r2(bucket);
            const uids = new Set<string>();
            try {
                const index = parseIndex(await r2.getObject(INDEX_KEY));
                for (const w of index?.workspaces || []) uids.add(w.workspaceUid);
            } catch (err: any) {
                if (err?.code === 'R2_FORBIDDEN' || err?.code === 'NOT_CONNECTED') throw err;
                if (err?.code !== 'R2_NO_BUCKET') logLine('warn', `[CloudDb] đọc ${bucket}/${INDEX_KEY} lỗi: ${err?.message || err}`);
                if (bucket !== own) continue;
            }
            if (bucket === own) for (const e of engines.values()) if (e.workspaceUid) uids.add(e.workspaceUid);
            for (const uid of uids) {
                let m: DbManifest | null = null;
                try {
                    m = parseManifest(await r2.getObject(manifestKey(uid)));
                } catch (err: any) {
                    logLine('warn', `[CloudDb] đọc manifest ${bucket}/${uid} lỗi: ${err?.message || err}`);
                }
                if (!m || !m.base) continue;
                const copy: RemoteDbCopy = {
                    workspaceId: copyIdOf(bucket, uid),
                    name: m.workspaceName || uid,
                    machine: m.machineName || bucket,
                    appVersion: m.appVersion,
                    schemaFingerprint: m.schemaFingerprint,
                    lastSyncAt: m.lastSyncAt,
                    baseAt: m.base.at,
                    bytes: (m.base.bytes || 0) + (m.segmentsBytes || 0),
                };
                // Manifest cũ không ghi phạm vi = tất cả (để trống — UI hiểu là toàn bộ).
                if (m.scope) copy.scope = normalizeScope(m.scope);
                if (m.accountNames) copy.accountNames = m.accountNames.map(a => ({ id: a.id, name: a.name, channel: a.channel }));
                out.push(copy);
            }
        }
        return out.sort((a, b) => b.lastSyncAt - a.lastSyncAt);
    },

    async deleteRemote(workspaceId: string): Promise<void> {
        requireConnected();
        if (restoring) throw new CloudError('RESTORE_BUSY', 'Đang khôi phục một bản sao — chờ khôi phục xong rồi xoá.');
        const id = String(workspaceId || '');
        let ref = parseCopyId(id);
        let inUse = false;
        try {
            if (!ref) {
                const uid = await localWorkspaceUid(id);
                if (!uid) throw new CloudError('COPY_NOT_FOUND', `Không tìm thấy bản sao của workspace này trên ${storeName()}.`);
                ref = { bucket: ownBucket(), uid };
            }
            inUse = await pushedFromHere(ref.bucket, ref.uid);
        } finally {
            terminateAuxIfIdle(); // dò mã workspace có thể đã bật worker phụ
        }
        const copyId = copyIdOf(ref.bucket, ref.uid);
        if (follower.followingCopyId() === copyId || settingsSafe()?.db?.following?.workspaceId === copyId) {
            throw new CloudError('COPY_FOLLOWED', 'Đang dùng bản này cho máy dự phòng — tắt theo dõi trước');
        }
        if (inUse) {
            throw new CloudError('COPY_IN_USE', 'Bản này đang được đồng bộ từ máy này — tắt đồng bộ trước khi xoá');
        }
        const r2 = cloudflare.r2(ref.bucket);
        const prefix = dbPrefix(ref.uid);
        const mKey = manifestKey(ref.uid);
        // Chỉ <uid>/db/ (gốc, đoạn, trang danh sách đoạn, nhịp tim máy dự phòng) — media <uid>/media/ không đụng tới.
        const keys = await listAllKeys(r2, prefix);
        // Manifest xoá SAU CÙNG: lỗi giữa chừng → bản sao vẫn hiện trong danh sách để bấm xoá lại.
        await deleteKeys(r2, keys.filter(k => k !== mKey));
        // Kiểm lại một lần (xoá nhiều object có thể sót một phần) rồi xoá nốt từng object.
        const left = (await listAllKeys(r2, prefix)).filter(k => k !== mKey);
        if (left.length) await pool(left, 6, key => withRetry(() => r2.deleteObject(key)));
        await withRetry(() => r2.deleteObject(mKey));
        await removeIndexEntry(ref.bucket, ref.uid);
        // Workspace local từng đẩy bản này (đồng bộ đang tắt): bỏ manifest nhớ sẵn → lần bật sau chụp gốc mới, không nối đoạn
        // vào chuỗi đã xoá.
        if (ref.bucket === ownBucket()) {
            for (const wsId of store.workspaceIds()) {
                const st = store.workspace(wsId);
                if (st.workspaceUid !== ref.uid) continue;
                st.manifest = null;
                st.lastAckedId = 0;
            }
            store.save();
        }
        logLine('log', `[CloudDb] đã xoá bản sao ${copyId} trên R2 (${keys.length} object)`);
        notify(true);
    },

    async restore(req: RestoreRequest, onProgress?: (p: RestoreProgress) => void): Promise<{ restoredWorkspaceId: string }> {
        if (restoring) throw new CloudError('RESTORE_BUSY', 'Đang khôi phục một bản sao khác — vui lòng chờ.');
        restoring = true;
        const progress = (p: RestoreProgress) => {
            try { onProgress?.(p); } catch { /* UI */ }
        };
        let createdWsId: string | null = null;
        let workDir: string | null = null;
        let followerHeld = false;
        try {
            requireConnected();
            progress({ step: 'download', percent: 0, message: `Đang đọc bản sao trên ${storeName()}` });
            const src = await resolveCopy(String(req?.workspaceId || ''));
            const copyId = copyIdOf(src.bucket, src.uid);
            const isFollowed = follower.followingCopyId() === copyId;
            const passphrase = (req?.passphrase || '') || (isFollowed ? followPassphrase() : null) || storedPassphrase();
            if (!passphrase) throw new CloudError('PASSPHRASE_REQUIRED', 'Cần nhập mật khẩu sao lưu để khôi phục.');
            if ((await checkPassphrase(cloudflare.crypto, src.manifest, passphrase)) === false) {
                throw new CloudError('BAD_PASSPHRASE', 'Sai mật khẩu sao lưu.');
            }
            const untilTs = req?.untilTs && req.untilTs > 0 ? req.untilTs : null;
            // Máy dự phòng: chuyển sang máy này dùng bản sao theo dõi (không tải lại bản gốc).
            followerHeld = isFollowed && !untilTs;
            const followRef: FollowCopyRef | null = followerHeld ? await follower.prepareSwitchOver() : null;
            const target = await resolveTargetWorkspace(src);
            if (target.created) createdWsId = target.ws.id;
            const dbPath = WorkspaceManager.getInstance().resolveDbPath(target.ws.dbPath || DEFAULT_DB);
            workDir = path.join(path.dirname(dbPath), `.cloud-restore-${Date.now()}`);
            logLine('log', `[CloudDb] khôi phục ${copyId} → workspace ${target.ws.id}${target.created ? ' (mới)' : ''}${untilTs ? ` tới ${new Date(untilTs).toISOString()}` : ''}`);
            const result = await buildRestoredDb(
                { bucket: src.bucket, uid: src.uid, r2: cloudflare.r2(src.bucket), manifest: src.manifest },
                {
                    ops: auxOps(),
                    crypto: cloudflare.crypto,
                    passphrase,
                    workDir,
                    logWorkspaceId: target.ws.id,
                    onProgress: progress,
                    log: m => logLine('warn', m),
                },
                { untilTs, fromFollowCopy: followRef },
            );
            progress({ step: 'swap', percent: 95, message: 'Đang thay dữ liệu workspace' });
            const swap = await swapIntoWorkspace(target.ws, dbPath, result.dbPath);
            createdWsId = null;
            if (followerHeld) {
                // Đã chuyển sang máy này → thôi theo dõi máy nguồn.
                followerHeld = false;
                await stopFollowing(true);
            }
            const warn = result.warnings.length ? ` Lưu ý: ${result.warnings.slice(0, 3).join('; ')}.` : '';
            progress({
                step: 'done',
                percent: 100,
                message: `${swap.active ? 'Đã khôi phục và mở lại dữ liệu (nên khởi động lại ứng dụng).' : 'Đã khôi phục xong.'} `
                    + 'Các kênh cần đăng nhập lại; tự động hoá tạm dừng đến khi bạn xác nhận máy cũ đã tắt.' + warn,
            });
            logLine('log', `[CloudDb] khôi phục xong → ${target.ws.id} (${result.appliedSegments} đoạn, bản cũ: ${path.basename(swap.backupPath)})`);
            notify(true);
            return { restoredWorkspaceId: target.ws.id };
        } catch (err: any) {
            if (createdWsId) {
                try { WorkspaceManager.getInstance().deleteWorkspace(createdWsId); } catch { /* bỏ qua */ }
            }
            const message = userMessage(err);
            logLine('warn', `[CloudDb] khôi phục lỗi: ${err?.message || err}`);
            progress({ step: 'error', percent: 100, message });
            throw err instanceof CloudError ? err : new CloudError(String(err?.code || 'RESTORE_ERROR'), message);
        } finally {
            if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
            restoring = false;
            // Chuyển máy thất bại → máy dự phòng tiếp tục theo dõi như cũ.
            if (followerHeld && store.follow() && follower.isActive()) follower.start(10_000);
            terminateAuxIfIdle();
        }
    },

    async follow(req: { workspaceId: string; on: boolean; passphrase?: string }): Promise<DbSyncStatus> {
        if (!req?.on) {
            await stopFollowing(true);
            notify(true);
            return cloudDb.status();
        }
        requireConnected();
        const src = await resolveCopy(String(req.workspaceId || ''));
        const copyId = copyIdOf(src.bucket, src.uid);
        if (src.bucket === ownBucket()) {
            throw new CloudError('FOLLOW_SELF', 'Đây là bản sao của chính máy này — hãy chọn bản sao của máy khác để làm máy dự phòng.');
        }
        const stored = storedPassphrase();
        const pass = req.passphrase || (follower.followingCopyId() === copyId ? followPassphrase() : null) || stored;
        if (!pass) throw new CloudError('PASSPHRASE_REQUIRED', 'Cần nhập mật khẩu sao lưu của máy nguồn.');
        if ((await checkPassphrase(cloudflare.crypto, src.manifest, pass)) === false) throw new CloudError('BAD_PASSPHRASE', 'Sai mật khẩu sao lưu.');
        // Mật khẩu theo dõi khác mật khẩu đồng bộ của máy này → cất riêng (safeStorage) để nhịp theo dõi tự chạy sau khi mở lại app.
        const passEnc: string | null = pass !== stored ? encryptLocal(pass) : null;
        const prev = store.follow();
        if (prev && prev.copyId !== copyId) await stopFollowing(true);
        if (prev && prev.copyId === copyId) {
            await follower.stop();
            prev.passEnc = passEnc;
            prev.lastError = null;
            store.setFollow(prev);
        } else {
            store.setFollow(newFollowState({ copyId, bucket: src.bucket, workspaceUid: src.uid, sourceMachine: src.manifest.machineName || src.bucket, passEnc }));
        }
        // Không mã hoá được trên máy này → chỉ giữ trong RAM (mở lại app phải nhập lại).
        memoryFollowPass = !passEnc && pass !== stored ? pass : null;
        cloudflare.settings.update(d => { d.db.following = { workspaceId: copyId, sourceMachine: src.manifest.machineName || src.bucket }; });
        follower.start();
        logLine('log', `[CloudDb] bật máy dự phòng cho ${copyId}`);
        notify(true);
        return cloudDb.status();
    },

    async pauseFor<T>(reason: string, fn: () => Promise<T> | T): Promise<T> {
        pauseDepth++;
        if (pauseDepth === 1 && engines.size) {
            logLine('log', `[CloudDb] tạm dừng đồng bộ: ${reason}`);
            const list = [...engines.values()];
            for (const e of list) e.pause();
            notify();
            const idle = await Promise.all(list.map(e => e.idle(PAUSE_WAIT_MS)));
            // Nhả file DB: worker đóng connection (sau khi thao tác dở xong); quá hạn → dừng hẳn worker.
            if (mainOps && mainOps.isActive()) {
                const closed = await within(mainOps.call('closeAll'), idle.every(Boolean) ? PAUSE_WAIT_MS : 5_000);
                if (!closed || !idle.every(Boolean)) await mainOps.terminate(0);
            }
        }
        try {
            return await fn();
        } finally {
            pauseDepth--;
            if (pauseDepth === 0 && !shuttingDown) {
                try {
                    if (currentMode() !== 'off') {
                        reconcileEngines();
                        for (const e of engines.values()) {
                            e.resume();
                            e.recheck();
                        }
                        void Promise.all([...engines.values()].map(e => e.reloadLogs()));
                    }
                } catch (err: any) {
                    logLine('warn', `[CloudDb] tiếp tục đồng bộ sau "${reason}" lỗi: ${err?.message || err}`);
                }
                notify();
            }
        }
    },

    async shutdown(): Promise<void> {
        shuttingDown = true;
        try { unsubscribe?.(); } catch { /* bỏ qua */ }
        unsubscribe = null;
        const list = [...engines.values()];
        for (const e of list) e.pause();
        const followerStop = follower.stop();
        // main.ts cho tối đa ~3 s: không chờ bản gốc đang tải lên (lần mở sau chụp lại), chỉ đóng gọn connection.
        await within(Promise.all([...list.map(e => e.idle(1_500)), followerStop]), 1_500);
        store.flush();
        await Promise.all([
            mainOps ? mainOps.terminate(500) : Promise.resolve(),
            auxOpsInst ? auxOpsInst.terminate(500) : Promise.resolve(),
        ]);
        engines.clear();
        uidOwners.clear();
        initialized = false;
    },
};

export default cloudDb;
