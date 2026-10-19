/**
 * keys — quy tắc đặt tên cho R2 media (hàm thuần, không I/O).
 *
 *  - rel_path (khoá của bảng cloud_media): đường dẫn trong thư mục media/ của workspace, phân tách '/', GIỮ NGUYÊN tên
 *    trên đĩa (hoa/thường, dạng Unicode) để đọc lại đúng file.
 *  - Khoá object R2: `<workspaceUid>/<rel_path>` chuẩn hoá Unicode NFC (khoá R2 phân biệt hoa/thường → giữ nguyên chữ).
 *  - Bucket: `deplao-media-<8 ký tự đầu machineId>`.
 *  - Bỏ qua: file tạm / đang ghi dở, file hệ thống, thư mục cache sticker, thư mục ẩn.
 *  - Phạm vi lưu (tài khoản + từ ngày + file dùng chung): accountOfRelPath / relInScope / dirMayHaveInScope.
 */
import * as path from 'path';
import { ALL_SCOPE, CloudScope, scopeIncludesAccount } from '../../../shared/cloudContracts';

export function toSlash(p: string): string {
    return String(p).replace(/\\/g, '/');
}

/**
 * Chuẩn hoá đường dẫn tương đối: '/' thay '\', bỏ './' và '/' thừa. Giữ nguyên hoa/thường và dạng Unicode.
 * null nếu rỗng hoặc có '..'.
 */
export function cleanRelPath(rel: string): string | null {
    if (typeof rel !== 'string') return null;
    const segs = toSlash(rel).split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0 || segs.some((s) => s === '..')) return null;
    return segs.join('/');
}

/** Khoá object R2: `<workspaceUid>/<rel>` dạng NFC, '/' — ném lỗi nếu đường dẫn không hợp lệ. */
export function objectKeyFor(workspaceUid: string, rel: string): string {
    const clean = cleanRelPath(rel);
    const uid = String(workspaceUid || '').trim();
    if (!clean || !uid || /[\\/]/.test(uid)) throw new Error('Đường dẫn media không hợp lệ');
    return `${uid}/${clean.normalize('NFC')}`;
}

/**
 * Đường dẫn tương đối (dạng '/') của absPath trong thư mục root; null nếu nằm ngoài (hoặc khác ổ đĩa).
 * Windows: so khớp phần gốc không phân biệt hoa/thường (path.win32.relative), phần còn lại giữ nguyên chữ của absPath.
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

/** rel ('/') → đường dẫn tuyệt đối trong root (rel phải đã qua cleanRelPath). */
export function absPathFor(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'));
}

/** Tên bucket R2 của máy: deplao-media-<8 ký tự đầu machineId> (a-z, 0-9). */
export function mediaBucketName(machineId: string): string {
    const id = String(machineId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    return `deplao-media-${id || 'local'}`;
}

// ─── Bỏ qua ──────────────────────────────────────────────────────────────────

const SKIP_FILE_EXT = new Set([
    '.part', '.partial', '.tmp', '.temp', '.crdownload', '.download', '.dltmp', '.lock', '.swp', '.r2tmp', '.r2part',
]);
const SKIP_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'icon\r']);
/** Cache sticker (Telegram <tài khoản>/stickers), thư mục tạm / cache, thùng rác hệ thống. */
const SKIP_DIR_NAMES = new Set([
    'stickers', 'sticker', 'cache', '_cache', 'tmp', '_tmp', 'temp', '_temp', '$recycle.bin', 'system volume information',
]);

/** File tạm / đang ghi dở / file hệ thống — không sao lưu. */
export function isSkippedFileName(name: string): boolean {
    if (!name) return true;
    const lower = name.toLowerCase();
    if (lower.startsWith('.') || lower.startsWith('~$') || lower.endsWith('~')) return true;
    if (SKIP_FILE_NAMES.has(lower)) return true;
    if (SKIP_FILE_EXT.has(path.extname(lower))) return true;
    // Đuôi tạm có hậu tố: "anh.jpg.tmp-123", "x.download~" (không đụng "nen.part1.rar" — file nén chia phần thật)
    // "anh.jpg.r2tmp-1a2b3c4d" = file tạm của R2Client.getObjectToFile khi đang tải về
    if (/\.(r2tmp|tmp|part|partial|download|crdownload)[-~_][^.]*$/.test(lower)) return true;
    return false;
}

export function isSkippedDirName(name: string): boolean {
    if (!name) return true;
    const lower = name.toLowerCase();
    return lower.startsWith('.') || SKIP_DIR_NAMES.has(lower);
}

/** rel có thư mục bị bỏ qua hoặc tên file bị bỏ qua. */
export function isSkippedRelPath(rel: string): boolean {
    const segs = rel.split('/');
    const name = segs.pop() || '';
    return isSkippedFileName(name) || segs.some(isSkippedDirName);
}

