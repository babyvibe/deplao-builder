/**
 * facebookIpc.ts
 * IPC handlers for all Facebook operations
 * Pattern: ipcMain.handle('fb:channel', async (_event, params) => { ... })
 */

import { BrowserWindow, ipcMain as electronIpcMain, type IpcMainInvokeEvent } from 'electron';
import { v4 as uuid } from 'uuid';
import DatabaseService from '../../../src/services/database/DatabaseService';
import FacebookConnectionManager from '../../../src/utils/connection/FacebookConnectionManager';
import { initSession, fetchBasicProfileFromHome, fetchFBHomepage, augmentWebCookies } from '../../../src/services/facebook/FacebookSession';
import { loginWithCredentials } from '../../../src/services/facebook/FacebookLoginHelper';
import { secureGet, secureSet, secureDelete } from '../../../src/services/secure/SecureSettingsService';
import FacebookE2EEBridge, {
  BridgeError,
  NATIVE_LOGIN_REQUIRED_CAPABILITIES,
  type NativeLoginResult,
  type NativeLoginStep,
} from '../../../src/services/facebook/e2ee/FacebookE2EEBridge';
import { buildProxyUrl } from '../../../src/utils/connection/ProxyHelper';
import { resolveNativeLoginBinaryPath } from '../../../src/services/facebook/FacebookUtils';
import { NativeLoginWebStepClosedError, runNativeLoginWebStep } from './facebookNativeLoginWebStep';
import FileStorageService from '../../../src/services/file/FileStorageService';
import EventBroadcaster from '../../../src/services/event/EventBroadcaster';
import Logger from '../../../src/utils/Logger';
import FacebookService from "../../../src/services/facebook/FacebookService";
import FacebookHistorySyncService from '../../../src/services/facebook/history/FacebookHistorySyncService';
import { employeeRoutedIpcMain } from '../network/proxyHelper';
import { tr } from '../../../src/shared/i18n';

/**
 * Employee mode: `ipcMain.handle` in this file registers handlers wrapped by the employeeChannelRoutes table
 * (src/services/http/employeeChannelRoutes.ts): an employee machine runs chat actions (send messages, reactions, unsend, groups…) on
 * Boss via /api/proxy/action and returns the real result; adding / signing in / connecting accounts, cookies, E2EE report the error "chỉ Boss" (Boss only).
 * Boss / standalone machines: the handler runs exactly as before. A new handler must be classified in the table (test proxyActionPolicy).
 */
const ipcMain = employeeRoutedIpcMain(electronIpcMain);

// ─── Cookie secure storage helpers ───────────────────────────────────────────

function fbCookieKey(accountId: string): string {
  return `fb_cookie_${accountId}`;
}

type NativeLoginSession = {
  bridge: FacebookE2EEBridge;
  expiryTimer?: ReturnType<typeof setTimeout>;
  /** Proxy chosen when the login started; the account is created with it. */
  proxyId: number | null | undefined;
  proxyUrl?: string;
  /** Last step shown to the user (a cookies step is run from it). */
  step?: NativeLoginStep;
};

// A login wizard owns a short-lived process of fbchat-login-bridge (see
// src/bridge-e2ee/login). It is never shared with a connected Facebook account
// and is destroyed on completion, cancel, or after 10 idle minutes.
const nativeLoginSessions = new Map<string, NativeLoginSession>();
const NATIVE_LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;
const NATIVE_LOGIN_STEP_CANCELLED = 'FI.MAU.LOGIN_STEP_CANCELLED';
const GOOGLE_OAUTH_STEP_SUFFIX = '.google_oauth';

/** Vietnamese explanations for the login helper's mautrix error codes. */
const NATIVE_LOGIN_ERROR_MESSAGES: Record<string, string> = {
  'FI.MAU.META_CHECKPOINT_ERROR': tr('Facebook yêu cầu xác minh tài khoản (checkpoint). Hãy mở ứng dụng hoặc website Facebook, hoàn tất bước xác minh rồi đăng nhập lại.'),
  'FI.MAU.META_CHALLENGE_ERROR': tr('Facebook yêu cầu xác minh bảo mật. Hãy kiểm tra ứng dụng hoặc website Facebook rồi thử lại.'),
  'FI.MAU.META_CONSENT_ERROR': tr('Facebook cần bạn xác nhận điều khoản. Hãy mở ứng dụng hoặc website Facebook rồi thử lại.'),
  'FI.MAU.META_AFAD_STOPPED': tr('Yêu cầu xác nhận trên thiết bị khác đã hết hạn hoặc bị từ chối. Vui lòng đăng nhập lại.'),
  'FI.MAU.META_OAUTH_MANDATORY': tr('Facebook bắt buộc xác minh bằng Google, ứng dụng chưa hỗ trợ. Hãy thêm ứng dụng xác thực hoặc SMS làm xác thực hai lớp cho tài khoản, hoặc dùng đăng nhập bằng Cookie.'),
  'FI.MAU.META_NO_SUPPORTED_MFA': tr('Không có phương thức xác thực hai lớp nào được hỗ trợ. Hãy thêm ứng dụng xác thực hoặc SMS cho tài khoản Facebook, hoặc dùng đăng nhập bằng Cookie.'),
  'FI.MAU.META_GOOGLE_RECAPTCHA': tr('Facebook yêu cầu Google reCAPTCHA. Hãy thử lại sau, hoặc đăng nhập trên ứng dụng/website Facebook chính thức trước.'),
  'FI.MAU.META_NO_SMS_AVAILABLE': tr('Facebook tạm thời không gửi được mã SMS. Hãy thử lại sau hoặc chọn phương thức xác thực khác.'),
  'FI.MAU.META_PASSKEY_MANDATORY': tr('Facebook bắt buộc đăng nhập bằng passkey, ứng dụng chưa hỗ trợ. Hãy thêm phương thức xác thực hai lớp khác hoặc dùng đăng nhập bằng Cookie.'),
  'FI.MAU.META_TOKEN_EXCHANGE_FAILED': tr('Facebook trả về phiên tạm thời không dùng được. Hãy thử lại, hoặc đăng nhập trên ứng dụng/website Facebook chính thức trước.'),
  'FI.MAU.META_RATE_LIMITED': tr('Facebook đang tạm chặn đăng nhập từ mạng này do thử quá nhiều lần. Vui lòng đợi vài phút rồi thử lại.'),
  'FI.MAU.META_MISSING_COOKIES': tr('Facebook không trả về đủ cookie phiên. Hãy bật xác thực hai lớp cho tài khoản rồi thử lại.'),
  'FI.MAU.META_UNINFORMATIVE_ERROR': tr('Facebook từ chối đăng nhập mà không nêu lý do. Hãy thử lại, đăng nhập trên ứng dụng/website Facebook trước, hoặc đổi cài đặt xác thực hai lớp.'),
  'FI.MAU.META_ACCOUNT_RECOVERY_REQUIRED': tr('Facebook yêu cầu khôi phục tài khoản (không phải mã xác thực hai lớp). Hãy hoàn tất trên ứng dụng hoặc website Facebook rồi đăng nhập lại.'),
  'FI.MAU.META_PHONE_NUMBER': tr('Đăng nhập tài khoản chỉ hỗ trợ email hoặc tên người dùng, không hỗ trợ số điện thoại. Vui lòng nhập email hoặc tên người dùng.'),
  'FI.MAU.META_MATRIX_ID': tr('Tên đăng nhập không hợp lệ. Vui lòng nhập email hoặc tên người dùng Facebook.'),
  'FI.MAU.META_TOKEN_ERROR': tr('Facebook đăng xuất phiên ngay sau khi đăng nhập. Vui lòng thử lại.'),
};

function describeNativeLoginError(err: any, fallback: string): string {
  const raw = String(err?.message || '').trim();
  const code = err instanceof BridgeError ? err.code : undefined;
  const mapped = code ? NATIVE_LOGIN_ERROR_MESSAGES[code] : undefined;
  if (mapped) {
    // A checkpoint carries Facebook's own title and message; keep it.
    return code === 'FI.MAU.META_CHECKPOINT_ERROR' && raw ? `${mapped} (${raw})` : mapped;
  }
  if (/native login step timed out|Bridge call timeout/i.test(raw)) return tr('Facebook phản hồi quá chậm. Vui lòng thử lại.');
  if (/^Bridge exited/.test(raw)) return tr('Trình đăng nhập Facebook dừng đột ngột ({{raw}}). Vui lòng thử lại.', { raw });
  if (/is not initialised/.test(raw)) return tr('Phiên đăng nhập đã kết thúc. Vui lòng bắt đầu lại.');
  return raw || fallback;
}

