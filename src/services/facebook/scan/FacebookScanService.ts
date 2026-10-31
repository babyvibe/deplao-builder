/**
 * FacebookScanService.ts
 * Core scan engine cho Facebook data scanning.
 * Dịch từ ChatCore Engine (background.ts) của babyvibe/facebook-scan-data-extension.
 *
 * Chức năng:
 * - Quản lý session + auth cho scan operations
 * - Xây dựng GraphQL params
 * - Tìm docId từ Facebook JS bundles
 * - Parse responses + cursor-based pagination
 * - 8 loại scan: group members, group keyword, fanpage followers/following/keyword,
 *   post comments, post reactions, post keyword
 */

import axios from 'axios';
import {
  FBSessionData,
} from '../FacebookTypes';
import {
  initSession,
  fetchFBHomepage,
} from '../FacebookSession';
import {
  buildHeaders,
  buildFormData,
  parseFBResponse,
  dataSplit,
  getNextReqId,
  strBase,
  getFacebookIDFromCookie,
} from '../FacebookUtils';
import { fbHeaders } from '../FacebookSession';
import DatabaseService from '../../database/DatabaseService';
import { secureGet } from '../../secure/SecureSettingsService';
import Logger from '../../../utils/Logger';

// ─── Constants ──────────────────────────────────────────────────────────

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const FB_HOME_URL = 'https://www.facebook.com/';

const DEBUG = false;

function log(...args: any[]) {
  if (DEBUG) {
    console.log('[FacebookScan]', ...args);
  }
}

function logError(...args: any[]) {
  console.error('[FacebookScan ERROR]', ...args);
}

// ─── Cookie key helper ─────────────────────────────────────────────────

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

// ─── Interfaces ────────────────────────────────────────────────────────

interface SiteData {
  be_one_ahead?: number;
  pkg_cohort?: string;
  pr?: number;
  client_revision?: string;
  [key: string]: any;
}

interface ServerNonce {
  ServerNonce?: string;
  [key: string]: any;
}

interface SprinkleConfig {
  version?: number;
  param_name?: string;
  should_randomize?: boolean;
  [key: string]: any;
}

interface WebConnectionClass {
  connectionClass?: string;
  [key: string]: any;
}

interface ScanContext {
  userId: string;
  fb_dtsg: string;
  lsd: string;
  siteData: SiteData;
  ServerNonce: ServerNonce;
  sprinkle_config: SprinkleConfig;
  WebConnectionClass: WebConnectionClass;
  clientRevision: string;
  // Extra fields từ original background.js
  serverRevision: string;
  sequenceId: string;
  messengerRegion: string;
  mercuryServerRequestsConfig: any;
  usidMetadata: any;
  env: {
    isCQuick: boolean;
    iframeKey?: string;
    iframeToken?: string;
    iframeTarget?: string;
  };
  // Spin fallback
  __spin_r?: string;
  __spin_b?: string;
  __spin_t?: string;
  // Extra fields từ extension mới
  __dyn: string;
  __hsdp: string;
  __hblp: string;
  __sjsp: string;
}

interface ScanParams {
  [key: string]: any;
}

// ─── handleWebSesion ───────────────────────────────────────────────────
// Port từ background.js - tạo compound __s param: "sessionId:tabId:pageId"

const WEB_SESSION_POOL = Math.pow(36, 6);

function webSessionRandom(): number {
  return Math.floor(Math.random() * WEB_SESSION_POOL);
}

function webSessionId(): string {
  const id = webSessionRandom();
  return id.toString(36).padStart(6, '0');
}

let _webSessionTabId: string | null = null;
let _webSessionId: string | null = null;
let _webSessionExpiry = 0;
let _webSessionPageId: string | null = null;

function webSessionGetId(serverNonce?: string): string {
  const now = Date.now();

  // Reset session nếu expired
  if (now >= _webSessionExpiry) {
    _webSessionId = null;
    _webSessionExpiry = now + 35000; // 35s
  }

  // Tạo session ID mới nếu chưa có
  if (!_webSessionId) {
    _webSessionId = webSessionId();
  }

  // Tab ID (tồn tại suốt phiên)
  if (!_webSessionTabId) {
    _webSessionTabId = webSessionId();
  }

  // Page ID (mới mỗi lần gọi)
  _webSessionPageId = webSessionId();

  const sid = _webSessionId || '';
  const tabId = _webSessionTabId || '';
  const pid = _webSessionPageId || '';
  return `${sid}:${tabId}:${pid}`;
}

// ─── Helper Functions ──────────────────────────────────────────────────

/**
 * Parse GraphQL response, xử lý for(;;); prefix.
 * Nhận cả string (axios trả về text) và object (axios tự parse JSON).
 */
function parseGraphQLResponse(response: any, functionName: string = ''): any {
  try {
    let data: any;

    // Nếu axios đã parse sẵn thành object → dùng trực tiếp
    if (typeof response === 'object' && response !== null) {
      data = response;
    } else if (typeof response === 'string') {
      const responseText = response;
      if (responseText.includes('for (;;);')) {
        data = JSON.parse(responseText.replace('for (;;);', ''));
      } else {
        // Có thể multiple JSON objects trên nhiều dòng
        const jsonObjects = responseText.trim().split('\n')
          .filter(Boolean)
          .map((str: string) => {
            try { return JSON.parse(str); } catch { return null; }
          })
          .filter(Boolean);
        data = jsonObjects.length > 0 ? jsonObjects[0] : null;
      }
    } else {
      return { data: null, error: 'Unexpected response type: ' + typeof response };
    }

    if (!data) {
      return { data: null, error: 'Empty response' };
    }

    // Kiểm tra lỗi từ Facebook - nhiều format khác nhau
    if (data?.error) {
      const err = data.error;
      const errorCode = err.code || err.error_code || err;
      const errorMsg = err.errorDescription || err.errorSummary || err.description || err.message || err.errorUserMsg || (typeof err === 'string' ? err : JSON.stringify(err));

      logError(`[${functionName}] Facebook API error: code=${errorCode} message="${errorMsg}"`);

      if (isSessionExpiredError(errorCode)) {
        log(`${functionName}: Session expired error detected:`, errorCode);
        return { replay: 1, error: errorMsg };
      }
      return { data: null, error: `Facebook lỗi (${errorCode}): ${errorMsg}` };
    }

    // Kiểm tra lỗi summary nếu có (một số response có errorSummary ở root)
    if (data?.errorSummary) {
      logError(`[${functionName}] Error summary: ${data.errorSummary}`);
      return { data: null, error: data.errorSummary };
    }

    return { data, error: null };
  } catch (err: any) {
    logError(`[${functionName}] Parse error: ${err.message}`);
    return { data: null, error: err.message };
  }
}

/**
 * Check if error is session expired
 */
function isSessionExpiredError(errorCode: any): boolean {
  return errorCode == 1357004 || errorCode == 1357001 || errorCode == 1357032 || errorCode == 1357054;
}

/**
 * Tính jazoest từ fb_dtsg
 */
function calcJazoest(data: string): string {
  // Extension thực tế dùng SUM (số ngắn: "25643"), không phải concatenation
  let t = 0;
  for (let r = 0; r < data.length; r++) {
    t += data.charCodeAt(r);
  }
  return '2' + t;
}

/**
 * Tính jazoest V2 (có sprinkle_config)
 */
function calcJazoestV2(data: string, sprinkleConfig: SprinkleConfig): string {
  // Extension thực tế dùng SUM
  let t = 0;
  for (let r = 0; r < data.length; r++) {
    t += data.charCodeAt(r);
  }
  t = parseInt(String(t));
  return sprinkleConfig.should_randomize ? String(t) : '2' + t;
}

/**
 * Decode HTML entities
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Normalize URL
 */
function normalizeUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('//')) {
    return 'https:' + url;
  }
  return 'https://' + url;
}

// ─── Core Engine ───────────────────────────────────────────────────────

export class FacebookScanService {
  private static instance: FacebookScanService;
  private contextCache = new Map<string, ScanContext>();
  private docIdCache = new Map<string, string>();
  private requestCount = 0;

  private constructor() {}

  public static getInstance(): FacebookScanService {
    if (!FacebookScanService.instance) {
      FacebookScanService.instance = new FacebookScanService();
    }
    return FacebookScanService.instance;
  }

  // ─── Session Management ────────────────────────────────────────────

  /**
   * Lấy cookie từ secure storage
   */
  private getCookie(accountId: string): string | null {
    return secureGet(fbCookieKey(accountId));
  }

