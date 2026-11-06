/**
 * Link và điều hướng của cửa sổ chính. Preload gắn electronAPI cho mọi trang cửa sổ chính hiển thị, nên cửa sổ chính chỉ
 * được ở giao diện Deplao:
 *  - will-navigate: chỉ cho về giao diện của app (bản cài: đúng file dist/index.html; bản dev: Vite). Link web mở bằng
 *    trình duyệt của máy (giữ phiên đăng nhập của người dùng), còn lại chặn.
 *  - window.open / target="_blank" / bấm chuột giữa: không mở cửa sổ Electron; link web mở bằng trình duyệt của máy.
 *  - shell.openExternal chỉ nhận http, https, mailto: link lạ (file:, ms-msdt:, ...) có thể chạy chương trình trên máy.
 *  - Link Telegram / nhóm Zalo (window.open, target="_blank" trong Mini App…): gửi về giao diện mở trong app
 *    (app:openChatLink → lib/chat/links/chatLinks), như bấm link trong tin.
 */
import { pathToFileURL } from 'url';
import { parseGroupLink } from '../../src/shared/crm/groupLinks';
import { parseTelegramLink } from '../../src/shared/telegram/telegramLinks';

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Link được mở bằng ứng dụng mặc định của máy (trình duyệt, ứng dụng thư). */
export function isExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  return url.protocol === 'mailto:' || !!url.hostname;
}

/** Link app tự mở được (Telegram, nhóm Zalo): giao diện xử lý thay vì trình duyệt. */
export function isInAppChatLink(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return false;
  if (!/^(https?:\/\/|tg:)/i.test(raw)) return false;
  return parseTelegramLink(raw) !== null || parseGroupLink(raw)?.channel === 'zalo';
}

export interface AppUrlOptions {
  isDev: boolean;
  /** Vite của bản dev, vd http://localhost:27799 */
  devOrigin: string;
  /** File giao diện của bản cài (dist/index.html) */
  entryFile: string;
  platform?: NodeJS.Platform;
}

/** Điều hướng vẫn ở giao diện Deplao (đổi hash / query, tải lại). Bản cài: đúng file giao diện, không phải file khác trên máy. */
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
  /** Bị chặn nhưng là link web / thư: mở bằng ứng dụng của máy. */
  openExternal: string | null;
}

/** will-navigate của khung chính: ở lại giao diện thì cho; link web / thư thì mở ngoài; còn lại chặn. */
export function mainFrameNavigation(raw: string, opts: AppUrlOptions): MainFrameNavigation {
  if (isAppUrl(raw, opts)) return { allow: true, openExternal: null };
  return { allow: false, openExternal: isExternalUrl(raw) ? raw : null };
}
