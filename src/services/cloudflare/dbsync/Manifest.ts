/**
 * Manifest — bố cục bản sao DB trên R2 (một bản sao cho mỗi workspace, trong bucket của máy nguồn):
 *
 *   db-index.json                                   danh sách workspace có bản sao trong bucket (máy mới tìm bản sao)
 *   <workspaceUid>/db/manifest.json                 manifest (JSON thường, không bí mật), ghi đè sau mỗi lần đẩy
 *   <workspaceUid>/db/base-<ts>.dplc                bản gốc: SQLite → gzip → DPLC1
 *   <workspaceUid>/db/seg-<fromId>-<toId>-<ts>.dplc đoạn thay đổi: JSONL → gzip → DPLC1
 *   <workspaceUid>/db/segpage-<baseAt>-<n>.json     trang danh sách đoạn cũ (bất biến) — manifest chỉ giữ phần đuôi
 *   <workspaceUid>/db/followers/<machineId>.json    nhịp tim của máy dự phòng {machine, lagMs, seenAt}
 *
 * Phân trang danh sách đoạn: chế độ realtime có thể đẩy hàng nghìn đoạn/ngày — manifest ghi lại sau MỖI lần đẩy nên
 * chỉ giữ ≤ 2×SEGMENT_PAGE_SIZE đoạn mới nhất; phần cũ chuyển sang trang bất biến (một lần ghi mỗi 500 đoạn).
 *
 * Phạm vi (tài khoản + từ ngày): manifest + mục db-index ghi phạm vi của bản gốc và tên các tài khoản có trong bản sao.
 * Manifest cũ không ghi = tất cả. Phạm vi hiện tại khác phạm vi trong manifest → chụp gốc mới (rebaseReason).
 * (Chỉ dùng ở main — import cloudContracts lúc chạy được; worker không nạp file này.)
 */
import type { R2Client } from '../contracts';
import type { CloudScope } from '../../../shared/cloudContracts';
import { ALL_SCOPE, isAllScope, normalizeScope, sameScope } from '../../../shared/cloudContracts';
import { SCOPE_POLICY_VERSION } from './tableSelection';

export const MANIFEST_VERSION = 1;
export const SEGMENT_PAGE_SIZE = 500;
export const INDEX_KEY = 'db-index.json';

export interface ManifestSegment {
    key: string;
    fromId: number;
    toId: number;
    at: number;
    rows: number;
    bytes: number;
}

export interface ManifestSegmentPage {
    key: string;
    count: number;
    firstAt: number;
    lastAt: number;
    bytes: number;
    toId: number;
}

export interface ManifestBase {
    key: string;
    at: number;
    highWater: number;
    /** Kích thước bản mã trên R2. */
    bytes: number;
    /** Kích thước file SQLite gốc. */
    rawBytes: number;
}

export interface DbManifest {
    version: number;
    workspaceUid: string;
    workspaceName: string;
    machineId: string;
    machineName: string;
    appVersion: string;
    schemaFingerprint: string;
    /** _cloud_meta.db_uid của DB nguồn — đổi = file DB đã bị thay → chụp gốc mới. */
    dbUid: string;
    /** 64 byte header DPLC1 của bản gốc (base64) — kiểm tra mật khẩu mà không phải tải bản gốc. */
    passCheck: string | null;
    base: ManifestBase | null;
    segmentPages: ManifestSegmentPage[];
    /** Phần đuôi (mới nhất) của danh sách đoạn, theo thứ tự đẩy. */
    segments: ManifestSegment[];
    segmentsCount: number;
    segmentsBytes: number;
    lastSyncAt: number;
    /** Số dòng từng bảng LÚC CHỤP GỐC (không cập nhật theo đoạn — đếm lại mỗi đoạn quá tốn ở chế độ realtime). */
    rowCounts: Record<string, number>;
    rowCountsAt: number | null;
    updatedAt: number;
    /** Phạm vi của bản gốc (tài khoản + từ ngày). Thiếu (manifest cũ) = tất cả. */
    scope?: CloudScope;
    /** SCOPE_POLICY_VERSION lúc chụp gốc — phạm vi giới hạn mà khác phiên bản quy tắc → chụp gốc mới. */
    scopePolicy?: number;
    /** Tài khoản có trong bản sao (id = accounts.zalo_id) — màn khôi phục hiện tên. */
    accountNames?: ManifestAccount[];
}

export interface ManifestAccount {
    id: string;
    name: string;
    channel: string;
}

