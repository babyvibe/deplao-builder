/**
 * telegramForward.ts: the "Chuyển tiếp từ …" (Forwarded from …) card of a Telegram message (MessageFwdHeader).
 * Stored in attachments (type telegram_forward) like the other display info: no DB schema change, passes through the employee's REST /
 * realtime intact. Renderer: getTelegramForwardMeta (ui/lib/media/mediaResolver).
 */
import { getPeerId } from 'telegram/Utils';

export type TelegramForwardSource = 'user' | 'channel' | 'chat' | 'hidden';

/** Display name of a GramJS User / Channel / Chat. */
export function telegramEntityName(entity: any): string {
  if (!entity) return '';
  const title = String(entity.title || '').trim();
  if (title) return title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || (entity.username ? `@${entity.username}` : '');
}

/**
 * fwdFrom → the forward card. The original sender / channel name comes from `message.forward` (GramJS Forward: the entity is already in the update
 * / history + cache, NO network call); an account that hides itself when forwarding only has `fromName`. No fwdFrom → null.
 */
export function getTelegramForwardAttachment(message: any): Record<string, any> | null {
  const header = message?.fwdFrom;
  if (!header || typeof header !== 'object') return null;
  const fromPeer = header.fromId;
  const source: TelegramForwardSource = !fromPeer ? 'hidden'
    : fromPeer.className === 'PeerUser' ? 'user'
      : fromPeer.className === 'PeerChannel' ? 'channel'
        : 'chat';
  let fromId = '';
  if (fromPeer) {
    try { fromId = String(getPeerId(fromPeer)); } catch { fromId = ''; }
  }
  let entity: any;
  try { entity = message?.forward?.sender || message?.forward?.chat; } catch { entity = undefined; }
  const date = Number(header.date);
  return {
    type: 'telegram_forward',
    from_type: source,
    from_id: fromId,
    from_name: telegramEntityName(entity) || String(header.fromName || '').trim(),
    from_username: String(entity?.username || ''),
    post_author: String(header.postAuthor || '').trim(),
    channel_post_id: header.channelPost != null ? String(header.channelPost) : '',
    date: Number.isFinite(date) && date > 0 ? date * 1000 : 0,
  };
}
