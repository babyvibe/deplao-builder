import React, { useState } from 'react';
import { NODE_GROUPS } from './workflowConfig';

const GROUP_ACCENT: Record<string, string> = {
  'Kích hoạt':             'bg-violet-500',
  'Thao tác':              'bg-blue-500',
  'Điều kiện & Logic':     'bg-amber-500',
  'Xử lý dữ liệu':        'bg-teal-500',
  'Google Sheets':         'bg-green-600',
  'Trí tuệ nhân tạo (AI)':'bg-violet-600',
  'Gửi thông báo':        'bg-orange-500',
  'Đầu ra & API':          'bg-rose-500',
};
const GROUP_HOVER: Record<string, string> = {
  'Kích hoạt':             'hover:border-violet-500/50 hover:bg-violet-500/5',
  'Thao tác':              'hover:border-blue-500/50 hover:bg-blue-500/5',
  'Điều kiện & Logic':     'hover:border-amber-500/50 hover:bg-amber-500/5',
  'Xử lý dữ liệu':        'hover:border-teal-500/50 hover:bg-teal-500/5',
  'Google Sheets':         'hover:border-green-500/50 hover:bg-green-500/5',
  'Trí tuệ nhân tạo (AI)':'hover:border-violet-500/50 hover:bg-violet-500/5',
  'Gửi thông báo':        'hover:border-orange-500/50 hover:bg-orange-500/5',
  'Đầu ra & API':          'hover:border-rose-500/50 hover:bg-rose-500/5',
};

export default function NodePalette() {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const onDragStart = (e: React.DragEvent, nodeType: string) => {
    e.dataTransfer.setData('nodeType', nodeType);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const filtered = NODE_GROUPS.map(g => ({
    ...g,
    items: g.items.filter(n =>
      !search ||
      n.label.toLowerCase().includes(search.toLowerCase()) ||
      n.type.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter(g => g.items.length > 0);

  return (
    <div className="w-56 bg-gray-900 border-r border-gray-700/60 flex flex-col h-full overflow-hidden flex-shrink-0">
      {/* Header + search */}
      <div className="px-3 py-3 border-b border-gray-700/60 flex-shrink-0">
        <p className="text-xs font-semibold text-gray-400 mb-2">Kéo node vào canvas</p>
        <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 focus-within:border-blue-500 transition-colors">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm node..."
            className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-500 hover:text-white transition-colors">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Node groups */}
      <div className="flex-1 overflow-y-auto py-2">
        {filtered.map(group => (
          <div key={group.label} className="mb-1">
            {/* Group header */}
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800 transition-colors text-left"
              onClick={() => setCollapsed(c => ({ ...c, [group.label]: !c[group.label] }))}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${GROUP_ACCENT[group.label] || 'bg-gray-500'}`} />
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide flex-1">
                {group.label}
              </span>
              <svg
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={`text-gray-600 transition-transform ${collapsed[group.label] ? '-rotate-90' : ''}`}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {/* Node items */}
            {!collapsed[group.label] && (
              <div className="px-2 pb-1">
                {group.items.map(item => (
                  <div
                    key={item.type}
                    draggable
                    onDragStart={e => onDragStart(e, item.type)}
                    className={`cursor-grab active:cursor-grabbing mb-1 rounded-xl px-2.5 py-2 bg-gray-800/60 border border-gray-700/60 transition-all select-none ${GROUP_HOVER[group.label] || 'hover:border-gray-500 hover:bg-gray-700/60'}`}
                  >
                    <p className="text-xs text-white font-medium leading-tight">{item.label}</p>
                    <p className="text-[10px] text-gray-500 leading-tight mt-0.5">{item.desc}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-6">Không tìm thấy node</p>
        )}
      </div>
    </div>
  );
}
