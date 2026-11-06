/**
 * Bấm link trong app (tin nhắn, thẻ link, nút bot, Mini App), như Zalo / Telegram:
 *  - Link nhóm Zalo (zalo.me/g/…): đã ở trong nhóm → mở hội thoại; chưa → xem trước rồi "Tham gia".
 *  - Link Telegram (shared/telegram/telegramLinks, https://core.telegram.org/api/links): người / bot → mở chat (link bot
 *    ?start → hỏi "Bắt đầu"), nhóm / kênh đã tham gia → mở (link tin → nhảy tới tin; nhóm forum → đúng chủ đề), chưa →
 *    xem trước + "Tham gia"; link mời, số điện thoại, Mini App (?startapp, t.me/<bot>/<app>) mở trong app, bộ sticker mở
 *    popup sticker; ?text= điền sẵn ô soạn tin; link chia sẻ (t.me/share) → chọn hội thoại rồi điền sẵn ô soạn tin.
 *  - Nút bot: Mini App, đăng nhập, link như trên; callback / trò chơi / sao chép / mở hồ sơ → main đọc lại nút từ tin
 *    (pressInlineButton) rồi làm như Telegram (câu trả lời của bot hiện thành thông báo hoặc hộp, link mở như trên).
 *  - Còn lại (và khi không có tài khoản cùng kênh): trình duyệt của máy.
 * Tài khoản: tài khoản của hội thoại / Mini App đang dùng nếu cùng kênh, rồi tài khoản đang mở, rồi tài khoản đầu tiên
 * (chỉ tài khoản được thấy, chế độ nhân viên chỉ tài khoản được giao).
 */
import React from 'react';
import ipc, { buildZaloAuth } from '../../ipc';
import { useAccountStore, type AccountInfo } from '../../../store/accounts/accountStore';
import { useAppStore } from '../../../store/app/appStore';
import { useChatStore } from '../../../store/chat/chatStore';
import { visibleAccountsNow } from '../../../hooks/accounts/useVisibleAccounts';
import { openConversation, type OpenConversationRequest } from '../conversations/openConversation';
import { openTelegramMiniApp, openTelegramUrlAuth } from '../telegram/telegramMiniApp';
import { openTelegramStickerSet } from '../telegram/telegramStickerStore';
import { openExternalLink } from './externalLink';
import { parseGroupLink } from '../../../../shared/crm/groupLinks';
import { parseTelegramLink, type TelegramLink } from '../../../../shared/telegram/telegramLinks';
import { FORUM_GENERAL_TOPIC_ID, forumTopicHasId, type ForumTopicRow } from '../../../../shared/telegram/forumTopics';
import { setChatLinkOpener } from '../messages/messageParser';

export interface ChatLinkContext {
  /** Tài khoản của hội thoại / Mini App nơi bấm link. */
  accountId?: string;
}

// ── Hộp mở từ link (ChatLinkHost ở App): tham gia nhóm, "Bắt đầu" bot, chia sẻ tới hội thoại, hộp của bot ──

export interface GroupJoinRequest {
  key: number;
  link: string;
  accountId: string;
}

export interface BotStartRequest {
  key: number;
  accountId: string;
  botId: string;
  botName?: string;
  startParam: string;
}

export interface ShareRequest {
  key: number;
  /** Chữ điền vào ô soạn tin của hội thoại được chọn (URL dòng đầu, rồi lời nhắn). */
  text: string;
  /** Tài khoản nơi bấm link: chọn sẵn trong hộp. */
  accountId?: string;
}

export interface BotAlertRequest {
  key: number;
  title: string;
  message: string;
}

interface State {
  join: GroupJoinRequest | null;
  botStart: BotStartRequest | null;
  share: ShareRequest | null;
  botAlert: BotAlertRequest | null;
}

let state: State = { join: null, botStart: null, share: null, botAlert: null };
let seq = 0;
const listeners = new Set<() => void>();

function update(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openGroupJoinDialog(request: Omit<GroupJoinRequest, 'key'>): void {
  update({ join: { ...request, key: ++seq } });
}

export function closeGroupJoinDialog(): void {
  update({ join: null });
}

export function useGroupJoinRequest(): GroupJoinRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.join, () => state.join);
}

