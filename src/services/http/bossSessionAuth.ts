/**
 * bossSessionAuth.ts — (máy nhân viên, main process) Boss URL → token phiên nhân viên, để tải file của Boss.
 *
 * Boss bắt buộc `Authorization: Bearer <token>` cho /api/media/* và /api/library/file|thumb/* (bossFileAccess.ts),
 * nhưng renderer nhét thẳng URL Boss vào <img>/<video> — thẻ đó không gửi header được. Nên:
 *   - HttpConnectionManager ghi workspace → (Boss URL, token) vào đây mỗi lần kết nối / đổi URL-token, xoá khi ngắt.
 *     Lúc mở app nạp sẵn từ cấu hình workspace (renderer hiện ảnh trước khi kết nối xong).
 *   - installBossFileAuthHook: session.webRequest.onBeforeSendHeaders gắn header CHỈ cho request tới Boss đã đăng ký,
 *     xuất phát từ khung chính (main frame) của cửa sổ chính — không cho iframe plugin, <webview>, trình duyệt nội bộ.
 *   - Code main tự tải file Boss (MediaCacheService, FileStorageService…) dùng bossAuthHeaders(url).
 * Khớp theo gốc URL đã chuẩn hoá (giao thức + host + cổng + sub-path), không chỉ host; http và https là hai gốc khác
 * nhau (không gửi token của Boss https qua http).
 */
import type { Session } from 'electron';
import { normalizeBossUrl } from '../../shared/employee/employeeConnection';

/** Mẫu URL cho webRequest (Chromium match pattern; `*` host khớp mọi cổng). Lọc chính xác ở findBossSession. */
export const BOSS_FILE_URL_PATTERNS = ['*://*/*api/media/*', '*://*/*api/library/*'];

/** Chỉ các route file — token không đi kèm request khác tới cùng host. */
const BOSS_FILE_PATH = /^\/api\/(?:media|library)\//;

export interface BossSession {
  workspaceId: string;
  /** `${protocol}//${host}` — host đã chữ thường, bỏ cổng mặc định (theo WHATWG URL). */
  origin: string;
  /** Sub-path của Boss URL, không có '/' cuối ('' = gốc). */
  basePath: string;
  token: string;
  updatedAt: number;
}

const sessions = new Map<string, BossSession>();
let preferredWorkspace: () => string | undefined = () => undefined;
let clock = 0;

function parseBase(bossUrl: string): { origin: string; basePath: string } | null {
  const normalized = normalizeBossUrl(bossUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { origin: `${u.protocol}//${u.host}`, basePath: u.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

/** Ghi / cập nhật phiên của workspace (URL hoặc token rỗng → xoá). */
export function setBossSession(workspaceId: string, bossUrl: string | null | undefined, token: string | null | undefined): void {
  const id = String(workspaceId || '');
  const base = parseBase(String(bossUrl ?? ''));
  const tok = String(token ?? '').trim();
  if (!id) return;
  if (!base || !tok) {
    sessions.delete(id);
    return;
  }
  sessions.set(id, { workspaceId: id, ...base, token: tok, updatedAt: ++clock });
}

/** Chỉ ghi khi workspace chưa có phiên (nạp từ cấu hình lúc mở app — không đè credentials đang dùng). */
export function seedBossSession(workspaceId: string, bossUrl: string | null | undefined, token: string | null | undefined): void {
  if (!sessions.has(String(workspaceId || ''))) setBossSession(workspaceId, bossUrl, token);
}

export function removeBossSession(workspaceId: string): void {
  sessions.delete(String(workspaceId || ''));
}

export function clearBossSessions(): void {
  sessions.clear();
}

/** Workspace ưu tiên khi nhiều workspace cùng một Boss URL (mặc định: workspace đang active). */
export function setPreferredBossWorkspace(fn: () => string | undefined): void {
  preferredWorkspace = typeof fn === 'function' ? fn : () => undefined;
}

/**
 * Phiên Boss cho URL file: cùng origin, đường dẫn nằm dưới sub-path của Boss (theo ranh giới '/') và là route file.
 * Nhiều phiên khớp → sub-path dài nhất, rồi workspace ưu tiên, rồi phiên ghi gần nhất.
 */
export function findBossSession(url: string, preferWorkspaceId?: string): BossSession | null {
  if (sessions.size === 0) return null;
  let u: URL;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const origin = `${u.protocol}//${u.host}`;
  let prefer = preferWorkspaceId;
  if (prefer === undefined) {
    try { prefer = preferredWorkspace(); } catch { prefer = undefined; }
  }
  let best: BossSession | null = null;
  for (const session of sessions.values()) {
    if (session.origin !== origin) continue;
    const { basePath } = session;
    if (basePath && u.pathname !== basePath && !u.pathname.startsWith(`${basePath}/`)) continue;
    if (!BOSS_FILE_PATH.test(u.pathname.slice(basePath.length))) continue;
    if (!best
      || basePath.length > best.basePath.length
      || (basePath.length === best.basePath.length && rank(session, prefer) > rank(best, prefer))) {
      best = session;
    }
  }
  return best;
}

function rank(session: BossSession, prefer: string | undefined): number {
  return (prefer && session.workspaceId === prefer ? 1e12 : 0) + session.updatedAt;
}

/** Header Authorization cho URL file của Boss đã đăng ký; `{}` với mọi URL khác (CDN Zalo, Facebook…). */
export function bossAuthHeaders(url: string, preferWorkspaceId?: string): Record<string, string> {
  const session = findBossSession(url, preferWorkspaceId);
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

// ─── Hook webRequest (cửa sổ chính) ─────────────────────────────────────────

export interface RequestOrigin {
  webContentsId?: number;
  frame?: { readonly parent: unknown } | null;
}

/**
 * Request do khung chính của cửa sổ chính tạo ra. Có thông tin frame → phải là main frame (iframe plugin bị loại);
 * frame không còn (đã điều hướng / huỷ) hoặc đọc lỗi → chỉ dựa vào webContentsId.
 */
export function isMainWindowMainFrameRequest(details: RequestOrigin, mainWebContentsId: number | null | undefined): boolean {
  if (mainWebContentsId === null || mainWebContentsId === undefined) return false;
  if (details.webContentsId !== mainWebContentsId) return false;
  try {
    const frame = details.frame;
    if (frame) return frame.parent === null || frame.parent === undefined;
  } catch { /* frame đã dispose → dùng webContentsId */ }
  return true;
}

function hasHeader(headers: Record<string, unknown>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Gắn `Authorization` cho <img>/<video>/fetch của renderer tới file Boss. Không ghi đè header renderer tự đặt
 * (RestQueryService gửi token riêng cho /api/library/items…).
 * ⚠️ Electron chỉ giữ MỘT listener cho mỗi sự kiện webRequest của một session (gọi lại = thay listener cũ):
 * đây phải là onBeforeSendHeaders DUY NHẤT của session cửa sổ chính — cần thêm xử lý thì gộp vào đây.
 */
export function installBossFileAuthHook(
  ses: Session,
  getMainWebContentsId: () => number | null | undefined,
): void {
  ses.webRequest.onBeforeSendHeaders({ urls: BOSS_FILE_URL_PATTERNS }, (details, callback) => {
    try {
      if (!hasHeader(details.requestHeaders, 'authorization')
        && isMainWindowMainFrameRequest(details, getMainWebContentsId())) {
        const session = findBossSession(details.url);
        if (session) {
          callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${session.token}` } });
          return;
        }
      }
    } catch { /* không chặn request vì lỗi hook */ }
    callback({ requestHeaders: details.requestHeaders });
  });
}
