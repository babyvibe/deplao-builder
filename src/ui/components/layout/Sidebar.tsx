import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';
import ChannelBadge from '../common/ChannelBadge';
import { useVisibleAccounts } from '@/hooks/useVisibleAccounts';
import { hasUnseenSettingsTabs } from '@/utils/settingsSeenTabs';
import { useErpPermissions } from '@/hooks/erp/useErpContext';

interface SidebarProps {
  onAddAccount: () => void;
}

export default function Sidebar({ onAddAccount }: SidebarProps) {
  const { activeAccountId, setActiveAccount, reorderAccounts } = useAccountStore();
  const visibleAccounts = useVisibleAccounts();
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const empMode = useEmployeeStore(s => s.mode);
  // Subscribe so Sidebar re-renders when permissions / employees list changes
  const empPermissions = useEmployeeStore(s => s.permissions);
  const employees = useEmployeeStore(s => s.employees);
  const isSimulating = empMode !== 'employee' && !!previewEmployeeId;

  const hasPerm = useCallback((module: string) => {
    if (module === 'dashboard') return true;

    // Boss preview mode: use previewed employee's permissions
    if (empMode !== 'employee' && previewEmployeeId) {
      const emp = employees.find((e: any) => e.employee_id === previewEmployeeId);
      const perm = emp?.permissions?.find((p: any) => p.module === module);
      return perm ? !!perm.can_access : false;
    }

    // Boss/standalone has full access
    if (empMode !== 'employee') return true;

    // Real employee mode
    return !!empPermissions[module];
  }, [empMode, previewEmployeeId, employees, empPermissions]);
  // ERP-specific permission check (role-based, independent from Zalo ACL).
  const { can: canErp } = useErpPermissions();
  const canErpAccess = canErp('erp.access');
  // Use visible (filtered) accounts for rendering
  const accounts = visibleAccounts;
  const { view, setView, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount, setMergedInboxFilter, exitMergedInbox } = useAppStore();
  const crmRequestUnseenByAccount = useAppStore(s => s.crmRequestUnseenByAccount);
  const { contacts, activeThreadId, activeThreadType, saveAccountThread } = useChatStore();
  const { othersConversations: allOthers } = useAppStore();

  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showToolsGuide, setShowToolsGuide] = useState(false);
  const hasNewCRMRequests = Object.values(crmRequestUnseenByAccount || {}).some(Boolean);

  // Chấm đỏ trên nút Settings — tắt khi người dùng đã xem hết các tab quan trọng
  const [hasNewSettings, setHasNewSettings] = useState(() => hasUnseenSettingsTabs());
  useEffect(() => {
    const handler = () => setHasNewSettings(hasUnseenSettingsTabs());
    window.addEventListener('settings:tabSeen', handler);
    return () => window.removeEventListener('settings:tabSeen', handler);
  }, []);

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
    <div className="flex flex-col w-16 bg-gray-900 border-r border-gray-700 h-full">
      {/* Danh sách tài khoản — chế độ Gộp trang: hiện các avatar dùng làm bộ lọc */}
      {mergedInboxMode ? (
        <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-2">
          {/* Exit button — ở trên cùng */}
          <button
            onClick={exitMergedInbox}
            title="Thoát chế độ Gộp tài khoản"
            className="w-8 h-8 rounded-lg bg-red-900/30 border border-red-700/40 flex items-center justify-center text-red-400 hover:bg-red-900/60 hover:text-red-300 transition-colors flex-shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>

          {/* "Tất cả" — bỏ lọc */}
          <button
            onClick={() => setMergedInboxFilter(null)}
            title="Tất cả tài khoản"
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all flex-shrink-0 ring-2 ${
              mergedInboxFilterAccount === null
                ? 'bg-blue-600 text-white ring-blue-400'
                : 'bg-gray-700 text-gray-400 hover:bg-gray-600 ring-transparent'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </button>

          {/* Account filter avatars */}
          {mergedInboxAccounts.map(zaloId => {
            const account = accounts.find(a => a.zalo_id === zaloId);
            if (!account) return null;
            const accountContacts = contacts[zaloId] || [];
            const acctOthers = allOthers[zaloId] || new Set();
            const unreadConvCount = accountContacts.reduce((s, c) => {
              if (acctOthers.has(c.contact_id)) return s;
              return s + (c.unread_count > 0 ? 1 : 0);
            }, 0);
            const isSelected = mergedInboxFilterAccount === zaloId;
            const isAllMode = mergedInboxFilterAccount === null;
            return (
              <div key={zaloId} className="relative flex-shrink-0">
                <button
                  onClick={() => setMergedInboxFilter(isSelected ? null : zaloId)}
                  title={`${account.full_name || zaloId}${isSelected ? ' — đang lọc' : ' — nhấn để lọc'}`}
                  className={`w-10 h-10 rounded-full overflow-hidden ring-2 transition-all flex-shrink-0 ${
                    isSelected
                      ? 'ring-blue-500 scale-110'
                      : isAllMode
                        ? 'ring-transparent opacity-90 hover:ring-gray-500'
                        : 'ring-transparent opacity-40 hover:opacity-80 hover:ring-gray-500'
                  }`}
                >
                  {account.avatar_url ? (
                    <img src={account.avatar_url} alt={account.full_name} className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).src = ''; }} />
                  ) : (
                    <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
                      {(account.full_name || account.zalo_id).charAt(0).toUpperCase()}
                    </div>
                  )}
                </button>
                {unreadConvCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-0.5 leading-none z-10 shadow-md pointer-events-none">
                    {unreadConvCount > 99 ? '99+' : unreadConvCount}
                  </span>
                )}
                {/* Channel badge */}
                <div className="absolute -bottom-0.5 -left-0.5 z-10 pointer-events-none">
                  <ChannelBadge channel={(account.channel as any) || 'zalo'} size="xs" />
                </div>
              </div>
            );
          })}

        </div>
      ) : (
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-2">
        {accounts.map((account, index) => {
          const accountContacts = contacts[account.zalo_id] || [];
          const acctOthers = allOthers[account.zalo_id] || new Set();
          const unreadConvCount = accountContacts.reduce((s, c) => {
            if (acctOthers.has(c.contact_id)) return s;
            return s + (c.unread_count > 0 ? 1 : 0);
          }, 0);
          const listenerDead = account.isConnected && account.listenerActive === false;
          const isDragOver = dragOverIndex === index;

          const tooltipLines = [
            account.full_name || account.zalo_id,
            account.is_business ? '💼 Tài khoản Zalo Business' : null,
            listenerDead ? '⚠ Listener chết' : null,
          ].filter(Boolean).join('\n');

          return (
            <div
              key={account.zalo_id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`relative flex-shrink-0 transition-all ${isDragOver ? 'scale-110 opacity-70' : ''}`}
              style={{ cursor: 'grab' }}
            >
              <button
                onClick={() => {
                  if (activeAccountId && activeThreadId) {
                    saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
                  }
                  setActiveAccount(account.zalo_id);
                  setView('chat');
                }}
                title={tooltipLines}
                className={`relative w-10 h-10 rounded-full overflow-visible ring-2 transition-all flex-shrink-0 ${
                  activeAccountId === account.zalo_id
                    ? 'ring-blue-500'
                    : listenerDead
                      ? 'ring-red-600'
                        : 'ring-transparent hover:ring-gray-500'
                }`}
                style={{ cursor: 'pointer' }}
              >
                <div className="w-10 h-10 rounded-full overflow-hidden">
                  {account.avatar_url ? (
                    <img
                      src={account.avatar_url}
                      alt={account.full_name}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).src = ''; }}
                    />
                  ) : (
                    <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
                      {(account.full_name || account.zalo_id).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                {/* ── Top-right: listener dead / unread badge ── */}
                {listenerDead ? (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-gray-900 flex items-center justify-center z-10">
                    <span className="text-white text-[8px] font-bold leading-none">!</span>
                  </span>
                ) : unreadConvCount > 0 ? (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-0.5 leading-none z-10 shadow-md">
                    {unreadConvCount > 99 ? '99+' : unreadConvCount}
                  </span>
                ) : null}

                {/* ── Bottom-left: Zalo Business badge ── */}
                {account.is_business ? (
                  <span
                    className="absolute -bottom-1 -left-1 bg-amber-500 text-white text-[7px] font-bold rounded-full border border-gray-900 z-10 leading-none flex items-center justify-center"
                    style={{ minWidth: 14, height: 14, padding: '0 2px' }}
                    title="Zalo Business"
                  >
                    💼
                  </span>
                ) : null}

                {/* ── Channel badge (Zalo/Facebook) ── */}
                <div className="absolute -bottom-0.5 -left-0.5 z-10">
                  <ChannelBadge channel={(account.channel as any) || 'zalo'} size="xs" />
                </div>
              </button>
            </div>
          );
        })}

        {/* Add Account Button — hidden in employee mode and during employee simulation */}
        {empMode !== 'employee' && !isSimulating && (
        <button
          onClick={onAddAccount}
          title="Thêm tài khoản"
          className="w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors border-2 border-dashed border-gray-600"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
          </svg>
        </button>
        )}
      </div>
      )} {/* end: !mergedInboxMode account list */}

      {/* Nav bottom */}
      <div className="border-t border-gray-700 py-2 flex flex-col items-center gap-1">
        <NavBtn icon="dashboard"  label="Dashboard"   active={view === 'dashboard'}  onClick={() => setView('dashboard')} />
        {hasPerm('chat') && (
        <NavBtn icon="chat"       label="Chat"         active={view === 'chat'}       onClick={() => setView('chat')} />
        )}
        {hasPerm('crm') && (
        <NavBtn icon="crm"        label="CRM"          active={view === 'crm'}        onClick={() => setView('crm')} dot={hasNewCRMRequests} />
        )}
        {(hasPerm('workflow') || hasPerm('integration')) && (
        <NavFlyout
          icon="tools"
          label="Công cụ"
          active={view === 'workflow' || view === 'integration'}
          items={[
            ...(hasPerm('workflow') ? [{ icon: 'workflow' as const, label: 'Workflow (n8n)', active: view === 'workflow', onClick: () => setView('workflow') }] : []),
            ...(hasPerm('integration') ? [{ icon: 'integration' as const, label: 'Tích hợp', active: view === 'integration', onClick: () => setView('integration') }] : []),
          ]}
          onGuide={() => setShowToolsGuide(true)}
        />
        )}
        {hasPerm('analytics') && (
        <NavBtn icon="analytics"  label="Báo cáo"      active={view === 'analytics'}  onClick={() => setView('analytics')} />
        )}
        {/* ERP — gated by ERP RBAC (`erp.access`, default-allowed). Inside ERP,
            fine-grained writes enforced via `useErpPermissions().can(...)` +
            IPC middleware `withErpAuth`. */}
        {canErpAccess && (
        <NavBtn icon="erp"        label="Quản lý công việc"   active={view === 'erp'}        onClick={() => setView('erp')} />
        )}
        <NavBtn icon="settings"   label="Cài đặt"      active={view === 'settings'}   onClick={() => setView('settings')} dot={hasNewSettings} />
      </div>

      {/* Tools Guide Modal */}
      {showToolsGuide && <ToolsGuideModal onClose={() => setShowToolsGuide(false)} />}
    </div>
  );
}

