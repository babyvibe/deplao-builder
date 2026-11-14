/**
 * Telegram: source of a forwarded message ("Chuyển tiếp từ <nguồn>" (Forwarded from <source>)): the name is stored with the message; if missing, look up the contact or
 * group member; a message from yourself → "Bạn" (You). Other channels: telegramForward = null.
 */
import { getTelegramForwardMeta } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { MessageRowContext } from '../../rows/rowContext';
import { tr } from '../../../../../../shared/i18n';

export function resolveTelegramForward(
  { activeAccountId, getContact, getGroupMember }: Pick<MessageRowContext, 'activeAccountId' | 'getContact' | 'getGroupMember'>,
  msg: any,
) {
  const telegramForward = getTelegramForwardMeta(msg);
  const forwardKnown = telegramForward?.fromId ? (getContact(telegramForward.fromId) || getGroupMember(telegramForward.fromId)) as any : null;
  const forwardKnownName = String(forwardKnown?.alias || forwardKnown?.display_name || forwardKnown?.displayName || '');
  const forwardName = !telegramForward ? ''
    : telegramForward.fromId && telegramForward.fromId === activeAccountId ? tr('Bạn')
    : telegramForward.fromName
      || (forwardKnownName && forwardKnownName !== telegramForward.fromId ? forwardKnownName : '')
      || (telegramForward.fromUsername ? `@${telegramForward.fromUsername}` : '')
      || (telegramForward.fromType === 'channel' ? tr('Kênh Telegram') : telegramForward.fromType === 'chat' ? tr('Nhóm Telegram') : tr('Người dùng Telegram'));
  const forwardAvatar = telegramForward ? toLocalMediaUrl(forwardKnown?.avatar_url || forwardKnown?.avatar || '') : '';
  return { telegramForward, forwardName, forwardAvatar };
}
