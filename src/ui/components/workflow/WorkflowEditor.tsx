import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState,
  MarkerType, ReactFlowInstance, Connection, Edge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { v4 as uuidv4 } from 'uuid';
import { CustomDeletableEdge } from './nodes/WorkflowNodes';
import { reactFlowNodeTypes } from './nodeRegistry';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';
import RunHistoryPanel from './RunHistoryPanel';
import WorkflowAIDialog from './WorkflowAIDialog';
import { DEFAULT_CONFIGS, nodeTypeGroup, getNodeLabel, isUnsupportedWorkflowNodeType } from './workflowConfig';
import ipc from '../../lib/ipc';
import { useAppStore } from '@/store/appStore';
import type { Channel } from '../../../configs/channelConfig';

// Use node types from registry (centralized node component mapping)
const nodeTypes = reactFlowNodeTypes;

const edgeTypes = {
  custom: CustomDeletableEdge,
};

interface Props {
  workflowId: string;
  onBack: () => void;
}

const normalizeWorkflowChannel = (channel?: string): Channel => channel === 'facebook' ? 'facebook' : 'zalo';

const hasUnsupportedWorkflowNodes = (nodes: any[]): boolean => {
  return nodes.some((node: any) => typeof node?.data?.type === 'string' && isUnsupportedWorkflowNodeType(node.data.type));
};

