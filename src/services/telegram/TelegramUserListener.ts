/**
 * TelegramUserListener.ts - MTProto listener cho Telegram cá nhân
 *
 * Giữ 1 kết nối MTProto sống cho mỗi tài khoản đã đăng nhập.
 * Lắng nghe tin nhắn mới, ghi vào messages table, emit events cho UI.
 *
 * Pattern theo khuôn FacebookMQTTListener.ts.
 * Sử dụng GramJS (telegram) library cho MTProto protocol.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events';
import { getPeerId } from 'telegram/Utils';
import * as path from 'path';
import * as fs from 'fs';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import FileStorageService from '../file/FileStorageService';
import { shouldFetchAvatar, markAvatarFetched, markAvatarSuccess, resetAvatarCache } from '../../utils/avatarFetchCache';
import type { TelegramPeerType } from '../../models/telegram';

// Telegram API credentials - đăng ký tại my.telegram.org
import { API_ID, API_HASH } from '../../configs/telegram.config';

export interface TelegramUserAccount {
  accountId: string;     // = Telegram user ID
  phoneNumber: string;
  stringSession: string; // GramJS StringSession (encrypted)
}

interface ActiveListener {
  account: TelegramUserAccount;
  client: TelegramClient | null;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  channelPollTimer: ReturnType<typeof setInterval> | null;
  connecting: Promise<void> | null;
  healthCheckClient: TelegramClient | null;
  transportDownSince: number | null;
  retryCount: number;
  stopped: boolean;
}

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PRIMARY_RECONNECT_GRACE_MS = 70_000;
const HEALTH_CHECK_INTERVAL_MS = 45_000;
const INITIAL_DIALOG_LIMIT = 300;
const RECENT_DIALOG_LIMIT = 200;
const INITIAL_MESSAGES_PER_DIALOG = 100;
const RECOVERY_MESSAGES_PER_DIALOG = 1000;
const MAX_MANUAL_MESSAGE_DOWNLOAD = 5000;

/** Map accountId → ActiveListener */
const activeListeners = new Map<string, ActiveListener>();
const intentionallyDisconnectedClients = new WeakSet<TelegramClient>();
const reconnectCatchUps = new Map<string, Promise<void>>();
const manualRefreshTasks = new Map<string, Promise<void>>();
const syncingAccounts = new Set<string>();
const recoveringUpdateAccounts = new Set<string>();
const rawUpdateHandlers = new Map<string, (update: any) => Promise<void>>();
/** All direct-download operations share one account queue. GramJS borrows an
 * exported sender per DC; allowing avatar and media paths to run independently
 * causes the "Not connected" reconnect storm seen on media-heavy forums. */
const mediaDownloadQueues = new Map<string, Promise<unknown>>();
const inFlightDownloadKeys = new Map<string, Promise<unknown>>();
const mediaRepairQueues = new Map<string, Promise<unknown>>();
const quoteRepairQueues = new Map<string, Promise<unknown>>();
const entityHydrationQueues = new Map<string, Promise<any | null>>();
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

// ─── Phase A: Diagnostic types and structured logging ────────────────────────

type TelegramIngressSource = 'socket' | 'global_difference' | 'channel_difference' | 'history' | 'poll' | 'topic_api';

type ProcessResult = {
  status: 'inserted' | 'duplicate' | 'updated' | 'ignored' | 'failed';
  chatId?: string;
  messageId?: string;
};

// Telegram receives a lot of expected duplicate/difference events. Keep the
// production terminal useful; detailed ingress traces are opt-in for diagnosis.
const TELEGRAM_VERBOSE_LOGGING = process.env.TELEGRAM_VERBOSE_LOGGING === '1';
function tgDebugLog(line: string): void {
  if (TELEGRAM_VERBOSE_LOGGING) Logger.log(line);
}

/** Structured diagnostic logger for Telegram ingress pipeline.
 *  Safe fields only — never logs session strings, access hashes, or message content. */
function tgLog(level: 'info' | 'warn' | 'error', accountId: string, source: TelegramIngressSource, msg: string, extra?: Record<string, unknown>): void {
  const prefix = `[TG:${source}]`;
  const fields = [`account=${accountId}`];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) fields.push(`${k}=${v}`);
    }
  }
  const line = `${prefix} ${msg} | ${fields.join(' ')}`;
  if (level === 'error') Logger.error(line);
  else if (level === 'warn') Logger.warn(line);
  else tgDebugLog(line);
}

/** Short-lived login state is separate from persistent account listeners. */
let pendingLogin: { client: TelegramClient; phoneNumber: string; phoneCodeHash: string; expiresAt: number } | null = null;

async function clearPendingLogin(): Promise<void> {
  const current = pendingLogin;
  pendingLogin = null;
  if (current?.client) {
    try { await current.client.disconnect(); } catch {}
  }
}

function getPendingLogin(): typeof pendingLogin {
  if (!pendingLogin || pendingLogin.expiresAt > Date.now()) return pendingLogin;
  clearPendingLogin().catch(() => {});
  return null;
}

/**
 * GramJS uses "marked" peer IDs: user=123, basic group=-123, channel=-100123.
 * Persisting chat.id directly loses that type marker and creates duplicate chats
 * because dialog.id is already marked while message.getChat().id is not.
 */
function getCanonicalChatId(peer: any): string {
  try {
    return String(getPeerId(peer));
  } catch {
    return String(peer?.id ?? peer ?? '');
  }
}

function getForumCacheKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

function getTelegramPeerType(entity: any): TelegramPeerType {
  if (entity?.className === 'Chat' || entity?.className === 'ChatForbidden') return 'basic_group';
  if (entity?.className === 'Channel' || entity?.className === 'ChannelForbidden') {
    if (entity?.forum) return 'forum';
    return entity?.broadcast ? 'channel' : 'supergroup';
  }
  return 'user';
}

/** Persist every resolved MTProto peer independently from the conversation
 * list. This retains access_hash for valid InputPeer construction without
 * creating phantom contacts for group participants. */
function cacheTelegramPeer(accountId: string, peerId: string, entity: any): void {
  const db = DatabaseService.getInstance();
  if (!db || !peerId || !entity) return;
  const displayName = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || '';
  const peerType = getTelegramPeerType(entity);
  db.upsertTelegramPeer(accountId, {
    peerId,
    peerType,
    accessHash: entity?.accessHash != null ? String(entity.accessHash) : '',
    username: entity?.username || '',
    displayName,
    phone: entity?.phone || '',
  });
  // A Channel carrying forum=true is authoritative and must immediately heal
  // the denormalized contact flag used by the renderer conversation list.
  if (peerType === 'forum') db.setIsForum(accountId, peerId, true);
}

type TelegramMembershipState = 'member' | 'joinable' | 'request' | 'pending' | 'left' | 'forbidden';
type TelegramJoinAction = 'join' | 'request' | 'none';

function getTelegramMembership(entity: any): {
  state: TelegramMembershipState;
  action: TelegramJoinAction;
  reason: string;
} {
  if (!entity) return { state: 'member', action: 'none', reason: '' };
  if (entity.className === 'ChatForbidden' || entity.className === 'ChannelForbidden' || entity.kicked) {
    return { state: 'forbidden', action: 'none', reason: 'Nhóm hoặc kênh này không còn khả dụng với tài khoản của bạn' };
  }
  if (entity.left) {
    if (entity.joinRequest) {
      return { state: 'request', action: 'request', reason: 'Bạn cần được quản trị viên duyệt để tham gia nhóm này' };
    }
    const publicUsername = entity.username || (entity.usernames || []).some((item: any) => item?.active && item?.username);
    if (publicUsername || entity.hasLink) {
      return { state: 'joinable', action: 'join', reason: 'Bạn chưa tham gia cuộc trò chuyện này' };
    }
    return { state: 'left', action: 'none', reason: 'Nhóm riêng tư này cần liên kết mời để tham gia lại' };
  }
  return { state: 'member', action: 'none', reason: '' };
}

function getTelegramSendCapability(entity: any): { canSend: boolean; reason: string } {
  if (!entity) return { canSend: true, reason: '' };
  if (entity.className === 'User') return { canSend: !entity.deleted, reason: entity.deleted ? 'Tài khoản Telegram không còn hoạt động' : '' };
  const membership = getTelegramMembership(entity);
  if (membership.state !== 'member') return { canSend: false, reason: membership.reason };
  const now = Math.floor(Date.now() / 1000);
  const banned = entity.bannedRights;
  const banActive = !!banned && (!Number(banned.untilDate || 0) || Number(banned.untilDate) > now);
  if (banActive && (banned.sendMessages || banned.sendPlain || banned.viewMessages)) {
    return { canSend: false, reason: 'Bạn không có quyền gửi tin nhắn trong cuộc trò chuyện này' };
  }
  if (entity.className === 'Channel' && (entity.broadcast || entity.gigagroup)) {
    const canPost = !!entity.creator || !!entity.adminRights?.postMessages;
    return { canSend: canPost, reason: canPost ? '' : 'Chỉ quản trị viên được đăng bài trong kênh này' };
  }
  if (entity.creator || entity.adminRights) return { canSend: true, reason: '' };
  const defaults = entity.defaultBannedRights;
  if (defaults?.sendMessages || defaults?.sendPlain) {
    return { canSend: false, reason: 'Nhóm này chỉ cho phép quản trị viên gửi tin nhắn' };
  }
  return { canSend: true, reason: '' };
}

