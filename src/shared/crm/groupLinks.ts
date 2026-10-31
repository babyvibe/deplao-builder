/**
 * Group / profile links pasted in "Tham gia nhóm bằng link" (main process + renderer).
 *   Zalo:     https://zalo.me/g/<code>
 *   Telegram: https://t.me/+<hash>, t.me/joinchat/<hash>, tg://join?invite=<hash>  → private invite
 *             https://t.me/<username>, @username, tg://resolve?domain=<username>     → public group / channel
 *   Facebook: https://m.me/j/<code>, messenger.com/join/<code>                        → recognised, joining is not supported
 */

export type GroupLinkTarget =
  | { channel: 'zalo'; link: string }
  | { channel: 'telegram'; kind: 'invite'; hash: string }
  | { channel: 'telegram'; kind: 'public'; username: string }
  | { channel: 'facebook'; link: string };

/** Telegram usernames: 5–32 chars, letters / digits / underscore, starting with a letter. */
const TELEGRAM_USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
/** Paths of t.me that are not usernames. */
const TELEGRAM_RESERVED = new Set(['joinchat', 'addstickers', 'addemoji', 'share', 'proxy', 'socks', 'login', 'iv', 'setlanguage', 'c', 's', 'boost', 'addlist', 'm', 'invoice']);

function withScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

export function parseGroupLink(input: string): GroupLinkTarget | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // @username (Telegram public group / channel)
  if (raw.startsWith('@')) {
    const username = raw.slice(1);
    return TELEGRAM_USERNAME.test(username) ? { channel: 'telegram', kind: 'public', username } : null;
  }

  let url: URL;
  try {
    url = new URL(withScheme(raw));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.protocol === 'tg:') {
    // tg://join?invite=HASH, tg://resolve?domain=username
    const kind = (url.hostname || parts[0] || '').toLowerCase();
    if (kind === 'join') {
      const hash = url.searchParams.get('invite') || '';
      return hash ? { channel: 'telegram', kind: 'invite', hash } : null;
    }
    if (kind === 'resolve') {
      const username = url.searchParams.get('domain') || '';
      return TELEGRAM_USERNAME.test(username) ? { channel: 'telegram', kind: 'public', username } : null;
    }
    return null;
  }

  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
    const first = parts[0] || '';
    if (first.startsWith('+') && first.length > 1) return { channel: 'telegram', kind: 'invite', hash: first.slice(1) };
    if (first.toLowerCase() === 'joinchat' && parts[1]) return { channel: 'telegram', kind: 'invite', hash: parts[1] };
    if (first && !TELEGRAM_RESERVED.has(first.toLowerCase()) && TELEGRAM_USERNAME.test(first)) {
      return { channel: 'telegram', kind: 'public', username: first };
    }
    return null;
  }

  if (host === 'zalo.me' && parts[0] === 'g' && parts[1]) {
    return { channel: 'zalo', link: `https://zalo.me/g/${parts[1]}` };
  }

  if ((host === 'm.me' && parts[0] === 'j' && parts[1]) || ((host === 'messenger.com' || host === 'facebook.com') && parts[0] === 'join' && parts[1])) {
    return { channel: 'facebook', link: url.toString() };
  }
  return null;
}

/** Which account channels can open a parsed link. */
export function groupLinkAccountChannels(target: GroupLinkTarget | null): string[] {
  if (!target) return [];
  if (target.channel === 'zalo') return ['zalo'];
  if (target.channel === 'telegram') return ['telegram_user'];
  return [];
}