  /**
   * Khởi tạo context cho account: fetch HTML, parse fb_dtsg, userID, LSD, SiteData...
   */
  async initContext(accountId: string, cookie?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const ck = cookie || this.getCookie(accountId);
      if (!ck) return { success: false, error: 'Cookie not found' };

      const ctx = this.createEmptyContext();

      // Fetch homepage HTML + dual-fetch fallback (giống original ChatCore.init)
      const html = await fetchFBHomepage(ck);
      this.parseHtmlContext(html, ctx);

      // Dual-fetch: nếu không isCQuick, fetch lại với URL khác (giống original)
      if (!ctx.env.isCQuick && ctx.userId) {
        await this.delay(1000);
        const altUrl = this.makeBusinessUrl(ctx.userId);
        try {
          const res = await axios.get(altUrl, {
            headers: {
              ...fbHeaders(ck),
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 30000,
            maxRedirects: 5,
          });
          const altHtml = res.data as string;
          // Merge thêm fields từ HTML mới (không ghi đè)
          this.parseHtmlContext(altHtml, ctx, true);
        } catch {}
      }

      // Fallback: lấy userId từ cookie nếu HTML không parse được
      if (!ctx.userId) {
        const fbIdFromCookie = getFacebookIDFromCookie(ck);
        if (fbIdFromCookie) {
          ctx.userId = fbIdFromCookie;
          log('initContext: Got userId from cookie:', fbIdFromCookie);
        }
      }

      this.contextCache.set(accountId, ctx);
      return { success: true };
    } catch (err: any) {
      logError('initContext error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Tạo empty context
   */
  private createEmptyContext(): ScanContext {
    return {
      userId: '',
      fb_dtsg: '',
      lsd: '',
      siteData: {},
      ServerNonce: {},
      sprinkle_config: {},
      WebConnectionClass: {},
      clientRevision: '',
      serverRevision: '',
      sequenceId: '',
      messengerRegion: '',
      mercuryServerRequestsConfig: null,
      usidMetadata: null,
      env: { isCQuick: false },
      __spin_r: '',
      __spin_b: '',
      __spin_t: '',
      __dyn: '',
      __hsdp: '',
      __hblp: '',
      __sjsp: '',
    };
  }

  /**
   * Parse HTML vào context - giống original background.js loadHtml()
   */
  private parseHtmlContext(html: string, ctx: ScanContext, mergeOnly: boolean = false): void {
    let data: RegExpMatchArray | null;

    // Parse userID - thử nhiều pattern (FB thay đổi thường xuyên)
    if (!ctx.userId) {
      const userIdMatch = html.match(/"userID":"(\d+)"/);
      if (userIdMatch) {
        ctx.userId = userIdMatch[1];
      } else {
        // Fallback: "accountId":"<id>"
        const accountIdMatch = html.match(/"accountId":"(\d+)"/);
        if (accountIdMatch) ctx.userId = accountIdMatch[1];
      }
    }

    // Parse fb_dtsg (chỉ ghi nếu chưa có)
    if (!ctx.fb_dtsg) {
      const dtsgMatch = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
      if (dtsgMatch) {
        ctx.fb_dtsg = dtsgMatch[1];
      } else {
        const dtsgMatch2 = html.match(/"token":"([\w:]+)","ttl":\d+}/);
        if (dtsgMatch2) ctx.fb_dtsg = dtsgMatch2[1];
      }
    }

    // Parse USIDMetadata - PHẢI parse TRƯỚC LSD (extension gốc parse USIDMetadata rồi mới LSD)
    if (!ctx.usidMetadata) {
      data = html.match(/\["USIDMetadata",\[\],([^\]]+),\d+\]/);
      if (data) {
        try { ctx.usidMetadata = JSON.parse(data[1]); } catch {}
      }
    }

    // Parse LSD - ORIGINAL EXTENSION: chỉ parse khi usid_metadata ĐÃ TỒN TẠI
    // Nếu parse LSD không có usid_metadata → LSD sai session → Facebook lỗi 1357054
    if (!ctx.lsd && ctx.usidMetadata) {
      const lsdMatch = html.match(/\["LSD",\[\],([^\]]+),\d+\]/);
      if (lsdMatch) {
        try { ctx.lsd = JSON.parse(lsdMatch[1]).token; } catch {}
      }
    }

    // Parse SiteData
    if (!ctx.siteData || Object.keys(ctx.siteData).length === 0) {
      data = html.match(/\["SiteData",\[\],([^\]]+),\d+\]/);
      if (data) {
        try { ctx.siteData = JSON.parse(data[1]); } catch {}
      }
    }

