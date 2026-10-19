/**
 * PluginChatPanel — panel plugin bên phải màn chat; gửi context.changed khi đổi hội thoại.
 * Context: tài khoản, hội thoại, kênh, thông tin khách (tên, ảnh, số điện thoại nếu có).
 */
import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useChatStore } from '@/store/chatStore';
import { usePluginStore } from '@/store/pluginStore';
import { CloseIcon } from '@/components/common/icons';
import PluginFrame from './PluginFrame';

export default function PluginChatPanel() {
  const panel = useAppStore(s => s.activePluginPanel);
  const setPanel = useAppStore(s => s.setActivePluginPanel);
  const panels = usePluginStore(s => s.contributions.chatPanels);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const channel = useAccountStore(s => s.accounts.find(a => a.zalo_id === s.activeAccountId)?.channel || 'zalo');
  const { threadId, threadType } = useChatStore(useShallow(s => ({ threadId: s.activeThreadId, threadType: s.activeThreadType })));
  const contact = useChatStore(s => (s.activeThreadId && activeAccountId ? (s.contacts[activeAccountId] || []).find(c => c.contact_id === s.activeThreadId) : undefined));

  const current = panels.find(p => panel && p.pluginId === panel.pluginId && p.id === panel.panelId);

  const context = useMemo(() => (threadId && activeAccountId ? {
    accountId: activeAccountId,
    channel,
    threadId,
    threadType: threadType === 1 || contact?.contact_type === 'group' ? 'group' : 'user',
    contact: contact ? {
      id: contact.contact_id,
      name: (contact as any).alias || contact.display_name || '',
      avatar: (contact as any).avatar_url || (contact as any).avatar || '',
      phone: (contact as any).phone || '',
    } : null,
  } : null), [activeAccountId, channel, threadId, threadType, contact]);

  if (!panel || !current) return null;

  return (
    <div className="h-full flex flex-col border-l border-border bg-card shadow-2xl" style={{ width: current.width || 320 }}>
      <div className="h-11 flex-shrink-0 flex items-center gap-1 px-2 border-b border-border overflow-x-auto">
        {panels.map(p => {
          const on = p.pluginId === current.pluginId && p.id === current.id;
          return (
            <button
              key={`${p.pluginId}::${p.id}`}
              type="button"
              title={p.pluginName}
              onClick={() => setPanel({ pluginId: p.pluginId, panelId: p.id })}
              className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap transition-colors ${on ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              {p.title}
            </button>
          );
        })}
        <button type="button" title="Đóng" onClick={() => setPanel(null)} className="ml-auto w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <PluginFrame key={`${current.pluginId}::${current.id}`} contribution={current} kind="panel" context={context} />
      </div>
    </div>
  );
}

/** Nút trên header chat: bật/tắt panel plugin (ẩn khi không có panel nào). */
export function PluginPanelToggle() {
  const panels = usePluginStore(s => s.contributions.chatPanels);
  const panel = useAppStore(s => s.activePluginPanel);
  const setPanel = useAppStore(s => s.setActivePluginPanel);
  if (!panels.length) return null;
  const open = !!panel;
  return (
    <button
      type="button"
      title={open ? 'Ẩn panel ứng dụng' : 'Panel ứng dụng'}
      onClick={() => setPanel(open ? null : { pluginId: panels[0].pluginId, panelId: panels[0].id })}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${open ? 'bg-primary text-white' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
      </svg>
    </button>
  );
}
