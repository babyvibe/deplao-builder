import EventBroadcaster from './EventBroadcaster';
import DatabaseService from './DatabaseService';
import ConnectionManager from '../utils/ConnectionManager';
import { FacebookService } from './facebook/FacebookService';
import Logger from '../utils/Logger';
import IntegrationRegistry from './integrations/IntegrationRegistry';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as cron from 'node-cron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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
  | 'sapo.lookupCustomer'    | 'sapo.lookupOrder'    | 'sapo.createOrder'    | 'sapo.lookupProduct'
  | 'ipos.lookupCustomer'    | 'ipos.lookupOrder'    | 'ipos.createOrder'    | 'ipos.lookupProduct'
  | 'nhanh.lookupCustomer'   | 'nhanh.lookupOrder'   | 'nhanh.createOrder'   | 'nhanh.lookupProduct'
  | 'pancake.lookupCustomer' | 'pancake.lookupOrder' | 'pancake.createOrder' | 'pancake.lookupProduct'
  | 'payment.getTransactions'
  | 'ghn.createOrder' | 'ghn.getTracking' | 'ghn.getProvinces' | 'ghn.getDistricts' | 'ghn.getWards' | 'ghn.getServices'
  | 'ghtk.createOrder' | 'ghtk.getTracking'
  // Facebook
  | 'fb.trigger.message'
  | 'fb.action.sendMessage' | 'fb.action.addReaction' | 'fb.action.sendImage';

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
    this.registerCronJobs();
    Logger.log(`[WorkflowEngine] Initialized — ${this.workflows.size} workflows loaded`);
  }

  private normalizeWorkflowChannel(channel?: string): WorkflowChannel {
    return channel === 'facebook' ? 'facebook' : 'zalo';
  }

  private isRunnableWorkflow(wf: Workflow): boolean {
    return this.normalizeWorkflowChannel(wf.channel) === 'zalo';
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
      if (wf.pageIds.length > 0 && eventData.zaloId && !wf.pageIds.includes(eventData.zaloId)) continue;
      if (!this.matchesTriggerFilter(triggerNode, eventData)) continue;

      // ─── Debounce for trigger.message: gom tin nhắn liên tiếp ──────────
      const debounceSeconds = Number(triggerNode.config.debounceSeconds || 0);
      if (triggerType === 'trigger.message' && debounceSeconds > 0) {
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
      // Filter by accountId
      if (cfg.accountId && data.fbAccountId !== cfg.accountId) return false;
      // Filter by threadId
      if (cfg.threadId && data.threadId !== cfg.threadId) return false;
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

    return true;
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  public async executeWorkflow(
    wf: Workflow,
    triggerData: any,
    triggeredBy: string = 'manual'
  ): Promise<WorkflowRunLog> {
    if (!this.isRunnableWorkflow(wf)) {
      throw new Error('Workflow Facebook chưa được hỗ trợ chạy ở phiên bản hiện tại');
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
        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'skipped', input: {}, output: {}, durationMs: 0 });
        // Propagate skip to downstream nodes
        this.markDownstreamSkipped(nodeId, wf, context.skippedNodes);
        continue;
      }

      let renderedConfig: Record<string, any> = {};
      try {
        renderedConfig = this.renderConfig(node.config, context);
        const output = await this.executeNode(node, renderedConfig, context, wf);
        context.nodes[nodeId] = { output };

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

        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: renderedConfig, output, durationMs: Date.now() - t0 });
      } catch (err: any) {
        // logic.stopIf signals a graceful stop — treat as success, halt loop
        if (err.message === '__STOP__') {
          nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'success', input: renderedConfig, output: { stopped: true }, durationMs: Date.now() - t0 });
          break;
        }
        nodeResults.push({ nodeId, nodeType: node.type, label: node.label, status: 'error', input: {}, output: {}, durationMs: Date.now() - t0, error: err.message });
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

        // ─── Structured AI response handling ─────────────────────────────
        // Detect AI structured JSON: [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
        const segments = this.parseStructuredAIResponse(cfg.message);
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
                    const res = await api.sendImage(tempPath, cfg.threadId, threadType);
                    lastMsgId = (res as any)?.message?.msgId || lastMsgId;
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
        const result = await api.sendImage(cfg.filePath, cfg.threadId, threadType, cfg.message);
        return { msgId: (result as any)?.msgId || '', success: true };
      }

      case 'zalo.sendFile': {
        const api = this.getApi(ctx.pageId);
        const threadType = Number(cfg.threadType) === 1 ? 1 : 0;
        await api.sendFile(cfg.filePath, cfg.threadId, threadType);
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
        await api.acceptFriendRequest({ userId: cfg.userId } as any);
        return { success: true };
      }

      case 'zalo.rejectFriendRequest': {
        const api = this.getApi(ctx.pageId);
        await (api as any).rejectFriendRequest({ userId: cfg.userId });
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
        await api.forwardMessage({ msgId: cfg.msgId, toThreadId: cfg.toThreadId, toThreadType: Number(cfg.toThreadType ?? 0) } as any);
        return { success: true };
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
          case 'greater_than': result = Number(left) > Number(right); break;
          case 'less_than':    result = Number(left) < Number(right); break;
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
          case 'greater_than': stop = Number(left) > Number(right); break;
          case 'less_than':    stop = Number(left) < Number(right); break;
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
        try { headers = cfg.headers ? (typeof cfg.headers === 'string' ? JSON.parse(cfg.headers) : cfg.headers) : {}; } catch {}
        try { body = cfg.body ? (typeof cfg.body === 'string' ? JSON.parse(cfg.body) : cfg.body) : undefined; } catch { body = cfg.body; }
        try { params = cfg.params ? (typeof cfg.params === 'string' ? JSON.parse(cfg.params) : cfg.params) : undefined; } catch {}
        const response = await axios({
          method: (cfg.method || 'POST').toUpperCase(),
          url: cfg.url,
          headers,
          data: body,
          params,
          timeout: Number(cfg.timeout ?? 10000),
        });
        return { status: response.status, data: response.data };
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
        const { google } = require('googleapis');
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
          rowValues = [[cfg.values]];
        }
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: cfg.spreadsheetId,
          range: `${cfg.sheetName || 'Sheet1'}!A:Z`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rowValues },
        });
        return {
          success: true,
          updatedRange: res.data.updates?.updatedRange || '',
          updatedRows: res.data.updates?.updatedRows || 0,
        };
      }

      case 'sheets.readValues': {
        const { google } = require('googleapis');
        const auth = new google.auth.GoogleAuth({
          keyFile: cfg.serviceAccountPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: cfg.spreadsheetId,
          range: cfg.range || `${cfg.sheetName || 'Sheet1'}!A1:Z1000`,
        });
        const rows: any[][] = res.data.values || [];
        return { rows, count: rows.length, firstRow: rows[0] || [] };
      }

      case 'sheets.updateCell': {
        const { google } = require('googleapis');
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
        });
        return { success: true, range: cfg.range };
      }

      // ── AI (Multi-platform: OpenAI, Gemini, Deepseek, Grok) ─────────────
      case 'ai.generateText': {
        // If assistantId is provided, delegate to AIAssistantService
        if (cfg.assistantId) {
          try {
            const AIAssistantService = (await import('./AIAssistantService')).default;
            const chatMsgs: { role: string; content: string }[] = [];

            // Add chat history if provided
            if (cfg.chatHistory) {
              try {
                let history: any[] = typeof cfg.chatHistory === 'string' && cfg.chatHistory.trim()
                  ? JSON.parse(cfg.chatHistory) : (Array.isArray(cfg.chatHistory) ? cfg.chatHistory : []);
                const maxMsgs = Number(cfg.maxHistoryMessages ?? 10);
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
            const maxMsgs = Number(cfg.maxHistoryMessages ?? 10);
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
        const model = cfg.model || 'gpt-5.4-mini';
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
          // OpenAI-compatible API (OpenAI, Deepseek, Grok/xAI, Mistral)
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
            const AIAssistantService = (await import('./AIAssistantService')).default;
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
        const model = cfg.model || 'gpt-5.4-mini';
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
          // OpenAI-compatible API (OpenAI, Deepseek, Grok/xAI, Mistral)
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

      // ── P0: iPOS ─────────────────────────────────────────────────────────
      case 'ipos.lookupCustomer': {
        const result = await IntegrationRegistry.executeActionByType('ipos', 'lookupCustomer', { phone: cfg.phone });
        return { customers: result.customers || [], found: result.found, firstCustomer: result.firstCustomer || null };
      }
      case 'ipos.lookupOrder': {
        const result = await IntegrationRegistry.executeActionByType('ipos', 'lookupOrder', { phone: cfg.phone, orderId: cfg.orderId });
        const orders: any[] = result.orders || (result.order ? [result.order] : []);
        return { orders, order: result.order || orders[0] || null, found: orders.length > 0 };
      }
      case 'ipos.createOrder': {
        let orderObj: any = {};
        try { orderObj = typeof cfg.order === 'string' ? JSON.parse(cfg.order) : cfg.order; } catch {}
        const result = await IntegrationRegistry.executeActionByType('ipos', 'createOrder', { order: orderObj });
        return { order: result.order || result, success: true };
      }
      case 'ipos.lookupProduct': {
        const result = await IntegrationRegistry.executeActionByType('ipos', 'lookupProduct', {
          keyword: cfg.keyword, limit: Number(cfg.limit || 10),
        });
        return { products: result.products || [], found: result.found };
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
        return { ...ctx.trigger };

      case 'fb.action.sendMessage': {
        const accountId = cfg.accountId || ctx.trigger?.fbAccountId;
        if (!accountId) throw new Error('[fb.action.sendMessage] accountId required');
        const service = FacebookService.getInstance(accountId);
        const threadId = cfg.threadId || ctx.trigger?.threadId;
        if (!threadId) throw new Error('[fb.action.sendMessage] threadId required');
        const result = await service.sendMessage(String(threadId), String(cfg.message || ''));
        return { success: result.success, messageId: result.messageId };
      }

      case 'fb.action.addReaction': {
        const accountId = cfg.accountId || ctx.trigger?.fbAccountId;
        if (!accountId) throw new Error('[fb.action.addReaction] accountId required');
        const service = FacebookService.getInstance(accountId);
        const messageId = cfg.messageId || ctx.trigger?.messageId;
        if (!messageId) throw new Error('[fb.action.addReaction] messageId required');
        await service.addReaction(String(messageId), cfg.emoji || '👍', 'add');
        return { success: true };
      }

      case 'fb.action.sendImage': {
        const accountId = cfg.accountId || ctx.trigger?.fbAccountId;
        if (!accountId) throw new Error('[fb.action.sendImage] accountId required');
        const service = FacebookService.getInstance(accountId);
        const threadId = cfg.threadId || ctx.trigger?.threadId;
        if (!threadId) throw new Error('[fb.action.sendImage] threadId required');
        const att = await service.uploadAttachment(String(cfg.filePath));
        if (!att) throw new Error('[fb.action.sendImage] Upload failed');
        // Send message with attachment reference
        const result = await service.sendMessage(String(threadId), cfg.body || '', { attachmentId: att.attachmentId });
        return { success: result.success };
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
    return template.replace(/\{\{[\s]*([\w$.[\]]+)[\s]*}}/g, (_, expr) => {
      try {
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
              return String(this.getNestedValue(ndata.output, field) ?? '');
            }
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

  /** Get the OpenAI-compatible chat/completions URL for a given platform */
  private getOpenAICompatibleUrl(platform: string): string {
    switch (platform) {
      case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
      case 'grok':     return 'https://api.x.ai/v1/chat/completions';
      case 'mistral':  return 'https://api.mistral.ai/v1/chat/completions';
      case 'openai':
      default:         return 'https://api.openai.com/v1/chat/completions';
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
  private parseStructuredAIResponse(message: string): Array<{ type: 'text' | 'image'; content: any }> | null {
    if (!message || typeof message !== 'string') return null;
    const trimmed = message.trim();
    if (!trimmed.startsWith('[')) return null;

    try {
      // Try direct parse first
      const parsed = JSON.parse(trimmed);
      if (this.isValidStructuredResponse(parsed)) return parsed as Array<{ type: 'text' | 'image'; content: any }>;
    } catch {
      // Try regex extraction (AI may wrap JSON in markdown code block)
      try {
        const jsonMatch = trimmed.match(/\[[\s\S]*]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (this.isValidStructuredResponse(parsed)) return parsed as Array<{ type: 'text' | 'image'; content: any }>;
        }
      } catch {}
    }
    return null;
  }

  private isValidStructuredResponse(parsed: any): parsed is Array<{ type: 'text' | 'image'; content: any }> {
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every((item: any) =>
      item && typeof item === 'object' &&
      (item.type === 'text' || item.type === 'image') &&
      item.content !== undefined
    );
  }

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