    // Parse ServerNonce
    if (!ctx.ServerNonce?.ServerNonce) {
      data = html.match(/\["ServerNonce",\[\],([^\]]+),\d+\]/);
      if (data) {
        try { ctx.ServerNonce = JSON.parse(data[1]); } catch {}
      }
    }

    // Parse SprinkleConfig
    if (!ctx.sprinkle_config?.version) {
      data = html.match(/\["SprinkleConfig",\[\],([^\]]+),\d+\]/);
      if (data) {
        try { ctx.sprinkle_config = JSON.parse(data[1]); } catch {}
      }
    }

    // Parse WebConnectionClassServerGuess
    if (!ctx.WebConnectionClass?.connectionClass) {
      data = html.match(/\["WebConnectionClassServerGuess",\[\],([^\]]+),\d+\]/);
      if (data) {
        try { ctx.WebConnectionClass = JSON.parse(data[1]); } catch {}
      }
    }

    // Parse MercuryServerRequestsConfig
    data = html.match(/\["MercuryServerRequestsConfig",\[\],([^\]]+),\d+\]/);
    if (data) {
      try { ctx.mercuryServerRequestsConfig = JSON.parse(data[1]); } catch {}
    }

    // Parse revisions
    if (!ctx.serverRevision) {
      data = html.match(/server_revision":(\d+)/);
      if (data) ctx.serverRevision = data[1];
    }
    if (!ctx.clientRevision) {
      data = html.match(/client_revision":(\d+)/);
      if (data) ctx.clientRevision = data[1];
    }
    if (!ctx.sequenceId) {
      data = html.match(/sequenceId":(\d+)/);
      if (data) ctx.sequenceId = data[1];
    }

    // Parse messenger region
    if (!ctx.messengerRegion) {
      data = html.match(/"(?:regionNullable|msgrRegion)":"(\w+)"/);
      if (data) {
        ctx.messengerRegion = data[1];
      } else {
        ctx.messengerRegion = 'PRN';
      }
    }

    // Parse env (cquick detection từ business URL)
    if (!mergeOnly) {
      const envMatch = html.match(/cquick=([^&"]+)/);
      if (envMatch) {
        ctx.env.isCQuick = true;
        ctx.env.iframeKey = envMatch[1];
        const tokenMatch = html.match(/cquick_token=([^&"]+)/);
        if (tokenMatch) ctx.env.iframeToken = tokenMatch[1];
        const targetMatch = html.match(/ctarget=([^&"]+)/);
        if (targetMatch) ctx.env.iframeTarget = targetMatch[1];
      }
    }

    // Parse __dyn
    if (!ctx.__dyn) {
      data = html.match(/\["DynLocConfig",\[\],([^\]]+),\d+\]/);
      if (data) {
        try {
          const dynConfig = JSON.parse(data[1]);
          ctx.__dyn = dynConfig?.dyn || '';
        } catch { ctx.__dyn = ''; }
      }
      // Fallback: __dyn từ pattern khác
      if (!ctx.__dyn) {
        data = html.match(/"__dyn":"([^"]+)"/);
        if (data) ctx.__dyn = data[1];
      }
      // Fallback: __dyn từ siteData (dyn field)
      if (!ctx.__dyn && ctx.siteData) {
        ctx.__dyn = (ctx.siteData as any).dyn || (ctx.siteData as any).__dyn || '';
      }
    }

    // ⚠️ __hsdp/__hblp/__sjsp - KHÔNG parse từ HTML nữa
    // Working extension luôn gửi empty string cho các params này
    // Parse giá trị thật từ HTML gây sai lệch → Facebook reject request

    // Lưu spin params từ ctx để fallback trong buildParams
    if ((ctx as any).__spin_r === '') {
      const sr = (html.match(/__spin_r":(\d+)/) || [])[1];
      const sb = (html.match(/__spin_b":(\d+)/) || [])[1];
      const st = (html.match(/__spin_t":(\d+)/) || [])[1];
      if (sr) ctx.__spin_r = sr;
      if (sb) ctx.__spin_b = sb;
      if (st) ctx.__spin_t = st;
    }
  }

  /**
   * Tạo business URL giống original markeUrl
   */
  private makeBusinessUrl(userId: string): string {
    return `https://business.facebook.com/latest/inbox/all?asset_id=${userId}&nav_ref=diode_page_inbox&mailbox_id=${userId}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Lấy context từ cache, nếu không có thì khởi tạo
   */
  async ensureContext(accountId: string): Promise<{ ctx?: ScanContext; error?: string }> {
    let ctx = this.contextCache.get(accountId);
    if (!ctx || !ctx.userId) {
      const result = await this.initContext(accountId);
      if (!result.success) {
        return { error: result.error || 'Cannot init session' };
      }
      ctx = this.contextCache.get(accountId);
    }
    return { ctx };
  }

  // ─── DocId Management ──────────────────────────────────────────────

  /**
   * Tìm docId từ Facebook JS bundles
   * Mỗi GraphQL query cần một docId (số) xác định query
   */
  async loadDocId(
    url: string,
    options: {
      type: 'group' | 'search' | 'postGroup' | 'postProfile' | 'postComment' | 'postReact' | 'pagesList';
      moduleName?: string;
    },
    cookie?: string
  ): Promise<string | null> {
    const cacheKey = `${options.type}`;
    if (!cookie) {
      logError('loadDocId: cookie is required');
      return null;
    }
    if (this.docIdCache.has(cacheKey)) {
      return this.docIdCache.get(cacheKey)!;
    }

    // URL ưu tiên theo type
    const primaryUrl = (() => {
      switch (options.type) {
        case 'postProfile': return url;
        case 'group': return url;
        case 'postGroup': return url;
        case 'search': return 'https://www.facebook.com/search/groups?q=test';
        case 'pagesList': return 'https://www.facebook.com/pages/';
        case 'postComment': return 'https://www.facebook.com/';
        case 'postReact': return 'https://www.facebook.com/';
        default: return url;
      }
    })();

    const FALLBACK_URLS: Record<string, string[]> = {
      postComment: ['https://www.facebook.com/'],
      postReact: ['https://www.facebook.com/'],
    };

    try {
      // Dùng fbHeaders() giống FacebookSession - đã được kiểm chứng hoạt động
      const fetchHtml = async (fetchUrl: string): Promise<string> => {
        const res = await axios.get(fetchUrl, {
          headers: {
            ...fbHeaders(cookie),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          },
          timeout: 30000,
          maxRedirects: 5,
        });
        return res.data as string;
      };

      // Thử primary URL, nếu fail thì thử fallback URLs
      let html: string | null = null;
      try {
        html = await fetchHtml(primaryUrl);
      } catch (err: any) {
        logError(`loadDocId: fetchHtml failed for ${primaryUrl}: ${err.message}`);
        const fallbacks = FALLBACK_URLS[options.type] || [];
        for (const fbUrl of fallbacks) {
          if (fbUrl === primaryUrl) continue;
          try {
            html = await fetchHtml(fbUrl);
            if (html) break;
          } catch {}
        }
      }
      if (!html) throw new Error('fetchHtml failed');

      if (!html) return null;

      // Helper: extract docId từ JS text bằng module name
      const extractDocIdFromJS = (jsText: string, moduleName: string): string | null => {
        const escapedName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Pattern: "ModuleName"[...]exports = "123456" (có thể có/và không space quanh =)
        const r = new RegExp('"' + escapedName + '"[\\s\\S]{0,400}?\\.exports\\s*=\\s*"(\\d+)"');
        const m = r.exec(jsText);
        return m ? m[1] : null;
      };

      // ── Module names mapping ── (thêm cả bare name không suffix để fallback)
      const MODULE_NAMES: Record<string, string[]> = {
        group: ['GroupsCometMembersPageNewMembersSectionRefetchQuery_facebookRelayOperation'],
        search: ['SearchCometResultsPaginatedResultsQuery_facebookRelayOperation'],
        postProfile: ['ProfileCometTimelineFeedRefetchQuery_facebookRelayOperation'],
        postGroup: ['GroupsCometFeedRegularStoriesPaginationQuery_facebookRelayOperation'],
        postComment: [
          'CommentsListComponentsPaginationQuery_facebookRelayOperation',
          'CommentsListComponentsPaginationQuery',
          'Depth1CommentsListPaginationQuery_facebookRelayOperation',
          'Depth1CommentsListPaginationQuery',
          'Depth2CommentsListPaginationQuery_facebookRelayOperation',
          'Depth2CommentsListPaginationQuery',
        ],
        postReact: ['CometUFIReactionsDialogTabContentRefetchQuery_facebookRelayOperation'],
        pagesList: ['PagesCometLaunchPointUnifiedQueryPagesListRedesignedUpdatedPagesSectionQuery_facebookRelayOperation'],
      };

      // Helper: extract docId bằng friendly name (fallback khi module name không match)
      const extractDocIdByQueryName = (jsText: string, queryName: string): string | null => {
        const escaped = queryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Pattern chính: "QueryName"[...]exports = "docId" (có thể space quanh =)
        const r1 = new RegExp('"' + escaped + '"[\\s\\S]{0,400}?\\.exports\\s*=\\s*"(\\d+)"');
        const m1 = r1.exec(jsText);
        if (m1) return m1[1];
        // Pattern fallback: QueryName gần số dài (docId) trong vòng 300 ký tự
        const r2 = new RegExp('"' + escaped + '"[\\s\\S]{0,300}?(\\d{10,})');
        const m2 = r2.exec(jsText);
        return m2 ? m2[1] : null;
      };

      // Helper: try extract từ 1 URL JS
      const tryExtractFromUrl = async (scriptUrl: string): Promise<string | null> => {
        try {
          const res = await axios.get(scriptUrl, {
            headers: {
              'Accept': '*/*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
              'Cookie': cookie,
              'Referer': 'https://www.facebook.com/',
            },
            timeout: 15000,
          });
          if (res.status === 200 && typeof res.data === 'string') {
            const jsText = res.data as string;
            // Try options.moduleName first
            if (options.moduleName) {
              const found = extractDocIdFromJS(jsText, options.moduleName);
              if (found) return found;
            }
            // Try all module names for this type
            const names = MODULE_NAMES[options.type] || [];
            for (const name of names) {
              const found = extractDocIdFromJS(jsText, name);
              if (found) return found;
            }
            // Fallback: search by friendly name directly (bỏ suffix _facebookRelayOperation)
            if (names.length > 0) {
              const baseName = names[0].replace(/_facebookRelayOperation$/, '');
              const found = extractDocIdByQueryName(jsText, baseName);
              if (found) return found;
            }
          }
        } catch {}
        return null;
      };

      let docId: string | null = null;

      // ── Bước 1: Collect inline <script> content ──
      const inlineParts: string[] = [];
      for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (m[1] && m[1].length > 10) inlineParts.push(m[1]);
      }
      const combinedInline = inlineParts.join('\n');

      if (combinedInline.length > 0) {
        log(`loadDocId: Scanning ${combinedInline.length} chars of inline scripts for type: ${options.type}`);
        const names = MODULE_NAMES[options.type] || [];
        for (const name of names) {
          const found = extractDocIdFromJS(combinedInline, name);
          if (found) {
            docId = found;
            log(`loadDocId: ✅ Found docId in inline scripts: ${docId}`);
            break;
          }
        }
        if (docId) { this.docIdCache.set(cacheKey, docId); return docId; }
      }

      // ── Bước 2 (đặc biệt): postReact - tìm qua CometUFIReactionsDialog.react ──
      if (!docId && options.type === 'postReact') {
        log('loadDocId: postReact - searching via CometUFIReactionsDialog.react');
        const regexRArray = /"CometUFIReactionsDialog\.react"\s*:\s*\{[^]*?"r"\s*:\s*\[([^]*?)\]/g;
        const matchRArray = regexRArray.exec(html);
        if (matchRArray && matchRArray[1]) {
          let rArray: string[] = [];
          try { rArray = JSON.parse(`[${matchRArray[1]}]`.replace(/\\\\/g, '\\\\')); }
          catch { rArray = matchRArray[1].split(',').map(s => s.trim().replace(/"/g, '')); }
          for (let i = 0; i < rArray.length; i++) {
            const keyword = rArray[i];
            const regexElement = new RegExp(`"${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\{[^]*?"src":\\s*"([^"]+)"`, 'g');
            const matchElement = regexElement.exec(html);
            if (matchElement) {
              const srcValue = matchElement[1].replace(/\\+/g, '');
              log(`loadDocId: postReact → fetching ${srcValue}`);
              const found = await tryExtractFromUrl(srcValue);
              if (found) { docId = found; break; }
            }
          }
        }
      }

      // ── Bước 2: Tìm lazy bundle qua BootloaderMap trong HTML ──
      if (!docId) {
        const getModuleNameForType = (): string | null => {
          const names = MODULE_NAMES[options.type] || [];
          return names[0] || null;
        };
        const targetModule = getModuleNameForType();
        if (targetModule) {
          const escapedMod = targetModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const rxR = new RegExp('"' + escapedMod + '"\\s*:\\s*\\{[^{}]*?"r"\\s*:\\s*\\[([^\\]]*?)\\]');
          const mR = rxR.exec(html);
          if (mR && mR[1]) {
            let hashes: string[] = [];
            try { hashes = JSON.parse(`[${mR[1]}]`.replace(/\\(?!")/g, '\\\\')); }
            catch { hashes = [...mR[1].matchAll(/"([^"]+)"/g)].map(x => x[1]); }
            log(`loadDocId: BootloaderMap found ${hashes.length} hashes for ${targetModule}`);
            for (const hash of hashes) {
              const hashEsc = hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const rxSrc = new RegExp('"' + hashEsc + '"\\s*:\\s*\\{[^{}]*?"src"\\s*:\\s*"([^"]+)"');
              const mSrc = rxSrc.exec(html);
              if (mSrc) {
                const srcUrl = mSrc[1].replace(/\\+/g, '');
                log(`loadDocId: BootloaderMap → fetching ${srcUrl}`);
                const bFound = await tryExtractFromUrl(srcUrl);
                if (bFound) { docId = bFound; break; }
              }
            }
          }
        }
      }

      // ── Bước 3: Thu thập TẤT CẢ JS URLs từ HTML ──
      if (!docId) {
        const allUrls: string[] = [];
        // link tags with as="script"
        for (const m of html.matchAll(/<link\b([^>]*)\bas="script"\b([^>]*)>/g)) {
          const attrs = (m[1] || '') + (m[2] || '');
          const hm = /\bhref="([^"]+)"/.exec(attrs);
          if (hm) allUrls.push(hm[1]);
        }
        // script src - tất cả các dạng
        for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
          allUrls.push(m[1]);
        }
        // rsrc.php URLs trong text
        for (const m of html.matchAll(/["'](https?:\/\/[^"']*rsrc\.php\/[^"']*)['"]/g)) {
          allUrls.push(m[1]);
        }
        for (const m of html.matchAll(/"(\/rsrc\.php\/[^"]*)"/g)) {
          allUrls.push('https://static.xx.fbcdn.net' + m[1]);
        }
        // Haste JS bundles
        for (const m of html.matchAll(/["'](https?:\/\/[^"']*\/haste[^"']*)["']/g)) {
          allUrls.push(m[1]);
        }
        // Tất cả URL chứa .js
        for (const m of html.matchAll(/["'](https?:\/\/[^"']*\.js(?:[?#][^"']*)?)["']/g)) {
          if (!allUrls.includes(m[1])) allUrls.push(m[1]);
        }

        const uniqueUrls = [...new Set(allUrls)].filter(u => u.includes('.js'));
        log(`loadDocId: Checking ${uniqueUrls.length} JS files for type: ${options.type}`);

        for (const scriptUrl of uniqueUrls) {
          const found = await tryExtractFromUrl(scriptUrl);
          if (found) { docId = found; break; }
        }
      }

      // ── Bước 4: Fallback cuối - search docId trực tiếp trong HTML bằng friendly name ──
      if (!docId) {
        log(`loadDocId: Step 4 - searching inline scripts by friendly name for type: ${options.type}`);
        const names = MODULE_NAMES[options.type] || [];
        for (const name of names) {
          const baseName = name.replace(/_facebookRelayOperation$/, '');
          const found = extractDocIdByQueryName(combinedInline, baseName);
          if (found) {
            docId = found;
            log(`loadDocId: ✅ Found docId by friendly name: ${docId}`);
            break;
          }
        }
      }

      if (docId) {
        this.docIdCache.set(cacheKey, docId);
        return docId;
      }
      logError(`loadDocId: No docId found for type: ${options.type}`);
      return null;
    } catch (err: any) {
      logError('loadDocId error:', err.message);
      return null;
    }
  }

  // ─── Params Builder ────────────────────────────────────────────────

  /**
   * Xây dựng params cơ bản cho GraphQL request (dùng cho non-profile queries)
   */
  buildParams(ctx: ScanContext): ScanParams {
    const params: ScanParams = {
      av: ctx.userId,
      __user: ctx.userId,
      __aaid: 0,
      __a: 1,
      __req: getNextReqId(),
      __ccg: 'EXCELLENT',
      dpr: 1,
    };

    // SiteData params
    if (ctx.siteData) {
      params.__csr = '';
      params.__beoa = ctx.siteData.be_one_ahead ? 1 : 0;
      params.__pc = ctx.siteData.pkg_cohort;
      params.dpr = ctx.siteData.pr;
      if (ctx.WebConnectionClass?.connectionClass) {
        params.__ccg = ctx.WebConnectionClass.connectionClass;
      }
      params.__rev = ctx.siteData.client_revision;
      params.__hsi = ctx.siteData.hsi;
      params.__hs = ctx.siteData.haste_session;
      // __comet_req: siteData có comet_env (field thật từ FB HTML)
      params.__comet_req = (ctx.siteData as any).comet_env ?? 15;
      // Spin params
      if (ctx.siteData.spin) {
        params.__spin_r = ctx.siteData.__spin_r;
        params.__spin_b = ctx.siteData.__spin_b;
        params.__spin_t = ctx.siteData.__spin_t;
        if (ctx.siteData.__spin_dev_mhenv) {
          params.__spin_dev_mhenv = ctx.siteData.__spin_dev_mhenv;
        }
      }
    }

    // Extra params - luôn gửi dạng rỗng (giống working extension)
    // ⚠️ KHÔNG dùng giá trị parse từ HTML vì working extension gửi empty string
    params.__dyn = ctx.__dyn || '';
    params.__hsdp = '';
    params.__hblp = '';
    params.__sjsp = '';

    // ServerNonce - extension dùng __sudn (không phải __s)
    if (ctx.ServerNonce?.ServerNonce) {
      params.__sudn = webSessionGetId(ctx.ServerNonce.ServerNonce);
    }

    // Sprinkle
    if (ctx.sprinkle_config) {
      if (ctx.sprinkle_config.version == 2) {
        params[ctx.sprinkle_config.param_name] = calcJazoestV2(ctx.fb_dtsg, ctx.sprinkle_config);
      } else if (ctx.sprinkle_config.param_name) {
        params[ctx.sprinkle_config.param_name] = calcJazoest(ctx.fb_dtsg);
      }
    }

    // fb_dtsg - original extension ALWAYS sets this
    if (ctx.fb_dtsg) params.fb_dtsg = ctx.fb_dtsg;

    // jazoest standalone param (extension có gửi)
    if (ctx.fb_dtsg) {
      params.jazoest = calcJazoest(ctx.fb_dtsg);
    }

    // force_blue (nếu siteData yêu cầu)
    if (ctx.siteData?.force_blue) {
      params.force_blue = 1;
    }

    // Fallback spin params từ ctx nếu chưa có từ siteData
    if (!params.__spin_r && (ctx as any).__spin_r) {
      params.__spin_r = (ctx as any).__spin_r;
      params.__spin_b = (ctx as any).__spin_b;
      params.__spin_t = (ctx as any).__spin_t;
    }

    return params;
  }

  /**
   * Xây dựng params cho profile-scoped queries
   */
  buildParamsProfile(ctx: ScanContext): ScanParams {
    // Khớp với original background.js buildParamsProfile + extension mới
    const params: ScanParams = {
      av: ctx.userId,
      __user: ctx.userId,
      __aaid: 0,
      __a: 1,
      __req: getNextReqId(),
    };

    // Extra params - luôn gửi dạng rỗng (giống working extension)
    // ⚠️ KHÔNG dùng giá trị parse từ HTML vì working extension gửi empty string
    params.__dyn = ctx.__dyn || '';
    params.__hsdp = '';
    params.__hblp = '';
    params.__sjsp = '';

    // ServerNonce - dùng handleWebSesion.getId() - extension dùng __sudn
    if (ctx.ServerNonce?.ServerNonce) {
      params.__sudn = webSessionGetId(ctx.ServerNonce.ServerNonce);
    }

    // WebConnectionClass
    if (ctx.WebConnectionClass?.connectionClass) {
      params.__ccg = ctx.WebConnectionClass.connectionClass;
    }

    // fb_dtsg + jazoest
    if (ctx.fb_dtsg) {
      params.fb_dtsg = ctx.fb_dtsg;
      if (ctx.sprinkle_config?.version == 2) {
        params[ctx.sprinkle_config.param_name] = calcJazoestV2(ctx.fb_dtsg, ctx.sprinkle_config);
      } else if (ctx.sprinkle_config?.param_name) {
        params[ctx.sprinkle_config.param_name] = calcJazoest(ctx.fb_dtsg);
      }
      // jazoest standalone param (extension có gửi)
      params.jazoest = calcJazoest(ctx.fb_dtsg);
    }

    // Fallback spin params từ ctx
    if (!params.__spin_r && (ctx as any).__spin_r) {
      params.__spin_r = (ctx as any).__spin_r;
      params.__spin_b = (ctx as any).__spin_b;
      params.__spin_t = (ctx as any).__spin_t;
    }

    return params;
  }

  // ─── GraphQL Request ──────────────────────────────────────────────

  /**
   * Delay ngẫu nhiên 300-800ms giữa các request để tránh rate limit
   */
  private async rateLimitDelay(): Promise<void> {
    const ms = 300 + Math.floor(Math.random() * 500);
    await this.delay(ms);
  }

  /**
   * Gửi GraphQL request đến Facebook
   */
  async graphQLRequest(
    cookie: string,
    params: ScanParams,
    friendlyName: string,
    docId: string,
    variables: any,
    lsdForHeader?: string
  ): Promise<{ data?: any; error?: string; replay?: number; _requestPayload?: string; _responsePreview?: string; _requestHeaders?: string; _responseHeaders?: string }> {
    // Rate limit delay - giống original có delay 500ms giữa requests
    await this.rateLimitDelay();

    const allParams: ScanParams = {
      ...params,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: friendlyName,
      variables: JSON.stringify(variables),
      server_timestamps: true,
      doc_id: docId,
    };

    // Build form data - KHÔNG include lsd (working extension không gửi lsd trong form body)
    const formData = Object.entries(allParams)
      .map(([key, val]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(val)))
      .join('&');

    // Debug: log request params (che dấu cookie)
    log(`[GraphQL] → ${friendlyName} docId=${docId} av=${params.av} __user=${params.__user} lsd=${lsdForHeader?.slice(0,8) || '(none)'}... fb_dtsg=${params.fb_dtsg?.slice(0,8)}...`);

    // Capture request headers (che dấu cookie)
    const lsd = lsdForHeader || params.lsd || '';
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': friendlyName,
      'x-fb-lsd': lsd,                              // ⚠️ LUÔN gửi header (working extension luôn gửi, kể cả "undefined")
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'Origin': 'https://www.facebook.com',
      'Referer': 'https://www.facebook.com/',
      // ⚠️ Browser headers - Chrome tự động thêm, axios/Node không có
      // Facebook kiểm tra sec-fetch-site để chống CSRF → thiếu → lỗi 1357054
      'Accept': '*/*',
      'Accept-Language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    try {
      const response = await axios.post(GRAPHQL_URL, formData, {
        headers: {
          ...reqHeaders,
          'Cookie': cookie,
        },
        timeout: 60000,
      });

      // Capture request payload (che dấu cookie & fb_dtsg)
      const sanitizedParams = { ...allParams };
      if (sanitizedParams.fb_dtsg) sanitizedParams.fb_dtsg = sanitizedParams.fb_dtsg.slice(0, 8) + '...';
      const requestPayload = JSON.stringify({ docId, friendlyName, variables, params: sanitizedParams });

      // Capture request headers as JSON (safe, no cookie)
      const requestHeadersStr = JSON.stringify(reqHeaders, null, 2);

      // Capture response headers
      const respHeaders = response.headers as Record<string, any>;
      const respHeadersSafe: Record<string, string> = {};
      const importantHeaders = [
        'x-fb-friendly-name', 'x-fb-lsd', 'content-type', 'content-encoding',
        'vary', 'x-fb-debug', 'x-fb-connection-quality', 'x-fb-trace-id',
        'date', 'pragma', 'cache-control', 'x-fb-dbg', 'www-authenticate',
      ];
      for (const h of importantHeaders) {
        const val = respHeaders[h] || respHeaders[h.toLowerCase()] || respHeaders[h.replace(/-/g, '').toLowerCase()];
        if (val) respHeadersSafe[h] = String(val);
      }
      const responseHeadersStr = JSON.stringify(respHeadersSafe, null, 2);

      // Capture response preview (2000 ký tự đầu để debug)
      // axios có thể tự parse JSON → response.data là object, cần normalize về string
      const rawResponse: any = response.data;
      const responseText: string = typeof rawResponse === 'string'
        ? rawResponse
        : JSON.stringify(rawResponse);
      const responsePreview = responseText.slice(0, 2000);

      if (response.status !== 200) {
        logError(`[GraphQL] ${friendlyName} → HTTP ${response.status}`);
        return { error: 'Request failed with status: ' + response.status, _requestPayload: requestPayload, _responsePreview: responsePreview, _requestHeaders: requestHeadersStr, _responseHeaders: responseHeadersStr };
      }

      const parsed = parseGraphQLResponse(responseText, friendlyName);

      if (parsed.replay) return { replay: 1, error: parsed.error, _requestPayload: requestPayload, _responsePreview: responsePreview, _requestHeaders: requestHeadersStr, _responseHeaders: responseHeadersStr };
      if (parsed.error) {
        logError(`[GraphQL] ${friendlyName} → error: ${parsed.error}`);
        return { error: parsed.error, _requestPayload: requestPayload, _responsePreview: responsePreview, _requestHeaders: requestHeadersStr, _responseHeaders: responseHeadersStr };
      }

      log(`[GraphQL] ${friendlyName} → OK`);
      return { data: parsed.data, _requestPayload: requestPayload, _responsePreview: responsePreview, _requestHeaders: requestHeadersStr, _responseHeaders: responseHeadersStr };
    } catch (err: any) {
      logError(`[GraphQL] ${friendlyName} → exception: ${err.message}`);
      return { error: err.message, _requestPayload: '', _responsePreview: '', _requestHeaders: '', _responseHeaders: '' };
    }
  }

  // ─── Retry Helper ─────────────────────────────────────────────────

  /**
   * Xử lý replay khi session expired: re-init context + retry (tối đa 1 lần)
   * Giống original background.js: chỉ replay 1 lần, nếu vẫn lỗi thì báo luôn
   */
  async handleReplay(
    accountId: string,
    fn: (retryCount?: number) => Promise<any>,
    retryCount: number = 0,
    /** Dữ liệu gốc từ request bị lỗi, được merge vào error response khi retry thất bại */
    fallbackData?: Record<string, any>
  ): Promise<any> {
    if (retryCount >= 1) {
      return {
        error: 'Phiên Facebook đã hết hạn hoặc có lỗi kết nối. Vui lòng cập nhật cookie Facebook và thử lại.',
        ...(fallbackData || {}),
      };
    }
    // Re-init context
    const initResult = await this.initContext(accountId);
    if (!initResult.success) {
      return {
        error: 'Không thể refresh phiên Facebook. Vui lòng cập nhật cookie.',
        ...(fallbackData || {}),
      };
    }
    // Retry với retryCount + 1
    return await fn(retryCount + 1);
  }

  // ─── Scan: Group Members ──────────────────────────────────────────

  async scanGroupMembers(
    accountId: string,
    groupId: string,
    cursor?: string | null,
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string }> {
    const { ctx, error: ctxError } = await this.ensureContext(accountId);
    if (ctxError || !ctx) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: ctxError };

    const cookie = this.getCookie(accountId);
    if (!cookie) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cookie not found' };

    let docId = this.docIdCache.get('group');
    if (!docId) {
      docId = await this.loadDocId(`https://www.facebook.com/groups/${groupId}`, { type: 'group' }, cookie) || '';
    }
    if (!docId) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Không thể tìm docId. Vui lòng thử lại hoặc kiểm tra kết nối.' };
    }

    const params = this.buildParamsProfile(ctx);
    const variables: any = {
      count: 10,
      cursor: cursor || '',
      groupID: groupId,
      recruitingGroupFilterNonCompliant: false,
      scale: 1.5,
      id: groupId,
      // KHÔNG thêm __relay_internal__pv__ - giống original background.js
    };

    const result = await this.graphQLRequest(
      cookie, params,
      'GroupsCometMembersPageNewMembersSectionRefetchQuery',
      docId, variables,
      ctx.lsd
    );

    if (result.replay) {
      return await this.handleReplay(accountId, (retry) => this.scanGroupMembers(accountId, groupId, cursor, retry), retryCount, {
        _lastPayload: result._requestPayload || '',
        _lastResponse: result._responsePreview || '',
        _lastDocId: docId,
        _lastRequestHeaders: result._requestHeaders || '',
        _lastResponseHeaders: result._responseHeaders || '',
      });
    }
    if (result.error) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: result.error, _lastPayload: result._requestPayload || '', _lastResponse: result._responsePreview || '', _lastDocId: docId, _lastRequestHeaders: result._requestHeaders || '', _lastResponseHeaders: result._responseHeaders || '' };
    }

    // Parse items từ response (khớp với original background.js)
    const items: any[] = [];
    let endCursor: string | null = null;
    let hasNextPage = false;

    try {
      const data = result.data;
      // Original dùng: data?.data?.node?.new_members?.edges
      const edges = data?.data?.node?.new_members?.edges
        || data?.data?.node?.members?.edges
        || [];

      for (const edge of edges) {
        const node = edge.node;
        if (node?.id && node?.name) {
          items.push({
            uid: node.id,
            name: node.name,
            picture: node?.profile_picture?.uri || node?.profilePicture?.uri || '',
            role: node?.administrator ? 'admin' : (node?.moderator ? 'mod' : 'member'),
          });
        }
      }

      // Original dùng: data?.data?.node?.new_members?.page_info?.end_cursor
      endCursor = data?.data?.node?.new_members?.page_info?.end_cursor
        || data?.data?.node?.members?.page_info?.end_cursor
        || null;
      hasNextPage = data?.data?.node?.new_members?.page_info?.has_next_page
        || data?.data?.node?.members?.page_info?.has_next_page
        || false;
    } catch (e: any) {
      logError('scanGroupMembers parse error:', e.message);
    }

    return {
      success: true,
      items,
      pageInfo: { endCursor, hasNextPage },
      _lastPayload: result._requestPayload || '',
      _lastResponse: result._responsePreview || '',
      _lastDocId: docId,
      _lastRequestHeaders: result._requestHeaders || '',
      _lastResponseHeaders: result._responseHeaders || '',
    };
  }

  // ─── Scan: Search Comet (groups, pages, posts) ────────────────────

  /**
   * Search comet - dùng chung cho search groups, pages, posts
   */
  async scanSearchComet(
    accountId: string,
    options: {
      keyword: string;
      type: 'group' | 'page' | 'post';
      cursor?: string | null;
      filters?: string[];
      bsid?: string;
      tsid?: string;
    },
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string; _nextBsid?: string; _nextTsid?: string }> {
    const { ctx, error: ctxError } = await this.ensureContext(accountId);
    if (ctxError || !ctx) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: ctxError };

    const cookie = this.getCookie(accountId);
    if (!cookie) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cookie not found' };

    let docId = this.docIdCache.get('search');
    if (!docId) {
      docId = await this.loadDocId('https://www.facebook.com/search/groups?q=test', { type: 'search' }, cookie) || '';
    }
    if (!docId) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Không thể tìm docId cho search.' };
    }

    // ⚠️ Dùng buildParams (full params) thay vì buildParamsProfile - khớp với extension thực tế
    const params = this.buildParams(ctx);

    // Build filters - map từ options.filters (giống original)
    const filters = options.filters || [];

    // Xác định typeSearch và URL giống original
    let typeSearch = 'GROUPS_TAB';
    let searchUrl = `https://www.facebook.com/search/groups?q=${encodeURIComponent(options.keyword)}`;
    if (options.type === 'post') {
      searchUrl = `https://www.facebook.com/search/posts?q=${encodeURIComponent(options.keyword)}`;
      typeSearch = 'POSTS_TAB';
    } else if (options.type === 'page') {
      searchUrl = `https://www.facebook.com/search/pages?q=${encodeURIComponent(options.keyword)}`;
      typeSearch = 'PAGES_TAB';
    }

    // Build search variables - khớp hoàn toàn với original background.js scanSearchComet
    const searchVariables: any = {
      // Group variables
      ...(options.type === 'group' ? {} : {
        'UFI2CommentsProvider_commentsKey': 'SearchCometResultsInitialResultsQuery',
      }),
      'allow_streaming': false,
      'args': {
        'callsite': 'COMET_GLOBAL_SEARCH',
        'config': {
          'exact_match': false,
          'high_confidence_config': null,
          'intercept_config': null,
          'sts_disambiguation': null,
          'watch_config': null,
        },
        'context': {
          'bsid': options.bsid || null,
          'tsid': options.tsid || null,
        },
        'experience': {
          'client_defined_experiences': ['ADS_PARALLEL_FETCH'],
          'encoded_server_defined_params': null,
          'fbid': null,
          'type': typeSearch,
        },
        'filters': filters,
        'text': options.keyword,
      },
      'count': 5,
      'cursor': options.cursor || null,
      'feedLocation': 'SEARCH',
      'feedbackSource': 23,
      'fetch_filters': true,
      'focusCommentID': null,
      'locale': null,
      'privacySelectorRenderLocation': 'COMET_STREAM',
      'referringStoryRenderLocation': null,
      'renderLocation': 'search_results_page',
      'scale': 2,
      'stream_initial_count': 0,
      'useDefaultActor': false,
    };

    // ── Relay providers: KHÁC NHAU cho group vs post/page (giống original background.js) ──
    if (options.type === 'group') {
      Object.assign(searchVariables, {
        '__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider': true,
        '__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider': true,
        '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': true,
        '__relay_internal__pv__IsWorkUserrelayprovider': false,
        '__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider': false,
        '__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider': true,
        '__relay_internal__pv__FeedDeepDiveTopicPillThreadViewEnabledrelayprovider': false,
        '__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider': true,
        '__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider': false,
        '__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider': false,
        '__relay_internal__pv__IsMergQAPollsrelayprovider': false,
        '__relay_internal__pv__FBReels_enable_meta_ai_label_gkrelayprovider': true,
        '__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider': true,
        '__relay_internal__pv__FBUnifiedLightweightVideoAttachmentWrapper_wearable_attribution_on_comet_reels_qerelayprovider': false,
        '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
        '__relay_internal__pv__CometUFIShareActionMigrationrelayprovider': true,
        '__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider': false,
        '__relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider': true,
        '__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider': true,
        '__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider': 150,
        '__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider': true,
        '__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider': false,
      });
    } else {
      Object.assign(searchVariables, {
        '__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider': true,
        '__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider': true,
        '__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider': false,
        '__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider': false,
        '__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider': false,
        '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': true,
        '__relay_internal__pv__IsWorkUserrelayprovider': false,
        '__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider': false,
        '__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider': true,
        '__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider': true,
        '__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider': false,
        '__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider': false,
        '__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider': false,
        '__relay_internal__pv__IsMergQAPollsrelayprovider': false,
        '__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider': true,
        '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
        '__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider': 'ORIGINAL',
        '__relay_internal__pv__CometUFIShareActionMigrationrelayprovider': true,
        '__relay_internal__pv__CometUFISingleLineUFIrelayprovider': true,
        '__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider': true,
        '__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider': true,
        '__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider': false,
        '__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider': true,
        '__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider': 206,
        '__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider': true,
        '__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider': false,
      });
    }

    const result = await this.graphQLRequest(
      cookie, params,
      'SearchCometResultsPaginatedResultsQuery',
      docId, searchVariables,
      ctx.lsd
    );

    if (result.replay) {
      return await this.handleReplay(accountId, (retry) => this.scanSearchComet(accountId, options, retry), retryCount, {
        _lastPayload: result._requestPayload || '',
        _lastResponse: result._responsePreview || '',
        _lastDocId: docId,
      });
    }
    if (result.error) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: result.error, _lastPayload: result._requestPayload || '', _lastResponse: result._responsePreview || '', _lastDocId: docId };
    }

    // ─── Parse items ─────────────────────────────────────────────
    const items: any[] = [];
    let endCursor: string | null = null;
    let hasNextPage = false;
    let extractedBsid = '';
    let extractedTsid = '';

    try {
      const data = result.data;
      const edges = data?.data?.serpResponse?.results?.edges || [];

      for (const edge of edges) {
        // ⚠️ Extension gốc parse ở EDGE LEVEL (edge.rendering_strategy), KHÔNG phải edge.node!
        // Facebook API mới trả rendering_strategy trực tiếp trên edge object
        const item = edge?.node || edge; // fallback: edge.node nếu có, không thì dùng edge
        const renderStrategy = edge?.rendering_strategy || edge?.relay_rendering_strategy
                            || item?.rendering_strategy || item?.relay_rendering_strategy;
        const viewModel = renderStrategy?.view_model || renderStrategy;
        const profile = viewModel?.profile;

        if (options.type === 'group') {
          const textEntities = viewModel?.primary_snippet_text_with_entities?.text || '';
          const separatedText = textEntities.split(' · ');
          items.push({
            uid: profile?.id || edge?.id || item?.id || '',
            name: profile?.name || '',
            picture: profile?.profile_picture?.uri || '',
            type: separatedText[0] || '',
            members: separatedText[1] || '',
          });
        } else if (options.type === 'page') {
          const textEntities = viewModel?.primary_snippet_text_with_entities?.text || '';
          const followersMatch = textEntities.match(/\b\d+(?:\.\d+)?\s?(triệu\s+)?K?\s?M?\s?(người theo dõi|lượt thích|followers)\b/i);
          items.push({
            uid: profile?.id || edge?.id || item?.id || '',
            name: profile?.name || '',
            picture: profile?.profile_picture?.uri || '',
            followers: followersMatch ? followersMatch[0] : 0,
          });
        } else if (options.type === 'post') {
          // Original handleScanPostKeyword: extract từ story structure (edge level)
          const story = viewModel?.click_model?.story;
          const postId = story?.post_id || edge?.id || item?.id || '';
          // Lấy reaction/comment count từ FEEDBACK
          const fbContainer = story?.comet_sections?.feedback?.story;
          // Tìm feedback bằng recursive search nếu path cố định không ra
          function deepFindFeedback(obj: any, depth: number = 0): any {
            if (!obj || depth > 8) return null;
            if (obj?.comet_ufi_summary_and_actions_renderer?.feedback?.reaction_count) {
              return obj.comet_ufi_summary_and_actions_renderer.feedback;
            }
            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === 'object' && obj[key] !== null) {
                const found = deepFindFeedback(obj[key], depth + 1);
                if (found) return found;
              }
            }
            return null;
          }
          const fbFeedback =
            // Path 1: qua story_ufi_container (từ JSON thật)
            fbContainer?.story_ufi_container?.story?.feedback_context?.feedback_target_with_context?.comet_ufi_summary_and_actions_renderer?.feedback
            // Path 2: feedback_context trực tiếp dưới feedback.story
            || fbContainer?.feedback_context?.feedback_target_with_context?.comet_ufi_summary_and_actions_renderer?.feedback
            // Path 3: search toàn bộ edge data
            || deepFindFeedback(edge)
            || null;
          // Reactions: sum top_reactions.edges, fallback reaction_count.count
          const topReactions = fbFeedback?.top_reactions?.edges;
          const reactionCount = topReactions && topReactions.length > 0
            ? topReactions.reduce((sum: number, e: any) => sum + (e.reaction_count || 0), 0)
            : fbFeedback?.reaction_count?.count
              || edge?.reaction_count?.count
              || item?.reaction_count?.count
              || story?.reaction_count?.count
              || 0;
          const commentCount = fbFeedback?.comment_rendering_instance?.comments?.total_count
            || fbFeedback?.adaptive_ufi_action_renderers?.find((a: any) => a.__typename === 'UFICommentActionRenderer')?.feedback?.comment_rendering_instance?.comments?.total_count
            || edge?.comment_count?.count
            || item?.comment_count?.count
            || 0;
          items.push({
            postId,
            authorId: profile?.id || '',
            content: story?.comet_sections?.content?.story?.message?.text || viewModel?.primary_snippet?.text || edge?.message?.text || item?.message?.text || '',
            timestamp: story?.comet_sections?.timestamp?.story?.creation_time || edge?.creation_time || item?.creation_time || edge?.timestamp || 0,
            url: postId ? `https://www.facebook.com/${postId}` : (story?.url || edge?.url || item?.url || ''),
            reactions: reactionCount,
            comments: commentCount,
            photoImage: story?.attachments?.[0]?.styles?.attachment?.media?.photo_image?.uri || '',
          });
        }
      }

      // Extract bsid/tsid từ item đầu tiên - EDGE LEVEL (giống original extension)
      if (edges.length > 0) {
        const firstEdge = edges[0];
        const firstRender = firstEdge?.relay_rendering_strategy || firstEdge?.rendering_strategy
                         || firstEdge?.node?.relay_rendering_strategy || firstEdge?.node?.rendering_strategy;
        const chainingParams = firstRender?.view_model?.chaining_action_view_model?.chaining_params;
        if (chainingParams) {
          extractedBsid = chainingParams.bsid || '';
          extractedTsid = chainingParams.tsid || '';
        }
      }

      // Tìm endCursor từ response - giống original extension: parse 4 path + multi-object fallback
      const serpResponse = data?.data?.serpResponse;
      endCursor = data?.data?.serpResponse?.results?.page_info?.end_cursor
        || data?.data?.serpResponse?.page_info?.end_cursor
        || data?.serpResponse?.results?.page_info?.end_cursor
        || data?.serpResponse?.page_info?.end_cursor
        || null;
      hasNextPage = data?.data?.serpResponse?.results?.page_info?.has_next_page
        || data?.data?.serpResponse?.page_info?.has_next_page
        || data?.serpResponse?.results?.page_info?.has_next_page
        || data?.serpResponse?.page_info?.has_next_page
        || false;

      // Nếu có items nhưng không tìm thấy endCursor → thử parse từ responsePreview (multi-line JSON)
      if (items.length > 0 && !endCursor && result._responsePreview) {
        try {
          const preview = result._responsePreview;
          const allObjects = preview.replace('for (;;);', '').trim().split('\n')
            .filter(Boolean).map((s: string) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
          for (const obj of allObjects) {
            const cursor = obj?.data?.serpResponse?.results?.page_info?.end_cursor
              || obj?.data?.serpResponse?.page_info?.end_cursor;
            if (cursor) { endCursor = cursor; break; }
          }
        } catch {}
      }

      // ⚠️ Nếu không có items → chắc chắn không còn trang tiếp theo
      if (items.length === 0) {
        endCursor = null;
        hasNextPage = false;
      }
    } catch (e: any) {
      logError('scanSearchComet parse error:', e.message);
    }

    // Return pagination params bao gồm bsid/tsid cho lần tiếp theo
    return {
      success: true,
      items,
      pageInfo: { endCursor, hasNextPage },
      _lastPayload: result._requestPayload || '',
      _lastResponse: result._responsePreview || '',
      _lastDocId: docId,
      _lastRequestHeaders: result._requestHeaders || '',
      _lastResponseHeaders: result._responseHeaders || '',
      _nextBsid: extractedBsid,
      _nextTsid: extractedTsid,
    };
  }

  // ─── Scan: Group by Keyword ───────────────────────────────────────

  async scanGroupKeyword(
    accountId: string,
    keyword: string,
    cursor?: string | null,
    filters?: string[],
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string; _nextBsid?: string; _nextTsid?: string }> {
    return this.scanSearchComet(accountId, {
      keyword,
      type: 'group',
      cursor,
      filters,
    }, retryCount);
  }

  // ─── Scan: Fanpage by Keyword ─────────────────────────────────────

  async scanFanpageKeyword(
    accountId: string,
    keyword: string,
    cursor?: string | null,
    filters?: string[],
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string; _nextBsid?: string; _nextTsid?: string }> {
    return this.scanSearchComet(accountId, {
      keyword,
      type: 'page',
      cursor,
      filters,
    }, retryCount);
  }

  // ─── Scan: Post by Keyword ────────────────────────────────────────

  async scanPostKeyword(
    accountId: string,
    keyword: string,
    cursor?: string | null,
    filters?: string[],
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string; _nextBsid?: string; _nextTsid?: string }> {
    return this.scanSearchComet(accountId, {
      keyword,
      type: 'post',
      cursor,
      filters,
    }, retryCount);
  }

  // ─── Scan: Post Comments ─────────────────────────────────────────

  async scanPostComments(
    accountId: string,
    feedbackTargetID: string,
    cursor?: string | null,
    retryCount: number = 0,
    level?: string, // '' | '1' | '2' - hỗ trợ nested comments (giống original)
    expansionToken?: string
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string; _feedbackIds?: any[]; _level?: string }> {
    const { ctx, error: ctxError } = await this.ensureContext(accountId);
    if (ctxError || !ctx) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: ctxError };

    const cookie = this.getCookie(accountId);
    if (!cookie) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cookie not found' };

    let docId = this.docIdCache.get('postComment');
    if (!docId) {
      docId = await this.loadDocId('https://www.facebook.com/', { type: 'postComment' }, cookie) || '';
    }
    if (!docId) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cannot load docId for post comments.' };
    }

    const params = this.buildParamsProfile(ctx);

    // Xác định friendly_name và variables dựa trên level (giống original)
    let friendlyName = 'CommentsListComponentsPaginationQuery';
    let beforeParams: any = {};

    if (level) {
      // Nested comments (Depth1CommentsListPaginationQuery / Depth2CommentsListPaginationQuery)
      if (!expansionToken) {
        return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Missing expansionToken for nested comments.' };
      }
      beforeParams = {
        'clientKey': null,
        'expansionToken': expansionToken,
        'repliesAfterCount': null,
        'repliesAfterCursor': cursor || null,
        'repliesBeforeCount': null,
        'repliesBeforeCursor': null,
      };
      if (level === '1') {
        friendlyName = 'Depth1CommentsListPaginationQuery';
      } else if (level === '2') {
        friendlyName = 'Depth2CommentsListPaginationQuery';
      }
    } else {
      // Top-level comments
      beforeParams = {
        'commentsAfterCount': -1,
        'commentsAfterCursor': cursor || null,
        'commentsBeforeCount': null,
        'commentsBeforeCursor': null,
        'commentsIntentToken': 'RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1',
      };
    }

    const variables: any = {
      ...beforeParams,
      'feedLocation': 'POST_PERMALINK_DIALOG',
      'focusCommentID': null,
      'scale': 2,
      'useDefaultActor': false,
      'id': feedbackTargetID,
      '__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider': 'ORIGINAL',
      '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': false,
      '__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider': false,
      '__relay_internal__pv__IsWorkUserrelayprovider': false,
    };

    // Thêm __crn cho post comment (giống Facebook thực tế)
    const commentParams = {
      ...params,
      __crn: 'comet.fbweb.CometSinglePostDialogRoute',
    };

    const result = await this.graphQLRequest(
      cookie, commentParams,
      friendlyName,
      docId, variables,
      ctx.lsd
    );

    if (result.replay) {
      return await this.handleReplay(accountId, (retry) => this.scanPostComments(accountId, feedbackTargetID, cursor, retry, level, expansionToken), retryCount, {
        _lastPayload: result._requestPayload || '',
        _lastResponse: result._responsePreview || '',
        _lastDocId: docId,
        _lastRequestHeaders: result._requestHeaders || '',
        _lastResponseHeaders: result._responseHeaders || '',
      });
    }
    if (result.error) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: result.error, _lastPayload: result._requestPayload || '', _lastResponse: result._responsePreview || '', _lastDocId: docId, _lastRequestHeaders: result._requestHeaders || '', _lastResponseHeaders: result._responseHeaders || '' };
    }

    // Parse comments
    const items: any[] = [];
    let endCursor: string | null = null;
    let hasNextPage = false;
    const feedbackIds: any[] = [];

    try {
      const data = result.data;
      // Nếu level (nested) - different path
      let edges: any[] = [];
      if (level) {
        edges = data?.data?.node?.replies_connection?.edges || [];
        const pageInfo = data?.data?.node?.replies_connection?.page_info;
        endCursor = pageInfo?.end_cursor || null;
        hasNextPage = pageInfo?.has_next_page || false;
      } else {
        const parenItem = data?.data?.node?.comment_rendering_instance_for_feed_location?.comments
          || data?.data?.node?.display_comments
          || data?.data?.feedback?.display_comments;
        edges = parenItem?.edges || [];
        const pageInfo = parenItem?.page_info;
        endCursor = pageInfo?.end_cursor || null;
        hasNextPage = pageInfo?.has_next_page || false;
      }

      for (const edge of edges) {
        const node = edge.node;
        if (node?.id) {
          // Kiểm tra feedback để hỗ trợ nested comments (giống original)
          const feedback = node?.feedback;
          const hasSubComments = feedback?.total_comment_count > 0;
          items.push({
            commentId: node.id,
            authorId: node?.author?.id || '',
            authorName: node?.author?.name || '',
            authorAvatar: node?.author?.profile_picture?.uri || '',
            body: node?.body?.text || '',
            timestamp: node?.created_time || node?.timestamp || 0,
            reactions: node?.comment_reactions?.count || 0,
            // Hỗ trợ nested comments
            _hasSubComments: hasSubComments,
            _feedbackId: hasSubComments ? feedback?.id : null,
            _expansionToken: hasSubComments ? feedback?.expansion_info?.expansion_token : null,
          });
        }
      }
    } catch (e: any) {
      logError('scanPostComments parse error:', e.message);
    }

    return {
      success: true,
      items,
      pageInfo: { endCursor, hasNextPage },
      _lastPayload: result._requestPayload || '',
      _lastResponse: result._responsePreview || '',
      _lastDocId: docId,
      _lastRequestHeaders: result._requestHeaders || '',
      _lastResponseHeaders: result._responseHeaders || '',
      _feedbackIds: feedbackIds,
      _level: level || '',
    };
  }

  // ─── Scan: Post Timeline (bài đăng từ profile/fanpage/group) ─────

  async scanPostTimeline(
    accountId: string,
    sourceId: string,
    sourceType: 'profile' | 'fanpage' | 'group',
    cursor?: string | null,
    retryCount: number = 0
  ): Promise<{ success: boolean; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean }; error?: string; _lastPayload?: string; _lastResponse?: string; _lastDocId?: string; _lastRequestHeaders?: string; _lastResponseHeaders?: string }> {
    const { ctx, error: ctxError } = await this.ensureContext(accountId);
    if (ctxError || !ctx) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: ctxError };

    const cookie = this.getCookie(accountId);
    if (!cookie) return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cookie not found' };

    // Xác định docId và friendly_name theo loại nguồn
    let docType: 'postProfile' | 'postGroup';
    let friendlyName: string;
    let docCacheKey: string;

    if (sourceType === 'group') {
      docType = 'postGroup';
      friendlyName = 'GroupsCometFeedRegularStoriesPaginationQuery';
      docCacheKey = 'postGroup';
    } else {
      docType = 'postProfile';
      friendlyName = 'ProfileCometTimelineFeedRefetchQuery';
      docCacheKey = 'postProfile';
    }

    const profileUrl = sourceType === 'profile'
      ? `https://www.facebook.com/${sourceId}`
      : sourceType === 'group'
        ? `https://www.facebook.com/groups/${sourceId}`
        : `https://www.facebook.com/${sourceId}`;

    let docId = this.docIdCache.get(docCacheKey);
    if (!docId) {
      docId = await this.loadDocId(profileUrl, { type: docType }, cookie) || '';
    }
    if (!docId) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: 'Cannot load docId for ' + sourceType + ' timeline.' };
    }

    const params = this.buildParamsProfile(ctx);

    // Build variables - giống original background.js scanPost
    let variables: any;
    if (sourceType === 'group') {
      variables = {
        'UFI2CommentsProvider_commentsKey': 'CometGroupDiscussionRootSuccessQuery',
        'count': 3,
        'cursor': cursor || null,
        'feedLocation': 'GROUP',
        'feedType': 'DISCUSSION',
        'feedbackSource': 0,
        'focusCommentID': null,
        'privacySelectorRenderLocation': 'COMET_STREAM',
        'renderLocation': 'group',
        'scale': 1.5,
        'sortingSetting': null,
        'stream_initial_count': 1,
        'useDefaultActor': false,
        'id': sourceId,
        '__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider': true,
        '__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider': true,
        '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': true,
        '__relay_internal__pv__IsWorkUserrelayprovider': false,
        '__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider': false,
        '__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider': true,
        '__relay_internal__pv__FeedDeepDiveTopicPillThreadViewEnabledrelayprovider': false,
        '__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider': true,
        '__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider': false,
        '__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider': false,
        '__relay_internal__pv__IsMergQAPollsrelayprovider': false,
        '__relay_internal__pv__FBReels_enable_meta_ai_label_gkrelayprovider': true,
        '__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider': true,
        '__relay_internal__pv__FBUnifiedLightweightVideoAttachmentWrapper_wearable_attribution_on_comet_reels_qerelayprovider': false,
        '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
        '__relay_internal__pv__CometUFIShareActionMigrationrelayprovider': true,
        '__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider': false,
        '__relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider': true,
        '__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider': true,
        '__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider': 150,
        '__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider': true,
        '__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider': false,
      };
    } else {
      // Profile / Fanpage
      variables = {
        'UFI2CommentsProvider_commentsKey': 'ProfileCometTimelineRoute',
        'count': 3,
        'cursor': cursor || null,
        'afterTime': null,
        'beforeTime': null,
        'feedLocation': 'TIMELINE',
        'feedbackSource': 0,
        'focusCommentID': null,
        'memorializedSplitTimeFilter': null,
        'omitPinnedPost': true,
        'postedBy': { 'group': 'OWNER' },
        'privacy': null,
        'privacySelectorRenderLocation': 'COMET_STREAM',
        'renderLocation': 'timeline',
        'scale': 1.5,
        'stream_count': 1,
        'taggedInOnly': null,
        'useDefaultActor': false,
        'id': sourceId,
        'displayCommentsContextEnableComment': null,
        'displayCommentsContextIsAdPreview': null,
        'displayCommentsContextIsAggregatedShare': null,
        'displayCommentsContextIsStorySet': null,
        'displayCommentsFeedbackContext': null,
        '__relay_internal__pv__IsWorkUserrelayprovider': false,
        '__relay_internal__pv__IsMergQAPollsrelayprovider': false,
        '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
        '__relay_internal__pv__CometUFIIsRTAEnabledrelayprovider': false,
        '__relay_internal__pv__StoriesArmadilloReplyEnabledrelayprovider': false,
        '__relay_internal__pv__StoriesRingrelayprovider': false,
      };
    }

    const result = await this.graphQLRequest(
      cookie, params,
      friendlyName,
      docId, variables,
      ctx.lsd
    );

    if (result.replay) {
      return await this.handleReplay(accountId, (retry) => this.scanPostTimeline(accountId, sourceId, sourceType, cursor, retry), retryCount, {
        _lastPayload: result._requestPayload || '',
        _lastResponse: result._responsePreview || '',
        _lastDocId: docId,
        _lastRequestHeaders: result._requestHeaders || '',
        _lastResponseHeaders: result._responseHeaders || '',
      });
    }
    if (result.error) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: result.error, _lastPayload: result._requestPayload || '', _lastResponse: result._responsePreview || '', _lastDocId: docId, _lastRequestHeaders: result._requestHeaders || '', _lastResponseHeaders: result._responseHeaders || '' };
    }

    // Parse posts - khớp original background.js scanPost + parseScanPostResponse
    const items: any[] = [];
    let endCursor: string | null = null;
    let hasNextPage = false;

    try {
      const data = result.data;

      // Original dùng parseScanPostResponse - xử lý multiple JSON objects
      // Path khác nhau cho group vs profile/fanpage
      let edges: any[] = [];
      if (sourceType === 'group') {
        edges = data?.data?.node?.group_feed?.edges || [];
        const pi = data?.data?.node?.group_feed?.page_info;
        endCursor = pi?.end_cursor || null;
        hasNextPage = pi?.has_next_page || false;
      } else {
        edges = data?.data?.node?.timeline_list_feed_units?.edges || [];
        const pi = data?.data?.node?.timeline_list_feed_units?.page_info;
        endCursor = pi?.end_cursor || null;
        hasNextPage = pi?.has_next_page || false;
      }

      for (const edge of edges) {
        const node = edge.node || edge;
        if (!node?.post_id) continue;

        items.push({
          postId: node.post_id,
          authorId: node?.author?.id || '',
          authorName: node?.author?.name || '',
          content: node?.message?.text || '',
          timestamp: node?.creation_time || node?.timestamp || 0,
          url: node?.url || '',
          reactions: node?.reaction_count?.count || 0,
          comments: node?.comment_count?.count || 0,
        });
      }
    } catch (e: any) {
      logError('scanPostTimeline parse error:', e.message);
    }

    return {
      success: true,
      items,
      pageInfo: { endCursor, hasNextPage },
      _lastPayload: result._requestPayload || '',
      _lastResponse: result._responsePreview || '',
      _lastDocId: docId,
      _lastRequestHeaders: result._requestHeaders || '',
      _lastResponseHeaders: result._responseHeaders || '',
    };
  }

  // ─── Batch Scans ─────────────────────────────────────────────────

  /**
   * Quét thành viên nhiều nhóm cùng lúc (batch)
   * @param accountId FB account ID
   * @param groupIds Danh sách group IDs
   * @param threadCount Số luồng đồng thời (1-20)
   * @param onProgress Callback báo tiến độ (done, total, currentId)
   */
  async scanGroupMembersBatch(
    accountId: string,
    groupIds: string[],
    threadCount: number = 5,
    onProgress?: (done: number, total: number, currentId: string) => void
  ): Promise<{ success: boolean; items: any[]; errors: string[]; error?: string }> {
    const allItems: any[] = [];
    const errors: string[] = [];
    let done = 0;

    const worker = async (id: string) => {
      onProgress?.(done, groupIds.length, id);
      const res = await this.scanGroupMembers(accountId, id);
      if (res.success && res.items) {
        allItems.push(...res.items.map((item: any) => ({ ...item, _batchSource: id })));
      } else {
        errors.push(`${id}: ${res.error || 'Không có dữ liệu'}`);
      }
      done++;
      onProgress?.(done, groupIds.length, '');
    };

    await this.runBatch(groupIds, threadCount, worker);

    return { success: errors.length < groupIds.length, items: allItems, errors };
  }

  /**
   * Quét bình luận nhiều bài viết cùng lúc (batch)
   */
  async scanPostCommentsBatch(
    accountId: string,
    postIds: string[],
    threadCount: number = 5,
    onProgress?: (done: number, total: number, currentId: string) => void
  ): Promise<{ success: boolean; items: any[]; errors: string[]; error?: string }> {
    const allItems: any[] = [];
    const errors: string[] = [];
    let done = 0;

    const worker = async (id: string) => {
      onProgress?.(done, postIds.length, id);
      const res = await this.scanPostComments(accountId, id);
      if (res.success && res.items) {
        allItems.push(...res.items.map((item: any) => ({ ...item, _batchSource: id })));
      } else {
        errors.push(`${id}: ${res.error || 'Không có dữ liệu'}`);
      }
      done++;
      onProgress?.(done, postIds.length, '');
    };

    await this.runBatch(postIds, threadCount, worker);

    return { success: errors.length < postIds.length, items: allItems, errors };
  }

  /**
   * Thread pool chung cho batch operations
   */
  private async runBatch(
    items: string[],
    threadCount: number,
    worker: (item: string) => Promise<void>
  ): Promise<void> {
    const queue = [...items];
    let index = 0;

    const runWorker = async () => {
      while (index < queue.length) {
        const item = queue[index++];
        await worker(item);
      }
    };

    const threads = Math.min(threadCount, items.length);
    const workers = Array.from({ length: threads }, () => runWorker());
    await Promise.all(workers);
  }

  // ─── Status ───────────────────────────────────────────────────────

  getCacheStatus(): { contexts: number; docIds: number } {
    return {
      contexts: this.contextCache.size,
      docIds: this.docIdCache.size,
    };
  }

  clearCache(): void {
    this.contextCache.clear();
    this.docIdCache.clear();
    this.requestCount = 0;
  }
}