// ─── Thứ tự quét (con trỏ quét tiếp được) ────────────────────────────────────

/** Thứ tự duyệt thư mục con: tên giảm dần → thư mục ngày mới nhất trước. */
export function childOrder(a: string, b: string): number {
    return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * So sánh hai thư mục (mảng tên từ gốc) theo thứ tự duyệt sâu trước (cha trước con, con theo childOrder).
 * < 0: a được duyệt trước b.
 */
export function preOrderCompare(a: readonly string[], b: readonly string[]): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const c = childOrder(a[i], b[i]);
        if (c !== 0) return c;
    }
    return a.length - b.length;
}

/** a là thư mục tổ tiên (thực sự) của b. */
export function isAncestorOf(a: readonly string[], b: readonly string[]): boolean {
    if (a.length >= b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ─── local_paths trong DB ────────────────────────────────────────────────────

/**
 * Giá trị local_paths ("media/<id>/<ngày>/a.jpg" tương đối thư mục cấu hình, hoặc đường dẫn tuyệt đối cũ) → đường dẫn
 * tuyệt đối trong thư mục media hiện tại. null nếu không phải file media (URL, data:, ngoài thư mục media…).
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
    // Đường dẫn tuyệt đối cũ (ổ/thư mục trước khi chuyển) → ghép phần sau "/media/" vào thư mục media hiện tại
    const idx = s.toLowerCase().lastIndexOf('/media/');
    if (idx < 0) return null;
    const clean = cleanRelPath(s.slice(idx + 7));
    return clean ? absPathFor(mediaRoot, clean) : null;
}

// ─── Tài khoản của file / phạm vi lưu ────────────────────────────────────────

/**
 * Thư mục cấp 1 dùng chung (không thuộc tài khoản nào — MediaSyncOptions.includeShared): thư viện media
 * (library/<chủ>/…, theo hợp đồng tính là file chung), công việc ERP (erp/tasks/<id>/…). Tên bắt đầu '_' (_avatars,
 * _uploads, _api_uploads…) hoặc '.' cũng là thư mục dùng chung.
 */
const SHARED_TOP_DIRS = new Set(['library', 'erp']);
const DATE_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Nới hai đầu ngày của thư mục YYYY-MM-DD: getAccountDir đặt tên theo ngày UTC; bản cũ / máy khác có thể theo giờ máy. */
const DATE_DIR_SLACK_MS = 14 * HOUR_MS;

function relSegments(rel: string): string[] {
    return toSlash(String(rel ?? '')).split('/').filter((s) => s !== '' && s !== '.');
}

/**
 * Thư mục cấp 1 trong media/ → tài khoản (accounts.zalo_id — id chung của mọi kênh); null = thư mục dùng chung.
 * aliases: tên thư mục khác accounts.zalo_id → id tài khoản (Facebook lưu theo fb_accounts.id khi chưa biết
 * facebook_id — CloudMediaIndex.accountFolderAliases).
 */
export function accountOfTopDir(name: string, aliases?: ReadonlyMap<string, string> | null): string | null {
    if (!name || name.startsWith('_') || name.startsWith('.') || SHARED_TOP_DIRS.has(name.toLowerCase())) return null;
    if (aliases && aliases.size) return aliases.get(name) ?? aliases.get(name.toLowerCase()) ?? name;
    return name;
}

/**
 * Tài khoản của file media (rel '/' trong thư mục media/); null = file dùng chung. Bố cục do FileStorageService và
 * các kênh ghi:
 *   <id>/<YYYY-MM-DD>/[fw_<msg>/]<file>       Zalo, Facebook (tải về, gửi đi, E2EE), file nhân viên tải lên theo tài khoản
 *   <id>/images|videos|voices|files/<file>    Telegram cá nhân + bot (id số)
 *   <fb_accounts.id>/<YYYY-MM-DD>/…            Facebook chưa có facebook_id → aliases đổi sang facebook_id
 *   library/<chủ>/…, erp/tasks/<id>/…, _avatars/…, _uploads/…, _api_uploads/…, file ngay ở gốc → dùng chung
 * Thư mục cấp 1 lạ (tài khoản đã xoá, "unknown" của Telegram…) vẫn tính là thư mục tài khoản: chỉ lưu khi phạm vi là
 * "tất cả tài khoản".
 */
export function accountOfRelPath(rel: string, aliases?: ReadonlyMap<string, string> | null): string | null {
    const segs = relSegments(rel);
    return segs.length >= 2 ? accountOfTopDir(segs[0], aliases) : null;
}

/** Thư mục ngày YYYY-MM-DD → khoảng thời gian (ms) của ngày đó, nới ±14 giờ; null nếu không phải ngày hợp lệ. */
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
 * Thời điểm của file để so với "từ ngày" của phạm vi: mtime; file trong thư mục ngày của tài khoản
 * (<id>/<YYYY-MM-DD>/…) thì kẹp mtime vào ngày đó — thư mục chép sang ổ khác (mtime thành "mới") hay file chép giữ
 * mtime cũ vẫn tính theo ngày lưu.
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

/** Phạm vi lưu media đang áp (MediaSyncOptions.scope + includeShared) + bí danh thư mục tài khoản. */
export interface MediaScopeFilter {
    scope: CloudScope;
    /** File không thuộc tài khoản nào (thư viện, công việc, file tải lên chung, ảnh đại diện…). */
    includeShared: boolean;
    aliases?: ReadonlyMap<string, string> | null;
}

/** File có thuộc phạm vi lưu lên R2 không. filter null = không giới hạn (mọi file, như trước khi có phạm vi). */
export function relInScope(rel: string, mtimeMs: number, filter: MediaScopeFilter | null | undefined): boolean {
    if (!filter) return true;
    const account = accountOfRelPath(rel, filter.aliases);
    if (account === null ? !filter.includeShared : !scopeIncludesAccount(filter.scope, account)) return false;
    const fromTs = filter.scope.fromTs;
    return typeof fromTs !== 'number' || mediaTimeOf(rel, mtimeMs) >= fromTs;
}

/**
 * Thư mục (mảng tên từ gốc media/) có thể chứa file trong phạm vi không — false = bỏ qua cả nhánh (không đọc, không
 * stat): thư mục tài khoản ngoài phạm vi, thư mục dùng chung khi không lưu file chung, thư mục ngày trước "từ ngày".
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

/** Chuỗi so sánh được của phạm vi (tài khoản đã sắp xếp) — ghi vào app_settings để biết phạm vi đã đổi. */
export function scopeSignature(filter: Pick<MediaScopeFilter, 'scope' | 'includeShared'> | null | undefined): string {
    const scope = filter ? filter.scope : ALL_SCOPE;
    return JSON.stringify({
        accounts: scope.accounts === 'all' ? 'all' : [...scope.accounts].sort(),
        fromTs: typeof scope.fromTs === 'number' ? scope.fromTs : null,
        includeShared: filter ? filter.includeShared !== false : true,
    });
}

// ─── Tham chiếu tới file media trong DB (công cụ dọn R2: file của tin đã xoá) ──

/** Khoá so khớp đường dẫn media (NFC, chữ thường): so đường dẫn ghi trong DB với rel của chỉ mục. */
export function mediaRefKey(rel: string): string {
    return String(rel ?? '').normalize('NFC').toLowerCase();
}

const MEDIA_HINT_RE = /media/i;
/** "media/" đứng đầu một đoạn đường dẫn (không phải "multimedia/", "social-media/"…). */
const MEDIA_SEG_RE = /(?<![A-Za-z0-9_.\-])media\/+/gi;
/** Ký tự có thể đứng ngay sau một đường dẫn trong văn bản / JSON (thử cắt tại đó). */
const REF_BOUNDARY = new Set(Array.from('"\'<>|?*#,;:)]}&=.!` \t\r\n'));
const MAX_REF_TAIL = 1024;

function decodePercentRuns(s: string): string {
    return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
        try { return decodeURIComponent(run); } catch { return run; }
    });
}

