/**
 * telegramMiniApp.ts: Mini Apps and login buttons of Telegram bots, the pure part shared by main + renderer.
 *
 * Works like a Telegram client (https://core.telegram.org/api/bots/webapps, /api/web-events, /api/url-authorization):
 *  - Mini Apps (web_app button in a message, bot menu button, the main "Mở" (Open) app) run RIGHT INSIDE the app: Telegram returns a link with the user's
 *    initData (tgWebAppData), so the Mini App knows who is using it without logging in again.
 *  - Login button (keyboardButtonUrlAuth): asks the user, then messages.acceptUrlAuth, and opens the Telegram link that comes back (already containing
 *    the login signature) in the machine's browser; if the user declines, the original link is opened.
 *  - Normal link button: opens in the machine's browser, as in Telegram.
 */

/** tgWebAppPlatform: Deplao is a desktop app, so the Mini App is handled like Telegram Desktop. */
export const MINI_APP_PLATFORM = 'tdesktop';

export const MINI_APP_THEME_KEYS = [
  'bg_color', 'secondary_bg_color', 'text_color', 'hint_color', 'link_color', 'button_color', 'button_text_color',
  'header_bg_color', 'bottom_bar_bg_color', 'accent_text_color', 'section_bg_color', 'section_header_text_color',
  'section_separator_color', 'subtitle_text_color', 'destructive_text_color',
] as const;

export type MiniAppThemeKey = typeof MINI_APP_THEME_KEYS[number];
export type MiniAppThemeParams = Partial<Record<MiniAppThemeKey, string>>;

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/** Theme sent to Telegram (renderer → main): only known keys, colours in #RRGGBB. */
export function sanitizeMiniAppTheme(raw: unknown): MiniAppThemeParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: MiniAppThemeParams = {};
  for (const key of MINI_APP_THEME_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (isHexColor(value)) out[key] = value.toLowerCase();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Bot-specific methods that the Mini App calls through Telegram (CloudStorage: getStorageValues, saveStorageValue…). */
export const MINI_APP_METHOD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Parameters of one call (JSON): CloudStorage allows up to 4 KB per value, with a generous margin. */
export const MINI_APP_PARAMS_MAX_CHARS = 64 * 1024;

/** Valid custom method parameters: a JSON object that is not too large. Returns a JSON string to send to Telegram, null if invalid. */
export function miniAppParamsJson(params: unknown): string | null {
  if (params === undefined || params === null) return '{}';
  if (typeof params !== 'object' || Array.isArray(params)) return null;
  let json: string;
  try { json = JSON.stringify(params); } catch { return null; }
  return json.length <= MINI_APP_PARAMS_MAX_CHARS ? json : null;
}

/** The result of messages.requestUrlAuth / acceptUrlAuth has been changed to plain data. */
export type UrlAuthInfo =
  | {
    kind: 'request';
    /** Page that will log in, e.g. comments.app */
    domain: string;
    botId: string;
    botName: string;
    botUsername?: string;
    /** Page asking for the bot to message the user */
    requestWriteAccess: boolean;
    /** Page asking for a phone number */
    requestPhoneNumber: boolean;
  }
  | { kind: 'accepted'; url: string | null }
  | { kind: 'default' };

/**
 * urlAuthResultRequest / Accepted / Default (GramJS) → plain data. The bot's login button does not use match codes
 * (match_codes, only present in the OAuth flow): if one shows up, open the original link, do not log in.
 */
export function urlAuthInfo(result: any): UrlAuthInfo {
  const kind = String(result?.className || '');
  if (kind === 'UrlAuthResultAccepted') {
    return { kind: 'accepted', url: typeof result.url === 'string' && result.url ? result.url : null };
  }
  if (kind === 'UrlAuthResultRequest' && typeof result.domain === 'string' && result.domain && !result.matchCodes?.length) {
    const bot = result.bot || {};
    const username = typeof bot.username === 'string' && bot.username ? bot.username : '';
    const name = [bot.firstName, bot.lastName].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
    return {
      kind: 'request',
      domain: result.domain,
      botId: bot.id != null ? String(bot.id) : '',
      botName: name || (username ? `@${username}` : 'Bot'),
      ...(username ? { botUsername: username } : {}),
      requestWriteAccess: !!result.requestWriteAccess,
      requestPhoneNumber: !!result.requestPhoneNumber,
    };
  }
  return { kind: 'default' };
}
