/**
 * bossFileAccess.ts: file download permissions on Boss for employees (pure logic, tested in src/__tests__/employee/bossFileAccess.test.ts).
 *
 * Previously GET /api/media/* (chat media) and /api/library/file|thumb/* (library) served files WITHOUT login:
 * anyone who knew the Boss / tunnel URL could download customers' images, videos and documents. Now HttpRelayService requires an employee session
 * (Authorization: Bearer; the employee machine attaches it, see bossSessionAuth.ts) and then applies the rules here:
 *   - Media: the first-level folder (after an optional `thumb/` or `avatar/`) is an account id. Zalo / Facebook / Telegram all live under
 *     accounts.zalo_id, and FileStorageService saves to `media/<id>/...`, so the id must be in assigned_accounts (403 ACCOUNT_FORBIDDEN).
 *     A folder containing digits only is also treated as an account folder (a deleted account or a DB read error → blocked instead of opened).
 *     `media/library/<owner>/...` follows the library rules. Other folders (_avatars, erp, _uploads, old paths…) → any logged-in employee.
 *   - Library: the item's owner must be visible, the same as resolveAccessibleOwners (LibraryHandler): an employee with no assigned accounts can see every library.
 * The classification runs on the REAL file path (after realpath, relative to the media folder), so `..`, `%2e`, `\`, upper/lower case, Windows 8.3 names or trailing dots cannot get past the account check.
 */

import { tr } from '../../shared/i18n';

const MEDIA_PREFIX = '/api/media/';

/** A first-level folder with digits only = an account folder (Zalo uid, Facebook / Telegram id). Dates are stored as YYYY-MM-DD. */
const NUMERIC_ACCOUNT_DIR = /^\d{5,}$/;

const isWindowsDefault = (): boolean => typeof process !== 'undefined' && process.platform === 'win32';

export interface PathOptions {
  /** Windows file-name rules (default: for the machine that is running). */
  windows?: boolean;
}

// ─── Paths in the URL ───────────────────────────────────────────────────────

/** Decode valid %XX sequences (UTF-8), keep a lone '%' as is: a file named "100% sale.jpg" can still be opened. */
export function decodeUrlPath(raw: string): string {
  return String(raw || '').replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

/**
 * The part after /api/media/ in the request URL → a relative path (separated by '/') or null if invalid.
 * Strips ?query / #hash, decodes %XX exactly ONCE, treats '\' as '/', rejects NUL, `..`, and an empty path. On Windows it also rejects
 * ':' (drive / alternate data stream) and segments made only of dots / spaces.
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
 * `target` is inside (or is exactly) the `base` folder. Replaces a bare `startsWith(base)`: base "C:\x\media" no longer
 * matches "C:\x\media2\...". Windows compares case-insensitively.
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

// ─── Media file classification ──────────────────────────────────────────

export type MediaScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'library'; ownerId: string }
  | { kind: 'shared' }
  /** A folder name that is not in standard form (8.3 alias '~', Windows ':') at the account position → rejected. */
  | { kind: 'invalid' };

/**
 * Classifies a relative path against the media folder (uses the REAL path after realpath).
 * `lookupAccount(segment)` → the canonical account id (accounts.zalo_id) if the segment is an account, otherwise null.
 */
export function classifyMediaPath(
  relPath: string,
  lookupAccount: (segment: string) => string | null,
  opts: PathOptions = {},
): MediaScope {
  const windows = opts.windows ?? isWindowsDefault();
  const segments = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  // Windows drops trailing dots / spaces from names. Folder keywords are case-insensitive on every OS (the drive
  // Windows / macOS are case-insensitive by default: "LIBRARY/…" is still the library folder).
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

// ─── Decision ────────────────────────────────────────────────────────────

export interface FileAccessEmployee {
  assigned_accounts?: string[] | null;
  /** For logging only. */
  employee_id?: string;
}

export interface FileAccessDenied {
  status: 403;
  error: string;
  code: 'ACCOUNT_FORBIDDEN';
}

const ACCOUNT_DENIED: FileAccessDenied = { status: 403, error: tr('Không có quyền truy cập tài khoản này'), code: 'ACCOUNT_FORBIDDEN' };
const LIBRARY_DENIED: FileAccessDenied = { status: 403, error: tr('Không có quyền xem thư viện của trang này'), code: 'ACCOUNT_FORBIDDEN' };
const INVALID_DENIED: FileAccessDenied = { status: 403, error: tr('Đường dẫn không hợp lệ'), code: 'ACCOUNT_FORBIDDEN' };

function assignedSet(employee: FileAccessEmployee | null | undefined): Set<string> {
  return new Set((employee?.assigned_accounts || []).map(String));
}

/** Account media: must be assigned (no assigned account → cannot view, same as employeeAccess). */
export function canAccessAccount(employee: FileAccessEmployee | null | undefined, accountId: string): boolean {
  return !!accountId && assignedSet(employee).has(String(accountId));
}

/** Library: same as resolveAccessibleOwners; no assigned account = can view every library. */
export function canAccessLibraryOwner(employee: FileAccessEmployee | null | undefined, ownerId: string): boolean {
  const assigned = assignedSet(employee);
  return assigned.size === 0 || assigned.has(String(ownerId || ''));
}

/** null = allowed to download. */
export function checkMediaAccess(employee: FileAccessEmployee | null | undefined, scope: MediaScope): FileAccessDenied | null {
  switch (scope.kind) {
    case 'account': return canAccessAccount(employee, scope.accountId) ? null : ACCOUNT_DENIED;
    case 'library': return canAccessLibraryOwner(employee, scope.ownerId) ? null : LIBRARY_DENIED;
    case 'invalid': return INVALID_DENIED;
    default: return null;
  }
}

/** Library item (/api/library/file|thumb/:uuid): null = allowed to download. */
export function checkLibraryAccess(employee: FileAccessEmployee | null | undefined, ownerId: string): FileAccessDenied | null {
  return canAccessLibraryOwner(employee, ownerId) ? null : LIBRARY_DENIED;
}

// ─── Range / cache ─────────────────────────────────────────────────────────

export type ByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Range header → the part to send. Missing / a unit other than bytes / multiple ranges → the whole file (RFC allows ignoring Range).
 * `bytes=a-b` (if b is past the end of the file it is cut to the end), `bytes=a-`, `bytes=-n` (the last n bytes). Broken numbers, a > b, a >= size,
 * or an empty file → 416 (see unsatisfiableRangeHeader).
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

/** Content-Range of a 416 response. */
export function unsatisfiableRangeHeader(size: number): string {
  return `bytes */${Math.max(0, Math.floor(Number(size) || 0))}`;
}

/**
 * Cache headers for an authenticated file: `private` so Cloudflare / proxies do not store it at the edge and serve it to others,
 * `Vary: Authorization` so the browser cache does not reuse it for another session.
 */
export function privateCacheHeaders(maxAgeSeconds: number): Record<string, string> {
  return {
    'Cache-Control': `private, max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'Vary': 'Authorization',
  };
}