function persistTelegramDialogState(accountId: string, chatId: string, dialog: any, entity: any, fullChat?: any): void {
  const db = DatabaseService.getInstance();
  if (!db || !chatId) return;
  const existing = db.queryOne<any>(
    `SELECT telegram_folder_id, is_muted, mute_until, telegram_membership_state, is_in_others FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [accountId, chatId],
  );
  const peerType = entity ? getTelegramPeerType(entity) : (db.getTelegramPeer(accountId, chatId)?.peer_type || 'user');
  const capability = getTelegramSendCapability(entity);
  // Khi entity null → giữ nguyên membership state cũ thay vì reset về 'member'
  const membership = entity
    ? getTelegramMembership(entity)
    : { state: (existing?.telegram_membership_state || 'member') as TelegramMembershipState, action: 'none' as const, reason: '' };
  const folderId = Number(dialog?.folderId ?? dialog?.dialog?.folderId ?? existing?.telegram_folder_id ?? 0);
  const rawMuteUntil = dialog?.dialog?.notifySettings?.muteUntil ?? dialog?.notifySettings?.muteUntil;
  const muteUntilSeconds = rawMuteUntil == null ? null : Number(rawMuteUntil || 0);
  const foreverMuted = muteUntilSeconds == null
    ? Number(existing?.is_muted || 0) === 1
    : muteUntilSeconds >= 2147483647;
  const muteUntilMs = muteUntilSeconds == null
    ? Number(existing?.mute_until || 0)
    : (foreverMuted ? 0 : muteUntilSeconds * 1000);
  const membersCount = Number(fullChat?.participantsCount ?? entity?.participantsCount ?? 0);
  const onlineCount = Number(fullChat?.onlineCount ?? 0);
  const displayName = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || chatId;
  const contactType = peerType === 'user' ? 'user' : 'group';
  // Saved Messages (self-chat) → auto pin local
  const isSelfChat = peerType === 'user' && chatId === accountId;
  // Update is_cov_bot flag — only set to 1 when confirmed bot, leave untouched otherwise
  const isBot = entity?.className === 'User' && entity?.bot ? 1 : null;
  // Lấy unread_count từ Telegram dialog (đồng bộ chính xác với Telegram)
  const dialogUnreadCount = Number(dialog?.unreadCount ?? 0);
  db.run(
    `INSERT INTO contacts
       (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, channel,
        is_muted, mute_until, telegram_folder_id, telegram_archived, telegram_can_send,
        telegram_send_reason, telegram_peer_type, telegram_members_count, telegram_online_count, telegram_state_updated_at,
        telegram_membership_state, telegram_join_action, is_in_others, is_cov_bot)
     VALUES (?, ?, ?, '', 0, ?, ?, 'telegram_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
       display_name = CASE WHEN contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
       contact_type = excluded.contact_type, channel = 'telegram_user',
       unread_count = excluded.unread_count,
       is_muted = excluded.is_muted, mute_until = excluded.mute_until,
       telegram_folder_id = excluded.telegram_folder_id, telegram_archived = excluded.telegram_archived,
       telegram_can_send = excluded.telegram_can_send, telegram_send_reason = excluded.telegram_send_reason,
       telegram_peer_type = excluded.telegram_peer_type,
       telegram_members_count = CASE WHEN excluded.telegram_members_count > 0 THEN excluded.telegram_members_count ELSE contacts.telegram_members_count END,
       telegram_online_count = excluded.telegram_online_count,
       telegram_state_updated_at = excluded.telegram_state_updated_at,
       telegram_membership_state = excluded.telegram_membership_state,
       telegram_join_action = excluded.telegram_join_action,
       is_in_others = excluded.is_in_others,
       is_cov_bot = CASE WHEN excluded.is_cov_bot = 1 THEN 1 ELSE contacts.is_cov_bot END`,
    [accountId, chatId, displayName, contactType, dialogUnreadCount, foreverMuted ? 1 : 0, muteUntilMs,
      folderId, folderId === 1 ? 1 : 0, capability.canSend ? 1 : 0, capability.reason,
      peerType, membersCount, onlineCount, Date.now(), membership.state, membership.action,
      // is_in_others: archived | chưa tham gia (joinable/request/left/forbidden)
      (folderId === 1 || membership.state !== 'member') ? 1 : 0, isBot],
  );
  // Saved Messages (self-chat) → auto pin local
  if (isSelfChat) {
    db.run(
      `INSERT OR IGNORE INTO local_pinned_conversations (owner_zalo_id, thread_id, pinned_at) VALUES (?, ?, ?)`,
      [accountId, chatId, Date.now()],
    );
  }
  // Emit event to trigger renderer cache refresh (othersConversations, mutedThreads)
  try {
    const { EventBroadcaster } = require('../event/EventBroadcaster');
    EventBroadcaster.emit('db:unreadChanged', {
      zaloId: accountId,
      source: 'telegram_dialog_state',
    });
  } catch {}
}

function getTelegramUserStatus(user: any): { status: string; statusText: string; lastSeenAt?: number; onlineUntil?: number } {
  const status = user?.status;
  const className = String(status?.className || '');
  const now = Math.floor(Date.now() / 1000);
  if (className === 'UserStatusOnline' && Number(status?.expires || 0) > now) {
    return { status: className, statusText: 'Đang online', onlineUntil: Number(status.expires) };
  }
  if (className === 'UserStatusOffline') {
    return { status: className, statusText: 'Đã offline', lastSeenAt: Number(status?.wasOnline || 0) || undefined };
  }
  if (className === 'UserStatusRecently') return { status: className, statusText: 'Hoạt động gần đây' };
  if (className === 'UserStatusLastWeek') return { status: className, statusText: 'Hoạt động trong tuần qua' };
  if (className === 'UserStatusLastMonth') return { status: className, statusText: 'Hoạt động trong tháng qua' };
  return { status: className, statusText: '' };
}

function getForumTopicId(message: any): string | undefined {
  const replyTo = message?.replyTo;
  if (replyTo?.replyToTopId) return String(replyTo.replyToTopId);
  // Telegram omits replyToTopId when a message replies directly to the topic
  // root. General-topic messages do not set forumTopic and remain topic_id=NULL.
  if (replyTo?.forumTopic && replyTo?.replyToMsgId) return String(replyTo.replyToMsgId);
  if (message?.className === 'MessageService' && message?.action?.className === 'MessageActionTopicCreate') {
    return String(message?.id || '');
  }
  return undefined;
}

/** Telegram uses replyToMsgId both for a real reply and to attach a message
 * to a forum topic root. When it points at the same message as topic_id it is
 * routing metadata, not a quote preview (Telegram does not render a quote in
 * that case). Keep topic routing in topic_id and expose only genuine replies. */
function getTelegramReplyToMessageId(message: any): string | undefined {
  const replyToMessageId = message?.replyTo?.replyToMsgId != null
    ? String(message.replyTo.replyToMsgId)
    : '';
  if (!replyToMessageId) return undefined;
  const topicId = getForumTopicId(message);
  if (topicId && replyToMessageId === topicId) return undefined;
  return replyToMessageId;
}

function buildTelegramQuoteData(message: {
  msgId: string;
  content?: string;
  msgType?: string;
  senderId?: string;
  senderName?: string;
  attachments?: string | any[];
  localPaths?: string | Record<string, string> | null;
}): string {
  const attachmentValue = Array.isArray(message.attachments)
    ? JSON.stringify(message.attachments)
    : (message.attachments || '[]');
  const msgType = String(message.msgType || 'text');
  let imageLocalPath = '';
  try {
    const paths = typeof message.localPaths === 'string'
      ? JSON.parse(message.localPaths || '{}')
      : (message.localPaths || {});
    if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') {
      imageLocalPath = paths.main || paths.image || paths.thumbnail || paths.file || '';
    }
  } catch {}
  if (!imageLocalPath) {
    try {
      const attachments = typeof attachmentValue === 'string' ? JSON.parse(attachmentValue) : attachmentValue;
      const media = (Array.isArray(attachments) ? attachments : []).find((attachment: any) =>
        ['photo', 'image', 'chat.photo'].includes(String(attachment?.type || ''))
      );
      imageLocalPath = String(media?.localPath || '');
    } catch {}
  }
  return JSON.stringify({
    msgId: message.msgId,
    msg: message.content || '',
    senderId: message.senderId || '',
    fromD: message.senderName || '',
    msgType,
    attach: attachmentValue,
    ...(imageLocalPath ? { imageLocalPath } : {}),
  });
}

function hasUsableTelegramQuoteData(value?: string | null): boolean {
  if (!value) return false;
  try {
    const quote = JSON.parse(value);
    const msgType = String(quote?.msgType || 'text');
    // MTProto does not provide a durable CDN URL for photos. A media quote is
    // usable only after we have a local preview; otherwise repair it instead
    // of rendering the misleading "[Hình ảnh]" fallback.
    if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') {
      return !!quote?.imageUrl || !!quote?.imageLocalPath;
    }
    if (String(quote?.msg || '').trim()) return true;
    if (msgType !== 'text' && msgType !== 'chat.text') return true;
    const attach = typeof quote?.attach === 'string' ? quote.attach.trim() : quote?.attach;
    return !!quote?.imageUrl || (!!attach && attach !== '[]' && attach !== '{}');
  } catch {
    return false;
  }
}

/** Convert the aggregate MTProto reaction payload into Deplao's display model.
 * Telegram only provides identities for a recent subset of reactors, so counts
 * remain authoritative while the users map contains only identities Telegram
 * actually returned (including the current account when marked as my). */
function normalizeTelegramReactions(reactions: any, accountId: string): {
  total: number;
  lastReact: string;
  emoji: Record<string, { total: number; users: Record<string, number> }>;
} {
  const normalized = { total: 0, lastReact: '', emoji: {} as Record<string, { total: number; users: Record<string, number> }> };
  const getEmoji = (reaction: any): string => {
    if (reaction?.className === 'ReactionEmoji') return String(reaction.emoticon || '');
    if (reaction?.className === 'ReactionCustomEmoji' && reaction.documentId != null) {
      return `tg_custom:${String(reaction.documentId)}`;
    }
    return '';
  };

  for (const result of reactions?.results || []) {
    const emoji = getEmoji(result?.reaction);
    const count = Math.max(0, Number(result?.count || 0));
    if (!emoji || !count) continue;
    normalized.emoji[emoji] = { total: count, users: {} };
    normalized.total += count;
    normalized.lastReact = emoji;
  }

  for (const recent of reactions?.recentReactions || []) {
    const emoji = getEmoji(recent?.reaction);
    if (!emoji || !normalized.emoji[emoji]) continue;
    const userId = recent?.my ? accountId : getCanonicalChatId(recent?.peerId);
    if (!userId) continue;
    // A peer can have at most one occurrence for an emoji in this payload.
    normalized.emoji[emoji].users[userId] = 1;
  }

  return normalized;
}

function getMessageIdFromUpdates(result: any): string | undefined {
  const directId = result?.id || result?.message?.id;
  if (directId) return String(directId);
  const update = (result?.updates || []).find((item: any) => item?.message?.id);
  return update?.message?.id ? String(update.message.id) : undefined;
}

/** MTProto basic-group methods expect the raw positive chat ID, not GramJS's marked ID. */
function getBasicGroupId(chatId: string): bigint {
  return BigInt(String(chatId).replace(/^-100/, '').replace(/^-/, ''));
}

/** Telegram stickers are documents; DocumentAttributeSticker is the authoritative marker. */
function getTelegramStickerAttachment(message: any): Record<string, any> | null {
  const document = message?.document as any;
  const attributes = document?.attributes || [];
  const stickerAttribute = attributes.find((attribute: any) =>
    attribute?.className === 'DocumentAttributeSticker'
  );
  if (!stickerAttribute) return null;

  const imageSize = attributes.find((attribute: any) =>
    attribute?.className === 'DocumentAttributeImageSize'
  );
  const mimeType = String(document?.mimeType || '');
  const stickerFormat = mimeType.includes('tgsticker') || mimeType.includes('lottie')
    ? 'tgs'
    : mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('mp4')
        ? 'mp4'
        : 'webp';

  return {
    type: 'sticker',
    is_sticker: true,
    sticker_format: stickerFormat,
    id: String(document?.id || ''),
    dc_id: document?.dcId,
    access_hash: String(document?.accessHash || ''),
    emoji: stickerAttribute.alt || '',
    width: imageSize?.w || 0,
    height: imageSize?.h || 0,
    mime_type: mimeType,
  };
}

/** Keep Telegram-only presentation metadata inside attachments so the DB
 * schema and external IPC surface stay stable. Broadcast posts are visually
 * different from ordinary chat messages and may expose a discussion count. */
function getTelegramPostAttachment(message: any, peerType?: TelegramPeerType): Record<string, any> | null {
  const isBroadcastPost = message?.post === true || peerType === 'channel';
  if (!isBroadcastPost) return null;
  const replies = message?.replies as any;
  return {
    type: 'telegram_post',
    is_channel_post: true,
    post_author: String(message?.postAuthor || ''),
    views: Math.max(0, Number(message?.views || 0)),
    forwards: Math.max(0, Number(message?.forwards || 0)),
    comments: Math.max(0, Number(replies?.replies || 0)),
    recent_repliers: (replies?.recentRepliers || []).map((peer: any) => getCanonicalChatId(peer)).filter(Boolean),
    discussion_channel_id: replies?.channelId != null ? String(replies.channelId) : '',
    grouped_id: message?.groupedId != null ? String(message.groupedId) : '',
  };
}

function getTelegramGroupedMediaAttachment(message: any): Record<string, any> | null {
  if (message?.groupedId == null) return null;
  return { type: 'telegram_grouped_media', grouped_id: String(message.groupedId) };
}

/** Preserve custom-emoji entity ranges. Telegram includes a Unicode fallback
 * in message.message; the renderer uses these ranges without applying Zalo's
 * text-code conversion to that fallback. */
function getTelegramCustomEmojiAttachments(message: any): Record<string, any>[] {
  return (message?.entities || [])
    .filter((entity: any) => entity?.className === 'MessageEntityCustomEmoji')
    .map((entity: any) => ({
      type: 'custom_emoji',
      document_id: String(entity.documentId || ''),
      offset: Math.max(0, Number(entity.offset || 0)),
      length: Math.max(0, Number(entity.length || 0)),
    }))
    .filter((entity: any) => entity.document_id && entity.length > 0);
}

/** Keep native mention ranges so the renderer never has to guess from a raw @. */
function getTelegramMentionAttachments(message: any): Record<string, any>[] {
  return (message?.entities || [])
    .filter((entity: any) =>
      entity?.className === 'MessageEntityMentionName'
      || entity?.className === 'MessageEntityMention'
    )
    .map((entity: any) => {
      let rawUserId = entity?.userId?.userId ?? entity?.userId ?? '';
      if (rawUserId && typeof rawUserId === 'object' && typeof rawUserId.valueOf === 'function') {
        rawUserId = rawUserId.valueOf();
      }
      const userId = ['string', 'number', 'bigint'].includes(typeof rawUserId)
        ? String(rawUserId)
        : '';
      return {
        type: 'telegram_mention',
        offset: Math.max(0, Number(entity?.offset || 0)),
        length: Math.max(0, Number(entity?.length || 0)),
        user_id: userId,
      };
    })
    .filter((entity: any) => entity.length > 0);
}

/** Normalize Telegram media once for socket, difference and API-history paths.
 * GramJS exposes stickers/voice/GIF/video-note as documents too, so the
 * specialized getters must be checked before the generic document branch. */
function normalizeTelegramMessageMedia(message: any, peerType?: TelegramPeerType): {
  content: string;
  msgType: string;
  attachments: Record<string, any>[];
} {
  const attachments: Record<string, any>[] = [];
  const postAttachment = getTelegramPostAttachment(message, peerType);
  if (postAttachment) attachments.push(postAttachment);
  const groupedMediaAttachment = getTelegramGroupedMediaAttachment(message);
  if (groupedMediaAttachment) attachments.push(groupedMediaAttachment);
  attachments.push(...getTelegramCustomEmojiAttachments(message));
  attachments.push(...getTelegramMentionAttachments(message));

  let content = String(message?.message || message?.text || '');
  const sticker = getTelegramStickerAttachment(message);
  let msgType = 'text';
  const media = message?.media as any;
  const mediaClass = String(media?.className || '');

  if (message?.photo) {
    msgType = 'photo';
    const photo = message.photo as any;
    const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
    const largest = sizes[sizes.length - 1];
    attachments.push({
      type: 'photo', id: String(photo?.id || ''), dc_id: photo?.dcId,
      access_hash: String(photo?.accessHash || ''), width: largest?.w || 0,
      height: largest?.h || 0, file_size: largest?.size || 0,
    });
  } else if (sticker) {
    msgType = 'sticker';
    attachments.push(sticker);
  } else if (message?.videoNote) {
    msgType = 'video_note';
    const videoNote = message.videoNote as any;
    attachments.push({
      type: 'video_note', id: String(videoNote?.id || ''), dc_id: videoNote?.dcId,
      access_hash: String(videoNote?.accessHash || ''), duration: videoNote?.duration || 0,
      width: videoNote?.w || 0, height: videoNote?.h || 0, file_size: videoNote?.size || 0,
    });
  } else if (message?.voice) {
    msgType = 'audio';
    const voice = message.voice as any;
    attachments.push({
      type: 'voice', id: String(voice?.id || ''), dc_id: voice?.dcId,
      access_hash: String(voice?.accessHash || ''), duration: voice?.duration || 0,
      file_size: voice?.size || 0, mime_type: voice?.mimeType || '',
    });
  } else if (message?.audio) {
    msgType = 'audio';
    const audio = message.audio as any;
    attachments.push({
      type: 'audio', id: String(audio?.id || ''), dc_id: audio?.dcId,
      access_hash: String(audio?.accessHash || ''), duration: audio?.duration || 0,
      file_size: audio?.size || 0, mime_type: audio?.mimeType || '',
    });
  } else if (message?.gif) {
    msgType = 'video';
    const gif = message.gif as any;
    attachments.push({
      type: 'gif', id: String(gif?.id || ''), dc_id: gif?.dcId,
      access_hash: String(gif?.accessHash || ''), duration: gif?.duration || 0,
      width: gif?.w || 0, height: gif?.h || 0, file_size: gif?.size || 0,
      mime_type: gif?.mimeType || '',
    });
  } else if (message?.video) {
    msgType = 'video';
    const video = message.video as any;
    attachments.push({
      type: 'video', id: String(video?.id || ''), dc_id: video?.dcId,
      access_hash: String(video?.accessHash || ''), duration: video?.duration || 0,
      width: video?.w || 0, height: video?.h || 0, file_size: video?.size || 0,
      mime_type: video?.mimeType || '',
    });
  } else if (message?.document) {
    msgType = 'file';
    const document = message.document as any;
    const attributes = document?.attributes || [];
    const filename = attributes.find((attribute: any) =>
      attribute?.className === 'DocumentAttributeFilename'
    )?.fileName || document?.name || '';
    attachments.push({
      type: 'file', id: String(document?.id || ''), dc_id: document?.dcId,
      access_hash: String(document?.accessHash || ''), file_name: filename,
      name: filename, mime_type: document?.mimeType || '', file_size: document?.size || 0,
      fileSize: document?.size || 0,
    });
  } else if (mediaClass === 'MessageMediaWebPage') {
    const webpage = media?.webpage || {};
    msgType = 'telegram.webpage';
    content ||= String(webpage?.title || webpage?.description || webpage?.url || 'Liên kết');
    attachments.push({
      type: 'webpage', url: webpage?.url || '', display_url: webpage?.displayUrl || '',
      site_name: webpage?.siteName || '', title: webpage?.title || '',
      description: webpage?.description || '', author: webpage?.author || '',
    });
  } else if (mediaClass === 'MessageMediaContact') {
    msgType = 'telegram.contact';
    const displayName = [media?.firstName, media?.lastName].filter(Boolean).join(' ').trim();
    content ||= displayName || media?.phoneNumber || 'Liên hệ';
    attachments.push({
      type: 'contact', user_id: String(media?.userId || ''), name: displayName,
      phone: media?.phoneNumber || '', vcard: media?.vcard || '',
    });
  } else if (mediaClass === 'MessageMediaGeo' || mediaClass === 'MessageMediaGeoLive' || mediaClass === 'MessageMediaVenue') {
    const geo = media?.geo || {};
    msgType = mediaClass === 'MessageMediaVenue' ? 'telegram.venue' : 'telegram.location';
    content ||= mediaClass === 'MessageMediaVenue'
      ? [media?.title, media?.address].filter(Boolean).join(' — ') || 'Địa điểm'
      : mediaClass === 'MessageMediaGeoLive' ? 'Vị trí trực tiếp' : 'Vị trí';
    attachments.push({
      type: mediaClass === 'MessageMediaVenue' ? 'venue' : 'location',
      latitude: Number(geo?.lat || 0), longitude: Number(geo?.long || 0),
      title: media?.title || '', address: media?.address || '',
      live: mediaClass === 'MessageMediaGeoLive', period: Number(media?.period || 0),
    });
  } else if (mediaClass === 'MessageMediaPoll') {
    const poll = media?.poll || {};
    const question = String(poll?.question?.text || poll?.question || 'Bình chọn');
    msgType = 'telegram.poll';
    content ||= question;
    const resultByOption = new Map<string, any>();
    for (const result of media?.results?.results || []) {
      const key = Buffer.from(result?.option || []).toString('base64');
      resultByOption.set(key, result);
    }
    attachments.push({
      type: 'poll', id: String(poll?.id || ''), question,
      closed: !!poll?.closed, multiple_choice: !!poll?.multipleChoice, quiz: !!poll?.quiz,
      total_voters: Number(media?.results?.totalVoters || 0),
      answers: (poll?.answers || []).map((answer: any) => {
        const option = Buffer.from(answer?.option || []).toString('base64');
        const result = resultByOption.get(option);
        return {
          text: String(answer?.text?.text || answer?.text || ''), option,
          voters: Number(result?.voters || 0), chosen: !!result?.chosen, correct: !!result?.correct,
        };
      }),
    });
  } else if (mediaClass === 'MessageMediaDice') {
    msgType = 'telegram.dice';
    content ||= `${media?.emoticon || '🎲'} ${Number(media?.value || 0)}`;
    attachments.push({ type: 'dice', emoticon: media?.emoticon || '🎲', value: Number(media?.value || 0) });
  } else if (mediaClass === 'MessageMediaGame') {
    const game = media?.game || {};
    msgType = 'telegram.game';
    content ||= String(game?.title || game?.description || 'Trò chơi');
    attachments.push({ type: 'game', id: String(game?.id || ''), title: game?.title || '', description: game?.description || '' });
  } else if (mediaClass === 'MessageMediaInvoice') {
    msgType = 'telegram.invoice';
    content ||= String(media?.title || media?.description || 'Hóa đơn');
    attachments.push({
      type: 'invoice', title: media?.title || '', description: media?.description || '',
      currency: media?.currency || '', total_amount: String(media?.totalAmount || ''), test: !!media?.test,
    });
  } else if (mediaClass === 'MessageMediaStory') {
    msgType = 'telegram.story';
    content ||= 'Tin (Story)';
    attachments.push({ type: 'story', id: String(media?.id || ''), peer_id: String(media?.peer?.userId || media?.peer?.channelId || '') });
  } else if (mediaClass === 'MessageMediaGiveaway' || mediaClass === 'MessageMediaGiveawayResults') {
    msgType = 'telegram.giveaway';
    content ||= mediaClass === 'MessageMediaGiveawayResults' ? 'Kết quả giveaway' : 'Giveaway';
    attachments.push({
      type: 'giveaway', result: mediaClass === 'MessageMediaGiveawayResults',
      quantity: Number(media?.quantity || media?.winnersCount || 0),
      prize_description: media?.prizeDescription || '', until_date: Number(media?.untilDate || 0),
      stars: String(media?.stars || ''), months: Number(media?.months || 0),
    });
  } else if (mediaClass === 'MessageMediaPaidMedia') {
    msgType = 'telegram.paid_media';
    content ||= `Nội dung trả phí (${String(media?.starsAmount || 0)} Stars)`;
    attachments.push({ type: 'paid_media', stars_amount: String(media?.starsAmount || 0), items: Number(media?.extendedMedia?.length || 0) });
  } else if (mediaClass === 'MessageMediaUnsupported') {
    msgType = 'telegram.unsupported';
    content ||= 'Loại tin nhắn Telegram chưa được hỗ trợ';
    attachments.push({ type: 'unsupported', media_class: mediaClass });
  } else if (mediaClass && mediaClass !== 'MessageMediaEmpty') {
    msgType = 'telegram.unknown';
    content ||= `Tin nhắn Telegram (${mediaClass})`;
    attachments.push({ type: 'unknown', media_class: mediaClass });
    Logger.warn(
      `[TG:media] UNHANDLED account=${String(message?._clientAccountId || '') || 'unknown'} ` +
      `chatId=${deriveMessageIdentity(message).chatId || 'unknown'} msg=${String(message?.id || '') || 'unknown'} class=${mediaClass}`
    );
  }

  return { content, msgType, attachments };
}

/** Parse ReplyInlineMarkup from message into structured button rows */
function parseInlineButtons(message: any): Array<Array<{ text: string; type: 'url' | 'webview' | 'callback'; url?: string }>> | null {
  const replyMarkup = (message as any)?.replyMarkup;
  if (!replyMarkup || replyMarkup.className !== 'ReplyInlineMarkup') return null;

  const rows = replyMarkup.rows || [];
  return rows.map((row: any) => {
    const buttons = row.buttons || [];
    return buttons.map((btn: any) => {
      if (btn.className === 'KeyboardButtonUrl') {
        return { text: btn.text || '', type: 'url' as const, url: btn.url || '' };
      }
      if (btn.className === 'KeyboardButtonWebView') {
        return { text: btn.text || '', type: 'webview' as const, url: btn.url || '' };
      }
      if (btn.className === 'KeyboardButtonCallback') {
        return { text: btn.text || '', type: 'callback' as const };
      }
      // Other button types — render as text-only
      return { text: btn.text || btn.className || '', type: 'callback' as const };
    });
  });
}

// ─── Phase B: Identity derivation (peerId-first, no getChat dependency) ──────

/** Derive canonical chatId, threadType, and topicId from a message without
 *  requiring getChat() to succeed. peerId is authoritative for identity. */
function deriveMessageIdentity(message: any, resolvedEntity?: any): {
  chatId: string;
  threadType: number;
  topicId: string | undefined;
  peerKind: 'user' | 'chat' | 'channel';
} {
  const peerId = message?.peerId;
  let chatId = '';
  let peerKind: 'user' | 'chat' | 'channel' = 'user';

  if (peerId) {
    try {
      chatId = String(getPeerId(peerId));
    } catch {
      chatId = String(peerId?.userId ?? peerId?.chatId ?? peerId?.channelId ?? '');
    }
    if (peerId.className === 'PeerChannel' || String(chatId).startsWith('-100')) {
      peerKind = 'channel';
    } else if (peerId.className === 'PeerChat' || String(chatId).startsWith('-')) {
      peerKind = 'chat';
    }
  }

  // Fallback to resolved entity if peerId derivation failed
  if (!chatId && resolvedEntity) {
    chatId = getCanonicalChatId(resolvedEntity);
    if (resolvedEntity.className === 'Channel') peerKind = 'channel';
    else if (resolvedEntity.className === 'Chat') peerKind = 'chat';
  }

  // Last resort: message.id based fallback (should not happen for valid messages)
  if (!chatId) {
    chatId = String(message?.chatId ?? message?.peerId?.userId ?? '');
  }

  const threadType = peerKind === 'user' ? 0 : 1;
  const topicId = getForumTopicId(message);
  return { chatId, threadType, topicId, peerKind };
}

/** Persist a normalized message to DB idempotently.
 *  Returns { inserted: true } only when a NEW row was created.
 *  Callers must use this flag to gate unread increments, contact updates, and UI events. */
function persistTelegramMessage(
  db: DatabaseService,
  msg: {
    msgId: string; accountId: string; chatId: string; threadType: number;
    senderId: string; content: string; msgType: string; timestamp: number;
    isSelf: boolean; attachments: any[]; replyToId?: string; quoteData?: string;
    topicId?: string; reactions?: any; inlineButtons?: any;
  },
): ProcessResult {
  if (!msg.msgId || !msg.chatId) return { status: 'ignored' };

  tgDebugLog(`[TG:persist] msgId=${msg.msgId} msgType=${msg.msgType} isSelf=${msg.isSelf} attachments=${(msg.attachments || []).length}`);

  // Check if already exists
  const existing = db.queryOne<any>(
    `SELECT msg_id, attachments, content, msg_type, quote_data FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [msg.msgId, msg.accountId, msg.chatId],
  );
  if (existing) {
    tgDebugLog(`[TG:persist] DUPLICATE msgId=${msg.msgId} existing_attachments=${existing.attachments?.length || 0} new_attachments=${msg.attachments?.length || 0}`);
    // A replay may carry richer post/sticker/custom-emoji metadata than an
    // earlier history row. Merge it without repeating unread/UI side effects.
    let currentAttachments: any[] = [];
    try { currentAttachments = JSON.parse(existing.attachments || '[]'); } catch {}
    const merged = [...currentAttachments];
    for (const attachment of msg.attachments || []) {
      const identity = `${attachment?.type || ''}:${attachment?.id || attachment?.document_id || ''}:${attachment?.offset ?? ''}`;
      const index = merged.findIndex((item: any) =>
        `${item?.type || ''}:${item?.id || item?.document_id || ''}:${item?.offset ?? ''}` === identity
      );
      if (index >= 0) merged[index] = { ...merged[index], ...attachment };
      else merged.push(attachment);
    }
    db.run(
      `UPDATE messages SET attachments = ?, content = ?, msg_type = ?, reactions = CASE WHEN ? IS NOT NULL THEN ? ELSE reactions END,
                           reply_to_id = ?, quote_data = COALESCE(quote_data, ?),
                           topic_id = COALESCE(topic_id, ?)
       WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [
        JSON.stringify(merged),
        existing.content || msg.content,
        // Always update msg_type from socket echo (more accurate than sendFile's extension-based detection)
        msg.msgType || existing.msg_type,
        msg.reactions == null ? null : JSON.stringify(msg.reactions),
        msg.reactions == null ? null : JSON.stringify(msg.reactions),
        msg.replyToId || null,
        msg.quoteData || null,
        msg.topicId || null,
        msg.msgId, msg.accountId, msg.chatId,
      ],
    );
    // Return 'updated' if attachments were actually merged (so caller can emit event for UI)
    const hadAttachments = currentAttachments.length > 0;
    const newAttachments = (msg.attachments || []).length > 0;
    const mergeStatus = hadAttachments && newAttachments ? 'updated' : 'duplicate';
    tgDebugLog(`[TG:persist] MERGE_RESULT msgId=${msg.msgId} status=${mergeStatus} merged_count=${merged.length}`);
    return { status: mergeStatus, chatId: msg.chatId, messageId: msg.msgId };
  }

  try {
    db.run(`
      INSERT INTO messages
        (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, reactions, status, channel, reply_to_id, quote_data, topic_id, inline_buttons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'telegram_user', ?, ?, ?, ?)
    `, [
      msg.msgId, msg.accountId, msg.chatId, msg.threadType,
      msg.senderId, msg.content, msg.msgType, msg.timestamp,
      msg.isSelf ? 1 : 0, JSON.stringify(msg.attachments), JSON.stringify(msg.reactions || { total: 0, lastReact: '', emoji: {} }),
      msg.isSelf ? 'sent' : 'received',
      msg.replyToId || null, msg.quoteData || null, msg.topicId || null,
      msg.inlineButtons ? JSON.stringify(msg.inlineButtons) : null,
    ]);
    return { status: 'inserted', chatId: msg.chatId, messageId: msg.msgId };
  } catch (err: any) {
    // UNIQUE constraint = duplicate (race condition between socket + difference)
    if (err.message?.includes('UNIQUE')) {
      return { status: 'duplicate', chatId: msg.chatId, messageId: msg.msgId };
    }
    tgLog('error', msg.accountId, 'socket', `persist failed: ${err.message}`, { msgId: msg.msgId });
    return { status: 'failed', chatId: msg.chatId, messageId: msg.msgId };
  }
}

/** Initialize a raw Api.Message from channel-difference results so it can go
 *  through the standard handleNewMessage pipeline. Without this, getChat() and
 *  getSender() return undefined and the message is silently dropped (P0.1). */
function initializeRecoveredMessage(message: any, client: TelegramClient, entities: Map<any, any>): NewMessageEvent {
  const event = new NewMessageEvent(message, { _entities: entities } as any);
  (event as any)._setClient(client);
  return event;
}

/** Derive chatId from a raw message's peerId without any entity resolution.
 *  This is the fallback when even initialized messages can't resolve getChat(). */
function deriveChatIdFromRawMessage(message: any): string | undefined {
  const peerId = message?.peerId;
  if (!peerId) return undefined;
  try {
    return String(getPeerId(peerId));
  } catch {
    // Manual derivation for PeerUser/PeerChat/PeerChannel
    if (peerId.userId) return String(peerId.userId);
    if (peerId.chatId) return `-${peerId.chatId}`;
    if (peerId.channelId) return `-100${peerId.channelId}`;
    return undefined;
  }
}

// ─── Connection Management ───────────────────────────────────────────────────

/**
 * Start MTProto listener cho 1 tài khoản
 */
export async function startListener(account: TelegramUserAccount): Promise<{ success: boolean; error?: string }> {
  const existing = activeListeners.get(account.accountId);
  if (existing) {
    existing.account = account;
    existing.stopped = false;
    if (existing.connected && existing.client?.connected) {
      return { success: true };
    }
    if (existing.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
      existing.reconnectTimer = null;
    }
    try {
      await connectListener(existing);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  if (!API_ID || !API_HASH) {
    return { success: false, error: 'Telegram API credentials chưa được cấu hình. Liên hệ admin.' };
  }

  const listener: ActiveListener = {
    account,
    client: null,
    connected: false,
    reconnectTimer: null,
    healthTimer: null,
      channelPollTimer: null,
      connecting: null,
      healthCheckClient: null,
      transportDownSince: null,
      retryCount: 0,
      stopped: false,
  };
  activeListeners.set(account.accountId, listener);

  try {
    await connectListener(listener);
    return { success: true };
  } catch (err: any) {
    Logger.error(`[TelegramUserListener] Failed to start for ${account.accountId}: ${err.message}`);
    // Keep the listener registered: connectListener has scheduled recovery and
    // removing it here previously made a failed first connection permanent.
    return { success: false, error: err.message };
  }
}

function clearHealthCheck(listener: ActiveListener): void {
  if (listener.healthTimer) {
    clearInterval(listener.healthTimer);
    listener.healthTimer = null;
  }
  listener.healthCheckClient = null;
}

function isFatalTelegramSessionError(err?: unknown): boolean {
  const value = err as any;
  const message = String(value?.errorMessage || value?.message || value || '').toUpperCase();
  return [
    'AUTH_KEY_UNREGISTERED',
    'AUTH_KEY_DUPLICATED',
    'SESSION_REVOKED',
    'SESSION_EXPIRED',
    'USER_DEACTIVATED',
    'USER_DEACTIVATED_BAN',
  ].some(code => message.includes(code));
}

function markPrimaryConnectionRestored(
  listener: ActiveListener,
  client: TelegramClient,
  source: string,
): void {
  if (listener.stopped || listener.client !== client || !client.connected) return;
  if (listener.reconnectTimer) {
    clearTimeout(listener.reconnectTimer);
    listener.reconnectTimer = null;
  }
  const wasConnected = listener.connected;
  listener.connected = true;
  listener.transportDownSince = null;
  listener.retryCount = 0;
  startHealthCheck(listener);
  startChannelPoller(listener);
  if (!wasConnected) {
    EventBroadcaster.emit('event:connected', {
      zaloId: listener.account.accountId,
      accountInfo: { channel: 'telegram_user' },
    });
  }
  tgLog('info', listener.account.accountId, 'socket', 'PRIMARY_CONNECTION_RESTORED', { result: source });
  scheduleReconnectCatchUp(listener, client);
}

function scheduleReconnect(listener: ActiveListener, reason: string, err?: unknown): void {
  const wasConnected = listener.connected;
  listener.connected = false;
  listener.transportDownSince ??= Date.now();
  clearHealthCheck(listener);
  stopChannelPoller(listener);
  if (listener.stopped) return;

  if (isFatalTelegramSessionError(err)) {
    if (listener.reconnectTimer) {
      clearTimeout(listener.reconnectTimer);
      listener.reconnectTimer = null;
    }
    if (listener.client) {
      intentionallyDisconnectedClients.add(listener.client);
      listener.client.disconnect().catch(() => {});
    }
    Logger.error(`[TelegramUserListener] Session cannot reconnect for ${listener.account.accountId} (${reason})`);
    EventBroadcaster.emit('event:disconnected', {
      zaloId: listener.account.accountId,
      reason: 'session_invalid',
    });
    return;
  }
  if (listener.reconnectTimer) return;

  if (wasConnected) {
    EventBroadcaster.emit('event:disconnected', {
      zaloId: listener.account.accountId,
      reason,
    });
  }

  listener.retryCount++;
  const delay = Math.min(
    RECONNECT_DELAY_MS * Math.pow(2, Math.min(listener.retryCount - 1, 10)),
    MAX_RECONNECT_DELAY_MS,
  );
  Logger.log(`[TelegramUserListener] Reconnecting in ${delay}ms (attempt ${listener.retryCount}, ${reason})`);
  const reconnect = () => {
    listener.reconnectTimer = null;
    if (listener.stopped) return;
    const currentClient = listener.client;
    if (currentClient?.connected) {
      markPrimaryConnectionRestored(listener, currentClient, 'timer_transport_alive');
      return;
    }

    // GramJS first tries to reconnect its main sender in place. Do not destroy
    // that client mid-handshake; five connection attempts can legitimately take
    // close to a minute. If it remains stuck beyond the grace window, rebuild it.
    const senderReconnecting = !!(currentClient as any)?._sender?.isReconnecting;
    const downFor = Date.now() - (listener.transportDownSince || Date.now());
    if (senderReconnecting && downFor < PRIMARY_RECONNECT_GRACE_MS) {
      listener.reconnectTimer = setTimeout(reconnect, RECONNECT_DELAY_MS);
      return;
    }

    connectListener(listener).catch((err: any) => {
      Logger.warn(`[TelegramUserListener] Reconnect failed: ${err.message}`);
    });
  };
  listener.reconnectTimer = setTimeout(reconnect, delay);
}

function startHealthCheck(listener: ActiveListener): void {
  clearHealthCheck(listener);
  listener.healthTimer = setInterval(async () => {
    if (listener.stopped || !listener.client) return;
    const client = listener.client;
    if (listener.healthCheckClient) return;
    listener.healthCheckClient = client;
    try {
      if (!client.connected) throw new Error('MTProto transport disconnected');
      await client.getMe();
      if (listener.client !== client || listener.stopped) return;
      listener.connected = true;
      listener.retryCount = 0;
    } catch (err: any) {
      if (listener.client !== client || listener.stopped) return;
      Logger.warn(`[TelegramUserListener] Health check failed for ${listener.account.accountId}: ${err.message}`);
      scheduleReconnect(listener, 'health_check', err);
    } finally {
      if (listener.healthCheckClient === client) listener.healthCheckClient = null;
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function scheduleReconnectCatchUp(listener: ActiveListener, client: TelegramClient): void {
  const accountId = listener.account.accountId;
  if (reconnectCatchUps.has(accountId)) return;
  let retryNeeded = false;
  const task = (async () => {
    const idle = await waitForTelegramAccountSync(accountId, 30_000);
    if (!idle) {
      retryNeeded = true;
      return;
    }
    if (listener.client !== client || listener.stopped || !client.connected) return;
    const result = await synchronizeTelegramAccount(accountId, client);
    if (!result.success) {
      retryNeeded = true;
      Logger.warn(`[TelegramUserListener] Reconnect catch-up was deferred for ${accountId}`);
    }
  })().catch((err: any) => {
    Logger.warn(`[TelegramUserListener] Reconnect catch-up failed for ${accountId}: ${err.message}`);
  }).finally(() => {
    if (reconnectCatchUps.get(accountId) === task) reconnectCatchUps.delete(accountId);
    const current = activeListeners.get(accountId);
    if (
      current?.client &&
      (current.client !== client || retryNeeded) &&
      current.connected &&
      current.client.connected &&
      !current.stopped
    ) {
      setTimeout(() => scheduleReconnectCatchUp(current, current.client!), 1000);
    }
  });
  reconnectCatchUps.set(accountId, task);
}

// ─── Channel Poller (Phase D/E rewrite) ─────────────────────────────────────
// Channels/supergroups have independent PTS from the global message box.
// Socket updates are the primary realtime source; difference is for gap recovery.
// Short-poll is reserved for actively-viewed peers only (max 10/account).
//
// Phase D: Proper PTS state machine with commit-after-success.
// Phase E: Per-account+channel serialization, no global lock.

const CHANNEL_POLL_INTERVAL_MS = 15_000;
const ACTIVE_CHANNEL_LEASE_MS = 10 * 60_000;
const MAX_ACTIVE_CHANNELS_PER_ACCOUNT = 10;

/** Per-account channel poll serialization. Key: accountId */
const channelPollQueues = new Map<string, Promise<void>>();
type ChannelDifferenceResult = 'complete' | 'retry' | 'unavailable';

const channelDifferenceQueues = new Map<string, Promise<ChannelDifferenceResult>>();
/** Channels explicitly marked by a live PTS gap/server hint or a failed
 * reconnect recovery. This replaces the old arbitrary first-10 DB scan. */
// The value is the earliest PTS supplied by UpdateChannelTooLong. Telegram
// provides it specifically for a channel whose durable cursor is unavailable;
// keeping it is essential — querying GetFullChannel first would jump to the
// current cursor and silently discard the offline interval.
const pendingChannelRecoveries = new Map<string, Map<string, number>>();
const activeChannelLeases = new Map<string, Map<string, number>>();

function touchActiveChannel(accountId: string, channelId: string): void {
  if (!channelId.startsWith('-100')) return;
  const leases = activeChannelLeases.get(accountId) || new Map<string, number>();
  // Map insertion order acts as a small LRU.
  leases.delete(channelId);
  leases.set(channelId, Date.now() + ACTIVE_CHANNEL_LEASE_MS);
  while (leases.size > MAX_ACTIVE_CHANNELS_PER_ACCOUNT) {
    const oldest = leases.keys().next().value;
    if (!oldest) break;
    leases.delete(oldest);
  }
  activeChannelLeases.set(accountId, leases);
  const listener = activeListeners.get(accountId);
  if (listener?.client?.connected && !listener.stopped) {
    pollChannelUpdates(listener).catch(() => {});
  }
}

function markChannelRecoveryPending(accountId: string, channelId: string, suggestedPts = 0): void {
  const pending = pendingChannelRecoveries.get(accountId) || new Map<string, number>();
  const existingPts = pending.get(channelId) || 0;
  // When several hints arrive while offline, start from the earliest known
  // cursor. A later PTS can only skip a larger part of the missed interval.
  const nextPts = suggestedPts > 0 && existingPts > 0
    ? Math.min(existingPts, suggestedPts)
    : (suggestedPts || existingPts);
  pending.set(channelId, nextPts);
  pendingChannelRecoveries.set(accountId, pending);
}

function clearChannelRecoveryPending(accountId: string, channelId: string): void {
  const pending = pendingChannelRecoveries.get(accountId);
  if (!pending) return;
  pending.delete(channelId);
  if (pending.size === 0) pendingChannelRecoveries.delete(accountId);
}

function requestChannelRecovery(listener: ActiveListener, channelId: string, reason: string, suggestedPts = 0): void {
  markChannelRecoveryPending(listener.account.accountId, channelId, suggestedPts);
  // tgLog('warn', listener.account.accountId, 'channel_difference', `Recovery requested for ${channelId}`, { reason });
  if (recoveringUpdateAccounts.has(listener.account.accountId)) return;
  pollChannelUpdates(listener).catch((err: any) => {
    // tgLog('warn', listener.account.accountId, 'channel_difference', `Recovery queue failed: ${err.message}`, { chatId: channelId });
  });
}

function startChannelPoller(listener: ActiveListener): void {
  if (listener.channelPollTimer) clearInterval(listener.channelPollTimer);
  listener.channelPollTimer = setInterval(() => {
    if (listener.stopped || !listener.client?.connected) return;
    pollChannelUpdates(listener).catch(() => {});
  }, CHANNEL_POLL_INTERVAL_MS);
}

function stopChannelPoller(listener: ActiveListener): void {
  if (listener.channelPollTimer) {
    clearInterval(listener.channelPollTimer);
    listener.channelPollTimer = null;
  }
  // Clean up in-flight queue for this account
  channelPollQueues.delete(listener.account.accountId);
}

/** Phase E: Serialize channel polls per account — no global lock. */
async function pollChannelUpdates(listener: ActiveListener): Promise<void> {
  const accountId = listener.account.accountId;
  // Per-account serialization: skip if previous poll for this account is still running
  const existing = channelPollQueues.get(accountId);
  if (existing) return;

  const task = pollChannelUpdatesNow(listener);
  channelPollQueues.set(accountId, task);
  try {
    await task;
  } finally {
    if (channelPollQueues.get(accountId) === task) channelPollQueues.delete(accountId);
  }
}

async function pollChannelUpdatesNow(listener: ActiveListener): Promise<void> {
  const accountId = listener.account.accountId;
  const client = listener.client;
  if (!client) return;

  const db = DatabaseService.getInstance();
  if (!db) return;
  const { Api } = require('telegram');

  try {
    const now = Date.now();
    const leases = activeChannelLeases.get(accountId);
    if (leases) {
      for (const [channelId, expiresAt] of leases) {
        if (expiresAt <= now) leases.delete(channelId);
      }
    }
    const channelIds = [...new Set([
      ...(pendingChannelRecoveries.get(accountId)?.keys() || []),
      ...(leases?.keys() || []),
    ])];
    if (channelIds.length === 0) return;

    for (const channelId of channelIds) {
      if (listener.stopped || !listener.client?.connected) break;
      const peer = db.getTelegramPeer(accountId, channelId);
      const accessHash = peer?.access_hash;
      if (!accessHash) continue;
      const pts = db.getTelegramChannelPts(accountId, channelId)
        || pendingChannelRecoveries.get(accountId)?.get(channelId)
        || 0;
      if (pts <= 0) {
        // Older installations may have message rows but no per-channel PTS.
        // A bare UpdateChannelTooLong has no safe PTS seed, so use a bounded
        // history replay instead of writing ChannelFull.pts and losing it.
        if (pendingChannelRecoveries.get(accountId)?.has(channelId)) {
          const history = await backfillUnseededChannelHistory(accountId, client, channelId, peer.access_hash);
          if (!history.failed && history.complete) clearChannelRecoveryPending(accountId, channelId);
        }
        continue;
      }

      try {
        const recovered = await drainChannelDifference(accountId, client, channelId, accessHash, pts, 'channel_difference');
        if (recovered === 'complete' || recovered === 'unavailable') {
          clearChannelRecoveryPending(accountId, channelId);
        } else {
          markChannelRecoveryPending(accountId, channelId, pts);
        }
      } catch (err: any) {
        if (err.message?.includes('FLOOD_WAIT')) {
          const waitMatch = err.message.match(/(\d+)/);
          const waitSec = waitMatch ? parseInt(waitMatch[1]) : 30;
          tgLog('warn', accountId, 'poll', `FLOOD_WAIT ${waitSec}s for channel ${channelId}`);
          break; // Stop polling remaining channels
        }
        tgLog('warn', accountId, 'poll', `Channel ${channelId} error: ${err.message}`);
      }
    }
  } catch (err: any) {
    tgLog('warn', accountId, 'poll', `pollChannelUpdates error: ${err.message}`);
  }
}

// ─── Phase D: Per-channel PTS drain (commit-after-success) ──────────────────

/** Drain channel difference for a single channel. Handles all three result
 *  variants (Empty/Difference/TooLong), respects final flag, and only commits
 *  PTS after successful processing of the entire batch. */
async function drainChannelDifference(
  accountId: string,
  client: TelegramClient,
  channelId: string,
  accessHash: string,
  startingPts: number,
  source: TelegramIngressSource,
): Promise<ChannelDifferenceResult> {
  const queueKey = `${accountId}:${channelId}`;
  const existing = channelDifferenceQueues.get(queueKey);
  if (existing) return existing;
  const task = drainChannelDifferenceNow(accountId, client, channelId, accessHash, startingPts, source);
  channelDifferenceQueues.set(queueKey, task);
  try {
    return await task;
  } finally {
    if (channelDifferenceQueues.get(queueKey) === task) channelDifferenceQueues.delete(queueKey);
  }
}

/**
 * `channelDifferenceTooLong` means the PTS interval can no longer be obtained
 * as normal updates. Before accepting its newest snapshot, replay the bounded
 * message-ID range after our durable checkpoint. Otherwise committing
 * dialog.pts would turn every older missed message into a permanent gap.
 */
async function backfillChannelTooLongHistory(
  accountId: string,
  client: TelegramClient,
  inputChannel: any,
  channelId: string,
  entities: Map<any, any>,
  includeInitialSnapshot = false,
): Promise<{ complete: boolean; failed: boolean }> {
  const db = DatabaseService.getInstance();
  if (!db) return { complete: false, failed: true };

  const checkpoint = db.queryOne<{ lastMessageId?: number }>(
    `SELECT MAX(CAST(msg_id AS INTEGER)) AS lastMessageId
     FROM messages
     WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [accountId, channelId],
  );
  const minId = Number(checkpoint?.lastMessageId || 0);
  try {
    const messages: any[] = [];
    if (minId <= 0) {
      // The only safe option without a checkpoint is a bounded first load.
      // `channelDifferenceTooLong` already supplies such a snapshot, whereas
      // a bare UpdateChannelTooLong needs us to request one explicitly.
      if (!includeInitialSnapshot) return { complete: true, failed: false };
      messages.push(...await client.getMessages(inputChannel, { limit: INITIAL_MESSAGES_PER_DIALOG }));
      messages.sort((a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0));
    } else {
      for await (const message of client.iterMessages(inputChannel, {
        minId,
        limit: RECOVERY_MESSAGES_PER_DIALOG,
        // Advance the durable checkpoint in order; if capped, the next pass
        // continues from the oldest unprocessed message rather than skipping it.
        reverse: true,
      })) {
        messages.push(message);
      }
    }
    if (messages.length > 0) {
      await processDifferenceMessages(accountId, client, messages, entities, 'history');
    }
    return {
      complete: minId <= 0 || messages.length < RECOVERY_MESSAGES_PER_DIALOG,
      failed: false,
    };
  } catch (err: any) {
    tgLog('warn', accountId, 'channel_difference', `TooLong history backfill failed for ${channelId}: ${err.message}`);
    return { complete: false, failed: true };
  }
}

async function backfillUnseededChannelHistory(
  accountId: string,
  client: TelegramClient,
  channelId: string,
  accessHash: string,
): Promise<{ complete: boolean; failed: boolean }> {
  const { Api } = require('telegram');
  const inputChannel = new Api.InputChannel({
    channelId: BigInt(String(channelId).replace(/^-100/, '')),
    accessHash: BigInt(accessHash),
  });
  const entities = new Map<any, any>();
  try {
    const entity = await resolvePeerEntity(accountId, client, channelId);
    if (entity) {
      entities.set(getPeerId(entity), entity);
      cacheTelegramPeer(accountId, channelId, entity);
    }
  } catch {}
  return backfillChannelTooLongHistory(
    accountId,
    client,
    inputChannel,
    channelId,
    entities,
    true,
  );
}

async function drainChannelDifferenceNow(
  accountId: string,
  client: TelegramClient,
  channelId: string,
  accessHash: string,
  startingPts: number,
  source: TelegramIngressSource,
): Promise<ChannelDifferenceResult> {
  const { Api } = require('telegram');
  const db = DatabaseService.getInstance();
  if (!db) return 'retry';

  const numericId = String(channelId).replace(/^-100/, '');
  const inputChannel = new Api.InputChannel({
    channelId: BigInt(numericId),
    accessHash: BigInt(accessHash),
  });

  let currentPts = startingPts;
  const MAX_SLICES = 10; // Safety limit to prevent infinite drain loops

  for (let slice = 0; slice < MAX_SLICES; slice++) {
    let diff: any;
    try {
      diff = await client.invoke(new Api.updates.GetChannelDifference({
        channel: inputChannel,
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts: currentPts,
        limit: 100,
        force: false,
      }));
    } catch (err: any) {
      // These errors are terminal for this peer. Keeping them in the pending
      // queue makes reconnect/poll spam forever after the user leaves a group.
      const unavailable = /CHANNEL_(?:PRIVATE|INVALID)|USER_BANNED_IN_CHANNEL/.test(err.message || '');
      if (!unavailable) {
        tgLog('warn', accountId, source, `getChannelDifference failed for ${channelId}: ${err.message}`);
      }
      return unavailable ? 'unavailable' : 'retry'; // Don't commit PTS on failure
    }

    // ── ChannelDifferenceEmpty: no new updates ────────────────────────
    if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
      // P1.2 fix: commit PTS from ChannelDifferenceEmpty
      const emptyPts = Number((diff as any).pts || 0);
      if (emptyPts > 0) {
        db.saveTelegramChannelPts(accountId, channelId, emptyPts);
      }
      // tgLog('info', accountId, source, `ChannelDifferenceEmpty for ${channelId}`, { pts: emptyPts });
      return 'complete';
    }

    // ── ChannelDifferenceTooLong: snapshot, use dialog.pts ────────────
    if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
      tgLog('warn', accountId, source, `ChannelDifferenceTooLong for ${channelId}`);
      const entities = cacheDifferenceEntities(accountId, diff.users || [], diff.chats || []);
      // Telegram cannot return the old PTS interval here. Fill it by message
      // ID first; do not process/commit the newest snapshot until that bounded
      // range is complete, or its high IDs would hide the remaining gap.
      const history = await backfillChannelTooLongHistory(
        accountId,
        client,
        inputChannel,
        channelId,
        entities,
      );
      if (history.failed || !history.complete) {
        return 'retry';
      }

      // Process the server's latest snapshot before committing its cursor.
      const messages = diff.messages || [];
      let failedCount = 0;
      for (const msg of messages) {
        try {
          const event = initializeRecoveredMessage(msg, client, entities);
          const result = await handleNewMessage(accountId, event, client, source);
          if (result.status === 'failed') failedCount++;
        } catch (err: any) {
          failedCount++;
          tgLog('warn', accountId, source, `TooLong msg failed: ${err.message}`, { msgId: String(msg?.id) });
        }
      }

      // P0.3 fix: PTS comes from dialog.pts, NOT diff.pts
      const dialogPts = Number((diff as any).dialog?.pts || 0);
      if (dialogPts > 0 && failedCount === 0) {
        db.saveTelegramChannelPts(accountId, channelId, dialogPts);
        tgLog('info', accountId, source, `TooLong committed dialog.pts=${dialogPts} for ${channelId}`);
      } else if (failedCount > 0) {
        tgLog('warn', accountId, source, `TooLong: ${failedCount} msgs failed, NOT committing PTS for ${channelId}`);
      }
      return failedCount === 0 && dialogPts > 0 ? 'complete' : 'retry';
    }

    // ── ChannelDifference: normal incremental update ──────────────────
    if (diff instanceof Api.updates.ChannelDifference) {
      // Cache entities first
      const entities = cacheDifferenceEntities(accountId, diff.users || [], diff.chats || []);

      // Process new messages — initialize with entities so getChat() works
      const messages = (diff as any).newMessages || [];
      let failedCount = 0;
      for (const msg of messages) {
        try {
          const event = initializeRecoveredMessage(msg, client, entities);
          const result = await handleNewMessage(accountId, event, client, source);
          if (result.status === 'failed') failedCount++;
        } catch (err: any) {
          failedCount++;
          tgLog('warn', accountId, source, `Difference msg failed: ${err.message}`, { msgId: String(msg?.id) });
        }
      }

      // Process otherUpdates (edits, deletes, reactions, etc.)
      const rawHandler = rawUpdateHandlers.get(accountId);
      if (rawHandler) {
        for (const update of diff.otherUpdates || []) {
          try {
            await rawHandler(update);
          } catch (err: any) {
            failedCount++;
            tgLog('warn', accountId, source, `otherUpdate failed: ${err.message}`);
          }
        }
      }

      // P0.2 fix: Only commit PTS after ALL items processed successfully
      const newPts = Number((diff as any).pts || 0);
      if (failedCount === 0 && newPts > 0) {
        db.saveTelegramChannelPts(accountId, channelId, newPts);
        currentPts = newPts;
        // tgLog('info', accountId, source, `ChannelDifference committed pts=${newPts} for ${channelId}`, {
        //   msgs: messages.length,
        //   otherUpdates: (diff.otherUpdates || []).length,
        // });
      } else if (failedCount > 0) {
        // tgLog('warn', accountId, source, `ChannelDifference: ${failedCount} failed, NOT committing PTS for ${channelId}`);
        return 'retry'; // Don't continue draining on failure
      } else {
        // tgLog('warn', accountId, source, `ChannelDifference returned invalid PTS for ${channelId}`);
        return 'retry';
      }

      // If final=false, drain more slices immediately
      if (!(diff as any).final) {
        tgLog('info', accountId, source, `final=false for ${channelId}, draining next slice`);
        continue;
      }

      // final=true — done
      return 'complete';
    }

    // Unknown difference type
    tgLog('warn', accountId, source, `Unknown diff type for ${channelId}: ${diff?.className}`);
    return 'retry';
  }

  tgLog('warn', accountId, source, `Drain slice limit reached for ${channelId}`);
  return 'retry';
}

async function connectListener(listener: ActiveListener): Promise<void> {
  if (listener.connecting) return listener.connecting;
  const connecting = connectListenerNow(listener);
  listener.connecting = connecting;
  try {
    await connecting;
  } finally {
    if (listener.connecting === connecting) listener.connecting = null;
  }
}

