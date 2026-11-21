import EventBroadcaster from '../event/EventBroadcaster';
import DatabaseService from '../database/DatabaseService';
import ConnectionManager from '../../utils/connection/ConnectionManager';
import AccountSendQueue from './AccountSendQueue';
import { recipientGapRangeMs } from './recipientPacing';
import { FacebookService } from '../facebook/FacebookService';
import { FacebookSendService } from '../facebook/send/FacebookSendService';
import { resolveThreadKind } from '../facebook/FacebookThreadKind';
import Logger from '../../utils/Logger';
import IntegrationRegistry from '../integrations/IntegrationRegistry';
import * as TelegramUser from '../telegram/TelegramUserListener';
import * as TelegramBot from '../telegram/bot/TelegramBotChannelService';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as cron from 'node-cron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { google } from 'googleapis';
import { parseStructuredResponse, isValidStructuredResponse } from '../../shared/ai/aiUtils';
import { CHANNEL } from '../../ui/lib/channels/channelHelper';
import { Reactions } from 'zca-js';
import { requestAICompletion } from '../ai/AIProviderAdapter';
import { automationsPausedAfterRestore } from '../cloudflare/restoreGate';
import {
  parseIdList, isExcludedId, isThreadAllowed, isWithinActiveHours, classifyZaloMessageType, normalizeMessageTypes,
  mentionsAccount, hasSenderRoleFilter, normalizeZaloUid, resolveZaloGroupRole, isRoleAllowed,
  parseCooldownMs, zaloMessageText,
} from './triggerFilters';
import { posLookupNode, posLookupQuery, refusedPosLookup, vietnamLocalPhone } from './posLookupGuard';
import { evaluateCondition, isBotCommandText, looseText, matchCategory, parseBotCommand, workflowLocale } from './workflowText';
import { MAX_LOOP_ITERATIONS_PER_RUN, forEachBodyNodeIds, forEachItemLimit, forEachVariableName, parseForEachList } from './forEachLoop';
import { paymentFromEvent } from '../integrations/paymentWebhook';
import { matchesPosWebhookTrigger } from '../integrations/posWebhook';
import { sameZaloReactionMeaning, zaloReactionEventFields } from '../../shared/zalo/zaloReactions';
import { tr } from '../../shared/i18n';

// Workflow versions before reaction keys were introduced stored the six picker
// options as numbers. Keep those workflows executable while sending the icon
// value that zca-js and Zalo actually accept.
const ZALO_WORKFLOW_REACTIONS: Record<string, string> = {
  '1': Reactions.LIKE,
  '2': Reactions.HEART,
  '3': Reactions.HAHA,
  '4': Reactions.WOW,
  '5': Reactions.CRY,
  '6': Reactions.ANGRY,
  LIKE: Reactions.LIKE,
  HEART: Reactions.HEART,
  HAHA: Reactions.HAHA,
  WOW: Reactions.WOW,
  CRY: Reactions.CRY,
  ANGRY: Reactions.ANGRY,
};

