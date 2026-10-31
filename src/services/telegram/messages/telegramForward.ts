/**
 * telegramForward.ts — thẻ "Chuyển tiếp từ …" của tin Telegram (MessageFwdHeader).
 * Lưu trong attachments (type telegram_forward) như các thông tin trình bày khác: không đổi schema DB, đi qua REST /
 * realtime của nhân viên nguyên vẹn. Renderer: getTelegramForwardMeta (ui/lib/media/mediaResolver).
 */
import { getPeerId } from 'telegram/Utils';

export type TelegramForwardSource = 'user' | 'channel' | 'chat' | 'hidden';

/** Tên hiển thị của User / Channel / Chat GramJS. */
export function telegramEntityName(entity: any): string {
  if (!entity) return '';
  const title = String(entity.title || '').trim();
  if (title) return title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  return name || (entity.username ? `@${entity.username}` : '');
}

/**
 * fwdFrom → thẻ chuyển tiếp. Tên người gửi / kênh gốc lấy từ `message.forward` (GramJS Forward: entity có sẵn trong update
 * / lịch sử + cache, KHÔNG gọi mạng); người ẩn tài khoản khi chuyển tiếp chỉ có `fromName`. Không có fwdFrom → null.
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
