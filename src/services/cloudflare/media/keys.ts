/**
 * keys: naming rules for R2 media (pure functions, no I/O).
 *
 *  - rel_path (the key of the cloud_media table): path inside the workspace's media/ folder, separated by '/', KEEPS the name exactly as on disk
 *    (case, Unicode form) so the right file can be read back.
 *  - R2 object key: `<workspaceUid>/<rel_path>` normalized to Unicode NFC (R2 keys are case-sensitive → keep the letters as they are).
 *  - Bucket: `deplao-media-<first 8 characters of machineId>`.
 *  - Skipped: temp files / half-written files, system files, the sticker cache folder, hidden folders.
 *  - Storage scope (account + from date + shared files): accountOfRelPath / relInScope / dirMayHaveInScope.
 */
import * as path from 'path';
import { ALL_SCOPE, CloudScope, scopeIncludesAccount } from '../../../shared/cloud/cloudContracts';
import { tr } from '../../../shared/i18n';

export function toSlash(p: string): string {
    return String(p).replace(/\\/g, '/');
}

/**
 * Normalizes a relative path: '/' replaces '\', drops './' and extra '/'. Keeps the case and the Unicode form.
 * null if empty or contains '..'.
 */
export function cleanRelPath(rel: string): string | null {
    if (typeof rel !== 'string') return null;
    const segs = toSlash(rel).split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0 || segs.some((s) => s === '..')) return null;
    return segs.join('/');
}

/** R2 object key: `<workspaceUid>/<rel>` in NFC form, '/' separators; throws if the path is not valid. */
export function objectKeyFor(workspaceUid: string, rel: string): string {
    const clean = cleanRelPath(rel);
    const uid = String(workspaceUid || '').trim();
    if (!clean || !uid || /[\\/]/.test(uid)) throw new Error(tr('Đường dẫn media không hợp lệ'));
    return `${uid}/${clean.normalize('NFC')}`;
}

/**
 * Relative path (in '/' form) of absPath inside the root folder; null if it is outside (or on another drive).
 * Windows: the root part is matched case-insensitively (path.win32.relative), the rest keeps the letters of absPath.
 */
export function relPathInRoot(root: string, absPath: string, p: path.PlatformPath = path): string | null {
    if (!root || !absPath) return null;
    let rel: string;
    try {
        rel = p.relative(p.resolve(root), p.resolve(absPath));
    } catch {
        return null;
    }
    if (!rel || p.isAbsolute(rel)) return null;
    if (toSlash(rel).split('/')[0] === '..') return null;
    return cleanRelPath(rel);
}

/** rel ('/') → absolute path inside root (rel must already have gone through cleanRelPath). */
export function absPathFor(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'));
}

/** R2 bucket name of the machine: deplao-media-<first 8 characters of machineId> (a-z, 0-9). */
export function mediaBucketName(machineId: string): string {
    const id = String(machineId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    return `deplao-media-${id || 'local'}`;
}

// ─── Skipped ──────────────────────────────────────────────────────────────────

const SKIP_FILE_EXT = new Set([
    '.part', '.partial', '.tmp', '.temp', '.crdownload', '.download', '.dltmp', '.lock', '.swp', '.r2tmp', '.r2part',
]);
const SKIP_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'icon\r']);
/** Sticker cache (Telegram <account>/stickers), temp / cache folders, the system trash. */
const SKIP_DIR_NAMES = new Set([
    'stickers', 'sticker', 'cache', '_cache', 'tmp', '_tmp', 'temp', '_temp', '$recycle.bin', 'system volume information',
]);

/** Temp files / half-written files / system files: not backed up. */
export function isSkippedFileName(name: string): boolean {
    if (!name) return true;
    const lower = name.toLowerCase();
    if (lower.startsWith('.') || lower.startsWith('~$') || lower.endsWith('~')) return true;
    if (SKIP_FILE_NAMES.has(lower)) return true;
    if (SKIP_FILE_EXT.has(path.extname(lower))) return true;
    // Temp suffixes with a tail: "anh.jpg.tmp-123", "x.download~" (does not touch "nen.part1.rar", a real split archive part)
    // "anh.jpg.r2tmp-1a2b3c4d" = temp file of R2Client.getObjectToFile while downloading
    if (/\.(r2tmp|tmp|part|partial|download|crdownload)[-~_][^.]*$/.test(lower)) return true;
    return false;
}

