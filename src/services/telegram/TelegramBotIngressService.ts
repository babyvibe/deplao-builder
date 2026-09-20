/**
 * TelegramBotIngressService.ts — Unified Bot API update ingress
 *
 * Owns exactly ONE getUpdates loop per bot token (TG-015 fix).
 * Persists offset to DB for durable idempotency.
 * Parses ALL Bot API update types and fans out to registered consumers.
 * Does NOT advance the durable cursor after a consumer error (TG-016 fix).
 */

import axios from 'axios';
import * as crypto from 'crypto';
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_INTERVAL_MS = 2000;
const LONG_POLL_TIMEOUT = 25;      // seconds
const REQUEST_TIMEOUT_MS = 35000;  // slightly longer than long-poll

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BotAccount {
  accountId: string;      // bot's Telegram user ID
  botToken: string;
  botUsername: string;
  botFirstName: string;
}

export type UpdateKind =
  | 'message'
  | 'edited_message'
  | 'channel_post'
  | 'edited_channel_post'
  | 'callback_query'
  | 'my_chat_member'
  | 'chat_member'
  | 'message_reaction'
  | 'message_reaction_count'
  | 'poll'
  | 'poll_answer'
  | 'chat_join_request'
  | 'unknown';

export interface NormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  fromId: string;
  fromName: string;
  text: string;
  date: number;
  isCommand: boolean;
  command: string;
  commandArgs: string;
  raw: any; // original Telegram message object
}

export interface NormalizedUpdate {
  updateId: number;
  kind: UpdateKind;
  message?: NormalizedMessage;
  editedMessage?: NormalizedMessage;
  callbackQuery?: any;
  chatMember?: any;
  messageReaction?: any;
  messageReactionCount?: any;
  poll?: any;
  pollAnswer?: any;
  chatJoinRequest?: any;
  raw: any; // original Telegram update object
}

/** Consumer callback: receives normalized updates from the ingress. */
export type BotUpdateConsumer = (account: BotAccount, update: NormalizedUpdate) => void | Promise<void>;

interface ActivePoller {
  tokenHash: string;
  accountIds: Set<string>;     // all accountIds registered for this token
  primaryAccount: BotAccount;  // the first account that started this poller
  offset: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  consumers: Map<string, BotUpdateConsumer[]>; // accountId → consumers
  /** Tracks which consumers have successfully processed which update_id (TG-016 idempotent retry) */
  _completedConsumers?: Map<string, boolean>;
}

// ─── Internal state ─────────────────────────────────────────────────────────

/** tokenHash → poller (one loop per token) */
const activePollers = new Map<string, ActivePoller>();

/** accountId → tokenHash (reverse lookup) */
const accountIdToTokenHash = new Map<string, string>();

/** Accounts whose token is currently polled by another process. Kept outside
 * the active poller map so the health check cannot immediately restart them. */
const pollingConflicts = new Map<string, string>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

// ─── Message normalizer ─────────────────────────────────────────────────────

function normalizeMessage(raw: any): NormalizedMessage | undefined {
  if (!raw) return undefined;
  const chatId = String(raw.chat?.id || '');
  const fromId = String(raw.from?.id || '');
  const fromName = [raw.from?.first_name, raw.from?.last_name].filter(Boolean).join(' ') || fromId;
  const chatType: NormalizedMessage['chatType'] = raw.chat?.type || 'private';
  const text: string = raw.text || raw.caption || '';
  const date = (raw.date || 0) * 1000;
  const messageId = String(raw.message_id || '');

  let isCommand = false;
  let command = '';
  let commandArgs = '';
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    command = parts[0].toLowerCase();
    const atIndex = command.indexOf('@');
    if (atIndex > 0) command = command.substring(0, atIndex);
    commandArgs = parts.slice(1).join(' ');
    isCommand = true;
  }

  return { messageId, chatId, chatType, fromId, fromName, text, date, isCommand, command, commandArgs, raw };
}

// ─── Update normalizer ──────────────────────────────────────────────────────

