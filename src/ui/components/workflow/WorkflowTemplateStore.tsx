import React, { useEffect, useMemo, useState } from 'react';
import ReactFlow, { Background, Controls, MiniMap, MarkerType } from 'reactflow';
import 'reactflow/dist/style.css';
import { v4 as uuidv4 } from 'uuid';
import {
  WORKFLOW_TEMPLATES,
  TEMPLATE_CATEGORIES,
  instantiateTemplate,
  WorkflowTemplate,
  TemplateCategory,
} from './templates/workflowTemplates';
import { INTEGRATION_TEMPLATES } from './templates/integrationTemplates';
import { nodeTypeGroup, getNodeLabel, GROUP_COLORS } from './workflowConfig';
import { TriggerNode, ActionNode, LogicNode, DataNode, OutputNode, IntegrationNode } from './nodes/WorkflowNodes';
import ipc from '../../lib/ipc';
import { useAppStore } from '@/store/appStore';

const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  logic: LogicNode,
  data: DataNode,
  output: OutputNode,
  integration: IntegrationNode,
};

// Merge templates: giữ nguyên template cũ + thêm template tích hợp mới
const ALL_TEMPLATES = [...WORKFLOW_TEMPLATES, ...INTEGRATION_TEMPLATES];

interface PageAccount {
  zalo_id: string;
  full_name: string;
  avatar_url: string;
  phone?: string;
}

interface Props {
  onBack: () => void;
  onEdit: (id: string) => void;
}

