import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarIcon, CloseIcon, LightbulbIcon, LightningIcon, LinkIcon, PackageIcon, SearchIcon, UserIcon } from '@/components/common/icons';
import { getNodeLabel } from '../nodes/workflowConfig';
import { NodeIconTile } from '../nodes/nodeVisuals';
import { buildVarCatalog, TemplateVarGroup, TemplateVarInfo, VarNode } from './templateVars';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the expression to insert, e.g. '$trigger.fromName'. */
  onSelect: (varKey: string) => void;
  /** Trigger node types of the workflow (decide which $trigger.* fields exist). */
  triggerTypes: string[];
  /** Nodes that run before the current node (their outputs / variables can be used). */
  upstreamNodes: VarNode[];
  /** Field suggestions (field.templateVars), shown first when available. */
  suggestedKeys?: string[];
  /** Label of the field that receives the variable (empty = copy to clipboard). */
  fieldLabel?: string;
}

const GROUP_ICON: Record<TemplateVarGroup, React.ReactNode> = {
  suggested: <LightbulbIcon className="w-3.5 h-3.5" />,
  trigger: <LightningIcon className="w-3.5 h-3.5" />,
  node: <LinkIcon className="w-3.5 h-3.5" />,
  variable: <PackageIcon className="w-3.5 h-3.5" />,
  date: <CalendarIcon className="w-3.5 h-3.5" />,
  account: <UserIcon className="w-3.5 h-3.5" />,
};

function matches(v: TemplateVarInfo, q: string): boolean {
  return v.key.toLowerCase().includes(q)
    || v.label.toLowerCase().includes(q)
    || v.description.toLowerCase().includes(q)
    || (v.nodeLabel || '').toLowerCase().includes(q);
}