export function requestBotStart(request: Omit<BotStartRequest, 'key'>): void {
  update({ botStart: { ...request, key: ++seq } });
}

export function closeBotStart(): void {
  update({ botStart: null });
}

export function useBotStartRequest(): BotStartRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.botStart, () => state.botStart);
}

export function openShareDialog(request: Omit<ShareRequest, 'key'>): void {
  update({ share: { ...request, key: ++seq } });
}

export function closeShareDialog(): void {
  update({ share: null });
}

export function useShareRequest(): ShareRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.share, () => state.share);
}

export function showBotAlert(request: Omit<BotAlertRequest, 'key'>): void {
  update({ botAlert: { ...request, key: ++seq } });
}

export function closeBotAlert(): void {
  update({ botAlert: null });
}

export function useBotAlertRequest(): BotAlertRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.botAlert, () => state.botAlert);
}

// ── Chọn tài khoản, mở hội thoại, điền sẵn ô soạn tin ──

function notify(message: string, type: 'error' | 'warning' | 'info' | 'success' = 'error'): void {
  useAppStore.getState().showNotification(message, type);
}

/** Tài khoản mở link: tài khoản nơi bấm (cùng kênh) → tài khoản đang mở → tài khoản đang kết nối đầu tiên. */
export function pickLinkAccount(channel: 'zalo' | 'telegram_user', preferredId?: string): AccountInfo | null {
  const sameChannel = visibleAccountsNow().filter((account) => (account.channel || 'zalo') === channel);
  const connected = sameChannel.filter((account) => account.isConnected !== false);
  for (const id of [preferredId, useAccountStore.getState().activeAccountId]) {
    const hit = id ? connected.find((account) => account.zalo_id === id) : undefined;
    if (hit) return hit;
  }
  return connected[0] || sameChannel[0] || null;
}

/** Hội thoại đã có trong máy (đang hiện trong danh sách hoặc trong DB); null nếu chưa có. */
async function localConversation(accountId: string, threadId: string): Promise<{ is_forum?: number | null } | null> {
  const known = (useChatStore.getState().contacts[accountId] || []).find((contact) => contact.contact_id === threadId);
  if (known) return known as { is_forum?: number | null };
  try {
    const res = await ipc.db?.getContactsFiltered({ zaloId: accountId, contactIds: [threadId], limit: 1 });
    return res?.contacts?.find((contact: any) => String(contact?.contact_id) === threadId) || null;
  } catch {
    return null;
  }
}

function openThread(accountId: string, threadId: string, threadType: 0 | 1, info?: OpenConversationRequest['info']): void {
  openConversation({ accountId, threadId, threadType, ...(info ? { info } : {}) });
}

/** Mở hội thoại rồi nhảy tới tin (ChatWindow chờ hội thoại tải xong mới nhảy). */
function jumpToMessage(accountId: string, threadId: string, messageId: number): void {
  window.dispatchEvent(new CustomEvent('chat:jumpToMessage', { detail: { accountId, threadId, messageId: String(messageId) } }));
}

/**
 * Điền sẵn ô soạn tin (link ?text=, link chia sẻ), như Telegram: chỉ điền, không gửi. Hội thoại đang mở → chèn vào ô
 * soạn tin; chưa mở → lưu làm tin nháp (nối sau nháp đang có), mở hội thoại là thấy. Gọi TRƯỚC khi mở hội thoại.
 */
export function prefillComposer(accountId: string, threadId: string, text: string): void {
  let value = String(text || '').slice(0, 4096);
  if (!value.trim() || !accountId || !threadId) return;
  // Bắt đầu bằng @ → thêm khoảng trắng để không gọi bot inline (https://core.telegram.org/api/links)
  if (value.startsWith('@')) value = ` ${value}`;
  const chat = useChatStore.getState();
  if (useAccountStore.getState().activeAccountId === accountId && chat.activeThreadId === threadId) {
    window.dispatchEvent(new CustomEvent('composer:insertText', { detail: { text: value } }));
    return;
  }
  const existing = chat.drafts[`${accountId}_${threadId}`] || '';
  chat.setDraft(accountId, threadId, existing ? `${existing}\n${value}` : value);
}