function touchNativeLoginSession(sessionId: string, session: NativeLoginSession): void {
  clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => { void disposeNativeLoginSession(sessionId); }, NATIVE_LOGIN_SESSION_TTL_MS);
  session.expiryTimer.unref?.();
}

async function spawnNativeLoginBridge(): Promise<FacebookE2EEBridge> {
  const bridge = FacebookE2EEBridge.create(resolveNativeLoginBinaryPath());
  bridge.spawn();
  try {
    await bridge.hello(10000, NATIVE_LOGIN_REQUIRED_CAPABILITIES);
  } catch (err) {
    await bridge.close().catch(() => {});
    throw err;
  }
  return bridge;
}

async function disposeNativeLoginSession(sessionId: string): Promise<void> {
  const session = nativeLoginSessions.get(sessionId);
  if (!session) return;
  nativeLoginSessions.delete(sessionId);
  clearTimeout(session.expiryTimer);
  try { await session.bridge.cancelNativeLogin(); } catch {}
  await session.bridge.close().catch(() => {});
}

function serializeNativeCookies(cookies: Record<string, string> | undefined): string {
  if (!cookies) return '';
  return Object.entries(cookies)
    .filter(([name, value]) => name && typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function validateNativeLoginInput(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 8) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    // Same limits as fbchat-login-bridge (reCAPTCHA tokens run to a few KiB).
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(key) || typeof value !== 'string' || value.length > 16 * 1024) return null;
    result[key] = value;
  }
  return result;
}

/**
 * Resolve accountId: if it is a Facebook UID (all digits) → look up the UUID in fb_accounts.
 * If it is already a UUID → return it unchanged. Used by all handlers that receive accountId from the UI.
 */
function resolveInternalId(accountId: string): string {
  // If it looks like a Facebook UID (all digits) → look up the UUID
  if (/^\d+$/.test(accountId)) {
    const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(accountId);
    if (fbAcc?.id) return fbAcc.id;
  }
  return accountId;
}

/**
 * Always resolve the numeric Facebook ID - used as the name of the media folder.
 * Do not fall back to the internal UUID: if the service is null or not initialized,
 * look up the real facebook_id in the DB.
 */
function resolveRealFacebookId(internalId: string, service: any): string {
  const fbId = service?.getRealFacebookId();
  if (fbId) return fbId;
  const fbAcc = DatabaseService.getInstance().getFBAccount(internalId);
  return fbAcc?.facebook_id || internalId;
}

/** Open-source build: keep the function so imports in the main process do not break. */
export function setFBMainWindow(_win: any) {}

/**
 * Get FacebookService from ConnectionManager, auto-reconnecting if it is not there yet.
 * All handlers call this instead of calling FacebookConnectionManager.get() directly.
 * Avoids the "Account not connected" error when the network drops and comes back online but
 * ConnectionManager has not synced yet.
 */
async function getFBServiceOrReconnect(internalId: string): Promise<FacebookService | null> {
  let service = FacebookConnectionManager.get(internalId);
  if (service) return service;

  Logger.warn(`[facebookIpc] Service ${internalId} not in ConnectionManager - attempting auto-reconnect...`);
  const account = DatabaseService.getInstance().getFBAccount(internalId);
  if (!account) return null;

  const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
  if (!cookie) return null;

  let proxyId: number | null | undefined;
  try {
    const accRow = DatabaseService.getInstance().queryOne<any>('SELECT proxy_id FROM accounts WHERE zalo_id = ?', [account.facebook_id || internalId]);
    proxyId = accRow?.proxy_id ?? null;
  } catch { proxyId = null; }

  try {
    service = await FacebookConnectionManager.getOrCreate(internalId, cookie, proxyId);
    Logger.log(`[facebookIpc] Auto-reconnect success for ${internalId}`);
    return service;
  } catch (err: any) {
    Logger.warn(`[facebookIpc] Auto-reconnect failed for ${internalId}: ${err.message}`);
    return null;
  }
}

type FacebookConnectSource = 'dashboard' | 'startup' | 'startup-retry';

/**
 * Connect one account through the same path for the dashboard and automatic
 * startup. Do not add a separate cookie-health preflight here: creating a
 * FacebookService already validates the cookie with the account proxy, and a
 * duplicate homepage request used to leave startup waiting for up to a minute
 * before the MQTT/E2EE listeners were even created.
 */
async function connectFacebookAccount(
  internalId: string,
  source: FacebookConnectSource,
): Promise<{ service: FacebookService; listenerConnected: boolean; e2eeConnected: boolean }> {
  const db = DatabaseService.getInstance();
  const account = db.getFBAccount(internalId);
  if (!account) throw new Error('Account not found');

  const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
  if (!cookie) throw new Error('No cookie found for this account');

  let proxyId: number | null | undefined;
  try {
    const accRow = db.queryOne<any>(
      'SELECT proxy_id FROM accounts WHERE zalo_id = ?',
      [account.facebook_id || internalId],
    );
    proxyId = accRow?.proxy_id ?? null;
  } catch {
    proxyId = null;
  }

  Logger.log(`[facebookIpc] ${source} ${internalId}: starting Facebook session`);
  const service = await FacebookConnectionManager.getOrCreate(internalId, cookie, proxyId);

  // FacebookService.connect() starts MQTT asynchronously. Waiting here is what
  // makes automatic reconnect equivalent to dashboard reconnect, instead of
  // logging success while the socket is still dead.
  const ready = await service.ensureConnected();
  const listenerConnected = service.isListenerActuallyConnected();
  const e2eeConnected = service.isE2EEConnected();
  if (!ready) {
    throw new Error(tr('Facebook listener chưa sẵn sàng sau khi kết nối. Hệ thống sẽ tự thử lại.'));
  }

  service.resetListenerRetryCount?.();
  db.setListenerActive(account.facebook_id || internalId, true);
  Logger.log(
    `[facebookIpc] ${source} ${internalId}: ready ` +
    `(mqtt=${listenerConnected}, e2ee=${e2eeConnected})`,
  );
  return { service, listenerConnected, e2eeConnected };
}

const FB_STARTUP_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
const fbStartupRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearFacebookStartupRetry(accountId: string): void {
  const timer = fbStartupRetryTimers.get(accountId);
  if (timer) clearTimeout(timer);
  fbStartupRetryTimers.delete(accountId);
}

function scheduleFacebookStartupRetry(accountId: string, failedAttempt: number): void {
  if (failedAttempt >= FB_STARTUP_RETRY_DELAYS_MS.length || fbStartupRetryTimers.has(accountId)) return;
  const delay = FB_STARTUP_RETRY_DELAYS_MS[failedAttempt];
  Logger.warn(
    `[facebookIpc] startup ${accountId}: retrying in ${Math.round(delay / 1000)}s ` +
    `(attempt ${failedAttempt + 2}/${FB_STARTUP_RETRY_DELAYS_MS.length + 1})`,
  );
  const timer = setTimeout(() => {
    fbStartupRetryTimers.delete(accountId);
    connectFacebookAccount(accountId, 'startup-retry')
      .then(() => clearFacebookStartupRetry(accountId))
      .catch((err: any) => {
        Logger.warn(`[facebookIpc] startup retry ${accountId}: ${err?.message || err}`);
        scheduleFacebookStartupRetry(accountId, failedAttempt + 1);
      });
  }, delay);
  timer.unref?.();
  fbStartupRetryTimers.set(accountId, timer);
}

/**
 * Accounts removed from the app (accounts row with is_active = 0: Dashboard "Xóa tài khoản" (Delete account), Settings "Chỉ xoá tài khoản" (Delete account only)):
 * the data is kept, but startup does not reconnect them automatically.
 */
function isFacebookAccountRemoved(facebookId: string | null | undefined): boolean {
  if (!facebookId) return false;
  try {
    const row = DatabaseService.getInstance().queryOne<{ is_active: number }>(
      'SELECT is_active FROM accounts WHERE zalo_id = ?',
      [facebookId],
    );
    return !!row && Number(row.is_active) === 0;
  } catch {
    return false;
  }
}

