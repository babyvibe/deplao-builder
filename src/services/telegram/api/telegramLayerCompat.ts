/**
 * Compatibility between GramJS's original schema (layer 198) and the new layer Deplao loads (telegramApiLayer.ts): the places where Telegram changed
 * the structure that Deplao reads / sends. Every function works with BOTH layers (DEPLAO_TELEGRAM_LAYER=198; tests use the original GramJS).
 */

/**
 * "Community" (layer 22x): `Community` / `CommunityForbidden` in `chats`, `DialogCommunity` (no `peer`) in
 * `dialogs`. GramJS 2.26 calls getPeerId on every chat / dialog when iterating the conversation list (iterDialogs) → throws "Cannot
 * cast Community…" and the whole load fails; Deplao code also treats every chat as a group / channel. Deplao does not support communities yet, so they are removed
 * from the results before GramJS / Deplao read them (the groups / channels inside a community are still separate conversations).
 */
import { tr } from '../../../shared/i18n';

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
  // messages.ChatInviteJoinResultOk wraps `updates` (Updates has chats)
  if (container.updates && !Array.isArray(container.updates)) stripInPlace(container.updates, depth + 1);
}

/** Remove communities from the RPC result (edits in place, returns the same result). */
export function stripUnsupportedTelegramPeers<T>(result: T): T {
  stripInPlace(result, 0);
  return result;
}

export interface InlineButtonInfo {
  text: string;
  /** url_auth = the "đăng nhập bằng Telegram" (log in with Telegram) button (keyboardButtonUrlAuth): messages.requestUrlAuth needs a buttonId. */
  type: 'url' | 'url_auth' | 'webview' | 'callback';
  url?: string;
  buttonId?: number;
}

/**
 * Inline buttons of a message: layer 198 = KeyboardButtonUrl / KeyboardButtonWebView / KeyboardButtonCallback…; layer 23x =
 * KeyboardInlineButton { text, type: InlineButtonTypeUrl / WebView / Callback / UrlAuth / Copy … }.
 */
export function inlineButtonInfo(button: any): InlineButtonInfo {
  const text = String(button?.text || '');
  const kind = String(button?.className || '');
  const type = button?.type && typeof button.type === 'object' ? button.type : null;
  const typeKind = String(type?.className || '');
  if (kind === 'KeyboardButtonUrlAuth' || typeKind === 'InlineButtonTypeUrlAuth') {
    const url = String(button?.url || type?.url || '');
    const buttonId = Number(button?.buttonId ?? type?.buttonId);
    return Number.isInteger(buttonId) ? { text, type: 'url_auth', url, buttonId } : { text, type: 'url', url };
  }
  if (kind === 'KeyboardButtonUrl' || typeKind === 'InlineButtonTypeUrl') {
    return { text, type: 'url', url: String(button?.url || type?.url || '') };
  }
  if (kind === 'KeyboardButtonWebView' || kind === 'KeyboardButtonSimpleWebView' || typeKind === 'InlineButtonTypeWebView') {
    return { text, type: 'webview', url: String(button?.url || type?.url || '') };
  }
  // Callback and other buttons (games, buy, switch inline, copy…): show the text only
  return { text: text || kind, type: 'callback' };
}

/**
 * Result of joining a group (messages.importChatInvite / channels.joinChannel): layer 198 = Updates; layer 23x =
 * messages.ChatInviteJoinResultOk { updates } or messages.ChatInviteJoinResultWebView (a group that requires verification through a bot:
 * must be opened in the Telegram app, Deplao cannot open the bot's page).
 */
export function chatInviteJoinOutcome(result: any): { kind: 'joined'; updates: any } | { kind: 'bot_verification' } {
  const kind = String(result?.className || '');
  if (kind.endsWith('ChatInviteJoinResultWebView')) return { kind: 'bot_verification' };
  if (kind.endsWith('ChatInviteJoinResultOk')) return { kind: 'joined', updates: result.updates };
  return { kind: 'joined', updates: result };
}

export const TELEGRAM_BOT_VERIFICATION_ERROR =
  tr('Nhóm này yêu cầu xác minh qua bot trước khi tham gia — hãy tham gia bằng app Telegram rồi Deplao sẽ tự cập nhật.');