// ── Zalo ──

async function openZaloGroupLink(link: string, raw: string, ctx: ChatLinkContext): Promise<void> {
  const account = pickLinkAccount('zalo', ctx.accountId);
  if (!account) {
    openExternalLink(raw);
    return;
  }
  try {
    const res: any = await ipc.zalo?.getGroupLinkInfo({ auth: buildZaloAuth(account, account.zalo_id), link, memberPage: 1 });
    const data = res?.success ? res.response : null;
    const groupId = data?.groupId ? String(data.groupId) : '';
    if (groupId && await localConversation(account.zalo_id, groupId)) {
      openThread(account.zalo_id, groupId, 1, { display_name: data.name, avatar_url: data.fullAvt || data.avt, channel: 'zalo' });
      return;
    }
  } catch { /* xem trước lỗi: hộp tham gia báo lỗi cụ thể */ }
  openGroupJoinDialog({ link, accountId: account.zalo_id });
}

// ── Telegram ──

/** Nhóm / kênh qua link mời hoặc tên: đã tham gia → mở; chưa → hộp xem trước + "Tham gia". */
async function openTelegramGroupLink(link: string, accountId: string): Promise<void> {
  try {
    const res = await ipc.telegramUser?.previewJoinLink({ accountId, link });
    if (res?.success && res.alreadyMember && res.chatId) {
      openThread(accountId, String(res.chatId), 1, { display_name: res.title, channel: 'telegram_user' });
      return;
    }
  } catch { /* hộp tham gia báo lỗi cụ thể */ }
  openGroupJoinDialog({ link, accountId });
}

/**
 * Link tin trong nhóm forum: mở đúng chủ đề (link có chủ đề; link tới tin tạo chủ đề; tin 1 = General) rồi nhảy tới tin
 * (https://core.telegram.org/api/links#message-links). Không biết chủ đề → mở nhóm và nhảy tới tin.
 */
async function openForumPost(accountId: string, chatId: string, post: number | undefined, thread: number | undefined,
  info: OpenConversationRequest['info']): Promise<void> {
  openThread(accountId, chatId, 1, info);
  let topics = (useChatStore.getState().forumTopics[`${accountId}_${chatId}`] || []) as ForumTopicRow[];
  if (!topics.length) {
    try {
      const res = await ipc.telegramUser?.getForumTopics({ accountId, chatId });
      topics = res?.success ? (res.topics || []) as ForumTopicRow[] : [];
    } catch { /* không có danh sách chủ đề: vẫn mở theo id trong link */ }
  }
  const topicId = thread
    ? String(thread)
    : post && topics.some((topic) => forumTopicHasId(topic, String(post)))
      ? String(post)
      : post === 1 ? FORUM_GENERAL_TOPIC_ID : '';
  if (!topicId) {
    if (post) jumpToMessage(accountId, chatId, post);
    return;
  }
  const topic = topics.find((item) => forumTopicHasId(item, topicId));
  // Sau khi danh sách hội thoại mở nhóm xong (nó đặt lại chủ đề lúc mở)
  setTimeout(() => {
    useChatStore.getState().setMessages(accountId, chatId, [], topicId);
    useChatStore.setState({
      activeThreadId: chatId,
      activeThreadType: 1,
      activeTopicId: topicId,
      activeForumTopicId: topic?.forumTopicId || topicId,
      activeTopicTitle: topic?.title || (topicId === FORUM_GENERAL_TOPIC_ID ? 'General' : 'Chủ đề'),
      messagesLoading: true,
    });
    if (post && String(post) !== topicId) jumpToMessage(accountId, chatId, post);
  }, 0);
}

