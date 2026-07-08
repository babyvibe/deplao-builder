import React, { useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useVisibleAccounts } from '@/hooks/useVisibleAccounts';
import ChannelBadge from '../common/ChannelBadge';
import { formatPhone } from '@/utils/phoneUtils';
import { FolderIcon } from '@/components/common/icons';

interface AccountPanelProps {
  onAddAccount: () => void;
}

export default function AccountPanel({ onAddAccount }: AccountPanelProps) {
  const { activeAccountId, setActiveAccount, reorderAccounts } = useAccountStore();
  const visibleAccounts = useVisibleAccounts();
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const empMode = useEmployeeStore(s => s.mode);
  const isSimulating = empMode !== 'employee' && !!previewEmployeeId;
  const accounts = visibleAccounts;
  const { view, setView, toggleSidebarExpanded, mergedInboxMode, mergedInboxFilterAccount, setMergedInboxFilter } = useAppStore();
  const { contacts, activeThreadId, activeThreadType, saveAccountThread, setActiveThread } = useChatStore();

  const [accountSearch, setAccountSearch] = useState('');
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndexRef = React.useRef<number | null>(null);

  const filteredAccounts = accountSearch
    ? accounts.filter(a =>
        (a.full_name || '').toLowerCase().includes(accountSearch.toLowerCase()) ||
        (a.phone || '').includes(accountSearch)
      )
    : accounts;

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };
  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from !== null && from !== toIndex) reorderAccounts(from, toIndex);
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };
  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  return (
    <div className="w-64 bg-gray-900 border-r border-gray-700 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-11 border-b border-gray-700/60 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
          Tài khoản <span className="font-bold">({accounts.length})</span>
        </span>
      </div>

      {/* Search */}
      <div className="px-3 pt-2.5 pb-2 flex-shrink-0">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={accountSearch}
            onChange={(e) => setAccountSearch(e.target.value)}
            placeholder="Tìm tài khoản..."
            className="w-full h-8 pl-8 pr-7 rounded-lg bg-gray-800/80 border border-gray-700/60 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-colors"
          />
          {accountSearch && (
            <button
              onClick={() => setAccountSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Account list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filteredAccounts.map((account, index) => {
          const listenerDead = account.isConnected && account.listenerActive === false;
          const isDragOver = dragOverIndex === index;
          const isActive = activeAccountId === account.zalo_id;

          return (
            <div
              key={account.zalo_id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`relative transition-all rounded-lg ${isDragOver ? 'opacity-70 scale-[1.02]' : ''}`}
              style={{ cursor: 'grab' }}
            >
              <button
                onClick={() => {
                  if (mergedInboxMode) {
                    setMergedInboxFilter(
                      mergedInboxFilterAccount === account.zalo_id ? null : account.zalo_id
                    );
                  } else {
                    if (activeAccountId && activeThreadId) {
                      saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
                    }
                    // Reset thread trước để ChatWindow clear view cũ
                    setActiveThread(null);
                    setActiveAccount(account.zalo_id);
                    setView('chat');
                  }
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors text-left ${
                  isActive
                    ? 'bg-blue-600/20 ring-1 ring-blue-500/40'
                    : 'hover:bg-gray-700/50 active:bg-gray-700/80'
                }`}
              >
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  <div className="w-8 h-8 rounded-full overflow-hidden ring-1 ring-white/10">
                    {account.avatar_url ? (
                      <img src={account.avatar_url} alt={account.full_name}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).src = ''; }} />
                    ) : (
                      <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-xs">
                        {(account.full_name || account.zalo_id).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  {/* Status indicator */}
                  {listenerDead ? (
                    <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full border-2 border-gray-900" title="Listener chết" />
                  ) : account.isConnected ? (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-gray-900" title="Đã kết nối" />
                  ) : (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-gray-500 rounded-full border-2 border-gray-900" title="Chưa kết nối" />
                  )}
                  {/* Channel badge */}
                  <div className="absolute -top-1 -left-1 z-10 pointer-events-none scale-[0.7]">
                    <ChannelBadge channel={(account.channel as any) || 'zalo'} size="xs" />
                  </div>
                </div>

                {/* Name + phone */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium truncate ${isActive ? 'text-blue-300' : 'text-gray-200'}`}>
                      {account.full_name || account.zalo_id}
                    </span>
                    {account.is_business ? (
                      <span className="text-[9px] leading-none" title="Zalo Business"><FolderIcon className="w-4 h-4" /></span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {account.phone ? (
                      <span className="text-[10px] text-gray-400 truncate">{formatPhone(account.phone)}</span>
                    ) : null}
                    {!account.isConnected && !listenerDead && (
                      <span className="text-[9px] text-red-400/70 font-medium">Chưa kết nối</span>
                    )}
                    {listenerDead && (
                      <span className="text-[9px] text-red-400/70 font-medium">⚠ Listener</span>
                    )}
                  </div>
                </div>
              </button>
            </div>
          );
        })}

        {/* Add account */}
        {empMode !== 'employee' && !isSimulating && (
          <button
            onClick={onAddAccount}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-gray-700/50 transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-full border-2 border-dashed border-gray-600 flex items-center justify-center flex-shrink-0">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
              </svg>
            </div>
            <span className="text-xs font-medium">Thêm tài khoản</span>
          </button>
        )}
      </div>
    </div>
  );
}
