/**
 * FacebookSession.ts
 * Port từ Python _core/_session.py
 * Khởi tạo Facebook session từ cookie - parse fb_dtsg, jazoest, FacebookID, etc.
 */

import axios from 'axios';
import { FBSessionData } from './FacebookTypes';
import { dataSplit } from './FacebookUtils';
import Logger from '../../utils/Logger';

const FB_HOME_URL = 'https://www.facebook.com/';

/** Các field bắt buộc phải parse được để session hợp lệ */
const REQUIRED_SESSION_FIELDS: (keyof FBSessionData)[] = [
  'fb_dtsg', 'jazoest', 'sessionID', 'FacebookID', 'clientRevision',
];

// Parse order: [name, startDelimiter, endDelimiter]
const SESSION_FIELDS: [keyof FBSessionData, string, string][] = [
  ['fb_dtsg',         'DTSGInitialData",[],{"token":"', '"'],
  ['fb_dtsg_ag',      'async_get_token":"',              '"'],
  ['jazoest',         'jazoest=',                        '"'],
  ['hash',            'hash":"',                         '"'],
  ['sessionID',       'sessionId":"',                    '"'],
  ['FacebookID',      '"actorID":"',                     '"'],
  ['clientRevision',  'client_revision":',               ','],
];

function hasValue(value: any): boolean {
  return value != null && String(value).trim() !== '';
}

/**
 * Full browser-like headers cho Facebook requests
 */
export function fbHeaders(cookie: string): Record<string, string> {
  return {
    'authority': 'www.facebook.com',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5',
    'cache-control': 'max-age=0',
    'cookie': cookie,
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  };
}

/**
 * Fetch Facebook homepage HTML với đầy đủ headers
 * @throws Error nếu HTTP request thất bại
 */
