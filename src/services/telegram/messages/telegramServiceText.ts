/**
 * Display text for a Telegram system message (MessageService) when saved from history / load more: a notice line in the middle of the chat
 * window, as in Telegram ("Channel created", "Group photo changed"…). The socket path (handleServiceMessage) has more detailed member names;
 * here no network lookup is made, so a generic sentence is used. '' = not displayed (the action needs no notice / is not supported yet).
 * Pure function; tests in src/__tests__/telegram/TelegramServiceText.test.ts.
 */

import { tr } from '../../../shared/i18n';

const pad2 = (value: number) => String(value).padStart(2, '0');

function durationText(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return tr('{{total}} giây', { total });
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(total % 60)}` : tr('{{minutes}} phút', { minutes });
}

function ttlText(seconds: number): string {
  const days = Math.round(Number(seconds) / 86400);
  if (days >= 365) return tr('1 năm');
  if (days >= 28 && days <= 31) return tr('1 tháng');
  if (days === 7) return tr('1 tuần');
  if (days >= 1) return tr('{{days}} ngày', { days });
  const hours = Math.round(Number(seconds) / 3600);
  return hours >= 1 ? tr('{{hours}} giờ', { hours }) : tr('{{v1}} phút', { v1: Math.max(1, Math.round(Number(seconds) / 60)) });
}

/**
 * `isChannel`: message in a broadcast channel (MessageService.post): "kênh" (channel) instead of "nhóm" (group).
 */
export function describeTelegramServiceAction(message: any): string {
  const action = message?.action;
  const className = String(action?.className || '');
  const isChannel = message?.post === true;
  const noun = isChannel ? tr('kênh') : tr('nhóm');
  const title = String(action?.title || '').trim();
  switch (className) {
    case 'MessageActionChannelCreate':
      return title ? tr('Đã tạo {{noun}} “{{title}}”', { noun, title }) : tr('Đã tạo {{noun}}', { noun });
    case 'MessageActionChatCreate':
      return title ? tr('Đã tạo nhóm “{{title}}”', { title }) : tr('Đã tạo nhóm');
    case 'MessageActionChatEditTitle':
      return title ? tr('Tên {{noun}} đã đổi thành “{{title}}”', { noun, title }) : tr('Tên {{noun}} đã được đổi', { noun });
    case 'MessageActionChatEditPhoto':
      return tr('Ảnh {{noun}} đã được thay đổi', { noun });
    case 'MessageActionChatDeletePhoto':
      return tr('Ảnh {{noun}} đã bị xoá', { noun });
    case 'MessageActionChatAddUser': {
      const count = Array.isArray(action?.users) ? action.users.length : 0;
      return count > 1 ? tr('{{count}} thành viên đã được thêm vào nhóm', { count }) : tr('Thành viên mới đã được thêm vào nhóm');
    }
    case 'MessageActionChatJoinedByLink':
      return tr('Thành viên tham gia qua link mời');
    case 'MessageActionChatJoinedByRequest':
      return tr('Thành viên được duyệt tham gia nhóm');
    case 'MessageActionChatDeleteUser':
      return tr('Thành viên đã rời nhóm');
    case 'MessageActionPinMessage':
      return 'Tin nhắn đã được ghim';
    case 'MessageActionChatMigrateTo':
    case 'MessageActionChannelMigrateFrom':
      return tr('Nhóm đã được nâng cấp thành siêu nhóm');
    case 'MessageActionHistoryClear':
      return tr('Lịch sử trò chuyện đã được xoá');
    case 'MessageActionSetMessagesTTL': {
      const period = Number(action?.period || 0);
      return period > 0 ? tr('Tin nhắn mới sẽ tự xoá sau {{v1}}', { v1: ttlText(period) }) : tr('Đã tắt tự xoá tin nhắn');
    }
    case 'MessageActionGroupCall': {
      const duration = Number(action?.duration || 0);
      const kind = isChannel ? tr('Phát trực tiếp') : tr('Cuộc gọi nhóm');
      return duration > 0 ? tr('{{kind}} đã kết thúc ({{v1}})', { kind, v1: durationText(duration) }) : tr('{{kind}} đã bắt đầu', { kind });
    }
    case 'MessageActionGroupCallScheduled':
      return isChannel ? tr('Đã lên lịch phát trực tiếp') : tr('Đã lên lịch cuộc gọi nhóm');
    case 'MessageActionInviteToGroupCall':
      return tr('Mời tham gia cuộc gọi nhóm');
    case 'MessageActionTopicCreate':
      return title ? tr('Đã tạo chủ đề “{{title}}”', { title }) : tr('Đã tạo chủ đề mới');
    case 'MessageActionTopicEdit':
      return title ? tr('Chủ đề đã đổi tên thành “{{title}}”', { title }) : tr('Chủ đề đã được chỉnh sửa');
    case 'MessageActionContactSignUp':
      return tr('Đã tham gia Telegram');
    case 'MessageActionScreenshotTaken':
      return tr('Đã chụp màn hình cuộc trò chuyện');
    case 'MessageActionCustomAction':
      return String(action?.message || '').trim();
    default:
      return '';
  }
}