function NavBtn({ icon, label, active, onClick, dot }: { icon: string; label: string; active: boolean; onClick: () => void; dot?: boolean }) {
  const icons: Record<string, React.ReactNode> = {
    dashboard: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    chat: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    friends: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    crm: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"/>
        <path d="M7 14v3"/>
        <path d="M12 10v7"/>
        <path d="M17 7v10"/>
      </svg>
    ),
    workflow: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
        <circle cx="12" cy="18" r="2"/>
        <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
      </svg>
    ),
    integration: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
    ),
    tools: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        <line x1="12" y1="12" x2="12" y2="12.01"/>
      </svg>
    ),
    analytics: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 21H4.6c-.56 0-.84 0-1.054-.109a1 1 0 0 1-.437-.437C3 20.24 3 19.96 3 19.4V3"/>
          <path d="M7 14l4-4 4 4 6-6"/>
        </svg>
    ),
    settings: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    erp: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
      </svg>
    ),
  };

  return (
    <button onClick={onClick} title={label}
      className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}>
      {icons[icon]}
      {dot && (
        <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border border-gray-900 pointer-events-none" />
      )}
    </button>
  );
}

// ─── Flyout menu (hover to expand submenu to the right) ───────────────────────

interface FlyoutItem {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

function NavFlyout({ icon, label, active, items, onGuide }: { icon: string; label: string; active: boolean; items: FlyoutItem[]; onGuide?: () => void }) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setOpen(false), 200);
  }, []);

  // Reuse the same icon lookup as NavBtn
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        ref={btnRef}
        title={label}
        className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
          active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-white'
        }`}
      >
        <NavIcon name={icon} />
      </button>

      {/* Flyout submenu — appears to the right */}
      {open && (
        <div
          className="absolute left-full -bottom-12 ml-1.5 z-[9999] min-w-[160px] bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1.5 animate-in fade-in slide-in-from-left-2 duration-150"
        >
          {/* Header */}
          <div className="px-3 py-1.5 border-b border-gray-700/60 mb-1">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
          </div>
          {items.map((item) => (
            <button
              key={item.icon}
              onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                item.active
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                <NavIcon name={item.icon} />
              </span>
              <span className="text-xs font-medium whitespace-nowrap">{item.label}</span>
              {item.active && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              )}
            </button>
          ))}
          {/* Guide button */}
          {onGuide && (
            <>
              <div className="border-t border-gray-700/60 my-1" />
              <button
                onClick={() => { onGuide(); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
              >
                <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 text-sm">📖</span>
                <span className="text-xs font-medium whitespace-nowrap">Hướng dẫn sử dụng</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared icon component ────────────────────────────────────────────────────

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case 'dashboard':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'chat':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'friends':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'crm':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"/>
        <path d="M7 14v3"/>
        <path d="M12 10v7"/>
        <path d="M17 7v10"/>
      </svg>
      );
    case 'workflow':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
        <circle cx="12" cy="18" r="2"/>
        <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
      </svg>
      );
    case 'integration':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      );
    case 'analytics':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 21H4.6c-.56 0-.84 0-1.054-.109a1 1 0 0 1-.437-.437C3 20.24 3 19.96 3 19.4V3"/>
          <path d="M7 14l4-4 4 4 6-6"/>
        </svg>
      );
    case 'facebook':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
        </svg>
      );
    case 'tools':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <line x1="12" y1="12" x2="12" y2="12.01"/>
        </svg>
      );
    case 'erp':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
      );
    case 'settings':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      );
    default:
      return null;
  }
}


// ─── Tools Guide Modal ────────────────────────────────────────────────────────

const TOOLS_GUIDE = [
  {
    id: 'crm' as const,
    icon: '📊', title: 'CRM — Quản lý khách hàng',
    color: 'border-blue-500/40 bg-blue-900/10',
    badgeColor: 'bg-blue-600/30 text-blue-300',
    purpose: 'Quản lý toàn bộ danh sách liên hệ Zalo, phân loại khách hàng bằng nhãn, ghi chú nội bộ, và chạy chiến dịch nhắn tin hàng loạt — biến Zalo thành CRM chuyên nghiệp.',
    sections: [
      {
        title: '👥 Quản lý liên hệ',
        items: [
          'Xem tất cả liên hệ theo tài khoản Zalo: bạn bè, nhóm, stranger (người lạ)',
          'Bộ lọc nâng cao: theo nhãn, trạng thái (đã nhắn / chưa nhắn), loại liên hệ, thời gian',
          'Xem thông tin chi tiết: avatar, tên, SĐT, nhãn, ghi chú, lịch sử tương tác',
          'Dashboard tổng quan: thống kê số lượng liên hệ, tương tác, nhãn phân bố',
        ],
      },
      {
        title: '🏷️ Hệ thống nhãn kép',
        items: [
          'Nhãn Zalo (Zalo Label): đồng bộ 2 chiều với app Zalo trên điện thoại — gán từ Deplao, thấy trên Zalo và ngược lại',
          'Nhãn Local: nhãn riêng của Deplao, tùy biến màu sắc + emoji, không giới hạn số lượng',
          'Dùng nhãn làm điều kiện lọc trong chiến dịch (chỉ gửi cho khách có nhãn "VIP")',
          'Dùng nhãn làm Trigger trong Workflow: khi gắn nhãn → tự động chạy luồng xử lý',
        ],
      },
      {
        title: '📝 Ghi chú nội bộ (Notes)',
        items: [
          'Thêm ghi chú riêng cho từng liên hệ — khách hàng không thấy được',
          'Chỉnh sửa / xóa ghi chú bất kỳ lúc nào',
          'Xem lại toàn bộ ghi chú theo dòng thời gian trong panel chi tiết',
        ],
      },
      {
        title: '📢 Chiến dịch nhắn tin hàng loạt',
        items: [
          'Tạo chiến dịch: chọn đối tượng theo nhãn / bộ lọc → soạn mẫu tin → gửi',
          'Hỗ trợ biến động: chèn tên khách, SĐT, nhãn... vào nội dung tin nhắn tự động',
          'Giới hạn tốc độ gửi tự động: tối đa 60 tin/giờ, delay giữa mỗi tin (tránh spam)',
          'Theo dõi realtime: đã gửi / thất bại / phản hồi — dừng/tiếp tục chiến dịch mọi lúc',
          'Lịch sử gửi chi tiết: xem từng tin đã gửi, trạng thái, thời gian',
        ],
      },
    ],
  },
  {
    id: 'workflow' as const,
    icon: '⚙️', title: 'Workflow — Tự động hoá',
    color: 'border-purple-500/40 bg-purple-900/10',
    badgeColor: 'bg-purple-600/30 text-gray-300',
    purpose: 'Tạo các luồng xử lý tự động bằng giao diện kéo-thả trực quan: nhận sự kiện → xử lý logic → thực hiện hành động. Không cần viết code, có sẵn 20+ mẫu workflow.',
    sections: [
      {
        title: '⚡ Trigger — 8 loại sự kiện kích hoạt',
        items: [
          'Khi nhận tin nhắn: lọc theo từ khóa, loại hội thoại (cá nhân/nhóm), regex',
          'Khi có lời mời kết bạn → tự động chấp nhận + gửi lời chào',
          'Khi có sự kiện nhóm: thành viên vào/rời, đổi admin, đổi avatar nhóm',
          'Khi có người react tin nhắn (like, heart, haha...)',
          'Khi gắn/gỡ nhãn: liên kết CRM → Workflow liền mạch',
          'Chạy theo lịch hẹn (cron): hàng ngày, hàng giờ, ngày cụ thể',
          'Khi nhận thanh toán (webhook từ Casso/SePay)',
          'Chạy thủ công: nút bấm test từ giao diện',
        ],
      },
      {
        title: '💬 Action — 15+ thao tác trên Zalo',
        items: [
          'Gửi tin nhắn văn bản (hỗ trợ biến động {{ tên }}, {{ sdt }}...)',
          'Hiệu ứng "đang gõ..." + delay → tạo cảm giác tự nhiên như người thật',
          'Gửi ảnh (từ file hoặc URL), gửi file đính kèm (PDF, Excel...)',
          'Tìm user bằng SĐT, lấy thông tin người dùng (avatar, tên, giới tính)',
          'Chấp nhận / Từ chối / Gửi lời mời kết bạn tự động',
          'Quản lý nhóm: thêm/xóa thành viên, tạo bình chọn (poll)',
          'Gắn/gỡ nhãn, thu hồi tin nhắn, chuyển tiếp tin nhắn, thả cảm xúc',
        ],
      },
      {
        title: '🧠 Logic & Dữ liệu',
        items: [
          'Rẽ nhánh IF/ELSE: kiểm tra điều kiện → chạy nhánh tương ứng',
          'Switch: phân nhiều nhánh theo giá trị (VD: phân loại câu hỏi)',
          'Lặp forEach: lặp qua danh sách rồi xử lý từng item',
          'Lưu biến, dừng workflow nếu điều kiện đúng, chờ N giây',
          'Ghép nội dung văn bản, chọn ngẫu nhiên, định dạng ngày giờ, đọc JSON',
        ],
      },
      {
        title: '🤖 AI & Tích hợp ngoài',
        items: [
          'AI tạo nội dung: ChatGPT, Gemini, Deepseek, Grok — chatbot thông minh',
          'AI phân loại tin nhắn: tự nhận diện hỏi giá / khiếu nại / hỗ trợ kỹ thuật...',
          'Google Sheets: ghi dữ liệu, đọc dữ liệu, cập nhật ô — biến Sheets thành database',
          'Gửi thông báo Telegram, Discord, Email, ghi vào Notion Database',
          'Gọi API/Webhook HTTP bên ngoài: kết nối bất kỳ hệ thống nào',
        ],
      },
      {
        title: '🏪 POS & Vận chuyển trong Workflow',
        items: [
          'KiotViet / Haravan / Sapo / iPOS / Nhanh: tra cứu KH, đơn hàng, sản phẩm, tạo đơn',
          'GHN / GHTK: tạo đơn vận chuyển, tra cứu vận đơn — ngay trong luồng tự động',
          'Casso / SePay (VietQR): lấy lịch sử giao dịch, đối soát thanh toán',
        ],
      },
    ],
  },
  {
    id: 'integration' as const,
    icon: '🔗', title: 'Tích hợp — Kết nối bên thứ 3',
    color: 'border-green-500/40 bg-green-900/10',
    badgeColor: 'bg-green-600/30 text-green-500',
    purpose: 'Kết nối Deplao với hệ sinh thái bán hàng, thanh toán, vận chuyển Việt Nam. Tra cứu dữ liệu ngay trong khung chat, nhận webhook tự động, kết hợp Workflow để xử lý end-to-end.',
    sections: [
      {
        title: '🛒 POS / Bán hàng (5 nền tảng)',
        items: [
          'KiotViet: tra cứu khách hàng, đơn hàng, sản phẩm, tạo đơn — phổ biến nhất VN',
          'Haravan: nền tảng TMĐT, tra cứu đơn hàng online, khách hàng',
          'Sapo: quản lý bán hàng đa kênh, tra cứu đơn/khách theo SĐT',
          'iPOS: POS nhà hàng / F&B, tra cứu hóa đơn, sản phẩm/món ăn',
          'Nhanh.vn: tra cứu đơn, sản phẩm, khách hàng, tạo đơn',
          '→ Tất cả đều tra cứu trực tiếp từ khung chat bằng nút tắt hoặc shortcut',
        ],
      },
      {
        title: '💳 Thanh toán (2 nền tảng)',
        items: [
          'Casso: kết nối ngân hàng, nhận webhook khi có chuyển khoản mới — realtime',
          'SePay (VietQR): tương tự Casso, hỗ trợ nhiều ngân hàng VN',
          'Webhook tự nhận về app tại http://127.0.0.1:9888/webhook/{type}',
          'Kết hợp Workflow trigger.payment → gửi tin cảm ơn + xác nhận đơn tự động',
        ],
      },
      {
        title: '🚚 Vận chuyển (2 nền tảng)',
        items: [
          'GHN Express: tạo đơn giao hàng, tra cứu mã vận đơn + trạng thái',
          'GHTK: tạo đơn + tra cứu tracking — đối soát COD',
        ],
      },
      {
        title: '🌐 Tunnel — Mở kết nối ra internet',
        items: [
          'Bật thủ công khi cần: tạo URL công khai (https://xxx.loca.lt) trỏ về app',
          'Cho phép bên ngoài (Casso, SePay, n8n cloud...) gửi webhook về Deplao',
          'Không bật = webhook chỉ hoạt động trên localhost (cùng máy)',
          'Tắt bất cứ lúc nào — không ảnh hưởng các tính năng khác',
        ],
      },
      {
        title: '⚡ Shortcut tra cứu nhanh',
        items: [
          'Ghim các nút tra cứu POS/vận chuyển ngay trên thanh công cụ chat',
          'Bấm 1 lần → tra cứu đơn hàng / khách hàng theo SĐT người đang chat',
          'Kết quả hiển thị ngay trong popup — không cần rời khung chat',
        ],
      },
    ],
  },
];

// ─── Combination scenarios ────────────────────────────────────────────────────

const COMBO_SCENARIOS = [
  {
    icon: '💰',
    title: 'Xác nhận thanh toán tự động',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-emerald-500/30',
    flow: ['🔗 SePay/Casso nhận CK', '⚙️ Trigger payment', '📝 Ghép tin "Cảm ơn {tên}, đơn #{mã} đã nhận {số tiền}"', '💬 Gửi tin Zalo', '🏷️ Gắn nhãn "Đã TT"'],
    desc: 'Khách chuyển khoản → Deplao nhận webhook từ ngân hàng → Workflow tự động gửi tin xác nhận + gắn nhãn CRM.',
  },
  {
    icon: '🤖',
    title: 'Chatbot AI tư vấn bán hàng',
    tags: ['Workflow', 'AI'],
    color: 'border-violet-500/30',
    flow: ['💬 Khách nhắn hỏi', '🧠 AI phân loại (hỏi giá / CSKH / khiếu nại)', '🤖 ChatGPT trả lời theo ngữ cảnh', '⌨️ Typing + delay', '💬 Gửi phản hồi'],
    desc: 'Khách nhắn tin → AI tự phân loại câu hỏi → ChatGPT sinh nội dung trả lời phù hợp → gửi tự động với hiệu ứng đang gõ.',
  },
  {
    icon: '👋',
    title: 'Chào mừng + phân loại khách mới',
    tags: ['Workflow', 'CRM'],
    color: 'border-blue-500/30',
    flow: ['👤 Nhận lời mời KB', '✅ Auto chấp nhận', '💬 Gửi tin chào', '🏷️ Gắn nhãn "Khách mới"', '📊 Ghi Google Sheets'],
    desc: 'Khi có người gửi kết bạn → auto accept → gửi lời chào + menu dịch vụ → gắn nhãn CRM → ghi thông tin vào Sheets.',
  },
  {
    icon: '🛒',
    title: 'Tra cứu đơn hàng ngay trong chat',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-orange-500/30',
    flow: ['💬 Khách nhắn "đơn hàng"', '🔍 KiotViet tra SĐT', '📝 Ghép kết quả', '💬 Gửi thông tin đơn'],
    desc: 'Khách hỏi về đơn hàng → Workflow tự tra cứu KiotViet/Haravan theo SĐT → gửi lại thông tin đơn chi tiết.',
  },
  {
    icon: '📢',
    title: 'Chiến dịch remarketing theo nhãn',
    tags: ['CRM', 'Workflow'],
    color: 'border-pink-500/30',
    flow: ['📊 Lọc KH nhãn "Chưa mua"', '📢 Tạo chiến dịch', '📝 Soạn tin ưu đãi', '💬 Gửi hàng loạt (60 tin/h)', '📈 Theo dõi phản hồi'],
    desc: 'Lọc danh sách khách có nhãn cụ thể → tạo chiến dịch với nội dung cá nhân hóa → gửi tự động + theo dõi kết quả.',
  },
  {
    icon: '📦',
    title: 'Đặt hàng + giao hàng tự động',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-cyan-500/30',
    flow: ['💬 Khách nhắn "MUA"', '🛒 Tạo đơn KiotViet', '🚚 Tạo vận đơn GHN', '💬 Gửi mã tracking', '📊 Ghi Sheets'],
    desc: 'Khách nhắn từ khóa → Workflow tạo đơn trên POS → tạo vận đơn GHN/GHTK → gửi mã tracking cho khách.',
  },
  {
    icon: '🔔',
    title: 'Thông báo đa kênh khi có đơn mới',
    tags: ['Workflow', 'Tích hợp'],
    color: 'border-amber-500/30',
    flow: ['💰 Nhận thanh toán', '💬 Gửi tin Zalo cho KH', '📲 Thông báo Telegram cho admin', '📧 Email cho kế toán', '📝 Ghi Notion'],
    desc: 'Một sự kiện → nhiều hành động: xác nhận cho khách trên Zalo + thông báo admin qua Telegram + ghi log vào Notion/Email.',
  },
  {
    icon: '🏷️',
    title: 'Tự động gắn nhãn theo nội dung chat',
    tags: ['Workflow', 'AI', 'CRM'],
    color: 'border-rose-500/30',
    flow: ['💬 Khách nhắn tin', '🧠 AI phân loại nội dung', '🏷️ Gắn nhãn tương ứng', '📊 CRM cập nhật'],
    desc: 'AI đọc tin nhắn → phân loại (hỏi giá / khiếu nại / khen / hỏi giao hàng) → tự động gắn nhãn CRM phù hợp.',
  },
];

function ToolsGuideModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'overview' | 'crm' | 'workflow' | 'integration' | 'combo'>('overview');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-2xl border border-gray-600 shadow-2xl w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-700/60 flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>📖</span> Hướng dẫn — Công cụ nâng cao
            </h2>
            <p className="text-[11px] text-gray-400 mt-0.5">Mô tả chi tiết tính năng và cách phối hợp các công cụ</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700/60 px-2 flex-shrink-0 overflow-x-auto gap-0.5">
          {([
            { id: 'overview', label: '💡 Tổng quan' },
            { id: 'crm', label: '📊 CRM' },
            { id: 'workflow', label: '⚙️ Workflow' },
            { id: 'integration', label: '🔗 Tích hợp' },
            { id: 'combo', label: '🔄 Kết hợp' },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2.5 text-[11px] font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* ── Overview Tab ── */}
          {activeTab === 'overview' && (
            <>
              <div className="bg-gray-700/30 rounded-xl p-4 flex items-start gap-3">
                <span className="text-2xl leading-none">💡</span>
                <div className="space-y-2">
                  <p className="text-gray-300 text-xs leading-relaxed">
                    Ba công cụ <strong className="text-white">CRM</strong>, <strong className="text-white">Workflow</strong> và <strong className="text-white">Tích hợp</strong> phối
                    hợp với nhau tạo thành hệ thống tự động hoá hoàn chỉnh:
                  </p>
                  <div className="flex items-center gap-2 text-[11px] flex-wrap">
                    <span className="bg-green-900/40 text-white px-2.5 py-1 rounded-lg border border-green-700/40">🔗 Tích hợp nhận dữ liệu</span>
                    <span className="text-gray-600">→</span>
                    <span className="bg-purple-900/40 text-white px-2.5 py-1 rounded-lg border border-purple-700/40">⚙️ Workflow xử lý logic</span>
                    <span className="text-gray-600">→</span>
                    <span className="bg-blue-900/40 text-blue-300 px-2.5 py-1 rounded-lg border border-blue-700/40">📊 CRM quản lý KH</span>
                  </div>
                </div>
              </div>

              {/* Summary cards */}
              {TOOLS_GUIDE.map((tool, i) => (
                <button
                  key={i}
                  onClick={() => setActiveTab(tool.id)}
                  className={`w-full border rounded-xl p-4 text-left transition-colors hover:bg-gray-700/30 ${tool.color}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{tool.icon}</span>
                    <h3 className="text-sm font-bold text-white">{tool.title}</h3>
                    <span className="text-gray-600 ml-auto text-[10px]">Bấm để xem chi tiết →</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">{tool.purpose}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {tool.sections.map((s, j) => (
                      <span key={j} className={`text-[10px] px-2 py-0.5 rounded-full ${tool.badgeColor}`}>
                        {s.title.split(' ').slice(1).join(' ')}
                      </span>
                    ))}
                  </div>
                </button>
              ))}

              {/* Combo preview */}
              <button
                onClick={() => setActiveTab('combo')}
                className="w-full border border-amber-500/30 bg-amber-900/10 rounded-xl p-4 text-left hover:bg-amber-900/20 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">🔄</span>
                  <h3 className="text-sm font-bold text-white">{COMBO_SCENARIOS.length} kịch bản kết hợp thực tế</h3>
                  <span className="text-gray-600 ml-auto text-[10px]">Bấm để xem →</span>
                </div>
                <p className="text-xs text-gray-400">Xem các ví dụ phối hợp CRM + Workflow + Tích hợp trong thực tế kinh doanh.</p>
              </button>
            </>
          )}

          {/* ── Tool Detail Tabs (CRM / Workflow / Integration) ── */}
          {(activeTab === 'crm' || activeTab === 'workflow' || activeTab === 'integration') && (() => {
            const tool = TOOLS_GUIDE.find(t => t.id === activeTab)!;
            return (
              <>
                <div className={`border rounded-xl p-4 ${tool.color}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{tool.icon}</span>
                    <h3 className="text-sm font-bold text-white">{tool.title}</h3>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed">{tool.purpose}</p>
                </div>

                {tool.sections.map((section, i) => (
                  <div key={i} className="space-y-2">
                    <h4 className="text-xs font-bold text-gray-300">{section.title}</h4>
                    <ul className="space-y-1 pl-1">
                      {section.items.map((item, j) => (
                        <li key={j} className="flex items-start gap-2 text-xs text-gray-400">
                          <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                          <span className="leading-relaxed">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {/* Related combos */}
                <div className="border-t border-gray-700/60 pt-4 mt-2">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">🔄 Kịch bản kết hợp liên quan</p>
                  <div className="space-y-2">
                    {COMBO_SCENARIOS.filter(c =>
                      (activeTab === 'crm' && c.tags.includes('CRM')) ||
                      (activeTab === 'workflow' && c.tags.includes('Workflow')) ||
                      (activeTab === 'integration' && c.tags.includes('Tích hợp'))
                    ).slice(0, 3).map((combo, i) => (
                      <div key={i} className={`border rounded-lg p-3 bg-gray-700/20 ${combo.color}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span>{combo.icon}</span>
                          <span className="text-xs font-semibold text-white">{combo.title}</span>
                          <div className="flex gap-1 ml-auto">
                            {combo.tags.map(t => (
                              <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-600/50 text-gray-400">{t}</span>
                            ))}
                          </div>
                        </div>
                        <p className="text-[11px] text-gray-400 leading-relaxed">{combo.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}

          {/* ── Combo Tab ── */}
          {activeTab === 'combo' && (
            <>
              <div className="bg-gray-700/30 rounded-xl p-4">
                <p className="text-xs text-gray-300 leading-relaxed">
                  Sức mạnh thực sự nằm ở việc <strong className="text-white">kết hợp</strong> các công cụ. Dưới đây là {COMBO_SCENARIOS.length} kịch bản thực tế
                  giúp bạn hình dung cách ứng dụng vào kinh doanh.
                </p>
              </div>

              {COMBO_SCENARIOS.map((combo, i) => (
                <div key={i} className={`border rounded-xl p-4 space-y-2.5 bg-gray-700/10 ${combo.color}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{combo.icon}</span>
                    <h3 className="text-xs font-bold text-white">{combo.title}</h3>
                    <div className="flex gap-1 ml-auto">
                      {combo.tags.map(t => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-600/50 text-gray-400">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-relaxed">{combo.desc}</p>
                  {/* Flow diagram */}
                  <div className="flex items-center gap-1.5 text-[10px] flex-wrap pt-1">
                    {combo.flow.map((step, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span className="text-gray-600">→</span>}
                        <span className="bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md border border-gray-700/60 whitespace-nowrap">{step}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-700/60 flex-shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}
