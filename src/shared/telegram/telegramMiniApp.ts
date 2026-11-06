/**
 * telegramMiniApp.ts: Mini App và nút đăng nhập của bot Telegram, phần thuần dùng chung main + renderer.
 *
 * Làm như client Telegram (https://core.telegram.org/api/bots/webapps, /api/web-events, /api/url-authorization):
 *  - Mini App (nút web_app trong tin, nút menu bot, "Mở" app chính) chạy NGAY TRONG app: Telegram trả link có initData
 *    của người dùng (tgWebAppData) nên Mini App tự biết ai đang dùng, không cần đăng nhập lại.
 *  - Nút đăng nhập (keyboardButtonUrlAuth): hỏi người dùng rồi messages.acceptUrlAuth, mở link Telegram trả về (đã kèm
 *    chữ ký đăng nhập) bằng trình duyệt của máy; không đồng ý thì mở link gốc.
 *  - Nút link thường: mở bằng trình duyệt của máy như Telegram.
 */

/** tgWebAppPlatform: Deplao là app máy tính, Mini App xử lý như Telegram Desktop. */
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

/** Theme gửi cho Telegram (renderer → main): chỉ khoá đã biết, màu #RRGGBB. */
export function sanitizeMiniAppTheme(raw: unknown): MiniAppThemeParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: MiniAppThemeParams = {};
  for (const key of MINI_APP_THEME_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (isHexColor(value)) out[key] = value.toLowerCase();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Phương thức riêng của bot mà Mini App gọi qua Telegram (CloudStorage: getStorageValues, saveStorageValue…). */
export const MINI_APP_METHOD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Tham số của một lần gọi (JSON): CloudStorage tối đa 4 KB / giá trị, chừa rộng. */
export const MINI_APP_PARAMS_MAX_CHARS = 64 * 1024;

/** Tham số phương thức riêng hợp lệ: object JSON không quá lớn. Trả chuỗi JSON để gửi Telegram, null nếu sai. */
export function miniAppParamsJson(params: unknown): string | null {
  if (params === undefined || params === null) return '{}';
  if (typeof params !== 'object' || Array.isArray(params)) return null;
  let json: string;
  try { json = JSON.stringify(params); } catch { return null; }
  return json.length <= MINI_APP_PARAMS_MAX_CHARS ? json : null;
}

/** Kết quả messages.requestUrlAuth / acceptUrlAuth đã đổi sang dữ liệu thuần. */
export type UrlAuthInfo =
  | {
    kind: 'request';
    /** Trang sẽ đăng nhập, vd comments.app */
    domain: string;
    botId: string;
    botName: string;
    botUsername?: string;
    /** Trang xin cho bot nhắn tin cho người dùng */
    requestWriteAccess: boolean;
    /** Trang xin số điện thoại */
    requestPhoneNumber: boolean;
  }
  | { kind: 'accepted'; url: string | null }
  | { kind: 'default' };

/**
 * urlAuthResultRequest / Accepted / Default (GramJS) → dữ liệu thuần. Nút đăng nhập của bot không dùng mã khớp
 * (match_codes, chỉ có ở luồng OAuth): gặp thì mở link gốc, không đăng nhập.
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
