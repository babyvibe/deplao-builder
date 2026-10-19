/**
 * Câu hiển thị cho tin hệ thống Telegram (MessageService) khi lưu từ lịch sử / tải thêm — dòng thông báo ở giữa khung
 * chat như Telegram ("Channel created", "Group photo changed"…). Đường socket (handleServiceMessage) có tên thành viên
 * chi tiết hơn; ở đây không tra mạng nên dùng câu chung. '' = không hiển thị (hành động không cần báo / chưa hỗ trợ).
 * Thuần, test ở src/__tests__/telegram/TelegramServiceText.test.ts.
 */

const pad2 = (value: number) => String(value).padStart(2, '0');

function durationText(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} giây`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(total % 60)}` : `${minutes} phút`;
}

function ttlText(seconds: number): string {
  const days = Math.round(Number(seconds) / 86400);
  if (days >= 365) return '1 năm';
  if (days >= 28 && days <= 31) return '1 tháng';
  if (days === 7) return '1 tuần';
  if (days >= 1) return `${days} ngày`;
  const hours = Math.round(Number(seconds) / 3600);
  return hours >= 1 ? `${hours} giờ` : `${Math.max(1, Math.round(Number(seconds) / 60))} phút`;
}

/**
 * `isChannel`: tin trong kênh phát tin (MessageService.post) — "kênh" thay cho "nhóm".
 */
export function describeTelegramServiceAction(message: any): string {
  const action = message?.action;
  const className = String(action?.className || '');
  const isChannel = message?.post === true;
  const noun = isChannel ? 'kênh' : 'nhóm';
  const title = String(action?.title || '').trim();
  switch (className) {
    case 'MessageActionChannelCreate':
      return title ? `Đã tạo ${noun} “${title}”` : `Đã tạo ${noun}`;
    case 'MessageActionChatCreate':
      return title ? `Đã tạo nhóm “${title}”` : 'Đã tạo nhóm';
    case 'MessageActionChatEditTitle':
      return title ? `Tên ${noun} đã đổi thành “${title}”` : `Tên ${noun} đã được đổi`;
    case 'MessageActionChatEditPhoto':
      return `Ảnh ${noun} đã được thay đổi`;
    case 'MessageActionChatDeletePhoto':
      return `Ảnh ${noun} đã bị xoá`;
    case 'MessageActionChatAddUser': {
      const count = Array.isArray(action?.users) ? action.users.length : 0;
      return count > 1 ? `${count} thành viên đã được thêm vào nhóm` : 'Thành viên mới đã được thêm vào nhóm';
    }
    case 'MessageActionChatJoinedByLink':
      return 'Thành viên tham gia qua link mời';
    case 'MessageActionChatJoinedByRequest':
      return 'Thành viên được duyệt tham gia nhóm';
    case 'MessageActionChatDeleteUser':
      return 'Thành viên đã rời nhóm';
    case 'MessageActionPinMessage':
      return 'Tin nhắn đã được ghim';
    case 'MessageActionChatMigrateTo':
    case 'MessageActionChannelMigrateFrom':
      return 'Nhóm đã được nâng cấp thành siêu nhóm';
    case 'MessageActionHistoryClear':
      return 'Lịch sử trò chuyện đã được xoá';
    case 'MessageActionSetMessagesTTL': {
      const period = Number(action?.period || 0);
      return period > 0 ? `Tin nhắn mới sẽ tự xoá sau ${ttlText(period)}` : 'Đã tắt tự xoá tin nhắn';
    }
    case 'MessageActionGroupCall': {
      const duration = Number(action?.duration || 0);
      const kind = isChannel ? 'Phát trực tiếp' : 'Cuộc gọi nhóm';
      return duration > 0 ? `${kind} đã kết thúc (${durationText(duration)})` : `${kind} đã bắt đầu`;
    }
    case 'MessageActionGroupCallScheduled':
      return isChannel ? 'Đã lên lịch phát trực tiếp' : 'Đã lên lịch cuộc gọi nhóm';
    case 'MessageActionInviteToGroupCall':
      return 'Mời tham gia cuộc gọi nhóm';
    case 'MessageActionTopicCreate':
      return title ? `Đã tạo chủ đề “${title}”` : 'Đã tạo chủ đề mới';
    case 'MessageActionTopicEdit':
      return title ? `Chủ đề đã đổi tên thành “${title}”` : 'Chủ đề đã được chỉnh sửa';
    case 'MessageActionContactSignUp':
      return 'Đã tham gia Telegram';
    case 'MessageActionScreenshotTaken':
      return 'Đã chụp màn hình cuộc trò chuyện';
    case 'MessageActionCustomAction':
      return String(action?.message || '').trim();
    default:
      return '';
  }
}