function normalizeUpdate(raw: any): NormalizedUpdate {
  const updateId: number = raw.update_id || 0;
  let kind: UpdateKind = 'unknown';

  if (raw.message)                     kind = 'message';
  else if (raw.edited_message)         kind = 'edited_message';
  else if (raw.channel_post)          kind = 'channel_post';
  else if (raw.edited_channel_post)   kind = 'edited_channel_post';
  else if (raw.callback_query)        kind = 'callback_query';
  else if (raw.my_chat_member)        kind = 'my_chat_member';
  else if (raw.chat_member)           kind = 'chat_member';
  else if (raw.message_reaction)         kind = 'message_reaction';
  else if (raw.message_reaction_count)   kind = 'message_reaction_count';
  else if (raw.poll)                  kind = 'poll';
  else if (raw.poll_answer)           kind = 'poll_answer';
  else if (raw.chat_join_request)     kind = 'chat_join_request';

  const result: NormalizedUpdate = { updateId, kind, raw };

  switch (kind) {
    case 'message':
      result.message = normalizeMessage(raw.message);
      break;
    case 'edited_message':
      result.editedMessage = normalizeMessage(raw.edited_message);
      break;
    case 'channel_post':
      result.message = normalizeMessage(raw.channel_post);
      break;
    case 'edited_channel_post':
      result.editedMessage = normalizeMessage(raw.edited_channel_post);
      break;
    case 'callback_query':
      result.callbackQuery = raw.callback_query;
      break;
    case 'my_chat_member':
    case 'chat_member':
      result.chatMember = raw.my_chat_member || raw.chat_member;
      break;
    case 'message_reaction':
      result.messageReaction = raw.message_reaction;
      break;
    case 'message_reaction_count':
      result.messageReactionCount = raw.message_reaction_count;
      break;
    case 'poll':
      result.poll = raw.poll;
      break;
    case 'poll_answer':
      result.pollAnswer = raw.poll_answer;
      break;
    case 'chat_join_request':
      result.chatJoinRequest = raw.chat_join_request;
      break;
  }

  return result;
}

// ─── Polling loop ───────────────────────────────────────────────────────────