// ── Test-run recipient picker modal ──────────────────────────────────────────
function TestRunModal({ accounts, workflowPageIds, onRun, onClose }: {
  accounts: { zalo_id: string; full_name: string; avatar_url: string; phone?: string }[];
  workflowPageIds: string[];
  onRun: (triggerData: any) => void;
  onClose: () => void;
}) {
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
    ipc.db?.getFriends({ zaloId: selectedAccount }).then((res: any) => {
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
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[440px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-white font-semibold text-sm flex items-center gap-2">▶️ Chạy thử Workflow</p>
            <p className="text-gray-500 text-[11px] mt-0.5">Chọn người nhận để gửi tin nhắn thử nghiệm</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Account selector */}
          {availableAccounts.length > 1 && (
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Tài khoản gửi</label>
              <div className="space-y-1.5">
                {availableAccounts.map(acc => (
                  <button key={acc.zalo_id} type="button"
                    onClick={() => setSelectedAccount(acc.zalo_id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition-all ${
                      selectedAccount === acc.zalo_id
                        ? 'bg-blue-600/20 border-blue-500/60 ring-1 ring-blue-500/30'
                        : 'bg-gray-800/60 border-gray-700/50 hover:border-gray-600'
                    }`}>
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                      : <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
                          {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                        </div>}
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium truncate ${selectedAccount === acc.zalo_id ? 'text-blue-300' : 'text-gray-200'}`}>
                        {acc.full_name || acc.zalo_id}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Test message content */}
          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">Nội dung tin nhắn thử ($trigger.content)</label>
            <textarea
              value={testContent}
              onChange={e => setTestContent(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-blue-500 outline-none resize-none"
              rows={2}
              placeholder="Nhập tin nhắn thử nghiệm..."
            />
          </div>

          {/* Friend picker */}
          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">
              Chọn người nhận <span className="text-gray-600">(không thể gửi cho chính mình)</span>
            </label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-blue-500 outline-none mb-2"
              placeholder="🔍 Tìm tên hoặc ID..."
            />

            {loadingFriends ? (
              <div className="flex items-center gap-2 py-4 justify-center text-gray-500 text-xs">
                <span className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                Đang tải danh bạ…
              </div>
            ) : filteredFriends.length === 0 ? (
              <div className="py-4 text-center text-gray-600 text-xs">
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
                          : 'bg-gray-800/40 border-gray-700/40 hover:border-gray-600'
                      }`}>
                      {f.avatar
                        ? <img src={f.avatar} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                        : <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0 text-[10px] text-gray-400 font-bold">
                            {(f.displayName || '?').charAt(0).toUpperCase()}
                          </div>}
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${isActive ? 'text-green-300' : 'text-gray-200'}`}>
                          {f.displayName || f.userId}
                        </p>
                        <p className="text-[10px] text-gray-600 truncate">{f.userId}</p>
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
        <div className="px-5 py-4 border-t border-gray-700 flex gap-2 flex-shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
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
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [accounts, setAccounts] = useState<{ zalo_id: string; full_name: string; avatar_url: string; phone?: string }[]>([]);
  const [showPagePicker, setShowPagePicker] = useState(false);
  const [showTestRunModal, setShowTestRunModal] = useState(false);
  const [showAIDialog, setShowAIDialog] = useState(false);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Load connected accounts for page selector
  useEffect(() => {
    ipc.login?.getAccounts().then((res: any) => {
      if (res?.success) setAccounts((res.accounts || []).filter((acc: any) => (acc.channel || 'zalo') === 'zalo'));
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
    ipc.workflow?.get(workflowId).then((res: any) => {
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
      setEdges(wf.edges.map((e: any) => ({
        ...e, type: 'custom',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#4b5563' },
      })));
    });
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
      config: { ...(DEFAULT_CONFIGS[nodeType] || {}) },
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

  const updateNodeLabel = (nodeId: string, label: string) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, label } } : n));
    if (selectedNode?.id === nodeId) setSelectedNode((p: any) => ({ ...p, label }));
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
    edges: edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target })),
  });

  const handleSave = async () => {
    if (workflowMeta.channel !== 'zalo' || hasUnsupportedWorkflowNodes(nodes)) {
      showNotification('Workflow Facebook hiện chưa hỗ trợ lưu/chạy trong editor.', 'warning');
      return;
    }
    setSaving(true);
    try {
      const res = await ipc.workflow?.save(buildWorkflow());
      if (res?.success) showNotification('Đã lưu workflow', 'success');
      else showNotification(res?.error || 'Lỗi lưu workflow', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async (triggerData?: any) => {
    if (workflowMeta.channel !== 'zalo' || hasUnsupportedWorkflowNodes(nodes)) {
      showNotification('Workflow Facebook hiện chưa hỗ trợ chạy.', 'warning');
      return;
    }
    setRunning(true);
    try {
      // Save first, then run
      await ipc.workflow?.save(buildWorkflow());
      const res = await ipc.workflow?.runManual(workflowId, triggerData);
      if (res?.success) showNotification(`Chạy thành công — ${res.log?.status}`, 'success');
      else showNotification(res?.error || 'Lỗi chạy workflow', 'error');
    } finally {
      setRunning(false);
    }
  };

  // ── Check if workflow has send-message nodes → need recipient picker ─────
  const hasSendNodes = nodes.some(n => {
    const t = n.data?.type || '';
    return t === 'zalo.sendMessage' || t === 'zalo.sendImage' || t === 'zalo.sendFile'
      || t === 'zalo.sendVoice' || t === 'zalo.sendTyping';
  });

  const handleRunClick = () => {
    if (hasSendNodes) {
      setShowTestRunModal(true);
    } else {
      handleRun();
    }
  };

  // ── Apply AI-generated nodes & edges (append to canvas) ──────────────
  const handleAIApply = (newNodes: any[], newEdges: any[]) => {
    setNodes(ns => [...ns, ...newNodes.map((n: any) => toRFNode(n))]);
    setEdges(es => [...es, ...newEdges.map((e: any) => ({
      ...e, type: 'custom',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#4b5563' },
    }))]);
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
        if (normalizeWorkflowChannel(data.channel) !== 'zalo' || (data.nodes || []).some((n: any) => typeof n?.type === 'string' && isUnsupportedWorkflowNodeType(n.type))) {
          showNotification('Workflow Facebook hiện chưa hỗ trợ nhập vào editor.', 'warning');
          return;
        }
        // Assign new IDs to avoid conflicts
        const idMap: Record<string, string> = {};
        const importedNodes = (data.nodes || []).map((n: any) => {
          const newId = uuidv4();
          idMap[n.id] = newId;
          return { ...n, id: newId };
        });
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
          channel: 'zalo',
          name: data.name || m.name,
          description: data.description || m.description,
        }));
        setSelectedNode(null);
        showNotification(`Đã nhập workflow "${data.name || 'Imported'}" — nhớ Lưu để áp dụng!`, 'success');
      } catch (err: any) {
        showNotification('Lỗi đọc file JSON: ' + (err.message || 'Invalid JSON'), 'error');
      }
    };
    reader.readAsText(file);
    // reset input so same file can be re-imported
    e.target.value = '';
  };

  // Page selector label
  const pageLabel = workflowMeta.pageIds.length === 0
    ? <span className="text-amber-400">⚠ Tất cả tài khoản Zalo</span>
    : workflowMeta.pageIds.length === 1
      ? <span className="text-blue-300">📱 {accounts.find(a => a.zalo_id === workflowMeta.pageIds[0])?.full_name || workflowMeta.pageIds[0]}</span>
      : <span className="text-blue-300">📱 {workflowMeta.pageIds.length} tài khoản Zalo</span>;

  const workflowUnsupported = workflowMeta.channel !== 'zalo' || hasUnsupportedWorkflowNodes(nodes);

  const togglePage = (zaloId: string) => {
    setWorkflowMeta(m => ({
      ...m,
      pageIds: m.pageIds.includes(zaloId)
        ? m.pageIds.filter(id => id !== zaloId)
        : [...m.pageIds, zaloId],
    }));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Hidden file input for import */}
      <input ref={importFileRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-700 flex-shrink-0 flex-wrap">
        <button onClick={onBack} className="text-gray-400 hover:text-white text-sm flex items-center gap-1">
          ← Quay lại
        </button>
        <div className="w-px h-5 bg-gray-700" />
        <input
          value={workflowMeta.name}
          onChange={e => setWorkflowMeta(m => ({ ...m, name: e.target.value }))}
          className="bg-transparent border-b border-gray-700 focus:border-blue-500 text-white text-sm px-1 py-0.5 outline-none min-w-0 w-48"
          placeholder="Tên workflow..."
        />

        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${
          workflowUnsupported
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
        }`}>
          <span>{workflowMeta.channel === 'zalo' ? 'Kênh: Zalo' : 'Kênh: Facebook (tạm khóa)'}</span>
        </div>

        {/* ── Page selector ─────────────────────────────────────────── */}
        <div className="relative">
          <button
            onClick={() => setShowPagePicker(p => !p)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 hover:border-gray-500 text-xs transition-colors"
          >
            {pageLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-gray-500">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {showPagePicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-xl min-w-[220px] py-2">
              <p className="text-[11px] text-gray-500 px-3 pb-1.5 font-medium uppercase tracking-wider">
                Workflow áp dụng cho tài khoản Zalo
              </p>
              {accounts.length === 0 && (
                <p className="text-gray-600 text-xs px-3 py-2">Chưa có tài khoản nào</p>
              )}
              {accounts.map(acc => (
                <label key={acc.zalo_id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-800 cursor-pointer">
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
                    <div className="text-white text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</div>
                    {acc.phone && <div className="text-gray-400 text-[11px]">{acc.phone}</div>}
                    <div className="text-gray-600 text-[11px]">{acc.zalo_id}</div>
                  </div>
                </label>
              ))}
              <div className="border-t border-gray-800 mt-1 pt-1 px-3">
                <p className="text-[11px] text-gray-600 leading-relaxed">
                  {workflowMeta.pageIds.length === 0
                    ? '⚠ Chưa chọn tài khoản — workflow sẽ chạy cho TẤT CẢ tài khoản Zalo'
                    : `✓ Sẽ chạy cho ${workflowMeta.pageIds.length} tài khoản Zalo đã chọn`}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Export */}
          <button onClick={handleExport} title="Xuất workflow ra JSON"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium rounded-xl transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Xuất
          </button>
          {/* Import */}
          <button onClick={() => importFileRef.current?.click()} title="Nhập workflow từ JSON"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium rounded-xl transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Nhập
          </button>
          {/* AI Builder */}
          <button onClick={() => setShowAIDialog(true)} title="Dùng AI để tạo workflow tự động"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 border border-violet-500/50 text-white/90 text-xs font-medium rounded-xl transition-all shadow-sm shadow-violet-500/20">
            ✨ AI
          </button>

          <div className="w-px h-4 bg-gray-700" />

          {/* enabled toggle */}
          <button
            onClick={() => setWorkflowMeta(m => ({ ...m, enabled: !m.enabled }))}
            className="flex items-center gap-2 cursor-pointer"
            title={workflowMeta.enabled ? 'Đang bật — nhấn để tắt' : 'Đang tắt — nhấn để bật'}
          >
            <div className={`w-8 h-[18px] rounded-full transition-colors relative ${workflowMeta.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
              <span className={`absolute top-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-all ${workflowMeta.enabled ? 'left-[18px]' : 'left-[2px]'}`} />
            </div>
            <span className={`text-xs font-medium transition-colors ${workflowMeta.enabled ? 'text-blue-400' : 'text-gray-500'}`}>
              {workflowMeta.enabled ? 'Bật' : 'Tắt'}
            </span>
          </button>

          <div className="w-px h-4 bg-gray-700" />

          <button onClick={handleRunClick} disabled={running || workflowUnsupported}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs font-medium rounded-xl transition-colors">
            {running ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
            Chạy thử
          </button>
          <button onClick={handleSave} disabled={saving || workflowUnsupported}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium rounded-xl transition-colors">
            {saving ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>}
            Lưu
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden" onClick={() => setShowPagePicker(false)}>
        <NodePalette />

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 relative" onDrop={onDrop} onDragOver={e => e.preventDefault()}
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
              defaultEdgeOptions={{ type: 'custom', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#4b5563' } }}
            >
              <Background color={isLight ? '#c8c2b8' : '#374151'} gap={20} />
              <Controls />
              <MiniMap
                nodeColor={isLight ? '#9ca3af' : '#374151'}
                maskColor={isLight ? 'rgba(200,194,184,0.45)' : 'rgba(17,24,39,0.7)'}
                style={{ background: isLight ? '#ede9e3' : '#111827' }}
              />
            </ReactFlow>
            {/* UX hint */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] text-gray-600 pointer-events-none select-none whitespace-nowrap">
              Click liên kết → nhấn ✕ hoặc <kbd className="bg-gray-800 border border-gray-700 rounded px-1">Del</kbd> để xóa
            </div>
          </div>
          <RunHistoryPanel workflowId={workflowId} />
        </div>

        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            onConfigChange={cfg => updateNodeConfig(selectedNode.id, cfg)}
            onLabelChange={label => updateNodeLabel(selectedNode.id, label)}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>

      {/* Test Run Modal */}
      {showTestRunModal && (
        <TestRunModal
          accounts={accounts}
          workflowPageIds={workflowMeta.pageIds}
          onRun={(triggerData) => handleRun(triggerData)}
          onClose={() => setShowTestRunModal(false)}
        />
      )}

      {/* AI Workflow Builder Dialog */}
      {showAIDialog && (
        <WorkflowAIDialog
          currentNodes={buildWorkflow().nodes}
          currentEdges={buildWorkflow().edges}
          onApply={handleAIApply}
          onClose={() => setShowAIDialog(false)}
        />
      )}
    </div>
  );
}

