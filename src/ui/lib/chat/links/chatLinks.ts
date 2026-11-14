/**
 * Opens links inside the app (messages, link cards, bot buttons, Mini Apps), like Zalo / Telegram:
 *  - Zalo group link (zalo.me/g/…): already in the group → open the conversation; not yet → preview, then "Tham gia" (Join).
 *  - Telegram link (shared/telegram/telegramLinks, https://core.telegram.org/api/links): user / bot → open the chat (bot link
 *    ?start → asks "Bắt đầu" (Start)), joined group / channel → open (message link → jumps to the message; forum group → the right topic), not yet →
 *    preview + "Tham gia" (Join); invite links, phone numbers, Mini Apps (?startapp, t.me/<bot>/<app>) open in the app, a sticker set opens the
 *    sticker popup; ?text= pre-fills the composer; share links (t.me/share) → pick a conversation, then pre-fill the composer.
 *  - Bot buttons: Mini Apps, login, links as above; callback / game / copy / open profile → main re-reads the button from the message
 *    (pressInlineButton), then acts like Telegram (the bot's answer shows as a notification or a box, links open as above).
 *  - Everything else (and when no account on the same channel exists): the machine's browser.
 * Account: the account of the conversation / Mini App in use if it is the same channel, then the account currently open, then the first account
 * (only accounts the user can see; employee mode: only the accounts assigned to them).
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
import { tr } from '../../../../shared/i18n';

export interface ChatLinkContext {
  /** Account of the conversation / Mini App where the link was tapped. */
  accountId?: string;
}

// ── Boxes opened from a link (ChatLinkHost in App): join a group, bot "Bắt đầu" (Start), share to a conversation, the bot's box ──

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
  /** Text pre-filled into the composer of the chosen conversation (the URL on the first line, then the message). */
  text: string;
  /** Account where the link was tapped: preselected in the box. */
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

// ── Pick an account, open the conversation, pre-fill the composer ──

function notify(message: string, type: 'error' | 'warning' | 'info' | 'success' = 'error'): void {
  useAppStore.getState().showNotification(message, type);
}

/** Account used to open the link: the account where it was tapped (same channel) → the account currently open → the first connected account. */
export function pickLinkAccount(channel: 'zalo' | 'telegram_user', preferredId?: string): AccountInfo | null {
  const sameChannel = visibleAccountsNow().filter((account) => (account.channel || 'zalo') === channel);
  const connected = sameChannel.filter((account) => account.isConnected !== false);
  for (const id of [preferredId, useAccountStore.getState().activeAccountId]) {
    const hit = id ? connected.find((account) => account.zalo_id === id) : undefined;
    if (hit) return hit;
  }
  return connected[0] || sameChannel[0] || null;
}

/** Conversation already on this machine (shown in the list or in the DB); null if not there yet. */
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

/** Opens the conversation, then jumps to the message (ChatWindow waits for the conversation to load before jumping). */
function jumpToMessage(accountId: string, threadId: string, messageId: number): void {
  window.dispatchEvent(new CustomEvent('chat:jumpToMessage', { detail: { accountId, threadId, messageId: String(messageId) } }));
}

/**
 * Pre-fills the composer (?text= links, share links), like Telegram: it only fills the box, never sends. If the conversation is open → insert into the
 * composer; if not → save it as a draft (appended after any existing draft), visible once the conversation opens. Call this BEFORE opening the conversation.
 */
export function prefillComposer(accountId: string, threadId: string, text: string): void {
  let value = String(text || '').slice(0, 4096);
  if (!value.trim() || !accountId || !threadId) return;
  // Starts with @ → add a space so an inline bot is not triggered (https://core.telegram.org/api/links)
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
  } catch { /* preview failed: the join box shows the specific error */ }
  openGroupJoinDialog({ link, accountId: account.zalo_id });
}

// ── Telegram ──

/** Group / channel via an invite link or name: already joined → open; not yet → preview box + "Tham gia" (Join). */
async function openTelegramGroupLink(link: string, accountId: string): Promise<void> {
  try {
    const res = await ipc.telegramUser?.previewJoinLink({ accountId, link });
    if (res?.success && res.alreadyMember && res.chatId) {
      openThread(accountId, String(res.chatId), 1, { display_name: res.title, channel: 'telegram_user' });
      return;
    }
  } catch { /* the join box shows the specific error */ }
  openGroupJoinDialog({ link, accountId });
}

/**
 * Message link in a forum group: opens the right topic (the link has a topic; a link to the message that created a topic; message 1 = General), then jumps to the message
 * (https://core.telegram.org/api/links#message-links). If the topic is unknown → open the group and jump to the message.
 */