export function isSkippedDirName(name: string): boolean {
    if (!name) return true;
    const lower = name.toLowerCase();
    return lower.startsWith('.') || SKIP_DIR_NAMES.has(lower);
}

/** rel has a skipped folder or a skipped file name. */
export function isSkippedRelPath(rel: string): boolean {
    const segs = rel.split('/');
    const name = segs.pop() || '';
    return isSkippedFileName(name) || segs.some(isSkippedDirName);
}

// ─── Scan order (the scan cursor can resume) ────────────────────────────────────

/** Subfolder traversal order: names descending → the newest day folder first. */
export function childOrder(a: string, b: string): number {
    return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Compares two folders (arrays of names from the root) in depth-first traversal order (parent before child, children by childOrder).
 * < 0: a is traversed before b.
 */
export function preOrderCompare(a: readonly string[], b: readonly string[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const c = childOrder(a[i], b[i]);
        if (c !== 0) return c;
    }
    return a.length - b.length;
}

/** a is a real ancestor folder of b. */
export function isAncestorOf(a: readonly string[], b: readonly string[]): boolean {
    if (a.length >= b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ─── local_paths trong DB ────────────────────────────────────────────────────

/**
 * A local_paths value ("media/<id>/<day>/a.jpg" relative to the config folder, or an old absolute path) → absolute path
 * inside the current media folder. null if it is not a media file (URL, data:, outside the media folder…).
 */
export function resolveStoredLocalPath(value: string, mediaRoot: string): string | null {
    if (typeof value !== 'string' || !mediaRoot) return null;
    let v = value.trim();
    if (!v || /^(https?|data|blob):/i.test(v)) return null;
    v = v.replace(/^local-media:\/+/i, '');
    const s = toSlash(v);
    const isAbs = path.isAbsolute(v) || /^[A-Za-z]:\//.test(s) || s.startsWith('/');
    if (!isAbs) {
        const rel = s.replace(/^(\.\/)+/, '');
        if (!rel.toLowerCase().startsWith('media/')) return null;
        const clean = cleanRelPath(rel.slice(6));
        return clean ? absPathFor(mediaRoot, clean) : null;
    }
    const inside = relPathInRoot(mediaRoot, v);
    if (inside) return absPathFor(mediaRoot, inside);
    // Old absolute path (drive / folder from before a move) → append the part after "/media/" to the current media folder
    const idx = s.toLowerCase().lastIndexOf('/media/');
    if (idx < 0) return null;
    const clean = cleanRelPath(s.slice(idx + 7));
    return clean ? absPathFor(mediaRoot, clean) : null;
}

// ─── Account of a file / storage scope ────────────────────────────────────────

/**
 * Top-level shared folders (not owned by any account; MediaSyncOptions.includeShared): the media library
 * (library/<owner>/…, counted as shared files by contract), ERP work (erp/tasks/<id>/…). Names starting with '_' (_avatars,
 * _uploads, _api_uploads…) or '.' are also shared folders.
 */
const SHARED_TOP_DIRS = new Set(['library', 'erp']);
const DATE_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Widens both ends of a YYYY-MM-DD folder's day: getAccountDir names folders by UTC day; older versions / other machines may use local machine time. */
const DATE_DIR_SLACK_MS = 14 * HOUR_MS;

function relSegments(rel: string): string[] {
    return toSlash(String(rel ?? '')).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * Top-level folder in media/ → account (accounts.zalo_id, the shared id of every channel); null = shared folder.
 * aliases: folder names that differ from accounts.zalo_id → account id (Facebook stores by fb_accounts.id while the
 * facebook_id is not known yet : CloudMediaIndex.accountFolderAliases).
 */
export function accountOfTopDir(name: string, aliases?: ReadonlyMap<string, string> | null): string | null {
    if (!name || name.startsWith('_') || name.startsWith('.') || SHARED_TOP_DIRS.has(name.toLowerCase())) return null;
    if (aliases && aliases.size) return aliases.get(name) ?? aliases.get(name.toLowerCase()) ?? name;
    return name;
}

/**
 * Account of a media file (rel with '/' inside media/); null = shared file. The layout is written by FileStorageService and
 * the channels:
 *   <id>/<YYYY-MM-DD>/[fw_<msg>/]<file>       Zalo, Facebook (downloads, sends, E2EE), files employees upload under an account
 *   <id>/images|videos|voices|files/<file>    Telegram personal + bot (numeric id)
 *   <fb_accounts.id>/<YYYY-MM-DD>/…            Facebook before facebook_id is known → aliases switch to facebook_id
 *   library/<owner>/…, erp/tasks/<id>/…, _avatars/…, _uploads/…, _api_uploads/…, files right at the root → shared
 * An unknown top-level folder (a deleted account, Telegram's "unknown"…) still counts as an account folder: it is only stored when the scope is
 * "tất cả tài khoản" (all accounts).
 */
export function accountOfRelPath(rel: string, aliases?: ReadonlyMap<string, string> | null): string | null {
    const segs = relSegments(rel);
    return segs.length >= 2 ? accountOfTopDir(segs[0], aliases) : null;
}

/** Day folder YYYY-MM-DD → time range (ms) of that day, widened by ±14 hours; null if it is not a valid date. */
export function dateDirRange(name: string): { start: number; end: number } | null {
    const m = DATE_DIR_RE.exec(String(name ?? ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const t = Date.UTC(y, mo, d);
    const check = new Date(t);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
    return { start: t - DATE_DIR_SLACK_MS, end: t + DAY_MS + DATE_DIR_SLACK_MS };
}

/**
 * The time of a file to compare with the scope's "từ ngày" (from date): mtime; for a file inside an account's day folder
 * (<id>/<YYYY-MM-DD>/…) the mtime is clamped to that day: a folder copied to another drive (its mtime becomes "mới" (new)) or a file copied with its old
 * mtime still counts by the day it was stored.
 */
export function mediaTimeOf(rel: string, mtimeMs: number): number {
    const segs = relSegments(rel);
    const t = Number(mtimeMs) || 0;
    if (segs.length >= 3 && accountOfTopDir(segs[0]) !== null) {
        const range = dateDirRange(segs[1]);
        if (range) return Math.min(range.end, Math.max(range.start, t));
    }
    return t;
}

/** Media storage scope in effect (MediaSyncOptions.scope + includeShared) + account folder aliases. */
export interface MediaScopeFilter {
    scope: CloudScope;
    /** File that belongs to no account (library, work, shared uploads, avatars…). */
    includeShared: boolean;
    aliases?: ReadonlyMap<string, string> | null;
}

/** Whether a file is in the scope to be stored on R2. filter null = no limit (every file, as before scopes existed). */
export function relInScope(rel: string, mtimeMs: number, filter: MediaScopeFilter | null | undefined): boolean {
    if (!filter) return true;
    const account = accountOfRelPath(rel, filter.aliases);
    if (account === null ? !filter.includeShared : !scopeIncludesAccount(filter.scope, account)) return false;
    const fromTs = filter.scope.fromTs;
    return typeof fromTs !== 'number' || mediaTimeOf(rel, mtimeMs) >= fromTs;
}

/**
 * Whether a folder (array of names from the media/ root) may contain files in scope : false = skip the whole branch (no read, no
 * stat call): an account folder outside the scope, the shared folder when shared files are not stored, a day folder before "từ ngày" (from date).
 */
export function dirMayHaveInScope(segs: readonly string[], filter: MediaScopeFilter | null | undefined): boolean {
    if (!filter || !segs.length) return true;
    const account = accountOfTopDir(segs[0], filter.aliases);
    if (account === null) return filter.includeShared;
    if (!scopeIncludesAccount(filter.scope, account)) return false;
    const fromTs = filter.scope.fromTs;
    if (segs.length >= 2 && typeof fromTs === 'number') {
        const range = dateDirRange(segs[1]);
        if (range && range.end < fromTs) return false;
    }
    return true;
}

/** Comparable string of the scope (accounts sorted), written to app_settings so the scope change can be detected. */
export function scopeSignature(filter: Pick<MediaScopeFilter, 'scope' | 'includeShared'> | null | undefined): string {
    const scope = filter ? filter.scope : ALL_SCOPE;
    return JSON.stringify({
        accounts: scope.accounts === 'all' ? 'all' : [...scope.accounts].sort(),
        fromTs: typeof scope.fromTs === 'number' ? scope.fromTs : null,
        includeShared: filter ? filter.includeShared !== false : true,
    });
}

// ─── References to media files in the DB (R2 cleanup tool: files of deleted messages) ──

/** Match key for media paths (NFC, lowercase): compares paths written in the DB with the index rel. */
export function mediaRefKey(rel: string): string {
    return String(rel ?? '').normalize('NFC').toLowerCase();
}

const MEDIA_HINT_RE = /media/i;
/** "media/" at the start of a path segment (not "multimedia/", "social-media/"…). */
const MEDIA_SEG_RE = /(?<![A-Za-z0-9_.\-])media\/+/gi;
/** Characters that can come right after a path in text / JSON (try cutting the path there). */
const REF_BOUNDARY = new Set(Array.from('"\'<>|?*#,;:)]}&=.!` \t\r\n'));
const MAX_REF_TAIL = 1024;

function decodePercentRuns(s: string): string {
    return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
        try { return decodeURIComponent(run); } catch { return run; }
    });
}

/**
 * Finds, in one DB value, the paths to media files inside the candidate set (keys mediaRefKey of rel) → adds them to
 * found. Accepts every stored form: "media/<id>/…" (FileStorageService.toRelativePath), absolute paths …\media\…
 * (Telegram, old paths on another drive), local-media://…, URLs …/api/media/…, JSON (including nested JSON with "\/", "\\", \uXXXX),
 * %XX. No need to know where the path ends: try cutting at every boundary character; an extra reference only means less cleanup.
 */
export function collectMediaRefs(value: string, candidates: ReadonlySet<string>, found: Set<string>): void {
    if (typeof value !== 'string' || value.length < 7 || !candidates.size || !MEDIA_HINT_RE.test(value)) return;
    let s = value;
    // JSON \uXXXX (not "\\u…": an escaped backslash "\" followed by u, e.g. a Windows folder starting with "u")
    if (s.includes('\\u')) s = s.replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (s.includes('\\')) s = s.replace(/\\+/g, '/');
    const variants = [s];
    if (s.includes('%')) {
        const decoded = decodePercentRuns(s);
        if (decoded !== s) variants.push(decoded);
    }
    for (const v of variants) {
        for (const m of v.matchAll(MEDIA_SEG_RE)) {
            const start = (m.index ?? 0) + m[0].length;
            const tail = mediaRefKey(v.slice(start, start + MAX_REF_TAIL)).replace(/\/{2,}/g, '/');
            for (let k = 1; k <= tail.length; k++) {
                if (k < tail.length && !REF_BOUNDARY.has(tail[k])) continue;
                const key = tail.slice(0, k);
                if (candidates.has(key)) found.add(key);
            }
        }
    }
}

// ─── Other ────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
    '.jxl': 'image/jxl', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp', '.flv': 'video/x-flv',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.opus': 'audio/opus', '.wav': 'audio/wav', '.amr': 'audio/amr', '.flac': 'audio/flac',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
    '.tgs': 'application/x-tgsticker',
};

export function contentTypeFor(rel: string): string {
    return MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
}

/** Comparable ETag: strip the W/ prefix, the " quotes, lowercase. */
export function normEtag(etag: string | null | undefined): string {
    return String(etag || '').trim().replace(/^W\//i, '').replace(/"/g, '').toLowerCase();
}