async function connectListenerNow(listener: ActiveListener): Promise<void> {
  const { account } = listener;

  // Cleanup old client before creating new one
  const previousClient = listener.client;
  if (previousClient) {
    intentionallyDisconnectedClients.add(previousClient);
    listener.client = null;
    try { await previousClient.disconnect(); } catch {}
  }
  clearHealthCheck(listener);
  stopChannelPoller(listener);

  const stringSession = new StringSession(account.stringSession);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  listener.client = client;

  try {
    const transportConnected = await client.connect();
    if (!transportConnected && !client.connected) {
      throw new Error('MTProto transport failed to connect');
    }
    // stopListener may have run while the transport handshake was in flight.
    if (listener.stopped) {
      intentionallyDisconnectedClients.add(client);
      try { await client.disconnect(); } catch {}
      return;
    }

    // A live TCP transport is not enough to mark an account online. This
    // authorized request catches revoked/expired sessions before timers and UI
    // are started for a client that cannot actually receive account updates.
    await client.getMe();
    if (listener.stopped || listener.client !== client) {
      intentionallyDisconnectedClients.add(client);
      try { await client.disconnect(); } catch {}
      return;
    }
    listener.connected = true;
    listener.transportDownSince = null;
    listener.retryCount = 0;
    listener.stopped = false;

    const { Api } = require('telegram');
    const { UpdateConnectionState } = require('telegram/network');

    // Exported media senders do not use this update callback. Therefore these
    // state events represent the primary account sender, not the expected
    // 30-second idle disconnect of a file-download DC.
    client.addEventHandler(async (stateUpdate: any) => {
      if (
        intentionallyDisconnectedClients.has(client) ||
        listener.stopped ||
        listener.client !== client
      ) return;

      const state = Number(stateUpdate?.state);
      tgLog(state === UpdateConnectionState.connected ? 'info' : 'warn', account.accountId, 'socket', 'CONNECTION_STATE', {
        result: state === UpdateConnectionState.connected
          ? 'connected'
          : state === UpdateConnectionState.broken
            ? 'broken'
            : 'disconnected',
      });

      if (state === UpdateConnectionState.connected) {
        markPrimaryConnectionRestored(listener, client, 'gramjs_auto_reconnect');
        return;
      }

      scheduleReconnect(
        listener,
        state === UpdateConnectionState.broken ? 'transport_broken' : 'transport_disconnected',
      );
    }, new Raw({ types: [UpdateConnectionState] }));

    // Diagnostic ingress probe: register BEFORE the high-level NewMessage
    // builder so we can distinguish "Telegram did not send the update" from
    // "the builder/handler stalled or rejected it". This handler is read-only
    // and intentionally logs no message content or access hash.
    client.addEventHandler(async (update: any) => {
      try {
        const message = update?.message;
        let chatId = message ? deriveChatIdFromRawMessage(message) : undefined;
        if (!chatId && update instanceof Api.UpdateChannelTooLong && update.channelId != null) {
          chatId = `-100${String(update.channelId)}`;
        }
        const localPts = chatId?.startsWith('-100')
          ? DatabaseService.getInstance()?.getTelegramChannelPts(account.accountId, chatId)
          : undefined;
        tgLog('info', account.accountId, 'socket', `RAW_RECEIVED ${update?.className || update?.constructor?.name || 'unknown'}`, {
          msgClass: message?.className || '-',
          mediaClass: message?.media?.className || '-',
          chatId: chatId || '-',
          msgId: message?.id != null ? String(message.id) : '-',
          pts: update?.pts,
          ptsCount: update?.ptsCount,
          localPts,
          replyToMsgId: message?.replyTo?.replyToMsgId,
          replyToTopId: message?.replyTo?.replyToTopId,
          forumTopic: message?.replyTo?.forumTopic === true,
        });
      } catch (err: any) {
        tgLog('warn', account.accountId, 'socket', `RAW_RECEIVED diagnostic failed: ${err.message}`);
      }
    }, new Raw({
      types: [
        Api.UpdateNewMessage,
        Api.UpdateNewChannelMessage,
        Api.UpdateShortMessage,
        Api.UpdateShortChatMessage,
        Api.UpdateChannelTooLong,
        Api.UpdatesTooLong,
      ].filter(Boolean),
    }));

    // Listen for new messages (socket — primary realtime source)
    // Authoritative live channel ingress. The high-level NewMessage builder
    // remains an idempotent fallback for normal messages.
    client.addEventHandler(async (update: any) => {
      if (update instanceof Api.UpdateChannelTooLong) {
        if (update.channelId != null) {
          requestChannelRecovery(
            listener,
            `-100${String(update.channelId)}`,
            'UpdateChannelTooLong',
            Number((update as any).pts || 0),
          );
        }
        return;
      }
      if (!(update instanceof Api.UpdateNewChannelMessage)) return;

      const message = update.message as any;
      const chatId = deriveChatIdFromRawMessage(message);
      if (!message || !chatId) {
        throw new Error('UpdateNewChannelMessage has no canonical channel identity');
      }

      const db = DatabaseService.getInstance();
      if (!db) throw new Error('Database is unavailable for live channel update');
      const previousPts = db.getTelegramChannelPts(account.accountId, chatId);
      const nextPts = Number(update.pts || 0);
      const ptsCount = Math.max(1, Number(update.ptsCount || 1));
      const hasDurableMessageWithoutCursor = previousPts <= 0 && !!db.queryOne(
        `SELECT 1 FROM messages
         WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
         LIMIT 1`,
        [account.accountId, chatId],
      );
      const hasPtsGap = previousPts > 0 && previousPts + ptsCount < nextPts;
      // Detect recovery before persisting this high-ID message. In particular,
      // if Telegram later answers ChannelDifferenceTooLong, a persisted newest
      // message would make history recovery start after the missing interval.
      if (hasDurableMessageWithoutCursor || hasPtsGap) {
        requestChannelRecovery(
          listener,
          chatId,
          hasPtsGap
            ? `pts_gap:${previousPts}->${nextPts}/${ptsCount}`
            : 'missing_channel_pts_with_history',
        );
        return;
      }
      const entities = (message as any)._entities instanceof Map
        ? (message as any)._entities
        : new Map<any, any>();
      const event = initializeRecoveredMessage(message, client, entities);
      const result = await handleNewMessage(account.accountId, event, client, 'socket');

      if (result.status === 'failed') {
        throw new Error(`Live channel message ${String(message.id)} failed persistence`);
      }
      if (nextPts > previousPts) {
        db.saveTelegramChannelPts(account.accountId, chatId, nextPts);
        tgLog('info', account.accountId, 'socket', `CURSOR_COMMITTED ${chatId}`, {
          previousPts,
          pts: nextPts,
          ptsCount,
          result: result.status,
        });
      }
    }, new Raw({ types: [Api.UpdateNewChannelMessage, Api.UpdateChannelTooLong] }));

    client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        const message = event?.message as any;
        tgLog('info', account.accountId, 'socket', 'BUILDER_RECEIVED NewMessage', {
          msgClass: message?.className || '-',
          mediaClass: message?.media?.className || '-',
          chatId: deriveChatIdFromRawMessage(message) || '-',
          msgId: message?.id != null ? String(message.id) : '-',
          replyToMsgId: message?.replyTo?.replyToMsgId,
          replyToTopId: message?.replyTo?.replyToTopId,
          forumTopic: message?.replyTo?.forumTopic === true,
        });
        await handleNewMessage(account.accountId, event, client, 'socket');
      } catch (err: any) {
        tgLog('error', account.accountId, 'socket', `Error handling message: ${err.message}`);
      }
    }, new NewMessage({}));

    // Listen for edited messages via Raw event (UpdateEditMessage)
    const rawUpdateHandler = async (update: any) => {
      try {
        const db = DatabaseService.getInstance();
        if (!db) return;
        let msgId: string | undefined;
        let newText: string | undefined;
        let chatId: string | undefined;

        if (update instanceof Api.UpdateChannelTooLong) {
          if (update.channelId != null) {
            requestChannelRecovery(
              listener,
              `-100${String(update.channelId)}`,
              'difference_UpdateChannelTooLong',
              Number((update as any).pts || 0),
            );
          }
          return;
        }

        if (update instanceof Api.UpdateFolderPeers) {
          for (const folderPeer of update.folderPeers || []) {
            const folderChatId = getCanonicalChatId(folderPeer.peer);
            const folderId = Number(folderPeer.folderId || 0);
            if (!folderChatId) continue;
            db.run(
              `UPDATE contacts SET telegram_folder_id = ?, telegram_archived = ?, is_in_others = ?, telegram_state_updated_at = ?
               WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
              [folderId, folderId === 1 ? 1 : 0, folderId === 1 ? 1 : 0, Date.now(), account.accountId, folderChatId],
            );
          }
          EventBroadcaster.emit('db:unreadChanged', { zaloId: account.accountId, source: 'telegram_folder_update' });
          return;
        }

        if (update instanceof Api.UpdateNotifySettings && update.peer?.className === 'NotifyPeer') {
          const notifyChatId = getCanonicalChatId(update.peer.peer);
          const muteUntil = Number(update.notifySettings?.muteUntil || 0);
          if (notifyChatId) {
            const foreverMuted = muteUntil >= 2147483647;
            const muteUntilMs = muteUntil > 0 && !foreverMuted ? muteUntil * 1000 : 0;
            db.run(
              `UPDATE contacts SET is_muted = ?, mute_until = ?, telegram_state_updated_at = ?
               WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
              [foreverMuted ? 1 : 0, muteUntilMs, Date.now(), account.accountId, notifyChatId],
            );
            EventBroadcaster.emit('db:unreadChanged', { zaloId: account.accountId, source: 'telegram_notify_update' });
          }
          return;
        }

        if (update instanceof Api.UpdateChatDefaultBannedRights) {
          const rightsChatId = getCanonicalChatId(update.peer);
          if (rightsChatId) getGroupInfo(account.accountId, rightsChatId).catch(() => {});
          return;
        }

        if (update instanceof Api.UpdateUserTyping) {
          const userId = String(update.userId);
          await hydrateTelegramTypingIdentity(account.accountId, client, userId, userId);
          EventBroadcaster.emit('event:typing', {
            zaloId: account.accountId,
            threadId: userId,
            userId,
            channel: 'telegram_user',
          });
          return;
        }

        if (update instanceof Api.UpdateChatUserTyping) {
          const userId = getCanonicalChatId(update.fromId);
          const typingChatId = `-${String(update.chatId)}`;
          await hydrateTelegramTypingIdentity(account.accountId, client, userId, typingChatId);
          EventBroadcaster.emit('event:typing', {
            zaloId: account.accountId,
            threadId: typingChatId,
            userId,
            channel: 'telegram_user',
          });
          return;
        }

        if (update instanceof Api.UpdateChannelUserTyping) {
          const userId = getCanonicalChatId(update.fromId);
          const typingChatId = `-100${String(update.channelId)}`;
          await hydrateTelegramTypingIdentity(account.accountId, client, userId, typingChatId);
          EventBroadcaster.emit('event:typing', {
            zaloId: account.accountId,
            threadId: typingChatId,
            userId,
            topicRootMessageId: update.topMsgId ? String(update.topMsgId) : undefined,
            channel: 'telegram_user',
          });
          return;
        }

        if (update instanceof Api.UpdateMessageReactions) {
          const chatId = getCanonicalChatId(update.peer);
          const msgId = String(update.msgId || '');
          if (!chatId || !msgId) return;
          const reactions = normalizeTelegramReactions(update.reactions, account.accountId);
          for (const recent of update.reactions?.recentReactions || []) {
            const reactorId = getCanonicalChatId(recent?.peerId);
            if (reactorId && !reactorId.startsWith('-')) {
              hydrateTelegramIdentity(account.accountId, client, reactorId, chatId).catch(() => {});
            }
          }
          db.run(
            'UPDATE messages SET reactions = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = \'telegram_user\'',
            [JSON.stringify(reactions), msgId, account.accountId, chatId],
          );
          EventBroadcaster.emit('event:telegramReaction', {
            zaloId: account.accountId,
            threadId: chatId,
            msgId,
            topicRootMessageId: update.topMsgId ? String(update.topMsgId) : undefined,
            reactions,
          });
          return;
        }

        // Channel reactions (UpdateChannelMessageReactions)
        if ((update as any).className === 'UpdateChannelMessageReactions' ||
            (update as any).CONSTRUCTOR_ID === 0xc2db42ae) {
          const channelId = (update as any).channelId;
          const msgId = String((update as any).topMsgId || (update as any).msgId || '');
          if (!channelId || !msgId) return;
          const chatId = `-100${String(channelId)}`;
          const reactions = normalizeTelegramReactions((update as any).reactions, account.accountId);
          db.run(
            'UPDATE messages SET reactions = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = \'telegram_user\'',
            [JSON.stringify(reactions), msgId, account.accountId, chatId],
          );
          EventBroadcaster.emit('event:telegramReaction', {
            zaloId: account.accountId,
            threadId: chatId,
            msgId,
            reactions,
          });
          return;
        }

        if (update instanceof Api.UpdateEditMessage) {
          const msg = update.message;
          if (!msg) return;
          msgId = String(msg.id);
          newText = (msg as any).message || (msg as any).text || '';
          // Extract chat ID from peer
          const peerId = (msg as any).peerId;
          if (peerId) chatId = getCanonicalChatId(peerId);
        } else if (update instanceof Api.UpdateEditChannelMessage) {
          const msg = update.message;
          if (!msg) return;
          msgId = String(msg.id);
          newText = (msg as any).message || (msg as any).text || '';
          const peerId = (msg as any).peerId;
          if (peerId) chatId = getCanonicalChatId(peerId);
        }

        if (msgId && newText !== undefined) {
          if (chatId) {
            // Build edit_history from current content (giống Facebook handler)
            const existingMsg = db.queryOne<any>(
              `SELECT content, edit_history FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
              [msgId, account.accountId, chatId]
            );
            let editHistory: any[] = [];
            if (existingMsg?.edit_history) {
              try { editHistory = JSON.parse(existingMsg.edit_history); } catch { editHistory = []; }
            }
            const contentChanged = existingMsg?.content && existingMsg.content !== newText;
            if (contentChanged) {
              editHistory.push({ oldBody: existingMsg.content, editedAt: Date.now(), editCount: editHistory.length + 1 });
            }
            // Only set is_edited=1 when content ACTUALLY changed (reaction updates don't change content)
            db.run(
              `UPDATE messages SET content = ?, is_edited = ?, edit_history = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
              [newText, contentChanged ? 1 : 0, JSON.stringify(editHistory), msgId, account.accountId, chatId]
            );
          }
          EventBroadcaster.emit('event:messageEdited', {
            zaloId: account.accountId,
            msgId,
            newText,
            threadId: chatId,
          });
          Logger.log(`[TelegramUserListener] Message edited: ${msgId}`);
        }

        // Handle deleted messages (thu hồi)
        if (update instanceof Api.UpdateDeleteMessages || update instanceof Api.UpdateDeleteChannelMessages) {
          const ids = update.messages || [];
          // Channel message IDs are scoped to their channel. Never mark an
          // equal ID in another Telegram channel as deleted.
          const deletedThreadId = update instanceof Api.UpdateDeleteChannelMessages && update.channelId != null
            ? `-100${String(update.channelId)}`
            : undefined;
          for (const id of ids) {
            const msgIdStr = String(id);
            // Lưu recalled_content trước khi đánh dấu thu hồi
            const scope = deletedThreadId
              ? `msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`
              : `msg_id = ? AND owner_zalo_id = ? AND channel = 'telegram_user'`;
            const scopeParams = deletedThreadId
              ? [msgIdStr, account.accountId, deletedThreadId]
              : [msgIdStr, account.accountId];
            const existingMsg = db.queryOne<any>(
              `SELECT content FROM messages WHERE ${scope}`, scopeParams
            );
            const recalledContent = existingMsg?.content || null;
            Logger.log(`[TelegramUserListener] Recall msg ${msgIdStr}: content="${(recalledContent || '').slice(0, 100)}" scope=${scope} deletedThreadId=${deletedThreadId || 'none'}`);
            if (deletedThreadId) {
              db.run(
                `UPDATE messages SET msg_type = 'recalled', status = 'recalled', is_recalled = 1, recalled_content = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
                [recalledContent, msgIdStr, account.accountId, deletedThreadId]
              );
            } else {
              db.run(
                `UPDATE messages SET msg_type = 'recalled', status = 'recalled', is_recalled = 1, recalled_content = ? WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'telegram_user'`,
                [recalledContent, msgIdStr, account.accountId]
              );
            }
          }
          if (ids.length > 0) {
            EventBroadcaster.emit('event:messagesDeleted', {
              zaloId: account.accountId,
              messageIds: ids.map(String),
              threadId: deletedThreadId,
            });
          }
        }

        // ── Read history (inbox = other party read our messages) ─────────────
        if (update instanceof Api.UpdateReadHistoryInbox) {
          try {
            const peer = (update as any).peer;
            const maxId = String(update.maxId || '');
            if (peer && maxId) {
              const readChatId = getCanonicalChatId(peer);
              // Đánh dấu tin nhắn đã gửi (is_sent=1) là 'read' đến maxId
              db.run(
                `UPDATE messages SET status = 'read'
                 WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
                   AND is_sent = 1 AND CAST(msg_id AS INTEGER) <= ? AND status != 'read'`,
                [account.accountId, readChatId, Number(maxId)],
              );
              EventBroadcaster.emit('event:seen', {
                zaloId: account.accountId,
                threadId: readChatId,
                msgId: maxId,
                channel: 'telegram_user',
              });
              EventBroadcaster.emit('db:unreadChanged', { zaloId: account.accountId, source: 'telegram_read_inbox' });
            }
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] ReadHistoryInbox error: ${err.message}`);
          }
          return;
        }

        // ── Read history outbox (we read their messages on another device) ───
        if (update instanceof Api.UpdateReadHistoryOutbox) {
          try {
            const peer = (update as any).peer;
            if (peer) {
              const readChatId = getCanonicalChatId(peer);
              // Đánh dấu tin nhắn nhận được (is_sent=0) là 'read' và clear unread_count
              db.run(
                `UPDATE messages SET status = 'read'
                 WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
                   AND is_sent = 0 AND status != 'read'`,
                [account.accountId, readChatId],
              );
              db.run(
                `UPDATE contacts SET unread_count = 0
                 WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
                [account.accountId, readChatId],
              );
              EventBroadcaster.emit('event:seen', {
                zaloId: account.accountId,
                threadId: readChatId,
                msgId: String(update.maxId || ''),
                channel: 'telegram_user',
              });
              EventBroadcaster.emit('db:unreadChanged', { zaloId: account.accountId, source: 'telegram_read_outbox' });
            }
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] ReadHistoryOutbox error: ${err.message}`);
          }
          return;
        }

        // ── Pinned messages ──────────────────────────────────────────────────
        if (update instanceof Api.UpdatePinnedMessages) {
          try {
            const peer = (update as any).peer;
            if (peer) {
              const pinnedChatId = getCanonicalChatId(peer);
              syncPinnedMessages(account.accountId, pinnedChatId).catch((err: any) => {
                Logger.warn(`[TelegramUserListener] Pin sync failed for ${pinnedChatId}: ${err.message}`);
              });
            }
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] PinnedMessages update failed: ${err.message}`);
          }
          return;
        }

        if (update instanceof Api.UpdatePinnedChannelMessages) {
          try {
            if (update.channelId != null) {
              const pinnedChatId = `-100${String(update.channelId)}`;
              syncPinnedMessages(account.accountId, pinnedChatId).catch((err: any) => {
                Logger.warn(`[TelegramUserListener] Channel pin sync failed for ${pinnedChatId}: ${err.message}`);
              });
            }
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] PinnedChannelMessages update failed: ${err.message}`);
          }
          return;
        }

        // ── User status (online/offline/presence) ────────────────────────────
        if (update instanceof Api.UpdateUserStatus) {
          hydrateTelegramIdentity(account.accountId, client, String(update.userId)).catch(() => {});
          const statusClass = update.status?.className || 'unknown';
          const presenceStatus = statusClass === 'UserStatusOnline' ? 'online'
            : statusClass === 'UserStatusOffline' ? 'offline'
            : statusClass === 'UserStatusRecently' ? 'recently'
            : statusClass === 'UserStatusLastWeek' ? 'last_week'
            : statusClass === 'UserStatusLastMonth' ? 'last_month'
            : 'unknown';
          EventBroadcaster.emit('event:userPresence', {
            zaloId: account.accountId,
            userId: String(update.userId),
            status: presenceStatus,
            wasOnline: (update.status as any)?.wasOnline ? Number((update.status as any).wasOnline) : undefined,
            expires: (update.status as any)?.expires ? Number((update.status as any).expires) : undefined,
            channel: 'telegram_user',
          });
          return;
        }
      } catch (err: any) {
        Logger.warn(`[TelegramUserListener] Raw event error: ${err.message}`);
        throw err;
      }
    };
    rawUpdateHandlers.set(account.accountId, rawUpdateHandler);
    client.addEventHandler(rawUpdateHandler, new Raw({
      types: [
        Api.UpdateEditMessage,
        Api.UpdateEditChannelMessage,
        Api.UpdateDeleteMessages,
        Api.UpdateDeleteChannelMessages,
        Api.UpdateUserTyping,
        Api.UpdateChatUserTyping,
        Api.UpdateChannelUserTyping,
        Api.UpdateMessageReactions,
        Api.UpdateChannelTooLong,
        // Phase C (P0.4): Add UpdateNewMessage/UpdateNewChannelMessage to raw
        // handler to catch MessageService that GramJS NewMessage builder filters out.
        // Normal messages may be processed twice (here + NewMessage event) but
        // idempotent persistence prevents duplicate side effects.
        Api.UpdateNewMessage,
        Api.UpdateNewChannelMessage,
        Api.UpdateReadHistoryInbox,
        Api.UpdateReadHistoryOutbox,
        Api.UpdatePinnedMessages,
        Api.UpdatePinnedChannelMessages,
        Api.UpdateUserStatus,
        Api.UpdateFolderPeers,
        Api.UpdateNotifySettings,
        Api.UpdateChatDefaultBannedRights,
        // Channel reactions - handled via className/CONSTRUCTOR_ID check in handler
        (Api as any).UpdateChannelMessageReactions,
      ].filter(Boolean),
    }));

    // Phase C (P0.4): Separate raw handler for new message updates to catch
    // MessageService that the NewMessage high-level event builder skips.
    // Normal messages are de-duplicated by idempotent persistence.
    client.addEventHandler(async (update: any) => {
      try {
        const msg = update?.message;
        if (!msg) return;
        // Only handle MessageService here — normal messages go through NewMessage event
        if ((msg as any).className !== 'MessageService') return;
        // Channel service messages are handled by the authoritative raw
        // channel ingress above. Keep this hook for private/basic-group
        // MessageService updates, which NewMessage filters out.
        if (update instanceof Api.UpdateNewChannelMessage) return;
        const result = await handleServiceMessage(account.accountId, msg, client);
        if (result.status === 'failed') {
          throw new Error(`Raw service message ${String(msg.id)} failed persistence`);
        }
      } catch (err: any) {
        tgLog('warn', account.accountId, 'socket', `Raw MessageService error: ${err.message}`);
      }
    }, new Raw({ types: [Api.UpdateNewMessage, Api.UpdateNewChannelMessage] }));

    Logger.log(`[TelegramUserListener] Connected for ${account.accountId}`);
    startHealthCheck(listener);
    startChannelPoller(listener);

    // Recover MTProto updates before recording the next global cursor. This
    // remains background work so a slow history backfill never blocks UI login.
    synchronizeTelegramAccount(account.accountId, client).catch(err => {
      Logger.warn(`[TelegramUserListener] Telegram update synchronization failed: ${err.message}`);
    });

    // Check isForum for unchecked groups (background, non-blocking)
    checkForumForNewGroups(account.accountId).catch(err => {
      Logger.warn(`[TelegramUserListener] checkForumForNewGroups failed: ${err.message}`);
    });

    // Broadcast connection status
    EventBroadcaster.emit('event:connected', {
      zaloId: account.accountId,
      accountInfo: { channel: 'telegram_user' },
    });
  } catch (err: any) {
    Logger.error(`[TelegramUserListener] Connection failed for ${account.accountId}: ${err.message}`);
    scheduleReconnect(listener, 'connect', err);
    throw err;
  }
}

// ─── Service Message Handling ─────────────────────────────────────────────────
// GramJS delivers service messages (join/leave/title/photo/pin) as MessageService
// inside NewMessageEvent. They are NOT a separate UpdateServiceMessage type.