export default function TemplateVarPopup({ open, onClose, onSelect, triggerTypes, upstreamNodes, suggestedKeys, fieldLabel }: Props) {
  const [search, setSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<TemplateVarGroup | 'all'>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  const catalog = useMemo(
    () => buildVarCatalog({ triggerTypes, upstreamNodes, suggestedKeys }),
    [triggerTypes, upstreamNodes, suggestedKeys],
  );

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setActiveGroup('all');
    setTimeout(() => searchRef.current?.focus(), 30);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const q = search.trim().toLowerCase();
  const visibleGroups = useMemo(() => catalog.groups
    .filter(group => activeGroup === 'all' || group.id === activeGroup)
    .map(group => ({ ...group, vars: q ? group.vars.filter(v => matches(v, q)) : group.vars }))
    .filter(group => group.vars.length > 0), [catalog, activeGroup, q]);
  const visibleCount = visibleGroups.reduce((sum, group) => sum + group.vars.length, 0);
  const totalCount = catalog.groups.reduce((sum, group) => sum + group.vars.length, 0);

  if (!open) return null;

  const triggerNames = triggerTypes.map(type => getNodeLabel(type)).join(', ');
  const noTrigger = triggerTypes.length === 0;
  const scheduleOnly = triggerTypes.length > 0 && triggerTypes.every(type => type === 'trigger.schedule');

  const pick = (v: TemplateVarInfo) => { onSelect(v.key); onClose(); };

  const renderVar = (v: TemplateVarInfo) => (
    <button key={`${v.group}:${v.key}`} type="button" onClick={() => pick(v)} className="wf-var-row group">
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold wf-text truncate">{v.label}</span>
          {v.isPattern && <span className="wf-badge !h-4 flex-shrink-0" data-tone="yellow">SỬA SAU KHI CHÈN</span>}
        </span>
        {v.description && <span className="block mt-0.5 text-[11.5px] leading-[1.05rem] wf-muted">{v.description}</span>}
        {v.example && <span className="block mt-0.5 text-[11px] wf-faint">VD: <span className="font-mono">{v.example}</span></span>}
      </span>
      <code className="wf-var flex-shrink-0 max-w-[45%] truncate !text-[11px] !px-1.5 !py-0.5" title={`{{ ${v.key} }}`}>{`{{ ${v.key} }}`}</code>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm pointer-events-none" />
      <div className="relative wf-panel border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 'min(48rem, 96vw)', height: 'min(40rem, 88vh)' }}>
        {/* Header */}
        <div className="wf-panel__header flex items-center gap-3 px-5 py-3.5">
          <span className="inline-flex w-10 h-10 items-center justify-center rounded-xl flex-shrink-0 font-mono font-bold"
            style={{ background: 'var(--wf-var-bg)', color: 'var(--wf-var-fg)' }}>{'{ }'}</span>
          <div className="flex-1 min-w-0">
            <p className="wf-panel__title truncate">Chèn biến động</p>
            <p className="wf-panel__desc truncate">
              {noTrigger ? 'Workflow chưa có node kích hoạt' : `Kích hoạt: ${triggerNames}`}
              {fieldLabel ? ` · chèn vào "${fieldLabel}"` : ' · bấm để copy'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="wf-icon-btn" title="Đóng (Esc)"><CloseIcon className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Groups */}
          <div className="w-48 flex-shrink-0 border-r border-[color:var(--wf-panel-border)] overflow-y-auto p-2 space-y-0.5">
            {[{ id: 'all' as const, label: 'Tất cả', count: totalCount }, ...catalog.groups.map(g => ({ id: g.id, label: g.label, count: g.vars.length }))].map(g => (
              <button key={g.id} type="button" onClick={() => setActiveGroup(g.id)}
                className="wf-choice !gap-2 !px-2.5 !py-1.5" data-active={String(activeGroup === g.id)}>
                <span className="wf-muted flex-shrink-0">{g.id === 'all' ? <SearchIcon className="w-3.5 h-3.5" /> : GROUP_ICON[g.id]}</span>
                <span className="wf-choice__title flex-1 truncate !text-xs">{g.label}</span>
                <span className="text-[10.5px] font-semibold wf-faint tabular-nums">{g.count}</span>
              </button>
            ))}
          </div>

          {/* Variables */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-4 pt-3 pb-2.5 border-b border-[color:var(--wf-panel-border)]">
              <div className="relative">
                <SearchIcon className="w-4 h-4 wf-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Tìm theo tên, cú pháp, mô tả…" className="wf-input !pl-9" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
              {(noTrigger || scheduleOnly) && activeGroup !== 'node' && (
                <div className="wf-callout" data-tone="tip">
                  <LightbulbIcon className="w-4 h-4" />
                  <span>{noTrigger
                    ? 'Chưa có node kích hoạt nên chưa có biến $trigger. Thêm node "Kích hoạt" để dùng dữ liệu tin nhắn / sự kiện.'
                    : 'Chạy theo lịch không có dữ liệu kích hoạt — dùng kết quả node trước, biến tự đặt hoặc ngày giờ.'}</span>
                </div>
              )}
              {visibleGroups.length === 0 ? (
                <div className="wf-empty">
                  <p className="text-sm font-semibold wf-text">Không tìm thấy biến</p>
                  <p className="wf-help !mt-0">Thử từ khoá khác hoặc chọn nhóm "Tất cả".</p>
                </div>
              ) : visibleGroups.map(group => (
                <section key={group.id}>
                  <p className="wf-section-title mb-1.5 px-1">{group.label}</p>
                  {group.id === 'node' ? (
                    // Outputs grouped per upstream node
                    Array.from(new Map(group.vars.map(v => [v.nodeId, v])).values()).map(first => (
                      <div key={first.nodeId} className="mb-2">
                        <div className="flex items-center gap-2 px-1 pb-1">
                          <NodeIconTile type={first.nodeType || ''} size="sm" showChannel={false} />
                          <span className="text-xs font-semibold wf-text-2 truncate">{first.nodeLabel}</span>
                        </div>
                        <div className="space-y-0.5">{group.vars.filter(v => v.nodeId === first.nodeId).map(renderVar)}</div>
                      </div>
                    ))
                  ) : (
                    <div className="space-y-0.5">{group.vars.map(renderVar)}</div>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="wf-panel__footer flex items-center gap-2 px-5 py-3">
          <span className="text-xs wf-muted">
            {visibleCount} biến{q ? ` khớp "${search.trim()}"` : ''} · chỉ hiện biến dùng được ở bước này
          </span>
          <button type="button" onClick={onClose} className="wf-btn ml-auto">Đóng</button>
        </div>
      </div>
    </div>
  );
}
