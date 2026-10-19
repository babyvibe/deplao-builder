/**
 * facebookNativeLoginWebStep.ts
 * Runs a Messenger Lite login `cookies` step (Google reCAPTCHA) in a throwaway
 * browser window: load the step URL, run its `extract_js` and return the
 * values it resolves to, which are then submitted to fbchat-login-bridge.
 *
 * The window has no Node access, an in-memory session of its own (cleared
 * afterwards) and uses the login proxy, so Facebook sees the same network as
 * the rest of the login.
 */

import { BrowserWindow, session as electronSession, type Session } from 'electron';
import { v4 as uuid } from 'uuid';
import type { NativeLoginCookieField, NativeLoginStep } from '../../src/services/facebook/FacebookE2EEBridge';
import Logger from '../../src/utils/Logger';

const WEB_STEP_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VALUE_LENGTH = 16 * 1024;
/** Chromium's code for a navigation replaced by another one (redirects). */
const ERR_ABORTED = -3;

export class NativeLoginWebStepClosedError extends Error {
  constructor() {
    super('Cửa sổ xác minh đã đóng trước khi hoàn tất.');
    this.name = 'NativeLoginWebStepClosedError';
  }
}

type WebStepProxy = { rules: string; username?: string; password?: string };

function parseProxy(proxyUrl?: string): WebStepProxy | null {
  if (!proxyUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('Proxy của phiên đăng nhập không hợp lệ.');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(scheme)) {
    throw new Error(`Cửa sổ xác minh không hỗ trợ proxy ${scheme}.`);
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  if (username && scheme.startsWith('socks')) {
    // Chromium cannot authenticate to SOCKS proxies.
    throw new Error('Cửa sổ xác minh không hỗ trợ proxy SOCKS có mật khẩu. Hãy dùng proxy HTTP hoặc đăng nhập bằng Cookie.');
  }
  return {
    rules: `${scheme === 'socks5h' ? 'socks5' : scheme}://${parsed.host}`,
    username,
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
  };
}

function compilePattern(pattern?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** Keep only string values of requested fields from what extract_js resolved to. */
function pickValues(value: unknown, fieldIds: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (fieldIds.has(key) && typeof item === 'string' && item.length > 0 && item.length <= MAX_VALUE_LENGTH) {
      result[key] = item;
    }
  }
  return result;
}

/** Fill fields that name a cookie source and are still missing. */
async function fillFromCookies(ses: Session, fields: NativeLoginCookieField[], values: Record<string, string>): Promise<void> {
  for (const field of fields) {
    if (values[field.id]) continue;
    for (const source of field.sources || []) {
      if (source.type !== 'cookie' || !source.name) continue;
      const cookies = await ses.cookies.get({ name: source.name, ...(source.cookie_domain ? { domain: source.cookie_domain } : {}) });
      const value = cookies.find((cookie) => cookie.value)?.value;
      if (value && value.length <= MAX_VALUE_LENGTH) {
        values[field.id] = value;
        break;
      }
    }
  }
}

export async function runNativeLoginWebStep(
  step: NativeLoginStep,
  opts: { proxyUrl?: string; parent?: BrowserWindow | null },
): Promise<Record<string, string>> {
  const params = step.cookies;
  if (!params?.url) throw new Error('Bước xác minh không có địa chỉ trang.');
  let target: URL;
  try {
    target = new URL(params.url);
  } catch {
    throw new Error('Địa chỉ trang xác minh không hợp lệ.');
  }
  if (target.protocol !== 'https:') throw new Error('Trang xác minh phải dùng HTTPS.');

  const fields = params.fields || [];
  const fieldIds = new Set(fields.map((field) => field.id).filter(Boolean));
  const requiredIds = fields.filter((field) => field.required).map((field) => field.id);
  const waitPattern = compilePattern(params.wait_for_url_pattern);
  const proxy = parseProxy(opts.proxyUrl);

  // No "persist:" prefix: the partition lives in memory only.
  const partition = `fb-login-web-${uuid()}`;
  const ses = electronSession.fromPartition(partition, { cache: false });
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  if (proxy) await ses.setProxy({ proxyRules: proxy.rules });
  if (params.user_agent) ses.setUserAgent(params.user_agent);
  for (const cookie of params.initial_cookies || []) {
    const host = String(cookie.domain || '').replace(/^\./, '');
    if (!host) continue;
    await ses.cookies.set({
      url: `https://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.http_only,
    }).catch(() => {});
  }

  const parent = opts.parent && !opts.parent.isDestroyed() ? opts.parent : undefined;
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent,
    show: !params.hidden,
    title: 'Xác minh Facebook',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  return await new Promise<Record<string, string>>((resolve, reject) => {
    let settled = false;
    let collected: Record<string, string> | null = null;

    const finish = (outcome: Record<string, string> | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      void ses.clearStorageData().catch(() => {});
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(new Error('Hết thời gian xác minh (5 phút). Vui lòng thử lại.')),
      WEB_STEP_TIMEOUT_MS,
    );

    // wait_for_url_pattern: values are only final once the page reached it.
    const maybeFinish = () => {
      if (!collected || settled || win.isDestroyed()) return;
      if (!waitPattern || waitPattern.test(win.webContents.getURL())) finish(collected);
    };

    // extract_js resolves when the page hands over the values, e.g. the
    // reCAPTCHA page calling window.FbLoginRecaptcha.onRecaptcha(). A
    // navigation drops the page context, so it is rerun on every load.
    const runExtract = () => {
      if (!params.extract_js || settled || win.isDestroyed()) return;
      win.webContents.executeJavaScript(params.extract_js, true)
        .then(async (value: unknown) => {
          if (settled) return;
          const values = pickValues(value, fieldIds);
          await fillFromCookies(ses, fields, values);
          if (requiredIds.every((id) => values[id])) {
            collected = values;
            maybeFinish();
          }
        })
        .catch((err: any) => {
          if (!settled) Logger.warn(`[FBLoginWebStep] extract_js failed: ${String(err?.message || err).slice(0, 200)}`);
        });
    };

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!/^https:\/\//i.test(url)) event.preventDefault();
    });
    win.webContents.on('login', (event, _details, authInfo, callback) => {
      if (authInfo.isProxy && proxy?.username) {
        event.preventDefault();
        callback(proxy.username, proxy.password || '');
      }
    });
    win.webContents.on('dom-ready', runExtract);
    win.webContents.on('did-navigate', maybeFinish);
    win.webContents.on('did-navigate-in-page', maybeFinish);
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) {
        finish(new Error(`Không mở được trang xác minh (${errorDescription || errorCode}).`));
      }
    });
    // Closing after the values arrived still counts (the URL wait is optional).
    win.on('closed', () => finish(collected ?? new NativeLoginWebStepClosedError()));

    win.loadURL(target.toString()).catch(() => {
      // Reported through did-fail-load; an aborted load is a redirect.
    });
  });
}
