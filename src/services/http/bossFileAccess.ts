/**
 * bossFileAccess.ts — quyền tải file Boss phục vụ cho nhân viên (pure, test ở src/__tests__/employee/bossFileAccess.test.ts).
 *
 * Trước đây GET /api/media/* (media chat) và /api/library/file|thumb/* (thư viện) trả file KHÔNG cần đăng nhập:
 * ai biết URL Boss / tunnel là tải được ảnh, video, tài liệu của khách. Nay HttpRelayService bắt buộc phiên nhân viên
 * (Authorization: Bearer — máy nhân viên tự gắn, xem bossSessionAuth.ts) rồi áp các quy tắc ở đây:
 *   - Media: thư mục cấp 1 (sau `thumb/` | `avatar/` tuỳ chọn) là id tài khoản — Zalo / Facebook / Telegram đều nằm ở
 *     accounts.zalo_id, FileStorageService lưu `media/<id>/...` → id phải thuộc assigned_accounts (403 ACCOUNT_FORBIDDEN).
 *     Thư mục chỉ gồm chữ số cũng coi là thư mục tài khoản (tài khoản đã xoá / đọc DB lỗi → chặn thay vì mở).
 *     `media/library/<chủ>/...` theo quy tắc thư viện. Thư mục khác (_avatars, erp, _uploads, đường dẫn cũ…) → mọi
 *     nhân viên đã đăng nhập.
 *   - Thư viện: chủ item phải xem được — giống resolveAccessibleOwners (LibraryHandler): nhân viên chưa được giao tài
 *     khoản nào xem được mọi thư viện.
 * Phân loại chạy trên đường dẫn THẬT của file (sau realpath, tương đối so với thư mục media) để `..`, `%2e`, `\`, chữ
 * hoa/thường, tên 8.3 hay dấu chấm cuối của Windows không lách được kiểm tra tài khoản.
 */

const MEDIA_PREFIX = '/api/media/';

/** Thư mục cấp 1 chỉ gồm chữ số = thư mục tài khoản (uid Zalo, id Facebook / Telegram). Ngày lưu dạng YYYY-MM-DD. */
const NUMERIC_ACCOUNT_DIR = /^\d{5,}$/;

const isWindowsDefault = (): boolean => typeof process !== 'undefined' && process.platform === 'win32';

export interface PathOptions {
  /** Quy tắc tên file Windows (mặc định: theo máy đang chạy). */
  windows?: boolean;
}

// ─── Đường dẫn trong URL ───────────────────────────────────────────────────