export interface DbIndexEntry {
    workspaceUid: string;
    workspaceName: string;
    manifestKey: string;
    baseAt: number | null;
    updatedAt: number;
    scope?: CloudScope;
    accountNames?: ManifestAccount[];
}

export interface DbIndex {
    version: number;
    machineId: string;
    machineName: string;
    updatedAt: number;
    workspaces: DbIndexEntry[];
}

export interface FollowerHeartbeat {
    machine: string;
    machineId: string;
    lagMs: number | null;
    seenAt: number;
}

// ─── Khoá object ────────────────────────────────────────────────────────────

export const dbPrefix = (uid: string) => `${uid}/db/`;
export const manifestKey = (uid: string) => `${uid}/db/manifest.json`;
export const baseKey = (uid: string, at: number) => `${uid}/db/base-${at}.dplc`;
export const segmentKey = (uid: string, fromId: number, toId: number, at: number) => `${uid}/db/seg-${fromId}-${toId}-${at}.dplc`;
export const segmentPageKey = (uid: string, baseAt: number, index: number) => `${uid}/db/segpage-${baseAt}-${index}.json`;
export const followersPrefix = (uid: string) => `${uid}/db/followers/`;
export const followerKey = (uid: string, machineId: string) => `${uid}/db/followers/${machineId}.json`;

/** Tên bucket sao lưu của một máy: deplao-backup-<8 ký tự đầu của machineId>. */
export function backupBucketName(machineId: string): string {
    const id = String(machineId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    return `deplao-backup-${id || 'local'}`;
}

/** Mã bản sao trên R2 dùng làm workspaceId của RemoteDbCopy: "<bucket>/<workspaceUid>". */
export function copyIdOf(bucket: string, uid: string): string {
    return `${bucket}/${uid}`;
}

export function parseCopyId(id: string): { bucket: string; uid: string } | null {
    const s = String(id || '');
    const slash = s.indexOf('/');
    if (slash <= 0 || slash === s.length - 1) return null;
    const bucket = s.slice(0, slash);
    const uid = s.slice(slash + 1);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || uid.includes('/')) return null;
    return { bucket, uid };
}

// ─── Manifest ───────────────────────────────────────────────────────────────

