/**
 * FacebookUtils.ts
 * Port từ Python _core/_utils.py
 * Helper functions dùng chung cho tất cả Facebook services
 */

import { FBSessionData } from './FacebookTypes';

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
  host: string = 'www.facebook.com'
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
  };
}

/**
 * Build axios config cho một GET request đến Facebook
 */
export function buildGetConfig(url: string, cookie: string, host: string = 'www.facebook.com') {
  return {
    url,
    headers: buildHeaders(cookie, undefined, host),
    timeout: 30000,
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