async function handleServiceMessage(accountId: string, message: any, client?: TelegramClient): Promise<ProcessResult> {
  const action = message.action;
  if (!action) return { status: 'ignored' };

  const db = DatabaseService.getInstance();
  if (!db) return { status: 'failed' };

  const serviceMsgId = String(message.id);
  const peerId = message.peerId;
  const serviceChatId = peerId ? getCanonicalChatId(peerId) : '';
  const serviceTimestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;
  const className = action.className || '';

  // Membership check: skip service messages from unjoined channels
  if (serviceChatId && client) {
    try {
      const chat = await message.getChat();
      if (chat && getTelegramPeerType(chat) !== 'user') {
        const membership = getTelegramMembership(chat);
        if (membership.state !== 'member') {
          return { status: 'ignored', chatId: serviceChatId, messageId: serviceMsgId };
        }
      }
    } catch {}
  }

  // Check identity before emitting any lifecycle side effect. Difference and
  // socket may replay the same MessageService.
  if (serviceChatId) {
    const persistedService = db.queryOne<any>(
      `SELECT msg_id FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [serviceMsgId, accountId, serviceChatId],
    );
    if (persistedService) {
      return { status: 'duplicate', chatId: serviceChatId, messageId: serviceMsgId };
    }
  }

  let systemText = '';
  let groupEventType = '';

  if (className === 'MessageActionChatAddUser') {
    const addedUsers = action.users || [];
    if (addedUsers.length > 0) {
      const names = addedUsers.map((u: any) => {
        const uid = String(u?.id || u?.userId || '');
        const name = u?.firstName ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '';
        if (name) return name;
        // Try to resolve from group members cache
        const cached = db?.queryOne<any>(
          `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
          [accountId, serviceChatId, uid]
        );
        return cached?.display_name || uid;
      }).filter(Boolean);
      systemText = names.length > 0
        ? `${names.join(', ')} đã được thêm vào nhóm`
        : 'Thành viên đã được thêm vào nhóm';
    } else {
      systemText = 'Thành viên mới tham gia nhóm';
    }
    groupEventType = 'member_join';
  } else if (className === 'MessageActionChatJoinedByLink') {
    // Try to get the user who joined from the message sender
    const senderId = String(message?.senderId?.valueOf?.() || '');
    let senderName = '';
    if (senderId) {
      const cached = db?.queryOne<any>(
        `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, serviceChatId, senderId]
      );
      senderName = cached?.display_name || '';
    }
    systemText = senderName
      ? `${senderName} tham gia nhóm qua link mời`
      : 'Thành viên tham gia qua link mời';
    groupEventType = 'member_join';
  } else if (className === 'MessageActionChatDeleteUser') {
    const deletedUserId = String(action.userId?.valueOf?.() || action.user_id?.valueOf?.() || '');
    let deletedUserName = '';
    if (deletedUserId) {
      // Try to resolve from group members cache or peer registry
      const cached = db?.queryOne<any>(
        `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, serviceChatId, deletedUserId]
      );
      deletedUserName = cached?.display_name || '';
      if (!deletedUserName) {
        const peer = db?.queryOne<any>(
          `SELECT first_name, last_name FROM telegram_peers WHERE owner_zalo_id = ? AND peer_id = ?`,
          [accountId, deletedUserId]
        );
        if (peer) deletedUserName = [peer.first_name, peer.last_name].filter(Boolean).join(' ');
      }
    }
    // Check if self-leave or kicked by admin
    const isSelfLeave = deletedUserId === String(message?.senderId?.valueOf?.() || '');
    systemText = deletedUserName
      ? (isSelfLeave ? `${deletedUserName} đã rời khỏi nhóm` : `${deletedUserName} đã bị xoá khỏi nhóm`)
      : (isSelfLeave ? 'Thành viên đã rời khỏi nhóm' : 'Thành viên đã bị xoá khỏi nhóm');
    groupEventType = 'member_leave';
  } else if (className === 'MessageActionChatEditTitle') {
    systemText = `Tên nhóm đã đổi thành "${action.title || ''}"`;
    groupEventType = 'title_change';
    if (serviceChatId) {
      EventBroadcaster.emit('event:groupInfoUpdate', {
        zaloId: accountId,
        groupId: serviceChatId,
        name: action.title || '',
      });
    }
  } else if (className === 'MessageActionChatEditPhoto') {
    systemText = 'Ảnh nhóm đã được thay đổi';
    groupEventType = 'photo_change';
  } else if (className === 'MessageActionPinMessage') {
    systemText = 'Tin nhắn đã được ghim';
    EventBroadcaster.emit('event:pinsUpdated', {
      zaloId: accountId,
      threadId: serviceChatId,
    });
  // ── Phase C: Forum topic lifecycle (P0.5 fix — use real schema names) ──
  // Telegram schema uses MessageActionTopicCreate and MessageActionTopicEdit.
  // MessageActionTopicEdit carries optional flags: title, closed, hidden.
  } else if (className === 'MessageActionTopicCreate') {
    const topicTitle = action.title || 'chủ đề mới';
    systemText = `Đã tạo chủ đề "${topicTitle}"`;
    EventBroadcaster.emit('event:forumTopicsChanged', {
      zaloId: accountId,
      threadId: serviceChatId,
    });
  } else if (className === 'MessageActionTopicEdit') {
    // MessageActionTopicEdit can carry title, closed, hidden changes
    const topicTitle = action.title || '';
    const closed = (action as any).closed;
    const hidden = (action as any).hidden;
    if (topicTitle) {
      systemText = `Chủ đề đã đổi tên thành "${topicTitle}"`;
    } else if (closed === true) {
      systemText = 'Chủ đề đã được đóng';
    } else if (closed === false) {
      systemText = 'Chủ đề đã được mở lại';
    } else if (hidden === true) {
      systemText = 'Chủ đề General đã được ẩn';
    } else if (hidden === false) {
      systemText = 'Chủ đề General đã được hiện lại';
    } else {
      systemText = 'Chủ đề đã được chỉnh sửa';
    }
    EventBroadcaster.emit('event:forumTopicsChanged', {
      zaloId: accountId,
      threadId: serviceChatId,
    });
  } else {
    Logger.log(`[TelegramUserListener] Service message: ${className} in ${serviceChatId}`);
  }

  // Save service message to DB (idempotent — P1.5)
  if (serviceChatId && systemText) {
    try {
      // Check if already exists to avoid duplicate side effects
      const existing = db.queryOne<any>(
        `SELECT msg_id FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [serviceMsgId, accountId, serviceChatId],
      );
      if (!existing) {
        db.run(`
          INSERT INTO messages
            (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, status, channel, topic_id)
          VALUES (?, ?, ?, 1, 'system', ?, 'system', ?, 0, 'received', 'telegram_user', ?)
        `, [serviceMsgId, accountId, serviceChatId, systemText, serviceTimestamp, getForumTopicId(message)]);

        // Emit group event only for new service messages
        if (groupEventType && (groupEventType === 'member_join' || groupEventType === 'member_leave')) {
          EventBroadcaster.emit('event:groupEvent', {
            zaloId: accountId,
            groupId: serviceChatId,
            eventType: groupEventType,
            data: { action: className },
            systemText,
            msgId: serviceMsgId,
            timestamp: serviceTimestamp,
          });
        }
        return { status: 'inserted', chatId: serviceChatId, messageId: serviceMsgId };
      }
      return { status: 'duplicate', chatId: serviceChatId, messageId: serviceMsgId };
    } catch (err: any) {
      tgLog('warn', accountId, 'socket', `Service message persist error: ${err.message}`, { msgId: serviceMsgId });
      return { status: 'failed', chatId: serviceChatId, messageId: serviceMsgId };
    }
  }
  return systemText
    ? { status: 'failed', messageId: serviceMsgId }
    : { status: 'ignored', chatId: serviceChatId, messageId: serviceMsgId };
}

/** Main message ingress — handles normal messages from all sources (socket,
 *  difference, history). Uses peerId-first identity (P1.1) and idempotent
 *  persistence (P1.5). Only emits UI events on actual insert. */
async function handleNewMessage(accountId: string, event: NewMessageEvent, client?: TelegramClient, source: TelegramIngressSource = 'socket'): Promise<ProcessResult> {
  const message = event.message;
  if (!message) return { status: 'ignored' };

  // ── Service messages (join/leave/title/photo/pin) ────────────────────
  // GramJS delivers these as NewMessageEvent where message is a MessageService.
  // Handle them separately from normal messages.
  if ((message as any).className === 'MessageService') {
    return handleServiceMessage(accountId, message, client);
  }

  const messageId = String(message.id);
  if (!messageId) return { status: 'ignored' };

  // ── Phase B: peerId-first identity (P1.1 fix) ────────────────────────
  // Derive identity from peerId BEFORE trying getChat(). If getChat() fails
  // (e.g. cold entity cache after restart), we still persist the message.
  const rawIdentity = deriveMessageIdentity(message);

  // Try to get richer entity data from getChat() — non-blocking for identity
  let chat: any = null;
  try {
    chat = await message.getChat();
  } catch {}

  // Use resolved chat entity for metadata, but rawIdentity.chatId is authoritative
  const chatId = rawIdentity.chatId;
  if (!chatId) {
    tgLog('warn', accountId, source, `No chatId derivable for msg ${messageId}`, { peerId: String((message.peerId as any)?.userId ?? (message.peerId as any)?.channelId ?? '') });
    return { status: 'failed', messageId };
  }

  // ── Membership check: skip messages from unjoined groups/channels ────
  // This prevents unjoined channels from appearing in the inbox.
  if (rawIdentity.peerKind !== 'user' && !message.out) {
    let isMember = true; // default: allow if we can't determine
    if (chat) {
      const membership = getTelegramMembership(chat);
      isMember = membership.state === 'member';
    } else {
      // Fallback: check DB membership state
      const dbInst = DatabaseService.getInstance();
      const dbContact = dbInst?.queryOne<any>(
        `SELECT telegram_membership_state FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId]
      );
      if (dbContact && dbContact.telegram_membership_state && dbContact.telegram_membership_state !== 'member') {
        isMember = false;
      }
    }
    if (!isMember) {
      // Expected for channels/groups the account no longer belongs to. Do not
      // emit one terminal line per incoming message from that peer.
      return { status: 'ignored', chatId, messageId };
    }
  }

  const threadType = rawIdentity.threadType;
  const topicId = rawIdentity.topicId;

  // Cache entity if resolved (for access_hash and metadata)
  if (chat) {
    cacheTelegramPeer(accountId, chatId, chat);
  }

  const senderId = String(message.senderId?.valueOf() || '');
  const isSelf = message.out || false;
  const timestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;

  // Get sender name — best-effort, not blocking identity
  let senderName = '';
  try {
    let sender = await message.getSender();
    if (!sender && senderId && client) {
      sender = await hydrateTelegramIdentity(accountId, client, senderId, threadType === 1 ? chatId : undefined);
    }
    if (sender) {
      if ('firstName' in sender) {
        senderName = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
      }
      if (!senderName && 'title' in sender) {
        senderName = (sender as any).title || '';
      }
      if (!senderName && 'username' in sender) {
        senderName = '@' + (sender as any).username;
      }
      if (senderId && client) await hydrateTelegramIdentity(
        accountId, client, senderId, threadType === 1 ? chatId : undefined, sender,
      );
    }
  } catch (err: any) {
    tgLog('warn', accountId, source, `Sender hydration failed for msg ${messageId}`, {
      chatId, senderId, error: err?.message,
    });
  }

  // ── Determine content + msgType + attachments ──────────────────────────
  const peerType = chat ? getTelegramPeerType(chat) : DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
  const { content, msgType, attachments } = normalizeTelegramMessageMedia(message, peerType);
  const reactions = normalizeTelegramReactions((message as any).reactions, accountId);

  // ── Reply detection ────────────────────────────────────────────────────
  let replyToId: string | undefined;
  let quoteData: string | undefined;
  try {
    replyToId = getTelegramReplyToMessageId(message);
    if (replyToId) {
      const db = DatabaseService.getInstance();
      if (db) {
        const orig = db.queryOne<any>(
          `SELECT content, msg_type, sender_id, attachments FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
          [replyToId, accountId, chatId]
        );
        if (orig) {
          // Resolve sender name from group members cache or peer registry
          let senderName = '';
          if (orig.sender_id) {
            const member = db.queryOne<any>(
              `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
              [accountId, chatId, orig.sender_id]
            );
            senderName = member?.display_name || '';
            if (!senderName) {
              const peer = db.queryOne<any>(
                `SELECT first_name, last_name FROM telegram_peers WHERE owner_zalo_id = ? AND peer_id = ?`,
                [accountId, orig.sender_id]
              );
              if (peer) senderName = [peer.first_name, peer.last_name].filter(Boolean).join(' ');
            }
          }
          quoteData = buildTelegramQuoteData({
            msgId: replyToId,
            content: orig.content,
            senderId: orig.sender_id,
            senderName,
            msgType: orig.msg_type,
            attachments: orig.attachments,
          });
        }
      }
    }
  } catch {}

  // ── Phase B: Idempotent persistence (P1.5 fix) ────────────────────────
  const db = DatabaseService.getInstance();
  if (!db) return { status: 'failed', chatId, messageId };

  const displayContent = content || (() => {
    // Chỉ hiện placeholder cho audio (có ý nghĩa), còn lại empty nếu không có caption
    if (msgType === 'audio') return '🎵 Audio';
    if (msgType !== 'text') return '';
    return '';
  })();

  const inlineButtons = parseInlineButtons(message);

  const result = persistTelegramMessage(db, {
    msgId: messageId, accountId, chatId, threadType,
    senderId, content: displayContent, msgType, timestamp,
    isSelf, attachments, replyToId, quoteData, topicId, reactions,
    inlineButtons,
  });

  tgLog('info', accountId, source, `msg ${messageId}`, {
    chatId,
    topicId: topicId || '-',
    result: result.status,
    msgType,
    msgClass: (message as any)?.className || '-',
    mediaClass: (message as any)?.media?.className || '-',
    replyToMsgId: (message as any)?.replyTo?.replyToMsgId,
    replyToTopId: (message as any)?.replyTo?.replyToTopId,
    forumTopic: (message as any)?.replyTo?.forumTopic === true,
  });

  // ── Side effects ONLY on actual insert ─────────────────────────────────
  // Difference/reconnect recovery preserves real unread state, but must not
  // replay one desktop toast or sound for every message missed while offline.
  const suppressNotification = source !== 'socket';
  if (result.status === 'inserted') {
    // Update contacts — only when a NEW message was inserted
    const isGroup = rawIdentity.peerKind !== 'user';
    const chatTitle = (chat && 'title' in chat ? chat.title : '') || senderName || chatId;
    // Group chat: prepend sender name to last_message preview
    const lastMessagePreview = (isGroup && !isSelf && senderName)
      ? `${senderName}: ${displayContent}`
      : displayContent;

    // Check membership state for "Others" folder auto-placement
    // For groups/channels: if not a member → put in Others
    let shouldBeInOthers = false;
    if (isGroup && !isSelf) {
      const existingContact = db.queryOne<any>(
        `SELECT is_in_others, telegram_membership_state FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
        [accountId, chatId]
      );
      if (existingContact) {
        // Keep existing Others state; persistTelegramDialogState will update it during sync
        shouldBeInOthers = existingContact.is_in_others === 1;
      } else if (chat) {
        // New contact: check membership from entity
        const membership = getTelegramMembership(chat);
        shouldBeInOthers = membership.state !== 'member';
      }
    }

    // Detect if peer is a bot (for DM conversations with bots)
    const peerIsBot = chat?.className === 'User' && chat?.bot ? 1 : null;

    db.run(`
      INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others, is_cov_bot)
      VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, 'telegram_user', ?, ?)
      ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
        display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
        last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
        last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
        unread_count = CASE WHEN ? = 0 THEN contacts.unread_count ELSE contacts.unread_count + 1 END,
        channel = 'telegram_user',
        is_cov_bot = CASE WHEN excluded.is_cov_bot = 1 THEN 1 ELSE contacts.is_cov_bot END
    `, [
      accountId, chatId, chatTitle,
      isGroup ? 'group' : 'user',
      isSelf ? 0 : 1, lastMessagePreview, timestamp,
      shouldBeInOthers ? 1 : 0, peerIsBot,
      isSelf ? 0 : 1,
    ]);

    // If this is a new group/channel with no real name (just ID), resolve info async
    if (isGroup && chatTitle === chatId && client) {
      resolveNewGroupInfo(accountId, client, chatId).catch(() => {});
    }

    // Download media (background, non-blocking)
    const hasMedia = !!(message as any).media;
    tgDebugLog(`[TG:handleNew] STEP6 msgId=${messageId} hasMedia=${hasMedia} isSelf=${isSelf} source=${source} msgType=${msgType} result=${result.status}`);
    if (hasMedia && client) {
      downloadMediaForMessage(accountId, client, message, messageId, msgType, chatId).catch(err => {
        Logger.error(`[TG:download] QUEUE_FAILED msgId=${messageId} error=${err.message}`);
      });
    }

    // Fetch avatar cho contact mới (background, non-blocking)
    if (client && !isSelf && chat) {
      fetchNewContactAvatar(accountId, client, chatId, chat).catch(() => {});
    }

    // Broadcast to UI — only for new messages
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: {
        type: threadType,
        threadId: chatId,
        isSelf,
        _silentNotification: suppressNotification,
        data: {
          uidFrom: senderId,
          idTo: chatId,
          msgId: messageId,
          content,
          msgType,
          ts: String(timestamp),
          dName: senderName,
          topicId,
          replyToId,
          quoteData,
          attachments,
          telegramPost: attachments.find((attachment: any) => attachment.type === 'telegram_post') || undefined,
        },
      },
    });
    tgLog('info', accountId, source, `UI_EMITTED msg ${messageId}`, {
      chatId,
      topicId: topicId || '-',
      msgType,
    });
  } else if (result.status === 'updated') {
    // Attachments were merged into existing message — emit event so UI picks it up
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: {
        type: threadType,
        threadId: chatId,
        isSelf,
        _silentNotification: suppressNotification,
        data: {
          uidFrom: senderId,
          idTo: chatId,
          msgId: messageId,
          content,
          msgType,
          ts: String(timestamp),
          dName: senderName,
          attachments,
        },
      },
    });
    tgLog('info', accountId, source, `UI_EMITTED (updated) msg ${messageId}`, { chatId, msgType });
  } else if (result.status === 'duplicate') {
    // Duplicate — KHÔNG emit UI event.
    // Temp message trong store đã có local_paths và hiển thị đúng.
    // Real message trong DB có metadata (attachments, reactions) từ socket echo.
    // Emit event → renderer thay temp bằng real → mất local_paths → "Đang tải về...".
    tgLog('info', accountId, source, `dedup msg ${messageId} (kept temp, DB enriched)`, { chatId });
    // For self-sent messages: socket echo merges attachments into DB, but UI store needs update
    // Emit event so addMessage can merge attachments into existing temp/real message
    if (isSelf && attachments && attachments.length > 0) {
      EventBroadcaster.emit('event:message', {
        zaloId: accountId,
        message: {
          type: threadType,
          threadId: chatId,
          isSelf,
          _silentNotification: true,
          data: {
            uidFrom: senderId,
            idTo: chatId,
            msgId: messageId,
            content,
            msgType,
            ts: String(timestamp),
            dName: senderName,
            attachments,
          },
        },
      });
      tgLog('info', accountId, source, `UI_EMITTED (self-dedup with attachments) msg ${messageId}`, { chatId, msgType });
    }
  }
  return result;
}

// ─── Media Download ──────────────────────────────────────────────────────────

/**
 * Download media từ Telegram message và cập nhật local_paths trong DB.
 * Chạy background, không block message processing.
 */
/** Serialize and deduplicate all exported-DC downloads for one account. */
function queueTelegramDownload<T>(accountId: string, resourceKey: string, operation: () => Promise<T>): Promise<T> {
  const key = `${accountId}:${resourceKey}`;
  const existing = inFlightDownloadKeys.get(key);
  if (existing) return existing as Promise<T>;

  const previous = mediaDownloadQueues.get(accountId) || Promise.resolve();
  const task = previous.catch(() => undefined).then(() => operation()) as Promise<T>;
  let settled!: Promise<T>;
  settled = task.finally(() => {
    if (mediaDownloadQueues.get(accountId) === settled) mediaDownloadQueues.delete(accountId);
    if (inFlightDownloadKeys.get(key) === settled) inFlightDownloadKeys.delete(key);
  });
  mediaDownloadQueues.set(accountId, settled);
  inFlightDownloadKeys.set(key, settled);
  return settled;
}

function downloadProfilePhotoQueued(accountId: string, client: TelegramClient, peer: any, resourceId: string, isBig: boolean): Promise<any> {
  return queueTelegramDownload(
    accountId,
    `avatar:${resourceId}:${isBig ? 'big' : 'small'}`,
    () => client.downloadProfilePhoto(peer, { isBig }),
  );
}

function downloadMediaForMessage(
  accountId: string,
  client: TelegramClient,
  message: any,
  messageId: string,
  msgType: string,
  threadId: string,
): Promise<string | null> {
  return queueTelegramDownload(
    accountId,
    `media:${threadId}:${messageId}`,
    () => downloadMediaForMessageNow(accountId, client, message, messageId, msgType, threadId),
  );
}

async function downloadMediaForMessageNow(
  accountId: string,
  client: TelegramClient,
  message: any,
  messageId: string,
  msgType: string,
  threadId: string,
): Promise<string | null> {
  tgDebugLog(`[TG:download] START msgId=${messageId} msgType=${msgType} threadId=${threadId}`);
  const db = DatabaseService.getInstance();
  if (!db) return null;

  try {
    // Download media buffer từ GramJS
    const mediaResult = await client.downloadMedia(message);
    if (!mediaResult || mediaResult.length === 0) {
      tgLog('warn', accountId, 'history', 'MEDIA_DOWNLOAD_EMPTY', {
        chatId: threadId,
        messageId,
        msgType,
      });
      return null;
    }
    const buffer = Buffer.from(mediaResult);

    // Determine file extension
    const ext = getMediaExtension(msgType, message);
    const filename = `${accountId}_${threadId}_${messageId}${ext}`;

    // Save to disk
    const localPath = await saveMediaToDisk(buffer, filename, msgType);
    if (!localPath) return null;

    // Update local_paths trong DB
    const localPaths: Record<string, string> = {};
    // Detect actual media type for webpage messages
    let effectiveMsgType = msgType;
    if (msgType === 'telegram.webpage') {
      try {
        const webpage = (message?.media as any)?.webpage;
        if (webpage?.photo) effectiveMsgType = 'photo';
        else if (webpage?.document) {
          const mime = String(webpage.document?.mimeType || '');
          if (mime.includes('video')) effectiveMsgType = 'video';
          else if (mime.includes('audio')) effectiveMsgType = 'audio';
          else effectiveMsgType = 'file';
        }
      } catch {}
    }
    if (effectiveMsgType === 'photo') localPaths.main = localPath;
    else if (effectiveMsgType === 'video') localPaths.video = localPath;
    else if (effectiveMsgType === 'audio') localPaths.voice = localPath;
    else localPaths.file = localPath;

    db.run(
      `UPDATE messages SET local_paths = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [JSON.stringify(localPaths), messageId, accountId, threadId]
    );

    // Broadcast local path update to UI
    EventBroadcaster.emit('event:localPath', {
      zaloId: accountId,
      msgId: messageId,
      threadId,
      localPaths,
    });

    tgDebugLog(`[TG:download] DONE msgId=${messageId} msgType=${msgType} localPath=${localPath} localPaths=${JSON.stringify(localPaths)}`);
    return localPath;
  } catch (err: any) {
    Logger.error(`[TG:download] FAILED msgId=${messageId} error=${err.message}`);
    tgLog('warn', accountId, 'history', 'MEDIA_DOWNLOAD_FAILED', {
      chatId: threadId,
      messageId,
      msgType,
      error: err?.message || String(err),
    });
    return null;
  }
}

function getMediaExtension(msgType: string, message: any): string {
  if (msgType === 'photo') return '.jpg';
  if (msgType === 'video') return '.mp4';
  if (msgType === 'gif') return '.mp4'; // Telegram GIFs are MPEG4
  if (msgType === 'video_note') return '.mp4';
  if (msgType === 'audio') {
    if (message.voice) return '.ogg';
    return '.mp3';
  }
  if (msgType === 'sticker') {
    const stickerMime = String((message.document as any)?.mimeType || (message.sticker as any)?.mimeType || '');
    if (stickerMime.includes('tgsticker') || stickerMime.includes('lottie')) return '.tgs';
    if (stickerMime.includes('webm')) return '.webm';
    if (stickerMime.includes('mp4')) return '.mp4';
    if (stickerMime.includes('webp')) return '.webp';
    return '.webp';
  }
  // MessageMediaWebPage: detect actual media type inside webpage
  if (msgType === 'telegram.webpage') {
    try {
      const webpage = (message?.media as any)?.webpage;
      if (webpage?.photo) return '.jpg';
      if (webpage?.document) {
        const doc = webpage.document;
        const mime = String(doc?.mimeType || '');
        if (mime.includes('video')) return '.mp4';
        if (mime.includes('audio')) return '.mp3';
        if (mime.includes('gif')) return '.mp4';
        // Try filename extension
        const attrs = doc?.attributes || [];
        const fnAttr = attrs.find((a: any) => a.className === 'DocumentAttributeFilename');
        if (fnAttr?.fileName) {
          const dot = fnAttr.fileName.lastIndexOf('.');
          if (dot > 0) return fnAttr.fileName.substring(dot);
        }
        return '.bin';
      }
    } catch {}
    return '.jpg'; // fallback: webpage often has photo thumbnail
  }
  // File: try get extension from document attributes
  try {
    const doc = message.document;
    const attrs = (doc as any)?.attributes || [];
    const fileNameAttr = attrs.find((a: any) => a.className === 'DocumentAttributeFilename');
    if (fileNameAttr?.fileName) {
      const dot = fileNameAttr.fileName.lastIndexOf('.');
      if (dot > 0) return fileNameAttr.fileName.substring(dot);
    }
  } catch {}
  return '.bin';
}

async function saveMediaToDisk(buffer: Buffer, filename: string, msgType: string): Promise<string | null> {
  try {
    const baseDir = FileStorageService.getBaseDir();

    // Determine subfolder by type — lưu cùng cấu trúc với Zalo media
    let subfolder = 'files';
    if (msgType === 'photo') subfolder = 'images';
    else if (msgType === 'video') subfolder = 'videos';
    else if (msgType === 'audio') subfolder = 'voices';
    else if (msgType === 'sticker') subfolder = 'stickers';

    // Extract accountId from filename (format: accountId_threadId_msgId.ext)
    const parts = filename.split('_');
    const accountId = parts[0] || 'unknown';

    const mediaDir = path.join(baseDir, accountId, subfolder);
    if (!fs.existsSync(mediaDir)) {
      fs.mkdirSync(mediaDir, { recursive: true });
    }

    const filePath = path.join(mediaDir, filename);
    fs.writeFileSync(filePath, buffer);

    // Auto-fix non-faststart MP4 files (moov atom at end → move to front)
    // Without faststart, <video> element can't read metadata and fails to play
    if (msgType === 'video' && filename.endsWith('.mp4')) {
      ensureFaststart(filePath).catch(err => {
        Logger.warn(`[TG:download] faststart fix failed for ${filename}: ${err.message}`);
      });
    }

    return filePath;
  } catch {
    return null;
  }
}

/**
 * Ensure MP4 file has moov atom at the beginning (faststart).
 * If not, run ffmpeg to move moov to front without re-encoding.
 * This is critical for <video> element to read metadata for playback.
 */
async function ensureFaststart(filePath: string): Promise<void> {
  const { spawnSync } = require('child_process') as typeof import('child_process');

  // Get ffmpeg binary path
  let ffmpegBin = 'ffmpeg';
  try {
    let ffmpegStatic = require('ffmpeg-static') as string;
    if (ffmpegStatic && ffmpegStatic.includes('app.asar') && !ffmpegStatic.includes('app.asar.unpacked')) {
      ffmpegStatic = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
    }
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      ffmpegBin = ffmpegStatic;
    }
  } catch {}

  // Check if already faststart by scanning first 64KB for moov atom
  try {
    const scanBuf = Buffer.alloc(Math.min(fs.statSync(filePath).size, 64 * 1024));
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, scanBuf, 0, scanBuf.length, 0);
    fs.closeSync(fd);

    let offset = 0;
    while (offset < scanBuf.length - 8) {
      const boxSize = scanBuf.readUInt32BE(offset);
      const boxType = scanBuf.toString('ascii', offset + 4, offset + 8);
      if (boxType === 'moov') {
        Logger.log(`[faststart] ${filePath} already faststart`);
        return; // Already faststart, nothing to do
      }
      if (boxSize < 8) break;
      offset += boxSize;
    }
  } catch {}

  // Not faststart — fix with ffmpeg
  Logger.log(`[faststart] Fixing non-faststart MP4: ${filePath}`);
  const tempPath = filePath + '.faststart.tmp.mp4';

  try {
    const result = spawnSync(ffmpegBin, [
      '-y', '-i', filePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      tempPath,
    ], { timeout: 120_000, stdio: 'pipe' });

    if (result.status === 0 && fs.existsSync(tempPath)) {
      // Replace original with fixed version
      fs.renameSync(tempPath, filePath);
      Logger.log(`[faststart] Fixed: ${filePath}`);
    } else {
      // Cleanup temp file on failure
      try { fs.unlinkSync(tempPath); } catch {}
      const stderr = result.stderr?.toString() || '';
      Logger.warn(`[faststart] ffmpeg failed (exit=${result.status}): ${stderr.slice(0, 200)}`);
    }
  } catch (err: any) {
    try { fs.unlinkSync(tempPath); } catch {}
    Logger.warn(`[faststart] ffmpeg error: ${err.message}`);
  }
}

// ─── Fetch New Contact Avatar ─────────────────────────────────────────────────

/**
 * Resolve group info for a new group that was created from a message with just an ID.
 * Fetches the group entity, updates the contact name/avatar, and emits a refresh event.
 */
async function resolveNewGroupInfo(
  accountId: string,
  client: TelegramClient,
  chatId: string,
): Promise<void> {
  try {
    const entity = await resolvePeerEntity(accountId, client, chatId);
    if (!entity) return;

    const db = DatabaseService.getInstance();
    if (!db) return;

    // Get display name from entity
    const displayName = entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || '';
    if (!displayName || displayName === chatId) return;

    // Update contact in DB
    db.run(
      `UPDATE contacts SET display_name = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user' AND (display_name = '' OR display_name = contact_id)`,
      [displayName, accountId, chatId]
    );

    // Cache the peer for future use
    cacheTelegramPeer(accountId, chatId, entity);

    // Try to fetch avatar
    try {
      const photo = await downloadProfilePhotoQueued(accountId, client, entity, `group:${chatId}`, false);
      if (photo?.length) {
        const savedPath = await saveAvatarToDisk(Buffer.from(photo), `tg_group_${chatId}_${Date.now()}.jpg`);
        if (savedPath) {
          const normalized = savedPath.replace(/\\/g, '/');
          const avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
          db.run(
            `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
            [avatarUrl, accountId, chatId]
          );
        }
      }
    } catch {}

    // Emit event to refresh conversation list in renderer
    EventBroadcaster.emit('db:unreadChanged', {
      zaloId: accountId,
      source: 'telegram_new_group_resolved',
    });

    tgLog('info', accountId, 'history', `[resolveNewGroupInfo] Resolved group ${chatId} → "${displayName}"`);
  } catch (err: any) {
    tgLog('warn', accountId, 'history', `[resolveNewGroupInfo] Failed to resolve ${chatId}: ${err.message}`);
  }
}

/**
 * Fetch avatar cho contact mới khi nhận tin nhắn.
 * Chỉ fetch nếu contact chưa có avatar.
 */
async function fetchNewContactAvatar(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  chat: any,
): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  try {
    // Kiểm tra đã có avatar chưa
    const existing = db.queryOne<any>(
      `SELECT avatar_url, display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, chatId]
    );
    if (existing?.avatar_url) {
      markAvatarSuccess(accountId, chatId); // Reset cache nếu đã có
      return;
    }

    // Kiểm tra cache: đã thử gần đây hoặc hết lần thử
    if (!shouldFetchAvatar(accountId, chatId)) return;
    markAvatarFetched(accountId, chatId);

    // Download avatar
    let avatarUrl = '';
    try {
      const photo = await downloadProfilePhotoQueued(accountId, client, chat, `chat:${chatId}`, false);
      if (photo && photo.length > 0) {
        const avatarPath = `telegram_avatar_${chatId}_${Date.now()}.jpg`;
        const savedPath = await saveAvatarToDisk(Buffer.from(photo), avatarPath);
        if (savedPath) {
          const normalized = savedPath.replace(/\\/g, '/');
          avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
        }
      }
    } catch {}

    if (avatarUrl) {
      db.run(`
        UPDATE contacts SET avatar_url = ?
        WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'
      `, [avatarUrl, accountId, chatId]);

      markAvatarSuccess(accountId, chatId); // Reset cache khi thành công
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_avatar' });
    }

    // Fetch thêm thông tin contact (username, phone) nếu là user
    if (!isGroupChat(chat)) {
      try {
        const entity = chat;
        if (entity?.username || entity?.phone) {
          const updates: string[] = [];
          const params: any[] = [];
          if (entity.phone) {
            updates.push('phone = ?');
            params.push(String(entity.phone));
          }
          if (updates.length > 0) {
            params.push(accountId, chatId);
            db.run(
              `UPDATE contacts SET ${updates.join(', ')} WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
              params
            );
          }
        }
      } catch {}
    }
  } catch {}
}

function isGroupChat(chat: any): boolean {
  return chat?.className === 'Channel' || chat?.className === 'Chat';
}

function normalizeLegacyTelegramContacts(accountId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  const legacyContacts = db.query<any>(`
    SELECT contact_id FROM contacts
    WHERE owner_zalo_id = ? AND channel = 'telegram_user'
      AND contact_type = 'group' AND contact_id NOT LIKE '-%'
  `, [accountId]);
  for (const legacy of legacyContacts) {
    const rawId = String(legacy.contact_id || '');
    const canonical = db.queryOne<any>(`
      SELECT contact_id FROM contacts
      WHERE owner_zalo_id = ? AND channel = 'telegram_user'
        AND contact_id IN (?, ?) LIMIT 1
    `, [accountId, `-100${rawId}`, `-${rawId}`]);
    if (!rawId || !canonical?.contact_id) continue;
    const canonicalId = String(canonical.contact_id);
    db.run(`
      DELETE FROM messages AS legacy
      WHERE legacy.owner_zalo_id = ? AND legacy.channel = 'telegram_user' AND legacy.thread_id = ?
        AND EXISTS (
          SELECT 1 FROM messages AS canonical
          WHERE canonical.owner_zalo_id = legacy.owner_zalo_id
            AND canonical.channel = legacy.channel
            AND canonical.thread_id = ?
            AND canonical.msg_id = legacy.msg_id
        )
    `, [accountId, rawId, canonicalId]);
    db.run(`UPDATE messages SET thread_id = ? WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND thread_id = ?`, [canonicalId, accountId, rawId]);
    db.run(`DELETE FROM contacts WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND contact_id = ?`, [accountId, rawId]);
  }
}

// ─── Fetch Missed Messages ───────────────────────────────────────────────────

/**
 * Fetch tin nhắn đến trong lúc offline.
 * Telegram lưu messages trên server — chỉ cần query lại.
 * Chạy background, không block quá trình connect.
 */
type TelegramUpdateState = { pts: number; qts: number; date: number; seq: number };
type DifferenceResult = 'no_state' | 'complete' | 'too_long' | 'failed';

function toTelegramUpdateState(state: any, fallback: TelegramUpdateState): TelegramUpdateState {
  return {
    pts: Number(state?.pts ?? fallback.pts ?? 0),
    qts: Number(state?.qts ?? fallback.qts ?? 0),
    date: Number(state?.date ?? fallback.date ?? 0),
    seq: Number(state?.seq ?? fallback.seq ?? 0),
  };
}

function cacheDifferenceEntities(accountId: string, users: any[] = [], chats: any[] = []): Map<any, any> {
  const entities = new Map<any, any>();
  for (const entity of [...users, ...chats]) {
    if (!entity) continue;
    try {
      const peerId = getCanonicalChatId(entity);
      if (peerId) {
        entities.set(getPeerId(entity), entity);
        cacheTelegramPeer(accountId, peerId, entity);
      }
    } catch {}
  }
  return entities;
}

async function processDifferenceMessages(accountId: string, client: TelegramClient, messages: any[], entities: Map<any, any>, source: TelegramIngressSource = 'global_difference'): Promise<void> {
  for (const message of messages || []) {
    if (!message?.id || !message?.peerId) continue;
    const event = initializeRecoveredMessage(message, client, entities);
    const result = await handleNewMessage(accountId, event, client, source);
    if (result.status === 'failed') {
      throw new Error(`Failed to persist Telegram message ${String(message.id)}`);
    }
  }
}

async function recoverTelegramUpdateDifference(accountId: string, client: TelegramClient): Promise<DifferenceResult> {
  const db = DatabaseService.getInstance();
  const persisted = db?.getTelegramUpdateState(accountId) as TelegramUpdateState | null;
  if (!db || !persisted) return 'no_state';

  const { Api } = require('telegram');
  let state = toTelegramUpdateState(persisted, persisted);
  try {
    for (let slice = 0; slice < 50; slice++) {
      const difference = await client.invoke(new Api.updates.GetDifference({
        pts: state.pts,
        date: state.date,
        qts: state.qts,
      }));

      if (difference instanceof Api.updates.DifferenceTooLong) {
        Logger.warn(`[TelegramUserListener] DifferenceTooLong for ${accountId}; falling back to dialog recovery`);
        return 'too_long';
      }

      if (difference instanceof Api.updates.DifferenceEmpty) {
        db.saveTelegramUpdateState(accountId, {
          ...state,
          date: Number(difference.date || state.date),
          seq: Number(difference.seq || state.seq),
        });
        return 'complete';
      }

      const entities = cacheDifferenceEntities(accountId, difference.users || [], difference.chats || []);
      await processDifferenceMessages(accountId, client, difference.newMessages || [], entities, 'global_difference');
      const rawHandler = rawUpdateHandlers.get(accountId);
      if (rawHandler) {
        for (const update of difference.otherUpdates || []) await rawHandler(update);
      }

      const nextState = difference instanceof Api.updates.DifferenceSlice
        ? difference.intermediateState
        : difference.state;
      state = toTelegramUpdateState(nextState, state);
      db.saveTelegramUpdateState(accountId, state);

      if (!(difference instanceof Api.updates.DifferenceSlice)) return 'complete';
    }
    Logger.warn(`[TelegramUserListener] Difference slice limit reached for ${accountId}`);
    return 'failed';
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] GetDifference failed for ${accountId}: ${err.message}`);
    return 'failed';
  }
}

async function saveCurrentTelegramUpdateState(accountId: string, client: TelegramClient): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;
  const { Api } = require('telegram');
  const state = await client.invoke(new Api.updates.GetState());
  db.saveTelegramUpdateState(accountId, toTelegramUpdateState(state, { pts: 0, qts: 0, date: 0, seq: 0 }));
}

type TelegramHistorySyncResult = {
  success: boolean;
  complete: boolean;
  inserted: number;
};

type TelegramAccountSyncResult = {
  success: boolean;
  historyComplete: boolean;
  inserted: number;
};

async function synchronizeTelegramAccount(
  accountId: string,
  client: TelegramClient,
  options: { includeHistory?: boolean } = {}
): Promise<TelegramAccountSyncResult> {
  if (recoveringUpdateAccounts.has(accountId)) {
    return { success: false, historyComplete: false, inserted: 0 };
  }
  recoveringUpdateAccounts.add(accountId);
  try {
    const differenceResult = await recoverTelegramUpdateDifference(accountId, client);
    // Channel cursors are the realtime catch-up path. Run them before the broad
    // dialog history backfill, which may hit messages.GetHistory FLOOD_WAIT.
    await recoverChannelUpdates(accountId, client);

    // A complete global difference plus per-channel recovery is authoritative.
    // Running a broad GetHistory pass anyway races channel difference (history
    // can insert first, causing the realtime path to dedup without a UI event)
    // and creates the FLOOD_WAIT storm observed during forum navigation.
    if (differenceResult === 'complete' && !options.includeHistory) {
      return { success: true, historyComplete: true, inserted: 0 };
    }

    const historyResult = await fetchMissedMessages(accountId, client);
    // Never advance a cursor after DifferenceTooLong or a failed difference:
    // the bounded dialog backfill may still have scheduled another pass.
    if (historyResult.success && historyResult.complete && differenceResult === 'no_state') {
      await saveCurrentTelegramUpdateState(accountId, client);
    }
    return {
      success: historyResult.success && differenceResult !== 'failed',
      historyComplete: historyResult.complete,
      inserted: historyResult.inserted,
    };
  } finally {
    recoveringUpdateAccounts.delete(accountId);
    const listener = activeListeners.get(accountId);
    if (listener?.client === client && listener.client.connected && !listener.stopped) {
      pollChannelUpdates(listener).catch(() => {});
    }
  }
}

async function waitForTelegramAccountSync(accountId: string, timeoutMs = 30_000): Promise<boolean> {
  const startedAt = Date.now();
  while (recoveringUpdateAccounts.has(accountId) || syncingAccounts.has(accountId)) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Explicit user-triggered catch-up. Unlike the reconnect fast path, this always
 * checks dialog history after draining Telegram update cursors. Persistence is
 * idempotent, so replayed socket/difference/history messages do not increment
 * unread state or emit a second new-message event.
 */
export async function refreshAccountMessages(accountId: string): Promise<{
  success: boolean;
  inserted?: number;
  pending?: boolean;
  error?: string;
}> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected || !listener.client.connected || listener.stopped) {
    return { success: false, error: 'Tài khoản Telegram chưa kết nối' };
  }

  const idle = await waitForTelegramAccountSync(accountId);
  if (!idle) {
    return { success: false, error: 'Telegram vẫn đang đồng bộ. Vui lòng thử lại sau.' };
  }

  try {
    const result = await synchronizeTelegramAccount(accountId, listener.client, { includeHistory: true });
    if (!result.success) {
      return { success: false, error: 'Không thể hoàn tất đồng bộ tin nhắn Telegram' };
    }
    return {
      success: true,
      inserted: result.inserted,
      pending: !result.historyComplete,
    };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] Manual refresh failed for ${accountId}: ${err.message}`);
    return { success: false, error: err.message || 'Không thể đồng bộ tin nhắn Telegram' };
  }
}

/**
 * Start a user-requested full Telegram catch-up without holding an IPC invoke
 * open for every dialog/history request. The renderer receives an immediate
 * acknowledgement, while completion is reported through event:telegramSync.
 */
export function startAccountMessageRefresh(accountId: string): {
  success: boolean;
  started?: boolean;
  pending?: boolean;
  error?: string;
} {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected || !listener.client.connected || listener.stopped) {
    return { success: false, error: 'Tài khoản Telegram chưa kết nối' };
  }
  if (manualRefreshTasks.has(accountId)) {
    return { success: true, started: false, pending: true };
  }

  const client = listener.client;
  const task = (async () => {
    EventBroadcaster.emit('event:telegramSync', { zaloId: accountId, status: 'started' });
    // A reconnect catch-up may already be active. Waiting here is safe because
    // this is a background task; the topbar must never time out while it waits.
    const idle = await waitForTelegramAccountSync(accountId, 5 * 60_000);
    if (!idle) {
      EventBroadcaster.emit('event:telegramSync', {
        zaloId: accountId,
        status: 'failed',
        error: 'Telegram đang bận đồng bộ quá lâu. Vui lòng thử lại sau.',
      });
      return;
    }
    if (listener.client !== client || listener.stopped || !client.connected) {
      EventBroadcaster.emit('event:telegramSync', {
        zaloId: accountId,
        status: 'failed',
        error: 'Kết nối Telegram đã bị ngắt trong lúc đồng bộ.',
      });
      return;
    }

    const result = await refreshAccountMessages(accountId);
    EventBroadcaster.emit('event:telegramSync', result.success
      ? { zaloId: accountId, status: 'completed', inserted: result.inserted || 0, pending: !!result.pending }
      : { zaloId: accountId, status: 'failed', error: result.error || 'Không thể đồng bộ tin nhắn Telegram' },
    );
  })();
  manualRefreshTasks.set(accountId, task);
  task.finally(() => {
    if (manualRefreshTasks.get(accountId) === task) manualRefreshTasks.delete(accountId);
  }).catch(() => {});
  return { success: true, started: true, pending: true };
}

/**
 * Phase D: Recover updates for channels/supergroups using per-channel PTS.
 * Uses drainChannelDifference for proper state machine handling.
 * Each channel has its own PTS independent of the global PTS.
 */
async function recoverChannelUpdates(accountId: string, client: TelegramClient): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  try {
    // Channel PTS is independent from the global update state. Only recover a
    // channel Telegram explicitly marked as needing a difference, plus a small
    // set the user is actively viewing. Scanning every cached peer causes
    // CHANNEL_PRIVATE retry loops and is not Telegram's update protocol.
    const now = Date.now();
    const leases = activeChannelLeases.get(accountId);
    if (leases) {
      for (const [channelId, expiresAt] of leases) {
        if (expiresAt <= now) leases.delete(channelId);
      }
    }
    const channelIds = [...new Set([
      ...(pendingChannelRecoveries.get(accountId)?.keys() || []),
      ...(leases?.keys() || []),
    ])];

    for (const channelId of channelIds) {
      const peer = db.getTelegramPeer(accountId, channelId);
      if (!peer?.access_hash) continue;
      const currentPts = db.getTelegramChannelPts(accountId, channelId)
        || pendingChannelRecoveries.get(accountId)?.get(channelId)
        || 0;
      // No durable cursor and no PTS from UpdateChannelTooLong: GetFullChannel
      // is deliberately not used as a seed because it represents *now*, not
      // the point before the offline gap. Use the bounded message-history
      // fallback below until Telegram gives us a channel cursor.
      if (currentPts <= 0) {
        if (pendingChannelRecoveries.get(accountId)?.has(channelId)) {
          const history = await backfillUnseededChannelHistory(accountId, client, channelId, peer.access_hash);
          if (!history.failed && history.complete) clearChannelRecoveryPending(accountId, channelId);
        }
        continue;
      }

      try {
        const recovered = await drainChannelDifference(accountId, client, channelId, peer.access_hash, currentPts, 'channel_difference');
        if (recovered === 'complete' || recovered === 'unavailable') {
          clearChannelRecoveryPending(accountId, channelId);
        } else {
          markChannelRecoveryPending(accountId, channelId, currentPts);
        }
      } catch (err: any) {
        markChannelRecoveryPending(accountId, channelId, currentPts);
        // tgLog('warn', accountId, 'channel_difference', `Recovery failed for ${channelId}: ${err.message}`);
      }
    }
  } catch (err: any) {
    tgLog('warn', accountId, 'channel_difference', `recoverChannelUpdates error: ${err.message}`);
  }
}

async function fetchMissedMessages(accountId: string, client: TelegramClient): Promise<TelegramHistorySyncResult> {
  const db = DatabaseService.getInstance();
  if (!db || syncingAccounts.has(accountId)) return { success: false, complete: false, inserted: 0 };
  syncingAccounts.add(accountId);
  let needsFollowUpSync = false;

  try {
    // Lấy thời gian tin nhắn cuối cùng đã lưu trong DB
    normalizeLegacyTelegramContacts(accountId);
    const existingCount = db.queryOne<any>(
      `SELECT COUNT(*) as count FROM messages WHERE owner_zalo_id = ? AND channel = 'telegram_user'`,
      [accountId]
    );
    const isFirstSync = (existingCount?.count || 0) === 0;

    // Lấy tất cả cuộc hội thoại (dialogs) — limit cao hơn cho lần đầu
    const dialogLimit = isFirstSync ? INITIAL_DIALOG_LIMIT : RECENT_DIALOG_LIMIT;
    const dialogs = await client.getDialogs({ limit: dialogLimit });

    // Lấy thêm archived dialogs (folder=1) để đồng bộ vào "Khác"
    let archivedDialogs: any[] = [];
    try {
      archivedDialogs = await client.getDialogs({ limit: dialogLimit, folder: 1 });
    } catch (err: any) {
      Logger.warn(`[TelegramUserListener] Failed to fetch archived dialogs: ${err.message}`);
    }

    // Gộp dialogs, dedup theo chatId (archived có thể trùng với main nếu user archive/recently)
    const allDialogs = [...dialogs];
    const seenIds = new Set(dialogs.map((d: any) => getCanonicalChatId(d.id)));
    for (const ad of archivedDialogs) {
      const adId = getCanonicalChatId(ad.id);
      if (adId && !seenIds.has(adId)) {
        allDialogs.push(ad);
        seenIds.add(adId);
      }
    }

    let totalSynced = 0;

    for (const dialog of allDialogs) {
      const chatId = getCanonicalChatId(dialog.id);
      if (!chatId) continue;
      if (dialog.entity) cacheTelegramPeer(accountId, chatId, dialog.entity);
      // Dialog metadata is independent from message history. Persist it even
      // when this dialog has no new messages so archive/mute/send rights stay
      // synchronized with Telegram.
      persistTelegramDialogState(accountId, chatId, dialog, dialog.entity);

      // Fetch tin nhắn gần nhất từ mỗi cuộc hội thoại
      // The first sync is deliberately bounded. On reconnect, load every
      // message after the newest durable ID for this dialog instead of an
      // arbitrary recent window. Telegram IDs are monotonic per peer,
      // including all topics below the same forum parent.
      let messages: any[];
      if (isFirstSync) {
        messages = await client.getMessages(dialog.id, { limit: INITIAL_MESSAGES_PER_DIALOG });
      } else {
        const checkpoint = db.queryOne<{ lastMessageId?: number }>(
          `SELECT MAX(CAST(msg_id AS INTEGER)) AS lastMessageId
           FROM messages
           WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
          [accountId, chatId]
        );
        const minId = Number(checkpoint?.lastMessageId || 0);
        if (!minId) {
          // A newly discovered dialog has no local checkpoint yet. Treat it
          // as a bounded first-load rather than unexpectedly downloading its
          // whole history during an unrelated reconnect.
          messages = await client.getMessages(dialog.id, { limit: INITIAL_MESSAGES_PER_DIALOG });
        } else {
          messages = [];
          for await (const message of client.iterMessages(dialog.id, {
            minId,
            limit: RECOVERY_MESSAGES_PER_DIALOG,
            // Oldest first means a bounded follow-up can safely advance the
            // durable max ID without skipping a gap in the middle.
            reverse: true,
          })) {
            messages.push(message);
          }
          if (messages.length === RECOVERY_MESSAGES_PER_DIALOG) {
            needsFollowUpSync = true;
            Logger.warn(`[TelegramUserListener] Recovery cap reached for ${accountId}/${chatId}; another sync pass is required`);
          }
        }
      }

      // Sort ASC by timestamp — message cuối cùng trong loop sẽ là mới nhất
      messages.sort((a: any, b: any) => (a.date || 0) - (b.date || 0));

      for (const msg of messages) {
        const msgTimestamp = (msg.date || 0) * 1000;
        const messageId = String(msg.id);
        if (!messageId) continue;

        // Phase B: Use persistTelegramMessage for idempotency
        const senderId = String(msg.senderId?.valueOf() || '');
        const isSelf = msg.out || false;
        const isGroup = dialog.isChannel || dialog.isGroup;
        const threadType = isGroup ? 1 : 0;

        // Resolve sender name for group last_message preview
        let senderName = '';
        if (isGroup && !isSelf) {
          try {
            const sender = await msg.getSender?.();
            if (sender) {
              senderName = (sender as any).firstName
                ? [(sender as any).firstName, (sender as any).lastName].filter(Boolean).join(' ')
                : (sender as any).title || (sender as any).username || '';
            }
          } catch {}
        }

        const dialogPeerType = dialog.entity
          ? getTelegramPeerType(dialog.entity)
          : db.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
        const { content, msgType, attachments } = normalizeTelegramMessageMedia(msg, dialogPeerType);
        const reactions = normalizeTelegramReactions((msg as any).reactions, accountId);

        const displayContent = content || (() => {
          if (msgType === 'audio') return '🎵 Audio';
          if (msgType !== 'text') return '';
          return '';
        })();

        if (!displayContent && msgType === 'text') continue;

        // Use idempotent persist — returns inserted/duplicate
        const result = persistTelegramMessage(db, {
          msgId: messageId, accountId, chatId, threadType,
          senderId, content: displayContent, msgType, timestamp: msgTimestamp,
          isSelf, attachments, topicId: getForumTopicId(msg), reactions,
        });

        // Side effects only on actual insert (P1.5)
        if (result.status === 'inserted') {
          // Media download for recent messages only
          if (attachments.some((attachment: any) =>
            attachment.type !== 'telegram_post'
            && attachment.type !== 'telegram_grouped_media'
            && attachment.type !== 'custom_emoji'
          ) && client) {
            const isRecent = (Date.now() - msgTimestamp) < 24 * 60 * 60 * 1000;
            if (isRecent) {
              downloadMediaForMessage(accountId, client, msg, messageId, msgType, chatId).catch(() => {});
            }
          }

          // Update contacts — chỉ cập nhật last_message, KHÔNG increment unread_count
          // (unread_count đã được đồng bộ chính xác từ Telegram dialog trong persistTelegramDialogState)
          const chatTitle = dialog.title || chatId;
          db.run(`
            INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
            VALUES (?, ?, ?, '', 0, ?, 0, ?, ?, 'telegram_user')
            ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
              display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
              last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
              last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
              channel = 'telegram_user'
          `, [accountId, chatId, chatTitle, isGroup ? 'group' : 'user', displayContent, msgTimestamp]);

          totalSynced++;
        }
      }
    }

    if (totalSynced > 0) {
      Logger.log(`[TelegramUserListener] Synced ${totalSynced} missed messages for ${accountId}`);
    }

    // Avatar hydration is demand-driven. Bulk profile downloads at login open
    // exported DC senders and can destabilize the primary MTProto transport.

    // Broadcast để UI refresh
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_sync' });
    return { success: true, complete: !needsFollowUpSync, inserted: totalSynced };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] fetchMissedMessages error: ${err.message}`);
    return { success: false, complete: false, inserted: 0 };
  } finally {
    syncingAccounts.delete(accountId);
    if (needsFollowUpSync && activeListeners.get(accountId)?.client === client) {
      setTimeout(() => {
        synchronizeTelegramAccount(accountId, client, { includeHistory: true }).catch(err => {
          Logger.warn(`[TelegramUserListener] Follow-up recovery failed: ${err.message}`);
        });
      }, 1000);
    }
  }
}

/**
 * Fetch avatar cho tất cả contacts trong dialogs
 */
async function fetchContactAvatars(accountId: string, client: TelegramClient, dialogs: any[]): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  for (const dialog of dialogs) {
    const chatId = getCanonicalChatId(dialog.id);
    if (!chatId) continue;

    try {
      // Kiểm tra đã có avatar chưa
      const existing = db.queryOne<any>(
        `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId]
      );
      if (existing?.avatar_url) continue; // Đã có avatar

      // Lấy thông tin entity từ dialog
      const entity = dialog.entity;
      if (!entity) continue;

      let avatarUrl = '';

      // Try download avatar photo
      try {
        const photo = await downloadProfilePhotoQueued(accountId, client, entity, `chat:${chatId}`, false);
        if (photo && photo.length > 0) {
          // Lưu avatar vào file và lấy URL
          const avatarPath = `telegram_avatar_${chatId}_${Date.now()}.jpg`;
          const savedPath = await saveAvatarToDisk(Buffer.from(photo), avatarPath);
          if (savedPath) {
            const normalized = savedPath.replace(/\\/g, '/');
            avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
          }
        }
      } catch {}

      if (avatarUrl) {
        db.run(`
          UPDATE contacts SET avatar_url = ?
          WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'
        `, [avatarUrl, accountId, chatId]);
      }
    } catch (err: any) {
      // Silent fail cho avatar
    }
  }

  // Broadcast để UI refresh avatars
  EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId });
}