function resolveZaloWorkflowReaction(value: unknown): string | null {
  const reaction = String(value ?? '').trim();
  if (!reaction) return null;
  return ZALO_WORKFLOW_REACTIONS[reaction.toUpperCase()]
    || ((Object.values(Reactions) as string[]).includes(reaction) ? reaction : null);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType =
  | 'trigger.message' | 'trigger.friendRequest' | 'trigger.groupEvent'
  | 'trigger.reaction' | 'trigger.undo' | 'trigger.schedule' | 'trigger.manual'
  | 'trigger.labelAssigned' | 'trigger.telegramCommand'
  | 'zalo.sendMessage' | 'zalo.sendImage' | 'zalo.sendFile' | 'zalo.sendVoice'
  | 'zalo.sendVideo' | 'zalo.sendSticker'
  | 'zalo.forwardMessage' | 'zalo.addReaction' | 'zalo.undoMessage'
  | 'zalo.sendTyping'
  | 'zalo.findUser' | 'zalo.getUserInfo' | 'zalo.sendFriendRequest'
  | 'zalo.acceptFriendRequest' | 'zalo.rejectFriendRequest'
  | 'zalo.addToGroup' | 'zalo.removeFromGroup' | 'zalo.createPoll'
  | 'zalo.getMessageHistory' | 'zalo.setMute'
  | 'zalo.assignLabel' | 'zalo.removeLabel'
  | 'zalo.changeAliasName'
  | 'logic.if' | 'logic.switch' | 'logic.wait' | 'logic.forEach'
  | 'logic.forEachContact'
  | 'logic.setVariable' | 'logic.stopIf'
  | 'action.forwardCrossChannel'
  | 'data.textFormat' | 'data.jsonParse' | 'data.dateFormat' | 'data.randomPick'
  | 'sheets.appendRow' | 'sheets.readValues' | 'sheets.updateCell'
  | 'ai.generateText' | 'ai.classify'
  | 'notify.telegram' | 'notify.discord' | 'notify.email' | 'notify.notion'
  | 'output.httpRequest' | 'output.log'
  // P0 integrations
  | 'trigger.payment' | 'trigger.posWebhook'
  | 'trigger.webhook' | 'trigger.api'
  | 'kiotviet.lookupCustomer' | 'kiotviet.lookupOrder' | 'kiotviet.createOrder' | 'kiotviet.lookupProduct'
  | 'haravan.lookupCustomer' | 'haravan.lookupOrder' | 'haravan.createOrder' | 'haravan.lookupProduct'
  | 'sapo.lookupCustomer'    | 'sapo.lookupOrder'    | 'sapo.createOrder'    | 'sapo.lookupProduct'    | 'sapo.getInventory'
  | 'nhanh.lookupCustomer'   | 'nhanh.lookupOrder'   | 'nhanh.createOrder'   | 'nhanh.lookupProduct'
  | 'pancake.lookupCustomer' | 'pancake.lookupOrder' | 'pancake.createOrder' | 'pancake.lookupProduct'
  | 'payment.getTransactions'
  | 'ghn.createOrder' | 'ghn.getTracking' | 'ghn.getProvinces' | 'ghn.getDistricts' | 'ghn.getWards' | 'ghn.getServices'
  | 'ghtk.createOrder' | 'ghtk.getTracking'
  // Facebook
  | 'fb.trigger.message' | 'fb.trigger.image' | 'fb.trigger.video' | 'fb.trigger.file' | 'fb.trigger.sticker' | 'fb.trigger.reaction'
  | 'fb.trigger.unsend' | 'fb.trigger.groupEvent'
  | 'fb.action.sendMessage' | 'fb.action.sendTyping' | 'fb.action.addReaction'
  | 'fb.action.markAsRead' | 'fb.action.forward' | 'fb.action.pin' | 'fb.action.unpin'
  | 'fb.action.createPoll' | 'fb.action.block' | 'fb.action.unsend' | 'fb.action.editMessage'
  | 'fb.action.changeName' | 'fb.action.changeEmoji' | 'fb.action.changeNickname'
  | 'fb.action.sendImage' | 'fb.action.sendVideo' | 'fb.action.sendFile' | 'fb.action.sendAudio'
  // Telegram
  | 'tg.trigger.message' | 'tg.trigger.unsend' | 'tg.trigger.groupEvent'
  | 'tg.sendMessage' | 'tg.sendPhoto' | 'tg.sendFile' | 'tg.forwardMessage'
  | 'tg.sendVideo' | 'tg.sendVoice'
  | 'tg.deleteMessage' | 'tg.editMessage' | 'tg.addReaction' | 'tg.pinMessage'
  | 'tg.sendPoll' | 'tg.sendSticker' | 'tg.sendTyping'
  | 'tg.banMember' | 'tg.promoteMember' | 'tg.addMember' | 'tg.removeMember'
  | 'tg.markAsRead' | 'tg.markTopicAsRead'
  | 'tg.blockUser' | 'tg.unblockUser'
  | 'tg.changeGroupName' | 'tg.leaveGroup' | 'tg.exportInviteLink' | 'tg.createForumTopic'
  // Telegram Bot
  | 'tgbot.trigger.message' | 'tgbot.trigger.command' | 'tgbot.trigger.join' | 'tgbot.trigger.callback'
  | 'tgbot.trigger.editedMessage' | 'tgbot.trigger.joinRequest' | 'tgbot.trigger.memberUpdate'
  | 'tgbot.action.unbanMember' | 'tgbot.action.approveJoinRequest'
  | 'tgbot.action.sendMessage' | 'tgbot.action.sendPhoto' | 'tgbot.action.sendVideo' | 'tgbot.action.sendFile'
  | 'tgbot.action.sendMenu' | 'tgbot.action.sendForm' | 'tgbot.action.forward'
  | 'tgbot.action.sendSticker' | 'tgbot.action.sendAudio' | 'tgbot.action.sendVoice' | 'tgbot.action.leaveChat'
  | 'tgbot.action.editMessage' | 'tgbot.action.deleteMessage' | 'tgbot.action.pinMessage'
  | 'tgbot.action.unpinMessage' | 'tgbot.action.addReaction' | 'tgbot.action.sendPoll'
  | 'tgbot.action.sendChatAction' | 'tgbot.action.banMember' | 'tgbot.action.restrictMember'
  | 'tgbot.action.answerCallback';

export type WorkflowChannel = 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label?: string;
  position: { x: number; y: number };
  config: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  /** Visual-only interaction route; it executes only after a Bot callback. */
  data?: { telegramInline?: boolean; [key: string]: any };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  channel: WorkflowChannel;
  /** @deprecated use pageIds */
  pageId?: string;
  /** zalo_id list this workflow applies to. Empty = applies to all pages. */
  pageIds: string[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunLog {
  id: string;
  workflowId: string;
  workflowName: string;
  triggeredBy: string;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'error' | 'partial';
  errorMessage?: string;
  nodeResults: NodeResult[];
  /** Dry-run (simulate): side effects were mocked, no real message was sent. */
  simulated?: boolean;
  /** Outbound messages produced by send nodes (for the mock chat). */
  simulatedMessages?: SimulatedMessage[];
}

export interface SimulatedMessage {
  nodeId: string;
  label: string;
  type: string;
  text: string;
  threadId?: string;
}

export interface NodeResult {
  nodeId: string;
  nodeType: NodeType;
  label?: string;
  status: 'success' | 'error' | 'skipped';
  input: Record<string, any>;
  output: Record<string, any>;
  durationMs: number;
  error?: string;
  /** Iteration number (from 1) when the node sits inside the body of "Lặp qua danh sách" (loop over list); absent = the node runs once. */
  iteration?: number;
}

interface ExecutionContext {
  trigger: any;
  nodes: Record<string, { output: Record<string, any> }>;
  variables: Record<string, any>;
  pageId: string;
  /** nodeIds that should be skipped because they're on the wrong branch of an IF/switch */
  skippedNodes: Set<string>;
  /** Full node list - used by renderTemplate to match $node.Label.field by label name */
  _wfNodes: WorkflowNode[];
  _wfName: string;
}

/** State of one run, shared between the main node chain and the bodies of the logic.forEach loops. */
interface WorkflowRunState {
  status: 'success' | 'error' | 'partial';
  errorMessage?: string;
  nodeResults: NodeResult[];
  simulate: boolean;
  simulatedMessages: SimulatedMessage[];
  /** Total number of loop iterations run so far (limit MAX_LOOP_ITERATIONS_PER_RUN). */
  loopIterations: number;
}

/**
 * Extract only correlation metadata for the Telegram User supergroup/channel
 * ingress trace.  Never put the message body in this diagnostic: these lines
 * are deliberately easy for a user to copy from the Electron terminal.
 */
function getTelegramChannelTrace(data: any): {
  accountId: string;
  chatId: string;
  msgId: string;
  peerKind: string;
  msgType: string;
  topicId: string;
  isSelf: boolean;
} | null {
  const envelope = data?.message || data || {};
  const msg = envelope?.data || data?.data || envelope || {};
  const channel = data?.channel || envelope?.channel || msg?.channel || '';
  const chatId = String(envelope?.threadId || data?.threadId || msg?.threadId || msg?.idTo || '');
  if (channel !== 'telegram_user' || !chatId.startsWith('-100')) return null;
  return {
    accountId: String(data?.zaloId || data?.accountId || ''),
    chatId,
    msgId: String(msg?.msgId || data?.msgId || ''),
    peerKind: msg?.isChannel ? 'channel' : 'supergroup_or_topic',
    msgType: String(msg?.msgType || ''),
    topicId: String(msg?.topicId || ''),
    isSelf: !!(envelope?.isSelf || data?.isSelf || msg?.isSelf),
  };
}

function logTelegramChannelTrace(stage: string, trace: ReturnType<typeof getTelegramChannelTrace>, extra: Record<string, unknown> = {}): void {
  if (!trace) return;
  const fields: Record<string, unknown> = { ...trace, ...extra };
  const printable = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  // Logger.log(`[TG:channel-workflow] ${stage} | ${printable.join(' ')}`);
}

/** Cooldown (cooldownMinutes): when the map exceeds the threshold, expired entries are removed (at most once per minute) */
const COOLDOWN_PRUNE_THRESHOLD = 2000;
const COOLDOWN_PRUNE_INTERVAL_MS = 60 * 1000;
/** Cache of Zalo group roles for the senderRole filter (key = zaloId:groupId) */
const GROUP_ROLE_CACHE_TTL_MS = 10 * 60 * 1000;
/** Short-lived memory of lookup errors, so getGroupInfo is not called repeatedly when a group sends many messages quickly */
const GROUP_ROLE_FAILURE_TTL_MS = 30 * 1000;
/** zca-js getGroupInfo has no timeout → limit it ourselves, so a hung lookup does not block that group forever */
const GROUP_ROLE_LOOKUP_TIMEOUT_MS = 15 * 1000;
const GROUP_ROLE_CACHE_MAX = 500;

type ZaloGroupRoles = { creatorId: string; adminIds: string[] };

// ─── Simulation (dry-run) ─────────────────────────────────────────────────────
// These node types are pure (no side effect) so a simulated run executes them for
// real to get the correct branch decisions; every other node type is mocked.

const SIMULATE_REAL_TYPES = new Set<string>([
  'logic.if', 'logic.switch', 'logic.setVariable', 'logic.stopIf', 'logic.forEach',
  'data.textFormat', 'data.randomPick', 'data.dateFormat', 'data.jsonParse',
]);

const OUTBOUND_SEND_RE = /^(zalo|fb\.action|tg|tgbot\.action)\.(sendMessage|sendImage|sendPhoto|sendFile|sendVideo|sendVoice|sendAudio|sendSticker|sendGif|sendTextStyle|sendBusinessCard|sendBankCard|sendMenu|sendPoll|sendForm|forwardMessage)$/;

/** Best-effort outbound text of a send node's rendered config. */
function outboundText(cfg: Record<string, any>): string {
  return String(cfg.message || cfg.caption || cfg.body || cfg.text || cfg.content || '').trim();
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Per-recipient counts of a send node (continueOnError keeps going after a failed recipient). */
type SendTally = { sent: number; failed: number; lastMsgId: string; lastError: string };
const newSendTally = (): SendTally => ({ sent: 0, failed: 0, lastMsgId: '', lastError: '' });

/** Zalo message types that carry a downloadable file (forwarding re-sends the local copy). */
function isZaloMediaType(msgType: string): boolean {
  return /^(chat\.(photo|video\.msg|video|voice|gif|doodle)|share\.file)$/i.test(String(msgType || '').trim());
}

/** Readable text of a Zalo link card ({ title, href, … }): its address, so forwarding never sends attachment JSON. */
function zaloLinkText(raw: unknown): string {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return ''; }
  }
  return obj && typeof obj === 'object' ? String(obj.href || '').trim() : '';
}

class WorkflowEngineService {
  private static instance: WorkflowEngineService;
  private workflows: Map<string, Workflow> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();

  /** Debounce timers for trigger.message - key = workflowId:threadId */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Buffered message events for debounce - key = workflowId:threadId */
  private debounceBuffers: Map<string, any[]> = new Map();
  /** cooldownMinutes - key = workflowId:threadId → time when the cooldown ends (RAM only) */
  private cooldownUntil: Map<string, number> = new Map();
  private cooldownLastPruneAt = 0;
  /** senderRole - looked-up Zalo group role, key = zaloId:groupId (failed = error, short-lived memory) */
  private groupRoleCache: Map<string, ZaloGroupRoles & { at: number; failed?: boolean }> = new Map();
  /** senderRole - getGroupInfo in progress, merges lookups with the same key */
  private groupRoleInflight: Map<string, Promise<ZaloGroupRoles | null>> = new Map();

  public static getInstance(): WorkflowEngineService {
    if (!this.instance) this.instance = new WorkflowEngineService();
    return this.instance;
  }

  public async initialize(): Promise<void> {
    this.loadWorkflows();
    this.rehookEvents();
    this.registerCronJobs();
    // Sync Telegram bot pollers for trigger.telegramCommand
    try {
      const { syncPollers } = require('./TelegramBotPollingService');
      syncPollers();
    } catch { /* ignore if module not available */ }
    Logger.log(`[WorkflowEngine] Initialized - ${this.workflows.size} workflows loaded`);
  }

  private normalizeWorkflowChannel(channel?: string): WorkflowChannel {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalizeChannel } = require('../../configs/channels/channelConfig');
    // Legacy 'telegram' → default to 'telegram_user' (MTProto)
    if (channel === 'telegram') return 'telegram_user';
    return normalizeChannel(channel) as WorkflowChannel;
  }

  private isRunnableWorkflow(wf: Workflow): boolean {
    const ch = this.normalizeWorkflowChannel(wf.channel);
    return ch === 'zalo' || ch === 'facebook' || ch === 'telegram_user' || ch === 'telegram_bot';
  }

  /** Channel an event says it comes from ('' = not stated: Zalo events and channel-less triggers). */
  private eventChannelOf(data: any): WorkflowChannel | '' {
    const raw = data?.channel || data?.message?.channel || data?.message?.data?.channel || data?.data?.channel || '';
    if (!raw || typeof raw !== 'string') return '';
    const ch = this.normalizeWorkflowChannel(raw);
    return ch === 'zalo' || ch === 'facebook' || ch === 'telegram_user' || ch === 'telegram_bot' ? ch : '';
  }

  /**
   * Resolve a Facebook account ID to its internal UUID so the right instance is found in FacebookService.
   * FacebookService.instances is keyed by UUID, but the workflow trigger sends the numeric FB UID.
   * Without resolving, getInstance() creates a new instance and connect() takes ~10s for nothing.
   */
  private resolveFBAccountId(rawId: string): string {
    if (!rawId) return '';
    // If it is already a UUID (contains dashes) → return it unchanged
    if (rawId.includes('-')) return rawId;
    // If it is a Facebook UID (all digits) → look up the UUID in the DB
    if (/^\d+$/.test(rawId)) {
      try {
        const fbAcc = DatabaseService.getInstance().getFBAccountByFacebookId(rawId);
        if (fbAcc?.id) return fbAcc.id;
      } catch {}
    }
    return rawId;
  }

  // ─── Load ─────────────────────────────────────────────────────────────────

  private loadWorkflows(): void {
    const rows = DatabaseService.getInstance().getWorkflows();
    this.workflows.clear();
    for (const row of rows) {
      try {
        const pageIdsRaw: string = row.page_ids || row.page_id || '';
        const wf: Workflow = {
          id: row.id, name: row.name, description: row.description || '',
          enabled: row.enabled === 1 || row.enabled === true,
          channel: this.normalizeWorkflowChannel(row.channel),
          pageId: pageIdsRaw.split(',').filter(Boolean)[0] || '',
          pageIds: pageIdsRaw.split(',').filter(Boolean),
          nodes: JSON.parse(row.nodes_json || '[]'),
          edges: JSON.parse(row.edges_json || '[]'),
          createdAt: row.created_at, updatedAt: row.updated_at,
        };
        this.workflows.set(wf.id, wf);
      } catch (e: any) {
        Logger.error(`[WorkflowEngine] Failed to parse workflow ${row.id}: ${e.message}`);
      }
    }
  }

  /**
   * When a background local workspace switches to another local workspace: reload all workflows + schedules of that workspace (before
   * this, workflows were only loaded when the app opened → after a switch, the old workspace's workflows ran on the new workspace's DB).
   * Not called when switching to / leaving an employee (remote) workspace: the local workspace's workflows keep running.
   */
  public reloadAll(): void {
    for (const workflowId of Array.from(this.cronJobs.keys())) this.unregisterCron(workflowId);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.debounceBuffers.clear();
    this.cooldownUntil.clear();
    this.loadWorkflows();
    this.registerCronJobs();
    try {
      const { syncPollers } = require('./TelegramBotPollingService');
      syncPollers();
    } catch { /* ignore */ }
    Logger.log(`[WorkflowEngine] Reloaded - ${this.workflows.size} workflows loaded`);
  }

  public reloadWorkflow(workflowId: string): void {
    const row = DatabaseService.getInstance().getWorkflowById(workflowId);
    if (!row) { this.workflows.delete(workflowId); this.unregisterCron(workflowId); return; }
    try {
      const pageIdsRaw: string = row.page_ids || row.page_id || '';
      const wf: Workflow = {
        id: row.id, name: row.name, description: row.description || '',
        enabled: row.enabled === 1 || row.enabled === true,
        channel: this.normalizeWorkflowChannel(row.channel),
        pageId: pageIdsRaw.split(',').filter(Boolean)[0] || '',
        pageIds: pageIdsRaw.split(',').filter(Boolean),
        nodes: JSON.parse(row.nodes_json || '[]'),
        edges: JSON.parse(row.edges_json || '[]'),
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
      this.workflows.set(wf.id, wf);
      this.unregisterCron(workflowId);
      if (wf.enabled && this.isRunnableWorkflow(wf)) this.registerCronForWorkflow(wf);
      // Sync Telegram pollers when workflow is reloaded
      try {
        const { syncPollers } = require('./TelegramBotPollingService');
        syncPollers();
      } catch { /* ignore */ }
    } catch (e: any) {
      Logger.error(`[WorkflowEngine] reloadWorkflow ${workflowId}: ${e.message}`);
    }
  }

  public removeWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    this.unregisterCron(workflowId);
    // Clean up debounce timers/buffers for this workflow
    this.clearDebounceForWorkflow(workflowId);
    this.clearCooldownForWorkflow(workflowId);
    // Sync Telegram pollers when workflow is removed
    try {
      const { syncPollers } = require('./TelegramBotPollingService');
      syncPollers();
    } catch { /* ignore */ }
  }

  /** Clear all debounce timers and buffers whose key starts with workflowId: */
  private clearDebounceForWorkflow(workflowId: string): void {
    const prefix = workflowId + ':';
    for (const [key, timer] of this.debounceTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
        this.debounceBuffers.delete(key);
      }
    }
  }

  /** Delete the cooldown entries of the workflow (key = workflowId:threadId) */
  private clearCooldownForWorkflow(workflowId: string): void {
    const prefix = workflowId + ':';
    for (const key of this.cooldownUntil.keys()) {
      if (key.startsWith(prefix)) this.cooldownUntil.delete(key);
    }
  }

  // ─── Event Listeners ──────────────────────────────────────────────────────

  /** Hook registered with EventBroadcaster: remove it before registering again so the workflow does not run twice. */
  private eventUnsubscribers: Array<() => void> = [];

  private onEvent(channel: string, callback: (data: any) => void): void {
    this.eventUnsubscribers.push(EventBroadcaster.onBeforeSend(channel, callback));
  }

  /**
   * (Re-)register all trigger hooks. Called at startup and after a workspace change: workspace:switch calls
   * EventBroadcaster.clearBeforeSendHooks(), and before this fix the workflows stopped receiving events until the app was reopened.
   */
  public rehookEvents(): void {
    for (const unsubscribe of this.eventUnsubscribers) {
      try { unsubscribe(); } catch { /* the hook was removed */ }
    }
    this.eventUnsubscribers = [];
    this.registerZaloEventListeners();
    this.registerFacebookEventListeners();
    this.registerTelegramEventListeners();
  }

  private registerZaloEventListeners(): void {
    const EVENT_MAP: Record<string, string> = {
      'event:message':       'trigger.message',
      'event:friendRequest': 'trigger.friendRequest',
      'event:groupEvent':    'trigger.groupEvent',
      'event:reaction':      'trigger.reaction',
      'event:undo':          'trigger.undo',
      'event:labelAssigned': 'trigger.labelAssigned',
      'integration:payment': 'trigger.payment',
      'integration:posWebhook': 'trigger.posWebhook',
    };
    for (const [channel, triggerType] of Object.entries(EVENT_MAP)) {
      this.onEvent(channel, (data: any) => {
        if (channel === 'event:reaction') {
          // The listener sends { zaloId, reaction }: the fields are nested in reaction.data. Own reactions and removals (✕) do not
          // start "Khi có cảm xúc"
          if (!data?.reaction) return;
          const fields = zaloReactionEventFields(data);
          if (!fields.react || fields.isSelf) return;
          this.triggerWorkflows(triggerType, { ...data, ...fields });
          return;
        }
        this.triggerWorkflows(triggerType, data);
      });
    }

  }

  /** Bridge Facebook events to workflow triggers */
  private registerFacebookEventListeners(): void {
    // Simple 1:1 mapping for standalone Facebook events
    const SIMPLE_EVENTS: Record<string, string> = {
      'fb:onReaction':   'fb.trigger.reaction',
      'fb:onUnsend':     'fb.trigger.unsend',
      'fb:onGroupEvent': 'fb.trigger.groupEvent',
    };
    for (const [channel, triggerType] of Object.entries(SIMPLE_EVENTS)) {
      this.onEvent(channel, (data: any) => {
        this.triggerWorkflows(triggerType, data);
      });
    }

    // Message event - determine specific trigger type from attachment data
    this.onEvent('fb:onMessage', (data: any) => {
      // Always trigger the base text-message workflow
      this.triggerWorkflows('fb.trigger.message', data);

      // Route to media-specific triggers based on attachment type
      const msg = data?.message || {};
      const att = msg.attachments || {};
      const attType = (att.attachmentType || '').toLowerCase();

      if (attType === 'image' || attType === 'photo') {
        this.triggerWorkflows('fb.trigger.image', data);
      } else if (attType === 'video') {
        this.triggerWorkflows('fb.trigger.video', data);
      } else if (attType === 'file' || attType === 'audio') {
        this.triggerWorkflows('fb.trigger.file', data);
      } else if (attType === 'sticker') {
        this.triggerWorkflows('fb.trigger.sticker', data);
      }
    });
  }

  /** Bridge Telegram events to workflow triggers */
  private registerTelegramEventListeners(): void {
    // Telegram messages come through the unified 'event:message' channel
    this.onEvent('event:message', (data: any) => {
      const ch = data?.channel || data?.message?.channel || data?.message?.data?.channel || data?.data?.channel;
      if (ch === 'telegram_user') {
        logTelegramChannelTrace('HOOK_RECEIVED', getTelegramChannelTrace(data));
        this.triggerWorkflows('tg.trigger.message', data);
      }
      if (ch === 'telegram_bot') {
        this.triggerWorkflows('tgbot.trigger.message', data);
        const msg = data?.message?.data || data?.data || {};
        if (/^\/[A-Za-z][\w-]*/.test(String(msg.content || data?.content || ''))) {
          this.triggerWorkflows('tgbot.trigger.command', data);
        }
      }
    });
    // Telegram message deletes (unsend)
    this.onEvent('event:messagesDeleted', (data: any) => {
      this.triggerWorkflows('tg.trigger.unsend', data);
    });
    // Telegram group events
    this.onEvent('event:groupEvent', (data: any) => {
      if (data.channel === 'telegram_user') {
        this.triggerWorkflows('tg.trigger.groupEvent', data);
      }
    });
    // Bot inline keyboards are delivered as callback_query updates, not normal
    // messages. Route buttons intentionally resume a node in the *same*
    // workflow; they never start an unrelated workflow.
    this.onEvent('event:telegramBotCallback', (data: any) => {
      const callbackData = String(data?.callbackData || '');
      const route = callbackData.match(/^dlw:n:([a-zA-Z0-9_-]+)$/);
      if (route) {
        const routeId = route[1];
        for (const wf of this.workflows.values()) {
          if (!wf.enabled || !this.isRunnableWorkflow(wf)) continue;
          if (wf.pageIds.length && !wf.pageIds.includes(String(data.accountId || data.zaloId || ''))) continue;
          const sender = wf.nodes.find(node => node.type === 'tgbot.action.sendMessage' &&
            (node.config?.keyboard?.rows || []).some((row: any) =>
              (Array.isArray(row) ? row : [row]).some((button: any) =>
                button?.id === routeId && button?.action === 'node' && button?.targetNodeId,
              ),
            ),
          );
          if (!sender) continue;
          const button = (sender.config.keyboard.rows as any[][])
            .flat().find((item: any) => item?.id === routeId && item?.action === 'node');
          if (button?.targetNodeId && wf.nodes.some(node => node.id === button.targetNodeId)) {
            this.executeWorkflow(wf, data, 'tgbot.trigger.callback', button.targetNodeId).catch(err =>
              Logger.error(`[WorkflowEngine] Telegram Bot inline route failed: ${err.message}`),
            );
            return;
          }
        }
        Logger.warn(`[WorkflowEngine] Telegram Bot inline route not found: ${routeId}`);
        return;
      }
      this.triggerWorkflows('tgbot.trigger.callback', data);
    });
    this.onEvent('event:telegramBotMembership', (data: any) => {
      this.triggerWorkflows('tgbot.trigger.join', data);
    });
    this.onEvent('event:telegramBotEditedMessage', (data: any) => {
      this.triggerWorkflows('tgbot.trigger.editedMessage', data);
    });
    this.onEvent('event:telegramBotJoinRequest', (data: any) => {
      this.triggerWorkflows('tgbot.trigger.joinRequest', data);
    });
    this.onEvent('event:telegramBotMemberUpdate', (data: any) => {
      this.triggerWorkflows('tgbot.trigger.memberUpdate', data);
    });
  }

  /**
   * Called from the main process when the renderer emits 'workflow:labelEvent'.
   * Bridge: renderer (ChatHeader) → ipcMain → engine.
   */
  public triggerLabelEvent(data: {
    zaloId: string;
    threadId: string;
    threadType: number;
    labelId: number;
    labelText: string;
    labelColor: string;
    labelEmoji: string;
    labelSource?: 'local' | 'zalo';
    action: 'assigned' | 'removed';
  }): void {
    this.triggerWorkflows('trigger.labelAssigned', data);
  }

  // ─── Cron ─────────────────────────────────────────────────────────────────

  private registerCronJobs(): void {
    for (const wf of this.workflows.values()) {
      if (wf.enabled && this.isRunnableWorkflow(wf)) this.registerCronForWorkflow(wf);
    }
  }

  private registerCronForWorkflow(wf: Workflow): void {
    if (!this.isRunnableWorkflow(wf)) return;
    const scheduleNode = wf.nodes.find(n => n.type === 'trigger.schedule');
    if (!scheduleNode) return;
    const expr: string = scheduleNode.config.cronExpression || '';
    if (!expr || !cron.validate(expr)) return;

    const tz = scheduleNode.config.timezone || 'Asia/Ho_Chi_Minh';
    const task = cron.schedule(expr, () => {
      // Just restored the DB from Cloudflare: wait for the user to confirm the old machine is off (avoids two machines running the schedules at once).
      if (automationsPausedAfterRestore()) {
        Logger.warn(`[WorkflowEngine] Cron "${wf.name}" skipped: automations paused after restore`);
        return;
      }
      this.executeWorkflow(wf, {}, 'trigger.schedule').catch(err => {
        Logger.error(`[WorkflowEngine] Cron error in "${wf.name}": ${err.message}`);
      });
    }, { timezone: tz });
    this.cronJobs.set(wf.id, task);
    Logger.log(`[WorkflowEngine] Cron registered for "${wf.name}" - ${expr}`);
  }

  private unregisterCron(workflowId: string): void {
    const job = this.cronJobs.get(workflowId);
    if (job) { job.stop(); this.cronJobs.delete(workflowId); }
  }

  // ─── Trigger matching ─────────────────────────────────────────────────────

  private triggerWorkflows(triggerType: string, eventData: any, targetWorkflowId?: string): void {
    if (automationsPausedAfterRestore()) return;
    const telegramChannelTrace = triggerType === 'tg.trigger.message'
      ? getTelegramChannelTrace(eventData)
      : null;
    logTelegramChannelTrace('TRIGGER_DISPATCH', telegramChannelTrace, {
      triggerType,
      loadedWorkflows: this.workflows.size,
    });
    for (const wf of this.workflows.values()) {
      if (targetWorkflowId && wf.id !== targetWorkflowId) continue;
      if (!wf.enabled) {
        logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'disabled' });
        continue;
      }
      if (!this.isRunnableWorkflow(wf)) {
        logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'unsupported_channel', workflowChannel: wf.channel || '-' });
        continue;
      }
      const triggerNode = wf.nodes.find(n => n.type === triggerType);
      if (!triggerNode) {
        logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'trigger_not_present' });
        continue;
      }
      // An event of one channel never starts a workflow of another channel: Zalo and Telegram share event names
      // (event:message, event:groupEvent), so a Zalo workflow set for "all accounts" used to run on Telegram messages too
      // and answer through the Zalo API. Events without a channel (schedule, webhook, payment…) are not affected.
      const eventChannel = this.eventChannelOf(eventData);
      if (eventChannel && this.normalizeWorkflowChannel(wf.channel) !== eventChannel) {
        logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'other_channel', workflowChannel: wf.channel || '-' });
        continue;
      }
      // pageIds: empty = applies to all; has values = only runs for the matching pages
      if (wf.pageIds.length > 0) {
        const accountId = eventData.zaloId || eventData.fbAccountId || eventData.accountId || '';
        if (accountId && !wf.pageIds.includes(accountId)) {
          logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'account_filter', configuredAccounts: wf.pageIds.join(',') });
          continue;
        }
      }
      if (!this.matchesTriggerFilter(triggerNode, eventData)) {
        logTelegramChannelTrace('WORKFLOW_SKIPPED', telegramChannelTrace, { workflowId: wf.id, reason: 'trigger_filter', triggerNodeId: triggerNode.id });
        continue;
      }

      logTelegramChannelTrace('WORKFLOW_MATCHED', telegramChannelTrace, {
        workflowId: wf.id,
        triggerNodeId: triggerNode.id,
        debounceSeconds: Number(triggerNode.config.debounceSeconds || 0),
      });

      // senderRole (owner / deputy / member) needs getGroupInfo → checked asynchronously,
      // only dispatch when the sender's role matches. Personal messages were already excluded in matchesTriggerFilter.
      if (triggerType === 'trigger.message' && hasSenderRoleFilter(triggerNode.config?.senderRole)) {
        this.matchesSenderRole(triggerNode, eventData)
          .then(allowed => {
            if (!allowed) return;
            // The workflow may have been disabled / deleted while waiting for getGroupInfo
            if (!this.workflows.get(wf.id)?.enabled) return;
            this.dispatchMatchedWorkflow(wf, triggerNode, triggerType, eventData);
          })
          .catch(err => {
            Logger.warn(`[WorkflowEngine] senderRole check failed for "${wf.name}": ${err?.message || err}`);
          });
        continue;
      }

      this.dispatchMatchedWorkflow(wf, triggerNode, triggerType, eventData);
    }
  }

  /**
   * Processing after the workflow matched the trigger (matchesTriggerFilter + senderRole):
   * cooldown → debounce (batch consecutive messages) or run immediately.
   */
  private dispatchMatchedWorkflow(wf: Workflow, triggerNode: WorkflowNode, triggerType: string, eventData: any): void {
    // ─── Cooldown: already ran for this conversation within the last N minutes → skip ────
    // With debounce: check when the message arrives (before batching), record the timestamp when the batched run actually starts.
    const cooldown = this.getMessageCooldown(wf, triggerNode, triggerType, eventData);
    if (cooldown) {
      const until = this.cooldownUntil.get(cooldown.key);
      const now = Date.now();
      if (until !== undefined && now < until) {
        const remainSeconds = Math.ceil((until - now) / 1000);
        Logger.info(`[WorkflowEngine] Cooldown: skip "${wf.name}" (${cooldown.key}), còn ${remainSeconds}s`);
        return;
      }
    }

    // ─── Debounce for message triggers: batch consecutive messages ────────
    const debounceSeconds = Number(triggerNode.config.debounceSeconds || 0);
    if ((triggerType === 'trigger.message' || triggerType === 'fb.trigger.message' || triggerType === 'tg.trigger.message' || triggerType === 'tgbot.trigger.message') && debounceSeconds > 0) {
      const envelope = eventData.message || eventData;
      const msg = envelope.data || eventData.data || envelope;
      // fb:onMessage has no threadId (the conversation id is in message.replyToID) → previously all conversations
      // used one shared key on Facebook, so the previous conversation's messages were dropped. Zalo / Telegram keep their reading.
      const threadId = triggerType === 'fb.trigger.message' || triggerType === 'tgbot.trigger.message'
        ? this.getMessageThreadId(triggerType, eventData)
        : ((msg as any).threadId || envelope.threadId || eventData.threadId || '');
      const debounceKey = `${wf.id}:${threadId}`;

      // Buffer the event
      if (!this.debounceBuffers.has(debounceKey)) {
        this.debounceBuffers.set(debounceKey, []);
      }
      this.debounceBuffers.get(debounceKey)!.push(eventData);

      // Clear existing timer and set new one
      const existingTimer = this.debounceTimers.get(debounceKey);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(debounceKey);
        const buffered = this.debounceBuffers.get(debounceKey) || [];
        this.debounceBuffers.delete(debounceKey);

        if (buffered.length === 0) return;

        // Merge all buffered messages: take the LAST event as base, combine contents
        const lastEvent = buffered[buffered.length - 1];
        if (buffered.length > 1) {
          // Extract content from each buffered message and join
          const mergedContents: string[] = [];
          for (const evt of buffered) {
            const m = evt.data || evt.message || {};
            const md = (m as any).data || {};
            const rawContent = md.content || (m as any).content || evt.content;
            const text = String((rawContent as any)?.msg || (typeof rawContent === 'string' ? rawContent : '') || '').trim();
            if (text) mergedContents.push(text);
          }
          // Inject merged content into last event's message data
          const lastMsg = lastEvent.data || lastEvent.message || {};
          const lastMsgData = (lastMsg as any).data || {};
          const mergedText = mergedContents.join('\n');
          if (lastMsgData.content && typeof lastMsgData.content === 'object') {
            lastMsgData.content = { ...lastMsgData.content, msg: mergedText };
          } else {
            lastMsgData.content = mergedText;
          }
          Logger.info(`[WorkflowEngine] Debounce merged ${buffered.length} messages for "${wf.name}": "${mergedText.substring(0, 200)}"`);
        }

        if (cooldown) this.markCooldown(cooldown.key, cooldown.ms);
        this.executeWorkflow(wf, lastEvent, triggerType).catch(err => {
          Logger.error(`[WorkflowEngine] Error in workflow "${wf.name}" (debounced): ${err.message}`);
        });
      }, debounceSeconds * 1000);

      this.debounceTimers.set(debounceKey, timer);

      // Cap debounce entries to prevent unbounded memory growth
      if (this.debounceTimers.size > 500) {
        const oldestKey = this.debounceTimers.keys().next().value;
        if (oldestKey) {
          clearTimeout(this.debounceTimers.get(oldestKey)!);
          this.debounceTimers.delete(oldestKey);
          this.debounceBuffers.delete(oldestKey);
        }
      }

      Logger.info(`[WorkflowEngine] Debounce: buffered message for "${wf.name}" (${debounceKey}), wait ${debounceSeconds}s`);
      return;
    }

    if (cooldown) this.markCooldown(cooldown.key, cooldown.ms);
    this.executeWorkflow(wf, eventData, triggerType).catch(err => {
      Logger.error(`[WorkflowEngine] Error in workflow "${wf.name}": ${err.message}`);
    });
  }

  /**
   * cooldownMinutes of the message trigger → { key: `${workflowId}:${threadId}`, ms }.
   * null = off (not configured / another trigger / conversation cannot be determined).
   */
  private getMessageCooldown(wf: Workflow, triggerNode: WorkflowNode, triggerType: string, eventData: any): { key: string; ms: number } | null {
    if (triggerType !== 'trigger.message' && triggerType !== 'fb.trigger.message' && triggerType !== 'tg.trigger.message' && triggerType !== 'tgbot.trigger.message') return null;
    const ms = parseCooldownMs(triggerNode.config?.cooldownMinutes);
    if (ms <= 0) return null;
    const threadId = this.getMessageThreadId(triggerType, eventData);
    return threadId ? { key: `${wf.id}:${threadId}`, ms } : null;
  }

  /** Thread id of the message event - read the same way as matchesTriggerFilter in each channel */
  private getMessageThreadId(triggerType: string, data: any): string {
    if (!data) return '';
    if (triggerType === 'fb.trigger.message') return this.getFacebookThreadId(data);
    if (triggerType === 'tgbot.trigger.message') {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      return String(data.chatId || envelope.threadId || data.threadId || msg.idTo || '').trim();
    }
    if (triggerType === 'tg.trigger.message') {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      return String(data.threadId || envelope.threadId || msg.threadId || msg.chatId || '').trim();
    }
    // trigger.message (Zalo): message.threadId = user id (1-1) or group id
    const msg = data.data || data.message || {};
    return String((msg as any).threadId || data.threadId || '').trim();
  }

  /**
   * Thread id of the fb:onMessage event. FBMQTTMessage has no threadId but carries the conversation id in
   * message.replyToID ('0' = unknown) → same fallback chain as $trigger.threadId (flattenTriggerData).
   */
  private getFacebookThreadId(data: any): string {
    const msg = data?.message || {};
    const threadId = String(data?.threadId || msg.threadId || msg.replyToID || '').trim();
    return threadId === '0' ? '' : threadId;
  }

  /**
   * Record the cooldown end time (when the workflow starts running + N minutes). When the map gets too big, remove the
   * expired entries - scan them all, because expiry times do not follow insertion order (N differs).
   */
  private markCooldown(key: string, cooldownMs: number): void {
    const now = Date.now();
    this.cooldownUntil.set(key, now + cooldownMs);
    if (this.cooldownUntil.size <= COOLDOWN_PRUNE_THRESHOLD) return;
    if (now - this.cooldownLastPruneAt < COOLDOWN_PRUNE_INTERVAL_MS) return;
    this.cooldownLastPruneAt = now;
    for (const [entryKey, until] of this.cooldownUntil) {
      if (until <= now) this.cooldownUntil.delete(entryKey);
    }
  }

  /**
   * senderRole (Zalo trigger.message, group messages): the sender's role comes from getGroupInfo of
   * the SAME account that received the message. Lookup error / missing data → false (does not trigger).
   */
  private async matchesSenderRole(triggerNode: WorkflowNode, data: any): Promise<boolean> {
    const msg = data?.data || data?.message || {};          // UserMessage | GroupMessage
    const msgData = (msg as any).data || {};                 // TMessage - uidFrom, mentions ...
    // 'event:message' also carries Telegram messages → the Zalo group role does not apply
    const channel = data?.channel || (msg as any).channel || msgData.channel;
    if (channel && channel !== CHANNEL.ZALO) return false;
    const zaloId = String(data?.zaloId || '').trim();
    const groupId = String((msg as any).threadId || data?.threadId || '').trim();
    const senderId = normalizeZaloUid(msgData.uidFrom || (msg as any).uidFrom || data?.fromId);
    if (!zaloId || !groupId || !senderId) {
      Logger.warn(`[WorkflowEngine] senderRole: thiếu dữ liệu (account=${zaloId || '-'}, group=${groupId || '-'}, sender=${senderId || '-'}) → không kích hoạt`);
      return false;
    }
    const roles = await this.getZaloGroupRoles(zaloId, groupId);
    if (!roles) return false;
    const role = resolveZaloGroupRole(senderId, roles.creatorId, roles.adminIds);
    return isRoleAllowed(role, String(triggerNode.config?.senderRole ?? ''));
  }

  /** Group creatorId / adminIds: cached for 10 minutes per zaloId:groupId, duplicate calls are merged */
  private getZaloGroupRoles(zaloId: string, groupId: string): Promise<ZaloGroupRoles | null> {
    const key = `${zaloId}:${groupId}`;
    const cached = this.groupRoleCache.get(key);
    if (cached) {
      const ttl = cached.failed ? GROUP_ROLE_FAILURE_TTL_MS : GROUP_ROLE_CACHE_TTL_MS;
      const age = Date.now() - cached.at;
      if (age < ttl) {
        if (cached.failed) {
          // Do not call getGroupInfo again in a burst (Zalo limits the API), but still record the reason each message was skipped
          Logger.warn(`[WorkflowEngine] senderRole: tra cứu nhóm ${groupId} (tài khoản ${zaloId}) vừa lỗi ${Math.round(age / 1000)}s trước, thử lại sau ${Math.ceil((ttl - age) / 1000)}s → không kích hoạt`);
          return Promise.resolve(null);
        }
        return Promise.resolve({ creatorId: cached.creatorId, adminIds: cached.adminIds });
      }
      this.groupRoleCache.delete(key);
    }
    const inflight = this.groupRoleInflight.get(key);
    if (inflight) return inflight;

    const lookup = this.fetchZaloGroupRoles(zaloId, groupId)
      .then(roles => {
        this.rememberZaloGroupRoles(key, roles);
        return roles;
      })
      .finally(() => {
        this.groupRoleInflight.delete(key);
      });
    this.groupRoleInflight.set(key, lookup);
    return lookup;
  }

  private async fetchZaloGroupRoles(zaloId: string, groupId: string): Promise<ZaloGroupRoles | null> {
    // Do not use getApi(): getApi falls back to another account → wrong role / wrong group
    const api = ConnectionManager.getConnection(zaloId)?.api;
    if (!api) {
      Logger.warn(`[WorkflowEngine] senderRole: tài khoản ${zaloId} chưa kết nối → không kích hoạt (nhóm ${groupId})`);
      return null;
    }
    try {
      // zca-js: GroupInfoResponse.gridInfoMap[groupId] = GroupInfo { creatorId, adminIds, ... }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${GROUP_ROLE_LOOKUP_TIMEOUT_MS / 1000}s`)), GROUP_ROLE_LOOKUP_TIMEOUT_MS);
      });
      const res: any = await Promise.race([api.getGroupInfo(groupId), timeout])
        .finally(() => { if (timer) clearTimeout(timer); });
      const info: any = res?.gridInfoMap?.[groupId] || res?.changed_groups?.[groupId];
      const creatorId = normalizeZaloUid(info?.creatorId || info?.creator);
      if (!info || !creatorId) {
        Logger.warn(`[WorkflowEngine] senderRole: getGroupInfo(${groupId}) không có creatorId → không kích hoạt`);
        return null;
      }
      const rawAdminIds: unknown[] = Array.isArray(info.adminIds) ? info.adminIds : (Array.isArray(info.subAdmins) ? info.subAdmins : []);
      const adminIds = rawAdminIds.map(id => normalizeZaloUid(id)).filter(Boolean);
      return { creatorId, adminIds };
    } catch (err: any) {
      Logger.warn(`[WorkflowEngine] senderRole: getGroupInfo(${groupId}) lỗi (tài khoản ${zaloId}): ${err?.message || err} → không kích hoạt`);
      return null;
    }
  }

  private rememberZaloGroupRoles(key: string, roles: ZaloGroupRoles | null): void {
    this.groupRoleCache.delete(key);
    this.groupRoleCache.set(key, roles
      ? { creatorId: roles.creatorId, adminIds: roles.adminIds, at: Date.now() }
      : { creatorId: '', adminIds: [], at: Date.now(), failed: true });
    while (this.groupRoleCache.size > GROUP_ROLE_CACHE_MAX) {
      const oldestKey = this.groupRoleCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.groupRoleCache.delete(oldestKey);
    }
  }

  /**
   * Find an enabled workflow with a trigger.webhook node matching the given token.
   */
  private findWorkflowByWebhookToken(token: string): Workflow | null {
    for (const wf of this.workflows.values()) {
      if (!wf.enabled) continue;
      const triggerNode = wf.nodes.find(n => n.type === 'trigger.webhook');
      if (!triggerNode) continue;
      if (triggerNode.config?.webhookToken === token) return wf;
    }
    return null;
  }

  /**
   * Find enabled workflows with trigger.telegramCommand matching the given bot integration + command.
   */
  public findWorkflowsByTelegramCommand(integrationId: string, command: string, chatId?: string): Workflow[] {
    const results: Workflow[] = [];
    for (const wf of this.workflows.values()) {
      if (!wf.enabled) continue;
      const triggerNode = wf.nodes.find(n => n.type === 'trigger.telegramCommand');
      if (!triggerNode) continue;
      const cfg = triggerNode.config || {};
      // Match integration
      if (cfg.integrationId && cfg.integrationId !== integrationId) continue;
      // Match command (empty = any)
      if (cfg.command && cfg.command !== command) continue;
      // Match chatId filter (empty = any)
      if (cfg.chatIdFilter && cfg.chatIdFilter !== chatId) continue;
      results.push(wf);
    }
    return results;
  }

  /**
   * Handle an incoming webhook request from WebhookGatewayService.
   * Looks up the workflow by webhook token, verifies method, then triggers execution.
   */
  public async handleWebhook(token: string, req: {
    method: string;
    body: any;
    headers: Record<string, string>;
    query: Record<string, string>;
    rawBody: string;
    remoteIp?: string;
  }): Promise<{ status: number; body: any }> {
    const wf = this.findWorkflowByWebhookToken(token);
    if (!wf) {
      Logger.warn('[WorkflowEngine] Webhook token not found: ' + token);
      return { status: 404, body: { success: false, error: 'Webhook not found' } };
    }

    const triggerNode = wf.nodes.find(n => n.type === 'trigger.webhook')!;
    const cfg = triggerNode.config || {};

    // Method check
    const allowedMethod = (cfg.method || 'POST').toUpperCase();
    if (allowedMethod !== 'ANY' && req.method.toUpperCase() !== allowedMethod) {
      Logger.warn('[WorkflowEngine] Webhook ' + token + ': method ' + req.method + ' not allowed (expected ' + allowedMethod + ')');
      return { status: 405, body: { success: false, error: 'Method not allowed' } };
    }

    // IP whitelist check
    if (cfg.allowedIps) {
      const allowedIps = String(cfg.allowedIps).split(',').map(s => s.trim()).filter(Boolean);
      if (allowedIps.length > 0 && req.remoteIp) {
        if (!allowedIps.includes(req.remoteIp)) {
          Logger.warn('[WorkflowEngine] Webhook ' + token + ': IP ' + req.remoteIp + ' not allowed');
          return { status: 403, body: { success: false, error: 'IP not allowed' } };
        }
      }
    }

    // Build event data for triggerWorkflows
    const eventData = {
      webhookToken: token,
      body: req.body || {},
      headers: req.headers || {},
      method: req.method,
      query: req.query || {},
      rawBody: req.rawBody || '',
    };

    // Fire and forget - run workflow async
    this.triggerWorkflows('trigger.webhook', eventData);

    return {
      status: 200,
      body: { success: true, workflowId: wf.id, workflowName: wf.name },
    };
  }

  /**
   * Public API v1 / plugin: fires an event for the trigger.api node. Goes through triggerWorkflows
   * (same pageIds filter, debounce and cooldown as every trigger) and returns the matching workflows.
   */
  public triggerApiEvent(eventName: string, payload: any, meta: { keyId?: string; accountId?: string; source?: string } = {}): { matched: number; workflowIds: string[] } {
    const data = {
      eventName: String(eventName || ''),
      payload: payload ?? {},
      keyId: meta.keyId || '',
      source: meta.source || 'api',
      accountId: meta.accountId || '',
      zaloId: meta.accountId || '',
      receivedAt: Date.now(),
    };
    const matched: string[] = [];
    for (const wf of this.workflows.values()) {
      if (!wf.enabled || !this.isRunnableWorkflow(wf)) continue;
      const node = wf.nodes.find(n => n.type === 'trigger.api');
      if (!node || !this.matchesTriggerFilter(node, data)) continue;
      if (wf.pageIds.length > 0 && data.zaloId && !wf.pageIds.includes(data.zaloId)) continue;
      matched.push(wf.id);
    }
    this.triggerWorkflows('trigger.api', data);
    return { matched: matched.length, workflowIds: matched };
  }

  /**
   * A plugin fires its own trigger (deplao.workflow.trigger). The payload fields sit at the top
   * level so they can be used as {{ $trigger.<field> }}; accountId (if present) is used to filter the workflow's accounts.
   */
  public triggerPluginEvent(type: string, payload: any, meta: { pluginId: string }): { matched: number; workflowIds: string[] } {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload };
    const accountId = String(body.accountId || body.zaloId || '');
    const data = { ...body, payload: body, pluginId: meta.pluginId, accountId, zaloId: accountId, receivedAt: Date.now() };
    const matched: string[] = [];
    for (const wf of this.workflows.values()) {
      if (!wf.enabled || !this.isRunnableWorkflow(wf)) continue;
      const node = wf.nodes.find(n => n.type === type);
      if (!node || !this.matchesTriggerFilter(node, data)) continue;
      if (wf.pageIds.length > 0 && accountId && !wf.pageIds.includes(accountId)) continue;
      matched.push(wf.id);
    }
    this.triggerWorkflows(type, data);
    return { matched: matched.length, workflowIds: matched };
  }

  private matchesTriggerFilter(triggerNode: WorkflowNode, data: any): boolean {
    const cfg = triggerNode.config;

    // Trigger contributed by a plugin (contributes.triggers)
    if ((cfg as any)?.__plugin && (cfg as any)?.__kind === 'trigger') {
      return require('../plugins/PluginNodeRegistry').default.getInstance().matchesTrigger(cfg, data);
    }

    // Public API v1: POST /api/v1/workflows/events/{eventName}
    if (triggerNode.type === 'trigger.api') {
      const wanted = String(cfg?.eventName || '').trim();
      if (wanted && wanted !== String(data?.eventName || '')) return false;
      const requiredKey = String(cfg?.requiredKeyId || '').trim();
      if (requiredKey && requiredKey !== String(data?.keyId || '')) return false;
      return true;
    }

    if (triggerNode.type === 'trigger.message') {
      // data = { zaloId, message } where message is a zca-js UserMessage | GroupMessage:
      //   { type: 0|1, data: TMessage, threadId: string, isSelf: boolean }
      // All payload fields (uidFrom, msgId, ts, dName, content) live inside message.data (msgData)
      const msg  = data.data || data.message || {};           // UserMessage | GroupMessage
      const msgData = (msg as any).data || {};                // TMessage - uidFrom, content, msgId, ts, dName ...
      // type === 1 (ThreadType.Group) is the ONLY reliable group indicator in zca-js
      const isGroup = (msg as any).type === 1 || !!(msg as any).isGroup;
      if (cfg.threadType !== undefined && cfg.threadType !== 'all') {
        if (String(cfg.threadType) === '0' && isGroup) return false;
        if (String(cfg.threadType) === '1' && !isGroup) return false;
      }
      if (cfg.fromId && (msgData.uidFrom || (msg as any).uidFrom || data.fromId) !== cfg.fromId) return false;
      if (cfg.groupId && ((msg as any).threadId || data.threadId) !== cfg.groupId) return false;
      if (cfg.ignoreOwn !== false) {
        if ((msg as any).isSelf || data.isSelf) return false;
      }
      if (cfg.onlyOwn && !((msg as any).isSelf || data.isSelf)) return false;
      if (cfg.keyword) {
        const rawContent = msgData.content || (msg as any).content || data.content;
        // Link cards keep the typed text in content.title, so "/lenh https://…" can match a keyword too
        const content = zaloMessageText(rawContent, msgData.msgType || (msg as any).msgType).toLowerCase();
        const kws: string[] = String(cfg.keyword).split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
        const mode = cfg.keywordMode || 'contains_any';
        if (mode === 'contains_any' && !kws.some(k => content.includes(k))) return false;
        if (mode === 'contains_all' && !kws.every(k => content.includes(k))) return false;
        if (mode === 'equals' && !kws.includes(content)) return false;
        if (mode === 'starts_with' && !kws.some(k => content.startsWith(k))) return false;
        if (mode === 'regex') {
          try { if (!new RegExp(cfg.keyword, 'i').test(content)) return false; } catch { return false; }
        }
      }
      // ── Extended filters: only take effect when configured (old workflows are unchanged) ──
      // senderRole ≠ 'all' only applies to group messages → personal messages do not trigger.
      // The actual role (getGroupInfo) is checked asynchronously in triggerWorkflows.
      if (hasSenderRoleFilter(cfg.senderRole) && !isGroup) return false;
      if (isExcludedId(cfg.excludeSenderIds, msgData.uidFrom || (msg as any).uidFrom || data.fromId)) return false;
      if (!isThreadAllowed(cfg.includeThreadIds, cfg.excludeThreadIds, (msg as any).threadId || data.threadId)) return false;
      if ((cfg.onlyWhenMentioned === true || cfg.onlyWhenMentioned === 'true') && isGroup
        && !mentionsAccount(msgData.mentions, String(data.zaloId || ''))) return false;
      const messageTypes = normalizeMessageTypes(cfg.messageTypes);
      if (messageTypes.length > 0) {
        const rawContent = msgData.content || (msg as any).content || data.content;
        const messageKind = classifyZaloMessageType(msgData.msgType || (msg as any).msgType, rawContent);
        if (!messageTypes.includes(messageKind)) return false;
      }
      if (!isWithinActiveHours(cfg.activeHours, Date.now())) return false;
    }

    if (triggerNode.type === 'trigger.groupEvent') {
      if (cfg.groupId && data.groupId !== cfg.groupId) return false;
      if (cfg.eventType && cfg.eventType !== 'all' && data.eventType !== cfg.eventType) return false;
    }

    if (triggerNode.type === 'trigger.reaction') {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      if (cfg.reactionType && cfg.reactionType !== 'any') {
        // By meaning: workflows saved 😂 (Haha) / 😢 (Buồn), Zalo's reactions now arrive as 😆 / 😭
        if (!sameZaloReactionMeaning(String(data.react || data.reactionType || ''), String(cfg.reactionType))) return false;
      }
    }

    if (triggerNode.type === 'trigger.labelAssigned') {
      // action filter: 'any' | 'assigned' | 'removed'
      if (cfg.action && cfg.action !== 'any' && data.action !== cfg.action) return false;
      // source filter: 'any' | 'local' | 'zalo'
      if (cfg.labelSource && cfg.labelSource !== 'any') {
        const source = String(data.labelSource || CHANNEL.ZALO);
        if (source !== String(cfg.labelSource)) return false;
      }
      // New: labelIds array - contains "source:id" strings
      if (Array.isArray(cfg.labelIds) && cfg.labelIds.length > 0) {
        const eventSrc = String(data.labelSource || CHANNEL.ZALO);
        const matches = cfg.labelIds.some((item: string) => {
          if (typeof item === 'string' && item.includes(':')) {
            const [src, id] = item.split(':');
            return String(data.labelId) === String(id) && eventSrc === src;
          }
          return String(data.labelId) === String(item);
        });
        if (!matches) return false;
      } else {
        // Backward-compat: old single labelId / labelText fields
        if (cfg.labelId && String(data.labelId) !== String(cfg.labelId)) return false;
        if (cfg.labelText) {
          const needle = String(cfg.labelText).toLowerCase().trim();
          if (!String(data.labelText || '').toLowerCase().includes(needle)) return false;
        }
      }
    }

    if (triggerNode.type === 'trigger.payment') {
      // Casso (amount) and SePay (transferAmount / transferType) are already normalized in IntegrationRegistry
      const payment = paymentFromEvent(data);
      // "Khi nhận thanh toán" (on payment received) only for incoming money
      if (payment.direction === 'out') return false;
      // Filter by integration id
      if (cfg.integrationId && data.integrationId !== cfg.integrationId) return false;
      // Filter by minimum amount
      if (cfg.minAmount && payment.amount < Number(cfg.minAmount)) return false;
      // Filter by description keyword (SePay: both the transfer content and the bank's full description)
      if (cfg.descContains) {
        const desc = `${payment.description}\n${payment.bankDescription}`.toLowerCase();
        if (!desc.includes(String(cfg.descContains).toLowerCase())) return false;
      }
    }

    if (triggerNode.type === 'trigger.posWebhook') {
      // Only verified webhooks (IntegrationRegistry → posWebhook.ts); filter by platform / connection / data type / event / status
      if (data?.verified !== true || !matchesPosWebhookTrigger(cfg, data)) return false;
    }

    if (triggerNode.type === 'trigger.webhook') {
      // Method filter - already checked in handleWebhook, but double-check
      if (cfg.method && cfg.method !== 'ANY' && data.method !== cfg.method) return false;
    }

    if (triggerNode.type === 'trigger.telegramCommand') {
      // Integration filter
      if (cfg.integrationId && data.integrationId !== cfg.integrationId) return false;
      // Command filter (empty = any)
      if (cfg.command && cfg.command !== data.command) return false;
      // Chat ID filter (empty = any)
      if (cfg.chatIdFilter && cfg.chatIdFilter !== data.chatId) return false;
    }

    // Telegram Bot callback filter.  A workflow selected directly by an inline
    // button is already narrowed by id; this filter is for generic callbacks.
    if (triggerNode.type === 'tgbot.trigger.callback') {
      if (cfg.accountId && String(cfg.accountId) !== String(data.accountId || data.zaloId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(data.chatId || data.threadId || '')) return false;
      if (cfg.callbackData && String(cfg.callbackData) !== String(data.callbackData || '')) return false;
    }

    if (triggerNode.type === 'tgbot.trigger.message' || triggerNode.type === 'tgbot.trigger.command') {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      const content = String(msg.content || data.content || '');
      if (cfg.accountId && String(cfg.accountId) !== String(data.zaloId || data.accountId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(envelope.threadId || data.threadId || msg.idTo || '')) return false;
      if (cfg.ignoreOwn !== false && (data.isSelf || envelope.isSelf || msg.isSelf)) return false;
      const chatType = String(msg.chatType || data.chatType || (msg.isChannel ? 'channel' : '')).toLowerCase();
      if (cfg.chatScope === 'private' && chatType !== 'private') return false;
      if (cfg.chatScope === 'group' && !['group', 'supergroup'].includes(chatType)) return false;
      if (cfg.chatScope === 'channel' && chatType !== 'channel') return false;
      // Chat allow / deny lists (absent = every chat, as before); same chat id as the chatId filter above
      if (!isThreadAllowed(cfg.includeThreadIds, cfg.excludeThreadIds, envelope.threadId || data.threadId || msg.idTo)) return false;
      if (triggerNode.type === 'tgbot.trigger.command') {
        const command = content.trim().split(/\s+/)[0].replace(/@[^\s]+$/, '').replace(/^\//, '').toLowerCase();
        const commands = [cfg.command, ...String(cfg.aliases || '').split(',')]
          .map((item: string) => item.trim().replace(/^\//, '').toLowerCase()).filter(Boolean);
        if (commands.length && !commands.includes(command)) return false;
        if (cfg.argumentContains && !content.trim().split(/\s+/).slice(1).join(' ').toLowerCase().includes(String(cfg.argumentContains).toLowerCase())) return false;
        const allowed = String(cfg.authorizedUsers || '').split(',').map((item: string) => item.trim()).filter(Boolean);
        if (allowed.length && !allowed.includes(String(msg.uidFrom || data.fromId || ''))) return false;
      }
      if (triggerNode.type === 'tgbot.trigger.message') {
        if (cfg.fromId && String(cfg.fromId) !== String(msg.uidFrom || data.fromId || '')) return false;
        if (cfg.messageTypes && cfg.messageTypes !== 'all' && String(msg.msgType || data.msgType || 'text') !== cfg.messageTypes) return false;
        const keywords = String(cfg.keyword ?? '').split(',').map((item: string) => item.trim().toLowerCase()).filter(Boolean);
        // /commands belong to "Khi user gửi lệnh cho Bot": answering them here too gave customers two replies. A keyword
        // that itself starts with "/" (or the option turned off) still lets this trigger take commands.
        if (isBotCommandText(content) && cfg.ignoreCommands !== false && !keywords.some((item: string) => item.startsWith('/'))) return false;
        if (keywords.length) {
          const normalized = content.toLowerCase();
          const mode = cfg.keywordMode || 'contains_any';
          const matched = mode === 'contains_all' ? keywords.every((item: string) => normalized.includes(item))
            : mode === 'exact' ? keywords.some((item: string) => normalized === item)
            : mode === 'starts_with' ? keywords.some((item: string) => normalized.startsWith(item))
            : keywords.some((item: string) => normalized.includes(item));
          if (!matched) return false;
        }
      }
    }

    if (triggerNode.type === 'tgbot.trigger.join') {
      if (cfg.accountId && String(cfg.accountId) !== String(data.accountId || data.zaloId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(data.chatId || data.threadId || '')) return false;
      if (cfg.eventType && cfg.eventType !== 'all' && cfg.eventType !== data.eventType) return false;
    }

    if (triggerNode.type === 'tgbot.trigger.joinRequest') {
      if (cfg.accountId && String(cfg.accountId) !== String(data.accountId || data.zaloId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(data.chatId || data.threadId || '')) return false;
    }

    if (triggerNode.type === 'tgbot.trigger.memberUpdate') {
      if (cfg.accountId && String(cfg.accountId) !== String(data.accountId || data.zaloId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(data.chatId || data.threadId || '')) return false;
      if (cfg.eventType && cfg.eventType !== 'all' && cfg.eventType !== data.eventType) return false;
      // Other bots joining (e.g. a moderation bot) are usually not people to greet
      if (cfg.ignoreBots !== false && data.isBot) return false;
    }

    if (triggerNode.type === 'tgbot.trigger.editedMessage') {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      const content = String(msg.content || data.content || '');
      if (cfg.accountId && String(cfg.accountId) !== String(data.accountId || data.zaloId || '')) return false;
      if (cfg.chatId && String(cfg.chatId) !== String(data.chatId || data.threadId || msg.idTo || '')) return false;
      const chatType = String(msg.chatType || data.chatType || '').toLowerCase();
      if (cfg.chatScope === 'private' && chatType !== 'private') return false;
      if (cfg.chatScope === 'group' && !['group', 'supergroup'].includes(chatType)) return false;
      if (cfg.chatScope === 'channel' && chatType !== 'channel') return false;
      if (cfg.keyword) {
        const keywords = String(cfg.keyword).split(',').map((item: string) => item.trim().toLowerCase()).filter(Boolean);
        const normalized = content.toLowerCase();
        const mode = cfg.keywordMode || 'contains_any';
        const matched = mode === 'contains_all' ? keywords.every((item: string) => normalized.includes(item))
          : mode === 'exact' ? keywords.some((item: string) => normalized === item)
          : mode === 'starts_with' ? keywords.some((item: string) => normalized.startsWith(item))
          : keywords.some((item: string) => normalized.includes(item));
        if (!matched) return false;
      }
    }

    // ── Facebook trigger matching ───────────────────────────────────────────
    if (triggerNode.type === 'fb.trigger.message') {
      // Filter by threadId
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      // Filter by threadType using the source's explicit discriminator. Both
      // Facebook users and groups may have a numeric ID, so ID shape is never
      // a safe routing signal here.
      if (cfg.threadType !== undefined && cfg.threadType !== 'all') {
        const sourceType = data.typeChat ?? data.message?.type;
        const isGroup = sourceType === null || sourceType === 'group';
        const isUser = sourceType === 'user';
        // Do not guess when a legacy event has no discriminator. This is
        // preferable to firing a "group only" workflow for a personal chat.
        if (!isGroup && !isUser) return false;
        if (String(cfg.threadType) === '0' && isGroup) return false;
        if (String(cfg.threadType) === '1' && !isGroup) return false;
      }
      // Filter by sender (fromId)
      if (cfg.fromId) {
        const senderId = data.fromId || (data.message || {}).userID || '';
        if (senderId !== cfg.fromId) return false;
      }
      // Filter by group (groupId)
      if (cfg.groupId && data.threadId !== cfg.groupId) return false;
      // Ignore own messages (default true)
      if (cfg.ignoreOwn !== false) {
        const msg = data.message || {};
        if (msg.isSelf || data.isSelf) return false;
      }
      // Only own messages
      if (cfg.onlyOwn && !((data.message || {}).isSelf || data.isSelf)) return false;
      // Keyword filter
      if (cfg.keyword) {
        const content = String(data.content || data.message?.body || '').toLowerCase();
        const kws: string[] = String(cfg.keyword).split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
        const mode = cfg.keywordMode || 'contains_any';
        if (mode === 'contains_any' && !kws.some(k => content.includes(k))) return false;
        if (mode === 'contains_all' && !kws.every(k => content.includes(k))) return false;
        if (mode === 'equals' && !kws.includes(content)) return false;
        if (mode === 'starts_with' && !kws.some(k => content.startsWith(k))) return false;
        if (mode === 'regex') {
          try {
            if (!(new RegExp(String(cfg.keyword), 'i')).test(content)) return false;
          } catch {
            // An invalid user pattern must not turn the filter into match-all.
            return false;
          }
        }
      }
      // ── Extended filters (excludeSenderIds / includeThreadIds / excludeThreadIds / activeHours) ──
      if (isExcludedId(cfg.excludeSenderIds, data.fromId || (data.message || {}).userID)) return false;
      if (!isThreadAllowed(cfg.includeThreadIds, cfg.excludeThreadIds, this.getFacebookThreadId(data))) return false;
      if (!isWithinActiveHours(cfg.activeHours, Date.now())) return false;
    }

    // ── Facebook media attachment triggers ────────────────────────────────
    if (['fb.trigger.image', 'fb.trigger.video', 'fb.trigger.file', 'fb.trigger.sticker'].includes(triggerNode.type)) {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      // Also verify the message actually has the matching attachment type
      const msg = data?.message || {};
      const att = msg.attachments || {};
      const attType = (att.attachmentType || '').toLowerCase();
      const expectedType = triggerNode.type.split('.').pop(); // image | video | file | sticker
      if (expectedType === 'file' && attType !== 'file' && attType !== 'audio') return false;
      if (expectedType === 'image' && attType !== 'image' && attType !== 'photo') return false;
      if (expectedType !== 'file' && expectedType !== 'image' && attType !== expectedType) return false;
    }

    // ── Facebook reaction trigger ─────────────────────────────────────────
    if (triggerNode.type === 'fb.trigger.reaction') {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      if (cfg.reactionType && cfg.reactionType !== 'any') {
        // FB event uses 'emoji' field; Zalo uses 'react'/'reactionType'
        const actualEmoji = data.emoji || data.react || data.reactionType || '';
        if (String(actualEmoji) !== String(cfg.reactionType)) return false;
      }
    }

    // ── Facebook unsend trigger ───────────────────────────────────────────
    if (triggerNode.type === 'fb.trigger.unsend') {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
    }

    // ── Facebook group event trigger ──────────────────────────────────────
    if (triggerNode.type === 'fb.trigger.groupEvent') {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      if (cfg.eventType && cfg.eventType !== 'all' && data.type !== cfg.eventType) return false;
    }

    // ── Telegram message trigger ──────────────────────────────────────────
    if (triggerNode.type === 'tg.trigger.message') {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      // Filter by chatId (empty = any)
      if (cfg.chatId) {
        const msgChatId = data.threadId || envelope.threadId || msg.threadId || msg.chatId || '';
        if (msgChatId !== cfg.chatId) return false;
      }
      // Filter by chatType (user/group/channel/topic)
      if (cfg.chatType && cfg.chatType !== 'all') {
        const chatId = String(data.threadId || envelope.threadId || msg.threadId || msg.chatId || '');
        const isGroup = chatId.startsWith('-') && !chatId.startsWith('-100');
        const isSupergroup = chatId.startsWith('-100');
        const isChannel = !!msg.isChannel || !!data.isChannel;
        const hasTopic = !!msg.topicId;
        if (cfg.chatType === 'user' && (isGroup || isSupergroup || isChannel)) return false;
        if (cfg.chatType === 'group' && ((!isGroup && !isSupergroup) || isChannel)) return false;
        if (cfg.chatType === 'channel' && !isChannel) return false;
        if (cfg.chatType === 'topic' && !hasTopic) return false;
      }
      // Filter by sender (fromId)
      if (cfg.fromId) {
        const senderId = String(data.fromId || msg.fromId || msg.senderId || msg.uidFrom || '');
        if (senderId !== cfg.fromId) return false;
      }
      // Ignore own messages (default true)
      if (cfg.ignoreOwn !== false) {
        if (data.isSelf || envelope.isSelf || msg.isSelf) return false;
      }
      // Keyword filter
      if (cfg.keyword) {
        const content = String(data.content || msg.content || msg.text || '').toLowerCase();
        const kws: string[] = String(cfg.keyword).split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
        const mode = cfg.keywordMode || 'contains_any';
        if (mode === 'contains_any' && !kws.some(k => content.includes(k))) return false;
        if (mode === 'contains_all' && !kws.every(k => content.includes(k))) return false;
        if (mode === 'exact' && !kws.includes(content)) return false;
        if (mode === 'starts_with' && !kws.some(k => content.startsWith(k))) return false;
      }
      // ── Extended filters (excludeSenderIds / includeThreadIds / excludeThreadIds / activeHours) ──
      if (isExcludedId(cfg.excludeSenderIds, data.fromId || msg.fromId || msg.senderId || msg.uidFrom)) return false;
      if (!isThreadAllowed(cfg.includeThreadIds, cfg.excludeThreadIds, data.threadId || envelope.threadId || msg.threadId || msg.chatId)) return false;
      if (!isWithinActiveHours(cfg.activeHours, Date.now())) return false;
    }

    // ── Telegram unsend trigger ──────────────────────────────────────────
    if (triggerNode.type === 'tg.trigger.unsend') {
      if (cfg.chatId) {
        const chatId = data.threadId || '';
        if (chatId !== cfg.chatId) return false;
      }
    }

    // ── Telegram group event trigger ─────────────────────────────────────
    if (triggerNode.type === 'tg.trigger.groupEvent') {
      if (cfg.chatId) {
        const chatId = data.groupId || data.threadId || '';
        if (chatId !== cfg.chatId) return false;
      }
      if (cfg.eventType && cfg.eventType !== 'all') {
        const eventType = data.eventType || data.type || '';
        if (eventType !== cfg.eventType) return false;
      }
    }

    return true;
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  public async executeWorkflow(
    wf: Workflow,
    triggerData: any,
    triggeredBy: string = 'manual',
    startNodeId?: string,
    opts?: { simulate?: boolean },
  ): Promise<WorkflowRunLog> {
    if (!this.isRunnableWorkflow(wf)) {
      throw new Error(tr('Workflow không hỗ trợ chạy (channel unknown)'));
    }

    const simulate = opts?.simulate === true;
    const runId = uuidv4();
    const startedAt = Date.now();
    const nodeResults: NodeResult[] = [];
    const simulatedMessages: SimulatedMessage[] = [];

    const telegramChannelTrace = triggeredBy === 'tg.trigger.message'
      ? getTelegramChannelTrace(triggerData)
      : null;
    logTelegramChannelTrace('WORKFLOW_EXECUTION_STARTED', telegramChannelTrace, {
      workflowId: wf.id,
      runId,
      startNodeId: startNodeId || '-',
    });

    // Flatten trigger data for template access
    const flatTrigger = this.flattenTriggerData(triggerData, triggeredBy);

    const context: ExecutionContext = {
      trigger: flatTrigger,
      nodes: {},
      variables: {},
      pageId: this.resolveRunAccount(wf, triggerData),
      skippedNodes: new Set(),
      _wfNodes: wf.nodes,
      _wfName: wf.name,
    };

    const sortedOrder = this.topologicalSort(wf);
    const routeNodes = startNodeId ? this.getReachableWorkflowNodes(wf, startNodeId) : null;
    // The normal run never enters the branches of Telegram Bot inline buttons: they wait for the button press
    const buttonOnly = startNodeId ? null : this.inlineButtonOnlyNodes(wf, triggeredBy);
    const order = routeNodes
      ? sortedOrder.filter(nodeId => routeNodes.has(nodeId))
      : sortedOrder.filter(nodeId => !buttonOnly?.has(nodeId));
    const run: WorkflowRunState = { status: 'success', nodeResults, simulate, simulatedMessages, loopIterations: 0 };
    await this.runNodeSequence(order, wf, context, run);
    const { status, errorMessage } = run;

    const log: WorkflowRunLog = {
      id: runId, workflowId: wf.id, workflowName: wf.name,
      triggeredBy, startedAt, finishedAt: Date.now(),
      status, errorMessage, nodeResults,
      ...(simulate ? { simulated: true, simulatedMessages } : {}),
    };

    if (!simulate) {
      DatabaseService.getInstance().saveWorkflowRunLog(log);
      EventBroadcaster.emit('workflow:executed', { workflowId: wf.id, runId, status });
    }
    logTelegramChannelTrace('WORKFLOW_EXECUTION_FINISHED', telegramChannelTrace, {
      workflowId: wf.id,
      runId,
      status,
      nodeCount: nodeResults.length,
      durationMs: log.finishedAt - startedAt,
      error: errorMessage || '-',
    });
    return log;
  }

  /**
   * Account a run sends from: the account that received the event when it belongs to the workflow (a workflow set up for
   * several accounts used to always answer from the first one, i.e. from an account that is not in the conversation),
   * otherwise the workflow's first account (schedule, manual, webhook…).
   */
  private resolveRunAccount(wf: Workflow, triggerData: any): string {
    const eventAccount = String(triggerData?.zaloId || triggerData?.fbAccountId || triggerData?.accountId || '').trim();
    if (eventAccount && (!wf.pageIds.length || wf.pageIds.includes(eventAccount))) return eventAccount;
    return wf.pageIds[0] || wf.pageId || eventAccount || '';
  }

  /**
   * Runs the nodes in topological order. When the "Lặp qua danh sách" (loop over list, logic.forEach) node finishes, the nodes wired from its
   * "Mỗi phần tử" (for each item, forEachBodyNodeIds) port run again for each item, then this chain runs the remaining nodes. The
   * "Xong" (done) branch runs once. Returns false when the workflow must stop (Stop workflow if…, or a node error without "tiếp tục khi lỗi" (continue on error) enabled).
   */
  private async runNodeSequence(order: string[], wf: Workflow, ctx: ExecutionContext, run: WorkflowRunState, iteration?: number): Promise<boolean> {
    const loopHandled = new Set<string>();
    for (const nodeId of order) {
      if (loopHandled.has(nodeId)) continue;
      const node = wf.nodes.find(n => n.id === nodeId);
      if (!node) continue;
      const step = await this.runWorkflowNode(node, wf, ctx, run, iteration);
      if (step === 'halt') return false;
      if (node.type !== 'logic.forEach' || step === 'skipped') continue;
      const bodyIds = forEachBodyNodeIds(wf.edges, nodeId);
      const body = order.filter(id => bodyIds.has(id));
      if (step === 'failed') {
        // Loop node failed but "tiếp tục khi lỗi" (continue on error) is on: no list → the loop body does not run, the "Xong" branch still runs
        for (const id of body) ctx.skippedNodes.add(id);
        continue;
      }
      body.forEach(id => loopHandled.add(id));
      if (!(await this.runForEachLoop(node, body, wf, ctx, run))) return false;
    }
    return true;
  }

  /**
   * Loop body for each item of the forEach node that just ran (output.items, up to the "Tối đa" (max) field / 100 items).
   * Each pass: {{ $var.<variable name> }} = the item, {{ $var.<variable name>Index }} = the position from 1; skipped branches (IF / Switch)
   * and node results from the previous pass are cleared. Other variables saved inside the loop (save value to variable node) remain after the loop
   * for the "Xong" branch to use (e.g. join a list, then send one message).
   */
  private async runForEachLoop(node: WorkflowNode, body: string[], wf: Workflow, ctx: ExecutionContext, run: WorkflowRunState): Promise<boolean> {
    const output = ctx.nodes[node.id]?.output || {};
    const items: any[] = Array.isArray(output.items) ? output.items.slice(0, forEachItemLimit(node.config?.maxItems)) : [];
    if (items.length === 0) {
      for (const id of body) {
        const bodyNode = wf.nodes.find(n => n.id === id);
        if (bodyNode) {
          run.nodeResults.push({
            nodeId: id, nodeType: bodyNode.type, label: bodyNode.label, status: 'skipped', input: {},
            output: { _skipped: true, reason: tr('Danh sách rỗng - không có phần tử để lặp') }, durationMs: 0,
          });
        }
      }
      return true;
    }

    const itemVar = forEachVariableName(node.config?.itemVariable);
    const indexVar = `${itemVar}Index`;
    const saved = [itemVar, indexVar].map(key => ({
      key, had: Object.prototype.hasOwnProperty.call(ctx.variables, key), value: ctx.variables[key],
    }));
    const baseSkipped = new Set(ctx.skippedNodes);
    // Same rule as forEachRecipient: workflow disabled / deleted while looping → stop, do not run the remaining items
    const existedAtStart = this.workflows.has(wf.id);
    const stopped = (): boolean => {
      const live = this.workflows.get(wf.id);
      return live ? (wf.enabled && !live.enabled) : existedAtStart;
    };
    try {
      for (let i = 0; i < items.length; i++) {
        if (i > 0 && stopped()) {
          run.status = 'error';
          run.errorMessage = tr('Node "{{v1}}": workflow đã tắt hoặc bị xoá — dừng lặp, còn {{v2}}/{{count}} phần tử chưa chạy', { v1: node.label || node.type, v2: items.length - i, count: items.length });
          return false;
        }
        if (++run.loopIterations > MAX_LOOP_ITERATIONS_PER_RUN) {
          run.status = 'error';
          run.errorMessage = tr('Node "{{v1}}" lỗi: vượt quá {{MAX_LOOP_ITERATIONS_PER_RUN}} lượt lặp trong một lần chạy', { v1: node.label || node.type, MAX_LOOP_ITERATIONS_PER_RUN });
          return false;
        }
        ctx.variables[itemVar] = items[i];
        ctx.variables[indexVar] = i + 1;
        ctx.skippedNodes = new Set(baseSkipped);
        for (const id of body) delete ctx.nodes[id];
        if (!(await this.runNodeSequence(body, wf, ctx, run, i + 1))) return false;
      }
      return true;
    } finally {
      ctx.skippedNodes = baseSkipped;
      for (const entry of saved) {
        if (entry.had) ctx.variables[entry.key] = entry.value;
        else delete ctx.variables[entry.key];
      }
    }
  }

  /**
   * Runs one node: skips it if it sits on a branch that does not run, renders the config, runs it (or simulates it), saves the result, and marks
   * the not-run branches of IF / Switch. 'halt' = stop the whole workflow (Stop workflow if…, or an error without "tiếp tục khi lỗi" (continue on error) enabled),
   * 'failed' = the node failed but the workflow keeps going (partial status).
   */
  private async runWorkflowNode(
    node: WorkflowNode,
    wf: Workflow,
    context: ExecutionContext,
    run: WorkflowRunState,
    iteration?: number,
  ): Promise<'ran' | 'skipped' | 'failed' | 'halt'> {
    const nodeId = node.id;
    const nodeResults = run.nodeResults;
    const loopTag = iteration ? { iteration } : {};
    const t0 = Date.now();

    if (context.skippedNodes.has(nodeId)) {
      nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'skipped', input: {}, output: { _skipped: true }, durationMs: 0, ...loopTag });
      // Propagate skip to downstream nodes
      this.markDownstreamSkipped(nodeId, wf, context.skippedNodes);
      return 'skipped';
    }

    let renderedConfig: Record<string, any> = {};
    try {
      renderedConfig = this.renderConfig(node.config, context);
      if (node.type === 'zalo.sendMessage') {
        Logger.info(`[WorkflowEngine] sendMessage BEFORE: raw="${(node.config.message || '').substring(0, 300)}" → rendered="${(renderedConfig.message || '').substring(0, 300)}"`);
      }
      const isTriggerNode = node.type.startsWith('trigger.') || node.type.includes('.trigger.');
      const output = run.simulate && !isTriggerNode && !SIMULATE_REAL_TYPES.has(node.type)
        ? this.simulateNode(node, renderedConfig, context)
        : await this.executeNode(node, renderedConfig, context, wf);
      context.nodes[nodeId] = { output };
      // A node that reports { success: false, error } did not do its job (Telegram / Bot / Facebook helpers return instead of
      // throwing): it is recorded as a failure, so the run log is red and "Tiếp tục khi lỗi" decides whether the workflow goes
      // on. The output stays readable by later steps ({{ $node.<id>.error }}).
      if (output && typeof output === 'object' && output.success === false && typeof output.error === 'string' && output.error.trim()) {
        throw new Error(output.error);
      }

      // Simulate: capture outbound messages for the mock chat (in execution order)
      if (run.simulate && OUTBOUND_SEND_RE.test(node.type)) {
        const text = outboundText(renderedConfig);
        if (text.trim()) {
          run.simulatedMessages.push({
            nodeId,
            label: node.label,
            type: node.type,
            text,
            threadId: String(renderedConfig.threadId || renderedConfig.chatId || renderedConfig.threadIds || ''),
          });
        }
      }
      if (node.type === 'ai.generateText') {
        Logger.info(`[WorkflowEngine] AI chat output stored: keys=${output ? Object.keys(output).join(',') : 'null'}, result="${typeof output === 'object' && output ? (output.result || '').substring(0, 200) : String(output).substring(0, 200)}"`);
      }

      // If this is an IF node, mark the wrong branch as skipped
      if (node.type === 'logic.if') {
        const result = output.result as boolean;
        for (const edge of wf.edges.filter(e => e.source === nodeId)) {
          if (edge.sourceHandle === 'true' && !result) {
            context.skippedNodes.add(edge.target);
            this.markDownstreamSkipped(edge.target, wf, context.skippedNodes);
          }
          if (edge.sourceHandle === 'false' && result) {
            context.skippedNodes.add(edge.target);
            this.markDownstreamSkipped(edge.target, wf, context.skippedNodes);
          }
        }
      }

      // switch node: mark all non-matching cases
      if (node.type === 'logic.switch') {
        const matchedHandle = output.matchedHandle as string;
        for (const edge of wf.edges.filter(e => e.source === nodeId)) {
          if (edge.sourceHandle !== matchedHandle) {
            context.skippedNodes.add(edge.target);
            this.markDownstreamSkipped(edge.target, wf, context.skippedNodes);
          }
        }
      }

      nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: this.truncateData(renderedConfig), output: this.truncateData(output), durationMs: Date.now() - t0, ...loopTag });
      return 'ran';
    } catch (err: any) {
      // logic.stopIf signals a graceful stop - treat as success, halt loop
      if (err.message === '__STOP__') {
        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: this.truncateData(renderedConfig), output: { stopped: true }, durationMs: Date.now() - t0, ...loopTag });
        return 'halt';
      }
      // Build rich error output from axios/HTTP errors
      const errorOutput: Record<string, any> = {};
      errorOutput._errorType = 'execution_error';
      if (err.response) {
        errorOutput._errorType = 'http_error';
        errorOutput._httpStatus = err.response.status;
        errorOutput._httpStatusText = err.response.statusText;
        errorOutput._responseData = this.truncateData(err.response.data);
        errorOutput._responseHeaders = err.response.headers;
      } else if (err.request) {
        errorOutput._errorType = 'network_error';
        errorOutput._requestSummary = `${err.request.method || ''} ${err.request.url || ''}`;
      }
      if (err.code) errorOutput._errorCode = err.code;
      if (err.message) errorOutput._errorMessage = err.message;
      if (err.stack) errorOutput._stackTrace = err.stack.split('\n').slice(0, 6).join('\n');
      nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'error', input: this.truncateData(renderedConfig), output: this.truncateData(errorOutput), durationMs: Date.now() - t0, error: err.message, ...loopTag });
      if (node.config.continueOnError) {
        run.status = 'partial';
        return 'failed';
      }
      run.status = 'error';
      run.errorMessage = tr('Node "{{v1}}" lỗi: {{message}}', { v1: node.label || node.type, message: err.message });
      return 'halt';
    }
  }

  private markDownstreamSkipped(nodeId: string, wf: Workflow, skipped: Set<string>): void {
    for (const edge of wf.edges.filter(e => e.source === nodeId && !e.data?.telegramInline)) {
      if (!skipped.has(edge.target)) {
        skipped.add(edge.target);
        this.markDownstreamSkipped(edge.target, wf, skipped);
      }
    }
  }

  private flattenTriggerData(data: any, triggerType: string): Record<string, any> {
    if (!data) return {};
    if (triggerType === 'trigger.message' || triggerType.startsWith('event:message')) {
      // data = { zaloId, message } where message is zca-js UserMessage | GroupMessage:
      //   { type: 0|1 (ThreadType), data: TMessage, threadId: string, isSelf: boolean }
      // All payload fields live inside message.data (msgData), NOT at top-level of message.
      const msg     = data.data || data.message || {};           // UserMessage | GroupMessage
      const msgData = (msg as any).data || {};                   // TMessage: uidFrom, msgId, ts, dName, content...
      // type === 1 (ThreadType.Group) is the ONLY reliable group indicator in zca-js
      const isGroup   = (msg as any).type === 1 || !!(msg as any).isGroup || !!(data.isGroup);
      const threadType = data.threadType !== undefined
        ? Number(data.threadType)
        : (isGroup ? 1 : 0);
      const rawContent = msgData.content || (msg as any).content || data.content;
      const msgType = String(msgData.msgType || (msg as any).msgType || '');
      let content = String((rawContent as any)?.msg || (typeof rawContent === 'string' ? rawContent : '') || '');
      // Link cards (chat.recommended) often store user text inside content.title, not content.msg.
      if (!content && rawContent && typeof rawContent === 'object') {
        if (msgType === 'chat.recommended' || msgType === 'chat.link') {
          content = String((rawContent as any).title || (rawContent as any).href || '');
        } else {
          content = String((rawContent as any).title || '');
        }
      }
      // Extract image URLs from message content for $trigger.images
      const images: string[] = [];
      if (rawContent && typeof rawContent === 'object') {
        let params: any = (rawContent as any).params;
        if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
        const hdUrl = params?.hd || params?.rawUrl || '';
        if (hdUrl) images.push(hdUrl);
        const thumbUrl = (rawContent as any).thumb || (rawContent as any).normalUrl || (rawContent as any).hdUrl || '';
        if (thumbUrl && !images.includes(thumbUrl)) images.push(thumbUrl);
      }
      const fromId = msgData.uidFrom    || (msg as any).uidFrom    || data.fromId    || '';
      return {
        fromId,
        fromName:    data.fromName      || msgData.dName            || msgData.senderInfo?.displayName
          || msgData.senderInfo?.zaloName || msgData.senderInfo?.name || (msg as any).fromName || '',
        // Zalo messages do not carry a phone number → use the sender's saved phone (contacts / contact info)
        fromPhone:   data.fromPhone     || (msg as any).fromPhone   || this.getSavedContactPhone(data.zaloId, fromId),
        content,
        images,
        threadId:    (msg as any).threadId || data.threadId        || msgData.idTo   || '',
        threadType,
        isGroup,
        groupName:   data.groupName     || (msg as any).groupName  || msgData.groupName
          || msgData.groupInfo?.name || msgData.group?.name || '',
        msgId:       msgData.msgId      || (msg as any).msgId       || data.msgId    || '',
        cliMsgId:    msgData.cliMsgId   || (msg as any).cliMsgId    || data.cliMsgId || '',
        timestamp:   Number(msgData.ts) || Number((msg as any).ts) || data.timestamp || Date.now(),
        isSelf:      !!((msg as any).isSelf || data.isSelf),
        zaloId:      data.zaloId || '',
      };
    }
    if (triggerType === 'trigger.friendRequest' || triggerType.startsWith('event:friendRequest')) {
      const d = data.requester || data.data || data;
      return {
        userId: d.userId || d.uid || data.userId || '',
        displayName: d.displayName || d.dName || data.displayName || '',
        phone: d.phone || d.phoneNumber || data.phone || '',
        message: d.msg || d.message || data.message || '',
        zaloId: data.zaloId || '',
      };
    }
    if (triggerType === 'trigger.groupEvent' || triggerType.startsWith('event:groupEvent')) {
      const d = data.data || data;
      const members: any[] = d.updateMembers || [];
      const groupId = data.groupId || d.groupId || '';
      const memberNames = members.map((m: any) => m.dName || m.zaloName || m.id || '').filter(Boolean).join(', ');
      return {
        groupId,
        // The group conversation itself: a send node right after a group event replies in the group (type 1)
        threadId: groupId,
        threadType: 1,
        eventType: data.eventType || '',
        actorName: members[0]?.dName || members[0]?.zaloName || '',
        targetNames: memberNames,
        memberNames,
        memberIds: members.map((m: any) => String(m.id || '')).filter(Boolean).join(','),
        systemText: data.systemText || '',
        zaloId: data.zaloId || '',
      };
    }
    if (triggerType === 'trigger.reaction' || triggerType.startsWith('event:reaction')) {
      const msgId = data.msgId || '';
      // Group or personal conversation: from the event, otherwise from the reacted message in the DB
      let threadType: number | '' = data.threadType !== undefined && data.threadType !== '' ? Number(data.threadType)
        : data.isGroup !== undefined ? (data.isGroup ? 1 : 0) : '';
      if (threadType === '' && msgId) {
        try {
          const stored: any = DatabaseService.getInstance().getMessageById(data.zaloId || '', String(msgId), data.threadId || undefined);
          if (stored && stored.thread_type !== undefined && stored.thread_type !== null) threadType = Number(stored.thread_type) === 1 ? 1 : 0;
        } catch {}
      }
      return {
        fromId: data.uidFrom || data.fromId || '',
        fromName: data.fromName || '',
        msgId,
        threadId: data.threadId || '',
        threadType: threadType === '' ? 0 : threadType,
        react: data.react || data.reactionType || '',
        zaloId: data.zaloId || '',
      };
    }
    if (triggerType === 'trigger.labelAssigned') {
      return {
        zaloId:      data.zaloId || '',
        threadId:    data.threadId || '',
        threadType:  data.threadType ?? 0,
        labelId:     data.labelId ?? '',
        labelText:   data.labelText || '',
        labelColor:  data.labelColor || '',
        labelEmoji:  data.labelEmoji || '',
        labelSource: data.labelSource || CHANNEL.ZALO,
        action:      data.action || 'assigned',   // 'assigned' | 'removed'
      };
    }
    if (triggerType === 'trigger.payment' || triggerType === 'integration:payment') {
      const payment = paymentFromEvent(data);
      return {
        integrationId:   data.integrationId || '',
        integrationType: data.integrationType || '',
        amount:          payment.amount,
        description:     payment.description,
        bankName:        payment.bankName,
        accountNumber:   payment.accountNumber,
        transactionId:   payment.transactionId,
        transactionDate: payment.transactionDate,
        raw:             data.transaction || data,
      };
    }
    if (triggerType === 'trigger.posWebhook') {
      return {
        integrationId:   data.integrationId || '',
        integrationType: data.integrationType || '',
        integrationName: data.integrationName || '',
        event:           data.event || '',
        entity:          data.entity || '',
        code:            data.code || '',
        status:          data.status || '',
        customerName:    data.customerName || '',
        customerPhone:   data.customerPhone || '',
        // The POS lookup node uses {{ $trigger.fromPhone }} by default → the customer's phone number from the order / the customer who just sent the message
        fromPhone:       data.customerPhone || '',
        total:           data.total || '',
        data:            data.data ?? {},
      };
    }
    if (triggerType === 'trigger.webhook') {
      return {
        webhookToken: data.webhookToken || '',
        body:         data.body || {},
        headers:      data.headers || {},
        method:       data.method || 'POST',
        query:        data.query || {},
        rawBody:      data.rawBody || '',
      };
    }
    if (triggerType === 'fb.trigger.unsend') {
      // fb:onUnsend: { fbAccountId, messageId }
      return {
        fbAccountId: data.fbAccountId || '',
        messageId: data.messageId || '',
        threadId: data.threadId || '',
        fromId: '',
        content: '',
        body: '',
        attachments: null,
        isSelf: false,
        emoji: '',
        timestamp: Date.now(),
      };
    }
    if (triggerType === 'fb.trigger.groupEvent') {
      // fb:onGroupEvent: { fbAccountId, threadId, type, participantId, participants, actorFbId }
      return {
        fbAccountId: data.fbAccountId || '',
        messageId: '',
        threadId: data.threadId || '',
        fromId: data.actorFbId || '',
        fromName: this.getSavedContactName(data.fbAccountId, data.actorFbId),
        content: '',
        body: '',
        groupEventType: data.type || '',
        participantId: data.participantId || '',
        participantName: this.getSavedContactName(data.fbAccountId, data.participantId),
        participants: data.participants || [],
        actorFbId: data.actorFbId || '',
        attachments: null,
        isSelf: false,
        emoji: '',
        timestamp: Date.now(),
      };
    }
    if (triggerType.startsWith('fb.trigger.')) {
      const msg = data.message || {};
      const fbFromId = msg.userID || data.userId || data.fromId || '';
      return {
        fbAccountId: data.fbAccountId || '',
        // fb:onMessage carries the message id in message.messageID (fb:onReaction has messageId at the top level)
        messageId: data.messageId || msg.messageID || msg.messageId || '',
        threadId: data.threadId || msg.threadId || msg.replyToID || '',
        fromId: fbFromId,
        // Facebook events carry no sender name: the saved contact name (alias first), as shown in the chat list
        fromName: data.fromName || msg.senderName || this.getSavedContactName(data.fbAccountId, fbFromId),
        content: msg.body || '',
        body: msg.body || '',
        attachments: msg.attachments || null,
        isSelf: !!(msg.isSelf || data.isSelf),
        emoji: data.emoji || '',
        msgType: msg.type || msg.attachments?.attachmentType || '',
        timestamp: Number(msg.timestamp || data.timestamp || msg.timestamp_precise || Date.now()),
        // Numeric Facebook group IDs cannot be detected from their shape.
        // Retain the tri-state discriminator for downstream send actions.
        typeChat: msg.type === 'user' ? 'user' : msg.type === 'group' ? null : undefined,
      };
    }
    // ── Telegram Bot trigger flattening ────────────────────────────────────
    if (triggerType.startsWith('tgbot.trigger.')) {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      const content = String(msg.content || data.content || '');
      // "/donhang 0901…" → {{ $trigger.command }} = donhang, {{ $trigger.args }} = 0901…
      const { command, args } = parseBotCommand(content);
      return {
        command,
        args,
        // Member join / leave (tgbot.trigger.memberUpdate) and join requests
        memberId: data.memberId || (triggerType === 'tgbot.trigger.joinRequest' ? data.fromId || '' : ''),
        memberName: data.memberName || (triggerType === 'tgbot.trigger.joinRequest' ? data.fromName || '' : ''),
        memberUsername: data.memberUsername || '',
        isBot: !!data.isBot,
        accountId: data.accountId || data.zaloId || '',
        chatId: data.chatId || envelope.threadId || data.threadId || msg.idTo || '',
        threadId: data.chatId || envelope.threadId || data.threadId || msg.idTo || '',
        fromId: data.fromId || msg.uidFrom || '',
        fromName: data.fromName || msg.dName || '',
        content,
        body: content,
        messageId: data.messageId || msg.msgId || '',
        callbackQueryId: data.callbackQueryId || '',
        callbackData: data.callbackData || '',
        isSelf: !!(data.isSelf || envelope.isSelf || msg.isSelf),
        channel: 'telegram_bot',
        timestamp: Number(msg.ts || data.timestamp || Date.now()),
        eventType: data.eventType || '',
        chatTitle: data.chatTitle || '',
        chatType: data.chatType || '',
        actorId: data.actorId || '',
        actorName: data.actorName || '',
      };
    }
    // ── Telegram trigger flattening ─────────────────────────────────────────
    if (triggerType === 'tg.trigger.groupEvent') {
      // { zaloId, channel, groupId, eventType: member_join | member_leave, data: { updateMembers: [{ id, dName }] }, systemText }
      const members: any[] = Array.isArray(data?.data?.updateMembers) ? data.data.updateMembers : [];
      const chatId = String(data.groupId || data.threadId || '');
      return {
        accountId: data.zaloId || data.accountId || '',
        chatId,
        threadId: chatId,
        groupId: chatId,
        eventType: data.eventType || '',
        // The member who joined / left (the first one when several were added at once)
        fromId: String(members[0]?.id || ''),
        fromName: String(members[0]?.dName || ''),
        memberIds: members.map((m: any) => String(m?.id || '')).filter(Boolean).join(','),
        memberNames: members.map((m: any) => String(m?.dName || '')).filter(Boolean).join(', '),
        content: data.systemText || '',
        systemText: data.systemText || '',
        isGroup: true,
        channel: 'telegram_user',
        timestamp: Number(data.timestamp || Date.now()),
      };
    }
    if (triggerType === 'tg.trigger.message' || triggerType.startsWith('tg.trigger.')) {
      const envelope = data.message || data;
      const msg = envelope.data || data.data || envelope;
      const ch = data.channel || envelope.channel || msg.channel || '';
      const content = msg.preview || msg.content || msg.text || data.content || '';
      const accountId = data.zaloId || data.accountId || '';
      const fromId = msg.fromId || msg.senderId || msg.uidFrom || data.fromId || '';
      return {
        accountId,
        chatId:     data.threadId || envelope.threadId || msg.threadId || msg.chatId || '',
        fromId,
        fromName:   msg.fromName || msg.senderName || msg.dName || data.fromName || '',
        ...(triggerType === 'tg.trigger.message'
          ? { fromPhone: data.fromPhone || msg.fromPhone || this.getSavedContactPhone(accountId, fromId, true) }
          : {}),
        content,
        body:       content,
        caption:    msg.content || msg.text || data.content || '',
        preview:    msg.preview || content,
        msgType:    msg.msgType || msg.type || 'text',
        messageId:  msg.msgId || msg.messageId || data.msgId || '',
        threadId:   data.threadId || envelope.threadId || msg.threadId || '',
        isGroup:    !!(msg.isGroup || envelope.type === 1 || data.isGroup),
        isSelf:     !!(msg.isSelf || envelope.isSelf || data.isSelf),
        channel:    ch,
        timestamp:  Number(msg.timestamp || msg.ts || data.timestamp || Date.now()),
        attachments: msg.attachments || null,
      };
    }
    return { ...data };
  }

  /**
   * {{ $trigger.fromPhone }}: the sender's saved phone number, contacts.phone (Zalo friends with a number, numbers entered in Conversation info /
   * CRM); Telegram adds the number from telegram_peers (contacts that shared their number). Missing → '' and POS lookup nodes
   * that use this variable will not look up (posLookupGuard).
   */
  /** {{ $trigger.fromName }} for channels whose events carry no name (Facebook): the contact's alias, else its display name. */
  private getSavedContactName(accountId: unknown, contactId: unknown): string {
    const owner = String(accountId ?? '').trim();
    const id = String(contactId ?? '').trim();
    if (!owner || !id) return '';
    try {
      const contact: any = DatabaseService.getInstance().getContactById(owner, id);
      return String(contact?.alias || contact?.display_name || '').trim();
    } catch {
      return '';
    }
  }

  private getSavedContactPhone(accountId: unknown, contactId: unknown, telegram = false): string {
    const owner = String(accountId ?? '').trim();
    const id = String(contactId ?? '').trim();
    if (!owner || !id) return '';
    try {
      const db = DatabaseService.getInstance();
      const saved = vietnamLocalPhone(db.getContactById(owner, id)?.phone);
      if (saved || !telegram) return saved;
      return vietnamLocalPhone(db.getTelegramPeer(owner, id)?.phone);
    } catch {
      return '';
    }
  }

  // ─── Node Executor ────────────────────────────────────────────────────────

  /** Dry-run: produce a mock output for a side-effect node without touching any real service. */
  private simulateNode(node: WorkflowNode, cfg: Record<string, any>, ctx: ExecutionContext): Record<string, any> {
    const type = node.type;
    if (type === 'logic.wait') {
      return { simulated: true, waited: Number(cfg.delayMs ?? (Number(cfg.delaySeconds || 1) * 1000)) };
    }
    if (type === 'output.log') {
      return { simulated: true, logged: outboundText(cfg) || cfg.message };
    }
    if (type === 'ai.generateText') {
      const prompt = String(cfg.prompt || '').replace(/\s+/g, ' ').slice(0, 80);
      return { simulated: true, result: tr('[AI mô phỏng — trả lời cho: "{{prompt}}"]', { prompt }), model: 'simulate' };
    }
    if (type === 'ai.classify') {
      return { simulated: true, category: 'khác', input: String(cfg.input || '').slice(0, 80) };
    }
    if (type === 'output.httpRequest') {
      return { simulated: true, status: 200, data: { simulated: true }, _simulated: true };
    }
    // send nodes + everything else with a side effect (sheets, notify, integrations, forEachContact…)
    return {
      simulated: true,
      message: outboundText(cfg),
      threadId: String(cfg.threadId || cfg.chatId || cfg.threadIds || ''),
    };
  }

  private async executeNode(
    node: WorkflowNode,
    cfg: Record<string, any>,
    ctx: ExecutionContext,
    _wf: Workflow
  ): Promise<Record<string, any>> {
    // POS customer / order lookup with an empty phone number and order code: the API is not called (some platforms return an unfiltered list
    // → the workflow would reply with someone else's order / customer, see posLookupGuard.ts.
    const posLookup = posLookupNode(node.type);
    if (posLookup && !posLookupQuery(posLookup.kind, cfg)) {
      Logger.info(`[WorkflowEngine] ${node.type}: SĐT / mã đơn trống → không tra cứu (workflow "${ctx._wfName}")`);
      return refusedPosLookup(posLookup.kind);
    }

    switch (node.type) {

      // ── Trigger nodes (just pass-through - already matched) ──────────────
      case 'trigger.message':
      case 'trigger.friendRequest':
      case 'trigger.groupEvent':
      case 'trigger.reaction':
      case 'trigger.undo':
      case 'trigger.schedule':
      case 'trigger.manual':
      case 'trigger.labelAssigned':
      case 'trigger.webhook':
      case 'trigger.api':
      case 'tgbot.trigger.message':
      case 'tgbot.trigger.command':
      case 'tgbot.trigger.join':
      case 'tgbot.trigger.callback':
      case 'tgbot.trigger.editedMessage':
      case 'tgbot.trigger.joinRequest':
      case 'tgbot.trigger.memberUpdate':
        return { ...ctx.trigger };

      case 'action.forwardCrossChannel': {
        const sourceAccountId = String(cfg.sourceAccountId || ctx.trigger?.accountId || ctx.trigger?.zaloId || ctx.trigger?.fbAccountId || ctx.pageId || '');
        const sourceChannel = String(cfg.sourceChannel || this.getAccountChannel(sourceAccountId) || ctx.trigger?.channel || '');
        const targetAccountId = String(cfg.targetAccountId || '');
        const targetChannel = String(cfg.targetChannel || '');
        const targetChatId = String(cfg.targetChatId || '');
        const messageId = String(cfg.messageId || ctx.trigger?.messageId || ctx.trigger?.msgId || '');
        if (!sourceAccountId || !sourceChannel) throw new Error('[action.forwardCrossChannel] source account/channel required');
        if (!targetAccountId || !targetChannel || !targetChatId) throw new Error('[action.forwardCrossChannel] target channel, account and chat required');

        let sourceMessage: any = null;
        if (messageId) {
          try { sourceMessage = DatabaseService.getInstance().getMessageById(sourceAccountId, messageId); } catch {}
        }
        // Media is persisted first, but its local download completes asynchronously.
        // Do not silently downgrade a just-arrived image/video/file to its caption.
        if (messageId && !this.getForwardMediaPath(sourceMessage) && this.isForwardMedia(sourceMessage, ctx.trigger)) {
          sourceMessage = await this.waitForForwardMedia(sourceAccountId, messageId, sourceMessage);
        }

        const text = this.getForwardText(sourceMessage?.content ?? ctx.trigger?.content ?? '');
        const mediaPath = this.getForwardMediaPath(sourceMessage);
        const mediaType = String(sourceMessage?.msg_type || sourceMessage?.type || ctx.trigger?.msgType || '');
        const targetThreadType = this.resolveForwardTargetThreadType(targetChannel, cfg);
        const sourceIsMedia = this.isForwardMedia(sourceMessage, ctx.trigger);
        let nativeForwarded = false;

        if (mediaPath) {
          const mediaResult = await this.sendForwardMedia(targetChannel, targetAccountId, targetChatId, mediaPath, mediaType, targetThreadType);
          if (!mediaResult.success) throw new Error(mediaResult.error || tr('Không gửi được media chuyển tiếp'));
        } else if (messageId && sourceChannel === targetChannel && sourceAccountId === targetAccountId && (sourceIsMedia || !text)) {
          const sourceChatId = String(cfg.sourceChatId || ctx.trigger?.chatId || ctx.trigger?.threadId || sourceMessage?.thread_id || '');
          if (!sourceChatId) throw new Error('[action.forwardCrossChannel] sourceChatId required for native forward');
          const nativeResult = await this.forwardNativeMessage(sourceChannel, sourceAccountId, sourceChatId, targetChatId, messageId, sourceMessage);
          if (!nativeResult.success) throw new Error(nativeResult.error || tr('Không thể chuyển tiếp tin gốc'));
          nativeForwarded = true;
        } else if (sourceIsMedia) {
          throw new Error(tr('Tệp nguồn chưa tải xong trong 30 giây; không thể chuyển sang kênh hoặc tài khoản khác'));
        } else if (!text) {
          throw new Error(tr('Tin nguồn không có nội dung để chuyển tiếp'));
        }

        // Captions and the optional compose text deliberately travel as separate
        // messages, matching the chat forward modal and never replacing media.
        const texts = [nativeForwarded ? '' : text, String(cfg.companionText || '')].map(value => value.trim()).filter(Boolean);
        for (const item of texts) {
          const result = await this.sendForwardText(targetChannel, targetAccountId, targetChatId, item, targetThreadType);
          if (!result.success) throw new Error(result.error || tr('Không gửi được nội dung chuyển tiếp'));
        }
        return { success: true, sourceAccountId, targetAccountId, targetChannel, mediaSent: !!mediaPath || nativeForwarded, textMessagesSent: texts.length };
      }

      // ── Zalo Actions ─────────────────────────────────────────────────────
      case 'zalo.sendMessage': {
        this.getApi(ctx.pageId); // not connected → the node fails immediately, as before
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;   // guard NaN → 0
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const continueOnError = cfg.continueOnError === true;
        Logger.info(`[WorkflowEngine] sendMessage: message="${(cfg.message || '').substring(0, 300)}", threadIds=${JSON.stringify(targetThreadIds)}, threadType=${threadType}, isEmpty=${!cfg.message?.trim()}`);

        // ─── Structured AI response handling ─────────────────────────────
        // Detect AI structured JSON: [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        const segments = parseStructuredResponse(cfg.message);
        if (segments) {
          Logger.info(`[WorkflowEngine] Structured AI response: ${segments.length} segments`);
          let lastMsgId = '';
          const tally = newSendTally();
          await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
            const api = this.getApi(ctx.pageId);
            try {
              for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (seg.type === 'text' && seg.content) {
                  if (i > 0) await new Promise(r => setTimeout(r, 600));
                  try {
                    const destType = threadType === 0 ? 3 : undefined;
                    await api.sendTypingEvent(tid, threadType, destType);
                  } catch {}
                  const typingDelay = Math.min(Math.max(String(seg.content).length * 30, 800), 3000);
                  await new Promise(r => setTimeout(r, typingDelay));
                  const res = await api.sendMessage({ msg: String(seg.content) }, tid, threadType);
                  lastMsgId = (res as any)?.message?.msgId || lastMsgId;
                } else if (seg.type === 'image') {
                  const urls = Array.isArray(seg.content) ? seg.content : [seg.content];
                  for (const url of urls) {
                    if (!url || typeof url !== 'string') continue;
                    if (i > 0 || urls.indexOf(url) > 0) await new Promise(r => setTimeout(r, 500));
                    try {
                      const tempPath = await this.downloadUrlToTempFile(String(url));
                      try {
                        const res = await api.sendMessage({ msg: '', attachments: [tempPath] }, tid, threadType);
                        lastMsgId = (res as any)?.attachment?.[0]?.msgId || (res as any)?.message?.msgId || lastMsgId;
                      } finally {
                        try { fs.unlinkSync(tempPath); } catch {}
                      }
                    } catch (e: any) {
                      Logger.warn(`[WorkflowEngine] Failed to send image ${url}: ${e.message}`);
                      await api.sendMessage({ msg: String(url) }, tid, threadType);
                    }
                  }
                }
              }
              tally.sent++;
            } catch (err: any) {
              Logger.warn(`[WorkflowEngine] sendMessage to ${tid} failed: ${err.message}`);
              tally.failed++;
              tally.lastError = err.message;
              if (!continueOnError) throw err;
            }
          });
          tally.lastMsgId = lastMsgId;
          return this.sendTallyOutput(tally, targetThreadIds.length, { structured: true, segmentCount: segments.length });
        }

        // ─── Plain text: loop over several threads ────────────────────────────
        if (!String(cfg.message ?? '').trim()) throw new Error(tr('[zalo.sendMessage] Nội dung tin nhắn đang trống'));
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            const result = await api.sendMessage({ msg: cfg.message }, tid, threadType);
            tally.sent++;
            tally.lastMsgId = (result as any)?.message?.msgId || tally.lastMsgId;
            Logger.log(`[WorkflowEngine] zalo.sendMessage to ${tid}: success=true, msgId=${(result as any)?.message?.msgId}`);
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendMessage to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.sendTyping': {
        // Send the "đang gõ" (typing) event, then wait for the delay before the next step runs.
        // Purpose: send this indicator BEFORE zalo.sendMessage so it looks natural.
        //   threadType 0 = DM (needs destType=3), 1 = Group (no destType needed)
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const destType   = threadType === 0 ? 3 : undefined; // DestType.User=3
        try {
          await api.sendTypingEvent(cfg.threadId, threadType, destType);
        } catch (e: any) {
          Logger.warn(`[WorkflowEngine] sendTypingEvent warning: ${e.message}`);
        }
        const delayMs = Number(cfg.delaySeconds || 3) * 1000;
        await new Promise(r => setTimeout(r, Math.min(delayMs, 30_000)));
        return { success: true, delayMs };
      }

      case 'zalo.sendImage': {
        this.getApi(ctx.pageId); // not connected → the node fails immediately, as before
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const continueOnError = cfg.continueOnError === true;
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        if (!String(cfg.filePath || '').trim()) throw new Error(tr('[zalo.sendImage] Chưa chọn ảnh cần gửi'));
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            const result = await api.sendMessage({ msg: cfg.message || '', attachments: [cfg.filePath] }, tid, threadType);
            tally.sent++;
            tally.lastMsgId = (result as any)?.attachment?.[0]?.msgId || tally.lastMsgId;
            Logger.log(`[WorkflowEngine] zalo.sendImage to ${tid}: success=true`);
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendImage to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.sendFile': {
        this.getApi(ctx.pageId); // not connected → the node fails immediately, as before
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const continueOnError = cfg.continueOnError === true;
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        if (!String(cfg.filePath || '').trim()) throw new Error(tr('[zalo.sendFile] Chưa chọn file cần gửi'));
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            await api.sendMessage({ msg: '', attachments: [cfg.filePath] }, tid, threadType);
            tally.sent++;
            Logger.log(`[WorkflowEngine] zalo.sendFile to ${tid}: success=true`);
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendFile to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.sendVoice': {
        this.getApi(ctx.pageId); // not connected → the node fails immediately, as before
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const continueOnError = cfg.continueOnError === true;
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            const up = await api.uploadAttachment([cfg.filePath], tid, threadType);
            const resp = Array.isArray(up) ? up[0] : up;
            const voiceUrl = resp?.fileUrl || '';
            if (!voiceUrl) throw new Error(tr('Tải tin thoại lên Zalo thất bại'));
            await api.sendVoice({ voiceUrl }, tid, threadType);
            tally.sent++;
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendVoice to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.sendVideo': {
        this.getApi(ctx.pageId); // not connected → the node fails immediately, as before
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const continueOnError = cfg.continueOnError === true;
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            const up = await api.uploadAttachment([cfg.filePath], tid, threadType);
            const resp = Array.isArray(up) ? up[0] : up;
            const videoUrl = resp?.fileUrl || '';
            if (!videoUrl) throw new Error(tr('Tải video lên Zalo thất bại'));
            await api.sendVideo({ videoUrl, thumbnailUrl: videoUrl }, tid, threadType);
            tally.sent++;
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendVideo to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.sendSticker': {
        const lookupApi = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        const stickerId = Number(cfg.stickerId);
        if (!stickerId) throw new Error('[zalo.sendSticker] stickerId required');
        const stickersDetail = await lookupApi.getStickersDetail(stickerId);
        if (!stickersDetail || stickersDetail.length === 0) throw new Error(tr('Không tìm thấy sticker'));
        const continueOnError = cfg.continueOnError === true;
        if (!targetThreadIds.length) return this.noRecipientsOutput(cfg, node.type);
        const tally = newSendTally();
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          const api = this.getApi(ctx.pageId);
          try {
            await api.sendSticker(stickersDetail[0], tid, threadType);
            tally.sent++;
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] zalo.sendSticker to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        });
        return this.sendTallyOutput(tally, targetThreadIds.length);
      }

      case 'zalo.findUser': {
        // zca-js 2.x: findUser(phone) → UserBasic { uid, display_name, zalo_name, avatar, … } (no `data` wrapper)
        const api = this.getApi(ctx.pageId);
        const phone = String(cfg.phone || '').trim();
        if (!phone) throw new Error(tr('[zalo.findUser] Thiếu số điện thoại'));
        const result: any = await api.findUser(phone);
        const user = result?.data && typeof result.data === 'object' ? result.data : (result || {});
        const userId = String(user.uid || user.userId || '');
        return {
          userId,
          displayName: user.display_name || user.displayName || user.zalo_name || user.zaloName || '',
          avatar: user.avatar || '',
          gender: user.gender ?? '',
          isFriend: !!(user.isFr ?? user.isFriend),
          found: !!userId,
        };
      }

      case 'zalo.getUserInfo': {
        // zca-js 2.x: getUserInfo(userId) → { changed_profiles: { [uid]: profile }, unchanged_profiles, … }
        const api = this.getApi(ctx.pageId);
        const userId = String(cfg.userId || ctx.trigger?.fromId || '').trim();
        if (!userId) throw new Error(tr('[zalo.getUserInfo] Thiếu User ID'));
        const result: any = await api.getUserInfo(userId);
        const profiles = result?.changed_profiles || result?.data?.changed_profiles || {};
        const profile = profiles[userId] || profiles[`${userId}_0`] || Object.values(profiles)[0] || {};
        return {
          ...profile,
          userId: String(profile.userId || profile.uid || userId),
          displayName: profile.displayName || profile.zaloName || profile.display_name || '',
          avatar: profile.avatar || '',
          found: Object.keys(profile).length > 0,
        };
      }

      case 'zalo.acceptFriendRequest': {
        const api = this.getApi(ctx.pageId);
        await api.acceptFriendRequest(cfg.userId);
        return { success: true };
      }

      case 'zalo.rejectFriendRequest': {
        const api = this.getApi(ctx.pageId);
        await api.rejectFriendRequest(cfg.userId);
        return { success: true };
      }

      case 'zalo.sendFriendRequest': {
        const api = this.getApi(ctx.pageId);
        await api.sendFriendRequest(cfg.message || '', cfg.userId);
        return { success: true };
      }

      case 'zalo.addToGroup': {
        // zca-js 2.x: addUserToGroup(memberId | memberId[], groupId)
        const api = this.getApi(ctx.pageId);
        const userIds = parseIdList(String(cfg.userId || ''));
        if (!userIds.length) throw new Error(tr('[zalo.addToGroup] Thiếu User ID'));
        if (!cfg.groupId) throw new Error(tr('[zalo.addToGroup] Thiếu nhóm'));
        const result: any = await api.addUserToGroup(userIds.length === 1 ? userIds[0] : userIds, String(cfg.groupId));
        const failed: string[] = Array.isArray(result?.errorMembers) ? result.errorMembers.map(String) : [];
        if (failed.length && failed.length === userIds.length) throw new Error(tr('Zalo không thêm được thành viên vào nhóm'));
        return { success: true, addedCount: userIds.length - failed.length, failedIds: failed };
      }

      case 'zalo.removeFromGroup': {
        // zca-js 2.x: removeUserFromGroup(memberId | memberId[], groupId)
        const api = this.getApi(ctx.pageId);
        const userIds = parseIdList(String(cfg.userId || ''));
        if (!userIds.length) throw new Error(tr('[zalo.removeFromGroup] Thiếu User ID'));
        if (!cfg.groupId) throw new Error(tr('[zalo.removeFromGroup] Thiếu nhóm'));
        await api.removeUserFromGroup(userIds.length === 1 ? userIds[0] : userIds, String(cfg.groupId));
        return { success: true, removedCount: userIds.length };
      }

      case 'zalo.undoMessage': {
        // zca-js 2.x: undo({ msgId, cliMsgId }, threadId, type). cliMsgId comes from the trigger or the stored message.
        const api = this.getApi(ctx.pageId);
        const msgId = String(cfg.msgId || '').trim();
        if (!msgId) throw new Error(tr('[zalo.undoMessage] Thiếu ID tin nhắn'));
        const accountId = ctx.trigger?.zaloId || ctx.pageId;
        const stored: any = (() => { try { return DatabaseService.getInstance().getMessageById(accountId, msgId, cfg.threadId || undefined); } catch { return undefined; } })();
        const threadId = String(cfg.threadId || stored?.thread_id || ctx.trigger?.threadId || '').trim();
        if (!threadId) throw new Error(tr('[zalo.undoMessage] Thiếu ID hội thoại'));
        const threadType = Number(cfg.threadType ?? stored?.thread_type ?? 0) === 1 ? 1 : 0;
        const cliMsgId = String(cfg.cliMsgId || (msgId === String(ctx.trigger?.msgId || '') ? ctx.trigger?.cliMsgId : '') || stored?.cli_msg_id || '').trim();
        if (!cliMsgId) throw new Error(tr('[zalo.undoMessage] Không tìm thấy Client Message ID của tin nhắn (tin chưa có trong máy)'));
        await api.undo({ msgId, cliMsgId }, threadId, threadType);
        return { success: true, msgId, threadId };
      }

      case 'zalo.setMute': {
        // zca-js 2.x: setMute({ duration (seconds, -1 = forever), action: 1 = mute | 3 = unmute }, threadId, type)
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const threadId = String(cfg.threadId || ctx.trigger?.threadId || '').trim();
        if (!threadId) throw new Error(tr('[zalo.setMute] Thiếu ID hội thoại'));
        const mute = cfg.action !== 'unmute';
        const seconds = Number(cfg.duration ?? 0);
        await api.setMute(mute ? { action: 1, duration: seconds > 0 ? seconds : -1 } : { action: 3 }, threadId, threadType);
        return { success: true, action: mute ? 'mute' : 'unmute', threadId };
      }

      case 'zalo.getMessageHistory': {
        // Read from local DB instead of Zalo API (API may 404 or rate-limit)
        const zaloId = ctx.pageId;
        const threadId = cfg.threadId || ctx.trigger?.threadId || '';
        const count = Number(cfg.count ?? 20);
        const before = cfg.before ? Number(cfg.before) : undefined;
        if (!threadId) throw new Error('[zalo.getMessageHistory] threadId required');
        const messages = DatabaseService.getInstance().getMessages(zaloId, threadId, count, 0, before);
        return { messages: messages || [] };
      }

      case 'zalo.forwardMessage': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.toThreadType ?? 0);
        const threadId = cfg.toThreadId;
        if (!threadId) throw new Error('[zalo.forwardMessage] toThreadId required');

        const msgId = String(cfg.msgId || ctx.trigger?.msgId || '');
        const accountId = ctx.trigger?.zaloId || ctx.pageId;

        // The original message from the DB (same source as "Chuyển tiếp đa kênh"): media is downloaded asynchronously, so a
        // just-received photo / video / file waits for its local copy instead of going out as the raw attachment JSON.
        let stored: any = null;
        if (msgId && accountId) {
          try { stored = DatabaseService.getInstance().getMessageById(accountId, msgId); } catch {}
        }
        const storedType = String(stored?.msg_type || ctx.trigger?.msgType || '');
        const isMedia = this.isForwardMedia(stored, ctx.trigger) || isZaloMediaType(storedType);
        if (msgId && isMedia && !this.getForwardMediaPath(stored)) stored = await this.waitForForwardMedia(accountId, msgId, stored);
        const mediaPath = this.getForwardMediaPath(stored);

        // Text: what the node sets, otherwise the readable text of the message (link card → its address, never raw JSON)
        const rawContent = stored?.content ?? ctx.trigger?.content ?? '';
        const message = String(cfg.message || '').trim() || this.getForwardText(rawContent) || zaloLinkText(rawContent);

        if (mediaPath) {
          // Media + text (caption) in one call, as in chat forwarding
          await api.sendMessage({ msg: message, attachments: [mediaPath] }, threadId, threadType);
        } else if (isMedia) {
          throw new Error(tr('Tệp nguồn chưa tải xong trong 30 giây; không thể chuyển tiếp'));
        } else if (message) {
          await api.sendMessage({ msg: message, attachments: [] }, threadId, threadType);
        } else {
          throw new Error(tr('Tin nguồn không có nội dung để chuyển tiếp'));
        }

        return { success: true, msgId, mediaSent: !!mediaPath };
      }

      case 'zalo.createPoll': {
        // zca-js 2.x: createPoll({ question, options, expiredTime (ms, 0 = none), allowMultiChoices }, groupId)
        const api = this.getApi(ctx.pageId);
        const options = String(cfg.options || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
        if (!cfg.groupId) throw new Error(tr('[zalo.createPoll] Thiếu nhóm'));
        if (!String(cfg.question || '').trim()) throw new Error(tr('[zalo.createPoll] Thiếu câu hỏi'));
        if (options.length < 2) throw new Error(tr('[zalo.createPoll] Cần ít nhất 2 lựa chọn'));
        const seconds = Math.max(0, Number(cfg.expireTime ?? 0) || 0);
        const poll: any = await api.createPoll({
          question: String(cfg.question),
          options,
          expiredTime: seconds > 0 ? Date.now() + seconds * 1000 : 0,
          allowMultiChoices: !!cfg.allowMultiple,
        }, String(cfg.groupId));
        return { success: true, pollId: poll?.poll_id ?? poll?.pollId ?? '' };
      }

      case 'zalo.addReaction': {
        const api = this.getApi(ctx.pageId);
        const reaction = resolveZaloWorkflowReaction(cfg.reactionType ?? 'LIKE');
        if (!reaction) {
          throw new Error(tr('[zalo.addReaction] Reaction không hợp lệ'));
        }

        const msgId = String(cfg.msgId || ctx.trigger?.msgId || '').trim();
        // zca-js needs both the server message ID and the original client
        // message ID. For received messages those two IDs may be different.
        // Falling back to msgId makes the API accept the request in some cases,
        // but Zalo then silently does not apply the reaction.
        const configuredThreadId = String(cfg.threadId || '').trim();
        const triggerThreadId = String(ctx.trigger?.threadId || '').trim();
        const storedMessage = msgId
          ? DatabaseService.getInstance().getMessageById(
            ctx.trigger?.zaloId || ctx.pageId,
            msgId,
            configuredThreadId || triggerThreadId || undefined,
          )
          : undefined;
        const threadId = configuredThreadId || triggerThreadId || String(storedMessage?.thread_id || '').trim();
        const configuredThreadType = cfg.threadType !== undefined && cfg.threadType !== ''
          ? cfg.threadType
          : undefined;
        const triggerThreadType = ctx.trigger?.threadType !== undefined && ctx.trigger?.threadType !== ''
          ? ctx.trigger.threadType
          : undefined;
        const threadType = Number(configuredThreadType ?? triggerThreadType ?? storedMessage?.thread_type ?? 0) === 1 ? 1 : 0;
        const cliMsgId = String(
          cfg.clientMsgId || ctx.trigger?.cliMsgId || storedMessage?.cli_msg_id || msgId,
        ).trim();
        if (!msgId) throw new Error(tr('[zalo.addReaction] Thiếu ID tin nhắn'));
        if (!threadId) throw new Error(tr('[zalo.addReaction] Thiếu ID hội thoại'));
        if (!cliMsgId) throw new Error(tr('[zalo.addReaction] Thiếu Client Message ID của tin nhắn'));

        await api.addReaction(reaction, {
          data: {
            msgId,
            cliMsgId,
          },
          threadId,
          type: threadType,
        } as any);
        return { success: true, msgId, cliMsgId, reaction };
      }

      case 'zalo.assignLabel': {
        // Decode labelIds: an array of "source:id" (new), or fall back to the old labelId/labelSource
        const rawIds: string[] = Array.isArray(cfg.labelIds) && cfg.labelIds.length > 0
          ? cfg.labelIds
          : (cfg.labelId ? [`${cfg.labelSource || 'local'}:${cfg.labelId}`] : []);

        if (cfg.labelSource === 'local') {
          const localIds = rawIds
            .filter(v => typeof v === 'string' && v.startsWith('local:'))
            .map(v => Number(v.split(':')[1]))
            .filter(Boolean);
          for (const labelId of localIds) {
            DatabaseService.getInstance().assignLocalLabelToThread(ctx.pageId, labelId, cfg.threadId);
          }
          return { success: true, source: 'local', labelIds: localIds, threadId: cfg.threadId };
        } else {
          // Zalo: only one label per conversation
          const api = this.getApi(ctx.pageId);
          const zaloEntry = rawIds.find(v => typeof v === 'string' && v.startsWith('zalo:')) || rawIds[0] || '';
          const zaloRawId = typeof zaloEntry === 'string' && zaloEntry.includes(':')
            ? zaloEntry.split(':')[1]
            : String(zaloEntry || cfg.labelId || '');
          const labelsRes = await (api as any).getLabels();
          const labelData = labelsRes?.labelData || labelsRes?.data?.labelData || [];
          const version = labelsRes?.version || labelsRes?.data?.version || 0;
          const label = labelData.find((l: any) => String(l.id) === String(zaloRawId));
          if (!label) throw new Error(tr('[zalo.assignLabel] Không tìm thấy nhãn Zalo đã chọn (có thể đã bị xoá)'));
          // Zalo keeps one label per conversation: take the conversation out of its other labels first
          const threadId = String(cfg.threadId);
          for (const other of labelData) {
            if (other !== label && Array.isArray(other.memberIds) && other.memberIds.map(String).includes(threadId)) {
              other.memberIds = other.memberIds.filter((id: any) => String(id) !== threadId);
            }
          }
          const existingMembers: any[] = label.memberIds || [];
          if (!existingMembers.map(String).includes(threadId)) label.memberIds = [...existingMembers, threadId];
          await (api as any).updateLabels({ labelData, version });
          return { success: true, source: 'zalo', labelId: zaloRawId, threadId: cfg.threadId };
        }
      }

      case 'zalo.removeLabel': {
        const rawIds: string[] = Array.isArray(cfg.labelIds) && cfg.labelIds.length > 0
          ? cfg.labelIds
          : (cfg.labelId ? [`${cfg.labelSource || 'local'}:${cfg.labelId}`] : []);

        if (cfg.labelSource === 'local') {
          const localIds = rawIds
            .filter(v => typeof v === 'string' && v.startsWith('local:'))
            .map(v => Number(v.split(':')[1]))
            .filter(Boolean);
          for (const labelId of localIds) {
            DatabaseService.getInstance().removeLocalLabelFromThread(ctx.pageId, labelId, cfg.threadId);
          }
          return { success: true, source: 'local', labelIds: localIds, threadId: cfg.threadId };
        } else {
          // Zalo: remove one label from the conversation
          const api = this.getApi(ctx.pageId);
          const zaloEntry = rawIds.find(v => typeof v === 'string' && v.startsWith('zalo:')) || rawIds[0] || '';
          const zaloRawId = typeof zaloEntry === 'string' && zaloEntry.includes(':')
            ? zaloEntry.split(':')[1]
            : String(zaloEntry || cfg.labelId || '');
          const labelsRes = await (api as any).getLabels();
          const labelData = labelsRes?.labelData || labelsRes?.data?.labelData || [];
          const version = labelsRes?.version || labelsRes?.data?.version || 0;
          const label = labelData.find((l: any) => String(l.id) === String(zaloRawId));
          if (label) {
            label.memberIds = (label.memberIds || []).filter((id: string) => id !== cfg.threadId);
            await (api as any).updateLabels({ labelData, version });
          }
          return { success: true, source: 'zalo', labelId: zaloRawId, threadId: cfg.threadId };
        }
      }

      case 'zalo.changeAliasName': {
        const api = this.getApi(ctx.pageId);
        const friendId = cfg.friendId || ctx.trigger?.fromId;
        if (!friendId) throw new Error('[zalo.changeAliasName] friendId required');
        if (cfg.alias === undefined || cfg.alias === '') throw new Error('[zalo.changeAliasName] alias required');
        const alias = String(cfg.alias);
        // 1. Call the Zalo API to change the alias name
        await api.changeFriendAlias(alias, String(friendId));
        // 2. Update the local DB (same as the db:setContactAlias IPC handler)
        DatabaseService.getInstance().setContactAlias(ctx.pageId, String(friendId), alias);
        // 3. Broadcast to the employees who are connected
        EventBroadcaster.emit('db:contactAliasChanged', { ownerZaloId: ctx.pageId, contactId: String(friendId), alias });
        return { success: true, friendId, alias };
      }

      // ── Logic Nodes ──────────────────────────────────────────────────────
      case 'logic.if': {
        const result = evaluateCondition(cfg.left, cfg.operator ?? 'equals', cfg.right);
        ctx.variables[`__if_${node.id}`] = result;
        return { result, branch: result ? 'true' : 'false' };
      }

      case 'logic.switch': {
        const val = String(cfg.value ?? '');
        const cases: Array<{ match: string; label: string }> = cfg.cases || [];
        // Exact match first (old behaviour); then ignoring case and surrounding spaces / punctuation, so "Hỏi giá." or
        // "hỏi giá" from an AI step still reaches the "Hỏi giá" branch
        const exact = cases.find(c => String(c.match) === val);
        const loose = exact ? undefined : cases.find(c => looseText(String(c.match)) !== '' && looseText(String(c.match)) === looseText(val));
        const matchedHandle = (exact || loose)?.label || cfg.defaultLabel || 'default';
        ctx.variables[`__switch_${node.id}`] = matchedHandle;
        return { value: val, matchedHandle, matched: !!(exact || loose) };
      }

      case 'logic.wait': {
        const ms = Number(cfg.delayMs ?? (Number(cfg.delaySeconds || 1) * 1000));
        await new Promise(r => setTimeout(r, Math.min(ms, 300_000)));
        return { waited: ms };
      }

      case 'logic.setVariable': {
        ctx.variables[cfg.name] = cfg.value;
        return { [cfg.name]: cfg.value };
      }

      case 'logic.stopIf': {
        if (evaluateCondition(cfg.left, cfg.operator ?? 'equals', cfg.right)) throw new Error('__STOP__');
        return { stopped: false };
      }

      case 'logic.forEach': {
        // The loop runs in runNodeSequence / runForEachLoop; this node only reads the list.
        const items = this.resolveForEachItems(node.config?.array, cfg.array, ctx);
        return { items, count: items.length, processed: Math.min(items.length, forEachItemLimit(node.config?.maxItems)) };
      }

      case 'logic.forEachContact': {
        const audience = await this.resolveAudience(cfg, ctx);
        return { result: JSON.stringify(audience.threadIds), count: audience.threadIds.length, items: audience.items };
      }

      // ── Data Nodes ───────────────────────────────────────────────────────
      case 'data.textFormat':
        return { result: cfg.template || '' };

      case 'data.jsonParse': {
        try {
          const parsed = typeof cfg.input === 'string' ? JSON.parse(cfg.input) : cfg.input;
          return { data: parsed };
        } catch {
          return { data: null, error: 'JSON parse failed' };
        }
      }

      case 'data.dateFormat': {
        // A numeric string is a timestamp (seconds or milliseconds), not a date text
        const raw = String(cfg.date ?? '').trim();
        const num = /^\d{9,13}$/.test(raw) ? Number(raw) : NaN;
        const d = !raw ? new Date() : Number.isFinite(num) ? new Date(num < 1e12 ? num * 1000 : num) : new Date(raw);
        if (Number.isNaN(d.getTime())) throw new Error(tr('[data.dateFormat] Ngày giờ không hợp lệ: {{v1}}', { v1: raw }));
        const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Ho_Chi_Minh' };
        if (cfg.format === 'full') { opts.dateStyle = 'full'; opts.timeStyle = 'short'; }
        else if (cfg.format === 'date') { opts.dateStyle = 'short'; }
        else if (cfg.format === 'time') { opts.timeStyle = 'short'; }
        else { opts.dateStyle = 'short'; opts.timeStyle = 'short'; }
        // Text sent to customers: the node's language (Vietnamese by default), never the app's UI language
        return { result: new Intl.DateTimeFormat(workflowLocale(cfg.locale), opts).format(d), timestamp: d.getTime() };
      }

      case 'data.randomPick': {
        const options = String(cfg.options || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
        const picked = options.length > 0 ? options[Math.floor(Math.random() * options.length)] : '';
        return { result: picked };
      }

      // ── Output Nodes ─────────────────────────────────────────────────────
      case 'output.httpRequest': {
        let headers: Record<string, any> = {};
        let body: any = undefined;
        let params: any = undefined;
        const method = (cfg.method || 'POST').toUpperCase();
        const url = cfg.url || '';
        try { headers = cfg.headers ? (typeof cfg.headers === 'string' ? JSON.parse(cfg.headers) : cfg.headers) : {}; } catch {}
        try { body = cfg.body ? (typeof cfg.body === 'string' ? JSON.parse(cfg.body) : cfg.body) : undefined; } catch { body = cfg.body; }
        try { params = cfg.params ? (typeof cfg.params === 'string' ? JSON.parse(cfg.params) : cfg.params) : undefined; } catch {}
        const startTime = Date.now();
        try {
          const response = await axios({
            method,
            url,
            headers,
            data: body,
            params,
            timeout: Number(cfg.timeout ?? 10000),
            // Accept all HTTP status codes - 4xx/5xx are valid business responses,
            // not node errors. Let the workflow logic (e.g. logic.if) decide success/failure.
            validateStatus: () => true,
          });
          return {
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: response.headers,
            _request: { method, url, headers, body, params },
            _durationMs: Date.now() - startTime,
          };
        } catch (axiosErr: any) {
          // Network errors (ECONNREFUSED, DNS, timeout) - don't throw, return
          // structured error response so downstream nodes can always access output.
          const isTimeout = axiosErr.code === 'ECONNABORTED' || axiosErr.message?.includes('timeout');
          const isConnRefused = axiosErr.code === 'ECONNREFUSED';
          const isDns = axiosErr.code === 'ENOTFOUND' || axiosErr.code === 'EAI_AGAIN';
          return {
            status: 0,
            statusText: '',
            data: null,
            _error: true,
            _errorType: isTimeout ? 'timeout' : isConnRefused ? 'connection_refused' : isDns ? 'dns_error' : 'network_error',
            _errorMessage: axiosErr.message,
            _request: { method, url, headers, body, params },
            _durationMs: Date.now() - startTime,
          };
        }
      }

      case 'output.log': {
        const level = cfg.level || 'info';
        const msg = `[Workflow "${ctx._wfName}"] ${cfg.message}`;
        if (level === 'error') Logger.error(msg);
        else if (level === 'warn') Logger.warn(msg);
        else Logger.log(msg);
        return { logged: cfg.message };
      }

      // ── Google Sheets ────────────────────────────────────────────────────
      case 'sheets.appendRow': {
        if (!cfg.spreadsheetId) throw new Error('[sheets.appendRow] spreadsheetId required');
        if (!cfg.serviceAccountPath) throw new Error('[sheets.appendRow] serviceAccountPath required');
        const auth = new google.auth.GoogleAuth({
          keyFile: cfg.serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        let rowValues: any[][];
        try {
          const parsed = typeof cfg.values === 'string' ? JSON.parse(cfg.values) : cfg.values;
          rowValues = Array.isArray(parsed[0]) ? parsed : [parsed];
        } catch {
          // JSON parse failed (e.g., template vars contain special chars) → split by newline or single cell
          const raw = String(cfg.values ?? '');
          const lines = raw.split('\n').filter(Boolean);
          rowValues = lines.length > 0 ? [lines] : [[raw]];
        }
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: cfg.spreadsheetId,
          range: `${cfg.sheetName || 'Sheet1'}!A:Z`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rowValues },
        }, { timeout: 30000 });
        return {
          success: true,
          updatedRange: res.data.updates?.updatedRange || '',
          updatedRows: res.data.updates?.updatedRows || 0,
        };
      }

      case 'sheets.readValues': {
        if (!cfg.spreadsheetId) throw new Error('[sheets.readValues] spreadsheetId required');
        if (!cfg.serviceAccountPath) throw new Error('[sheets.readValues] serviceAccountPath required');
        const auth = new google.auth.GoogleAuth({
          keyFile: cfg.serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const range = cfg.range || 'Sheet1!A1:Z1000';
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: cfg.spreadsheetId,
          range,
        }, { timeout: 30000 });
        const rows: any[][] = res.data.values || [];
        return { rows, count: rows.length, firstRow: rows[0] || [] };
      }

      case 'sheets.updateCell': {
        if (!cfg.spreadsheetId) throw new Error('[sheets.updateCell] spreadsheetId required');
        if (!cfg.serviceAccountPath) throw new Error('[sheets.updateCell] serviceAccountPath required');
        if (!cfg.range) throw new Error('[sheets.updateCell] range required');
        const auth = new google.auth.GoogleAuth({
          keyFile: cfg.serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.update({
          spreadsheetId: cfg.spreadsheetId,
          range: cfg.range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[cfg.value]] },
        }, { timeout: 30000 });
        return { success: true, range: cfg.range };
      }

      // ── AI (Multi-platform: OpenAI, Gemini, Deepseek, Grok) ─────────────
      case 'ai.generateText': {
        // If assistantId is provided, delegate to AIAssistantService
        if (cfg.assistantId) {
          try {
            const AIAssistantService = (await import('../ai/AIAssistantService')).default;
            const chatMsgs: { role: string; content: string }[] = [];

            // Add chat history if provided
            if (cfg.chatHistory) {
              try {
                let history: any[] = typeof cfg.chatHistory === 'string' && cfg.chatHistory.trim()
                  ? JSON.parse(cfg.chatHistory) : (Array.isArray(cfg.chatHistory) ? cfg.chatHistory : []);
            const maxMsgs = Number(cfg.maxHistoryMessages ?? 20);
                if (history.length > maxMsgs) history = history.slice(-maxMsgs);
                for (const msg of history) {
                  if (msg?.role && msg?.content) {
                    chatMsgs.push({ role: msg.role, content: String(msg.content) });
                  } else if (msg && typeof msg === 'object') {
                    const content = msg.content?.msg || (typeof msg.content === 'string' ? msg.content : '');
                    if (content.trim()) chatMsgs.push({ role: msg.isSelf ? 'assistant' : 'user', content });
                  }
                }
              } catch {}
            }

            chatMsgs.push({ role: 'user', content: cfg.prompt });
            const result = await AIAssistantService.getInstance().chatForWorkflow(cfg.assistantId, chatMsgs);
            Logger.info(`[WorkflowEngine] AI assistant response: success=${!!result.result}, length=${result.result?.length || 0}, preview="${(result.result || '').substring(0, 200)}", tokens=${result.totalTokens}`);
            return { result: result.result, totalTokens: result.totalTokens, model: 'assistant' };
          } catch (e: any) {
            throw new Error(tr('Trợ lý AI lỗi: {{message}}', { message: e.message }));
          }
        }

        const messages: any[] = [];
        if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });

        // ── Chat history (conversation context) ────────────────────────
        if (cfg.chatHistory) {
          try {
            let history: any[] = [];
            if (typeof cfg.chatHistory === 'string' && cfg.chatHistory.trim()) {
              history = JSON.parse(cfg.chatHistory);
            } else if (Array.isArray(cfg.chatHistory)) {
              history = cfg.chatHistory;
            }
            const maxMsgs = Number(cfg.maxHistoryMessages ?? 20);
            // Trim to maxMsgs (most recent)
            if (history.length > maxMsgs) history = history.slice(-maxMsgs);
            for (const msg of history) {
              if (msg && typeof msg === 'object') {
                if (msg.role && msg.content) {
                  // Already OpenAI format { role, content }
                  messages.push({ role: msg.role, content: String(msg.content) });
                } else {
                  // Zalo message format – convert automatically
                  const content = msg.content?.msg
                    || (typeof msg.content === 'string' ? msg.content : '')
                    || '';
                  if (content.trim()) {
                    // isSelf = true → bot/assistant sent it; false → user sent it
                    messages.push({ role: msg.isSelf ? 'assistant' : 'user', content });
                  }
                }
              }
            }
          } catch {
            // Ignore parse errors - just proceed without history
          }
        }

        messages.push({ role: 'user', content: cfg.prompt });

        const platform = cfg.platform || 'openai';
        const rawModel = cfg.model || '';
        const maxTokens = Number(cfg.maxTokens || 500);
        const temperature = Number(cfg.temperature ?? 0.7);
        const response = await requestAICompletion({ platform, model: rawModel, apiKey: cfg.apiKey, messages, maxTokens, temperature });
        return { result: response.result, totalTokens: response.totalTokens, model: response.model };
      }

      case 'ai.classify': {
        const categories: string[] = String(cfg.categories || '')
          .split(',').map((s: string) => s.trim()).filter(Boolean);
        const systemMsg = `Bạn là bộ phân loại văn bản. Hãy phân loại đoạn văn bản đầu vào vào MỘT trong các danh mục sau: ${categories.join(', ')}. Chỉ trả về đúng tên danh mục, không giải thích thêm.`;

        // If assistantId is provided, delegate to AIAssistantService
        if (cfg.assistantId) {
          try {
            const AIAssistantService = (await import('../ai/AIAssistantService')).default;
            const chatMsgs = [
              { role: 'system', content: systemMsg },
              { role: 'user', content: cfg.input },
            ];
            const result = await AIAssistantService.getInstance().chat(cfg.assistantId, chatMsgs);
            const raw = (result.result || '').trim();
            const category = matchCategory(raw, categories);
            return { category: category || raw, matched: !!category, raw, input: cfg.input };
          } catch (e: any) {
            throw new Error(tr('Trợ lý AI lỗi: {{message}}', { message: e.message }));
          }
        }

        const platform = cfg.platform || 'openai';
        const classifyMessages = [
          { role: 'system' as const, content: systemMsg },
          { role: 'user' as const, content: cfg.input },
        ];
        const response = await requestAICompletion({
          platform,
          model: cfg.model || '',
          apiKey: cfg.apiKey,
          messages: classifyMessages,
          maxTokens: 30,
          temperature: 0,
        });
        // The model may answer "Hỏi giá." / "hỏi giá" / "Danh mục: Hỏi giá": map it back to the exact category name so
        // a Switch on {{ $node.<id>.category }} reaches the right branch
        const raw = String(response.result || '').trim();
        const category = matchCategory(raw, categories);
        return { category: category || raw, matched: !!category, raw, input: cfg.input, model: response.model };
      }

      // ── Notify: Telegram ─────────────────────────────────────────────────
      case 'notify.telegram': {
        // 1. A Telegram Bot account connected in Deplao: sent through it, no token to paste
        const botAccountId = String(cfg.botAccountId || '').trim();
        if (botAccountId) {
          const botMessage = this.resolveMessageFromConfigOrUpstream(node, cfg, ctx, _wf);
          if (!botMessage.text) {
            throw new Error(tr('[notify.telegram] Nội dung thông báo đang trống. Nhập nội dung hoặc nối một node tạo văn bản ngay trước node này.'));
          }
          if (!String(cfg.chatId || '').trim()) throw new Error(tr('[notify.telegram] Thiếu Chat ID nhận thông báo'));
          const sent = await TelegramBot.sendMessage({
            accountId: botAccountId,
            chatId: String(cfg.chatId).trim(),
            text: botMessage.text,
            ...(cfg.parseMode ? { parseMode: cfg.parseMode } : {}),
          });
          if (!sent.success) throw new Error(sent.error || tr('Không gửi được tin qua Bot Telegram'));
          return { success: true, messageId: sent.messageId || '', contentSource: botMessage.source };
        }

        // 2. Telegram Bot integration, or the bot token typed in the node (older workflows)
        let botToken = cfg.botToken || '';
        if (cfg.integrationId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const IntegrationRegistry = require('../integrations/IntegrationRegistry').default;
            const integration = IntegrationRegistry.getIntegration(cfg.integrationId);
            if (integration?.credentials?.botToken) {
              botToken = integration.credentials.botToken;
            }
          } catch (err) {
            Logger.warn(`[WorkflowEngine] Không tìm thấy Integration ${cfg.integrationId}: ${err}`);
          }
        }
        if (!botToken) {
          throw new Error(tr('Thiếu Bot Telegram: chọn Bot đã kết nối, hoặc cấu hình Integration Telegram Bot.'));
        }
        const message = this.resolveMessageFromConfigOrUpstream(node, cfg, ctx, _wf);
        if (!message.text) {
          throw new Error(tr('[notify.telegram] Nội dung thông báo đang trống. Nhập nội dung hoặc nối một node tạo văn bản ngay trước node này.'));
        }
        const payload: Record<string, any> = {
          chat_id: cfg.chatId,
          text: message.text,
        };
        if (cfg.parseMode) payload.parse_mode = cfg.parseMode;
        const res = await axios.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          payload,
          { timeout: 10000 }
        );
        return {
          success: true,
          messageId: res.data.result?.message_id || '',
          contentSource: message.source,
        };
      }

      // ── Notify: Discord ───────────────────────────────────────────────────
      case 'notify.discord': {
        if (!String(cfg.webhookUrl || '').trim()) throw new Error(tr('[notify.discord] Thiếu Webhook URL'));
        // Same as Telegram: an empty message takes the text of the step right before
        const discordMessage = this.resolveMessageFromConfigOrUpstream(node, cfg, ctx, _wf);
        if (!discordMessage.text) {
          throw new Error(tr('[notify.discord] Nội dung thông báo đang trống. Nhập nội dung hoặc nối một node tạo văn bản ngay trước node này.'));
        }
        const payload: Record<string, any> = {
          // Discord rejects messages over 2000 characters
          content: discordMessage.text.length > 2000 ? `${discordMessage.text.slice(0, 1997)}...` : discordMessage.text,
          username: cfg.username || 'DepLao Bot',
        };
        if (cfg.avatarUrl) payload.avatar_url = cfg.avatarUrl;
        await axios.post(cfg.webhookUrl, payload, { timeout: 10000 });
        return { success: true, contentSource: discordMessage.source };
      }

      // ── Notify: Email ─────────────────────────────────────────────────────
      case 'notify.email': {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: cfg.smtpHost || 'smtp.gmail.com',
          port: Number(cfg.smtpPort || 587),
          secure: Number(cfg.smtpPort) === 465,
          auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
          // Certificates are checked (the SMTP password travels over this connection); only a self-signed mail server
          // the user explicitly trusts skips the check
          tls: { rejectUnauthorized: !(cfg.allowInvalidCert === true || cfg.allowInvalidCert === 'true') },
        });
        const info = await transporter.sendMail({
          from: cfg.from || cfg.smtpUser,
          to: cfg.to,
          subject: cfg.subject,
          ...(cfg.isHtml ? { html: cfg.body } : { text: cfg.body }),
        });
        return { success: true, messageId: info.messageId || '' };
      }

      // ── Notify: Notion ────────────────────────────────────────────────────
      case 'notify.notion': {
        let properties: any = {};
        try {
          properties = typeof cfg.properties === 'string'
            ? JSON.parse(cfg.properties)
            : (cfg.properties || {});
        } catch {
          properties = {};
        }
        const res = await axios.post(
          'https://api.notion.com/v1/pages',
          { parent: { database_id: cfg.databaseId }, properties },
          {
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              'Notion-Version': '2022-06-28',
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );
        return {
          success: true,
          pageId: res.data.id || '',
          url: res.data.url || '',
        };
      }

      // ── P0: trigger.payment / trigger.posWebhook (pass-through like other triggers) ──────────────
      case 'trigger.payment':
      case 'trigger.posWebhook':
        return { ...ctx.trigger };

      // ── P0: KiotViet POS ─────────────────────────────────────────────────
      case 'kiotviet.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('kiotviet', 'lookupCustomer', {
          phone: cfg.phone,
        });
        const customers: any[] = result.customers || [];
        return { customers, found: customers.length > 0, firstCustomer: customers[0] || null };
      }

      case 'kiotviet.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('kiotviet', 'lookupOrder', {
          phone: cfg.phone,
          orderId: cfg.orderId,
        });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }

      case 'kiotviet.createOrder': {
        let orderObj: any = {};
        try {
          orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : (cfg.order || {});
        } catch {}
        if (!cfg.order || Object.keys(orderObj || {}).length === 0) {
          let orderDetails: any[] = [];
          try {
            orderDetails = Array.isArray(cfg.orderDetails)
              ? cfg.orderDetails
              : JSON.parse(String(cfg.orderDetails || '[]'));
          } catch {}
          orderObj = {
            ...(cfg.branchId ? { branchId: Number(cfg.branchId) } : {}),
            // KiotViet documents the order's customer as customer{ id, … }; customerId kept for older behaviour
            ...(cfg.customerId ? { customerId: cfg.customerId, customer: { id: Number(cfg.customerId) || cfg.customerId } } : {}),
            orderDetails,
            discount: Number(cfg.discount || 0),
            description: cfg.note || undefined,
          };
        }
        const result = await IntegrationRegistry.executeActionByType('kiotviet', 'createOrder', orderObj);
        return { order: result.order || result, success: true };
      }
      case 'kiotviet.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('kiotviet', 'lookupProduct', {
          keyword: cfg.keyword, code: cfg.code, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
      }

      // ── P0: Haravan POS ──────────────────────────────────────────────────
      case 'haravan.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('haravan', 'lookupCustomer', { phone: cfg.phone });
        return { customers: result.customers || [], found: result.found, firstCustomer: result.firstCustomer || null };
      }
      case 'haravan.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('haravan', 'lookupOrder', { phone: cfg.phone, orderId: cfg.orderId });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }
      case 'haravan.createOrder': {
        let orderObj: any = {};
        try { orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order; } catch {}
        const result = await IntegrationRegistry.executeActionByType('haravan', 'createOrder', { order: orderObj });
        return { order: result.order || result, success: true };
      }
      case 'haravan.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('haravan', 'lookupProduct', {
          keyword: cfg.keyword, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
      }

      // ── P0: Sapo POS ─────────────────────────────────────────────────────
      case 'sapo.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('sapo', 'lookupCustomer', { phone: cfg.phone });
        return { customers: result.customers || [], found: result.found, firstCustomer: result.firstCustomer || null };
      }
      case 'sapo.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('sapo', 'lookupOrder', { phone: cfg.phone, orderId: cfg.orderId });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }
      case 'sapo.createOrder': {
        let orderObj: any = {};
        try { orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order; } catch {}
        const result = await IntegrationRegistry.executeActionByType('sapo', 'createOrder', { order: orderObj });
        return { order: result.order || result, success: true };
      }
      case 'sapo.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('sapo', 'lookupProduct', {
          keyword: cfg.keyword, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
      }
      case 'sapo.getInventory': {
        const result = await IntegrationRegistry.executeActionByType('sapo', 'getInventory', {
          limit: Number(cfg.limit || 50),
        });
        return { items: result.items || [] };
      }

      // ── P0: Nhanh.vn ─────────────────────────────────────────────────────
      case 'nhanh.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('nhanh', 'lookupCustomer', { phone: cfg.phone });
        return { customers: result.customers || [], found: result.found, firstCustomer: result.firstCustomer || null };
      }
      case 'nhanh.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('nhanh', 'lookupOrder', { phone: cfg.phone, orderId: cfg.orderId });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }
      case 'nhanh.createOrder': {
        let orderObj: any = {};
        try { orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order; } catch {}
        const result = await IntegrationRegistry.executeActionByType('nhanh', 'createOrder', { order: orderObj });
        return { order: result.order || result, success: true };
      }
      case 'nhanh.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('nhanh', 'lookupProduct', {
          keyword: cfg.keyword, code: cfg.code, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
      }

      // ── P0: Pancake POS ───────────────────────────────────────────────────
      case 'pancake.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('pancake', 'lookupCustomer', { phone: cfg.phone });
        return { customers: result.customers || [], found: result.found, firstCustomer: result.firstCustomer || null };
      }
      case 'pancake.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('pancake', 'lookupOrder', { phone: cfg.phone, orderId: cfg.orderId });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }
      case 'pancake.createOrder': {
        let orderObj: any = {};
        try { orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order; } catch {}
        const result = await IntegrationRegistry.executeActionByType('pancake', 'createOrder', { order: orderObj });
        return { order: result.order || result, success: true };
      }
      case 'pancake.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('pancake', 'lookupProduct', {
          keyword: cfg.keyword, code: cfg.code, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
      }

      // ── P0: Payment (Casso/SePay) ─────────────────────────────────────────
      case 'payment.getTransactions': {
        const type = cfg.integrationType || 'casso';
        const result = await IntegrationRegistry.executeActionByType(type, 'getTransactions', {
          limit: Number(cfg.limit || 20),
          fromDate: cfg.fromDate,
          toDate: cfg.toDate,
        });
        return { transactions: result.transactions || [], total: result.total || 0 };
      }

      // ── P0: GHN Express ──────────────────────────────────────────────────
      case 'ghn.createOrder': {
        let orderObj: any = {};
        try {
          orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : (cfg.order || {});
        } catch {}
        orderObj = {
          ...orderObj,
          ...(cfg.toName ? { to_name: cfg.toName } : {}),
          ...(cfg.toPhone ? { to_phone: cfg.toPhone } : {}),
          ...(cfg.toAddress ? { to_address: cfg.toAddress } : {}),
          // GHN addresses by name (developer.ghn.vn): ward + province; a district name means an old 3-level address
          // (GHNAdapter.prepareGhnOrder sets is_new_to_address)
          ...(cfg.toWardName ? { to_ward_name: cfg.toWardName } : {}),
          ...(cfg.toDistrictName ? { to_district_name: cfg.toDistrictName } : {}),
          ...(cfg.toProvinceName ? { to_province_name: cfg.toProvinceName } : {}),
          // Legacy id fields of older workflows
          ...(cfg.toDistrictId ? { to_district_id: Number(cfg.toDistrictId) } : {}),
          ...(cfg.toWardCode ? { to_ward_code: cfg.toWardCode } : {}),
          ...(cfg.weight ? { weight: Number(cfg.weight) } : {}),
          ...(cfg.serviceTypeId ? { service_type_id: Number(cfg.serviceTypeId) } : {}),
          ...(cfg.codAmount != null && String(cfg.codAmount) !== '' ? { cod_amount: Number(cfg.codAmount) } : {}),
        };
        // Required by GHN; the advanced JSON wins when it already has them
        if (orderObj.required_note == null && cfg.requiredNote) orderObj.required_note = cfg.requiredNote;
        if (orderObj.payment_type_id == null && cfg.paymentTypeId) orderObj.payment_type_id = Number(cfg.paymentTypeId);
        if (!orderObj.content && !(Array.isArray(orderObj.items) && orderObj.items.length) && cfg.content) orderObj.content = cfg.content;
        const result = await IntegrationRegistry.executeActionByType('ghn', 'createOrder', {
          order: orderObj,
        });
        return { order: result.order || {}, orderCode: result.order?.order_code || '', success: true };
      }

      case 'ghn.getTracking': {
        const result = await IntegrationRegistry.executeActionByType('ghn', 'getTracking', {
          orderCode: cfg.orderCode,
        });
        const tracking = result.tracking || {};
        return {
          tracking,
          status: tracking.status || '',
          orderCode: tracking.order_code || cfg.orderCode,
          updatedDate: tracking.updated_date || '',
        };
      }

      case 'ghn.getProvinces': {
        const result = await IntegrationRegistry.executeActionByType('ghn', 'getProvinces', {});
        return { provinces: result.provinces || [] };
      }

      case 'ghn.getDistricts': {
        const result = await IntegrationRegistry.executeActionByType('ghn', 'getDistricts', {
          provinceId: Number(cfg.provinceId || 0),
        });
        return { districts: result.districts || [] };
      }

      case 'ghn.getWards': {
        const result = await IntegrationRegistry.executeActionByType('ghn', 'getWards', {
          districtId: Number(cfg.districtId || 0),
        });
        return { wards: result.wards || [] };
      }

      case 'ghn.getServices': {
        const result = await IntegrationRegistry.executeActionByType('ghn', 'getServices', {
          fromDistrict: Number(cfg.fromDistrict || 0),
          toDistrict: Number(cfg.toDistrict || 0),
        });
        return { services: result.services || [] };
      }

      // ── P0: GHTK ─────────────────────────────────────────────────────────
      case 'ghtk.createOrder': {
        let orderObj: any = {};
        try {
          orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order;
        } catch {}
        const result = await IntegrationRegistry.executeActionByType('ghtk', 'createOrder', orderObj);
        return { order: result.order || {}, trackingCode: result.order?.label || '', success: true };
      }

      case 'ghtk.getTracking': {
        const result = await IntegrationRegistry.executeActionByType('ghtk', 'getTracking', {
          trackingCode: cfg.trackingCode,
        });
        const tracking = result.tracking || {};
        return {
          tracking,
          status: tracking.status_text || tracking.status || '',
          trackingCode: tracking.label || cfg.trackingCode,
        };
      }

      // ── Facebook ─────────────────────────────────────────────────────────────
      case 'fb.trigger.message':
      case 'fb.trigger.image':
      case 'fb.trigger.video':
      case 'fb.trigger.file':
      case 'fb.trigger.sticker':
      case 'fb.trigger.reaction':
      case 'fb.trigger.unsend':
      case 'fb.trigger.groupEvent':
        return { ...ctx.trigger };

      case 'fb.action.sendMessage': {
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.sendMessage] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        if (!cfg.message) throw new Error('[fb.action.sendMessage] message required');
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        if (!targetThreadIds.length) throw new Error('[fb.action.sendMessage] threadId/threadIds required');

        // Parse the structured AI response (same as zalo.sendMessage) - if it is a JSON array of segments
        // join the text back into 1 message, so raw JSON is not sent to the customer
        const segments = parseStructuredResponse(cfg.message);
        const finalMessage = segments
          ? segments
              .filter((s: any) => s.type === 'text' && s.content)
              .map((s: any) => String(s.content).trim())
              .join('\n\n')
          : String(cfg.message || '');

        const continueOnError = cfg.continueOnError === true;
        const tally = newSendTally();
        // Several recipients: space out each one (Facebook easily triggers verification when sending in bursts); a single recipient is sent immediately, as before
        await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (tid) => {
          try {
            const result = await FacebookSendService.sendTextMessage({
              accountId,
              threadId: tid,
              body: finalMessage || String(cfg.message || ''),
              typeChat: Object.prototype.hasOwnProperty.call(cfg, 'typeChat')
                ? cfg.typeChat
                : ctx.trigger?.typeChat,
              replyToMessageId: cfg.replyToMessageId,
            });
            Logger.log(`[WorkflowEngine] fb.action.sendMessage to ${tid}: success=${result.success}, msgId=${result.messageId}`);
            if (!result.success) throw new Error(result.error || tr('Không gửi được tin nhắn đến {{tid}}', { tid }));
            tally.sent++;
            tally.lastMsgId = result.messageId || tally.lastMsgId;
          } catch (err: any) {
            Logger.warn(`[WorkflowEngine] fb.action.sendMessage to ${tid} failed: ${err.message}`);
            tally.failed++;
            tally.lastError = err.message;
            if (!continueOnError) throw err;
          }
        }, { queueKey: `fb:${accountId}`, single: 'direct' });
        const out = this.sendTallyOutput(tally, targetThreadIds.length);
        return { ...out, messageId: tally.lastMsgId || undefined };
      }

      case 'fb.action.addReaction': {
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.addReaction] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const service = await FacebookService.getInstance(accountId);
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!messageId) throw new Error('[fb.action.addReaction] messageId required');
        // FacebookService resolves the message's actual thread and original
        // sender from DB, then chooses encrypted or group reaction safely.
        const result = await service.addReaction(String(messageId), cfg.emoji || '👍', cfg.action || 'add');
        this.assertFacebookActionSucceeded(tr('thả reaction'), result);
        return { success: result.success, ...(result.error ? { error: result.error } : {}) };
      }

      case 'fb.action.sendImage':
      case 'fb.action.sendVideo':
      case 'fb.action.sendFile':
      case 'fb.action.sendAudio': {
        // DEPLAO_ADAPTER: Delegate to FacebookSendService.sendAttachment() —
        // single entry point for all Facebook attachment sends.
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.sendImage] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const targetThreadIds = this.resolveTargetThreadIds(cfg, ctx.trigger?.threadId);
        if (!targetThreadIds.length) throw new Error('[fb.action.sendImage] threadId/threadIds required');
        const requestedFilePath = String(cfg.filePath || '').trim();
        if (!requestedFilePath) throw new Error('[fb.action.sendImage] filePath required');
        const caption = cfg.body || cfg.message || '';
        const continueOnError = cfg.continueOnError === true;

        // Resolve typeChat once from workflow config or trigger context
        const suppliedTypeChat = Object.prototype.hasOwnProperty.call(cfg, 'typeChat')
          ? cfg.typeChat
          : ctx.trigger?.typeChat;

        // The picker also accepts a URL. Download it once to a local temporary
        // file because FacebookSendService correctly validates local files
        // before selecting the E2EE or REST attachment route.
        let filePath = requestedFilePath;
        let temporaryPath = '';
        try {
          if (/^https?:\/\//i.test(requestedFilePath)) {
            temporaryPath = await this.downloadUrlToTempFile(requestedFilePath);
            filePath = temporaryPath;
          }

          const tally = newSendTally();
          await this.forEachRecipient(cfg, ctx, _wf, targetThreadIds, async (threadId) => {
            try {
              const result = await FacebookSendService.sendAttachment({
                accountId,
                threadId: String(threadId),
                filePath,
                body: caption || undefined,
                typeChat: suppliedTypeChat,
              });
              if (!result.success) throw new Error(result.error || tr('Không gửi được tệp đính kèm'));
              Logger.log(`[WorkflowEngine] fb.action.sendImage to ${threadId}: success, msgId=${result.messageId}`);
              tally.sent++;
              tally.lastMsgId = result.messageId || tally.lastMsgId;
            } catch (err: any) {
              Logger.warn(`[WorkflowEngine] fb.action.sendImage to ${threadId} failed: ${err.message}`);
              tally.failed++;
              tally.lastError = err.message;
              if (!continueOnError) throw err;
            }
          }, { queueKey: `fb:${accountId}`, single: 'direct' });
          const out = this.sendTallyOutput(tally, targetThreadIds.length);
          return { ...out, messageId: tally.lastMsgId || undefined };
        } finally {
          if (temporaryPath) {
            try { fs.unlinkSync(temporaryPath); } catch {}
          }
        }
      }

      case 'fb.action.sendTyping': {
        const rawA1 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA1) throw new Error('[fb.action.sendTyping] accountId required');
        const a1 = this.resolveFBAccountId(rawA1);
        const s1 = await FacebookService.getInstance(a1);
        const t1 = cfg.threadId || ctx.trigger?.threadId;
        if (!t1) throw new Error('[fb.action.sendTyping] threadId required');
        await s1.sendTyping(String(t1), cfg.isTyping !== false);
        return { success: true };
      }

      case 'fb.action.markAsRead': {
        const rawA2 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA2) throw new Error('[fb.action.markAsRead] accountId required');
        const a2 = this.resolveFBAccountId(rawA2);
        const s2 = await FacebookService.getInstance(a2);
        const t2 = cfg.threadId || ctx.trigger?.threadId;
        if (!t2) throw new Error('[fb.action.markAsRead] threadId required');
        const result = await s2.markReadOnServer(String(t2));
        this.assertFacebookActionSucceeded(tr('đánh dấu đã đọc'), result);
        return { success: result.success, ...(result.error ? { error: result.error } : {}) };
      }

      case 'fb.action.forward': {
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.forward] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const threadId = String(cfg.targetThreadId || '').trim();
        if (!threadId) throw new Error(tr('[fb.action.forward] Chưa chọn hội thoại nhận'));
        // The message picked in the node (or the trigger message), read from the DB like "Chuyển tiếp đa kênh": its media is
        // re-sent from the local copy and its text is the readable caption, never attachment JSON
        const messageId = String(cfg.messageId || ctx.trigger?.messageId || '').trim();
        let stored: any = null;
        if (messageId) {
          try { stored = DatabaseService.getInstance().getMessageById(accountId, messageId); } catch {}
        }
        const sameAsTrigger = !messageId || messageId === String(ctx.trigger?.messageId || '');
        const triggerForMedia = sameAsTrigger ? ctx.trigger : undefined;
        const isMedia = this.isForwardMedia(stored, triggerForMedia);
        if (messageId && isMedia && !this.getForwardMediaPath(stored)) stored = await this.waitForForwardMedia(accountId, messageId, stored);
        const mediaPath = this.getForwardMediaPath(stored);
        const text = String(cfg.message || '').trim()
          || this.getForwardText(stored?.content ?? (sameAsTrigger ? ctx.trigger?.content : '') ?? '');

        const result = mediaPath
          ? await FacebookSendService.sendAttachment({ accountId, threadId, filePath: mediaPath, body: text || undefined })
          : isMedia
            ? { success: false, error: tr('Tệp nguồn chưa tải xong trong 30 giây; không thể chuyển tiếp') }
            : text
              ? await FacebookSendService.sendTextMessage({ accountId, threadId, body: text })
              : { success: false, error: tr('Tin nguồn không có nội dung để chuyển tiếp') };
        this.assertFacebookActionSucceeded(tr('gửi lại nội dung'), result);
        return {
          success: result.success,
          messageId: (result as any).messageId,
          mediaSent: !!mediaPath,
        };
      }

      case 'fb.action.pin': {
        const rawA4 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA4) throw new Error('[fb.action.pin] accountId required');
        const a4 = this.resolveFBAccountId(rawA4);
        const s4 = await FacebookService.getInstance(a4);
        const m2 = cfg.messageId || ctx.trigger?.messageId;
        if (!m2) throw new Error('[fb.action.pin] messageId required');
        const t3 = cfg.threadId || ctx.trigger?.threadId;
        if (!t3) throw new Error('[fb.action.pin] threadId required');
        const r2 = await s4.pinMessage(String(m2), String(t3));
        this.assertFacebookActionSucceeded(tr('ghim tin nhắn'), r2);
        return { success: r2.success };
      }

      case 'fb.action.unpin': {
        const rawA5 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA5) throw new Error('[fb.action.unpin] accountId required');
        const a5 = this.resolveFBAccountId(rawA5);
        const s5 = await FacebookService.getInstance(a5);
        const m3 = cfg.messageId || ctx.trigger?.messageId;
        if (!m3) throw new Error('[fb.action.unpin] messageId required');
        const t4 = cfg.threadId || ctx.trigger?.threadId;
        if (!t4) throw new Error('[fb.action.unpin] threadId required');
        const r3 = await s5.unpinMessage(String(m3), String(t4));
        this.assertFacebookActionSucceeded(tr('bỏ ghim tin nhắn'), r3);
        return { success: r3.success };
      }

      case 'fb.action.createPoll': {
        const rawA6 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA6) throw new Error('[fb.action.createPoll] accountId required');
        const a6 = this.resolveFBAccountId(rawA6);
        const s6 = await FacebookService.getInstance(a6);
        const t5 = cfg.threadId || ctx.trigger?.threadId;
        if (!t5) throw new Error('[fb.action.createPoll] threadId required');
        if (!cfg.question) throw new Error('[fb.action.createPoll] question required');
        const opts: string[] = String(cfg.options || '').split('\n').map((x: string) => x.trim()).filter(Boolean);
        const r4 = await s6.createPoll(String(t5), String(cfg.question), opts);
        this.assertFacebookActionSucceeded(tr('tạo bình chọn'), r4);
        return { success: r4.success, pollId: r4.pollId };
      }

      case 'fb.action.block': {
        const rawA7 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA7) throw new Error('[fb.action.block] accountId required');
        const a7 = this.resolveFBAccountId(rawA7);
        const s7 = await FacebookService.getInstance(a7);
        const u1 = cfg.userId || ctx.trigger?.fromId;
        if (!u1) throw new Error('[fb.action.block] userId required');
        const r5 = await s7.blockUser(String(u1));
        this.assertFacebookActionSucceeded(tr('chặn người dùng'), r5);
        return { success: r5.success };
      }

      case 'fb.action.unsend': {
        const rawA8 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA8) throw new Error('[fb.action.unsend] accountId required');
        const a8 = this.resolveFBAccountId(rawA8);
        const s8 = await FacebookService.getInstance(a8);
        const m4 = cfg.messageId || ctx.trigger?.messageId;
        if (!m4) throw new Error('[fb.action.unsend] messageId required');
        const r6 = await s8.unsendMessage(String(m4));
        this.assertFacebookActionSucceeded(tr('thu hồi tin nhắn'), r6);
        return { success: r6.success };
      }

      case 'fb.action.editMessage': {
        const rawA9 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA9) throw new Error('[fb.action.editMessage] accountId required');
        const a9 = this.resolveFBAccountId(rawA9);
        const s9 = await FacebookService.getInstance(a9);
        const m5 = cfg.messageId || ctx.trigger?.messageId;
        if (!m5) throw new Error('[fb.action.editMessage] messageId required');
        if (!cfg.text && !cfg.newText) throw new Error('[fb.action.editMessage] text required');
        const editText = cfg.text || cfg.newText || '';
        const r7 = await s9.editMessage(String(m5), String(editText));
        this.assertFacebookActionSucceeded(tr('chỉnh sửa tin nhắn'), r7);
        return { success: r7.success };
      }

      case 'fb.action.changeName': {
        const rawA10 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA10) throw new Error('[fb.action.changeName] accountId required');
        const a10 = this.resolveFBAccountId(rawA10);
        const s10 = await FacebookService.getInstance(a10);
        const t6 = cfg.threadId || ctx.trigger?.threadId;
        if (!t6) throw new Error('[fb.action.changeName] threadId required');
        if (!cfg.name) throw new Error('[fb.action.changeName] name required');
        const r8 = await s10.changeThreadName(String(t6), String(cfg.name));
        this.assertFacebookActionSucceeded(tr('đổi tên nhóm'), r8);
        return { success: r8 };
      }

      case 'fb.action.changeEmoji': {
        const rawA11 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA11) throw new Error('[fb.action.changeEmoji] accountId required');
        const a11 = this.resolveFBAccountId(rawA11);
        const s11 = await FacebookService.getInstance(a11);
        const t7 = cfg.threadId || ctx.trigger?.threadId;
        if (!t7) throw new Error('[fb.action.changeEmoji] threadId required');
        if (!cfg.emoji) throw new Error('[fb.action.changeEmoji] emoji required');
        const r9 = await s11.changeThreadEmoji(String(t7), String(cfg.emoji));
        this.assertFacebookActionSucceeded(tr('đổi biểu tượng nhóm'), r9);
        return { success: r9 };
      }

      case 'fb.action.changeNickname': {
        const rawA12 = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawA12) throw new Error('[fb.action.changeNickname] accountId required');
        const a12 = this.resolveFBAccountId(rawA12);
        const s12 = await FacebookService.getInstance(a12);
        const t8 = cfg.threadId || ctx.trigger?.threadId;
        if (!t8) throw new Error('[fb.action.changeNickname] threadId required');
        const u2 = cfg.userId || ctx.trigger?.fromId;
        if (!u2) throw new Error('[fb.action.changeNickname] userId required');
        if (cfg.nickname === undefined) throw new Error('[fb.action.changeNickname] nickname required');
        const r10 = await s12.changeNickname(String(t8), String(u2), String(cfg.nickname));
        this.assertFacebookActionSucceeded(tr('đổi biệt danh'), r10);
        return { success: r10 };
      }

      // ─── Telegram Actions ──────────────────────────────────────────────────

      case 'tg.sendMessage': {
        const tgAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAccountId) throw new Error('[tg.sendMessage] accountId required');
        const tgChatId = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChatId) throw new Error('[tg.sendMessage] chatId required');
        if (!cfg.message) throw new Error('[tg.sendMessage] message required');
        // Parse structured AI response (same as zalo.sendMessage)
        const tgSegments = parseStructuredResponse(cfg.message);
        const tgMsg = tgSegments
          ? tgSegments
              .filter((s: any) => s.type === 'text' && s.content)
              .map((s: any) => String(s.content).trim())
              .join('\n\n')
          : cfg.message;
        const tgSendResult = await this.sendTelegramMessage(tgAccountId, String(tgChatId), tgMsg);
        return { success: tgSendResult.success, messageId: tgSendResult.messageId, ...(tgSendResult.error ? { error: tgSendResult.error } : {}) };
      }

      case 'tg.sendPhoto': {
        const tgAcc2 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc2) throw new Error('[tg.sendPhoto] accountId required');
        const tgChat2 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat2) throw new Error('[tg.sendPhoto] chatId required');
        if (!cfg.filePath) throw new Error('[tg.sendPhoto] filePath required');
        const tgPhotoResult = await this.sendTelegramPhoto(tgAcc2, String(tgChat2), String(cfg.filePath), cfg.caption || '');
        return { success: tgPhotoResult.success, messageId: tgPhotoResult.messageId, ...(tgPhotoResult.error ? { error: tgPhotoResult.error } : {}) };
      }

      case 'tg.sendFile': {
        const tgAcc3 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc3) throw new Error('[tg.sendFile] accountId required');
        const tgChat3 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat3) throw new Error('[tg.sendFile] chatId required');
        if (!cfg.filePath) throw new Error('[tg.sendFile] filePath required');
        const tgFileResult = await this.sendTelegramFile(tgAcc3, String(tgChat3), String(cfg.filePath), cfg.caption || '');
        return { success: tgFileResult.success, messageId: tgFileResult.messageId, ...(tgFileResult.error ? { error: tgFileResult.error } : {}) };
      }

      case 'tg.sendVideo': {
        const tgAccV = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAccV) throw new Error('[tg.sendVideo] accountId required');
        const tgChatV = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChatV) throw new Error('[tg.sendVideo] chatId required');
        if (!cfg.filePath) throw new Error('[tg.sendVideo] filePath required');
        const tgVideoResult = await this.sendTelegramVideo(tgAccV, String(tgChatV), String(cfg.filePath), cfg.caption || '');
        return { success: tgVideoResult.success, messageId: tgVideoResult.messageId, ...(tgVideoResult.error ? { error: tgVideoResult.error } : {}) };
      }

      case 'tg.sendVoice': {
        const tgAccVo = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAccVo) throw new Error('[tg.sendVoice] accountId required');
        const tgChatVo = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChatVo) throw new Error('[tg.sendVoice] chatId required');
        if (!cfg.filePath) throw new Error('[tg.sendVoice] filePath required');
        const tgVoiceResult = await this.sendTelegramVoice(tgAccVo, String(tgChatVo), String(cfg.filePath), cfg.caption || '');
        return { success: tgVoiceResult.success, messageId: tgVoiceResult.messageId, ...(tgVoiceResult.error ? { error: tgVoiceResult.error } : {}) };
      }

      case 'tg.forwardMessage': {
        const tgAcc4 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc4) throw new Error('[tg.forwardMessage] accountId required');
        const fromChat = cfg.fromChatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!fromChat) throw new Error('[tg.forwardMessage] fromChatId required');
        const toChat = cfg.toChatId;
        if (!toChat) throw new Error('[tg.forwardMessage] toChatId required');
        const fwdMsgId = cfg.messageId || ctx.trigger?.messageId;
        if (!fwdMsgId) throw new Error('[tg.forwardMessage] messageId required');
        const tgFwdResult = await this.forwardTelegramMessage(tgAcc4, String(fromChat), String(toChat), String(fwdMsgId));
        return { success: tgFwdResult.success, ...(tgFwdResult.error ? { error: tgFwdResult.error } : {}) };
      }

      case 'tg.deleteMessage': {
        const tgAcc5 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc5) throw new Error('[tg.deleteMessage] accountId required');
        const tgChat5 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat5) throw new Error('[tg.deleteMessage] chatId required');
        const delMsgId = cfg.messageId || ctx.trigger?.messageId;
        if (!delMsgId) throw new Error('[tg.deleteMessage] messageId required');
        const tgDelResult = await this.deleteTelegramMessage(tgAcc5, String(tgChat5), String(delMsgId));
        return { success: tgDelResult.success, ...(tgDelResult.error ? { error: tgDelResult.error } : {}) };
      }

      case 'tg.editMessage': {
        const tgAcc6 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc6) throw new Error('[tg.editMessage] accountId required');
        const tgChat6 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat6) throw new Error('[tg.editMessage] chatId required');
        const editMsgId = cfg.messageId || ctx.trigger?.messageId;
        if (!editMsgId) throw new Error('[tg.editMessage] messageId required');
        if (!cfg.text) throw new Error('[tg.editMessage] text required');
        const tgEditResult = await this.editTelegramMessage(tgAcc6, String(tgChat6), String(editMsgId), String(cfg.text));
        return { success: tgEditResult.success, ...(tgEditResult.error ? { error: tgEditResult.error } : {}) };
      }

      case 'tg.addReaction': {
        const tgAcc7 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc7) throw new Error('[tg.addReaction] accountId required');
        const tgChat7 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat7) throw new Error('[tg.addReaction] chatId required');
        const reactMsgId = cfg.messageId || ctx.trigger?.messageId;
        if (!reactMsgId) throw new Error('[tg.addReaction] messageId required');
        const tgReactResult = await this.addTelegramReaction(tgAcc7, String(tgChat7), String(reactMsgId), cfg.emoji || '👍');
        return { success: tgReactResult.success, ...(tgReactResult.error ? { error: tgReactResult.error } : {}) };
      }

      case 'tg.pinMessage': {
        const tgAcc8 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc8) throw new Error('[tg.pinMessage] accountId required');
        const tgChat8 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat8) throw new Error('[tg.pinMessage] chatId required');
        const pinMsgId = cfg.messageId || ctx.trigger?.messageId;
        if (!pinMsgId) throw new Error('[tg.pinMessage] messageId required');
        const tgPinResult = await this.pinTelegramMessage(tgAcc8, String(tgChat8), String(pinMsgId));
        return { success: tgPinResult.success, ...(tgPinResult.error ? { error: tgPinResult.error } : {}) };
      }

      case 'tg.sendPoll': {
        const tgAcc9 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc9) throw new Error('[tg.sendPoll] accountId required');
        const tgChat9 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat9) throw new Error('[tg.sendPoll] chatId required');
        if (!cfg.question) throw new Error('[tg.sendPoll] question required');
        const pollOptions: string[] = String(cfg.options || '').split('\n').map((x: string) => x.trim()).filter(Boolean);
        if (pollOptions.length < 2) throw new Error('[tg.sendPoll] at least 2 options required');
        const tgPollResult = await this.sendTelegramPoll(tgAcc9, String(tgChat9), String(cfg.question), pollOptions);
        return { success: tgPollResult.success, messageId: tgPollResult.messageId, ...(tgPollResult.error ? { error: tgPollResult.error } : {}) };
      }

      case 'tg.banMember': {
        const tgAcc10 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc10) throw new Error('[tg.banMember] accountId required');
        const tgChat10 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat10) throw new Error('[tg.banMember] chatId required');
        const banUserId = cfg.userId || ctx.trigger?.fromId;
        if (!banUserId) throw new Error('[tg.banMember] userId required');
        const tgBanResult = await this.banTelegramMember(tgAcc10, String(tgChat10), String(banUserId));
        return { success: tgBanResult.success, ...(tgBanResult.error ? { error: tgBanResult.error } : {}) };
      }

      case 'tg.promoteMember': {
        const tgAcc11 = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!tgAcc11) throw new Error('[tg.promoteMember] accountId required');
        const tgChat11 = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!tgChat11) throw new Error('[tg.promoteMember] chatId required');
        // No fallback to the trigger sender: an empty field would make whoever wrote the message an admin
        const promoteUserId = String(cfg.userId || '').trim();
        if (!promoteUserId) throw new Error(tr('[tg.promoteMember] Thiếu User ID cần thăng / hạ quyền'));
        const isAdmin = cfg.isAdmin === true || cfg.isAdmin === 'true';
        const tgPromoteResult = await this.promoteTelegramMember(tgAcc11, String(tgChat11), String(promoteUserId), isAdmin);
        return { success: tgPromoteResult.success, ...(tgPromoteResult.error ? { error: tgPromoteResult.error } : {}) };
      }

      // ── New Telegram actions ─────────────────────────────────────────────

      case 'tg.trigger.message':
      case 'tg.trigger.unsend':
      case 'tg.trigger.groupEvent':
        return { ...ctx.trigger };

      case 'tg.sendSticker': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.sendSticker] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!chatId) throw new Error('[tg.sendSticker] chatId required');
        if (!cfg.stickerId) throw new Error('[tg.sendSticker] stickerId required');
        const r = await this.tgInvoke(acc, 'sendSticker', { chatId, stickerId: cfg.stickerId, accessHash: cfg.accessHash });
        return r;
      }

      case 'tg.sendTyping': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.sendTyping] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!chatId) throw new Error('[tg.sendTyping] chatId required');
        const r = await this.tgInvoke(acc, 'sendTyping', { chatId });
        return r;
      }

      case 'tg.addMember': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.addMember] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.addMember] chatId required');
        const userId = cfg.userId;
        if (!userId) throw new Error('[tg.addMember] userId required');
        const r = await this.tgInvoke(acc, 'addChatUser', { chatId, userId });
        return r;
      }

      case 'tg.removeMember': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.removeMember] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.removeMember] chatId required');
        const userId = cfg.userId;
        if (!userId) throw new Error('[tg.removeMember] userId required');
        const r = await this.tgInvoke(acc, 'deleteChatUser', { chatId, userId });
        return r;
      }

      case 'tg.markAsRead': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.markAsRead] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId || ctx.trigger?.threadId;
        if (!chatId) throw new Error('[tg.markAsRead] chatId required');
        const r = await this.tgInvoke(acc, 'readChatHistory', { chatId });
        return r;
      }

      case 'tg.markTopicAsRead': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.markTopicAsRead] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.markTopicAsRead] chatId required');
        const topicId = cfg.topicId || ctx.trigger?.topicId;
        if (!topicId) throw new Error('[tg.markTopicAsRead] topicId required');
        const r = await this.tgInvoke(acc, 'readForumTopic', { chatId, topMsgId: topicId });
        return r;
      }

      case 'tg.blockUser': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.blockUser] accountId required');
        const userId = cfg.userId || ctx.trigger?.fromId;
        if (!userId) throw new Error('[tg.blockUser] userId required');
        const r = await this.tgInvoke(acc, 'blockUser', { userId });
        return r;
      }

      case 'tg.unblockUser': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.unblockUser] accountId required');
        const userId = cfg.userId || ctx.trigger?.fromId;
        if (!userId) throw new Error('[tg.unblockUser] userId required');
        const r = await this.tgInvoke(acc, 'unblockUser', { userId });
        return r;
      }

      case 'tg.changeGroupName': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.changeGroupName] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.changeGroupName] chatId required');
        if (!cfg.name) throw new Error('[tg.changeGroupName] name required');
        const r = await this.tgInvoke(acc, 'editChatTitle', { chatId, title: cfg.name });
        return r;
      }

      case 'tg.leaveGroup': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.leaveGroup] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.leaveGroup] chatId required');
        const r = await this.tgInvoke(acc, 'leaveChat', { chatId });
        return r;
      }

      case 'tg.exportInviteLink': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.exportInviteLink] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.exportInviteLink] chatId required');
        const r = await this.tgInvoke(acc, 'exportChatInvite', { chatId });
        return { ...r, link: r.link || '' };
      }

      case 'tg.createForumTopic': {
        const acc = cfg.accountId || ctx.trigger?.accountId;
        if (!acc) throw new Error('[tg.createForumTopic] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tg.createForumTopic] chatId required');
        if (!cfg.title) throw new Error('[tg.createForumTopic] title required');
        const r = await this.tgInvoke(acc, 'createForumTopic', { chatId, title: cfg.title });
        return r;
      }

      // ─── Telegram Bot Actions ──────────────────────────────────────────────

      case 'tgbot.action.sendMessage': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.sendMessage] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.sendMessage] chatId required');
        const resolvedMessage = this.resolveMessageFromConfigOrUpstream(node, cfg, ctx, _wf);
        // No fallback to the customer's own text: an empty node used to echo the message back to them
        const text = resolvedMessage.text;
        if (!text) throw new Error(tr('[tgbot.action.sendMessage] Nội dung tin nhắn đang trống. Nhập nội dung hoặc nối một node tạo văn bản ngay trước node này.'));

        const TelegramBotChannel = require('../telegram/bot/TelegramBotChannelService');
        const replyMarkup = this.buildTelegramBotReplyMarkup(cfg.keyboard);
        const result = await TelegramBotChannel.sendMessage({
          accountId: botAccountId,
          chatId,
          text,
          replyMarkup,
        });
        return { success: result?.success, messageId: result?.messageId, error: result?.error, contentSource: resolvedMessage.source };
      }

      case 'tgbot.action.sendPhoto': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.sendPhoto] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.sendPhoto] chatId required');
        const photoPath = cfg.photoPath || cfg.url;
        if (!photoPath) throw new Error('[tgbot.action.sendPhoto] photoPath required');

        const result = await TelegramBot.sendPhoto(botAccountId, chatId, photoPath, cfg.caption || '');
        return { success: result?.success, messageId: result?.messageId };
      }

      case 'tgbot.action.sendVideo': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const videoPath = cfg.videoPath || cfg.url;
        if (!botAccountId || !chatId || !videoPath) throw new Error('[tgbot.action.sendVideo] accountId, chatId and videoPath required');
        const result = await TelegramBot.sendVideo(botAccountId, chatId, videoPath, cfg.caption || '');
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.sendFile': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId || !cfg.filePath) throw new Error('[tgbot.action.sendFile] accountId, chatId and filePath required');
        const result = await TelegramBot.sendDocument(botAccountId, chatId, cfg.filePath, cfg.caption || '');
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.sendSticker': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId || !cfg.stickerPath) throw new Error('[tgbot.action.sendSticker] accountId, chatId and stickerPath required');
        const result = await TelegramBot.sendSticker(botAccountId, chatId, cfg.stickerPath);
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.sendAudio': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId || !cfg.audioPath) throw new Error('[tgbot.action.sendAudio] accountId, chatId and audioPath required');
        const result = await TelegramBot.sendAudio(botAccountId, chatId, cfg.audioPath, cfg.caption || '');
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.sendVoice': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId || !cfg.voicePath) throw new Error('[tgbot.action.sendVoice] accountId, chatId and voicePath required');
        const result = await TelegramBot.sendVoice(botAccountId, chatId, cfg.voicePath, cfg.caption || '');
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.leaveChat': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId) throw new Error('[tgbot.action.leaveChat] accountId and chatId required');
        const result = await TelegramBot.leaveChat(botAccountId, chatId);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.sendMenu': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.sendMenu] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.sendMenu] chatId required');
        const text = cfg.text || tr('Chọn một tùy chọn:');
        const buttons = cfg.buttons || []; // Array of { text, callback_data }

        // Build inline keyboard
        const inline_keyboard: any[][] = buttons.map((row: any) => {
          if (Array.isArray(row)) {
            return row.map((btn: any) => ({
              text: btn.text || '',
              callback_data: btn.callback_data || '',
            }));
          }
          return [{ text: row.text || '', callback_data: row.callback_data || '' }];
        });

        const TelegramBotChannel = require('../telegram/bot/TelegramBotChannelService');
        const result = await TelegramBotChannel.sendMessage({
          accountId: botAccountId,
          chatId,
          text,
          replyMarkup: { inline_keyboard },
        });
        return { success: result?.success, messageId: result?.messageId };
      }

      case 'tgbot.action.sendForm': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.sendForm] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.sendForm] chatId required');
        const formText = cfg.text || tr('Vui lòng nhập thông tin:');
        const fields = cfg.fields || []; // Array of { label, field_name, required }

        // Build form as text with buttons
        let formContent = formText + '\n\n';
        fields.forEach((f: any, i: number) => {
          formContent += `${i + 1}. ${f.label}${f.required ? ' *' : ''}\n`;
        });

        const TelegramBotChannel = require('../telegram/bot/TelegramBotChannelService');
        const result = await TelegramBotChannel.sendMessage({
          accountId: botAccountId,
          chatId,
          text: formContent,
        });

        // Store form state in context for follow-up messages
        return {
          success: result?.success,
          messageId: result?.messageId,
          formFields: fields,
          formChatId: chatId,
        };
      }

      case 'tgbot.action.forward': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.forward] accountId required');
        const targetChatId = cfg.targetChatId;
        if (!targetChatId) throw new Error('[tgbot.action.forward] targetChatId required');
        const fromChatId = cfg.fromChatId || ctx.trigger?.chatId;
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!fromChatId || !messageId) throw new Error('[tgbot.action.forward] fromChatId and messageId required');

        const result = await TelegramBot.forwardMessage(botAccountId, targetChatId, fromChatId, String(messageId));
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.editMessage': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.editMessage] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.editMessage] chatId required');
        const messageId = cfg.messageId;
        if (!messageId) throw new Error('[tgbot.action.editMessage] messageId required');
        const text = cfg.text || '';

        if (!text) throw new Error('[tgbot.action.editMessage] text required');
        const result = await TelegramBot.editMessage(botAccountId, chatId, String(messageId), text);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.deleteMessage': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.deleteMessage] accountId required');
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!chatId) throw new Error('[tgbot.action.deleteMessage] chatId required');
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!messageId) throw new Error('[tgbot.action.deleteMessage] messageId required');

        const result = await TelegramBot.deleteMessage(botAccountId, chatId, String(messageId));
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.pinMessage': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!botAccountId || !chatId || !messageId) throw new Error('[tgbot.action.pinMessage] accountId, chatId and messageId required');
        const result = await TelegramBot.pinMessage(botAccountId, chatId, String(messageId));
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.unpinMessage': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId) throw new Error('[tgbot.action.unpinMessage] accountId and chatId required');
        const result = await TelegramBot.unpinChatMessage(botAccountId, chatId, cfg.messageId || ctx.trigger?.messageId || undefined);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.addReaction': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!botAccountId || !chatId || !messageId || !cfg.emoji) throw new Error('[tgbot.action.addReaction] accountId, chatId, messageId and emoji required');
        const result = await TelegramBot.addReaction(botAccountId, chatId, String(messageId), cfg.emoji);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.sendPoll': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const options = String(cfg.options || '').split(/\r?\n/).map((item: string) => item.trim()).filter(Boolean);
        if (!botAccountId || !chatId || !cfg.question || options.length < 2) throw new Error('[tgbot.action.sendPoll] accountId, chatId, question and at least two options required');
        const result = await TelegramBot.sendPoll(botAccountId, chatId, cfg.question, options);
        return { success: result.success, messageId: result.messageId, error: result.error };
      }

      case 'tgbot.action.sendChatAction': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        if (!botAccountId || !chatId) throw new Error('[tgbot.action.sendChatAction] accountId and chatId required');
        const result = await TelegramBot.sendChatAction(botAccountId, chatId, cfg.action || 'typing');
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.banMember': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const userId = cfg.userId || ctx.trigger?.fromId;
        if (!botAccountId || !chatId || !userId) throw new Error('[tgbot.action.banMember] accountId, chatId and userId required');
        const minutes = Number(cfg.durationMinutes || 0);
        const untilDate = minutes > 0 ? Math.floor(Date.now() / 1000) + minutes * 60 : undefined;
        const result = await TelegramBot.banChatMember(botAccountId, chatId, String(userId), untilDate);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.restrictMember': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const userId = cfg.userId || ctx.trigger?.fromId;
        if (!botAccountId || !chatId || !userId) throw new Error('[tgbot.action.restrictMember] accountId, chatId and userId required');
        const minutes = Math.max(1, Number(cfg.durationMinutes || 10));
        const result = await TelegramBot.restrictChatMember(botAccountId, chatId, String(userId), { canSendMessages: false }, Math.floor(Date.now() / 1000) + minutes * 60);
        return { success: result.success, error: result.error };
      }

      case 'tgbot.action.unbanMember': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const userId = String(cfg.userId || '').trim();
        if (!botAccountId || !chatId || !userId) throw new Error(tr('[tgbot.action.unbanMember] Thiếu Bot, nhóm hoặc Telegram user ID'));
        // only_if_banned: an unban never removes a member who is still in the group
        const result = await TelegramBot.unbanChatMember(botAccountId, chatId, userId, true);
        return { success: result.success, error: result.error, userId };
      }

      case 'tgbot.action.approveJoinRequest': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        const chatId = cfg.chatId || ctx.trigger?.chatId;
        const userId = String(cfg.userId || ctx.trigger?.fromId || '').trim();
        if (!botAccountId || !chatId || !userId) throw new Error(tr('[tgbot.action.approveJoinRequest] Thiếu Bot, nhóm hoặc người xin vào'));
        const approve = cfg.decision !== 'decline';
        const result = await TelegramBot.answerChatJoinRequest(botAccountId, String(chatId), userId, approve);
        return { success: result.success, error: result.error, decision: approve ? 'approve' : 'decline', userId };
      }

      case 'tgbot.action.answerCallback': {
        const botAccountId = cfg.accountId || ctx.trigger?.accountId || ctx.pageId;
        if (!botAccountId) throw new Error('[tgbot.action.answerCallback] accountId required');
        const callbackQueryId = cfg.callbackQueryId || ctx.trigger?.callbackQueryId;
        if (!callbackQueryId) throw new Error('[tgbot.action.answerCallback] callbackQueryId required');
        const text = cfg.text || '';

        const result = await TelegramBot.answerCallbackQuery(botAccountId, callbackQueryId, text, !!cfg.showAlert);
        return { success: result.success, error: result.error };
      }

      default: {
        // Node/trigger contributed by a plugin: the editor sets cfg.__plugin when it is added from the plugin palette.
        // Unknown nodes without this mark keep the old behavior (skipped).
        if (!cfg?.__plugin) return {};
        const registry = require('../plugins/PluginNodeRegistry').default.getInstance();
        if (cfg.__kind === 'trigger' || registry.isTrigger(node.type)) return { ...ctx.trigger };
        return registry.execute(node.type, cfg, {
          trigger: ctx.trigger,
          variables: ctx.variables,
          pageId: ctx.pageId,
          workflowId: _wf.id,
          workflowName: ctx._wfName,
          nodeId: node.id,
          nodeLabel: String((node as any).label || node.type),
        });
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Push one send task onto the per-account queue (ctx.pageId = the workflow's zaloId).
   * Several workflows on the same account → one shared queue → messages are sent one by one, with a random gap
   * set by the node config (sendDelayMin/MaxSeconds) to avoid spam when many customers message at the same time.
   */
  private enqueueSend<T>(cfg: Record<string, any>, ctx: ExecutionContext, task: () => Promise<T>): Promise<T> {
    const minMs = Number(cfg.sendDelayMinSeconds ?? 0) * 1000;
    const maxMs = Number(cfg.sendDelayMaxSeconds ?? 0) * 1000;
    return AccountSendQueue.getInstance().enqueue(ctx.pageId, task, minMs, maxMs);
  }

  /**
   * Sends in turn to each recipient of a send node.
   *  - 0-1 recipient (auto-reply): as before. Zalo: one turn in the account queue (enqueueSend, spaced by the node's
   *    "Giãn cách gửi" (send gap) setting); Facebook (`single: 'direct'`): sent immediately.
   *  - Several recipients: EACH recipient gets its own turn in the account queue, with a random wait after each turn in
   *    recipientGapRangeMs (at least 5 seconds, like a CRM campaign spacing out contacts). Before this, the whole list was sent
   *    back to back in one turn (the queue only spaced out between node runs). The next recipient is queued only when the queue is idle
   *    (whenIdle) → auto-reply messages of the same account queued during the wait are sent first, instead of waiting for the whole batch.
   * A batch now takes a long time: if the workflow is turned off (it was on when the batch started) or deleted midway, the rest is skipped.
   * `send` throws → stop the remaining recipients (continueOnError is handled by `send` itself, as before).
   */
  private async forEachRecipient(
    cfg: Record<string, any>,
    ctx: ExecutionContext,
    wf: Workflow,
    recipients: string[],
    send: (threadId: string) => Promise<void>,
    opts: { queueKey?: string; single?: 'queue' | 'direct' } = {},
  ): Promise<void> {
    if (recipients.length <= 1) {
      const sendAll = async () => { for (const threadId of recipients) await send(threadId); };
      return opts.single === 'direct' ? sendAll() : this.enqueueSend(cfg, ctx, sendAll);
    }
    const [minMs, maxMs] = recipientGapRangeMs(cfg);
    const queueKey = opts.queueKey ?? ctx.pageId;
    const existedAtStart = this.workflows.has(wf.id);
    const stopped = (): boolean => {
      const live = this.workflows.get(wf.id);
      return live ? (wf.enabled && !live.enabled) : existedAtStart;
    };
    Logger.info(`[WorkflowEngine] "${wf.name}": gửi ${recipients.length} người nhận, giãn cách ${Math.round(minMs / 1000)}–${Math.round(maxMs / 1000)} giây`);
    const queue = AccountSendQueue.getInstance();
    for (let i = 0; i < recipients.length; i++) {
      const threadId = recipients[i];
      if (i > 0) await queue.whenIdle(queueKey);
      await queue.enqueue(queueKey, async () => {
        if (i > 0 && stopped()) {
          throw new Error(tr('Workflow đã tắt hoặc bị xoá — dừng gửi, còn {{v1}}/{{count}} người nhận chưa gửi', { v1: recipients.length - i, count: recipients.length }));
        }
        await send(threadId);
      }, minMs, maxMs);
    }
  }

  /**
   * Output of a send node over its recipients: sentCount / failedCount. success = false only when every recipient failed
   * (runWorkflowNode then records the node as failed); a partial failure keeps success = true and carries the last error.
   */
  private sendTallyOutput(tally: SendTally, total: number, extra: Record<string, any> = {}): Record<string, any> {
    const out: Record<string, any> = { ...extra, success: tally.failed === 0 || tally.sent > 0, sentCount: tally.sent, failedCount: tally.failed, _targetCount: total };
    if (tally.lastMsgId) out.msgId = tally.lastMsgId;
    if (tally.failed > 0 && tally.lastError) out.error = tally.lastError;
    return out;
  }

  /** No recipient: an empty dynamic list ("Chọn đối tượng nhận tin") is a normal outcome; a node without any target is a setup error. */
  private noRecipientsOutput(cfg: Record<string, any>, nodeType: string): Record<string, any> {
    if (String(cfg.threadIdsExpr || '').trim()) return { success: true, skipped: true, sentCount: 0, failedCount: 0, _targetCount: 0 };
    throw new Error(tr('[{{nodeType}}] Chưa có hội thoại nhận: chọn hội thoại trong node, hoặc dùng trigger có hội thoại', { nodeType }));
  }

  /**
   * Zalo API of the workflow's account. Never switches to another account: a reply sent from the wrong account goes to a
   * stranger (or fails). Only a workflow without any account picked uses the single connected Zalo account.
   */
  private getApi(pageId: string): any {
    let conn = pageId ? ConnectionManager.getConnection(pageId) : undefined;
    if (!pageId) {
      const connected = [...ConnectionManager.getAllConnections()].map(([, c]) => c).filter((c: any) => c?.connected && c?.api);
      if (connected.length === 1) conn = connected[0];
      else if (connected.length > 1) throw new Error(tr('Workflow chưa chọn tài khoản Zalo mà đang có {{count}} tài khoản kết nối: chọn tài khoản trong cài đặt workflow', { count: connected.length }));
    }
    if (!conn || !conn.api) throw new Error(tr('Account {{v1}} không connected', { v1: pageId || 'unknown' }));
    return conn.api;
  }

  private getAccountChannel(accountId: string): string {
    if (!accountId) return '';
    try {
      return String((DatabaseService.getInstance().getAccounts?.() || [])
        .find((account: any) => String(account.zalo_id) === String(accountId))?.channel || 'zalo');
    } catch {
      return '';
    }
  }

  private getForwardText(raw: any): string {
    if (raw === null || raw === undefined || raw === 'null') return '';
    if (typeof raw !== 'string') return String(raw || '').trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed.trim();
      if (parsed?.msg) return String(parsed.msg).trim();
      if (parsed?.text) return String(parsed.text).trim();
      // Attachment-shaped JSON is not a human-readable caption.
      if (parsed?.href || parsed?.thumb || parsed?.title) return '';
    } catch {}
    return raw.trim();
  }

  /** A returned { success: false } must fail the node, not produce a green run. */
  private assertFacebookActionSucceeded(action: string, result: any): void {
    const success = typeof result === 'boolean' ? result : result?.success;
    if (!success) throw new Error(result?.error || tr('Facebook không thể {{action}}', { action }));
  }

  private getForwardMediaPath(message: any): string {
    if (!message) return '';
    try {
      const paths = typeof message.local_paths === 'string' ? JSON.parse(message.local_paths || '{}') : (message.local_paths || {});
      const candidate = paths.file || paths.video || paths.voice || paths.main || paths.hd
        || Object.values(paths).find((value: any) => typeof value === 'string' && value) || '';
      if (!candidate || typeof candidate !== 'string') return '';
      const normalized = candidate.startsWith('local-media:///') ? candidate.replace('local-media:///', '')
        : candidate.startsWith('local-media://') ? candidate.replace('local-media://', '') : candidate;
      return fs.existsSync(normalized) ? normalized : '';
    } catch {
      return '';
    }
  }

  private isForwardMedia(message: any, trigger: any): boolean {
    const attachment = Array.isArray(trigger?.attachments) ? trigger.attachments[0] : trigger?.attachments;
    const type = String(
      message?.msg_type || message?.type || trigger?.msgType ||
      attachment?.attachmentType || attachment?.type || '',
    ).toLowerCase();
    return ['image', 'photo', 'picture', 'video', 'video_note', 'audio', 'voice', 'file', 'document', 'sticker'].includes(type);
  }

  /** Wait only for the downloader of the message currently being forwarded. */
  private async waitForForwardMedia(accountId: string, messageId: string, initialMessage: any): Promise<any> {
    const deadline = Date.now() + 30_000;
    let message = initialMessage;
    while (Date.now() < deadline) {
      if (this.getForwardMediaPath(message)) return message;
      await new Promise(resolve => setTimeout(resolve, 400));
      try { message = DatabaseService.getInstance().getMessageById(accountId, messageId) || message; } catch {}
    }
    return message;
  }

  /** targetThreadType is a Zalo-only knob. Facebook resolves the target from its DB. */
  private resolveForwardTargetThreadType(channel: string, cfg: Record<string, any>): number | undefined {
    if (channel !== 'zalo' || cfg.targetThreadType === undefined || cfg.targetThreadType === '') return undefined;
    return Number(cfg.targetThreadType) === 1 ? 1 : 0;
  }

  private async sendForwardText(channel: string, accountId: string, chatId: string, text: string, threadType?: number): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (channel === 'zalo') {
      try {
        const result = await this.getApi(accountId).sendMessage({ msg: text, attachments: [] }, chatId, threadType ?? 0);
        return { success: result?.success !== false, messageId: result?.msgId || result?.messageId };
      } catch (err: any) { return { success: false, error: err.message }; }
    }
    if (channel === 'facebook') {
      const typeChat = threadType === 0 ? 'user' : threadType === 1 ? null : undefined;
      const result = await FacebookSendService.sendTextMessage({ accountId: this.resolveFBAccountId(accountId), threadId: chatId, body: text, typeChat });
      return { success: !!result.success, messageId: result.messageId, error: result.error };
    }
    if (channel === 'telegram_bot') return TelegramBot.sendMessage(accountId, chatId, text);
    if (channel === 'telegram_user') return TelegramUser.sendMessage(accountId, chatId, text);
    return { success: false, error: tr('Kênh đích không hỗ trợ: {{channel}}', { channel }) };
  }

  private async sendForwardMedia(channel: string, accountId: string, chatId: string, filePath: string, mediaType: string, threadType?: number): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const kind = mediaType.toLowerCase();
    const isImage = ['photo', 'image', 'picture'].includes(kind);
    const isVideo = ['video', 'video_note'].includes(kind);
    if (channel === 'zalo') {
      try {
        const result = await this.getApi(accountId).sendMessage({ msg: '', attachments: [filePath] }, chatId, threadType ?? 0);
        return { success: result?.success !== false, messageId: result?.msgId || result?.messageId };
      } catch (err: any) { return { success: false, error: err.message }; }
    }
    if (channel === 'facebook') {
      // DEPLAO_ADAPTER: Delegate to FacebookSendService.sendAttachment().
      const typeChat = threadType === 0 ? 'user' : threadType === 1 ? null : undefined;
      return FacebookSendService.sendAttachment({
        accountId: this.resolveFBAccountId(accountId),
        threadId: chatId,
        filePath,
        typeChat,
      });
    }
    if (channel === 'telegram_bot') {
      if (isImage) return TelegramBot.sendPhoto(accountId, chatId, filePath);
      if (isVideo) return TelegramBot.sendVideo(accountId, chatId, filePath);
      return TelegramBot.sendDocument(accountId, chatId, filePath);
    }
    if (channel === 'telegram_user') return TelegramUser.sendFile(accountId, chatId, filePath, '');
    return { success: false, error: tr('Kênh đích không hỗ trợ: {{channel}}', { channel }) };
  }

  private async forwardNativeMessage(channel: string, accountId: string, sourceChatId: string, targetChatId: string, messageId: string, sourceMessage: any): Promise<{ success: boolean; error?: string }> {
    if (channel === 'telegram_user' || channel === 'telegram_bot') {
      return this.forwardTelegramMessage(accountId, sourceChatId, targetChatId, messageId);
    }
    if (channel === 'facebook') {
      // DEPLAO_ADAPTER: Don't pass source message type — forwardMessage()
      // resolves target thread kind from DB via resolveThreadKind().
      // Passing sourceMessage.is_group would incorrectly route a group→user
      // forward as group, or user→group as user.
      try {
        const service = await FacebookService.getInstance(this.resolveFBAccountId(accountId));
        const result = await service.forwardMessage(messageId, targetChatId);
        return { success: !!result.success, error: result.error };
      } catch (err: any) { return { success: false, error: err.message }; }
    }
    if (channel === 'zalo') {
      try {
        const result = await this.getApi(accountId).forwardMessage({
          message: '', reference: { id: messageId, ts: sourceMessage?.timestamp || Date.now(), logSrcType: 0, fwLvl: 0 },
        }, [targetChatId], Number(sourceMessage?.thread_type || 0));
        return { success: result?.success !== false, error: result?.error };
      } catch (err: any) { return { success: false, error: err.message }; }
    }
    return { success: false, error: tr('Kênh nguồn không hỗ trợ: {{channel}}', { channel }) };
  }

  // ─── Telegram Helpers ─────────────────────────────────────────────────────

  /** Detect if account is telegram_bot (Bot API) or telegram_user (MTProto) */
  private isTelegramBotAccount(accountId: string): boolean {
    try {
      const accounts = DatabaseService.getInstance().getAccounts?.() || [];
      const acc = accounts.find((a: any) => a.zalo_id === accountId);
      return acc?.channel === 'telegram_bot';
    } catch {
      return false;
    }
  }

  /** Generic Telegram User API invoke by name */
  private async tgInvoke(accountId: string, method: string, params: Record<string, any>): Promise<any> {
    const TelegramUser = require('../telegram/TelegramUserListener');
    switch (method) {
      case 'sendSticker': return await TelegramUser.sendSticker(accountId, params.chatId, params.stickerId, params.accessHash);
      case 'sendTyping': return await TelegramUser.sendTyping(accountId, params.chatId);
      case 'addChatUser': return await TelegramUser.addChatUser(accountId, params.chatId, params.userId);
      case 'deleteChatUser': return await TelegramUser.deleteChatUser(accountId, params.chatId, params.userId);
      case 'readChatHistory': return await TelegramUser.readChatHistory(accountId, params.chatId);
      case 'readForumTopic': return await TelegramUser.readForumTopic(accountId, params.chatId, params.topMsgId);
      case 'blockUser': return await TelegramUser.blockUser(accountId, params.userId);
      case 'unblockUser': return await TelegramUser.unblockUser(accountId, params.userId);
      case 'editChatTitle': return await TelegramUser.editChatTitle(accountId, params.chatId, params.title);
      case 'leaveChat': return await TelegramUser.leaveChat(accountId, params.chatId);
      case 'exportChatInvite': return await TelegramUser.exportChatInvite(accountId, params.chatId);
      case 'createForumTopic': return await TelegramUser.createForumTopic(accountId, params.chatId, params.title);
      default: throw new Error(`[tgInvoke] Unknown method: ${method}`);
    }
  }

  private async sendTelegramMessage(accountId: string, chatId: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendMessage(accountId, chatId, text);
      }
      return await TelegramUser.sendMessage(accountId, chatId, text);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async sendTelegramPhoto(accountId: string, chatId: string, filePath: string, caption: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendPhoto(accountId, chatId, filePath, caption);
      }
      // MTProto: use sendFile which handles all media types
      return await TelegramUser.sendFile(accountId, chatId, filePath, caption);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async sendTelegramFile(accountId: string, chatId: string, filePath: string, caption: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendDocument(accountId, chatId, filePath, caption);
      }
      return await TelegramUser.sendFile(accountId, chatId, filePath, caption);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async sendTelegramVideo(accountId: string, chatId: string, filePath: string, caption: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendVideo(accountId, chatId, filePath, caption);
      }
      // MTProto: sendFile auto-detects media type from the file (mp4 → video).
      return await TelegramUser.sendFile(accountId, chatId, filePath, caption);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async sendTelegramVoice(accountId: string, chatId: string, filePath: string, caption: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendVoice(accountId, chatId, filePath, caption);
      }
      // MTProto: sendFile auto-detects media type from the file (ogg → voice note).
      return await TelegramUser.sendFile(accountId, chatId, filePath, caption);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async forwardTelegramMessage(accountId: string, fromChatId: string, toChatId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.forwardMessage(accountId, toChatId, fromChatId, messageId);
      }
      return await TelegramUser.forwardMessages(accountId, fromChatId, toChatId, [messageId]);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async deleteTelegramMessage(accountId: string, chatId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.deleteMessage(accountId, chatId, messageId);
      }
      return await TelegramUser.deleteMessages(accountId, chatId, [messageId]);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async editTelegramMessage(accountId: string, chatId: string, messageId: string, text: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.editMessage(accountId, chatId, messageId, text);
      }
      return await TelegramUser.editMessage(accountId, chatId, messageId, text);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async addTelegramReaction(accountId: string, chatId: string, messageId: string, emoji: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.addReaction(accountId, chatId, messageId, emoji);
      }
      return await TelegramUser.sendReaction(accountId, chatId, messageId, emoji);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async pinTelegramMessage(accountId: string, chatId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.pinMessage(accountId, chatId, messageId);
      }
      return await TelegramUser.pinMessage(accountId, chatId, messageId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async sendTelegramPoll(accountId: string, chatId: string, question: string, options: string[]): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.sendPoll(accountId, chatId, question, options);
      }
      // MTProto: no direct sendPoll export, return not supported
      return { success: false, error: 'sendPoll not supported for telegram_user yet' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async banTelegramMember(accountId: string, chatId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.banChatMember(accountId, chatId, userId);
      }
      return await TelegramUser.deleteChatUser(accountId, chatId, userId);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async promoteTelegramMember(accountId: string, chatId: string, userId: string, isAdmin: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isTelegramBotAccount(accountId)) {
        return await TelegramBot.promoteChatMember(accountId, chatId, userId);
      }
      return await TelegramUser.editChatAdmin(accountId, chatId, userId, isAdmin);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private topologicalSort(wf: Workflow): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const node of wf.nodes) { inDegree.set(node.id, 0); adj.set(node.id, []); }
    for (const edge of wf.edges) {
      // These dashed edges document an interaction route in the editor. They
      // are activated only by an actual Bot API callback, never by normal flow.
      if (edge.data?.telegramInline) continue;
      adj.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const result: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      result.push(id);
      for (const next of adj.get(id) ?? []) {
        const d = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    // ⚠️ If the graph has a cycle, the topological sort cannot process it
    // Only return nodes that can be sorted (no cycle)
    Logger.warn(`[WorkflowEngine] topologicalSort: ${result.length}/${wf.nodes.length} nodes sorted, ${wf.nodes.length - result.length} nodes skipped due to cycle(s)`);
    return result;
  }

  /**
   * Nodes that only run after a Telegram Bot inline button is pressed: the buttons' target nodes (from the keyboards and the
   * dashed route edges) and what follows them, minus anything the trigger also reaches through normal edges. Without this
   * the normal run executed them right away (they have no incoming normal edge), before anyone pressed a button.
   */
  private inlineButtonOnlyNodes(wf: Workflow, triggeredBy: string): Set<string> {
    const targets = new Set<string>();
    for (const edge of wf.edges) if (edge.data?.telegramInline) targets.add(edge.target);
    for (const node of wf.nodes) {
      const keyboard = node.type === 'tgbot.action.sendMessage' ? node.config?.keyboard : null;
      if (!keyboard?.enabled || keyboard.type !== 'inline' || !Array.isArray(keyboard.rows)) continue;
      for (const button of keyboard.rows.flat()) {
        if (button && (button.action || 'node') === 'node' && button.targetNodeId) targets.add(String(button.targetNodeId));
      }
    }
    const result = new Set<string>();
    if (!targets.size) return result;
    for (const target of targets) {
      if (!wf.nodes.some(node => node.id === target)) continue;
      for (const id of this.getReachableWorkflowNodes(wf, target)) result.add(id);
    }
    const trigger = wf.nodes.find(node => node.type === triggeredBy)
      || wf.nodes.find(node => node.type.startsWith('trigger.') || node.type.includes('.trigger.'));
    if (trigger) for (const id of this.getReachableWorkflowNodes(wf, trigger.id)) result.delete(id);
    return result;
  }

  /** Nodes to execute after an inline button is pressed (normal edges only). */
  private getReachableWorkflowNodes(wf: Workflow, startNodeId: string): Set<string> {
    const reached = new Set<string>([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
      const nodeId = queue.shift()!;
      for (const edge of wf.edges) {
        if (edge.source !== nodeId || edge.data?.telegramInline || reached.has(edge.target)) continue;
        reached.add(edge.target);
        queue.push(edge.target);
      }
    }
    return reached;
  }

  /** Resolve target thread IDs from cfg, supports both threadIds (JSON array) and the old threadId (string) */
  private resolveTargetThreadIds(cfg: Record<string, any>, triggerThreadId?: string): string[] {
    if (cfg.threadIds) {
      try {
        const parsed = JSON.parse(cfg.threadIds);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(String);
      } catch {}
    }
    if (cfg.threadIdsExpr) {
      try {
        const parsed = JSON.parse(String(cfg.threadIdsExpr));
        // An empty dynamic list means "nobody", never "the conversation that triggered the workflow"
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {}
    }
    // threadIds with one plain id (not a JSON array): the conversation picker used to ignore contactMode
    // → the single id was saved and ignored (sent to the trigger conversation). Placed after threadIdsExpr so the dynamic list
    // (select recipients) still takes priority, as before.
    if (typeof cfg.threadIds === 'string' && cfg.threadIds.trim() && !cfg.threadIds.trim().startsWith('[')) {
      const ids = parseIdList(cfg.threadIds);
      if (ids.length > 0) return ids;
    }
    if (cfg.threadId) return [String(cfg.threadId)];
    if (triggerThreadId) return [triggerThreadId];
    return [];
  }

  /**
   * Audience: resolve the threadId list from the chosen source
   * (friends / group members / local label / CRM contacts) for the Zalo account.
   * Returns threadIds + items so the send node can loop over each recipient.
   */
  private async resolveAudience(cfg: Record<string, any>, ctx: ExecutionContext): Promise<{ threadIds: string[]; items: Array<{ threadId: string; name: string }> }> {
    const db = DatabaseService.getInstance();
    const owner = String(cfg.accountId || cfg.pageId || ctx.pageId || '');
    const limit = Math.max(1, Math.min(5000, Number(cfg.limit || 500)));
    const source = cfg.source || 'friends';
    // Exclude recipients (excludeIds): applied BEFORE the limit so there are still `limit` recipients when possible
    const excludedIds = new Set(parseIdList(cfg.excludeIds));
    const notExcluded = (id: unknown): boolean => !excludedIds.has(String(id ?? '').trim());
    let threadIds: string[] = [];
    let items: Array<{ threadId: string; name: string }> = [];

    if (!owner) return { threadIds, items };

    switch (source) {
      case 'friends': {
        const friends = db.getFriends(owner).filter(f => notExcluded(f.userId)).slice(0, limit);
        threadIds = friends.map(f => String(f.userId)).filter(Boolean);
        items = friends.map(f => ({ threadId: String(f.userId), name: f.displayName || f.userId }));
        break;
      }
      case 'group_members': {
        if (!cfg.groupId) throw new Error(tr('[logic.forEachContact] groupId required khi chọn nguồn "thành viên nhóm"'));
        const members = db.getGroupMembers(owner, String(cfg.groupId)).filter(m => notExcluded(m.member_id)).slice(0, limit);
        threadIds = members.map(m => String(m.member_id)).filter(Boolean);
        items = members.map(m => ({ threadId: String(m.member_id), name: m.display_name || m.member_id }));
        break;
      }
      case 'labels': {
        // The label picker saves "local:<id>" (the Zalo label "zalo:<acc>:<id>" does not apply to this source) or a number.
        // Labels were chosen but none is usable → nobody (for bulk sends: does not expand to "all labels").
        const rawLabelIds: unknown[] = Array.isArray(cfg.labelIds) ? cfg.labelIds : [];
        const labelIds: number[] = rawLabelIds
          .map((x: any) => {
            const value = String(x ?? '').trim();
            if (value.startsWith('zalo:')) return NaN;
            return Number(value.startsWith('local:') ? value.slice('local:'.length) : value);
          })
          .filter((id: number) => Number.isFinite(id));
        const rows = db.getLocalLabelThreads(owner);
        const filtered = rawLabelIds.length ? rows.filter(r => labelIds.includes(Number(r.label_id))) : rows;
        const unique = [...new Set(filtered.map(r => String(r.thread_id)).filter(Boolean))].filter(notExcluded).slice(0, limit);
        threadIds = unique;
        items = unique.map(t => ({ threadId: t, name: t }));
        break;
      }
      case 'crm_contacts': {
        // getCRMContacts pages by limit → fetch extra rows equal to the number of excluded ids, so the recipient count is not short
        // (the extra count is capped so the IN (...) clause does not exceed SQLite's parameter limit)
        const res = db.getCRMContacts(owner, { limit: limit + Math.min(excludedIds.size, 20000) });
        const contacts = res.contacts.filter((c: any) => notExcluded(c.contact_id)).slice(0, limit);
        threadIds = contacts.map((c: any) => String(c.contact_id)).filter(Boolean).slice(0, limit);
        items = contacts.map((c: any) => ({ threadId: String(c.contact_id), name: c.display_name || c.alias || c.contact_id }));
        break;
      }
      default:
        throw new Error(`[logic.forEachContact] unsupported source: ${source}`);
    }

    return { threadIds, items };
  }

  /**
   * Converts the editor's compact keyboard model to Telegram Bot API markup.
   * Never invent callback payloads: generic callbacks must be supplied by the
   * editor, while routed buttons use a short button id payload (Bot API caps
   * callback_data at 64 bytes).
   */
  private buildTelegramBotReplyMarkup(keyboard: any): Record<string, any> | undefined {
    if (!keyboard?.enabled) return undefined;
    const rows = Array.isArray(keyboard.rows) ? keyboard.rows : [];
    if (!rows.length) return undefined;

    if (keyboard.type === 'reply') {
      const replyKeyboard = rows
        .map((row: any) => (Array.isArray(row) ? row : [row]))
        .map((row: any[]) => row
          .map(btn => String(btn?.text || '').trim())
          .filter(Boolean),
        )
        .filter((row: string[]) => row.length > 0);
      return replyKeyboard.length ? {
        keyboard: replyKeyboard,
        resize_keyboard: keyboard.resize !== false,
        one_time_keyboard: !!keyboard.oneTime,
        is_persistent: !!keyboard.persistent,
      } : undefined;
    }

    const inlineKeyboard = rows
      .map((row: any) => (Array.isArray(row) ? row : [row]))
      .map((row: any[]) => row.map((btn: any) => {
        const text = String(btn?.text || '').trim();
        if (!text) return null;
        if (btn.action === 'url') {
          const url = String(btn.url || '').trim();
          return url ? { text, url } : null;
        }
        const callbackData = btn.action === 'node'
          ? `dlw:n:${String(btn.id || '').trim()}`
          : String(btn.callbackData || '').trim();
        if (!callbackData || Buffer.byteLength(callbackData, 'utf8') > 64) return null;
        return { text, callback_data: callbackData };
      }).filter(Boolean))
      .filter((row: any[]) => row.length > 0);
    return inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined;
  }

  private renderConfig(config: Record<string, any>, ctx: ExecutionContext): Record<string, any> {
    const rendered: Record<string, any> = {};
    for (const [key, value] of Object.entries(config)) {
      rendered[key] = typeof value === 'string' ? this.renderTemplate(value, ctx) : value;
    }
    return rendered;
  }

  /**
   * A text-format node is commonly connected directly to a notification node.
   * Make that connection useful without requiring users to paste a node token
   * into the message field. An explicit message (including a template that
   * renders empty) remains authoritative, so a mistyped variable is not
   * replaced with unrelated workflow data.
   */
  private resolveMessageFromConfigOrUpstream(
    node: WorkflowNode,
    cfg: Record<string, any>,
    ctx: ExecutionContext,
    wf: Workflow,
  ): { text: string; source: 'config' | 'upstream' | 'none' } {
    const configured = String(node.config?.message ?? node.config?.text ?? '').trim();
    const rendered = String(cfg.message ?? cfg.text ?? '').trim();
    if (configured || rendered) return { text: rendered, source: rendered ? 'config' : 'none' };

    const directSources = wf.edges
      .filter(edge => edge.target === node.id && !edge.data?.telegramInline)
      .map(edge => edge.source);
    for (const sourceId of directSources) {
      const text = this.getTextOutput(ctx.nodes[sourceId]?.output);
      if (text) return { text, source: 'upstream' };
    }

    // Legacy workflows can omit the visual edge while still execute in order.
    // Only consider dedicated text-producing nodes to avoid sending a JSON
    // object or an IF result by accident.
    for (const sourceId of Object.keys(ctx.nodes).reverse()) {
      const sourceNode = ctx._wfNodes?.find(candidate => candidate.id === sourceId);
      if (!sourceNode || !['data.textFormat', 'data.randomPick', 'data.dateFormat', 'ai.generateText'].includes(sourceNode.type)) continue;
      const text = this.getTextOutput(ctx.nodes[sourceId]?.output);
      if (text) return { text, source: 'upstream' };
    }
    return { text: '', source: 'none' };
  }

  private getTextOutput(output: any): string {
    if (typeof output === 'string') return output.trim();
    if (!output || typeof output !== 'object') return '';
    for (const key of ['result', 'text', 'message', 'content']) {
      if (typeof output[key] === 'string' && output[key].trim()) return output[key].trim();
    }
    return '';
  }

  private renderTemplate(template: string, ctx: ExecutionContext): string {
    return template.replace(/\{\{\s*([\s\S]*?)\s*\}\}/gu, (_, raw) => {
      try {
        const expr = raw.trim();
        if (expr.startsWith('$trigger.')) {
          const val = this.getNestedValue(ctx.trigger, expr.slice(9));
          return String(val ?? '');
        }
        if (expr.startsWith('$var.'))       return this.formatVariableValue(this.getVariableValue(ctx, expr.slice(5)));
        if (expr === '$pageId')             return ctx.pageId ?? '';
        // Text sent to customers: Vietnamese date format whatever the app UI language is
        if (expr === '$date.now')           return new Date().toLocaleString(workflowLocale(''), { timeZone: 'Asia/Ho_Chi_Minh' });
        if (expr === '$date.today')         return new Date().toLocaleDateString(workflowLocale(''), { timeZone: 'Asia/Ho_Chi_Minh' });
        if (expr.startsWith('$node.')) {
          const rest = expr.slice(6);
          const dotIdx = rest.indexOf('.');
          if (dotIdx === -1) return '';
          const nodeRef = rest.slice(0, dotIdx);
          const field = rest.slice(dotIdx + 1);
          // Match by nodeId or by node label
          for (const [nid, ndata] of Object.entries(ctx.nodes)) {
            const nodeDef = ctx._wfNodes?.find(n => n.id === nid);
            const labelOrId = nodeDef?.label || nid;
            if (nid === nodeRef || labelOrId === nodeRef) {
              // $node.X.output → return the whole output object (not getNestedValue on it)
              if (field === 'output') {
                const out = ndata.output;
                const val = typeof out === 'string' ? out : (out?.result ?? out?.text ?? out?.message ?? JSON.stringify(out ?? ''));
                Logger.info(`[WorkflowEngine] $node.${nodeRef}.output → matched by ${nid === nodeRef ? 'id' : 'label'}("${labelOrId}"), value="${String(val).substring(0, 200)}"`);
                return String(val);
              }
              const val = this.getNestedValue(ndata.output, field);
              Logger.info(`[WorkflowEngine] $node.${nodeRef}.${field} → matched by ${nid === nodeRef ? 'id' : 'label'}("${labelOrId}"), value="${String(val ?? '').substring(0, 200)}"`);
              return String(val ?? '');
            }
          }
          // Fallback: match "n4" → 4th node by array order (legacy template IDs like n1,n2,n3...)
          const idxMatch = nodeRef.match(/^n(\d+)$/);
          if (idxMatch && ctx._wfNodes) {
            const targetIdx = parseInt(idxMatch[1]) - 1;
            if (targetIdx >= 0 && targetIdx < ctx._wfNodes.length) {
              const targetNodeId = ctx._wfNodes[targetIdx].id;
              const ndata = ctx.nodes[targetNodeId];
              if (ndata) {
                let val: any;
                if (field === 'output') {
                  const out = ndata.output;
                  val = typeof out === 'string' ? out : (out?.result ?? out?.text ?? out?.message ?? JSON.stringify(out ?? ''));
                } else {
                  val = this.getNestedValue(ndata.output, field);
                }
                Logger.info(`[WorkflowEngine] $node.${nodeRef}.${field} → fallback n${targetIdx + 1} → node "${ctx._wfNodes[targetIdx].label}" (${targetNodeId}), value="${String(val ?? '').substring(0, 200)}"`);
                return String(val ?? '');
              }
            }
            Logger.warn(`[WorkflowEngine] $node.${nodeRef}.${field} → fallback n${targetIdx + 1} FAILED - no output for node at index ${targetIdx}. Available nodes: ${ctx._wfNodes.map((n, i) => `n${i+1}=${n.label}`).join(', ')}`);
          }
        }
      } catch {}
      return '';
    });
  }

  /**
   * {{ $var.<name> }}: a saved variable, or one field of a variable. Items of "Lặp qua danh sách" (loop over list) are often objects
   * ({{ $var.item.name }}, {{ $var.item.variants[0].sku }}). A variable name with a dot, saved verbatim, still takes priority.
   */
  private getVariableValue(ctx: ExecutionContext, path: string): any {
    const vars = ctx.variables || {};
    if (Object.prototype.hasOwnProperty.call(vars, path)) return vars[path];
    return /[.[]/.test(path) ? this.getNestedValue(vars, path) : undefined;
  }

  /** Object / array variable (list item) → JSON instead of "[object Object]". */
  private formatVariableValue(value: any): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return ''; }
    }
    return String(value);
  }

  /**
   * List of the "Lặp qua danh sách" (loop over list) node: if the field holds only one {{ … }} variable, take its raw value (e.g. the array
   * {{ $node.n3.products }} of a previous step; rendering it to a string would lose the data). Otherwise read the rendered string
   * (a JSON array, or one item per line).
   */
  private resolveForEachItems(raw: unknown, rendered: unknown, ctx: ExecutionContext): any[] {
    if (Array.isArray(raw)) return raw;
    const single = typeof raw === 'string' ? /^\s*\{\{\s*([\s\S]*?)\s*\}\}\s*$/.exec(raw) : null;
    if (single) return parseForEachList(this.resolveExpressionValue(single[1].trim(), ctx));
    return parseForEachList(typeof rendered === 'string' ? rendered : '');
  }

  /** Raw value (not converted to a string) of a variable: $trigger.*, $var.*, $node.<id or node name>.<field>. */
  private resolveExpressionValue(expr: string, ctx: ExecutionContext): any {
    if (expr.startsWith('$trigger.')) return this.getNestedValue(ctx.trigger, expr.slice(9));
    if (expr.startsWith('$var.')) return this.getVariableValue(ctx, expr.slice(5));
    if (!expr.startsWith('$node.')) return undefined;
    const rest = expr.slice(6);
    const dotIdx = rest.indexOf('.');
    if (dotIdx === -1) return undefined;
    const nodeRef = rest.slice(0, dotIdx);
    const field = rest.slice(dotIdx + 1);
    // Find the node the same way as renderTemplate: by id, then by node name, then "nN" = the Nth node (id of old templates)
    let found: { output: any } | null = null;
    for (const [nid, ndata] of Object.entries(ctx.nodes)) {
      const labelOrId = ctx._wfNodes?.find(n => n.id === nid)?.label || nid;
      if (nid === nodeRef || labelOrId === nodeRef) { found = ndata; break; }
    }
    if (!found) {
      const idxMatch = nodeRef.match(/^n(\d+)$/);
      const target = idxMatch && ctx._wfNodes ? ctx._wfNodes[parseInt(idxMatch[1], 10) - 1] : undefined;
      if (target && ctx.nodes[target.id]) found = ctx.nodes[target.id];
    }
    if (!found) return undefined;
    return field === 'output' ? found.output : this.getNestedValue(found.output, field);
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => {
      if (acc === null || acc === undefined) return '';
      if (key.endsWith(']')) {
        const bracket = key.indexOf('[');
        const arrKey = key.slice(0, bracket);
        const idx = parseInt(key.slice(bracket + 1, -1));
        return acc[arrKey]?.[idx];
      }
      return acc[key];
    }, obj);
  }

  /**
   * Truncate data for log storage to prevent huge JSON blobs.
   * Truncates strings > 1000 chars and arrays/objects beyond a depth limit.
   */
  private truncateData(data: any, maxStrLen: number = 1000, maxDepth: number = 5, depth: number = 0): any {
    if (depth > maxDepth) return '[MaxDepth]';
    if (data === null || data === undefined) return data;
    if (typeof data === 'string') {
      return data.length > maxStrLen ? data.substring(0, maxStrLen) + `...[truncated, total ${data.length} chars]` : data;
    }
    if (typeof data === 'number' || typeof data === 'boolean') return data;
    if (Array.isArray(data)) {
      if (data.length > 50) {
        const arr = data.slice(0, 50).map((item: any) => this.truncateData(item, maxStrLen, maxDepth, depth + 1));
        arr.push(`...[truncated, total ${data.length} items]`);
        return arr;
      }
      return data.map((item: any) => this.truncateData(item, maxStrLen, maxDepth, depth + 1));
    }
    if (typeof data === 'object') {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.truncateData(value, maxStrLen, maxDepth, depth + 1);
      }
      return result;
    }
    return String(data);
  }

  /**
   * Compare two values for greater_than / less_than.
   * Supports numbers and time strings (HH:MM or HH:MM:SS).
   * Returns positive if left > right, negative if left < right, 0 if equal.
   */
  /** Get the OpenAI-compatible chat/completions URL for a given platform */
  private getOpenAICompatibleUrl(platform: string): string {
    switch (platform) {
      case 'deepseek':   return 'https://api.deepseek.com/v1/chat/completions';
      case 'grok':       return 'https://api.x.ai/v1/chat/completions';
      case 'mistral':    return 'https://api.mistral.ai/v1/chat/completions';
      case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
      case 'openai':
      default:           return 'https://api.openai.com/v1/chat/completions';
    }
  }

  /** Convert OpenAI-format messages to Google Gemini format */
  private openaiMessagesToGemini(messages: Array<{ role: string; content: string }>): any[] {
    // Gemini uses "contents" with role: "user" | "model"
    // System messages become a user+model pair at the start for best results
    const contents: any[] = [];
    let systemText = '';

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText += (systemText ? '\n' : '') + msg.content;
        continue;
      }
      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
    }

    // Prepend system instruction as a user→model pair if present
    if (systemText) {
      contents.unshift(
        { role: 'user', parts: [{ text: `System instruction: ${systemText}` }] },
        { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
      );
    }

    return contents;
  }

  public getWorkflows(): Workflow[] {
    return [...this.workflows.values()];
  }

  // ─── Structured AI response helpers ───────────────────────────────────────

  /**
   * Parse structured AI JSON response: [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
   * Returns null if the message is not structured JSON, otherwise returns the parsed array.
   */
  // parseStructuredAIResponse → moved to shared/ai/aiUtils.ts

  /**
   * Download a URL to a temporary file. Returns the local temp file path.
   */
  private async downloadUrlToTempFile(url: string): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), 'deplao-workflow-images');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // Extract extension from URL or default to .jpg
    let ext = '.jpg';
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const match = pathname.match(/\.(\w{3,5})$/);
      if (match) ext = '.' + match[1];
    } catch {}

    const tempPath = path.join(tmpDir, `ai_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 30000,
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    return tempPath;
  }
}

export default WorkflowEngineService;