async function pollLoop(poller: ActivePoller): Promise<void> {
  if (!poller.running) return;

  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${poller.primaryAccount.botToken}/getUpdates`, {
      params: {
        offset: poller.offset,
        limit: 100,
        timeout: LONG_POLL_TIMEOUT,
        allowed_updates: JSON.stringify([
          'message', 'edited_message', 'channel_post', 'edited_channel_post',
          'callback_query', 'my_chat_member', 'chat_member',
          'message_reaction', 'message_reaction_count',
          'poll', 'poll_answer', 'chat_join_request',
        ]),
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    const updates: any[] = res.data?.result || [];

    if (updates.length > 0) {
      Logger.log(`[BotIngress] Received ${updates.length} updates for ${poller.primaryAccount.accountId} (offset=${poller.offset})`);

      let anyConsumerFailed = false;

      // Track completed consumers per update_id for idempotent retry.
      // Key: `${updateId}:${accountId}:${consumerIndex}` → true
      // This ensures that when a batch is retried after partial failure,
      // consumers that already succeeded are not re-invoked.
      if (!poller._completedConsumers) poller._completedConsumers = new Map();

      // Fan out each update to all registered consumers
      for (const rawUpdate of updates) {
        const normalized = normalizeUpdate(rawUpdate);

        for (const [accountId, consumers] of poller.consumers) {
          // Find the account object for this accountId
          const account = accountId === poller.primaryAccount.accountId
            ? poller.primaryAccount
            : { ...poller.primaryAccount, accountId };

          for (let ci = 0; ci < consumers.length; ci++) {
            const completionKey = `${normalized.updateId}:${accountId}:${ci}`;

            // Skip if this consumer already succeeded for this update
            if (poller._completedConsumers.get(completionKey)) continue;

            try {
              await consumers[ci](account, normalized);
              // Mark as completed — will not re-run on retry
              poller._completedConsumers.set(completionKey, true);
            } catch (err: any) {
              Logger.warn(`[BotIngress] Consumer error for ${accountId} update ${normalized.updateId}: ${err.message}`);
              anyConsumerFailed = true;
            }
          }
        }
      }

      // Only advance offset when ALL consumers succeeded (TG-016)
      if (!anyConsumerFailed) {
        const newOffset = updates[updates.length - 1].update_id + 1;
        poller.offset = newOffset;

        // Clear completed tracking — batch fully done
        poller._completedConsumers.clear();

        // Persist to DB
        try {
          const db = DatabaseService.getInstance();
          if (db) db.setBotCursor(poller.tokenHash, newOffset);
        } catch (err: any) {
          Logger.warn(`[BotIngress] Failed to persist offset for ${poller.tokenHash}: ${err.message}`);
        }
      } else {
        Logger.warn(`[BotIngress] Not advancing offset for ${poller.tokenHash} due to consumer failure; will retry failed consumers only`);
      }
    }
  } catch (err: any) {
    if (err.response?.status === 409) {
      Logger.warn(`[BotIngress] 409 Conflict for token ${poller.tokenHash} — another consumer is polling this token. Stopping.`);
      for (const accountId of poller.accountIds) {
        pollingConflicts.set(accountId, poller.tokenHash);
        try {
          const { EventBroadcaster } = require('../event/EventBroadcaster');
          EventBroadcaster.emit('event:disconnected', {
            zaloId: accountId,
            reason: 'bot_poll_conflict',
          });
        } catch {}
      }
      stopPollerByTokenHash(poller.tokenHash);
      return;
    }
    Logger.warn(`[BotIngress] Poll error ${poller.tokenHash}: ${err.message}`);

    // If it's a persistent error (401 Unauthorized, 404 Not Found), stop polling
    // and emit disconnect event for all registered accounts
    if (err.response?.status === 401 || err.response?.status === 404) {
      Logger.warn(`[BotIngress] Fatal error ${err.response.status} for token ${poller.tokenHash} — stopping poller`);
      for (const accountId of poller.accountIds) {
        try {
          const { EventBroadcaster } = require('../event/EventBroadcaster');
          EventBroadcaster.emit('event:disconnected', {
            zaloId: accountId,
            reason: err.response?.status === 401 ? 'token_invalid' : 'bot_not_found',
          });
        } catch {}
      }
      stopPollerByTokenHash(poller.tokenHash);
      return;
    }
  }

  if (poller.running) {
    poller.timer = setTimeout(() => pollLoop(poller), POLL_INTERVAL_MS);
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function stopPollerByTokenHash(tokenHash: string): void {
  const poller = activePollers.get(tokenHash);
  if (!poller) return;
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);

  // Clean up reverse lookup for all accountIds
  for (const id of poller.accountIds) {
    accountIdToTokenHash.delete(id);
  }
  activePollers.delete(tokenHash);
  Logger.log(`[BotIngress] Stopped poller for token ${tokenHash}`);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start ingress polling for a bot account.
 * If a poller for the same token already exists, just registers the accountId
 * without starting a second getUpdates loop (TG-015 fix).
 */
export function startBot(account: BotAccount): boolean {
  const tokenHash = hashToken(account.botToken);
  if (pollingConflicts.get(account.accountId) === tokenHash) {
    Logger.warn(`[BotIngress] Polling remains paused for ${account.accountId}: Telegram reported another getUpdates consumer. Stop the other consumer or restart after it is removed.`);
    return false;
  }
  const existingPoller = activePollers.get(tokenHash);

  if (existingPoller) {
    // Token already polled — just register this accountId
    existingPoller.accountIds.add(account.accountId);
    accountIdToTokenHash.set(account.accountId, tokenHash);
    if (!existingPoller.consumers.has(account.accountId)) {
      existingPoller.consumers.set(account.accountId, []);
    }
    Logger.log(`[BotIngress] Reusing existing poller for ${account.accountId} (@${account.botUsername}) on token ${tokenHash}`);
    return true;
  }

  // New token — start a new poller
  const db = DatabaseService.getInstance();
  const savedOffset = db ? db.getBotCursor(tokenHash) : 0;

  const poller: ActivePoller = {
    tokenHash,
    accountIds: new Set([account.accountId]),
    primaryAccount: account,
    offset: savedOffset,
    running: true,
    timer: null,
    consumers: new Map([[account.accountId, []]]),
  };
  activePollers.set(tokenHash, poller);
  accountIdToTokenHash.set(account.accountId, tokenHash);

  Logger.log(`[BotIngress] Started poller for ${account.accountId} (@${account.botUsername}) offset=${savedOffset}`);
  pollLoop(poller);
  return true;
}

/**
 * Stop ingress polling for a bot account.
 * Only stops the poller when ALL accountIds for this token are removed.
 */
export function stopBot(accountId: string): void {
  pollingConflicts.delete(accountId);
  const tokenHash = accountIdToTokenHash.get(accountId);
  if (!tokenHash) return;

  const poller = activePollers.get(tokenHash);
  if (!poller) return;

  poller.accountIds.delete(accountId);
  poller.consumers.delete(accountId);
  accountIdToTokenHash.delete(accountId);

  if (poller.accountIds.size === 0) {
    // No more consumers — stop the poller
    poller.running = false;
    if (poller.timer) clearTimeout(poller.timer);
    activePollers.delete(tokenHash);
    Logger.log(`[BotIngress] Stopped poller for token ${tokenHash} (no remaining accounts)`);
  } else {
    Logger.log(`[BotIngress] Removed ${accountId} from poller ${tokenHash}; ${poller.accountIds.size} accounts remain`);
  }
}

/**
 * Register a consumer that receives all updates for a bot account.
 * Multiple consumers can be registered (inbox handler + workflow trigger).
 */
export function registerConsumer(accountId: string, consumer: BotUpdateConsumer): void {
  const tokenHash = accountIdToTokenHash.get(accountId);
  if (!tokenHash) {
    Logger.warn(`[BotIngress] Cannot register consumer — no active poller for ${accountId}`);
    return;
  }
  const poller = activePollers.get(tokenHash);
  if (!poller) return;

  const consumers = poller.consumers.get(accountId) || [];
  if (!consumers.includes(consumer)) {
    consumers.push(consumer);
    poller.consumers.set(accountId, consumers);
  }
}

/**
 * Unregister a consumer from a bot account.
 */
export function unregisterConsumer(accountId: string, consumer: BotUpdateConsumer): void {
  const tokenHash = accountIdToTokenHash.get(accountId);
  if (!tokenHash) return;
  const poller = activePollers.get(tokenHash);
  if (!poller) return;

  const consumers = poller.consumers.get(accountId) || [];
  poller.consumers.set(accountId, consumers.filter(c => c !== consumer));
}

/**
 * Check if a bot token is currently being polled.
 * Accepts either an accountId or looks up the token hash directly.
 */
export function isPolling(accountId: string): boolean {
  const tokenHash = accountIdToTokenHash.get(accountId);
  return tokenHash ? activePollers.has(tokenHash) : false;
}

/**
 * Get status of all active pollers.
 */
export function getActivePollers(): Array<{ accountId: string; botUsername: string; offset: number; consumerCount: number; accountIds: string[] }> {
  return Array.from(activePollers.values()).map(p => ({
    accountId: p.primaryAccount.accountId,
    botUsername: p.primaryAccount.botUsername,
    offset: p.offset,
    consumerCount: Array.from(p.consumers.values()).reduce((sum, c) => sum + c.length, 0),
    accountIds: Array.from(p.accountIds),
  }));
}

/**
 * Check if a poller is running for the given accountId.
 */
export function isPollerRunning(accountId: string): boolean {
  const tokenHash = accountIdToTokenHash.get(accountId);
  if (!tokenHash) return false;
  const poller = activePollers.get(tokenHash);
  return !!poller?.running;
}

/** True when Telegram rejected this process because another getUpdates loop owns the token. */
export function hasPollingConflict(accountId: string): boolean {
  return pollingConflicts.has(accountId);
}

/**
 * Stop all pollers. Called on app shutdown.
 */
export function stopAll(): void {
  for (const tokenHash of Array.from(activePollers.keys())) {
    stopPollerByTokenHash(tokenHash);
  }
}

/**
 * Validate bot token via getMe.
 */
export async function validateBotToken(botToken: string): Promise<{ success: boolean; bot?: any; error?: string }> {
  try {
    const res = await axios.get(`${TELEGRAM_API}/bot${botToken}/getMe`, { timeout: 10000 });
    if (res.data?.ok) {
      return { success: true, bot: res.data.result };
    }
    return { success: false, error: 'Token không hợp lệ' };
  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}