/**
 * Signs the Facebook account out when it is removed from the app: does NOT delete data. Disconnects, cancels the pending reconnect at startup,
 * deletes the session (cookie in secure storage, raw cookie + session_data in fb_accounts) and the E2EE device state
 * (signing in again also creates a new device, _addFBAccountCommon). Shared by fb:removeAccount (Dashboard) and
 * login:removeAccount (Settings → Accounts); the accounts row and the data deletion are decided by the caller.
 */
export async function signOutFacebookAccount(internalId: string): Promise<void> {
  clearFacebookStartupRetry(internalId);
  await FacebookConnectionManager.disconnect(internalId).catch((err: any) => {
    Logger.warn(`[facebookIpc] signOut ${internalId}: disconnect failed: ${err?.message || err}`);
  });
  await FacebookService.removeInstance(internalId).catch(() => {});
  secureDelete(fbCookieKey(internalId));
  DatabaseService.getInstance().clearFBAccountSession(internalId);
}

/**
 * Reconnect a Facebook account with the saved session: recreates the session + MQTT + E2EE with the proxy saved in
 * accounts.proxy_id (just changed in Settings, network/proxyIpc). Throws an error if it cannot connect.
 */
export async function reconnectFacebookAccount(accountId: string): Promise<void> {
  const internalId = resolveInternalId(accountId);
  clearFacebookStartupRetry(internalId);
  await FacebookConnectionManager.disconnect(internalId);
  await connectFacebookAccount(internalId, 'dashboard');
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function registerFacebookIpc(): void {

  /**
   * Shared helper: verify cookie, save account to DB, connect.
   * Shared by cookie-based and credentials-based login.
   */
  async function _addFBAccountCommon(cookie: string, proxyId: number | null | undefined): Promise<{
    success: boolean; account?: any; facebookId?: string; name?: string; error?: string;
  }> {
    // Resolve the proxy agent to use for initSession
    let httpsAgent: any = undefined;
    if (proxyId) {
      try {
        const proxy = DatabaseService.getInstance().getProxyById(proxyId);
        if (proxy) {
          const { createProxyAgent } = require('../../../src/utils/connection/ProxyHelper');
          httpsAgent = createProxyAgent(proxy);
        }
      } catch {}
    }

    // 1. Verify cookie alive + init session (with proxy)
    const sessionData = await initSession(cookie, httpsAgent);
    const fbId = sessionData.FacebookID;

    if (!fbId || fbId === '0' || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
      return { success: false, error: tr('Cookie không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại Facebook và copy cookie mới.') };
    }

    // 2. Signing in again to an existing account (session expired → sign-in popup on the Dashboard): keep the internal ID
    // same conversations / messages / CRM, only the session is replaced. The old connection (including the E2EE device state) is dropped
    // as in a brand-new sign-in.
    const existing = DatabaseService.getInstance().getFBAccountByFacebookId(fbId);
    if (existing) {
      Logger.log(`[facebookIpc] _addFBAccountCommon - account ${fbId} đã tồn tại, đăng nhập lại (giữ dữ liệu)`);
      await FacebookConnectionManager.disconnect(existing.id).catch(() => {});
      await FacebookService.removeInstance(existing.id).catch(() => {});
    }

    // 3. Get the name + avatar (signing in again: keep the old name/avatar if they cannot be fetched)
    let name = existing?.name || fbId;
    let avatarUrl = existing?.avatar_url || '';
    try {
      const html = await fetchFBHomepage(cookie);
      const profile = await fetchBasicProfileFromHome(html);
      if (profile.name) name = profile.name;
      if (profile.avatarUrl) avatarUrl = profile.avatarUrl;
    } catch {}

    // 4. Save to DB (encrypted cookie). Login with username/password (mobile) only
    // returns the minimal cookies (c_user/xs/datr/fr) → add the web cookies (sb, wd, ...)
    // that www.facebook.com sets via Set-Cookie, so the data scan (/api/graphql) is not blocked.
    const storedCookie = await augmentWebCookies(cookie, httpsAgent);
    const accountId = existing?.id || uuid();
    secureSet(fbCookieKey(accountId), storedCookie);

    DatabaseService.getInstance().saveFBAccount({
      id: accountId,
      facebook_id: fbId,
      name,
      avatar_url: avatarUrl,
      // Cookies live only in secure storage (encrypted); there is no longer a raw backup copy in fb_accounts
      cookie_encrypted: '',
      session_data: JSON.stringify(sessionData),
      status: 'disconnected',
    });

    // Also sync to unified accounts table - use fbId as zalo_id (for license matching)
    DatabaseService.getInstance()['run'](
      `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, channel, proxy_id, created_at)
       VALUES (?, ?, ?, '', 0, '', '', '', 1, 'facebook', ?, datetime('now'))
       ON CONFLICT(zalo_id) DO UPDATE SET
         full_name = excluded.full_name, avatar_url = excluded.avatar_url,
         channel = 'facebook', is_active = 1, proxy_id = excluded.proxy_id`,
      [fbId, name, avatarUrl, proxyId ?? null]
    );

    // 5. Connect (with proxy) - getOrCreate already connects automatically
    await FacebookConnectionManager.getOrCreate(accountId, storedCookie, proxyId);

    const account = DatabaseService.getInstance().getFBAccount(accountId);
    return { success: true, account, facebookId: fbId, name };
  }

  /**
   * Add a Facebook account using cookies
   */
  ipcMain.handle('fb:addAccount', async (_event, { cookie, proxyId }: { cookie: string; proxyId?: number | null }) => {
    try {
      return await _addFBAccountCommon(cookie, proxyId);
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:addAccount error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Add a Facebook account using username/password (+ optional 2FA)
   * Calls loginWithCredentials → gets cookies → creates the account via _addFBAccountCommon
   */
  ipcMain.handle('fb:addAccountWithCredentials', async (_event, params: {
    username: string; password: string; twoFASecret?: string; proxyId?: number | null;
  }) => {
    try {
      // Resolve proxy agent cho loginWithCredentials
      let httpsAgent: any = undefined;
      if (params.proxyId) {
        try {
          const proxy = DatabaseService.getInstance().getProxyById(params.proxyId);
          if (proxy) {
            const { createProxyAgent } = require('../../../src/utils/connection/ProxyHelper');
            httpsAgent = createProxyAgent(proxy);
          }
        } catch {}
      }

      // 1. Sign in to get cookies
      const loginResult = await loginWithCredentials(
        params.username, params.password, params.twoFASecret, httpsAgent
      );

      // 2FA challenge - asks the UI for twoFASecret
      if (loginResult.error?.error_subcode === 1348162) {
        return {
          success: false,
          need2FA: true,
          error: loginResult.error.description || tr('Tài khoản yêu cầu xác thực 2 yếu tố (2FA). Vui lòng nhập mã bí mật 2FA.'),
          errorTitle: loginResult.error.title,
        };
      }

      // Other sign-in errors (wrong password, checkpoint, ...)
      if (!loginResult.success) {
        Logger.warn(`[facebookIpc] loginWithCredentials failed:`, JSON.stringify(loginResult.error));
        return {
          success: false,
          error: loginResult.error?.description || loginResult.error?.title || tr('Đăng nhập thất bại'),
          errorTitle: loginResult.error?.title,
        };
      }

      // 2. Success - create the account with the cookies just obtained
      const cookie = loginResult.success.setCookies;
      if (!cookie) {
        return { success: false, error: tr('Đăng nhập thành công nhưng không lấy được cookie.') };
      }

      return await _addFBAccountCommon(cookie, params.proxyId);
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:addAccountWithCredentials error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Credential login ("Đăng nhập tài khoản" = account sign-in) through fbchat-login-bridge, which
   * runs Messenger Lite's step-by-step login: credentials, then whatever
   * Facebook asks for (code, captcha, approval on another device, reCAPTCHA).
   * Secrets are passed through IPC but deliberately never written to logs.
   */
  const expiredNativeLogin = { success: false, expired: true, error: tr('Phiên đăng nhập đã hết hạn. Vui lòng bắt đầu lại.') };

  /** The wizard for `sessionId`, or null once it expired or its helper process died. */
  const getLiveNativeLoginSession = async (sessionId: string): Promise<NativeLoginSession | null> => {
    const session = nativeLoginSessions.get(sessionId);
    if (!session) return null;
    if (session.bridge.isAlive()) return session;
    await disposeNativeLoginSession(sessionId);
    return null;
  };

  /** Error answer for a failed step; a dead helper process ends the wizard. */
  const nativeLoginFailure = async (sessionId: string, session: NativeLoginSession, err: any, fallback: string) => {
    const error = describeNativeLoginError(err, fallback);
    if (session.bridge.isAlive()) return { success: false, error };
    await disposeNativeLoginSession(sessionId);
    return { success: false, expired: true, error };
  };

  /** Answer the renderer with the next step, or create the account once complete. */
  const finishNativeLoginStep = async (sessionId: string, session: NativeLoginSession, result: NativeLoginResult) => {
    if (!result.complete) {
      if (result.step) session.step = result.step;
      return { success: true, sessionId, step: session.step, ...(result.waiting ? { waiting: true } : {}) };
    }
    const cookie = serializeNativeCookies(result.cookies);
    await disposeNativeLoginSession(sessionId);
    if (!cookie) return { success: false, error: tr('Đăng nhập hoàn tất nhưng không nhận được cookie phiên.') };
    return await _addFBAccountCommon(cookie, session.proxyId);
  };

  ipcMain.handle('fb:startMessengerLiteLogin', async (_event, { proxyId }: { proxyId?: number | null }) => {
    let bridge: FacebookE2EEBridge | null = null;
    try {
      let proxyUrl: string | undefined;
      if (proxyId) {
        const proxy = DatabaseService.getInstance().getProxyById(proxyId);
        if (!proxy) return { success: false, error: tr('Proxy đã chọn không tồn tại.') };
        proxyUrl = buildProxyUrl(proxy);
      }

      bridge = await spawnNativeLoginBridge();
      const result = await bridge.startNativeLogin(proxyUrl);
      const sessionId = uuid();
      const session: NativeLoginSession = { bridge, proxyId, proxyUrl };
      nativeLoginSessions.set(sessionId, session);
      touchNativeLoginSession(sessionId, session);
      bridge = null;
      return await finishNativeLoginStep(sessionId, session, result);
    } catch (err: any) {
      Logger.warn(`[facebookIpc] Messenger Lite login could not start: ${err.message}`);
      return { success: false, error: describeNativeLoginError(err, tr('Không thể khởi tạo đăng nhập Facebook.')) };
    } finally {
      if (bridge) await bridge.close().catch(() => {});
    }
  });

  ipcMain.handle('fb:submitMessengerLiteLogin', async (_event, params: { sessionId?: string; input?: Record<string, string> }) => {
    const sessionId = String(params?.sessionId || '');
    const input = validateNativeLoginInput(params?.input);
    const session = await getLiveNativeLoginSession(sessionId);
    if (!session) return expiredNativeLogin;
    if (!input) return { success: false, error: tr('Dữ liệu xác thực không hợp lệ.') };
    touchNativeLoginSession(sessionId, session);

    try {
      return await finishNativeLoginStep(sessionId, session, await session.bridge.submitNativeLogin(input));
    } catch (err: any) {
      // The upstream state machine keeps its state after a rejected code so the
      // user can retry; do not dispose the session merely because a step failed.
      Logger.warn(`[facebookIpc] Messenger Lite login step failed: ${err.message}`);
      return await nativeLoginFailure(sessionId, session, err, tr('Xác thực Facebook thất bại.'));
    }
  });

  /** Poll an approval on another device; `waiting: true` while still pending. */
  ipcMain.handle('fb:waitMessengerLiteLogin', async (_event, params: { sessionId?: string }) => {
    const sessionId = String(params?.sessionId || '');
    const session = await getLiveNativeLoginSession(sessionId);
    if (!session) return expiredNativeLogin;
    touchNativeLoginSession(sessionId, session);

    try {
      return await finishNativeLoginStep(sessionId, session, await session.bridge.waitNativeLogin());
    } catch (err: any) {
      // "Try another way" or cancel interrupted this wait; the renderer moved on.
      if (err instanceof BridgeError && err.code === NATIVE_LOGIN_STEP_CANCELLED) {
        return { success: false, cancelled: true };
      }
      if (!nativeLoginSessions.has(sessionId)) return expiredNativeLogin;
      Logger.warn(`[facebookIpc] Messenger Lite approval wait failed: ${err.message}`);
      return await nativeLoginFailure(sessionId, session, err, tr('Không kiểm tra được trạng thái xác nhận.'));
    }
  });

  /** "Try another way": leave the current verification step for another method. */
  ipcMain.handle('fb:backMessengerLiteLogin', async (_event, params: { sessionId?: string }) => {
    const sessionId = String(params?.sessionId || '');
    const session = await getLiveNativeLoginSession(sessionId);
    if (!session) return expiredNativeLogin;
    touchNativeLoginSession(sessionId, session);

    try {
      return await finishNativeLoginStep(sessionId, session, await session.bridge.backNativeLogin());
    } catch (err: any) {
      Logger.warn(`[facebookIpc] Messenger Lite step back failed: ${err.message}`);
      return await nativeLoginFailure(sessionId, session, err, tr('Không thể chuyển sang cách xác minh khác.'));
    }
  });

  /**
   * Run the current `cookies` step (Google reCAPTCHA) in a verification window
   * and submit what it yields. The values go from the window straight to the
   * login helper without passing through the renderer.
   */
  ipcMain.handle('fb:runMessengerLiteWebStep', async (event, params: { sessionId?: string }) => {
    const sessionId = String(params?.sessionId || '');
    const session = await getLiveNativeLoginSession(sessionId);
    if (!session) return expiredNativeLogin;
    const step = session.step;
    if (step?.type !== 'cookies' || !step.cookies) {
      return { success: false, error: tr('Bước hiện tại không cần mở cửa sổ xác minh.') };
    }
    if (step.step_id.endsWith(GOOGLE_OAUTH_STEP_SUFFIX)) {
      // fbchat's login library cannot finish a Google sign-in yet.
      return { success: false, error: NATIVE_LOGIN_ERROR_MESSAGES['FI.MAU.META_OAUTH_MANDATORY'] };
    }
    touchNativeLoginSession(sessionId, session);

    let values: Record<string, string>;
    try {
      values = await runNativeLoginWebStep(step, {
        proxyUrl: session.proxyUrl,
        parent: BrowserWindow.fromWebContents(event.sender),
      });
    } catch (err: any) {
      if (err instanceof NativeLoginWebStepClosedError) return { success: false, error: err.message };
      Logger.warn(`[facebookIpc] Messenger Lite web step failed: ${err.message}`);
      return { success: false, error: err.message || tr('Không hoàn tất được bước xác minh.') };
    }

    // The wizard may have expired or been cancelled while the window was open.
    const current = await getLiveNativeLoginSession(sessionId);
    if (!current) return expiredNativeLogin;
    touchNativeLoginSession(sessionId, current);
    try {
      return await finishNativeLoginStep(sessionId, current, await current.bridge.submitNativeLogin(values));
    } catch (err: any) {
      Logger.warn(`[facebookIpc] Messenger Lite web step submit failed: ${err.message}`);
      return await nativeLoginFailure(sessionId, current, err, tr('Facebook không chấp nhận kết quả xác minh.'));
    }
  });

  ipcMain.handle('fb:cancelMessengerLiteLogin', async (_event, { sessionId }: { sessionId?: string }) => {
    await disposeNativeLoginSession(String(sessionId || ''));
    return { success: true };
  });

  /**
   * Remove a Facebook account from the app (Dashboard): KEEPS the data, like Zalo / Telegram. Before, it permanently deleted messages,
   * conversations and CRM contacts (deleteFBAccount), which the confirmation dialog did not mention. To delete all data too: Settings → Accounts →
   * "Xoá tất cả dữ liệu" (Delete all data) (login:removeAccount with deleteData).
   */
  ipcMain.handle('fb:removeAccount', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const facebookId = DatabaseService.getInstance().getFBAccount(internalId)?.facebook_id || accountId;
      await signOutFacebookAccount(internalId);
      // Hidden from the merged accounts table (zalo_id = facebook_id), like login:removeAccount, which does not delete data
      DatabaseService.getInstance().deleteAccount(facebookId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Update the cookies of an existing Facebook account
   */
  ipcMain.handle('fb:updateCookie', async (_event, { accountId, cookie }: { accountId: string; cookie: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const account = DatabaseService.getInstance().getFBAccount(internalId);
      if (!account) return { success: false, error: tr('Tài khoản không tồn tại') };

      // Verify cookie alive + init session
      const sessionData = await initSession(cookie);
      const fbId = sessionData.FacebookID;
      if (!fbId || !fbId.match(/^\d+$/) || fbId.includes('Unable')) {
        return { success: false, error: tr('Cookie không hợp lệ hoặc đã hết hạn') };
      }

      // Fetch updated profile
      let name = account.name || fbId;
      let avatarUrl = account.avatar_url || '';
      try {
        const html = await fetchFBHomepage(cookie);
        const profile = await fetchBasicProfileFromHome(html);
        if (profile.name) name = profile.name;
        if (profile.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch {}

      // Update cookie in secure storage
      secureSet(fbCookieKey(internalId), cookie);

      // Do not keep a raw backup copy of the cookies in fb_accounts (delete the old one if present): when the safeStorage key changes
      // (data copied to another machine), sign in again, like Zalo
      DatabaseService.getInstance().run(
        `UPDATE fb_accounts SET cookie_encrypted = '', updated_at = ? WHERE id = ?`,
        [Date.now(), internalId]
      );

      // Update session + profile
      DatabaseService.getInstance().updateFBAccountSession(internalId, JSON.stringify(sessionData));
      DatabaseService.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, fbId);

      // Update unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance()['run'](
        `UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`,
        [name, avatarUrl, fbId]
      );

      Logger.log(`[facebookIpc] fb:updateCookie success for ${internalId}`);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:updateCookie error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Refresh the profile (name, avatar) of an existing Facebook account
   */
  ipcMain.handle('fb:refreshProfile', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const account = DatabaseService.getInstance().getFBAccount(internalId);
      if (!account) return { success: false, error: tr('Tài khoản không tồn tại') };

      const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;
      if (!cookie) return { success: false, error: tr('Không tìm thấy cookie. Vui lòng cập nhật cookie.') };

      let name = account.name || account.facebook_id;
      let avatarUrl = account.avatar_url || '';
      try {
        const html = await fetchFBHomepage(cookie);
        const profile = await fetchBasicProfileFromHome(html);
        if (profile.name) name = profile.name;
        if (profile.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch (err: any) {
        Logger.warn(`[facebookIpc] fb:refreshProfile fetch error: ${err.message}`);
      }

      // Update FB account table
      DatabaseService.getInstance().updateFBAccountProfile(internalId, name, avatarUrl, account.facebook_id);

      // Update unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance()['run'](
        `UPDATE accounts SET full_name = ?, avatar_url = ? WHERE zalo_id = ?`,
        [name, avatarUrl, account.facebook_id]
      );

      Logger.log(`[facebookIpc] fb:refreshProfile success for ${account.facebook_id}: ${name}`);
      return { success: true, name, avatarUrl, facebookId: account.facebook_id };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:refreshProfile error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Refresh the avatar of 1 Facebook contact (1-1 user).
   * Used when the avatar CDN link has expired (403). Re-fetches the thread list from GraphQL
   * to get the new avatar URL, update the DB, and return the URL.
   */
  ipcMain.handle('fb:refreshContactAvatar', async (_event, { accountId, userId }: { accountId: string; userId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const cookie = secureGet(fbCookieKey(internalId));
      if (!cookie) return { success: false, error: tr('Không tìm thấy cookie. Vui lòng cập nhật cookie.'), avatarUrl: null };

      const service = FacebookConnectionManager.get(internalId);
      if (!service || !service.isConnected()) {
        // If the service is not connected, refreshContactAvatar can still be called
        // by creating a temporary, non-persistent service
        return { success: false, error: 'Tài khoản chưa kết nối', avatarUrl: null };
      }

      const avatarUrl = await service.refreshContactAvatar(userId);
      if (avatarUrl) {
        return { success: true, avatarUrl };
      }
      return { success: false, error: tr('Không thể lấy avatar mới'), avatarUrl: null };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:refreshContactAvatar error: ${err.message}`);
      return { success: false, error: err.message, avatarUrl: null };
    }
  });

  /** Resolve a one-to-one Facebook identity by its numeric UID. */
  const getUserInfoFacebookHandler = async (_event: IpcMainInvokeEvent, { accountId, userId }: { accountId: string; userId: string }) => {
    try {
      // Only allow numeric user IDs (not group chats)
      if (!/^\d+$/.test(userId)) return { success: false, error: tr('Chỉ hỗ trợ user 1-1') };
      const internalId = resolveInternalId(accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối' };
      const info = await service.getUserInfoFacebook(userId);
      if (info) {
        Logger.log(`[facebookIpc] fb:getUserInfoFacebook: resolved ${userId} → name="${info.name}"`);
        // Save under the real Facebook UID, not the account's internal UUID.
        if (info.name) {
          DatabaseService.getInstance()['run']?.(
            `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
             VALUES (?, ?, ?, ?, 0, 'user', 0, '', 0, 'facebook')
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               display_name = excluded.display_name,
               avatar_url = excluded.avatar_url`,
            [resolveRealFacebookId(internalId, service), userId, info.name, info.avatarUrl || '']
          );
        }
        return { success: true, name: info.name, avatarUrl: info.avatarUrl };
      }
      return { success: false, error: tr('Không thể lấy thông tin user') };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:getUserInfoFacebook error: ${err.message}`);
      return { success: false, error: err.message };
    }
  };
  ipcMain.handle('fb:getUserInfoFacebook', getUserInfoFacebookHandler);
  // Kept so renderer bundles released before the IPC rename keep working.
  ipcMain.handle('fb:getUserInfoFacebookHtml', getUserInfoFacebookHandler);

  /**
   * Get the list of FB accounts
   */
  ipcMain.handle('fb:getAccounts', async () => {
    try {
      const accounts = DatabaseService.getInstance().getFBAccounts();
      return { success: true, accounts };
    } catch (err: any) {
      return { success: false, accounts: [], error: err.message };
    }
  });

  /**
   * Connect MQTT listener cho account
   */
  ipcMain.handle('fb:connect', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const result = await connectFacebookAccount(internalId, 'dashboard');
      clearFacebookStartupRetry(internalId);
      return {
        success: true,
        listenerConnected: result.listenerConnected,
        e2eeConnected: result.e2eeConnected,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Disconnect MQTT listener
   */
  ipcMain.handle('fb:disconnect', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      await FacebookConnectionManager.disconnect(internalId);
      DatabaseService.getInstance().updateFBAccountStatus(internalId, 'disconnected');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Health check
   */
  ipcMain.handle('fb:checkHealth', async (_event, { accountId }: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: true, alive: false, listenerConnected: false, reason: 'not_initialized' };
      const health = await service.checkHealth();
      return { success: true, ...health };
    } catch (err: any) {
      return { success: false, alive: false, listenerConnected: false, error: err.message };
    }
  });

  /**
   * Send a message (C1: auto-route 1:1 via E2EE)
   * Shares FacebookSendService.sendTextMessage() with the workflow engine.
   */
   ipcMain.handle('fb:sendMessage', async (_event, params: {
    accountId: string; threadId: string; body: string; options?: any;
  }) => {
    const startedAt = Date.now();
    try {
      const internalId = resolveInternalId(params.accountId);
      Logger.log(`[facebookIpc] fb:sendMessage accountId=${params.accountId} → internalId=${internalId} threadId=${params.threadId} body="${params.body?.slice(0,50)}"`);

      // Auto-reconnect if the service is not yet in ConnectionManager
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) {
        return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      }

      const { FacebookSendService } = require('../../../src/services/facebook/send/FacebookSendService');

      // Phase 4: Preserve typeChat tri-state (undefined vs null have different meanings)
      // undefined = not specified → resolve from DB
      // null = explicitly group
      // 'user' = explicitly 1:1
      const hasTypeChat = params.options && Object.prototype.hasOwnProperty.call(params.options, 'typeChat');
      const typeChat = hasTypeChat ? params.options.typeChat : undefined;

      const TIMEOUT_MS = 60000;
      const result = (await Promise.race([
        FacebookSendService.sendTextMessage({
          accountId: internalId,
          threadId: params.threadId,
          body: params.body,
          typeChat,
          replyToMessageId: params.options?.replyToMessageId,
        }),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error(tr('Gửi tin nhắn timeout sau {{v1}}s. Vui lòng thử lại.', { v1: TIMEOUT_MS / 1000 }))), TIMEOUT_MS)
        ),
      ])) as any;

      const elapsedMs = Date.now() - startedAt;
      if (result?.success) {
        Logger.log(`[facebookIpc] fb:sendMessage completed accountId=${internalId} threadId=${params.threadId} success=true elapsedMs=${elapsedMs}`);
      } else {
        Logger.warn(`[facebookIpc] fb:sendMessage completed accountId=${internalId} threadId=${params.threadId} success=false elapsedMs=${elapsedMs} error=${result?.error || 'unknown'}`);
      }

      return result;
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:sendMessage error after ${Date.now() - startedAt}ms: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Send an attachment (C2: auto-route 1:1 via E2EE)
   * DEPLAO_ADAPTER: Delegates to FacebookSendService.sendAttachment() for
   * consolidated route matrix. No fallback between E2EE and REST routes.
   */
  ipcMain.handle('fb:sendAttachment', async (_event, params: {
    accountId: string; threadId: string; filePath: string; body?: string; typeChat?: 'user' | null; fileType?: 'image' | 'video' | 'audio' | 'file';
    replyToMessageId?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      const { FacebookSendService } = require('../../../src/services/facebook/send/FacebookSendService');
      const result = await FacebookSendService.sendAttachment({
        accountId: internalId,
        threadId: params.threadId,
        filePath: params.filePath,
        body: params.body,
        typeChat: params.typeChat,
        fileType: params.fileType,
        replyToMessageId: params.replyToMessageId,
      });

      return { ...result, fileName: require('path').basename(params.filePath) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Send several images/files in one request (batch attachments)
   * DEPLAO_ADAPTER: Delegates to FacebookSendService.sendAttachment() per file.
   */
  ipcMain.handle('fb:sendAttachments', async (_event, params: {
    accountId: string; threadId: string; filePaths: string[]; body?: string; typeChat?: 'user' | null;
    replyToMessageId?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      const { FacebookSendService } = require('../../../src/services/facebook/send/FacebookSendService');
      let failCount = 0;

      for (const fp of params.filePaths) {
        const result = await FacebookSendService.sendAttachment({
          accountId: internalId,
          threadId: params.threadId,
          filePath: fp,
          body: params.body,
          typeChat: params.typeChat,
          replyToMessageId: params.replyToMessageId,
        });
        if (!result.success) failCount++;
      }

      return {
        success: failCount < params.filePaths.length,
        uploadedCount: params.filePaths.length - failCount,
        totalCount: params.filePaths.length,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Unsend a message
   */
  ipcMain.handle('fb:unsendMessage', async (_event, params: {
    accountId: string; messageId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const result = await service.unsendMessage(params.messageId);
      if (result.success) {
        DatabaseService.getInstance().updateFBMessageUnsent(params.messageId);
      }
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Reaction (C3: auto-route via service)
   * DEPLAO_ADAPTER: Delegate entirely to FacebookService.addReaction().
   * Service handles: resolveMessageThreadKind → E2EE/REST routing,
   * correct sender JID from DB, idempotent remove via empty emoji.
   * No local DB write on failure — only on success through the service.
   */
  ipcMain.handle('fb:addReaction', async (_event, params: {
    accountId: string; messageId: string; emoji: string; action: 'add' | 'remove';
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      return await service.addReaction(params.messageId, params.emoji, params.action);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Edit the content of a sent message (I1)
   */
  ipcMain.handle('fb:editMessage', async (_event, params: {
    accountId: string; messageId: string; text: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.editMessage(params.messageId, params.text);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Get the list of threads
   */
  ipcMain.handle('fb:getThreads', async (_event, params: {
    accountId: string; forceRefresh?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      // Read from the DB first (cache)
      const cached = DatabaseService.getInstance().getFBThreads(internalId);

      if (!params.forceRefresh && cached.length > 0) {
        return { success: true, threads: cached };
      }

      // Refresh both sources. The bridge page contains E2EE/private threads
      // that the legacy web GraphQL inbox does not consistently return.
      const service = await getFBServiceOrReconnect(internalId);
      if (service && service.isConnected()) {
        const history = await service.syncBridgeHistory();
        const threads = await service.getThreadList();
        const db = DatabaseService.getInstance();
        db.saveFBThreads(internalId, threads);
        // Correct rows that were previously populated with the account avatar.
        // The repair uses Facebook's ID-bound /picture endpoint and only
        // requests avatars that are blank or match the current account.
        const repairedAvatars = await service.refreshSuspectThreadAvatars(
          db.getFBThreads(internalId).map(thread => thread.id),
        );
        const updated = db.getFBThreads(internalId);
        return { success: true, threads: updated, syncedMessages: history.messages, repairedAvatars };
      }

      return { success: true, threads: cached };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:getThreads error: ${err.message}`);
      return { success: false, threads: [], error: err.message };
    }
  });

  /**
   * Get messages from the local DB
   */
  ipcMain.handle('fb:getMessages', async (_event, params: {
    accountId: string; threadId: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      // Read in a worker (DatabaseService.getFBMessagesAsync): a slow disk does not freeze the whole app
      const messages = await DatabaseService.getInstance().getFBMessagesAsync(
        internalId, params.threadId, params.limit || 50, params.offset || 0
      );
      return { success: true, messages };
    } catch (err: any) {
      return { success: false, messages: [], error: err.message };
    }
  });

  /**
   * Mark as read (C5: sent to the Facebook server via the bridge)
   */
  ipcMain.handle('fb:markAsRead', async (_event, params: {
    accountId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      DatabaseService.getInstance().markFBThreadAsRead(internalId, params.threadId);

      // C5: Also send read receipt to Facebook server
      const service = FacebookConnectionManager.get(internalId);
      if (service) {
        service.markReadOnServer(params.threadId).catch(() => {});
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Rename a group
   */
  ipcMain.handle('fb:changeThreadName', async (_event, params: {
    accountId: string; threadId: string; name: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeThreadName(params.threadId, params.name);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Change a group's emoji
   */
  ipcMain.handle('fb:changeThreadEmoji', async (_event, params: {
    accountId: string; threadId: string; emoji: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeThreadEmoji(params.threadId, params.emoji);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Change a member's nickname
   */
  ipcMain.handle('fb:changeNickname', async (_event, params: {
    accountId: string; threadId: string; userId: string; nickname: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const ok = await service.changeNickname(params.threadId, params.userId, params.nickname);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Sign in with username/password
   */
  ipcMain.handle('fb:loginWithCredentials', async (_event, params: {
    username: string; password: string; twoFASecret?: string;
  }) => {
    try {
      const result = await loginWithCredentials(params.username, params.password, params.twoFASecret);
      return { success: !!result.success, result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── E2EE Handlers ──────────────────────────────────────────────────────

  /**
   * Send an E2EE message (1:1 encrypted)
   */
  ipcMain.handle('fb:sendE2EEMessage', async (_event, params: {
    accountId: string; chatJid: string; text: string; replyToId?: string; replyToSenderJid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      // Keep this endpoint on the same guarded route as fb:sendMessage. It
      // retries only a deterministic pre-flight "not connected" failure.
      const result = await service.sendE2EEMessage(
        params.chatJid,
        params.text,
        { replyToMessageId: params.replyToId || '' },
        params.replyToSenderJid || '',
      );

      // Save sent message to DB - strip @msgr JID from chatJid for consistency
      // with handleE2EEMessage (uses the stripped numeric ID as thread_id)
      if (result.success && result.messageId) {
        try {
          const strippedThreadId = params.chatJid ? params.chatJid.replace(/@.*$/, '') : params.chatJid;
          DatabaseService.getInstance().saveFBMessage({
            id: result.messageId,
            account_id: internalId,
            thread_id: strippedThreadId, // ← numeric ID, consistent with the receive path
            sender_id: resolveRealFacebookId(internalId, service),
            body: params.text,
            timestamp: result.timestamp || Date.now(),
            type: 'text',
            is_self: 1,
            is_unsent: 0,
            ...(params.replyToId ? { reply_to_id: params.replyToId } : {}),
          });
        } catch (dbErr: any) {
          Logger.warn(`[facebookIpc] fb:sendE2EEMessage DB save error: ${dbErr.message}`);
        }
      }

      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Check the E2EE bridge status
   */
  ipcMain.handle('fb:getE2EEStatus', async (_event, params: {
    accountId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = FacebookConnectionManager.get(internalId);
      if (!service) return { success: true, status: 'disconnected', available: false };

      return {
        success: true,
        status: service.getE2EEStatus(),
        connected: service.isE2EEConnected(),
        available: service.isE2EEAvailable(),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Turn the E2EE bridge on/off manually
   */
  ipcMain.handle('fb:toggleE2EE', async (_event, params: {
    accountId: string; enable: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      await service.setE2EEEnabled(params.enable);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Send typing indicator (C6)
   */
  ipcMain.handle('fb:sendTyping', async (_event, params: {
    accountId: string; threadId: string; isTyping: boolean; isGroup?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      await service.sendTyping(params.threadId, params.isTyping);
      return { success: true };
    } catch (err: any) {
      // Typing is best-effort - no error returned
      return { success: true };
    }
  });

  /**
   * Send seen/delivered receipt (C5)
   */
  ipcMain.handle('fb:sendSeen', async (_event, params: {
    accountId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };

      return await service.markReadOnServer(params.threadId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Forward a message (I2)
   */
  ipcMain.handle('fb:forwardMessage', async (_event, params: {
    accountId: string; messageId: string; targetThreadId: string; isGroup?: boolean;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      // Keep `undefined` distinct from false: an omitted target kind must be
      // resolved from fb_threads, never silently treated as a 1:1 conversation.
      const hasIsGroup = Object.prototype.hasOwnProperty.call(params, 'isGroup');
      const typeChat = hasIsGroup ? (params.isGroup ? null : 'user') : undefined;
      return await service.forwardMessage(params.messageId, params.targetThreadId, typeChat);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Pin a message (I3)
   */
  ipcMain.handle('fb:pinMessage', async (_event, params: {
    accountId: string; messageId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.pinMessage(params.messageId, params.threadId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Unpin a message (I3)
   */
  ipcMain.handle('fb:unpinMessage', async (_event, params: {
    accountId: string; messageId: string; threadId: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.unpinMessage(params.messageId, params.threadId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Create a poll (I6)
   */
  ipcMain.handle('fb:createPoll', async (_event, params: {
    accountId: string; threadId: string; question: string; options: string[];
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.createPoll(params.threadId, params.question, params.options);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Vote in a poll (I6)
   */
  ipcMain.handle('fb:votePoll', async (_event, params: {
    accountId: string; pollId: string; optionIds: string[];
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      return await service.votePoll(params.pollId, params.optionIds);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Sync Facebook messages over a time range (a popup like syncing from the Zalo phone app): runs in the background on the machine that holds
   * the Facebook connection, progress via event:fbHistorySync. accountId = facebook_id; fromTs/toTs in ms (null = no limit).
   */
  ipcMain.handle('fb:startHistorySync', async (_event, params: { accountId: string; fromTs?: number | null; toTs?: number | null }) => {
    try {
      if (!params?.accountId) return { success: false, error: tr('Thiếu tài khoản') };
      const internalId = resolveInternalId(params.accountId);
      return FacebookHistorySyncService.getInstance().start(
        String(params.accountId),
        { fromTs: params.fromTs ?? null, toTs: params.toTs ?? null },
        () => getFBServiceOrReconnect(internalId),
      );
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:startHistorySync error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fb:cancelHistorySync', async (_event, params: { accountId: string }) => {
    return FacebookHistorySyncService.getInstance().cancel(String(params?.accountId || ''));
  });

  ipcMain.handle('fb:getHistorySyncStatus', async (_event, params: { accountId: string }) => {
    return { success: true, status: FacebookHistorySyncService.getInstance().getStatus(String(params?.accountId || '')) };
  });

  /**
   * One page of messages older than the marker (beforeTimestampMs, beforeMessageId) of a conversation, via the bridge (LightSpeed
   * FetchMessagesTask): scroll up until all messages on the machine are loaded / open a conversation that has no messages yet. Saved to the DB like history. No bridge →
   * returns `code` so the renderer uses the old GraphQL path.
   */
  ipcMain.handle('fb:fetchOlderMessages', async (_event, params: {
    accountId: string; threadId: string; beforeTimestampMs?: number; beforeMessageId?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, code: 'NOT_CONNECTED', error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      // The user scrolls / opens a conversation: short pace, shares the budget with the account's background sync
      return await service.fetchHistoryPage(String(params.threadId || ''), {
        timestampMs: Number(params.beforeTimestampMs) || 0,
        messageId: String(params.beforeMessageId || ''),
      }, undefined, { mode: 'interactive' });
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:fetchOlderMessages error: ${err.message}`);
      return { success: false, code: 'FETCH', error: err.message };
    }
  });

  /**
   * Fetch history messages from the Facebook API (C7)
   * Unlike fb:getMessages (reads from the local DB), this one calls the GraphQL API
   * Automatically saves the fetched messages to the DB for offline use.
   */
  ipcMain.handle('fb:fetchThreadMessages', async (_event, params: {
    accountId: string; threadId: string; limit?: number; beforeCursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
      const result = await service.fetchThreadMessages(params.threadId, params.limit, params.beforeCursor);
      // Save messages to the DB for offline use (same rule as the GraphQL history fetch)
      if (result.success && result.messages?.length) {
        service.persistGraphQLHistory(params.threadId, result.messages);
        Logger.log(`[fb:fetchThreadMessages] Saved ${result.messages.length} messages to DB`);
      }
      return result;
    } catch (err: any) {
      return { success: false, messages: [], error: err.message };
    }
  });

  // ─── Scan Data Handlers ─────────────────────────────────────────────────

  /**
   * Scan Facebook group members
   */
  ipcMain.handle('fb:scanGroupMembers', async (_event, params: {
    accountId: string; groupId: string; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanGroupMembers(internalId, params.groupId, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Scan groups by keyword
   */
  ipcMain.handle('fb:scanGroupKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'group', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Scan fanpages by keyword
   */
  ipcMain.handle('fb:scanFanpageKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'page', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Scan post comments
   */
  ipcMain.handle('fb:scanPostComments', async (_event, params: {
    accountId: string; postId: string; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostComments(internalId, params.postId, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Scan posts by keyword
   */
  ipcMain.handle('fb:scanPostKeyword', async (_event, params: {
    accountId: string; keyword: string; cursor?: string | null; filters?: string[]; bsid?: string; tsid?: string;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanSearchComet(internalId, { keyword: params.keyword, type: 'post', cursor: params.cursor, filters: params.filters, bsid: params.bsid, tsid: params.tsid });
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Scan posts from the profile / fanpage / group timeline
   */
  ipcMain.handle('fb:scanPostTimeline', async (_event, params: {
    accountId: string; sourceId: string; sourceType: 'profile' | 'fanpage' | 'group'; cursor?: string | null;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostTimeline(internalId, params.sourceId, params.sourceType, params.cursor);
      return result;
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Reset scan cache (clear context + docId cache)
   */
  // ─── Batch Scan Handlers ─────────────────────────────────────────────

  /**
   * Scan members of several groups at once (batch)
   */
  ipcMain.handle('fb:scanGroupMembersBatch', async (_event, params: {
    accountId: string; groupIds: string[]; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanGroupMembersBatch(internalId, params.groupIds, params.threadCount || 5);
      return result;
    } catch (err: any) {
      return { success: false, items: [], errors: [err.message], error: err.message };
    }
  });

  /**
   * Scan comments on several posts at once (batch)
   */
  ipcMain.handle('fb:scanPostCommentsBatch', async (_event, params: {
    accountId: string; postIds: string[]; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      const result = await service.scanPostCommentsBatch(internalId, params.postIds, params.threadCount || 5);
      return result;
    } catch (err: any) {
      return { success: false, items: [], errors: [err.message], error: err.message };
    }
  });

  // ─── Scan Log Handlers ───────────────────────────────────────────────

  /**
   * Save 1 scan history entry
   */
  ipcMain.handle('fb:saveScanLog', async (_event, params: {
    accountId: string; tabId?: string; tabName?: string; scanType: string; input: string;
    status: 'success' | 'error'; itemsCount?: number;
    error?: string; requestPayload?: string;
    responsePreview?: string; requestHeaders?: string; responseHeaders?: string;
    docId?: string; threadCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanLogService } = require('../../../src/services/facebook/scan/FacebookScanLogService');
      FacebookScanLogService.init();
      const id = FacebookScanLogService.save({
        accountId: internalId,
        tabId: params.tabId || '',
        tabName: params.tabName || '',
        scanType: params.scanType,
        input: params.input,
        status: params.status,
        itemsCount: params.itemsCount || 0,
        error: params.error || '',
        requestPayload: params.requestPayload || '{}',
        responsePreview: params.responsePreview || '',
        requestHeaders: params.requestHeaders || '',
        responseHeaders: params.responseHeaders || '',
        docId: params.docId || '',
        threadCount: params.threadCount || 1,
        createdAt: Date.now(),
      });
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Get scan history
   */
  ipcMain.handle('fb:getScanLogs', async (_event, params: {
    accountId: string; tabId?: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanLogService } = require('../../../src/services/facebook/scan/FacebookScanLogService');
      const result = FacebookScanLogService.getList(internalId, params.tabId, params.limit || 50, params.offset || 0);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, logs: [], total: 0, error: err.message };
    }
  });

  ipcMain.handle('fb:scanResetCache', async () => {
    try {
      const { FacebookScanService } = require('../../../src/services/facebook/scan/FacebookScanService');
      const service = FacebookScanService.getInstance();
      service.clearCache();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Scan Tab Handlers ────────────────────────────────────────────────

  /**
   * Save / update a tab
   */
  ipcMain.handle('fb:scanSaveTab', async (_event, params: {
    id: string; accountId: string; name: string; scanType: string;
    config: string; status?: string; itemsCount?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      FacebookScanTabService.init();
      // Preserve original created_at if tab already exists
      const existing = FacebookScanTabService.getTab(params.id);
      const ok = FacebookScanTabService.saveTab({
        id: params.id,
        accountId: internalId,
        name: params.name,
        scanType: params.scanType,
        config: params.config,
        status: (params.status as any) || 'active',
        itemsCount: params.itemsCount || 0,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Get the list of tabs
   */
  ipcMain.handle('fb:scanGetTabs', async (_event, params: {
    accountId: string; status?: string; limit?: number; offset?: number;
  }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const result = FacebookScanTabService.getTabs(internalId, params.status as any, params.limit, params.offset);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, tabs: [], total: 0, error: err.message };
    }
  });

  /**
   * Get 1 tab
   */
  ipcMain.handle('fb:scanGetTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const tab = FacebookScanTabService.getTab(params.id);
      return { success: !!tab, tab };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Update the tab status (active/archived/deleted)
   */
  ipcMain.handle('fb:scanUpdateTabStatus', async (_event, params: { id: string; status: string }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const ok = FacebookScanTabService.updateTabStatus(params.id, params.status as any);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Permanently delete the tab + data + request logs
   */
  ipcMain.handle('fb:scanDeleteTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const ok = FacebookScanTabService.deleteTab(params.id);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Update updated_at for the tab (moves it to the top of the list)
   */
  ipcMain.handle('fb:scanTouchTab', async (_event, params: { id: string }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const ok = FacebookScanTabService.touchTab(params.id);
      return { success: ok };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Save the data for the tab
   */
  ipcMain.handle('fb:scanSaveTabData', async (_event, params: {
    tabId: string; items: any[]; pageInfo: { endCursor: string | null; hasNextPage: boolean };
  }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const id = FacebookScanTabService.saveTabData(params.tabId, params.items, params.pageInfo);
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Get the saved data for the tab (items + pageInfo from the latest scan)
   */
  ipcMain.handle('fb:scanGetTabData', async (_event, params: { tabId: string }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const rows = FacebookScanTabService.getTabData(params.tabId, 1);
      if (rows.length > 0) {
        const latest = rows[0];
        return {
          success: true,
          items: JSON.parse(latest.items || '[]'),
          pageInfo: JSON.parse(latest.page_info || '{}'),
        };
      }
      return { success: true, items: [], pageInfo: { endCursor: null, hasNextPage: false } };
    } catch (err: any) {
      return { success: false, items: [], pageInfo: { endCursor: null, hasNextPage: false }, error: err.message };
    }
  });

  /**
   * Save request logs for the tab
   */
  ipcMain.handle('fb:scanSaveRequestLog', async (_event, params: {
    tabId: string; requestPayload: string; responsePreview: string;
    requestHeaders?: string; responseHeaders?: string;
    status: string; error?: string; itemsCount?: number;
  }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const id = FacebookScanTabService.saveRequestLog(params.tabId, {
        requestPayload: params.requestPayload,
        responsePreview: params.responsePreview,
        status: params.status as any,
        error: params.error,
        itemsCount: params.itemsCount,
      });
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  /**
   * Get the request logs of the tab
   */
  ipcMain.handle('fb:scanGetRequestLogs', async (_event, params: { tabId: string; limit?: number; offset?: number }) => {
    try {
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const result = FacebookScanTabService.getRequestLogs(params.tabId, params.limit, params.offset);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, logs: [], total: 0, error: err.message };
    }
  });

  /**
   * Scan statistics
   */
  ipcMain.handle('fb:scanGetStats', async (_event, params: { accountId: string }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const { FacebookScanTabService } = require('../../../src/services/facebook/scan/FacebookScanTabService');
      const stats = FacebookScanTabService.getStats(internalId);
      return { success: true, ...stats };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  Logger.log('[facebookIpc] All handlers registered');
}

/**
 * Block a user (N4)
 */
ipcMain.handle('fb:blockUser', async (_event, params: {
  accountId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.blockUser(params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Unblock a user (N4)
 */
ipcMain.handle('fb:unblockUser', async (_event, params: {
  accountId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.unblockUser(params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Change the conversation theme (N1)
 */
ipcMain.handle('fb:changeThreadTheme', async (_event, params: {
  accountId: string; threadId: string; theme: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.changeThreadTheme(params.threadId, params.theme);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Create a Messenger Note (N2)
 */
ipcMain.handle('fb:createNote', async (_event, params: {
  accountId: string; text: string; privacy?: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.createNote(params.text, params.privacy);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ─── N3: Group Admin Operations ─────────────────────────────────────────────

/**
 * Add a group admin (N3)
 */
ipcMain.handle('fb:addGroupAdmin', async (_event, params: {
  accountId: string; threadId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.addGroupAdmin(params.threadId, params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Create a Messenger group (quick action next to the search box)
 */
ipcMain.handle('fb:createGroup', async (_event, params: {
  accountId: string; participants: string[]; name: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.createGroup(params.participants || [], params.name || '');
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Remove a group admin (N3)
 */
ipcMain.handle('fb:removeGroupAdmin', async (_event, params: {
  accountId: string; threadId: string; userId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.removeGroupAdmin(params.threadId, params.userId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Turn member approval on/off (N3)
 */
ipcMain.handle('fb:changeApprovalMode', async (_event, params: {
  accountId: string; threadId: string; approved: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.changeApprovalMode(params.threadId, params.approved);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Approve/reject a member (N3)
 */
ipcMain.handle('fb:approvePendingMember', async (_event, params: {
  accountId: string; threadId: string; userId: string; approve: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.approvePendingMember(params.threadId, params.userId, params.approve);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Get the group invite link (N3)
 */
ipcMain.handle('fb:getGroupLink', async (_event, params: {
  accountId: string; threadId: string;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.getGroupLink(params.threadId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Turn the group invite link on/off (N3)
 */
ipcMain.handle('fb:setGroupLink', async (_event, params: {
  accountId: string; threadId: string; enable: boolean;
}) => {
  try {
    const internalId = resolveInternalId(params.accountId);
    const service = await getFBServiceOrReconnect(internalId);
    if (!service) return { success: false, error: 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.' };
    return await service.setGroupLink(params.threadId, params.enable);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/**
 * Auto-reconnect all FB accounts when the app starts.
 * Uses exactly the same connection path as the dashboard. A socket status
 * flag alone is not enough here: startup must wait for the MQTT transport and
 * let the E2EE bridge initialize from its persisted device state.
 */
export async function reconnectAllFBAccounts(): Promise<void> {
  try {
    const accounts = DatabaseService.getInstance().getFBAccounts();
    Logger.log(`[facebookIpc] reconnectAllFBAccounts: ${accounts.length} FB accounts found`);
    for (const acc of accounts) {
      try {
        // Removed from the app (data kept): not reconnected automatically. Before, "Chỉ xoá tài khoản" (Delete account only) left the raw cookies
        // so the removed account silently reconnected every time the app opened and kept receiving / saving messages.
        if (isFacebookAccountRemoved(acc.facebook_id)) {
          Logger.log(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: removed from the app, skipping`);
          continue;
        }
        const existing = FacebookConnectionManager.get(acc.id);
        if (existing && (existing.isListenerActuallyConnected() || existing.isE2EEConnected())) {
          Logger.log(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: transport already ready, skipping`);
          continue;
        }
        await connectFacebookAccount(acc.id, 'startup');
        clearFacebookStartupRetry(acc.id);
      } catch (err: any) {
        Logger.warn(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: ${err.message}`);
        scheduleFacebookStartupRetry(acc.id, 0);
      }
    }
  } catch (err: any) {
    Logger.warn(`[facebookIpc] reconnectAllFBAccounts error: ${err.message}`);
  }
}