/** Giải mã các cụm %XX hợp lệ (UTF-8), giữ nguyên '%' lẻ — tên file "100% sale.jpg" vẫn mở được. */
export function decodeUrlPath(raw: string): string {
  return String(raw || '').replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

/**
 * Phần sau /api/media/ của URL request → đường dẫn tương đối (phân cách '/') hoặc null nếu không hợp lệ.
 * Bỏ ?query/#hash, giải mã %XX đúng MỘT lần, '\' coi như '/', chặn NUL, `..`, đường dẫn rỗng; trên Windows chặn thêm
 * ':' (ổ đĩa / alternate data stream) và đoạn chỉ gồm dấu chấm / khoảng trắng.
 */
export function parseMediaRelPath(url: string, opts: PathOptions = {}): string | null {
  const windows = opts.windows ?? isWindowsDefault();
  const raw = String(url || '');
  const cut = raw.search(/[?#]/);
  const pathname = cut >= 0 ? raw.slice(0, cut) : raw;
  if (!pathname.startsWith(MEDIA_PREFIX)) return null;
  const decoded = decodeUrlPath(pathname.slice(MEDIA_PREFIX.length));
  if (decoded.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    if (windows && (segment.includes(':') || !segment.replace(/[. ]+$/, ''))) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/**
 * `target` nằm trong (hoặc chính là) thư mục `base`. Thay cho `startsWith(base)` trần — base "C:\x\media" không còn
 * khớp "C:\x\media2\...". Windows so không phân biệt hoa/thường.
 */
export function isPathInside(base: string, target: string, opts: PathOptions = {}): boolean {
  const windows = opts.windows ?? isWindowsDefault();
  const sep = windows ? '\\' : '/';
  const norm = (p: string) => {
    const s = windows ? String(p || '').replace(/\//g, '\\').toLowerCase() : String(p || '');
    return s.length > 1 && s.endsWith(sep) && !(windows && /^[a-z]:\\$/.test(s)) ? s.slice(0, -1) : s;
  };
  const b = norm(base);
  const t = norm(target);
  if (!b || !t) return false;
  if (t === b) return true;
  return t.startsWith(b.endsWith(sep) ? b : b + sep);
}

// ─── Phân loại file media ──────────────────────────────────────────────────

export type MediaScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'library'; ownerId: string }
  | { kind: 'shared' }
  /** Tên thư mục không phải dạng chuẩn (alias 8.3 '~', ':' của Windows) ở vị trí tài khoản → từ chối. */
  | { kind: 'invalid' };

/**
 * Phân loại đường dẫn tương đối so với thư mục media (dùng đường dẫn THẬT sau realpath).
 * `lookupAccount(segment)` → id tài khoản chuẩn (accounts.zalo_id) nếu segment là tài khoản, ngược lại null.
 */
export function classifyMediaPath(
  relPath: string,
  lookupAccount: (segment: string) => string | null,
  opts: PathOptions = {},
): MediaScope {
  const windows = opts.windows ?? isWindowsDefault();
  const segments = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  // Windows bỏ dấu chấm / khoảng trắng cuối tên. Từ khoá thư mục so không phân biệt hoa/thường ở mọi OS (ổ đĩa
  // Windows / macOS mặc định không phân biệt: "LIBRARY/…" vẫn là thư mục library).
  const clean = (s: string) => (windows ? s.replace(/[. ]+$/, '') : s);
  const key = (s: string) => clean(s).toLowerCase();
  const suspicious = (s: string) => windows && /[~:]/.test(s);

  let i = 0;
  if (segments.length > 1 && (key(segments[0]) === 'thumb' || key(segments[0]) === 'avatar')) i = 1;
  const scope = clean(segments[i] || '');
  if (!scope) return { kind: 'shared' };
  if (suspicious(scope)) return { kind: 'invalid' };

  if (key(scope) === 'library' && segments.length > i + 2) {
    const owner = clean(segments[i + 1]);
    if (!owner || suspicious(owner)) return { kind: 'invalid' };
    return { kind: 'library', ownerId: lookupAccount(owner) ?? owner };
  }

  const accountId = lookupAccount(scope) ?? (NUMERIC_ACCOUNT_DIR.test(scope) ? scope : null);
  return accountId ? { kind: 'account', accountId } : { kind: 'shared' };
}

// ─── Quyết định ────────────────────────────────────────────────────────────

export interface FileAccessEmployee {
  assigned_accounts?: string[] | null;
  /** Chỉ dùng cho log. */
  employee_id?: string;
}

export interface FileAccessDenied {
  status: 403;
  error: string;
  code: 'ACCOUNT_FORBIDDEN';
}

const ACCOUNT_DENIED: FileAccessDenied = { status: 403, error: 'Không có quyền truy cập tài khoản này', code: 'ACCOUNT_FORBIDDEN' };
const LIBRARY_DENIED: FileAccessDenied = { status: 403, error: 'Không có quyền xem thư viện của trang này', code: 'ACCOUNT_FORBIDDEN' };
const INVALID_DENIED: FileAccessDenied = { status: 403, error: 'Đường dẫn không hợp lệ', code: 'ACCOUNT_FORBIDDEN' };

function assignedSet(employee: FileAccessEmployee | null | undefined): Set<string> {
  return new Set((employee?.assigned_accounts || []).map(String));
}

/** Media của tài khoản: phải được giao (chưa giao tài khoản nào → không xem được — giống employeeAccess). */
export function canAccessAccount(employee: FileAccessEmployee | null | undefined, accountId: string): boolean {
  return !!accountId && assignedSet(employee).has(String(accountId));
}

/** Thư viện: giống resolveAccessibleOwners — chưa giao tài khoản nào = xem mọi thư viện. */
export function canAccessLibraryOwner(employee: FileAccessEmployee | null | undefined, ownerId: string): boolean {
  const assigned = assignedSet(employee);
  return assigned.size === 0 || assigned.has(String(ownerId || ''));
}

/** null = được tải. */
export function checkMediaAccess(employee: FileAccessEmployee | null | undefined, scope: MediaScope): FileAccessDenied | null {
  switch (scope.kind) {
    case 'account': return canAccessAccount(employee, scope.accountId) ? null : ACCOUNT_DENIED;
    case 'library': return canAccessLibraryOwner(employee, scope.ownerId) ? null : LIBRARY_DENIED;
    case 'invalid': return INVALID_DENIED;
    default: return null;
  }
}

/** Item thư viện (/api/library/file|thumb/:uuid) — null = được tải. */
export function checkLibraryAccess(employee: FileAccessEmployee | null | undefined, ownerId: string): FileAccessDenied | null {
  return canAccessLibraryOwner(employee, ownerId) ? null : LIBRARY_DENIED;
}

// ─── Range / cache ─────────────────────────────────────────────────────────

export type ByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Header Range → đoạn cần gửi. Không có / đơn vị khác bytes / nhiều đoạn → cả file (RFC cho phép bỏ qua Range).
 * `bytes=a-b` (b vượt cuối file thì cắt về cuối), `bytes=a-`, `bytes=-n` (n byte cuối). Số hỏng, a > b, a >= size,
 * file rỗng → 416 (xem unsatisfiableRangeHeader).
 */
export function parseByteRange(header: string | string[] | undefined, size: number): ByteRange {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = String(raw ?? '').trim();
  if (!value) return { kind: 'full' };
  const unit = /^bytes\s*=\s*(.*)$/i.exec(value);
  if (!unit) return { kind: 'full' };
  const spec = unit[1].trim();
  if (spec.includes(',')) return { kind: 'full' };
  const m = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!m || (!m[1] && !m[2])) return { kind: 'unsatisfiable' };
  const total = Math.max(0, Math.floor(Number(size) || 0));
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'unsatisfiable' };
  if (start >= total || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, total - 1) };
}

/** Content-Range của phản hồi 416. */
export function unsatisfiableRangeHeader(size: number): string {
  return `bytes */${Math.max(0, Math.floor(Number(size) || 0))}`;
}

/**
 * Header cache cho file đã xác thực: `private` để Cloudflare / proxy không lưu ở edge rồi phát cho người khác,
 * `Vary: Authorization` để cache trình duyệt không dùng lại cho phiên khác.
 */
export function privateCacheHeaders(maxAgeSeconds: number): Record<string, string> {
  return {
    'Cache-Control': `private, max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'Vary': 'Authorization',
  };
}
