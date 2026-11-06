/**
 * Cầu sự kiện Mini App Telegram ↔ Deplao (phần thuần). Mini App chạy trong iframe như Telegram Web: SDK chính thức
 * (telegram-web-app.js) thấy mình ở trong iframe thì gửi window.parent.postMessage(JSON.stringify({ eventType, eventData }),
 * '*') và nhận sự kiện của client cũng bằng postMessage cùng dạng.
 * Danh sách sự kiện: https://core.telegram.org/api/web-events (Mini App → client), https://core.telegram.org/api/bots/webapps
 * (client → Mini App).
 */
import {
  MINI_APP_METHOD_RE, isHexColor, miniAppParamsJson, type MiniAppThemeParams,
} from '../../../../shared/telegram/telegramMiniApp';

export interface MiniAppEvent {
  eventType: string;
  eventData: any;
}

const MAX_EVENT_CHARS = 256 * 1024;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Tin postMessage của Mini App → sự kiện; null nếu không phải dạng của SDK Telegram. */
export function parseMiniAppEvent(data: unknown): MiniAppEvent | null {
  let raw: any = data;
  if (typeof data === 'string') {
    if (data.length > MAX_EVENT_CHARS) return null;
    try { raw = JSON.parse(data); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const eventType = raw.eventType;
  if (typeof eventType !== 'string' || !EVENT_TYPE_RE.test(eventType)) return null;
  return { eventType, eventData: raw.eventData ?? null };
}

/** Theme của Deplao (biến --dp-* của pluginTheme) → theme_params của Telegram. */
export function miniAppThemeFromVars(vars: Record<string, string>): MiniAppThemeParams {
  const pick = (name: string): string | undefined => (isHexColor(vars[name]) ? vars[name].toLowerCase() : undefined);
  const theme: MiniAppThemeParams = {
    bg_color: pick('--dp-surface'),
    secondary_bg_color: pick('--dp-bg'),
    text_color: pick('--dp-text'),
    hint_color: pick('--dp-text-muted'),
    link_color: pick('--dp-accent'),
    button_color: pick('--dp-accent'),
    button_text_color: pick('--dp-accent-text'),
    header_bg_color: pick('--dp-surface'),
    bottom_bar_bg_color: pick('--dp-surface'),
    accent_text_color: pick('--dp-accent'),
    section_bg_color: pick('--dp-surface'),
    section_header_text_color: pick('--dp-accent'),
    section_separator_color: pick('--dp-border'),
    subtitle_text_color: pick('--dp-text-muted'),
    destructive_text_color: pick('--dp-danger'),
  };
  for (const key of Object.keys(theme) as Array<keyof MiniAppThemeParams>) {
    if (!theme[key]) delete theme[key];
  }
  return theme;
}

export interface MiniAppButton {
  visible: boolean;
  active: boolean;
  text: string;
  color?: string;
  textColor?: string;
  progress: boolean;
  shine: boolean;
  /** Nút phụ: vị trí so với nút chính. */
  position: 'left' | 'right' | 'top' | 'bottom';
}

export const HIDDEN_MINI_APP_BUTTON: MiniAppButton = Object.freeze({
  visible: false, active: true, text: '', progress: false, shine: false, position: 'left',
});

const BUTTON_POSITIONS = ['left', 'right', 'top', 'bottom'] as const;

/** web_app_setup_main_button / web_app_setup_secondary_button → trạng thái nút (chữ rỗng = ẩn). */
export function miniAppButton(data: any): MiniAppButton {
  const text = typeof data?.text === 'string' ? data.text.trim().slice(0, 64) : '';
  const position = BUTTON_POSITIONS.includes(data?.position) ? data.position : 'left';
  return {
    visible: data?.is_visible === true && !!text,
    active: data?.is_active !== false,
    text,
    ...(isHexColor(data?.color) ? { color: data.color } : {}),
    ...(isHexColor(data?.text_color) ? { textColor: data.text_color } : {}),
    progress: data?.is_progress_visible === true,
    shine: data?.has_shine_effect === true,
    position,
  };
}

export type MiniAppPopupButtonType = 'ok' | 'close' | 'cancel' | 'default' | 'destructive';

export interface MiniAppPopup {
  title?: string;
  message: string;
  buttons: Array<{ id: string; type: MiniAppPopupButtonType; text: string }>;
}

const POPUP_BUTTON_TYPES: readonly MiniAppPopupButtonType[] = ['ok', 'close', 'cancel', 'default', 'destructive'];
const POPUP_DEFAULT_TEXT: Partial<Record<MiniAppPopupButtonType, string>> = { ok: 'OK', close: 'Đóng', cancel: 'Huỷ' };

/** web_app_open_popup → popup hợp lệ (tiêu đề ≤ 64, nội dung 1-256 ký tự, 1-3 nút id khác nhau); null nếu sai. */
export function miniAppPopup(data: any): MiniAppPopup | null {
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  if (!message || message.length > 256) return null;
  const title = typeof data?.title === 'string' ? data.title.trim() : '';
  if (title.length > 64) return null;
  const raw: any[] = Array.isArray(data?.buttons) ? data.buttons : [];
  if (raw.length < 1 || raw.length > 3) return null;
  const ids = new Set<string>();
  const buttons: MiniAppPopup['buttons'] = [];
  for (const item of raw) {
    const type: MiniAppPopupButtonType = item?.type ?? 'default';
    if (!POPUP_BUTTON_TYPES.includes(type)) return null;
    const id = typeof item?.id === 'string' ? item.id : '';
    if (id.length > 64 || ids.has(id)) return null;
    ids.add(id);
    const text = typeof item?.text === 'string' && item.text.trim() ? item.text.trim().slice(0, 64) : POPUP_DEFAULT_TEXT[type];
    if (!text) return null;
    buttons.push({ id, type, text });
  }
  return { ...(title ? { title } : {}), message, buttons };
}

/** web_app_set_header_color: color_key (bg_color / secondary_bg_color của theme) hoặc color #RRGGBB. */
export function miniAppHeaderColor(data: any, theme: MiniAppThemeParams): string | null {
  if (isHexColor(data?.color)) return data.color;
  if (data?.color_key === 'bg_color') return theme.bg_color ?? null;
  if (data?.color_key === 'secondary_bg_color') return theme.secondary_bg_color ?? null;
  return null;
}

/** web_app_set_background_color / web_app_set_bottom_bar_color: #RRGGBB. */
export function miniAppColor(data: any): string | null {
  return isHexColor(data?.color) ? data.color : null;
}

/** Chữ đen / trắng đọc được trên nền #RRGGBB (đầu Mini App đổi màu). */
export function textColorOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150 ? '#000000' : '#ffffff';
}

/** web_app_open_link: chỉ http / https (mở bằng trình duyệt của máy, Mini App vẫn mở). */
export function miniAppLinkUrl(data: any): string | null {
  const raw = typeof data?.url === 'string' ? data.url : '';
  if (!raw || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** web_app_open_tg_link: path_full của link t.me ("/" + đường dẫn + query) → https://t.me…; null nếu sai. */
export function miniAppTgLink(data: any): string | null {
  const path = typeof data?.path_full === 'string' ? data.path_full : '';
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 2048) return null;
  try {
    const url = new URL(path, 'https://t.me');
    return url.host === 't.me' ? url.href : null;
  } catch {
    return null;
  }
}

/** Giới hạn số lần trong một khoảng (mở link: 1 lần / 1 s như Telegram; popup: 3 lần / 3 s). */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): () => boolean {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] >= windowMs) hits.shift();
    if (hits.length >= limit) return false;
    hits.push(t);
    return true;
  };
}

