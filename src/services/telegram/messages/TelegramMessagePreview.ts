import { telegramCallPreviewFromContent } from '../../../shared/telegram/telegramQuickModel';
import { tr } from '../../../shared/i18n';

/**
 * Text used outside the message detail (conversation rows, notifications and
 * workflow/webhook payloads). A caption remains the message content, but must
 * never make a media message look like a plain-text message.
 */
export function getTelegramMessagePreview(msgType: string, content?: string): string {
  switch (String(msgType || 'text').toLowerCase()) {
    // Call card (messageActionPhoneCall, same format as the Zalo call card)
    case 'chat.recommended': return telegramCallPreviewFromContent(content) || tr('📞 Cuộc gọi');
    case 'photo': return tr('🖼️ Hình ảnh');
    case 'video': return '🎬 Video';
    case 'video_note': return tr('🎥 Video tròn');
    case 'audio': return tr('🎵 Tin nhắn thoại');
    case 'voice': return tr('🎤 Tin nhắn thoại');
    case 'sticker': return tr('🎨 Nhãn dán');
    case 'file':
    case 'document': return tr('📎 Tệp đính kèm');
    case 'telegram.contact': return tr('👤 Liên hệ');
    case 'telegram.location': return tr('📍 Vị trí');
    case 'telegram.venue': return tr('📍 Địa điểm');
    case 'telegram.poll': return tr('📊 Bình chọn');
    case 'telegram.dice': return tr('🎲 Xúc xắc');
    case 'telegram.game': return tr('🎮 Trò chơi');
    case 'telegram.invoice': return tr('🧾 Hóa đơn');
    case 'telegram.story': return '📖 Tin';
    case 'telegram.giveaway': return '🎁 Giveaway';
    case 'telegram.webpage': return tr('🔗 Liên kết');
    // Checklist: the first line is the title
    case 'telegram.todo': return `☑️ ${String(content || '').split('\n')[0].trim() || tr('Danh sách việc cần làm')}`;
    case 'telegram.livestream': return tr('📡 Phát trực tiếp');
    default: return String(content || '').trim();
  }
}