export async function fetchFBHomepage(cookie: string, httpsAgent?: any): Promise<string> {
  try {
    const response = await axios.get(FB_HOME_URL, {
      headers: fbHeaders(cookie),
      withCredentials: false,
      timeout: 60000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    return response.data as string;
  } catch (err: any) {
    const status = err.response?.status ?? '?';
    const msg = err.message || 'Unknown error';
    throw new Error(`[FacebookSession] Cannot fetch Facebook homepage (HTTP ${status}): ${msg}`);
  }
}

/**
 * Khởi tạo session từ cookie string
 * Trả về FBSessionData với tất cả thông tin cần thiết cho mọi request.
 *
 * Port từ Python _core/_session.py dataGetHome() - bao gồm:
 * - Parse tất cả session fields từ homepage HTML
 * - Validate REQUIRED_SESSION_FIELDS
 * - Throw error nếu thiếu field bắt buộc hoặc HTTP request thất bại
 *
 * @throws Error nếu không fetch được homepage hoặc thiếu session fields bắt buộc
 */
export async function initSession(cookie: string, httpsAgent?: any): Promise<FBSessionData> {
  let html: string;
  try {
    html = await fetchFBHomepage(cookie, httpsAgent);
  } catch (err: any) {
    Logger.error(err.message);
    throw err;
  }

  const result: Partial<FBSessionData> = {};
  const parseErrors: string[] = [];

  for (const [name, start, end] of SESSION_FIELDS) {
    try {
      result[name] = dataSplit(html, start, end);
    } catch {
      parseErrors.push(name);
      result[name] = null as any;
    }
  }

  result.cookieFacebook = cookie;

  // Validate required fields (port từ Python REQUIRED_SESSION_FIELDS)
  const missing = REQUIRED_SESSION_FIELDS.filter((f) => !hasValue(result[f]));
  if (missing.length > 0) {
    const errMsg = `[FacebookSession] Missing required session fields: ${missing.join(', ')}`
      + (parseErrors.length > 0 ? ` (parse errors: ${parseErrors.join(', ')})` : '');
    Logger.error(errMsg);
    throw new Error(errMsg);
  }

  // Validate FacebookID là số (port từ Python)
  const fbId = String(result.FacebookID || '').trim();
  if (fbId && !fbId.match(/^\d+$/)) {
    throw new Error(`[FacebookSession] FacebookID is not numeric: ${fbId}`);
  }

  return result as FBSessionData;
}

/**
 * Kiểm tra cookie có còn sống không
 * Cookie alive = có parse được FacebookID từ homepage
 */
export async function checkCookieAlive(cookie: string, httpsAgent?: any): Promise<boolean> {
  try {
    await initSession(cookie, httpsAgent);
    // initSession() đã validate required fields + FacebookID - nếu không throw là OK
    return true;
  } catch (err: any) {
    Logger.warn(`[FacebookSession] checkCookieAlive error: ${err.message}`);
    return false;
  }
}

/**
 * Login bằng username/password (mobile/Android qua b-graph hoặc Messenger Lite)
 * chỉ trả về cookie phiên tối thiểu (c_user, xs, datr, fr). Trang www.facebook.com
 * khi mở bằng trình duyệt còn set thêm cookie web (sb, wd, presence, ...) qua
 * Set-Cookie; thiếu chúng, endpoint /api/graphql/ (dùng cho quét dữ liệu) có thể
 * từ chối session. Hàm này mở homepage một lần, gom cookie mới từ Set-Cookie và
 * gộp vào cookie gốc — KHÔNG ghi đè cookie đã có (giữ nguyên c_user/xs/datr/fr).
 * Lỗi không ném: trả về cookie gốc nếu không lấy thêm được.
 */
export async function augmentWebCookies(cookie: string, httpsAgent?: any): Promise<string> {
  const merged = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      if (key) merged.set(key, part.slice(eq + 1).trim());
    }
  }

  try {
    const response = await axios.get(FB_HOME_URL, {
      headers: fbHeaders(cookie),
      maxRedirects: 5,
      timeout: 60000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    const setCookies = response.headers?.['set-cookie'];
    if (Array.isArray(setCookies)) {
      // Chỉ bỏ qua attribute cookie (expires/domain/path/...) — không phải tên cookie.
      const attributeRe = /^(expires|domain|path|max-age|samesite|secure|httponly|priority|version|comment)$/i;
      for (const raw of setCookies) {
        const first = String(raw).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const key = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!key || !value || attributeRe.test(key)) continue;
        // Chỉ thêm cookie còn thiếu — không ghi đè cookie auth hiện có.
        if (!merged.has(key)) merged.set(key, value);
      }
    }
  } catch (err: any) {
    Logger.warn(`[FacebookSession] augmentWebCookies: ${err.message}`);
  }

  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Decode HTML entities và Unicode escapes
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Lấy tên và avatar từ Facebook homepage HTML
 * - Avatar: parse từ thẻ <image xlink:href="..."> trong homepage
 * - Tên: parse từ "NAME":"..." trong homepage HTML
 * @param html  HTML trả về từ facebook.com homepage (cần Accept header đúng)
 */
export async function fetchBasicProfileFromHome(html: string): Promise<{ name: string; avatarUrl: string }> {
  let name = '';
  let avatarUrl = '';

  // ── Avatar: parse từ thẻ <image xlink:href="..."> trong homepage ──────
  try {
    const imgMatch = html.match(/xlink:href="(https:\/\/scontent[^"]+)"/);
    if (imgMatch?.[1]) {
      avatarUrl = decodeHtmlEntities(imgMatch[1]);
    }
  } catch {}

  // Fallback: profile_pic_uri trong JSON
  if (!avatarUrl) {
    try {
      const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
      if (picMatch?.[1]) {
        avatarUrl = picMatch[1].replace(/\\\//g, '/');
      }
    } catch {}
  }

  // ── Tên: "NAME":"<display name>" từ homepage HTML ─────────────────────
  try {
    const nameMatch = html.match(/"NAME":"(.*?)"/);
    if (nameMatch?.[1] && !nameMatch[1].match(/^\d+$/) && nameMatch[1].length < 100) {
      name = decodeHtmlEntities(nameMatch[1]);
    }
  } catch {}

  // Fallback: "SHORT_NAME"
  if (!name) {
    try {
      const shortMatch = html.match(/"SHORT_NAME":"(.*?)"/);
      if (shortMatch?.[1] && !shortMatch[1].match(/^\d+$/) && shortMatch[1].length < 100) {
        name = decodeHtmlEntities(shortMatch[1]);
      }
    } catch {}
  }

  return { name, avatarUrl };
}

/**
 * Legacy HTML scraper. It is not identity-safe because Facebook profile pages
 * may redirect or hydrate a different person. Do not persist a contact name
 * from this function; use FacebookUserInfo.getFacebookUserInfo instead.
 *
 * Chiến lược:
 *   1. www.facebook.com/profile.php?id={userId} - parse xlink:href hoặc profile_pic_uri
 *   2. Fallback: mbasic.facebook.com/{userId} - HTML nhẹ, parse <img src>
 */
export async function fetchUserAvatarFromProfile(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  // The /picture route is bound to the requested numeric ID, unlike a
  // hydrated profile document which can describe the currently acting Page.
  return getFacebookAvatarById(cookie, userId, httpsAgent);
}

/**
 * Resolve an avatar through Facebook's ID-bound `/picture` route.
 *
 * This works for both people and Pages and only accepts a CDN redirect.  It is
 * deliberately separate from the legacy profile-HTML parser: an HTML page can
 * be hydrated for the logged-in/acting account, while this route is addressed
 * to the requested entity ID.
 */
export async function getFacebookAvatarById(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  if (!/^\d+$/.test(String(userId).trim())) return null;
  return tryFetchCdnRedirect(cookie, String(userId).trim(), httpsAgent);
}

/**
 * Legacy HTML profile fetch. Do not use for contact identity.
 * - Avatar: parse <image style="height:168px;width:168px"> xlink:href
 * - Tên: parse <h1> → <div role="button"> → text content
 */
export async function getUserInfoFacebookHtml(cookie: string, userId: string, httpsAgent?: any): Promise<{ name: string; avatarUrl: string } | null> {
  try {
    const response = await axios.get(`https://www.facebook.com/${userId}`, {
      headers: { ...fbHeaders(cookie), 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 30000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    let name = '';
    let avatarUrl = '';

    // ── Avatar: <image style="height:168px;width:168px"> xlink:href ────────
    const imgTagRe = /<image[^>]*style="[^"]*height:\s*168px[^"]*width:\s*168px[^"]*"[^>]*>/i;
    const imgTagMatch = html.match(imgTagRe);
    if (imgTagMatch) {
      const hrefMatch = imgTagMatch[0].match(/xlink:href="(https:\/\/[^"]+)"/);
      if (hrefMatch?.[1]) avatarUrl = decodeHtmlEntities(hrefMatch[1]);
    }

    // Fallback avatar: collect all xlink:href → last
    if (!avatarUrl) {
      const allXlink: string[] = [];
      const xlinkRe = /xlink:href="(https:\/\/[^"]*scontent[^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = xlinkRe.exec(html)) !== null) {
        allXlink.push(m[1]);
      }
      if (allXlink.length > 0) avatarUrl = decodeHtmlEntities(allXlink[allXlink.length - 1]);
    }

    // Fallback avatar: profile_pic_uri
    if (!avatarUrl) {
      const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
      if (picMatch?.[1]) avatarUrl = picMatch[1].replace(/\\\//g, '/');
    }

    // ── Tên: <h1> → <div role="button" tabindex="0"> text content ─────
    const h1Match = html.match(/<h1[^>]*>[\s\S]*?<div[^>]*role="button"[^>]*>([^<&]+)/);
    if (h1Match?.[1]) {
      name = h1Match[1].trim();
    }

    // Fallback tên: "NAME":"..." trong JSON
    if (!name) {
      const nameMatch = html.match(/"NAME":"(.*?)"/);
      if (nameMatch?.[1] && !nameMatch[1].match(/^\d+$/) && nameMatch[1].length < 100) {
        name = decodeHtmlEntities(nameMatch[1]);
      }
    }

    // ── Fallback CDN + mbasic cho avatar nếu www không có ────────
    if (!avatarUrl) {
      const cdnUrl = await tryFetchCdnRedirect(cookie, userId, httpsAgent);
      if (cdnUrl) avatarUrl = cdnUrl;
    }
    if (!avatarUrl) {
      const mbasicUrl = await tryFetchMbasic(cookie, userId, httpsAgent);
      if (mbasicUrl) avatarUrl = mbasicUrl;
    }

    if (!name && !avatarUrl) return null;
    return { name, avatarUrl: avatarUrl || '' };
  } catch (err: any) {
    Logger.debug(`[FacebookSession] getUserInfoFacebookHtml failed for ${userId}: ${err.message}`);
  }
  return null;
}

/**
 * Facebook /picture endpoint redirects directly to the CDN URL.
 * Dùng HEAD request để follow redirects mà không download image body.
 * KHÔNG BAO GIỜ nhầm avatar vì Facebook tự xác định ảnh đúng.
 */
async function tryFetchCdnRedirect(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  // Dùng maxRedirects:0 để bắt redirect, đọc Location header
  // HEAD request → không download image body
  try {
    const response = await axios.head(`https://www.facebook.com/${userId}/picture?type=large`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'cookie': cookie,
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    // Nếu không redirect (200 OK), thử request URL
    const reqUrl = response.request?.res?.responseUrl || (response.request as any)?.responseUrl || '';
    if (reqUrl.includes('fbcdn') || reqUrl.includes('scontent')) return reqUrl;
    // redirect URL trong Location header
    if (response.headers?.location) return response.headers.location;
  } catch (err: any) {
    // Khi maxRedirects=0, axios throw error với redirect info
    if (err.response?.headers?.location) {
      return err.response.headers.location;
    }
    // Một số tài khoản/đối tượng E2EE không công khai endpoint /picture.
    // 404 không phải lỗi phân giải UID; gọi lại cùng endpoint bằng HEAD sẽ chỉ
    // tạo thêm một request và log lỗi trùng lặp.
    if (err.response?.status === 404) {
      Logger.debug(`[FacebookSession] CDN avatar unavailable for ${userId} (404)`);
      return null;
    }
    Logger.debug(`[FacebookSession] tryFetchCdnRedirect failed for ${userId}: ${err.message}`);
  }

  // Fallback: HEAD request với maxRedirects=5 để axios tự follow
  try {
    const response = await axios.head(`https://www.facebook.com/${userId}/picture?type=large`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'cookie': cookie,
      },
      timeout: 15000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const finalUrl = response.request?.res?.responseUrl || (response.request as any)?.responseUrl || '';
    if (finalUrl.includes('fbcdn') || finalUrl.includes('scontent')) return finalUrl;
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchCdnRedirect fallback failed for ${userId}: ${err.message}`);
  }
  return null;
}

async function tryFetchWww(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  try {
    const response = await axios.get(`https://www.facebook.com/${userId}`, {
      headers: { ...fbHeaders(cookie), 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 30000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    // Priority 1: <image style="height:168px;width:168px"> - profile picture circle
    // Facebook dùng 168px là kích thước cố định cho profile picture thumbnail
    // Match cả thẻ <image> có style 168px, rồi extract xlink:href
    const imgTagRe = /<image[^>]*style="[^"]*height:\s*168px[^"]*width:\s*168px[^"]*"[^>]*>/i;
    const imgTagMatch = html.match(imgTagRe);
    if (imgTagMatch) {
      const hrefMatch = imgTagMatch[0].match(/xlink:href="(https:\/\/[^"]+)"/);
      if (hrefMatch?.[1]) return decodeHtmlEntities(hrefMatch[1]);
    }

    // Priority 2: Collect ALL xlink:href → return LAST one
    const allXlink: string[] = [];
    const xlinkRe = /xlink:href="(https:\/\/[^"]*scontent[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = xlinkRe.exec(html)) !== null) {
      allXlink.push(m[1]);
    }
    if (allXlink.length > 0) {
      return decodeHtmlEntities(allXlink[allXlink.length - 1]);
    }

    // Priority 3: profile_pic_uri trong JSON inline
    const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
    if (picMatch?.[1]) {
      return picMatch[1].replace(/\\\//g, '/');
    }
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchWww failed for ${userId}: ${err.message}`);
  }
  return null;
}

async function tryFetchMbasic(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  try {
    const response = await axios.get(`https://mbasic.facebook.com/${userId}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'cookie': cookie,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 30000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    const imgMatch = html.match(/<img[^>]*src="([^"]*scontent[^"]+)"[^>]*>/);
    if (imgMatch?.[1]) return decodeHtmlEntities(imgMatch[1]);

    const xlinkMatch = html.match(/xlink:href="(https:\/\/[^"]*scontent[^"]+)"/);
    if (xlinkMatch?.[1]) return decodeHtmlEntities(xlinkMatch[1]);
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchMbasic failed for ${userId}: ${err.message}`);
  }
  return null;
}