/**
 * Lưu avatar buffer vào disk — dùng cùng base dir với FileStorageService
 */
async function saveAvatarToDisk(buffer: Buffer, filename: string): Promise<string | null> {
  try {
    const baseDir = FileStorageService.getBaseDir();

    const avatarsDir = path.join(baseDir, '_avatars', 'telegram');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }

    const filePath = path.join(avatarsDir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Re-download avatar for a specific Telegram contact (user/group/channel).
 */
export async function refreshContactAvatar(accountId: string, chatId: string): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const entity = await resolvePeerEntity(accountId, conn.client, chatId);
    if (!entity) return { success: false, error: 'Entity not found' };
    const photo = await downloadProfilePhotoQueued(accountId, conn.client, entity, `refresh:${chatId}`, false);
    if (!photo || photo.length === 0) return { success: false, error: 'No photo available' };
    const avatarPath = `telegram_avatar_${chatId}_${Date.now()}.jpg`;
    const savedPath = await saveAvatarToDisk(Buffer.from(photo), avatarPath);
    if (!savedPath) return { success: false, error: 'Failed to save avatar' };
    const normalized = savedPath.replace(/\\/g, '/');
    const avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
    const db = DatabaseService.getInstance();
    db?.run(`UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`, [avatarUrl, accountId, chatId]);
    resetAvatarCache(accountId, chatId);
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_avatar_refresh' });
    return { success: true, avatarUrl };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Cache for bot commands: `${accountId}_${botId}` → { commands, fetchedAt } */
const botCommandsCache = new Map<string, { commands: Array<{ command: string; description: string }>; fetchedAt: number }>();
const BOT_COMMANDS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch bot commands via users.getFullUser → UserFull.botInfo.commands.
 * Any user account can call this — no bot owner credentials needed.
 */
export async function getBotCommands(accountId: string, botId: string): Promise<{ success: boolean; commands?: Array<{ command: string; description: string }>; error?: string }> {
  const cacheKey = `${accountId}_${botId}`;
  const cached = botCommandsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BOT_COMMANDS_CACHE_TTL) {
    return { success: true, commands: cached.commands };
  }

  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, botId) as any;
    if (!entity) return { success: false, error: 'Bot not found' };

    // Build InputUser from entity (avoids resolveInputUser which fails for large IDs)
    const accessHash = entity.accessHash;
    if (!accessHash) return { success: false, error: 'Cannot get bot access hash' };

    const inputUser = new Api.InputUser({ userId: BigInt(String(botId)), accessHash: BigInt(String(accessHash)) });
    const full = await conn.client.invoke(new Api.users.GetFullUser({ id: inputUser })) as any;

    // Extract botInfo from UserFull
    const botInfo = full?.fullUser?.botInfo;
    if (!botInfo) return { success: true, commands: [] }; // Not a bot or no commands

    const commands = (botInfo.commands || []).map((cmd: any) => ({
      command: cmd.command || '',
      description: cmd.description || '',
    }));

    botCommandsCache.set(cacheKey, { commands, fetchedAt: Date.now() });
    return { success: true, commands };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Telegram WebView (Mini App) ─────────────────────────────────────────────

/**
 * Open a Mini App via messages.requestWebView.
 * Used for: inline keyboard WebView buttons, custom bot menu buttons.
 */
export async function requestWebView(
  accountId: string, botId: string, url: string, fromBotMenu = false
): Promise<{ success: boolean; webViewUrl?: string; queryId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, botId);
    if (!entity) return { success: false, error: 'Bot not found' };

    const accessHash = entity.accessHash;
    if (!accessHash) return { success: false, error: 'Cannot get bot access hash' };

    const peer = await resolveInputPeer(accountId, conn.client, botId);
    const bot = new Api.InputUser({ userId: BigInt(String(botId)), accessHash: BigInt(String(accessHash)) });

    const result = await conn.client.invoke(new Api.messages.RequestWebView({
      peer,
      bot,
      url: url || undefined,
      platform: 'desktop',
      ...(fromBotMenu ? { fromBotMenu: true } : {}),
    })) as any;

    return {
      success: true,
      webViewUrl: result?.url || '',
      queryId: String(result?.queryId || ''),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Open a bot's Main Mini App via messages.requestMainWebView.
 * Used for: "Open" button in conversation list for bots with Main Mini App.
 */
export async function requestMainWebView(
  accountId: string, botId: string, startParam?: string
): Promise<{ success: boolean; webViewUrl?: string; queryId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, botId);
    if (!entity) return { success: false, error: 'Bot not found' };

    const accessHash = entity.accessHash;
    if (!accessHash) return { success: false, error: 'Cannot get bot access hash' };

    const peer = await resolveInputPeer(accountId, conn.client, botId);
    const bot = new Api.InputUser({ userId: BigInt(String(botId)), accessHash: BigInt(String(accessHash)) });

    const result = await conn.client.invoke(new Api.messages.RequestMainWebView({
      peer,
      bot,
      platform: 'desktop',
      ...(startParam ? { startParam } : {}),
    })) as any;

    return {
      success: true,
      webViewUrl: result?.url || '',
      queryId: String(result?.queryId || ''),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Keep WebView alive. Must be called every ~60s while WebView is open.
 */
export async function prolongWebView(
  accountId: string, botId: string, queryId: string
): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, botId);
    if (!entity) return { success: false, error: 'Bot not found' };

    const accessHash = entity.accessHash;
    if (!accessHash) return { success: false, error: 'Cannot get bot access hash' };

    const peer = await resolveInputPeer(accountId, conn.client, botId);
    const bot = new Api.InputUser({ userId: BigInt(String(botId)), accessHash: BigInt(String(accessHash)) });

    await conn.client.invoke(new Api.messages.ProlongWebView({
      peer,
      bot,
      queryId: BigInt(queryId),
    }));

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

/** Rate limiter: 30 tin/phút per account, refill dần (1 token mỗi 2 giây) */
const rateLimiters = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_MAX_TOKENS = 30;
const RATE_LIMIT_REFILL_INTERVAL_MS = 2000; // 1 token mỗi 2 giây

function checkRateLimit(accountId: string): { allowed: boolean; waitSeconds?: number } {
  let limiter = rateLimiters.get(accountId);
  if (!limiter) {
    limiter = { tokens: RATE_LIMIT_MAX_TOKENS, lastRefill: Date.now() };
    rateLimiters.set(accountId, limiter);
  }

  // Refill tokens dần dần
  const now = Date.now();
  const elapsed = now - limiter.lastRefill;
  const tokensToAdd = Math.floor(elapsed / RATE_LIMIT_REFILL_INTERVAL_MS);
  if (tokensToAdd > 0) {
    limiter.tokens = Math.min(RATE_LIMIT_MAX_TOKENS, limiter.tokens + tokensToAdd);
    limiter.lastRefill += tokensToAdd * RATE_LIMIT_REFILL_INTERVAL_MS; // Fix: don't drift the clock
  }

  if (limiter.tokens <= 0) {
    // Tính thời gian chờ cho token tiếp theo
    const waitMs = RATE_LIMIT_REFILL_INTERVAL_MS - (now - limiter.lastRefill);
    const waitSeconds = Math.ceil(waitMs / 1000);
    return { allowed: false, waitSeconds };
  }
  limiter.tokens--;
  return { allowed: true };
}

/** Resolve a usable InputPeer from GramJS's entity cache first, then the
 * durable peer registry. A bare Telegram user ID is not sufficient to send
 * messages because MTProto requires its access hash. */
async function resolveInputPeer(accountId: string, client: TelegramClient, peerId: string): Promise<any> {
  try {
    return await client.getInputEntity(peerId);
  } catch (cacheError: any) {
    const cached = DatabaseService.getInstance()?.getTelegramPeer(accountId, peerId);
    if (!cached) {
      throw new Error(`Không tìm thấy Telegram peer ${peerId}. Hãy mở hội thoại hoặc tìm username trước.`);
    }

    const { Api } = require('telegram');
    const peerType = String(cached.peer_type || 'user');
    const accessHash = String(cached.access_hash || '');
    const rawId = peerType === 'channel' || peerType === 'supergroup' || peerType === 'forum'
      ? String(peerId).replace(/^-100/, '')
      : String(peerId).replace(/^-/, '');

    if (peerType === 'basic_group') {
      return new Api.InputPeerChat({ chatId: BigInt(rawId) });
    }
    if (!accessHash) {
      throw new Error(`Telegram peer ${peerId} chưa có access hash hợp lệ.`);
    }
    if (peerType === 'channel' || peerType === 'supergroup' || peerType === 'forum') {
      return new Api.InputPeerChannel({ channelId: BigInt(rawId), accessHash: BigInt(accessHash) });
    }
    return new Api.InputPeerUser({ userId: BigInt(rawId), accessHash: BigInt(accessHash) });
  }
}

/** Resolve a peer's full entity when it is still available, while refreshing
 * the durable registry. Callers must tolerate an unavailable entity: after an
 * app restart GramJS's in-memory entity cache is empty by design. */
async function resolvePeerEntity(accountId: string, client: TelegramClient, peerId: string): Promise<any | null> {
  const cached = DatabaseService.getInstance()?.getTelegramPeer(accountId, peerId);
  if (cached) {
    try {
      const { Api } = require('telegram');
      const peerType = String(cached.peer_type || 'user');
      const rawId = peerType === 'channel' || peerType === 'supergroup' || peerType === 'forum'
        ? String(peerId).replace(/^-100/, '')
        : String(peerId).replace(/^-/, '');
      const accessHash = String(cached.access_hash || '');
      const inputPeer = peerType === 'basic_group'
        ? new Api.InputPeerChat({ chatId: BigInt(rawId) })
        : isChannelPeerType(peerType) && accessHash
          ? new Api.InputPeerChannel({ channelId: BigInt(rawId), accessHash: BigInt(accessHash) })
          : accessHash
            ? new Api.InputPeerUser({ userId: BigInt(rawId), accessHash: BigInt(accessHash) })
            : null;
      if (inputPeer) {
        const entity = await client.getEntity(inputPeer);
        cacheTelegramPeer(accountId, peerId, entity);
        return entity;
      }
    } catch {
      // A stale durable access hash is not repaired by retrying a bare marked
      // ID; that would issue channels.GetChannels with no usable hash and
      // produce the noisy CHANNEL_INVALID stack seen at startup.
      return null;
    }
  }
  try {
    const entity = await client.getEntity(peerId);
    cacheTelegramPeer(accountId, peerId, entity);
    return entity;
  } catch {
    return null;
  }
}

async function hydrateTelegramIdentity(
  accountId: string,
  client: TelegramClient,
  userId: string,
  chatId?: string,
  entityHint?: any,
): Promise<any | null> {
  if (!userId) return null;
  const key = `${accountId}:${chatId || '-'}:${userId}`;
  const existing = entityHydrationQueues.get(key);
  if (existing) return existing;
  let task!: Promise<any | null>;
  task = (async () => {
    const entity = entityHint || await resolvePeerEntity(accountId, client, userId);
    if (!entity) return null;
    cacheTelegramPeer(accountId, userId, entity);
    // Update is_cov_bot flag for bot users
    if (entity.className === 'User' && entity.bot) {
      const db = DatabaseService.getInstance();
      db?.run(`UPDATE contacts SET is_cov_bot = 1 WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`, [accountId, userId]);
    }
    const displayName = [entity.firstName, entity.lastName].filter(Boolean).join(' ')
      || entity.title || entity.username || userId;
    let cachedAvatar = '';
    if (chatId && chatId !== userId) {
      const db = DatabaseService.getInstance();
      const cached = db?.queryOne<any>(
        `SELECT avatar, role FROM page_group_member
         WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, chatId, userId],
      );
      cachedAvatar = cached?.avatar || '';
      db?.upsertGroupMember(accountId, chatId, {
        memberId: userId,
        displayName,
        avatar: cachedAvatar,
        role: Number(cached?.role || 0),
        username: entity.username || '',
      });
      if (entity.className === 'User' && entity.photo && entity.photo !== 'ChatPhotoEmpty' && !cached?.avatar) {
        scheduleGroupMemberAvatarHydration(
          accountId,
          chatId,
          client,
          [entity],
          new Map(),
          new Map([[userId, Number(cached?.role || 0)]]),
        );
      }
    }
    EventBroadcaster.emit('event:telegramEntityHydrated', {
      zaloId: accountId,
      threadId: chatId,
      userId,
      displayName,
      username: entity.username || '',
      avatar: cachedAvatar,
      ...getTelegramUserStatus(entity),
    });
    return entity;
  })().finally(() => {
    if (entityHydrationQueues.get(key) === task) entityHydrationQueues.delete(key);
  });
  entityHydrationQueues.set(key, task);
  return task;
}

/** A typing update only carries a peer ID. Give the identity request a short
 * head start before publishing the indicator so a cold member cache does not
 * render a numeric Telegram ID. Hydration still completes in the background
 * and emits its cache-update event if Telegram takes longer than this bound. */
async function hydrateTelegramTypingIdentity(
  accountId: string,
  client: TelegramClient,
  userId: string,
  chatId?: string,
): Promise<void> {
  const hydration = hydrateTelegramIdentity(accountId, client, userId, chatId).catch(() => null);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hydration,
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, 350);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isChannelPeerType(peerType: string | undefined): boolean {
  return peerType === 'channel' || peerType === 'supergroup' || peerType === 'forum';
}

/** Determine chat type without treating a failed entity-cache lookup as a
 * different Telegram chat type. */
async function resolveChatPeerType(accountId: string, client: TelegramClient, chatId: string): Promise<TelegramPeerType> {
  const entity = await resolvePeerEntity(accountId, client, chatId);
  if (entity) return getTelegramPeerType(entity);
  const cached = DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId);
  if (cached?.peer_type) return cached.peer_type as TelegramPeerType;
  throw new Error(`KhÃ´ng tÃ¬m tháº¥y Telegram chat ${chatId}. HÃ£y táº£i láº¡i danh sÃ¡ch há»™i thoáº¡i.`);
}

/** Channel RPCs require InputChannel (not InputPeerChannel). Build it from
 * the live entity when possible, otherwise from the persisted access hash. */
async function resolveInputChannel(accountId: string, client: TelegramClient, chatId: string): Promise<any> {
  const { Api } = require('telegram');

  // 1. Try GramJS's getInputEntity — uses session cache + entity cache + API fallback.
  //    This is the most reliable way to get a fresh InputChannel.
  try {
    const inputEntity = await client.getInputEntity(chatId);
    if (inputEntity) return inputEntity;
  } catch {
    // getInputEntity failed — fall through to manual resolution
  }

  // 2. Try getEntity to fetch a fresh entity with access hash
  const entity = await resolvePeerEntity(accountId, client, chatId);
  const liveAccessHash = entity?.accessHash;
  if (entity?.className === 'Channel' && liveAccessHash != null) {
    return new Api.InputChannel({ channelId: BigInt(entity.id), accessHash: BigInt(liveAccessHash) });
  }

  // 3. Fall back to DB-persisted peer (may have stale access hash)
  const cached = DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId);
  if (!isChannelPeerType(cached?.peer_type)) {
    throw new Error(`Telegram peer ${chatId} không phải supergroup/channel.`);
  }
  const accessHash = String(cached?.access_hash || '');
  if (!accessHash) {
    throw new Error(`Telegram channel ${chatId} chưa có access hash hợp lệ.`);
  }
  return new Api.InputChannel({
    channelId: BigInt(String(chatId).replace(/^-100/, '').replace(/^-/, '')),
    accessHash: BigInt(accessHash),
  });
}

/** Participant-management RPCs require InputUser. */
async function resolveInputUser(accountId: string, client: TelegramClient, userId: string): Promise<any> {
  const { Api } = require('telegram');
  const entity = await resolvePeerEntity(accountId, client, userId);
  if (entity?.className === 'User' && entity.accessHash != null) {
    return new Api.InputUser({ userId: BigInt(entity.id), accessHash: BigInt(entity.accessHash) });
  }
  const cached = DatabaseService.getInstance()?.getTelegramPeer(accountId, userId);
  if (cached?.peer_type && cached.peer_type !== 'user') {
    throw new Error(`Telegram peer ${userId} khÃ´ng pháº£i ngÆ°á»i dÃ¹ng.`);
  }
  const accessHash = String(cached?.access_hash || '');
  if (!accessHash) {
    throw new Error(`Telegram user ${userId} chÆ°a cÃ³ access hash há»£p lá»‡.`);
  }
  return new Api.InputUser({
    userId: BigInt(String(userId).replace(/^-/, '')),
    accessHash: BigInt(accessHash),
  });
}

// ─── Send Message ────────────────────────────────────────────────────────────

function getPersistedTelegramSendDenial(accountId: string, chatId: string): string | null {
  try {
    const state = DatabaseService.getInstance()?.queryOne<any>(
      `SELECT telegram_can_send, telegram_send_reason, telegram_state_updated_at FROM contacts
       WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, chatId],
    );
    if (state?.telegram_can_send !== 0) return null;
    // Stale denial: if the denial is older than 5 minutes, allow retry
    // This prevents temporary connection issues from permanently blocking sends
    const updatedAt = Number(state.telegram_state_updated_at || 0);
    if (updatedAt > 0 && (Date.now() - updatedAt) > 5 * 60 * 1000) {
      Logger.log(`[TelegramUserListener] Stale send denial for ${chatId}, allowing retry`);
      return null;
    }
    return state.telegram_send_reason || 'Bạn không có quyền gửi tin nhắn trong cuộc trò chuyện này';
  } catch {
    return null;
  }
}

export async function sendMessage(accountId: string, chatId: string, text: string, mentions?: Array<{ uid: string; pos: number; len: number }>, replyToMsgId?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    return { success: false, error: 'Telegram client not connected' };
  }
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };

  // Rate limit check
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) {
    return { success: false, error: `Gửi tin quá nhanh. Vui lòng chờ ${rateLimit.waitSeconds} giây.` };
  }

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);

    // Build mention entities từ mentions array
    const entities: any[] = [];
    if (mentions && mentions.length > 0) {
      for (const m of mentions) {
        if (!m.uid) continue;
        try {
          const entity = await resolveInputPeer(accountId, listener.client, m.uid);
          if (entity) {
            entities.push(new Api.InputMessageEntityMentionName({
              offset: m.pos,
              length: m.len,
              userId: entity,
            }));
          }
        } catch {}
      }
    }

    const sendOpts: any = { message: text };
    if (entities.length > 0) sendOpts.entities = entities;
    if (replyToMsgId) sendOpts.replyTo = Number(replyToMsgId);

    const result = await listener.client.sendMessage(peer, sendOpts);
    const msgId = String(result?.id || Date.now());

    // Save sent message to DB (INSERT OR IGNORE — socket echo sẽ skip nếu đã tồn tại)
    const now = Date.now();
    const threadType = chatId.startsWith('-') ? 1 : 0;
    // Build quote_data nếu reply
    let quoteData: string | null = null;
    if (replyToMsgId) {
      const dbQuote = DatabaseService.getInstance()?.queryOne<any>(
        `SELECT content, msg_type, sender_id FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [replyToMsgId, accountId, chatId]
      );
      if (dbQuote) {
        quoteData = JSON.stringify({ msgId: replyToMsgId, msg: dbQuote.content || '', senderId: dbQuote.sender_id || '', msgType: dbQuote.msg_type || 'text' });
      } else {
        quoteData = JSON.stringify({ msgId: replyToMsgId, msg: '', senderId: '', msgType: 'text' });
      }
    }
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`
        INSERT OR IGNORE INTO messages
          (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data)
        VALUES (?, ?, ?, ?, ?, ?, 'text', ?, 1, '[]', 'sent', 'telegram_user', ?, ?)
      `, [msgId, accountId, chatId, threadType, accountId, text, now, replyToMsgId || null, quoteData]);

      // Update contacts (last_message, last_message_time) — đảm bảo conversation list cập nhật ngay
      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END
      `, [accountId, chatId, threadType === 1 ? 'group' : 'user', text, now]);
    }

    // Emit event cho renderer — socket echo sẽ skip do persistTelegramMessage trả 'existing'
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: {
        type: threadType,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: text,
          msgType: 'text',
          ts: String(now),
          replyToId: replyToMsgId || undefined,
          quoteData: quoteData || undefined,
        },
      },
    });

    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Edit message (User API)
 */
export async function editMessage(accountId: string, chatId: string, messageId: string, text: string): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    await listener.client.editMessage(peer, { message: Number(messageId), text });
    // Update DB
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`UPDATE messages SET content = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`, [text, messageId, accountId, chatId]);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Pin message (User API) — uses messages.UpdatePinnedMessage
 */