export interface MiniAppCustomCall {
  reqId: string;
  method: string;
  params: Record<string, unknown>;
}

/** web_app_invoke_custom_method (CloudStorage…) → lời gọi hợp lệ; null nếu sai. */
export function miniAppCustomCall(data: any): MiniAppCustomCall | null {
  const reqId = typeof data?.req_id === 'string' && data.req_id.length <= 128 ? data.req_id : '';
  const method = typeof data?.method === 'string' ? data.method : '';
  if (!reqId || !MINI_APP_METHOD_RE.test(method)) return null;
  const params = data?.params ?? {};
  if (miniAppParamsJson(params) === null) return null;
  return { reqId, method, params };
}

/**
 * Sự kiện Deplao chưa hỗ trợ mà Mini App chờ trả lời: trả "không hỗ trợ" ngay để Mini App không treo (toàn màn hình,
 * sinh trắc, quét QR, thanh toán, vị trí, bộ nhớ trên máy…). Đọc clipboard: Telegram chỉ cho bot ở menu đính kèm.
 */
export function unsupportedReply(event: MiniAppEvent): MiniAppEvent | null {
  const data = event.eventData && typeof event.eventData === 'object' ? event.eventData : {};
  const reqId = typeof data.req_id === 'string' ? data.req_id : '';
  const reply = (eventType: string, eventData: unknown): MiniAppEvent => ({ eventType, eventData });
  switch (event.eventType) {
    case 'web_app_request_fullscreen': return reply('fullscreen_failed', { error: 'UNSUPPORTED' });
    case 'web_app_check_home_screen': return reply('home_screen_checked', { status: 'unsupported' });
    case 'web_app_add_to_home_screen': return reply('home_screen_failed', { error: 'UNSUPPORTED' });
    case 'web_app_biometry_get_info':
    case 'web_app_biometry_request_access': return reply('biometry_info_received', { available: false });
    case 'web_app_biometry_request_auth': return reply('biometry_auth_requested', { status: 'failed' });
    case 'web_app_biometry_update_token': return reply('biometry_token_updated', { status: 'failed' });
    case 'web_app_open_scan_qr_popup': return reply('scan_qr_popup_closed', {});
    case 'web_app_read_text_from_clipboard': return reqId ? reply('clipboard_text_received', { req_id: reqId }) : null;
    case 'web_app_open_invoice':
      return reply('invoice_closed', { slug: typeof data.slug === 'string' ? data.slug : '', status: 'failed' });
    case 'web_app_set_emoji_status': return reply('emoji_status_failed', { error: 'UNSUPPORTED' });
    case 'web_app_request_emoji_status_access': return reply('emoji_status_access_requested', { status: 'cancelled' });
    case 'web_app_check_location': return reply('location_checked', { available: false });
    case 'web_app_request_location': return reply('location_requested', { available: false });
    case 'web_app_request_file_download': return reply('file_download_requested', { status: 'cancelled' });
    case 'web_app_send_prepared_message': return reply('prepared_message_failed', { error: 'UNSUPPORTED' });
    case 'web_app_start_accelerometer': return reply('accelerometer_failed', { error: 'UNSUPPORTED' });
    case 'web_app_start_gyroscope': return reply('gyroscope_failed', { error: 'UNSUPPORTED' });
    case 'web_app_start_device_orientation': return reply('device_orientation_failed', { error: 'UNSUPPORTED' });
    case 'web_app_device_storage_save_key':
    case 'web_app_device_storage_get_key':
    case 'web_app_device_storage_clear':
      return reqId ? reply('device_storage_failed', { req_id: reqId, error: 'UNSUPPORTED' }) : null;
    case 'web_app_secure_storage_save_key':
    case 'web_app_secure_storage_get_key':
    case 'web_app_secure_storage_restore_key':
    case 'web_app_secure_storage_clear':
      return reqId ? reply('secure_storage_failed', { req_id: reqId, error: 'UNSUPPORTED' }) : null;
    default: return null;
  }
}

/** Mép an toàn (safe_area_changed / content_safe_area_changed): khung trong app không bị che. */
export const MINI_APP_ZERO_INSETS = Object.freeze({ top: 0, bottom: 0, left: 0, right: 0 });
