/**
 * FacebookUtils.ts
 * Port từ Python _core/_utils.py
 * Helper functions dùng chung cho tất cả Facebook services
 */

import { FBSessionData } from './FacebookTypes';
import Logger from '../../utils/Logger';

// ─── Base Conversion ──────────────────────────────────────────────────────────

function digitToChar(digit: number): string {
  if (digit < 10) return String(digit);
  return String.fromCharCode('a'.charCodeAt(0) + digit - 10);
}

export function strBase(number: number, base: number): string {
  if (number < 0) return '-' + strBase(-number, base);
  const d = Math.floor(number / base);
  const m = number % base;
  if (d > 0) return strBase(d, base) + digitToChar(m);
  return digitToChar(m);
}

// ─── Cookie Helpers ───────────────────────────────────────────────────────────

/**
 * Parse cookie string thành object
 * "c_user=123; xs=abc; ..." → { c_user: "123", xs: "abc" }
 */
export function parseCookieString(cookieString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const cookies = cookieString.split(';');
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf('=');
    if (eqIdx > 0) {
      const key = cookie.slice(0, eqIdx).trim();
      const value = cookie.slice(eqIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

/**
 * Lấy c_user (Facebook ID) từ cookie string
 */
export function getFacebookIDFromCookie(cookie: string): string | null {
  const parsed = parseCookieString(cookie);
  return parsed['c_user'] || null;
}

// ─── Random / ID Generation ───────────────────────────────────────────────────

let _reqCounter = 0;

export function getNextReqId(): string {
  _reqCounter += 1;
  return strBase(_reqCounter, 36);
}

export function generateSessionId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function generateClientId(): string {
  const gen = (length: number) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  };
  return `${gen(8)}-${gen(4)}-${gen(4)}-${gen(4)}-${gen(12)}`;
}

export function randStr(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Generate threading ID (offline_threading_id / message_id)
 * Port từ Python gen_threading_id()
 */
export function genThreadingId(): string {
  const timeBinary = (Date.now()).toString(2);
  const randomBinary = (Math.floor(Math.random() * 4294967295)).toString(2).padStart(22, '0').slice(-22);
  return String(parseInt(timeBinary + randomBinary, 2));
}

// ─── Request Helpers ──────────────────────────────────────────────────────────

/**
 * Build standard HTTP headers cho Facebook requests
 */
export function buildHeaders(cookie: string, contentLength?: number, host: string = 'www.facebook.com'): Record<string, string> {
  const headers: Record<string, string> = {
    'Host': host,
    'Connection': 'keep-alive',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Origin': `https://${host}`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': `https://${host}`,
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': cookie,
  };
  if (contentLength !== undefined) {
    headers['Content-Length'] = String(contentLength);
  }
  return headers;
}

/**
 * Build standard form data từ FBSessionData
 * Port từ Python formAll() trong _utils.py
 */
export function buildFormData(
  dataFB: FBSessionData,
  opts?: {
    friendlyName?: string;
    docId?: string | number;
    requireGraphql?: boolean;
  }
): Record<string, string> {
  const reqId = getNextReqId();
  const form: Record<string, string> = {
    'fb_dtsg': dataFB.fb_dtsg,
    'jazoest': dataFB.jazoest,
    '__a': '1',
    '__user': dataFB.FacebookID,
    '__req': reqId,
    '__rev': dataFB.clientRevision,
    'av': dataFB.FacebookID,
  };

  if (opts?.requireGraphql !== false) {
    form['fb_api_caller_class'] = 'RelayModern';
    form['fb_api_req_friendly_name'] = opts?.friendlyName || '';
    form['server_timestamps'] = 'true';
    form['doc_id'] = String(opts?.docId || '');
  }

  return form;
}

/**
 * Minimal JSON stringify (no extra spaces)
 */
export function jsonMinimal(data: any): string {
  return JSON.stringify(data);
}

/**
 * Extract data từ HTML string bằng cặp delimiters
 * Port từ Python dataSplit()
 */
export function dataSplit(html: string, before: string, after: string): string {
  const startIdx = html.indexOf(before);
  if (startIdx === -1) throw new Error(`dataSplit: "${before}" not found`);
  const valueStart = startIdx + before.length;
  const endIdx = html.indexOf(after, valueStart);
  if (endIdx === -1) throw new Error(`dataSplit: closing "${after}" not found`);
  return html.slice(valueStart, endIdx);
}

/**
 * Parse "for (;;);" prefix từ Facebook JSON responses
 */
export function parseFBResponse(text: string): any {
  const cleaned = text.replace(/^for\s*\(;;\);/, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Build axios config cho một POST request đến Facebook
 */
export function buildPostConfig(
  url: string,
  formData: Record<string, string>,
  cookie: string,
  host: string = 'www.facebook.com',
  httpsAgent?: any
) {
  const body = new URLSearchParams(formData).toString();
  return {
    url,
    data: body,
    headers: {
      ...buildHeaders(cookie, body.length, host),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 30000,
    ...(httpsAgent ? { httpsAgent } : {}),
  };
}

/**
 * Build axios config cho một GET request đến Facebook
 */
export function buildGetConfig(url: string, cookie: string, host: string = 'www.facebook.com', httpsAgent?: any) {
  return {
    url,
    headers: buildHeaders(cookie, undefined, host),
    timeout: 30000,
    ...(httpsAgent ? { httpsAgent } : {}),
  };
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limit delay ngẫu nhiên để tránh bị FB detect spam
 * 300–800ms
 */
export function rateLimitDelay(): Promise<void> {
  const ms = 300 + Math.floor(Math.random() * 500);
  return sleep(ms);
}

// ─── E2EE / JID Helpers ──────────────────────────────────────────────────────

/** Default E2EE Messenger server suffix */
const E2EE_MESSENGER_SERVER = 'msgr';

/** Cookies recommended by the E2EE bridge for pairing. Only c_user + xs are truly required. */
export const E2EE_REQUIRED_COOKIES = ['c_user', 'xs'];
export const E2EE_OPTIONAL_COOKIES = ['datr', 'fr', 'sb'];

/**
 * Chuẩn hóa target thành JID đầy đủ cho E2EE.
 * Hỗ trợ: fbid:123 / facebook:123 / 12345678 / 12345678@msgr
 * Port từ Python normalize_chat_jid()
 */
export function normalizeChatJid(
  target: string | number,
  defaultServer: string = E2EE_MESSENGER_SERVER,
): string {
  let targetStr = String(target ?? '').trim();
  if (!targetStr) {
    throw new Error('Thiếu chat_jid hoặc Facebook user ID để gửi E2EE.');
  }

  // Strip "fbid:" / "facebook:" prefix
  const lower = targetStr.toLowerCase();
  if (lower.startsWith('fbid:') || lower.startsWith('facebook:')) {
    targetStr = targetStr.split(':')[1]?.trim() ?? targetStr;
  }

  // Already a full JID
  if (targetStr.includes('@')) return targetStr;

  // Must be numeric Facebook ID
  if (!/^\d+$/.test(targetStr)) {
    throw new Error(
      `chat_jid phải là JID đầy đủ (\`<id>@msgr\`) hoặc Facebook numeric ID. ` +
      `Giá trị nhận được: ${JSON.stringify(targetStr)}`,
    );
  }

  const server = (defaultServer || E2EE_MESSENGER_SERVER).trim().replace(/^@/, '');
  return `${targetStr}@${server}`;
}

/**
 * Tạo JID từ Facebook user ID
 * Port từ Python chat_jid_from_user_id()
 */
export function chatJidFromUserId(userId: string | number): string {
  return normalizeChatJid(userId);
}

/**
 * Parse cookie string → trích cookies cần cho E2EE bridge.
 * Chỉ thực sự require: c_user + xs. Các cookie còn lại (datr, fr, sb) là optional.
 * wd, presence là ephemeral/JS-set - không bao giờ có trong saved cookie.
 */
export function parseE2EECookies(cookieString: string): Record<string, string> {
  const all = parseCookieString(cookieString);
  const required = new Set(E2EE_REQUIRED_COOKIES); // ['c_user', 'xs']
  const optional = new Set(E2EE_OPTIONAL_COOKIES);  // ['datr', 'fr', 'sb']
  const allE2EE = new Set([...required, ...optional]);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (allE2EE.has(k)) result[k] = v;
  }

  // Chỉ kiểm tra 2 cookies bắt buộc
  const missing = E2EE_REQUIRED_COOKIES.filter(k => !result[k]);
  if (missing.length > 0) {
    throw new Error(
      `Thiếu cookie bắt buộc cho E2EE bridge: ${missing.join(', ')}. ` +
      `Đảm bảo cookie chứa: c_user và xs`,
    );
  }

  // Log optional missing cookies (không throw)
  const optionalMissing = E2EE_OPTIONAL_COOKIES.filter(k => !result[k]);
  if (optionalMissing.length > 0) {
    Logger.warn(`[parseE2EECookies] Thiếu cookies optional: ${optionalMissing.join(', ')} - bridge có thể limited`);
  }

  return result;
}

/**
 * Tìm một binary Go trong src/bridge-e2ee/build/ (cùng chỗ với E2EE bridge).
 * Thứ tự: biến môi trường `envVar` → process.resourcesPath → build/ khi dev.
 */
function findBridgeBinary(baseName: string, envVar: string): string | null {
  // 1. Environment variable override
  const override = process.env[envVar];
  if (override) {
    return override;
  }

  // 2. Bundled with Electron app (production)
  const path = require('path');
  const fs = require('fs');
  const binaryName = process.platform === 'win32' ? `${baseName}.exe` : baseName;

  if ((process as any).resourcesPath) {
    const rp = (process as any).resourcesPath;
    // 2a. Direct file in resources/
    const bundled = path.join(rp, binaryName);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
    // 2b. Fallback: search subdirectories (electron-builder may nest extraResources)
    try {
      const entries = fs.readdirSync(rp, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const nested = path.join(rp, entry.name, binaryName);
          if (fs.existsSync(nested)) {
            return nested;
          }
        }
      }
    } catch { /* ignore readdir errors */ }
  }

  // 3. Development: look for it in build/ relative to project root
  // __dirname is in src/services/facebook (raw TS) or dist-electron/src/services/facebook (compiled)
  // Bridge is now at src/bridge-e2ee/build/
  const candidates = [
    // raw TS: src/services/facebook → ../../src/bridge-e2ee/build/
    path.join(__dirname, '..', '..', 'bridge-e2ee', 'build', binaryName),
    // compiled: dist-electron/src/services/facebook → ../../../src/bridge-e2ee/build/
    path.join(__dirname, '..', '..', '..', '..', 'src', 'bridge-e2ee', 'build', binaryName),
    // fallback: old locations (pre-move)
    path.join(__dirname, '..', '..', '..', 'bridge-e2ee', 'build', binaryName),
    path.join(__dirname, '..', '..', '..', '..', 'bridge-e2ee', 'build', binaryName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve đường dẫn đến Go bridge binary.
 * Thứ tự: FBCHAT_E2EE_BIN env → process.resourcesPath → error
 */
export function resolveE2EEBinaryPath(): string {
  const found = findBridgeBinary('fbchat-bridge-e2ee', 'FBCHAT_E2EE_BIN');
  if (found) return found;
  const binaryName = process.platform === 'win32' ? 'fbchat-bridge-e2ee.exe' : 'fbchat-bridge-e2ee';
  throw new Error(
    `Không tìm thấy E2EE bridge binary (${binaryName}). ` +
    `Đặt biến môi trường FBCHAT_E2EE_BIN hoặc build bridge từ bridge-e2ee/. ` +
    `Xem docs: bridge-e2ee/README.md`,
  );
}

/**
 * Resolve đường dẫn đến trình đăng nhập Facebook (fbchat-login-bridge, build
 * từ src/bridge-e2ee/login cùng lúc với E2EE bridge).
 * Thứ tự: FBCHAT_LOGIN_BIN env → process.resourcesPath → build/ khi dev
 */
export function resolveNativeLoginBinaryPath(): string {
  const found = findBridgeBinary('fbchat-login-bridge', 'FBCHAT_LOGIN_BIN');
  if (found) return found;
  const binaryName = process.platform === 'win32' ? 'fbchat-login-bridge.exe' : 'fbchat-login-bridge';
  throw new Error(
    `Thiếu trình đăng nhập Facebook (${binaryName}). ` +
    `Bản cài đặt cần được cập nhật; khi phát triển, chạy lại "npm run dev" hoặc "npm run build:bridge-e2ee" để build.`,
  );
}