export async function syncPinnedMessages(
  accountId: string,
  chatId: string,
): Promise<{ success: boolean; pins?: any[]; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const { Api } = await import('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const db = DatabaseService.getInstance();
    const entities = new Map<string, any>();
    const pinnedMessages: any[] = [];
    const seenMessageIds = new Set<string>();
    let offsetId = 0;

    // messages.search pages at 100 messages, but Telegram supports multiple
    // pinned messages and does not impose Zalo's three-message rule. Retrieve
    // every page so the local snapshot never truncates pins after the first 100.
    while (true) {
      const result: any = await listener.client.invoke(new Api.messages.Search({
        peer, q: '', filter: new Api.InputMessagesFilterPinned(), minDate: 0, maxDate: 0,
        offsetId, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: BigInt(0) as any,
      }));
      for (const entity of [...(result?.users || []), ...(result?.chats || [])]) {
        const entityId = getCanonicalChatId(entity);
        if (!entityId) continue;
        entities.set(entityId, entity);
        cacheTelegramPeer(accountId, entityId, entity);
      }

      const page = (result?.messages || []).filter((item: any) => item?.className === 'Message');
      if (page.length === 0) break;
      for (const message of page) {
        const messageId = String(message.id || '');
        if (messageId && !seenMessageIds.has(messageId)) {
          seenMessageIds.add(messageId);
          pinnedMessages.push(message);
        }
      }
      if (page.length < 100) break;
      const nextOffsetId = Number(page[page.length - 1]?.id || 0);
      if (!nextOffsetId || nextOffsetId === offsetId) break;
      offsetId = nextOffsetId;
    }
    const peerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const chatEntity = entities.get(chatId);
    const chatDisplayName = chatEntity?.title
      || db?.getTelegramPeer(accountId, chatId)?.display_name
      || db?.queryOne<any>(
        `SELECT display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId],
      )?.display_name
      || 'Kênh/Nhóm Telegram';
    const pins: any[] = [];
    for (const message of pinnedMessages) {
        const normalized = normalizeTelegramMessageMedia(message, peerType);
        const senderId = getCanonicalChatId(message.fromId)
          || String(message.senderId?.valueOf?.() || '');
        const sender = entities.get(senderId);
        const senderName = sender
          ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.title || sender.username || chatDisplayName
          : senderId === chatId ? chatDisplayName : 'Thành viên Telegram';
        if (sender?.className === 'User') {
          await hydrateTelegramIdentity(accountId, listener.client, senderId, chatId, sender);
        }
        if (db) {
          persistTelegramMessage(db, {
            msgId: String(message.id), accountId, chatId,
            threadType: chatId.startsWith('-') ? 1 : 0,
            senderId: senderId || chatId,
            content: normalized.content,
            msgType: normalized.msgType,
            timestamp: Number(message.date || 0) * 1000,
            isSelf: !!message.out,
            attachments: normalized.attachments,
            replyToId: getTelegramReplyToMessageId(message),
            topicId: getForumTopicId(message),
            reactions: normalizeTelegramReactions(message.reactions, accountId),
          });
        }
        const stored = db?.queryOne<any>(
          `SELECT local_paths FROM messages
           WHERE owner_zalo_id = ? AND thread_id = ? AND msg_id = ? AND channel = 'telegram_user'`,
          [accountId, chatId, String(message.id)],
        );
        let previewImage = '';
        try {
          const paths = JSON.parse(stored?.local_paths || '{}');
          previewImage = paths.main || paths.file || paths.image || paths.thumbnail || paths.video || '';
        } catch {}
        pins.push({
          msgId: String(message.id), msgType: normalized.msgType,
          content: normalized.content, previewText: normalized.content, previewImage,
          senderId, senderName, timestamp: Number(message.date || 0) * 1000,
        });
    }
    db?.replaceRemotePinnedMessages(accountId, chatId, pins);
    EventBroadcaster.emit('event:pinsUpdated', { zaloId: accountId, threadId: chatId });
    return { success: true, pins: db?.getPinnedMessages(accountId, chatId) || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Ensure a pinned/search target exists in the local timeline. Telegram message
 * IDs are scoped to the peer, so both lookup and persistence include chatId.
 * Missing media is downloaded before returning so the opened target is not a
 * permanent placeholder. This path deliberately has no unread/contact/new
 * message side effects. */
export async function ensureMessageAvailable(
  accountId: string,
  chatId: string,
  messageId: string,
): Promise<{ success: boolean; message?: any; error?: string }> {
  const db = DatabaseService.getInstance();
  const numericMessageId = Number(messageId);
  if (!db || !accountId || !chatId || !Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    return { success: false, error: 'Invalid Telegram message identity' };
  }

  const existing = db.getMessageById(accountId, messageId, chatId) as any;
  let existingLocalPaths: Record<string, string> = {};
  try { existingLocalPaths = JSON.parse(existing?.local_paths || '{}'); } catch {}
  const existingNeedsMedia = !!existing && ['photo', 'video', 'audio', 'file', 'sticker'].includes(String(existing.msg_type || ''));
  if (existing && (!existingNeedsMedia || Object.values(existingLocalPaths).some(Boolean))) {
    return { success: true, message: existing };
  }

  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    return existing
      ? { success: true, message: existing }
      : { success: false, error: 'Telegram listener is not connected' };
  }

  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const fetched = await listener.client.getMessages(peer, { ids: [numericMessageId] });
    const message = (fetched || []).find((item: any) =>
      String(item?.id || '') === messageId && item?.className !== 'MessageEmpty'
    );
    if (!message) {
      tgLog('warn', accountId, 'history', 'PIN_TARGET_NOT_FOUND', { chatId, messageId });
      return { success: false, error: 'Telegram message was not found' };
    }

    const peerType = db.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const normalized = normalizeTelegramMessageMedia(message, peerType);
    const senderId = getCanonicalChatId((message as any).fromId)
      || String((message as any).senderId?.valueOf?.() || '')
      || chatId;
    const persisted = persistTelegramMessage(db, {
      msgId: messageId, accountId, chatId,
      threadType: chatId.startsWith('-') ? 1 : 0,
      senderId,
      content: normalized.content,
      msgType: normalized.msgType,
      timestamp: Number((message as any).date || 0) * 1000,
      isSelf: !!(message as any).out,
      attachments: normalized.attachments,
      replyToId: getTelegramReplyToMessageId(message),
      topicId: getForumTopicId(message),
    });
    if (persisted.status === 'failed') return { success: false, error: 'Could not persist Telegram message' };

    try {
      const sender = await (message as any).getSender?.();
      if (sender?.className === 'User') {
        await hydrateTelegramIdentity(accountId, listener.client, senderId, chatId, sender);
      }
    } catch {}

    const hasMedia = !!(message as any).media
      && String((message as any).media?.className || '') !== 'MessageMediaEmpty';
    if (hasMedia && !Object.values(existingLocalPaths).some(Boolean)) {
      await downloadMediaForMessage(accountId, listener.client, message, messageId, normalized.msgType, chatId);
    }

    const stored = db.getMessageById(accountId, messageId, chatId) as any;
    tgLog('info', accountId, 'history', 'PIN_TARGET_FETCHED', {
      chatId, messageId, result: persisted.status, msgType: normalized.msgType,
    });
    return { success: true, message: stored || existing };
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'PIN_TARGET_FAILED', {
      chatId, messageId, error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
}

export async function pinMessage(
  accountId: string,
  chatId: string,
  messageId: string,
  silent?: boolean,
  unpin?: boolean,
): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    await (listener.client as any).invoke(new (await import('telegram')).Api.messages.UpdatePinnedMessage({
      peer,
      id: Number(messageId),
      silent: silent ?? true,
      unpin: unpin || undefined,
    }));
    await syncPinnedMessages(accountId, chatId);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete message (User API)
 */
export async function deleteMessages(accountId: string, chatId: string, messageIds: string[]): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    await listener.client.deleteMessages(peer, messageIds.map(Number), { revoke: true });
    // Update DB
    const db = DatabaseService.getInstance();
    if (db) {
      for (const msgId of messageIds) {
        db.run(`UPDATE messages SET msg_type = 'deleted' WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`, [msgId, accountId, chatId]);
      }
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Get messages from a chat (User API).
 * Returns normalized messages compatible with the renderer message model.
 */
export async function getMessages(
  accountId: string,
  chatId: string,
  opts?: { limit?: number; offsetId?: number; topicRootMessageId?: string }
): Promise<{ success: boolean; messages?: any[]; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };

  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    // getMessages() is a single-page convenience call (100 items here before).
    // The header accepts up to 5,000, so use GramJS's paginator to honor the
    // requested amount rather than silently reporting a partial download.
    const requestedLimit = Number(opts?.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50, 1),
      MAX_MANUAL_MESSAGE_DOWNLOAD,
    );
    const fetchOpts: any = { limit };
    if (opts?.offsetId) fetchOpts.offsetId = opts.offsetId;
    // For forum topics, use replyToMsgId filter
    if (opts?.topicRootMessageId) fetchOpts.replyTo = Number(opts.topicRootMessageId);

    const rawMessages: any[] = [];
    for await (const message of listener.client.iterMessages(peer, fetchOpts)) {
      rawMessages.push(message);
    }
    const db = DatabaseService.getInstance();
    const messages: any[] = [];
    let scheduledMediaDownloads = 0;
    const rawMessageById = new Map<string, any>();
    for (const rawMessage of rawMessages || []) {
      if (rawMessage?.id != null) rawMessageById.set(String(rawMessage.id), rawMessage);
    }

    for (const msg of rawMessages || []) {
      if (!msg) continue;
      const msgId = String(msg.id);
      const senderId = String(msg.senderId?.valueOf() || '');
      const isSelf = msg.out || false;
      const timestamp = ((msg as any).date || Math.floor(Date.now() / 1000)) * 1000;

      const cachedPeerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
      const { content, msgType, attachments } = normalizeTelegramMessageMedia(msg, cachedPeerType);
      const reactions = normalizeTelegramReactions((msg as any).reactions, accountId);

      // Reply detection
      const replyToId = getTelegramReplyToMessageId(msg);
      const topicId = getForumTopicId(msg);

      let quoteData: string | undefined;
      if (replyToId) {
        const rawOriginal = rawMessageById.get(replyToId);
        if (rawOriginal) {
          const originalMedia = normalizeTelegramMessageMedia(rawOriginal, cachedPeerType);
          const origSenderId = String(rawOriginal.senderId?.valueOf() || '');
          // Resolve sender name from raw message entities or group members
          let origSenderName = '';
          const origSender = (rawOriginal as any).sender || (rawOriginal as any).fromId;
          if (origSender?.firstName) {
            origSenderName = [origSender.firstName, origSender.lastName].filter(Boolean).join(' ');
          }
          if (!origSenderName && origSenderId) {
            const member = db?.queryOne<any>(
              `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
              [accountId, chatId, origSenderId]
            );
            origSenderName = member?.display_name || '';
          }
          quoteData = buildTelegramQuoteData({
            msgId: replyToId,
            content: originalMedia.content,
            msgType: originalMedia.msgType,
            senderId: origSenderId,
            senderName: origSenderName,
            attachments: originalMedia.attachments,
          });
        } else {
          const original = db?.queryOne<any>(
            `SELECT content, msg_type, sender_id, attachments, local_paths FROM messages
             WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
            [replyToId, accountId, chatId],
          );
          if (original) {
            // Resolve sender name from group members
            let origSenderName2 = '';
            if (original.sender_id) {
              const member2 = db?.queryOne<any>(
                `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
                [accountId, chatId, original.sender_id]
              );
              origSenderName2 = member2?.display_name || '';
            }
            quoteData = buildTelegramQuoteData({
              msgId: replyToId,
              content: original.content,
              msgType: original.msg_type,
              senderId: original.sender_id,
              senderName: origSenderName2,
              attachments: original.attachments,
              localPaths: original.local_paths,
            });
          }
        }
      }

      const existingMessage = db?.queryOne<any>(
        `SELECT local_paths FROM messages
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [msgId, accountId, chatId],
      );
      const normalizedMessage = {
        msg_id: msgId,
        owner_zalo_id: accountId,
        thread_id: chatId,
        thread_type: (chatId.startsWith('-') ? 1 : 0),
        sender_id: senderId,
        content,
        msg_type: msgType,
        timestamp,
        is_sent: isSelf ? 1 : 0,
        status: 'received',
        attachments: attachments.length ? JSON.stringify(attachments) : '[]',
        reactions: JSON.stringify(reactions),
        channel: 'telegram_user',
        reply_to_id: replyToId || null,
        quote_data: quoteData || null,
        topic_id: topicId || null,
        local_paths: existingMessage?.local_paths || null,
      };
      messages.push(normalizedMessage);

      // Persist to DB
      if (db) {
        try {
          db.run(`
            INSERT OR IGNORE INTO messages
              (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, reactions, status, channel, reply_to_id, quote_data, topic_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 'telegram_user', ?, ?, ?)
          `, [msgId, accountId, chatId, chatId.startsWith('-') ? 1 : 0, senderId, content, msgType, timestamp, isSelf ? 1 : 0, attachments.length ? JSON.stringify(attachments) : '[]', JSON.stringify(reactions), replyToId || null, quoteData || null, topicId || null]);
          // Repair legacy API-synced rows without replaying contact/unread/UI
          // side effects. local_paths remains untouched.
          db.run(`
            UPDATE messages
            SET attachments = CASE WHEN ? != '[]' THEN ? ELSE attachments END,
                msg_type = CASE WHEN msg_type = 'text' AND ? != 'text' THEN ? ELSE msg_type END,
                reactions = ?,
                reply_to_id = ?,
                quote_data = COALESCE(quote_data, ?),
                topic_id = COALESCE(topic_id, ?)
            WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
          `, [JSON.stringify(attachments), JSON.stringify(attachments), msgType, msgType, JSON.stringify(reactions), replyToId || null, quoteData || null, topicId || null, msgId, accountId, chatId]);
        } catch {}
      }

      // API history can contain media that was never seen by the realtime
      // listener. Hydrate the visible item and let event:localPath update the
      // same store row; existing files are never downloaded again.
      const hasLocalMedia = !!existingMessage?.local_paths && existingMessage.local_paths !== '{}';
      if ((msg as any).media && !hasLocalMedia && scheduledMediaDownloads < 12) {
        scheduledMediaDownloads++;
        downloadMediaForMessage(accountId, listener.client, msg, msgId, msgType, chatId).catch(() => {});
      }
    }

    return { success: true, messages };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export type TelegramQuoteRepairResult = {
  messageId: string;
  replyToId: string;
  status: 'repaired' | 'topic_routing' | 'not_found' | 'deferred' | 'invalid';
  quoteData?: string;
};

/** Repair legacy Telegram quote previews in one account-scoped batch.
 * Local DB originals are preferred; only genuinely missing originals trigger
 * one batched MTProto lookup. This never inserts messages or emits unread/UI
 * new-message events. */
export function repairMessageQuotes(
  accountId: string,
  chatId: string,
  items: Array<{ messageId: string; replyToId: string }>,
): Promise<{ success: boolean; results?: TelegramQuoteRepairResult[]; error?: string }> {
  const safeItems = (Array.isArray(items) ? items : [])
    .slice(0, 100)
    .map(item => ({ messageId: String(item?.messageId || ''), replyToId: String(item?.replyToId || '') }));
  const previous = quoteRepairQueues.get(accountId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => repairMessageQuotesNow(accountId, chatId, safeItems));
  let settled!: Promise<Awaited<ReturnType<typeof repairMessageQuotesNow>>>;
  settled = task.finally(() => {
    if (quoteRepairQueues.get(accountId) === settled) quoteRepairQueues.delete(accountId);
  });
  quoteRepairQueues.set(accountId, settled);
  return settled;
}

async function repairMessageQuotesNow(
  accountId: string,
  chatId: string,
  items: Array<{ messageId: string; replyToId: string }>,
): Promise<{ success: boolean; results?: TelegramQuoteRepairResult[]; error?: string }> {
  const db = DatabaseService.getInstance();
  if (!db || !accountId || !chatId || items.length === 0) {
    return { success: false, error: 'Invalid Telegram quote repair request' };
  }

  const results: TelegramQuoteRepairResult[] = [];
  const pending = new Map<string, Array<{ messageId: string; replyToId: string }>>();
  let localCount = 0;
  let routingCount = 0;

  for (const item of items) {
    const numericMessageId = Number(item.messageId);
    const numericReplyToId = Number(item.replyToId);
    if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0 ||
        !Number.isSafeInteger(numericReplyToId) || numericReplyToId <= 0) {
      results.push({ ...item, status: 'invalid' });
      continue;
    }

    const current = db.queryOne<any>(
      `SELECT reply_to_id, quote_data, topic_id FROM messages
       WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [item.messageId, accountId, chatId],
    );
    if (!current || String(current.reply_to_id || '') !== item.replyToId) {
      results.push({ ...item, status: 'invalid' });
      continue;
    }

    // Legacy forum rows stored the topic root as reply_to_id. It is routing
    // metadata and must not produce a quote preview.
    if (current.topic_id != null && String(current.topic_id) === item.replyToId) {
      db.run(
        `UPDATE messages SET reply_to_id = NULL
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [item.messageId, accountId, chatId],
      );
      routingCount++;
      results.push({ ...item, status: 'topic_routing' });
      continue;
    }

    if (hasUsableTelegramQuoteData(current.quote_data)) {
      results.push({ ...item, status: 'repaired', quoteData: current.quote_data });
      continue;
    }

    const original = db.queryOne<any>(
      `SELECT content, msg_type, sender_id, attachments, local_paths FROM messages
       WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [item.replyToId, accountId, chatId],
    );
    if (original) {
      // Resolve sender name from group members
      let senderName = '';
      if (original.sender_id) {
        const member = db.queryOne<any>(
          `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
          [accountId, chatId, original.sender_id]
        );
        senderName = member?.display_name || '';
      }
      const quoteData = buildTelegramQuoteData({
        msgId: item.replyToId,
        content: original.content,
        msgType: original.msg_type,
        senderId: original.sender_id,
        senderName,
        attachments: original.attachments,
        localPaths: original.local_paths,
      });
      if (hasUsableTelegramQuoteData(quoteData)) {
        db.run(
          `UPDATE messages SET quote_data = ?
           WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
          [quoteData, item.messageId, accountId, chatId],
        );
        localCount++;
        results.push({ ...item, status: 'repaired', quoteData });
        continue;
      }
    }

    const waiting = pending.get(item.replyToId) || [];
    waiting.push(item);
    pending.set(item.replyToId, waiting);
  }

  let apiCount = 0;
  let apiLookupCompleted = false;
  const listener = activeListeners.get(accountId);
  if (pending.size > 0 && listener?.client && listener.connected) {
    try {
      const peer = await resolveInputPeer(accountId, listener.client, chatId);
      const ids = [...pending.keys()].map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
      const fetched = await listener.client.getMessages(peer, { ids });
      const fetchedById = new Map<string, any>();
      for (const message of fetched || []) {
        if (message?.id != null && (message as any)?.className !== 'MessageEmpty') {
          fetchedById.set(String(message.id), message);
        }
      }
      apiLookupCompleted = true;
      const cachedPeerType = db.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;

      for (const [replyToId, waiting] of pending) {
        const original = fetchedById.get(replyToId);
        if (!original) continue;
        const normalized = normalizeTelegramMessageMedia(original, cachedPeerType);
        let localPath = '';
        if (normalized.msgType === 'photo' || normalized.msgType === 'image') {
          localPath = await downloadMediaForMessage(
            accountId, listener.client, original, replyToId, normalized.msgType, chatId,
          ) || '';
        }
        // Resolve sender name from raw message or group members
        let senderName = '';
        const sender = (original as any).sender || (original as any).fromId;
        if (sender?.firstName) {
          senderName = [sender.firstName, sender.lastName].filter(Boolean).join(' ');
        }
        if (!senderName) {
          const senderId = String(original.senderId?.valueOf() || '');
          if (senderId) {
            const member = db.queryOne<any>(
              `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
              [accountId, chatId, senderId]
            );
            senderName = member?.display_name || '';
          }
        }
        const quoteData = buildTelegramQuoteData({
          msgId: replyToId,
          content: normalized.content,
          msgType: normalized.msgType,
          senderId: String(original.senderId?.valueOf() || ''),
          senderName,
          attachments: normalized.attachments,
          localPaths: localPath ? { main: localPath } : undefined,
        });
        for (const item of waiting) {
          db.run(
            `UPDATE messages SET quote_data = ?
             WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
            [quoteData, item.messageId, accountId, chatId],
          );
          results.push({ ...item, status: 'repaired', quoteData });
          apiCount++;
        }
        pending.delete(replyToId);
      }
    } catch (err: any) {
      tgLog('warn', accountId, 'history', 'QUOTE_REPAIR_API_FAILED', {
        chatId,
        requested: pending.size,
        error: err?.message || String(err),
      });
    }
  }

  for (const waiting of pending.values()) {
    for (const item of waiting) {
      const status = apiLookupCompleted ? 'not_found' : 'deferred';
      results.push({ ...item, status });
      tgLog(status === 'not_found' ? 'warn' : 'info', accountId, 'history',
        status === 'not_found' ? 'QUOTE_REPAIR_NOT_FOUND' : 'QUOTE_REPAIR_DEFERRED', {
        chatId,
        messageId: item.messageId,
        replyToId: item.replyToId,
        connected: !!listener?.connected,
      });
    }
  }

  tgLog('info', accountId, 'history', 'QUOTE_REPAIR_COMPLETED', {
    chatId,
    requested: items.length,
    local: localCount,
    api: apiCount,
    topicRouting: routingCount,
    notFound: results.filter(result => result.status === 'not_found').length,
    deferred: results.filter(result => result.status === 'deferred').length,
  });
  return { success: true, results };
}

/**
 * Repair a legacy Telegram media row without replaying message side effects.
 *
 * MTProto photo/document attachments do not expose a durable CDN URL. Older
 * rows that were persisted before the media downloader ran therefore cannot
 * be rendered from attachment metadata alone. Fetching the exact message by
 * peer + message ID refreshes Telegram's file reference, after which the
 * normal account-scoped download queue can hydrate local_paths in place.
 */
export function repairMessageMedia(
  accountId: string,
  chatId: string,
  messageId: string,
): Promise<{
  success: boolean;
  localPaths?: Record<string, string>;
  attachments?: any[];
  msgType?: string;
  error?: string;
}> {
  const previous = mediaRepairQueues.get(accountId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => repairMessageMediaNow(accountId, chatId, messageId));
  let settled!: Promise<Awaited<ReturnType<typeof repairMessageMediaNow>>>;
  settled = task.finally(() => {
    if (mediaRepairQueues.get(accountId) === settled) mediaRepairQueues.delete(accountId);
  });
  mediaRepairQueues.set(accountId, settled);
  return settled;
}

export async function repairEmptyMessages(
  accountId: string,
  chatId: string,
  messageIds: string[],
): Promise<{ success: boolean; results?: any[]; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram listener is not connected' };
  try {
    const ids = Array.from(new Set(messageIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
    if (!ids.length) return { success: true, results: [] };
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const fetched = await listener.client.getMessages(peer, { ids });
    const db = DatabaseService.getInstance();
    const peerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const results: any[] = [];
    for (const message of fetched as any[]) {
      if (!message || message.className === 'MessageEmpty') continue;
      const messageId = String(message.id || '');
      const normalized = normalizeTelegramMessageMedia(message, peerType);
      const mediaClass = String(message?.media?.className || 'MessageMediaEmpty');
      const resolved = !!normalized.content.trim() || normalized.msgType !== 'text' || normalized.attachments.length > 0;
      if (db && resolved) {
        db.run(
          `UPDATE messages SET content = ?, msg_type = ?, attachments = ?, topic_id = COALESCE(topic_id, ?)
           WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
          [normalized.content, normalized.msgType, JSON.stringify(normalized.attachments),
            getForumTopicId(message) || null, messageId, accountId, chatId],
        );
      }
      const result = {
        messageId, resolved, content: normalized.content, msgType: normalized.msgType,
        attachments: normalized.attachments, mediaClass,
      };
      results.push(result);
      tgLog(resolved ? 'info' : 'warn', accountId, 'history', resolved ? 'EMPTY_MESSAGE_REPAIRED' : 'EMPTY_MESSAGE_UNRESOLVED', {
        chatId, messageId, msgType: normalized.msgType, mediaClass,
      });
    }
    return { success: true, results };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function repairMessageMediaNow(
  accountId: string,
  chatId: string,
  messageId: string,
): Promise<{
  success: boolean;
  localPaths?: Record<string, string>;
  attachments?: any[];
  msgType?: string;
  error?: string;
}> {
  const listener = activeListeners.get(accountId);
  const numericMessageId = Number(messageId);
  tgLog('info', accountId, 'history', 'MEDIA_REPAIR_REQUESTED', {
    chatId,
    messageId,
    connected: !!listener?.connected,
  });
  if (!listener?.client || !listener.connected) {
    tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_DEFERRED_NOT_CONNECTED', { chatId, messageId });
    return { success: false, error: 'Telegram listener is not connected' };
  }
  if (!chatId || !Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    return { success: false, error: 'Invalid Telegram media identity' };
  }

  try {
    // getMessages() may already be hydrating this visible row. Reuse that
    // download instead of issuing a second exact-message RPC/file transfer.
    const existingDownload = inFlightDownloadKeys.get(`media:${chatId}:${messageId}`);
    if (existingDownload) {
      await existingDownload;
      const hydrated = DatabaseService.getInstance()?.queryOne<any>(
        `SELECT local_paths, attachments, msg_type FROM messages
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [messageId, accountId, chatId],
      );
      try {
        const localPaths = JSON.parse(hydrated?.local_paths || '{}');
        if (Object.values(localPaths).some(Boolean)) {
          tgLog('info', accountId, 'history', 'MEDIA_REPAIR_REUSED_DOWNLOAD', {
            chatId,
            messageId,
            msgType: hydrated?.msg_type || '-',
          });
          return {
            success: true,
            localPaths,
            attachments: JSON.parse(hydrated?.attachments || '[]'),
            msgType: hydrated?.msg_type || undefined,
          };
        }
      } catch {}
    }

    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const fetched = await listener.client.getMessages(peer, { ids: [numericMessageId] });
    const message = (fetched || []).find((item: any) => String(item?.id || '') === messageId);
    if (!message) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_MESSAGE_NOT_FOUND', { chatId, messageId });
      return { success: false, error: 'Telegram message was not found' };
    }
    if (!(message as any).media) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_NO_MEDIA', {
        chatId,
        messageId,
        messageClass: (message as any)?.className || '-',
      });
      return { success: false, error: 'Telegram message no longer contains media' };
    }

    const db = DatabaseService.getInstance();
    const cachedPeerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const normalized = normalizeTelegramMessageMedia(message, cachedPeerType);

    // Repair attachment/type metadata left sparse by the legacy API-history
    // path. This intentionally does not touch contacts, unread counts or UI
    // new-message events.
    if (db && normalized.attachments.length > 0) {
      db.run(`
        UPDATE messages
        SET attachments = ?,
            msg_type = CASE WHEN msg_type = 'text' OR msg_type = 'photo' THEN ? ELSE msg_type END,
            topic_id = COALESCE(topic_id, ?)
        WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
      `, [
        JSON.stringify(normalized.attachments),
        normalized.msgType,
        getForumTopicId(message) || null,
        messageId,
        accountId,
        chatId,
      ]);
    }

    const localPath = await downloadMediaForMessage(
      accountId,
      listener.client,
      message,
      messageId,
      normalized.msgType,
      chatId,
    );
    if (!localPath) {
      return { success: false, error: 'Telegram media download returned no data' };
    }

    const localPaths: Record<string, string> = {};
    if (normalized.msgType === 'photo') localPaths.main = localPath;
    else if (normalized.msgType === 'video') localPaths.video = localPath;
    else if (normalized.msgType === 'audio') localPaths.voice = localPath;
    else localPaths.file = localPath;

    tgLog('info', accountId, 'history', 'MEDIA_REPAIR_COMPLETED', {
      chatId,
      messageId,
      msgType: normalized.msgType,
      attachmentTypes: normalized.attachments.map((attachment: any) => attachment?.type || '-').join(','),
    });
    return {
      success: true,
      localPaths,
      attachments: normalized.attachments,
      msgType: normalized.msgType,
    };
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_FAILED', {
      chatId,
      messageId,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Forward message (User API)
 */
export async function forwardMessages(accountId: string, fromChatId: string, toChatId: string, messageIds: string[]): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  const denial = getPersistedTelegramSendDenial(accountId, toChatId);
  if (denial) return { success: false, error: denial };
  try {
    const [toPeer, fromPeer] = await Promise.all([
      resolveInputPeer(accountId, listener.client, toChatId),
      resolveInputPeer(accountId, listener.client, fromChatId),
    ]);
    await listener.client.forwardMessages(toPeer, {
      messages: messageIds.map(Number),
      fromPeer,
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Send file/media (User API)
 */
export async function sendFile(accountId: string, chatId: string, filePath: string, caption?: string, fileType?: string, replyToMsgId?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: `Rate limited. Wait ${rateLimit.waitSeconds}s.` };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const pathMod = require('path');
    const fs = require('fs');

    // Resolve path: handle both absolute paths and local-media:// URLs
    let resolvedPath = filePath;
    if (filePath.startsWith('local-media:///')) {
      resolvedPath = filePath.replace('local-media:///', '');
    } else if (filePath.startsWith('local-media://')) {
      resolvedPath = filePath.replace('local-media://', '');
    }
    resolvedPath = resolvedPath.replace(/\//g, pathMod.sep);
    if (!fs.existsSync(resolvedPath)) {
      Logger.error(`[TG:sendFile] File not found: ${resolvedPath} (original: ${filePath})`);
      return { success: false, error: `File không tồn tại: ${pathMod.basename(resolvedPath)}` };
    }
    Logger.log(`[TG:sendFile] STEP1 Sending ${resolvedPath}`);

    // Use client.sendFile() — handles upload + response parsing + message ID extraction
    const sendOpts: any = { file: resolvedPath, forceDocument: fileType === 'file' };
    if (caption) sendOpts.message = caption;
    if (replyToMsgId) sendOpts.replyTo = Number(replyToMsgId);

    Logger.log(`[TG:sendFile] STEP2 sendOpts:`, JSON.stringify({ file: resolvedPath, forceDocument: sendOpts.forceDocument, hasCaption: !!caption }));
    const result = await listener.client.sendFile(peer, sendOpts);
    // client.sendFile() returns a Message object with .id (proper 32-bit Telegram msgId)
    const msgId = String(result?.id || '');
    const now = Date.now();
    const threadType = chatId.startsWith('-') ? 1 : 0;
    Logger.log(`[TG:sendFile] STEP3 result: id=${msgId} className=${result?.className} hasMedia=${!!(result as any)?.media}`);
    Logger.log(`[TG:sendFile] SUCCESS msgId=${msgId} result.className=${result?.className} result.id=${String(result?.id)}`);

    // Extract attachments from GramJS Message result
    const attachments: any[] = [];
    let msgType = 'file';
    const media = (result as any)?.media;
    if (media) {
      if (media.photo) {
        // Photo: array of PhotoSize — take the largest (last element)
        const photos = media.photo.sizes || [];
        const largest = photos[photos.length - 1];
        if (largest) {
          attachments.push({
            type: 'photo',
            file_id: String(largest.src?.volumeId || ''),
            width: largest.w || 0,
            height: largest.h || 0,
            file_size: largest.size || 0,
          });
        }
        msgType = 'photo';
      } else if (media.document) {
        const doc = media.document;
        const fileName = (doc.attributes || []).find((a: any) => a.fileName)?.fileName || pathMod.basename(resolvedPath);
        const mimeType = doc.mimeType || '';
        // Detect type from attributes
        const isVideo = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeVideo');
        const isAudio = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeAudio');
        const isVoice = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeAudio' && a.voice);
        const isSticker = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeSticker');

        if (isVoice) msgType = 'voice';
        else if (isVideo) msgType = 'video';
        else if (isAudio) msgType = 'audio';
        else if (isSticker) msgType = 'sticker';

        attachments.push({
          type: isSticker ? 'sticker' : isVoice ? 'voice' : isAudio ? 'audio' : isVideo ? 'video' : 'file',
          file_id: String(doc.id?.valueOf?.() || doc.id || ''),
          file_name: fileName,
          mime_type: mimeType,
          file_size: doc.size || 0,
          is_sticker: isSticker,
        });
      }
    }

    // Determine msgType: ưu tiên fileType từ UI, fallback extension, fallback media attributes
    const ext = pathMod.extname(resolvedPath).toLowerCase();
    if (fileType === 'image') msgType = 'photo';
    else if (fileType === 'video') msgType = 'video';
    else if (fileType === 'audio') msgType = 'audio';
    else if (!msgType || msgType === 'file') {
      // Fallback: detect from extension
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) msgType = 'photo';
      else if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) msgType = 'video';
      else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) msgType = 'audio';
    }

    Logger.log(`[TG:sendFile] STEP4 msgType=${msgType} attachments=${attachments.length} attachmentTypes=${attachments.map((a: any) => a.type).join(',')}`);

    // Media preview for contacts.last_message
    const mediaPreview = msgType === 'photo' ? '🖼️ Hình ảnh'
      : msgType === 'video' ? '🎬 Video'
      : msgType === 'audio' ? '🎵 Audio'
      : caption || '📎 File';

    // Build quote_data nếu reply
    let quoteData: string | null = null;
    if (replyToMsgId) {
      const dbQuote = DatabaseService.getInstance()?.queryOne<any>(
        `SELECT content, msg_type, sender_id FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [replyToMsgId, accountId, chatId]
      );
      if (dbQuote) {
        quoteData = JSON.stringify({ msgId: replyToMsgId, msg: dbQuote.content || '', senderId: dbQuote.sender_id || '', msgType: dbQuote.msg_type || 'text' });
      } else {
        quoteData = JSON.stringify({ msgId: replyToMsgId, msg: '', senderId: '', msgType: 'text' });
      }
    }

    // Save to DB WITH attachments (socket echo sẽ skip vì đã tồn tại)
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user', ?, ?)`,
        [msgId, accountId, chatId, threadType, accountId, caption || '', msgType, now, JSON.stringify(attachments), replyToMsgId || null, quoteData]);

      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END
      `, [accountId, chatId, threadType === 1 ? 'group' : 'user', mediaPreview, now]);
      Logger.log(`[TG:sendFile] STEP5 DB saved msgId=${msgId} msgType=${msgType} attachments=${attachments.length}`);
    }

    // Emit event để UI thêm tin nhắn ngay (msgType đúng, socket echo KHÔNG arrive cho self-sent)
    Logger.log(`[TG:sendFile] EMITTING event: msgId=${msgId} msgType=${msgType} chatId=${chatId}`);
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: {
        type: threadType,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: caption || '',
          msgType,
          ts: String(now),
          attachments,
          replyToId: replyToMsgId || undefined,
          quoteData: quoteData || undefined,
        },
      },
    });
    Logger.log(`[TG:sendFile] STEP6 EVENT_EMITTED msgId=${msgId}`);

    // Trigger background download NGAY — không rely vào handleNewMessage
    // (socket echo có thể không arrive cho self-sent GramJS messages)
    if ((result as any)?.media && listener.client) {
      Logger.log(`[TG:sendFile] STEP7 Starting background download for msgId=${msgId}`);
      downloadMediaForMessage(accountId, listener.client, result, msgId, msgType, chatId).catch(err => {
        Logger.error(`[TG:sendFile] STEP7 download FAILED msgId=${msgId} error=${err.message}`);
      });
    } else {
      Logger.log(`[TG:sendFile] STEP7 SKIPPED no media or no client: hasMedia=${!!(result as any)?.media} hasClient=${!!listener.client}`);
    }
    Logger.log(`[TG:sendFile] DONE msgId=${msgId} msgType=${msgType} (waiting for background download + socket echo)`);

    return { success: true, messageId: msgId };
  } catch (err: any) {
    Logger.error(`[TG:sendFile] FAILED: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Send typing action (User API)
 */
export async function sendTyping(accountId: string, chatId: string): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    await listener.client.invoke(new Api.messages.SetTyping({
      peer,
      action: new Api.SendMessageTypingAction(),
    }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Login Flow ──────────────────────────────────────────────────────────────

/**
 * Bước 1: Gửi mã OTP đến số điện thoại
 */
export async function sendCode(phoneNumber: string): Promise<{ success: boolean; phoneCodeHash?: string; error?: string }> {
  if (!API_ID || !API_HASH) {
    return { success: false, error: 'Telegram API credentials chưa được cấu hình' };
  }

  try {
    await clearPendingLogin();
    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
      connectionRetries: 3,
    });

    await client.connect();
    const result = await client.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      phoneNumber
    );

    // Store client temporarily for next step
    pendingLogin = { client, phoneNumber, phoneCodeHash: result.phoneCodeHash, expiresAt: Date.now() + LOGIN_SESSION_TTL_MS };

    return { success: true, phoneCodeHash: result.phoneCodeHash };
  } catch (err: any) {
    await clearPendingLogin();
    return { success: false, error: err.message };
  }
}

/**
 * Bước 2: Xác nhận mã OTP
 */
export async function signIn(phoneNumber: string, code: string, phoneCodeHash: string): Promise<{
  success: boolean; stringSession?: string; accountId?: string;
  userInfo?: { firstName: string; lastName: string; phone: string; username: string };
  error?: string;
}> {
  const pending = getPendingLogin();
  if (!pending) {
    return { success: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng thử lại.' };
  }
  if (pending.phoneNumber !== phoneNumber || pending.phoneCodeHash !== phoneCodeHash) {
    return { success: false, error: 'Mã xác nhận không thuộc phiên đăng nhập hiện tại. Vui lòng gửi lại mã.' };
  }
  const { client } = pending;

  try {
    const { Api } = require('telegram');
    // signInUser() would invoke auth.SendCode a second time. The UI already
    // holds the hash from sendCode(), so complete this exact OTP transaction.
    await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }));

    const me = await client.getMe();
    const accountId = String(me.id);
    const stringSession = client.session.save() as unknown as string;

    // Lấy thông tin user
    const userInfo = {
      firstName: (me as any).firstName || '',
      lastName: (me as any).lastName || '',
      phone: phoneNumber,
      username: (me as any).username || '',
    };

    await clearPendingLogin();
    return { success: true, stringSession, accountId, userInfo };
  } catch (err: any) {
    // Check if 2FA is required
    if (err.message?.includes('PASSWORD') || err.message?.includes('2FA') || err.message?.includes('password')) {
      return { success: false, error: '2FA_REQUIRED' };
    }
    await clearPendingLogin();
    return { success: false, error: err.message };
  }
}

