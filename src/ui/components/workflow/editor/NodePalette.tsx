import React, { useState } from 'react';
import { NODE_GROUPS } from '../nodes/workflowConfig';
import { Channel } from '../../../../configs/channels/channelConfig';
import { FAMILY_META, NodeIconTile, PALETTE_GROUP_FAMILY, accentStyle } from '../nodes/nodeVisuals';
import { pluginPaletteGroups, useLoadPluginNodes, usePluginNodeStore } from '../nodes/pluginNodes';

interface Props {
  channel?: Channel;
}

export default function NodePalette({ channel }: Props) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Node/trigger do plugin đang bật đóng góp (nhóm "Ứng dụng · …" sau các nhóm có sẵn).
  useLoadPluginNodes();
  const pluginDefs = usePluginNodeStore(s => s.defs);

  const onDragStart = (e: React.DragEvent, nodeType: string) => {
    e.dataTransfer.setData('nodeType', nodeType);
    e.dataTransfer.effectAllowed = 'copy';
  };

  /** Filter node items by channel: show items without channel restriction, or matching the current workflow channel */
  const channelFilter = (item: { channel?: string }) => {
    if (!channel) return true;
    if (!item.channel || item.channel === 'both') return true;
    if (item.channel === channel) return true;
    return false;
  };

  const filtered = [...NODE_GROUPS, ...pluginPaletteGroups(pluginDefs)].map(g => ({
    ...g,
    items: g.items.filter(n =>
      channelFilter(n) &&
      (!search ||
        n.label.toLowerCase().includes(search.toLowerCase()) ||
        n.type.toLowerCase().includes(search.toLowerCase()))
    ),
  })).filter(g => g.items.length > 0);

  return (
    <div className="w-60 wf-palette border-r flex flex-col h-full overflow-hidden flex-shrink-0">
      {/* Header + search */}
      <div className="px-3 pt-3 pb-2.5 flex-shrink-0">
        <p className="text-[11px] font-semibold wf-muted mb-2">Kéo node vào sơ đồ</p>
        <div className="relative">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className="wf-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm node..."
            className="wf-input wf-input--sm !pl-8 !pr-7"
          />
          {search && (
            <button onClick={() => setSearch('')} className="wf-icon-btn absolute right-1 top-1/2 -translate-y-1/2 !w-6 !h-6">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Node groups */}
      <div className="flex-1 overflow-y-auto pb-3">
        {filtered.map(group => {
          const family = PALETTE_GROUP_FAMILY[group.label];
          const accent = family ? FAMILY_META[family].accent : '#6b7280';
          return (
            <div key={group.label} className="mb-1">
              {/* Group header */}
              <button
                className="wf-palette-group"
                style={accentStyle(accent)}
                onClick={() => setCollapsed(c => ({ ...c, [group.label]: !c[group.label] }))}
              >
                <span className="wf-palette-group__dot" />
                <span className="truncate">{group.label}</span>
                <span className="wf-palette-group__count">{group.items.length}</span>
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  className={`flex-shrink-0 transition-transform ${collapsed[group.label] ? '-rotate-90' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {/* Node items */}
              {!collapsed[group.label] && (
                <div className="px-2">
                  {group.items.map(item => (
                    <div
                      key={item.type}
                      draggable
                      onDragStart={e => onDragStart(e, item.type)}
                      className="wf-palette-item"
                      title={item.desc}
                    >
                      <NodeIconTile type={item.type} size="sm" showChannel={false} />
                      <div className="min-w-0 flex-1">
                        <p className="wf-palette-item__title">{item.label}</p>
                        <p className="wf-palette-item__desc">{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="text-xs wf-muted text-center py-6">Không tìm thấy node</p>
        )}
      </div>
    </div>
  );
}
