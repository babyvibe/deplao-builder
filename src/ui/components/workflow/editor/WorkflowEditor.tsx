import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState,
  MarkerType, ReactFlowInstance, Connection, Edge, Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { v4 as uuidv4 } from 'uuid';
import { CustomDeletableEdge } from '../nodes/WorkflowNodes';
import { reactFlowNodeTypes } from '../nodes/nodeRegistry';
import { CHANNEL } from '@/lib/channels/channelHelper';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';
import RunHistoryPanel from '../RunHistoryPanel';
import WorkflowAIDialog from '../ai/WorkflowAIDialog';
import SimulateModal from './SimulateModal';
import { DEFAULT_CONFIGS, nodeTypeGroup, getNodeLabel } from '../nodes/workflowConfig';
import { pluginDefaultConfig } from '../nodes/pluginNodes';
import { getNodeVisual } from '../nodes/nodeVisuals';
import { computeAutoLayout, LayoutPositions } from './autoLayout';
import { MaterializedWorkflow, ProposalMode } from '../ai/aiCopilot';
import { Channel, normalizeChannel, getChannelLabel } from '../../../../configs/channels/channelConfig';
import ipc from '../../../lib/ipc'
import DataAccessor from '@/lib/data/DataAccessor';;
import { useAppStore } from '@/store/app/appStore';
import PageLoading from '../../common/PageLoading';
import { SearchIcon, SmartphoneIcon, PlayIcon, SparklesIcon, LayoutIcon, UndoIcon } from '@/components/common/icons';

// Use node types from registry (centralized node component mapping)
const nodeTypes = reactFlowNodeTypes;

/** Auto layout: nodes glide for this long (`.wf-canvas--animating` in index.css). */
const LAYOUT_ANIMATION_MS = 400;
/** How long the "Hoàn tác" button stays after an auto layout. */
const LAYOUT_UNDO_MS = 10_000;
/** How long "Hoàn tác AI" stays after applying an AI copilot proposal. */
const AI_UNDO_MS = 30_000;

/** Saved / generated edge → React Flow edge (Telegram inline-button routes are dashed). */
const toRFEdge = (e: any): Edge => ({
  ...e, type: 'custom',
  markerEnd: { type: MarkerType.ArrowClosed },
  style: e.data?.telegramInline
    ? { stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '6 4' }
    : { stroke: '#4b5563' },
});

const edgeTypes = {
  custom: CustomDeletableEdge,
};

interface Props {
  workflowId: string;
  onBack: () => void;
}

const normalizeWorkflowChannel = (ch?: string): Channel => {
  // Legacy 'telegram' → default to 'telegram_user'
  if (ch === 'telegram') return 'telegram_user' as Channel;
  return normalizeChannel(ch);
};