async function openForumPost(accountId: string, chatId: string, post: number | undefined, thread: number | undefined,
  info: OpenConversationRequest['info']): Promise<void> {
  openThread(accountId, chatId, 1, info);
  let topics = (useChatStore.getState().forumTopics[`${accountId}_${chatId}`] || []) as ForumTopicRow[];
  if (!topics.length) {
    try {
      const res = await ipc.telegramUser?.getForumTopics({ accountId, chatId });
      topics = res?.success ? (res.topics || []) as ForumTopicRow[] : [];
    } catch { /* no topic list: still open by the id in the link */ }
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
  // After the conversation list has opened the group (it resets the topic when opening)
  setTimeout(() => {
    useChatStore.getState().setMessages(accountId, chatId, [], topicId);
    useChatStore.setState({
      activeThreadId: chatId,
      activeThreadType: 1,
      activeTopicId: topicId,
      activeForumTopicId: topic?.forumTopicId || topicId,
      activeTopicTitle: topic?.title || (topicId === FORUM_GENERAL_TOPIC_ID ? 'General' : tr('Chủ đề')),
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
    notify(res?.error || (link.kind === 'username' ? tr('Không tìm thấy @{{username}}', { username: link.username }) : tr('Không tìm thấy số này trên Telegram')));
    return;
  }
  const peerId = String(peer.peerId);
  const name = peer.displayName || (peer.username ? `@${peer.username}` : undefined);
  const info = { ...(name ? { display_name: name } : {}), channel: 'telegram_user' };
  const view = link.kind === 'username' ? link : null;

  if (peer.peerType === 'user') {
    // Mini App: t.me/<bot>/<app> · t.me/<bot>?startapp (bot with a main app)
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
    // Bot ?start link: asks "Bắt đầu" (Start) first, then sends messages.startBot (as Telegram does)
    if (peer.isBot && view?.start !== undefined) {
      requestBotStart({ accountId, botId: peerId, startParam: view.start, ...(name ? { botName: name } : {}) });
    }
    return;
  }

  // Public group / channel
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
  // Share: pick a conversation (any account), no Telegram account needed
  if (link.kind === 'share') {
    openShareDialog({ text: link.text ? `${link.url}\n${link.text}` : link.url, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) });
    return;
  }
  const account = pickLinkAccount('telegram_user', ctx.accountId);
  if (!account) {
    if (/^tg:/i.test(raw)) notify(tr('Chưa có tài khoản Telegram để mở link này'), 'warning');
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
          notify(tr('Bạn chưa tham gia nhóm / kênh của tin này'), 'warning');
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
    notify(tr('Không mở được link Telegram: {{v1}}', { v1: err?.message || err }));
  }
}

/**
 * Tapping a link inside the app. true = Deplao opens it itself (conversation, join box, Mini App...), false = open in the browser / ignore.
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

// ── Inline buttons of a Telegram bot message ──

export interface TelegramInlineButton {
  text: string;
  type: string;
  url?: string;
  buttonId?: number;
}

/**
 * A button that is not a link (callback, game, copy, open profile...): main re-reads the button at [row][column] from the message on Telegram, then
 * returns what to do (https://core.telegram.org/api/bots/buttons). The bot's answer: alert → box, otherwise a small
 * notification; has a link (game...) → open it like a link in the message.
 */
async function pressTelegramInlineButton(
  accountId: string, chatId: string, msgId: number, row: number, col: number, botName?: string,
): Promise<void> {
  try {
    const res = await ipc.telegramUser?.pressInlineButton?.({ accountId, chatId, msgId, row, col });
    const action = res?.success ? res.action : undefined;
    if (!action) {
      notify(res?.error || tr('Bấm nút không được'));
      return;
    }
    switch (action.kind) {
      case 'answer':
        if (action.message) {
          if (action.alert) showBotAlert({ title: botName || tr('Bot'), message: action.message });
          else notify(action.message, 'info');
        }
        if (action.url) openChatLink(action.url, { accountId });
        return;
      case 'copy':
        try {
          await navigator.clipboard.writeText(action.text);
          notify(tr('Đã sao chép'), 'success');
        } catch {
          notify(tr('Không sao chép được'));
        }
        return;
      case 'profile':
        if (action.userId) openThread(accountId, action.userId, 0, { channel: 'telegram_user' });
        return;
      default:
        notify(action.reason || tr('Loại nút này chưa hỗ trợ trong Deplao'), 'warning');
    }
  } catch (err: any) {
    notify(tr('Bấm nút không được: {{v1}}', { v1: err?.message || err }));
  }
}

/**
 * Taps an inline button in a Telegram bot message (msg: the message containing the button; botName: the bot's name for the Mini App frame / the bot's box;
 * position: the button's row / column, needed for callback buttons):
 * Mini App → open in the app; login → ask in a box; link → openChatLink; callback / copy / profile → pressInlineButton.
 * Returns a Promise when it has to wait for Telegram (the button is waiting).
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

// Links in the text of a message (linkifyText) go through here once the chat screen has loaded this module
setChatLinkOpener((url) => { openChatLink(url); });