function num(v: unknown, d = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

/** Phạm vi ghi trong manifest / db-index (thiếu → undefined = bản cũ, coi như tất cả). */
export function parseScope(v: unknown): CloudScope | undefined {
    return v && typeof v === 'object' ? normalizeScope(v) : undefined;
}

export function parseAccountNames(v: unknown): ManifestAccount[] | undefined {
    if (!Array.isArray(v)) return undefined;
    return v
        .filter((a: any) => a && (typeof a.id === 'string' || typeof a.id === 'number'))
        .slice(0, 500)
        .map((a: any) => ({ id: String(a.id), name: String(a.name ?? ''), channel: String(a.channel ?? '') }));
}

export function parseManifest(raw: Buffer | string | null | undefined): DbManifest | null {
    if (!raw) return null;
    let m: any;
    try {
        m = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch {
        return null;
    }
    if (!m || typeof m !== 'object' || typeof m.workspaceUid !== 'string') return null;
    const segs = Array.isArray(m.segments) ? m.segments : [];
    const pages = Array.isArray(m.segmentPages) ? m.segmentPages : [];
    return {
        version: num(m.version, MANIFEST_VERSION),
        workspaceUid: m.workspaceUid,
        workspaceName: String(m.workspaceName || ''),
        machineId: String(m.machineId || ''),
        machineName: String(m.machineName || ''),
        appVersion: String(m.appVersion || ''),
        schemaFingerprint: String(m.schemaFingerprint || ''),
        dbUid: String(m.dbUid || ''),
        passCheck: typeof m.passCheck === 'string' ? m.passCheck : null,
        base: m.base && typeof m.base.key === 'string'
            ? { key: m.base.key, at: num(m.base.at), highWater: num(m.base.highWater), bytes: num(m.base.bytes), rawBytes: num(m.base.rawBytes) }
            : null,
        segmentPages: pages
            .filter((p: any) => p && typeof p.key === 'string')
            .map((p: any) => ({ key: p.key, count: num(p.count), firstAt: num(p.firstAt), lastAt: num(p.lastAt), bytes: num(p.bytes), toId: num(p.toId) })),
        segments: segs
            .filter((s: any) => s && typeof s.key === 'string')
            .map((s: any) => ({ key: s.key, fromId: num(s.fromId), toId: num(s.toId), at: num(s.at), rows: num(s.rows), bytes: num(s.bytes) })),
        segmentsCount: num(m.segmentsCount, segs.length),
        segmentsBytes: num(m.segmentsBytes),
        lastSyncAt: num(m.lastSyncAt),
        rowCounts: m.rowCounts && typeof m.rowCounts === 'object' ? m.rowCounts : {},
        rowCountsAt: m.rowCountsAt === null || m.rowCountsAt === undefined ? null : num(m.rowCountsAt),
        updatedAt: num(m.updatedAt),
        scope: parseScope(m.scope),
        scopePolicy: m.scopePolicy === null || m.scopePolicy === undefined ? undefined : num(m.scopePolicy),
        accountNames: parseAccountNames(m.accountNames),
    };
}

export function cloneManifest(m: DbManifest): DbManifest {
    return JSON.parse(JSON.stringify(m));
}

/**
 * Thêm một đoạn vào manifest (bản sao mới — không sửa m). Khi phần đuôi đủ 2 trang: tách trang cũ nhất ra,
 * trả về nội dung trang để ghi lên R2 TRƯỚC khi ghi manifest.
 */
export function appendSegment(m: DbManifest, seg: ManifestSegment): { manifest: DbManifest; page: { key: string; segments: ManifestSegment[] } | null } {
    const next = cloneManifest(m);
    next.segments.push(seg);
    next.segmentsCount += 1;
    next.segmentsBytes += seg.bytes;
    next.lastSyncAt = Math.max(next.lastSyncAt, seg.at);
    next.updatedAt = seg.at;
    let page: { key: string; segments: ManifestSegment[] } | null = null;
    if (next.segments.length >= 2 * SEGMENT_PAGE_SIZE && next.base) {
        const moved = next.segments.splice(0, SEGMENT_PAGE_SIZE);
        const key = segmentPageKey(next.workspaceUid, next.base.at, next.segmentPages.length);
        next.segmentPages.push({
            key,
            count: moved.length,
            firstAt: moved[0].at,
            lastAt: moved[moved.length - 1].at,
            bytes: moved.reduce((s, x) => s + x.bytes, 0),
            toId: moved[moved.length - 1].toId,
        });
        page = { key, segments: moved };
    }
    return { manifest: next, page };
}

export function parsePage(raw: Buffer | null): ManifestSegment[] | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw.toString('utf8'));
        const list = Array.isArray(v?.segments) ? v.segments : null;
        if (!list) return null;
        return list
            .filter((s: any) => s && typeof s.key === 'string')
            .map((s: any) => ({ key: s.key, fromId: num(s.fromId), toId: num(s.toId), at: num(s.at), rows: num(s.rows), bytes: num(s.bytes) }));
    } catch {
        return null;
    }
}

/** Toàn bộ danh sách đoạn theo thứ tự đẩy (đọc các trang — cache theo khoá vì trang bất biến). */
export async function loadAllSegments(r2: R2Client, m: DbManifest, cache?: Map<string, ManifestSegment[]>): Promise<ManifestSegment[]> {
    const out: ManifestSegment[] = [];
    for (const p of m.segmentPages) {
        let list = cache?.get(p.key) || null;
        if (!list) {
            list = parsePage(await r2.getObject(p.key));
            if (!list) throw Object.assign(new Error(`Thiếu trang danh sách đoạn ${p.key} trên kho lưu`), { code: 'DBSYNC_MANIFEST' });
            cache?.set(p.key, list);
        }
        out.push(...list);
    }
    out.push(...m.segments);
    return out;
}

export function totalSegments(m: DbManifest | null): number {
    if (!m) return 0;
    return m.segmentPages.reduce((s, p) => s + p.count, 0) + m.segments.length;
}

// ─── Khi nào chụp gốc mới ───────────────────────────────────────────────────

export const REBASE_SEGMENT_RATIO = 0.25;
/** Không chụp gốc lại vì tỉ lệ khi tổng đoạn còn nhỏ hơn mức này (DB nhỏ: 25% vài KB = chụp lại liên tục). */
export const REBASE_MIN_SEGMENT_BYTES = 2 * 1024 * 1024;
export const REBASE_WINDOW_MIN_AGE_MS = 20 * 3600_000;
export const REBASE_MAX_AGE_MS = 30 * 3600_000;
export const REBASE_DIRTY_ROWS = 100_000;

export interface RebaseContext {
    now: number;
    fingerprint: string;
    dbUid: string;
    /** Giờ địa phương 0..23 (mặc định new Date(now).getHours()). */
    localHour?: number;
    /** Phạm vi đồng bộ hiện tại (thiếu = không so phạm vi). */
    scope?: CloudScope;
}

