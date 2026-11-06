/**
 * telegramLinks.ts: link Telegram (t.me, telegram.me, <tên>.t.me, tg://) → việc cần làm trong app, theo
 * https://core.telegram.org/api/links. Phần thuần: bấm link trong tin, thẻ link, nút bot, Mini App (web_app_open_tg_link)
 * đều đi qua đây (lib/chat/links/chatLinks).
 *
 * Hỗ trợ: tên công khai (người, bot, nhóm, kênh; kèm ?start, ?startapp, ?text), link tin (t.me/<tên>/<id>,
 * t.me/c/<kênh>/<id>), link mời (t.me/+…, joinchat), số điện thoại (t.me/+84…), Mini App theo tên (t.me/<bot>/<app>),
 * bộ sticker / emoji, chia sẻ (t.me/share/url?url=…&text=…: chọn hội thoại rồi điền sẵn ô soạn tin). Link khác (proxy,
 * boost, hoá đơn…) → null: mở trang web như trước.
 */

export type TelegramLink =
  | {
    kind: 'username';
    username: string;
    /** Link tin: t.me/<tên>/<id> hoặc t.me/<tên>/<chủ đề>/<id> */
    post?: number;
    thread?: number;
    /** Bình luận của bài kênh: id tin trong nhóm thảo luận */
    comment?: number;
    /** Link bot: ?start=<tham số> (rỗng = chỉ ?start) */
    start?: string;
    /** Mini App: ?startapp[=<tham số>]; có appName = Mini App theo tên của bot */
    startApp?: string;
    appName?: string;
    /** ?text=… chữ điền sẵn */
    text?: string;
  }
  | { kind: 'invite'; hash: string }
  | { kind: 'private_post'; channelId: string; post: number; thread?: number }
  | { kind: 'phone'; phone: string; text?: string }
  | { kind: 'stickers'; slug: string; emoji: boolean }
  /** Chia sẻ: chọn hội thoại, điền URL (dòng đầu) + chữ vào ô soạn tin. */
  | { kind: 'share'; url: string; text?: string };

/** Tên Telegram: 5-32 ký tự, chữ / số / gạch dưới, bắt đầu bằng chữ. */
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
/** Tên ngắn Mini App của bot (inputBotAppShortName). */
const APP_NAME_RE = /^[a-zA-Z0-9_]{3,64}$/;
/** start: tối đa 64 ký tự base64url; startapp tối đa 512. */
const START_RE = /^[A-Za-z0-9_-]{0,64}$/;
const START_APP_RE = /^[A-Za-z0-9_-]{0,512}$/;
const SET_SLUG_RE = /^[A-Za-z0-9_]{1,64}$/;
const POSITIVE_INT_RE = /^\d{1,10}$/;

const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);
/** Đường dẫn t.me không phải tên (đã xử lý riêng hoặc mở trang web). */
const RESERVED = new Set([
  'joinchat', 'addstickers', 'addemoji', 'share', 'proxy', 'socks', 'login', 'iv', 'setlanguage', 'c', 'boost',
  'addlist', 'm', 'invoice', 'bg', 'addtheme', 'confirmphone', 'giftcode', 'contact', 'nft', 'stars', 'premium',
]);

/** ?url=&text= của link chia sẻ; thiếu url → null. */
function shareLink(params: URLSearchParams): TelegramLink | null {
  const url = (params.get('url') || '').trim().slice(0, 2048);
  if (!url) return null;
  const text = (params.get('text') || '').trim().slice(0, 4096);
  return { kind: 'share', url, ...(text ? { text } : {}) };
}

function phoneLink(phone: string, params: URLSearchParams): TelegramLink {
  const text = params.get('text');
  return { kind: 'phone', phone, ...(text ? { text: text.slice(0, 4096) } : {}) };
}

function withScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

function positiveInt(value: string | null | undefined): number | undefined {
  if (!value || !POSITIVE_INT_RE.test(value)) return undefined;
  const n = Number(value);
  return n > 0 && n <= 0x7fffffff ? n : undefined;
}

/** ?start=x → 'x'; ?start (không giá trị) → ''; sai định dạng / không có → undefined. */
function param(params: URLSearchParams, name: string, re: RegExp): string | undefined {
  if (!params.has(name)) return undefined;
  const value = params.get(name) || '';
  return re.test(value) ? value : undefined;
}