async function openTelegramPeer(link: Extract<TelegramLink, { kind: 'username' | 'phone' }>, accountId: string): Promise<void> {
  const res = link.kind === 'username'
    ? await ipc.telegramUser?.resolveUsername({ accountId, username: link.username })
    : await ipc.telegramUser?.resolvePhone?.({ accountId, phone: link.phone });
  const peer = res?.success ? res.peer : null;
  if (!peer?.peerId) {
    notify(res?.error || (link.kind === 'username' ? `Không tìm thấy @${link.username}` : 'Không tìm thấy số này trên Telegram'));
    return;
  }
  const peerId = String(peer.peerId);
  const name = peer.displayName || (peer.username ? `@${peer.username}` : undefined);
  const info = { ...(name ? { display_name: name } : {}), channel: 'telegram_user' };
  const view = link.kind === 'username' ? link : null;

  if (peer.peerType === 'user') {
    // Mini App: t.me/<bot>/<app> · t.me/<bot>?startapp (bot có app chính)
    if (peer.isBot && view?.appName) {
      openTelegramMiniApp({
        accountId, botId: peerId, peerId, kind: 'app', appName: view.appName, ...(name ? { botName: name } : {}),
        ...(view.startApp ? { startParam: view.startApp } : {}),
      });
      return;
    }
    if (peer.isBot && view?.startApp !== undefined && peer.hasMainApp) {
      openTelegramMiniApp({
        accountId, botId: peerId, peerId, kind: 'main', ...(name ? { botName: name } : {}),
        ...(view.startApp ? { startParam: view.startApp } : {}),
      });
      return;
    }
    if (link.text) prefillComposer(accountId, peerId, link.text);
    openThread(accountId, peerId, 0, info);
    // Link bot ?start: hỏi "Bắt đầu" rồi mới gửi messages.startBot (như Telegram)
    if (peer.isBot && view?.start !== undefined) {
      requestBotStart({ accountId, botId: peerId, startParam: view.start, ...(name ? { botName: name } : {}) });
    }
    return;
  }

  // Nhóm / kênh công khai
  if (!peer.isMember) {
    openGroupJoinDialog({ link: `https://t.me/${view ? view.username : ''}`, accountId });
    return;
  }
  if (link.text) prefillComposer(accountId, peerId, link.text);
  if (peer.peerType === 'forum' && (view?.post || view?.thread)) {
    await openForumPost(accountId, peerId, view.post, view.thread, info);
    return;
  }
  openThread(accountId, peerId, 1, info);
  if (view?.post) jumpToMessage(accountId, peerId, view.post);
}

async function openTelegramLink(link: TelegramLink, raw: string, ctx: ChatLinkContext): Promise<void> {
  // Chia sẻ: chọn hội thoại (mọi tài khoản), không cần tài khoản Telegram
  if (link.kind === 'share') {
    openShareDialog({ text: link.text ? `${link.url}\n${link.text}` : link.url, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) });
    return;
  }
  const account = pickLinkAccount('telegram_user', ctx.accountId);
  if (!account) {
    if (/^tg:/i.test(raw)) notify('Chưa có tài khoản Telegram để mở link này', 'warning');
    else openExternalLink(raw);
    return;
  }
  const accountId = account.zalo_id;
  try {
    switch (link.kind) {
      case 'invite':
        await openTelegramGroupLink(`https://t.me/+${link.hash}`, accountId);
        return;
      case 'private_post': {
        const threadId = `-100${link.channelId}`;
        const known = await localConversation(accountId, threadId);
        if (!known) {
          notify('Bạn chưa tham gia nhóm / kênh của tin này', 'warning');
          return;
        }
        if (link.thread || Number(known.is_forum) === 1) {
          await openForumPost(accountId, threadId, link.post, link.thread, { channel: 'telegram_user' });
          return;
        }
        openThread(accountId, threadId, 1, { channel: 'telegram_user' });
        jumpToMessage(accountId, threadId, link.post);
        return;
      }
      case 'stickers':
        openTelegramStickerSet({ accountId, ref: { shortName: link.slug } });
        return;
      default:
        await openTelegramPeer(link, accountId);
    }
  } catch (err: any) {
    notify(`Không mở được link Telegram: ${err?.message || err}`);
  }
}

/**
 * Bấm link trong app. true = Deplao tự mở (hội thoại, hộp tham gia, Mini App…), false = mở trình duyệt / bỏ qua.
 */