/**
 * Tìm trong một giá trị DB các đường dẫn tới file media nằm trong tập ứng viên (khoá mediaRefKey của rel) → thêm vào
 * found. Nhận mọi dạng đã lưu: "media/<id>/…" (FileStorageService.toRelativePath), đường dẫn tuyệt đối …\media\…
 * (Telegram, đường dẫn cũ ở ổ khác), local-media://…, URL …/api/media/…, JSON (kể cả JSON lồng có "\/", "\\", \uXXXX),
 * %XX. Không cần biết đường dẫn kết thúc ở đâu: thử cắt tại mọi ký tự ranh giới — thừa tham chiếu chỉ làm dọn ít đi.
 */
export function collectMediaRefs(value: string, candidates: ReadonlySet<string>, found: Set<string>): void {
    if (typeof value !== 'string' || value.length < 7 || !candidates.size || !MEDIA_HINT_RE.test(value)) return;
    let s = value;
    // \uXXXX của JSON (không phải "\\u…" = dấu "\" đã thoát, vd thư mục Windows bắt đầu bằng "u")
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

// ─── Khác ────────────────────────────────────────────────────────────────────

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

/** ETag so sánh được: bỏ W/, dấu ", chữ thường. */
export function normEtag(etag: string | null | undefined): string {
    return String(etag || '').trim().replace(/^W\//i, '').replace(/"/g, '').toLowerCase();
}
