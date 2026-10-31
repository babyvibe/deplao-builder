/**
 * Telegram: nguồn của tin chuyển tiếp ("Chuyển tiếp từ <nguồn>"): tên lưu kèm tin; không có thì tra liên hệ / thành
 * viên nhóm; tin của chính mình → "Bạn". Kênh khác: telegramForward = null.
 */
import { getTelegramForwardMeta } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { MessageRowContext } from '../../rows/rowContext';

export function resolveTelegramForward(
  { activeAccountId, getContact, getGroupMember }: Pick<MessageRowContext, 'activeAccountId' | 'getContact' | 'getGroupMember'>,
  msg: any,
) {
  const telegramForward = getTelegramForwardMeta(msg);
  const forwardKnown = telegramForward?.fromId ? (getContact(telegramForward.fromId) || getGroupMember(telegramForward.fromId)) as any : null;
  const forwardKnownName = String(forwardKnown?.alias || forwardKnown?.display_name || forwardKnown?.displayName || '');
  const forwardName = !telegramForward ? ''
    : telegramForward.fromId && telegramForward.fromId === activeAccountId ? 'Bạn'
    : telegramForward.fromName
      || (forwardKnownName && forwardKnownName !== telegramForward.fromId ? forwardKnownName : '')
      || (telegramForward.fromUsername ? `@${telegramForward.fromUsername}` : '')
      || (telegramForward.fromType === 'channel' ? 'Kênh Telegram' : telegramForward.fromType === 'chat' ? 'Nhóm Telegram' : 'Người dùng Telegram');
  const forwardAvatar = telegramForward ? toLocalMediaUrl(forwardKnown?.avatar_url || forwardKnown?.avatar || '') : '';
  return { telegramForward, forwardName, forwardAvatar };
}
