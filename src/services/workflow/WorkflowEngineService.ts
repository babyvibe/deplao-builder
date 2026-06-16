import EventBroadcaster from '../event/EventBroadcaster';
import DatabaseService from '../database/DatabaseService';
import ConnectionManager from '../../utils/ConnectionManager';
import { FacebookService } from '../facebook/FacebookService';
import { FacebookSendService } from '../facebook/FacebookSendService';
import Logger from '../../utils/Logger';
import IntegrationRegistry from '../integrations/IntegrationRegistry';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as cron from 'node-cron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { google } from 'googleapis';
import { parseStructuredResponse, isValidStructuredResponse } from '../../utils/aiUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeType =
  | 'trigger.message' | 'trigger.friendRequest' | 'trigger.groupEvent'
  | 'trigger.reaction' | 'trigger.undo' | 'trigger.schedule' | 'trigger.manual'
  | 'trigger.labelAssigned'
  | 'zalo.sendMessage' | 'zalo.sendImage' | 'zalo.sendFile' | 'zalo.sendVoice'
  | 'zalo.forwardMessage' | 'zalo.addReaction' | 'zalo.undoMessage'
  | 'zalo.sendTyping'
  | 'zalo.findUser' | 'zalo.getUserInfo' | 'zalo.sendFriendRequest'
  | 'zalo.acceptFriendRequest' | 'zalo.rejectFriendRequest'
  | 'zalo.addToGroup' | 'zalo.removeFromGroup' | 'zalo.createPoll'
  | 'zalo.getMessageHistory' | 'zalo.setMute'
  | 'zalo.assignLabel' | 'zalo.removeLabel'
  | 'logic.if' | 'logic.switch' | 'logic.wait' | 'logic.forEach'
  | 'logic.setVariable' | 'logic.stopIf'
  | 'data.textFormat' | 'data.jsonParse' | 'data.dateFormat' | 'data.randomPick'
  | 'sheets.appendRow' | 'sheets.readValues' | 'sheets.updateCell'
  | 'ai.generateText' | 'ai.classify'
  | 'notify.telegram' | 'notify.discord' | 'notify.email' | 'notify.notion'
  | 'output.httpRequest' | 'output.log'
  // P0 integrations
  | 'trigger.payment'
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
  | 'fb.action.sendImage';

export type WorkflowChannel = 'zalo' | 'facebook';

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
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  channel: WorkflowChannel;
  /** @deprecated use pageIds */
  pageId?: string;
  /** Danh sách zalo_id mà workflow này áp dụng. Rỗng = áp dụng cho tất cả pages. */
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
}

interface ExecutionContext {
  trigger: any;
  nodes: Record<string, { output: Record<string, any> }>;
  variables: Record<string, any>;
  pageId: string;
  /** nodeIds that should be skipped because they're on the wrong branch of an IF/switch */
  skippedNodes: Set<string>;
  /** Full node list — used by renderTemplate to match $node.Label.field by label name */
  _wfNodes: WorkflowNode[];
  _wfName: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

class WorkflowEngineService {
  private static instance: WorkflowEngineService;
  private workflows: Map<string, Workflow> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();

  /** Debounce timers for trigger.message — key = workflowId:threadId */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Buffered message events for debounce — key = workflowId:threadId */
  private debounceBuffers: Map<string, any[]> = new Map();

  public static getInstance(): WorkflowEngineService {
    if (!this.instance) this.instance = new WorkflowEngineService();
    return this.instance;
  }

  public async initialize(): Promise<void> {
    this.loadWorkflows();
    this.registerZaloEventListeners();
    this.registerFacebookEventListeners();
    this.registerCronJobs();
    Logger.log(`[WorkflowEngine] Initialized — ${this.workflows.size} workflows loaded`);
  }

  private normalizeWorkflowChannel(channel?: string): WorkflowChannel {
    return channel === 'facebook' ? 'facebook' : 'zalo';
  }

  private isRunnableWorkflow(wf: Workflow): boolean {
    const ch = this.normalizeWorkflowChannel(wf.channel);
    return ch === 'zalo' || ch === 'facebook';
  }

  /**
   * Resolve Facebook account ID về internal UUID để tìm đúng instance trong FacebookService.
   * FacebookService.instances map dùng UUID làm key, nhưng workflow trigger gửi numeric FB UID.
   * Nếu không resolve, getInstance() sẽ tạo instance mới + connect() mất ~10s không cần thiết.
   */
  private resolveFBAccountId(rawId: string): string {
    if (!rawId) return '';
    // Nếu đã là UUID (có dấu gạch ngang) → trả về nguyên
    if (rawId.includes('-')) return rawId;
    // Nếu là Facebook UID (all digits) → tìm UUID từ DB
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
    } catch (e: any) {
      Logger.error(`[WorkflowEngine] reloadWorkflow ${workflowId}: ${e.message}`);
    }
  }

  public removeWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    this.unregisterCron(workflowId);
    // Clean up debounce timers/buffers for this workflow
    this.clearDebounceForWorkflow(workflowId);
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

  // ─── Event Listeners ──────────────────────────────────────────────────────