function usernameLink(
  username: string,
  extra: string[],
  params: URLSearchParams,
): TelegramLink | null {
  if (!USERNAME_RE.test(username)) return null;
  const link: Extract<TelegramLink, { kind: 'username' }> = { kind: 'username', username };
  // /<tên>/<id> · /<tên>/<chủ đề>/<id> · /<bot>/<tên app>
  if (extra.length >= 2 && positiveInt(extra[0]) && positiveInt(extra[1])) {
    link.thread = positiveInt(extra[0]);
    link.post = positiveInt(extra[1]);
  } else if (extra.length >= 1 && positiveInt(extra[0])) {
    link.post = positiveInt(extra[0]);
  } else if (extra.length >= 1 && APP_NAME_RE.test(extra[0])) {
    link.appName = extra[0];
  }
  const post = positiveInt(params.get('post'));
  if (post) link.post = post;
  const thread = positiveInt(params.get('thread'));
  if (thread) link.thread = thread;
  const comment = positiveInt(params.get('comment'));
  if (comment) link.comment = comment;
  const appName = params.get('appname');
  if (appName && APP_NAME_RE.test(appName)) link.appName = appName;
  const start = param(params, 'start', START_RE);
  if (start !== undefined) link.start = start;
  const startApp = param(params, 'startapp', START_APP_RE);
  if (startApp !== undefined) link.startApp = startApp;
  const text = params.get('text');
  if (text) link.text = text.slice(0, 4096);
  return link;
}

/** Link có phải của Telegram (để không mở nhầm trang web khi app xử lý được). */
export function isTelegramUrl(raw: string): boolean {
  try {
    const url = new URL(withScheme(String(raw || '').trim()));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.protocol === 'tg:' || TELEGRAM_HOSTS.has(host) || host.endsWith('.t.me');
  } catch {
    return false;
  }
}

export function parseTelegramLink(input: string): TelegramLink | null {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 8192) return null;
  let url: URL;
  try { url = new URL(withScheme(raw)); } catch { return null; }
  const params = url.searchParams;

  if (url.protocol === 'tg:') {
    const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
    if (action === 'resolve') {
      const phone = params.get('phone') || '';
      if (/^\d{5,15}$/.test(phone)) return phoneLink(phone, params);
      return usernameLink(params.get('domain') || '', [], params);
    }
    if (action === 'msg_url') return shareLink(params);
    if (action === 'join') {
      const hash = params.get('invite') || '';
      return /^[A-Za-z0-9_-]{1,64}$/.test(hash) ? { kind: 'invite', hash } : null;
    }
    if (action === 'privatepost') {
      const channelId = params.get('channel') || '';
      const post = positiveInt(params.get('post'));
      if (!/^\d{1,20}$/.test(channelId) || !post) return null;
      const thread = positiveInt(params.get('thread'));
      return { kind: 'private_post', channelId, post, ...(thread ? { thread } : {}) };
    }
    if (action === 'addstickers' || action === 'addemoji') {
      const slug = params.get('set') || '';
      return SET_SLUG_RE.test(slug) ? { kind: 'stickers', slug, emoji: action === 'addemoji' } : null;
    }
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (host.endsWith('.t.me') && !TELEGRAM_HOSTS.has(host)) {
    // <tên>.t.me/… = t.me/<tên>/…
    parts = [host.slice(0, -'.t.me'.length), ...parts];
  } else if (!TELEGRAM_HOSTS.has(host)) {
    return null;
  }
  const first = parts[0] || '';
  const lower = first.toLowerCase();

  if (first.startsWith('+') && first.length > 1) {
    const rest = first.slice(1);
    if (/^\d{5,15}$/.test(rest)) return phoneLink(rest, params);
    return /^[A-Za-z0-9_-]{1,64}$/.test(rest) ? { kind: 'invite', hash: rest } : null;
  }
  // t.me/share?url= · t.me/share/url?url= · t.me/msg/url?url=
  if ((lower === 'share' && (!parts[1] || parts[1].toLowerCase() === 'url')) || (lower === 'msg' && parts[1]?.toLowerCase() === 'url')) {
    return shareLink(params);
  }
  if (lower === 'joinchat') {
    return parts[1] && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1]) ? { kind: 'invite', hash: parts[1] } : null;
  }
  if (lower === 'c') {
    const channelId = parts[1] || '';
    if (!/^\d{1,20}$/.test(channelId)) return null;
    const a = positiveInt(parts[2]);
    const b = positiveInt(parts[3]);
    if (!a) return null;
    const thread = b ? a : positiveInt(params.get('thread'));
    const post = b || a;
    return { kind: 'private_post', channelId, post, ...(thread ? { thread } : {}) };
  }
  if (lower === 'addstickers' || lower === 'addemoji') {
    return parts[1] && SET_SLUG_RE.test(parts[1]) ? { kind: 'stickers', slug: parts[1], emoji: lower === 'addemoji' } : null;
  }
  if (lower === 's' && parts[1]) return usernameLink(parts[1], parts.slice(2), params);
  if (!first || RESERVED.has(lower)) return null;
  return usernameLink(first, parts.slice(1), params);
}
