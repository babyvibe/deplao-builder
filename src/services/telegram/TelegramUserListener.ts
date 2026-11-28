/**
 * TelegramUserListener.ts - MTProto listener for personal Telegram
 *
 * Keeps 1 live MTProto connection per logged-in account.
 * Listens for new messages, writes them to the messages table, emits events for the UI.
 *
 * Follows the FacebookMQTTListener.ts pattern.
 * Uses the GramJS (telegram) library for the MTProto protocol.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events';
import { getPeerId } from 'telegram/Utils';
import * as path from 'path';
import * as fs from 'fs';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import { TELEGRAM_TOP_MESSAGE_ID_SQL, telegramTopMessageIdParams } from '../database/telegramTopMessage';
import { createCatchUpPacer, focusFirst } from './messages/telegramCatchUpPacer';
import { createResumeTurns } from './messages/telegramResumeTurns';
import { mergeTelegramPollUpdate, telegramPollAttachment } from './messages/telegramPolls';
import { onSystemPower } from '../../utils/startup/systemIdle';
import EventBroadcaster from '../event/EventBroadcaster';
import FileStorageService from '../file/FileStorageService';
import { writeMediaFile } from '../file/writeMediaFile';
import { shouldFetchAvatar, markAvatarFetched, markAvatarSuccess, resetAvatarCache } from '../../utils/telegram/avatarFetchCache';
import type { TelegramPeerType } from '../../models/telegram/telegram';
import { getTelegramMessagePreview } from './messages/TelegramMessagePreview';
import { parseGroupLink } from '../../shared/crm/groupLinks';
import { describeTelegramServiceAction } from './messages/telegramServiceText';
import { getTelegramForwardAttachment, telegramEntityName } from './messages/telegramForward';
import { markTelegramMessagesDeleted } from './messages/telegramDeletions';
import type { MessagesSyncedEvent } from '../../shared/chat/messagesSynced';
import {
  createPendingLinkPreviewWatch, isLinkPreviewAttachment, LINK_PREVIEW_TARGET_TYPES, telegramLinkPreviewState, telegramWebpageIdOf,
  withLinkPreview, type PendingLinkPreview, type TelegramLinkPreviewState,
} from './messages/telegramSentLinkPreview';
import { telegramStrippedThumb, telegramVideoAttributes, telegramWebpageMeta } from './media/telegramMediaMeta';
import * as TelegramStickers from './media/telegramStickers';
import { stickerSetRefOf, type StickerClientDeps, type TelegramStickerSetRef } from './media/telegramStickers';
import { mapForumTopics } from './channels/telegramForumTopics';
import { basicGroupChat, telegramParticipantsCount } from './channels/telegramMemberCount';
import { mapReadReceiptError, normalizeReadParticipants, type ReadReceiptUnavailableReason } from './read/telegramReadReceipts';
import { applyTelegramReadUpdate, parseTelegramReadUpdate } from './read/telegramReadHistory';
import { isStartupSettled, whenStartupSettled } from '../../utils/startup/startupSettle';
import { telegramSentTimestamp } from '../../utils/time/serverClock';
import { messageTimestampById, recordPeerReceipt } from '../receipts/peerReceipts';
import { mediaProgressReporter } from '../media/mediaProgress';
import {
  createTelegramDownloadQueue, isTelegramDownloadPreempted,
  type TelegramDownloadOptions, type TelegramDownloadRun, type TelegramDownloadUrgency,
} from './media/telegramDownloadQueue';
import { richMediaRefs, richMessageToBlocks, richMessageToText, todoListToText } from './messages/telegramRichMessage';
import {
  chatInviteJoinOutcome, inlineButtonInfo, stripUnsupportedTelegramPeers, TELEGRAM_BOT_VERIFICATION_ERROR,
  type InlineButtonInfo,
} from './api/telegramLayerCompat';
import { GRAMJS_BUNDLED_LAYER, telegramApiLayerState } from './api/telegramApiLayer';
import {
  discussionAccess, discussionOpenWindow, discussionPageFlags, discussionRoot, mergeTelegramPostStats, withCommentsRead,
  type DiscussionAnchor,
} from './channels/telegramChannelPosts';
import { isTelegramMetaAttachment } from '../../shared/telegram/telegramAttachmentTypes';
import {
  MINI_APP_METHOD_RE, MINI_APP_PLATFORM, miniAppParamsJson, sanitizeMiniAppTheme, urlAuthInfo, type UrlAuthInfo,
} from '../../shared/telegram/telegramMiniApp';
import { isUndecryptedCredential } from '../../shared/accounts/storedCredential';
import { normalizeTelegramReaction, orderTelegramReactions, type TelegramChatReactions, type TelegramReactionCatalog } from '../../shared/telegram/telegramReactions';
import {
  normalizeTelegramTtl, telegramCallCardContent, telegramCallReasonOf, telegramPresenceOf, telegramPresenceRank,
  telegramUsernameError, validateTelegramUsername,
  type TelegramCallHistoryItem, type TelegramCallInfo, type TelegramChatSettings, type TelegramContactItem,
  type TelegramCreateChannelResult, type TelegramMissingInvitee,
} from '../../shared/telegram/telegramQuickModel';

// Telegram API credentials - register at my.telegram.org
import { API_ID, API_HASH } from '../../configs/channels/telegram.config';
import { tr } from '../../shared/i18n';
import { TELEGRAM_PINNED_LIMIT } from '../../shared/telegram/telegramPins';
import { isLocalMediaUrl, localMediaUrlToPath } from '../../shared/media/localMediaUrl';

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
  /** Archived/All dialog watch; separate from channelPollTimer (see CHANNEL_DIALOG_WATCH_TICK_MS). */
  dialogWatchTimer: ReturnType<typeof setInterval> | null;
  connecting: Promise<void> | null;
  healthCheckClient: TelegramClient | null;
  transportDownSince: number | null;
  retryCount: number;
  /** Timestamp of the last GramJS transport diagnostic written to our log.
   * GramJS retries an idle ping several times, so logging each raw stack is
   * noisy and hides the account that is actually affected. */
  lastTransportErrorAt: number;
  stopped: boolean;
  /** The GramJS Connection object last seen healthy. GramJS replaces it when
   * it rebuilds the socket in place, which is how a real reconnect is told
   * apart from its periodic `connected` heartbeat. */
  transportIdentity: unknown;
  /** Pending confirmation of a GramJS `disconnected` report (see
   * TRANSPORT_DISCONNECT_CONFIRM_MS). */
  disconnectConfirmTimer: ReturnType<typeof setTimeout> | null;
  /** Last time the primary transport was observed healthy (heartbeat, probe,
   * connect). Nothing runs while the machine sleeps, so after a long sleep this
   * still holds the pre-sleep time and selects a full catch-up. */
  lastAliveAt: number;
  /** Last time Telegram pushed any update to this connection. */
  lastUpdateAt: number;
  /** Set on system resume: the next restoration must run a full catch-up. */
  forceFullCatchUp: boolean;
  /** Telegram rejected the authorization itself (revoked, expired, duplicated).
   * Only a new login can fix it, so nothing reconnects automatically. */
  sessionInvalid: boolean;
}

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PRIMARY_RECONNECT_GRACE_MS = 70_000;
const HEALTH_CHECK_INTERVAL_MS = 45_000;
// GramJS 2.26 emits `disconnected` whenever a ping is slower than 1s and then
// `connected` when the same socket answers. Only an outage that is still
// unresolved after this window is surfaced to the UI and rebuilds the client.
const TRANSPORT_DISCONNECT_CONFIRM_MS = 8_000;
// A blip shorter than this only needs updates.getDifference plus the recent
// dialog watch. Longer outages (including any system sleep) run the full
// history/channel catch-up.
const LIGHT_CATCHUP_MAX_OFFLINE_MS = 5 * 60_000;
// Telegram documents "no updates for 15 minutes or longer" as a gap that the
// client must close with getDifference.
const NO_UPDATES_WATCHDOG_MS = 15 * 60_000;
// The health probe is application level. When GramJS pings are still being
// answered, a slow getMe (FLOOD_WAIT sleeps inside GramJS) is not an outage.
const HEALTH_HEARTBEAT_FRESH_MS = 30_000;
const STALE_RECOVERY_REQUEUE_INTERVAL_MS = 5 * 60_000;
// No application await may depend on a single MTProto request forever. GramJS
// has no request timeout, and it never rejects requests of a client that was
// disconnected. Generous enough for GramJS's own FLOOD_WAIT sleeps (<= 60s).
const TELEGRAM_RPC_DEADLINE_MS = 180_000;
// client.connect() retries five times; each TCP attempt has no timeout of its
// own (about 21s on Windows when SYN goes unanswered).
const TELEGRAM_CONNECT_DEADLINE_MS = 120_000;
const TELEGRAM_PROBE_DEADLINE_MS = 15_000;
const MEDIA_DOWNLOAD_DEADLINE_MS = 5 * 60_000;
const RETIRED_CLIENT_SHUTDOWN_MS = 3_000;
const INITIAL_DIALOG_LIMIT = 300;
const RECENT_DIALOG_LIMIT = 200;
// Metadata-only sweep: this is deliberately independent from history sync.
// It establishes a trusted membership cache for every dialog on accounts with
// thousands of channels without downloading thousands of message histories.
const MEMBERSHIP_RECONCILE_DIALOG_LIMIT = 2_500;
const INITIAL_MESSAGES_PER_DIALOG = 100;
const RECOVERY_MESSAGES_PER_DIALOG = 1000;
const MAX_MANUAL_MESSAGE_DOWNLOAD = 5000;
// Telegram message IDs are positive signed 32-bit integers. Never use a
// timestamp-based/local temporary ID as an MTProto minId checkpoint.
const MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647;

/** Map accountId → ActiveListener */
const activeListeners = new Map<string, ActiveListener>();
const intentionallyDisconnectedClients = new WeakSet<TelegramClient>();
/** Clients whose GramJS sender and update loop were shut down by retireTelegramClient. */
const retiredClients = new WeakSet<TelegramClient>();
type CatchUpMode = 'light' | 'full';
const reconnectCatchUps = new Map<string, { client: TelegramClient; promise: Promise<void> }>();
/** Strongest catch-up requested while one was already running for the same client. */
const pendingCatchUpModes = new Map<string, CatchUpMode>();
const catchUpFailureCounts = new Map<string, number>();
const manualRefreshTasks = new Map<string, Promise<void>>();
/** Account locks remember the client that owns them. A lock held by a retired
 * client never blocks its replacement: GramJS does not reject the old client's
 * in-flight requests, so that lock could otherwise be held forever. */
type AccountLockOwner = { client: TelegramClient; since: number };
const syncingAccounts = new Map<string, AccountLockOwner>();
const recoveringUpdateAccounts = new Map<string, AccountLockOwner>();
const membershipReconciliations = new Map<string, Promise<void>>();
const membershipReconciledAccounts = new Set<string>();
const rawUpdateHandlers = new Map<string, (update: any) => Promise<void>>();
/** All direct-download operations share one account queue. GramJS borrows an
 * exported sender per DC; allowing avatar and media paths to run independently
 * causes the "Not connected" reconnect storm seen on media-heavy forums.
 * One transfer per account, but the open conversation and the newest messages
 * first (telegramDownloadQueue.ts) — FIFO made the open chat wait for catch-up. */
const telegramDownloads = createTelegramDownloadQueue({
  deadlineMs: MEDIA_DOWNLOAD_DEADLINE_MS,
  onPreempt: ({ accountId, key, downloaded, total, forKey }) => {
    Logger.info(`[TG:download] YIELD account=${accountId} key=${key} at=${downloaded}/${total} for=${forKey}`);
  },
});
/** Background catch-up (difference, TooLong history, resync, dialog watch) yields the main thread on a pace (telegramCatchUpPacer.ts). */
const paceCatchUp = createCatchUpPacer();
/** After the machine wakes up / unlocks: catch up each account's messages one by one, the account with the open conversation first (telegramResumeTurns.ts). */
const resumeTurns = createResumeTurns({ focusedAccount: () => telegramDownloads.getFocus()?.accountId || null });
onSystemPower(ev => {
  if (ev !== 'suspend') resumeTurns.noteWake();
});
/**
 * Poll results recently asked for, by poll id (the UpdateMessagePoll of the old layer carries only the poll id, not the message):
 * `${accountId}:${pollId}` → conversation + message. Limited number of entries; the oldest is dropped.
 */
const telegramPollMessages = new Map<string, { chatId: string; msgId: string }>();
const TELEGRAM_POLL_MEMORY = 2000;

function rememberTelegramPoll(accountId: string, pollId: string, chatId: string, msgId: string): void {
  if (!pollId || pollId === '0') return;
  const key = `${accountId}:${pollId}`;
  telegramPollMessages.delete(key);
  telegramPollMessages.set(key, { chatId, msgId });
  if (telegramPollMessages.size > TELEGRAM_POLL_MEMORY) {
    const oldest = telegramPollMessages.keys().next().value;
    if (oldest) telegramPollMessages.delete(oldest);
  }
}

/**
 * Applies new poll results to the saved messages (messages/telegramPolls.ts) and patches the UI (event:messagesRepaired; employees receive it too).
 * Returns the new attachments; null = no message / nothing changed.
 */
function applyTelegramPollUpdate(accountId: string, chatId: string, msgId: string, update: { poll?: any; results?: any }): string | null {
  const db = DatabaseService.getInstance();
  if (!db || !chatId || !msgId) return null;
  const row = db.queryOne<any>(
    `SELECT attachments FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND CAST(thread_id AS TEXT) = ? AND channel = 'telegram_user'`,
    [accountId, msgId, chatId],
  );
  if (!row) return null;
  const merged = mergeTelegramPollUpdate(row.attachments, update);
  if (!merged) return null;
  db.run(
    `UPDATE messages SET attachments = ? WHERE owner_zalo_id = ? AND msg_id = ? AND CAST(thread_id AS TEXT) = ? AND channel = 'telegram_user'`,
    [merged, accountId, msgId, chatId],
  );
  EventBroadcaster.emit('event:messagesRepaired', { zaloId: accountId, threadId: chatId, items: [{ msgId, attachments: JSON.parse(merged) }] });
  return merged;
}

/** UpdateMessagePoll: the new layer carries the conversation + message; the old layer carries only the poll id (poll results recently asked for). */
function handleTelegramPollUpdate(accountId: string, update: any): void {
  const pollId = update?.pollId != null ? String(update.pollId) : '';
  let chatId = update?.peer ? getCanonicalChatId(update.peer) : '';
  let msgId = update?.msgId != null ? String(update.msgId) : '';
  if (!chatId || !msgId) {
    const known = telegramPollMessages.get(`${accountId}:${pollId}`);
    if (!known) return;
    chatId = known.chatId;
    msgId = known.msgId;
  } else {
    rememberTelegramPoll(accountId, pollId, chatId, msgId);
  }
  applyTelegramPollUpdate(accountId, chatId, msgId, { poll: update?.poll, results: update?.results });
}

/** The account's open Telegram conversation (the renderer reports it via setTelegramDownloadFocus): catch up its messages first. */
function focusedTelegramChat(accountId: string): string | null {
  const focus = telegramDownloads.getFocus();
  return focus && focus.accountId === String(accountId) ? focus.threadId : null;
}
/** Media-repair RPCs (one getMessages per chat batch), serialized per account. */
const mediaRepairQueues = new Map<string, Promise<unknown>>();
const quoteRepairQueues = new Map<string, Promise<unknown>>();
const entityHydrationQueues = new Map<string, Promise<any | null>>();
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

/** GramJS can upload only absolute paths; media DB rows may be storage-relative. */
function resolveTelegramUploadPath(filePath: string): string {
  const raw = String(filePath || '');
  const candidate = isLocalMediaUrl(raw) ? localMediaUrlToPath(raw, { windows: process.platform === 'win32' }) : raw;
  return FileStorageService.resolveAbsolutePath(candidate);
}

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

/**
 * Always-on, privacy-safe trace for the MTProto channel/supergroup ingress
 * path. Unlike tgLog(info), this intentionally remains visible without
 * TELEGRAM_VERBOSE_LOGGING while we diagnose live updates that otherwise only
 * fail on high-traffic `-100…` peers. Keep this to IDs/state only: terminal
 * logs are routinely copied for support and must not contain message bodies,
 * session strings, or access hashes.
 */
function tgChannelRealtimeTrace(stage: string, accountId: string, extra: Record<string, unknown>): void {
  const fields = [`account=${accountId}`];
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') fields.push(`${key}=${value}`);
  }
  // Logger.log(`[TG:channel-realtime] ${stage} | ${fields.join(' ')}`);
}

/** Short-lived login state is separate from persistent account listeners. */
let pendingLogin: { client: TelegramClient; phoneNumber: string; phoneCodeHash: string; expiresAt: number } | null = null;

async function clearPendingLogin(): Promise<void> {
  const current = pendingLogin;
  pendingLogin = null;
  if (current?.client) {
    // The login client shares its auth key with the listener started next;
    // disconnect() alone would keep its ping loop running for good.
    await retireTelegramClient(current.client, 'login_finished');
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
    return { state: 'forbidden', action: 'none', reason: tr('Nhóm hoặc kênh này không còn khả dụng với tài khoản của bạn') };
  }
  if (entity.left) {
    if (entity.joinRequest) {
      return { state: 'request', action: 'request', reason: tr('Bạn cần được quản trị viên duyệt để tham gia nhóm này') };
    }
    const publicUsername = entity.username || (entity.usernames || []).some((item: any) => item?.active && item?.username);
    if (publicUsername || entity.hasLink) {
      return { state: 'joinable', action: 'join', reason: tr('Bạn chưa tham gia cuộc trò chuyện này') };
    }
    return { state: 'left', action: 'none', reason: tr('Nhóm riêng tư này cần liên kết mời để tham gia lại') };
  }
  return { state: 'member', action: 'none', reason: '' };
}

function getTelegramSendCapability(entity: any): { canSend: boolean; reason: string } {
  if (!entity) return { canSend: true, reason: '' };
  if (entity.className === 'User') return { canSend: !entity.deleted, reason: entity.deleted ? tr('Tài khoản Telegram không còn hoạt động') : '' };
  const membership = getTelegramMembership(entity);
  if (membership.state !== 'member') return { canSend: false, reason: membership.reason };
  const now = Math.floor(Date.now() / 1000);
  const banned = entity.bannedRights;
  const banActive = !!banned && (!Number(banned.untilDate || 0) || Number(banned.untilDate) > now);
  if (banActive && (banned.sendMessages || banned.sendPlain || banned.viewMessages)) {
    return { canSend: false, reason: tr('Bạn không có quyền gửi tin nhắn trong cuộc trò chuyện này') };
  }
  if (entity.className === 'Channel' && (entity.broadcast || entity.gigagroup)) {
    const canPost = !!entity.creator || !!entity.adminRights?.postMessages;
    return { canSend: canPost, reason: canPost ? '' : tr('Chỉ quản trị viên được đăng bài trong kênh này') };
  }
  if (entity.creator || entity.adminRights) return { canSend: true, reason: '' };
  const defaults = entity.defaultBannedRights;
  if (defaults?.sendMessages || defaults?.sendPlain) {
    return { canSend: false, reason: tr('Nhóm này chỉ cho phép quản trị viên gửi tin nhắn') };
  }
  return { canSend: true, reason: '' };
}

/**
 * Whether a bot has a main Mini App (User.bot_has_main_app, layer 185+): 1 / 0 for a full bot User, null when unknown (not a
 * bot, a min User that may lack the flag, no entity). botInfo.appSettings is NOT the signal: many main-app bots never set it.
 */
function telegramBotHasMainApp(entity: any): 0 | 1 | null {
  if (entity?.className !== 'User' || !entity?.bot || entity?.min) return null;
  return entity.botHasMainApp ? 1 : 0;
}

/** Top message of a GramJS dialog (`Dialog.message`, sent along with getDialogs): its server time and its conversation-row preview. */
function telegramDialogTopMessage(dialog: any, peerType?: string): { timestamp: number; preview: string } | null {
  const message = dialog?.message;
  const seconds = Number(message?.date || 0);
  if (!message || !Number.isFinite(seconds) || seconds <= 0) return null;
  const { content, msgType } = normalizeTelegramMessageMedia(message, peerType as TelegramPeerType | undefined);
  return { timestamp: seconds * 1000, preview: getTelegramMessagePreview(msgType, telegramDisplayContent(content, msgType)) };
}

function persistTelegramDialogState(
  accountId: string,
  chatId: string,
  dialog: any,
  entity: any,
  fullChat?: any,
  emitRefresh = true,
  /** 1 when the dialog was listed as archived; omitted keeps the stored folder. */
  listedFolderId?: 1,
): boolean {
  const db = DatabaseService.getInstance();
  if (!db || !chatId) return false;
  const existing = db.queryOne<any>(
    `SELECT telegram_folder_id, is_muted, mute_until, telegram_membership_state, is_in_others, unread_count, telegram_can_send,
            peer_read_max_id, last_message_time, has_main_app
     FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [accountId, chatId],
  );
  // The other side read my messages up to this id (read_outbox_max_id), including reads made while the app was closed
  const readOutboxMaxId = Number(dialog?.dialog?.readOutboxMaxId ?? dialog?.readOutboxMaxId ?? 0) || 0;
  const peerType = entity ? getTelegramPeerType(entity) : (db.getTelegramPeer(accountId, chatId)?.peer_type || 'user');
  const capability = getTelegramSendCapability(entity);
  // When the entity is null → keep the old membership state instead of resetting it to 'member'
  const membership = entity
    ? getTelegramMembership(entity)
    : { state: (existing?.telegram_membership_state || 'member') as TelegramMembershipState, action: 'none' as const, reason: '' };
  const folderId = Number(listedFolderId ?? dialog?.folderId ?? dialog?.dialog?.folderId ?? existing?.telegram_folder_id ?? 0);
  const rawMuteUntil = dialog?.dialog?.notifySettings?.muteUntil ?? dialog?.notifySettings?.muteUntil;
  const muteUntilSeconds = rawMuteUntil == null ? null : Number(rawMuteUntil || 0);
  const foreverMuted = muteUntilSeconds == null
    ? Number(existing?.is_muted || 0) === 1
    : muteUntilSeconds >= 2147483647;
  const muteUntilMs = muteUntilSeconds == null
    ? Number(existing?.mute_until || 0)
    : (foreverMuted ? 0 : muteUntilSeconds * 1000);
  const membersCount = telegramParticipantsCount(fullChat, entity);
  const onlineCount = Number(fullChat?.onlineCount ?? 0);
  const displayName = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || chatId;
  const contactType = peerType === 'user' ? 'user' : 'group';
  // Saved Messages (self-chat) → auto pin local
  const isSelfChat = peerType === 'user' && chatId === accountId;
  // Update is_cov_bot flag — only set to 1 when confirmed bot, leave untouched otherwise
  const isBot = entity?.className === 'User' && entity?.bot ? 1 : null;
  // Take unread_count from the Telegram dialog (exact sync with Telegram)
  const dialogUnreadCount = Number(dialog?.unreadCount ?? 0);
  // is_in_others: archived | not joined (joinable/request/left/forbidden)
  const isInOthers = (folderId === 1 || membership.state !== 'member') ? 1 : 0;
  // The dialog's top message (getDialogs sends it with every dialog): the row gets its preview and time even when its history is
  // not loaded (dialogs past the first sync's 300, the membership reconcile's 2,500 channels). Without it these rows had no time:
  // they sat at the bottom, and opening one loaded its history and made it jump.
  const top = telegramDialogTopMessage(dialog, peerType);
  const topNewer = !!top && top.timestamp > Number(existing?.last_message_time || 0);
  // Bot with a main Mini App (User.bot_has_main_app): the conversation row shows "Open" like Telegram. Only a full bot User
  // decides it (a min User may lack the flag); anything else keeps the stored value.
  const hasMainApp = telegramBotHasMainApp(entity);
  // Only fields the conversation list renders. Online counts and timestamps
  // change on every pass and must not trigger a renderer refresh.
  const changed = !existing
    || topNewer
    || (hasMainApp != null && (existing.has_main_app == null || Number(existing.has_main_app) !== hasMainApp))
    || Number(existing.unread_count || 0) !== dialogUnreadCount
    || Number(existing.telegram_folder_id || 0) !== folderId
    || Number(existing.is_muted || 0) !== (foreverMuted ? 1 : 0)
    || Number(existing.mute_until || 0) !== muteUntilMs
    || String(existing.telegram_membership_state || '') !== membership.state
    || Number(existing.is_in_others || 0) !== isInOthers
    || Number(existing.telegram_can_send ?? 1) !== (capability.canSend ? 1 : 0);
  db.run(
    `INSERT INTO contacts
       (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, channel,
        is_muted, mute_until, telegram_folder_id, telegram_archived, telegram_can_send,
        telegram_send_reason, telegram_peer_type, telegram_members_count, telegram_online_count, telegram_state_updated_at,
        telegram_membership_state, telegram_join_action, is_in_others, is_cov_bot, last_message, last_message_time, has_main_app)
     VALUES (?, ?, ?, '', 0, ?, ?, 'telegram_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
       has_main_app = CASE WHEN excluded.has_main_app IS NOT NULL THEN excluded.has_main_app ELSE contacts.has_main_app END,
       -- Only a newer top message moves the row; one without a preview (unsupported service message) keeps the old text
       last_message = CASE WHEN excluded.last_message_time > COALESCE(contacts.last_message_time, 0) AND excluded.last_message != ''
         THEN excluded.last_message ELSE contacts.last_message END,
       last_message_time = CASE WHEN excluded.last_message_time > COALESCE(contacts.last_message_time, 0)
         THEN excluded.last_message_time ELSE contacts.last_message_time END,
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
      isInOthers, isBot, top?.preview ?? '', top?.timestamp ?? 0, hasMainApp],
  );
  if (readOutboxMaxId > (Number(existing?.peer_read_max_id) || 0)) {
    recordPeerReceipt(accountId, chatId, {
      readMaxId: readOutboxMaxId,
      readTs: messageTimestampById(accountId, chatId, [String(readOutboxMaxId)], 'telegram_user'),
    });
  }
  // Saved Messages (self-chat) → auto pin local
  if (isSelfChat) {
    db.run(
      `INSERT OR IGNORE INTO local_pinned_conversations (owner_zalo_id, thread_id, pinned_at) VALUES (?, ?, ?)`,
      [accountId, chatId, Date.now()],
    );
  }
  // Emit event to trigger renderer cache refresh (othersConversations, mutedThreads).
  // The module has only a default export: the former
  // require('../event/EventBroadcaster').EventBroadcaster was undefined, so this
  // refresh threw inside a swallowed try/catch and never reached the renderer.
  if (emitRefresh && changed) {
    try {
      EventBroadcaster.emit('db:unreadChanged', {
        zaloId: accountId,
        source: 'telegram_dialog_state',
      });
    } catch {}
  }
  return changed;
}

/**
 * Rebuild the membership cache from Telegram's dialog list without fetching
 * any message history. Socket Channel entities can be minimal/stale, whereas
 * a dialog entity carries the account's actual `left` state. The final pass
 * moves old `-100…` peers not present in either main or Archived dialogs out
 * of the normal inbox, which also repairs rows admitted by older builds.
 */
async function reconcileTelegramDialogMembership(
  accountId: string,
  client: TelegramClient,
): Promise<void> {
  if (membershipReconciledAccounts.has(accountId)) return;
  const existingTask = membershipReconciliations.get(accountId);
  if (existingTask) return existingTask;
  const task = (async () => {
    const db = DatabaseService.getInstance();
    if (!db) return;

    Logger.log(`[TelegramUserListener] Starting membership reconciliation for ${accountId}`);

    const mainDialogs = await client.getDialogs({ limit: MEMBERSHIP_RECONCILE_DIALOG_LIMIT });
    const archivedDialogs = await client.getDialogs({ limit: MEMBERSHIP_RECONCILE_DIALOG_LIMIT, folder: 1 });
    // TG-03: `getDialogs` caps at MEMBERSHIP_RECONCILE_DIALOG_LIMIT per call.
    // Absence from a truncated snapshot only means "not in this page", not
    // "the account left the channel". Demotion requires a complete snapshot
    // (or, later, an explicit member/left/forbidden signal).
    const snapshotLegComplete = (list: any[]): boolean => {
      const total = Number((list as any)?.total ?? list.length);
      return list.length < MEMBERSHIP_RECONCILE_DIALOG_LIMIT && total <= list.length;
    };
    const snapshotComplete = snapshotLegComplete(mainDialogs) && snapshotLegComplete(archivedDialogs);

    // Private chats and basic groups need no membership pass, but this full dialog list is the one place that reaches the ones
    // past the history sync's recent dialogs. A row already on this machine takes its dialog when it has no last-message time
    // (a person saved from a group who also has a private chat, older builds) or is a bot (main Mini App flag → "Open" in the
    // conversation list). No new rows are created for them.
    const privateRows = new Map<string, number>(db.query<{ contact_id: string; t: number }>(
      `SELECT contact_id, COALESCE(last_message_time, 0) AS t FROM contacts
       WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND contact_id NOT LIKE '-100%'`,
      [accountId],
    ).map(row => [String(row.contact_id), Number(row.t) || 0]));
    const seen = new Set<string>();
    for (const dialog of [...mainDialogs, ...archivedDialogs]) {
      const chatId = getCanonicalChatId(dialog.id);
      if (!chatId) continue;
      if (!chatId.startsWith('-100')) {
        const storedTime = privateRows.get(chatId);
        if (storedTime !== undefined && (storedTime === 0 || (dialog.entity as any)?.bot)) {
          privateRows.delete(chatId);
          if (dialog.entity) cacheTelegramPeer(accountId, chatId, dialog.entity);
          persistTelegramDialogState(accountId, chatId, dialog, dialog.entity, undefined, false);
        }
        continue;
      }
      if (seen.has(chatId)) continue;
      seen.add(chatId);
      if (dialog.entity) cacheTelegramPeer(accountId, chatId, dialog.entity);
      persistTelegramDialogState(accountId, chatId, dialog, dialog.entity, undefined, false);
    }

    if (!snapshotComplete) {
      Logger.warn(
        `[TelegramUserListener] Membership snapshot truncated for ${accountId} `
        + `(main ${mainDialogs.length}/${(mainDialogs as any)?.total ?? '?'}, `
        + `archive ${archivedDialogs.length}/${(archivedDialogs as any)?.total ?? '?'}); `
        + 'keeping existing member states instead of demoting from a partial view',
      );
      membershipReconciledAccounts.add(accountId);
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_membership_reconcile' });
      return;
    }

    // `getDialogs` contains every peer the account currently belongs to,
    // including archived peers. A normal-inbox channel absent from that
    // complete snapshot is an old/unjoined row and must not remain eligible
    // for live ingest or occupy the All tab.
    const memberRows = db.query<{ contact_id: string }>(
      `SELECT contact_id FROM contacts
       WHERE owner_zalo_id = ? AND channel = 'telegram_user'
         AND contact_id LIKE '-100%' AND telegram_membership_state = 'member'`,
      [accountId],
    );
    const staleIds = memberRows
      .map(row => String(row.contact_id || ''))
      .filter(chatId => !!chatId && !seen.has(chatId));
    const now = Date.now();
    for (let index = 0; index < staleIds.length; index += 400) {
      const chunk = staleIds.slice(index, index + 400);
      const placeholders = chunk.map(() => '?').join(',');
      db.run(
        `UPDATE contacts
         SET telegram_membership_state = 'left', telegram_join_action = 'none',
             telegram_can_send = 0, telegram_send_reason = ?, is_in_others = 1,
             telegram_state_updated_at = ?
         WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND contact_id IN (${placeholders})`,
        ['Bạn chưa tham gia cuộc trò chuyện này', now, accountId, ...chunk],
      );
    }
    membershipReconciledAccounts.add(accountId);
    Logger.log(`[TelegramUserListener] Membership reconciled: ${seen.size} dialogs, ${staleIds.length} stale channels for ${accountId}`);
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_membership_reconcile' });
  })().catch((err: any) => {
    Logger.warn(`[TelegramUserListener] Membership reconciliation failed for ${accountId}: ${err.message}`);
    throw err;
  }).finally(() => {
    membershipReconciliations.delete(accountId);
  });
  membershipReconciliations.set(accountId, task);
  return task;
}

function getTelegramUserStatus(user: any): { status: string; statusText: string; lastSeenAt?: number; onlineUntil?: number } {
  const status = user?.status;
  const className = String(status?.className || '');
  const now = Math.floor(Date.now() / 1000);
  if (className === 'UserStatusOnline' && Number(status?.expires || 0) > now) {
    return { status: className, statusText: 'Đang online', onlineUntil: Number(status.expires) };
  }
  if (className === 'UserStatusOffline') {
    return { status: className, statusText: tr('Đã offline'), lastSeenAt: Number(status?.wasOnline || 0) || undefined };
  }
  if (className === 'UserStatusRecently') return { status: className, statusText: tr('Hoạt động gần đây') };
  if (className === 'UserStatusLastWeek') return { status: className, statusText: tr('Hoạt động trong tuần qua') };
  if (className === 'UserStatusLastMonth') return { status: className, statusText: tr('Hoạt động trong tháng qua') };
  return { status: className, statusText: '' };
}

/**
 * Discussion groups I have NOT joined but can comment in (Telegram allows commenting without joining): a comment sent does not add the group
 * to the conversation list, same as Telegram. Updated each time the comments section is opened (getPostDiscussion).
 */
const commentOnlyGroups = new Set<string>();

function isCommentOnlyGroup(accountId: string, chatId: string): boolean {
  return commentOnlyGroups.has(`${accountId}:${chatId}`);
}

/** A comment-only group not yet in the conversation list → no conversation is created for it (if one exists, it is updated as usual). */
function skipCommentOnlyConversation(db: DatabaseService, accountId: string, chatId: string): boolean {
  return isCommentOnlyGroup(accountId, chatId)
    && !db.queryOne(`SELECT 1 FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`, [accountId, chatId]);
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

/**
 * Name of the quoted message's sender (fromD in quote_data; the quote box shows the name, like Telegram):
 * group member → known peer → contact → the account itself. No network call; '' if none.
 */
function resolveTelegramQuoteSenderName(
  db: { queryOne<T = any>(sql: string, params?: any[]): T | undefined } | null | undefined,
  accountId: string,
  chatId: string,
  senderId?: string | null,
): string {
  const id = String(senderId || '');
  if (!db || !id) return '';
  try {
    const member = db.queryOne<any>(
      `SELECT display_name FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
      [accountId, chatId, id],
    );
    if (member?.display_name) return String(member.display_name);
    const peer = db.queryOne<any>(
      `SELECT display_name FROM telegram_peers WHERE owner_zalo_id = ? AND peer_id = ?`,
      [accountId, id],
    );
    if (peer?.display_name) return String(peer.display_name);
    const contact = db.queryOne<any>(
      `SELECT display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
      [accountId, id],
    );
    if (contact?.display_name && contact.display_name !== id) return String(contact.display_name);
    if (id === accountId) {
      const self = db.queryOne<any>(`SELECT full_name FROM accounts WHERE zalo_id = ?`, [accountId]);
      return String(self?.full_name || '');
    }
  } catch {}
  return '';
}

/** quote_data of my sent message when it is a reply: same shape as received messages (sender name + preview image of the original message). */
function sentReplyQuoteData(accountId: string, chatId: string, replyToMsgId?: string | null): string | null {
  if (!replyToMsgId) return null;
  const quoteDb = DatabaseService.getInstance();
  const dbQuote = quoteDb?.queryOne<any>(
    `SELECT content, msg_type, sender_id, attachments, local_paths FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [replyToMsgId, accountId, chatId]
  );
  if (!dbQuote) return JSON.stringify({ msgId: replyToMsgId, msg: '', senderId: '', msgType: 'text' });
  return buildTelegramQuoteData({
    msgId: replyToMsgId,
    content: dbQuote.content,
    msgType: dbQuote.msg_type,
    senderId: dbQuote.sender_id,
    senderName: resolveTelegramQuoteSenderName(quoteDb, accountId, chatId, dbQuote.sender_id),
    attachments: dbQuote.attachments,
    localPaths: dbQuote.local_paths,
  });
}

type TelegramSendMention = { uid: string; pos: number; len: number; text?: string };

/**
 * Position of the mention name in the text actually sent. The compose box computes positions on the text before leading spaces / hidden
 * U+200B characters are removed, so if they differ, search again by label (@name) nearest the old position; outside the text range, drop it
 * (Telegram rejects the whole message: ENTITY_BOUNDS_INVALID).
 */
function anchorTelegramMentions(text: string, mentions?: TelegramSendMention[]): TelegramSendMention[] {
  const anchored: TelegramSendMention[] = [];
  for (const mention of mentions || []) {
    const len = Math.max(0, Number(mention?.len || 0));
    let pos = Math.max(0, Number(mention?.pos || 0));
    const label = typeof mention?.text === 'string' ? mention.text : '';
    if (label && label.length === len && text.substr(pos, len) !== label) {
      let nearest = -1;
      for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
        if (nearest < 0 || Math.abs(at - pos) < Math.abs(nearest - pos)) nearest = at;
      }
      if (nearest < 0) continue;
      pos = nearest;
    }
    if (!mention?.uid || len === 0 || pos + len > text.length) continue;
    anchored.push({ uid: String(mention.uid), pos, len });
  }
  return anchored;
}

/**
 * @mention name picked in the compose box → InputMessageEntityMentionName. user_id must be an InputUser (InputPeerUser is the wrong TL type:
 * GramJS does not convert a nested field inside an entity by itself). People who cannot be resolved are skipped.
 */
async function telegramMentionEntities(accountId: string, client: any, mentions?: TelegramSendMention[]): Promise<any[]> {
  const entities: any[] = [];
  if (!mentions?.length) return entities;
  const { Api } = require('telegram');
  const { getInputUser } = require('telegram/Utils');
  for (const m of mentions) {
    if (!m.uid) continue;
    try {
      const entity = await resolveInputPeer(accountId, client, m.uid);
      if (entity) {
        entities.push(new Api.InputMessageEntityMentionName({
          offset: m.pos,
          length: m.len,
          userId: getInputUser(entity),
        }));
      }
    } catch {}
  }
  return entities;
}

/** Telegram rejects the whole message because of a name mention (the person is no longer valid / wrong position) → send again without the mention. */
function isTelegramMentionEntityError(err: any): boolean {
  return /ENTITY_MENTION_USER_INVALID|ENTITY_BOUNDS_INVALID/.test(String(err?.errorMessage || err?.message || ''));
}

/** Name mention saved with the sent message (the UI highlights the name like a received message). */
function telegramMentionAttachments(mentions: TelegramSendMention[] | undefined, text: string): any[] {
  return (mentions || [])
    .map((mention) => ({
      type: 'telegram_mention',
      offset: Math.max(0, Number(mention.pos || 0)),
      length: Math.max(0, Number(mention.len || 0)),
      user_id: String(mention.uid || ''),
    }))
    .filter((mention) => mention.user_id && mention.length > 0 && mention.offset + mention.length <= text.length);
}

function hasUsableTelegramQuoteData(value?: string | null): boolean {
  if (!value) return false;
  try {
    const quote = JSON.parse(value);
    const msgType = String(quote?.msgType || 'text');
    // MTProto does not provide a durable CDN URL for photos. A media quote is
    // usable only after we have a local preview; otherwise repair it instead
    // of rendering the misleading "[Hình ảnh]" (Image) fallback.
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

type NormalizedTelegramReactions = {
  total: number;
  lastReact: string;
  emoji: Record<string, { total: number; users: Record<string, number> }>;
};

/** Convert the aggregate MTProto reaction payload into Deplao's display model.
 * Telegram only provides identities for a recent subset of reactors, so counts
 * remain authoritative while the users map contains only identities Telegram
 * actually returned (including the current account when marked as my).
 * The account's own reaction comes from `chosen_order` (also present in channels,
 * where recent reactors are hidden) or a `my` recent reaction. A `min` payload is
 * shared by every user and omits the own reaction: `previous` (stored value) then
 * keeps the own reaction that is already known, like Telegram Desktop does. */
function normalizeTelegramReactions(reactions: any, accountId: string, previous?: NormalizedTelegramReactions | null): NormalizedTelegramReactions {
  const normalized: NormalizedTelegramReactions = { total: 0, lastReact: '', emoji: {} };
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
    if (result?.chosenOrder != null || result?.chosen) normalized.emoji[emoji].users[accountId] = 1;
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

  if (reactions?.min && previous?.emoji) {
    for (const [emoji, entry] of Object.entries(normalized.emoji)) {
      if (previous.emoji[emoji]?.users?.[accountId]) entry.users[accountId] = 1;
    }
  }

  return normalized;
}

function parseStoredTelegramReactions(raw: unknown): NormalizedTelegramReactions | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.emoji && typeof parsed.emoji === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Same counts and same known reactors per emoji (lastReact / key order ignored). */
function sameTelegramReactions(stored: NormalizedTelegramReactions | null, next: NormalizedTelegramReactions): boolean {
  const before = Object.entries(stored?.emoji || {}).filter(([, entry]) => Number(entry?.total || 0) > 0);
  if (before.length !== Object.keys(next.emoji).length) return false;
  return before.every(([emoji, entry]) => {
    const after = next.emoji[emoji];
    if (!after || Number(entry.total) !== after.total) return false;
    const users = (value: Record<string, number> | undefined) => Object.keys(value || {}).sort().join(',');
    return users(entry.users) === users(after.users);
  });
}

/** Content stored for a Telegram message (caption, poll question, dice…; audio without caption → placeholder). */
function telegramDisplayContent(content: string, msgType: string): string {
  return content || (msgType === 'audio' ? '🎵 Audio' : '');
}

/**
 * Saves and emits the combined reactions of 1 Telegram message: REPLACES them (no adding up), for the right conversation + channel.
 * Sources: UpdateMessageReactions pushed back (Telegram only pushes it to the message author), UpdateEditMessage "ẩn" (hidden edit: private chat / normal group, where a reaction change arrives as a message edit carrying all current reactions), the result of SendReaction, and
 * GetMessagesReactions (poll). Writes to the DB and emits the event only when the reactions actually change (`force`: always emit; the SendReaction result
 * replaces the temporary copy in the renderer).
 */
function applyTelegramMessageReactions(
  accountId: string,
  client: any,
  chatId: string,
  msgId: string,
  rawReactions: any,
  topicRootMessageId?: string,
  force = false,
): boolean {
  if (!chatId || !msgId) return false;
  const db = DatabaseService.getInstance();
  const row = db?.queryOne<{ reactions: string | null }>(
    `SELECT reactions FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [msgId, accountId, chatId],
  );
  // Message not yet in the DB: the next history load brings its reactions along (persistTelegramMessage overwrites reactions)
  if (!row && !force) return false;
  const previous = parseStoredTelegramReactions(row?.reactions);
  const reactions = normalizeTelegramReactions(rawReactions, accountId, previous);
  if (!force && sameTelegramReactions(previous, reactions)) return false;
  for (const recent of rawReactions?.recentReactions || []) {
    const reactorId = getCanonicalChatId(recent?.peerId);
    if (reactorId && !reactorId.startsWith('-') && reactorId !== accountId) {
      hydrateTelegramIdentity(accountId, client, reactorId, chatId).catch(() => {});
    }
  }
  if (row) {
    db.run(
      `UPDATE messages SET reactions = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [JSON.stringify(reactions), msgId, accountId, chatId],
    );
  }
  EventBroadcaster.emit('event:telegramReaction', {
    zaloId: accountId,
    threadId: chatId,
    msgId,
    topicRootMessageId,
    reactions,
  });
  return true;
}

function applyTelegramReactionUpdate(accountId: string, client: any, update: any, force = false): boolean {
  return applyTelegramMessageReactions(
    accountId, client, getCanonicalChatId(update?.peer), String(update?.msgId || ''), update?.reactions,
    update?.topMsgId ? String(update.topMsgId) : undefined, force,
  );
}

/** Applies all UpdateMessageReactions in an RPC result (GramJS does not feed RPC results into the update stream). Returns the number of messages changed. */
function applyTelegramReactionResult(accountId: string, client: any, result: any, force = false): number {
  const { Api } = require('telegram');
  let applied = 0;
  for (const update of result?.updates || []) {
    if (update instanceof Api.UpdateMessageReactions && applyTelegramReactionUpdate(accountId, client, update, force)) {
      applied++;
    }
  }
  return applied;
}

/**
 * UpdateEditMessage / UpdateEditChannelMessage.
 * 1) Reactions: in private chats / normal groups Telegram does NOT send UpdateMessageReactions; a reaction change arrives as a hidden
 *    message edit ("editHide") carrying all current reactions of the message (no reactions field = all removed), so always apply it.
 * 2) Content: computed the same way as when the message was saved (caption / poll question / 🎲 / "🎵 Audio"…) before comparing. A reaction change does not change
 *    the content; comparing directly with msg.message used to clear the content of poll / audio / dice messages and wrongly mark them as "edited".
 *    editHide (e.g. a bot updating its answer bit by bit): content changes but is not marked as edited, and no edit history is kept.
 */
function applyTelegramMessageEdit(accountId: string, client: any, msg: any): void {
  if (!msg || msg.className === 'MessageEmpty' || msg.id == null || !msg.peerId) return;
  const msgId = String(msg.id);
  const chatId = getCanonicalChatId(msg.peerId);
  const db = DatabaseService.getInstance();
  if (!chatId || !db) return;

  applyTelegramMessageReactions(accountId, client, chatId, msgId, msg.reactions, getForumTopicId(msg) || undefined);
  // Poll edited (closed, options added…): the text does not change, so the part below is skipped → update the poll here
  if (msg.media?.className === 'MessageMediaPoll') {
    applyTelegramPollUpdate(accountId, chatId, msgId, { poll: msg.media.poll, results: msg.media.results });
  }

  const existingMsg = db.queryOne<any>(
    `SELECT content, edit_history, is_edited FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [msgId, accountId, chatId],
  );
  if (!existingMsg) return;
  const peerType = db.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
  const normalized = normalizeTelegramMessageMedia(msg, peerType);
  const newText = telegramDisplayContent(normalized.content, normalized.msgType);
  const storedText = String(existingMsg.content || '');
  // Some save paths (history load) do not use the "🎵 Audio" placeholder → treat both forms as "không đổi" (unchanged)
  if (storedText === newText || storedText === normalized.content) return;

  const hidden = !!msg.editHide;
  let editHistory: any[] = [];
  if (existingMsg.edit_history) {
    try { editHistory = JSON.parse(existingMsg.edit_history); } catch { editHistory = []; }
  }
  if (!hidden && storedText) {
    editHistory.push({ oldBody: storedText, editedAt: Date.now(), editCount: editHistory.length + 1 });
  }
  db.run(
    `UPDATE messages SET content = ?, is_edited = ?, edit_history = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [newText, hidden ? (existingMsg.is_edited ? 1 : 0) : 1, JSON.stringify(editHistory), msgId, accountId, chatId],
  );
  EventBroadcaster.emit('event:messageEdited', { zaloId: accountId, msgId, newText, threadId: chatId, hidden });
  Logger.log(`[TelegramUserListener] Message edited: ${msgId}${hidden ? ' (hidden)' : ''}`);
}

/**
 * Long rich-format messages: Telegram sends only part of them (`richMessage.part`). Get the full text with messages.getRichMessage
 * (once per message, one account at a time), save the full text and update the bubble like a hidden edit (without the "đã chỉnh sửa" (edited) label).
 */
const richMessageCompletions = new Set<string>();
const richMessageCompletionQueues = new Map<string, Promise<void>>();

/** After saving a message: a rich-format message gets its full text (part) + the images in it are downloaded (automatically, like normal images). */
function handleRichMessageExtras(accountId: string, client: TelegramClient | null | undefined, chatId: string, message: any): void {
  if (!client || !message?.richMessage || !chatId) return;
  completeRichMessage(accountId, client, chatId, message);
  const messageId = String(message?.id || '');
  if (messageId && !message.richMessage.part) {
    downloadRichMessageMedia(accountId, client, message, messageId, chatId).catch(() => {});
  }
}

function completeRichMessage(accountId: string, client: TelegramClient | null | undefined, chatId: string, message: any): void {
  if (!client || !message?.richMessage?.part) return;
  const messageId = String(message?.id || '');
  if (!messageId || !chatId) return;
  const key = `${accountId}:${chatId}:${messageId}`;
  if (richMessageCompletions.has(key)) return;
  richMessageCompletions.add(key);
  const previous = richMessageCompletionQueues.get(accountId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => fetchFullRichMessage(accountId, client, chatId, messageId));
  let settled!: Promise<void>;
  settled = task.catch(() => {}).finally(() => {
    if (richMessageCompletionQueues.get(accountId) === settled) richMessageCompletionQueues.delete(accountId);
  });
  richMessageCompletionQueues.set(accountId, settled);
}

async function fetchFullRichMessage(accountId: string, client: TelegramClient, chatId: string, messageId: string): Promise<void> {
  const { Api } = require('telegram');
  const GetRichMessage = (Api as any).messages?.GetRichMessage;
  if (!GetRichMessage) return;
  try {
    const peer = await resolveInputPeer(accountId, client, chatId);
    const result: any = await client.invoke(new GetRichMessage({ peer, id: Number(messageId) }));
    const full = (result?.messages || []).find((item: any) => String(item?.id || '') === messageId);
    const db = DatabaseService.getInstance();
    if (!full?.richMessage || !db) return;
    const peerType = db.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const normalized = normalizeTelegramMessageMedia(full, peerType);
    if (!normalized.content.trim()) return;
    db.run(
      `UPDATE messages SET content = ?, attachments = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [normalized.content, JSON.stringify(normalized.attachments), messageId, accountId, chatId],
    );
    EventBroadcaster.emit('event:messagesRepaired', {
      zaloId: accountId, threadId: chatId,
      items: [{ msgId: messageId, content: normalized.content, msgType: normalized.msgType, attachments: normalized.attachments }],
    });
    downloadRichMessageMedia(accountId, client, full, messageId, chatId).catch(() => {});
    tgLog('info', accountId, 'history', 'RICH_MESSAGE_COMPLETED', { chatId, messageId, chars: normalized.content.length });
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'RICH_MESSAGE_FETCH_FAILED', { chatId, messageId, error: err?.message || String(err) });
  }
}

/**
 * Images (automatic) / videos / files (on click) inside a rich-format message: richMessage.photos / documents, blocks pointing to them
 * by id. Downloaded through the account's download queue, saved as local_paths["rich_<id>"] (merged with the existing paths) → event:localPath.
 */
async function downloadRichMessageMedia(
  accountId: string,
  client: TelegramClient,
  message: any,
  messageId: string,
  threadId: string,
  opts: { mediaIds?: string[]; urgency?: TelegramDownloadUrgency } = {},
): Promise<Record<string, string>> {
  const rich = message?.richMessage;
  const db = DatabaseService.getInstance();
  if (!rich || !db) return {};
  const refs = richMediaRefs(richMessageToBlocks(rich));
  const wanted = opts.mediaIds?.length
    ? refs.filter(ref => opts.mediaIds!.includes(ref.id))
    : refs.filter(ref => ref.kind === 'photo');
  if (!wanted.length) return {};
  const readPaths = (): Record<string, string> => {
    const row = db.queryOne<any>(
      `SELECT local_paths FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [messageId, accountId, threadId],
    );
    try { return JSON.parse(row?.local_paths || '{}') || {}; } catch { return {}; }
  };
  const existing = readPaths();
  const byId = new Map<string, any>();
  for (const photo of rich.photos || []) byId.set(String(photo?.id?.toString?.() ?? photo?.id ?? ''), photo);
  for (const document of rich.documents || []) byId.set(String(document?.id?.toString?.() ?? document?.id ?? ''), document);
  let changed = false;
  for (const ref of wanted) {
    const key = `rich_${ref.id}`;
    const target = byId.get(ref.id);
    if (existing[key] || !target) continue;
    const localPath = await queueTelegramDownload(
      accountId,
      `rich:${threadId}:${messageId}:${ref.id}`,
      async () => {
        const data = await client.downloadMedia(target);
        if (!data || !data.length) return null;
        const buffer = Buffer.from(data as any);
        if (ref.kind === 'photo' && !isImageBuffer(buffer)) return null;
        const ext = ref.kind === 'photo' ? '.jpg' : ref.kind === 'video' ? '.mp4' : ref.kind === 'audio' ? '.mp3' : '';
        return saveMediaToDisk(buffer, `${accountId}_${threadId}_${messageId}_rich_${ref.id}${ext}`, ref.kind === 'photo' ? 'photo' : ref.kind === 'video' ? 'video' : 'file');
      },
      { threadId, urgency: opts.urgency, sortKey: telegramMessageTimeMs(message) },
    ).catch(() => null);
    if (!localPath) continue;
    // Re-read before merging: other downloads of the same message may have just written
    const merged = { ...readPaths(), [key]: localPath };
    db.run(
      `UPDATE messages SET local_paths = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [JSON.stringify(merged), messageId, accountId, threadId],
    );
    existing[key] = localPath;
    changed = true;
    EventBroadcaster.emit('event:localPath', { zaloId: accountId, msgId: messageId, threadId, localPaths: merged });
  }
  return changed ? readPaths() : existing;
}

/** UI request for the images / videos of a rich-format message (an image not there yet after reopening the app, click to download a video). */
export async function downloadRichMedia(
  accountId: string,
  chatId: string,
  messageId: string,
  mediaId?: string,
): Promise<{ success: boolean; localPaths?: Record<string, string>; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram listener is not connected' };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const fetched = await listener.client.getMessages(peer, { ids: [Number(messageId)] });
    // richMessage exists only in the new schema layer (the original GramJS type does not know it) → any
    const message: any = (fetched || []).find((item: any) => String(item?.id || '') === String(messageId));
    if (!message?.richMessage) return { success: false, error: 'Telegram message was not found' };
    const localPaths = await downloadRichMessageMedia(accountId, listener.client, message, String(messageId), chatId, {
      mediaIds: mediaId ? [String(mediaId)] : undefined,
      urgency: mediaId ? 'urgent' : 'visible',
    });
    return { success: true, localPaths };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
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

  // The sticker set containing it: clicking a sticker in the chat opens the set popup (view / add to the account), like Telegram
  const stickerSet = stickerSetRefOf(stickerAttribute.stickerset);
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
    ...(stickerSet?.id ? { set_id: stickerSet.id, set_access_hash: stickerSet.accessHash || '' } : {}),
    ...(stickerSet?.shortName ? { set_short_name: stickerSet.shortName } : {}),
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
    // Latest comment / last one I read → show the "chưa đọc" (unread) dot on the comment bar, like Telegram
    comments_max_id: Math.max(0, Number(replies?.maxId || 0)),
    comments_read_max_id: Math.max(0, Number(replies?.readMaxId || 0)),
    grouped_id: message?.groupedId != null ? String(message.groupedId) : '',
  };
}

/** My message just posted to a channel → a "Bài đăng kênh" (Channel post) card (like a received message via socket / history). */
function sentChannelPostAttachment(accountId: string, chatId: string, sent: any): Record<string, any> | null {
  if (!String(chatId).startsWith('-100')) return null;
  const peerType = DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
  if (sent?.post !== true && peerType !== 'channel') return null;
  return getTelegramPostAttachment(sent || {}, 'channel');
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

/** Read the last server-issued Telegram message ID for a dialog. Some legacy
 * optimistic rows used Date.now() as msg_id; they remain valid local rows but
 * are not legal MTProto message IDs and must be excluded from history cursors.
 * Reads the 200 newest messages instead of scanning the whole channel: the dialog watch calls this function for up to
 * 100 channels per pass (telegramTopMessage.ts). */
function getTelegramHistoryCheckpoint(db: DatabaseService, accountId: string, chatId: string): number {
  const recovery = db.queryOne<{ history_start_msg_id: number | null }>(
    `SELECT history_start_msg_id FROM telegram_channel_recovery_queue
     WHERE owner_zalo_id = ? AND channel_id = ? AND status IN ('pending', 'draining')`,
    [accountId, chatId],
  );
  if (recovery?.history_start_msg_id != null) return Number(recovery.history_start_msg_id);
  const checkpoint = db.queryOne<{ lastMessageId?: number }>(
    `SELECT ${TELEGRAM_TOP_MESSAGE_ID_SQL} AS lastMessageId`,
    telegramTopMessageIdParams(accountId, chatId),
  );
  const messageId = Number(checkpoint?.lastMessageId || 0);
  return Number.isSafeInteger(messageId) && messageId > 0 && messageId <= MAX_TELEGRAM_MESSAGE_ID
    ? messageId
    : 0;
}

/** Keep native mention ranges so the renderer never has to guess from a raw @. */
function getTelegramMentionAttachments(message: any): Record<string, any>[] {
  const text = String(message?.message || message?.text || '');
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
      const offset = Math.max(0, Number(entity?.offset || 0));
      const length = Math.max(0, Number(entity?.length || 0));
      // A MessageEntityMention is an @username token and deliberately has no
      // userId. Preserve that token so the renderer can resolve it on click.
      const username = entity?.className === 'MessageEntityMention'
        ? text.slice(offset, offset + length).replace(/^@/, '')
        : '';
      return {
        type: 'telegram_mention',
        offset,
        length,
        user_id: userId,
        username,
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
  /** Telegram rich-format messages send only part of the text: get the full text with completeRichMessage. */
  richPart?: boolean;
} {
  // Call (MessageService · messageActionPhoneCall) → a call card like Zalo (CallBubble) on every save path:
  // socket, history, load more. Previously skipped because it had no text.
  if (message?.action?.className === 'MessageActionPhoneCall') {
    return { content: telegramCallCardContent(telegramCallInfoOf(message)), msgType: 'chat.recommended', attachments: [] };
  }
  // Other system messages (channel / group created, photo changed, pinned…) → a notice line. Previously, channel messages were tagged as "Bài đăng kênh"
  // (peerType = channel), so "Channel created" became an empty post. Unsupported actions → '' (skipped).
  if (message?.className === 'MessageService') {
    const text = describeTelegramServiceAction(message);
    return { content: text, msgType: text ? 'system' : 'text', attachments: [] };
  }
  const attachments: Record<string, any>[] = [];
  const postAttachment = getTelegramPostAttachment(message, peerType);
  if (postAttachment) attachments.push(postAttachment);
  const groupedMediaAttachment = getTelegramGroupedMediaAttachment(message);
  if (groupedMediaAttachment) attachments.push(groupedMediaAttachment);
  attachments.push(...getTelegramCustomEmojiAttachments(message));
  attachments.push(...getTelegramMentionAttachments(message));
  // "Chuyển tiếp từ …" (Forwarded from …) (fwdFrom): previously skipped, so a forwarded message looked like one the sender typed themselves
  const forwardAttachment = getTelegramForwardAttachment(message);
  if (forwardAttachment) attachments.push(forwardAttachment);

  let content = String(message?.message || message?.text || '');
  // Rich-format message (layer 23x): the content is blocks of headings / paragraphs / lists… in message.richMessage, the
  // text part is left empty: the old layer receives an empty "messageMediaUnsupported" ("Loại tin nhắn Telegram chưa được hỗ trợ" (Telegram message type not supported yet))
  const rich = richMessageToText((message as any)?.richMessage);
  if (rich?.text) content = rich.text;
  // Blocks drawn like Telegram (real images, headings, lists, tables…); content keeps plain text for preview / search
  const richBlocks = rich ? richMessageToBlocks((message as any).richMessage) : null;
  if (richBlocks?.length) attachments.push({ type: 'rich_message', blocks: richBlocks, ...(rich?.part ? { part: true } : {}) });
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
      // GramJS message.photo falls back to the link preview's photo: source 'webpage' + page name / title / description
      // (card like Telegram; hidden if the preview fails). `page_url`, never `url`: the renderer reads attachments[].url as the image source.
      ...telegramWebpageMeta(media),
    });
  } else if (sticker) {
    msgType = 'sticker';
    attachments.push(sticker);
  } else if (message?.videoNote) {
    msgType = 'video_note';
    const videoNote = message.videoNote as any;
    attachments.push({
      type: 'video_note', id: String(videoNote?.id || ''), dc_id: videoNote?.dcId,
      access_hash: String(videoNote?.accessHash || ''), file_size: videoNote?.size || 0,
      ...telegramVideoAttributes(videoNote),
      stripped_thumb: telegramStrippedThumb(videoNote) || undefined,
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
      access_hash: String(gif?.accessHash || ''), file_size: gif?.size || 0,
      mime_type: gif?.mimeType || '',
      ...telegramVideoAttributes(gif),
      stripped_thumb: telegramStrippedThumb(gif) || undefined,
      ...telegramWebpageMeta(media),
    });
  } else if (message?.video) {
    msgType = 'video';
    const video = message.video as any;
    attachments.push({
      type: 'video', id: String(video?.id || ''), dc_id: video?.dcId,
      access_hash: String(video?.accessHash || ''), file_size: video?.size || 0,
      mime_type: video?.mimeType || '',
      ...telegramVideoAttributes(video),
      stripped_thumb: telegramStrippedThumb(video) || undefined,
      // Link preview with video only (e.g. fxTikTok): page name / title / description card wrapping the video
      ...telegramWebpageMeta(media),
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
      ...telegramWebpageMeta(media),
    });
  } else if (mediaClass === 'MessageMediaWebPage') {
    const webpage = media?.webpage || {};
    msgType = 'telegram.webpage';
    content ||= String(webpage?.title || webpage?.description || webpage?.url || tr('Liên kết'));
    attachments.push({
      type: 'webpage', url: webpage?.url || '', display_url: webpage?.displayUrl || '',
      site_name: webpage?.siteName || '', title: webpage?.title || '',
      description: webpage?.description || '', author: webpage?.author || '',
    });
  } else if (mediaClass === 'MessageMediaContact') {
    msgType = 'telegram.contact';
    const displayName = [media?.firstName, media?.lastName].filter(Boolean).join(' ').trim();
    content ||= displayName || media?.phoneNumber || tr('Liên hệ');
    attachments.push({
      type: 'contact', user_id: String(media?.userId || ''), name: displayName,
      phone: media?.phoneNumber || '', vcard: media?.vcard || '',
    });
  } else if (mediaClass === 'MessageMediaGeo' || mediaClass === 'MessageMediaGeoLive' || mediaClass === 'MessageMediaVenue') {
    const geo = media?.geo || {};
    msgType = mediaClass === 'MessageMediaVenue' ? 'telegram.venue' : 'telegram.location';
    content ||= mediaClass === 'MessageMediaVenue'
      ? [media?.title, media?.address].filter(Boolean).join(' — ') || tr('Địa điểm')
      : mediaClass === 'MessageMediaGeoLive' ? tr('Vị trí trực tiếp') : tr('Vị trí');
    attachments.push({
      type: mediaClass === 'MessageMediaVenue' ? 'venue' : 'location',
      latitude: Number(geo?.lat || 0), longitude: Number(geo?.long || 0),
      title: media?.title || '', address: media?.address || '',
      live: mediaClass === 'MessageMediaGeoLive', period: Number(media?.period || 0),
    });
  } else if (mediaClass === 'MessageMediaPoll') {
    // Result when the message arrives; later updated via UpdateMessagePoll / refreshPollResults (messages/telegramPolls.ts)
    const pollAttachment = telegramPollAttachment(media?.poll || {}, media?.results);
    msgType = 'telegram.poll';
    content ||= pollAttachment.question;
    attachments.push(pollAttachment);
  } else if (mediaClass === 'MessageMediaDice') {
    msgType = 'telegram.dice';
    content ||= `${media?.emoticon || '🎲'} ${Number(media?.value || 0)}`;
    attachments.push({ type: 'dice', emoticon: media?.emoticon || '🎲', value: Number(media?.value || 0) });
  } else if (mediaClass === 'MessageMediaGame') {
    const game = media?.game || {};
    msgType = 'telegram.game';
    content ||= String(game?.title || game?.description || tr('Trò chơi'));
    attachments.push({ type: 'game', id: String(game?.id || ''), title: game?.title || '', description: game?.description || '' });
  } else if (mediaClass === 'MessageMediaInvoice') {
    msgType = 'telegram.invoice';
    content ||= String(media?.title || media?.description || tr('Hóa đơn'));
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
    content ||= mediaClass === 'MessageMediaGiveawayResults' ? tr('Kết quả giveaway') : 'Giveaway';
    attachments.push({
      type: 'giveaway', result: mediaClass === 'MessageMediaGiveawayResults',
      quantity: Number(media?.quantity || media?.winnersCount || 0),
      prize_description: media?.prizeDescription || '', until_date: Number(media?.untilDate || 0),
      stars: String(media?.stars || ''), months: Number(media?.months || 0),
    });
  } else if (mediaClass === 'MessageMediaPaidMedia') {
    msgType = 'telegram.paid_media';
    content ||= tr('Nội dung trả phí ({{v1}} Stars)', { v1: String(media?.starsAmount || 0) });
    attachments.push({ type: 'paid_media', stars_amount: String(media?.starsAmount || 0), items: Number(media?.extendedMedia?.length || 0) });
  } else if (mediaClass === 'MessageMediaToDo') {
    // Checklist: title + ☐ / ☑ for each item
    const todo = todoListToText(media);
    msgType = 'telegram.todo';
    content ||= todo.text;
    attachments.push({ type: 'todo', title: todo.title, items: todo.items });
  } else if (mediaClass === 'MessageMediaVideoStream') {
    msgType = 'telegram.livestream';
    content ||= tr('Phát trực tiếp');
    attachments.push({ type: 'livestream', rtmp: !!media?.rtmpStream });
  } else if (mediaClass === 'MessageMediaUnsupported') {
    msgType = 'telegram.unsupported';
    content ||= 'Loại tin nhắn Telegram chưa được hỗ trợ';
    attachments.push({ type: 'unsupported', media_class: mediaClass });
  } else if (mediaClass && mediaClass !== 'MessageMediaEmpty') {
    msgType = 'telegram.unknown';
    content ||= tr('Tin nhắn Telegram ({{mediaClass}})', { mediaClass });
    attachments.push({ type: 'unknown', media_class: mediaClass });
    Logger.warn(
      `[TG:media] UNHANDLED account=${String(message?._clientAccountId || '') || 'unknown'} ` +
      `chatId=${deriveMessageIdentity(message).chatId || 'unknown'} msg=${String(message?.id || '') || 'unknown'} class=${mediaClass}`
    );
  }

  return rich?.part ? { content, msgType, attachments, richPart: true } : { content, msgType, attachments };
}

/** Parse ReplyInlineMarkup from message into structured button rows */
function parseInlineButtons(message: any): InlineButtonInfo[][] | null {
  const replyMarkup = (message as any)?.replyMarkup;
  if (!replyMarkup || replyMarkup.className !== 'ReplyInlineMarkup') return null;

  const rows = replyMarkup.rows || [];
  // Layer 198: KeyboardButtonUrl / WebView / Callback…; layer 23x: KeyboardInlineButton { text, type: InlineButtonType* }
  return rows.map((row: any) => (row.buttons || []).map((btn: any) => inlineButtonInfo(btn)));
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
function initializeRecoveredMessage(message: any, client: TelegramClient, entities: Map<any, any>, resolvedChat?: any): NewMessageEvent {
  const event = new NewMessageEvent(message, { _entities: entities } as any);
  (event as any)._setClient(client);
  // `message.chat` is commonly unset on raw socket updates even when the
  // update carries the authoritative Channel entity in `_entities`.  Preserve
  // it on our wrapper instead of forcing GramJS getChat(), which can make an
  // unnecessary RPC in the realtime hot path.
  if (resolvedChat) (event as any).__deplaoResolvedChat = resolvedChat;
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
 * Start the MTProto listener for 1 account
 */
export async function startListener(account: TelegramUserAccount): Promise<{ success: boolean; error?: string }> {
  // The session is still in encrypted form = cannot be decrypted on this machine (data copied from another machine…): no listener is registered,
  // a listener with a connection error is kept to retry on its own; a broken session string would retry forever
  if (isUndecryptedCredential(account.stringSession)) {
    return {
      success: false,
      error: tr('Phiên đăng nhập Telegram không giải mã được trên máy này. Vui lòng đăng nhập lại tài khoản Telegram này.'),
    };
  }
  const existing = activeListeners.get(account.accountId);
  if (existing) {
    existing.account = account;
    existing.stopped = false;
    // An explicit start may carry a new session from a fresh login.
    existing.sessionInvalid = false;
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
      return { success: false, error: describeTelegramConnectError(err) };
    }
  }

  if (!API_ID || !API_HASH) {
    return { success: false, error: tr('Telegram API credentials chưa được cấu hình. Liên hệ admin.') };
  }

  const listener: ActiveListener = {
    account,
    client: null,
    connected: false,
    reconnectTimer: null,
    healthTimer: null,
    channelPollTimer: null,
    dialogWatchTimer: null,
    connecting: null,
    healthCheckClient: null,
    transportDownSince: null,
    retryCount: 0,
    lastTransportErrorAt: 0,
    stopped: false,
    transportIdentity: null,
    disconnectConfirmTimer: null,
    lastAliveAt: 0,
    lastUpdateAt: 0,
    forceFullCatchUp: false,
    sessionInvalid: false,
  };
  activeListeners.set(account.accountId, listener);

  try {
    await connectListener(listener);
    return { success: true };
  } catch (err: any) {
    Logger.error(`[TelegramUserListener] Failed to start for ${account.accountId}: ${err.message}`);
    // Keep the listener registered: connectListener has scheduled recovery and
    // removing it here previously made a failed first connection permanent.
    return { success: false, error: describeTelegramConnectError(err) };
  }
}

/** User-facing reason for a failed connect. When Telegram itself has rejected the
 * authorization, "Kết nối lại" (Reconnect) can never succeed: say a new login is needed. */
function describeTelegramConnectError(err?: unknown): string {
  const raw = String((err as any)?.errorMessage || (err as any)?.message || err || '');
  if (raw.toUpperCase().includes('AUTH_KEY_DUPLICATED')) {
    return tr('Telegram đã huỷ phiên đăng nhập này vì phát hiện phiên được dùng từ hai kết nối cùng lúc (AUTH_KEY_DUPLICATED). Vui lòng đăng nhập lại tài khoản Telegram này.', {  });
  }
  if (isFatalTelegramSessionError(err)) {
    return tr('Phiên đăng nhập Telegram đã hết hiệu lực hoặc bị thu hồi. Vui lòng đăng nhập lại tài khoản Telegram này.');
  }
  return raw || tr('Không thể kết nối Telegram');
}

function clearHealthCheck(listener: ActiveListener): void {
  if (listener.healthTimer) {
    clearInterval(listener.healthTimer);
    listener.healthTimer = null;
  }
  listener.healthCheckClient = null;
}

function clearDisconnectConfirmTimer(listener: ActiveListener): void {
  if (listener.disconnectConfirmTimer) {
    clearTimeout(listener.disconnectConfirmTimer);
    listener.disconnectConfirmTimer = null;
  }
}

/** Settle with `promise`, or reject once `ms` elapses. This only stops waiting;
 * the underlying request keeps running. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} (deadline ${Math.round(ms / 1000)}s)`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Give every client.invoke() a deadline, including GramJS's own internal
 * calls (getDialogs/getMessages iterators, getMe, GetState). */
function installRpcDeadline(client: TelegramClient): void {
  const anyClient = client as any;
  if (anyClient.__deplaoRpcDeadline || typeof anyClient.invoke !== 'function') return;
  const invoke = anyClient.invoke.bind(client);
  anyClient.__deplaoRpcDeadline = true;
  // Newer layers have "communities" (Community / DialogCommunity): remove them from the results before GramJS / Deplao read them, otherwise GramJS
  // iterDialogs throws "Cannot cast Community" and the whole conversation list load breaks (telegramLayerCompat.ts)
  anyClient.invoke = (request: any, ...rest: any[]) => withDeadline(
    invoke(request, ...rest),
    TELEGRAM_RPC_DEADLINE_MS,
    `TELEGRAM_RPC_TIMEOUT ${request?.className || 'request'}`,
  ).then(stripUnsupportedTelegramPeers);
}

let telegramApiLayerLogged = false;
/** Once per session, on connect: the GramJS API layer in use (198 = original schema → new-format messages become "chưa hỗ trợ" (unsupported)). */
function logTelegramApiLayerOnce(): void {
  if (telegramApiLayerLogged) return;
  telegramApiLayerLogged = true;
  let layer = 0;
  try { layer = Number(require('telegram/tl/AllTLObjects').LAYER) || 0; } catch {}
  const state = telegramApiLayerState();
  if (state?.installed) {
    Logger.info(`[Telegram] API layer ${layer}`);
  } else {
    Logger.warn(`[Telegram] API layer ${layer} — schema gốc của GramJS${state?.reason ? ` (${state.reason})` : ''}: tin dùng tính năng mới của Telegram sẽ hiện "chưa hỗ trợ"`);
  }
}

/**
 * Keep exactly one MTProto session on the account's main DC.
 *
 * GramJS sends every upload, and every download of a file stored on the main
 * DC, through client.getSender(mainDc). That opens a second sender with the
 * same authorization key to the main DC's regular (non-media) address.
 * Telegram treats parallel sessions on a non-media DC as a duplicated key and
 * invalidates the authorization for good (406 AUTH_KEY_DUPLICATED, the user
 * must log in again; see core.telegram.org/api/errors). Reconnects after
 * sleep or network loss made both connections come back at the same moment.
 * Serve main-DC transfers on the primary sender instead; other DCs keep their
 * own senders, which use separate authorizations.
 *
 * Senders GramJS still creates are tracked so that retiring the client can
 * shut them down even while they are still connecting.
 */
function installSingleMainSession(client: TelegramClient): void {
  const anyClient = client as any;
  if (anyClient.__deplaoSingleMainSession) return;
  anyClient.__deplaoSingleMainSession = true;
  if (typeof anyClient.getSender === 'function') {
    const getSender = anyClient.getSender.bind(client);
    anyClient.getSender = (dcId?: number) => {
      const mainDcId = Number(anyClient.session?.dcId || 0);
      if (!dcId || (mainDcId > 0 && Number(dcId) === mainDcId)) return Promise.resolve(anyClient._sender);
      return getSender(dcId);
    };
  }
  if (typeof anyClient._createExportedSender === 'function') {
    const createExportedSender = anyClient._createExportedSender.bind(client);
    const created = new Set<any>();
    anyClient.__deplaoExportedSenders = created;
    anyClient._createExportedSender = (dcId: number) => {
      const sender = createExportedSender(dcId);
      created.add(sender);
      return sender;
    };
  }
}

/** GramJS's Connection object for the primary socket. It is replaced whenever
 * the sender rebuilds the socket, unlike the `connected` heartbeat. */
function getTransportIdentity(client: TelegramClient | null | undefined): unknown {
  return (client as any)?._sender?._connection ?? null;
}

function isCurrentTelegramClient(accountId: string, client: TelegramClient | null | undefined): boolean {
  if (!client || retiredClients.has(client)) return false;
  const listener = activeListeners.get(accountId);
  return !!listener && !listener.stopped && listener.client === client;
}

function isAccountLockOwnerLive(accountId: string, owner: AccountLockOwner | undefined): boolean {
  if (!owner) return false;
  if (retiredClients.has(owner.client) || intentionallyDisconnectedClients.has(owner.client)) return false;
  const listener = activeListeners.get(accountId);
  // Without a registered listener (tests, early startup) the owner stands;
  // only a known newer client generation supersedes it.
  if (!listener) return true;
  return listener.client === owner.client && !listener.stopped;
}

function isAccountLockHeld(lock: Map<string, AccountLockOwner>, accountId: string): boolean {
  const owner = lock.get(accountId);
  if (!owner) return false;
  if (isAccountLockOwnerLive(accountId, owner)) return true;
  // Owned by a retired client generation. Its late completion cannot release
  // the replacement's lock because release checks ownership.
  lock.delete(accountId);
  return false;
}

function acquireAccountLock(lock: Map<string, AccountLockOwner>, accountId: string, client: TelegramClient): void {
  lock.set(accountId, { client, since: Date.now() });
}

function releaseAccountLock(lock: Map<string, AccountLockOwner>, accountId: string, client: TelegramClient): void {
  if (lock.get(accountId)?.client === client) lock.delete(accountId);
}

/** Reject every request a retired sender still holds so the application tasks
 * awaiting them unwind and release their locks. */
function rejectPendingSenderRequests(sender: any, error: Error): void {
  const states = new Set<any>();
  try { for (const state of sender?._pendingState?.values?.() || []) states.add(state); } catch {}
  try { for (const state of sender?._sendQueue?._pendingStates || []) states.add(state); } catch {}
  try { for (const state of sender?._sendQueue?._queue || []) if (state) states.add(state); } catch {}
  for (const state of states) {
    try {
      // Pings and MsgsAck have no awaiting caller; attach a handler first so
      // rejecting them cannot surface as an unhandled rejection.
      state?.promise?.catch?.(() => {});
      state?.reject?.(error);
    } catch {}
  }
  try { sender?._pendingState?.clear?.(); } catch {}
}

/** An attempt that was already connecting can still open its socket after
 * retirement. Close it if that happens; give up after three minutes. */
function reapRetiredSenderConnection(sender: any): void {
  let checks = 0;
  const timer = setInterval(() => {
    checks++;
    const connection = sender?._connection;
    try {
      if (connection?._connected) connection.disconnect?.()?.catch?.(() => {});
    } catch {}
    const settled = !sender?.isConnecting && !sender?.isReconnecting && !connection?._connected;
    if (settled || checks >= 36) clearInterval(timer);
  }, 5_000);
  (timer as any).unref?.();
}

function neutralizeRetiredSender(sender: any, error: Error): void {
  if (!sender || sender.__deplaoRetired) return;
  sender.__deplaoRetired = true;
  try {
    // End GramJS's in-place reconnect loop after the attempt in flight and
    // never start another one for this sender.
    sender._retries = 0;
    sender.reconnect = () => {};
    // GramJS 2.26: an attempt in flight still completes after disconnect()
    // and sets _userConnected=true, reviving the sender on the same auth key.
    // Telegram can then route updates to it, where every handler drops them.
    Object.defineProperty(sender, '_userConnected', {
      configurable: true,
      get: () => false,
      set: () => {},
    });
  } catch {}
  rejectPendingSenderRequests(sender, error);
  Promise.resolve()
    .then(() => sender.disconnect?.())
    .catch(() => {});
  reapRetiredSenderConnection(sender);
}

/**
 * Shut a client down for good. GramJS's disconnect() alone leaves the client's
 * ping/update loop running forever, never rejects requests that are still
 * waiting (which kept account sync locks held across reconnects), and does not
 * stop an in-place reconnect in progress.
 */
async function retireTelegramClient(client: TelegramClient | null | undefined, reason: string): Promise<void> {
  if (!client) return;
  intentionallyDisconnectedClients.add(client);
  if (retiredClients.has(client)) return;
  retiredClients.add(client);
  const anyClient = client as any;
  const error = new Error(`TELEGRAM_CLIENT_RETIRED: ${reason}`);
  // File-DC senders: GramJS 2.26's disconnect() walks these Maps with
  // Object.values(), so it neither closes them nor clears their release timers.
  try {
    for (const timeout of anyClient._exportedSenderReleaseTimeouts?.values?.() || []) clearTimeout(timeout);
    anyClient._exportedSenderReleaseTimeouts?.clear?.();
  } catch {}
  // Senders tracked at creation, including ones still connecting. Their
  // promise in _exportedSenderPromises settles only after they connected and
  // already resent their queued requests, which is too late.
  try {
    for (const sender of anyClient.__deplaoExportedSenders || []) neutralizeRetiredSender(sender, error);
  } catch {}
  try {
    for (const senderPromise of anyClient._exportedSenderPromises?.values?.() || []) {
      Promise.resolve(senderPromise).then(sender => neutralizeRetiredSender(sender, error)).catch(() => {});
    }
  } catch {}
  neutralizeRetiredSender(anyClient._sender, error);
  // Nothing may be sent through this client any more. The DC_ID_INVALID tag is
  // what ends GramJS's _connectSender loop, which otherwise retries a file-DC
  // sender every second forever once authorization can no longer be exported.
  const rejectRetired = () => Promise.reject(Object.assign(new Error(error.message), { errorMessage: 'DC_ID_INVALID' }));
  anyClient.invoke = rejectRetired;
  anyClient.invokeWithSender = rejectRetired;
  // destroy() marks the client destroyed synchronously, which ends the update
  // loop, and drops its event handlers once disconnected.
  let shutdown: Promise<unknown> = Promise.resolve();
  try {
    shutdown = Promise.resolve(typeof anyClient.destroy === 'function' ? anyClient.destroy() : anyClient.disconnect?.());
  } catch {}
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    shutdown.catch(() => {}),
    new Promise(resolve => { shutdownTimer = setTimeout(resolve, RETIRED_CLIENT_SHUTDOWN_MS); }),
  ]);
  if (shutdownTimer) clearTimeout(shutdownTimer);
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

/**
 * A raw UpdateNewChannelMessage can arrive before the high-level event has
 * resolved its chat.  Persist the embedded Channel entity first when GramJS
 * provides it, so a PTS-gap recovery has the access_hash it needs instead of
 * turning the channel into a terminal `missing_access_hash` failure.
 */
function cacheRawChannelEntity(accountId: string, update: any, chatId: string): any | null {
  const entities = update?._entities;
  if (!(entities instanceof Map)) return null;
  for (const entity of entities.values()) {
    try {
      if (getCanonicalChatId(entity) === chatId) {
        cacheTelegramPeer(accountId, chatId, entity);
        return entity;
      }
    } catch {
      // A malformed unrelated entity must never reject the incoming update.
    }
  }
  return null;
}

/**
 * GramJS can report a broken primary update loop through `onError` before (or
 * without) delivering UpdateConnectionState.disconnected.  Treat only socket
 * and network failures as an outage here; RPC errors such as FLOOD_WAIT must
 * not tear down a healthy listener.
 */
function isTelegramTransportError(err?: unknown): boolean {
  const value = err as any;
  const message = String(value?.errorMessage || value?.message || value || '').toUpperCase();
  return [
    'TIMEOUT',
    'CONNECTION',
    'SOCKET',
    'DISCONNECTED',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'NETWORK',
  ].some(code => message.includes(code));
}

/**
 * A primary-transport `connected` report. GramJS 2.26 emits one after every
 * successful ~9s ping (its wake-up branch always runs because
 * PING_INTERVAL_TO_WAKE_UP < PING_INTERVAL), so almost all of them are
 * heartbeats on an unchanged socket and must stay cheap no-ops. Only a
 * confirmed outage or a socket GramJS rebuilt in place is a reconnect.
 */
function handlePrimaryTransportConnected(listener: ActiveListener, client: TelegramClient): void {
  if (listener.stopped || listener.client !== client || retiredClients.has(client) || !client.connected) return;
  clearDisconnectConfirmTimer(listener);
  const transportChanged = getTransportIdentity(client) !== listener.transportIdentity;
  if (listener.connected && !transportChanged && listener.transportDownSince === null) {
    listener.lastAliveAt = Date.now();
    return;
  }
  markPrimaryConnectionRestored(
    listener,
    client,
    transportChanged ? 'gramjs_transport_rebuilt' : 'gramjs_auto_reconnect',
  );
}

/**
 * A primary-transport outage report: UpdateConnectionState.disconnected or a
 * transport error passed to onError. GramJS also reports `disconnected` when a
 * ping is merely slower than 1s and the same socket answers moments later
 * (slow network, or this process busy with a sync pass), and file-DC senders
 * share the same onError. Treating each report as an outage flapped the UI and
 * restarted a full catch-up every few seconds, so confirm it first.
 */
function handlePrimaryTransportDisconnected(listener: ActiveListener, client: TelegramClient, reason: string): void {
  if (listener.stopped || listener.client !== client || retiredClients.has(client)) return;
  if (!listener.connected || listener.reconnectTimer || listener.disconnectConfirmTimer) return;
  listener.disconnectConfirmTimer = setTimeout(() => {
    listener.disconnectConfirmTimer = null;
    if (listener.stopped || listener.client !== client || retiredClients.has(client)) return;
    const senderReconnecting = !!(client as any)._sender?.isReconnecting;
    if (client.connected && !senderReconnecting) {
      if (getTransportIdentity(client) === listener.transportIdentity) {
        tgLog('info', listener.account.accountId, 'socket', 'TRANSPORT_BLIP_IGNORED', { result: reason });
        return;
      }
      // GramJS rebuilt the socket in place within the confirmation window.
      markPrimaryConnectionRestored(listener, client, 'gramjs_transport_rebuilt');
      return;
    }
    scheduleReconnect(listener, reason);
  }, TRANSPORT_DISCONNECT_CONFIRM_MS);
}

function markPrimaryConnectionRestored(
  listener: ActiveListener,
  client: TelegramClient,
  source: string,
): void {
  if (listener.stopped || listener.client !== client || retiredClients.has(client) || !client.connected) return;
  if (listener.reconnectTimer) {
    clearTimeout(listener.reconnectTimer);
    listener.reconnectTimer = null;
  }
  clearDisconnectConfirmTimer(listener);
  const accountId = listener.account.accountId;
  const now = Date.now();
  const wasConnected = listener.connected;
  const identity = getTransportIdentity(client);
  // Startup handshakes and heartbeats are not outages. Only a confirmed outage
  // or a rebuilt socket can have lost updates; otherwise every startup would
  // re-enqueue all previously completed channel recoveries.
  const hadTransportOutage = listener.transportDownSince !== null || identity !== listener.transportIdentity;
  const previousAliveAt = listener.lastAliveAt;
  listener.connected = true;
  listener.transportDownSince = null;
  listener.transportIdentity = identity;
  listener.retryCount = 0;
  listener.lastAliveAt = now;
  if (hadTransportOutage) {
    // Compare the recent dialogs with local cursors right away rather than at
    // the next 45/90s watch slot.
    channelDialogWatchStates.set(accountId, { nextMainAt: 0, nextArchivedAt: 0 });
  }
  // Start the timers only when an outage stopped them. Restarting them on the
  // ~9s heartbeat meant the 45s health check and the 15s poll of open
  // channels never fired at all.
  if (!listener.healthTimer) startHealthCheck(listener);
  if (!listener.channelPollTimer) startChannelPoller(listener);
  else if (hadTransportOutage) refreshRecentChannelDialogWatch(listener);
  if (!wasConnected) {
    EventBroadcaster.emit('event:connected', {
      zaloId: accountId,
      accountInfo: { channel: 'telegram_user' },
    });
  }
  tgLog('info', accountId, 'socket', 'PRIMARY_CONNECTION_RESTORED', { result: source });
  if (!hadTransportOutage) return;
  const offlineFor = previousAliveAt > 0 ? now - previousAliveAt : Number.POSITIVE_INFINITY;
  const mode: CatchUpMode = listener.forceFullCatchUp || offlineFor > LIGHT_CATCHUP_MAX_OFFLINE_MS ? 'full' : 'light';
  listener.forceFullCatchUp = false;
  Logger.log(
    `[TelegramUserListener] Starting ${mode} reconnect catch-up for ${accountId} `
    + `(${source}, offline ${Number.isFinite(offlineFor) ? `${Math.round(offlineFor / 1000)}s` : 'unknown'})`,
  );
  scheduleReconnectCatchUp(listener, client, mode);
}

function scheduleReconnect(
  listener: ActiveListener,
  reason: string,
  err?: unknown,
  options: { delayMs?: number } = {},
): void {
  const wasConnected = listener.connected;
  listener.connected = false;
  listener.transportDownSince ??= Date.now();
  clearDisconnectConfirmTimer(listener);
  clearHealthCheck(listener);
  stopChannelPoller(listener);
  if (listener.stopped || listener.sessionInvalid) return;

  if (isFatalTelegramSessionError(err)) {
    listener.sessionInvalid = true;
    if (listener.reconnectTimer) {
      clearTimeout(listener.reconnectTimer);
      listener.reconnectTimer = null;
    }
    if (listener.client) {
      retireTelegramClient(listener.client, 'session_invalid').catch(() => {});
    }
    Logger.error(`[TelegramUserListener] Session cannot reconnect for ${listener.account.accountId} (${reason})`);
    EventBroadcaster.emit('event:disconnected', {
      zaloId: listener.account.accountId,
      reason: 'session_invalid',
      message: describeTelegramConnectError(err),
    });
    return;
  }
  if (listener.reconnectTimer) {
    // An explicit delay (network back online, system resume) replaces the
    // exponential backoff; other callers keep the timer already armed.
    if (options.delayMs === undefined) return;
    clearTimeout(listener.reconnectTimer);
    listener.reconnectTimer = null;
  }

  if (wasConnected) {
    EventBroadcaster.emit('event:disconnected', {
      zaloId: listener.account.accountId,
      reason,
    });
  }

  listener.retryCount++;
  const delay = options.delayMs ?? Math.min(
    RECONNECT_DELAY_MS * Math.pow(2, Math.min(listener.retryCount - 1, 10)),
    MAX_RECONNECT_DELAY_MS,
  );
  Logger.log(`[TelegramUserListener] Reconnecting in ${delay}ms (attempt ${listener.retryCount}, ${reason})`);
  const reconnect = () => {
    listener.reconnectTimer = null;
    if (listener.stopped) return;
    const currentClient = listener.client;
    const usable = !!currentClient && !retiredClients.has(currentClient);
    if (usable && currentClient!.connected) {
      markPrimaryConnectionRestored(listener, currentClient!, 'timer_transport_alive');
      return;
    }

    // GramJS first tries to reconnect its main sender in place. Do not destroy
    // that client mid-handshake; five connection attempts can legitimately take
    // close to a minute. If it remains stuck beyond the grace window, rebuild it.
    // Never shorten this wait: a replacement opened while GramJS's own attempt
    // is completing is a second session on the main DC, and Telegram answers
    // that with AUTH_KEY_DUPLICATED, which permanently invalidates the login.
    const senderReconnecting = usable && !!(currentClient as any)?._sender?.isReconnecting;
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
  let lastStaleRequeueAt = 0;
  listener.healthTimer = setInterval(async () => {
    if (listener.stopped || !listener.client) return;
    const client = listener.client;
    if (listener.healthCheckClient) return;
    listener.healthCheckClient = client;
    const accountId = listener.account.accountId;
    try {
      if (!client.connected) throw new Error('MTProto transport disconnected');
      // TG-04: getMe() has no transport-level deadline. A hung RPC previously
      // kept healthCheckClient latched forever, which made every later tick
      // return early — the account looked healthy while nothing was probing it.
      await withDeadline(client.getMe(), TELEGRAM_PROBE_DEADLINE_MS, 'health_probe_timeout');
      if (listener.client !== client || listener.stopped) return;
      listener.connected = true;
      listener.retryCount = 0;
      listener.lastAliveAt = Date.now();
      // Telegram treats "no updates for 15 minutes or longer" as a gap the
      // client must close with getDifference; doing so also renews the
      // session's update subscription.
      if (Date.now() - listener.lastUpdateAt >= NO_UPDATES_WATCHDOG_MS) {
        listener.lastUpdateAt = Date.now();
        Logger.log(`[TelegramUserListener] No updates for ${Math.round(NO_UPDATES_WATCHDOG_MS / 60_000)} min on ${accountId}; fetching difference`);
        scheduleReconnectCatchUp(listener, client, 'light');
      }
      // A recovery worker that died with its client leaves its row `draining`.
      // Reclaim such rows here instead of only when the next account sync starts.
      if (Date.now() - lastStaleRequeueAt >= STALE_RECOVERY_REQUEUE_INTERVAL_MS) {
        lastStaleRequeueAt = Date.now();
        DatabaseService.getInstance()?.requeueStaleChannelRecoveries(accountId);
        reconcileRecoveryMembership(accountId);
        schedulePendingChannelRecovery(listener);
      }
    } catch (err: any) {
      if (listener.client !== client || listener.stopped) return;
      if (
        !isFatalTelegramSessionError(err)
        && client.connected
        && Date.now() - listener.lastAliveAt < HEALTH_HEARTBEAT_FRESH_MS
      ) {
        // GramJS pings on this socket are still answered: a slow RPC (for
        // example a FLOOD_WAIT sleep inside GramJS) is not a transport outage.
        Logger.warn(`[TelegramUserListener] Health probe slow for ${accountId}, transport heartbeat is fresh: ${err.message}`);
        return;
      }
      Logger.warn(`[TelegramUserListener] Health check failed for ${accountId}: ${err.message}`);
      scheduleReconnect(listener, 'health_check', err);
    } finally {
      if (listener.healthCheckClient === client) listener.healthCheckClient = null;
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Catch up on what the primary connection may have missed.
 *  - light: updates.getDifference plus the queued/urgent channel recoveries.
 *    Falls back to the history pass by itself when the difference is not
 *    complete (no cursor yet, DifferenceTooLong, failure).
 *  - full: additionally re-checks every known channel and the recent dialogs'
 *    history. Used on startup, after a long outage and after system sleep.
 * One catch-up runs per account; a request arriving meanwhile reruns it once
 * afterwards, because the running pass may already be past getDifference.
 */
function scheduleReconnectCatchUp(listener: ActiveListener, client: TelegramClient, mode: CatchUpMode = 'full'): void {
  if (!isStartupSettled()) {
    // Right after the app opens: catch-up sync / reload of old messages waits until the UI finishes loading and the main thread is idle (utils/startup/startupSettle), so it runs
    // right at startup it competes with the UI for CPU / IPC, which makes the app stutter. New messages via socket are still saved and shown at once.
    whenStartupSettled(() => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
      scheduleReconnectCatchUp(listener, client, mode);
    });
    return;
  }
  const accountId = listener.account.accountId;
  const existing = reconnectCatchUps.get(accountId);
  if (existing && existing.client === client && !retiredClients.has(client)) {
    const pending = pendingCatchUpModes.get(accountId);
    pendingCatchUpModes.set(accountId, pending === 'full' || mode === 'full' ? 'full' : 'light');
    return;
  }
  let retryNeeded = false;
  let releaseTurn: () => void = () => undefined;
  const promise: Promise<void> = (async () => {
    // Right after waking up: accounts catch up one at a time instead of all at once (telegramResumeTurns.ts); otherwise it runs immediately
    releaseTurn = await resumeTurns.turn(accountId);
    const idle = await waitForTelegramAccountSync(accountId, 30_000);
    if (!idle) {
      retryNeeded = true;
      return;
    }
    if (!isCurrentTelegramClient(accountId, client) || !client.connected) return;
    const result = await synchronizeTelegramAccount(accountId, client, mode === 'full'
      ? { includeHistory: true, recoverRecentChannels: true }
      : {});
    if (!isCurrentTelegramClient(accountId, client)) return;
    const firstFailure = !catchUpFailureCounts.get(accountId);
    if (result.success) {
      // A light pass delivers what it recovers through event:message already;
      // reporting "completed" on every 15-minute check would only spam toasts.
      if (mode === 'full' || result.inserted > 0) {
        EventBroadcaster.emit('event:telegramSync', {
          zaloId: accountId,
          status: 'completed',
          inserted: result.inserted,
          pending: !result.historyComplete,
        });
        // The history pass saves without one event per message and repairs conversation previews: employees reload like the Boss topbar
        EventBroadcaster.emit('event:messagesSynced', { zaloId: accountId, source: 'telegram', inserted: result.inserted } satisfies MessagesSyncedEvent);
      }
    } else {
      retryNeeded = true;
      Logger.warn(`[TelegramUserListener] ${mode} catch-up was deferred for ${accountId}`);
      if (mode === 'full' && firstFailure) {
        EventBroadcaster.emit('event:telegramSync', {
          zaloId: accountId,
          status: 'failed',
          error: tr('Không thể hoàn tất đồng bộ tin nhắn Telegram'),
        });
      }
    }
  })().catch((err: any) => {
    // TG-05: a thrown pass needs the same retry as a failed one, unless its
    // client was replaced (the replacement schedules its own catch-up).
    retryNeeded = isCurrentTelegramClient(accountId, client);
    Logger.warn(`[TelegramUserListener] Reconnect catch-up failed for ${accountId}: ${err.message}`);
  }).finally(() => {
    releaseTurn();
    // A newer client's catch-up owns the account now; leave its state alone.
    if (reconnectCatchUps.get(accountId)?.promise !== promise) return;
    reconnectCatchUps.delete(accountId);
    const rerunMode = pendingCatchUpModes.get(accountId);
    pendingCatchUpModes.delete(accountId);
    const current = activeListeners.get(accountId);
    const currentClient = current?.client;
    if (
      !current || !currentClient || current.stopped || !current.connected
      || !currentClient.connected || retiredClients.has(currentClient)
    ) return;
    if (currentClient !== client) {
      setTimeout(() => scheduleReconnectCatchUp(current, currentClient, 'full'), 1_000);
      return;
    }
    if (retryNeeded) {
      const failures = (catchUpFailureCounts.get(accountId) || 0) + 1;
      catchUpFailureCounts.set(accountId, failures);
      const delay = Math.min(5_000 * Math.pow(3, failures - 1), 5 * 60_000);
      const retryMode: CatchUpMode = mode === 'full' || rerunMode === 'full' ? 'full' : 'light';
      setTimeout(() => scheduleReconnectCatchUp(current, currentClient, retryMode), delay);
      return;
    }
    catchUpFailureCounts.delete(accountId);
    if (rerunMode) setTimeout(() => scheduleReconnectCatchUp(current, currentClient, rerunMode), 1_000);
  });
  reconnectCatchUps.set(accountId, { client, promise });
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
const URGENT_CHANNEL_RECOVERY_PRIORITY = 1000;
// The MTProto socket remains the primary realtime transport.  This dialog
// watch is a small, low-rate safety net for accounts where Telegram delivers
// typing but delays/omits UpdateNewChannelMessage after a reconnect.  A new
// channel post moves that dialog to the top of its folder, so looking at the
// recent page is vastly cheaper (and safer) than polling every channel.
const CHANNEL_DIALOG_WATCH_LIMIT = 100;
const CHANNEL_DIALOG_WATCH_MAIN_INTERVAL_MS = 45_000;
// Telegram may stop pushing updates for some channels ("Subscribing to updates
// of channels/supergroups"); in practice that is mostly Archived/“Khác”, where
// this watch is the realtime path. Checked more often than All.
const CHANNEL_DIALOG_WATCH_ARCHIVED_INTERVAL_MS = 30_000;
// The watch runs on its own timer, so a long recovery drain (or a FLOOD_WAIT
// that GramJS sleeps inside a request) cannot postpone it.
const CHANNEL_DIALOG_WATCH_TICK_MS = 5_000;
// Opened channels are short-polled at the interval Telegram returns in
// getChannelDifference's `timeout`; never on every poller pass.
const ACTIVE_CHANNEL_MIN_POLL_MS = 1_000;
const ACTIVE_CHANNEL_DEFAULT_POLL_MS = 5_000;
const ACTIVE_CHANNEL_MAX_POLL_MS = 60_000;
// Typing in a busy group asks for at most one difference per interval.
const TYPING_CHANNEL_RECOVERY_MIN_INTERVAL_MS = 15_000;
// Backoff for a channel whose recovery failed without a FLOOD_WAIT.
const CHANNEL_RECOVERY_RETRY_BASE_MS = 5_000;
const CHANNEL_RECOVERY_RETRY_MAX_MS = 5 * 60_000;
// A failed history repair may be tried again for the same top message.
const CHANNEL_HISTORY_REPAIR_RETRY_MS = 10 * 60_000;
// Reconnect/manual sync can inspect recent dialogs, but must never fan out to
// every historical channel a long-lived account has ever seen.
const MAX_RECONNECT_CHANNEL_RECOVERY = 200;

/** Per-account channel poll serialization. Key: accountId */
const channelPollQueues = new Map<string, Promise<void>>();
// continue: the slice limit was reached after progress; drain again without backoff.
type ChannelDifferenceResult = 'complete' | 'retry' | 'unavailable' | 'continue';
type ChannelRecoveryQueueItem = {
  channel_id: string;
  access_hash: string;
  pts: number;
  priority: number;
  attempts: number;
  /** Active UI leases are polled without creating/reopening a DB queue row. */
  queued?: boolean;
};
type ChannelRecoveryOutcome = 'complete' | 'retry' | 'flood';
type ChannelRecoveryThrottle = {
  concurrency: number;
  successfulRequests: number;
  cooldownUntil: number;
};

// Start conservatively, scale only after a sustained healthy run, then back
// off all the way to one request after Telegram asks us to wait.  This keeps
// one account/session below the usual MTProto flood threshold while still
// allowing independent channels to make progress in parallel.
const CHANNEL_RECOVERY_INITIAL_WORKERS = 2;
const CHANNEL_RECOVERY_MIN_WORKERS = 1;
const CHANNEL_RECOVERY_MAX_WORKERS = 4;
const CHANNEL_RECOVERY_RAMP_AFTER_SUCCESSES = 30;
const CHANNEL_RECOVERY_CONTINUE_DELAY_MS = 250;
const channelRecoveryThrottles = new Map<string, ChannelRecoveryThrottle>();
const channelRecoveryDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingChannelRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const channelDialogWatchStates = new Map<string, {
  nextMainAt: number;
  nextArchivedAt: number;
}>();
/** Keyed by account; a task of a retired client must not block its replacement. */
const channelDialogWatchTasks = new Map<string, { client: TelegramClient; promise: Promise<void> }>();

const channelDifferenceQueues = new Map<string, { client: TelegramClient; promise: Promise<ChannelDifferenceResult> }>();
/** Channels explicitly marked by a live PTS gap/server hint or a failed
 * reconnect recovery. This replaces the old arbitrary first-10 DB scan. */
// The value is the earliest PTS supplied by UpdateChannelTooLong. Telegram
// provides it specifically for a channel whose durable cursor is unavailable;
// keeping it is essential — querying GetFullChannel first would jump to the
// current cursor and silently discard the offline interval.
// NOTE: pendingChannelRecoveries was migrated to persistent DB queue
// (telegram_channel_recovery_queue). The RAM Map is kept only for active
// channel leases (UI-navigated channels).
const activeChannelLeases = new Map<string, Map<string, number>>();
// Per-channel maps below are keyed `${accountId}:${channelId}`.
/** Earliest next short-poll of an opened (leased) channel. */
const activeChannelNextPollAt = new Map<string, number>();
/** `timeout` (seconds) returned by the channel's last getChannelDifference. */
const channelDifferenceTimeouts = new Map<string, number>();
/** Consecutive recovery failures without FLOOD_WAIT (drives the retry backoff). */
const channelRecoveryFailures = new Map<string, number>();
const typingChannelRecoveryAt = new Map<string, number>();
/** History repair attempted per channel, by Telegram top message ID. */
const channelHistoryRepairs = new Map<string, { topMessageId: number; failedAt: number }>();
const channelHistoryRepairQueues = new Map<string, Promise<void>>();
const channelRecoveryDrainDueAt = new Map<string, number>();

function deleteAccountChannelKeys(map: Map<string, unknown>, accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

function getChannelRecoveryThrottle(accountId: string): ChannelRecoveryThrottle {
  let throttle = channelRecoveryThrottles.get(accountId);
  if (!throttle) {
    throttle = {
      concurrency: CHANNEL_RECOVERY_INITIAL_WORKERS,
      successfulRequests: 0,
      cooldownUntil: 0,
    };
    channelRecoveryThrottles.set(accountId, throttle);
  }
  return throttle;
}

function getFloodWaitMs(error: unknown): number {
  const message = String((error as any)?.errorMessage || (error as any)?.message || error || '');
  const match = message.match(/FLOOD_WAIT_?(\d+)/i) || message.match(/FLOOD_WAIT\D+(\d+)/i);
  return Math.max(1_000, (match ? Number(match[1]) : 30) * 1_000);
}

function recordChannelRecoverySuccess(accountId: string): void {
  const throttle = getChannelRecoveryThrottle(accountId);
  if (throttle.cooldownUntil > Date.now()) return;
  throttle.successfulRequests++;
  if (
    throttle.successfulRequests >= CHANNEL_RECOVERY_RAMP_AFTER_SUCCESSES
    && throttle.concurrency < CHANNEL_RECOVERY_MAX_WORKERS
  ) {
    throttle.concurrency++;
    throttle.successfulRequests = 0;
    Logger.log(`[TelegramUserListener] Channel recovery concurrency increased to ${throttle.concurrency} for ${accountId}`);
  }
}

function applyChannelRecoveryFloodWait(accountId: string, error: unknown): number {
  const throttle = getChannelRecoveryThrottle(accountId);
  const waitMs = getFloodWaitMs(error);
  throttle.cooldownUntil = Math.max(throttle.cooldownUntil, Date.now() + waitMs);
  throttle.successfulRequests = 0;
  throttle.concurrency = Math.max(CHANNEL_RECOVERY_MIN_WORKERS, Math.floor(throttle.concurrency / 2));
  Logger.warn(`[TelegramUserListener] Channel recovery paused ${Math.ceil(waitMs / 1000)}s for ${accountId}; concurrency=${throttle.concurrency}`);
  return waitMs;
}

function schedulePendingChannelRecovery(listener: ActiveListener): void {
  const accountId = listener.account.accountId;
  if (listener.stopped || !listener.client?.connected) return;
  const db = DatabaseService.getInstance();
  if (!db) return;
  const now = Date.now();
  let runAt: number | null;
  // A full reconnect catch-up can take minutes for accounts with many old
  // channels. During that period continue only the live PTS-gap lane; the
  // ordinary pending queue remains owned by the reconnect worker.
  if (!isStartupSettled()) {
    // Right after the app opens: the recovery queue (including pts gaps) waits until the app settles; only the open channels are asked
    runAt = getNextActiveChannelPollAt(accountId);
  } else if (isAccountLockHeld(recoveringUpdateAccounts, accountId)) {
    runAt = db.hasPendingUrgentChannelRecovery(accountId) ? now : null;
  } else {
    // Only rows the workers can actually take. Counting every pending row
    // (including channels the account is no longer a member of, which dequeue
    // skips) made this reschedule the poller every 250ms forever, and each
    // pass re-polled every opened channel.
    runAt = db.getNextChannelRecoveryRunAt(accountId);
    const leasePollAt = getNextActiveChannelPollAt(accountId);
    if (leasePollAt !== null && (runAt === null || leasePollAt < runAt)) runAt = leasePollAt;
  }
  if (runAt === null) return;
  const throttle = getChannelRecoveryThrottle(accountId);
  const delay = Math.max(
    CHANNEL_RECOVERY_CONTINUE_DELAY_MS,
    runAt - now,
    throttle.cooldownUntil > now ? throttle.cooldownUntil - now + CHANNEL_RECOVERY_CONTINUE_DELAY_MS : 0,
  );
  // The 15-second poll interval covers anything due later.
  if (delay > CHANNEL_POLL_INTERVAL_MS) return;
  const dueAt = now + delay;
  const existing = channelRecoveryDrainTimers.get(accountId);
  if (existing) {
    if ((channelRecoveryDrainDueAt.get(accountId) ?? 0) <= dueAt) return;
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    channelRecoveryDrainTimers.delete(accountId);
    channelRecoveryDrainDueAt.delete(accountId);
    pollChannelUpdates(listener).catch(() => {});
  }, delay);
  channelRecoveryDrainTimers.set(accountId, timer);
  channelRecoveryDrainDueAt.set(accountId, dueAt);
}

/** Park/reopen recovery rows to match membership (see reconcileChannelRecoveryMembership). */
function reconcileRecoveryMembership(accountId: string): void {
  const result = DatabaseService.getInstance()?.reconcileChannelRecoveryMembership(accountId);
  if (result && (result.parked > 0 || result.reopened > 0)) {
    Logger.log(
      `[TelegramUserListener] Recovery queue: parked ${result.parked} channels the account is not a member of, `
      + `reopened ${result.reopened} for ${accountId}`,
    );
  }
}

function nextChannelRecoveryRetryAt(accountId: string, channelId: string): number {
  const key = `${accountId}:${channelId}`;
  const failures = (channelRecoveryFailures.get(key) || 0) + 1;
  channelRecoveryFailures.set(key, failures);
  return Date.now() + Math.min(
    CHANNEL_RECOVERY_RETRY_BASE_MS * Math.pow(2, Math.min(failures - 1, 10)),
    CHANNEL_RECOVERY_RETRY_MAX_MS,
  );
}

/** Next short-poll of an opened channel follows Telegram's `timeout`. */
function noteActiveChannelPolled(accountId: string, channelId: string): void {
  if (!activeChannelLeases.get(accountId)?.has(channelId)) return;
  const key = `${accountId}:${channelId}`;
  const timeoutSeconds = channelDifferenceTimeouts.get(key) || 0;
  const delay = timeoutSeconds > 0
    ? Math.min(ACTIVE_CHANNEL_MAX_POLL_MS, Math.max(ACTIVE_CHANNEL_MIN_POLL_MS, timeoutSeconds * 1000))
    : ACTIVE_CHANNEL_DEFAULT_POLL_MS;
  activeChannelNextPollAt.set(key, Date.now() + delay);
}

function getNextActiveChannelPollAt(accountId: string): number | null {
  let next: number | null = null;
  for (const channelId of getActiveChannelRecoveryOrder(accountId)) {
    const at = activeChannelNextPollAt.get(`${accountId}:${channelId}`) ?? 0;
    if (next === null || at < next) next = at;
  }
  return next;
}

/**
 * Active conversations bypass the normal folder queue, newest active first.
 * They are a small bounded set and must not let an open topic wait behind a
 * long reconnect backlog.
 */
function getActiveChannelRecoveryOrder(accountId: string): string[] {
  const leases = activeChannelLeases.get(accountId);
  if (!leases) return [];
  const now = Date.now();
  for (const [channelId, expiresAt] of leases) {
    if (expiresAt <= now) {
      leases.delete(channelId);
      activeChannelNextPollAt.delete(`${accountId}:${channelId}`);
    }
  }
  return [...leases.keys()].reverse();
}

function touchActiveChannel(accountId: string, channelId: string): void {
  if (!channelId.startsWith('-100')) return;
  const leases = activeChannelLeases.get(accountId) || new Map<string, number>();
  const now = Date.now();
  const alreadyOpen = (leases.get(channelId) || 0) > now;
  // Map insertion order acts as a small LRU.
  leases.delete(channelId);
  leases.set(channelId, now + ACTIVE_CHANNEL_LEASE_MS);
  while (leases.size > MAX_ACTIVE_CHANNELS_PER_ACCOUNT) {
    const oldest = leases.keys().next().value;
    if (!oldest) break;
    leases.delete(oldest);
    activeChannelNextPollAt.delete(`${accountId}:${oldest}`);
  }
  activeChannelLeases.set(accountId, leases);
  // Opening a channel polls it at once. The UI touches an open channel again
  // for topics/forum checks; that only extends the lease and keeps Telegram's
  // polling interval.
  if (alreadyOpen) return;
  activeChannelNextPollAt.set(`${accountId}:${channelId}`, 0);
  const listener = activeListeners.get(accountId);
  if (listener?.client?.connected && !listener.stopped) {
    pollChannelUpdates(listener).catch(() => {});
  }
}

/** A `member` default on a newly-created contact is not trustworthy. Only a
 * state written from a dialog/entity reconciliation can authorize background
 * channel recovery when a raw update does not carry a full Channel entity. */
function hasVerifiedTelegramChannelMembership(accountId: string, channelId: string): boolean {
  const db = DatabaseService.getInstance();
  const row = db?.queryOne<any>(
    `SELECT telegram_membership_state, telegram_state_updated_at FROM contacts
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, channelId],
  );
  return row?.telegram_membership_state === 'member'
    && Number(row?.telegram_state_updated_at || 0) > 0;
}

/**
 * Inspect only the leading dialogs in a folder and queue a difference only
 * when Telegram's dialog cursor proves that the local channel cursor/message
 * checkpoint is behind.  This deliberately does not call getMessages: the
 * per-channel difference drain remains the single persistence path.
 *
 * Main is examined before Archived/"Khác" and more often.  That mirrors the
 * UI/reconnect priority without leaving Archived dialogs permanently reliant
 * on the user opening them to obtain an active lease.
 */
function refreshRecentChannelDialogWatch(listener: ActiveListener): void {
  const accountId = listener.account.accountId;
  const client = listener.client;
  if (listener.stopped || !client || client.connected !== true || retiredClients.has(client)) return;
  // A watch still waiting on a retired client's request must not disable the
  // watch for its replacement (it used to stay pending forever).
  const running = channelDialogWatchTasks.get(accountId);
  if (running && running.client === client) return;
  // Right after the app opens: wait for the app to settle (a 5 s timer runs the first scan right after that)
  if (!isStartupSettled()) return;

  const state = channelDialogWatchStates.get(accountId) || { nextMainAt: 0, nextArchivedAt: 0 };
  const now = Date.now();
  const inspectMain = now >= state.nextMainAt;
  const inspectArchived = now >= state.nextArchivedAt;
  if (!inspectMain && !inspectArchived) return;
  if (inspectMain) state.nextMainAt = now + CHANNEL_DIALOG_WATCH_MAIN_INTERVAL_MS;
  if (inspectArchived) state.nextArchivedAt = now + CHANNEL_DIALOG_WATCH_ARCHIVED_INTERVAL_MS;
  channelDialogWatchStates.set(accountId, state);

  const promise: Promise<void> = (async () => {
    const db = DatabaseService.getInstance();
    if (!db || listener.stopped || listener.client !== client || !client.connected) return;

    let inspected = 0;
    let queuedMain = 0;
    let queuedArchived = 0;
    let repairs = 0;
    let stateChanged = false;
    const inspectFolder = async (folder: 0 | 1): Promise<void> => {
      const dialogs = folder === 1
        ? await client.getDialogs({ limit: CHANNEL_DIALOG_WATCH_LIMIT, folder: 1 })
        : await client.getDialogs({ limit: CHANNEL_DIALOG_WATCH_LIMIT });
      for (const dialog of dialogs) {
        await paceCatchUp();
        if (listener.stopped || listener.client !== client || !client.connected) return;
        const channelId = getCanonicalChatId(dialog.id);
        if (!channelId.startsWith('-100')) continue;
        inspected++;
        if (dialog.entity) cacheTelegramPeer(accountId, channelId, dialog.entity);
        // Only "archived" is ever read from a listing. The All pass calls
        // getDialogs without `folder`, which also returns recently active
        // archived chats WITHOUT folderId (observed live), so a missing
        // folderId must keep the stored folder. Treating it as 0 moved those
        // chats to "Tất cả" on every All pass until the next Archived pass.
        // Unarchiving arrives as UpdateFolderPeers (live or via getDifference).
        const listedFolder: 1 | undefined = folder === 1
          || Number((dialog as any)?.folderId ?? (dialog as any)?.dialog?.folderId ?? 0) === 1 ? 1 : undefined;
        // Keep dialog membership/folder metadata fresh but avoid a renderer
        // refresh for every row. One refresh below is enough for this pass,
        // and only when a visible field (unread, folder, mute...) changed.
        if (persistTelegramDialogState(accountId, channelId, dialog, dialog.entity, undefined, false, listedFolder)) {
          stateChanged = true;
        }
        if (!hasVerifiedTelegramChannelMembership(accountId, channelId)) continue;

        const localPts = Math.max(0, Number(db.getTelegramChannelPts(accountId, channelId) || 0));
        const serverPts = Math.max(0, Number((dialog as any)?.dialog?.pts ?? (dialog as any)?.pts ?? 0));
        const localMessageId = getTelegramHistoryCheckpoint(db, accountId, channelId);
        const topMessageId = Math.max(0, Number((dialog as any)?.dialog?.topMessage ?? (dialog as any)?.topMessage ?? 0));
        // The dialog PTS is authoritative when present; the top message is
        // only the fallback for a dialog shape without it. Comparing the top
        // message as well queued a channel on every pass forever whenever
        // that message is not stored locally (history never loaded, a service
        // message...), although its difference was already empty.
        const needsDifference = serverPts > 0
          ? serverPts > localPts
          : topMessageId > 0 && topMessageId > localMessageId;
        if (!needsDifference) {
          // Cursor current, newest message still missing locally: a
          // difference cannot return it, the history can (once).
          if (serverPts > 0 && topMessageId > localMessageId) {
            if (scheduleChannelHistoryRepair(listener, client, dialog, channelId, topMessageId)) repairs++;
          }
          continue;
        }
        // This is a current-server cursor/top-message signal, not a broad
        // historical scan. Put it in the live lane so reconnect catch-up
        // cannot make a recently active Archived dialog wait behind thousands
        // of old rows. Main still wins over "Khác" when both are pending.
        markChannelRecoveryPending(
          accountId,
          channelId,
          URGENT_CHANNEL_RECOVERY_PRIORITY + (folder === 0 ? 10 : 0),
        );
        if (folder === 0) queuedMain++;
        else queuedArchived++;
      }
    };

    // Preserve the product priority: exhaust the recent All page before
    // touching "Khác". The DB queue applies the same folder ordering while
    // draining the resulting difference requests.
    if (inspectMain) await inspectFolder(0);
    if (inspectArchived) await inspectFolder(1);
    if (stateChanged) {
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_dialog_watch' });
    }
    if (queuedMain || queuedArchived || repairs) {
      Logger.log(
        `[TelegramUserListener] Dialog watch inspected ${inspected} channels; queued ${queuedMain} All and `
        + `${queuedArchived} Khác, ${repairs} history repairs for ${accountId}`,
      );
    }
    if (queuedMain || queuedArchived) {
      schedulePendingChannelRecovery(listener);
    }
  })().catch((err: any) => {
    Logger.warn(`[TelegramUserListener] Dialog watch failed for ${accountId}: ${err.message}`);
  }).finally(() => {
    if (channelDialogWatchTasks.get(accountId)?.promise === promise) channelDialogWatchTasks.delete(accountId);
  });
  channelDialogWatchTasks.set(accountId, { client, promise });
}

/**
 * Read a channel's newest history once per Telegram top message when its
 * cursor is current but that message is not stored (a cursor seeded without
 * history, or a message getChannelDifference will not replay). Stored like the
 * history pass: no notification or workflow event. Returns whether a read was
 * scheduled.
 */
function scheduleChannelHistoryRepair(
  listener: ActiveListener,
  client: TelegramClient,
  dialog: any,
  channelId: string,
  topMessageId: number,
): boolean {
  const accountId = listener.account.accountId;
  const key = `${accountId}:${channelId}`;
  const previous = channelHistoryRepairs.get(key);
  if (previous?.topMessageId === topMessageId
    && (!previous.failedAt || Date.now() - previous.failedAt < CHANNEL_HISTORY_REPAIR_RETRY_MS)) {
    return false;
  }
  channelHistoryRepairs.set(key, { topMessageId, failedAt: 0 });
  const queue = channelHistoryRepairQueues.get(accountId) || Promise.resolve();
  const task: Promise<void> = queue.then(async () => {
    if (listener.stopped || listener.client !== client || !client.connected || retiredClients.has(client)) return;
    const db = DatabaseService.getInstance();
    if (!db) return;
    // A queued difference owns this channel and may still deliver the rows.
    if (db.queryOne(
      `SELECT 1 AS open FROM telegram_channel_recovery_queue
       WHERE owner_zalo_id = ? AND channel_id = ? AND status IN ('pending', 'draining')`,
      [accountId, channelId],
    )) {
      channelHistoryRepairs.delete(key);
      return;
    }
    const localMessageId = getTelegramHistoryCheckpoint(db, accountId, channelId);
    // Newest rows after the local checkpoint (or the bounded first load).
    const messages: any[] = [...await client.getMessages(dialog.inputEntity ?? dialog.entity ?? dialog.id, {
      limit: INITIAL_MESSAGES_PER_DIALOG,
      ...(localMessageId > 0 ? { minId: localMessageId } : {}),
    })];
    const inserted = await persistTelegramHistoryMessages(accountId, client, channelId, dialog, messages);
    Logger.log(
      `[TelegramUserListener] History repair for ${channelId}: fetched ${messages.length}, stored ${inserted} `
      + `(local ${localMessageId}, top ${topMessageId})`,
    );
  }).catch((err: any) => {
    const current = channelHistoryRepairs.get(key);
    if (current?.topMessageId === topMessageId) channelHistoryRepairs.set(key, { topMessageId, failedAt: Date.now() });
    Logger.warn(`[TelegramUserListener] History repair failed for ${channelId}: ${err?.message || err}`);
  });
  channelHistoryRepairQueues.set(accountId, task);
  task.finally(() => {
    if (channelHistoryRepairQueues.get(accountId) === task) channelHistoryRepairQueues.delete(accountId);
  }).catch(() => {});
  return true;
}

function markChannelRecoveryPending(accountId: string, channelId: string, priority = 0): void {
  const db = DatabaseService.getInstance();
  if (!db || !hasVerifiedTelegramChannelMembership(accountId, channelId)) return;
  // Try to get access_hash from peer cache for the queue
  const peer = db.getTelegramPeer(accountId, channelId);
  const accessHash = peer?.access_hash || '';
  // Queue only the last cursor that we durably committed after processing
  // messages.  The PTS on UpdateChannelTooLong is Telegram's current cursor,
  // not a safe recovery start; persisting it here would skip missed updates.
  const durablePts = Math.max(0, Number(db.getTelegramChannelPts(accountId, channelId) || 0));
  db.enqueueChannelRecovery(accountId, channelId, accessHash, durablePts, priority);
}

function clearChannelRecoveryPending(accountId: string, channelId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  // Live priority is a one-shot scheduling hint. Retaining it after a
  // successful recovery would turn every historic channel into “urgent” on
  // the next reconnect and recreate the starvation this queue is meant to
  // prevent.
  db.completeChannelRecovery(accountId, channelId);
}

function requestChannelRecovery(listener: ActiveListener, channelId: string, reason: string): void {
  if (!hasVerifiedTelegramChannelMembership(listener.account.accountId, channelId)) {
    tgChannelRealtimeTrace('RECOVERY_SKIPPED_NON_MEMBER', listener.account.accountId, { chatId: channelId, reason });
    return;
  }
  // A live PTS gap or Telegram's explicit TooLong hint must not wait for the
  // normal folder backlog: it represents a known missing interval.
  markChannelRecoveryPending(listener.account.accountId, channelId, URGENT_CHANNEL_RECOVERY_PRIORITY);
  // This is intentionally a normal log (rather than verbose ingress output):
  // it is emitted only for a real cursor gap/TooLong signal and makes it
  // possible to distinguish a Telegram delivery issue from a stuck recovery
  // queue in field logs.
  Logger.log(`[TelegramUserListener] Live channel recovery queued for ${channelId} (${reason})`);
  // Do not defer a live PTS gap behind the reconnect/history backlog. The
  // poller selects only urgent rows while that backlog owns the normal queue.
  pollChannelUpdates(listener).catch((err: any) => {
    // tgLog('warn', listener.account.accountId, 'channel_difference', `Recovery queue failed: ${err.message}`, { chatId: channelId });
  });
}

/**
 * A channel typing update proves that the primary MTProto socket is live for
 * that peer. Telegram may still omit/delay its companion NewChannelMessage
 * after a reconnect. Debounce a single difference probe so supergroups and
 * forum topics catch up without waiting for the user to open the chat.
 */
function scheduleTypingChannelRecovery(listener: ActiveListener, channelId: string): void {
  if (!hasVerifiedTelegramChannelMembership(listener.account.accountId, channelId)) return;
  const key = `${listener.account.accountId}:${channelId}`;
  // One probe per interval. Typing used to lease the channel for ten minutes
  // of short-polling, so busy groups evicted the chats actually open, and a
  // timer reset on every typing event postponed the probe while people typed.
  if (typingChannelRecoveryTimers.has(key)) return;
  if (Date.now() - (typingChannelRecoveryAt.get(key) || 0) < TYPING_CHANNEL_RECOVERY_MIN_INTERVAL_MS) return;
  const timer = setTimeout(() => {
    typingChannelRecoveryTimers.delete(key);
    typingChannelRecoveryAt.set(key, Date.now());
    if (listener.stopped || listener.client?.connected !== true) return;
    requestChannelRecovery(listener, channelId, 'channel_typing_followup');
  }, 1_500);
  typingChannelRecoveryTimers.set(key, timer);
  tgChannelRealtimeTrace('TYPING_CATCHUP_SCHEDULED', listener.account.accountId, { chatId: channelId });
}

function startChannelPoller(listener: ActiveListener): void {
  if (listener.channelPollTimer) clearInterval(listener.channelPollTimer);
  if (listener.dialogWatchTimer) clearInterval(listener.dialogWatchTimer);
  // Do not make a freshly connected Archived dialog wait for its first slot.
  refreshRecentChannelDialogWatch(listener);
  // The watch is not driven by the poller: a poll stays busy for as long as
  // its recovery batch drains (including GramJS FLOOD_WAIT sleeps), which used
  // to postpone Archived detection by minutes.
  listener.dialogWatchTimer = setInterval(() => {
    if (listener.stopped || !listener.client?.connected) return;
    refreshRecentChannelDialogWatch(listener);
  }, CHANNEL_DIALOG_WATCH_TICK_MS);
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
  if (listener.dialogWatchTimer) {
    clearInterval(listener.dialogWatchTimer);
    listener.dialogWatchTimer = null;
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
    // An urgent row can have arrived while this account's previous poll was
    // draining. Re-check after releasing the serialization lock so it is not
    // stranded until the next 15-second timer (or until manual refresh).
    schedulePendingChannelRecovery(listener);
  }
}

/**
 * Recover one independent channel. PTS is serialized inside
 * drainChannelDifference per channel, while callers may process different
 * channels concurrently through the bounded account worker pool below.
 */
async function recoverQueuedChannel(
  accountId: string,
  client: TelegramClient,
  queued: ChannelRecoveryQueueItem,
  source: TelegramIngressSource,
): Promise<ChannelRecoveryOutcome> {
  try {
    return await recoverQueuedChannelNow(accountId, client, queued, source);
  } finally {
    noteActiveChannelPolled(accountId, queued.channel_id);
  }
}

function readChannelRecoveryRetryAt(db: DatabaseService, accountId: string, channelId: string): number {
  return Number(db.queryOne<{ retry_at: number }>(
    `SELECT retry_at FROM telegram_channel_recovery_queue
     WHERE owner_zalo_id = ? AND channel_id = ?`,
    [accountId, channelId],
  )?.retry_at || 0);
}

async function recoverQueuedChannelNow(
  accountId: string,
  client: TelegramClient,
  queued: ChannelRecoveryQueueItem,
  source: TelegramIngressSource,
): Promise<ChannelRecoveryOutcome> {
  const db = DatabaseService.getInstance();
  if (!db) return 'retry';
  const channelId = queued.channel_id;
  const failureKey = `${accountId}:${channelId}`;
  // Even an active-view poll needs a durable history boundary while its RPC
  // is in flight: realtime can arrive before a TooLong response comes back.
  if (queued.queued === false) markChannelRecoveryPending(accountId, channelId);
  db.preserveChannelRecoveryHistoryStart(accountId, channelId);
  const peer = db.getTelegramPeer(accountId, channelId);
  let accessHash = peer?.access_hash || queued.access_hash;

  if (!accessHash) {
    const resolved = await repairAccessHash(accountId, client, channelId, peer);
    accessHash = db.getTelegramPeer(accountId, channelId)?.access_hash || '';
    if (!resolved || !accessHash) {
      tgLog('warn', accountId, source, `No access_hash for ${channelId}, skipping`);
      db.updateChannelRecoveryStatus(accountId, channelId, 'failed', { lastError: 'missing_access_hash' });
      return 'complete';
    }
  }

  // `telegram_channel_pts` is the sole durable cursor.  A value carried by
  // UpdateChannelTooLong describes Telegram's *current* state, not our last
  // successfully persisted state; using it as a fallback can silently skip
  // the very interval the recovery was queued for.  Bootstrap an unseeded
  // channel from pts=0 instead.  GetChannelDifference will return either an
  // authoritative empty cursor, normal differences, or TooLong together with
  // dialog.pts after the history snapshot has been persisted.
  const currentPts = Math.max(0, Number(db.getTelegramChannelPts(accountId, channelId) || 0));

  // A retry time set before this drain (backoff) is not a FLOOD_WAIT signal.
  const retryAtBefore = readChannelRecoveryRetryAt(db, accountId, channelId);
  try {
    db.updateChannelRecoveryStatus(accountId, channelId, 'draining');
    const recovered = await drainChannelDifference(accountId, client, channelId, accessHash, currentPts, source);
    if (recovered === 'complete' || recovered === 'unavailable') {
      channelRecoveryFailures.delete(failureKey);
      clearChannelRecoveryPending(accountId, channelId);
      return 'complete';
    }
    // drainChannelDifference handles FLOOD_WAIT internally and persists its
    // retry_at. Read it back so this worker pool pauses globally instead of
    // continuing other channel history/difference requests during the wait.
    const retryAtAfter = readChannelRecoveryRetryAt(db, accountId, channelId);
    if (retryAtAfter > Date.now() && retryAtAfter !== retryAtBefore) {
      const waitMs = Math.max(1_000, retryAtAfter - Date.now());
      applyChannelRecoveryFloodWait(accountId, new Error(`FLOOD_WAIT_${Math.ceil(waitMs / 1000)}`));
      return 'flood';
    }
    // A recoverable, non-flood incomplete result must return the durable row
    // to pending. enqueueChannelRecovery intentionally preserves `draining`
    // rows, so using it here would leave this channel stuck forever.
    if (recovered === 'continue') {
      // Progress was made up to the slice limit: drain on, no backoff.
      channelRecoveryFailures.delete(failureKey);
      db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
        pts: currentPts,
        lastError: 'channel_difference_continue',
      });
      return 'retry';
    }
    // Back off per channel: a peer failing the same way on every pass used
    // to be retried immediately, hot-looping the poller.
    db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
      pts: currentPts,
      lastError: 'channel_difference_incomplete',
      retryAt: nextChannelRecoveryRetryAt(accountId, channelId),
    });
    return 'retry';
  } catch (err: any) {
    if (String(err?.message || '').includes('FLOOD_WAIT')) {
      const waitMs = applyChannelRecoveryFloodWait(accountId, err);
      db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
        retryAt: Date.now() + waitMs,
        lastError: err.message,
      });
      tgLog('warn', accountId, source, `FLOOD_WAIT ${Math.ceil(waitMs / 1000)}s for ${channelId}`);
      return 'flood';
    }
    tgLog('warn', accountId, source, `Channel ${channelId} error: ${err.message}`);
    db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
      lastError: err.message,
      retryAt: nextChannelRecoveryRetryAt(accountId, channelId),
    });
    return 'retry';
  }
}

async function runChannelRecoveryWorkers(
  listener: ActiveListener,
  client: TelegramClient,
  items: ChannelRecoveryQueueItem[],
  source: TelegramIngressSource,
): Promise<void> {
  if (!items.length) return;
  const accountId = listener.account.accountId;
  const throttle = getChannelRecoveryThrottle(accountId);
  if (throttle.cooldownUntil > Date.now()) return;

  let nextIndex = 0;
  let stopForFlood = false;
  // Live work (a PTS gap, TooLong, a dialog watch hit on an Archived channel)
  // that arrives while backlog items drain is taken between items, not after
  // the whole batch.
  const claimed = new Set<string>();
  const db = DatabaseService.getInstance();
  const takeNext = (): ChannelRecoveryQueueItem | undefined => {
    const live = (db?.dequeueUrgentChannelRecovery(accountId, claimed.size + 5) as ChannelRecoveryQueueItem[] | undefined)
      ?.find(item => !claimed.has(item.channel_id));
    if (live) {
      claimed.add(live.channel_id);
      return live;
    }
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (claimed.has(item.channel_id)) continue;
      claimed.add(item.channel_id);
      return item;
    }
    return undefined;
  };
  const worker = async () => {
    // Stop with the client generation that started this pool: a retired
    // client can no longer send, and its items belong to the replacement.
    while (!stopForFlood && !listener_stopped(accountId) && isCurrentTelegramClient(accountId, client)) {
      const item = takeNext();
      if (!item) return;
      const outcome = await recoverQueuedChannel(accountId, client, item, source);
      if (outcome === 'flood') {
        stopForFlood = true;
        return;
      }
      if (outcome === 'complete') recordChannelRecoverySuccess(accountId);
    }
  };

  const workerCount = Math.min(throttle.concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function pollChannelUpdatesNow(listener: ActiveListener): Promise<void> {
  const accountId = listener.account.accountId;
  const client = listener.client;
  if (!client) return;

  const db = DatabaseService.getInstance();
  if (!db) return;
  const reconnectRecoveryActive = isAccountLockHeld(recoveringUpdateAccounts, accountId);

  try {
    // The Archived/All dialog watch has its own timer (startChannelPoller).
    const throttle = getChannelRecoveryThrottle(accountId);
    if (throttle.cooldownUntil > Date.now()) {
      schedulePendingChannelRecovery(listener);
      return;
    }

    // While the reconnect pass owns the normal queue, this poller runs a
    // separate urgent lane for live PTS gaps/TooLong updates. This keeps
    // supergroups, channels and forum topics realtime even with a very large
    // historical recovery backlog.
    // Right after the app opens: do not pull the recovery queue (reloading old messages), only ask the open channels below
    const queuedChannels = (!isStartupSettled()
      ? []
      : reconnectRecoveryActive
        ? db.dequeueUrgentChannelRecovery(accountId, 20)
        : db.dequeueChannelRecovery(accountId, 50)) as ChannelRecoveryQueueItem[];
    if (reconnectRecoveryActive && queuedChannels.length === 0) return;

    // Active-channel leases are useful for normal backlog ordering, but must
    // not let an open conversation steal a non-urgent row while reconnect
    // recovery is processing the durable queue.
    // Opened channels are short-polled only when due (Telegram's `timeout`),
    // however often this pass runs.
    const now = Date.now();
    const activeChannelIds = reconnectRecoveryActive
      ? []
      : getActiveChannelRecoveryOrder(accountId)
        .filter(channelId => (activeChannelNextPollAt.get(`${accountId}:${channelId}`) ?? 0) <= now);
    const activeChannelSet = new Set(activeChannelIds);
    const queuedById = new Map<string, ChannelRecoveryQueueItem>();
    for (const c of queuedChannels) {
      queuedById.set(c.channel_id, c);
    }
    const workItems: ChannelRecoveryQueueItem[] = [
      ...activeChannelIds.map(channelId => queuedById.get(channelId) || {
        channel_id: channelId,
        access_hash: '',
        pts: db.getTelegramChannelPts(accountId, channelId),
        priority: URGENT_CHANNEL_RECOVERY_PRIORITY,
        attempts: 0,
        queued: false,
      }),
      ...queuedChannels.filter(channel => !activeChannelSet.has(channel.channel_id)),
    ];
    await runChannelRecoveryWorkers(listener, client, workItems, 'poll');
    // Drain the next batch immediately while there is a reconnect backlog;
    // the 15-second poll interval remains the idle/realtime safety net.
    schedulePendingChannelRecovery(listener);
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
  // TG-04: single-flight is per (account, channel, *client generation*).
  // Handing a pending promise from a retired client to the new one meant the
  // fresh connection sat waiting on an RPC that would never come back after
  // the transport was torn down.
  if (existing && existing.client === client) return existing.promise;
  const task = drainChannelDifferenceNow(accountId, client, channelId, accessHash, startingPts, source);
  const entry = { client, promise: task };
  channelDifferenceQueues.set(queueKey, entry);
  try {
    return await task;
  } finally {
    // Only clear our own entry; a newer client may already own the key.
    if (channelDifferenceQueues.get(queueKey) === entry) channelDifferenceQueues.delete(queueKey);
  }
}

/**
 * `channelDifferenceTooLong` means the PTS interval can no longer be obtained
 * as normal updates. Before accepting its newest snapshot, replay the bounded
 * message-ID range after our durable checkpoint. Otherwise committing
 * dialog.pts would turn every older missed message into a permanent gap.
 *
 * Fetch history oldest first in bounded pages; commit each page's boundary
 * only after persistence succeeds so retries cannot skip a partial backlog.
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

  db.preserveChannelRecoveryHistoryStart(accountId, channelId);
  const minId = getTelegramHistoryCheckpoint(db, accountId, channelId);
  // Keep individual history requests small. GramJS's iterator applies its own
  // wait policy only for very large limits, which currently produces a
  // negative timeout on the first chunk and causes bursty requests/flood waits.
  // We still recover up to 5,000 messages, but do it as paced 100-message pages.
  const BACKFILL_LIMIT = 5000;
  const BACKFILL_PAGE_SIZE = 100;
  const BACKFILL_PAGE_DELAY_MS = 1000;

  try {
    const allMessages: any[] = [];
    let historyCursor = minId;
    let reachedHistoryEnd = false;

    if (minId <= 0) {
      // The only safe option without a checkpoint is a bounded first load.
      // `channelDifferenceTooLong` already supplies such a snapshot, whereas
      // a bare UpdateChannelTooLong needs us to request one explicitly.
      if (!includeInitialSnapshot) return { complete: true, failed: false };
      allMessages.push(...await client.getMessages(inputChannel, { limit: INITIAL_MESSAGES_PER_DIALOG }));
      allMessages.sort((a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0));
    } else {
      // Paginate explicitly instead of asking GramJS for 5,000 items at once.
      // `getMessages` delegates to its iterator, so a large limit here would
      // recreate the negative-timer issue seen during ChannelDifferenceTooLong.
      while (allMessages.length < BACKFILL_LIMIT) {
        const pageLimit = Math.min(BACKFILL_PAGE_SIZE, BACKFILL_LIMIT - allMessages.length);
        const opts: any = {
          limit: pageLimit,
          reverse: true,
          minId: historyCursor,
        };

        const batch: any[] = await client.getMessages(inputChannel, opts);
        if (batch.length === 0) { reachedHistoryEnd = true; break; }
        const page = batch.filter(message => Number(message.id) > historyCursor)
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (!page.length) return { complete: false, failed: true };
        // Persist oldest first and only advance the recovery boundary after
        // the entire page succeeds. A retry resumes beyond this page, never
        // beyond an unrelated high-ID message delivered by the live socket.
        await processDifferenceMessages(accountId, client, page, entities, 'history');
        historyCursor = Number(page[page.length - 1].id);
        db.run(`UPDATE telegram_channel_recovery_queue SET history_start_msg_id = ?
                WHERE owner_zalo_id = ? AND channel_id = ? AND status IN ('pending', 'draining')`,
          [historyCursor, accountId, channelId]);
        allMessages.push(...page);

        // If we got fewer than requested, we're done
        if (batch.length < pageLimit) {
          reachedHistoryEnd = true;
          break;
        }

        // Match the safe pacing GramJS intended for very large collections,
        // without relying on its broken first-iteration timeout calculation.
        if (allMessages.length < BACKFILL_LIMIT) {
          await new Promise(resolve => setTimeout(resolve, BACKFILL_PAGE_DELAY_MS));
        }
      }

    }

    if (minId <= 0 && allMessages.length > 0) {
      // Sort by ID to ensure chronological order
      allMessages.sort((a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0));
      await processDifferenceMessages(accountId, client, allMessages, entities, 'history');
    }

    // Update the last message ID checkpoint for future recovery
    if (allMessages.length > 0) {
      const maxMsgId = Math.max(...allMessages.map((m: any) => Number(m?.id || 0)));
      db.updateChannelRecoveryStatus(accountId, channelId, 'pending', { lastMsgId: maxMsgId });
    }

    return {
      complete: minId <= 0 || reachedHistoryEnd,
      failed: false,
    };
  } catch (err: any) {
    // Handle flood wait gracefully
    if (err.message?.includes('FLOOD_WAIT')) {
      const waitMatch = err.message.match(/(\d+)/);
      const waitSec = waitMatch ? parseInt(waitMatch[1]) : 30;
      tgLog('warn', accountId, 'channel_difference', `TooLong backfill FLOOD_WAIT ${waitSec}s for ${channelId}`);
      db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
        retryAt: Date.now() + waitSec * 1000,
        lastError: err.message,
      });
      return { complete: false, failed: false }; // Not failed, just throttled
    }
    tgLog('warn', accountId, 'channel_difference', `TooLong history backfill failed for ${channelId}: ${err.message}`);
    return { complete: false, failed: true };
  }
}

/**
 * Telegram rejects GetChannelDifference with PERSISTENT_TIMESTAMP_EMPTY for
 * some channels that have no usable server-side persistent cursor (commonly
 * a newly discovered/legacy channel with local PTS=0). Retrying the exact
 * same RPC can never repair that state and used to occupy a live worker every
 * 250ms. Establish a snapshot PTS first, backfill history up to that
 * checkpoint, then commit it. A message arriving after the snapshot remains
 * visible to the next normal difference, so this does not discard realtime.
 */
async function bootstrapPersistentTimestampEmptyChannel(
  accountId: string,
  client: TelegramClient,
  inputChannel: any,
  channelId: string,
  source: TelegramIngressSource,
): Promise<ChannelDifferenceResult> {
  const { Api } = require('telegram');
  const db = DatabaseService.getInstance();
  if (!db) return 'retry';
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }));
    const snapshotPts = Math.max(0, Number((full as any)?.fullChat?.pts || 0));
    if (snapshotPts <= 0) {
      // There is no cursor to establish. Treat this peer as unavailable for
      // the current pass rather than spinning the same rejected RPC forever;
      // a future socket update may enqueue it again with a real PTS.
      tgLog('warn', accountId, source, `PERSISTENT_TIMESTAMP_EMPTY without ChannelFull.pts for ${channelId}; stopping this recovery pass`);
      return 'unavailable';
    }

    const entities = cacheDifferenceEntities(accountId, (full as any)?.users || [], (full as any)?.chats || []);
    const history = await backfillChannelTooLongHistory(
      accountId,
      client,
      inputChannel,
      channelId,
      entities,
      true,
    );
    if (history.complete && !history.failed) {
      db.saveTelegramChannelPts(accountId, channelId, snapshotPts);
      Logger.log(`[TelegramUserListener] Bootstrapped PTS=${snapshotPts} after PERSISTENT_TIMESTAMP_EMPTY for ${channelId}`);
      return 'complete';
    }

    // A backfill FLOOD_WAIT has already installed a server-authorized retry
    // time and must keep the normal global throttle behavior. Any other
    // failure is local to this peer: finishing this pass is safer than adding
    // a retry_at which recoverQueuedChannel would interpret as a global flood
    // and use to block every unrelated channel.
    const pending = db.queryOne<{ retry_at: number }>(
      `SELECT retry_at FROM telegram_channel_recovery_queue
       WHERE owner_zalo_id = ? AND channel_id = ?`,
      [accountId, channelId],
    );
    if (Number(pending?.retry_at || 0) > Date.now()) return 'retry';
    tgLog('warn', accountId, source, `PERSISTENT_TIMESTAMP history incomplete for ${channelId}; stopping this recovery pass`);
    return 'unavailable';
  } catch (err: any) {
    const message = String(err?.message || err || 'unknown error');
    const unavailable = /CHANNEL_(?:PRIVATE|INVALID)|USER_BANNED_IN_CHANNEL/.test(message);
    if (unavailable) return 'unavailable';
    tgLog('warn', accountId, source, `PERSISTENT_TIMESTAMP bootstrap failed for ${channelId}: ${message}`);
    return 'unavailable';
  }
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
  const MAX_SLICES = 50; // Increased from 10 — large channels need more drain iterations

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
      // Flood wait: schedule retry at the exact time Telegram allows
      if (err.message?.includes('FLOOD_WAIT')) {
        const waitMatch = err.message.match(/(\d+)/);
        const waitSec = waitMatch ? parseInt(waitMatch[1]) : 30;
        tgLog('warn', accountId, source, `FLOOD_WAIT ${waitSec}s for ${channelId}`);
        db.updateChannelRecoveryStatus(accountId, channelId, 'pending', {
          retryAt: Date.now() + waitSec * 1000,
          lastError: err.message,
        });
        return 'retry';
      }
      if (String(err?.message || '').includes('PERSISTENT_TIMESTAMP_EMPTY')) {
        return bootstrapPersistentTimestampEmptyChannel(
          accountId,
          client,
          inputChannel,
          channelId,
          source,
        );
      }
      // These errors are terminal for this peer. Keeping them in the pending
      // queue makes reconnect/poll spam forever after the user leaves a group.
      const unavailable = /CHANNEL_(?:PRIVATE|INVALID)|USER_BANNED_IN_CHANNEL/.test(err.message || '');
      if (!unavailable) {
        tgLog('warn', accountId, source, `getChannelDifference failed for ${channelId}: ${err.message}`);
      }
      return unavailable ? 'unavailable' : 'retry'; // Don't commit PTS on failure
    }

    // When to short-poll this channel again if it is open (seconds).
    const pollTimeout = Number((diff as any)?.timeout || 0);
    if (pollTimeout > 0) channelDifferenceTimeouts.set(queueKeyFor(accountId, channelId), pollTimeout);
    else channelDifferenceTimeouts.delete(queueKeyFor(accountId, channelId));

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
        await paceCatchUp();
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
        await paceCatchUp();
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
          await paceCatchUp();
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
  return 'continue';
}

function queueKeyFor(accountId: string, channelId: string): string {
  return `${accountId}:${channelId}`;
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

  // Retire the old client before creating a new one. GramJS's disconnect()
  // alone would leave its update loop running and its in-flight requests (and
  // the account locks awaiting them) pending forever.
  const previousClient = listener.client;
  if (previousClient) {
    listener.client = null;
    await retireTelegramClient(previousClient, 'replaced');
  }
  clearDisconnectConfirmTimer(listener);
  clearHealthCheck(listener);
  stopChannelPoller(listener);

  const stringSession = new StringSession(account.stringSession);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });
  installRpcDeadline(client);
  installSingleMainSession(client);

  // GramJS's update loop prints a raw `Error: TIMEOUT` stack after its own
  // ping retries. The error is expected during a temporary network outage and
  // GramJS immediately reconnects the sender. Keep diagnostics useful without
  // leaking a stack or generating several identical lines per outage.
  (client as any).setLogLevel?.('none');
  (client as any).onError = async (err: unknown) => {
    if (listener.stopped || listener.client !== client || intentionallyDisconnectedClients.has(client)) return;
    const message = String((err as any)?.errorMessage || (err as any)?.message || err || 'unknown error');
    const transportError = isTelegramTransportError(err);

    // Do this before rate-limiting diagnostics. A later TIMEOUT in the same
    // outage must still leave the listener marked offline if an earlier state
    // event was missed by GramJS. GramJS also reports file-DC sender failures
    // and errors thrown by our own handlers here, so a transport error is only
    // a candidate outage until the primary socket is confirmed down.
    if (transportError) {
      handlePrimaryTransportDisconnected(listener, client, 'gramjs_transport_error');
    }

    const now = Date.now();
    if (now - listener.lastTransportErrorAt < 30_000) return;
    listener.lastTransportErrorAt = now;
    tgLog(
      'warn',
      account.accountId,
      'socket',
      transportError
        ? (/^TIMEOUT$/i.test(message) ? 'PING_TIMEOUT' : 'GRAMJS_TRANSPORT_ERROR')
        : 'GRAMJS_RPC_ERROR',
      {
        // CHANNEL_INVALID/FLOOD_WAIT and similar RPC failures are emitted by
        // GramJS through the same callback, but must not be presented as a
        // socket reconnect: the active listener stays healthy in that case.
        result: transportError ? 'gramjs_auto_reconnect' : 'listener_kept_alive',
        error: message.slice(0, 160),
      },
    );
  };

  listener.client = client;

  try {
    // client.connect() retries without a deadline of its own, and a request
    // that never gets an answer would otherwise hold listener.connecting (and
    // with it every later reconnect) forever.
    const transportConnected = await withDeadline(
      client.connect(),
      TELEGRAM_CONNECT_DEADLINE_MS,
      'TELEGRAM_CONNECT_TIMEOUT',
    );
    if (!transportConnected && !client.connected) {
      throw new Error('MTProto transport failed to connect');
    }
    // stopListener may have run while the transport handshake was in flight.
    if (listener.stopped) {
      await retireTelegramClient(client, 'listener_stopped');
      return;
    }

    // A live TCP transport is not enough to mark an account online. This
    // authorized request catches revoked/expired sessions before timers and UI
    // are started for a client that cannot actually receive account updates.
    await withDeadline(client.getMe(), TELEGRAM_PROBE_DEADLINE_MS * 2, 'TELEGRAM_GETME_TIMEOUT');
    if (listener.stopped || listener.client !== client) {
      await retireTelegramClient(client, 'listener_replaced');
      return;
    }
    const connectedAt = Date.now();
    listener.connected = true;
    logTelegramApiLayerOnce();
    scheduleTelegramDataRepair(listener.account.accountId);
    listener.transportDownSince = null;
    listener.retryCount = 0;
    listener.stopped = false;
    listener.transportIdentity = getTransportIdentity(client);
    listener.lastAliveAt = connectedAt;
    listener.lastUpdateAt = connectedAt;
    listener.forceFullCatchUp = false;

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
      // Verbose only: GramJS reports `connected` after every ~9s ping and
      // `disconnected` for every ping slower than 1s. Confirmed outages are
      // logged by scheduleReconnect.
      tgLog('info', account.accountId, 'socket', 'CONNECTION_STATE', {
        result: state === UpdateConnectionState.connected
          ? 'connected'
          : state === UpdateConnectionState.broken
            ? 'broken'
            : 'disconnected',
      });

      if (state === UpdateConnectionState.connected) {
        handlePrimaryTransportConnected(listener, client);
        return;
      }
      if (state === UpdateConnectionState.broken) {
        scheduleReconnect(listener, 'transport_broken');
        return;
      }
      handlePrimaryTransportDisconnected(listener, client, 'transport_disconnected');
    }, new Raw({ types: [UpdateConnectionState] }));

    // Any server push proves the update stream is alive. Feeds the 15-minute
    // no-update watchdog in the health check.
    client.addEventHandler(async (update: any) => {
      if (update instanceof UpdateConnectionState || listener.client !== client) return;
      listener.lastUpdateAt = Date.now();
    }, new Raw({}));

    // updatesTooLong: Telegram dropped events queued for this connection and
    // expects the client to fetch them with updates.getDifference.
    client.addEventHandler(async () => {
      if (listener.stopped || listener.client !== client || retiredClients.has(client)) return;
      Logger.log(`[TelegramUserListener] updatesTooLong for ${account.accountId}; fetching difference`);
      scheduleReconnectCatchUp(listener, client, 'light');
    }, new Raw({ types: [Api.UpdatesTooLong].filter(Boolean) }));

    // Diagnostic ingress probe: register BEFORE the high-level NewMessage
    // builder so we can distinguish "Telegram did not send the update" from
    // "the builder/handler stalled or rejected it". This handler is read-only
    // and intentionally logs no message content or access hash.
    let lastChannelReceivedLogAt = 0;
    let lastChannelProcessedLogAt = 0;
    client.addEventHandler(async (update: any) => {
      // A reconnect replaces listener.client, but GramJS can still flush
      // updates from the old client while it is closing. Ignore those stale
      // callbacks so one old socket cannot duplicate recovery work.
      if (listener.stopped || listener.client !== client || !client.connected) return;
      try {
        const message = update?.message;
        let chatId = message ? deriveChatIdFromRawMessage(message) : undefined;
        if (!chatId && update instanceof Api.UpdateChannelTooLong && update.channelId != null) {
          chatId = `-100${String(update.channelId)}`;
        }
        const localPts = chatId?.startsWith('-100')
          ? DatabaseService.getInstance()?.getTelegramChannelPts(account.accountId, chatId)
          : undefined;
        if (update instanceof Api.UpdateNewChannelMessage && Date.now() - lastChannelReceivedLogAt >= 30_000) {
          lastChannelReceivedLogAt = Date.now();
          Logger.log(`[TG:socket] CHANNEL_RECEIVED account=${account.accountId} chatId=${chatId} msgId=${message?.id} pts=${update.pts} localPts=${localPts}`);
        }
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

    // Listen for new messages (socket — primary realtime source).
    // The raw handler owns the channel PTS cursor. The high-level NewMessage
    // builder below remains an idempotent delivery fallback: it must continue
    // to persist a live message even while a historical PTS recovery is
    // draining, otherwise a large recovery queue turns every supergroup and
    // channel into a silent conversation until the queue eventually finishes.
    client.addEventHandler(async (update: any) => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
      if (update instanceof Api.UpdateChannelTooLong) {
        if (update.channelId != null) {
          requestChannelRecovery(
            listener,
            `-100${String(update.channelId)}`,
            'UpdateChannelTooLong',
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

      // Do this before PTS validation: a live channel update is often the
      // first place an old/archived dialog exposes its current access hash.
      const rawChannelEntity = cacheRawChannelEntity(account.accountId, update, chatId);

      const db = DatabaseService.getInstance();
      if (!db) throw new Error('Database is unavailable for live channel update');
      const rawMembership = getTelegramMembership(rawChannelEntity);
      const isVerifiedMember = hasVerifiedTelegramChannelMembership(account.accountId, chatId);
      // Telegram can deliver channel updates for old joinable/request peers.
      // Drop them before PTS handling: scheduling a Difference for each of
      // those peers was flooding the queue and delaying real conversations.
      if (rawMembership.state !== 'member' && !isVerifiedMember) {
        tgChannelRealtimeTrace('RAW_DROPPED_NON_MEMBER', account.accountId, {
          chatId,
          msgId: message?.id != null ? String(message.id) : '-',
          membership: rawMembership.state,
          rawEntityClass: rawChannelEntity?.className || '-',
          rawEntityLeft: rawChannelEntity?.left === true,
        });
        return;
      }
      db.preserveChannelRecoveryHistoryStart(account.accountId, chatId);
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
      // A gap means the durable PTS cursor cannot be advanced from this
      // update; doing so would skip the missing range during recovery.  It
      // does *not* make the current message unsafe to deliver, though.  In
      // particular, large channels can keep a recovery job queued for a long
      // time. Returning here made those chats look offline until that queue
      // completed because NewMessage is not guaranteed to be emitted for all
      // UpdateNewChannelMessage variants.
      const recoveryQueued = hasDurableMessageWithoutCursor || hasPtsGap;
      const entities = update._entities instanceof Map
        ? update._entities
        : new Map<any, any>();
      tgChannelRealtimeTrace('RAW_ACCEPTED', account.accountId, {
        chatId,
        msgId: message?.id != null ? String(message.id) : '-',
        messageClass: message?.className || message?.constructor?.name || '-',
        mediaClass: message?.media?.className || '-',
        hasResolvedChat: !!message?.chat,
        rawEntityClass: rawChannelEntity?.className || '-',
        rawEntityLeft: rawChannelEntity?.left === true,
        entityCount: entities.size,
        pts: nextPts,
        ptsCount,
        previousPts,
        hasPtsGap,
        missingCursorWithHistory: hasDurableMessageWithoutCursor,
        recoveryQueued,
      });
      // Freeze the history lower bound before delivering this high-ID message
      // so DifferenceTooLong can still recover from before the gap.
      if (recoveryQueued) {
        tgChannelRealtimeTrace('RECOVERY_QUEUED_LIVE_CONTINUES', account.accountId, {
          chatId,
          msgId: message?.id != null ? String(message.id) : '-',
          reason: hasPtsGap ? 'pts_gap' : 'missing_channel_pts_with_history',
        });
        requestChannelRecovery(
          listener,
          chatId,
          hasPtsGap
            ? `pts_gap:${previousPts}->${nextPts}/${ptsCount}`
            : 'missing_channel_pts_with_history',
        );
      }
      const event = initializeRecoveredMessage(message, client, entities, rawChannelEntity);
      const result = await handleNewMessage(account.accountId, event, client, 'socket');

      tgChannelRealtimeTrace('HANDLE_COMPLETE', account.accountId, {
        chatId,
        msgId: message?.id != null ? String(message.id) : '-',
        persistStatus: result.status,
        recoveryQueued,
      });

      if (result.status === 'failed') {
        throw new Error(`Live channel message ${String(message.id)} failed persistence`);
      }
      // Only a contiguous update may move the cursor. Recovery owns the
      // cursor while a gap/missing legacy cursor is being reconciled.
      if (nextPts > previousPts && !recoveryQueued) {
        db.saveTelegramChannelPts(account.accountId, chatId, nextPts);
        tgChannelRealtimeTrace('PTS_COMMITTED', account.accountId, {
          chatId,
          msgId: message?.id != null ? String(message.id) : '-',
          previousPts,
          pts: nextPts,
        });
        tgLog('info', account.accountId, 'socket', `CURSOR_COMMITTED ${chatId}`, {
          previousPts,
          pts: nextPts,
          ptsCount,
          result: result.status,
        });
      } else if (recoveryQueued) {
        tgChannelRealtimeTrace('PTS_DEFERRED', account.accountId, {
          chatId,
          msgId: message?.id != null ? String(message.id) : '-',
          previousPts,
          pts: nextPts,
          reason: hasPtsGap ? 'pts_gap' : 'missing_channel_pts_with_history',
        });
        tgLog('info', account.accountId, 'socket', `LIVE_DELIVERED_CURSOR_DEFERRED ${chatId}`, {
          previousPts,
          pts: nextPts,
          ptsCount,
          result: result.status,
          reason: hasPtsGap ? 'pts_gap' : 'missing_channel_pts_with_history',
        });
      }
    }, new Raw({ types: [Api.UpdateNewChannelMessage, Api.UpdateChannelTooLong] }));

    client.addEventHandler(async (event: NewMessageEvent) => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
      try {
        const message = event?.message as any;
        const builderChatId = deriveChatIdFromRawMessage(message);
        tgLog('info', account.accountId, 'socket', 'BUILDER_RECEIVED NewMessage', {
          msgClass: message?.className || '-',
          mediaClass: message?.media?.className || '-',
          chatId: builderChatId || '-',
          msgId: message?.id != null ? String(message.id) : '-',
          replyToMsgId: message?.replyTo?.replyToMsgId,
          replyToTopId: message?.replyTo?.replyToTopId,
          forumTopic: message?.replyTo?.forumTopic === true,
        });
        // Do not gate a live supergroup/channel event on the historical PTS
        // recovery queue. That queue can legitimately stay pending for a long
        // time on accounts with thousands of channels. `handleNewMessage` is
        // idempotent, while the raw handler/difference drain remains the only
        // writer of the PTS cursor, so processing this fallback cannot advance
        // the channel cursor. Freeze the separate history boundary for legacy
        // pending rows before writing the newest message as well.
        if (builderChatId?.startsWith('-100')) {
          DatabaseService.getInstance()?.preserveChannelRecoveryHistoryStart(account.accountId, builderChatId);
        }
        const result = await handleNewMessage(account.accountId, event, client, 'socket');
        if (builderChatId?.startsWith('-100') && Date.now() - lastChannelProcessedLogAt >= 30_000) {
          lastChannelProcessedLogAt = Date.now();
          Logger.log(`[TG:socket] CHANNEL_PROCESSED account=${account.accountId} chatId=${builderChatId} msgId=${message?.id} result=${result.status}`);
        }
      } catch (err: any) {
        tgLog('error', account.accountId, 'socket', `Error handling message: ${err.message}`);
      }
    }, new NewMessage({}));

    // Listen for edited messages via Raw event (UpdateEditMessage)
    const rawUpdateHandler = async (update: any) => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
      try {
        const db = DatabaseService.getInstance();
        if (!db) return;

        if (update instanceof Api.UpdateChannelTooLong) {
          if (update.channelId != null) {
            requestChannelRecovery(
              listener,
              `-100${String(update.channelId)}`,
              'difference_UpdateChannelTooLong',
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
          scheduleTypingChannelRecovery(listener, typingChatId);
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
          applyTelegramReactionUpdate(account.accountId, client, update);
          return;
        }

        // Legacy constructor name kept for old layers; current layers send UpdateMessageReactions (peer = channel)
        if ((update as any).className === 'UpdateChannelMessageReactions' ||
            (update as any).CONSTRUCTOR_ID === 0xc2db42ae) {
          const channelId = (update as any).channelId;
          if (channelId == null) return;
          applyTelegramMessageReactions(
            account.accountId, client, `-100${String(channelId)}`, String((update as any).msgId || ''), (update as any).reactions,
            (update as any).topMsgId ? String((update as any).topMsgId) : undefined,
          );
          return;
        }

        if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
          applyTelegramMessageEdit(account.accountId, client, update.message);
          return;
        }

        // Poll results changed (Telegram pushes them to those who viewed the poll / asked for results)
        if ((update as any)?.className === 'UpdateMessagePoll') {
          handleTelegramPollUpdate(account.accountId, update);
          return;
        }

        // Telegram finished fetching a link preview page (a message we sent got WebPagePending): ask for that message now
        if ((update as any)?.className === 'UpdateWebPage' || (update as any)?.className === 'UpdateChannelWebPage') {
          pendingLinkPreviews.pageReady(account.accountId, telegramWebpageIdOf((update as any).webpage));
          return;
        }

        // Handle deleted messages (unsend / recall)
        if (update instanceof Api.UpdateDeleteMessages || update instanceof Api.UpdateDeleteChannelMessages) {
          const ids = update.messages || [];
          // Channels / supergroups: ID per channel (the event carries the channel). Common inbox (private chats + normal groups): ID unique
          // within the account; it must not touch channel posts with the same number: see telegramDeletions.ts.
          const deletedThreadId = update instanceof Api.UpdateDeleteChannelMessages && update.channelId != null
            ? `-100${String(update.channelId)}`
            : undefined;
          const deletedByThread = markTelegramMessagesDeleted(db, account.accountId, ids, deletedThreadId, (line) => Logger.log(line));
          if (deletedThreadId) {
            if (ids.length > 0) {
              EventBroadcaster.emit('event:messagesDeleted', {
                zaloId: account.accountId,
                messageIds: ids.map(String),
                threadId: deletedThreadId,
              });
            }
          } else {
            // Common box: notify the exact conversation that contains the message. Do not emit ids not yet saved (no threadId): the renderer
            // would scan every conversation and wrongly mark channel posts with the same number.
            for (const [threadId, messageIds] of deletedByThread) {
              EventBroadcaster.emit('event:messagesDeleted', { zaloId: account.accountId, messageIds, threadId });
            }
          }
        }

        // ── Read status (telegramReadHistory.ts): Inbox = I have read the incoming messages (from another machine) → unread count per Telegram;
        //    Outbox = THE OTHER SIDE has read the messages I sent → "đã xem" (seen). History = private chat / normal group, Channel = supergroup / channel.
        const readUpdate = parseTelegramReadUpdate(update, getCanonicalChatId);
        if (readUpdate) {
          try {
            const result = applyTelegramReadUpdate(db, account.accountId, readUpdate);
            if (readUpdate.direction === 'outbox') {
              // "đã xem tới tin số…" (seen up to message no. …) mark of the conversation → ✓✓ tick next to the times of my sent messages (services/receipts)
              recordPeerReceipt(account.accountId, readUpdate.chatId, {
                readMaxId: readUpdate.maxId,
                readTs: messageTimestampById(account.accountId, readUpdate.chatId, [String(readUpdate.maxId)], 'telegram_user'),
              });
              EventBroadcaster.emit('event:seen', {
                zaloId: account.accountId,
                threadId: readUpdate.chatId,
                msgId: String(readUpdate.maxId),
                channel: 'telegram_user',
              });
            } else {
              // Has contactId + unread: the renderer edits only that conversation (unread 0) instead of reloading the whole list
              if (result.unread !== undefined) {
                EventBroadcaster.emit('db:unreadChanged', {
                  zaloId: account.accountId,
                  contactId: readUpdate.chatId,
                  unread: result.unread,
                  source: 'telegram_read_inbox',
                });
              }
              if (result.mentionCleared) {
                EventBroadcaster.emit('db:contactFlagsChanged', {
                  ownerZaloId: account.accountId,
                  contactId: readUpdate.chatId,
                  flags: { has_mention: 0 },
                });
              }
            }
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] Read update (${readUpdate.direction}) error: ${err.message}`);
          }
          return;
        }

        // ── Pinned messages ──────────────────────────────────────────────────
        // Applied to the local pin list without a network call: Telegram pins every channel post in its linked discussion
        // group, and a full pin sync per update used to download the group's whole pin history again for each post.
        if (update instanceof Api.UpdatePinnedMessages) {
          try {
            const peer = (update as any).peer;
            if (peer) applyTelegramPinnedUpdate(account.accountId, getCanonicalChatId(peer), (update as any).messages, !!(update as any).pinned);
          } catch (err: any) {
            Logger.warn(`[TelegramUserListener] PinnedMessages update failed: ${err.message}`);
          }
          return;
        }

        if (update instanceof Api.UpdatePinnedChannelMessages) {
          try {
            if (update.channelId != null) {
              applyTelegramPinnedUpdate(account.accountId, `-100${String(update.channelId)}`, (update as any).messages, !!(update as any).pinned);
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
        // `otherUpdates` contains side-effect updates (typing, read state,
        // reactions, edits...), not the message stream itself. One malformed
        // local DB update must not abort GetDifference and force a broad,
        // rate-limited messages.GetHistory replay on every reconnect.
        const updateType = String(update?.className || update?.constructor?.name || 'unknown');
        Logger.warn(`[TelegramUserListener] Raw event ${updateType} error: ${err.message}`);
        return;
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
        Api.UpdateReadChannelInbox,
        Api.UpdateReadChannelOutbox,
        Api.UpdatePinnedMessages,
        Api.UpdatePinnedChannelMessages,
        Api.UpdateUserStatus,
        Api.UpdateFolderPeers,
        Api.UpdateNotifySettings,
        Api.UpdateChatDefaultBannedRights,
        // Channel reactions - handled via className/CONSTRUCTOR_ID check in handler
        (Api as any).UpdateChannelMessageReactions,
        (Api as any).UpdateMessagePoll,
        (Api as any).UpdateWebPage,
        (Api as any).UpdateChannelWebPage,
      ].filter(Boolean),
    }));

    // Phase C (P0.4): Separate raw handler for new message updates to catch
    // MessageService that the NewMessage high-level event builder skips.
    // Normal messages are de-duplicated by idempotent persistence.
    client.addEventHandler(async (update: any) => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
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

    // Telegram call: report an incoming call (answer on the phone / Telegram, or decline) and when it ends.
    client.addEventHandler(async (update: any) => {
      if (listener.stopped || listener.client !== client) return;
      try {
        await handleTelegramPhoneCallUpdate(account.accountId, client, update?.phoneCall);
      } catch (err: any) {
        tgLog('warn', account.accountId, 'socket', `UpdatePhoneCall error: ${err.message}`);
      }
    }, new Raw({ types: [(Api as any).UpdatePhoneCall].filter(Boolean) }));

    Logger.log(`[TelegramUserListener] Connected for ${account.accountId}`);
    startHealthCheck(listener);
    startChannelPoller(listener);

    // Recover MTProto updates before recording the next global cursor. This
    // remains background work so a slow history backfill never blocks UI login.
    // Running it as this client's catch-up gives a failed first pass the same
    // backoff retry as a reconnect, instead of leaving the account without any
    // catch-up until the next outage.
    scheduleReconnectCatchUp(listener, client, 'full');

    // Right after the app opens: the tasks below (Telegram calls + bulk DB writes) wait until the app settles (utils/startup/startupSettle);
    // a reconnect during the session still runs immediately, as before.
    whenStartupSettled(() => {
      if (listener.stopped || listener.client !== client || !client.connected) return;
      // Channel recovery queue + conversation list scan held at startup: run now, do not wait for the next timer pass
      schedulePendingChannelRecovery(listener);
      refreshRecentChannelDialogWatch(listener);
      // Conversations with stored messages but no last-message time (DB only, no Telegram call)
      repairTelegramContactLastMessages(account.accountId).catch((err: any) => {
        Logger.warn(`[TelegramUserListener] Last message repair failed for ${account.accountId}: ${err?.message || err}`);
      });

      // Establish membership separately from the bounded history sync. This is
      // required before a socket update from a minimally-described channel can
      // be trusted, and cleans old unjoined rows out of the normal inbox.
      setTimeout(() => {
        if (listener.stopped || listener.client !== client || !client.connected) return;
        reconcileTelegramDialogMembership(account.accountId, client).catch(() => {});
      }, 1_000);

      // Check isForum for unchecked groups (background, non-blocking)
      checkForumForNewGroups(account.accountId).catch(err => {
        Logger.warn(`[TelegramUserListener] checkForumForNewGroups failed: ${err.message}`);
      });
    });

    // Broadcast connection status
    EventBroadcaster.emit('event:connected', {
      zaloId: account.accountId,
      accountInfo: { channel: 'telegram_user' },
    });
  } catch (err: any) {
    Logger.error(`[TelegramUserListener] Connection failed for ${account.accountId}: ${err.message}`);
    // GramJS starts its update loop even when connect() fails, and a timed-out
    // connect keeps retrying in the background. Shut this attempt down.
    if (listener.client === client) listener.client = null;
    await retireTelegramClient(client, 'connect_failed');
    scheduleReconnect(listener, 'connect', err);
    throw err;
  }
}

// ─── Service Message Handling ─────────────────────────────────────────────────
// GramJS delivers service messages (join/leave/title/photo/pin) as MessageService
// inside NewMessageEvent. They are NOT a separate UpdateServiceMessage type.

type TelegramServiceMember = { id: string; dName: string; avatar: string };

/** Resolve the actor of a Telegram service message before persisting it. Service
 * actions carry only peer IDs, and a newly joined person is usually not in the
 * group-member cache yet. Keeping the member ID with the system message lets
 * the renderer display their name and open the same profile popup as a mention. */
async function resolveTelegramServiceMember(
  accountId: string,
  chatId: string,
  userId: string,
  db: DatabaseService,
  client?: TelegramClient,
  entityHint?: any,
): Promise<TelegramServiceMember | null> {
  if (!userId) return null;

  // MessageActionChatAddUser.users is normally a vector of bare user IDs;
  // only a real Telegram entity is safe to pass through as a hydration hint.
  let entity = entityHint?.className ? entityHint : undefined;
  if (!entity && client) {
    try {
      entity = await hydrateTelegramIdentity(accountId, client, userId, chatId);
    } catch {
      // A deleted/private account can be unavailable to getEntity. Preserve its
      // ID so the message is still attributable and clickable in the UI.
    }
  } else if (entity && client) {
    try {
      await hydrateTelegramIdentity(accountId, client, userId, chatId, entity);
    } catch {}
  }

  const cached = db.queryOne<any>(
    `SELECT display_name, avatar FROM page_group_member
     WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
    [accountId, chatId, userId],
  );
  const peer = db.getTelegramPeer(accountId, userId);
  const entityName = entity
    ? ([entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.title || entity.username || '')
    : '';
  const displayName = entityName || cached?.display_name || peer?.display_name || peer?.username || userId;
  return { id: userId, dName: displayName, avatar: cached?.avatar || '' };
}

async function handleServiceMessage(
  accountId: string,
  message: any,
  client?: TelegramClient,
  source: TelegramIngressSource = 'socket',
): Promise<ProcessResult> {
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

  // 1-1 call: call card in the conversation (not a system notice line of a group)
  if (className === 'MessageActionPhoneCall') {
    return persistTelegramCallServiceMessage(accountId, message, source);
  }

  let systemText = '';
  let groupEventType = '';
  let systemMembers: TelegramServiceMember[] = [];

  if (className === 'MessageActionChatAddUser') {
    const addedUsers = action.users || [];
    if (addedUsers.length > 0) {
      systemMembers = (await Promise.all(addedUsers.map((user: any) => {
        const userId = String(user?.id || user?.userId || user?.valueOf?.() || '');
        return resolveTelegramServiceMember(accountId, serviceChatId, userId, db, client, user);
      }))).filter((member): member is TelegramServiceMember => !!member);
      const names = systemMembers.map(member => member.dName).filter(Boolean);
      systemText = names.length > 0
        ? tr('{{v1}} đã được thêm vào nhóm', { v1: names.join(', ') })
        : tr('Thành viên đã được thêm vào nhóm');
    } else {
      systemText = tr('Thành viên mới tham gia nhóm');
    }
    groupEventType = 'member_join';
  } else if (className === 'MessageActionChatJoinedByLink') {
    // The action itself contains no user. Telegram identifies the joiner as
    // MessageService.fromId/senderId, so hydrate that peer rather than relying
    // on the older group-member cache.
    const senderId = getCanonicalChatId(message?.fromId)
      || String(message?.senderId?.valueOf?.() || '');
    let senderEntity: any;
    try { senderEntity = await message.getSender?.(); } catch {}
    const sender = await resolveTelegramServiceMember(
      accountId, serviceChatId, senderId, db, client, senderEntity,
    );
    if (sender) systemMembers = [sender];
    systemText = sender?.dName
      ? tr('{{dName}} tham gia nhóm qua link mời', { dName: sender.dName })
      : tr('Thành viên tham gia qua link mời');
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
          `SELECT display_name FROM telegram_peers WHERE owner_zalo_id = ? AND peer_id = ?`,
          [accountId, deletedUserId]
        );
        deletedUserName = peer?.display_name || '';
      }
    }
    // Check if self-leave or kicked by admin
    const isSelfLeave = deletedUserId === String(message?.senderId?.valueOf?.() || '');
    systemText = deletedUserName
      ? (isSelfLeave ? tr('{{deletedUserName}} đã rời khỏi nhóm', { deletedUserName }) : tr('{{deletedUserName}} đã bị xoá khỏi nhóm', { deletedUserName }))
      : (isSelfLeave ? tr('Thành viên đã rời khỏi nhóm') : tr('Thành viên đã bị xoá khỏi nhóm'));
    groupEventType = 'member_leave';
  } else if (className === 'MessageActionChatEditTitle') {
    systemText = tr('Tên nhóm đã đổi thành "{{v1}}"', { v1: action.title || '' });
    groupEventType = 'title_change';
    if (serviceChatId) {
      EventBroadcaster.emit('event:groupInfoUpdate', {
        zaloId: accountId,
        groupId: serviceChatId,
        name: action.title || '',
      });
    }
  } else if (className === 'MessageActionChatEditPhoto') {
    systemText = tr('Ảnh nhóm đã được thay đổi');
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
    const topicTitle = action.title || tr('chủ đề mới');
    systemText = tr('Đã tạo chủ đề "{{topicTitle}}"', { topicTitle });
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
      systemText = tr('Chủ đề đã đổi tên thành "{{topicTitle}}"', { topicTitle });
    } else if (closed === true) {
      systemText = tr('Chủ đề đã được đóng');
    } else if (closed === false) {
      systemText = tr('Chủ đề đã được mở lại');
    } else if (hidden === true) {
      systemText = tr('Chủ đề General đã được ẩn');
    } else if (hidden === false) {
      systemText = tr('Chủ đề General đã được hiện lại');
    } else {
      systemText = tr('Chủ đề đã được chỉnh sửa');
    }
    EventBroadcaster.emit('event:forumTopicsChanged', {
      zaloId: accountId,
      threadId: serviceChatId,
    });
  } else {
    // Channel / group created, auto-delete timer changed, group call… (generic sentence, as when saved from history)
    systemText = describeTelegramServiceAction(message);
    if (!systemText) Logger.log(`[TelegramUserListener] Service message: ${className} in ${serviceChatId}`);
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
            (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, status, channel, attachments, topic_id)
          VALUES (?, ?, ?, ?, 'system', ?, 'system', ?, 0, 'received', 'telegram_user', ?, ?)
        `, [serviceMsgId, accountId, serviceChatId, serviceChatId.startsWith('-') ? 1 : 0, systemText, serviceTimestamp, JSON.stringify(systemMembers), getForumTopicId(message)]);

        // Emit group event only for new service messages
        if (groupEventType && (groupEventType === 'member_join' || groupEventType === 'member_leave')) {
          EventBroadcaster.emit('event:groupEvent', {
            zaloId: accountId,
            // Without the channel the workflow engine never started "Sự kiện nhóm Telegram" (and Zalo group triggers got it)
            channel: 'telegram_user',
            groupId: serviceChatId,
            eventType: groupEventType,
            data: { action: className, updateMembers: systemMembers },
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
/**
 * My own messages: sent messages, and every message in Saved Messages (chat with myself). A message forwarded there is stored with
 * out=false (the Telegram app shows it as an incoming message), so treated as incoming it would become unread, "Chưa trả lời" (Unanswered), and trigger the auto-reply workflow
 * right in the chat with myself.
 */
function isOwnTelegramMessage(message: any, accountId: string, chatId: string): boolean {
  return !!message?.out || (!!chatId && chatId === accountId);
}

async function handleNewMessage(accountId: string, event: NewMessageEvent, client?: TelegramClient, source: TelegramIngressSource = 'socket'): Promise<ProcessResult> {
  const message = event.message;
  if (!message) return { status: 'ignored' };

  // ── Service messages (join/leave/title/photo/pin) ────────────────────
  // GramJS delivers these as NewMessageEvent where message is a MessageService.
  // Handle them separately from normal messages.
  if ((message as any).className === 'MessageService') {
    const result = await handleServiceMessage(accountId, message, client, source);
    const serviceChatId = result.chatId || deriveChatIdFromRawMessage(message) || '';
    if (serviceChatId.startsWith('-100')) {
      tgChannelRealtimeTrace('SERVICE_MESSAGE_HANDLED', accountId, {
        source,
        chatId: serviceChatId,
        msgId: String(message.id || '-'),
        action: (message as any).action?.className || '-',
        persistStatus: result.status,
      });
    }
    return result;
  }

  const messageId = String(message.id);
  if (!messageId) return { status: 'ignored' };

  // ── Phase B: peerId-first identity (P1.1 fix) ────────────────────────
  // Derive identity from peerId BEFORE trying getChat(). If getChat() fails
  // (e.g. cold entity cache after restart), we still persist the message.
  const rawIdentity = deriveMessageIdentity(message);

  // GramJS getChat() may issue channels.GetChannels even when _chat exists
  // (it checks whether the entity HAS a `min` field). Do not put that RPC,
  // its retries, or FLOOD_WAIT in front of persistence of a socket message.
  const suppliedChat = (event as any).__deplaoResolvedChat || null;
  let chat: any = suppliedChat || message.chat || null;
  if (!chat && source !== 'socket') {
    try { chat = await message.getChat(); } catch {}
  }

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
    let membershipState = 'unknown';
    let membershipSource = 'db_cache';
    let cachedMembershipState = '';
    if (chat) {
      const membership = getTelegramMembership(chat);
      isMember = membership.state === 'member';
      membershipState = membership.state;
      membershipSource = suppliedChat ? 'raw_update_entity' : 'message_chat';
      // A Channel entity embedded in a socket update is often minimal and
      // may carry a stale `left` flag. The dialog snapshot is our durable
      // membership authority: it was written from messages.GetDialogs, not
      // inferred from a message. Let a known member state override only that
      // stale negative entity state; it can never admit a known joinable peer.
      if (!isMember) {
        const dbContact = DatabaseService.getInstance()?.queryOne<any>(
          `SELECT telegram_membership_state, telegram_state_updated_at FROM contacts
           WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
          [accountId, chatId],
        );
        cachedMembershipState = String(dbContact?.telegram_membership_state || '');
        const hasVerifiedDialogState = Number(dbContact?.telegram_state_updated_at || 0) > 0;
        if (cachedMembershipState === 'member' && hasVerifiedDialogState) {
          isMember = true;
          membershipState = 'member';
          membershipSource = `dialog_cache_override:${membershipSource}`;
        }
      }
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
      membershipState = String(dbContact?.telegram_membership_state || 'unknown');
    }
    if (!isMember) {
      // Expected for channels/groups the account no longer belongs to. A
      // history backfill can contain thousands of them, so keep that path
      // quiet; live/difference records remain visible for diagnostics.
      if (chatId.startsWith('-100') && (source === 'socket' || source === 'channel_difference')) {
        tgChannelRealtimeTrace('MEMBERSHIP_GATE_IGNORED', accountId, {
          chatId,
          msgId: messageId,
          source,
          membership: membershipState,
          membershipSource,
          cachedMembership: cachedMembershipState || '-',
          peerKind: rawIdentity.peerKind,
        });
      }
      return { status: 'ignored', chatId, messageId };
    }
    if (chatId.startsWith('-100')) {
      // Heal only the membership cache when the authoritative raw Channel
      // entity says this account is a member. Do not change is_in_others here:
      // that field also represents the user's archive/folder choice.
      if (source === 'socket' && membershipSource === 'raw_update_entity') {
        try {
          DatabaseService.getInstance()?.run(
            `UPDATE contacts
             SET telegram_membership_state = 'member', telegram_join_action = 'none', telegram_state_updated_at = ?
             WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
            [Date.now(), accountId, chatId],
          );
        } catch {
          // The live message must remain deliverable even if cache healing fails.
        }
      }
      tgChannelRealtimeTrace('MEMBERSHIP_ACCEPTED', accountId, {
        chatId,
        msgId: messageId,
        source,
        membership: membershipState,
        membershipSource,
        peerKind: rawIdentity.peerKind,
      });
    }
  }

  const threadType = rawIdentity.threadType;
  const topicId = rawIdentity.topicId;

  // Cache entity if resolved (for access_hash and metadata)
  if (chat) {
    cacheTelegramPeer(accountId, chatId, chat);
  }

  const senderId = String(message.senderId?.valueOf() || '');
  const isSelf = isOwnTelegramMessage(message, accountId, chatId);
  const timestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;

  // Get sender name — best-effort, not blocking identity
  let senderName = '';
  try {
    let sender = message.sender;
    if (!sender && source !== 'socket') sender = await message.getSender();
    if (!sender && senderId && client && source !== 'socket') {
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
      if (senderId && client && source !== 'socket') await hydrateTelegramIdentity(
        accountId, client, senderId, threadType === 1 ? chatId : undefined, sender,
      );
    }
  } catch (err: any) {
    tgLog('warn', accountId, source, `Sender hydration failed for msg ${messageId}`, {
      chatId, senderId, error: err?.message,
    });
  }

  if (!senderName && senderId) {
    senderName = DatabaseService.getInstance()?.getTelegramPeer(accountId, senderId)?.display_name || '';
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
          const senderName = resolveTelegramQuoteSenderName(db, accountId, chatId, orig.sender_id);
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

  // Show the placeholder only for audio (it has meaning); otherwise empty when there is no caption
  const displayContent = telegramDisplayContent(content, msgType);

  const inlineButtons = parseInlineButtons(message);

  const result = persistTelegramMessage(db, {
    msgId: messageId, accountId, chatId, threadType,
    senderId, content: displayContent, msgType, timestamp,
    isSelf, attachments, replyToId, quoteData, topicId, reactions,
    inlineButtons,
  });

  if (chatId.startsWith('-100')) {
    tgChannelRealtimeTrace('DB_PERSISTED', accountId, {
      source,
      chatId,
      msgId: messageId,
      persistStatus: result.status,
      peerKind: rawIdentity.peerKind,
      msgType,
      isSelf,
      topicId: topicId || '-',
    });
  }

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
    const preview = getTelegramMessagePreview(msgType, content);
    const lastMessagePreview = (isGroup && !isSelf && senderName)
      ? `${senderName}: ${preview}`
      : preview;

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
    // Saved messages (chat with myself): not counted as unread, no notification (like Telegram); messages in it are mine
    // (isOwnTelegramMessage)
    const savedMessages = !isGroup && chatId === accountId;

    // Comment in a discussion group not yet joined (e.g. a sticker just sent): do not create a conversation for the group
    const commentOnly = isGroup && skipCommentOnlyConversation(db, accountId, chatId);
    if (!commentOnly) db.run(`
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
      isSelf || savedMessages ? 0 : 1, lastMessagePreview, timestamp,
      shouldBeInOthers ? 1 : 0, peerIsBot,
      isSelf || savedMessages ? 0 : 1,
    ]);

    // If this is a new group/channel with no real name (just ID), resolve info async
    if (isGroup && chatTitle === chatId && client && !commentOnly) {
      resolveNewGroupInfo(accountId, client, chatId).catch(() => {});
    }

    // Fetch avatar for a new contact (background, non-blocking)
    if (client && !isSelf && !savedMessages && chat && !commentOnly) {
      fetchNewContactAvatar(accountId, client, chatId, chat).catch(() => {});
    }

    // Emit is synchronous: WorkflowEngine's before-send hook receives this
    // exact payload before the renderer does. Trace both sides so a copied log
    // establishes whether a missing automation is ingress, DB, or workflow.
    if (chatId.startsWith('-100')) {
      tgChannelRealtimeTrace('EVENT_MESSAGE_EMIT_START', accountId, {
        source,
        chatId,
        msgId: messageId,
        peerKind: rawIdentity.peerKind,
        msgType,
        isChannel: rawIdentity.peerKind === 'channel',
      });
    }
    // Broadcast to UI/workflow — only for new messages
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: {
        channel: 'telegram_user',
        type: threadType,
        threadId: chatId,
        isSelf,
        _silentNotification: suppressNotification || savedMessages,
        // UI: shown in the comments section, but does not create a conversation or count as unread
        ...(commentOnly ? { _commentOnly: true } : {}),
        data: {
          uidFrom: senderId,
          idTo: chatId,
          msgId: messageId,
          content,
          preview,
          msgType,
          channel: 'telegram_user',
          isChannel: rawIdentity.peerKind === 'channel',
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
    if (chatId.startsWith('-100')) {
      tgChannelRealtimeTrace('EVENT_MESSAGE_EMIT_DONE', accountId, {
        source,
        chatId,
        msgId: messageId,
      });
    }
    tgLog('info', accountId, source, `UI_EMITTED msg ${messageId}`, {
      chatId,
      topicId: topicId || '-',
      msgType,
    });
  } else if (result.status === 'updated') {
    // Attachments were merged into existing message — emit event so UI picks it up
    if (chatId.startsWith('-100')) {
      tgChannelRealtimeTrace('EVENT_MESSAGE_EMIT_START', accountId, {
        source,
        chatId,
        msgId: messageId,
        persistStatus: 'updated',
        peerKind: rawIdentity.peerKind,
        msgType,
        isChannel: rawIdentity.peerKind === 'channel',
      });
    }
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: {
        channel: 'telegram_user',
        type: threadType,
        threadId: chatId,
        isSelf,
        _silentNotification: suppressNotification,
        ...(rawIdentity.peerKind !== 'user' && skipCommentOnlyConversation(db, accountId, chatId) ? { _commentOnly: true } : {}),
        data: {
          uidFrom: senderId,
          idTo: chatId,
          msgId: messageId,
          content,
          preview: getTelegramMessagePreview(msgType, content),
          msgType,
          channel: 'telegram_user',
          isChannel: rawIdentity.peerKind === 'channel',
          ts: String(timestamp),
          dName: senderName,
          attachments,
          // Messages of a topic / comment must return to their own timeline (not leak into the common flow)
          ...(topicId ? { topicId } : {}),
        },
      },
    });
    if (chatId.startsWith('-100')) {
      tgChannelRealtimeTrace('EVENT_MESSAGE_EMIT_DONE', accountId, {
        source,
        chatId,
        msgId: messageId,
        persistStatus: 'updated',
      });
    }
    tgLog('info', accountId, source, `UI_EMITTED (updated) msg ${messageId}`, { chatId, msgType });
  } else if (result.status === 'duplicate') {
    // Duplicate: do NOT emit a UI event.
    // Temp message in the store already has local_paths and displays correctly.
    // Real message in the DB has metadata (attachments, reactions) from the socket echo.
    // Emit event → renderer swaps temp for real → local_paths lost → "Đang tải về..." (Downloading...).
    tgLog('info', accountId, source, `dedup msg ${messageId} (kept temp, DB enriched)`, { chatId });
    // For self-sent messages: socket echo merges attachments into DB, but UI store needs update
    // Emit event so addMessage can merge attachments into existing temp/real message
    if (isSelf && attachments && attachments.length > 0) {
      EventBroadcaster.emit('event:message', {
        zaloId: accountId,
        channel: 'telegram_user',
        message: {
          channel: 'telegram_user',
          type: threadType,
          threadId: chatId,
          isSelf,
          _silentNotification: true,
          // Echo of a comment just sent (image / file) in a discussion group not yet joined: do not create a conversation
          ...(rawIdentity.peerKind !== 'user' && skipCommentOnlyConversation(db, accountId, chatId) ? { _commentOnly: true } : {}),
          data: {
            uidFrom: senderId,
            idTo: chatId,
            msgId: messageId,
            content,
            preview: getTelegramMessagePreview(msgType, content),
            msgType,
            channel: 'telegram_user',
            isChannel: rawIdentity.peerKind === 'channel',
            ts: String(timestamp),
            dName: senderName,
            attachments,
            ...(topicId ? { topicId } : {}),
          },
        },
      });
      tgLog('info', accountId, source, `UI_EMITTED (self-dedup with attachments) msg ${messageId}`, { chatId, msgType });
    }
  }

  // Emit the message before queuing its media. A small sticker can finish
  // downloading before the renderer has inserted the message into its cache;
  // in that ordering event:localPath is dropped from the live timeline and the
  // sticker only appears after reopening the conversation from the DB.
  if (result.status === 'inserted' && source === 'socket' && senderId && client) {
    // Name/avatar enrichment has its own event and may finish after the bubble.
    hydrateTelegramIdentity(accountId, client, senderId, threadType === 1 ? chatId : undefined, message.sender)
      .catch(() => {});
  }
  if (result.status === 'inserted') handleRichMessageExtras(accountId, client, chatId, message);
  if (result.status === 'inserted' && (message as any).media && client) {
    tgDebugLog(`[TG:handleNew] STEP6 msgId=${messageId} hasMedia=true isSelf=${isSelf} source=${source} msgType=${msgType} result=${result.status}`);
    downloadMediaForMessage(accountId, client, message, messageId, msgType, chatId).catch(err => {
      Logger.error(`[TG:download] QUEUE_FAILED msgId=${messageId} error=${err.message}`);
    });
  }
  return result;
}

// ─── Media Download ──────────────────────────────────────────────────────────

/**
 * Download media from a Telegram message and update local_paths in the DB.
 * Runs in the background; does not block message processing.
 */
/** Serialize and deduplicate all exported-DC downloads for one account (open conversation first, newest first). */
function queueTelegramDownload<T>(
  accountId: string,
  resourceKey: string,
  operation: (run: TelegramDownloadRun) => Promise<T>,
  opts: TelegramDownloadOptions = {},
): Promise<T> {
  return telegramDownloads.enqueue(accountId, resourceKey, operation, opts);
}

/**
 * The Telegram conversation open in the UI (the renderer reports it when the conversation / account changes; empty = no Telegram
 * conversation open) → that account's download queue downloads this conversation's files first.
 */
export function setTelegramDownloadFocus(accountId?: string | null, threadId?: string | null): void {
  telegramDownloads.setFocus(accountId || null, threadId || null);
}

function downloadProfilePhotoQueued(
  accountId: string,
  client: TelegramClient,
  peer: any,
  resourceId: string,
  isBig: boolean,
  opts: TelegramDownloadOptions = {},
): Promise<any> {
  return queueTelegramDownload(
    accountId,
    `avatar:${resourceId}:${isBig ? 'big' : 'small'}`,
    () => client.downloadProfilePhoto(peer, { isBig }),
    opts,
  );
}

/**
 * What to download for a message. A link preview (MessageMediaWebPage) only shows its photo,
 * but GramJS downloadMedia(message) picks `webpage.document || webpage.photo`: for YouTube links
 * that is the whole video (100–800 MB), which was saved as images/*.jpg and rendered as a broken
 * image — and every repair attempt downloaded it again.
 */
function getTelegramDownloadTarget(message: any): any {
  const media = message?.media;
  if (media?.className === 'MessageMediaWebPage') {
    const photo = media?.webpage?.photo;
    if (photo?.className === 'Photo') return photo;
  }
  return message;
}

/** JPEG / PNG / GIF / WebP signature: a "photo" download must decode in <img>. */
function isImageBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') return true;
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head === 'GIF8') return true;
  return head === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** Message with a download progress ring on the bubble (renderer: Telegram video): event:mediaProgress. */
const PROGRESS_MEDIA_TYPES = new Set(['video', 'gif', 'video_note']);

/** File size of the message (video / document, including the video in a link card): the progress ring knows the total as soon as it is queued. */
function telegramMediaBytes(message: any): number {
  const media = message?.media;
  const size = (media?.document || media?.webpage?.document)?.size;
  const bytes = Number(size?.toString?.() ?? size ?? 0);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** Message time (ms): order in the download queue, newest first. Without it → the time it was queued. */
function telegramMessageTimeMs(message: any): number | undefined {
  const seconds = Number(message?.date || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Queues a message's files in the account's download queue. Default is background work (realtime messages, catch-up, history): the queue still
 * puts the message first if it belongs to the open conversation. UI requests (bubble, pinned message, quote) → `visible`; a click to download → `urgent`.
 */
function downloadMediaForMessage(
  accountId: string,
  client: TelegramClient,
  message: any,
  messageId: string,
  msgType: string,
  threadId: string,
  opts: Pick<TelegramDownloadOptions, 'urgency' | 'sortKey'> = {},
): Promise<string | null> {
  const resourceKey = `media:${threadId}:${messageId}`;
  // Video: report "waiting to download" as soon as it is queued (the account's queue runs one at a time) → the bubble shows 0 / 5.0 MB
  if (PROGRESS_MEDIA_TYPES.has(msgType) && !telegramDownloads.has(accountId, resourceKey)) {
    mediaProgressReporter(accountId, threadId, messageId, telegramMediaBytes(message)).queued();
  }
  return queueTelegramDownload(
    accountId,
    resourceKey,
    run => downloadMediaForMessageNow(accountId, client, message, messageId, msgType, threadId, run),
    { threadId, urgency: opts.urgency, sortKey: opts.sortKey ?? telegramMessageTimeMs(message) },
  );
}

async function downloadMediaForMessageNow(
  accountId: string,
  client: TelegramClient,
  message: any,
  messageId: string,
  msgType: string,
  threadId: string,
  run?: TelegramDownloadRun,
): Promise<string | null> {
  tgDebugLog(`[TG:download] START msgId=${messageId} msgType=${msgType} threadId=${threadId}`);
  const db = DatabaseService.getInstance();
  if (!db) return null;
  // Video: partial progress (GramJS progressCallback) → "2.1 / 5.0 MB" on the bubble; completion or error is reported below
  const progress = PROGRESS_MEDIA_TYPES.has(msgType)
    ? mediaProgressReporter(accountId, threadId, messageId, telegramMediaBytes(message))
    : null;

  try {
    // Download media buffer from GramJS (link preview → only its photo, never the linked document)
    const target = getTelegramDownloadTarget(message);
    // File / video: the progress callback reports progress (video) and lets the queue pause the background pass when the open conversation needs
    // the file (throws TelegramDownloadPreempted at the next chunk). Small image: download once, call downloadMedia(target) as before.
    const yieldable = !!run && msgType !== 'photo' && target === message;
    const mediaResult = progress || yieldable
      ? await client.downloadMedia(target, {
        progressCallback: (downloaded: any, total: any) => {
          run?.progress(downloaded, total);
          progress?.progress(downloaded, total);
        },
      })
      : await client.downloadMedia(target);
    if (!mediaResult || mediaResult.length === 0) {
      tgLog('warn', accountId, 'history', 'MEDIA_DOWNLOAD_EMPTY', {
        chatId: threadId,
        messageId,
        msgType,
      });
      progress?.failed();
      return null;
    }
    const buffer = Buffer.from(mediaResult);
    if (msgType === 'photo' && !isImageBuffer(buffer)) {
      // Never store a video/document as images/*.jpg (broken <img>, huge file).
      tgLog('warn', accountId, 'history', 'MEDIA_DOWNLOAD_NOT_IMAGE', {
        chatId: threadId,
        messageId,
        bytes: buffer.length,
      });
      return null;
    }

    // Determine file extension
    const ext = getMediaExtension(msgType, message);
    const filename = `${accountId}_${threadId}_${messageId}${ext}`;

    // Save to disk
    const localPath = await saveMediaToDisk(buffer, filename, msgType);
    if (!localPath) {
      progress?.failed();
      return null;
    }

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
    progress?.done(); // after event:localPath: the bubble gets its file before the progress ring is removed
    return localPath;
  } catch (err: any) {
    if (isTelegramDownloadPreempted(err)) {
      // Yields to the open conversation: this pass goes back to the queue and downloads again from the start later → the bubble returns to "đang chờ tải" (waiting to download)
      progress?.queued();
      throw err;
    }
    Logger.error(`[TG:download] FAILED msgId=${messageId} error=${err.message}`);
    tgLog('warn', accountId, 'history', 'MEDIA_DOWNLOAD_FAILED', {
      chatId: threadId,
      messageId,
      msgType,
      error: err?.message || String(err),
    });
    progress?.failed();
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

    // Determine subfolder by type: saved in the same structure as Zalo media
    let subfolder = 'files';
    if (msgType === 'photo') subfolder = 'images';
    else if (msgType === 'video') subfolder = 'videos';
    else if (msgType === 'audio') subfolder = 'voices';
    else if (msgType === 'sticker') subfolder = 'stickers';

    // Extract accountId from filename (format: accountId_threadId_msgId.ext)
    const parts = filename.split('_');
    const accountId = parts[0] || 'unknown';

    const mediaDir = path.join(baseDir, accountId, subfolder);
    await fs.promises.mkdir(mediaDir, { recursive: true });

    // Asynchronous: writing a video of several tens of MB synchronously blocks the main process for a second when the disk is busy
    const filePath = path.join(mediaDir, filename);
    await writeMediaFile(filePath, buffer);

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
      const photo = await downloadProfilePhotoQueued(accountId, client, entity, `group:${chatId}`, false, { threadId: chatId });
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
 * Fetch avatar for a new contact when a message is received.
 * Fetches only if the contact has no avatar yet.
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
    // Check whether it already has an avatar
    const existing = db.queryOne<any>(
      `SELECT avatar_url, display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, chatId]
    );
    if (existing?.avatar_url) {
      markAvatarSuccess(accountId, chatId); // Reset the cache if it exists
      return;
    }

    // Check cache: tried recently, or out of attempts
    if (!shouldFetchAvatar(accountId, chatId)) return;
    markAvatarFetched(accountId, chatId);

    // Download avatar
    let avatarUrl = '';
    try {
      const photo = await downloadProfilePhotoQueued(accountId, client, chat, `chat:${chatId}`, false, { threadId: chatId });
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

      markAvatarSuccess(accountId, chatId); // Reset cache on success
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_avatar' });
    }

    // Fetch extra contact info (username, phone) if it is a user
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
 * Fetch messages received while offline.
 * Telegram stores messages on the server, so just query again.
 * Runs in the background; does not block the connect process.
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
  // Messages of the open conversation first (order within each conversation kept), the whole pass runs on a pace
  const focusedChat = focusedTelegramChat(accountId);
  const ordered = focusedChat
    ? focusFirst(messages || [], message => deriveChatIdFromRawMessage(message) === focusedChat)
    : messages || [];
  for (const message of ordered) {
    if (!message?.id || !message?.peerId) continue;
    const event = initializeRecoveredMessage(message, client, entities);
    const result = await handleNewMessage(accountId, event, client, source);
    if (result.status === 'failed') {
      throw new Error(`Failed to persist Telegram message ${String(message.id)}`);
    }
    await paceCatchUp();
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
        for (const update of difference.otherUpdates || []) {
          await rawHandler(update);
          await paceCatchUp();
        }
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

async function fetchTelegramUpdateState(client: TelegramClient): Promise<TelegramUpdateState> {
  const { Api } = require('telegram');
  const state = await client.invoke(new Api.updates.GetState());
  return toTelegramUpdateState(state, { pts: 0, qts: 0, date: 0, seq: 0 });
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
  options: { includeHistory?: boolean; recoverRecentChannels?: boolean } = {}
): Promise<TelegramAccountSyncResult> {
  if (isAccountLockHeld(recoveringUpdateAccounts, accountId)) {
    // TG-04: a reconnect that lands while a previous recovery is still
    // finishing must not be reported as a failed sync. Wait (bounded) for the
    // current owner to release the account instead of failing fast — that
    // made reconnect look broken while recovery was perfectly healthy. A lock
    // owned by a retired client is not waited for at all (isAccountLockHeld).
    const LOCK_WAIT_MS = 60_000;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (isAccountLockHeld(recoveringUpdateAccounts, accountId) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (isAccountLockHeld(recoveringUpdateAccounts, accountId)) {
      return { success: false, historyComplete: false, inserted: 0 };
    }
  }
  acquireAccountLock(recoveringUpdateAccounts, accountId, client);
  try {
    // Emit initial syncing status with recovery queue stats
    const db = DatabaseService.getInstance();
    // A previous Electron process may have been closed while a channel RPC
    // was in flight. Such rows otherwise remain `draining` forever and will
    // never be considered by either the backlog or the live recovery lane.
    db?.requeueStaleChannelRecoveries(accountId);
    // Rows of channels the account is no longer in stay, parked as not_member.
    reconcileRecoveryMembership(accountId);
    const stats = db?.getChannelRecoveryStats(accountId);
    if (stats && (stats.pending + stats.draining) > 0) {
      EventBroadcaster.emit('event:telegramSync', {
        zaloId: accountId,
        status: 'syncing',
        pending: stats.pending + stats.draining,
        total: stats.pending + stats.draining + stats.complete,
        inserted: 0,
      });
    }

    const differenceResult = await recoverTelegramUpdateDifference(accountId, client);
    // Without a usable common-box cursor (never stored, or DifferenceTooLong),
    // snapshot the server state BEFORE the history pass and store that
    // snapshot once the pass has run. getDifference from it covers everything
    // after it, so storing it cannot skip an update; the history pass and the
    // channel queue cover what came before. This used to be stored only after
    // a *complete* history pass, which never happens for accounts with 200 or
    // more dialogs, so those accounts never used getDifference at all.
    let seedState: TelegramUpdateState | null = null;
    if (differenceResult === 'no_state' || differenceResult === 'too_long') {
      try {
        seedState = await fetchTelegramUpdateState(client);
      } catch (err: any) {
        Logger.warn(`[TelegramUserListener] GetState failed for ${accountId}: ${err.message}`);
      }
    }
    // Channel cursors are the realtime catch-up path. Run them before the broad
    // dialog history backfill, which may hit messages.GetHistory FLOOD_WAIT.
    const channelResult = await recoverChannelUpdates(accountId, client, {
      includeRecentDialogs: !!options.includeHistory || !!options.recoverRecentChannels,
    });

    // Saved messages are not in the chat scan pass (only the 200-300 most recent chats): ask for them separately, 1-2 calls
    await syncSavedMessages(accountId, client);

    // A complete global difference plus per-channel recovery is authoritative.
    // Running a broad GetHistory pass anyway races channel difference (history
    // can insert first, causing the realtime path to dedup without a UI event)
    // and creates the FLOOD_WAIT storm observed during forum navigation.
    if (differenceResult === 'complete' && !options.includeHistory && channelResult.ok) {
      DatabaseService.getInstance()?.repairTelegramLastMessagePreviews(accountId, 'telegram_user');
      return { success: true, historyComplete: true, inserted: 0 };
    }

    const historyResult = await fetchMissedMessages(accountId, client);
    // A failed difference keeps its stored cursor (it will be retried). Only a
    // missing/too-long cursor is replaced, and only by the pre-history snapshot.
    // A pass superseded by a newer client must not overwrite that client's cursor.
    const stillOwner = recoveringUpdateAccounts.get(accountId)?.client === client && !retiredClients.has(client);
    if (seedState && historyResult.success && stillOwner) {
      DatabaseService.getInstance()?.saveTelegramUpdateState(accountId, seedState);
      Logger.log(`[TelegramUserListener] Stored Telegram update cursor for ${accountId} (pts=${seedState.pts})`);
    }
    DatabaseService.getInstance()?.repairTelegramLastMessagePreviews(accountId, 'telegram_user');
    // TG-06: history succeeding does not launder a failed channel recovery
    // into `success: true`. The caller (and the UI progress) must see it.
    return {
      success: historyResult.success && differenceResult !== 'failed' && channelResult.ok,
      historyComplete: historyResult.complete && channelResult.ok,
      inserted: historyResult.inserted,
    };
  } finally {
    releaseAccountLock(recoveringUpdateAccounts, accountId, client);
    const listener = activeListeners.get(accountId);
    if (listener?.client === client && listener.client.connected && !listener.stopped) {
      pollChannelUpdates(listener).catch(() => {});
    }
  }
}

async function waitForTelegramAccountSync(accountId: string, timeoutMs = 30_000): Promise<boolean> {
  const startedAt = Date.now();
  while (isAccountLockHeld(recoveringUpdateAccounts, accountId) || isAccountLockHeld(syncingAccounts, accountId)) {
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
    return { success: false, error: tr('Telegram vẫn đang đồng bộ. Vui lòng thử lại sau.') };
  }

  try {
    const result = await synchronizeTelegramAccount(accountId, listener.client, { includeHistory: true });
    if (!result.success) {
      return { success: false, error: tr('Không thể hoàn tất đồng bộ tin nhắn Telegram') };
    }
    return {
      success: true,
      inserted: result.inserted,
      pending: !result.historyComplete,
    };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] Manual refresh failed for ${accountId}: ${err.message}`);
    return { success: false, error: err.message || tr('Không thể đồng bộ tin nhắn Telegram') };
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
        error: tr('Telegram đang bận đồng bộ quá lâu. Vui lòng thử lại sau.'),
      });
      return;
    }
    if (listener.client !== client || listener.stopped || !client.connected) {
      EventBroadcaster.emit('event:telegramSync', {
        zaloId: accountId,
        status: 'failed',
        error: tr('Kết nối Telegram đã bị ngắt trong lúc đồng bộ.'),
      });
      return;
    }

    const result = await refreshAccountMessages(accountId);
    EventBroadcaster.emit('event:telegramSync', result.success
      ? { zaloId: accountId, status: 'completed', inserted: result.inserted || 0, pending: !!result.pending }
      : { zaloId: accountId, status: 'failed', error: result.error || tr('Không thể đồng bộ tin nhắn Telegram') },
    );
    if (result.success) {
      EventBroadcaster.emit('event:messagesSynced', { zaloId: accountId, source: 'telegram', inserted: result.inserted || 0 } satisfies MessagesSyncedEvent);
    }
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
 *
 * Discovery strategy (DB-first):
 * 1. Enqueue all channels known in DB (messages + channel_pts) with priority
 * 2. Paginate API dialogs to discover new/missing channels
 * 3. Dequeue from persistent recovery queue for processing
 */
async function recoverChannelUpdates(
  accountId: string,
  client: TelegramClient,
  options: { includeRecentDialogs?: boolean } = {},
): Promise<{ ok: boolean; errors: string[] }> {
  const db = DatabaseService.getInstance();
  if (!db) return { ok: false, errors: ['no_db'] };
  const errors: string[] = [];

  try {
    // Phase 1: Enqueue all channels known in DB with appropriate priority
    if (options.includeRecentDialogs) {
      const knownChannelIds = db.getTelegramChannelIdsWithMessages(accountId);
      for (const channelId of knownChannelIds) {
        const pts = db.getTelegramChannelPts(accountId, channelId);
        const peer = db.getTelegramPeer(accountId, channelId);
        const priority = pts > 0 ? 30 : 10; // Has PTS = higher priority
        db.enqueueChannelRecovery(accountId, channelId, peer?.access_hash || '', pts, priority);
      }
      tgLog('info', accountId, 'channel_difference', `Enqueued ${knownChannelIds.length} DB-known channels for recovery`);

      // Phase 2: Discover recent dialogs. Let GramJS own the pagination cursor
      // (date + message ID + peer); passing its Date object back as offsetDate
      // caused an int32/millisecond mismatch and stopped at page two.
      const discoveredChannelIds = new Set<string>();
      const MAX_DIALOG_PAGES = 5; // Safety: max 5 pages × ~100 dialogs = 500 max
      const DIALOG_PAGE_SIZE = 100;
      const dialogs = await client.getDialogs({ limit: MAX_DIALOG_PAGES * DIALOG_PAGE_SIZE });

      for (let page = 0; page < MAX_DIALOG_PAGES; page++) {
        if (listener_stopped(accountId) || !isCurrentTelegramClient(accountId, client)) break;
        try {
          const pageDialogs = dialogs.slice(page * DIALOG_PAGE_SIZE, (page + 1) * DIALOG_PAGE_SIZE);
          if (pageDialogs.length === 0) break;

          for (const dialog of pageDialogs) {
            const channelId = getCanonicalChatId(dialog.id);
            if (!channelId?.startsWith('-100')) continue;
            if (discoveredChannelIds.has(channelId)) continue;
            discoveredChannelIds.add(channelId);

            if (dialog.entity) cacheTelegramPeer(accountId, channelId, dialog.entity);

            const hasCursor = db.getTelegramChannelPts(accountId, channelId) > 0;
            const hasMessages = !!db.queryOne(
              `SELECT 1 FROM messages
               WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
               LIMIT 1`,
              [accountId, channelId],
            );
            const entityAny = dialog.entity as any;
            if (hasCursor || hasMessages) {
              const priority = hasCursor ? 30 : 10;
              db.enqueueChannelRecovery(accountId, channelId, entityAny?.accessHash || '', db.getTelegramChannelPts(accountId, channelId), priority);
            } else {
              // TG-01: a member channel we have never synced must still get a
              // bootstrap job. Gating on local history meant newly joined /
              // newly discovered channels stayed silent until the user opened
              // them by hand.
              db.enqueueChannelRecovery(accountId, channelId, entityAny?.accessHash || '', 0, 5);
            }
          }
          // TG-01: never stop because this slice happened to hold only DMs or
          // already-known channels. A later slice/page may still contain
          // channels that need recovery; only the end of the list stops us.
        } catch (err: any) {
          tgLog('warn', accountId, 'channel_difference', `Dialog page ${page} failed: ${err.message}`);
          errors.push(`dialog_page:${err.message}`);
          break;
        }
      }

      // Also scan archived dialogs. TG-02: "Khác" must get the same inventory
      // budget as the main folder — a single 100-dialog page silently dropped
      // every archived channel past that page.
      try {
        const archivedDialogs = await client.getDialogs({ limit: MAX_DIALOG_PAGES * DIALOG_PAGE_SIZE, folder: 1 });
        for (const dialog of archivedDialogs) {
          const channelId = getCanonicalChatId(dialog.id);
          if (!channelId?.startsWith('-100') || discoveredChannelIds.has(channelId)) continue;
          discoveredChannelIds.add(channelId);
          if (dialog.entity) cacheTelegramPeer(accountId, channelId, dialog.entity);
          const hasCursor = db.getTelegramChannelPts(accountId, channelId) > 0;
          const hasMessages = !!db.queryOne(
            `SELECT 1 FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
             LIMIT 1`,
            [accountId, channelId],
          );
          const entityAny = dialog.entity as any;
          if (hasCursor || hasMessages) {
            db.enqueueChannelRecovery(accountId, channelId, entityAny?.accessHash || '', db.getTelegramChannelPts(accountId, channelId), hasCursor ? 30 : 10);
          } else {
            db.enqueueChannelRecovery(accountId, channelId, entityAny?.accessHash || '', 0, 5);
          }
        }
      } catch (err: any) {
        tgLog('warn', accountId, 'channel_difference', `Archived dialog scan failed: ${err.message}`);
        errors.push(`archive_scan:${err.message}`);
      }
    }

    // Phase 3: Dequeue and process from persistent recovery queue
    const queuedChannels = db.dequeueChannelRecovery(accountId, 200) as ChannelRecoveryQueueItem[];
    // Also include active channel leases from RAM. These bypass the folder
    // order because the user is looking at them now; every other queued item
    // keeps the DB order: "Tất cả" → unread/recent → Archived/"Khác".
    const activeChannelIds = getActiveChannelRecoveryOrder(accountId);
    const activeIndex = new Map(activeChannelIds.map((channelId, index) => [channelId, index]));
    for (const channelId of activeChannelIds) {
      if (!queuedChannels.find(channel => channel.channel_id === channelId)) {
        const pts = db.getTelegramChannelPts(accountId, channelId);
        queuedChannels.push({
          channel_id: channelId,
          access_hash: '',
          pts,
          priority: URGENT_CHANNEL_RECOVERY_PRIORITY,
          attempts: 0,
          queued: false,
        });
      }
    }
    queuedChannels.sort((a, b) => {
      const aActiveIndex = activeIndex.get(a.channel_id);
      const bActiveIndex = activeIndex.get(b.channel_id);
      if (aActiveIndex !== undefined || bActiveIndex !== undefined) {
        return (aActiveIndex ?? Number.MAX_SAFE_INTEGER) - (bActiveIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return 0;
    });

    tgLog('info', accountId, 'channel_difference', `Processing ${queuedChannels.length} channels from recovery queue`);

    const listener = activeListeners.get(accountId);
    if (listener) {
      await runChannelRecoveryWorkers(listener, client, queuedChannels, 'channel_difference');
    }

    // Cleanup old completed entries periodically
    db.cleanupChannelRecoveryQueue(accountId);
  } catch (err: any) {
    tgLog('warn', accountId, 'channel_difference', `recoverChannelUpdates error: ${err.message}`);
    errors.push(`recover:${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Check if the listener for this account has been stopped. */
function listener_stopped(accountId: string): boolean {
  const listener = activeListeners.get(accountId);
  return !listener || listener.stopped || !listener.client?.connected;
}

/**
 * Try to repair a missing access_hash by resolving the channel entity.
 * Returns true if repair succeeded.
 */
async function repairAccessHash(
  accountId: string,
  client: TelegramClient,
  channelId: string,
  peer: any,
): Promise<boolean> {
  try {
    // If peer has a username, try resolving via @username
    if (peer?.username) {
      const { Api } = require('telegram');
      const result = await client.invoke(new Api.contacts.ResolveUsername({ username: peer.username }));
      if (result?.channel) {
        cacheTelegramPeer(accountId, channelId, result.channel);
        return true;
      }
    }
    // Try resolvePeer with the channel ID
    const entity = await resolvePeerEntity(accountId, client, channelId);
    if (entity) {
      cacheTelegramPeer(accountId, channelId, entity);
      return true;
    }
  } catch (err: any) {
    tgLog('warn', accountId, 'channel_difference', `Access hash repair failed for ${channelId}: ${err.message}`);
  }
  return false;
}

const historyInsertThreadIds = new Map<string, Set<string>>();
const historyInsertTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The history pass persists rows without event:message (that event also
 * drives workflows and notifications). Tell the renderer which conversations
 * gained rows so it can merge them into an open chat instead of waiting for
 * the whole pass, coalesced to one event per account every 500ms. This also
 * covers a socket copy that arrives after history stored the same message and
 * is therefore deduplicated without a UI event.
 */
function noteTelegramHistoryInsert(accountId: string, chatId: string): void {
  let threadIds = historyInsertThreadIds.get(accountId);
  if (!threadIds) {
    threadIds = new Set<string>();
    historyInsertThreadIds.set(accountId, threadIds);
  }
  threadIds.add(chatId);
  if (historyInsertTimers.has(accountId)) return;
  historyInsertTimers.set(accountId, setTimeout(() => {
    historyInsertTimers.delete(accountId);
    const changed = [...(historyInsertThreadIds.get(accountId) || [])];
    historyInsertThreadIds.delete(accountId);
    if (changed.length === 0) return;
    EventBroadcaster.emit('db:unreadChanged', {
      zaloId: accountId,
      source: 'telegram_history_batch',
      threadIds: changed,
    });
  }, 500));
}

/**
 * Store history rows the way the history pass does: idempotent persist, the
 * conversation preview only (unread comes from the dialog), media for recent
 * rows, and no event:message (that event also drives workflows and desktop
 * notifications). Returns how many rows were newly inserted.
 */
/**
 * Conversation row preview + time from the newest message stored on this machine, when that message is newer than the row (or
 * the row has no time). Opening a conversation with no messages here loads its history (getMessages) without touching the row:
 * the renderer moved the conversation to its newest message, then the refresh from the DB put it back at the bottom (no time),
 * so the list jumped. Only updates an existing row. Returns whether the row changed.
 */
function refreshTelegramContactLastMessage(accountId: string, chatId: string): boolean {
  const db = DatabaseService.getInstance();
  if (!db || !accountId || !chatId) return false;
  const newest = db.queryOne<{ content: string; msg_type: string; timestamp: number }>(
    `SELECT content, msg_type, timestamp FROM messages
     WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND msg_type != 'recalled'
     ORDER BY timestamp DESC LIMIT 1`,
    [accountId, chatId],
  );
  const timestamp = Number(newest?.timestamp || 0);
  if (!newest || !Number.isFinite(timestamp) || timestamp <= 0) return false;
  const row = db.queryOne<{ last_message_time: number | null }>(
    `SELECT last_message_time FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [accountId, chatId],
  );
  if (!row || timestamp <= Number(row.last_message_time || 0)) return false;
  db.run(
    `UPDATE contacts SET last_message = ?, last_message_time = ? WHERE owner_zalo_id = ? AND contact_id = ?`,
    [getTelegramMessagePreview(newest.msg_type, newest.content), timestamp, accountId, chatId],
  );
  return true;
}

/**
 * Rows of this account with no last-message time although messages are stored for them (history stored by a path that did not
 * update the row, older builds): preview + time from the newest stored message. Runs after every connect: one indexed EXISTS
 * query (15 ms over 1,915 rows on a real DB), so an account that hits this again repairs itself without a one-time flag.
 */
async function repairTelegramContactLastMessages(accountId: string): Promise<number> {
  const db = DatabaseService.getInstance();
  if (!db) return 0;
  const rows = db.query<{ contact_id: string }>(
    `SELECT c.contact_id FROM contacts c
     WHERE c.owner_zalo_id = ? AND c.channel = 'telegram_user' AND COALESCE(c.last_message_time, 0) = 0
       AND EXISTS (SELECT 1 FROM messages m WHERE m.owner_zalo_id = c.owner_zalo_id AND m.thread_id = c.contact_id)`,
    [accountId],
  );
  let repaired = 0;
  for (let index = 0; index < rows.length; index++) {
    if (refreshTelegramContactLastMessage(accountId, String(rows[index].contact_id))) repaired++;
    if (index % 50 === 49) await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (repaired > 0) {
    Logger.log(`[TelegramUserListener] Last message repaired for ${repaired} conversation(s) of ${accountId}`);
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_sync' });
  }
  return repaired;
}

async function persistTelegramHistoryMessages(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  dialog: any,
  messages: any[],
): Promise<number> {
  const db = DatabaseService.getInstance();
  if (!db) return 0;
  // Sort ASC by timestamp: the last message in the loop is the newest
  messages.sort((a: any, b: any) => (a.date || 0) - (b.date || 0));
  let inserted = 0;

  for (const msg of messages) {
    await paceCatchUp();
    const msgTimestamp = (msg.date || 0) * 1000;
    const messageId = String(msg.id);
    if (!messageId) continue;

    // Phase B: Use persistTelegramMessage for idempotency
    const senderId = String(msg.senderId?.valueOf() || '');
    const isSelf = isOwnTelegramMessage(msg, accountId, chatId);
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

    const displayContent = telegramDisplayContent(content, msgType);

    if (!displayContent && msgType === 'text') continue;

    // Use idempotent persist — returns inserted/duplicate
    const result = persistTelegramMessage(db, {
      msgId: messageId, accountId, chatId, threadType,
      senderId, content: displayContent, msgType, timestamp: msgTimestamp,
      isSelf, attachments, topicId: getForumTopicId(msg), reactions,
    });

    // Side effects only on actual insert (P1.5)
    if (result.status === 'inserted') {
      handleRichMessageExtras(accountId, client, chatId, msg);
      // Media download for recent messages only
      if (attachments.some((attachment: any) => !isTelegramMetaAttachment(attachment)) && client) {
        const isRecent = (Date.now() - msgTimestamp) < 24 * 60 * 60 * 1000;
        if (isRecent) {
          downloadMediaForMessage(accountId, client, msg, messageId, msgType, chatId).catch(() => {});
        }
      }

      // Update contacts: only last_message is updated, does NOT increment unread_count
      // (unread_count is synced exactly from the Telegram dialog in persistTelegramDialogState)
      const chatTitle = dialog.title || chatId;
      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
        VALUES (?, ?, ?, '', 0, ?, 0, ?, ?, 'telegram_user')
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
          channel = 'telegram_user'
      `, [accountId, chatId, chatTitle, isGroup ? 'group' : 'user', getTelegramMessagePreview(msgType, content), msgTimestamp]);

      inserted++;
      noteTelegramHistoryInsert(accountId, chatId);
    }
  }
  return inserted;
}

/** First history load of Saved Messages: at most this many messages (older ones load when scrolling up). */
const SAVED_MESSAGES_HISTORY_MAX = 5000;
/** Flag (app_settings, per account): Saved Messages has had its history loaded for the first time. */
const savedMessagesHistoryKey = (accountId: string) => `tg_saved_messages_history_v1:${accountId}`;
const savedMessagesHistoryJobs = new Set<string>();

/**
 * Loads the Saved Messages history for the first time, in the background (does not hold up the sync pass). This chat has never had its history loaded: the machine
 * only has a few scattered realtime messages (real DB: 4 messages from 09/2024 to 03/2025; the newest message on Telegram is also the last of those, so the
 * "tin sau mốc" (messages after the mark) pass loads nothing, and the ones in between and before are all missing; scrolling up only loads messages older than the oldest). It loads from the newest message down to the oldest one stored (no gap left), in pages of 100 messages about 1 s apart, up to
 * SAVED_MESSAGES_HISTORY_MAX. An error midway → the flag is not set, and the next sync loads again (messages already there are skipped).
 */
async function backfillSavedMessagesHistory(accountId: string, client: TelegramClient, me: any, oldestLocalId: number): Promise<number> {
  const db = DatabaseService.getInstance();
  if (!db || savedMessagesHistoryJobs.has(accountId)) return 0;
  savedMessagesHistoryJobs.add(accountId);
  try {
    const { Api } = require('telegram');
    const messages: any[] = [];
    for await (const message of client.iterMessages(new Api.InputPeerSelf(), { limit: SAVED_MESSAGES_HISTORY_MAX, waitTime: 1000 })) {
      if (retiredClients.has(client)) return 0;
      messages.push(message);
      if (oldestLocalId > 0 && Number(message.id) <= oldestLocalId) break;
    }
    const title = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || accountId;
    const inserted = await persistTelegramHistoryMessages(accountId, client, accountId, { isChannel: false, isGroup: false, entity: me, title }, messages);
    db.setSetting(savedMessagesHistoryKey(accountId), '1');
    Logger.log(`[TelegramUserListener] Saved Messages history for ${accountId}: fetched=${messages.length} inserted=${inserted} oldestLocalId=${oldestLocalId}`);
    return inserted;
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] Saved Messages history failed for ${accountId}: ${err?.message || err}`);
    return 0;
  } finally {
    savedMessagesHistoryJobs.delete(accountId);
  }
}

/**
 * Saved Messages (= chat with myself; Deplao shows it as My Documents). A conversation is only created from the chat list scan (fetchMissedMessages: the 200-300 most recent chats, skipped when incremental sync already covers everything), so this rarely used chat never gets one. Each sync asks for it separately (messages.getPeerDialogs, 1 call) → saves the conversation (channel telegram_user); if Telegram has a message newer than the mark on the machine, it catches up like fetchMissedMessages: no message yet → the 100 newest; already has some → every message after the mark from oldest to newest (up to RECOVERY_MESSAGES_PER_DIALOG; the next pass loads the rest, no gap).
 * The first time there are scattered messages on the machine → background history load (backfillSavedMessagesHistory).
 */
async function syncSavedMessages(accountId: string, client: TelegramClient): Promise<number> {
  const db = DatabaseService.getInstance();
  if (!db) return 0;
  try {
    const { Api } = require('telegram');
    const result: any = await client.invoke(new Api.messages.GetPeerDialogs({
      peers: [new Api.InputDialogPeer({ peer: new Api.InputPeerSelf() })],
    }));
    const dialog = result?.dialogs?.[0];
    const me: any = (result?.users || []).find((user: any) => user?.self) || await client.getMe();
    if (!dialog || !me) return 0;
    persistTelegramDialogState(accountId, accountId, dialog, me);
    // Messages saved before every message here was mine (isOwnTelegramMessage): a forwarded message saved back then was treated as incoming
    db.run(
      `UPDATE messages SET is_sent = 1, status = 'sent'
       WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND is_sent = 0`,
      [accountId, accountId],
    );
    const topMessage = Number(dialog.topMessage || 0);
    const checkpoint = getTelegramHistoryCheckpoint(db, accountId, accountId);
    let inserted = 0;
    let backfilling = false;
    if (topMessage > 0 && db.getSetting(savedMessagesHistoryKey(accountId)) !== '1') {
      const oldestLocalId = Number(db.queryOne<{ id: number | null }>(
        `SELECT MIN(CAST(msg_id AS INTEGER)) AS id FROM messages
         WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [accountId, accountId],
      )?.id || 0);
      if (oldestLocalId > 0) {
        // Background load from the newest message downward: it includes the messages after the mark, so no separate catch-up below
        void backfillSavedMessagesHistory(accountId, client, me, oldestLocalId);
        backfilling = true;
      } else {
        // No messages on the machine yet: the 100 newest messages below are enough (no gap), just set the flag
        db.setSetting(savedMessagesHistoryKey(accountId), '1');
      }
    }
    if (!backfilling && topMessage > checkpoint) {
      const messages: any[] = [];
      if (!checkpoint) {
        messages.push(...await client.getMessages(new Api.InputPeerSelf(), { limit: INITIAL_MESSAGES_PER_DIALOG }));
      } else {
        for await (const message of client.iterMessages(new Api.InputPeerSelf(), {
          minId: checkpoint,
          limit: RECOVERY_MESSAGES_PER_DIALOG,
          reverse: true,
        })) {
          messages.push(message);
        }
      }
      const title = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || accountId;
      inserted = await persistTelegramHistoryMessages(accountId, client, accountId, { isChannel: false, isGroup: false, entity: me, title }, messages);
    }
    // Conversation has messages but no (or an older) last message on its row (an old row not created by sync) → take it from the newest message on the machine
    if (refreshTelegramContactLastMessage(accountId, accountId)) noteTelegramHistoryInsert(accountId, accountId);
    return inserted;
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] Saved Messages sync failed for ${accountId}: ${err?.message || err}`);
    return 0;
  }
}

async function fetchMissedMessages(accountId: string, client: TelegramClient): Promise<TelegramHistorySyncResult> {
  const db = DatabaseService.getInstance();
  if (!db || isAccountLockHeld(syncingAccounts, accountId)) return { success: false, complete: false, inserted: 0 };
  acquireAccountLock(syncingAccounts, accountId, client);
  let needsFollowUpSync = false;
  let inventoryTruncated = false;
  let archiveFetchFailed = false;

  try {
    // Get the time of the last message saved in the DB
    normalizeLegacyTelegramContacts(accountId);
    // Only need to know "has any Telegram message ever been saved?" → EXISTS stops at the first row
    // instead of COUNT(*), which scans all messages of the account.
    const hasExisting = db.queryOne<any>(
      `SELECT 1 AS one FROM messages WHERE owner_zalo_id = ? AND channel = 'telegram_user' LIMIT 1`,
      [accountId]
    );
    const isFirstSync = !hasExisting;

    // Get all conversations (dialogs): higher limit for the first run
    const dialogLimit = isFirstSync ? INITIAL_DIALOG_LIMIT : RECENT_DIALOG_LIMIT;
    const dialogs = await client.getDialogs({ limit: dialogLimit });

    // Also get archived dialogs (folder=1) to sync into "Khác"
    let archivedDialogs: any[] = [];
    try {
      archivedDialogs = await client.getDialogs({ limit: dialogLimit, folder: 1 });
    } catch (err: any) {
      archiveFetchFailed = true;
      Logger.warn(`[TelegramUserListener] Failed to fetch archived dialogs: ${err.message}`);
    }

    // TG-06: a capped dialog list is not a complete inventory. GramJS returns a
    // TotalList whose `total` is the server-side count; if either leg was cut
    // off we must not report this pass as a finished recovery epoch.
    const inventoryLegTruncated = (list: any[], limit: number): boolean => {
      const total = Number((list as any)?.total ?? list.length);
      return list.length >= limit || total > list.length;
    };
    if (inventoryLegTruncated(dialogs, dialogLimit) || inventoryLegTruncated(archivedDialogs, dialogLimit)) {
      inventoryTruncated = true;
    }

    // Merge dialogs, dedup by chatId (archived may overlap with main if the user archives / recently)
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
    let retiredMidPass = false;
    // Open conversation syncs first
    const focusedChat = focusedTelegramChat(accountId);
    const orderedDialogs = focusedChat
      ? focusFirst(allDialogs, (dialog: any) => getCanonicalChatId(dialog.id) === focusedChat)
      : allDialogs;

    for (const dialog of orderedDialogs) {
      // A reconnect retired this client: its requests can no longer be sent,
      // and the replacement client runs its own pass.
      if (retiredClients.has(client)) {
        retiredMidPass = true;
        break;
      }
      const chatId = getCanonicalChatId(dialog.id);
      if (!chatId) continue;
      if (dialog.entity) cacheTelegramPeer(accountId, chatId, dialog.entity);
      // Dialog metadata is independent from message history. Persist it even
      // when this dialog has no new messages so archive/mute/send rights stay
      // synchronized with Telegram.
      persistTelegramDialogState(accountId, chatId, dialog, dialog.entity);

      // Fetch the latest message from each conversation
      // The first sync is deliberately bounded. On reconnect, load every
      // message after the newest durable ID for this dialog instead of an
      // arbitrary recent window. Telegram IDs are monotonic per peer,
      // including all topics below the same forum parent.
      let messages: any[];
      if (isFirstSync) {
        messages = await client.getMessages(dialog.id, { limit: INITIAL_MESSAGES_PER_DIALOG });
      } else {
        const minId = getTelegramHistoryCheckpoint(db, accountId, chatId);
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

      totalSynced += await persistTelegramHistoryMessages(accountId, client, chatId, dialog, messages);
    }

    if (totalSynced > 0) {
      Logger.log(`[TelegramUserListener] Synced ${totalSynced} missed messages for ${accountId}`);
    }

    // Avatar hydration is demand-driven. Bulk profile downloads at login open
    // exported DC senders and can destabilize the primary MTProto transport.

    // Broadcast so the UI refreshes
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_sync' });
    // TG-06: success/complete must describe what this pass actually covered.
    // A failed archive leg or a truncated dialog list is partial work — the
    // scheduler needs to see that, not a green checkmark.
    return {
      success: !archiveFetchFailed && !retiredMidPass,
      complete: !needsFollowUpSync && !inventoryTruncated && !archiveFetchFailed && !retiredMidPass,
      inserted: totalSynced,
    };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] fetchMissedMessages error: ${err.message}`);
    return { success: false, complete: false, inserted: 0 };
  } finally {
    releaseAccountLock(syncingAccounts, accountId, client);
    const followUpListener = activeListeners.get(accountId);
    if (needsFollowUpSync && followUpListener && isCurrentTelegramClient(accountId, client)) {
      // Runs after the pass that called us (or reruns it once it finishes)
      // instead of racing it for the account lock.
      setTimeout(() => {
        if (isCurrentTelegramClient(accountId, client)) scheduleReconnectCatchUp(followUpListener, client, 'full');
      }, 1000);
    }
  }
}

/**
 * Fetch avatars for all contacts in the dialogs
 */
async function fetchContactAvatars(accountId: string, client: TelegramClient, dialogs: any[]): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;

  for (const dialog of dialogs) {
    const chatId = getCanonicalChatId(dialog.id);
    if (!chatId) continue;

    try {
      // Check whether it already has an avatar
      const existing = db.queryOne<any>(
        `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId]
      );
      if (existing?.avatar_url) continue; // Already has an avatar

      // Get the entity info from the dialog
      const entity = dialog.entity;
      if (!entity) continue;

      let avatarUrl = '';

      // Try download avatar photo
      try {
        const photo = await downloadProfilePhotoQueued(accountId, client, entity, `chat:${chatId}`, false, { threadId: chatId });
        if (photo && photo.length > 0) {
          // Save the avatar to a file and get its URL
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

  // Broadcast so the UI refreshes avatars
  EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId });
}

/**
 * Save the avatar buffer to disk, using the same base dir as FileStorageService
 */
async function saveAvatarToDisk(buffer: Buffer, filename: string): Promise<string | null> {
  try {
    const baseDir = FileStorageService.getBaseDir();

    const avatarsDir = path.join(baseDir, '_avatars', 'telegram');
    await fs.promises.mkdir(avatarsDir, { recursive: true });

    const filePath = path.join(avatarsDir, filename);
    await writeMediaFile(filePath, buffer);
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
    const photo = await downloadProfilePhotoQueued(accountId, conn.client, entity, `refresh:${chatId}`, false, {
      threadId: chatId, urgency: 'visible',
    });
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
// The bot's Mini App runs inside the app (renderer TelegramMiniApp, like the Telegram client): main gets the link with the user's initData
// and handles what the Mini App requests through events (CloudStorage, message permission, sharing the phone number).
// Docs: https://core.telegram.org/api/bots/webapps, https://core.telegram.org/api/web-events

export interface MiniAppRequestOptions {
  /** Conversation where the Mini App opens (button in a bot's message in a group → the group); none = private chat with the bot. */
  peerId?: string;
  /** UI colors (tgWebAppThemeParams) matching the Deplao theme; main filters them again (sanitizeMiniAppTheme). */
  themeParams?: unknown;
}

async function resolveBotInputUser(accountId: string, client: TelegramClient, botId: string): Promise<any> {
  const entity = await resolvePeerEntity(accountId, client, botId);
  if (!entity) throw new Error('Bot not found');
  if (!entity.accessHash) throw new Error('Cannot get bot access hash');
  const { Api } = require('telegram');
  return new Api.InputUser({ userId: BigInt(String(botId)), accessHash: BigInt(String(entity.accessHash)) });
}

/** Peer of the Mini App: the conversation where the button was clicked (the result message is sent there), default is the chat with the bot. */
function resolveMiniAppPeer(accountId: string, client: TelegramClient, botId: string, peerId?: string): Promise<any> {
  return resolveInputPeer(accountId, client, peerId && /^-?\d+$/.test(peerId) ? peerId : botId);
}

function miniAppThemeOption(themeParams: unknown): Record<string, unknown> {
  const theme = sanitizeMiniAppTheme(themeParams);
  if (!theme) return {};
  const { Api } = require('telegram');
  return { themeParams: new Api.DataJSON({ data: JSON.stringify(theme) }) };
}

function miniAppRandomId(): bigint {
  return require('crypto').randomBytes(8).readBigInt64LE();
}

/**
 * Open a Mini App via messages.requestWebView.
 * Used for: inline keyboard WebView buttons, custom bot menu buttons.
 */
export async function requestWebView(
  accountId: string, botId: string, url: string, fromBotMenu = false, opts: MiniAppRequestOptions = {},
): Promise<{ success: boolean; webViewUrl?: string; queryId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const peer = await resolveMiniAppPeer(accountId, conn.client, botId, opts.peerId);

    const result = await conn.client.invoke(new Api.messages.RequestWebView({
      peer,
      bot,
      url: url || undefined,
      platform: MINI_APP_PLATFORM,
      ...miniAppThemeOption(opts.themeParams),
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
 * Used for: "Open" button in conversation list / bot menu for bots with Main Mini App.
 */
export async function requestMainWebView(
  accountId: string, botId: string, startParam?: string, opts: MiniAppRequestOptions = {},
): Promise<{ success: boolean; webViewUrl?: string; queryId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const peer = await resolveMiniAppPeer(accountId, conn.client, botId, opts.peerId);

    const result = await conn.client.invoke(new Api.messages.RequestMainWebView({
      peer,
      bot,
      platform: MINI_APP_PLATFORM,
      ...miniAppThemeOption(opts.themeParams),
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
 * Mini App by name (t.me/<bot>/<app>): messages.getBotApp. `inactive` / `requestWriteAccess` → ask the user before
 * opening (https://core.telegram.org/api/bots/webapps#direct-link-mini-apps).
 */
export async function getBotApp(
  accountId: string, botId: string, shortName: string,
): Promise<{ success: boolean; app?: { id: string; accessHash: string; title: string; description: string; inactive: boolean; requestWriteAccess: boolean }; error?: string }> {
  if (!/^[A-Za-z0-9_]{3,64}$/.test(String(shortName || ''))) return { success: false, error: tr('Tên Mini App không hợp lệ') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const res = await conn.client.invoke(new Api.messages.GetBotApp({
      app: new Api.InputBotAppShortName({ botId: bot, shortName }),
      hash: BigInt(0),
    })) as any;
    const app = res?.app;
    if (!app?.id || app.accessHash == null) return { success: false, error: tr('Bot không có Mini App này') };
    return {
      success: true,
      app: {
        id: String(app.id), accessHash: String(app.accessHash), title: String(app.title || shortName),
        description: String(app.description || ''), inactive: !!res.inactive, requestWriteAccess: !!res.requestWriteAccess,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Open a Mini App by name (after getBotApp): messages.requestAppWebView. */
export async function requestAppWebView(
  accountId: string, botId: string, app: { id: string; accessHash: string },
  opts: MiniAppRequestOptions & { startParam?: string; writeAllowed?: boolean } = {},
): Promise<{ success: boolean; webViewUrl?: string; queryId?: string; error?: string }> {
  if (!/^-?\d+$/.test(String(app?.id || '')) || !/^-?\d+$/.test(String(app?.accessHash || ''))) {
    return { success: false, error: tr('Mini App không hợp lệ') };
  }
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const peer = await resolveMiniAppPeer(accountId, conn.client, botId, opts.peerId);
    const result = await conn.client.invoke(new Api.messages.RequestAppWebView({
      peer,
      app: new Api.InputBotAppID({ id: BigInt(app.id), accessHash: BigInt(app.accessHash) }),
      platform: MINI_APP_PLATFORM,
      ...miniAppThemeOption(opts.themeParams),
      ...(opts.startParam ? { startParam: opts.startParam } : {}),
      ...(opts.writeAllowed ? { writeAllowed: true } : {}),
    })) as any;
    return { success: true, webViewUrl: result?.url || '', queryId: String(result?.queryId || '') };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Bot link with ?start=<parameter>: the user clicks "Bắt đầu" (Start) → messages.startBot (https://core.telegram.org/api/links#bot-links). */
export async function startBot(accountId: string, botId: string, startParam: string): Promise<{ success: boolean; error?: string }> {
  if (!/^[A-Za-z0-9_-]{0,64}$/.test(String(startParam ?? ''))) return { success: false, error: tr('Tham số không hợp lệ') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const peer = await resolveInputPeer(accountId, conn.client, botId);
    await conn.client.invoke(new Api.messages.StartBot({ bot, peer, randomId: miniAppRandomId(), startParam: String(startParam ?? '') }));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export type InlineButtonPress =
  | { kind: 'answer'; message: string; alert: boolean; url: string }
  | { kind: 'copy'; text: string }
  | { kind: 'profile'; userId: string }
  | { kind: 'unsupported'; reason: string };

/**
 * Inline button that is not a link of the bot's message (callback, game, copy, open profile…): re-read the button at [row][col] from the message on
 * Telegram (callback data is not stored in the DB, so old messages can still be clicked), then act like the Telegram client
 * (https://core.telegram.org/api/bots/buttons): callback / game → messages.getBotCallbackAnswer.
 */
export async function pressInlineButton(
  accountId: string, chatId: string, messageId: number, row: number, col: number,
): Promise<{ success: boolean; action?: InlineButtonPress; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const fetched: any[] = (await conn.client.getMessages(peer, { ids: [messageId] })) as any;
    const message: any = (fetched || []).find((item: any) => Number(item?.id) === messageId);
    const markup = message?.replyMarkup;
    const button = markup?.className === 'ReplyInlineMarkup' ? markup.rows?.[row]?.buttons?.[col] : null;
    if (!button) return { success: false, error: tr('Nút này không còn trên tin (bot đã đổi tin)') };
    // Layer 198: KeyboardButtonCallback… · layer 23x: KeyboardInlineButton { type: InlineButtonTypeCallback… }
    const kind = String(button.className || '');
    const type = button.type && typeof button.type === 'object' ? button.type : null;
    const typeKind = String(type?.className || '');
    const pick = (name: string) => button[name] ?? type?.[name];
    const isKind = (legacy: string, current: string) => kind === legacy || typeKind === current;

    if (isKind('KeyboardButtonCallback', 'InlineButtonTypeCallback') || isKind('KeyboardButtonGame', 'InlineButtonTypeGame')) {
      const game = isKind('KeyboardButtonGame', 'InlineButtonTypeGame');
      if (!game && pick('requiresPassword')) {
        return { success: true, action: { kind: 'unsupported', reason: tr('Nút này cần mật khẩu 2 lớp của Telegram, hãy bấm trên app Telegram') } };
      }
      try {
        const answer: any = await conn.client.invoke(new Api.messages.GetBotCallbackAnswer({
          peer, msgId: messageId, ...(game ? { game: true } : { data: pick('data') }),
        }));
        return {
          success: true,
          action: { kind: 'answer', message: String(answer?.message || ''), alert: !!answer?.alert, url: String(answer?.url || '') },
        };
      } catch (err: any) {
        const reason = String(err?.errorMessage || err?.message || err);
        // Bot does not answer in time: Telegram stays silent too (bots usually edit the message right after)
        if (/BOT_RESPONSE_TIMEOUT/.test(reason)) return { success: true, action: { kind: 'answer', message: '', alert: false, url: '' } };
        if (/DATA_INVALID|MESSAGE_ID_INVALID/.test(reason)) return { success: false, error: tr('Nút đã hết hạn') };
        throw err;
      }
    }
    if (isKind('KeyboardButtonCopy', 'InlineButtonTypeCopy')) {
      return { success: true, action: { kind: 'copy', text: String(pick('copyText') || '') } };
    }
    if (isKind('KeyboardButtonUserProfile', 'InlineButtonTypeUserProfile')) {
      return { success: true, action: { kind: 'profile', userId: String(pick('userId') ?? '') } };
    }
    if (isKind('KeyboardButtonBuy', 'InlineButtonTypeBuy')) {
      return { success: true, action: { kind: 'unsupported', reason: tr('Thanh toán của bot chưa hỗ trợ trong Deplao') } };
    }
    if (isKind('KeyboardButtonSwitchInline', 'InlineButtonTypeSwitchInline')) {
      return { success: true, action: { kind: 'unsupported', reason: tr('Chế độ inline của bot chưa hỗ trợ trong Deplao') } };
    }
    return { success: true, action: { kind: 'unsupported', reason: tr('Loại nút này chưa hỗ trợ trong Deplao') } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Keep WebView alive. Must be called about every 60s while the WebView is open (same peer as requestWebView).
 * QUERY_ID_INVALID → `expired`: the Mini App must close.
 */
export async function prolongWebView(
  accountId: string, botId: string, queryId: string, peerId?: string,
): Promise<{ success: boolean; expired?: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  if (!/^-?\d+$/.test(String(queryId || ''))) return { success: false, error: tr('queryId không hợp lệ') };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const peer = await resolveMiniAppPeer(accountId, conn.client, botId, peerId);

    await conn.client.invoke(new Api.messages.ProlongWebView({
      peer,
      bot,
      queryId: BigInt(queryId),
    }));

    return { success: true };
  } catch (err: any) {
    const message = String(err?.message || err);
    return { success: false, error: message, ...(/QUERY_ID_INVALID/.test(message) ? { expired: true } : {}) };
  }
}

/** web_app_invoke_custom_method (Mini App CloudStorage…): bots.invokeWebViewCustomMethod. */
export async function invokeMiniAppCustomMethod(
  accountId: string, botId: string, method: string, params: unknown,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!MINI_APP_METHOD_RE.test(String(method || ''))) return { success: false, error: 'METHOD_INVALID' };
  const json = miniAppParamsJson(params);
  if (json === null) return { success: false, error: 'PARAMS_INVALID' };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    const res = await conn.client.invoke(new Api.bots.InvokeWebViewCustomMethod({
      bot,
      customMethod: method,
      params: new Api.DataJSON({ data: json }),
    })) as any;
    let result: unknown = null;
    try { result = JSON.parse(String(res?.data ?? 'null')); } catch { result = null; }
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** web_app_request_write_access: whether the bot has been messaged by the user yet (check) / permission granted (allow). */
export async function miniAppWriteAccess(
  accountId: string, botId: string, action: 'check' | 'allow',
): Promise<{ success: boolean; allowed?: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const bot = await resolveBotInputUser(accountId, conn.client, botId);
    if (action === 'check') {
      const allowed = await conn.client.invoke(new Api.bots.CanSendMessage({ bot }));
      return { success: true, allowed: allowed === true };
    }
    await conn.client.invoke(new Api.bots.AllowSendMessage({ bot }));
    return { success: true, allowed: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** web_app_request_phone (the user agreed): send the account's phone number as a contact card to the bot, unblocking the bot if needed. */
export async function shareMiniAppPhone(accountId: string, botId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const me: any = await conn.client.getMe();
    const phone = String(me?.phone || '');
    if (!phone) return { success: false, error: tr('Tài khoản Telegram chưa có số điện thoại') };
    const peer = await resolveInputPeer(accountId, conn.client, botId);
    const send = () => conn.client.invoke(new Api.messages.SendMedia({
      peer,
      media: new Api.InputMediaContact({
        phoneNumber: phone, firstName: String(me.firstName || ''), lastName: String(me.lastName || ''), vcard: '',
      }),
      message: '',
      randomId: miniAppRandomId(),
    }));
    try {
      await send();
    } catch (err: any) {
      if (!/YOU_BLOCKED_USER/.test(String(err?.message))) throw err;
      await conn.client.invoke(new Api.contacts.Unblock({ id: peer }));
      await send();
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Bot's login button (keyboardButtonUrlAuth): ask Telegram for the page that requires login (https://core.telegram.org/api/url-authorization). */
export async function requestUrlAuth(
  accountId: string, peerId: string, msgId: number, buttonId: number,
): Promise<{ success: boolean; info?: UrlAuthInfo; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, peerId);
    const res = await conn.client.invoke(new Api.messages.RequestUrlAuth({ peer, msgId, buttonId }));
    return { success: true, info: urlAuthInfo(res) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** The user agreed to log in: the Telegram link returned already includes the login signature (null = open the button's original link). */
export async function acceptUrlAuth(
  accountId: string, peerId: string, msgId: number, buttonId: number,
  opts: { writeAllowed?: boolean; sharePhone?: boolean } = {},
): Promise<{ success: boolean; url?: string | null; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, peerId);
    const res = await conn.client.invoke(new Api.messages.AcceptUrlAuth({
      peer,
      msgId,
      buttonId,
      ...(opts.writeAllowed ? { writeAllowed: true } : {}),
      ...(opts.sharePhone ? { sharePhoneNumber: true } : {}),
    }));
    const info = urlAuthInfo(res);
    return { success: true, url: info.kind === 'accepted' ? info.url : null };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

/** Rate limiter: 30 messages/min per account, refilled gradually (1 token every 2 seconds) */
const rateLimiters = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_MAX_TOKENS = 30;
const RATE_LIMIT_REFILL_INTERVAL_MS = 2000; // 1 token every 2 seconds

function checkRateLimit(accountId: string): { allowed: boolean; waitSeconds?: number } {
  let limiter = rateLimiters.get(accountId);
  if (!limiter) {
    limiter = { tokens: RATE_LIMIT_MAX_TOKENS, lastRefill: Date.now() };
    rateLimiters.set(accountId, limiter);
  }

  // Refill tokens gradually
  const now = Date.now();
  const elapsed = now - limiter.lastRefill;
  const tokensToAdd = Math.floor(elapsed / RATE_LIMIT_REFILL_INTERVAL_MS);
  if (tokensToAdd > 0) {
    limiter.tokens = Math.min(RATE_LIMIT_MAX_TOKENS, limiter.tokens + tokensToAdd);
    limiter.lastRefill += tokensToAdd * RATE_LIMIT_REFILL_INTERVAL_MS; // Fix: don't drift the clock
  }

  if (limiter.tokens <= 0) {
    // Compute the wait time for the next token
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
  throw new Error(tr('Không tìm thấy Telegram chat {{chatId}}. Hãy tải lại danh sách hội thoại.', { chatId }));
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
    throw new Error(tr('Telegram peer {{chatId}} không phải supergroup/channel.', { chatId }));
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
    throw new Error(tr('Telegram peer {{userId}} không phải người dùng.', { userId }));
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
    return state.telegram_send_reason || tr('Bạn không có quyền gửi tin nhắn trong cuộc trò chuyện này');
  } catch {
    return null;
  }
}

// ─── Link preview of sent messages (messages/telegramSentLinkPreview.ts) ───────

/** Link preview ready in Telegram's answer to a send: msg_type + attachments as history saves them (null = none or still pending). */
function sentLinkPreview(message: any): { msgType: string; attachments: Record<string, any>[] } | null {
  if (message?.className !== 'Message' || telegramLinkPreviewState(message) !== 'ready') return null;
  const normalized = normalizeTelegramMessageMedia(message);
  const attachments = normalized.attachments.filter(isLinkPreviewAttachment);
  return attachments.length ? { msgType: normalized.msgType, attachments } : null;
}

/** The page's photo is downloaded at once (open conversation first). Video / file previews are left to the bubble (small ones load by themselves). */
function downloadLinkPreviewPhoto(accountId: string, client: TelegramClient, message: any, msgId: string, msgType: string, chatId: string): void {
  if (msgType !== 'photo') return;
  downloadMediaForMessage(accountId, client, message, msgId, msgType, chatId, { urgency: 'visible' }).catch((err: any) => {
    tgLog('warn', accountId, 'socket', 'LINK_PREVIEW_DOWNLOAD_FAILED', { chatId, msgId, error: err?.message || String(err) });
  });
}

/** Writes a ready preview over the sent row, patches the bubble (event:messagesRepaired) and downloads the page's photo. */
function applySentLinkPreview(accountId: string, client: TelegramClient, chatId: string, msgId: string, message: any): boolean {
  const db = DatabaseService.getInstance();
  const preview = sentLinkPreview(message);
  if (!db || !preview) return false;
  const row = db.queryOne<{ attachments: string | null; msg_type: string }>(
    `SELECT attachments, msg_type FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [msgId, accountId, chatId],
  );
  if (!row || !LINK_PREVIEW_TARGET_TYPES.has(String(row.msg_type || ''))) return false;
  let saved: any[] = [];
  try {
    const parsed = JSON.parse(row.attachments || '[]');
    if (Array.isArray(parsed)) saved = parsed;
  } catch {}
  const attachments = withLinkPreview(saved, preview.attachments);
  db.run(
    `UPDATE messages SET msg_type = ?, attachments = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [preview.msgType, JSON.stringify(attachments), msgId, accountId, chatId],
  );
  EventBroadcaster.emit('event:messagesRepaired', {
    zaloId: accountId, threadId: chatId, items: [{ msgId, msgType: preview.msgType, attachments }],
  });
  downloadLinkPreviewPhoto(accountId, client, message, msgId, preview.msgType, chatId);
  return true;
}

/** Asks Telegram again for a sent message whose preview was still being fetched; saves the preview once it is ready. */
async function refreshPendingLinkPreview(item: PendingLinkPreview): Promise<TelegramLinkPreviewState> {
  const listener = activeListeners.get(item.accountId);
  if (!listener?.client || !listener.connected || listener.stopped) throw new Error('Telegram client not connected');
  const peer = await resolveInputPeer(item.accountId, listener.client, item.chatId);
  const fetched = await listener.client.getMessages(peer, { ids: [Number(item.msgId)] });
  const message = (fetched || []).find((entry: any) => String(entry?.id || '') === item.msgId && entry?.className !== 'MessageEmpty');
  if (!message) return 'none';
  const state = telegramLinkPreviewState(message);
  if (state === 'ready') applySentLinkPreview(item.accountId, listener.client, item.chatId, item.msgId, message);
  return state;
}

const pendingLinkPreviews = createPendingLinkPreviewWatch({ refresh: refreshPendingLinkPreview });

/** After a send: download the preview's photo now, or keep asking while Telegram is still fetching the page. */
function followSentLinkPreview(
  accountId: string, client: TelegramClient, chatId: string, msgId: string, message: any,
  preview: { msgType: string } | null,
): void {
  if (preview) {
    downloadLinkPreviewPhoto(accountId, client, message, msgId, preview.msgType, chatId);
    return;
  }
  if (telegramLinkPreviewState(message) === 'none' || !/^\d+$/.test(msgId)) return;
  pendingLinkPreviews.watch({ accountId, chatId, msgId, webpageId: telegramWebpageIdOf(message?.media?.webpage) });
}

export async function sendMessage(accountId: string, chatId: string, text: string, mentions?: TelegramSendMention[], replyToMsgId?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    return { success: false, error: 'Telegram client not connected' };
  }
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };

  // Rate limit check
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) {
    return { success: false, error: tr('Gửi tin quá nhanh. Vui lòng chờ {{waitSeconds}} giây.', { waitSeconds: rateLimit.waitSeconds }) };
  }

  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);

    // Build mention entities from the mentions array
    const sendMentions = anchorTelegramMentions(text, mentions);
    const entities = await telegramMentionEntities(accountId, listener.client, sendMentions);

    const sendOpts: any = { message: text };
    // GramJS client.sendMessage only reads `formattingEntities` (the `entities` key is ignored → name mentions never reach
    // Telegram). With formattingEntities, GramJS no longer parses markdown (**, __, ~~, `), so use them only when the text has none of those
    // symbols (the mention position is computed on the original text); if the symbols are present, keep the old behavior.
    if (entities.length > 0 && !/\*\*|__|~~|`/.test(text)) sendOpts.formattingEntities = entities;
    if (replyToMsgId) sendOpts.replyTo = Number(replyToMsgId);

    const sentAt = Date.now();
    let result: any;
    try {
      result = await listener.client.sendMessage(peer, sendOpts);
    } catch (err: any) {
      if (!sendOpts.formattingEntities || !isTelegramMentionEntityError(err)) throw err;
      delete sendOpts.formattingEntities;
      result = await listener.client.sendMessage(peer, sendOpts);
    }
    const msgId = String(result?.id || Date.now());

    // Save sent message to DB (INSERT OR IGNORE: the socket echo skips it if it already exists). Server time of the message (`date`), not
    // the machine's clock: a machine running a few seconds fast would let a customer's immediate reply sort BEFORE this message (echo cannot overwrite it)
    const now = telegramSentTimestamp(result, sentAt);
    const threadType = chatId.startsWith('-') ? 1 : 0;
    // Build quote_data if this is a reply
    const quoteData = sentReplyQuoteData(accountId, chatId, replyToMsgId);
    const mentionAttachments = telegramMentionAttachments(sendMentions, text);
    // Channel post: the message just posted shows at once as "Bài đăng kênh" (Channel post); previously only after the next sync
    const postAttachment = sentChannelPostAttachment(accountId, chatId, result);
    // Link in the text: the preview in Telegram's answer is saved with the message (card + page photo, as history saves it), so it
    // shows at once instead of after reopening the conversation. A preview Telegram is still fetching is asked for again below.
    const linkPreview = sentLinkPreview(result);
    const msgType = linkPreview?.msgType || 'text';
    const rowAttachments = withLinkPreview(
      postAttachment ? [postAttachment, ...mentionAttachments] : mentionAttachments,
      linkPreview?.attachments || [],
    );
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`
        INSERT OR IGNORE INTO messages
          (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user', ?, ?)
      `, [msgId, accountId, chatId, threadType, accountId, text, msgType, now, JSON.stringify(rowAttachments), replyToMsgId || null, quoteData]);

      // Update contacts (last_message, last_message_time): ensures the conversation list updates right away
      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
          channel = 'telegram_user'
      `, [accountId, chatId, threadType === 1 ? 'group' : 'user', text, now]);
    }

    // Emit event for the renderer: the socket echo will be skipped because persistTelegramMessage returns 'existing'
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: {
        channel: 'telegram_user',
        type: threadType,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: text,
          preview: text,
          msgType,
          channel: 'telegram_user',
          ts: String(now),
          replyToId: replyToMsgId || undefined,
          quoteData: quoteData || undefined,
          attachments: rowAttachments,
        },
      },
    });

    followSentLinkPreview(accountId, listener.client, chatId, msgId, result, linkPreview);
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

/** A message named by an UpdatePinned* may be stored a moment later (same update batch): look again once after this. */
const TELEGRAM_PIN_UPDATE_RETRY_MS = 3_000;

/** Pin row of a Telegram message already stored in the DB (same fields as syncPinnedMessages builds). */
function telegramPinFromRow(accountId: string, chatId: string, row: any) {
  const db = DatabaseService.getInstance();
  let previewImage = '';
  try {
    const paths = JSON.parse(row?.local_paths || '{}');
    previewImage = paths.main || paths.file || paths.image || paths.thumbnail || paths.video || '';
  } catch {}
  const senderId = String(row?.sender_id || '');
  const senderPeer: any = senderId ? db?.getTelegramPeer(accountId, senderId) : null;
  const senderName = String(senderPeer?.display_name || '') || tr('Thành viên Telegram');
  const timestamp = Number(row?.timestamp) || Date.now();
  return {
    msgId: String(row.msg_id), msgType: String(row.msg_type || 'text'), content: String(row.content || ''),
    previewText: String(row.content || ''), previewImage, senderId, senderName, timestamp, pinnedAt: timestamp,
  };
}

/**
 * UpdatePinnedMessages / UpdatePinnedChannelMessages: apply the change to the local pin list, no network call.
 * Unpin → remove those messages. Pin → list the ones already stored (only the newest TELEGRAM_PINNED_LIMIT are kept); a
 * message not stored yet is looked up once more shortly after, otherwise it arrives with the next sync when the chat opens.
 */
function applyTelegramPinnedUpdate(accountId: string, chatId: string, messageIds: unknown, pinned: boolean, retry = true): void {
  const db = DatabaseService.getInstance();
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map(id => String(id ?? '')).filter(id => id && id !== '0'))];
  if (!db || !accountId || !chatId || ids.length === 0) return;
  let changed = false;
  if (!pinned) {
    for (const id of ids) db.unpinMessage(accountId, chatId, id);
    changed = true;
  } else {
    const missing: string[] = [];
    for (const id of ids) {
      const row: any = db.getMessageById(accountId, id, chatId);
      if (!row || (row.channel && row.channel !== 'telegram_user')) { missing.push(id); continue; }
      db.pinMessage(accountId, chatId, telegramPinFromRow(accountId, chatId, row));
      changed = true;
    }
    if (changed) db.trimRemotePinnedMessages(accountId, chatId, TELEGRAM_PINNED_LIMIT);
    if (missing.length && retry) {
      const timer: any = setTimeout(() => applyTelegramPinnedUpdate(accountId, chatId, missing, true, false), TELEGRAM_PIN_UPDATE_RETRY_MS);
      timer?.unref?.();
    }
  }
  if (changed) EventBroadcaster.emit('event:pinsUpdated', { zaloId: accountId, threadId: chatId });
}

/**
 * Pinned messages of a chat from Telegram into the local pin list: the newest TELEGRAM_PINNED_LIMIT only (one request).
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

    // ONE page: the newest pins. Telegram pins every channel post automatically in the linked discussion group, so paging
    // through all pins downloaded whole channel histories (49,949 "pins" in one group, hundreds of requests per sync).
    const result: any = await listener.client.invoke(new Api.messages.Search({
      peer, q: '', filter: new Api.InputMessagesFilterPinned(), minDate: 0, maxDate: 0,
      offsetId: 0, addOffset: 0, limit: TELEGRAM_PINNED_LIMIT, maxId: 0, minId: 0, hash: BigInt(0) as any,
    }));
    for (const entity of [...(result?.users || []), ...(result?.chats || [])]) {
      const entityId = getCanonicalChatId(entity);
      if (!entityId) continue;
      entities.set(entityId, entity);
      cacheTelegramPeer(accountId, entityId, entity);
    }
    for (const message of result?.messages || []) {
      // Only messages Telegram flags as pinned: an ordinary message is never stored as a pin
      if (message?.className !== 'Message' || message.pinned === false) continue;
      const messageId = String(message.id || '');
      if (!messageId || seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
      pinnedMessages.push(message);
      if (pinnedMessages.length >= TELEGRAM_PINNED_LIMIT) break;
    }
    const peerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const chatEntity = entities.get(chatId);
    const chatDisplayName = chatEntity?.title
      || db?.getTelegramPeer(accountId, chatId)?.display_name
      || db?.queryOne<any>(
        `SELECT display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [accountId, chatId],
      )?.display_name
      || tr('Kênh/Nhóm Telegram');
    const pins: any[] = [];
    for (const message of pinnedMessages) {
        const normalized = normalizeTelegramMessageMedia(message, peerType);
        const senderId = getCanonicalChatId(message.fromId)
          || String(message.senderId?.valueOf?.() || '');
        const sender = entities.get(senderId);
        const senderName = sender
          ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.title || sender.username || chatDisplayName
          : senderId === chatId ? chatDisplayName : tr('Thành viên Telegram');
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
          // Telegram's pinned search returns messages in an API-dependent
          // order and does not expose the moment they were pinned. Persist the
          // message time so the UI consistently shows newest message first.
          pinnedAt: Number(message.date || 0) * 1000,
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
      await downloadMediaForMessage(accountId, listener.client, message, messageId, normalized.msgType, chatId, { urgency: 'visible' });
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
  opts?: { limit?: number; offsetId?: number; topicRootMessageId?: string; returnMessages?: boolean }
): Promise<{ success: boolean; messages?: any[]; count?: number; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  // Channel post without a topic: filtering by replyTo returns COMMENTS (messages of the discussion group) → saving them into the channel conversation then
  // shows extra messages between the posts. Comments go through getPostDiscussion.
  if (opts?.topicRootMessageId && DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId)?.peer_type === 'channel') {
    return { success: false, error: 'NOT_A_FORUM' };
  }

  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    // The header accepts up to 5,000. Do not pass that large limit through
    // GramJS's iterator: it has a first-page negative timeout bug and bursts
    // requests into Telegram. Fetch bounded pages ourselves instead.
    const requestedLimit = Number(opts?.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50, 1),
      MAX_MANUAL_MESSAGE_DOWNLOAD,
    );
    const rawMessages: any[] = [];
    const PAGE_SIZE = 100;
    const PAGE_DELAY_MS = 1000;
    let offsetId = Number(opts?.offsetId || 0);
    while (rawMessages.length < limit) {
      const pageLimit = Math.min(PAGE_SIZE, limit - rawMessages.length);
      const fetchOpts: any = { limit: pageLimit, offsetId };
      // For forum topics, use replyToMsgId filter.
      if (opts?.topicRootMessageId) fetchOpts.replyTo = Number(opts.topicRootMessageId);
      const page: any[] = await listener.client.getMessages(peer, fetchOpts);
      if (!page.length) break;
      rawMessages.push(...page);

      const oldestId = Math.min(...page.map((message: any) => Number(message?.id || 0)).filter(Boolean));
      if (!Number.isFinite(oldestId) || (offsetId > 0 && oldestId >= offsetId) || page.length < pageLimit) break;
      offsetId = oldestId;

      if (rawMessages.length < limit) {
        await new Promise(resolve => setTimeout(resolve, PAGE_DELAY_MS));
      }
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
      const isSelf = isOwnTelegramMessage(msg, accountId, chatId);
      const timestamp = ((msg as any).date || Math.floor(Date.now() / 1000)) * 1000;

      const cachedPeerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
      const { content, msgType, attachments } = normalizeTelegramMessageMedia(msg, cachedPeerType);
      // System message with no display text → not saved (previously became an empty message / channel post)
      if ((msg as any).className === 'MessageService' && !content) continue;
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
          // Sender name: the entity that comes with the history page (user / channel) → DB
          let origSenderName = telegramEntityName((rawOriginal as any).sender);
          if (!origSenderName && origSenderId) {
            origSenderName = resolveTelegramQuoteSenderName(db, accountId, chatId, origSenderId);
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
            const origSenderName2 = resolveTelegramQuoteSenderName(db, accountId, chatId, original.sender_id);
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
          // System message wrongly saved as an empty message / "bài đăng kênh" (channel post) in the old version → fixed into a notice line
          db.run(`
            UPDATE messages
            SET attachments = CASE WHEN ? = 'system' THEN '[]' WHEN ? != '[]' THEN ? ELSE attachments END,
                msg_type = CASE WHEN msg_type = 'text' AND ? != 'text' THEN ? ELSE msg_type END,
                content = CASE WHEN ? = 'system' AND COALESCE(content, '') = '' THEN ? ELSE content END,
                reactions = ?,
                reply_to_id = ?,
                quote_data = COALESCE(quote_data, ?),
                topic_id = COALESCE(topic_id, ?)
            WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
          `, [msgType, JSON.stringify(attachments), JSON.stringify(attachments), msgType, msgType, msgType, content, JSON.stringify(reactions), replyToId || null, quoteData || null, topicId || null, msgId, accountId, chatId]);
        } catch {}
      }

      handleRichMessageExtras(accountId, listener.client, chatId, msg);
      // API history can contain media that was never seen by the realtime
      // listener. Hydrate the visible item and let event:localPath update the
      // same store row; existing files are never downloaded again.
      const hasLocalMedia = !!existingMessage?.local_paths && existingMessage.local_paths !== '{}';
      if ((msg as any).media && !hasLocalMedia && scheduledMediaDownloads < 12) {
        scheduledMediaDownloads++;
        downloadMediaForMessage(accountId, listener.client, msg, msgId, msgType, chatId).catch(() => {});
      }

      // History imports can contain thousands of rows. Yield periodically so
      // Electron can paint, handle IPC, and keep the connection heartbeat alive
      // instead of monopolising the main process in one synchronous loop.
      if (messages.length % 100 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    // Notify UI to refresh contacts from DB (updates last_message/time in conversation list). The rows above are stored with
    // INSERT OR IGNORE only, so the conversation row must take its newest message here: otherwise the refresh brought back a
    // row with no time and the conversation just opened dropped to the bottom of the list.
    if (messages.length > 0) {
      refreshTelegramContactLastMessage(accountId, chatId);
      EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_get_messages' });
    }
    // Manual history import only needs the persisted rows. Returning thousands
    // of rich message objects across IPC duplicates memory in main/preload/
    // renderer and makes the chat appear frozen.
    return opts?.returnMessages === false
      ? { success: true, count: messages.length }
      : { success: true, messages, count: messages.length };
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
      const senderName = resolveTelegramQuoteSenderName(db, accountId, chatId, original.sender_id);
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
            accountId, listener.client, original, replyToId, normalized.msgType, chatId, { urgency: 'visible' },
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
type MediaRepairResult = {
  success: boolean;
  localPaths?: Record<string, string>;
  attachments?: any[];
  msgType?: string;
  error?: string;
};

/** Media reload requests from the same conversation are grouped within this window (opening a conversation: the bubbles missing files ask at the same time). */
const MEDIA_REPAIR_BATCH_MS = 40;
/** One getMessages by id takes at most 100 messages. */
const MEDIA_REPAIR_BATCH_MAX = 100;
/**
 * A reload request while the account is connected (just opened the app, network just came back) waits for the connection instead of failing at once: each bubble
 * asks only once; a failure means the conversation has no image / video until it is reopened. Below the 60 s limit of the employee proxy.
 */
const MEDIA_REPAIR_CONNECT_WAIT_MS = 45_000;
const MEDIA_REPAIR_CONNECT_POLL_MS = 500;
const mediaRepairConnectWaits = new Map<string, Promise<boolean>>();
type MediaRepairWaiter = { urgency: TelegramDownloadUrgency; resolve: (result: MediaRepairResult) => void };
type MediaRepairBatch = {
  accountId: string;
  chatId: string;
  waiters: Map<string, MediaRepairWaiter[]>;
  timer: ReturnType<typeof setTimeout> | null;
};
const mediaRepairBatches = new Map<string, MediaRepairBatch>();

/**
 * A bubble missing a file (image / video / file / sticker not downloaded yet) asks for a reload. Previously each request was 1 getMessages RPC and
 * waited for the download to finish, running one by one in the order bubbles show (old at the top → new at the bottom): the newest message's file came last. Now:
 * requests for the same conversation are grouped into 1 RPC, the files go into the download queue with the "giao diện xin" (UI request) priority (`urgent` = the user clicked download),
 * and the download queue picks the open conversation + the newest message first.
 */
export function repairMessageMedia(
  accountId: string,
  chatId: string,
  messageId: string,
  opts: { urgent?: boolean } = {},
): Promise<MediaRepairResult> {
  const listener = activeListeners.get(accountId);
  const numericMessageId = Number(messageId);
  const urgency: TelegramDownloadUrgency = opts.urgent ? 'urgent' : 'visible';
  tgLog('info', accountId, 'history', 'MEDIA_REPAIR_REQUESTED', {
    chatId,
    messageId,
    urgency,
    connected: !!listener?.connected,
  });
  const notConnected = (): MediaRepairResult => {
    tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_DEFERRED_NOT_CONNECTED', { chatId, messageId });
    return { success: false, error: 'Telegram listener is not connected' };
  };
  if (!listener || listener.stopped || listener.sessionInvalid) return Promise.resolve(notConnected());
  if (!chatId || !Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    return Promise.resolve({ success: false, error: 'Invalid Telegram media identity' });
  }
  return waitForMediaRepairConnection(accountId).then(connected => {
    if (!connected) return notConnected();
    return reuseQueuedMediaDownload(accountId, chatId, messageId, urgency).then(reused => reused
      ?? new Promise<MediaRepairResult>(resolve => addMediaRepairRequest(accountId, chatId, messageId, { urgency, resolve })));
  });
}

/** Account connected (or connected within MEDIA_REPAIR_CONNECT_WAIT_MS). One shared wait for all bubbles. */
function waitForMediaRepairConnection(accountId: string): Promise<boolean> {
  const state = (): boolean | null => {
    const listener = activeListeners.get(accountId);
    if (!listener || listener.stopped || listener.sessionInvalid) return false;
    return listener.client && listener.connected ? true : null;
  };
  const now = state();
  if (now !== null) return Promise.resolve(now);
  const existing = mediaRepairConnectWaits.get(accountId);
  if (existing) return existing;
  const waiting = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MEDIA_REPAIR_CONNECT_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, MEDIA_REPAIR_CONNECT_POLL_MS));
      const current = state();
      if (current !== null) return current;
    }
    return false;
  })().finally(() => {
    mediaRepairConnectWaits.delete(accountId);
  });
  mediaRepairConnectWaits.set(accountId, waiting);
  return waiting;
}

/**
 * The file is already in the download queue (realtime message / catch-up / history / an earlier open) → raise its priority, reuse that pass, no RPC.
 * If that pass failed (file reference expired…) → null: request the message from Telegram as usual.
 */
async function reuseQueuedMediaDownload(
  accountId: string,
  chatId: string,
  messageId: string,
  urgency: TelegramDownloadUrgency,
): Promise<MediaRepairResult | null> {
  const queued = telegramDownloads.promote(accountId, `media:${chatId}:${messageId}`, { threadId: chatId, urgency });
  if (!queued) return null;
  try { await queued; } catch {}
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
  return null;
}

function addMediaRepairRequest(accountId: string, chatId: string, messageId: string, waiter: MediaRepairWaiter): void {
  const batchKey = `${accountId}\u0000${chatId}`;
  let batch = mediaRepairBatches.get(batchKey);
  if (!batch) {
    batch = { accountId, chatId, waiters: new Map(), timer: null };
    mediaRepairBatches.set(batchKey, batch);
    batch.timer = setTimeout(() => flushMediaRepairBatch(batchKey), MEDIA_REPAIR_BATCH_MS);
  }
  const waiters = batch.waiters.get(messageId) || [];
  waiters.push(waiter);
  batch.waiters.set(messageId, waiters);
  if (batch.waiters.size >= MEDIA_REPAIR_BATCH_MAX) flushMediaRepairBatch(batchKey);
}

function flushMediaRepairBatch(batchKey: string): void {
  const batch = mediaRepairBatches.get(batchKey);
  if (!batch) return;
  mediaRepairBatches.delete(batchKey);
  if (batch.timer) clearTimeout(batch.timer);
  const { accountId, chatId, waiters } = batch;
  // Only the RPC part runs one by one per account; the download itself is in the download queue, not waited for here
  const previous = mediaRepairQueues.get(accountId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => fetchMediaRepairBatch(accountId, chatId, waiters));
  let settled!: Promise<void>;
  settled = task.finally(() => {
    if (mediaRepairQueues.get(accountId) === settled) mediaRepairQueues.delete(accountId);
  });
  mediaRepairQueues.set(accountId, settled);
}

async function fetchMediaRepairBatch(
  accountId: string,
  chatId: string,
  waiters: Map<string, MediaRepairWaiter[]>,
): Promise<void> {
  const settle = (messageId: string, result: MediaRepairResult) => {
    for (const waiter of waiters.get(messageId) || []) waiter.resolve(result);
  };
  const messageIds = [...waiters.keys()];
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    for (const messageId of messageIds) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_DEFERRED_NOT_CONNECTED', { chatId, messageId });
      settle(messageId, { success: false, error: 'Telegram listener is not connected' });
    }
    return;
  }
  const client = listener.client;

  let fetched: any[] = [];
  try {
    const peer = await resolveInputPeer(accountId, client, chatId);
    fetched = (await client.getMessages(peer, { ids: messageIds.map(Number) })) || [];
  } catch (err: any) {
    const error = err?.message || String(err);
    for (const messageId of messageIds) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_FAILED', { chatId, messageId, error });
      settle(messageId, { success: false, error });
    }
    return;
  }

  const db = DatabaseService.getInstance();
  const cachedPeerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
  const ready: Array<{ messageId: string; message: any }> = [];
  for (const messageId of messageIds) {
    const message = fetched.find((item: any) => String(item?.id || '') === messageId);
    if (!message) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_MESSAGE_NOT_FOUND', { chatId, messageId });
      settle(messageId, { success: false, error: 'Telegram message was not found' });
      continue;
    }
    if (!(message as any).media) {
      tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_NO_MEDIA', {
        chatId,
        messageId,
        messageClass: (message as any)?.className || '-',
      });
      settle(messageId, { success: false, error: 'Telegram message no longer contains media' });
      continue;
    }
    ready.push({ messageId, message });
  }

  // Newest message goes first: the first pass runs at once when the queue is idle
  ready.sort((a, b) => (telegramMessageTimeMs(b.message) ?? 0) - (telegramMessageTimeMs(a.message) ?? 0));
  for (const { messageId, message } of ready) {
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

    const urgency: TelegramDownloadUrgency = (waiters.get(messageId) || []).some(waiter => waiter.urgency === 'urgent')
      ? 'urgent'
      : 'visible';
    downloadMediaForMessage(accountId, client, message, messageId, normalized.msgType, chatId, { urgency })
      .then((localPath): MediaRepairResult => {
        if (!localPath) return { success: false, error: 'Telegram media download returned no data' };
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
        return { success: true, localPaths, attachments: normalized.attachments, msgType: normalized.msgType };
      }, (err: any): MediaRepairResult => {
        const error = err?.message || String(err);
        tgLog('warn', accountId, 'history', 'MEDIA_REPAIR_FAILED', { chatId, messageId, error });
        return { success: false, error };
      })
      .then(result => settle(messageId, result));
  }
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
      if (resolved) handleRichMessageExtras(accountId, listener.client, chatId, message);
      const result = {
        messageId, resolved, content: normalized.content, msgType: normalized.msgType,
        attachments: normalized.attachments, mediaClass,
      };
      results.push(result);
      tgLog(resolved ? 'info' : 'warn', accountId, 'history', resolved ? 'EMPTY_MESSAGE_REPAIRED' : 'EMPTY_MESSAGE_UNRESOLVED', {
        chatId, messageId, msgType: normalized.msgType, mediaClass,
      });
    }
    if (results.some(result => result.resolved)) refreshTelegramContactPreview(accountId, chatId);
    return { success: true, results };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Old records missing link-card info (saved before title / description existed, or a link video without a card): fetch the messages again
 * from Telegram in 1 RPC for the whole batch (up to 100), normalize the attachments again. Do NOT download media, do not change content,
 * the unread count, or the new-message event. The renderer groups them by conversation when the card appears (telegramPreviewRefresh.ts).
 */
export async function refreshMessageAttachments(
  accountId: string,
  chatId: string,
  messageIds: string[],
): Promise<{ success: boolean; messages?: Array<{ messageId: string; attachments: any[] }>; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram listener is not connected' };
  const ids = [...new Set((messageIds || []).map(Number))]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 100);
  if (!chatId || ids.length === 0) return { success: true, messages: [] };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const fetched = await listener.client.getMessages(peer, { ids });
    const db = DatabaseService.getInstance();
    const cachedPeerType = db?.getTelegramPeer(accountId, chatId)?.peer_type as TelegramPeerType | undefined;
    const messages: Array<{ messageId: string; attachments: any[] }> = [];
    for (const message of fetched || []) {
      if (!message || (message as any).className === 'MessageEmpty' || !(message as any).id) continue;
      const messageId = String((message as any).id);
      const normalized = normalizeTelegramMessageMedia(message, cachedPeerType);
      if (!normalized.attachments.length) continue;
      db?.run(
        `UPDATE messages SET attachments = ?
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND msg_type != 'recalled'`,
        [JSON.stringify(normalized.attachments), messageId, accountId, chatId],
      );
      messages.push({ messageId, attachments: normalized.attachments });
    }
    tgLog('info', accountId, 'history', 'ATTACHMENTS_REFRESHED', { chatId, requested: ids.length, refreshed: messages.length });
    return { success: true, messages };
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'ATTACHMENTS_REFRESH_FAILED', { chatId, requested: ids.length, error: err?.message || String(err) });
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
/** ffmpeg bundled with the app (ffmpeg-static; the packaged copy lives outside the asar); if missing, try ffmpeg on the machine. */
function ffmpegBinary(): string {
  try {
    let bin = require('ffmpeg-static') as string;
    if (bin && bin.includes('app.asar') && !bin.includes('app.asar.unpacked')) bin = bin.replace('app.asar', 'app.asar.unpacked');
    if (bin && fs.existsSync(bin)) return bin;
  } catch {}
  return 'ffmpeg';
}

/** Duration (seconds) from the ffmpeg log: "Duration: hh:mm:ss.xx"; Chromium's recording has none, so use the last "time=" mark. */
export function ffmpegLogDurationSeconds(log: string): number {
  const toSeconds = (h: string, m: string, sec: string) => Number(h) * 3600 + Number(m) * 60 + Number(sec);
  const declared = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (declared) return Math.max(1, Math.round(toSeconds(declared[1], declared[2], declared[3])));
  const progress = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  return progress ? Math.max(1, Math.round(toSeconds(progress[1], progress[2], progress[3]))) : 0;
}

/**
 * A Telegram voice message like the Telegram app: OGG/Opus + DocumentAttributeAudio{voice, duration}. An in-app recording (Chromium) comes out as
 * WebM/Opus → change the container to OGG without re-encoding (if that fails, encode Opus at 32 kb/s). ffmpeg runs in the background (does not block the main
 * thread); on error → send the original file.
 */
async function prepareTelegramVoiceNote(inputPath: string): Promise<{ path: string; duration: number }> {
  const { execFile } = require('child_process') as typeof import('child_process');
  const run = (args: string[]) => new Promise<{ ok: boolean; log: string }>((resolve) => {
    execFile(ffmpegBinary(), args, { timeout: 60_000, windowsHide: true }, (err, _stdout, stderr) => {
      resolve({ ok: !err, log: String(stderr || '') });
    });
  });
  const ext = (inputPath.split('.').pop() || '').toLowerCase();
  if (ext === 'ogg' || ext === 'oga' || ext === 'opus') {
    const probe = await run(['-hide_banner', '-i', inputPath, '-f', 'null', '-']);
    return { path: inputPath, duration: ffmpegLogDurationSeconds(probe.log) };
  }
  const out = inputPath.replace(/\.[^.\\/]+$/, '') + '.voice.ogg';
  let result = await run(['-y', '-hide_banner', '-i', inputPath, '-vn', '-c:a', 'copy', out]);
  if (!result.ok || !fs.existsSync(out)) {
    result = await run(['-y', '-hide_banner', '-i', inputPath, '-vn', '-c:a', 'libopus', '-b:a', '32k', out]);
  }
  if (!result.ok || !fs.existsSync(out)) {
    Logger.warn(`[TG:voice] ffmpeg không đổi được sang OGG: ${result.log.slice(-200)}`);
    return { path: inputPath, duration: ffmpegLogDurationSeconds(result.log) };
  }
  return { path: out, duration: ffmpegLogDurationSeconds(result.log) };
}

/** sendFile for a voice message: OGG/Opus + voice flag + duration (like an in-app recording in the Telegram app). */
async function applyTelegramVoiceNote(sendOpts: any, resolvedPath: string): Promise<string> {
  const { Api } = require('telegram');
  const voice = await prepareTelegramVoiceNote(resolvedPath);
  sendOpts.file = voice.path;
  sendOpts.voiceNote = true;
  sendOpts.attributes = [new Api.DocumentAttributeAudio({ voice: true, duration: voice.duration })];
  return voice.path;
}

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

    // Resolve local-media URLs and storage-relative DB paths before upload.
    let resolvedPath = resolveTelegramUploadPath(filePath);
    resolvedPath = resolvedPath.replace(/\//g, pathMod.sep);
    if (!fs.existsSync(resolvedPath)) {
      Logger.error(`[TG:sendFile] File not found: ${resolvedPath} (original: ${filePath})`);
      return { success: false, error: tr('File không tồn tại: {{v1}}', { v1: pathMod.basename(resolvedPath) }) };
    }
    Logger.log(`[TG:sendFile] STEP1 Sending ${resolvedPath}`);

    // Use client.sendFile() — handles upload + response parsing + message ID extraction
    const sendOpts: any = { file: resolvedPath, forceDocument: fileType === 'file' };
    // GramJS sendFile reads `caption` (a `message` key is ignored → the caption never reached Telegram).
    if (caption) sendOpts.caption = caption;
    if (replyToMsgId) sendOpts.replyTo = Number(replyToMsgId);
    // In-app recording → a real voice message (OGG/Opus, duration)
    if (fileType === 'voice') resolvedPath = await applyTelegramVoiceNote(sendOpts, resolvedPath);

    Logger.log(`[TG:sendFile] STEP2 sendOpts:`, JSON.stringify({ file: resolvedPath, forceDocument: sendOpts.forceDocument, hasCaption: !!caption }));
    const sentAt = Date.now();
    const result = await listener.client.sendFile(peer, sendOpts);
    // client.sendFile() returns a Message object with .id (proper 32-bit Telegram msgId)
    const msgId = String(result?.id || '');
    // Server time of the message (`date`): do not use the machine's clock (see sendMessage)
    const now = telegramSentTimestamp(result, sentAt);
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

    // Determine msgType: prefer fileType from the UI, fall back to the extension, then to the media attributes
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

    const postAttachment = sentChannelPostAttachment(accountId, chatId, result);
    if (postAttachment) attachments.unshift(postAttachment);

    // Media preview for contacts.last_message
    const mediaPreview = msgType === 'photo' ? '🖼️ Hình ảnh'
      : msgType === 'video' ? '🎬 Video'
      : msgType === 'voice' ? '🎤 Tin nhắn thoại'
      : msgType === 'audio' ? '🎵 Audio'
      : caption || '📎 File';

    // Build quote_data if this is a reply
    const quoteData = sentReplyQuoteData(accountId, chatId, replyToMsgId);

    // Save to DB WITH attachments (the socket echo will be skipped because it already exists)
    const db = DatabaseService.getInstance();
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user', ?, ?)`,
        [msgId, accountId, chatId, threadType, accountId, caption || '', msgType, now, JSON.stringify(attachments), replyToMsgId || null, quoteData]);

      db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
          channel = 'telegram_user'
      `, [accountId, chatId, threadType === 1 ? 'group' : 'user', mediaPreview, now]);
      Logger.log(`[TG:sendFile] STEP5 DB saved msgId=${msgId} msgType=${msgType} attachments=${attachments.length}`);
    }

    // Emit event so the UI adds the message at once (correct msgType; the socket echo does NOT arrive for self-sent messages)
    Logger.log(`[TG:sendFile] EMITTING event: msgId=${msgId} msgType=${msgType} chatId=${chatId}`);
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: {
        channel: 'telegram_user',
        type: threadType,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: caption || '',
          preview: getTelegramMessagePreview(msgType, caption || ''),
          msgType,
          channel: 'telegram_user',
          ts: String(now),
          attachments,
          replyToId: replyToMsgId || undefined,
          quoteData: quoteData || undefined,
        },
      },
    });
    Logger.log(`[TG:sendFile] STEP6 EVENT_EMITTED msgId=${msgId}`);

    // Trigger the background download NOW: do not rely on handleNewMessage
    // (the socket echo may not arrive for self-sent GramJS messages)
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

/** Telegram media groups hold 2–10 items. */
const TELEGRAM_ALBUM_MAX = 10;

/**
 * Send several images as one album, the caption on the first item (Telegram shows it under the
 * album). GramJS does not feed RPC results to the update handlers, so every message of the album
 * is persisted through handleNewMessage — the same path as an own message sent from another
 * device (grouped media attachment, contact preview, silent UI event, media hydration).
 */
export async function sendAlbum(
  accountId: string,
  chatId: string,
  filePaths: string[],
  caption?: string,
  opts?: { topicRootMessageId?: string; replyToMsgId?: string },
): Promise<{ success: boolean; messageId?: string; messageIds?: string[]; error?: string }> {
  const files = filePaths.filter(Boolean);
  if (files.length === 0) return { success: false, error: tr('Không có ảnh để gửi') };
  if (files.length === 1) {
    // A one-item "album" is rejected by messages.SendMultiMedia → the plain file sender (which also handles topics)
    if (opts?.topicRootMessageId) {
      return sendTopicFile(accountId, chatId, opts.topicRootMessageId, files[0], caption, 'image', opts.replyToMsgId);
    }
    return sendFile(accountId, chatId, files[0], caption, 'image', opts?.replyToMsgId);
  }

  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: `Rate limited. Wait ${rateLimit.waitSeconds}s.` };
  try {
    const pathMod = require('path');
    const fs = require('fs');
    const resolved = files.map(file => resolveTelegramUploadPath(file).replace(/\//g, pathMod.sep));
    const missing = resolved.find((file: string) => !fs.existsSync(file));
    if (missing) return { success: false, error: tr('File không tồn tại: {{v1}}', { v1: pathMod.basename(missing) }) };

    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    // Forum topic / channel post comment thread: the album must enter the topic, so it replies to the topic root
    // (or to the quoted message) with topMsgId, exactly like sendTopicFile does for a single file.
    const topicRoot = opts?.topicRootMessageId ? Number(opts.topicRootMessageId) : 0;
    const replyTarget = opts?.replyToMsgId && /^\d+$/.test(String(opts.replyToMsgId))
      ? Number(opts.replyToMsgId)
      : (topicRoot || undefined);
    const messageIds: string[] = [];
    for (let start = 0; start < resolved.length; start += TELEGRAM_ALBUM_MAX) {
      const chunk = resolved.slice(start, start + TELEGRAM_ALBUM_MAX);
      const sendOpts: any = {
        // A one-item "album" is rejected by messages.SendMultiMedia → plain photo.
        file: chunk.length === 1 ? chunk[0] : chunk,
        caption: start === 0 ? (caption || '') : '',
      };
      if (replyTarget) sendOpts.replyTo = replyTarget;
      if (topicRoot) sendOpts.topMsgId = topicRoot;
      const result: any = await listener.client.sendFile(peer, sendOpts);
      const sent = (Array.isArray(result) ? result : [result]).filter(Boolean);
      for (const message of sent) {
        messageIds.push(String(message.id));
        try {
          await handleNewMessage(accountId, { message } as any, listener.client, 'history');
        } catch (persistErr: any) {
          tgLog('warn', accountId, 'history', 'ALBUM_PERSIST_FAILED', {
            chatId,
            messageId: String(message.id),
            error: persistErr?.message || String(persistErr),
          });
        }
      }
    }
    Logger.log(`[TG:sendAlbum] SUCCESS chat=${chatId} items=${resolved.length} messages=${messageIds.length} caption=${!!caption}`);
    return { success: true, messageId: messageIds[0], messageIds };
  } catch (err: any) {
    Logger.error(`[TG:sendAlbum] FAILED: ${err.message}`);
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
 * Step 1: Send the OTP code to the phone number
 */
export async function sendCode(phoneNumber: string): Promise<{ success: boolean; phoneCodeHash?: string; error?: string }> {
  if (!API_ID || !API_HASH) {
    return { success: false, error: tr('Telegram API credentials chưa được cấu hình') };
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
 * Step 2: Confirm the OTP code
 */
export async function signIn(phoneNumber: string, code: string, phoneCodeHash: string): Promise<{
  success: boolean; stringSession?: string; accountId?: string;
  userInfo?: { firstName: string; lastName: string; phone: string; username: string };
  error?: string;
}> {
  const pending = getPendingLogin();
  if (!pending) {
    return { success: false, error: tr('Phiên đăng nhập đã hết hạn. Vui lòng thử lại.') };
  }
  if (pending.phoneNumber !== phoneNumber || pending.phoneCodeHash !== phoneCodeHash) {
    return { success: false, error: tr('Mã xác nhận không thuộc phiên đăng nhập hiện tại. Vui lòng gửi lại mã.') };
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

    // Get user info
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
// ── Reactions usable in a conversation (right-click menu / reaction bar) ─────────────────────────────────
const REACTION_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CHAT_REACTIONS_TTL_MS = 10 * 60 * 1000;
const reactionCatalogCache = new Map<string, Omit<TelegramReactionCatalog, 'chat'> & { at: number }>();
const chatReactionsCache = new Map<string, { at: number; chat: TelegramChatReactions }>();

/** Reaction strings exactly as in Telegram's list (without U+FE0F; matches the loaded list if there is one). */
function canonicalTelegramReaction(accountId: string, emoji: string): string {
  const normalized = normalizeTelegramReaction(emoji);
  const catalog = reactionCatalogCache.get(accountId);
  const match = catalog?.available.find((reaction) => normalizeTelegramReaction(reaction.emoticon) === normalized);
  return match?.emoticon || normalized;
}

function parseChatReactions(value: any): TelegramChatReactions {
  if (value?.className === 'ChatReactionsNone') return { kind: 'none' };
  if (value?.className === 'ChatReactionsSome') {
    return {
      kind: 'some',
      emoticons: (value.reactions || [])
        .filter((reaction: any) => reaction?.className === 'ReactionEmoji' && reaction.emoticon)
        .map((reaction: any) => String(reaction.emoticon)),
    };
  }
  return { kind: 'all' };
}

/**
 * Reactions usable in a conversation: the account's frequently used reactions come first (like Telegram's right-click menu).
 * The standard list + frequently used reactions + Premium: cached 6 hours per account; group / channel limits (set by admins, or reactions turned off): cached 10 minutes per conversation. Private chats: all standard reactions.
 */
export async function getAvailableReactions(
  accountId: string,
  chatId: string,
): Promise<{ success: boolean; reactions?: string[]; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const { Api } = require('telegram');
    const client = listener.client;
    let catalog = reactionCatalogCache.get(accountId);
    if (!catalog || Date.now() - catalog.at > REACTION_CATALOG_TTL_MS) {
      const [availableResult, topResult, me]: any[] = await Promise.all([
        client.invoke(new Api.messages.GetAvailableReactions({ hash: 0 })).catch(() => null),
        client.invoke(new Api.messages.GetTopReactions({ limit: 100, hash: BigInt(0) as any })).catch(() => null),
        client.getMe().catch(() => null),
      ]);
      catalog = {
        at: Date.now(),
        available: (availableResult?.reactions || [])
          .map((reaction: any) => ({ emoticon: String(reaction?.reaction || ''), premium: !!reaction?.premium, inactive: !!reaction?.inactive }))
          .filter((reaction: any) => reaction.emoticon),
        top: (topResult?.reactions || [])
          .filter((reaction: any) => reaction?.className === 'ReactionEmoji' && reaction.emoticon)
          .map((reaction: any) => String(reaction.emoticon)),
        isPremium: !!me?.premium,
      };
      // Could not get the standard list (network error…) → do not cache for long, ask again next time
      if (catalog.available.length > 0) reactionCatalogCache.set(accountId, catalog);
    }

    const chatKey = `${accountId}:${chatId}`;
    let chatEntry = chatReactionsCache.get(chatKey);
    if (!chatEntry || Date.now() - chatEntry.at > CHAT_REACTIONS_TTL_MS) {
      let chat: TelegramChatReactions = { kind: 'all' };
      if (String(chatId).startsWith('-')) {
        const full: any = String(chatId).startsWith('-100')
          ? await client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, client, chatId) })).catch(() => null)
          : await client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) })).catch(() => null);
        chat = parseChatReactions(full?.fullChat?.availableReactions);
      }
      chatEntry = { at: Date.now(), chat };
      chatReactionsCache.set(chatKey, chatEntry);
    }
    return { success: true, reactions: orderTelegramReactions({ ...catalog, chat: chatEntry.chat }) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

const QUICK_REACTION_TTL_MS = 6 * 60 * 60 * 1000;
const quickReactionCache = new Map<string, { at: number; emoji: string }>();

/**
 * The account's quick reaction (Telegram settings → Quick Reaction, `help.getConfig().reactions_default`): what Telegram sends on a
 * double-click and shows on the reaction button. Cached 6 hours per account. A custom emoji (Premium) is not a standard emoji
 * → null, and the renderer falls back to 👍 like Telegram's own default.
 */
export async function getQuickReaction(accountId: string): Promise<{ success: boolean; emoji?: string | null; error?: string }> {
  const cached = quickReactionCache.get(accountId);
  if (cached && Date.now() - cached.at < QUICK_REACTION_TTL_MS) return { success: true, emoji: cached.emoji || null };
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  try {
    const { Api } = require('telegram');
    const config: any = await listener.client.invoke(new Api.help.GetConfig());
    const reaction = config?.reactionsDefault;
    const emoji = reaction?.className === 'ReactionEmoji' && reaction.emoticon ? String(reaction.emoticon) : '';
    quickReactionCache.set(accountId, { at: Date.now(), emoji });
    return { success: true, emoji: emoji || null };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

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
    return { success: false, error: tr('Telegram message ID không hợp lệ.') };
  }

  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const emoticon = emoji ? canonicalTelegramReaction(accountId, emoji) : '';
    const result = await listener.client.invoke(new Api.messages.SendReaction({
      peer,
      msgId: numericMessageId,
      reaction: emoticon ? [new Api.ReactionEmoji({ emoticon })] : [],
      addToRecent: !!emoticon,
    }));
    // Result has UpdateMessageReactions with official counts → save + update the UI (replaces the temporary copy in the renderer)
    try {
      applyTelegramReactionResult(accountId, listener.client, result, true);
    } catch (applyErr: any) {
      Logger.warn(`[TelegramUser] sendReaction: không áp được kết quả reaction ${chatId}/${messageId}: ${applyErr?.message}`);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Reloads the official reactions of the messages (messages.GetMessagesReactions) and overwrites them. Fixes data that was wrongly added up
 * before (a channel post's reactions with a duplicate ID were written to another conversation's message) and syncs my own reactions.
 */
export async function refreshMessageReactions(
  accountId: string,
  chatId: string,
  messageIds: string[],
): Promise<{ success: boolean; applied?: number; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Not connected' };
  const ids = [...new Set(messageIds.map(id => Number(String(id).replace(/^tg_/, ''))))]
    .filter(id => Number.isSafeInteger(id) && id > 0)
    .slice(0, 100);
  if (!ids.length) return { success: true, applied: 0 };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const result = await listener.client.invoke(new Api.messages.GetMessagesReactions({ peer, id: ids }));
    return { success: true, applied: applyTelegramReactionResult(accountId, listener.client, result) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Send a file/media into a forum topic. GramJS maps `topMsgId` to
 * InputReplyToMessage.topMsgId, which is required in addition to a reply ID
 * so Telegram does not route the upload to the forum parent timeline. */
export async function sendTopicFile(accountId: string, chatId: string, topicRootMessageId: string, filePath: string, caption?: string, fileType?: string, replyToMsgId?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram client not connected' };
  // Discussion group not joined but comments are allowed: the "không gửi được" (cannot send) state saved belongs to the group chat, not to the comment
  const denial = isCommentOnlyGroup(accountId, chatId) ? null : getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: tr('Gửi tin quá nhanh. Vui lòng chờ {{waitSeconds}} giây.', { waitSeconds: rateLimit.waitSeconds }) };
  try {
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const pathMod = require('path');
    const fs = require('fs');

    // Resolve local-media URLs and storage-relative DB paths before upload.
    let resolvedPath = resolveTelegramUploadPath(filePath);
    resolvedPath = resolvedPath.replace(/\//g, pathMod.sep);
    if (!fs.existsSync(resolvedPath)) {
      Logger.error(`[TG:sendTopicFile] File not found: ${resolvedPath} (original: ${filePath})`);
      return { success: false, error: tr('File không tồn tại: {{v1}}', { v1: pathMod.basename(resolvedPath) }) };
    }
    Logger.log(`[TG:sendTopicFile] Sending ${resolvedPath}`);

    // Use client.sendFile() — handles upload + response parsing + message ID extraction.
    // GramJS only attaches InputReplyToMessage when `replyTo` is given: passing only topMsgId makes the file land in the group's main line (General).
    // Reply to the root message of a topic / comment thread, or to a specific message inside it (still with topMsgId)
    const replyTarget = replyToMsgId && /^\d+$/.test(String(replyToMsgId)) ? Number(replyToMsgId) : Number(topicRootMessageId);
    const sendOpts: any = { file: resolvedPath, forceDocument: fileType === 'file', replyTo: replyTarget, topMsgId: Number(topicRootMessageId) };
    // GramJS sendFile reads `caption` (a `message` key is ignored → the caption never reached Telegram).
    if (caption) sendOpts.caption = caption;
    // In-app recording → a real voice message (OGG/Opus, duration)
    if (fileType === 'voice') resolvedPath = await applyTelegramVoiceNote(sendOpts, resolvedPath);

    const sentAt = Date.now();
    const result = await listener.client.sendFile(peer, sendOpts);
    const msgId = String(result?.id || '');
    // Server time of the message (`date`): do not use the machine's clock (see sendMessage)
    const now = telegramSentTimestamp(result, sentAt);
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

    const mediaPreview = msgType === 'photo' ? '🖼️ Hình ảnh' : msgType === 'video' ? '🎬 Video' : msgType === 'voice' ? '🎤 Tin nhắn thoại' : msgType === 'audio' ? '🎵 Audio' : caption || '📎 File';

    // Save to DB WITH attachments (correct topic / comment thread + the replied-to message, with a quote like a received message)
    const replyToId = replyTarget !== Number(topicRootMessageId) ? String(replyTarget) : null;
    const quoteData = sentReplyQuoteData(accountId, chatId, replyToId);
    const db = DatabaseService.getInstance();
    const commentOnly = !!db && skipCommentOnlyConversation(db, accountId, chatId);
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, topic_id, quote_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user', ?, ?, ?)`,
        [msgId, accountId, chatId, threadType, accountId, caption || '', msgType, now, JSON.stringify(attachments), replyToId, topicRootMessageId, quoteData]);
      // Discussion group not joined: do not create a conversation (like Telegram)
      if (!commentOnly) db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others) VALUES (?, ?, '', '', 0, ?, 0, ?, ?, 'telegram_user', 0) ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END, last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END, channel = 'telegram_user'`,
        [accountId, chatId, threadType === 1 ? 'group' : 'user', mediaPreview, now]);
    }

    // Emit event with full attachments
    Logger.log(`[TG:sendTopicFile] EMITTING event: msgId=${msgId} msgType=${msgType} chatId=${chatId}`);
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: { channel: 'telegram_user', type: threadType, threadId: chatId, isSelf: true, _silentNotification: true,
        ...(commentOnly ? { _commentOnly: true } : {}),
        data: { uidFrom: accountId, idTo: chatId, msgId, content: caption || '', preview: getTelegramMessagePreview(msgType, caption || ''), msgType, channel: 'telegram_user', ts: String(now), attachments, topicId: topicRootMessageId, ...(replyToId ? { replyToId } : {}), ...(quoteData ? { quoteData } : {}) } },
    });
    Logger.log(`[TG:sendTopicFile] EVENT_EMITTED msgId=${msgId} msgType=${msgType} attachments=${attachments.length}`);

    return { success: true, messageId: msgId };
  } catch (err: any) {
    Logger.error(`[TG:sendTopicFile] FAILED: ${err?.message || err}`);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Step 3: Confirm the 2FA password (if any)
 */
export async function signIn2FA(password: string): Promise<{
  success: boolean; stringSession?: string; accountId?: string;
  userInfo?: { firstName: string; lastName: string; phone: string; username: string };
  error?: string;
}> {
  const pending = getPendingLogin();
  if (!pending) {
    return { success: false, error: tr('Phiên đăng nhập đã hết hạn. Vui lòng thử lại.') };
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

    // Get user info
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
 * Reset the avatar cache for 1 contact (when the user presses the "Cập nhật thông tin" (Update info) button)
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
  clearDisconnectConfirmTimer(listener);
  clearHealthCheck(listener);
  stopChannelPoller(listener);
  if (listener.client) {
    retireTelegramClient(listener.client, 'listener_stopped').catch(() => {});
  }
  activeListeners.delete(accountId);
  rawUpdateHandlers.delete(accountId);
  channelPollQueues.delete(accountId);
  activeChannelLeases.delete(accountId);
  channelDialogWatchStates.delete(accountId);
  channelDialogWatchTasks.delete(accountId);
  reconnectCatchUps.delete(accountId);
  pendingCatchUpModes.delete(accountId);
  catchUpFailureCounts.delete(accountId);
  recoveringUpdateAccounts.delete(accountId);
  syncingAccounts.delete(accountId);
  const historyInsertTimer = historyInsertTimers.get(accountId);
  if (historyInsertTimer) clearTimeout(historyInsertTimer);
  historyInsertTimers.delete(accountId);
  historyInsertThreadIds.delete(accountId);
  const drainTimer = channelRecoveryDrainTimers.get(accountId);
  if (drainTimer) clearTimeout(drainTimer);
  channelRecoveryDrainTimers.delete(accountId);
  channelRecoveryDrainDueAt.delete(accountId);
  channelHistoryRepairQueues.delete(accountId);
  for (const map of [
    activeChannelNextPollAt, channelDifferenceTimeouts, channelRecoveryFailures,
    typingChannelRecoveryAt, channelHistoryRepairs,
  ] as Map<string, unknown>[]) {
    deleteAccountChannelKeys(map, accountId);
  }
  for (const [key, timer] of typingChannelRecoveryTimers) {
    if (!key.startsWith(`${accountId}:`)) continue;
    clearTimeout(timer);
    typingChannelRecoveryTimers.delete(key);
  }
  channelRecoveryThrottles.delete(accountId);
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
 * Probe the primary connection now instead of waiting for GramJS's next ping
 * or the reconnect backoff. A dead or offline listener is rebuilt within a
 * second; a live one that survived a sleep gets a catch-up.
 */
function probeTelegramListenerNow(listener: ActiveListener, reason: string): void {
  if (listener.stopped || listener.connecting || listener.sessionInvalid) return;
  const accountId = listener.account.accountId;
  const client = listener.client;
  if (!client || retiredClients.has(client) || !listener.connected) {
    // A confirmed outage waiting on its backoff: retry now. An in-place GramJS
    // reconnect that is still running keeps its grace period (scheduleReconnect),
    // so this cannot open a second session on the main DC.
    listener.retryCount = 0;
    scheduleReconnect(listener, reason, undefined, { delayMs: 1_000 });
    return;
  }
  if (!client.connected) {
    // GramJS is rebuilding the socket in place right now; confirm the outage
    // like any other report instead of replacing the client mid-handshake.
    handlePrimaryTransportDisconnected(listener, client, reason);
    return;
  }
  if (listener.healthCheckClient === client) return;
  listener.healthCheckClient = client;
  withDeadline(client.getMe(), TELEGRAM_PROBE_DEADLINE_MS, `${reason}_probe_timeout`)
    .then(() => {
      if (listener.client !== client || listener.stopped || retiredClients.has(client)) return;
      const now = Date.now();
      const offlineFor = listener.lastAliveAt > 0 ? now - listener.lastAliveAt : Number.POSITIVE_INFINITY;
      listener.lastAliveAt = now;
      if (listener.forceFullCatchUp) {
        // The socket survived the sleep, so no reconnect will start a catch-up.
        listener.forceFullCatchUp = false;
        scheduleReconnectCatchUp(listener, client, offlineFor > LIGHT_CATCHUP_MAX_OFFLINE_MS ? 'full' : 'light');
      }
    })
    .catch((err: any) => {
      if (listener.client !== client || listener.stopped) return;
      Logger.warn(`[TelegramUserListener] ${reason} probe failed for ${accountId}: ${err.message}`);
      if (isFatalTelegramSessionError(err)) {
        scheduleReconnect(listener, reason, err);
        return;
      }
      // GramJS usually notices the dead socket and rebuilds it in place
      // within the confirmation window.
      handlePrimaryTransportDisconnected(listener, client, reason);
    })
    .finally(() => {
      if (listener.healthCheckClient === client) listener.healthCheckClient = null;
    });
}

/**
 * The machine woke up (`resume`) or the session was unlocked. Nothing ran while
 * it slept and Telegram has usually closed the socket, so probe every listener
 * now. After a real sleep the next restoration runs a full catch-up.
 */
export function handleSystemResume(reason: 'resume' | 'unlock-screen' = 'resume'): void {
  for (const listener of activeListeners.values()) {
    if (listener.stopped) continue;
    if (reason === 'resume') listener.forceFullCatchUp = true;
    probeTelegramListenerNow(listener, `system_${reason.replace('-', '_')}`);
  }
}

/** The OS reports connectivity again: rebuild dead connections immediately. */
export function handleNetworkOnline(): void {
  for (const listener of activeListeners.values()) {
    if (listener.stopped) continue;
    probeTelegramListenerNow(listener, 'network_online');
  }
}

/**
 * Fetch the avatar of the logged-in account itself (self avatar).
 * Used by the "Cập nhật thông tin" (Update info) button on the dashboard.
 */
export async function fetchSelfAvatar(accountId: string): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) {
    return { success: false, error: 'Telegram chưa kết nối. Hãy kết nối lại trước.' };
  }

  try {
    const me = await listener.client.getMe();
    if (!me) return { success: false, error: tr('Không thể lấy thông tin tài khoản') };

    const photo = await downloadProfilePhotoQueued(accountId, listener.client, me, `self:${accountId}`, true, { urgency: 'visible' });
    if (!photo || photo.length === 0) {
      return { success: false, error: tr('Tài khoản chưa có avatar') };
    }

    const avatarPath = `telegram_self_${accountId}_${Date.now()}.jpg`;
    const savedPath = await saveAvatarToDisk(Buffer.from(photo), avatarPath);
    if (!savedPath) return { success: false, error: tr('Không thể lưu avatar') };

    // Convert absolute path → local-media:// URL (usable in the renderer's <img src>)
    const normalizedPath = savedPath.replace(/\\/g, '/');
    const mediaUrl = 'local-media://' + (normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath);

    // Update avatar_url in the accounts table
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
  if (!listener.client) return { error: tr('Telegram client chưa khởi tạo') };
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
    username: member.username || '',
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
 * Get group info (both Basic Group and Supergroup/Channel)
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
      : await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) })).catch(() => null);
    // A basic group the account was just added to may not resolve yet: the GetFullChat answer carries a fresh Chat object
    const groupEntity = entity || (isChannel ? null : basicGroupChat(full?.chats, chatId));
    if (groupEntity) {
      cacheTelegramPeer(accountId, chatId, groupEntity);
      persistTelegramDialogState(accountId, chatId, null, groupEntity, full?.fullChat);
    }
    let avatarUrl = '';
    const db = DatabaseService.getInstance();
    const cached = db?.queryOne<any>(
      `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, chatId]
    );
    avatarUrl = cached?.avatar_url || '';
    if (!avatarUrl && groupEntity) {
      try {
        const photo = await downloadProfilePhotoQueued(accountId, conn.client, groupEntity, `group:${chatId}`, false, {
          threadId: chatId, urgency: 'visible',
        });
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
    const capability = getTelegramSendCapability(groupEntity);
    const membership = getTelegramMembership(groupEntity);
    const canManageTopics = !!groupEntity?.creator || !!groupEntity?.adminRights?.manageTopics;
    return { success: true, info: {
      entity: groupEntity, peerType, full: full?.fullChat, chats: full?.chats, users: full?.users, avatarUrl,
      memberCount: telegramParticipantsCount(full?.fullChat, groupEntity, full?.chats, chatId),
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
 * Get the group member list
 */
export async function joinGroup(
  accountId: string,
  chatId: string,
): Promise<{ success: boolean; requested?: boolean; info?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const joined = await conn.client.invoke(new Api.channels.JoinChannel({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
    }));
    if (chatInviteJoinOutcome(joined).kind === 'bot_verification') return { success: false, error: TELEGRAM_BOT_VERIFICATION_ERROR };
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
        ? tr('Bạn không thể tham gia nhóm/kênh này bằng tài khoản hiện tại')
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

// ─── Quick actions: create group, join by link, add contact ─────────────────

/** Telegram RPC errors the quick actions can hit, in plain Vietnamese. */
function friendlyTelegramActionError(raw: string): string {
  const message = String(raw || '');
  const flood = /FLOOD_WAIT_(\d+)/.exec(message) || /wait of (\d+) seconds/i.exec(message);
  if (flood) return tr('Thao tác quá nhanh, Telegram yêu cầu chờ {{v1}} giây', { v1: flood[1] });
  const known: Array<[string, string]> = [
    // Specific codes before general ones (substring match: USER_CHANNELS_TOO_MUCH contains CHANNELS_TOO_MUCH)
    ['USER_CHANNELS_TOO_MUCH', tr('Người này đã tham gia quá nhiều nhóm / kênh')],
    ['INVITE_HASH_EXPIRED', tr('Link mời đã hết hạn')],
    ['INVITE_HASH_INVALID', tr('Link mời không hợp lệ')],
    ['INVITE_HASH_EMPTY', tr('Link mời không hợp lệ')],
    ['USERNAME_NOT_OCCUPIED', 'Không tìm thấy tên người dùng / nhóm này'],
    ['USERNAME_INVALID', tr('Tên người dùng không hợp lệ')],
    ['CHANNELS_TOO_MUCH', tr('Tài khoản đã tham gia quá nhiều nhóm / kênh')],
    ['USERS_TOO_MUCH', tr('Nhóm đã đủ thành viên')],
    ['USERS_TOO_FEW', tr('Cần chọn ít nhất 1 thành viên')],
    ['USER_PRIVACY_RESTRICTED', tr('Người này không cho phép thêm vào nhóm')],
    ['USER_NOT_MUTUAL_CONTACT', tr('Chỉ thêm được người đã lưu số của nhau')],
    ['CHAT_TITLE_EMPTY', tr('Nhập tên nhóm')],
    ['PEER_FLOOD', tr('Telegram đang hạn chế thao tác của tài khoản này, thử lại sau')],
    ['USER_RESTRICTED', tr('Tài khoản đang bị Telegram hạn chế')],
    ['CHANNEL_PRIVATE', tr('Nhóm / kênh riêng tư — cần link mời')],
    ['USER_BANNED_IN_CHANNEL', tr('Tài khoản đã bị chặn khỏi nhóm / kênh này')],
    ['CONTACT_NAME_EMPTY', tr('Nhập tên liên hệ')],
    ['USER_KICKED', tr('Người này đã bị xoá khỏi nhóm / kênh — gỡ chặn trước khi mời lại')],
    ['USER_BOT', tr('Bot chỉ thêm được làm quản trị viên kênh')],
    ['BOTS_TOO_MUCH', tr('Nhóm / kênh đã có quá nhiều bot')],
    ['USER_BLOCKED', tr('Người này đã chặn tài khoản')],
    ['INPUT_USER_DEACTIVATED', tr('Tài khoản Telegram này đã bị xoá')],
    ['CHAT_MEMBER_ADD_FAILED', tr('Telegram không thêm được người này')],
    ['CHAT_ADMIN_REQUIRED', tr('Cần quyền quản trị')],
    ['CHANNELS_ADMIN_PUBLIC_TOO_MUCH', tr('Tài khoản đang quản lý quá nhiều kênh / nhóm công khai')],
  ];
  const hit = known.find(([code]) => message.includes(code));
  return hit ? hit[1] : message;
}

/** The chat entity inside an Updates / messages.InvitedUsers result. */
function firstChatOfUpdates(result: any): any | null {
  const container = result?.updates && !Array.isArray(result.updates) ? result.updates : result;
  const chats: any[] = container?.chats || result?.chats || [];
  return chats.find(chat => chat?.className === 'Chat' || chat?.className === 'Channel') || null;
}

/**
 * A chat / user the account just created, joined or added: cache the peer, upsert the
 * conversation row and move it to the top of the list (RPC results never reach the
 * update handlers, so nothing else would insert it before the next sync).
 */
function rememberQuickActionPeer(accountId: string, entity: any, preview: string): string {
  const peerId = getCanonicalChatId(entity);
  cacheTelegramPeer(accountId, peerId, entity);
  persistTelegramDialogState(accountId, peerId, null, entity, undefined, false);
  DatabaseService.getInstance()?.run(
    `UPDATE contacts SET
       last_message = CASE WHEN COALESCE(last_message, '') = '' THEN ? ELSE last_message END,
       last_message_time = MAX(COALESCE(last_message_time, 0), ?)
     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [preview, Date.now(), accountId, peerId],
  );
  EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_quick_action' });
  return peerId;
}

/**
 * "Nhóm mới" (New group) like Telegram: a normal group (messages.CreateChat), with auto-delete of messages if chosen; you can create it with nobody selected
 * (TDLib: the member list may be empty). The server rejects an empty group (USERS_TOO_FEW) → a supergroup instead.
 * People who cannot be added because of privacy settings are in `missingInvitees` (an invite link can still be sent to them).
 */
export async function createGroup(
  accountId: string,
  title: string,
  userIds: string[] = [],
  options: { photoPath?: string; ttlPeriod?: number } = {},
): Promise<{
  success: boolean;
  chatId?: string;
  title?: string;
  missing?: number;
  missingInvitees?: TelegramMissingInvitee[];
  supergroup?: boolean;
  photoError?: string;
  error?: string;
}> {
  const name = String(title || '').trim();
  if (!name) return { success: false, error: tr('Nhập tên nhóm') };
  if (name.length > 128) return { success: false, error: tr('Tên nhóm tối đa 128 ký tự') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const ttlPeriod = normalizeTelegramTtl(options?.ttlPeriod);
  try {
    const { Api } = require('telegram');
    const { getInputUser } = require('telegram/Utils');
    const ids = Array.from(new Set((userIds || []).map(String).filter(id => id && id !== accountId)));
    const users: any[] = [];
    for (const id of ids) users.push(getInputUser(await resolveInputPeer(accountId, conn.client, id)));
    let result: any;
    let supergroup = false;
    try {
      result = await conn.client.invoke(new Api.messages.CreateChat({ users, title: name, ...(ttlPeriod ? { ttlPeriod } : {}) }));
    } catch (err: any) {
      const message = String(err?.errorMessage || err?.message || err);
      if (users.length > 0 || !message.includes('USERS_TOO_FEW')) throw err;
      result = await conn.client.invoke(new Api.channels.CreateChannel({ title: name, about: '', megagroup: true, ...(ttlPeriod ? { ttlPeriod } : {}) }));
      supergroup = true;
    }
    const chat = firstChatOfUpdates(result);
    if (!chat) return { success: false, error: tr('Telegram không trả về nhóm vừa tạo') };
    const chatId = rememberQuickActionPeer(accountId, chat, tr('Bạn đã tạo nhóm'));
    const missingInvitees = readMissingInvitees(accountId, result);
    const photoError = options?.photoPath
      ? await applyTelegramChatPhoto(accountId, conn.client, chatId, getTelegramPeerType(chat), options.photoPath)
      : undefined;
    tgLog('info', accountId, 'history', 'GROUP_CREATED', { chatId, members: ids.length, missing: missingInvitees.length, supergroup });
    return {
      success: true,
      chatId,
      title: chat.title || name,
      missing: missingInvitees.length,
      missingInvitees,
      ...(supergroup ? { supergroup } : {}),
      ...(photoError ? { photoError } : {}),
    };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    tgLog('warn', accountId, 'history', 'GROUP_CREATE_FAILED', { error: message });
    return { success: false, error: friendlyTelegramActionError(message) };
  }
}

export interface TelegramLinkPreview {
  success: boolean;
  title?: string;
  about?: string;
  membersCount?: number;
  isChannel?: boolean;
  alreadyMember?: boolean;
  requestNeeded?: boolean;
  /** Known only for public chats and chats the account can already see. */
  chatId?: string;
  error?: string;
}

/** Preview of a t.me link (name, member count, whether already a member) before joining. */
export async function previewJoinLink(accountId: string, link: string): Promise<TelegramLinkPreview> {
  const target = parseGroupLink(link);
  if (!target || target.channel !== 'telegram') return { success: false, error: tr('Không phải link nhóm / kênh Telegram') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    if (target.kind === 'invite') {
      const invite: any = await conn.client.invoke(new Api.messages.CheckChatInvite({ hash: target.hash }));
      if (invite?.chat) {
        const chat = invite.chat;
        const chatId = getCanonicalChatId(chat);
        cacheTelegramPeer(accountId, chatId, chat);
        return {
          success: true, title: chat.title, membersCount: Number(chat.participantsCount || 0) || undefined,
          isChannel: !!chat.broadcast, alreadyMember: invite.className === 'ChatInviteAlready' && !chat.left, chatId,
        };
      }
      return {
        success: true, title: invite?.title, about: invite?.about || undefined,
        membersCount: Number(invite?.participantsCount || 0) || undefined,
        isChannel: !!invite?.broadcast, requestNeeded: !!invite?.requestNeeded,
      };
    }
    const resolved: any = await conn.client.invoke(new Api.contacts.ResolveUsername({ username: target.username }));
    const chat = (resolved?.chats || []).find((item: any) => item?.className === 'Channel' || item?.className === 'Chat');
    if (!chat) return { success: false, error: tr('Tên này là một người dùng, không phải nhóm / kênh') };
    const chatId = getCanonicalChatId(chat);
    cacheTelegramPeer(accountId, chatId, chat);
    return {
      success: true, title: chat.title, membersCount: Number(chat.participantsCount || 0) || undefined,
      isChannel: !!chat.broadcast, alreadyMember: !chat.left, requestNeeded: !!chat.joinRequest, chatId,
    };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/**
 * Join a group / channel by link: a private invite link (messages.ImportChatInvite) or a public name
 * (channels.JoinChannel). `requested`: the group needs admin approval; `already`: already a member.
 */
export async function joinByLink(
  accountId: string,
  link: string,
): Promise<{ success: boolean; chatId?: string; title?: string; requested?: boolean; already?: boolean; error?: string }> {
  const target = parseGroupLink(link);
  if (!target || target.channel !== 'telegram') return { success: false, error: tr('Không phải link nhóm / kênh Telegram') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    let result: any;
    if (target.kind === 'invite') {
      result = await conn.client.invoke(new Api.messages.ImportChatInvite({ hash: target.hash }));
    } else {
      const preview = await previewJoinLink(accountId, link);
      if (!preview.success || !preview.chatId) return { success: false, error: preview.error || 'Không tìm thấy nhóm / kênh' };
      if (preview.alreadyMember) return { success: true, already: true, chatId: preview.chatId, title: preview.title };
      result = await conn.client.invoke(new Api.channels.JoinChannel({
        channel: await resolveInputChannel(accountId, conn.client, preview.chatId),
      }));
    }
    // New layer: messages.ChatInviteJoinResultOk { updates } / ChatInviteJoinResultWebView (verified through a bot)
    const outcome = chatInviteJoinOutcome(result);
    if (outcome.kind === 'bot_verification') return { success: false, error: TELEGRAM_BOT_VERIFICATION_ERROR };
    const chat = firstChatOfUpdates(outcome.updates);
    if (!chat) return { success: false, error: tr('Telegram không trả về nhóm vừa tham gia') };
    const chatId = rememberQuickActionPeer(accountId, chat, tr('Bạn đã tham gia nhóm'));
    tgLog('info', accountId, 'history', 'JOINED_BY_LINK', { chatId, kind: target.kind });
    return { success: true, chatId, title: chat.title };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    if (message.includes('INVITE_REQUEST_SENT')) return { success: true, requested: true };
    if (message.includes('USER_ALREADY_PARTICIPANT')) {
      const preview = await previewJoinLink(accountId, link).catch(() => null);
      return { success: true, already: true, chatId: preview?.chatId, title: preview?.title };
    }
    tgLog('warn', accountId, 'history', 'JOIN_BY_LINK_FAILED', { error: message });
    return { success: false, error: friendlyTelegramActionError(message) };
  }
}

/** "0912 345 678" → "+84912345678" (Telegram needs the international form; Vietnam by default). */
export function normalizeTelegramPhone(phone: string): string {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\+/g, '');
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('84')) return '+' + digits;
  if (digits.startsWith('0')) return '+84' + digits.slice(1);
  return digits ? '+' + digits : '';
}

/**
 * Add a Telegram contact: by phone number (contacts.ImportContacts) or by @username
 * (contacts.ResolveUsername + contacts.AddContact). A 1-1 conversation is created in the list.
 */
export async function addContact(
  accountId: string,
  params: { phone?: string; username?: string; firstName?: string; lastName?: string },
): Promise<{ success: boolean; userId?: string; displayName?: string; username?: string; phone?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  const firstName = String(params.firstName || '').trim();
  const lastName = String(params.lastName || '').trim();
  try {
    let user: any = null;
    const username = String(params.username || '').trim().replace(/^@/, '');
    if (username) {
      const resolved: any = await conn.client.invoke(new Api.contacts.ResolveUsername({ username }));
      user = (resolved?.users || []).find((item: any) => item?.className === 'User') || null;
      if (!user || resolved?.peer?.className !== 'PeerUser') return { success: false, error: 'Không tìm thấy người dùng Telegram này' };
      const { getInputUser } = require('telegram/Utils');
      await conn.client.invoke(new Api.contacts.AddContact({
        id: getInputUser(user),
        firstName: firstName || user.firstName || username,
        lastName: firstName ? lastName : (user.lastName || ''),
        phone: '',
      }));
    } else {
      const phone = normalizeTelegramPhone(params.phone || '');
      if (phone.replace(/\D/g, '').length < 8) return { success: false, error: tr('Nhập số điện thoại hoặc @tên người dùng') };
      const imported: any = await conn.client.invoke(new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({ clientId: Date.now(), phone, firstName: firstName || phone, lastName })],
      }));
      user = (imported?.users || []).find((item: any) => item?.className === 'User') || null;
      if (!user) return { success: false, error: tr('Số này chưa dùng Telegram hoặc không cho tìm theo số điện thoại') };
    }
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || firstName;
    const userId = rememberQuickActionPeer(accountId, user, tr('Đã thêm liên hệ'));
    tgLog('info', accountId, 'history', 'CONTACT_ADDED', { userId, by: username ? 'username' : 'phone' });
    return { success: true, userId, displayName, username: user.username || undefined, phone: user.phone || undefined };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    tgLog('warn', accountId, 'history', 'CONTACT_ADD_FAILED', { error: message });
    return { success: false, error: friendlyTelegramActionError(message) };
  }
}

// ─── Telegram: new group, new channel, group / channel settings, contacts, calls ──────────
// Per the Telegram API docs (core.telegram.org/api/channel, /api/invites, /api/calls): "Nhóm mới" (New group) = a normal group
// (messages.createChat, may have no members), "Kênh mới" (New channel) = channels.createChannel broadcast; the public
// link is only for supergroups / channels; a newly created group, supergroup or channel already has its main invite link.

/** Group / channel photo from a file on the machine (absolute path, relative to the data folder, or local-media://). */
async function uploadTelegramChatPhoto(client: TelegramClient, photoPath: string): Promise<{ photo: any; buffer: Buffer }> {
  const { Api } = require('telegram');
  const absolute = resolveTelegramUploadPath(photoPath);
  const buffer: Buffer = fs.readFileSync(absolute);
  const { CustomFile } = require('telegram/client/uploads');
  // client.uploadFile returns InputFile / InputFileBig → wrap it directly in InputChatUploadedPhoto
  // (Api.InputFileUploaded does not exist in GramJS: the old editChatPhoto always failed because of it).
  const file = await client.uploadFile({ file: new CustomFile(path.basename(absolute), buffer.length, '', buffer), workers: 1 });
  return { photo: new Api.InputChatUploadedPhoto({ file }), buffer };
}

/** The photo just set: shrunk (longest side ≤ 640px) so the list does not have to decode the original image of several MB. */
function avatarThumbnail(buffer: Buffer): { data: Buffer; ext: string } {
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage?.createFromBuffer?.(buffer);
    if (!image || image.isEmpty()) return { data: buffer, ext: '.jpg' };
    const { width, height } = image.getSize();
    if (Math.max(width, height) <= 640) return { data: buffer, ext: '.jpg' };
    return { data: image.resize(width >= height ? { width: 640 } : { height: 640 }).toJPEG(88), ext: '.jpg' };
  } catch {
    return { data: buffer, ext: '.jpg' };
  }
}

/**
 * The photo just set shows at once in the conversation list: saves a thumbnail to _avatars/telegram (like downloaded photos) and updates the conversation.
 * Previously it waited for the photo to be reloaded from Telegram; the cached entity still had the old photo, so it showed only minutes later.
 */
async function rememberLocalChatPhoto(accountId: string, chatId: string, buffer: Buffer): Promise<void> {
  const { data, ext } = avatarThumbnail(buffer);
  const saved = await saveAvatarToDisk(data, `telegram_avatar_${chatId}_${Date.now()}${ext}`);
  if (!saved) return;
  const normalized = saved.replace(/\\/g, '/');
  const avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
  DatabaseService.getInstance()?.run(
    `UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [avatarUrl, accountId, chatId],
  );
  resetAvatarCache(accountId, chatId);
  EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_avatar_refresh' });
}

/** Set the photo for a group / channel. Returns the error (Vietnamese text) instead of throwing: a just-created group / channel is still usable when the photo fails. */
async function applyTelegramChatPhoto(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  peerType: TelegramPeerType,
  photoPath: string,
): Promise<string | undefined> {
  try {
    const { Api } = require('telegram');
    const { photo, buffer } = await uploadTelegramChatPhoto(client, photoPath);
    if (isChannelPeerType(peerType)) {
      await client.invoke(new Api.channels.EditPhoto({ channel: await resolveInputChannel(accountId, client, chatId), photo }));
    } else {
      await client.invoke(new Api.messages.EditChatPhoto({ chatId: getBasicGroupId(chatId), photo }));
    }
    await rememberLocalChatPhoto(accountId, chatId, buffer).catch(() => {});
    return undefined;
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    tgLog('warn', accountId, 'history', 'CHAT_PHOTO_FAILED', { chatId, error: message });
    if (message.includes('PHOTO_CROP_SIZE_SMALL')) return tr('Ảnh quá nhỏ — chọn ảnh lớn hơn');
    if (message.includes('IMAGE_PROCESS_FAILED') || message.includes('PHOTO_INVALID') || message.includes('PHOTO_EXT_INVALID')) {
      return tr('Telegram không đọc được ảnh này — chọn ảnh JPG / PNG khác');
    }
    if (message.includes('ENOENT')) return 'Không tìm thấy file ảnh';
    return friendlyTelegramActionError(message);
  }
}

/** Known display name of a person (cache: peer → conversation → id). */
function telegramKnownName(accountId: string, peerId: string): string {
  const db = DatabaseService.getInstance();
  const peer = db?.getTelegramPeer(accountId, peerId);
  if (peer?.display_name) return peer.display_name;
  const contact = db?.queryOne<any>(
    `SELECT display_name FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, peerId],
  );
  return contact?.display_name || peer?.username || peerId;
}

/** messages.InvitedUsers.missing_invitees → list of people not added yet (+ the Premium reason if any). */
function readMissingInvitees(accountId: string, result: any): TelegramMissingInvitee[] {
  const list: any[] = Array.isArray(result?.missingInvitees) ? result.missingInvitees : [];
  return list
    .map(item => {
      const userId = String(item?.userId?.valueOf?.() ?? item?.userId ?? '');
      return {
        userId,
        name: telegramKnownName(accountId, userId),
        ...(item?.premiumWouldAllowInvite ? { premiumWouldAllowInvite: true } : {}),
        ...(item?.premiumRequiredForPm ? { premiumRequiredForPm: true } : {}),
      };
    })
    .filter(item => item.userId);
}

/**
 * Invite people into a group / channel: supergroup and channel → channels.InviteToChannel in batches of 50 (a failed batch → retry one by one to find
 * who can be added); normal group → messages.AddChatUser one by one (the 100 most recent messages are visible to new members, like Telegram).
 */
async function inviteUsersToChat(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  peerType: TelegramPeerType,
  userIds: string[],
): Promise<{ invited: number; missingInvitees: TelegramMissingInvitee[] }> {
  const { Api } = require('telegram');
  const { getInputUser } = require('telegram/Utils');
  const ids = Array.from(new Set((userIds || []).map(String).filter(id => id && id !== accountId)));
  const missingInvitees: TelegramMissingInvitee[] = [];
  let invited = 0;
  const failed = (userId: string, err: any) => {
    const raw = String(err?.errorMessage || err?.message || err);
    if (raw.includes('USER_ALREADY_PARTICIPANT')) {
      invited++;
      return;
    }
    missingInvitees.push({
      userId,
      name: telegramKnownName(accountId, userId),
      // Could not add because of privacy settings → an invite link can still be sent (like Telegram)
      ...(raw.includes('USER_PRIVACY_RESTRICTED') || raw.includes('USER_NOT_MUTUAL_CONTACT') ? {} : { error: friendlyTelegramActionError(raw) }),
    });
  };
  const inputs: Array<{ id: string; user: any }> = [];
  for (const id of ids) {
    try {
      inputs.push({ id, user: getInputUser(await resolveInputPeer(accountId, client, id)) });
    } catch (err: any) {
      missingInvitees.push({ userId: id, name: telegramKnownName(accountId, id), error: tr('Không tìm thấy người này trên Telegram') });
    }
  }
  if (inputs.length === 0) return { invited, missingInvitees };

  if (isChannelPeerType(peerType)) {
    const channel = await resolveInputChannel(accountId, client, chatId);
    for (let i = 0; i < inputs.length; i += 50) {
      const batch = inputs.slice(i, i + 50);
      try {
        const result: any = await client.invoke(new Api.channels.InviteToChannel({ channel, users: batch.map(item => item.user) }));
        const missing = readMissingInvitees(accountId, result);
        missingInvitees.push(...missing);
        invited += batch.length - missing.length;
      } catch (err: any) {
        if (batch.length === 1) {
          failed(batch[0].id, err);
          continue;
        }
        for (const item of batch) {
          try {
            const result: any = await client.invoke(new Api.channels.InviteToChannel({ channel, users: [item.user] }));
            const missing = readMissingInvitees(accountId, result);
            if (missing.length) missingInvitees.push(...missing);
            else invited++;
          } catch (singleErr: any) {
            failed(item.id, singleErr);
          }
        }
      }
    }
  } else {
    const basicChatId = getBasicGroupId(chatId);
    for (const item of inputs) {
      try {
        const result: any = await client.invoke(new Api.messages.AddChatUser({ chatId: basicChatId, userId: item.user, fwdLimit: 100 }));
        const missing = readMissingInvitees(accountId, result);
        if (missing.length) missingInvitees.push(...missing);
        else invited++;
      } catch (err: any) {
        failed(item.id, err);
      }
    }
  }
  return { invited, missingInvitees };
}

/** The main invite link of the group / channel (read from the full info; created if missing). '' when there is no permission. */
async function readPrimaryInviteLink(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  peerType: TelegramPeerType,
): Promise<string> {
  const { Api } = require('telegram');
  try {
    const full: any = isChannelPeerType(peerType)
      ? await client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, client, chatId) }))
      : await client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }));
    const link = String(full?.fullChat?.exportedInvite?.link || '');
    if (link) return link;
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'FULL_CHAT_FOR_INVITE_FAILED', { chatId, error: err?.message });
  }
  try {
    const exported: any = await client.invoke(new Api.messages.ExportChatInvite({ peer: await resolveInputPeer(accountId, client, chatId) }));
    return String(exported?.link || '');
  } catch (err: any) {
    tgLog('warn', accountId, 'history', 'EXPORT_INVITE_FAILED', { chatId, error: err?.message });
    return '';
  }
}

/** Record the new public name of the group / channel in the peer cache (the t.me link shows right away). */
function rememberTelegramUsername(accountId: string, chatId: string, username: string): void {
  DatabaseService.getInstance()?.run(
    `UPDATE telegram_peers SET username = ?, updated_at = ? WHERE owner_zalo_id = ? AND peer_id = ?`,
    [username, Date.now(), accountId, chatId],
  );
}

/**
 * "Kênh mới" (New channel): creates a broadcast channel (channels.CreateChannel broadcast), then the photo, the public link (if chosen), and invites followers.
 * A later step's failure does not delete the channel already created: return separate errors (photoError / usernameError / inviteError) so the screen
 * can show them and let the user fix them in the channel info.
 */
export async function createChannel(
  accountId: string,
  params: { title: string; about?: string; photoPath?: string; username?: string; userIds?: string[] },
): Promise<TelegramCreateChannelResult> {
  const title = String(params?.title || '').trim();
  if (!title) return { success: false, error: tr('Nhập tên kênh') };
  if (title.length > 128) return { success: false, error: tr('Tên kênh tối đa 128 ký tự') };
  const about = String(params?.about || '').trim();
  if (about.length > 255) return { success: false, error: tr('Mô tả tối đa 255 ký tự') };
  let username = '';
  if (params?.username) {
    const check = validateTelegramUsername(params.username);
    if ('error' in check) return { success: false, error: check.error };
    username = check.username;
  }
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const result = await conn.client.invoke(new Api.channels.CreateChannel({ broadcast: true, title, about }));
    const chat = firstChatOfUpdates(result);
    if (!chat) return { success: false, error: tr('Telegram không trả về kênh vừa tạo') };
    const chatId = rememberQuickActionPeer(accountId, chat, tr('Bạn đã tạo kênh'));
    const out: TelegramCreateChannelResult = { success: true, chatId, title: chat.title || title };
    if (params.photoPath) {
      const photoError = await applyTelegramChatPhoto(accountId, conn.client, chatId, 'channel', params.photoPath);
      if (photoError) out.photoError = photoError;
    }
    if (username) {
      try {
        await conn.client.invoke(new Api.channels.UpdateUsername({ channel: await resolveInputChannel(accountId, conn.client, chatId), username }));
        rememberTelegramUsername(accountId, chatId, username);
        out.username = username;
      } catch (err: any) {
        out.usernameError = telegramUsernameError(String(err?.errorMessage || err?.message || err));
      }
    }
    if (params.userIds?.length) {
      try {
        const invited = await inviteUsersToChat(accountId, conn.client, chatId, 'channel', params.userIds);
        out.invited = invited.invited;
        out.missingInvitees = invited.missingInvitees;
      } catch (err: any) {
        out.inviteError = friendlyTelegramActionError(String(err?.errorMessage || err?.message || err));
      }
    }
    out.inviteLink = out.username
      ? `https://t.me/${out.username}`
      : (await readPrimaryInviteLink(accountId, conn.client, chatId, 'channel')) || undefined;
    tgLog('info', accountId, 'history', 'CHANNEL_CREATED', { chatId, public: !!out.username, invited: out.invited || 0 });
    return out;
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    tgLog('warn', accountId, 'history', 'CHANNEL_CREATE_FAILED', { error: message });
    if (message.includes('CHAT_ABOUT_TOO_LONG')) return { success: false, error: tr('Mô tả quá dài') };
    return { success: false, error: friendlyTelegramActionError(message) };
  }
}

/**
 * Check a public link name (channels.CheckUsername). An empty `chatId` = channel not created yet (InputChannelEmpty).
 * `available: false` + `error` = the name cannot be used (someone already has it, wrong rules…); `success: false` = connection error.
 */
export async function checkChatUsername(
  accountId: string,
  chatId: string | null | undefined,
  username: string,
): Promise<{ success: boolean; available?: boolean; username?: string; error?: string }> {
  const check = validateTelegramUsername(username);
  if ('error' in check) return { success: true, available: false, error: check.error };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const channel = chatId ? await resolveInputChannel(accountId, conn.client, chatId) : new Api.InputChannelEmpty();
    const ok = await conn.client.invoke(new Api.channels.CheckUsername({ channel, username: check.username }));
    return ok
      ? { success: true, available: true, username: check.username }
      : { success: true, available: false, username: check.username, error: tr('Tên này đã có người dùng') };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (/USERNAME|CHANNELS_ADMIN_PUBLIC_TOO_MUCH/.test(raw)) {
      return { success: true, available: false, username: check.username, error: telegramUsernameError(raw) };
    }
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Set / remove the public link (channels.UpdateUsername; '' = switch to private). Returns the link in use after the change. */
export async function setChatUsername(
  accountId: string,
  chatId: string,
  username: string,
): Promise<{ success: boolean; username?: string; link?: string; error?: string }> {
  let name = '';
  if (String(username || '').trim()) {
    const check = validateTelegramUsername(username);
    if ('error' in check) return { success: false, error: check.error };
    name = check.username;
  }
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (!isChannelPeerType(peerType)) return { success: false, error: tr('Nhóm thường chưa đặt được link công khai — chỉ siêu nhóm và kênh') };
    try {
      await conn.client.invoke(new Api.channels.UpdateUsername({ channel: await resolveInputChannel(accountId, conn.client, chatId), username: name }));
    } catch (err: any) {
      const raw = String(err?.errorMessage || err?.message || err);
      if (!raw.includes('USERNAME_NOT_MODIFIED') && !raw.includes('CHAT_NOT_MODIFIED')) throw err;
    }
    rememberTelegramUsername(accountId, chatId, name);
    const link = name ? `https://t.me/${name}` : await readPrimaryInviteLink(accountId, conn.client, chatId, peerType);
    tgLog('info', accountId, 'history', 'CHAT_USERNAME_SET', { chatId, public: !!name });
    return { success: true, username: name, link };
  } catch (err: any) {
    return { success: false, error: telegramUsernameError(String(err?.errorMessage || err?.message || err)) };
  }
}

/** Info + permissions so the Telegram "Manage group / channel" screen knows what to show (GetFullChannel / GetFullChat). */
export async function getChatSettings(accountId: string, chatId: string): Promise<{ success: boolean; settings?: TelegramChatSettings; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (peerType === 'user') return { success: false, error: tr('Đây không phải nhóm / kênh') };
    const channelLike = isChannelPeerType(peerType);
    const full: any = channelLike
      ? await conn.client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId) }))
      : await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }));
    const fullChat = full?.fullChat || {};
    const chats: any[] = Array.isArray(full?.chats) ? full.chats : [];
    const entity = chats.find(chat => getCanonicalChatId(chat) === chatId) || null;
    if (entity) cacheTelegramPeer(accountId, chatId, entity);
    const type = entity ? getTelegramPeerType(entity) : peerType;
    const isBroadcast = type === 'channel';
    const creator = !!entity?.creator;
    const rights = entity?.adminRights || null;
    const defaults = entity?.defaultBannedRights || null;
    // Normal group: members may change the info / invite people unless restricted; a supergroup with no default permissions = forbidden.
    const memberAllowed = (flag: string) => !isBroadcast && !(defaults ? defaults[flag] : channelLike);
    const linkedId = fullChat.linkedChatId != null ? `-100${String(fullChat.linkedChatId?.valueOf?.() ?? fullChat.linkedChatId)}` : '';
    const linked = linkedId ? chats.find(chat => getCanonicalChatId(chat) === linkedId) : null;
    const activeUsername = entity?.username
      || (Array.isArray(entity?.usernames) ? entity.usernames.find((item: any) => item?.active)?.username : '')
      || '';
    const settings: TelegramChatSettings = {
      peerType: type,
      title: String(entity?.title || ''),
      about: String(fullChat.about || ''),
      username: String(activeUsername || ''),
      inviteLink: String(fullChat.exportedInvite?.link || ''),
      membersCount: Number(fullChat.participantsCount ?? entity?.participantsCount ?? fullChat.participants?.participants?.length ?? 0) || 0,
      isCreator: creator,
      isAdmin: creator || !!rights,
      canChangeInfo: creator || !!rights?.changeInfo || memberAllowed('changeInfo'),
      canInviteUsers: creator || !!rights?.inviteUsers || memberAllowed('inviteUsers'),
      canSetUsername: channelLike && (creator || !!fullChat.canSetUsername),
      canDelete: channelLike ? (creator || !!fullChat.canDeleteChannel) : creator,
      signatures: !!entity?.signatures,
      linkedChat: linkedId ? { id: linkedId, title: String(linked?.title || '') } : null,
      ttlPeriod: Number(fullChat.ttlPeriod || 0) || 0,
      joinRequest: !!entity?.joinRequest,
    };
    return { success: true, settings };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

function isNotModified(raw: string): boolean {
  return raw.includes('_NOT_MODIFIED');
}

/** Edit the group / channel description (messages.EditChatAbout, up to 255 characters). */
export async function editChatAbout(accountId: string, chatId: string, about: string): Promise<{ success: boolean; error?: string }> {
  const text = String(about || '').trim();
  if (text.length > 255) return { success: false, error: tr('Mô tả tối đa 255 ký tự') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    await conn.client.invoke(new Api.messages.EditChatAbout({ peer: await resolveInputPeer(accountId, conn.client, chatId), about: text }));
    return { success: true };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (isNotModified(raw)) return { success: true };
    if (raw.includes('CHAT_ABOUT_TOO_LONG')) return { success: false, error: tr('Mô tả quá dài') };
    if (raw.includes('CHAT_ADMIN_REQUIRED')) return { success: false, error: tr('Cần quyền quản trị để sửa mô tả') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Create a new main invite link; the old one stops working (messages.EditExportedChatInvite revoked → replacement link). */
export async function revokeInviteLink(accountId: string, chatId: string): Promise<{ success: boolean; link?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const current = await readPrimaryInviteLink(accountId, conn.client, chatId, peerType);
    if (current) {
      try {
        const replaced: any = await conn.client.invoke(new Api.messages.EditExportedChatInvite({ peer, link: current, revoked: true }));
        const link = String(replaced?.newInvite?.link || '');
        if (link) return { success: true, link };
      } catch (err: any) {
        tgLog('warn', accountId, 'history', 'REVOKE_INVITE_FALLBACK', { chatId, error: err?.message });
      }
    }
    const exported: any = await conn.client.invoke(new Api.messages.ExportChatInvite({ peer, legacyRevokePermanent: true }));
    const link = String(exported?.link || '');
    return link ? { success: true, link } : { success: false, error: tr('Telegram không trả về link mới') };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (raw.includes('CHAT_ADMIN_REQUIRED')) return { success: false, error: tr('Cần quyền mời thành viên để đổi link') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Channel: turn on / off showing the poster's name under each post (channels.ToggleSignatures). */
export async function toggleChannelSignatures(accountId: string, chatId: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    await conn.client.invoke(new Api.channels.ToggleSignatures({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
      ...(enabled ? { signaturesEnabled: true } : {}),
    }));
    return { success: true };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (isNotModified(raw)) return { success: true };
    if (raw.includes('CHAT_ADMIN_REQUIRED')) return { success: false, error: tr('Cần quyền quản trị kênh') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Groups that can serve as a channel's discussion group (channels.GetGroupsForDiscussion). A normal group must be upgraded first. */
export async function getDiscussionGroups(accountId: string): Promise<{
  success: boolean;
  groups?: Array<{ id: string; title: string; membersCount: number; basicGroup: boolean }>;
  error?: string;
}> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const result: any = await conn.client.invoke(new Api.channels.GetGroupsForDiscussion());
    const groups = (Array.isArray(result?.chats) ? result.chats : [])
      .filter((chat: any) => chat?.className === 'Chat' || (chat?.className === 'Channel' && chat?.megagroup))
      .map((chat: any) => {
        const id = getCanonicalChatId(chat);
        cacheTelegramPeer(accountId, id, chat);
        return { id, title: String(chat.title || id), membersCount: Number(chat.participantsCount || 0) || 0, basicGroup: chat.className === 'Chat' };
      });
    return { success: true, groups };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/**
 * Attach / detach a channel's discussion group (channels.SetDiscussionGroup; an empty groupId = detach). A group that hides history from new
 * members cannot be attached: `showHistory` = allow turning on history visibility (as Telegram asks first), then attach again.
 */
export async function setDiscussionGroup(
  accountId: string,
  channelId: string,
  groupId: string | null | undefined,
  showHistory = false,
): Promise<{ success: boolean; needsHistory?: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  const link = async () => conn.client.invoke(new Api.channels.SetDiscussionGroup({
    broadcast: await resolveInputChannel(accountId, conn.client, channelId),
    group: groupId ? await resolveInputChannel(accountId, conn.client, groupId) : new Api.InputChannelEmpty(),
  }));
  try {
    try {
      await link();
    } catch (err: any) {
      const raw = String(err?.errorMessage || err?.message || err);
      if (!raw.includes('MEGAGROUP_PREHISTORY_HIDDEN') || !groupId) throw err;
      if (!showHistory) {
        return { success: false, needsHistory: true, error: tr('Nhóm đang ẩn lịch sử trò chuyện với thành viên mới — cần bật hiện lịch sử để gắn làm nhóm thảo luận') };
      }
      await conn.client.invoke(new Api.channels.TogglePreHistoryHidden({ channel: await resolveInputChannel(accountId, conn.client, groupId), enabled: false }));
      await link();
    }
    tgLog('info', accountId, 'history', 'DISCUSSION_GROUP_SET', { channelId, linked: !!groupId });
    return { success: true };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (raw.includes('LINK_NOT_MODIFIED')) return { success: true };
    if (raw.includes('MEGAGROUP_ID_INVALID')) return { success: false, error: tr('Nhóm này chưa là siêu nhóm — không gắn được') };
    if (raw.includes('CHAT_ADMIN_REQUIRED')) return { success: false, error: tr('Cần quyền quản trị cả kênh và nhóm') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Auto-delete messages of a group / channel after N seconds (messages.SetHistoryTTL; 0 = off). */
export async function setChatHistoryTtl(accountId: string, chatId: string, period: number): Promise<{ success: boolean; ttlPeriod?: number; error?: string }> {
  const seconds = normalizeTelegramTtl(period);
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    await conn.client.invoke(new Api.messages.SetHistoryTTL({ peer: await resolveInputPeer(accountId, conn.client, chatId), period: seconds }));
    return { success: true, ttlPeriod: seconds };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (isNotModified(raw)) return { success: true, ttlPeriod: seconds };
    if (raw.includes('CHAT_ADMIN_REQUIRED')) return { success: false, error: tr('Cần quyền quản trị để đổi tự xoá tin nhắn') };
    if (raw.includes('TTL_PERIOD_INVALID')) return { success: false, error: tr('Thời gian tự xoá không hợp lệ') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/**
 * Permanently delete the group / channel for everyone (creator only): channels.DeleteChannel / messages.DeleteChat. The conversation in
 * Deplao changes to "không còn khả dụng" (unavailable) (old messages kept, removed from the main inbox), as when the group is deleted from another machine.
 */
export async function deleteChat(accountId: string, chatId: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (peerType === 'user') return { success: false, error: tr('Đây không phải nhóm / kênh') };
    if (isChannelPeerType(peerType)) {
      await conn.client.invoke(new Api.channels.DeleteChannel({ channel: await resolveInputChannel(accountId, conn.client, chatId) }));
    } else {
      await conn.client.invoke(new Api.messages.DeleteChat({ chatId: getBasicGroupId(chatId) }));
    }
    DatabaseService.getInstance()?.run(
      `UPDATE contacts SET telegram_membership_state = 'forbidden', telegram_join_action = 'none', telegram_can_send = 0,
         telegram_send_reason = ?, is_in_others = 1, telegram_state_updated_at = ?
       WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [peerType === 'channel' ? 'Kênh đã bị xoá' : 'Nhóm đã bị xoá', Date.now(), accountId, chatId],
    );
    EventBroadcaster.emit('db:unreadChanged', { zaloId: accountId, source: 'telegram_chat_deleted' });
    tgLog('info', accountId, 'history', 'CHAT_DELETED', { chatId, peerType });
    return { success: true };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (raw.includes('CHAT_ADMIN_REQUIRED') || raw.includes('CHAT_FORBIDDEN')) return { success: false, error: tr('Chỉ người tạo mới xoá được') };
    if (raw.includes('CHANNEL_TOO_LARGE')) return { success: false, error: tr('Kênh quá lớn — Telegram yêu cầu liên hệ hỗ trợ để xoá') };
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/** Invite several people into an existing group / channel (add followers and members). */
export async function inviteUsers(
  accountId: string,
  chatId: string,
  userIds: string[],
): Promise<{ success: boolean; invited?: number; missingInvitees?: TelegramMissingInvitee[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (peerType === 'user') return { success: false, error: tr('Đây không phải nhóm / kênh') };
    const result = await inviteUsersToChat(accountId, conn.client, chatId, peerType, userIds);
    tgLog('info', accountId, 'history', 'USERS_INVITED', { chatId, invited: result.invited, missing: result.missingInvitees.length });
    return { success: true, ...result };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/** Telegram contacts (contacts.GetContacts), sorted like Telegram: online now first, then recently active. */
export async function getContacts(accountId: string): Promise<{ success: boolean; contacts?: TelegramContactItem[]; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    const result: any = await conn.client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
    const mutual = new Set<string>(
      (Array.isArray(result?.contacts) ? result.contacts : [])
        .filter((item: any) => item?.mutual)
        .map((item: any) => String(item.userId?.valueOf?.() ?? item.userId)),
    );
    const db = DatabaseService.getInstance();
    const rows = db?.query<any>(
      `SELECT contact_id, avatar_url FROM contacts WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND contact_type = 'user'`,
      [accountId],
    ) || [];
    const chats = new Map<string, any>(rows.map((row: any) => [String(row.contact_id), row]));
    const users: any[] = (Array.isArray(result?.users) ? result.users : [])
      .filter((user: any) => user?.className === 'User' && !user.deleted && !user.self);
    // access_hash of each contact → can create a group / invite / message right away (1 transaction for the whole contact list)
    const cacheAll = () => {
      for (const user of users) cacheTelegramPeer(accountId, String(user.id?.valueOf?.() ?? user.id), user);
    };
    if (db && typeof (db as any).transaction === 'function') db.transaction(cacheAll);
    else cacheAll();
    const contacts: TelegramContactItem[] = users.map((user: any) => {
      const id = String(user.id?.valueOf?.() ?? user.id);
      const row = chats.get(id);
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || (user.phone ? `+${user.phone}` : id);
      return {
        id,
        name,
        firstName: String(user.firstName || ''),
        lastName: String(user.lastName || ''),
        username: String(user.username || ''),
        phone: String(user.phone || ''),
        avatar: String(row?.avatar_url || ''),
        mutual: mutual.has(id),
        presence: telegramPresenceOf(user.status),
        hasChat: !!row,
        bot: !!user.bot,
      };
    });
    const now = Date.now();
    contacts.sort((a, b) => telegramPresenceRank(b.presence, now) - telegramPresenceRank(a.presence, now) || a.name.localeCompare(b.name, 'vi'));
    return { success: true, contacts };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/** Remove from Telegram contacts (contacts.DeleteContacts): does not delete the conversation. */
export async function deleteContacts(accountId: string, userIds: string[]): Promise<{ success: boolean; error?: string }> {
  const ids = Array.from(new Set((userIds || []).map(String).filter(Boolean)));
  if (ids.length === 0) return { success: true };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  const { getInputUser } = require('telegram/Utils');
  try {
    const users: any[] = [];
    for (const id of ids) users.push(getInputUser(await resolveInputPeer(accountId, conn.client, id)));
    await conn.client.invoke(new Api.contacts.DeleteContacts({ id: users }));
    tgLog('info', accountId, 'history', 'CONTACTS_DELETED', { count: ids.length });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/** messageActionPhoneCall of a message (MessageService) → call info. */
function telegramCallInfoOf(message: any): TelegramCallInfo {
  const action = message?.action || {};
  return {
    out: !!message?.out,
    reason: telegramCallReasonOf(action.reason?.className),
    duration: Number(action.duration || 0) || 0,
    video: !!action.video,
  };
}

/**
 * The account's call history (like the Telegram "Cuộc gọi" (Calls) screen): messages.Search with an empty peer +
 * InputMessagesFilterPhoneCalls (missed = missed calls only), paginated by offsetId.
 */
export async function getCallHistory(
  accountId: string,
  params: { missed?: boolean; offsetId?: number; limit?: number } = {},
): Promise<{ success: boolean; items?: TelegramCallHistoryItem[]; nextOffsetId?: number; hasMore?: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 50)));
  try {
    const result: any = await conn.client.invoke(new Api.messages.Search({
      peer: new Api.InputPeerEmpty(),
      q: '',
      filter: new Api.InputMessagesFilterPhoneCalls(params.missed ? { missed: true } : {}),
      minDate: 0,
      maxDate: 0,
      offsetId: Math.max(0, Math.floor(Number(params.offsetId) || 0)),
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }));
    const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];
    const users = new Map<string, any>();
    for (const user of Array.isArray(result?.users) ? result.users : []) {
      users.set(String(user?.id?.valueOf?.() ?? user?.id), user);
    }
    const db = DatabaseService.getInstance();
    const avatars = new Map<string, string>(
      (db?.query<any>(
        `SELECT contact_id, avatar_url FROM contacts WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND contact_type = 'user' AND COALESCE(avatar_url, '') != ''`,
        [accountId],
      ) || []).map((row: any) => [String(row.contact_id), String(row.avatar_url)]),
    );
    const items: TelegramCallHistoryItem[] = [];
    for (const message of messages) {
      if (message?.action?.className !== 'MessageActionPhoneCall') continue;
      const userId = deriveChatIdFromRawMessage(message) || '';
      if (!userId) continue;
      const user = users.get(userId);
      if (user) cacheTelegramPeer(accountId, userId, user);
      const call = telegramCallInfoOf(message);
      items.push({
        msgId: String(message.id),
        userId,
        name: (user && ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username)) || telegramKnownName(accountId, userId),
        avatar: avatars.get(userId) || '',
        date: Number(message.date || 0) * 1000,
        out: call.out,
        reason: call.reason,
        duration: Number(call.duration || 0),
        video: !!call.video,
      });
    }
    const last = messages[messages.length - 1];
    return { success: true, items, nextOffsetId: last ? Number(last.id) : 0, hasMore: messages.length >= limit };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

// ── Incoming calls ───────────────────────────────────────────────────────────────
// Deplao does not yet have Telegram's call engine (tgcalls: WebRTC + a private signaling protocol that Telegram does not publish), so
// it cannot answer: it only reports "có cuộc gọi đến" (incoming call) so the user can answer on the phone / Telegram, or decline at once.
// Does not call phone.receivedCall (that would make Telegram treat this machine as busy and reject other calls).

const ringingTelegramCalls = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

function endRingingTelegramCall(accountId: string, callId: string, reason: string): void {
  const key = `${accountId}:${callId}`;
  const ringing = ringingTelegramCalls.get(key);
  if (!ringing) return;
  clearTimeout(ringing.timer);
  ringingTelegramCalls.delete(key);
  EventBroadcaster.emit('event:telegramCall', { zaloId: accountId, state: 'ended', callId, reason });
}

async function handleTelegramPhoneCallUpdate(accountId: string, client: TelegramClient, call: any): Promise<void> {
  if (!call) return;
  const callId = String(call.id?.valueOf?.() ?? call.id ?? '');
  if (!callId) return;
  if (call.className === 'PhoneCallRequested') {
    // Only calls to this account (calls made from another machine do not come here)
    if (String(call.participantId?.valueOf?.() ?? call.participantId ?? '') !== String(accountId)) return;
    const key = `${accountId}:${callId}`;
    if (ringingTelegramCalls.has(key)) return;
    const userId = String(call.adminId?.valueOf?.() ?? call.adminId ?? '');
    let name = telegramKnownName(accountId, userId);
    if (name === userId) {
      try {
        const entity: any = await hydrateTelegramIdentity(accountId, client, userId);
        name = [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || userId;
      } catch {}
    }
    const avatar = DatabaseService.getInstance()?.queryOne<any>(
      `SELECT avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
      [accountId, userId],
    )?.avatar_url || '';
    // Telegram ends an unanswered call by itself (PhoneCallDiscarded); a timer is set in case that update is lost.
    const timer = setTimeout(() => endRingingTelegramCall(accountId, callId, 'timeout'), 90_000);
    ringingTelegramCalls.set(key, { timer });
    EventBroadcaster.emit('event:telegramCall', {
      zaloId: accountId,
      state: 'ringing',
      callId,
      accessHash: String(call.accessHash?.valueOf?.() ?? call.accessHash ?? ''),
      userId,
      name,
      avatar,
      video: !!call.video,
      date: Number(call.date || 0) * 1000,
    });
    tgLog('info', accountId, 'socket', 'INCOMING_CALL', { video: !!call.video });
    return;
  }
  if (call.className === 'PhoneCallDiscarded') {
    endRingingTelegramCall(accountId, callId, telegramCallReasonOf(call.reason?.className) || 'ended');
  } else if (call.className === 'PhoneCall' || call.className === 'PhoneCallAccepted') {
    endRingingTelegramCall(accountId, callId, 'answered_elsewhere');
  }
}

/** Decline a ringing call (phone.DiscardCall with reason busy, like Telegram's "Từ chối" (Decline) button). */
export async function declineCall(
  accountId: string,
  params: { callId: string; accessHash: string; video?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const callId = String(params?.callId || '');
  if (!/^-?\d+$/.test(callId) || !/^-?\d+$/.test(String(params?.accessHash || ''))) return { success: false, error: tr('Cuộc gọi không hợp lệ') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const { Api } = require('telegram');
  try {
    await conn.client.invoke(new Api.phone.DiscardCall({
      peer: new Api.InputPhoneCall({ id: BigInt(callId), accessHash: BigInt(String(params.accessHash)) }),
      duration: 0,
      reason: new Api.PhoneCallDiscardReasonBusy(),
      connectionId: BigInt(0),
      ...(params.video ? { video: true } : {}),
    }));
    endRingingTelegramCall(accountId, callId, 'declined');
    return { success: true };
  } catch (err: any) {
    const raw = String(err?.errorMessage || err?.message || err);
    if (raw.includes('CALL_ALREADY_ACCEPTED')) {
      endRingingTelegramCall(accountId, callId, 'answered_elsewhere');
      return { success: false, error: tr('Cuộc gọi đã được nghe trên thiết bị khác') };
    }
    if (raw.includes('CALL_ALREADY_DECLINED') || raw.includes('CALL_PEER_INVALID')) {
      endRingingTelegramCall(accountId, callId, 'ended');
      return { success: true };
    }
    return { success: false, error: friendlyTelegramActionError(raw) };
  }
}

/**
 * Call message in a 1-1 conversation (socket): saves the call card, moves the conversation to the top, and notifies the chat view like a new message.
 * History / load-more go through normalizeTelegramMessageMedia (same card), so no separate branch is needed.
 */
function persistTelegramCallServiceMessage(accountId: string, message: any, source: TelegramIngressSource): ProcessResult {
  const db = DatabaseService.getInstance();
  if (!db) return { status: 'failed' };
  const msgId = String(message?.id ?? '');
  const chatId = deriveChatIdFromRawMessage(message) || '';
  if (!msgId || !chatId || chatId.startsWith('-')) return { status: 'ignored', chatId, messageId: msgId };
  const isSelf = !!message.out;
  const timestamp = (message.date || Math.floor(Date.now() / 1000)) * 1000;
  const { content, msgType } = normalizeTelegramMessageMedia(message);
  const senderId = isSelf ? String(accountId) : chatId;
  const result = persistTelegramMessage(db, {
    msgId, accountId, chatId, threadType: 0, senderId, content, msgType, timestamp, isSelf, attachments: [],
  });
  if (result.status !== 'inserted') return result;
  const preview = getTelegramMessagePreview(msgType, content);
  const countUnread = !isSelf && source === 'socket';
  const name = telegramKnownName(accountId, chatId);
  db.run(`
    INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
    VALUES (?, ?, ?, '', 0, 'user', ?, ?, ?, 'telegram_user')
    ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
      last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
      last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
      unread_count = CASE WHEN ? = 0 THEN contacts.unread_count ELSE contacts.unread_count + 1 END,
      channel = 'telegram_user'
  `, [accountId, chatId, name === chatId ? '' : name, countUnread ? 1 : 0, preview, timestamp, countUnread ? 1 : 0]);
  EventBroadcaster.emit('event:message', {
    zaloId: accountId,
    channel: 'telegram_user',
    message: {
      channel: 'telegram_user',
      type: 0,
      threadId: chatId,
      isSelf,
      _silentNotification: source !== 'socket',
      data: {
        uidFrom: senderId,
        idTo: chatId,
        msgId,
        content,
        preview,
        msgType,
        channel: 'telegram_user',
        isChannel: false,
        ts: String(timestamp),
        dName: isSelf || name === chatId ? '' : name,
      },
    },
  });
  tgLog('info', accountId, source, `UI_EMITTED call ${msgId}`, { chatId });
  return result;
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
      username: member.username || '', // the @mention box reads @usernames from the DB, without asking each person again
    })));

    return { success: true, members: membersResult };
  } catch (err: any) {
    const cachedMembers = mapCachedTelegramGroupMembers(accountId, chatId);
    return cachedMembers.length ? { success: true, members: cachedMembers } : { success: false, error: err.message };
  }
}

/** Telegram user's @username (including people who only have a collected username: usernames[]). */
function telegramUsernameOf(user: any): string {
  if (user?.username) return String(user.username);
  const active = (user?.usernames || []).find((item: any) => item?.active && item?.username);
  return active ? String(active.username) : '';
}

/**
 * The @mention box of a large group (like Telegram): search members by name / @username on Telegram right away (channels.getParticipants,
 * Mentions filter, anonymous admins excluded) and SAVE to page_group_member with the @username: next time search the DB, no
 * network needed. A normal group (basic group) already has all members through getGroupMembers, so no search. `complete`: all matching people have
 * been returned, so typing more text afterwards does not need to ask again (ui/lib/chat/members/mentionMembers.ts).
 */
export async function searchGroupMembers(
  accountId: string,
  chatId: string,
  query: string,
  limit = 50,
): Promise<{ success: boolean; found?: number; complete?: boolean; error?: string }> {
  const q = String(query || '').trim();
  if (!q) return { success: true, found: 0, complete: true };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    if (peerType !== 'supergroup' && peerType !== 'forum') return { success: true, found: 0, complete: true };
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);
    const result: any = await conn.client.invoke(new Api.channels.GetParticipants({
      channel: await resolveInputChannel(accountId, conn.client, chatId),
      filter: new Api.ChannelParticipantsMentions({ q }),
      offset: 0,
      limit: pageSize,
      hash: BigInt(0),
    }));
    const roles = new Map<string, number>();
    for (const participant of result?.participants || []) {
      const kind = participant?.className || '';
      if (kind === 'ChannelParticipantBanned' || kind === 'ChannelParticipantLeft') continue;
      const memberId = String(participant.userId || participant.peer?.userId || '');
      if (memberId) roles.set(memberId, kind === 'ChannelParticipantCreator' ? 1 : kind === 'ChannelParticipantAdmin' ? 2 : 0);
    }
    // Only people currently in the group (who have a participant entry); outsiders are not in the member list
    const users: any[] = (result?.users || []).filter((user: any) => user?.id != null && !user.deleted && roles.has(String(user.id)));
    const db = DatabaseService.getInstance();
    const cachedAvatars = new Map<string, string>();
    if (db && users.length) {
      const ids = users.map((user: any) => String(user.id));
      for (const row of db.query<any>(
        `SELECT member_id, avatar FROM page_group_member
         WHERE owner_zalo_id = ? AND group_id = ? AND member_id IN (${ids.map(() => '?').join(', ')})`,
        [accountId, chatId, ...ids],
      )) {
        if (row?.member_id && row?.avatar) cachedAvatars.set(String(row.member_id), String(row.avatar));
      }
    }
    for (const user of users) cacheTelegramPeer(accountId, String(user.id), user);
    if (users.length) {
      db?.saveGroupMembers(accountId, chatId, users.map((user: any) => {
        const memberId = String(user.id);
        const username = telegramUsernameOf(user);
        return {
          memberId,
          displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || username || memberId,
          avatar: cachedAvatars.get(memberId) || '',
          role: roles.get(memberId) || 0,
          username,
        };
      }));
      scheduleGroupMemberAvatarHydration(accountId, chatId, conn.client, users, cachedAvatars, roles);
    }
    const count = Number(result?.count);
    const complete = users.length < pageSize || (Number.isFinite(count) && count <= users.length);
    return { success: true, found: users.length, complete };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Group admins + custom title (rank, e.g. "I.... am.... mod"): the label at the top right of the sender's name, like Telegram.
 * The "recent" list from getGroupMembers does not include all admins in large groups, so ask the Admins filter separately (a few dozen people).
 * Channel (broadcast): posts have no sender and regular members cannot see the list, so skipped. Saved to telegram_group_admins.
 */
export async function getGroupAdmins(
  accountId: string,
  chatId: string,
): Promise<{ success: boolean; admins?: Array<{ memberId: string; role: number; rank: string }>; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const admins: Array<{ memberId: string; role: number; rank: string }> = [];
    if (peerType === 'supergroup' || peerType === 'forum') {
      const result: any = await conn.client.invoke(new Api.channels.GetParticipants({
        channel: await resolveInputChannel(accountId, conn.client, chatId),
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 200,
        hash: BigInt(0),
      }));
      for (const user of result?.users || []) cacheTelegramPeer(accountId, String(user.id), user);
      for (const participant of result?.participants || []) {
        const kind = participant?.className || '';
        if (kind !== 'ChannelParticipantCreator' && kind !== 'ChannelParticipantAdmin') continue;
        const memberId = String(participant.userId || participant.peer?.userId || '');
        if (!memberId) continue;
        admins.push({ memberId, role: kind === 'ChannelParticipantCreator' ? 1 : 2, rank: String(participant.rank || '').trim() });
      }
    } else if (peerType === 'basic_group') {
      // Normal group: no custom titles, only the creator / admins
      const fullChat: any = await conn.client.invoke(new Api.messages.GetFullChat({ chatId: getBasicGroupId(chatId) }));
      for (const participant of fullChat?.fullChat?.participants?.participants || []) {
        const kind = participant?.className || '';
        if (kind !== 'ChatParticipantCreator' && kind !== 'ChatParticipantAdmin') continue;
        const memberId = String(participant.userId || '');
        if (memberId) admins.push({ memberId, role: kind === 'ChatParticipantCreator' ? 1 : 2, rank: '' });
      }
    } else {
      return { success: true, admins: [] };
    }
    DatabaseService.getInstance()?.replaceTelegramGroupAdmins(accountId, chatId, admins);
    return { success: true, admins };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

const TELEGRAM_GROUP_ADMINS_TTL_MS = 6 * 60 * 60 * 1000;

/** getGroupAdmins uses the saved copy if it is recent (< 6 hours): opening a conversation makes no network call each time; on a network error, return the old saved copy. */
export async function getGroupAdminsCached(
  accountId: string,
  chatId: string,
  refresh = false,
): Promise<{ success: boolean; admins?: Array<{ memberId: string; role: number; rank: string }>; error?: string }> {
  const rows = DatabaseService.getInstance()?.getTelegramGroupAdmins(accountId, chatId) || [];
  const cached = rows.map((row) => ({ memberId: String(row.member_id), role: Number(row.role) || 2, rank: String(row.rank || '') }));
  const newest = rows.reduce((max, row) => Math.max(max, Number(row.updated_at) || 0), 0);
  if (!refresh && rows.length > 0 && Date.now() - newest < TELEGRAM_GROUP_ADMINS_TTL_MS) return { success: true, admins: cached };
  const fresh = await getGroupAdmins(accountId, chatId);
  if (fresh.success || rows.length === 0) return fresh;
  return { success: true, admins: cached };
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
 * Pin / unpin a conversation on Telegram.
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
 * Get the list of people who reacted to a message.
 * Uses Telegram's messages.GetMessageReactionsList API.
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
    // Channel post: Telegram does not let anyone see who reacted (not even admins): BROADCAST_FORBIDDEN
    if (String(err?.errorMessage || err?.message || '').includes('BROADCAST_FORBIDDEN')) {
      return { success: false, anonymous: true, error: tr('Kênh ẩn danh người thả cảm xúc') } as any;
    }
    return { success: false, error: err.message };
  }
}

/**
 * "Đã xem" (Read) status of messages I sent (like Telegram Desktop: right-click → "10 đã xem" (10 read) + the list). Group / supergroup:
 * getMessageReadParticipants (Telegram only allows this for small groups, messages up to 7 days old); private chat: getOutboxReadDate. The viewers' names:
 * one users.GetUsers call for the ids already in the GramJS cache (otherwise the renderer looks up the contact / group member itself).
 */
export async function getMessageReadParticipants(
  accountId: string,
  chatId: string,
  messageId: string,
): Promise<{
  success: boolean;
  kind?: 'group' | 'private';
  participants?: Array<{ userId: string; date: number; name: string }>;
  readAt?: number;
  reason?: ReadReceiptUnavailableReason;
  error?: string;
}> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, reason: 'error', error: conn.error };
  const msgId = Number(messageId);
  if (!Number.isSafeInteger(msgId) || msgId <= 0) return { success: false, reason: 'error', error: tr('Tin chưa gửi xong') };
  const { Api } = require('telegram');
  try {
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    if (!String(chatId).startsWith('-')) {
      const res: any = await conn.client.invoke(new Api.messages.GetOutboxReadDate({ peer, msgId }));
      return { success: true, kind: 'private', readAt: Math.max(0, Number(res?.date || 0)) * 1000, participants: [] };
    }
    const participants = normalizeReadParticipants(await conn.client.invoke(new Api.messages.GetMessageReadParticipants({ peer, msgId })));
    const names = new Map<string, string>();
    const inputUsers: any[] = [];
    for (const { userId } of participants.slice(0, 100)) {
      try {
        const inputPeer = (conn.client as any)._entityCache?.get(userId);
        if (inputPeer?.className === 'InputPeerUser') inputUsers.push(new Api.InputUser({ userId: inputPeer.userId, accessHash: inputPeer.accessHash }));
      } catch { /* not in the cache: the renderer looks it up itself */ }
    }
    if (inputUsers.length) {
      try {
        const users: any[] = await conn.client.invoke(new Api.users.GetUsers({ id: inputUsers }));
        for (const user of users || []) {
          const name = telegramEntityName(user);
          if (user?.id != null && name) names.set(String(user.id), name);
        }
      } catch { /* only a fallback name */ }
    }
    return { success: true, kind: 'group', participants: participants.map((p) => ({ ...p, name: names.get(p.userId) || '' })) };
  } catch (err: any) {
    const mapped = mapReadReceiptError(err);
    return { success: false, reason: mapped.reason, error: mapped.message };
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
    if (peerType !== 'user') return { success: false, error: tr('Đây không phải tài khoản người dùng Telegram') };
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
      const photo = await downloadProfilePhotoQueued(accountId, conn.client, user, `profile:${userId}`, false, {
        threadId: chatId || undefined, urgency: 'visible',
      });
      if (photo?.length) {
        const savedPath = await saveAvatarToDisk(Buffer.from(photo), `tg_profile_${userId}_${Date.now()}.jpg`);
        if (savedPath) {
          const normalized = savedPath.replace(/\\/g, '/');
          avatarUrl = 'local-media://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
        }
      }
    } catch {}
    const fullUser = full?.fullUser || {};
    // Main Mini App: the User flag decides (null = unknown, e.g. GetFullUser failed and the cached entity is a min User)
    const mainAppFlag = telegramBotHasMainApp(user) ?? telegramBotHasMainApp(entity);
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
        // botInfo.appSettings alone missed most main-app bots (it is optional), so the "Open" button never showed
        hasMainApp: mainAppFlag === 1 || !!full?.fullUser?.botInfo?.appSettings,
    };
    // Keep the flag on the conversation row: the renderer only set it in memory, so it was gone after a restart
    if (mainAppFlag != null) {
      DatabaseService.getInstance()?.run(
        `UPDATE contacts SET has_main_app = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
        [profile.hasMainApp ? 1 : 0, accountId, profile.id],
      );
    }
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
/** Result of contacts.resolveUsername / resolvePhone → the main peer (every peer returned is saved to get its access hash). */
function resolvedPeerInfo(accountId: string, result: any): any | null {
  const users = result?.users || [];
  const chats = result?.chats || [];
  for (const user of users) {
    if (user?.id) cacheTelegramPeer(accountId, String(user.id), user);
  }
  for (const chat of chats) {
    if (chat?.id) cacheTelegramPeer(accountId, getCanonicalChatId(chat), chat);
  }
  const primary = users[0] || chats[0];
  if (!primary) return null;
  const isUser = primary.className === 'User';
  return {
    peerId: isUser ? String(primary.id) : getCanonicalChatId(primary),
    peerType: getTelegramPeerType(primary),
    displayName: primary.firstName
      ? [primary.firstName, primary.lastName].filter(Boolean).join(' ')
      : primary.title || primary.username || '',
    username: primary.username || '',
    phone: primary.phone || '',
    // Open the link inside the app (lib/chat/links/chatLinks): bot / main app / already joined group, channel not yet
    isBot: isUser && !!primary.bot,
    hasMainApp: isUser && !!primary.botHasMainApp,
    ...(isUser ? {} : {
      isMember: !primary.left && primary.className !== 'ChatForbidden' && primary.className !== 'ChannelForbidden',
      isChannel: !!primary.broadcast,
    }),
  };
}

export async function resolveUsername(accountId: string, username: string): Promise<{ success: boolean; peer?: any; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const cleanUsername = username.replace(/^@/, '');
    if (!cleanUsername) return { success: false, error: tr('Username không hợp lệ') };

    const result = await conn.client.invoke(new Api.contacts.ResolveUsername({ username: cleanUsername }));
    const peer = resolvedPeerInfo(accountId, result);
    if (!peer) return { success: false, error: `Không tìm thấy @${cleanUsername}` };
    return { success: true, peer };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/** Phone number link (t.me/+84…): contacts.resolvePhone, same result shape as resolveUsername. */
export async function resolvePhone(accountId: string, phone: string): Promise<{ success: boolean; peer?: any; error?: string }> {
  const clean = String(phone || '').replace(/[^\d]/g, '');
  if (!/^\d{5,15}$/.test(clean)) return { success: false, error: tr('Số điện thoại không hợp lệ') };
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  try {
    const { Api } = require('telegram');
    const result = await conn.client.invoke(new Api.contacts.ResolvePhone({ phone: clean }));
    const peer = resolvedPeerInfo(accountId, result);
    if (!peer) return { success: false, error: `Không tìm thấy +${clean} trên Telegram` };
    return { success: true, peer };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    if (/PHONE_NOT_OCCUPIED/.test(message)) return { success: false, error: tr('+{{clean}} chưa dùng Telegram', { clean }) };
    return { success: false, error: message };
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
 * Add a member to the group
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
 * Remove / leave a member from the group
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
 * Rename the group
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
 * Change the group's profile photo
 */
export async function editChatPhoto(accountId: string, chatId: string, photoPath: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const error = await applyTelegramChatPhoto(accountId, conn.client, chatId, peerType, photoPath);
    return error ? { success: false, error } : { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Grant / revoke admin rights
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
      await conn.client.invoke(new Api.channels.EditAdmin({ channel: await resolveInputChannel(accountId, conn.client, chatId), userId: user, adminRights, rank: '' }));
    } else {
      await conn.client.invoke(new Api.messages.EditChatAdmin({ chatId: getBasicGroupId(chatId), userId: user, isAdmin }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Leave the group (convenience wrapper)
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
 * Get the group invite link
 */
export async function exportChatInvite(accountId: string, chatId: string): Promise<{ success: boolean; link?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const peerType = await resolveChatPeerType(accountId, conn.client, chatId);
    const link = await readPrimaryInviteLink(accountId, conn.client, chatId, peerType);
    return link ? { success: true, link } : { success: false, error: tr('Không lấy được link mời — cần quyền mời thành viên') };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Mark the group as read
 */
/**
 * @-mentions and reactions have their OWN unread counters on Telegram (the "@" / "❤" badges of the
 * Telegram apps): messages/channels.ReadHistory does not clear them. Clear both like "Mark as read"
 * in the Telegram apps (messages.readMentions / messages.readReactions, repeated while `offset` > 0).
 * Best-effort: a failure here must not turn a successful ReadHistory into an error.
 */
async function readTelegramUnreadThings(accountId: string, client: any, peer: any, chatId: string, topMsgId?: number): Promise<void> {
  const { Api } = require('telegram');
  const requests: Array<[string, (args: any) => any]> = [
    ['readMentions', args => new Api.messages.ReadMentions(args)],
    ...(Api.messages.ReadReactions ? [['readReactions', (args: any) => new Api.messages.ReadReactions(args)] as [string, (args: any) => any]] : []),
  ];
  for (const [name, build] of requests) {
    try {
      // AffectedHistory.offset > 0 → Telegram has more to process, call again
      for (let round = 0; round < 20; round++) {
        const result: any = await client.invoke(build({ peer, ...(topMsgId ? { topMsgId } : {}) }));
        if (!(Number(result?.offset) > 0)) break;
      }
    } catch (err: any) {
      tgLog('warn', accountId, 'socket', `${name} failed`, { chatId, topMsgId, error: err?.message });
    }
  }
}

/**
 * Mark the whole conversation as read (Read History) + clear the @ mark / reactions. `historyOnly`: only ReadHistory, used when reporting
 * a new message while the user is in the chat (1 call instead of 3; if the message mentions me, the renderer calls all of them).
 */
export async function readChatHistory(
  accountId: string, chatId: string, opts: { historyOnly?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
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
    // ReadHistory leaves the @-mention / reaction badges → clear them too (whole chat, every forum topic)
    if (!opts.historyOnly) {
      await readTelegramUnreadThings(accountId, conn.client, await resolveInputPeer(accountId, conn.client, chatId), chatId);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Mark one specific forum topic as read
 * A forum topic = discussion thread, uses messages.ReadDiscussion
 * msg_id = topic root message ID
 * read_max_id = max message ID to mark as read (uses top_message from ForumTopic if available)
 */
export async function readForumTopic(accountId: string, chatId: string, topMsgId: string, readMaxId?: string): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    // read_max_id: if missing → use INT32_MAX to mark the whole topic as read
    const maxId = readMaxId ? Number(readMaxId) : 0x7FFFFFFF;
    Logger.log(`[TelegramUserListener] readForumTopic: chatId=${chatId} topMsgId=${topMsgId} readMaxId=${maxId}`);
    await conn.client.invoke(new Api.messages.ReadDiscussion({
      peer,
      msgId: Number(topMsgId),
      readMaxId: maxId,
    }));
    // The topic's @-mention / reaction badges are separate counters (see readTelegramUnreadThings)
    await readTelegramUnreadThings(accountId, conn.client, peer, chatId, Number(topMsgId));
    return { success: true };
  } catch (err: any) {
    Logger.warn(`[TelegramUserListener] readForumTopic failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get the full group info (full chat info)
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

/** A member's avatar that failed to load / has none: do not retry for 1 hour (each time the group is opened, each history page queued for download reloads exactly those people). */
const MEMBER_AVATAR_RETRY_MS = 60 * 60 * 1000;
const MEMBER_AVATAR_FAILURES_MAX = 5000;
const memberAvatarFailedAt = new Map<string, number>();

function memberAvatarRecentlyFailed(failureKey: string): boolean {
  const at = memberAvatarFailedAt.get(failureKey);
  if (at === undefined) return false;
  if (Date.now() - at < MEMBER_AVATAR_RETRY_MS) return true;
  memberAvatarFailedAt.delete(failureKey);
  return false;
}

function rememberMemberAvatarFailure(failureKey: string): void {
  memberAvatarFailedAt.delete(failureKey);
  memberAvatarFailedAt.set(failureKey, Date.now());
  while (memberAvatarFailedAt.size > MEMBER_AVATAR_FAILURES_MAX) {
    memberAvatarFailedAt.delete(memberAvatarFailedAt.keys().next().value as string);
  }
}

/** GramJS can only build an InputPeer for a user that has an accessHash and is not a `min` (abbreviated) copy (a sender in a large channel):
 * downloadProfilePhoto for another user always throws "User without accessHash or min cannot be input" (log 28/10/2026: 170 tries, 170 errors). Their full copy (the member list) can still be downloaded. */
function canDownloadMemberPhoto(user: any): boolean {
  return user?.self === true || (user?.accessHash !== undefined && user?.accessHash !== null && !user?.min);
}

/** Queue media-photo downloads per group. Parallel GramJS exported senders can
 * tear down the main MTProto connection on unstable networks. */
function scheduleGroupMemberAvatarHydration(accountId: string, chatId: string, client: TelegramClient, participants: any[], cachedAvatars: Map<string, string>, roles: Map<string, number>): void {
  const key = `${accountId}_${chatId}`;
  const targets = participants.filter((user: any) => user?.id && user?.photo && user.photo !== 'ChatPhotoEmpty'
    && !cachedAvatars.has(String(user.id)) && canDownloadMemberPhoto(user)
    && !memberAvatarRecentlyFailed(`${key}_${String(user.id)}`));
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
            // After the conversation's photos / videos (sortKey 0): a group of several hundred members does not jump ahead of the message's files
            const photo = await downloadProfilePhotoQueued(accountId, job!.client, user, `member:${chatId}:${memberId}`, false, {
              threadId: chatId, sortKey: 0,
            });
            if (!photo?.length) {
              rememberMemberAvatarFailure(`${key}_${memberId}`);
              continue;
            }
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
            rememberMemberAvatarFailure(`${key}_${memberId}`);
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
 * Check whether a supergroup is a forum.
 * Flow: memory cache → DB → API → save to DB + cache
 *
 * @param forceApi Must call the API (skip the cache)
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
 * Check isForum for all group contacts not yet checked (background).
 * Called when the app starts or when a new group appears.
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
    // Throttle: 500ms between each check
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Get the list of topics in a forum group
 */
export async function getForumTopics(accountId: string, chatId: string): Promise<{ success: boolean; topics?: any[]; error?: string }> {
  touchActiveChannel(accountId, chatId);
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };

  // Guard: basic groups (negative IDs without -100 prefix) are NOT channels/supergroups.
  // GetForumTopics requires a supergroup. Basic groups cannot have forums.
  const numericId = String(chatId);
  if (numericId.startsWith('-') && !numericId.startsWith('-100')) {
    return { success: false, error: 'Forum topics are only available for supergroups' };
  }

  // Try up to 2 times: first attempt with current entity, second after forcing entity refresh.
  // This handles stale access hashes after reconnect or long idle.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await conn.client.invoke(await forumTopicRequest(accountId, conn.client, chatId, 'GetForumTopics', {
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
      }));

    const topics = (result as any)?.topics || [];
    // Custom emoji icon of the topic (one call for the ids not yet cached); on error or slowness, draw a colored icon instead
    let iconEmoji = new Map<string, any>();
    const emojiIds = topics.map((topic: any) => (topic?.iconEmojiId ? String(topic.iconEmojiId) : '')).filter(Boolean);
    if (emojiIds.length > 0) {
      try {
        const { Api } = require('telegram');
        iconEmoji = await Promise.race([
          TelegramStickers.getCustomEmojiItems(accountId, emojiIds, { client: conn.client, Api }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
        ]);
      } catch (emojiErr: any) {
        Logger.warn(`[TelegramUserListener] getForumTopics: topic icons for ${chatId}: ${emojiErr?.message || emojiErr}`);
      }
    }
    // Latest message line + the time of THAT message (ForumTopic.date is the topic's creation date): telegramForumTopics.ts
    const mappedTopics = mapForumTopics(result, (message: any) => normalizeTelegramMessageMedia(message), iconEmoji);

    tgLog('info', accountId, 'topic_api', `TOPICS_RECEIVED for ${chatId}`, {
      count: topics.length,
      // Keep both IDs visible while diagnosing topic routing. Telegram's
      // ForumTopic.id and ForumTopic.topMessage have different semantics.
      ids: topics.slice(0, 20).map((topic: any) => `${String(topic.id || '-')}:${String(topic.topMessage || '-')}`).join(','),
    });

    return { success: true, topics: mappedTopics };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      // CHANNEL_INVALID (PEER_ID_INVALID with messages.getForumTopics) on first attempt: refresh the entity cache and retry
      if ((errMsg.includes('CHANNEL_INVALID') || errMsg.includes('PEER_ID_INVALID')) && attempt === 0) {
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
        return { success: false, error: tr('CHANNEL_INVALID: Nhóm này không phải supergroup hoặc access hash đã hết hạn') };
      }
      return { success: false, error: errMsg };
    }
  }
  return { success: false, error: 'CHANNEL_INVALID' };
}

/**
 * Get the messages of 1 specific topic
 */
export async function getForumTopicMessages(accountId: string, chatId: string, rootMessageId: string, limit = 50): Promise<{ success: boolean; messages?: any[]; error?: string }> {
  // Channel post without a topic: a "topic" = the post's comments, which live in the DISCUSSION GROUP (getPostDiscussion). Previously saved
  // comments as messages of the CHANNEL → same id as the channel post: comments missing + overwrote the topic / reply of the channel post.
  if (DatabaseService.getInstance()?.getTelegramPeer(accountId, chatId)?.peer_type === 'channel') {
    return { success: false, error: 'NOT_A_FORUM' };
  }
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
 * Forum topics: from layer 22x Telegram moved channels.getForumTopics / createForumTopic / editForumTopic /
 * updatePinnedForumTopic to messages.* (the `peer` parameter instead of `channel`). Layer 198 (the original GramJS schema) still uses channels.*.
 */
async function forumTopicRequest(
  accountId: string,
  client: TelegramClient,
  chatId: string,
  method: 'GetForumTopics' | 'CreateForumTopic' | 'EditForumTopic' | 'UpdatePinnedForumTopic',
  params: Record<string, unknown>,
): Promise<any> {
  const { Api } = require('telegram');
  const modern = (Api as any).messages?.[method];
  if (modern) return new modern({ peer: await resolveInputPeer(accountId, client, chatId), ...params });
  const legacy = (Api as any).channels?.[method];
  if (!legacy) throw new Error(`Telegram API không có ${method}`);
  return new legacy({ channel: await resolveInputChannel(accountId, client, chatId), ...params });
}

/**
 * Create a new topic in a forum group
 */
export async function createForumTopic(accountId: string, chatId: string, title: string, iconColor?: number, iconEmojiId?: string): Promise<{ success: boolean; topicId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    const result = await conn.client.invoke(await forumTopicRequest(accountId, conn.client, chatId, 'CreateForumTopic', {
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
 * Rename / close / reopen a topic
 */
export async function editForumTopic(accountId: string, chatId: string, topicId: string, opts: { title?: string; iconEmojiId?: string; closed?: boolean; pinned?: boolean }): Promise<{ success: boolean; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  try {
    if (opts.title !== undefined || opts.iconEmojiId !== undefined || opts.closed !== undefined) {
      await conn.client.invoke(await forumTopicRequest(accountId, conn.client, chatId, 'EditForumTopic', {
        topicId: Number(topicId),
        title: opts.title,
        iconEmojiId: opts.iconEmojiId ? BigInt(opts.iconEmojiId) : undefined,
        closed: opts.closed,
      }));
    }
    // Pinning a topic is a separate method (EditForumTopic has no pin flag; previously `pinned` was ignored)
    if (opts.pinned !== undefined) {
      await conn.client.invoke(await forumTopicRequest(accountId, conn.client, chatId, 'UpdatePinnedForumTopic', {
        topicId: Number(topicId),
        pinned: !!opts.pinned,
      }));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Send a message into a specific topic
 */
export async function sendTopicMessage(accountId: string, chatId: string, rootMessageId: string, text: string, replyToMsgId?: string, mentions?: TelegramSendMention[]): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  // Discussion group not joined but comments are allowed: the "không gửi được" (cannot send) state saved belongs to the group chat, not to the comment
  const denial = isCommentOnlyGroup(accountId, chatId) ? null : getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: tr('Gửi tin quá nhanh. Vui lòng chờ {{waitSeconds}} giây.', { waitSeconds: rateLimit.waitSeconds }) };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, chatId);
    const sentAt = Date.now();
    // Reply to the root message of a topic / comment thread, or to a specific message inside it (still in the right topic thanks to topMsgId)
    const replyTarget = replyToMsgId && /^\d+$/.test(String(replyToMsgId)) ? Number(replyToMsgId) : Number(rootMessageId);
    const replyToId = replyTarget !== Number(rootMessageId) ? String(replyTarget) : null;
    // @mention name as in a normal message
    const sendMentions = anchorTelegramMentions(text, mentions);
    const entities = await telegramMentionEntities(accountId, conn.client, sendMentions);
    const sendRequest = (withEntities: boolean) => conn.client.invoke(new Api.messages.SendMessage({
      peer,
      message: text,
      replyTo: new Api.InputReplyToMessage({
        replyToMsgId: replyTarget,
        topMsgId: Number(rootMessageId),
      }),
      ...(withEntities && entities.length ? { entities } : {}),
      randomId: BigInt(Math.floor(Math.random() * 2**64)),
    }));
    let result: any;
    try {
      result = await sendRequest(true);
    } catch (err: any) {
      if (!entities.length || !isTelegramMentionEntityError(err)) throw err;
      result = await sendRequest(false);
    }
    const msgId = getMessageIdFromUpdates(result) || String(Date.now());
    // Server time of the message (UpdateShortSentMessage / Updates): do not use the machine's clock (see sendMessage)
    const now = telegramSentTimestamp(result, sentAt);
    const quoteData = sentReplyQuoteData(accountId, chatId, replyToId);
    const mentionAttachments = telegramMentionAttachments(sendMentions, text);
    // Link preview as in sendMessage: the sent message is inside the Updates answer
    const sentMessage = (result?.updates || []).find((update: any) => String(update?.message?.id || '') === msgId)?.message || result;
    const linkPreview = sentLinkPreview(sentMessage);
    const msgType = linkPreview?.msgType || 'text';
    const rowAttachments = withLinkPreview(mentionAttachments, linkPreview?.attachments || []);

    // Save to DB (INSERT OR IGNORE: the socket echo skips it if it already exists)
    const db = DatabaseService.getInstance();
    const commentOnly = !!db && skipCommentOnlyConversation(db, accountId, chatId);
    if (db) {
      db.run(`INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, topic_id, quote_data) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?, 'sent', 'telegram_user', ?, ?, ?)`,
        [msgId, accountId, chatId, accountId, text, msgType, now, JSON.stringify(rowAttachments), replyToId, rootMessageId, quoteData]);

      // Discussion group not joined: do not create a conversation (like Telegram)
      if (!commentOnly) db.run(`
        INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel, is_in_others)
        VALUES (?, ?, '', '', 0, 'group', 0, ?, ?, 'telegram_user', 0)
        ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
          last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
          last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
          channel = 'telegram_user'
      `, [accountId, chatId, text, now]);
    }

    // Emit event cho renderer
    EventBroadcaster.emit('event:message', {
      zaloId: accountId,
      channel: 'telegram_user',
      message: {
        channel: 'telegram_user',
        type: 1,
        threadId: chatId,
        isSelf: true,
        _silentNotification: true,
        ...(commentOnly ? { _commentOnly: true } : {}),
        data: {
          uidFrom: accountId,
          idTo: chatId,
          msgId,
          content: text,
          preview: text,
          msgType,
          channel: 'telegram_user',
          ts: String(now),
          topicId: rootMessageId,
          ...(replyToId ? { replyToId } : {}),
          ...(quoteData ? { quoteData } : {}),
          ...(rowAttachments.length ? { attachments: rowAttachments } : {}),
        },
      },
    });

    followSentLinkPreview(accountId, conn.client, chatId, msgId, sentMessage, linkPreview);
    return { success: true, messageId: msgId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── One-time data fixes / API layer ──────────────────────────────────────
//  - Messages saved as "chưa hỗ trợ" (unsupported) while GramJS is still on layer 198 (rich-format messages, checklists…) → re-fetched by id.
//  - Old records saved a channel post's COMMENTS into the channel's conversation (the discussion group's id): sometimes with topic_id, sometimes
//    without it → they show as extra items between posts; if the id matches a real post, the real post's topic / reply / content gets overwritten. Recognised by:
//    topic_id (a channel post without a topic) or a post card with 0 views (comments have no views; real posts have
//    their own sender (signature profiles) and always have views). Ask Telegram by id:
//      · the channel has that message → a real post: save the correct data (content, sender, reply), drop the topic;
//      · the channel does not have it → a comment saved by mistake: move it to the discussion group's conversation (already there, or fetch from Telegram and
//        save it), then drop the copy in the channel. Cannot verify (no discussion group / group unreadable) → keep
//        the row as is.
// Runs in the background after the app settles, one conversation at a time (≤ 100 messages / RPC, pause between calls); when a full pass is done, write the
// layer + version marker to app_settings, so the next launch does not run it again (until the layer / version changes).

const TELEGRAM_DATA_REPAIR_SETTING = 'telegram_data_repair_layer_';
/** 2 = adds moving comments saved by mistake back to the discussion group (a machine that ran version 1 runs this part again). */
const TELEGRAM_DATA_REPAIR_VERSION = 2;
const TELEGRAM_DATA_REPAIR_BATCH = 100;
const TELEGRAM_DATA_REPAIR_PAUSE_MS = 1_500;
const TELEGRAM_UNSUPPORTED_TEXT = 'Loại tin nhắn Telegram chưa được hỗ trợ';
const telegramDataRepairs = new Map<string, Promise<void>>();

function scheduleTelegramDataRepair(accountId: string): void {
  if (!accountId || telegramDataRepairs.has(accountId)) return;
  const run = new Promise<void>(resolve => whenStartupSettled(() => resolve()))
    .then(() => new Promise(resolve => setTimeout(resolve, 20_000)))
    .then(() => runTelegramDataRepair(accountId))
    .catch((err: any) => tgLog('warn', accountId, 'history', 'DATA_REPAIR_FAILED', { error: err?.message || String(err) }))
    .finally(() => telegramDataRepairs.delete(accountId));
  telegramDataRepairs.set(accountId, run);
}

async function runTelegramDataRepair(accountId: string): Promise<void> {
  const db = DatabaseService.getInstance();
  if (!db) return;
  let layer = 0;
  try { layer = Number(require('telegram/tl/AllTLObjects').LAYER) || 0; } catch {}
  if (layer <= GRAMJS_BUNDLED_LAYER) return; // original schema: re-fetching still gives "chưa hỗ trợ" (unsupported)
  const markerKey = `${TELEGRAM_DATA_REPAIR_SETTING}${accountId}`;
  const markerValue = `${layer}:${TELEGRAM_DATA_REPAIR_VERSION}`;
  if (db.getSetting(markerKey) === markerValue) return;

  // Channel posts in the conversation list (by the conversation index; scanning the whole store takes several seconds on the main thread)
  const channels = db.query<{ contact_id: string }>(
    `SELECT c.contact_id FROM contacts c
     JOIN telegram_peers p ON p.owner_zalo_id = c.owner_zalo_id AND p.peer_id = c.contact_id AND p.peer_type = 'channel'
     WHERE c.owner_zalo_id = ? AND c.channel = 'telegram_user'`,
    [accountId],
  );
  const jobs = new Map<string, { ids: string[]; corrupt: Set<string>; misplaced: Set<string> }>();
  const jobOf = (threadId: string) => {
    let job = jobs.get(threadId);
    if (!job) {
      job = { ids: [], corrupt: new Set(), misplaced: new Set() };
      jobs.set(threadId, job);
    }
    return job;
  };
  let corruptCount = 0;
  let misplacedCount = 0;
  for (let index = 0; index < channels.length; index++) {
    const channelId = String(channels[index].contact_id);
    const rows = db.query<{ msg_id: string; corrupt: number }>(
      `SELECT msg_id, (topic_id IS NOT NULL AND topic_id != '') AS corrupt FROM messages
       WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user' AND sender_id <> 'system'
         AND ((topic_id IS NOT NULL AND topic_id != '')
           OR (instr(attachments, '"type":"telegram_post"') > 0 AND instr(attachments, '"views":0,') > 0))`,
      [accountId, channelId],
    );
    for (const row of rows) {
      const msgId = String(row.msg_id);
      const job = jobOf(channelId);
      if (Number(row.corrupt)) {
        job.corrupt.add(msgId);
        corruptCount++;
      } else {
        job.misplaced.add(msgId);
        misplacedCount++;
      }
      job.ids.push(msgId);
    }
    // Yield the main thread between channels
    if (index % 20 === 19) await new Promise(resolve => setImmediate(resolve));
  }
  const unsupported = db.query<{ thread_id: string; msg_id: string }>(
    `SELECT thread_id, msg_id FROM messages
     WHERE owner_zalo_id = ? AND channel = 'telegram_user' AND msg_type = 'telegram.unsupported'
     ORDER BY timestamp DESC`,
    [accountId],
  );
  if (!corruptCount && !misplacedCount && !unsupported.length) {
    db.setSetting(markerKey, markerValue);
    return;
  }
  tgLog('info', accountId, 'history', 'DATA_REPAIR_START', {
    corrupt: corruptCount, misplaced: misplacedCount, unsupported: unsupported.length, layer, version: TELEGRAM_DATA_REPAIR_VERSION,
  });
  Logger.info(`[Telegram] Sửa dữ liệu cũ: ${unsupported.length} tin "chưa hỗ trợ", ${corruptCount + misplacedCount} tin nghi là bình luận lưu nhầm vào kênh`);

  for (const row of unsupported) {
    const job = jobOf(String(row.thread_id));
    const msgId = String(row.msg_id);
    if (!job.corrupt.has(msgId) && !job.misplaced.has(msgId)) job.ids.push(msgId);
  }

  let repaired = 0;
  for (const [threadId, job] of jobs) {
    const ids = job.ids.filter(id => /^\d+$/.test(id));
    let index = 0;
    while (index < ids.length) {
      const listener = activeListeners.get(accountId);
      if (!listener?.client || !listener.connected || listener.stopped) {
        tgLog('info', accountId, 'history', 'DATA_REPAIR_PAUSED', { repaired });
        return; // not finished: the next connection continues (the mark is not written)
      }
      const chunk = ids.slice(index, index + TELEGRAM_DATA_REPAIR_BATCH);
      try {
        repaired += await repairTelegramRowsFromServer(accountId, listener.client, threadId, chunk, job.corrupt, job.misplaced);
        index += chunk.length;
      } catch (err: any) {
        const message = String(err?.errorMessage || err?.message || err);
        const floodSeconds = Number(err?.seconds) || Number(/FLOOD_WAIT_(\d+)/.exec(message)?.[1] || 0);
        if (floodSeconds > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(floodSeconds, 300) * 1000 + 1000));
          continue; // retry that same batch
        }
        tgLog('warn', accountId, 'history', 'DATA_REPAIR_CHUNK_FAILED', { chatId: threadId, error: message.slice(0, 120) });
        // Conversation no longer accessible → skip the whole conversation; other errors → skip this batch
        if (/CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_FORBIDDEN|USER_BANNED|Không tìm thấy Telegram peer|access hash/.test(message)) break;
        index += chunk.length;
      }
      await new Promise(resolve => setTimeout(resolve, TELEGRAM_DATA_REPAIR_PAUSE_MS));
    }
  }
  db.setSetting(markerKey, markerValue);
  tgLog('info', accountId, 'history', 'DATA_REPAIR_DONE', { repaired });
  Logger.info(`[Telegram] Sửa dữ liệu cũ xong: ${repaired} tin`);
}

/**
 * Re-fetch messages by id and write the correct data. `corruptIds` (with topic_id) / `misplacedIds` (post card with 0 views) = messages
 * in the channel suspected to be comments saved by mistake: if the channel has that message → rewrite the real post; if not → move it to the discussion group.
 */
async function repairTelegramRowsFromServer(
  accountId: string,
  client: TelegramClient,
  threadId: string,
  ids: string[],
  corruptIds: Set<string>,
  misplacedIds: Set<string> = new Set(),
): Promise<number> {
  const db = DatabaseService.getInstance();
  if (!db || !ids.length) return 0;
  const peer = await resolveInputPeer(accountId, client, threadId);
  const fetched = await client.getMessages(peer, { ids: ids.map(Number) });
  const byId = new Map<string, any>();
  for (const message of fetched || []) {
    if (message && (message as any).className !== 'MessageEmpty') byId.set(String((message as any).id), message);
  }
  const peerType = db.getTelegramPeer(accountId, threadId)?.peer_type as TelegramPeerType | undefined;
  const items: any[] = [];
  const gone: string[] = [];
  for (const msgId of ids) {
    const message = byId.get(msgId);
    const suspect = corruptIds.has(msgId) || misplacedIds.has(msgId);
    if (!message) {
      // The channel does not have this message: a comment saved by mistake (id of the discussion group) → move it to the group, see below. Previously it only dropped the
      // topic → the comment showed as extra items between the channel's posts.
      if (suspect) gone.push(msgId);
      continue;
    }
    const normalized = normalizeTelegramMessageMedia(message, peerType);
    if (message.className === 'MessageService' && !normalized.content) continue;
    if (suspect) {
      // The channel's real post (same id as a comment saved by mistake, or a post with 0 views): rewrite it entirely from Telegram
      const replyToId = getTelegramReplyToMessageId(message) || null;
      const senderId = (message.fromId ? getCanonicalChatId(message.fromId) : '') || String(message.senderId?.valueOf?.() || '') || threadId;
      db.run(
        `UPDATE messages SET content = ?, msg_type = ?, attachments = ?, sender_id = ?, topic_id = NULL, reply_to_id = ?, quote_data = NULL
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [normalized.content, normalized.msgType, JSON.stringify(normalized.attachments), senderId, replyToId, msgId, accountId, threadId],
      );
      items.push({ msgId, content: normalized.content, msgType: normalized.msgType, attachments: normalized.attachments, topicId: null, replyToId, senderId });
    } else {
      db.run(
        `UPDATE messages SET content = ?, msg_type = ?, attachments = ?
         WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [normalized.content, normalized.msgType, JSON.stringify(normalized.attachments), msgId, accountId, threadId],
      );
      items.push({ msgId, content: normalized.content, msgType: normalized.msgType, attachments: normalized.attachments });
    }
    handleRichMessageExtras(accountId, client, threadId, message);
  }
  if (gone.length) {
    for (const msgId of await rehomeMisplacedComments(accountId, client, threadId, gone)) items.push({ msgId, removed: true });
  }
  if (items.length) {
    EventBroadcaster.emit('event:messagesRepaired', { zaloId: accountId, threadId, items });
    refreshTelegramContactPreview(accountId, threadId);
  }
  return items.length;
}

/** The discussion group attached to the channel: read from the saved post card (discussion_channel_id); if missing, ask Telegram (linked_chat_id). */
async function linkedDiscussionGroupId(accountId: string, client: TelegramClient, channelId: string): Promise<string> {
  const db = DatabaseService.getInstance();
  const row = db?.queryOne<{ attachments: string }>(
    `SELECT attachments FROM messages
     WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
       AND instr(attachments, '"discussion_channel_id":"') > 0 AND instr(attachments, '"discussion_channel_id":""') = 0
     ORDER BY timestamp DESC LIMIT 1`,
    [accountId, channelId],
  );
  try {
    const post = (JSON.parse(row?.attachments || '[]') as any[]).find(item => item?.type === 'telegram_post');
    const raw = String(post?.discussion_channel_id || '').replace(/^-100/, '');
    if (/^\d+$/.test(raw)) return `-100${raw}`;
  } catch {}
  try {
    const { Api } = require('telegram');
    const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: await resolveInputChannel(accountId, client, channelId) }));
    for (const chat of full?.chats || []) {
      const id = getCanonicalChatId(chat);
      if (id) cacheTelegramPeer(accountId, id, chat);
    }
    const linked = full?.fullChat?.linkedChatId;
    return linked != null ? `-100${String(linked?.valueOf?.() ?? linked)}` : '';
  } catch {
    return '';
  }
}

/**
 * Comments saved by mistake in the channel conversation (`ids` = the discussion group's ids) → the discussion group's conversation: if the group already has the message,
 * the copy in the channel is a duplicate; if not, fetch it from Telegram and save it like the comments part (topic = root message, reply to other
 * comments). Drop the copy in the channel only when the group already has the correct one; returns the ids dropped.
 */
async function rehomeMisplacedComments(accountId: string, client: TelegramClient, channelId: string, ids: string[]): Promise<string[]> {
  const db = DatabaseService.getInstance();
  if (!db || !ids.length) return [];
  const groupChatId = await linkedDiscussionGroupId(accountId, client, channelId);
  if (!groupChatId || groupChatId === channelId) return [];
  const inGroup = new Set(ids.filter(msgId => !!db.queryOne(
    `SELECT 1 FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
    [msgId, accountId, groupChatId],
  )));
  const missing = ids.filter(msgId => !inGroup.has(msgId));
  if (missing.length) {
    try {
      const groupPeer = await resolveInputPeer(accountId, client, groupChatId);
      const fetched = await client.getMessages(groupPeer, { ids: missing.map(Number) });
      const groupPeerType = (db.getTelegramPeer(accountId, groupChatId)?.peer_type || 'supergroup') as TelegramPeerType;
      for (const message of (fetched || []) as any[]) {
        if (!message || message.className === 'MessageEmpty') continue;
        const msgId = String(message.id);
        if (!missing.includes(msgId)) continue;
        const normalized = normalizeTelegramMessageMedia(message, groupPeerType);
        const sender = discussionSenderOf(message, groupChatId);
        const replyTo = message.replyTo as any;
        const replied = replyTo?.replyToMsgId != null ? String(replyTo.replyToMsgId) : '';
        const rootId = replyTo?.replyToTopId != null ? String(replyTo.replyToTopId) : replied;
        persistTelegramMessage(db, {
          msgId, accountId, chatId: groupChatId, threadType: 1,
          senderId: sender.id, content: normalized.content, msgType: normalized.msgType,
          timestamp: Number(message.date || 0) * 1000, isSelf: !!message.out, attachments: normalized.attachments,
          replyToId: replied && replied !== rootId ? replied : undefined, topicId: rootId || undefined,
          reactions: normalizeTelegramReactions(message.reactions, accountId),
        });
        inGroup.add(msgId);
      }
    } catch (err: any) {
      tgLog('warn', accountId, 'history', 'MISPLACED_COMMENTS_FETCH_FAILED', { chatId: channelId, groupChatId, error: String(err?.message || err).slice(0, 120) });
    }
  }
  const removable = ids.filter(msgId => inGroup.has(msgId));
  if (removable.length) {
    db.deleteMessages(accountId, removable, channelId);
    tgLog('info', accountId, 'history', 'MISPLACED_COMMENTS_MOVED', { chatId: channelId, groupChatId, moved: removable.length, kept: ids.length - removable.length });
  }
  return removable;
}

/** Conversation preview still "chưa hỗ trợ" (unsupported) while the newest message is now readable → update the DB + the conversation list. */
function refreshTelegramContactPreview(accountId: string, threadId: string): void {
  const db = DatabaseService.getInstance();
  if (!db) return;
  const contact = db.queryOne<any>(
    `SELECT last_message FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, threadId],
  );
  if (!contact || !String(contact.last_message || '').includes(TELEGRAM_UNSUPPORTED_TEXT)) return;
  const newest = db.queryOne<any>(
    `SELECT content, msg_type FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'
     ORDER BY timestamp DESC LIMIT 1`,
    [accountId, threadId],
  );
  if (!newest || newest.msg_type === 'telegram.unsupported') return;
  const preview = getTelegramMessagePreview(newest.msg_type, newest.content);
  if (!preview || preview.includes(TELEGRAM_UNSUPPORTED_TEXT)) return;
  db.run(
    `UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [preview, accountId, threadId],
  );
  EventBroadcaster.emit('event:contactPreview', { zaloId: accountId, contactId: threadId, lastMessage: preview });
}

// ─── Channel post comments (discussion group) + post stats ─────────────────

export interface TelegramDiscussionComment {
  msg_id: string;
  owner_zalo_id: string;
  thread_id: string;
  thread_type: 1;
  channel: 'telegram_user';
  topic_id: string;
  sender_id: string;
  sender_name: string;
  /** user = a person; chat = sent under the name of a group / channel (anonymous admin, channel auto-post). */
  sender_kind: 'user' | 'chat';
  sender_avatar: string;
  content: string;
  msg_type: string;
  timestamp: number;
  is_sent: 0 | 1;
  attachments: string;
  reactions: string;
  local_paths: string;
  /** Reply to another comment (not counting a direct reply to the post). */
  reply_to_id: string | null;
  is_edited: 0 | 1;
}

function discussionSenderOf(message: any, groupChatId: string): { id: string; kind: 'user' | 'chat' } {
  const from = message?.fromId;
  if (from?.className === 'PeerUser' && from.userId != null) return { id: String(from.userId), kind: 'user' };
  if (from) {
    const id = getCanonicalChatId(from);
    if (id) return { id, kind: 'chat' };
  }
  return { id: groupChatId, kind: 'chat' };
}

/** Commenter's name / photo: an entity in the RPC result, then the DB (group member, contact, saved peer). */
function discussionSenderProfile(
  db: DatabaseService,
  accountId: string,
  groupChatId: string,
  sender: { id: string; kind: 'user' | 'chat' },
  entities: Map<string, any>,
): { name: string; avatar: string } {
  const entity = entities.get(sender.id);
  const member = sender.kind === 'user'
    ? db.queryOne<any>(
      `SELECT display_name, avatar FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
      [accountId, groupChatId, sender.id],
    )
    : null;
  const contact = db.queryOne<any>(
    `SELECT display_name, alias, avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
    [accountId, sender.id],
  );
  const peer = db.getTelegramPeer(accountId, sender.id) as any;
  const name = telegramEntityName(entity) || member?.display_name || contact?.alias || contact?.display_name
    || peer?.display_name || (entity?.username ? `@${entity.username}` : '') || sender.id;
  const avatar = member?.avatar || contact?.avatar_url || peer?.avatar_url || '';
  return { name, avatar };
}

/**
 * Comments on a channel post, like Telegram: messages.getDiscussionMessage → the root message in the DISCUSSION GROUP + commenting permission
 * + read mark; messages.getReplies → the comments (Telegram returns newest → oldest; returning old → new). Comments are saved into the discussion group's
 * conversation (topic_id = root message id in the group), never into the channel.
 * `mode`: initial = open like Telegram (first unread comment / from the start / newest, discussionOpenWindow), older =
 * older than `offsetId`, newer = newer than `offsetId`, latest = the newest page (periodic refresh, ↓ button).
 */
export async function getPostDiscussion(
  accountId: string,
  channelId: string,
  postId: string,
  opts: { mode?: 'initial' | 'older' | 'newer' | 'latest'; offsetId?: number; limit?: number } = {},
): Promise<{
  success: boolean;
  error?: string;
  discussion?: {
    chatId: string; rootId: string; title: string; avatar: string;
    isMember: boolean; canWrite: boolean; joinMode: 'none' | 'join' | 'request'; reason: string;
    total: number; unreadCount: number;
    /** Read up to this comment / the newest comment (id in the discussion group; 0 = unknown) */
    readInboxMaxId: number; maxId: number;
  };
  comments?: TelegramDiscussionComment[];
  /** Older / newer comments remain beyond this page; null = the page does not check that side */
  hasOlder?: boolean | null;
  hasNewer?: boolean | null;
  /** First open: where to scroll to */
  anchor?: DiscussionAnchor | null;
}> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const db = DatabaseService.getInstance();
  if (!db) return { success: false, error: 'Database not ready' };
  const { Api } = require('telegram');
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  try {
    const channelPeer = await resolveInputPeer(accountId, conn.client, channelId);
    const discussion: any = await conn.client.invoke(new Api.messages.GetDiscussionMessage({ peer: channelPeer, msgId: Number(postId) }));
    const root = discussionRoot(discussion?.messages || []);
    if (!root) return { success: false, error: tr('Bài đăng này không có phần bình luận') };
    const groupChatId = getCanonicalChatId((root as any).peerId);
    const rootId = String((root as any).id);
    const entities = new Map<string, any>();
    for (const chat of discussion?.chats || []) {
      const id = getCanonicalChatId(chat);
      if (!id) continue;
      entities.set(id, chat);
      cacheTelegramPeer(accountId, id, chat);
    }
    const groupChat = entities.get(groupChatId);
    const access = discussionAccess(groupChat);
    // Not joined but can comment → a comment sent does not add the group to the conversation list
    if (access.isMember) commentOnlyGroups.delete(`${accountId}:${groupChatId}`);
    else commentOnlyGroups.add(`${accountId}:${groupChatId}`);
    const readInboxMaxId = Math.max(0, Number(discussion?.readInboxMaxId || 0));
    const threadMaxId = Math.max(0, Number(discussion?.maxId || 0));

    const mode = opts.mode || (opts.offsetId ? 'older' : 'initial');
    const anchorId = Math.max(0, Math.floor(Number(opts.offsetId) || 0));
    const page = mode === 'initial'
      ? discussionOpenWindow(Number(rootId), readInboxMaxId, threadMaxId, limit)
      : mode === 'older' && anchorId ? { offsetId: anchorId, addOffset: 0, anchor: null }
        : mode === 'newer' && anchorId ? { offsetId: anchorId + 1, addOffset: -limit, anchor: null }
          : { offsetId: 0, addOffset: 0, anchor: null };

    const replies: any = await conn.client.invoke(new Api.messages.GetReplies({
      peer: channelPeer,
      msgId: Number(postId),
      offsetId: page.offsetId,
      offsetDate: 0,
      addOffset: page.addOffset,
      limit,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }));
    for (const user of [...(replies?.users || []), ...(discussion?.users || [])]) {
      const userId = String(user?.id ?? '');
      if (!userId) continue;
      entities.set(userId, user);
      cacheTelegramPeer(accountId, userId, user);
      db.upsertGroupMember(accountId, groupChatId, {
        memberId: userId,
        displayName: telegramEntityName(user) || user.username || userId,
        avatar: '',
        role: 0,
        username: user.username || '',
      });
    }
    for (const chat of replies?.chats || []) {
      const id = getCanonicalChatId(chat);
      if (!id) continue;
      entities.set(id, chat);
      cacheTelegramPeer(accountId, id, chat);
    }

    const groupPeerType = (groupChat ? getTelegramPeerType(groupChat) : 'supergroup') as TelegramPeerType;
    const comments: TelegramDiscussionComment[] = [];
    // Telegram returns newest → oldest; display as Telegram does: oldest at the top, newest at the bottom
    for (const message of [...(replies?.messages || [])].reverse()) {
      if (!message || message.className === 'MessageEmpty') continue;
      if (message.className === 'MessageService' && !describeTelegramServiceAction(message)) continue;
      const msgId = String(message.id);
      const normalized = normalizeTelegramMessageMedia(message, groupPeerType);
      const sender = discussionSenderOf(message, groupChatId);
      const replyTo = message.replyTo as any;
      const repliedId = replyTo?.replyToMsgId != null ? String(replyTo.replyToMsgId) : '';
      const replyToComment = repliedId && repliedId !== rootId ? repliedId : null;
      const timestamp = Number(message.date || 0) * 1000;
      const reactions = normalizeTelegramReactions((message as any).reactions, accountId);
      persistTelegramMessage(db, {
        msgId, accountId, chatId: groupChatId, threadType: 1,
        senderId: sender.id, content: normalized.content, msgType: normalized.msgType,
        timestamp, isSelf: !!message.out, attachments: normalized.attachments,
        replyToId: replyToComment || undefined, topicId: rootId, reactions,
      });
      handleRichMessageExtras(accountId, conn.client, groupChatId, message);
      const stored = db.queryOne<any>(
        `SELECT local_paths, reactions, is_edited FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [msgId, accountId, groupChatId],
      );
      const profile = discussionSenderProfile(db, accountId, groupChatId, sender, entities);
      comments.push({
        msg_id: msgId,
        owner_zalo_id: accountId,
        thread_id: groupChatId,
        thread_type: 1,
        channel: 'telegram_user',
        topic_id: rootId,
        sender_id: sender.id,
        sender_name: profile.name,
        sender_kind: sender.kind,
        sender_avatar: profile.avatar,
        content: normalized.content,
        msg_type: normalized.msgType,
        timestamp,
        is_sent: message.out ? 1 : 0,
        attachments: JSON.stringify(normalized.attachments),
        reactions: stored?.reactions || JSON.stringify(reactions),
        local_paths: stored?.local_paths || '{}',
        reply_to_id: replyToComment,
        is_edited: message.editDate && !message.editHide ? 1 : 0,
      });
    }
    // Missing member avatars: load in the background like the Members panel (event:groupMemberAvatar)
    const missingAvatars = (replies?.users || []).filter((user: any) => {
      const row = db.queryOne<any>(
        `SELECT avatar FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
        [accountId, groupChatId, String(user?.id ?? '')],
      );
      return !row?.avatar;
    });
    if (missingAvatars.length) scheduleGroupMemberAvatarHydration(accountId, groupChatId, conn.client, missingAvatars, new Map(), new Map());

    const total = Math.max(0, Number(replies?.count ?? comments.length) || 0);
    const groupProfile = discussionSenderProfile(db, accountId, groupChatId, { id: groupChatId, kind: 'chat' }, entities);
    const flags = discussionPageFlags(
      (replies?.messages || []).map((message: any) => Number(message?.id)).filter((id: number) => Number.isSafeInteger(id) && id > 0),
      page.offsetId, page.addOffset, limit,
    );
    // Opened from the first comment: only the root post remains above
    const hasOlder = page.anchor === 'top' ? false : flags.hasOlder;
    tgLog('info', accountId, 'topic_api', 'POST_DISCUSSION', {
      chatId: channelId, postId, groupChatId, rootId, mode, anchor: page.anchor, count: comments.length, total,
      readInboxMaxId, maxId: threadMaxId, canWrite: access.canWrite,
    });
    return {
      success: true,
      discussion: {
        chatId: groupChatId,
        rootId,
        title: groupProfile.name,
        avatar: groupProfile.avatar,
        isMember: access.isMember,
        canWrite: access.canWrite,
        joinMode: access.joinMode,
        reason: access.reason,
        total,
        unreadCount: Math.max(0, Number(discussion?.unreadCount || 0)),
        readInboxMaxId,
        maxId: threadMaxId,
      },
      comments,
      hasOlder,
      hasNewer: flags.hasNewer,
      anchor: page.anchor,
    };
  } catch (err: any) {
    const message = String(err?.errorMessage || err?.message || err);
    tgLog('warn', accountId, 'topic_api', 'POST_DISCUSSION_FAILED', { chatId: channelId, postId, error: message });
    if (message.includes('MSG_ID_INVALID')) return { success: false, error: tr('Bài đăng này không có phần bình luận') };
    return { success: false, error: friendlyTelegramActionError(message) };
  }
}

/**
 * Read comments up to `readMaxId` (messages.readDiscussion in the discussion group, like Telegram when the comments appear): the next
 * open starts at the next unread comment, and the Telegram app on the phone also stops showing new comments. With `channelId` /
 * `postId` → saves the mark on the channel post (turns off the "chưa đọc" (unread) dot on the comment bar) and returns new attachments for the UI.
 */
export async function readPostDiscussion(
  accountId: string,
  groupChatId: string,
  rootId: string,
  readMaxId: number,
  post?: { channelId?: string; postId?: string },
): Promise<{ success: boolean; attachments?: string; error?: string }> {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return { success: false, error: conn.error };
  const root = Number(rootId);
  const read = Math.floor(Number(readMaxId) || 0);
  if (!Number.isSafeInteger(root) || root <= 0 || !Number.isSafeInteger(read) || read <= root) {
    return { success: false, error: tr('Mốc đã đọc không hợp lệ') };
  }
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, conn.client, groupChatId);
    await conn.client.invoke(new Api.messages.ReadDiscussion({ peer, msgId: root, readMaxId: read }));
    const db = DatabaseService.getInstance();
    if (!db || !post?.channelId || !post?.postId) return { success: true };
    const row = db.queryOne<any>(
      `SELECT attachments FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [String(post.postId), accountId, String(post.channelId)],
    );
    const attachments = row ? withCommentsRead(row.attachments, read) : null;
    if (!attachments) return { success: true };
    db.run(
      `UPDATE messages SET attachments = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
      [attachments, String(post.postId), accountId, String(post.channelId)],
    );
    return { success: true, attachments };
  } catch (err: any) {
    return { success: false, error: friendlyTelegramActionError(String(err?.errorMessage || err?.message || err)) };
  }
}

/**
 * Poll results as in the Telegram app: the polls shown in the conversation ask messages.getPollResults again (when opened and
 * every 30 s, renderer: useTelegramPollResults). Telegram does not push results to everyone who views a poll, so previously the numbers were only
 * captured when the message arrived ("0 lượt bình chọn" (0 votes) forever). After a request, Telegram's UpdateMessagePoll pushes can also be applied (it remembers the poll id).
 */
export async function refreshPollResults(
  accountId: string,
  chatId: string,
  messageIds: string[],
): Promise<{ success: boolean; error?: string; updates?: Array<{ msgId: string; attachments: string }> }> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram listener is not connected' };
  const ids = Array.from(new Set((messageIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 20);
  if (!ids.length) return { success: true, updates: [] };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const updates: Array<{ msgId: string; attachments: string }> = [];
    for (const id of ids) {
      let result: any;
      try {
        result = await listener.client.invoke(new Api.messages.GetPollResults({ peer, msgId: id, pollHash: BigInt(0) }));
      } catch (err: any) {
        // Rate limited: stop this pass; a deleted message / no longer a poll: skip that message
        if (/FLOOD/i.test(String(err?.errorMessage || err?.message || ''))) break;
        continue;
      }
      for (const update of result?.updates || []) {
        if (update?.className !== 'UpdateMessagePoll') continue;
        rememberTelegramPoll(accountId, update.pollId != null ? String(update.pollId) : '', chatId, String(id));
        const merged = applyTelegramPollUpdate(accountId, chatId, String(id), { poll: update.poll, results: update.results });
        if (merged) updates.push({ msgId: String(id), attachments: merged });
      }
    }
    return { success: true, updates };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Channel post stats as in Telegram (views, shares, comments, recent commenters): messages.getMessagesViews
 * for the posts shown. Previously only fetched when the post arrived, so it drifted far from Telegram. `increment` = count one view (like the Telegram app
 * when the post appears on screen).
 */
export async function refreshPostStats(
  accountId: string,
  chatId: string,
  messageIds: string[],
  increment = false,
): Promise<{
  success: boolean;
  error?: string;
  updates?: Array<{ msgId: string; attachments: string }>;
  peers?: Record<string, { name: string; avatar: string }>;
}> {
  const listener = activeListeners.get(accountId);
  if (!listener?.client || !listener.connected) return { success: false, error: 'Telegram listener is not connected' };
  const db = DatabaseService.getInstance();
  if (!db) return { success: false, error: 'Database not ready' };
  const ids = Array.from(new Set((messageIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 100);
  if (!ids.length) return { success: true, updates: [], peers: {} };
  try {
    const { Api } = require('telegram');
    const peer = await resolveInputPeer(accountId, listener.client, chatId);
    const result: any = await listener.client.invoke(new Api.messages.GetMessagesViews({ peer, id: ids, increment: !!increment }));
    const entities = new Map<string, any>();
    for (const entity of [...(result?.users || []), ...(result?.chats || [])]) {
      const id = getCanonicalChatId(entity);
      if (id) entities.set(id, entity);
    }
    const updates: Array<{ msgId: string; attachments: string }> = [];
    const peers: Record<string, { name: string; avatar: string }> = {};
    (result?.views || []).forEach((stats: any, index: number) => {
      const msgId = String(ids[index]);
      const row = db.queryOne<any>(
        `SELECT attachments FROM messages WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [msgId, accountId, chatId],
      );
      if (!row) return;
      const merged = mergeTelegramPostStats(row.attachments, stats || {}, getCanonicalChatId);
      for (const replier of stats?.replies?.recentRepliers || []) {
        const id = getCanonicalChatId(replier);
        if (!id || peers[id]) continue;
        const entity = entities.get(id);
        const known = db.getTelegramPeer(accountId, id) as any;
        const contact = db.queryOne<any>(
          `SELECT display_name, avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'`,
          [accountId, id],
        );
        const member = db.queryOne<any>(
          `SELECT display_name, avatar FROM page_group_member WHERE owner_zalo_id = ? AND member_id = ? AND avatar != '' LIMIT 1`,
          [accountId, id],
        );
        peers[id] = {
          name: telegramEntityName(entity) || contact?.display_name || member?.display_name || known?.display_name || id,
          avatar: contact?.avatar_url || member?.avatar || known?.avatar_url || '',
        };
      }
      if (!merged) return;
      db.run(
        `UPDATE messages SET attachments = ? WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'telegram_user'`,
        [merged, msgId, accountId, chatId],
      );
      updates.push({ msgId, attachments: merged });
    });
    return { success: true, updates, peers };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

// ─── Telegram Sticker/GIF APIs ──────────────────────────────────────────────
// Logic in ./telegramStickers: data synced with the account (installed sets, recent, favourites, saved GIFs) + cache
// Documents to send / download (fileReference expired → fetch again from the source). Here only the running session and the path that saves the just-sent message are linked
// sent (handleNewMessage 'history' like sendAlbum: GramJS does not feed RPC results into the update stream).

function telegramStickerDeps(accountId: string): StickerClientDeps | { error: string } {
  const conn = ensureConnected(accountId);
  if ('error' in conn) return conn;
  const { Api } = require('telegram');
  const client = conn.client;
  return {
    client,
    Api,
    resolvePeer: (chatId: string) => resolveInputPeer(accountId, client, chatId),
    persistSent: async (message: any) => {
      try {
        await handleNewMessage(accountId, { message } as any, client, 'history');
      } catch (persistErr: any) {
        tgLog('warn', accountId, 'history', 'STICKER_PERSIST_FAILED', {
          messageId: String(message?.id || ''),
          error: persistErr?.message || String(persistErr),
        });
      }
    },
    baseDir: FileStorageService.getBaseDir(),
  };
}

const TELEGRAM_STICKER_SEND_ERRORS: Array<[RegExp, string]> = [
  [/CHAT_SEND_STICKERS_FORBIDDEN/i, tr('Hội thoại này không cho gửi sticker')],
  [/CHAT_SEND_GIFS_FORBIDDEN/i, tr('Hội thoại này không cho gửi GIF')],
  [/CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL/i, tr('Bạn không có quyền gửi tin trong hội thoại này')],
  [/STICKER_NOT_CACHED/, 'Không tìm thấy sticker trên tài khoản — mở lại bảng sticker rồi thử lại'],
];

function telegramStickerSendError(error: string): string {
  for (const [pattern, text] of TELEGRAM_STICKER_SEND_ERRORS) if (pattern.test(error)) return text;
  return error;
}

/** Sticker panel: installed sets (the account's order) + recent stickers + favourites. */
export async function getStickerPanel(accountId: string) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  return TelegramStickers.getStickerPanel(accountId, deps);
}

/** Contents of 1 sticker set + whether it is installed in the account. */
export async function getStickerSet(accountId: string, ref: TelegramStickerSetRef) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  return TelegramStickers.getStickerSet(accountId, ref, deps);
}

/** Sticker set of 1 sticker message in the chat (click a sticker → set popup). */
export async function getStickerSetOfMessage(accountId: string, chatId: string, messageId: string) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  return TelegramStickers.getStickerSetOfMessage(accountId, chatId, messageId, deps);
}

/** Add / remove a sticker set from the account (other Telegram apps see it too). */
export async function setStickerSetInstalled(accountId: string, ref: TelegramStickerSetRef, installed: boolean) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  return TelegramStickers.setStickerSetInstalled(accountId, ref, installed, deps);
}

/** File drawn for stickers / GIFs in the panel: 'thumb' small static image, 'full' whole file (played on hover). */
export async function getStickerFile(accountId: string, docId: string, variant: 'thumb' | 'full' = 'thumb') {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) {
    // Not connected: a file downloaded earlier can still be drawn (forum topic icon saved in advance, recent stickers…)
    const onDisk = TelegramStickers.stickerFileOnDisk(FileStorageService.getBaseDir(), accountId, String(docId || ''), variant);
    return onDisk ? { success: true as const, ...onDisk } : { success: false as const, error: deps.error };
  }
  return TelegramStickers.getStickerFile(accountId, String(docId || ''), variant, deps);
}

/** Save / unsave a GIF to the account. */
export async function setGifSaved(accountId: string, docId: string, saved: boolean) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  return TelegramStickers.setGifSaved(accountId, String(docId || ''), saved, deps);
}

/** Search sticker sets (the sticker panel's search box); empty keyword → trending sets. */
export async function searchStickerSets(accountId: string, query: string) {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false as const, error: deps.error };
  const q = String(query || '').trim();
  return q ? TelegramStickers.searchStickerSets(accountId, q, deps) : TelegramStickers.getFeaturedStickerSets(accountId, deps);
}

/** Installed sticker sets (old name, kept for old callers). */
export async function getStickerSets(accountId: string): Promise<{ success: boolean; sets?: any[]; error?: string }> {
  const result = await getStickerPanel(accountId);
  return result.success ? { success: true, sets: result.sets } : result;
}

/** Stickers of 1 set (old name). */
export async function getStickerSetStickers(accountId: string, setId: string, accessHash?: string, shortName?: string): Promise<{ success: boolean; stickers?: any[]; set?: any; error?: string }> {
  const ref: TelegramStickerSetRef = {
    ...(setId && accessHash && accessHash !== '0' ? { id: String(setId), accessHash: String(accessHash) } : {}),
    ...(shortName ? { shortName } : {}),
  };
  if (!ref.id && !ref.shortName) return { success: false, error: tr('Thiếu thông tin bộ sticker') };
  const result = await getStickerSet(accountId, ref);
  return result.success ? { success: true, stickers: result.stickers, set: result.set } : result;
}

/** Recent stickers (old name). */
export async function getRecentStickers(accountId: string): Promise<{ success: boolean; stickers?: any[]; error?: string }> {
  const result = await getStickerPanel(accountId);
  return result.success ? { success: true, stickers: result.recent } : result;
}

/** The account's saved GIFs. The Telegram API has no separate "GIF thịnh hành" (trending GIFs) list: search (even with an empty keyword) through @gif. */
export async function getGifs(accountId: string): Promise<{ success: boolean; gifs?: any[]; error?: string }> {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false, error: deps.error };
  return TelegramStickers.getSavedGifs(accountId, deps);
}

/** Search GIFs through the @gif inline bot like the Telegram app (empty keyword = trending GIFs); `nextOffset` to load more. */
export async function searchGifs(accountId: string, query: string, offset = ''): Promise<{ success: boolean; gifs?: any[]; nextOffset?: string; error?: string }> {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false, error: deps.error };
  return TelegramStickers.searchGifs(accountId, String(query || ''), String(offset || ''), deps);
}

/**
 * Send a sticker / GIF by document id (sticker panel, set popup, workflow `tg.sendSticker`, API). The Document comes from the cache:
 * when the caller only has an id, look in recent / favourites / saved GIFs / installed sets. The sent message is saved and shown like a message
 * I sent from another device; the sticker goes to "gần đây" (recent), the GIF goes to "GIF đã lưu" (saved GIFs) of the account.
 */
export async function sendSticker(
  accountId: string,
  chatId: string,
  stickerId: string,
  _accessHash?: string,
  options: { replyToMsgId?: string; topicRootId?: string } = {},
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const deps = telegramStickerDeps(accountId);
  if ('error' in deps) return { success: false, error: deps.error };
  const denial = getPersistedTelegramSendDenial(accountId, chatId);
  if (denial) return { success: false, error: denial };
  const rateLimit = checkRateLimit(accountId);
  if (!rateLimit.allowed) return { success: false, error: `Rate limited. Wait ${rateLimit.waitSeconds}s.` };
  const docId = String(stickerId || '');
  if (!(await TelegramStickers.ensureStickerCached(accountId, docId, deps))) {
    return { success: false, error: telegramStickerSendError('STICKER_NOT_CACHED') };
  }
  const result = await TelegramStickers.sendStickerDocument(accountId, chatId, docId, options, deps);
  // 'in' (not !result.success): tsconfig is not strict → the union is not narrowed by success
  if ('error' in result) {
    Logger.warn(`[TG:sendSticker] FAILED chat=${chatId} doc=${docId}: ${result.error}`);
    return { success: false, error: telegramStickerSendError(result.error) };
  }
  return { success: true, messageId: result.messageId };
}

/** Send a GIF by document id (saved GIF / result of an @gif search). */
export async function sendGif(
  accountId: string,
  chatId: string,
  documentId: string,
  options: { replyToMsgId?: string; topicRootId?: string } = {},
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  return sendSticker(accountId, chatId, documentId, undefined, options);
}

/** Sticker image for the picker (old name), like getStickerFile(…, 'thumb'). */
export async function downloadSticker(accountId: string, stickerId: string, _accessHash?: string): Promise<{ success: boolean; localPath?: string; error?: string }> {
  const result = await getStickerFile(accountId, stickerId, 'thumb');
  return result.success ? { success: true, localPath: result.localPath } : result;
}

// ─── Test seams ──────────────────────────────────────────────────────────────
// Recovery/discovery/lifecycle helpers below are module-private because the
// listener is the only production caller. Regression tests for the sleep/wake
// audit (docs/sleep-wake-network-reconnect-audit-plan.md) need to exercise the
// real implementations with fake clients, so expose a narrow namespace here
// instead of duplicating the logic in test fixtures.
// Replace these with proper module APIs as the recovery coordinator lands.
export const __test = {
  // Pinned messages: one page of the newest pins, updates applied locally
  applyTelegramPinnedUpdate,
  // Conversation row last message: dialog top message, newest stored message, repair after connect
  telegramDialogTopMessage,
  telegramBotHasMainApp,
  refreshTelegramContactLastMessage,
  repairTelegramContactLastMessages,
  getMessages,
  // Quick actions (create group / join by link / add contact)
  createGroup,
  createChannel,
  checkChatUsername,
  setChatUsername,
  getChatSettings,
  revokeInviteLink,
  setDiscussionGroup,
  inviteUsers,
  getContacts,
  getCallHistory,
  declineCall,
  handleTelegramPhoneCallUpdate,
  persistTelegramCallServiceMessage,
  ringingTelegramCalls,
  previewJoinLink,
  joinByLink,
  addContact,
  firstChatOfUpdates,
  // Media download (link previews download their photo only)
  normalizeTelegramMessageMedia,
  getTelegramDownloadTarget,
  isImageBuffer,
  downloadMediaForMessage,
  // Link preview of sent messages (ready in the send answer, or asked for again while pending)
  sentLinkPreview,
  pendingLinkPreviews,
  // Reactions / edits (private chats deliver reaction changes as hidden edits)
  normalizeTelegramReactions,
  applyTelegramMessageReactions,
  applyTelegramReactionResult,
  applyTelegramMessageEdit,
  // Poll: results pushed by Telegram (UpdateMessagePoll)
  handleTelegramPollUpdate,
  readTelegramUnreadThings,
  drainChannelDifference,
  drainChannelDifferenceNow,
  synchronizeTelegramAccount,
  syncSavedMessages,
  backfillSavedMessagesHistory,
  savedMessagesHistoryJobs,
  fetchMissedMessages,
  recoverChannelUpdates,
  reconcileTelegramDialogMembership,
  startHealthCheck,
  clearHealthCheck,
  scheduleReconnectCatchUp,
  runChannelRecoveryWorkers,
  channelDifferenceQueues,
  recoveringUpdateAccounts,
  syncingAccounts,
  membershipReconciledAccounts,
  membershipReconciliations,
  reconnectCatchUps,
  pendingCatchUpModes,
  activeListeners,
  // Reconnect lifecycle (sleep/wake, network loss)
  handlePrimaryTransportConnected,
  handlePrimaryTransportDisconnected,
  markPrimaryConnectionRestored,
  scheduleReconnect,
  probeTelegramListenerNow,
  retireTelegramClient,
  retiredClients,
  installRpcDeadline,
  installSingleMainSession,
  isAccountLockHeld,
  waitForTelegramAccountSync,
  refreshRecentChannelDialogWatch,
  channelDialogWatchTasks,
  channelDialogWatchStates,
  persistTelegramDialogState,
  queueTelegramDownload,
  telegramDownloads,
  // Archived realtime: scheduling, opened-channel polling, typing, repair
  schedulePendingChannelRecovery,
  channelRecoveryDrainTimers,
  touchActiveChannel,
  noteActiveChannelPolled,
  getNextActiveChannelPollAt,
  activeChannelLeases,
  activeChannelNextPollAt,
  channelDifferenceTimeouts,
  scheduleTypingChannelRecovery,
  typingChannelRecoveryTimers,
  channelHistoryRepairs,
  channelHistoryRepairQueues,
  // Repair old data: a comment saved by mistake into the channel, a message "chưa hỗ trợ" (unsupported)
  runTelegramDataRepair,
  repairTelegramRowsFromServer,
  rehomeMisplacedComments,
  // Group member avatars: drop the users GramJS cannot download, remember the failure
  scheduleGroupMemberAvatarHydration,
  memberAvatarHydrationJobs,
  memberAvatarFailedAt,
};
