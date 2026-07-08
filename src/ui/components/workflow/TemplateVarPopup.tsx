import React, { useState, useMemo } from 'react';
import { useAppStore } from '@/store/appStore';
import { CalendarIcon, ClipboardListIcon, LinkIcon, PackageIcon, SearchIcon, SendIcon, UserIcon } from '@/components/common/icons';
import {
  TemplateVarInfo,
  TemplateVarGroup,
  TEMPLATE_VAR_GROUP_LABELS,
  getTemplateVarsByGroup,
  getNodeOutputVars,
} from './templateVars';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Loại node hiện tại để lọc variable phù hợp */
  nodeType?: string;
  /** Danh sách tất cả node trong workflow (cho $node.*) */
  allNodes?: { id: string; label: string; type: string }[];
  /** Node ID hiện tại - để loại trừ khi chọn output */
  currentId?: string;
  /** Callback khi người dùng chọn 1 variable */
  onSelect: (varKey: string) => void;
  /** Field key đang được focus - để gợi ý variable liên quan */
  currentField?: string;
}

export default function TemplateVarPopup({
  open,
  onClose,
  nodeType,
  allNodes,
  currentId,
  onSelect,
  currentField,
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<TemplateVarGroup | 'all'>('all');
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';

  // Build grouped vars
  const groupedVars = useMemo(() => {
    const trigger = getTemplateVarsByGroup(nodeType);
    // Add node output vars
    if (allNodes) {
      const nodeVars = getNodeOutputVars(allNodes, currentId);
      if (nodeVars.length > 0) {
        trigger.set('node', nodeVars);
      }
    }
    return trigger;
  }, [nodeType, allNodes, currentId]);

  // Flatten + filter
  const filtered = useMemo(() => {
    const all = [] as { var: TemplateVarInfo; group: TemplateVarGroup }[];
    for (const [group, vars] of groupedVars.entries()) {
      if (selectedGroup !== 'all' && group !== selectedGroup) continue;
      for (const v of vars) {
        all.push({ var: v, group });
      }
    }
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      ({ var: v }) =>
        v.key.toLowerCase().includes(q) ||
        v.label.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q),
    );
  }, [groupedVars, search, selectedGroup]);

  const groups = ['all' as const, ...groupedVars.keys()] as (TemplateVarGroup | 'all')[];
  const groupLabels: Record<string, string> = { all: 'Tất cả', ...TEMPLATE_VAR_GROUP_LABELS };
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const [g, vars] of groupedVars.entries()) {
      counts[g] = vars.length;
      counts.all += vars.length;
    }
    return counts;
  }, [groupedVars]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative rounded-2xl shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden border ${
        isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
          <div>
            <p className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-white'}`}>
              🔤 Chèn biến động
            </p>
            <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-400'}`}>
              Click vào variable để chèn vào ô đang nhập
            </p>
          </div>
          <button onClick={onClose} className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
            isLight ? 'hover:bg-gray-100 text-gray-400' : 'hover:bg-gray-700 text-gray-400'
          }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - group list */}
        <div className={`w-40 flex-shrink-0 overflow-y-auto border-r p-2 space-y-0.5 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700/50 bg-gray-800/30'}`}>
          {groups.map(g => (
            <button
              key={g}
              onClick={() => setSelectedGroup(g)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors text-sm ${selectedGroup === g ? isLight ? 'bg-blue-100 text-blue-700 font-medium' : 'bg-blue-500/20 text-blue-400 font-medium' : isLight ? 'text-gray-400 hover:bg-gray-200' : 'text-gray-400 hover:bg-gray-700'}`}>
              <span className="text-xs">{groupLabels[g] || g}</span>
              <span className={`ml-1.5 text-[10px] ${selectedGroup === g ? isLight ? 'text-blue-500' : 'text-blue-500' : isLight ? 'text-gray-400' : 'text-gray-400'}`}>
                {groupCounts[g] || 0}
              </span>
            </button>
          ))}
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className={`px-4 py-3 border-b flex-shrink-0 ${isLight ? 'border-gray-200' : 'border-gray-700/50'}`}>
            <div className="relative">
              <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-gray-400' : 'text-gray-400'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="text" placeholder="Tìm theo tên, cú pháp, mô tả..."
                value={search} onChange={e => setSearch(e.target.value)}
                autoFocus
                className={`w-full pl-10 pr-4 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 ${isLight ? 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-blue-500/30' : 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/30'}`}
              />
            </div>
          </div>

          {/* Variable list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">          {filtered.length === 0 ? (
            <div className={`text-center py-8 ${isLight ? 'text-gray-400' : 'text-gray-400'}`}>
              <span className="text-3xl block mb-2"><SearchIcon className="w-4 h-4" /></span>
              <p className="text-sm">Không tìm thấy variable</p>
              <p className={`text-xs mt-1 ${isLight ? 'text-gray-400' : 'text-gray-400'}`}>
                Thử tìm kiếm với từ khoá khác
              </p>
            </div>
          ) : (
            filtered.map(({ var: v, group }) => (
              <button
                key={v.key}
                type="button"
                onClick={() => { onSelect(v.key); onClose(); }}
                className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-start gap-3 ${
                  isLight
                    ? 'bg-white border-gray-200 hover:border-blue-300 hover:bg-blue-50/30'
                    : 'bg-gray-800/40 border-gray-700/40 hover:border-blue-500/30 hover:bg-blue-500/5'
                }`}
              >
                {/* Icon based on group */}
                <span className="flex-shrink-0 text-base mt-0.5">
                  {group === 'trigger' ? <SendIcon className="w-4 h-4" /> : group === 'date' ? <CalendarIcon className="w-4 h-4" /> : group === 'variable' ? <PackageIcon className="w-4 h-4" /> : group === 'node' ? <LinkIcon className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className={`text-xs font-mono font-semibold ${
                      isLight ? 'text-blue-700 bg-blue-50' : 'text-blue-400 bg-blue-500/10'
                    } px-1.5 py-0.5 rounded`}>
                      {'{{ '}{v.key}{' }}'}
                    </code>
                    <span className={`text-[11px] font-medium truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                      {v.label}
                    </span>
                  </div>
                  <p className={`text-[10px] mt-1 leading-relaxed ${isLight ? 'text-gray-400' : 'text-gray-400'}`}>
                    {v.description}
                  </p>
                  {v.example && (
                    <span className={`inline-block text-[9px] mt-0.5 font-mono ${
                      isLight ? 'text-green-600 bg-green-50' : 'text-green-400 bg-green-500/10'
                    } px-1 py-0.5 rounded`}>
                      VD: {v.example}
                    </span>
                  )}
                </div>

                {/* Insert button */}
                <span className={`flex-shrink-0 text-[10px] px-2 py-1 rounded-lg font-medium ${
                  isLight
                    ? 'bg-gray-100 text-gray-400 group-hover:bg-blue-100 group-hover:text-blue-600'
                    : 'bg-gray-700 text-gray-400 group-hover:bg-blue-500/20 group-hover:text-blue-400'
                }`}>
                  Chèn
                </span>
              </button>
            ))
          )}
        </div>

          </div>
        </div>

        {/* Footer */}
        <div className={`px-5 py-3 border-t flex items-center justify-between ${
          isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/50'
        }`}>
          <span className={`text-[11px] ${isLight ? 'text-gray-400' : 'text-gray-400'}`}>
            {filtered.length} variable{filtered.length !== 1 ? 's' : ''}
            {search.trim() ? ` (tìm "${search}")` : ''}
          </span>
          <button onClick={onClose} className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
