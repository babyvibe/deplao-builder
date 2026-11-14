/**
 * Links and navigation of the main window. Preload attaches electronAPI to every page the main window shows, so the main window can
 * only stay in the Deplao UI:
 *  - will-navigate: only allows navigation to the app UI (installed build: exactly dist/index.html; dev build: Vite). Web links open in
 *    the machine's browser (keeps the user's login session); everything else is blocked.
 *  - window.open / target="_blank" / middle-click: does not open an Electron window; web links open in the machine's browser.
 *  - shell.openExternal only accepts http, https, mailto: unknown links (file:, ms-msdt:, ...) can run programs on the machine.
 *  - Telegram / Zalo group links (window.open, target="_blank" inside a Mini App…): sent to the UI, which opens them inside the app
 *    (app:openChatLink → lib/chat/links/chatLinks), like clicking a link in a message.
 */
import { pathToFileURL } from 'url';
import { parseGroupLink } from '../../src/shared/crm/groupLinks';
import { parseTelegramLink } from '../../src/shared/telegram/telegramLinks';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Link opened with the machine's default app (browser, mail app). */
export function isExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  return url.protocol === 'mailto:' || !!url.hostname;
}

/** Links the app can open itself (Telegram, Zalo groups): the UI handles them instead of the browser. */
export function isInAppChatLink(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return false;
  if (!/^(https?:\/\/|tg:)/i.test(raw)) return false;
  return parseTelegramLink(raw) !== null || parseGroupLink(raw)?.channel === 'zalo';
}

export interface AppUrlOptions {
  isDev: boolean;
  /** Vite of the dev build, e.g. http://localhost:27799 */
  devOrigin: string;
  /** UI file of the installed build (dist/index.html) */
  entryFile: string;
  platform?: NodeJS.Platform;
}

/** Navigation stays in the Deplao UI (hash / query change, reload). Installed build: only the UI file itself, not any other file on the machine. */
export function isAppUrl(raw: string, opts: AppUrlOptions): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (opts.isDev) {
    try { return url.origin === new URL(opts.devOrigin).origin; } catch { return false; }
  }
  if (url.protocol !== 'file:') return false;
  const entry = pathToFileURL(opts.entryFile);
  if (url.host !== entry.host) return false;
  let target: string;
  let own: string;
  try {
    target = decodeURIComponent(url.pathname);
    own = decodeURIComponent(entry.pathname);
  } catch { return false; }
  return (opts.platform ?? process.platform) === 'win32' ? target.toLowerCase() === own.toLowerCase() : target === own;
}

export interface MainFrameNavigation {
  allow: boolean;
  /** Blocked, but it is a web / mail link: open it with the machine's app. */
  openExternal: string | null;
}

/** will-navigate of the main frame: staying in the UI is allowed; web / mail links open externally; everything else is blocked. */
export function mainFrameNavigation(raw: string, opts: AppUrlOptions): MainFrameNavigation {
  if (isAppUrl(raw, opts)) return { allow: true, openExternal: null };
  return { allow: false, openExternal: isExternalUrl(raw) ? raw : null };
}