// ── Test-run recipient picker modal ──────────────────────────────────────────
function TestRunModal({ accounts, workflowPageIds, triggerType, onRun, onClose }: {
  accounts: { zalo_id: string; full_name: string; avatar_url: string; phone?: string }[];
  workflowPageIds: string[];
  triggerType?: string;
  onRun: (triggerData: any) => void;
  onClose: () => void;
}) {
  const isFriendRequest = triggerType === 'trigger.friendRequest';
  const [selectedAccount, setSelectedAccount] = useState('');
  const [friends, setFriends] = useState<{ userId: string; displayName: string; avatar: string }[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<{ userId: string; displayName: string } | null>(null);
  const [search, setSearch] = useState('');
  const [testContent, setTestContent] = useState('Xin chào, đây là tin nhắn thử nghiệm từ workflow');

  // Filter accounts: only show accounts in workflow's pageIds (or all if none set)
  const availableAccounts = workflowPageIds.length > 0
    ? accounts.filter(a => workflowPageIds.includes(a.zalo_id))
    : accounts;

  // Auto-select first account
  useEffect(() => {
    if (availableAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(availableAccounts[0].zalo_id);
    }
  }, [availableAccounts]);

  // Load friends when account changes
  useEffect(() => {
    if (!selectedAccount) return;
    setLoadingFriends(true);
    setSelectedFriend(null);
    DataAccessor.getFriends({ zaloId: selectedAccount }).then((res: any) => {
      if (res?.success) {
        // Exclude self (the selected account itself)
        const list = (res.friends || []).filter((f: any) => f.userId !== selectedAccount);
        setFriends(list);
      }
    }).catch(() => {}).finally(() => setLoadingFriends(false));
  }, [selectedAccount]);

  const filteredFriends = search.trim()
    ? friends.filter(f => f.displayName?.toLowerCase().includes(search.toLowerCase()) || f.userId?.includes(search))
    : friends;

  const handleRun = () => {
    if (!selectedFriend || !selectedAccount) return;
    if (isFriendRequest) {
      onRun({
        userId: selectedFriend.userId,
        displayName: selectedFriend.displayName,
        phone: '',
        message: '',
        zaloId: selectedAccount,
      });
    } else {
      onRun({
        zaloId: selectedAccount,
        threadId: selectedFriend.userId,
        threadType: 0,
        fromId: selectedFriend.userId,
        fromName: selectedFriend.displayName,
        content: testContent,
        isGroup: false,
        isSelf: false,
        timestamp: Date.now(),
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-popover border border-border rounded-2xl shadow-2xl w-[440px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-foreground font-semibold text-sm flex items-center gap-2"><PlayIcon className="w-4 h-4" /> Chạy thử Workflow</p>
            <p className="text-muted-foreground text-[11px] mt-0.5">{isFriendRequest ? 'Chọn người để mô phỏng lời mời kết bạn' : 'Chọn người nhận để gửi tin nhắn thử nghiệm'}</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Account selector */}
          {availableAccounts.length > 1 && (
            <div>
              <label className="text-muted-foreground text-xs font-medium mb-1.5 block">Tài khoản gửi</label>
              <div className="space-y-1.5">
                {availableAccounts.map(acc => (
                  <button key={acc.zalo_id} type="button"
                    onClick={() => setSelectedAccount(acc.zalo_id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition-all ${
                      selectedAccount === acc.zalo_id
                        ? 'bg-blue-600/20 border-blue-500/60 ring-1 ring-blue-500/30'
                        : 'bg-card/60 border-border/50 hover:border-input'
                    }`}>
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                      : <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
                          {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                        </div>}
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium truncate ${selectedAccount === acc.zalo_id ? 'text-blue-300' : 'text-foreground'}`}>
                        {acc.full_name || acc.zalo_id}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Test message content */}
          {!isFriendRequest && (
          <div>
            <label className="text-muted-foreground text-xs font-medium mb-1.5 block">Nội dung tin nhắn thử ($trigger.content)</label>
            <textarea
              value={testContent}
              onChange={e => setTestContent(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:border-blue-500 outline-none resize-none"
              rows={2}
              placeholder="Nhập tin nhắn thử nghiệm..."
            />
          </div>
          )}

          {/* Friend picker */}
          <div>
            <label className="text-muted-foreground text-xs font-medium mb-1.5 block">
              {isFriendRequest ? 'Chọn người gửi lời mời kết bạn' : 'Chọn người nhận'} <span className="text-muted-foreground">(không thể gửi cho chính mình)</span>
            </label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:border-blue-500 outline-none mb-2"
              placeholder="Tìm tên hoặc ID..."
            />

            {loadingFriends ? (
              <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground text-xs">
                <span className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                Đang tải danh bạ…
              </div>
            ) : filteredFriends.length === 0 ? (
              <div className="py-4 text-center text-muted-foreground text-xs">
                {friends.length === 0 ? 'Chưa có bạn bè nào' : 'Không tìm thấy'}
              </div>
            ) : (
              <div className="max-h-[200px] overflow-y-auto space-y-1 pr-1">
                {filteredFriends.slice(0, 50).map(f => {
                  const isActive = selectedFriend?.userId === f.userId;
                  return (
                    <button key={f.userId} type="button"
                      onClick={() => setSelectedFriend(isActive ? null : f)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-all ${
                        isActive
                          ? 'bg-green-600/20 border-green-500/60 ring-1 ring-green-500/30'
                          : 'bg-card/40 border-border/40 hover:border-input'
                      }`}>
                      {f.avatar
                        ? <img src={f.avatar} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                        : <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-[10px] text-muted-foreground font-bold">
                            {(f.displayName || '?').charAt(0).toUpperCase()}
                          </div>}
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${isActive ? 'text-green-300' : 'text-foreground'}`}>
                          {f.displayName || f.userId}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">{f.userId}</p>
                      </div>
                      {isActive && (
                        <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex gap-2 flex-shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-card hover:bg-muted text-foreground/80 text-sm font-medium rounded-xl transition-colors">
            Hủy
          </button>
          <button onClick={handleRun} disabled={!selectedFriend || !selectedAccount}
            className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Chạy thử
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkflowEditor({ workflowId, onBack }: Props) {
  const { showNotification, theme } = useAppStore();
  const isLight = theme === 'light';
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [workflowMeta, setWorkflowMeta] = useState({
    name: '', description: '', enabled: true, channel: 'zalo' as Channel,
    pageIds: [] as string[],   // new: multi-page
  });
  const [loadingEditor, setLoadingEditor] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [accounts, setAccounts] = useState<{ zalo_id: string; full_name: string; avatar_url: string; phone?: string; channel?: string }[]>([]);
  const [showPagePicker, setShowPagePicker] = useState(false);
  const [showTestRunModal, setShowTestRunModal] = useState(false);
  const [showAIDialog, setShowAIDialog] = useState(false);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [layoutAnimating, setLayoutAnimating] = useState(false);
  const [canUndoLayout, setCanUndoLayout] = useState(false);
  const [canUndoAI, setCanUndoAI] = useState(false);
  /** Canvas before the last AI copilot apply (for "Hoàn tác AI"). */
  const aiUndoRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  /** Node positions before the last auto layout (for "Hoàn tác"). */
  const layoutUndoRef = useRef<LayoutPositions | null>(null);
  const layoutTimersRef = useRef<{
    animation?: ReturnType<typeof setTimeout>;
    fit?: ReturnType<typeof setTimeout>;
    undo?: ReturnType<typeof setTimeout>;
    aiUndo?: ReturnType<typeof setTimeout>;
  }>({});

  useEffect(() => {
    const timers = layoutTimersRef.current;
    return () => {
      clearTimeout(timers.animation);
      clearTimeout(timers.fit);
      clearTimeout(timers.undo);
      clearTimeout(timers.aiUndo);
    };
  }, []);

  // Load connected accounts for page selector
  useEffect(() => {
    ipc.login?.getAccounts().then((res: any) => {
      if (res?.success) setAccounts(res.accounts || []);
    }).catch(() => {});
  }, []);

  const toRFNode = useCallback((n: any) => ({
    id: n.id,
    type: nodeTypeGroup(n.type),
    position: n.position || { x: 100, y: 100 },
    data: { ...n, type: n.type, label: n.label || getNodeLabel(n.type), config: n.config || {} },
  }), []);

  // Load workflow
  useEffect(() => {
    if (!workflowId) return;
    setLoadingEditor(true);
    // DataAccessor: chế độ nhân viên đọc workflow từ Boss (IPC workflow:get trả "Không khả dụng" → không mở được)
    DataAccessor.getWorkflow(workflowId).then((res: any) => {
      if (!res?.success || !res.workflow) return;
      const wf = res.workflow;
      setWorkflowMeta({
        name: wf.name,
        description: wf.description || '',
        enabled: wf.enabled,
        channel: normalizeWorkflowChannel(wf.channel),
        pageIds: Array.isArray(wf.pageIds) ? wf.pageIds : (wf.pageId ? [wf.pageId] : []),
      });
      setNodes(wf.nodes.map((n: any) => toRFNode(n)));
      setEdges(wf.edges.map((e: any) => toRFEdge(e)));
      setLoadingEditor(false);
    }).catch(() => setLoadingEditor(false));
  }, [workflowId, toRFNode]);

  const onConnect = useCallback((params: Connection | Edge) => {
    setEdges(es => addEdge({
      ...params,
      type: 'custom',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#4b5563' },
    }, es));
  }, [setEdges]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData('nodeType');
    if (!nodeType || !rfInstanceRef.current) return;
    const pos = rfInstanceRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const newNode = {
      id: uuidv4(),
      type: nodeType,
      label: getNodeLabel(nodeType),
      position: pos,
      config: { ...(DEFAULT_CONFIGS[nodeType] || pluginDefaultConfig(nodeType) || {}) },
    };
    setNodes(ns => [...ns, toRFNode(newNode)]);
  }, [setNodes, toRFNode]);

  const onNodeClick = useCallback((_: any, node: any) => {
    setSelectedNode(node.data);
  }, []);

  const updateNodeConfig = (nodeId: string, config: Record<string, any>) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, config } } : n));
    if (selectedNode?.id === nodeId) setSelectedNode((p: any) => ({ ...p, config }));
  };

  /**
   * Inline Telegram Bot buttons are callback-only routes. Keep a dashed edge on
   * the canvas for documentation, but mark it so ordinary workflow execution
   * never follows it before a user actually presses the button.
   */
  const updateTelegramInlineRoutes = (sourceId: string, targetNodeIds: string[]) => {
    const uniqueTargets = Array.from(new Set(targetNodeIds)).filter(Boolean);
    setEdges(current => {
      const retained = current.filter(edge => !(edge.source === sourceId && edge.data?.telegramInline));
      const routes = uniqueTargets.map(target => ({
        id: `telegram-inline:${sourceId}:${target}`,
        source: sourceId,
        target,
        sourceHandle: 'default',
        targetHandle: 'default',
        data: { telegramInline: true },
        type: 'custom',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '6 4' },
      }));
      return [...retained, ...routes];
    });
  };

  const updateNodeLabel = (nodeId: string, label: string) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, label } } : n));
    if (selectedNode?.id === nodeId) setSelectedNode((p: any) => ({ ...p, label }));
  };

  // ── Auto layout ("Sắp xếp tự động") ──────────────────────────────────────
  // Only moves nodes in local state; positions are persisted when the user presses "Lưu".

  /** Glides the nodes to `positions` (nodes missing from it stay put), then fits the view. */
  const moveNodesAnimated = (positions: LayoutPositions) => {
    const timers = layoutTimersRef.current;
    clearTimeout(timers.animation);
    clearTimeout(timers.fit);
    setLayoutAnimating(true);
    setNodes(ns => ns.map(n => (positions[n.id] ? { ...n, position: positions[n.id] } : n)));
    timers.animation = setTimeout(() => setLayoutAnimating(false), LAYOUT_ANIMATION_MS);
    timers.fit = setTimeout(() => {
      rfInstanceRef.current?.fitView({ padding: 0.2, duration: LAYOUT_ANIMATION_MS });
    }, 50);
  };

  const handleAutoLayout = () => {
    if (nodes.length < 2) return;
    const previous: LayoutPositions = {};
    nodes.forEach(n => { previous[n.id] = { x: n.position.x, y: n.position.y }; });
    layoutUndoRef.current = previous;
    moveNodesAnimated(computeAutoLayout(nodes, edges));
    setCanUndoLayout(true);
    const timers = layoutTimersRef.current;
    clearTimeout(timers.undo);
    timers.undo = setTimeout(() => {
      layoutUndoRef.current = null;
      setCanUndoLayout(false);
    }, LAYOUT_UNDO_MS);
  };

  const handleUndoLayout = () => {
    const previous = layoutUndoRef.current;
    clearTimeout(layoutTimersRef.current.undo);
    layoutUndoRef.current = null;
    setCanUndoLayout(false);
    if (previous) moveNodesAnimated(previous);
  };

  const buildWorkflow = () => ({
    id: workflowId,
    name: workflowMeta.name,
    description: workflowMeta.description,
    enabled: workflowMeta.enabled,
    channel: workflowMeta.channel,
    pageIds: workflowMeta.pageIds,
    nodes: nodes.map(n => ({
      id: n.id, type: n.data.type, label: n.data.label, position: n.position, config: n.data.config,
    })),
    edges: edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, data: e.data })),
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await ipc.workflow?.save(buildWorkflow());
      if (res?.success) {
        showNotification('Đã lưu workflow', 'success');
        // Apply generated webhook token to local node state
        if (res.webhookToken) {
          setNodes(prev => prev.map(n => {
            if ((n.data?.type || '').startsWith('trigger.webhook')) {
              return {
                ...n,
                data: {
                  ...n.data,
                  config: { ...(n.data?.config || {}), webhookToken: res.webhookToken }
                }
              };
            }
            return n;
          }));
        }
      } else {
        showNotification(res?.error || 'Lỗi lưu workflow', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async (triggerData?: any) => {
    setRunning(true);
    try {
      // Save first, then run
      await ipc.workflow?.save(buildWorkflow());
      const res = await ipc.workflow?.runManual(workflowId, triggerData);
      if (res?.success) showNotification(`Chạy thành công - ${res.log?.status}`, 'success');
      else showNotification(res?.error || 'Lỗi chạy workflow', 'error');
    } finally {
      setRunning(false);
    }
  };

  // ── Check if workflow has send-message nodes → need recipient picker ─────
  const isTriggerType = (t: string) => t.startsWith('trigger.') || t.includes('.trigger.');
  const triggerNode = nodes.find(n => isTriggerType(n.data?.type || ''));
  const triggerType = triggerNode?.data?.type || '';
  const triggerLabel = triggerNode?.data?.label || '';
  const hasSendNodes = nodes.some(n => {
    const t = n.data?.type || '';
    return t === 'zalo.sendMessage' || t === 'zalo.sendImage' || t === 'zalo.sendFile'
      || t === 'zalo.sendVoice' || t === 'zalo.sendTyping';
  });

  const handleRunClick = () => {
    if (hasSendNodes || triggerType === 'trigger.friendRequest') {
      setShowTestRunModal(true);
    } else {
      handleRun();
    }
  };

  // ── AI copilot: apply a proposal (result = the whole canvas after the change) ──
  const aiCanvas = React.useMemo(() => (showAIDialog ? {
    nodes: nodes.map(n => ({ id: n.id, type: n.data.type, label: n.data.label, position: n.position, config: n.data.config })),
    edges: edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, data: e.data })),
  } : null), [showAIDialog, nodes, edges]);

  const handleAIApply = (result: MaterializedWorkflow, mode: ProposalMode, title: string) => {
    aiUndoRef.current = { nodes, edges };
    setNodes(result.nodes.map(n => toRFNode(n)));
    setEdges(result.edges.map(e => toRFEdge(e)));
    setSelectedNode(null);
    setCanUndoAI(true);
    const timers = layoutTimersRef.current;
    clearTimeout(timers.aiUndo);
    timers.aiUndo = setTimeout(() => { aiUndoRef.current = null; setCanUndoAI(false); }, AI_UNDO_MS);
    clearTimeout(timers.fit);
    timers.fit = setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: LAYOUT_ANIMATION_MS }), 80);
    const parts = [
      result.addedIds.length ? `thêm ${result.addedIds.length} node` : '',
      mode === 'append' && result.updatedIds.length ? `sửa ${result.updatedIds.length} node` : '',
      result.removedIds.length ? `xoá ${result.removedIds.length} node` : '',
    ].filter(Boolean).join(', ');
    showNotification(`Đã áp dụng "${title}"${parts ? ` (${parts})` : ''} - nhớ bấm Lưu!`, 'success');
  };

  const handleUndoAI = () => {
    const snapshot = aiUndoRef.current;
    clearTimeout(layoutTimersRef.current.aiUndo);
    aiUndoRef.current = null;
    setCanUndoAI(false);
    if (!snapshot) return;
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedNode(null);
  };

  // ── Export workflow as JSON ──────────────────────────────────────────────
  const handleExport = () => {
    const wf = buildWorkflow();
    const exportData = {
      _deplaoWorkflow: true,
      _version: 1,
      _exportedAt: new Date().toISOString(),
      channel: workflowMeta.channel,
      name: wf.name,
      description: wf.description,
      nodes: wf.nodes,
      edges: wf.edges,
    };
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${wf.name.replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1E00-\u1EFF]/g, '_').substring(0, 50)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification('Đã xuất workflow thành file JSON', 'success');
  };

  // ── Import workflow from JSON ───────────────────────────────────────────
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data._deplaoWorkflow) {
          showNotification('File không phải workflow Deplao hợp lệ', 'error');
          return;
        }
        // File cũ không có channel → mặc định Zalo
        const importChannel = normalizeWorkflowChannel(data.channel);

        // Assign new IDs to avoid conflicts
        // Assign new IDs to avoid conflicts
        const idMap: Record<string, string> = {};
        const originalNodes = data.nodes || [];
        originalNodes.forEach((n: any) => { idMap[n.id] = uuidv4(); });

        // Remap $node.xxx references in configs to use new UUIDs
        const remapRef = (str: string) =>
          str.replace(/\$node\.([\w-]+)\./g, (m, ref) => {
            if (idMap[ref]) return `$node.${idMap[ref]}.`;
            return m;
          });
        const deepRemap = (obj: any): any => {
          if (typeof obj === 'string') return remapRef(obj);
          if (Array.isArray(obj)) return obj.map(item => typeof item === 'string' ? remapRef(item) : item && typeof item === 'object' ? deepRemap(item) : item);
          if (obj && typeof obj === 'object') { const r: any = {}; for (const [k, v] of Object.entries(obj)) r[k] = deepRemap(v); return r; }
          return obj;
        };

        const importedNodes = originalNodes.map((n: any) => ({
          ...n,
          id: idMap[n.id],
          config: deepRemap(n.config),
        }));
        const importedEdges = (data.edges || []).map((e: any) => ({
          ...e,
          id: uuidv4(),
          source: idMap[e.source] || e.source,
          target: idMap[e.target] || e.target,
        }));

        // Replace current nodes & edges
        setNodes(importedNodes.map((n: any) => toRFNode(n)));

        setEdges(importedEdges.map((e: any) => ({
          ...e, type: 'custom',
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: '#4b5563' },
        })));
        setWorkflowMeta(m => ({
          ...m,
          channel: importChannel,
          name: data.name || m.name,
          description: data.description || m.description,
        }));
        setSelectedNode(null);
        showNotification(`Đã nhập workflow "${data.name || 'Imported'}" - nhớ Lưu để áp dụng!`, 'success');
      } catch (err: any) {
        showNotification('Lỗi đọc file JSON: ' + (err.message || 'Invalid JSON'), 'error');
      }
    };
    reader.readAsText(file);
    // reset input so same file can be re-imported
    e.target.value = '';
  };

  const channelLabel = getChannelLabel(workflowMeta.channel as Channel);

  // Filter accounts by workflow channel - only show matching accounts
  const filteredAccounts = accounts.filter(a => {
    const accChannel = a.channel || CHANNEL.ZALO;
    return accChannel === workflowMeta.channel;
  });

  // Page selector label
  const pageLabel = workflowMeta.pageIds.length === 0
    ? <span className="text-amber-400">⚠ Tất cả tài khoản {channelLabel} ({filteredAccounts.length})</span>
    : workflowMeta.pageIds.length === 1
      ? <span className="text-blue-300"><SmartphoneIcon className="w-4 h-4 inline" /> {accounts.find(a => a.zalo_id === workflowMeta.pageIds[0])?.full_name || workflowMeta.pageIds[0]}</span>
      : <span className="text-blue-300"><SmartphoneIcon className="w-4 h-4 inline" /> {workflowMeta.pageIds.length} tài khoản</span>;

  const togglePage = (zaloId: string) => {
    setWorkflowMeta(m => ({
      ...m,
      pageIds: m.pageIds.includes(zaloId)
        ? m.pageIds.filter(id => id !== zaloId)
        : [...m.pageIds, zaloId],
    }));
  };

  if (loadingEditor) return <PageLoading text="Đang tải workflow..." />;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Hidden file input for import */}
      <input ref={importFileRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-card border-b border-border flex-shrink-0 flex-wrap">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1">
          ← Quay lại
        </button>
        <div className="w-px h-5 bg-muted" />
        <input
          value={workflowMeta.name}
          onChange={e => setWorkflowMeta(m => ({ ...m, name: e.target.value }))}
          className="bg-transparent border-b border-border focus:border-blue-500 text-foreground text-sm px-1 py-0.5 outline-none min-w-0 w-48"
          placeholder="Tên workflow..."
        />

        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${
          workflowMeta.channel === CHANNEL.ZALO
            ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
            : workflowMeta.channel === CHANNEL.FACEBOOK
              ? 'bg-[#1877F2]/10 border-[#1877F2]/30 text-[#1877F2]'
              : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-600'
        }`}>
          <span>Kênh: {channelLabel}</span>
        </div>

        {/* ── Page selector ─────────────────────────────────────────── */}
        <div className="relative">
          <button
            onClick={() => setShowPagePicker(p => !p)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border border-border hover:border-border-strong text-xs transition-colors"
          >
            {pageLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {showPagePicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl min-w-[220px] py-2">
              <p className="text-[11px] text-muted-foreground px-3 pb-1.5 font-medium uppercase tracking-wider">
                Workflow áp dụng cho tài khoản {channelLabel}
              </p>
              {filteredAccounts.length === 0 && (
                <p className="text-muted-foreground text-xs px-3 py-2">Chưa có tài khoản {channelLabel} nào</p>
              )}
              {filteredAccounts.map(acc => (
                <label key={acc.zalo_id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-card cursor-pointer">
                  <input
                    type="checkbox"
                    checked={workflowMeta.pageIds.includes(acc.zalo_id)}
                    onChange={() => togglePage(acc.zalo_id)}
                    className="accent-blue-500 w-3.5 h-3.5"
                  />
                  {acc.avatar_url && (
                    <img src={acc.avatar_url} className="w-5 h-5 rounded-full object-cover flex-shrink-0" alt="" />
                  )}
                  <div className="min-w-0">
                    <div className="text-foreground text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</div>
                    {acc.phone && <div className="text-muted-foreground text-[11px]">{acc.phone}</div>}
                    <div className="text-muted-foreground text-[11px]">{acc.zalo_id}</div>
                  </div>
                </label>
              ))}
              <div className="border-t border-border mt-1 pt-1 px-3">
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {workflowMeta.pageIds.length === 0
                    ? `⚠ Chưa chọn tài khoản - workflow sẽ chạy cho TẤT CẢ tài khoản ${channelLabel} (${filteredAccounts.length})`
                    : `✓ Sẽ chạy cho ${workflowMeta.pageIds.length} tài khoản ${channelLabel} đã chọn`}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Export */}
          <button onClick={handleExport} title="Xuất workflow ra JSON"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-card hover:bg-muted border border-border text-foreground/80 text-xs font-medium rounded-xl transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Xuất
          </button>
          {/* Import */}
          <button onClick={() => importFileRef.current?.click()} title="Nhập workflow từ JSON"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-card hover:bg-muted border border-border text-foreground/80 text-xs font-medium rounded-xl transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Nhập
          </button>
          {/* AI Builder */}
          <button onClick={() => setShowAIDialog(true)} title="Trợ lý AI: trò chuyện để thiết kế hoặc sửa workflow"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 border border-violet-500/50 text-white/90 text-xs font-medium rounded-xl transition-all shadow-sm shadow-violet-500/20">
            <SparklesIcon className="w-3.5 h-3.5" /> AI
          </button>

          <div className="w-px h-4 bg-muted" />

          {/* enabled toggle */}
          <button
            onClick={() => setWorkflowMeta(m => ({ ...m, enabled: !m.enabled }))}
            className="flex items-center gap-2 cursor-pointer"
            title={workflowMeta.enabled ? 'Đang bật - nhấn để tắt' : 'Đang tắt - nhấn để bật'}
          >
            <div className={`w-8 h-[18px] rounded-full transition-colors relative ${workflowMeta.enabled ? 'bg-blue-600' : 'bg-muted'}`}>
              <span className={`absolute top-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-all ${workflowMeta.enabled ? 'left-[18px]' : 'left-[2px]'}`} />
            </div>
            <span className={`text-xs font-medium transition-colors ${workflowMeta.enabled ? 'text-blue-400' : 'text-muted-foreground'}`}>
              {workflowMeta.enabled ? 'Bật' : 'Tắt'}
            </span>
          </button>

          <div className="w-px h-4 bg-muted" />

          <button onClick={() => setShowSimulateModal(true)} disabled={running}
            title="Chạy thử khô (không gửi tin thật) - xem luồng dạng chat mô phỏng"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-500 hover:to-teal-500 border border-cyan-500/50 text-white/90 text-xs font-medium rounded-xl transition-all shadow-sm shadow-cyan-500/20 disabled:opacity-40">
            <SparklesIcon className="w-3.5 h-3.5" /> Mô phỏng
          </button>
          <button onClick={handleRunClick} disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs font-medium rounded-xl transition-colors">
            {running ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
            Chạy thử
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium rounded-xl transition-colors">
            {saving ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>}
            Lưu
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden" onClick={() => setShowPagePicker(false)}>
        <NodePalette channel={workflowMeta.channel} />

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className={`flex-1 relative wf-canvas${layoutAnimating ? ' wf-canvas--animating' : ''}`}
            onDrop={onDrop} onDragOver={e => e.preventDefault()}
            onClick={e => e.stopPropagation()}>
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onConnect={onConnect} onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedNode(null)}
              onNodesDelete={deleted => {
                if (selectedNode && deleted.some(n => n.id === selectedNode.id)) setSelectedNode(null);
              }}
              nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              deleteKeyCode={['Backspace', 'Delete']}
              onInit={inst => { rfInstanceRef.current = inst; }}
              fitView proOptions={{ hideAttribution: true }}
              // Mặc định 0.5 → "Sắp xếp tự động" của workflow lớn không thu vừa màn hình
              minZoom={0.2}
              defaultEdgeOptions={{ type: 'custom', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#4b5563' } }}
            >
              {/* SVG attributes cannot read CSS variables → theme colours passed explicitly */}
              <Background color={isLight ? '#d3ccbf' : '#2a303c'} gap={20} size={1.4} />
              <Controls />
              <MiniMap
                nodeColor={n => getNodeVisual(n.data?.type || '').accent}
                nodeStrokeWidth={0}
                nodeBorderRadius={6}
                maskColor={isLight ? 'rgba(243,241,236,0.72)' : 'rgba(13,16,22,0.72)'}
                style={{ background: 'var(--wf-card)' }}
              />
            </ReactFlow>
            {/* Canvas toolbar: auto layout (+ undo for a few seconds afterwards) */}
            <div className="wf-canvas-toolbar">
              {canUndoAI && (
                <button type="button" className="wf-btn" onClick={handleUndoAI}
                  title="Đưa sơ đồ về trước khi áp dụng đề xuất của AI">
                  <UndoIcon className="w-3.5 h-3.5" /> Hoàn tác AI
                </button>
              )}
              {canUndoLayout && (
                <button type="button" className="wf-btn" onClick={handleUndoLayout}
                  title="Đưa các node về vị trí trước khi sắp xếp">
                  <UndoIcon className="w-3.5 h-3.5" /> Hoàn tác
                </button>
              )}
              <button type="button" className="wf-btn" onClick={handleAutoLayout} disabled={nodes.length < 2}
                title="Tự động sắp xếp các node theo luồng (có thể hoàn tác)">
                <LayoutIcon className="w-3.5 h-3.5" /> Sắp xếp tự động
              </button>
            </div>
            {/* UX hint */}
            <div className="wf-canvas-hint">
              Chọn liên kết rồi bấm <span className="wf-kbd">✕</span> hoặc <span className="wf-kbd">Del</span> để xóa
            </div>
          </div>
          <RunHistoryPanel workflowId={workflowId} />
        </div>

        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            nodes={nodes}
            edges={edges}
            workflowId={workflowId}
            onConfigChange={cfg => updateNodeConfig(selectedNode.id, cfg)}
            onLabelChange={label => updateNodeLabel(selectedNode.id, label)}
            onInlineRoutesChange={targets => updateTelegramInlineRoutes(selectedNode.id, targets)}
            onClose={() => setSelectedNode(null)}
            workflowChannel={workflowMeta.channel}
            workflowPageIds={workflowMeta.pageIds}
          />
        )}
      </div>

      {/* Test Run Modal */}
      {showTestRunModal && (
        <TestRunModal
          accounts={accounts}
          workflowPageIds={workflowMeta.pageIds}
          triggerType={triggerType}
          onRun={(triggerData) => handleRun(triggerData)}
          onClose={() => setShowTestRunModal(false)}
        />
      )}

      {/* Workflow Simulate (dry-run mock chat) */}
      {showSimulateModal && (
        <SimulateModal
          workflowId={workflowId}
          channel={workflowMeta.channel}
          triggerType={triggerType}
          triggerLabel={triggerLabel}
          onClose={() => setShowSimulateModal(false)}
        />
      )}

      {/* AI Workflow Builder Dialog */}
      {showAIDialog && aiCanvas && (
        <WorkflowAIDialog
          workflowId={workflowId}
          currentNodes={aiCanvas.nodes}
          currentEdges={aiCanvas.edges}
          channel={workflowMeta.channel}
          pageIds={workflowMeta.pageIds}
          onApply={handleAIApply}
          onClose={() => setShowAIDialog(false)}
        />
      )}
    </div>
  );
}