// ── Difficulty badge ───────────────────────────────────────────────────────────
function DifficultyBadge({ level }: { level: 'easy' | 'medium' | 'advanced' }) {
  const cfg = {
    easy:     { label: 'Dễ',       color: 'bg-green-500/20 text-green-400 border-green-500/30' },
    medium:   { label: 'Trung bình', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
    advanced: { label: 'Nâng cao',  color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  }[level];
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ── Template Card ──────────────────────────────────────────────────────────────
function TemplateCard({
  tpl,
  onPreview,
  onInstall,
}: {
  tpl: WorkflowTemplate;
  onPreview: () => void;
  onInstall: () => void;
}) {
  const cat = TEMPLATE_CATEGORIES.find(c => c.key === tpl.category);

  return (
    <div className="bg-gray-900 border border-gray-700/80 rounded-2xl p-5 hover:border-gray-600 transition-all group relative flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-11 h-11 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center text-xl flex-shrink-0">
          {tpl.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-semibold text-sm leading-tight mb-1 truncate">{tpl.name}</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {cat && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full text-white/80 font-medium ${cat.color}`}>
                {cat.icon} {cat.label}
              </span>
            )}
            <DifficultyBadge level={tpl.difficulty} />
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-gray-400 text-xs leading-relaxed mb-3 flex-1 line-clamp-3">{tpl.description}</p>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[11px] text-gray-600 mb-4">
        <span className="flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          {tpl.nodes.length} bước
        </span>
        <span className="flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          {tpl.edges.length} kết nối
        </span>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {tpl.tags.slice(0, 4).map(tag => (
          <span key={tag} className="text-[10px] px-2 py-0.5 rounded-md bg-gray-800 border border-gray-700/60 text-gray-500">
            {tag}
          </span>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={onPreview}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs font-medium rounded-xl transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
          Xem trước
        </button>
        <button
          onClick={onInstall}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-xl transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Cài đặt
        </button>
      </div>
    </div>
  );
}

// ── Preview Modal ──────────────────────────────────────────────────────────────
function PreviewModal({
  tpl,
  onClose,
  onInstall,
}: {
  tpl: WorkflowTemplate;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { theme } = useAppStore();
  const isLight = theme === 'light';

  const rfNodes = useMemo(() => tpl.nodes.map(n => ({
    id: n.id,
    type: nodeTypeGroup(n.type),
    position: n.position,
    data: { ...n, label: n.label || getNodeLabel(n.type), config: n.config },
    selectable: false,
    draggable: false,
  })), [tpl]);

  const rfEdges = useMemo(() => tpl.edges.map(e => ({
    ...e,
    type: 'default',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: '#4b5563' },
  })), [tpl]);

  const cat = TEMPLATE_CATEGORIES.find(c => c.key === tpl.category);

  // count node types
  const nodeGroups = useMemo(() => {
    const counts: Record<string, number> = {};
    tpl.nodes.forEach(n => {
      const group = nodeTypeGroup(n.type);
      counts[group] = (counts[group] || 0) + 1;
    });
    return counts;
  }, [tpl]);

  const groupLabels: Record<string, string> = {
    trigger: 'Kích hoạt',
    action: 'Thao tác',
    logic: 'Logic',
    data: 'Dữ liệu',
    integration: 'Tích hợp',
    output: 'Đầu ra',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[900px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-4 flex-shrink-0">
          <div className="w-12 h-12 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center text-2xl flex-shrink-0">
            {tpl.icon}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-bold text-base">{tpl.name}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {cat && (
                <span className={`text-[11px] px-2.5 py-0.5 rounded-full text-white/80 font-medium ${cat.color}`}>
                  {cat.icon} {cat.label}
                </span>
              )}
              <DifficultyBadge level={tpl.difficulty} />
              <span className="text-[11px] text-gray-600">{tpl.nodes.length} bước · {tpl.edges.length} kết nối</span>
            </div>
          </div>
          <button
            onClick={onInstall}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Cài đặt workflow này
          </button>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Flow preview */}
          <div className="flex-1 relative bg-gray-950">
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={true}
              zoomOnScroll={true}
            >
              <Background color={isLight ? '#c8c2b8' : '#1f2937'} gap={20} />
              <Controls showInteractive={false} />
              <MiniMap
                  nodeColor={isLight ? '#9ca3af' : '#374151'}
                  maskColor={isLight ? 'rgba(200,194,184,0.45)' : 'rgba(17,24,39,0.7)'}
                  style={{ background: isLight ? '#ede9e3' : '#111827' }}
              />
            </ReactFlow>
          </div>

          {/* Info sidebar */}
          <div className="w-[280px] border-l border-gray-700 overflow-y-auto flex-shrink-0 p-5 space-y-5">
            {/* Description */}
            <div>
              <h4 className="text-gray-400 text-[11px] font-semibold uppercase tracking-wider mb-2">Mô tả</h4>
              <p className="text-gray-300 text-xs leading-relaxed">{tpl.description}</p>
            </div>

            {/* Node breakdown */}
            <div>
              <h4 className="text-gray-400 text-[11px] font-semibold uppercase tracking-wider mb-2">Thành phần</h4>
              <div className="space-y-1.5">
                {Object.entries(nodeGroups).map(([group, count]) => (
                  <div key={group} className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: GROUP_COLORS[group] || '#6b7280' }} />
                    <span className="text-gray-300 text-xs flex-1">{groupLabels[group] || group}</span>
                    <span className="text-gray-500 text-xs">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Steps */}
            <div>
              <h4 className="text-gray-400 text-[11px] font-semibold uppercase tracking-wider mb-2">Các bước</h4>
              <div className="space-y-2">
                {tpl.nodes.map((n, i) => {
                  const group = nodeTypeGroup(n.type);
                  return (
                    <div key={n.id} className="flex items-start gap-2">
                      <div className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-0.5"
                        style={{ backgroundColor: GROUP_COLORS[group] || '#6b7280' }}>
                        {i + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="text-white text-xs font-medium truncate">{n.label}</p>
                        <p className="text-gray-600 text-[10px] truncate">{n.type}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tags */}
            <div>
              <h4 className="text-gray-400 text-[11px] font-semibold uppercase tracking-wider mb-2">Tags</h4>
              <div className="flex flex-wrap gap-1.5">
                {tpl.tags.map(tag => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-md bg-gray-800 border border-gray-700/60 text-gray-400">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Install Modal (page picker) ────────────────────────────────────────────────
function InstallModal({
  tpl,
  accounts,
  onClose,
  onDone,
}: {
  tpl: WorkflowTemplate;
  accounts: PageAccount[];
  onClose: () => void;
  onDone: (workflowId: string) => void;
}) {
  const { showNotification } = useAppStore();
  const [selectedPages, setSelectedPages] = useState<string[]>([]);
  const [wfName, setWfName] = useState(tpl.name);
  const [installing, setInstalling] = useState(false);
  const [openInEditor, setOpenInEditor] = useState(true);

  const togglePage = (id: string) => {
    setSelectedPages(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  };

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const { nodes, edges } = instantiateTemplate(tpl);
      const workflowId = uuidv4();
      const res = await ipc.workflow?.save({
        channel: 'zalo',
        id: workflowId,
        name: wfName,
        description: tpl.description,
        enabled: false,
        pageIds: selectedPages,
        nodes,
        edges,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      if (res?.success) {
        showNotification(`Đã cài đặt "${wfName}" thành công!`, 'success');
        onDone(openInEditor ? workflowId : '');
      } else {
        showNotification(res?.error || 'Lỗi cài đặt workflow', 'error');
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[420px] max-w-[95vw] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center text-lg flex-shrink-0">
              {tpl.icon}
            </div>
            <div className="min-w-0">
              <p className="text-white font-semibold text-sm truncate">Cài đặt workflow</p>
              <p className="text-gray-500 text-[11px] truncate">{tpl.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="text-gray-400 text-[11px] font-medium uppercase tracking-wider block mb-1.5">
              Tên workflow
            </label>
            <input
              value={wfName}
              onChange={e => setWfName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm outline-none focus:border-blue-500 transition-colors"
              placeholder="Nhập tên..."
            />
          </div>

          {/* Page selection */}
          <div>
            <label className="text-gray-400 text-[11px] font-medium uppercase tracking-wider block mb-1.5">
              Áp dụng cho tài khoản Zalo
            </label>
            {accounts.length === 0 ? (
              <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 text-center">
                <p className="text-gray-500 text-xs">Chưa có tài khoản Zalo nào. Workflow sẽ chạy cho tất cả tài khoản Zalo.</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                {accounts.map(acc => {
                  const selected = selectedPages.includes(acc.zalo_id);
                  return (
                    <label key={acc.zalo_id}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border cursor-pointer transition-colors ${
                        selected ? 'bg-blue-500/10 border-blue-500/40' : 'bg-gray-800/50 border-gray-700/60 hover:border-gray-600'
                      }`}>
                      <input type="checkbox" checked={selected} onChange={() => togglePage(acc.zalo_id)} className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0" />
                      {acc.avatar_url
                        ? <img src={acc.avatar_url} className="w-6 h-6 rounded-full object-cover flex-shrink-0" alt="" />
                        : <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-[10px] text-white font-bold">
                            {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                          </div>
                      }
                      <div className="min-w-0 flex-1">
                        <p className="text-white text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                        {acc.phone && <p className="text-gray-500 text-[11px]">{acc.phone}</p>}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-gray-600 text-[10px] mt-1.5">
              {selectedPages.length === 0
                ? '⚠ Chưa chọn — workflow sẽ chạy cho TẤT CẢ tài khoản Zalo'
                : `✓ Sẽ áp dụng cho ${selectedPages.length} tài khoản Zalo`}
            </p>
          </div>

          {/* Options */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={openInEditor} onChange={e => setOpenInEditor(e.target.checked)} className="accent-blue-500 w-3.5 h-3.5" />
            <span className="text-gray-300 text-xs">Mở trong trình chỉnh sửa sau khi cài đặt</span>
          </label>

          {/* Info */}
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
            <p className="text-blue-300 text-xs leading-relaxed">
              💡 Workflow sẽ được tạo ở trạng thái <strong>TẮT</strong>. Hãy kiểm tra cấu hình và bật khi sẵn sàng.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
            Hủy
          </button>
          <button onClick={handleInstall} disabled={installing || !wfName.trim()}
            className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
            {installing && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Cài đặt
          </button>
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Main TemplateStore Component ──────────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function WorkflowTemplateStore({ onBack, onEdit }: Props) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');
  const [previewTpl, setPreviewTpl] = useState<WorkflowTemplate | null>(null);
  const [installTpl, setInstallTpl] = useState<WorkflowTemplate | null>(null);
  const [accounts, setAccounts] = useState<PageAccount[]>([]);

  useEffect(() => {
    ipc.login?.getAccounts().then((res: any) => {
      if (res?.success) setAccounts((res.accounts || [])
        .filter((a: any) => (a.channel || 'zalo') === 'zalo')
        .map((a: any) => ({
        zalo_id: a.zalo_id,
        full_name: a.full_name || '',
        avatar_url: a.avatar_url || '',
        phone: a.phone || '',
      })));
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    let list = ALL_TEMPLATES;

    if (activeCategory !== 'all') {
      list = list.filter(t => t.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.toLowerCase().includes(q))
      );
    }

    return list;
  }, [search, activeCategory]);

  const handleInstallDone = (workflowId: string) => {
    setInstallTpl(null);
    setPreviewTpl(null);
    if (workflowId) {
      onEdit(workflowId);
    } else {
      onBack();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-gray-400 hover:text-white text-sm flex items-center gap-1 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Quay lại
            </button>
            <div className="w-px h-5 bg-gray-700" />
            <div>
              <h1 className="text-white text-xl font-bold flex items-center gap-2">
                <span>📦</span> Kho Workflow mẫu
              </h1>
              <p className="text-gray-500 text-sm mt-0.5">Chọn workflow có sẵn, xem trước rồi cài đặt chỉ với 1 click</p>
            </div>
          </div>
          <div className="text-gray-600 text-xs">
            {ALL_TEMPLATES.length} mẫu có sẵn
          </div>
        </div>

        {/* Search + Category filter */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px] max-w-[400px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Tìm kiếm mẫu workflow..."
              className="w-full pl-9 pr-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm placeholder-gray-600 outline-none focus:border-blue-500 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>

          {/* Category pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                activeCategory === 'all'
                  ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300'
              }`}
            >
              Tất cả
            </button>
            {TEMPLATE_CATEGORIES.map(cat => (
              <button
                key={cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  activeCategory === cat.key
                    ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300'
                }`}
              >
                {cat.icon} {cat.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center mb-4 text-3xl">
              🔍
            </div>
            <p className="text-gray-300 font-semibold mb-1">Không tìm thấy mẫu nào</p>
            <p className="text-gray-600 text-sm mb-4 max-w-xs">
              Thử tìm kiếm với từ khoá khác hoặc chọn danh mục khác.
            </p>
            <button onClick={() => { setSearch(''); setActiveCategory('all'); }}
              className="text-blue-400 text-xs hover:text-blue-300 transition-colors">
              Xóa bộ lọc
            </button>
          </div>
        ) : (
          <>
            {/* Category summary when showing all */}
            {activeCategory === 'all' && !search && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
                {TEMPLATE_CATEGORIES.map(cat => {
                  const count = ALL_TEMPLATES.filter(t => t.category === cat.key).length;
                  return (
                    <button
                      key={cat.key}
                      onClick={() => setActiveCategory(cat.key)}
                      className="bg-gray-900 border border-gray-700/80 rounded-xl p-3 hover:border-gray-600 transition-colors text-left group"
                    >
                      <div className="text-2xl mb-1">{cat.icon}</div>
                      <p className="text-white text-xs font-medium group-hover:text-blue-300 transition-colors">{cat.label}</p>
                      <p className="text-gray-600 text-[10px]">{count} mẫu</p>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Template grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map(tpl => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  onPreview={() => setPreviewTpl(tpl)}
                  onInstall={() => setInstallTpl(tpl)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Preview Modal */}
      {previewTpl && (
        <PreviewModal
          tpl={previewTpl}
          onClose={() => setPreviewTpl(null)}
          onInstall={() => {
            setInstallTpl(previewTpl);
          }}
        />
      )}

      {/* Install Modal */}
      {installTpl && (
        <InstallModal
          tpl={installTpl}
          accounts={accounts}
          onClose={() => setInstallTpl(null)}
          onDone={handleInstallDone}
        />
      )}
    </div>
  );
}