/**
 * Phạm vi hiện tại khác phạm vi của bản gốc (manifest cũ không ghi = tất cả) → 'scope'; phạm vi giới hạn mà quy tắc
 * lọc (SCOPED_TABLES) đã đổi phiên bản → 'scope-policy'.
 */
export function scopeRebaseReason(m: DbManifest, scope: CloudScope): string | null {
    const cur = normalizeScope(scope);
    if (!sameScope(m.scope ? normalizeScope(m.scope) : ALL_SCOPE, cur)) return 'scope';
    if (!isAllScope(cur) && (m.scopePolicy ?? 0) !== SCOPE_POLICY_VERSION) return 'scope-policy';
    return null;
}

/** Lý do cần chụp gốc mới (null = không cần). */
export function rebaseReason(m: DbManifest | null, ctx: RebaseContext): string | null {
    if (!m || !m.base) return 'no-base';
    if (m.dbUid !== ctx.dbUid) return 'db-replaced';
    if (m.schemaFingerprint !== ctx.fingerprint) return 'schema';
    if (ctx.scope) {
        const byScope = scopeRebaseReason(m, ctx.scope);
        if (byScope) return byScope;
    }
    if (m.segmentsBytes > REBASE_MIN_SEGMENT_BYTES && m.segmentsBytes > REBASE_SEGMENT_RATIO * m.base.bytes) return 'segments-size';
    const age = ctx.now - m.base.at;
    const hour = ctx.localHour ?? new Date(ctx.now).getHours();
    // Gốc > 24 h: làm vào khung 02:00–04:00 nếu máy bật; quá 30 h (máy tắt ban đêm) thì làm ngay.
    if (age >= REBASE_MAX_AGE_MS) return 'age';
    if (age >= REBASE_WINDOW_MIN_AGE_MS && hour >= 2 && hour < 4) return 'age-night';
    return null;
}

export function newManifest(p: {
    workspaceUid: string;
    workspaceName: string;
    machineId: string;
    machineName: string;
    appVersion: string;
    schemaFingerprint: string;
    dbUid: string;
    passCheck: string | null;
    base: ManifestBase;
    rowCounts: Record<string, number>;
    /** Phạm vi đã áp lên bản gốc (thiếu = tất cả). */
    scope?: CloudScope;
    accountNames?: ManifestAccount[];
}): DbManifest {
    return {
        version: MANIFEST_VERSION,
        workspaceUid: p.workspaceUid,
        workspaceName: p.workspaceName,
        machineId: p.machineId,
        machineName: p.machineName,
        appVersion: p.appVersion,
        schemaFingerprint: p.schemaFingerprint,
        dbUid: p.dbUid,
        passCheck: p.passCheck,
        base: p.base,
        segmentPages: [],
        segments: [],
        segmentsCount: 0,
        segmentsBytes: 0,
        lastSyncAt: p.base.at,
        rowCounts: p.rowCounts,
        rowCountsAt: p.base.at,
        updatedAt: p.base.at,
        scope: normalizeScope(p.scope ?? ALL_SCOPE),
        scopePolicy: SCOPE_POLICY_VERSION,
        accountNames: p.accountNames ?? [],
    };
}

/** Đoạn có at ≤ untilTs (khôi phục về một thời điểm). Danh sách theo thứ tự đẩy nên cắt ở đoạn đầu tiên vượt mốc. */
export function segmentsUntil(list: ManifestSegment[], untilTs?: number | null): ManifestSegment[] {
    if (!untilTs) return list;
    const out: ManifestSegment[] = [];
    for (const s of list) {
        if (s.at > untilTs) break;
        out.push(s);
    }
    return out;
}

export function parseIndex(raw: Buffer | null): DbIndex | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw.toString('utf8'));
        if (!v || !Array.isArray(v.workspaces)) return null;
        return {
            version: num(v.version, 1),
            machineId: String(v.machineId || ''),
            machineName: String(v.machineName || ''),
            updatedAt: num(v.updatedAt),
            workspaces: v.workspaces
                .filter((w: any) => w && typeof w.workspaceUid === 'string')
                .map((w: any) => ({
                    workspaceUid: w.workspaceUid,
                    workspaceName: String(w.workspaceName || ''),
                    manifestKey: typeof w.manifestKey === 'string' ? w.manifestKey : manifestKey(w.workspaceUid),
                    baseAt: w.baseAt === null || w.baseAt === undefined ? null : num(w.baseAt),
                    updatedAt: num(w.updatedAt),
                    scope: parseScope(w.scope),
                    accountNames: parseAccountNames(w.accountNames),
                })),
        };
    } catch {
        return null;
    }
}
