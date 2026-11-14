/**
 * Manifest: layout of the DB copy on R2 (one copy per workspace, in the source machine's bucket):
 *
 *   db-index.json                                   list of workspaces that have a copy in the bucket (a new machine looks for the copy here)
 *   <workspaceUid>/db/manifest.json                 manifest (plain JSON, no secrets), overwritten after every push
 *   <workspaceUid>/db/base-<ts>.dplc                base snapshot: SQLite → gzip → DPLC1
 *   <workspaceUid>/db/seg-<fromId>-<toId>-<ts>.dplc change segment: JSONL → gzip → DPLC1
 *   <workspaceUid>/db/segpage-<baseAt>-<n>.json     page of the old segment list (immutable); the manifest only keeps the tail
 *   <workspaceUid>/db/followers/<machineId>.json    heartbeat of the standby machine {machine, lagMs, seenAt}
 *
 * Paging the segment list: realtime mode can push thousands of segments per day. The manifest is rewritten after EVERY push, so it
 * only keeps the ≤ 2×SEGMENT_PAGE_SIZE newest segments; older ones move to immutable pages (one write per 500 segments).
 *
 * Scope (accounts + from date): the manifest + db-index entry record the scope of the base snapshot and the names of the accounts in the copy.
 * An old manifest without it = all. A current scope different from the manifest's scope → take a new base snapshot (rebaseReason).
 * (Main process only: cloudContracts is imported at run time; the worker does not load this file.)
 */
import type { R2Client } from '../contracts';
import type { CloudScope } from '../../../shared/cloud/cloudContracts';
import { ALL_SCOPE, isAllScope, normalizeScope, sameScope } from '../../../shared/cloud/cloudContracts';
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
    /** Size of the ciphertext on R2. */
    bytes: number;
    /** Size of the original SQLite file. */
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
    /** _cloud_meta.db_uid of the source DB: a change = the DB file was replaced → take a new base snapshot. */
    dbUid: string;
    /** The 64-byte DPLC1 header of the base snapshot (base64): checks the password without downloading the base snapshot. */
    passCheck: string | null;
    base: ManifestBase | null;
    segmentPages: ManifestSegmentPage[];
    /** The tail (newest) of the segment list, in push order. */
    segments: ManifestSegment[];
    segmentsCount: number;
    segmentsBytes: number;
    lastSyncAt: number;
    /** Row count per table AT THE TIME OF THE BASE SNAPSHOT (not updated per segment: recounting on every segment is too costly in realtime mode). */
    rowCounts: Record<string, number>;
    rowCountsAt: number | null;
    updatedAt: number;
    /** Scope of the base snapshot (accounts + from date). Missing (old manifest) = all. */
    scope?: CloudScope;
    /** SCOPE_POLICY_VERSION when the base snapshot was taken: a limited scope whose rule version differs → take a new base snapshot. */
    scopePolicy?: number;
    /** Accounts in the copy (id = accounts.zalo_id): the restore screen shows the names. */
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

// ─── Object keys ────────────────────────────────────────────────────────────

export const dbPrefix = (uid: string) => `${uid}/db/`;
export const manifestKey = (uid: string) => `${uid}/db/manifest.json`;
export const baseKey = (uid: string, at: number) => `${uid}/db/base-${at}.dplc`;
export const segmentKey = (uid: string, fromId: number, toId: number, at: number) => `${uid}/db/seg-${fromId}-${toId}-${at}.dplc`;
export const segmentPageKey = (uid: string, baseAt: number, index: number) => `${uid}/db/segpage-${baseAt}-${index}.json`;
export const followersPrefix = (uid: string) => `${uid}/db/followers/`;
export const followerKey = (uid: string, machineId: string) => `${uid}/db/followers/${machineId}.json`;

/** Backup bucket name for one machine: deplao-backup-<first 8 characters of machineId>. */
export function backupBucketName(machineId: string): string {
    const id = String(machineId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    return `deplao-backup-${id || 'local'}`;
}

/** Copy id on R2 used as the workspaceId of RemoteDbCopy: "<bucket>/<workspaceUid>". */
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

/** Scope recorded in the manifest / db-index (missing → undefined = old copy, treated as all). */
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
 * Adds one segment to the manifest (returns a new copy, does not change m). When the tail reaches 2 pages: split off the oldest page,
 * and return its content to be written to R2 BEFORE the manifest is written.
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

/** The whole segment list in push order (reads the pages; cached by key because the pages are immutable). */
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

// ─── When to take a new base snapshot ───────────────────────────────────────────────────

export const REBASE_SEGMENT_RATIO = 0.25;
/** Do not re-take the base snapshot because of the ratio while the total segments are still below this level (small DB: 25% of a few KB = re-snapshot all the time). */
export const REBASE_MIN_SEGMENT_BYTES = 2 * 1024 * 1024;
export const REBASE_WINDOW_MIN_AGE_MS = 20 * 3600_000;
export const REBASE_MAX_AGE_MS = 30 * 3600_000;
export const REBASE_DIRTY_ROWS = 100_000;

export interface RebaseContext {
    now: number;
    fingerprint: string;
    dbUid: string;
    /** Local hour 0..23 (default new Date(now).getHours()). */
    localHour?: number;
    /** Current sync scope (missing = do not compare scopes). */
    scope?: CloudScope;
}

/**
 * The current scope differs from the base snapshot's scope (an old manifest without one = all) → 'scope'; a limited scope whose filter rules
 * (SCOPED_TABLES) changed version → 'scope-policy'.
 */
export function scopeRebaseReason(m: DbManifest, scope: CloudScope): string | null {
    const cur = normalizeScope(scope);
    if (!sameScope(m.scope ? normalizeScope(m.scope) : ALL_SCOPE, cur)) return 'scope';
    if (!isAllScope(cur) && (m.scopePolicy ?? 0) !== SCOPE_POLICY_VERSION) return 'scope-policy';
    return null;
}

/** Reason a new base snapshot is needed (null = not needed). */
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
    // Base older than 24 h: do it in the 02:00-04:00 window if the machine is on; older than 30 h (machine off at night) → do it right away.
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
    /** Scope applied to the base snapshot (missing = all). */
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

/** Segments with at ≤ untilTs (restore to a point in time). The list is in push order, so cut at the first segment past the mark. */
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