export function openChatLink(url: string, ctx: ChatLinkContext = {}): boolean {
  const raw = String(url || '').trim();
  if (!raw) return false;
  const group = parseGroupLink(raw);
  if (group?.channel === 'zalo') {
    void openZaloGroupLink(group.link, raw, ctx);
    return true;
  }
  const telegram = parseTelegramLink(raw);
  if (telegram) {
    void openTelegramLink(telegram, raw, ctx);
    return true;
  }
  openExternalLink(raw);
  return false;
}

// ── Nút inline của tin bot Telegram ──

export interface TelegramInlineButton {
  text: string;
  type: string;
  url?: string;
  buttonId?: number;
}

/**
 * Nút không phải link (callback, trò chơi, sao chép, mở hồ sơ…): main đọc lại nút ở [hàng][cột] từ tin trên Telegram rồi
 * trả việc cần làm (https://core.telegram.org/api/bots/buttons). Câu trả lời của bot: alert → hộp, không thì thông báo
 * nhỏ; có link (trò chơi…) → mở như link trong tin.
 */
async function pressTelegramInlineButton(
  accountId: string, chatId: string, msgId: number, row: number, col: number, botName?: string,
): Promise<void> {
  try {
    const res = await ipc.telegramUser?.pressInlineButton?.({ accountId, chatId, msgId, row, col });
    const action = res?.success ? res.action : undefined;
    if (!action) {
      notify(res?.error || 'Bấm nút không được');
      return;
    }
    switch (action.kind) {
      case 'answer':
        if (action.message) {
          if (action.alert) showBotAlert({ title: botName || 'Bot', message: action.message });
          else notify(action.message, 'info');
        }
        if (action.url) openChatLink(action.url, { accountId });
        return;
      case 'copy':
        try {
          await navigator.clipboard.writeText(action.text);
          notify('Đã sao chép', 'success');
        } catch {
          notify('Không sao chép được');
        }
        return;
      case 'profile':
        if (action.userId) openThread(accountId, action.userId, 0, { channel: 'telegram_user' });
        return;
      default:
        notify(action.reason || 'Loại nút này chưa hỗ trợ trong Deplao', 'warning');
    }
  } catch (err: any) {
    notify(`Bấm nút không được: ${err?.message || err}`);
  }
}

/**
 * Bấm nút inline trong tin của bot Telegram (msg: tin chứa nút; botName: tên bot cho khung Mini App / hộp của bot;
 * position: hàng / cột của nút, cần cho nút callback):
 * Mini App → mở trong app; đăng nhập → hộp hỏi; link → openChatLink; callback / sao chép / hồ sơ → pressInlineButton.
 * Trả Promise khi phải chờ Telegram (nút hiện đang chờ).
 */
export function handleTelegramInlineButton(
  msg: { msg_id?: unknown; thread_id?: unknown; sender_id?: unknown },
  button: TelegramInlineButton,
  accountId: string,
  botName?: string,
  position?: { row: number; col: number },
): Promise<void> | void {
  const url = typeof button.url === 'string' ? button.url : '';
  const peerId = String(msg.thread_id ?? '');
  const msgId = Number(msg.msg_id);
  const realMessage = Number.isInteger(msgId) && msgId > 0;
  if (button.type === 'webview' && url && accountId) {
    openTelegramMiniApp({
      accountId, botId: String(msg.sender_id ?? ''), peerId, kind: 'inline', url, ...(botName ? { botName } : {}),
    });
    return;
  }
  if (button.type === 'url_auth' && accountId && Number.isInteger(button.buttonId) && realMessage) {
    openTelegramUrlAuth({ accountId, peerId, msgId, buttonId: button.buttonId as number, url });
    return;
  }
  if ((button.type === 'url' || button.type === 'url_auth') && url) {
    openChatLink(url, { accountId });
    return;
  }
  if (button.type === 'callback' && accountId && peerId && realMessage && position
    && Number.isInteger(position.row) && Number.isInteger(position.col)) {
    return pressTelegramInlineButton(accountId, peerId, msgId, position.row, position.col, botName);
  }
}

// Link trong chữ của tin (linkifyText) đi qua đây khi màn chat đã nạp module này
setChatLinkOpener((url) => { openChatLink(url); });