/**
 * Add or remove the current account's reaction on a message (User MTProto API).
 * Telegram removes every reaction from this account when the reaction vector is
 * empty. Reactions are scoped to the peer and message id; a forum topic does
 * not need a separate topMsgId for this RPC.
 */
export async function sendReaction(
  accountId: string,
  chatId: string,
  messageId: string,
  emoji?: string,
): Promise<{ success: boolean; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };

  const numericMessageId = Number(String(messageId).replace(/^tg_/, ''));
  if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    return { success: false, error: 'Telegram message ID không hợp lệ.' };
  }

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    await listener.client.invoke(new Api.messages.SendReaction({
      peer,
      msgId: numericMessageId,
      reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
      addToRecent: !!emoji,
    }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Send a file/media into a forum topic. GramJS maps `topMsgId` to
 * InputReplyToMessage.topMsgId, which is required in addition to a reply ID
 * so Telegram does not route the upload to the forum parent timeline. */
export async function sendTopicFile(accountId: string, chatId: string, topicRootMessageId: string, filePath: string, caption?: string, fileType?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram client not connected' };
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: `Gửi tin quá nhanh. Vui lòng chờ ${rateLimit.waitSeconds} giây.` };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const pathMod = require('path');
    const fs = require('fs');

    // Resolve path
    let resolvedPath = filePath;
    if (filePath.startsWith('local-media:///')) {
      resolvedPath = filePath.replace('local-media:///', '');
    } else if (filePath.startsWith('local-media://')) {
      resolvedPath = filePath.replace('local-media://', '');
    }
    resolvedPath = resolvedPath.replace(/\//g, pathMod.sep);
    if (!fs.existsSync(resolvedPath)) {
      Logger.error(`[TG:sendTopicFile] File not found: ${resolvedPath} (original: ${filePath})`);
      return { success: false, error: `File không tồn tại: ${pathMod.basename(resolvedPath)}` };
    }
    Logger.log(`[TG:sendTopicFile] Sending ${resolvedPath}`);

    // Use client.sendFile() — handles upload + response parsing + message ID extraction
    const sendOpts: any = { file: resolvedPath, forceDocument: fileType === 'file', topMsgId: Number(topicRootMessageId) };
    if (caption) sendOpts.message = caption;

    const result = await listener.client.sendFile(peer, sendOpts);
    const msgId = String(result?.id || '');
    const now = Date.now();
    const threadType = chatId.startsWith('-') ? 1 : 0;

    // Extract attachments from GramJS Message result
    const attachments: any[] = [];
    let msgType = 'file';
    const media = (result as any)?.media;
    if (media) {
      if (media.photo) {
        const photos = media.photo.sizes || [];
        const largest = photos[photos.length - 1];
        if (largest) {
          attachments.push({ type: 'photo', file_id: String(largest.src?.volumeId || ''), width: largest.w || 0, height: largest.h || 0, file_size: largest.size || 0 });
        }
        msgType = 'photo';
      } else if (media.document) {
        const doc = media.document;
        const fileName = (doc.attributes || []).find((a: any) => a.fileName)?.fileName || pathMod.basename(resolvedPath);
        const mimeType = doc.mimeType || '';
        const isVideo = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeVideo');
        const isAudio = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeAudio');
        const isVoice = (doc.attributes || []).some((a: any) => a.className === 'DocumentAttributeAudio' && a.voice);
        if (isVoice) msgType = 'voice';
        else if (isVideo) msgType = 'video';
        else if (isAudio) msgType = 'audio';
        attachments.push({ type: isVoice ? 'voice' : isAudio ? 'audio' : isVideo ? 'video' : 'file', file_id: String(doc.id?.valueOf?.() || doc.id || ''), file_name: fileName, mime_type: mimeType, file_size: doc.size || 0 });
      }
    }
    // Fallback: determine from extension
    const ext = pathMod.extname(resolvedPath).toLowerCase();
    if (fileType === 'image') msgType = 'photo';
    else if (fileType === 'video') msgType = 'video';
    else if (fileType === 'audio') msgType = 'audio';
    else if (msgType === 'file') {
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) msgType = 'photo';
      else if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) msgType = 'video';
      else if (['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) msgType = 'audio';
    }

    const mediaPreview = msgType === 'photo' ? '🖼️ Hình ảnh' : msgType === 'video' ? '🎬 Video' : msgType === 'audio' ? '🎵 Audio' : caption || '📎 File';

    // Save to DB WITH attachments
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user')`,
        [msgId, accountId, chatId, threadType, accountId, caption || '', msgType, now, JSON.stringify(attachments)]);
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others) VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0) ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END, last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END`,
        [accountId, chatId, threadType === 1 ? 'group' : 'user', mediaPreview, now]);
    }

    // Emit event với đầy đủ attachments
    Logger.log(`[TG:sendTopicFile] EMITTING event: msgId=${msgId} msgType=${msgType} chatId=${chatId}`);
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: { type: threadType, threadId: chatId, isSelf: true, _silentNotification: true,
        data: { uidFrom: accountId, idTo: chatId, msgId, content: caption || '', msgType, ts: String(now), attachments, topicId: topicRootMessageId } },
    });
    Logger.log(`[TG:sendTopicFile] EVENT_EMITTED msgId=${msgId} msgType=${msgType} attachments=${attachments.length}`);

    return { success: true, messageId: msgId };
  } catch (err: any) {
    Logger.error(`[TG:sendTopicFile] FAILED: ${err?.message || err}`);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Bước 3: Xác nhận 2FA password (nếu có)
 */
export async function signIn2FA(password: string): Promise<{
  success: boolean; stringSession?: string; accountId?: string;
  userInfo?: { firstName: string; lastName: string; phone: string; username: string };
  error?: string;
}> {
  const pending = getPendingLogin();
  if (!pending) {
    return { success: false, error: 'Phiên đăng nhập đã hết hạn. Vui lòng thử lại.' };
  }
  const { client } = pending;
  let authenticated = false;

  try {
    await client.signInWithPassword(
      { apiId: API_ID, apiHash: API_HASH },
      {
        password: async () => password,
        onError: (err: any) => {
          Logger.error(`[TelegramUserListener] 2FA error: ${err.message}`);
        },
      }
    );

    const me = await client.getMe();
    const accountId = String(me.id);
    const stringSession = client.session.save() as unknown as string;
    authenticated = true;

    // Lấy thông tin user
    const userInfo = {
      firstName: (me as any).firstName || '',
      lastName: (me as any).lastName || '',
      phone: (me as any).phone || '',
      username: (me as any).username || '',
    };

    return { success: true, stringSession, accountId, userInfo };
  } catch (err: any) {
    return { success: false, error: err.message };
  } finally {
    // Keep the pending MTProto auth state for another password attempt; OTP
    // state is still valid until the short expiry. Clean up only after success.
    if (authenticated) await clearPendingLogin();
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Reset avatar cache cho 1 contact (khi user nhấn nút "Cập nhật thông tin")
 */
export function resetContactAvatarCache(accountId: string, contactId: string): void {
  resetAvatarCache(accountId, contactId);
}

export function stopListener(accountId: string): void {
  const listener = activeListeners.get(accountId);
  if (!listener) return;

  listener.stopped = true;
  listener.connected = false;
  if (listener.reconnectTimer) {
    clearTimeout(listener.reconnectTimer);
    listener.reconnectTimer = null;
  }
  clearHealthCheck(listener);
  stopChannelPoller(listener);
  if (listener.client) {
    intentionallyDisconnectedClients.add(listener.client);
    listener.client.disconnect().catch(() => {});
  }
  activeListeners.delete(accountId);
  rawUpdateHandlers.delete(accountId);
  channelPollQueues.delete(accountId);
  pendingChannelRecoveries.delete(accountId);
  activeChannelLeases.delete(accountId);
  reconnectCatchUps.delete(accountId);
  for (const key of channelDifferenceQueues.keys()) {
    if (key.startsWith(`${accountId}:`)) channelDifferenceQueues.delete(key);
  }
  Logger.log(`[TelegramUserListener] Stopped for ${accountId}`);
}

export function stopAllListeners(): void {
  for (const [id] of activeListeners) {
    stopListener(id);
  }
}

export function getActiveListeners(): Array<{ accountId: string; connected: boolean }> {
  return Array.from(activeListeners.values()).map(l => ({
    accountId: l.account.accountId,
    connected: l.connected,
  }));
}

export function isConnected(accountId: string): boolean {
  const listener = activeListeners.get(accountId);
  return !!(listener?.connected && listener.client?.connected);
}

/**
 * Fetch avatar cho chính tài khoản đang đăng nhập (self avatar).
 * Dùng cho nút "Cập nhật thông tin" trên dashboard.
 */
export async function fetchSelfAvatar(accountId: string): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    return { success: false, error: 'Telegram chưa kết nối. Hãy kết nối lại trước.' };
  }

  try {
    const me = await listener.client.getMe();
    if (!me) return { success: false, error: 'Không thể lấy thông tin tài khoản' };

    const photo = await downloadProfilePhotoQueued(accountId, listener.client, me, `self:${accountId}`, true);
    if (!photo || photo.length === 0) {
      return { success: false, error: 'Tài khoản chưa có avatar' };
    }

    const avatarPath = `telegram_self_${accountId}_${Date.now()}.jpg`;
    const savedPath = await saveAvatarToDisk(Buffer.from(photo), avatarPath);
    if (!savedPath) return { success: false, error: 'Không thể lưu avatar' };

    // Convert absolute path → local-media:// URL (dùng được trong renderer <img src>)
    const normalizedPath = savedPath.replace(/\\/g, '/');
    const mediaUrl = 'local-media://' + (normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath);

    // Cập nhật avatar_url trong accounts table
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`UPDATE accounts SET avatar_url = ? WHERE zalo_id = ? AND channel = 'telegram_user'`, [mediaUrl, accountId]);
    }

    // Reset avatar cache
    resetAvatarCache(accountId, accountId);

    return { success: true, avatarUrl: mediaUrl };
  } catch (err: any) {
    Logger.error(`[TelegramUserListener] fetchSelfAvatar error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Group Management APIs ───────────────────────────────────────────────────

function getClient(accountId: string): TelegramClient | null {
  return activeListeners.get(accountId)?.client ?? null;
}

function ensureConnected(accountId: string): { client: TelegramClient } | { error: string } {
  const listener = activeListeners.get(accountId);
  if (!listener) return { error: 'Tài khoản chưa kết nối' };
  if (!listener.client) return { error: 'Telegram client chưa khởi tạo' };
  if (!listener.connected) return { error: 'Tài khoản chưa kết nối' };
  return { client: listener.client };
}

function getCachedTelegramProfile(accountId: string, userId: string): any | null {
  const db = DatabaseService.getInstance();
  if (!db) return null;
  const peer = db.getTelegramPeer(accountId, userId);
  const contact = db.queryOne<any>(
    `SELECT display_name, avatar_url, phone FROM contacts
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, userId],
  );
  const member = db.queryOne<any>(
    `SELECT display_name, avatar FROM page_group_member
     WHERE owner_zalo_id = ? AND member_id = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [accountId, userId],
  );
  if (!peer && !contact && !member) return null;
  const displayName = peer?.display_name || contact?.display_name || member?.display_name || peer?.username || userId;
  return {
    id: userId,
    firstName: displayName,
    lastName: '',
    displayName,
    username: peer?.username || '',
    phone: peer?.phone || contact?.phone || '',
    bio: '',
    commonChatsCount: 0,
    status: '',
    avatarUrl: peer?.avatar_url || contact?.avatar_url || member?.avatar || '',
    isBot: false,
    isVerified: false,
    isPremium: false,
    isScam: false,
    isFake: false,
    isRestricted: false,
    isContact: false,
    isMutualContact: false,
    cached: true,
  };
}

function getCachedTelegramGroupInfo(accountId: string, chatId: string): any | null {
  const db = DatabaseService.getInstance();
  if (!db) return null;
  const peer = db.getTelegramPeer(accountId, chatId);
  const contact = db.queryOne<any>(
    `SELECT display_name, avatar_url, telegram_can_send, telegram_send_reason,
            telegram_members_count, telegram_online_count, telegram_peer_type,
            telegram_membership_state, telegram_join_action
     FROM contacts
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, chatId],
  );
  if (!peer && !contact) return null;
  return {
    entity: {
      id: chatId,
      className: isChannelPeerType(peer?.peer_type) ? 'Channel' : 'Chat',
      title: peer?.display_name || contact?.display_name || chatId,
      username: peer?.username || '',
      broadcast: peer?.peer_type === 'channel',
      forum: peer?.peer_type === 'forum',
    },
    peerType: peer?.peer_type || 'basic_group',
    full: {
      participantsCount: Number(contact?.telegram_members_count || 0),
      onlineCount: Number(contact?.telegram_online_count || 0),
    },
    memberCount: Number(contact?.telegram_members_count || 0),
    onlineCount: Number(contact?.telegram_online_count || 0),
    canSend: contact?.telegram_can_send == null ? undefined : contact.telegram_can_send === 1,
    sendReason: contact?.telegram_send_reason || '',
    membershipState: contact?.telegram_membership_state || 'member',
    joinAction: contact?.telegram_join_action || 'none',
    chats: [],
    users: [],
    avatarUrl: peer?.avatar_url || contact?.avatar_url || '',
    cached: true,
  };
}

function mapCachedTelegramGroupMembers(accountId: string, chatId: string): any[] {
  return (DatabaseService.getInstance()?.getGroupMembers(accountId, chatId) || []).map((member: any) => ({
    id: String(member.member_id || ''),
    firstName: member.display_name || '',
    lastName: '',
    username: '',
    phone: '',
    isBot: false,
    status: '',
    hasPhoto: !!member.avatar,
    avatar: member.avatar || '',
    role: Number(member.role || 0),
    cached: true,
  }));
}

/**
 * Lấy thông tin nhóm (cả Basic Group và Supergroup/Channel)
 */
export async function getGroupInfo(accountId: string, chatId: string): Promise<{ success: boolean; info?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) {
    // Try cached info first
    const cachedInfo = getCachedTelegramGroupInfo(accountId, chatId);
    if (cachedInfo) return { success: true, info: cachedInfo };
    // Try to build basic info from contacts DB
    const db = DatabaseService.getInstance();
    if (db) {
      const contact = db.queryOne<any>(
        `SELECT display_name, avatar_url, telegram_members_count, telegram_online_count, telegram_peer_type FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId]
      );
      if (contact) {
        return {
          success: true,
          info: {
            entity: { id: chatId, title: contact.display_name || chatId },
            peerType: contact.telegram_peer_type || 'basic_group',
            memberCount: Number(contact.telegram_members_count || 0),
            onlineCount: Number(contact.telegram_online_count || 0),
            avatarUrl: contact.avatar_url || '',
            membershipState: 'member',
            joinAction: 'none',
          },
        };
      }
    }
    return { success: false, error: conn.error };
  }
  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, chatId);
    const peerType = entity ? getTelegramPeerType(entity) : await resolveChatPeerType(accountId, conn.client, chatId);
    const isChannel = isChannelPeerType(peerType);
    const full = isChannel
      ? await conn.client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId) })).catch(() => null)
      : await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }).catch(() => null));
    if (entity) {
      cacheTelegramPeer(accountId, chatId, entity);
      persistTelegramDialogState(accountId, chatId, null, entity, full?.fullChat);
    }
    let avatarUrl = '';
    const db = DatabaseService.getInstance();
    const cached = db?.queryOne<any>(
      `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, chatId]
    );
    avatarUrl = cached?.avatar_url || '';
    if (!avatarUrl && entity) {
      try {
        const photo = await downloadProfilePhotoQueued(accountId, conn.client, entity, `group:${chatId}`, false);
        if (photo && photo.length > 0) {
          const savedPath = await saveAvatarToDisk(Buffer.from(photo), `telegram_group_${chatId}_${Date.now()}.jpg`);
          if (savedPath) {
            const normalized = savedPath.replace(/\\/g, '/');
            avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
            db?.run(
              `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
              [avatarUrl, accountId, chatId]
            );
          }
        }
      } catch {}
    }
    const capability = getTelegramSendCapability(entity);
    const membership = getTelegramMembership(entity);
    const canManageTopics = !!entity?.creator || !!entity?.adminRights?.manageTopics;
    return { success: true, info: {
      entity, peerType, full: full?.fullChat, chats: full?.chats, users: full?.users, avatarUrl,
      memberCount: Number(full?.fullChat?.participantsCount ?? entity?.participantsCount ?? 0),
      onlineCount: Number(full?.fullChat?.onlineCount ?? 0),
      canSend: capability.canSend, canManageTopics, sendReason: capability.reason,
      membershipState: membership.state, joinAction: membership.action,
    } };
  } catch (err: any) {
    const cachedInfo = getCachedTelegramGroupInfo(accountId, chatId);
    return cachedInfo ? { success: true, info: cachedInfo } : { success: false, error: err.message };
  }
}

/**
 * Lấy danh sách thành viên nhóm
 */
export async function joinGroup(
  accountId: string,
  chatId: string,
): Promise<{ success: boolean; requested?: boolean; info?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    await conn.client.invoke(new Api.channels.JoinChannel({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
    }));
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    if (message.includes('INVITE_REQUEST_SENT')) {
      DatabaseService.getInstance()?.run(
        `UPDATE contacts SET telegram_membership_state = 'pending', telegram_join_action = 'none',
          telegram_can_send = 0, telegram_send_reason = ?, telegram_state_updated_at = ?
         WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        ['Yêu cầu tham gia đang chờ quản trị viên duyệt', Date.now(), accountId, chatId],
      );
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_membership_update' });
      return { success: true, requested: true };
    }
    if (!message.includes('USER_ALREADY_PARTICIPANT')) {
      const friendly = message.includes('CHANNEL_PRIVATE') || message.includes('USER_BANNED_IN_CHANNEL')
        ? 'Bạn không thể tham gia nhóm/kênh này bằng tài khoản hiện tại'
        : message;
      return { success: false, error: friendly };
    }
  }

  const info = await getGroupInfo(accountId, chatId);
  DatabaseService.getInstance()?.run(
    `UPDATE contacts SET telegram_membership_state = 'member', telegram_join_action = 'none',
      telegram_state_updated_at = ?
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [Date.now(), accountId, chatId],
  );
  EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_membership_update' });
  return { success: true, info: info.info };
}

export async function getGroupMembers(accountId: string, chatId: string, limit = 200): Promise<{ success: boolean; members?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) {
    const cachedMembers = mapCachedTelegramGroupMembers(accountId, chatId);
    return cachedMembers.length ? { success: true, members: cachedMembers } : { success: false, error: conn.error };
  }
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    let participants: any[] = [];
    const participantRoles = new Map<string, number>();

    if (isChannelPeerType(peerType)) {
      const result = await conn.client.invoke(new Api.channels.GetParticipants({
        channel: await resolveInputChannel(accountId, conn.client, chatId),
        filter: new Api.ChannelParticipantsRecent(),
        offset: 0,
        limit,
        hash: BigInt(0),
      }));
      if (result && 'users' in result) {
        participants = (result as any).users || [];
        for (const participant of (result as any).participants || []) {
          const memberId = String(participant.userId || participant.peer?.userId || '');
          if (!memberId) continue;
          const kind = participant.className || '';
          participantRoles.set(memberId, kind === 'ChannelParticipantCreator' ? 1 : kind === 'ChannelParticipantAdmin' ? 2 : 0);
        }
      }
    } else {
      const fullChat = await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }));
      participants = (fullChat as any)?.users || [];
      for (const participant of (fullChat as any)?.fullChat?.participants?.participants || []) {
        const memberId = String(participant.userId || '');
        if (!memberId) continue;
        const kind = participant.className || '';
        participantRoles.set(memberId, kind === 'ChatParticipantCreator' ? 1 : kind === 'ChatParticipantAdmin' ? 2 : 0);
      }
    }

    const db = DatabaseService.getInstance();
    const cachedAvatars = new Map<string, string>();
    if (db) {
      for (const row of db.query<any>(
        `SELECT member_id, avatar FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ?`,
        [accountId, chatId]
      )) {
        if (row?.member_id && row?.avatar) cachedAvatars.set(String(row.member_id), String(row.avatar));
      }
    }

    // Members intentionally do not become conversation contacts (that creates
    // phantom DMs). Return cached avatars immediately and hydrate the missing
    // ones sequentially after this request has completed.
    scheduleGroupMemberAvatarHydration(accountId, chatId, conn.client, participants, cachedAvatars, participantRoles);

    const membersResult = participants.map((u: any) => {
      const memberId = String(u.id);
      cacheTelegramPeer(accountId, memberId, u);
      return {
        id: memberId,
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        username: u.username || '',
        phone: u.phone || '',
        isBot: u.bot || false,
        ...getTelegramUserStatus(u),
        hasPhoto: !!(u.photo && u.photo !== 'ChatPhotoEmpty'),
        avatar: cachedAvatars.get(memberId) || '',
        role: participantRoles.get(memberId) || 0,
      };
    });

    db?.saveGroupMembers(accountId, chatId, membersResult.map((member: any) => ({
      memberId: member.id,
      displayName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username || member.id,
      avatar: member.avatar || '',
      role: member.role || 0,
    })));

    return { success: true, members: membersResult };
  } catch (err: any) {
    const cachedMembers = mapCachedTelegramGroupMembers(accountId, chatId);
    return cachedMembers.length ? { success: true, members: cachedMembers } : { success: false, error: err.message };
  }
}

/** Resolve exactly the senders referenced by visible/history messages. Recent
 * participant lists are not authoritative for large groups, so using message
 * IDs avoids leaving older senders as bare UIDs. */
export async function hydrateMessageSenders(
  accountId: string,
  chatId: string,
  messageIds: string[],
  senderIds: string[] = [],
): Promise<{ success: boolean; members?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const ids = Array.from(new Set(messageIds.map(Number).filter(Number.isSafeInteger))).slice(0, 100);
    const requestedSenderIds = Array.from(new Set(
      senderIds.map(String).filter(value => /^\d+$/.test(value)),
    )).slice(0, 100);
    if (!ids.length && !requestedSenderIds.length) return { success: true, members: [] };
    tgLog('info', accountId, 'history', 'MEMBER_HYDRATE_REQUEST', {
      chatId, messageIds: ids.join(','), senderIds: requestedSenderIds.join(','),
    });
    const peer = ids.length ? await resolveInputPeer(accountId, conn.client, chatId) : null;
    const messages = peer ? await conn.client.getMessages(peer, { ids }) : [];
    const members = new Map<string, any>();
    const resolvedUsers: any[] = [];
    const cachedAvatars = new Map<string, string>();
    const roles = new Map<string, number>();
    const addResolvedSender = async (senderId: string, entityHint?: any): Promise<void> => {
      if (!senderId || members.has(senderId)) return;
      const sender = await hydrateTelegramIdentity(accountId, conn.client, senderId, chatId, entityHint);
      if (!sender || sender.className !== 'User') return;
      const status = getTelegramUserStatus(sender);
      const cached = DatabaseService.getInstance()?.queryOne<any>(
        `SELECT avatar, role FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, chatId, senderId],
      );
      const member = {
        id: senderId,
        firstName: sender.firstName || '', lastName: sender.lastName || '',
        username: sender.username || '', phone: sender.phone || '', isBot: !!sender.bot,
        ...status, avatar: cached?.avatar || '', role: Number(cached?.role || 0),
      };
      members.set(senderId, member);
      resolvedUsers.push(sender);
      if (member.avatar) cachedAvatars.set(senderId, member.avatar);
      roles.set(senderId, member.role);
      DatabaseService.getInstance()?.upsertGroupMember(accountId, chatId, {
        memberId: senderId,
        displayName: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username || senderId,
        avatar: member.avatar, role: member.role,
        username: member.username || '',
      });
    };
    for (const message of messages as any[]) {
      const senderId = getCanonicalChatId(message?.fromId)
        || String(message?.senderId?.valueOf?.() || message?.fromId?.userId || '');
      let sender: any = null;
      try { sender = await message.getSender?.(); } catch {}
      await addResolvedSender(senderId, sender);
    }
    // A visible bubble already carries its sender_id. Resolve that ID directly
    // as a fallback because getMessages(ids) may return MessageEmpty for an old
    // topic/channel item even though the peer registry can resolve the user.
    for (const senderId of requestedSenderIds) {
      await addResolvedSender(senderId);
    }
    scheduleGroupMemberAvatarHydration(accountId, chatId, conn.client, resolvedUsers, cachedAvatars, roles);
    tgLog('info', accountId, 'history', 'MEMBER_HYDRATE_RESULT', {
      chatId, requested: requestedSenderIds.length, resolved: members.size,
      resolvedSenderIds: Array.from(members.keys()).join(','),
    });
    return { success: true, members: Array.from(members.values()) };
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'MEMBER_HYDRATE_FAILED', {
      chatId, senderIds: senderIds.join(','), error: err?.message || String(err),
    });
    return { success: false, error: err.message };
  }
}

export async function setDialogMute(
  accountId: string,
  chatId: string,
  muteUntil: number,
): Promise<{ success: boolean; muteUntil?: number; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const normalizedUntil = Math.max(0, Math.min(2147483647, Math.floor(Number(muteUntil || 0))));
    await conn.client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({ muteUntil: normalizedUntil }),
    }));
    const foreverMuted = normalizedUntil >= 2147483647;
    const muteUntilMs = normalizedUntil > 0 && !foreverMuted ? normalizedUntil * 1000 : 0;
    DatabaseService.getInstance()?.run(
      `UPDATE contacts SET is_muted = ?, mute_until = ?, telegram_state_updated_at = ?
       WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [foreverMuted ? 1 : 0, muteUntilMs, Date.now(), accountId, chatId],
    );
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_dialog_state' });
    return { success: true, muteUntil: normalizedUntil };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function setDialogArchived(
  accountId: string,
  chatId: string,
  archived: boolean,
): Promise<{ success: boolean; folderId?: number; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const folderId = archived ? 1 : 0;
    await conn.client.invoke(new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer, folderId })],
    }));
    DatabaseService.getInstance()?.run(
      `UPDATE contacts SET telegram_folder_id = ?, telegram_archived = ?, is_in_others = ?, telegram_state_updated_at = ?
       WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [folderId, archived ? 1 : 0, archived ? 1 : 0, Date.now(), accountId, chatId],
    );
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_dialog_state' });
    return { success: true, folderId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Ghim/bỏ ghim hội thoại trên Telegram.
 */
export async function setDialogPin(
  accountId: string,
  chatId: string,
  pinned: boolean,
): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    await conn.client.invoke(new Api.messages.ToggleDialogPin({
      pinned,
      peer: new Api.InputDialogPeer({ peer }),
    }));
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_pin' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Lấy danh sách người đã thả cảm xúc cho một tin nhắn.
 * Sử dụng messages.GetMessageReactionsList API của Telegram.
 */
export async function getMessageReactions(
  accountId: string,
  chatId: string,
  messageId: string,
  reaction?: string,
  offset?: string,
  limit: number = 50,
): Promise<{ success: boolean; reactions?: Array<{ userId: string; emoji: string; date: number }>; count?: number; nextOffset?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const reactionObj = reaction ? new Api.ReactionEmoji({ emoticon: reaction }) : undefined;
    const result = await conn.client.invoke(new Api.messages.GetMessageReactionsList({
      peer,
      id: Number(messageId),
      reaction: reactionObj,
      offset: offset || '',
      limit,
    }));
    const reactions = (result.reactions || []).map((r: any) => ({
      userId: getCanonicalChatId(r.peerId) || String(r.peerId?.userId || ''),
      emoji: getReactionEmoji(r.reaction),
      date: r.date || 0,
    }));
    return {
      success: true,
      reactions,
      count: result.count || 0,
      nextOffset: result.nextOffset || '',
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function getReactionEmoji(reaction: any): string {
  if (!reaction) return '';
  if (reaction.className === 'ReactionEmoji') return reaction.emoticon || '';
  if (reaction.className === 'ReactionCustomEmoji') return '⭐';
  return '';
}

/** Load Telegram's user surface on demand. Phone is only returned when the
 * account is permitted to see it by Telegram's privacy rules. */
export async function getUserProfile(accountId: string, userId: string, chatId?: string): Promise<{ success: boolean; profile?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) {
    const cachedProfile = getCachedTelegramProfile(accountId, userId);
    return cachedProfile ? { success: true, profile: cachedProfile } : { success: false, error: conn.error };
  }
  try {
    const { Api } = require('telegram');
    const entity = await resolvePeerEntity(accountId, conn.client, userId) as any;
    const peerType = entity ? getTelegramPeerType(entity) : await resolveChatPeerType(accountId, conn.client, userId);
    if (peerType !== 'user') return { success: false, error: 'Đây không phải tài khoản người dùng Telegram' };
    let full: any = null;
    let user: any = entity; // Default to entity (has bot flag from resolvePeerEntity)
    try {
      // Build InputUser from entity accessHash — avoids resolveInputUser which fails for large IDs
      const accessHash = entity?.accessHash;
      if (accessHash) {
        const inputUser = new Api.InputUser({ userId: BigInt(String(userId)), accessHash: BigInt(String(accessHash)) });
        full = await conn.client.invoke(new Api.users.GetFullUser({ id: inputUser })) as any;
        const rawUserId = String(userId).replace(/^-/, '');
        user = full?.users?.find((item: any) => String(item?.id) === rawUserId) || entity || full?.users?.[0] || {};
      }
    } catch {
      // GetFullUser may fail — fallback to entity
    }
    let avatarUrl = '';
    try {
      const photo = await downloadProfilePhotoQueued(accountId, conn.client, user, `profile:${userId}`, false);
      if (photo?.length) {
        const savedPath = await saveAvatarToDisk(Buffer.from(photo), `tg_profile_${userId}_${Date.now()}.jpg`);
        if (savedPath) {
          const normalized = savedPath.replace(/\\/g, '/');
          avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
        }
      }
    } catch {}
    const fullUser = full?.fullUser || {};
    const profile = {
        id: String(user.id || userId),
        firstName: user.firstName || '', lastName: user.lastName || '',
        displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || String(user.id || userId),
        username: user.username || '', phone: user.phone || '', bio: fullUser.about || '',
        commonChatsCount: Number(fullUser.commonChatsCount || 0),
        status: user.status?.className || '', avatarUrl,
        isBot: !!(user.bot || entity?.bot || full?.users?.[0]?.bot), isVerified: !!user.verified, isPremium: !!user.premium,
        isScam: !!user.scam, isFake: !!user.fake, isRestricted: !!user.restricted,
        isContact: !!user.contact, isMutualContact: !!user.mutualContact,
        menuButton: (() => {
          const botInfo = full?.fullUser?.botInfo;
          if (!botInfo?.menuButton) return null;
          const mb = botInfo.menuButton;
          if (mb.className === 'BotMenuButtonCommands') return { type: 'commands' as const };
          if (mb.className === 'BotMenuButton') return { type: 'custom' as const, text: mb.text || '', url: mb.url || '' };
          return { type: 'default' as const };
        })(),
        hasMainApp: !!(full?.fullUser?.botInfo?.appSettings),
    };
    if (chatId && String(chatId) !== String(userId)) {
      const db = DatabaseService.getInstance();
      const existing = db?.queryOne<any>(
        `SELECT avatar, role FROM page_group_member
         WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, chatId, String(profile.id)],
      );
      const memberAvatar = avatarUrl || existing?.avatar || '';
      db?.upsertGroupMember(accountId, chatId, {
        memberId: String(profile.id), displayName: profile.displayName,
        avatar: memberAvatar, role: Number(existing?.role || 0),
        username: profile.username || '',
      });
      EventBroadcaster.emit('event:telegramEntityHydrated', {
        zaloId: accountId, threadId: chatId, userId: String(profile.id),
        displayName: profile.displayName, username: profile.username,
        avatar: memberAvatar, ...getTelegramUserStatus(user),
      });
      if (memberAvatar) {
        EventBroadcaster.emit('event:groupMemberAvatar', {
          zaloId: accountId, groupId: chatId, memberId: String(profile.id),
          displayName: profile.displayName, avatar: memberAvatar,
        });
      }
      tgLog('info', accountId, 'history', 'MEMBER_PROFILE_APPLIED', {
        chatId, memberId: String(profile.id), hasAvatar: !!memberAvatar,
      });
    }
    return {
      success: true,
      profile,
    };
  } catch (err: any) {
    const cachedProfile = getCachedTelegramProfile(accountId, userId);
    return cachedProfile ? { success: true, profile: cachedProfile } : { success: false, error: err.message };
  }
}

/**
 * Resolve a @username to a Telegram peer.
 * Caches the result in the peer registry.
 */
