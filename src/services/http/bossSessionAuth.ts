/**
 * bossSessionAuth.ts: (employee machine, main process) Boss URL → employee session token, for downloading Boss's files.
 *
 * Boss requires `Authorization: Bearer <token>` for /api/media/* and /api/library/file|thumb/* (bossFileAccess.ts),
 * but the renderer puts the Boss URL straight into <img>/<video>, and that tag cannot send a header. So:
 *   - HttpConnectionManager writes workspace → (Boss URL, token) here on every connect / URL-token change, and clears it on disconnect.
 *     When the app opens it is preloaded from the workspace config (the renderer shows images before the connection finishes).
 *   - installBossFileAuthHook: session.webRequest.onBeforeSendHeaders attaches the header ONLY to requests to a registered Boss,
 *     originating from the main frame of the main window: not to plugin iframes, <webview>, or the in-app browser.
 *   - Main-process code that downloads Boss files itself (MediaCacheService, FileStorageService…) uses bossAuthHeaders(url).
 * Matching uses the normalized URL origin (protocol + host + port + sub-path), not just the host; http and https are two different
 * origins (the token of an https Boss is not sent over http).
 */
import type { Session } from 'electron';
import { normalizeBossUrl } from '../../shared/employee/employeeConnection';

/** URL pattern for webRequest (Chromium match pattern; `*` host matches any port). Exact filtering happens in findBossSession. */
export const BOSS_FILE_URL_PATTERNS = ['*://*/*api/media/*', '*://*/*api/library/*'];

/** Only the file routes: the token is not sent with other requests to the same host. */
const BOSS_FILE_PATH = /^\/api\/(?:media|library)\//;

export interface BossSession {
  workspaceId: string;
  /** `${protocol}//${host}`: host in lowercase, default port removed (per the WHATWG URL spec). */
  origin: string;
  /** The sub-path of the Boss URL, without a trailing '/' ('' = root). */
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

/** Write / update a workspace's session (an empty URL or token → clear it). */
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

/** Write only if the workspace has no session yet (loaded from config when the app opens; does not overwrite the credentials in use). */
export function seedBossSession(workspaceId: string, bossUrl: string | null | undefined, token: string | null | undefined): void {
  if (!sessions.has(String(workspaceId || ''))) setBossSession(workspaceId, bossUrl, token);
}

export function removeBossSession(workspaceId: string): void {
  sessions.delete(String(workspaceId || ''));
}

export function clearBossSessions(): void {
  sessions.clear();
}

/** Preferred workspace when several workspaces share the same Boss URL (default: the active workspace). */
export function setPreferredBossWorkspace(fn: () => string | undefined): void {
  preferredWorkspace = typeof fn === 'function' ? fn : () => undefined;
}

/**
 * Boss session for a file URL: same origin, the path is under the Boss sub-path (on a '/' boundary) and is a file route.
 * Several sessions match → the longest sub-path, then the preferred workspace, then the most recently written session.
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

/** Authorization header for a registered Boss file URL; `{}` for any other URL (Zalo CDN, Facebook…). */
export function bossAuthHeaders(url: string, preferWorkspaceId?: string): Record<string, string> {
  const session = findBossSession(url, preferWorkspaceId);
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

// ─── webRequest hook (main window) ─────────────────────────────────────────

export interface RequestOrigin {
  webContentsId?: number;
  frame?: { readonly parent: unknown } | null;
}

/**
 * A request made by the main frame of the main window. If frame info is present, it must be the main frame (plugin iframes are excluded).
 * If the frame no longer exists (navigated away / cancelled) or reading it fails, rely on the webContentsId only.
 */
export function isMainWindowMainFrameRequest(details: RequestOrigin, mainWebContentsId: number | null | undefined): boolean {
  if (mainWebContentsId === null || mainWebContentsId === undefined) return false;
  if (details.webContentsId !== mainWebContentsId) return false;
  try {
    const frame = details.frame;
    if (frame) return frame.parent === null || frame.parent === undefined;
  } catch { /* frame disposed → use webContentsId */ }
  return true;
}

function hasHeader(headers: Record<string, unknown>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Attaches `Authorization` to the renderer's <img>/<video>/fetch requests for Boss files. It does not overwrite a header the renderer set itself
 * (RestQueryService sends its own token for /api/library/items…).
 * ⚠️ Electron keeps only ONE listener per webRequest event per session (registering again replaces the old one):
 * this must be the ONLY onBeforeSendHeaders of the main window's session; anything else needs to be merged into here.
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
    } catch { /* do not block the request because the hook failed */ }
    callback({ requestHeaders: details.requestHeaders });
  });
}