  private registerZaloEventListeners(): void {
    const EVENT_MAP: Record<string, string> = {
      'event:message':       'trigger.message',
      'event:friendRequest': 'trigger.friendRequest',
      'event:groupEvent':    'trigger.groupEvent',
      'event:reaction':      'trigger.reaction',
      'event:undo':          'trigger.undo',
      'event:labelAssigned': 'trigger.labelAssigned',
      'integration:payment': 'trigger.payment',
    };
    for (const [channel, triggerType] of Object.entries(EVENT_MAP)) {
      EventBroadcaster.onBeforeSend(channel, (data: any) => {
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
      EventBroadcaster.onBeforeSend(channel, (data: any) => {
        this.triggerWorkflows(triggerType, data);
      });
    }

    // Message event — determine specific trigger type from attachment data
    EventBroadcaster.onBeforeSend('fb:onMessage', (data: any) => {
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

  /**
   * Gọi từ main process khi renderer emit 'workflow:labelEvent'.
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
      this.executeWorkflow(wf, {}, 'trigger.schedule').catch(err => {
        Logger.error(`[WorkflowEngine] Cron error in "${wf.name}": ${err.message}`);
      });
    }, { timezone: tz });
    this.cronJobs.set(wf.id, task);
    Logger.log(`[WorkflowEngine] Cron registered for "${wf.name}" — ${expr}`);
  }

  private unregisterCron(workflowId: string): void {
    const job = this.cronJobs.get(workflowId);
    if (job) { job.stop(); this.cronJobs.delete(workflowId); }
  }

  // ─── Trigger matching ─────────────────────────────────────────────────────

  private triggerWorkflows(triggerType: string, eventData: any): void {
    for (const wf of this.workflows.values()) {
      if (!wf.enabled) continue;
      if (!this.isRunnableWorkflow(wf)) continue;
      const triggerNode = wf.nodes.find(n => n.type === triggerType);
      if (!triggerNode) continue;
      // pageIds: rỗng = áp dụng cho tất cả; có giá trị = chỉ chạy cho page khớp
      if (wf.pageIds.length > 0) {
        const accountId = eventData.zaloId || eventData.fbAccountId || '';
        if (accountId && !wf.pageIds.includes(accountId)) continue;
      }
      if (!this.matchesTriggerFilter(triggerNode, eventData)) continue;

      // ─── Debounce for message triggers: gom tin nhắn liên tiếp ────────
      const debounceSeconds = Number(triggerNode.config.debounceSeconds || 0);
      if ((triggerType === 'trigger.message' || triggerType === 'fb.trigger.message') && debounceSeconds > 0) {
        const msg = eventData.data || eventData.message || {};
        const threadId = (msg as any).threadId || eventData.threadId || '';
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
        continue;
      }

      this.executeWorkflow(wf, eventData, triggerType).catch(err => {
        Logger.error(`[WorkflowEngine] Error in workflow "${wf.name}": ${err.message}`);
      });
    }
  }

  private matchesTriggerFilter(triggerNode: WorkflowNode, data: any): boolean {
    const cfg = triggerNode.config;

    if (triggerNode.type === 'trigger.message') {
      // data = { zaloId, message } where message is a zca-js UserMessage | GroupMessage:
      //   { type: 0|1, data: TMessage, threadId: string, isSelf: boolean }
      // All payload fields (uidFrom, msgId, ts, dName, content) live inside message.data (msgData)
      const msg  = data.data || data.message || {};           // UserMessage | GroupMessage
      const msgData = (msg as any).data || {};                // TMessage — uidFrom, content, msgId, ts, dName ...
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
        const content = String((rawContent as any)?.msg || (typeof rawContent === 'string' ? rawContent : '') || '').toLowerCase();
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
    }

    if (triggerNode.type === 'trigger.groupEvent') {
      if (cfg.groupId && data.groupId !== cfg.groupId) return false;
      if (cfg.eventType && cfg.eventType !== 'all' && data.eventType !== cfg.eventType) return false;
    }

    if (triggerNode.type === 'trigger.reaction') {
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      if (cfg.reactionType && cfg.reactionType !== 'any') {
        if (String(data.react || data.reactionType || '') !== String(cfg.reactionType)) return false;
      }
    }

    if (triggerNode.type === 'trigger.labelAssigned') {
      // action filter: 'any' | 'assigned' | 'removed'
      if (cfg.action && cfg.action !== 'any' && data.action !== cfg.action) return false;
      // source filter: 'any' | 'local' | 'zalo'
      if (cfg.labelSource && cfg.labelSource !== 'any') {
        const source = String(data.labelSource || 'zalo');
        if (source !== String(cfg.labelSource)) return false;
      }
      // New: labelIds array — contains "source:id" strings
      if (Array.isArray(cfg.labelIds) && cfg.labelIds.length > 0) {
        const eventSrc = String(data.labelSource || 'zalo');
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
      const tx = data.transaction || data;
      // Filter by integration id
      if (cfg.integrationId && data.integrationId !== cfg.integrationId) return false;
      // Filter by minimum amount
      if (cfg.minAmount && Number(tx.amount || tx.in || 0) < Number(cfg.minAmount)) return false;
      // Filter by description keyword
      if (cfg.descContains) {
        const desc = String(tx.description || tx.memo || tx.content || '').toLowerCase();
        if (!desc.includes(String(cfg.descContains).toLowerCase())) return false;
      }
    }

    // ── Facebook trigger matching ───────────────────────────────────────────
    if (triggerNode.type === 'fb.trigger.message') {
      // Filter by threadId
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
      // Filter by threadType (DM vs Group) — Facebook group threads often have '_' in ID
      if (cfg.threadType !== undefined && cfg.threadType !== 'all') {
        const isGroup = !!(data.threadId && data.threadId.includes('_'));
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
      }
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

    return true;
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  public async executeWorkflow(
    wf: Workflow,
    triggerData: any,
    triggeredBy: string = 'manual'
  ): Promise<WorkflowRunLog> {
    if (!this.isRunnableWorkflow(wf)) {
      throw new Error('Workflow không hỗ trợ chạy (channel unknown)');
    }

    const runId = uuidv4();
    const startedAt = Date.now();
    const nodeResults: NodeResult[] = [];

    // Flatten trigger data for template access
    const flatTrigger = this.flattenTriggerData(triggerData, triggeredBy);

    const context: ExecutionContext = {
      trigger: flatTrigger,
      nodes: {},
      variables: {},
      pageId: wf.pageIds[0] || wf.pageId || triggerData?.zaloId || '',
      skippedNodes: new Set(),
      _wfNodes: wf.nodes,
      _wfName: wf.name,
    };

    const order = this.topologicalSort(wf);
    let status: 'success' | 'error' | 'partial' = 'success';
    let errorMessage: string | undefined;

    for (const nodeId of order) {
      const node = wf.nodes.find(n => n.id === nodeId);
      if (!node) continue;
      const t0 = Date.now();

      if (context.skippedNodes.has(nodeId)) {
        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'skipped', input: {}, output: { _skipped: true }, durationMs: 0 });
        // Propagate skip to downstream nodes
        this.markDownstreamSkipped(nodeId, wf, context.skippedNodes);
        continue;
      }

      let renderedConfig: Record<string, any> = {};
      try {
        renderedConfig = this.renderConfig(node.config, context);
        if (node.type === 'zalo.sendMessage') {
          Logger.info(`[WorkflowEngine] sendMessage BEFORE: raw="${(node.config.message || '').substring(0, 300)}" → rendered="${(renderedConfig.message || '').substring(0, 300)}"`);
        }
        const output = await this.executeNode(node, renderedConfig, context, wf);
        context.nodes[nodeId] = { output };
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

        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: this.truncateData(renderedConfig), output: this.truncateData(output), durationMs: Date.now() - t0 });
      } catch (err: any) {
        // logic.stopIf signals a graceful stop — treat as success, halt loop
        if (err.message === '__STOP__') {
          nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: this.truncateData(renderedConfig), output: { stopped: true }, durationMs: Date.now() - t0 });
          break;
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
        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'error', input: this.truncateData(renderedConfig), output: this.truncateData(errorOutput), durationMs: Date.now() - t0, error: err.message });
        if (node.config.continueOnError) {
          status = 'partial';
        } else {
          status = 'error';
          errorMessage = `Node "${node.label || node.type}" lỗi: ${err.message}`;
          break;
        }
      }
    }

    const log: WorkflowRunLog = {
      id: runId, workflowId: wf.id, workflowName: wf.name,
      triggeredBy, startedAt, finishedAt: Date.now(),
      status, errorMessage, nodeResults,
    };

    DatabaseService.getInstance().saveWorkflowRunLog(log);
    EventBroadcaster.emit('workflow:executed', { workflowId: wf.id, runId, status });
    return log;
  }

  private markDownstreamSkipped(nodeId: string, wf: Workflow, skipped: Set<string>): void {
    for (const edge of wf.edges.filter(e => e.source === nodeId)) {
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
      return {
        fromId:      msgData.uidFrom    || (msg as any).uidFrom    || data.fromId    || '',
        fromName:    data.fromName      || msgData.dName            || (msg as any).fromName || '',
        fromPhone:   data.fromPhone     || (msg as any).fromPhone   || '',
        content,
        images,
        threadId:    (msg as any).threadId || data.threadId        || msgData.idTo   || '',
        threadType,
        isGroup,
        groupName:   data.groupName     || (msg as any).groupName  || '',
        msgId:       msgData.msgId      || (msg as any).msgId       || data.msgId    || '',
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
      return {
        groupId: data.groupId || d.groupId || '',
        eventType: data.eventType || '',
        actorName: members[0]?.dName || members[0]?.zaloName || '',
        targetNames: members.map((m: any) => m.dName || m.zaloName || m.id || '').filter(Boolean).join(', '),
        systemText: data.systemText || '',
        zaloId: data.zaloId || '',
      };
    }
    if (triggerType === 'trigger.reaction' || triggerType.startsWith('event:reaction')) {
      return {
        fromId: data.uidFrom || data.fromId || '',
        fromName: data.fromName || '',
        msgId: data.msgId || '',
        threadId: data.threadId || '',
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
        labelSource: data.labelSource || 'zalo',
        action:      data.action || 'assigned',   // 'assigned' | 'removed'
      };
    }
    if (triggerType === 'trigger.payment' || triggerType === 'integration:payment') {
      const tx = data.transaction || data;
      return {
        integrationId:   data.integrationId || '',
        integrationType: data.integrationType || '',
        amount:          tx.amount || tx.in || 0,
        description:     tx.description || tx.memo || tx.content || '',
        bankName:        tx.bankName || tx.bank_name || '',
        accountNumber:   tx.accountNumber || tx.bank_acc_id || '',
        transactionId:   tx.id || tx.transaction_id || tx.tid || '',
        transactionDate: tx.when || tx.transactionDate || tx.created_at || '',
        raw:             tx,
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
        content: '',
        body: '',
        groupEventType: data.type || '',
        participantId: data.participantId || '',
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
      return {
        fbAccountId: data.fbAccountId || '',
        messageId: data.messageId || '',
        threadId: data.threadId || msg.threadId || msg.replyToID || '',
        fromId: msg.userID || data.userId || data.fromId || '',
        content: msg.body || '',
        body: msg.body || '',
        attachments: msg.attachments || null,
        isSelf: !!(msg.isSelf || data.isSelf),
        emoji: data.emoji || '',
        timestamp: Number(msg.timestamp || data.timestamp || msg.timestamp_precise || Date.now()),
      };
    }
    return { ...data };
  }

  // ─── Node Executor ────────────────────────────────────────────────────────

  private async executeNode(
    node: WorkflowNode,
    cfg: Record<string, any>,
    ctx: ExecutionContext,
    _wf: Workflow
  ): Promise<Record<string, any>> {
    switch (node.type) {

      // ── Trigger nodes (just pass-through — already matched) ──────────────
      case 'trigger.message':
      case 'trigger.friendRequest':
      case 'trigger.groupEvent':
      case 'trigger.reaction':
      case 'trigger.undo':
      case 'trigger.schedule':
      case 'trigger.manual':
      case 'trigger.labelAssigned':
        return { ...ctx.trigger };

      // ── Zalo Actions ─────────────────────────────────────────────────────
      case 'zalo.sendMessage': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;   // guard NaN → 0
        Logger.info(`[WorkflowEngine] sendMessage: message="${(cfg.message || '').substring(0, 300)}", threadId=${cfg.threadId}, threadType=${threadType}, isEmpty=${!cfg.message?.trim()}`);

        // ─── Structured AI response handling ─────────────────────────────
        // Detect AI structured JSON: [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
        const segments = parseStructuredResponse(cfg.message);
        if (segments) {
          Logger.info(`[WorkflowEngine] Structured AI response: ${segments.length} segments`);
          let lastMsgId = '';
          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg.type === 'text' && seg.content) {
              // Small delay between messages to simulate natural typing
              if (i > 0) await new Promise(r => setTimeout(r, 600));
              try {
                const destType = threadType === 0 ? 3 : undefined;
                await api.sendTypingEvent(cfg.threadId, threadType, destType);
              } catch {}
              // Wait a bit for typing effect
              const typingDelay = Math.min(Math.max(String(seg.content).length * 30, 800), 3000);
              await new Promise(r => setTimeout(r, typingDelay));
              const res = await api.sendMessage({ msg: String(seg.content) }, cfg.threadId, threadType);
              lastMsgId = (res as any)?.message?.msgId || lastMsgId;
            } else if (seg.type === 'image') {
              const urls = Array.isArray(seg.content) ? seg.content : [seg.content];
              for (const url of urls) {
                if (!url || typeof url !== 'string') continue;
                if (i > 0 || urls.indexOf(url) > 0) await new Promise(r => setTimeout(r, 500));
                try {
                  const tempPath = await this.downloadUrlToTempFile(String(url));
                  try {
                    const res = await api.sendMessage({ msg: '', attachments: [tempPath] }, cfg.threadId, threadType);
                    lastMsgId = (res as any)?.attachment?.[0]?.msgId || (res as any)?.message?.msgId || lastMsgId;
                  } finally {
                    try { fs.unlinkSync(tempPath); } catch {}
                  }
                } catch (e: any) {
                  Logger.warn(`[WorkflowEngine] Failed to send image ${url}: ${e.message}`);
                  // Fallback: send as text link
                  await api.sendMessage({ msg: String(url) }, cfg.threadId, threadType);
                }
              }
            }
          }
          return { msgId: lastMsgId, success: true, structured: true, segmentCount: segments.length };
        }

        // ─── Plain text (original behavior) ──────────────────────────────
        const result = await api.sendMessage(
          { msg: cfg.message },
          cfg.threadId,
          threadType
        );
        return { msgId: (result as any)?.message?.msgId || '', success: true };
      }

      case 'zalo.sendTyping': {
        // Gửi sự kiện "đang gõ" rồi chờ delay trước khi bước tiếp theo chạy.
        // Mục đích: đặt thẻ này TRƯỚC zalo.sendMessage để tạo hiệu ứng tự nhiên.
        //   threadType 0 = DM (cần destType=3), 1 = Group (không cần destType)
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
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        const result = await api.sendMessage({ msg: cfg.message || '', attachments: [cfg.filePath] }, cfg.threadId, threadType);
        return { msgId: (result as any)?.attachment?.[0]?.msgId || '', success: true };
      }

      case 'zalo.sendFile': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        await api.sendMessage({ msg: '', attachments: [cfg.filePath] }, cfg.threadId, threadType);
        return { success: true };
      }

      case 'zalo.findUser': {
        const api = this.getApi(ctx.pageId);
        const result: any = await api.findUser(cfg.phone);
        return {
          userId: result?.data?.uid || '', displayName: result?.data?.displayName || '',
          avatar: result?.data?.avatar || '', isFriend: !!(result?.data?.isFriend),
        };
      }

      case 'zalo.getUserInfo': {
        const api = this.getApi(ctx.pageId);
        const result: any = await api.getUserInfo({ userId: cfg.userId } as any);
        return result?.data || {};
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
        const api = this.getApi(ctx.pageId);
        await api.addUserToGroup({ groupId: cfg.groupId, members: [cfg.userId] } as any);
        return { success: true };
      }

      case 'zalo.removeFromGroup': {
        const api = this.getApi(ctx.pageId);
        await api.removeUserFromGroup({ groupId: cfg.groupId, members: [cfg.userId] } as any);
        return { success: true };
      }

      case 'zalo.undoMessage': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        await api.undo({ msgId: cfg.msgId, threadId: cfg.threadId, threadType } as any);
        return { success: true };
      }

      case 'zalo.setMute': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        await api.setMute(cfg.threadId, threadType, cfg.duration ?? 0, cfg.action === 'mute' ? 1 : 0);
        return { success: true };
      }

      case 'zalo.getMessageHistory': {
        const api = this.getApi(ctx.pageId);
        const result: any = await api.getGroupChatHistory({
          groupId: cfg.threadId,
          lastMsgId: cfg.lastMsgId || '',
          count: Number(cfg.count ?? 20),
        } as any);
        return { messages: result?.data || [] };
      }

      case 'zalo.forwardMessage': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.toThreadType ?? 0);
        const threadId = cfg.toThreadId;
        if (!threadId) throw new Error('[zalo.forwardMessage] toThreadId required');

        const message = cfg.message || ctx.trigger?.content || '';
        const msgId = cfg.msgId || ctx.trigger?.msgId || '';

        // Tra DB lấy local_paths + msg_type từ tin nhắn gốc (giống chat sendOneForward)
        let localPaths: Record<string, string> = {};
        let dbMsgType = '';
        const triggerZaloId = ctx.trigger?.zaloId || ctx.pageId;
        if (msgId && triggerZaloId) {
          try {
            const stored = DatabaseService.getInstance().getMessageById(triggerZaloId, msgId);
            if (stored) {
              dbMsgType = stored.msg_type || '';
              if (stored.local_paths) {
                const parsed = typeof stored.local_paths === 'string'
                  ? JSON.parse(stored.local_paths)
                  : stored.local_paths;
                if (parsed && typeof parsed === 'object') localPaths = parsed;
              }
            }
          } catch {}
        }

        // Ưu tiên gửi media (ảnh/file/video) trước — giống sendOneForward
        const mediaPath = localPaths.file || localPaths.video || localPaths.main || localPaths.hd || '';
        if (mediaPath) {
          // Gửi media + text (caption) trong 1 lần
          await api.sendMessage({ msg: message, attachments: [mediaPath] }, threadId, threadType);
        } else if (message) {
          // Chỉ có text
          await api.sendMessage({ msg: message, attachments: [] }, threadId, threadType);
        } else {
          throw new Error('[zalo.forwardMessage] Missing message content');
        }

        return { success: true, msgId };
      }

      case 'zalo.createPoll': {
        const api = this.getApi(ctx.pageId);
        const options = String(cfg.options || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
        await api.createPoll({
          groupId: cfg.groupId,
          question: cfg.question,
          options,
          allowMultiVote: !!cfg.allowMultiple,
          expiredTime: Number(cfg.expireTime ?? 0),
        } as any);
        return { success: true };
      }

      case 'zalo.addReaction': {
        const api = this.getApi(ctx.pageId);
        await api.addReaction({ msgId: cfg.msgId, clientMsgId: cfg.clientMsgId || '' } as any, Number(cfg.reactionType ?? 1));
        return { success: true };
      }

      case 'zalo.assignLabel': {
        // Giải mã labelIds: mảng "source:id" (new) hoặc fallback về labelId/labelSource cũ
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
          // Zalo: chỉ gắn 1 nhãn / hội thoại
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
            const existingMembers = label.memberIds || [];
            if (!existingMembers.includes(cfg.threadId)) {
              label.memberIds = [...existingMembers, cfg.threadId];
            }
            await (api as any).updateLabels({ labelData, version });
          }
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
          // Zalo: gỡ 1 nhãn / hội thoại
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

      // ── Logic Nodes ──────────────────────────────────────────────────────
      case 'logic.if': {
        const left  = String(cfg.left  ?? '');
        const right = String(cfg.right ?? '');
        const op    = cfg.operator ?? 'equals';
        let result = false;
        switch (op) {
          case 'equals':       result = left === right; break;
          case 'not_equals':   result = left !== right; break;
          case 'contains':     result = left.includes(right); break;
          case 'not_contains': result = !left.includes(right); break;
          case 'starts_with':  result = left.startsWith(right); break;
          case 'ends_with':    result = left.endsWith(right); break;
          case 'greater_than': result = this.compareValues(left, right) > 0; break;
          case 'less_than':    result = this.compareValues(left, right) < 0; break;
          case 'is_empty':     result = !left || left.trim() === ''; break;
          case 'not_empty':    result = !!left && left.trim() !== ''; break;
          case 'regex':
            try { result = new RegExp(right, 'i').test(left); } catch { result = false; } break;
        }
        ctx.variables[`__if_${node.id}`] = result;
        return { result, branch: result ? 'true' : 'false' };
      }

      case 'logic.switch': {
        const val = String(cfg.value ?? '');
        const cases: Array<{ match: string; label: string }> = cfg.cases || [];
        let matchedHandle = cfg.defaultLabel || 'default';
        for (const c of cases) {
          if (String(c.match) === val) { matchedHandle = c.label; break; }
        }
        ctx.variables[`__switch_${node.id}`] = matchedHandle;
        return { value: val, matchedHandle };
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
        const left  = String(cfg.left  ?? '');
        const right = String(cfg.right ?? '');
        const op    = cfg.operator ?? 'equals';
        let stop = false;
        switch (op) {
          case 'equals':       stop = left === right; break;
          case 'not_equals':   stop = left !== right; break;
          case 'contains':     stop = left.includes(right); break;
          case 'not_contains': stop = !left.includes(right); break;
          case 'starts_with':  stop = left.startsWith(right); break;
          case 'ends_with':    stop = left.endsWith(right); break;
          case 'greater_than': stop = this.compareValues(left, right) > 0; break;
          case 'less_than':    stop = this.compareValues(left, right) < 0; break;
          case 'is_empty':     stop = !left || left.trim() === ''; break;
          case 'not_empty':    stop = !!left && left.trim() !== ''; break;
          case 'regex':
            try { stop = new RegExp(right, 'i').test(left); } catch { stop = false; } break;
        }
        if (stop) throw new Error('__STOP__');
        return { stopped: false };
      }

      case 'logic.forEach': {
        let arr: any[] = [];
        try { arr = Array.isArray(cfg.array) ? cfg.array : JSON.parse(cfg.array || '[]'); } catch {}
        return { items: arr, count: arr.length };
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
        const d = cfg.date ? new Date(cfg.date) : new Date();
        const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Ho_Chi_Minh' };
        if (cfg.format === 'full') { opts.dateStyle = 'full'; opts.timeStyle = 'short'; }
        else if (cfg.format === 'date') { opts.dateStyle = 'short'; }
        else if (cfg.format === 'time') { opts.timeStyle = 'short'; }
        else { opts.dateStyle = 'short'; opts.timeStyle = 'short'; }
        return { result: new Intl.DateTimeFormat('vi-VN', opts).format(d), timestamp: d.getTime() };
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
            // Accept all HTTP status codes — 4xx/5xx are valid business responses,
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
          // Network errors (ECONNREFUSED, DNS, timeout) — don't throw, return
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
            throw new Error(`Trợ lý AI lỗi: ${e.message}`);
          }
        }

        const messages: any[] = [];
        if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });

        // ── Chat history (ngữ cảnh cuộc hội thoại) ────────────────────────
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
            // Ignore parse errors — just proceed without history
          }
        }

        messages.push({ role: 'user', content: cfg.prompt });

        const platform = cfg.platform || 'openai';
        const rawModel = cfg.model || 'gpt-5.4-mini';
        const model = this.normalizeModelName(rawModel);
        const maxTokens = Number(cfg.maxTokens || 500);
        const temperature = Number(cfg.temperature ?? 0.7);

        if (platform === 'gemini') {
          // Google Gemini API
          const geminiContents = this.openaiMessagesToGemini(messages);
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`,
            {
              contents: geminiContents,
              generationConfig: {
                maxOutputTokens: maxTokens,
                temperature,
              },
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
          );
          const result = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          const totalTokens = (res.data.usageMetadata?.promptTokenCount || 0) + (res.data.usageMetadata?.candidatesTokenCount || 0);
          return { result, totalTokens, model };
        } else if (platform === 'claude') {
          // Anthropic Claude Messages API
          const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
          const claudeMessages = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }));
          const res = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model,
              max_tokens: maxTokens,
              ...(systemText ? { system: systemText } : {}),
              messages: claudeMessages,
            },
            {
              headers: {
                'x-api-key': cfg.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              timeout: 60000,
            }
          );
          const result = res.data.content?.[0]?.text?.trim() || '';
          const totalTokens = (res.data.usage?.input_tokens || 0) + (res.data.usage?.output_tokens || 0);
          return { result, totalTokens, model };
        } else {
          // OpenAI-compatible API (OpenAI, Deepseek, Grok/xAI, Mistral, OpenRouter)
          const apiUrl = this.getOpenAICompatibleUrl(platform);
          const tokenParam = platform === 'openai'
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens };
          const res = await axios.post(
            apiUrl,
            {
              model,
              messages,
              ...tokenParam,
              temperature,
            },
            {
              headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 60000,
            }
          );
          const result = res.data.choices?.[0]?.message?.content?.trim() || '';
          return {
            result,
            totalTokens: res.data.usage?.total_tokens || 0,
            model: res.data.model || model,
          };
        }
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
            const category = (result.result || '').trim();
            return { category, input: cfg.input };
          } catch (e: any) {
            throw new Error(`Trợ lý AI lỗi: ${e.message}`);
          }
        }

        const platform = cfg.platform || 'openai';
        const model = this.normalizeModelName(cfg.model || 'gpt-5.4-mini');
        const classifyMessages = [
          { role: 'system' as const, content: systemMsg },
          { role: 'user' as const, content: cfg.input },
        ];

        if (platform === 'gemini') {
          const geminiContents = this.openaiMessagesToGemini(classifyMessages);
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`,
            {
              contents: geminiContents,
              generationConfig: { maxOutputTokens: 30, temperature: 0 },
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
          );
          const category = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
          return { category, input: cfg.input };
        } else if (platform === 'claude') {
          // Anthropic Claude Messages API
          const claudeMessages = classifyMessages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: 'user' as const, content: m.content }));
          const res = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model,
              max_tokens: 30,
              system: systemMsg,
              messages: claudeMessages,
            },
            {
              headers: {
                'x-api-key': cfg.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
              },
              timeout: 15000,
            }
          );
          const category = res.data.content?.[0]?.text?.trim() || '';
          return { category, input: cfg.input };
        } else {
          // OpenAI-compatible API (OpenAI, Deepseek, Grok/xAI, Mistral, OpenRouter)
          const apiUrl = this.getOpenAICompatibleUrl(platform);
          const tokenParam = platform === 'openai'
            ? { max_completion_tokens: 30 }
            : { max_tokens: 30 };
          const res = await axios.post(
            apiUrl,
            { model, messages: classifyMessages, ...tokenParam, temperature: 0 },
            {
              headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 15000,
            }
          );
          const category = res.data.choices?.[0]?.message?.content?.trim() || '';
          return { category, input: cfg.input };
        }
      }

      // ── Notify: Telegram ─────────────────────────────────────────────────
      case 'notify.telegram': {
        const payload: Record<string, any> = {
          chat_id: cfg.chatId,
          text: cfg.message,
        };
        if (cfg.parseMode) payload.parse_mode = cfg.parseMode;
        const res = await axios.post(
          `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
          payload,
          { timeout: 10000 }
        );
        return {
          success: true,
          messageId: res.data.result?.message_id || '',
        };
      }

      // ── Notify: Discord ───────────────────────────────────────────────────
      case 'notify.discord': {
        const payload: Record<string, any> = {
          content: cfg.message,
          username: cfg.username || 'DepLao Bot',
        };
        if (cfg.avatarUrl) payload.avatar_url = cfg.avatarUrl;
        await axios.post(cfg.webhookUrl, payload, { timeout: 10000 });
        return { success: true };
      }

      // ── Notify: Email ─────────────────────────────────────────────────────
      case 'notify.email': {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: cfg.smtpHost || 'smtp.gmail.com',
          port: Number(cfg.smtpPort || 587),
          secure: Number(cfg.smtpPort) === 465,
          auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
          tls: { rejectUnauthorized: false },
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

      // ── P0: trigger.payment (pass-through like other triggers) ──────────────
      case 'trigger.payment':
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
            ...(cfg.customerId ? { customerId: cfg.customerId } : {}),
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
          ...(cfg.toDistrictId ? { to_district_id: Number(cfg.toDistrictId) } : {}),
          ...(cfg.toWardCode ? { to_ward_code: cfg.toWardCode } : {}),
          ...(cfg.weight ? { weight: Number(cfg.weight) } : {}),
          ...(cfg.serviceTypeId ? { service_type_id: Number(cfg.serviceTypeId) } : {}),
          ...(cfg.codAmount != null && String(cfg.codAmount) !== '' ? { cod_amount: Number(cfg.codAmount) } : {}),
        };
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
        const threadId = cfg.threadId || ctx.trigger?.threadId;
        if (!threadId) throw new Error('[fb.action.sendMessage] threadId required');

        const result = await FacebookSendService.sendTextMessage({
          accountId,
          threadId: String(threadId),
          body: String(cfg.message || ''),
          typeChat: cfg.typeChat,
          replyToMessageId: cfg.replyToMessageId,
        });
        return {
          success: result.success,
          messageId: result.messageId,
          ...(result.error ? { error: result.error } : {}),
        };
      }

      case 'fb.action.addReaction': {
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.addReaction] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const service = await FacebookService.getInstance(accountId);
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!messageId) throw new Error('[fb.action.addReaction] messageId required');
        // E2EE 1:1 → cần gửi qua bridge (reaction có mã hoá)
        if (cfg.typeChat === 'user' && service.isE2EEConnected()) {
          const { normalizeChatJid } = require('../facebook/FacebookUtils');
          const chatJid = normalizeChatJid(String(cfg.threadId || ctx.trigger?.threadId || ''));
          const senderJid = normalizeChatJid(accountId);
          const e2eeResult = await service.sendE2EEReaction(chatJid, String(messageId), senderJid, cfg.emoji || '👍');
          return { success: e2eeResult.success };
        }
        await service.addReaction(String(messageId), cfg.emoji || '👍', 'add');
        return { success: true };
      }

      case 'fb.action.sendImage': {

        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.sendImage] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const service = await FacebookService.getInstance(accountId);
        const threadId = cfg.threadId || ctx.trigger?.threadId;
        if (!threadId) throw new Error('[fb.action.sendImage] threadId required');
        const filePath = String(cfg.filePath);
        const caption = cfg.body || cfg.message || '';
        const isUser = /^\d+$/.test(String(threadId));

        // E2EE 1:1: try bridge first (handles upload internally)
        if (isUser && service.isE2EEConnected()) {
          const { normalizeChatJid } = require('../facebook/FacebookUtils');
          const chatJid = normalizeChatJid(String(threadId));
          const e2eeResult = await service.sendE2EEImage(chatJid, filePath, caption);
          if (e2eeResult.success && e2eeResult.messageId) {
            const fbSenderId = service.getRealFacebookId() || accountId;
            const fileName = require('path').basename(filePath);
            await FacebookSendService.persistSentMessage({
              accountId, threadId: String(threadId),
              messageId: e2eeResult.messageId,
              body: caption || null,
              fbSenderId,
              timestamp: e2eeResult.timestamp || Date.now(),
              type: 'image',
              isUserMessage: true,
              attachments: JSON.stringify([{ type: 'image', name: fileName }]),
            });
            return { success: true, messageId: e2eeResult.messageId };
          }
        }

        // REST fallback: upload + send with attachment
        const att = await service.uploadAttachment(filePath);
        if (!att) throw new Error('[fb.action.sendImage] Upload failed');
        let result = await service.sendMessage(String(threadId), caption, { attachmentId: att.attachmentId });

        // E2EE error detection → retry via bridge for 1:1
        if (!result.success && isUser && /disabled|vô hiệu hoá|encrypted/i.test(result.error || '')) {
          Logger.warn(`[Workflow:fb.action.sendImage] E2EE error, retrying via bridge for thread=${threadId}`);
          if (!service.isE2EEConnected()) {
            try { await service.retryE2EE(); } catch {}
          }
          if (service.isE2EEConnected()) {
            const { normalizeChatJid } = require('../facebook/FacebookUtils');
            const chatJid = normalizeChatJid(String(threadId));
            const e2eeResult = await service.sendE2EEImage(chatJid, filePath, caption);
            if (e2eeResult.success && e2eeResult.messageId) {
              const fbSenderId = service.getRealFacebookId() || accountId;
              const fileName = require('path').basename(filePath);
              await FacebookSendService.persistSentMessage({
                accountId, threadId: String(threadId),
                messageId: e2eeResult.messageId,
                body: caption || null,
                fbSenderId,
                timestamp: e2eeResult.timestamp || Date.now(),
                type: 'image',
                isUserMessage: true,
                attachments: JSON.stringify([{ type: 'image', name: fileName }]),
              });
              return { success: true, messageId: e2eeResult.messageId };
            }
          }
        }

        // ── Save DB + emit cho REST path ──
        if (result.success && result.messageId) {
          const fbSenderId = service.getRealFacebookId() || accountId;
          const fileName = require('path').basename(filePath);
          await FacebookSendService.persistSentMessage({
            accountId, threadId: String(threadId),
            messageId: result.messageId,
            body: caption || null,
            fbSenderId,
            timestamp: result.timestamp || Date.now(),
            type: 'image',
            isUserMessage: isUser,
            attachments: JSON.stringify([{ type: 'image', name: fileName, id: String(att.attachmentId) }]),
          });
        }

        return { success: result.success, messageId: result.messageId };
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
        await s2.markReadOnServer(String(t2));
        return { success: true };
      }

      case 'fb.action.forward': {
        const rawAccountId = cfg.accountId || ctx.trigger?.fbAccountId || ctx.pageId;
        if (!rawAccountId) throw new Error('[fb.action.forward] accountId required');
        const accountId = this.resolveFBAccountId(rawAccountId);
        const threadId = cfg.targetThreadId || ctx.trigger?.threadId;
        if (!threadId) throw new Error('[fb.action.forward] targetThreadId required');
        const message = cfg.message || ctx.trigger?.content || '';
        if (!message) throw new Error('[fb.action.forward] Missing message content');
        // Resend như tin nhắn mới — giống behavior chat (sendOneForward), không dùng forwardMessage API riêng
        const result = await FacebookSendService.sendTextMessage({
          accountId,
          threadId: String(threadId),
          body: String(message),
        });
        return {
          success: result.success,
          messageId: result.messageId,
          ...(result.error ? { error: result.error } : {}),
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
        return { success: r10 };
      }

      default:
        return {};
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getApi(pageId: string): any {
    // Try to find connection by pageId or use any connected account
    let conn = ConnectionManager.getConnection(pageId);
    if (!conn) {
      // Try first available connected account
      for (const [, c] of ConnectionManager.getAllConnections()) {
        if (c.connected) { conn = c; break; }
      }
    }
    if (!conn || !conn.api) throw new Error(`Account ${pageId || 'unknown'} không connected`);
    return conn.api;
  }

  private topologicalSort(wf: Workflow): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const node of wf.nodes) { inDegree.set(node.id, 0); adj.set(node.id, []); }
    for (const edge of wf.edges) {
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
    return result;
  }

  private renderConfig(config: Record<string, any>, ctx: ExecutionContext): Record<string, any> {
    const rendered: Record<string, any> = {};
    for (const [key, value] of Object.entries(config)) {
      rendered[key] = typeof value === 'string' ? this.renderTemplate(value, ctx) : value;
    }
    return rendered;
  }

  private renderTemplate(template: string, ctx: ExecutionContext): string {
    return template.replace(/\{\{\s*([\s\S]*?)\s*\}\}/gu, (_, raw) => {
      try {
        const expr = raw.trim();
        if (expr.startsWith('$trigger.'))   return String(ctx.trigger?.[expr.slice(9)] ?? '');
        if (expr.startsWith('$var.'))       return String(ctx.variables?.[expr.slice(5)] ?? '');
        if (expr === '$pageId')             return ctx.pageId ?? '';
        if (expr === '$date.now')           return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        if (expr === '$date.today')         return new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
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
            Logger.warn(`[WorkflowEngine] $node.${nodeRef}.${field} → fallback n${targetIdx + 1} FAILED — no output for node at index ${targetIdx}. Available nodes: ${ctx._wfNodes.map((n, i) => `n${i+1}=${n.label}`).join(', ')}`);
          }
        }
      } catch {}
      return '';
    });
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
  private compareValues(left: string, right: string): number {
    // Try numeric comparison first
    const ln = Number(left), rn = Number(right);
    if (!isNaN(ln) && !isNaN(rn)) return ln - rn;

    // Try time comparison: HH:MM or HH:MM:SS
    const parseTime = (s: string): number | null => {
      const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;
      return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + (parseInt(m[3] || '0'));
    };
    const lt = parseTime(left), rt = parseTime(right);
    if (lt !== null && rt !== null) return lt - rt;

    // Fallback: string comparison (lexicographic)
    return left.localeCompare(right, 'vi');
  }

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

  /** Normalize legacy/incorrect model names to current API model IDs */
  private normalizeModelName(model: string): string {
    const aliases: Record<string, string> = {
      'deepseek-chat-v3.2':    'deepseek-v4-flash',
      'deepseek-chat-v3.1':    'deepseek-v4-flash',
      'deepseek-reasoner-r1.5':'deepseek-v4-pro',
      'gemini-3.1-pro':        'gemini-3.1-pro-preview',
      'gemini-3.1-flash':      'gemini-3.5-flash',
      'gemini-3.0-flash':      'gemini-3-flash-preview',
      'gemini-3.0-flash-lite': 'gemini-3-flash-preview',
    };
    return aliases[model] ?? model;
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
  // parseStructuredAIResponse → moved to utils/aiUtils.ts

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