export async function resolveUsername(accountId: string, username: string): Promise<{ success: boolean; peer?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const cleanUsername = username.replace(/^@/, '');
    if (!cleanUsername) return { success: false, error: 'Username không hợp lệ' };

    const result = await conn.client.invoke(new Api.contacts.ResolveUsername({ username: cleanUsername }));
    const users = (result as any).users || [];
    const chats = (result as any).chats || [];

    // Cache all resolved entities
    for (const user of users) {
      if (user?.id) cacheTelegramPeer(accountId, String(user.id), user);
    }
    for (const chat of chats) {
      if (chat?.id) {
        const chatId = getCanonicalChatId(chat);
        cacheTelegramPeer(accountId, chatId, chat);
      }
    }

    // Return the primary resolved peer
    const primary = users[0] || chats[0];
    if (!primary) return { success: false, error: `Không tìm thấy @${cleanUsername}` };

    const peerId = primary.className === 'User' ? String(primary.id) : getCanonicalChatId(primary);
    return {
      success: true,
      peer: {
        peerId,
        peerType: getTelegramPeerType(primary),
        displayName: primary.firstName
          ? [primary.firstName, primary.lastName].filter(Boolean).join(' ')
          : primary.title || primary.username || '',
        username: primary.username || '',
        phone: primary.phone || '',
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Search cached Telegram peers by name, username, or phone.
 * This queries the local peer registry, not the Telegram API.
 */
export function searchContacts(accountId: string, query: string): { success: boolean; peers?: any[]; error?: string } {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return { success: false, error: 'Database not available' };

    const like = `%${query}%`;
    const peers = db.query<any>(
      `SELECT peer_id, peer_type, access_hash, username, display_name, phone, avatar_url
       FROM telegram_peers
       WHERE owner_zalo_id = ?
         AND (display_name LIKE ? OR username LIKE ? OR phone LIKE ?)
       ORDER BY display_name
       LIMIT 50`,
      [accountId, like, like, like]
    );

    return { success: true, peers: peers || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * List all cached Telegram peers for an account.
 * Optionally filter by peer type.
 */
export function getPeers(accountId: string, peerType?: string): { success: boolean; peers?: any[]; error?: string } {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return { success: false, error: 'Database not available' };

    let sql = `SELECT peer_id, peer_type, access_hash, username, display_name, phone, avatar_url
               FROM telegram_peers WHERE owner_zalo_id = ?`;
    const params: any[] = [accountId];

    if (peerType) {
      sql += ` AND peer_type = ?`;
      params.push(peerType);
    }
    sql += ` ORDER BY display_name LIMIT 500`;

    const peers = db.query<any>(sql, params);
    return { success: true, peers: peers || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Thêm thành viên vào nhóm
 */
export async function addChatUser(accountId: string, chatId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const user = await resolveInputUser(accountId, conn.client, userId);

    if (isChannelPeerType(peerType)) {
      await conn.client.invoke(new Api.channels.InviteToChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId), users: [user] }));
    } else {
      await conn.client.invoke(new Api.messages.AddChatUser({ chatId: getBasicGroupId(chatId), userId: user, fwdLimit: 0 }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Xóa/rời thành viên khỏi nhóm
 */
export async function deleteChatUser(accountId: string, chatId: string, userId: string, revokeHistory = false): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);

    if (isChannelPeerType(peerType)) {
      // userId = 'self' → leave
      if (userId === 'self' || userId === accountId) {
        await conn.client.invoke(new Api.channels.LeaveChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId) }));
      } else {
        const user = await resolveInputPeer(accountId, conn.client, userId);
        await conn.client.invoke(new Api.channels.EditBanned({
          channel: await resolveInputChannel(accountId, conn.client, chatId),
          participant: user,
          bannedRights: new Api.ChatBannedRights({
            untilDate: 0,
            viewMessages: true,
            sendMessages: true,
            sendMedia: true,
            sendStickers: true,
            sendGifs: true,
            sendGames: true,
            sendInline: true,
            sendPolls: true,
            changeInfo: true,
            inviteUsers: true,
            pinMessages: true,
          }),
        }));
      }
    } else {
      if (userId === 'self' || userId === accountId) {
        await conn.client.invoke(new Api.messages.DeleteChatUser({ chatId: getBasicGroupId(chatId), userId: new Api.InputUserSelf() }));
      } else {
        const user = await resolveInputUser(accountId, conn.client, userId);
        await conn.client.invoke(new Api.messages.DeleteChatUser({ chatId: getBasicGroupId(chatId), userId: user, revokeHistory }));
      }
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Đổi tên nhóm
 */
export async function editChatTitle(accountId: string, chatId: string, title: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);

    if (isChannelPeerType(peerType)) {
      await conn.client.invoke(new Api.channels.EditTitle({ channel: await resolveInputChannel(accountId, conn.client, chatId), title }));
    } else {
      await conn.client.invoke(new Api.messages.EditChatTitle({ chatId: getBasicGroupId(chatId), title }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Đổi ảnh đại diện nhóm
 */
export async function editChatPhoto(accountId: string, chatId: string, photoPath: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const fs = require('fs');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const buffer = fs.readFileSync(photoPath);
    // GramJS uploadFile expects CustomFile, not raw Buffer
    const { CustomFile } = require('telegram/client/uploads');
    const customFile = new CustomFile(require('path').basename(photoPath), buffer.length, '', buffer);
    const file = await conn.client.uploadFile({ file: customFile, workers: 1 });
    const inputFile = 'id' in file
      ? new Api.InputFileUploaded({ id: file.id, parts: file.parts, md5Checksum: Buffer.alloc(0) })
      : file;

    if (isChannelPeerType(peerType)) {
      await conn.client.invoke(new Api.channels.EditPhoto({ channel: await resolveInputChannel(accountId, conn.client, chatId), photo: inputFile }));
    } else {
      await conn.client.invoke(new Api.messages.EditChatPhoto({ chatId: getBasicGroupId(chatId), photo: inputFile }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Cấp/thu quyền admin
 */
export async function editChatAdmin(accountId: string, chatId: string, userId: string, isAdmin: boolean): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const user = await resolveInputUser(accountId, conn.client, userId);

    if (isChannelPeerType(peerType)) {
      const adminRights = isAdmin ? new Api.ChatAdminRights({
        changeInfo: true, postMessages: true, editMessages: true,
        deleteMessages: true, banUsers: true, inviteUsers: true,
        pinMessages: true, addAdmins: true, anonymous: false,
        manageCall: true, other: true,
      }) : new Api.ChatAdminRights({
        changeInfo: false, postMessages: false, editMessages: false,
        deleteMessages: false, banUsers: false, inviteUsers: false,
        pinMessages: false, addAdmins: false, anonymous: false,
        manageCall: false, other: false,
      });
      await conn.client.invoke(new Api.channels.EditAdmin({ channel: await resolveInputChannel(accountId, conn.client, chatId), participant: user, adminRights }));
    } else {
      await conn.client.invoke(new Api.messages.EditChatAdmin({ chatId: getBasicGroupId(chatId), userId: user, isAdmin }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Rời nhóm (convenience wrapper)
 */
export async function leaveChat(accountId: string, chatId: string): Promise<{ success: boolean; error?: string }> {
  return deleteChatUser(accountId, chatId, 'self');
}

/**
 * Block a Telegram user.
 */
export async function blockUser(accountId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const user = await resolveInputUser(accountId, conn.client, userId);
    await conn.client.invoke(new Api.contacts.Block({ id: user }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Unblock a Telegram user.
 */
export async function unblockUser(accountId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const user = await resolveInputUser(accountId, conn.client, userId);
    await conn.client.invoke(new Api.contacts.Unblock({ id: user }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Lấy link mời nhóm
 */
export async function exportChatInvite(accountId: string, chatId: string): Promise<{ success: boolean; link?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    let result: any;
    if (isChannelPeerType(peerType)) {
      result = await conn.client.invoke(new Api.messages.ExportChatInvite({ peer, legacyRevokePermanent: false }));
    } else {
      result = await conn.client.invoke(new Api.messages.ExportChatInvite({ peer }));
    }
    const link = result?.link || result?.result?.link || '';
    return { success: true, link };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Đánh dấu đã đọc nhóm
 */
export async function readChatHistory(accountId: string, chatId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (isChannelPeerType(peerType)) {
      await conn.client.invoke(new Api.channels.ReadHistory({ channel: await resolveInputChannel(accountId, conn.client, chatId) }));
    } else {
      await conn.client.invoke(new Api.messages.ReadHistory({ peer: await resolveInputPeer(accountId, conn.client, chatId) }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Đánh dấu đã đọc 1 forum topic cụ thể
 * Forum topic = discussion thread, dùng messages.ReadDiscussion
 * msg_id = topic root message ID
 * read_max_id = max message ID cần mark read (dùng top_message từ ForumTopic nếu có)
 */
export async function readForumTopic(accountId: string, chatId: string, topMsgId: string, readMaxId?: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    // read_max_id: nếu không có → dùng INT32_MAX để mark toàn bộ topic
    const maxId = readMaxId ? Number(readMaxId) : 0x7FFFFFFF;
    Logger.log(`[TelegramUserListener] readForumTopic: chatId=${chatId} topMsgId=${topMsgId} readMaxId=${maxId}`);
    await conn.client.invoke(new Api.messages.ReadDiscussion({
      peer,
      msgId: Number(topMsgId),
      readMaxId: maxId,
    }));
    return { success: true };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] readForumTopic failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Lấy thông tin đầy đủ nhóm (full chat info)
 */
export async function getFullChat(accountId: string, chatId: string): Promise<{ success: boolean; info?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    let full: any;
    if (isChannelPeerType(peerType)) {
      full = await conn.client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId) }));
    } else {
      full = await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }));
    }
    return { success: true, info: full };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Forum / Topics APIs ─────────────────────────────────────────────────────

/** In-memory cache: accountId + chatId → isForum (loaded from DB or API) */
const forumMemCache = new Map<string, boolean>();
type MemberAvatarHydrationJob = {
  client: TelegramClient;
  users: Map<string, any>;
  roles: Map<string, number>;
  running: boolean;
};
const memberAvatarHydrationJobs = new Map<string, MemberAvatarHydrationJob>();
const latestTopicMessageRequests = new Map<string, symbol>();

/** Queue media-photo downloads per group. Parallel GramJS exported senders can
 * tear down the main MTProto connection on unstable networks. */
function scheduleGroupMemberAvatarHydration(accountId: string, chatId: string, client: TelegramClient, participants: any[], cachedAvatars: Map<string, string>, roles: Map<string, number>): void {
  const key = `${accountId}_${chatId}`;
  const targets = participants.filter((user: any) => user?.id && user?.photo && user.photo !== 'ChatPhotoEmpty' && !cachedAvatars.has(String(user.id)));
  if (!targets.length) return;
  let job = memberAvatarHydrationJobs.get(key);
  if (!job) {
    job = { client, users: new Map(), roles: new Map(), running: false };
    memberAvatarHydrationJobs.set(key, job);
  }
  job.client = client;
  for (const user of targets) {
    const memberId = String(user.id);
    job.users.set(memberId, user);
    job.roles.set(memberId, roles.get(memberId) || job.roles.get(memberId) || 0);
  }
  if (job.running) return;
  job.running = true;

  setTimeout(() => {
    void (async () => {
      const db = DatabaseService.getInstance();
      try {
        while (job!.users.size > 0) {
          const next = job!.users.entries().next().value as [string, any] | undefined;
          if (!next) break;
          const [memberId, user] = next;
          job!.users.delete(memberId);
          try {
            const existing = db?.queryOne<any>(
              `SELECT avatar FROM page_group_member
               WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
              [accountId, chatId, memberId],
            );
            if (existing?.avatar) continue;
            const photo = await downloadProfilePhotoQueued(accountId, job!.client, user, `member:${chatId}:${memberId}`, false);
            if (!photo?.length) continue;
            const savedPath = await saveAvatarToDisk(Buffer.from(photo), `tg_member_${memberId}_${Date.now()}.jpg`);
            if (!savedPath) continue;
            const normalized = savedPath.replace(/\\/g, '/');
            const avatar = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
            db?.upsertGroupMember(accountId, chatId, {
              memberId,
              displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || '',
              avatar,
              role: job!.roles.get(memberId) || 0,
              username: user.username || '',
            });
            EventBroadcaster.emit('event:groupMemberAvatar', {
              zaloId: accountId, groupId: chatId, memberId,
              displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || memberId,
              avatar,
            });
            tgLog('info', accountId, 'history', 'MEMBER_AVATAR_HYDRATED', { chatId, memberId });
          } catch (err: any) {
            tgLog('warn', accountId, 'history', 'MEMBER_AVATAR_FAILED', {
              chatId, memberId, error: err?.message || String(err),
            });
          }
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      } finally {
        job!.running = false;
        if (job!.users.size === 0) memberAvatarHydrationJobs.delete(key);
        else scheduleGroupMemberAvatarHydration(accountId, chatId, job!.client, [...job!.users.values()], new Map(), job!.roles);
      }
    })();
  }, 1_000);
}

/**
 * Kiểm tra supergroup có phải forum không.
 * Flow: memory cache → DB → API → save to DB + cache
 *
 * @param forceApi Bắt buộc gọi API (bỏ qua cache)
 */
export async function isForum(accountId: string, chatId: string, forceApi = false): Promise<{ success: boolean; isForum?: boolean; error?: string }> {
  // The renderer calls isForum when a conversation is opened. Reuse that
  // existing signal as the active-peer short-poll lease; background probes use
  // forceApi=true and therefore do not consume the 10-peer lease budget.
  if (!forceApi) touchActiveChannel(accountId, chatId);
  const cacheKey = getForumCacheKey(accountId, chatId);
  const db = DatabaseService.getInstance();

  // telegram_peers is populated directly from Telegram Channel entities and
  // is more reliable than the denormalized contacts.is_forum flag. In
  // particular, a cold GetFullChannel response previously overwrote valid
  // forums with false. Heal the contact row before any forced API probe.
  if (db?.getTelegramPeer(accountId, chatId)?.peer_type === 'forum') {
    forumMemCache.set(cacheKey, true);
    db.setIsForum(accountId, chatId, true);
    touchActiveChannel(accountId, chatId);
    return { success: true, isForum: true };
  }

  // 1. Memory cache
  if (!forceApi && forumMemCache.get(cacheKey) === true) {
    return { success: true, isForum: true };
  }

  // 2. DB cache
  if (!forceApi) {
    if (db) {
      const dbVal = db.getIsForum(accountId, chatId);
      if (dbVal === 1) {
        forumMemCache.set(cacheKey, true);
        return { success: true, isForum: true };
      }
      // A historical `false` can be stale (for example a cold entity cache
      // during an earlier check). Never let it permanently hide a forum.
    }
  }

  // 3. API call (with timeout)
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]);

    let isForumResult = false;

    const entity = await withTimeout(resolvePeerEntity(accountId, conn.client, chatId), 5000);
    const peerType = entity ? getTelegramPeerType(entity) : await resolveChatPeerType(accountId, conn.client, chatId);
    if (!isChannelPeerType(peerType)) {
      isForumResult = false;
    } else {
      // `forum` belongs to Channel. ChannelFull is a compatibility fallback
      // for peers restored from the durable registry after a process restart.
      isForumResult = !!(entity as any)?.forum || peerType === 'forum';
      const full = await withTimeout(
        conn.client.invoke(new Api.channels.GetFullChannel({
          channel: await resolveInputChannel(accountId, conn.client, chatId),
        })),
        5000
      );
      isForumResult = isForumResult || !!((full?.fullChat as any)?.forum);
      // ChannelFull.pts is a snapshot of *now*, not a recovery cursor. Never
      // write it here: opening the forum details during an offline gap would
      // otherwise advance PTS past messages that getChannelDifference must read.
    }

    // 4. Save to DB + memory cache
    forumMemCache.set(cacheKey, isForumResult);
    if (db) {
      db.setIsForum(accountId, chatId, isForumResult);
    }

    Logger.log(`[TelegramUserListener] isForum(${chatId}): forum=${isForumResult} (from API)`);
    touchActiveChannel(accountId, chatId);
    return { success: true, isForum: isForumResult };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] isForum(${chatId}) error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Check isForum cho tất cả group contacts chưa check (background).
 * Gọi khi app khởi động hoặc khi có group mới.
 */
export async function checkForumForNewGroups(accountId: string): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  const groups = db.query<any>(
    `SELECT contact_id FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group' AND channel = 'telegram_user' AND is_forum IS NULL`,
    [accountId]
  );

  if (groups.length === 0) return;
  Logger.log(`[TelegramUserListener] Checking isForum for ${groups.length} unchecked groups...`);

  for (const g of groups) {
    try {
      await isForum(accountId, g.contact_id, true);
    } catch {}
    // Throttle: 500ms giữa mỗi check
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Lấy danh sách topics của forum group
 */
export async function getForumTopics(accountId: string, chatId: string): Promise<{ success: boolean; topics?: any[]; error?: string }> {
  touchActiveChannel(accountId, chatId);
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  const { Api } = require('telegram');

  // Guard: basic groups (negative IDs without -100 prefix) are NOT channels/supergroups.
  // channels.GetForumTopics requires a supergroup. Basic groups cannot have forums.
  const numericId = String(chatId);
  if (numericId.startsWith('-') && !numericId.startsWith('-100')) {
    return { success: false, error: 'Forum topics are only available for supergroups' };
  }

  // Try up to 2 times: first attempt with current entity, second after forcing entity refresh.
  // This handles stale access hashes after reconnect or long idle.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const channelInput = await resolveInputChannel(accountId, conn.client, chatId);
      const result = await conn.client.invoke(new Api.channels.GetForumTopics({
        channel: channelInput,
        offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: 100,
      hash: BigInt(0),
    }));

    const topics = (result as any)?.topics || [];
    const users = (result as any)?.users || [];
    const userMap = new Map<string, any>(users.map((u: any) => [String(u.id), u]));

    const mappedTopics = topics.map((t: any) => ({
      // ForumTopic.id is the topic/thread root. topMessage is only the latest
      // message currently present in that topic.
      id: String(t.id || ''),
      forumTopicId: String(t.id || ''),
      title: t.title || '',
      iconEmojiId: t.iconEmojiId ? String(t.iconEmojiId) : '',
      iconColor: t.iconColor || 0,
      rootMessageId: String(t.id || ''),
      topMessageId: String(t.topMessage || ''), // compatibility for current UI
      topMessageDate: t.date || 0,
      unreadCount: t.unreadCount || 0,
      isPinned: !!t.pinned,
      isClosed: !!t.closed,
      isShort: !!t.short,
      creatorId: String(t.fromId?.userId || ''),
      creatorName: (() => {
        const uid = String(t.fromId?.userId || '');
        const u = userMap.get(uid);
        return u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '';
      })(),
    }));

    tgLog('info', accountId, 'topic_api', `TOPICS_RECEIVED for ${chatId}`, {
      count: topics.length,
      // Keep both IDs visible while diagnosing topic routing. Telegram's
      // ForumTopic.id and ForumTopic.topMessage have different semantics.
      ids: topics.slice(0, 20).map((topic: any) => `${String(topic.id || '-')}:${String(topic.topMessage || '-')}`).join(','),
    });

    return { success: true, topics: mappedTopics };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      // CHANNEL_INVALID on first attempt — try to force refresh entity cache and retry
      if (errMsg.includes('CHANNEL_INVALID') && attempt === 0) {
        Logger.warn(`[TelegramUserListener] getForumTopics: CHANNEL_INVALID for ${chatId} on attempt 1 — refreshing entity cache`);
        try {
          // Force GramJS to populate its entity cache by fetching dialogs
          await conn.client.getDialogs({ limit: 100 });
          // Also try to explicitly resolve the entity
          await resolvePeerEntity(accountId, conn.client, chatId);
        } catch (refreshErr: any) {
          Logger.warn(`[TelegramUserListener] Entity refresh failed: ${refreshErr.message}`);
        }
        continue; // retry with refreshed entity
      }
      if (errMsg.includes('CHANNEL_INVALID')) {
        Logger.warn(`[TelegramUserListener] getForumTopics: CHANNEL_INVALID for ${chatId} after retry`);
        return { success: false, error: 'CHANNEL_INVALID: Nhóm này không phải supergroup hoặc access hash đã hết hạn' };
      }
      return { success: false, error: errMsg };
    }
  }
  return { success: false, error: 'CHANNEL_INVALID' };
}

/**
 * Lấy messages của 1 topic cụ thể
 */
export async function getForumTopicMessages(accountId: string, chatId: string, rootMessageId: string, limit = 50): Promise<{ success: boolean; messages?: any[]; error?: string }> {
  touchActiveChannel(accountId, chatId);
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const requestKey = `${accountId}:${chatId}`;
  const requestToken = Symbol(rootMessageId);
  latestTopicMessageRequests.set(requestKey, requestToken);
  // Topic clicks can arrive in a burst. Let the latest selection win before
  // invoking GetReplies; stale calls were causing avoidable FLOOD_WAIT sleeps.
  await new Promise(resolve => setTimeout(resolve, 200));
  if (latestTopicMessageRequests.get(requestKey) !== requestToken) {
    return { success: false, error: 'REQUEST_SUPERSEDED' };
  }
  try {
    const { Api } = require('telegram');
    tgLog('info', accountId, 'topic_api', 'TOPIC_MESSAGES_REQUEST', {
      chatId,
      requestedId: rootMessageId,
      limit,
    });
    // messages.getReplies expects the immutable ForumTopic.id/root message.
    const result = await conn.client.invoke(new Api.messages.GetReplies({
      peer: await resolveInputPeer(accountId, conn.client, chatId),
      msgId: Number(rootMessageId),
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }));

    const messages = (result as any)?.messages || [];
    tgLog('info', accountId, 'topic_api', 'TOPIC_MESSAGES_RESPONSE', {
      chatId,
      requestedId: rootMessageId,
      count: messages.length,
      firstMsgId: messages[0]?.id != null ? String(messages[0].id) : '-',
    });
    const users = (result as any)?.users || [];
    const userMap = new Map<string, any>(users.map((u: any) => [String(u.id), u]));
    for (const user of users) {
      const userId = String(user.id || '');
      if (!userId) continue;
      cacheTelegramPeer(accountId, userId, user);
      const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || userId;
      DatabaseService.getInstance()?.upsertGroupMember(accountId, chatId, {
        memberId: userId, displayName, avatar: '', role: 0,
        username: user.username || '',
      });
    }
    const cachedPeerType = DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const rawMessageById = new Map<string, any>(messages.map((message: any) => [String(message.id), message]));

    const mappedMessages = messages.map((m: any) => {
      const normalized = normalizeTelegramMessageMedia(m, cachedPeerType);
      const replyToId = getTelegramReplyToMessageId(m);
      let quoteData: string | undefined;
      const original = replyToId ? rawMessageById.get(replyToId) : undefined;
      if (original) {
        const originalNormalized = normalizeTelegramMessageMedia(original, cachedPeerType);
        quoteData = buildTelegramQuoteData({
          msgId: replyToId!,
          content: originalNormalized.content,
          msgType: originalNormalized.msgType,
          senderId: String(original.senderId?.valueOf() || ''),
          attachments: originalNormalized.attachments,
        });
      }

      return {
        id: String(m.id),
        text: normalized.content,
        date: m.date || 0,
        senderId: String(m.fromId?.userId || ''),
        senderName: (() => {
          const uid = String(m.fromId?.userId || '');
          const u = userMap.get(uid);
          return u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '';
        })(),
        isOut: !!m.out,
        replyToId,
        quoteData,
        topicRootMessageId: rootMessageId,
        msgType: normalized.msgType,
        attachments: normalized.attachments,
        media: m.media ? { type: m.media.className } : undefined,
        localPaths: undefined as Record<string, string> | undefined,
      };
    });

    const db = DatabaseService.getInstance();
    if (db) {
      let scheduledMediaDownloads = 0;
      for (let index = 0; index < mappedMessages.length; index++) {
        const message = mappedMessages[index];
        const existingMessage = db.queryOne<any>(
          `SELECT local_paths FROM messages
           WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
          [message.id, accountId, chatId],
        );
        // Repair rows that history/difference inserted earlier with an
        // incomplete reply header and therefore the wrong topic_id.
        db.run(`
          UPDATE messages SET topic_id = ?, reply_to_id = ?, quote_data = COALESCE(quote_data, ?)
          WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
        `, [rootMessageId, message.replyToId || null, message.quoteData || null, message.id, accountId, chatId]);
        db.run(`
          INSERT OR IGNORE INTO messages
            (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data, topic_id)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'received', 'telegram_user', ?, ?, ?)
        `, [
          message.id, accountId, chatId, message.senderId,
          message.text || '', message.msgType,
          Number(message.date || 0) * 1000, message.isOut ? 1 : 0,
          JSON.stringify(message.attachments || []),
          message.replyToId || null, message.quoteData || null, message.topicRootMessageId,
        ]);
        const rawMessage = messages[index];
        let hasLocalMedia = false;
        try {
          const localPaths = typeof existingMessage?.local_paths === 'string'
            ? JSON.parse(existingMessage.local_paths || '{}')
            : existingMessage?.local_paths || {};
          hasLocalMedia = Object.values(localPaths).some(Boolean);
          message.localPaths = localPaths;
        } catch {}
        // Hydrate only the newest visible media and never redownload rows that
        // already have a local file. Queuing every historical attachment from
        // several rapidly-clicked topics opened many exported DC senders.
        if (rawMessage?.media && !hasLocalMedia && scheduledMediaDownloads < 12) {
          scheduledMediaDownloads++;
          downloadMediaForMessage(accountId, conn.client, rawMessage, message.id, message.msgType, chatId).catch(() => {});
        }
      }
    }

    if (latestTopicMessageRequests.get(requestKey) === requestToken) {
      latestTopicMessageRequests.delete(requestKey);
    }
    return { success: true, messages: mappedMessages };
  } catch (err: any) {
    if (latestTopicMessageRequests.get(requestKey) === requestToken) {
      latestTopicMessageRequests.delete(requestKey);
    }
    tgLog('warn', accountId, 'topic_api', 'TOPIC_MESSAGES_FAILED', {
      chatId,
      requestedId: rootMessageId,
      error: err?.message || String(err),
    });
    return { success: false, error: err.message };
  }
}

/**
 * Tạo topic mới trong forum group
 */
export async function createForumTopic(accountId: string, chatId: string, title: string, iconColor?: number, iconEmojiId?: string): Promise<{ success: boolean; topicId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.channels.CreateForumTopic({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
      title,
      iconColor: iconColor || 0,
      iconEmojiId: iconEmojiId ? BigInt(iconEmojiId) : undefined,
    }));
    const topicId = getMessageIdFromUpdates(result);
    return { success: true, topicId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Đổi tên/đóng/mở topic
 */
export async function editForumTopic(accountId: string, chatId: string, topicId: string, opts: { title?: string; iconEmojiId?: string; closed?: boolean; pinned?: boolean }): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    await conn.client.invoke(new Api.channels.EditForumTopic({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
      topicId: Number(topicId),
      title: opts.title,
      iconEmojiId: opts.iconEmojiId ? BigInt(opts.iconEmojiId) : undefined,
      closed: opts.closed,
      pinned: opts.pinned,
    }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Gửi tin nhắn vào topic cụ thể
 */
export async function sendTopicMessage(accountId: string, chatId: string, rootMessageId: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: `Gửi tin quá nhanh. Vui lòng chờ ${rateLimit.waitSeconds} giây.` };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const result = await conn.client.invoke(new Api.messages.SendMessage({
      peer,
      message: text,
      replyTo: new Api.InputReplyToMessage({
        replyToMsgId: Number(rootMessageId),
        topMsgId: Number(rootMessageId),
      }),
      randomId: BigInt(Math.floor(Math.random() * 2**64)),
    }));
    const msgId = getMessageIdFromUpdates(result) || String(Date.now());
    const now = Date.now();

    // Save to DB (INSERT OR IGNORE — socket echo sẽ skip nếu đã tồn tại)
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, topic_id) VALUES (?, ?, ?, 1, ?, ?, 'text', ?, 1, '[]', 'sent', 'telegram_user', ?, ?)`,
        [msgId, accountId, chatId, accountId, text, now, null, rootMessageId]);

      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, 'group', 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END
      `, [accountId, chatId, text, now]);
    }

    // Emit event cho renderer
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      message: {
        type: 1,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: text,
          msgType: 'text',
          ts: String(now),
          topicId: rootMessageId,
        },
      },
    });

    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Telegram Sticker/GIF APIs ──────────────────────────────────────────────

/** Get all installed sticker sets */
export async function getStickerSets(accountId: string): Promise<{ success: boolean; sets?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.messages.GetAllStickers({ hash: BigInt(0) }));
    const sets = (result.sets || []).map((set: any) => ({
      id: String(set.id?.valueOf?.() || set.id || ''),
      accessHash: String(set.accessHash?.valueOf?.() || ''),
      shortName: set.shortName || '',
      title: set.title || '',
      count: set.count || 0,
    }));
    Logger.log(`[TelegramUser] getStickerSets: ${sets.length} sets, sample: ${sets[0]?.shortName || 'none'}`);
    return { success: true, sets };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Get stickers from a specific set */
export async function getStickerSetStickers(accountId: string, setId: string, accessHash?: string, shortName?: string): Promise<{ success: boolean; stickers?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    // Use InputStickerSetShortName if available (doesn't need accessHash)
    let stickerset: any;
    if (shortName) {
      stickerset = new Api.InputStickerSetShortName({ shortName });
    } else {
      // Fallback: need valid accessHash
      if (!accessHash || accessHash === '0') {
        return { success: false, error: 'Missing sticker set accessHash' };
      }
      stickerset = new Api.InputStickerSetID({ id: BigInt(setId), accessHash: BigInt(accessHash) });
    }
    const result = await conn.client.invoke(new Api.messages.GetStickerSet({
      stickerset,
      hash: 0,  // int type, not long
    }));
    const stickers = (result.documents || []).map((doc: any) => {
      const attrs = doc.attributes || [];
      const stickerAttr = attrs.find((a: any) => a.className === 'DocumentAttributeSticker');
      const imageSize = attrs.find((a: any) => a.className === 'DocumentAttributeImageSize');
      const mimeType = String(doc.mimeType || '');
      const format = mimeType.includes('tgsticker') ? 'tgs' : mimeType.includes('webm') ? 'webm' : 'webp';
      return {
        id: String(doc.id?.valueOf?.() || doc.id || ''),
        emoji: stickerAttr?.alt || '',
        format, width: imageSize?.w || 512, height: imageSize?.h || 512,
        accessHash: String(doc.accessHash || ''), dcId: doc.dcId || 0,
      };
    });
    return { success: true, stickers };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Get recent stickers */
export async function getRecentStickers(accountId: string): Promise<{ success: boolean; stickers?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) }));
    const stickers = (result.stickers || []).map((doc: any) => {
      const attrs = doc.attributes || [];
      const stickerAttr = attrs.find((a: any) => a.className === 'DocumentAttributeSticker');
      const mimeType = String(doc.mimeType || '');
      const format = mimeType.includes('tgsticker') ? 'tgs' : mimeType.includes('webm') ? 'webm' : 'webp';
      return { id: String(doc.id?.valueOf?.() || doc.id || ''), emoji: stickerAttr?.alt || '', format };
    });
    return { success: true, stickers };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Get trending GIFs */
export async function getGifs(accountId: string): Promise<{ success: boolean; gifs?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.messages.GetGifs({ hash: BigInt(0) }));
    const gifs = (result.gifs || []).map((doc: any) => ({
      id: String(doc.id?.valueOf?.() || doc.id || ''),
      dcId: doc.dcId || 0,
      accessHash: String(doc.accessHash || ''),
      size: doc.size || 0,
    }));
    return { success: true, gifs };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Search GIFs */
export async function searchGifs(accountId: string, query: string): Promise<{ success: boolean; gifs?: any[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.messages.SearchGifs({ q: query, offset: 0 }));
    const gifs = (result.gifs || []).map((doc: any) => ({
      id: String(doc.id?.valueOf?.() || doc.id || ''),
      dcId: doc.dcId || 0,
      accessHash: String(doc.accessHash || ''),
    }));
    return { success: true, gifs };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Send sticker by document ID */
export async function sendSticker(accountId: string, chatId: string, stickerId: string, accessHash?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    // Try to resolve the sticker document to get correct accessHash and fileReference
    let stickerAccessHash = BigInt(accessHash || '0');
    let fileReference = Buffer.from([]);
    if (!accessHash) {
      // Fallback: try to get from cached sticker or recent stickers
      try {
        const recent = await conn.client.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) }));
        const found = (recent.stickers || []).find((d: any) => String(d.id) === stickerId);
        if (found) {
          stickerAccessHash = found.accessHash || BigInt(0);
          fileReference = found.fileReference || Buffer.from([]);
        }
      } catch {}
    }
    const result = await conn.client.sendFile(peer, {
      file: new Api.InputDocument({
        id: BigInt(stickerId),
        accessHash: stickerAccessHash,
        fileReference,
      }),
    });
    return { success: true, messageId: String(result?.id || Date.now()) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Send GIF by document ID */
export async function sendGif(accountId: string, chatId: string, documentId: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const result = await conn.client.sendFile(peer, {
      file: new Api.InputDocument({ id: BigInt(documentId), accessHash: BigInt(0), fileReference: Buffer.from([]) }),
    });
    return { success: true, messageId: String(result?.id || Date.now()) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Download sticker thumbnail for picker display.
 * Returns local file path of the downloaded sticker.
 */
export async function downloadSticker(accountId: string, stickerId: string, accessHash?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    // Try to get the sticker document
    let doc: any = null;

    // Method 1: Get from recent stickers
    try {
      const recent = await conn.client.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) }));
      doc = (recent.stickers || []).find((d: any) => String(d.id) === stickerId);
    } catch {}

    // Method 2: If not found in recent, try from faved stickers
    if (!doc) {
      try {
        const faved = await conn.client.invoke(new Api.messages.GetFavedStickers({ hash: BigInt(0) }));
        doc = (faved.stickers || []).find((d: any) => String(d.id) === stickerId);
      } catch {}
    }

    if (!doc) {
      // Try to construct InputDocument from provided accessHash
      if (accessHash) {
        doc = { id: BigInt(stickerId), accessHash: BigInt(accessHash), fileReference: Buffer.from([]) };
      } else {
        return { success: false, error: 'Sticker not found in recent/faved' };
      }
    }

    // Download the document
    const buffer = await conn.client.downloadMedia(doc);
    if (!buffer || buffer.length === 0) {
      return { success: false, error: 'Download failed' };
    }

    // Save to disk
    const fs = require('fs');
    const path = require('path');
    const FileStorageService = require('../file/FileStorageService').default;
    const baseDir = FileStorageService.getBaseDir();
    const stickersDir = path.join(baseDir, accountId, 'stickers');
    if (!fs.existsSync(stickersDir)) fs.mkdirSync(stickersDir, { recursive: true });

    const mimeType = doc.mimeType || '';
    const ext = mimeType.includes('webm') ? '.webm' : mimeType.includes('tgsticker') || mimeType.includes('lottie') ? '.tgs' : '.webp';
    const filePath = path.join(stickersDir, `sticker_${stickerId}${ext}`);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    return { success: true, localPath: filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
