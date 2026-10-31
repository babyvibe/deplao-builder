/**
 * Tương thích giữa schema gốc của GramJS (layer 198) và layer mới Deplao nạp (telegramApiLayer.ts): các chỗ Telegram đổi
 * cấu trúc mà Deplao đọc / gửi. Mọi hàm chạy được với CẢ HAI layer (DEPLAO_TELEGRAM_LAYER=198, test dùng GramJS gốc).
 */

/**
 * "Cộng đồng" (layer 22x): `Community` / `CommunityForbidden` trong `chats`, `DialogCommunity` (không có `peer`) trong
 * `dialogs`. GramJS 2.26 gọi getPeerId với mọi chat / dialog khi duyệt danh sách hội thoại (iterDialogs) → ném "Cannot
 * cast Community…" và cả lượt tải hỏng; mã Deplao cũng coi mọi chat là nhóm / kênh. Deplao chưa hỗ trợ cộng đồng → bỏ
 * khỏi kết quả RPC trước khi GramJS / Deplao đọc (các nhóm / kênh bên trong cộng đồng vẫn là hội thoại riêng).
 */
const UNSUPPORTED_CHAT_CLASSES = new Set(['Community', 'CommunityForbidden']);
const UNSUPPORTED_DIALOG_CLASSES = new Set(['DialogCommunity']);

function stripInPlace(container: any, depth: number): void {
  if (!container || typeof container !== 'object' || depth > 2) return;
  if (Array.isArray(container.chats) && container.chats.some((chat: any) => UNSUPPORTED_CHAT_CLASSES.has(chat?.className))) {
    container.chats = container.chats.filter((chat: any) => !UNSUPPORTED_CHAT_CLASSES.has(chat?.className));
  }
  if (Array.isArray(container.dialogs) && container.dialogs.some((dialog: any) => UNSUPPORTED_DIALOG_CLASSES.has(dialog?.className))) {
    container.dialogs = container.dialogs.filter((dialog: any) => !UNSUPPORTED_DIALOG_CLASSES.has(dialog?.className));
  }
  // messages.ChatInviteJoinResultOk bọc `updates` (Updates có chats)
  if (container.updates && !Array.isArray(container.updates)) stripInPlace(container.updates, depth + 1);
}

/** Bỏ cộng đồng khỏi kết quả RPC (sửa tại chỗ, trả lại chính kết quả). */
export function stripUnsupportedTelegramPeers<T>(result: T): T {
  stripInPlace(result, 0);
  return result;
}

export interface InlineButtonInfo {
  text: string;
  type: 'url' | 'webview' | 'callback';
  url?: string;
}

/**
 * Nút inline của tin: layer 198 = KeyboardButtonUrl / KeyboardButtonWebView / KeyboardButtonCallback…; layer 23x =
 * KeyboardInlineButton { text, type: InlineButtonTypeUrl / WebView / Callback / UrlAuth / Copy … }.
 */
export function inlineButtonInfo(button: any): InlineButtonInfo {
  const text = String(button?.text || '');
  const kind = String(button?.className || '');
  const type = button?.type && typeof button.type === 'object' ? button.type : null;
  const typeKind = String(type?.className || '');
  if (kind === 'KeyboardButtonUrl' || kind === 'KeyboardButtonUrlAuth' || typeKind === 'InlineButtonTypeUrl' || typeKind === 'InlineButtonTypeUrlAuth') {
    return { text, type: 'url', url: String(button?.url || type?.url || '') };
  }
  if (kind === 'KeyboardButtonWebView' || kind === 'KeyboardButtonSimpleWebView' || typeKind === 'InlineButtonTypeWebView') {
    return { text, type: 'webview', url: String(button?.url || type?.url || '') };
  }
  // Callback và các nút khác (trò chơi, mua, chuyển inline, sao chép…): chỉ hiện chữ
  return { text: text || kind, type: 'callback' };
}

/**
 * Kết quả tham gia nhóm (messages.importChatInvite / channels.joinChannel): layer 198 = Updates; layer 23x =
 * messages.ChatInviteJoinResultOk { updates } hoặc messages.ChatInviteJoinResultWebView (nhóm bắt xác minh qua bot —
 * phải mở bằng app Telegram, Deplao không mở được trang của bot).
 */
export function chatInviteJoinOutcome(result: any): { kind: 'joined'; updates: any } | { kind: 'bot_verification' } {
  const kind = String(result?.className || '');
  if (kind.endsWith('ChatInviteJoinResultWebView')) return { kind: 'bot_verification' };
  if (kind.endsWith('ChatInviteJoinResultOk')) return { kind: 'joined', updates: result.updates };
  return { kind: 'joined', updates: result };
}

export const TELEGRAM_BOT_VERIFICATION_ERROR =
  'Nhóm này yêu cầu xác minh qua bot trước khi tham gia — hãy tham gia bằng app Telegram rồi Deplao sẽ tự cập nhật.';
