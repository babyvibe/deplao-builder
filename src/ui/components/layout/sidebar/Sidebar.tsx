import React, { useRef, useState, useCallback, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import ChannelBadge, { ZaloIcon, FacebookIcon, TelegramIcon } from '../../common/avatars/ChannelBadge';
import { isZalo, isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { useVisibleAccounts } from '@/hooks/accounts/useVisibleAccounts';
import { hasUnseenSettingsTabs, markFeatureSeen, useFeatureSeen } from '@/lib/app/settingsSeenTabs';
import { useErpPermissions } from '@/hooks/erp/useErpContext';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { BellIcon, BookIcon, BotIcon, BrainIcon, CampaignIcon, ChartIcon, ChatIcon, CheckIcon, CloudIcon, CreditCardIcon, DiamondIcon, DollarIcon, EditIcon, FileTextIcon, FolderIcon, GlobeIcon, HelpCircleIcon, LightningIcon, LinkIcon, LightbulbIcon, MailIcon, MessageCircleIcon, PackageIcon, RefreshIcon, SaveIcon, SearchIcon, SettingsIcon, ShoppingCartIcon, SmartphoneIcon, StoreIcon, SunIcon, TagIcon, TrendingUpIcon, TruckIcon, UserIcon, UsersIcon, WaveIcon, PluginIcon } from '@/components/common/icons';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { useFeatureVisibilityStore } from '@/store/app/featureVisibilityStore';


interface SidebarProps {
  onAddAccount: () => void;
}

/**
 * Tài khoản chưa kết nối: huy hiệu cam có biểu tượng nguồn (tắt) ở góc phải dưới; avatar đồng thời xám + mờ.
 * Màu dùng giá trị cố định (không phải lớp màu Tailwind) để lớp ánh xạ theme sáng không đổi màu huy hiệu.
 * Đỏ dành cho tin chưa đọc / listener chết ("!") — không trùng ý nghĩa.
 */
function DisconnectedBadge() {
  return (
    <span
      className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[rgb(234_88_12)] ring-2 ring-sidebar flex items-center justify-center z-10 pointer-events-none"
      title="Chưa kết nối"
      aria-label="Chưa kết nối"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
        <line x1="12" y1="2" x2="12" y2="12" />
      </svg>
    </span>
  );
}

export default function Sidebar({ onAddAccount }: SidebarProps) {
  const { activeAccountId, setActiveAccount, reorderAccounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, setActiveAccount: s.setActiveAccount,
    reorderAccounts: s.reorderAccounts,
  })));
  const visibleAccounts = useVisibleAccounts();
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const empMode = useEmployeeStore(s => s.mode);
  const openPluginHub = useAppStore(s => s.openPluginHub);
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
  const { view, setView, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount, setMergedInboxFilter, exitMergedInbox, sidebarExpanded, toggleSidebarExpanded } = useAppStore(useShallow(s => ({
    view: s.view, setView: s.setView, mergedInboxMode: s.mergedInboxMode,
    mergedInboxAccounts: s.mergedInboxAccounts, mergedInboxFilterAccount: s.mergedInboxFilterAccount,
    setMergedInboxFilter: s.setMergedInboxFilter, exitMergedInbox: s.exitMergedInbox,
    sidebarExpanded: s.sidebarExpanded, toggleSidebarExpanded: s.toggleSidebarExpanded,
  })));
  const featureVisibility = useFeatureVisibilityStore(state => state.enabled);
  const crmRequestUnseenByAccount = useAppStore(s => s.crmRequestUnseenByAccount);
  const { contacts, activeThreadId, activeThreadType, saveAccountThread } = useChatStore(useShallow(s => ({
    contacts: s.contacts, activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType,
    saveAccountThread: s.saveAccountThread,
  })));
  const { othersConversations: allOthers } = useAppStore(useShallow(s => ({
    othersConversations: s.othersConversations,
  })));

  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [showToolsGuide, setShowToolsGuide] = useState(false);
  const hasNewCRMRequests = Object.values(crmRequestUnseenByAccount || {}).some(Boolean);

  // Red dot cho CRM → Nhóm → Quét thành viên (chưa xem)
  const hasScanNewDot = (() => {
    try { return localStorage.getItem('scanTabSeen') !== 'true'; } catch { return false; }
  })();

  // Chấm đỏ trên nút Settings - tắt khi người dùng đã xem hết các tab quan trọng
  const [hasNewSettings, setHasNewSettings] = useState(() => hasUnseenSettingsTabs());
  useEffect(() => {
    const handler = () => setHasNewSettings(hasUnseenSettingsTabs());
    window.addEventListener('settings:tabSeen', handler);
    return () => window.removeEventListener('settings:tabSeen', handler);
  }, []);

  // Chấm đỏ "mới" trên Công cụ → Ứng dụng, API & Webhook: tắt khi đã mở trang Ứng dụng (view 'plugin')
  // và đã xem phần "API" và "Webhook" trong trang đó (PluginHub đánh dấu 'api' / 'webhooks').
  const pluginsSeen = useFeatureSeen('plugins');
  const apiSeen = useFeatureSeen('api');
  const webhooksSeen = useFeatureSeen('webhooks');
  useEffect(() => {
    if (view === 'plugin') markFeatureSeen('plugins');
  }, [view]);

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

  const showExpanded = sidebarExpanded && view === 'chat';

  return (
    <div className="flex flex-col w-16 bg-sidebar border-r border-sidebar-foreground/15 h-full">
      {/* ─── Toggle expand/collapse - chỉ hiện ở màn hình Chat ─── */}
      {view === 'chat' && (
        <div className="pt-2 pb-1 flex justify-center">
          <button
            onClick={toggleSidebarExpanded}
            title={showExpanded ? 'Ẩn danh sách tài khoản đầy đủ' : 'Hiện danh sách tài khoản đầy đủ'}
            className={`font-semibold w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              showExpanded
                ? 'bg-sidebar-foreground/15 text-sidebar-foreground hover:bg-sidebar-hover'
                : 'bg-sidebar-foreground/15 text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-sidebar-foreground'
            }`}
          >
            {showExpanded ? (
              /* X - đóng */
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              /* Hamburger - mở rộng */
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* ─── Danh sách tài khoản ─── */}
      {showExpanded ? (
        /* ── Expanded: ẩn avatar thu gọn, nav đẩy lên ── */
        <div className="" />
      ) : mergedInboxMode ? (
        <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-2">
          {/* "Tất cả" - bỏ lọc, với nút thoát ở góc trên-phải */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setMergedInboxFilter(null)}
              title="Chọn tất cả tài khoản"
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-all flex-shrink-0 ring-2 ${
                mergedInboxFilterAccount === null
                  ? 'bg-sidebar-active text-sidebar-active-foreground ring-sidebar-foreground'
                  : 'bg-sidebar-foreground/15 text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-sidebar-foreground ring-transparent'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </button>
            {/* Exit button - góc trên phải */}
            <button
              onClick={exitMergedInbox}
              title="Thoát chế độ Gộp tài khoản"
              className="absolute -top-2 -right-3 w-5 h-5 rounded-full bg-sidebar-foreground/15 flex items-center justify-center text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-sidebar-foreground transition-colors z-10"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

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
                {isSelected && <span className="absolute -left-3 top-0.5 bottom-0.5 w-[3px] rounded-r-full bg-sidebar-active pointer-events-none" />}
                <button
                  onClick={() => setMergedInboxFilter(isSelected ? null : zaloId)}
                  title={`${account.full_name || zaloId}${account.isConnected ? '' : ' · Chưa kết nối'}${isSelected ? ' - đang lọc' : ' - nhấn để lọc'}`}
                  className={`w-10 h-10 rounded-full overflow-hidden ring-2 transition-all flex-shrink-0 ${
                    isSelected
                      ? 'ring-[3px] ring-sidebar-active scale-110'
                      : isAllMode
                        ? 'ring-transparent opacity-90 hover:ring-sidebar-foreground/60'
                        : 'ring-transparent opacity-40 hover:opacity-80 hover:ring-sidebar-foreground/60'
                  }`}
                >
                  {account.avatar_url ? (
                    <img src={toLocalMediaUrl(account.avatar_url)} alt={account.full_name} className={`w-full h-full object-cover${account.isConnected ? '' : ' grayscale opacity-60'}`}
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.style.display = 'none';
                        // Retry avatar, nếu fail → xóa avatar_url để fallback sang channel icon
                        import('@/lib/contacts/avatarRetry').then(({ handleAvatarError }) =>
                          handleAvatarError({ ownerId: zaloId, contactId: zaloId, channel: account.channel || CHANNEL.ZALO })
                        ).then(newUrl => {
                          if (newUrl) {
                            useAccountStore.getState().updateAccount(zaloId, { avatar_url: newUrl });
                            img.src = newUrl;
                            img.style.display = '';
                          } else {
                            useAccountStore.getState().updateAccount(zaloId, { avatar_url: '' });
                          }
                        }).catch(() => {
                          useAccountStore.getState().updateAccount(zaloId, { avatar_url: '' });
                        });
                      }} />
                  ) : (
                    <div className={`w-full h-full flex items-center justify-center text-white font-bold text-sm ${isFacebook(account.channel) ? 'bg-blue-800' : isTelegram(account.channel) ? 'bg-blue-500' : 'bg-blue-600'}${account.isConnected ? '' : ' grayscale opacity-60'}`}>
                      {isFacebook(account.channel) ? (
                        <FacebookIcon size={16} />
                      ) : isTelegram(account.channel) ? (
                        <TelegramIcon size={16} />
                      ) : (
                        <ZaloIcon size={16} />
                      )}
                    </div>
                  )}
                </button>
                {unreadConvCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-0.5 leading-none z-10 shadow-md pointer-events-none">
                    {unreadConvCount > 99 ? '99+' : unreadConvCount}
                  </span>
                )}
                {/* Channel badge */}
                <div className="absolute -top-2 -left-0.5 z-10 pointer-events-none">
                  <ChannelBadge channel={(account.channel as any) || CHANNEL.ZALO} size="sm" />
                </div>
                {/* Chưa kết nối (gộp tài khoản) */}
                {!account.isConnected && <DisconnectedBadge />}
              </div>
            );
          })}

        </div>
      ) : (
        /* ── Collapsed / non-chat: danh sách avatar thu gọn ── */
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
              !account.isConnected ? '⚠ Chưa kết nối' : null,
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
                      ? 'ring-[3px] ring-sidebar-active'
                      : listenerDead
                        ? 'ring-red-600'
                          : 'ring-transparent hover:ring-sidebar-foreground/60'
                  }`}
                  style={{ cursor: 'pointer' }}
                >
                  {activeAccountId === account.zalo_id && <span className="absolute -left-3 top-0.5 bottom-0.5 w-[3px] rounded-r-full bg-sidebar-active pointer-events-none" />}
                  <div className={`w-10 h-10 rounded-full overflow-hidden transition-[filter,opacity]${account.isConnected ? '' : ' grayscale opacity-60'}`}>
                    {account.avatar_url ? (
                      <img
                        src={toLocalMediaUrl(account.avatar_url)}
                        alt={account.full_name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          img.style.display = 'none';
                          import('@/lib/contacts/avatarRetry').then(({ handleAvatarError }) =>
                            handleAvatarError({ ownerId: account.zalo_id, contactId: account.zalo_id, channel: account.channel || CHANNEL.ZALO })
                          ).then(newUrl => {
                            if (newUrl) {
                              useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: newUrl });
                              img.src = newUrl;
                              img.style.display = '';
                            } else {
                              useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: '' });
                            }
                          }).catch(() => {
                            useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: '' });
                          });
                        }}
                      />
                    ) : (
                      <div className={`w-full h-full flex items-center justify-center text-white font-bold text-sm ${isFacebook(account.channel) ? 'bg-blue-800' : isTelegram(account.channel) ? 'bg-blue-500' : 'bg-blue-600'}`}>
                        {isFacebook(account.channel) ? (
                          <FacebookIcon size={16} />
                        ) : isTelegram(account.channel) ? (
                          <TelegramIcon size={16} />
                        ) : (
                          <ZaloIcon size={16} />
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Top-right: listener dead / unread badge ── */}
                  {listenerDead ? (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-sidebar flex items-center justify-center z-10">
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
                      className="absolute -bottom-1 -left-1 bg-amber-500 text-white text-[7px] font-bold rounded-full border border-sidebar z-10 leading-none flex items-center justify-center"
                      style={{ minWidth: '0.875rem', height: '0.875rem', padding: '0 0.125rem' }}
                      title="Zalo Business"
                    ><FolderIcon className="w-4 h-4 inline" /> </span>
                  ) : null}

                  {/* ── Channel badge (Zalo/Facebook) ── */}
                  <div className="absolute -top-2 -left-0.5 z-10">
                    <ChannelBadge channel={(account.channel as any) || CHANNEL.ZALO} size="sm" />
                  </div>

                  {/* ── Chưa kết nối (góc phải dưới) ── */}
                  {!account.isConnected && !listenerDead ? <DisconnectedBadge /> : null}
                </button>
              </div>
            );
          })}

          {/* Add Account Button - hidden in employee mode and during employee simulation */}
          {empMode !== 'employee' && !isSimulating && (
          <button
            onClick={onAddAccount}
            title="Thêm tài khoản"
            // Nhiều tài khoản phải cuộn: không để flex bóp dẹt nút (các ô tài khoản cũng flex-shrink-0)
            className="w-10 h-10 flex-shrink-0 rounded-full bg-sidebar-foreground/15 hover:bg-sidebar-hover flex items-center justify-center text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors border-2 border-dashed border-sidebar-foreground/40"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
            </svg>
          </button>
          )}
        </div>
      )}

      {/* Nav bottom */}
      <div className="border-t border-sidebar-foreground/15 py-2 flex flex-col items-center gap-1">
        {featureVisibility.dashboard && <NavBtn icon="dashboard"  label="Dashboard"   active={view === 'dashboard'}  onClick={() => setView('dashboard')} />}
        {featureVisibility.chat && hasPerm('chat') && (
        <NavBtn icon="chat"       label="Chat"         active={view === 'chat'}       onClick={() => setView('chat')} />
        )}
        {featureVisibility.crm && hasPerm('crm') && (
        <NavBtn icon="crm"        label="CRM"          active={view === 'crm'}        onClick={() => setView('crm')} dot={hasNewCRMRequests || hasScanNewDot} />
        )}
        {featureVisibility.analytics && hasPerm('analytics') && (
        <NavBtn icon="analytics"  label="Báo cáo"      active={view === 'analytics'}  onClick={() => setView('analytics')} />
        )}
        {/* Công cụ: Workflow, Tích hợp, Quản lý công việc (ERP) và Ứng dụng gom vào một flyout để rail ngắn.
            ERP gated by module permission AND ERP RBAC (`erp.access`); fine-grained writes enforced via
            `useErpPermissions().can(...)` + IPC middleware `withErpAuth`. */}
        {(() => {
          const toolItems: FlyoutItem[] = [
            ...(featureVisibility.workflow && hasPerm('workflow') ? [{ icon: 'workflow', label: 'Workflow (n8n)', active: view === 'workflow', onClick: () => setView('workflow') }] : []),
            ...(featureVisibility.integration && hasPerm('integration') ? [{ icon: 'integration', label: 'Tích hợp', active: view === 'integration', onClick: () => setView('integration') }] : []),
            ...(featureVisibility.erp && hasPerm('erp') && canErpAccess ? [{ icon: 'erp', label: 'Quản lý công việc', active: view === 'erp', onClick: () => setView('erp') }] : []),
            ...(featureVisibility.plugins && empMode !== 'employee' && ipc.plugins ? [{ icon: 'plugin', label: 'Ứng dụng, API & Webhook', active: view === 'plugin', onClick: openPluginHub, dot: !pluginsSeen || !apiSeen || !webhooksSeen }] : []),
          ];
          if (toolItems.length === 0) return null;
          return (
            <NavFlyout
              icon="tools"
              label="Công cụ"
              active={toolItems.some((i) => i.active)}
              items={toolItems}
              onGuide={() => setShowToolsGuide(true)}
            />
          );
        })()}
        {featureVisibility.settings && <NavBtn icon="settings"   label="Cài đặt"      active={view === 'settings'}   onClick={() => setView('settings')} dot={hasNewSettings} />}
      </div>

      {/* Tools Guide Modal */}
      {showToolsGuide && <ToolsGuideModal onClose={() => setShowToolsGuide(false)} />}
    </div>
  );
}

/** Chấm đỏ "mới" ở góc nút trên rail - dùng chung cho NavBtn và NavFlyout để các chấm giống hệt nhau. */
const RAIL_DOT_CLASS = 'absolute top-1 right-1 w-2 h-2 bg-destructive rounded-full border border-sidebar pointer-events-none';

function NavBtn({ icon, label, active, onClick, dot }: { icon: string; label: string; active: boolean; onClick: () => void; dot?: boolean }) {
  const icons: Record<string, React.ReactNode> = {
    dashboard: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    chat: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    friends: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    crm: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/>
        <circle cx="9" cy="10.5" r="2.25"/>
        <path d="M5.5 16c.7-1.6 2-2.4 3.5-2.4s2.8.8 3.5 2.4"/>
        <path d="M14.5 9.5h4M14.5 13h4"/>
      </svg>
    ),
    workflow: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
        <circle cx="12" cy="18" r="2"/>
        <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
      </svg>
    ),
    integration: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
    ),
    tools: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        <line x1="12" y1="12" x2="12" y2="12.01"/>
      </svg>
    ),
    analytics: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 21H4.6c-.56 0-.84 0-1.054-.109a1 1 0 0 1-.437-.437C3 20.24 3 19.96 3 19.4V3"/>
          <path d="M7 14l4-4 4 4 6-6"/>
        </svg>
    ),
    settings: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    bot: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8" y2="16" />
        <line x1="16" y1="16" x2="16" y2="16" />
      </svg>
    ),
    erp: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
      </svg>
    ),
  };

  return (
    <button onClick={onClick} title={label}
      className={`relative w-11 h-11 rounded-xl flex items-center justify-center transition-colors ${active ? 'bg-sidebar-active text-sidebar-active-foreground shadow-md shadow-sidebar-active/40' : 'text-sidebar-foreground/90 hover:bg-sidebar-hover hover:text-sidebar-foreground'}`}>
      {icons[icon]}
      {active && <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-sidebar-active pointer-events-none" />}
      {dot && <span className={RAIL_DOT_CLASS} />}
    </button>
  );
}

// ─── Flyout menu (hover to expand submenu to the right) ───────────────────────

interface FlyoutItem {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Chấm đỏ "mới" trên mục; nút rail của flyout cũng hiện chấm khi có mục bất kỳ có chấm. */
  dot?: boolean;
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
  const hasDot = items.some((item) => item.dot);

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
        className={`relative w-11 h-11 rounded-xl flex items-center justify-center transition-colors ${
          active ? 'bg-sidebar-active text-sidebar-active-foreground shadow-md shadow-sidebar-active/40' : 'text-sidebar-foreground/90 hover:bg-sidebar-hover hover:text-sidebar-foreground'
        }`}
      >
        <NavIcon name={icon} />
        {active && <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-sidebar-active pointer-events-none" />}
        {hasDot && <span className={RAIL_DOT_CLASS} />}
      </button>

      {/* Flyout submenu - appears to the right */}
      {open && (
        <div
          className="absolute left-full -bottom-12 ml-1.5 z-[9999] min-w-[160px] bg-card border border-input rounded-xl shadow-2xl py-1.5 animate-in fade-in slide-in-from-left-2 duration-150"
        >
          {/* Header */}
          <div className="px-3 py-1.5 border-b border-border/60 mb-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
          </div>
          {items.map((item) => (
            <button
              key={item.icon}
              onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                item.active
                  ? 'bg-selected text-primary'
                  : 'text-foreground/80 hover:bg-muted hover:text-foreground'
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                <NavIcon name={item.icon} size={16} />
              </span>
              <span className="text-xs font-medium whitespace-nowrap">{item.label}</span>
              {item.dot && (
                <span className="ml-auto w-2 h-2 rounded-full bg-destructive flex-shrink-0" />
              )}
              {item.active && (
                <span className={`${item.dot ? '' : 'ml-auto '}w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0`} />
              )}
            </button>
          ))}
          {/* Guide button */}
          {onGuide && (
            <>
              <div className="border-t border-border/60 my-1" />
              <button
                onClick={() => { onGuide(); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 text-sm"><BookIcon className="w-4 h-4" /></span>
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

function NavIcon({ name, size = 20 }: { name: string; size?: number }) {
  switch (name) {
    case 'dashboard':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'chat':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'friends':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'crm':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/>
        <circle cx="9" cy="10.5" r="2.25"/>
        <path d="M5.5 16c.7-1.6 2-2.4 3.5-2.4s2.8.8 3.5 2.4"/>
        <path d="M14.5 9.5h4M14.5 13h4"/>
      </svg>
      );
    case 'workflow':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
        <circle cx="12" cy="18" r="2"/>
        <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
      </svg>
      );
    case 'integration':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      );
    case 'analytics':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 21H4.6c-.56 0-.84 0-1.054-.109a1 1 0 0 1-.437-.437C3 20.24 3 19.96 3 19.4V3"/>
          <path d="M7 14l4-4 4 4 6-6"/>
        </svg>
      );
    case 'facebook':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
        </svg>
      );
    case 'tools':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <line x1="12" y1="12" x2="12" y2="12.01"/>
        </svg>
      );
    case 'erp':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
      );
    case 'plugin':
      return <span className="inline-flex [&_svg]:w-full [&_svg]:h-full" style={{ width: size, height: size }}><PluginIcon className="w-full h-full" /></span>;
    case 'settings':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    icon: <ChartIcon className="w-4 h-4" />, title: 'CRM - Quản lý khách hàng',
    color: 'border-blue-500/40 bg-blue-900/30',
    badgeColor: 'bg-card text-foreground/80',
    purpose: 'Quản lý liên hệ của các tài khoản Zalo, Facebook, Telegram: phân loại bằng nhãn, ghi chú nội bộ, chạy chiến dịch gửi tin / kết bạn / mời vào nhóm và quét thành viên nhóm Zalo để tìm khách mới.',
    sections: [
      {
        icon: <UsersIcon className="w-4 h-4 inline" />,
        title: 'Quản lý liên hệ',
        items: [
          'Xem liên hệ theo từng tài khoản (chọn tài khoản ở góc phải): bạn bè, người chưa kết bạn, nhóm',
          'Lọc theo nhãn, loại (bạn bè / chưa là bạn bè / nhóm / có SĐT / có ghi chú), giới tính, sinh nhật; sắp xếp theo tên hoặc tin nhắn cuối',
          'Panel chi tiết: SĐT, giới tính, sinh nhật, nhãn, ghi chú và lịch sử gửi tin của từng liên hệ',
          'Xuất danh sách ra file CSV; xem số liệu ở trang Báo cáo (nút biểu đồ ở góc trên)',
        ],
      },
      {
        icon: <TagIcon className="w-4 h-4 inline" />,
        title: 'Hệ thống nhãn kép',
        items: [
          'Nhãn Zalo: đồng bộ 2 chiều với app Zalo - gán từ Deplao, thấy trên Zalo và ngược lại',
          'Nhãn Local: nhãn riêng của Deplao, chọn màu + emoji, dùng chung cho nhiều tài khoản',
          'Chọn người nhận chiến dịch theo nhãn (vd. chỉ gửi cho khách có nhãn "VIP")',
          'Dùng nhãn làm Trigger trong Workflow: "Khi gán hoặc gỡ nhãn" → tự động chạy luồng xử lý',
        ],
      },
      {
        icon: <FileTextIcon className="w-4 h-4 inline" />,
        title: 'Ghi chú nội bộ',
        items: [
          'Thêm ghi chú riêng cho từng liên hệ - khách hàng không thấy được',
          'Sửa / xoá ghi chú bất kỳ lúc nào ở tab Nhãn/Ghi chú của panel chi tiết',
          'Nhóm Zalo: xem thêm ghi chú nhóm của Zalo (chỉ đọc)',
        ],
      },
      {
        icon: <CampaignIcon className="w-4 h-4 inline" />,
        title: 'Chiến dịch & tìm khách mới',
        items: [
          'Loại chiến dịch: Tin nhắn, Kết bạn, Mời nhóm, Hỗn hợp (Telegram: chỉ Tin nhắn)',
          'Chọn người nhận: thủ công, theo nhãn, SĐT, UID, bạn bè, nhóm, thành viên nhóm',
          'Chèn tên người nhận bằng {name}; xem trước nội dung như khung chat; chọn chữ trước / ảnh trước hoặc gộp ảnh + chữ thành 1 tin',
          'Tự giãn cách ngẫu nhiên giữa các liên hệ (tối thiểu 30 giây), tối đa 60 tin/giờ mỗi tài khoản để tránh bị coi là spam',
          'Theo dõi realtime: đã gửi / đang chờ / lỗi - tạm dừng, tiếp tục bất cứ lúc nào; tab Lịch sử xem từng tin đã gửi',
          'Tab Nhóm → Quét thành viên: lấy thành viên nhóm Zalo (cả nhóm ẩn danh sách, nhóm đang chờ duyệt) vào CRM',
        ],
      },
    ],
  },
  {
    id: 'workflow' as const,
    icon: <LightningIcon className="w-4 h-4" />, title: 'Workflow - Tự động hoá',
    color: 'border-purple-500/40 bg-purple-900/30',
    badgeColor: 'bg-card text-foreground/80',
    purpose: 'Tạo luồng xử lý tự động bằng kéo-thả: nhận sự kiện → xử lý logic → thực hiện hành động trên Zalo, Facebook, Telegram. Không cần viết code; Kho mẫu có hơn 100 mẫu và nút AI giúp thiết kế bằng câu lệnh.',
    sections: [
      {
        icon: <LightningIcon className="w-4 h-4 inline" />,
        title: 'Trigger - sự kiện kích hoạt',
        items: [
          'Zalo: Khi nhận tin nhắn (lọc từ khóa / regex, cá nhân / nhóm, vai trò người gửi), lời mời kết bạn, sự kiện nhóm, react tin nhắn, gán / gỡ nhãn',
          'Facebook Messenger: tin nhắn (chữ, ảnh, video, file, sticker), reaction, thu hồi, sự kiện nhóm',
          'Telegram: tin nhắn, thu hồi, sự kiện nhóm; Telegram Bot: tin nhắn, lệnh, nút bấm, yêu cầu vào nhóm…',
          'Dùng chung: Chạy theo lịch hẹn (mỗi ngày, mỗi giờ, mỗi tuần… hoặc tự đặt), Chạy thủ công, Khi nhận thanh toán (Casso / SePay), Khi phần mềm bán hàng gửi webhook (KiotViet / Haravan / Sapo / Nhanh.vn / Pancake, cần khoá xác thực), Webhook bên ngoài, Khi API/ứng dụng gọi',
        ],
      },
      {
        icon: <MessageCircleIcon className="w-4 h-4 inline" />,
        title: 'Hành động trên Zalo, Facebook, Telegram',
        items: [
          'Gửi tin nhắn - chèn tên người gửi, nội dung tin… bằng nút "Chèn biến"',
          'Hiệu ứng "đang gõ..." + chờ vài giây → trả lời tự nhiên như người thật',
          'Gửi ảnh, file đính kèm (PDF, Excel...); tìm user bằng SĐT, lấy thông tin người dùng',
          'Chấp nhận / từ chối / gửi lời mời kết bạn; thêm / xoá thành viên nhóm, tạo bình chọn',
          'Gắn / gỡ nhãn, thu hồi, chuyển tiếp, thả cảm xúc, đổi tên gợi nhớ',
          'Facebook, Telegram và Telegram Bot có bộ hành động riêng; "Chuyển tiếp đa kênh" gửi lại tin sang kênh khác',
        ],
      },
      {
        icon: <BrainIcon className="w-4 h-4 inline" />,
        title: 'Logic & Dữ liệu',
        items: [
          'Rẽ nhánh Đúng/Sai (IF) và Phân nhiều nhánh (Switch) theo giá trị',
          'Lưu giá trị vào biến, Dừng workflow nếu…, Tạm dừng chờ N giây',
          'Lặp qua danh sách: chạy các bước cho từng sản phẩm / đơn / dòng tồn kho (tối đa 100), nhánh "Xong" chạy một lần sau cùng',
          'Chọn đối tượng nhận tin: lấy bạn bè / thành viên nhóm / nhãn / liên hệ CRM để gửi hàng loạt (tự giãn cách 5-10 giây giữa từng người nhận)',
          'Ghép nội dung văn bản, chọn ngẫu nhiên 1 mục, định dạng ngày giờ, đọc dữ liệu JSON',
        ],
      },
      {
        icon: <BotIcon className="w-4 h-4 inline" />,
        title: 'AI & Tích hợp ngoài',
        items: [
          'Tạo nội dung bằng AI: dùng Trợ lý AI đã tạo hoặc tự chọn OpenAI, Gemini, Claude, DeepSeek, Grok, Mistral, OpenRouter',
          'Phân loại văn bản bằng AI: tự nhận diện hỏi giá / khiếu nại / hỗ trợ...',
          'Google Sheets: ghi thêm dòng, đọc dữ liệu, cập nhật ô',
          'Gửi tin qua Telegram, Discord, Email; ghi vào Notion Database',
          'Gọi API bên ngoài (HTTP) để kết nối hệ thống khác',
        ],
      },
      {
        icon: <StoreIcon className="w-4 h-4 inline" />,
        title: 'POS, Thanh toán & Vận chuyển',
        items: [
          'KiotViet / Haravan / Sapo / Nhanh.vn / Pancake: tra cứu khách hàng, đơn hàng, sản phẩm, tạo đơn (Sapo có thêm tồn kho); webhook đơn mới / đổi trạng thái kích hoạt "Khi phần mềm bán hàng gửi webhook"',
          'Tra cứu theo SĐT đã lưu của người nhắn; khách chưa lưu SĐT thì không tra cứu (tránh trả nhầm đơn của khách khác)',
          'GHN / GHTK: tạo đơn vận chuyển, tra cứu vận đơn',
          'Casso / SePay: kích hoạt "Khi nhận thanh toán" (báo nhóm nội bộ, Telegram, ghi Sheets), lấy lịch sử giao dịch',
        ],
      },
      {
        icon: <SettingsIcon className="w-4 h-4 inline" />,
        title: 'Soạn & chạy thử',
        items: [
          'Kho mẫu: hơn 100 workflow mẫu, chọn rồi sửa theo nhu cầu',
          'Nút AI trong trình sửa: trò chuyện với Trợ lý AI để thiết kế hoặc sửa workflow',
          'Mô phỏng: chạy thử không gửi tin thật, xem luồng dạng khung chat',
          'Lịch sử chạy: xem từng lần chạy và lỗi để kiểm tra',
        ],
      },
    ],
  },
  {
    id: 'integration' as const,
    icon: <LinkIcon className="w-4 h-4" />, title: 'Tích hợp - Kết nối bên thứ 3',
    color: 'border-green-500/40 bg-green-900/30',
    badgeColor: 'bg-card text-foreground/80',
    purpose: 'Kết nối Deplao với phần mềm bán hàng, cổng thanh toán và đơn vị vận chuyển. Tra cứu dữ liệu ngay trong khung chat, nhận thông báo chuyển khoản tự động, kết hợp Workflow để xử lý trọn quy trình.',
    sections: [
      {
        icon: <ShoppingCartIcon className="w-4 h-4 inline" />,
        title: 'POS / Bán hàng (5 nền tảng)',
        items: [
          'KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS',
          'Tra cứu khách hàng, đơn hàng, sản phẩm (giá, tồn kho) và tạo đơn ngay trong hội thoại qua bảng Tích hợp nhanh',
          'Kết nối ở Công cụ → Tích hợp → POS / Bán hàng; bấm Test kết nối để nền tảng hiện trong Tích hợp nhanh',
          'Nhận webhook: KiotViet / Sapo bấm Đăng ký webhook tự động trong trang nền tảng; nền tảng khác đặt khoá xác thực webhook rồi dán Địa chỉ nhận webhook vào phần mềm bán hàng → workflow "Khi phần mềm bán hàng gửi webhook" chạy (webhook sai / thiếu khoá bị từ chối)',
        ],
      },
      {
        icon: <CreditCardIcon className="w-4 h-4 inline" />,
        title: 'Thanh toán (2 nền tảng)',
        items: [
          'Casso, SePay (VietQR): nhận thông báo ngay khi có chuyển khoản vào tài khoản',
          'Workflow "Khi nhận thanh toán": tự ghi sổ, báo nhân viên khi có tiền vào (lọc theo số tiền, nội dung chuyển khoản)',
          'Trong hội thoại: Tích hợp nhanh → Lịch sử giao dịch để xem nhanh giao dịch gần nhất',
        ],
      },
      {
        icon: <TruckIcon className="w-4 h-4 inline" />,
        title: 'Vận chuyển (2 nền tảng)',
        items: [
          'GHN Express: tra cứu vận đơn, tính phí, xem mã tỉnh / quận / phường của GHN',
          'GHTK: tra cứu vận đơn, tính phí',
          'Tạo đơn vận chuyển GHN / GHTK bằng Workflow',
        ],
      },
      {
        icon: <GlobeIcon className="w-4 h-4 inline" />,
        title: 'Địa chỉ Internet - nhận thông báo từ bên ngoài',
        items: [
          'Casso / SePay gửi thông báo qua Internet: bật dòng "Thanh toán, tích hợp" ở Cài đặt → Internet & Đám mây → Địa chỉ Internet',
          'Cloudflare tự động: địa chỉ cố định; Địa chỉ tạm đổi mỗi lần khởi động lại - phải dán lại vào Casso / SePay',
          'Địa chỉ nhận của từng kết nối nằm ngay trong trang Casso / SePay (nút sao chép)',
          'Website / dịch vụ ngoài kích hoạt Workflow qua dòng "Webhook workflow" ở cùng trang',
          'Chỉ nhận được khi Deplao đang mở',
        ],
      },
      {
        icon: <LightningIcon className="w-4 h-4 inline" />,
        title: 'Tích hợp nhanh trong hội thoại',
        items: [
          'Mở bằng nút hình mắt xích trên thanh tiêu đề hội thoại (hoặc ⋯ Thêm tính năng → Tích hợp nhanh)',
          'Ghim thao tác hay dùng ra thanh công cụ ô soạn tin - bấm một lần là mở đúng thao tác, SĐT điền sẵn nếu hội thoại có số',
          'Kết quả hiện ngay trong bảng bên phải - không cần rời khung chat',
          'Máy nhân viên: tra cứu chạy trên máy Boss (kết nối nằm ở Boss), cần quyền Tích hợp',
        ],
      },
    ],
  },
];

// ─── Combination scenarios ────────────────────────────────────────────────────

const COMBO_SCENARIOS = [
  {
    icon: <DollarIcon className="w-4 h-4" />,
    title: 'Xác nhận chuyển khoản tự động',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-emerald-500/30',
    flow: [
      { icon: <LinkIcon className="w-3 h-3" />, text: 'Casso / SePay báo có CK' },
      { icon: <SettingsIcon className="w-3 h-3" />, text: 'Khi nhận thanh toán' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Ghi Google Sheets' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Báo nhóm Zalo nội bộ' },
    ],
    desc: 'Khách chuyển khoản → Casso / SePay báo về Deplao → Workflow ghi sổ và báo ngay cho nhân viên để xác nhận đơn, không cần ngồi soát sao kê.',
  },
  {
    icon: <BotIcon className="w-4 h-4" />,
    title: 'Chatbot AI tư vấn bán hàng',
    tags: ['Workflow', 'AI'],
    color: 'border-violet-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn hỏi' },
      { icon: <BrainIcon className="w-3 h-3" />, text: 'AI phân loại (hỏi giá / CSKH / khiếu nại)' },
      { icon: <BotIcon className="w-3 h-3" />, text: 'AI soạn câu trả lời' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Hiệu ứng đang gõ' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi phản hồi' },
    ],
    desc: 'Khách nhắn tin → AI phân loại câu hỏi → Trợ lý AI soạn câu trả lời phù hợp → gửi tự động kèm hiệu ứng đang gõ.',
  },
  {
    icon: <WaveIcon className="w-4 h-4" />,
    title: 'Chào mừng + phân loại khách mới',
    tags: ['Workflow', 'CRM'],
    color: 'border-blue-500/30',
    flow: [
      { icon: <UserIcon className="w-3 h-3" />, text: 'Nhận lời mời KB' },
      { icon: <CheckIcon className="w-3 h-3" />, text: 'Tự chấp nhận' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi tin chào' },
      { icon: <TagIcon className="w-3 h-3" />, text: 'Gắn nhãn "Khách mới"' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Ghi Google Sheets' },
    ],
    desc: 'Có người gửi lời mời kết bạn → tự chấp nhận → gửi lời chào + giới thiệu dịch vụ → gắn nhãn CRM → ghi thông tin vào Sheets.',
  },
  {
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    title: 'Tra cứu đơn hàng qua tin nhắn',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-orange-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn SĐT đặt hàng' },
      { icon: <SearchIcon className="w-3 h-3" />, text: 'Tra cứu đơn hàng (POS)' },
      { icon: <SettingsIcon className="w-3 h-3" />, text: 'Rẽ nhánh: tìm thấy?' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi trạng thái đơn' },
    ],
    desc: 'Khách gửi số điện thoại đặt hàng (hoặc đã lưu SĐT trong thông tin liên hệ) → Workflow tra đơn trên KiotViet / Haravan / Sapo / Nhanh.vn / Pancake → trả lời trạng thái đơn ngay. Nhân viên cũng tra tay được bằng bảng Tích hợp nhanh.',
  },
  {
    icon: <CampaignIcon className="w-4 h-4" />,
    title: 'Chiến dịch remarketing theo nhãn',
    tags: ['CRM'],
    color: 'border-pink-500/30',
    flow: [
      { icon: <ChartIcon className="w-3 h-3" />, text: 'Chọn KH nhãn "Chưa mua"' },
      { icon: <CampaignIcon className="w-3 h-3" />, text: 'Tạo chiến dịch' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Soạn tin ưu đãi + {name}' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi giãn cách (≤ 60 tin/giờ)' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Theo dõi đã gửi / lỗi' },
    ],
    desc: 'Chọn người nhận theo nhãn → tạo chiến dịch với nội dung có tên từng khách → gửi tự động, giãn cách để tránh spam → theo dõi tiến độ realtime.',
  },
  {
    icon: <PackageIcon className="w-4 h-4" />,
    title: 'Đơn từ website → vận đơn GHN',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-cyan-500/30',
    flow: [
      { icon: <LinkIcon className="w-3 h-3" />, text: 'Website gửi đơn (Webhook)' },
      { icon: <TruckIcon className="w-3 h-3" />, text: 'GHN: Tạo đơn vận chuyển' },
      { icon: <BellIcon className="w-3 h-3" />, text: 'Báo mã vận đơn qua Telegram' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Ghi Sheets' },
    ],
    desc: 'Website gửi đơn mới về Deplao (Webhook bên ngoài) → Workflow tạo vận đơn GHN từ thông tin người nhận → báo mã vận đơn cho kho và ghi sổ.',
  },
  {
    icon: <BellIcon className="w-4 h-4" />,
    title: 'Thông báo đa kênh khi có tiền vào',
    tags: ['Workflow', 'Tích hợp'],
    color: 'border-amber-500/30',
    flow: [
      { icon: <DollarIcon className="w-3 h-3" />, text: 'Nhận thanh toán' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Báo nhóm Zalo nội bộ' },
      { icon: <BellIcon className="w-3 h-3" />, text: 'Telegram cho admin' },
      { icon: <MailIcon className="w-3 h-3" />, text: 'Email cho kế toán' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Ghi Notion' },
    ],
    desc: 'Một giao dịch → nhiều hành động cùng lúc: báo nhóm Zalo nội bộ, Telegram cho admin, email cho kế toán và ghi vào Notion.',
  },
  {
    icon: <TagIcon className="w-4 h-4" />,
    title: 'Tự động gắn nhãn theo nội dung chat',
    tags: ['Workflow', 'AI', 'CRM'],
    color: 'border-rose-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn tin' },
      { icon: <BrainIcon className="w-3 h-3" />, text: 'AI phân loại nội dung' },
      { icon: <TagIcon className="w-3 h-3" />, text: 'Gắn nhãn tương ứng' },
      { icon: <ChartIcon className="w-3 h-3" />, text: 'CRM cập nhật' },
    ],
    desc: 'AI đọc tin nhắn → phân loại (hỏi giá / khiếu nại / khen / hỏi giao hàng) → tự động gắn nhãn CRM phù hợp.',
  },
];

function ToolsGuideModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'overview' | 'crm' | 'workflow' | 'integration' | 'combo'>('overview');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-card rounded-2xl border border-input shadow-2xl w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border/60 flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-foreground flex items-center gap-2">
              <span><BookIcon className="w-4 h-4" /></span> Hướng dẫn - Công cụ nâng cao
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Mô tả chi tiết tính năng và cách phối hợp các công cụ</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/60 px-2 flex-shrink-0 overflow-x-auto gap-0.5">
          {([
            { id: 'overview', icon: <LightbulbIcon className="w-3.5 h-3.5" />, label: 'Tổng quan' },
            { id: 'crm', icon: <ChartIcon className="w-3.5 h-3.5" />, label: 'CRM' },
            { id: 'workflow', icon: <SettingsIcon className="w-3.5 h-3.5" />, label: 'Workflow' },
            { id: 'integration', icon: <LinkIcon className="w-3.5 h-3.5" />, label: 'Tích hợp' },
            { id: 'combo', icon: <RefreshIcon className="w-3.5 h-3.5" />, label: 'Kết hợp' },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2.5 text-[11px] flex font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon} <span className="ml-1">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* ── Overview Tab ── */}
          {activeTab === 'overview' && (
            <>
              <div className="bg-muted/30 rounded-xl p-4 flex items-start gap-3">
                <span className="text-2xl leading-none"><SunIcon className="w-4 h-4" /></span>
                <div className="space-y-2">
                  <p className="text-foreground/80 text-xs leading-relaxed">
                    Ba công cụ <strong className="text-foreground">CRM</strong>, <strong className="text-foreground">Workflow</strong> và <strong className="text-foreground">Tích hợp</strong> phối
                    hợp với nhau tạo thành hệ thống tự động hoá hoàn chỉnh:
                  </p>
                  <div className="flex items-center gap-2 text-[11px] flex-wrap">
                    <span className="bg-green-900/30 text-foreground px-2.5 py-1 rounded-lg border border-green-700/40"><LinkIcon className="w-4 h-4 inline" /> Tích hợp nhận dữ liệu</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="bg-purple-900/30 text-foreground px-2.5 py-1 rounded-lg border border-purple-700/40"><SettingsIcon className="w-3.5 h-3.5 inline" /> Workflow xử lý logic</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="bg-blue-900/30 text-blue-300 px-2.5 py-1 rounded-lg border border-blue-700/40"><ChartIcon className="w-4 h-4 inline" /> CRM quản lý KH</span>
                  </div>
                </div>
              </div>

              {/* Summary cards */}
              {TOOLS_GUIDE.map((tool, i) => (
                <button
                  key={i}
                  onClick={() => setActiveTab(tool.id)}
                  className={`w-full border rounded-xl p-4 text-left transition-colors hover:bg-muted/30 ${tool.color}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{tool.icon}</span>
                    <h3 className="text-sm font-bold text-foreground">{tool.title}</h3>
                    <span className="text-muted-foreground ml-auto text-[10px]">Bấm để xem chi tiết →</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{tool.purpose}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {tool.sections.map((s, j) => (
                      <span key={j} className={`text-[12px] px-2 py-0.5 rounded-full ${tool.badgeColor}`}>
                        {s.title}
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
                  <span className="text-lg"><RefreshIcon className="w-4 h-4" /></span>
                  <h3 className="text-sm font-bold text-foreground">{COMBO_SCENARIOS.length} kịch bản kết hợp thực tế</h3>
                  <span className="text-muted-foreground ml-auto text-[10px]">Bấm để xem →</span>
                </div>
                <p className="text-xs text-muted-foreground">Xem các ví dụ phối hợp CRM + Workflow + Tích hợp trong thực tế kinh doanh.</p>
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
                    <h3 className="text-sm font-bold text-foreground">{tool.title}</h3>
                  </div>
                  <p className="text-xs text-foreground/80 leading-relaxed">{tool.purpose}</p>
                </div>

                {tool.sections.map((section, i) => (
                  <div key={i} className="space-y-2">
                    <h4 className="text-xs font-bold text-foreground/80 flex items-center gap-1.5">{section.icon} {section.title}</h4>
                    <ul className="space-y-1 pl-1">
                      {section.items.map((item, j) => (
                        <li key={j} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                          <span className="leading-relaxed">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {/* Related combos */}
                <div className="border-t border-border/60 pt-4 mt-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2"><RefreshIcon className="w-4 h-4 inline" /> Kịch bản kết hợp liên quan</p>
                  <div className="space-y-2">
                    {COMBO_SCENARIOS.filter(c =>
                      (activeTab === 'crm' && c.tags.includes('CRM')) ||
                      (activeTab === 'workflow' && c.tags.includes('Workflow')) ||
                      (activeTab === 'integration' && c.tags.includes('Tích hợp'))
                    ).slice(0, 3).map((combo, i) => (
                      <div key={i} className={`border rounded-lg p-3 bg-muted/20 ${combo.color}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span>{combo.icon}</span>
                          <span className="text-xs font-semibold text-foreground">{combo.title}</span>
                          <div className="flex gap-1 ml-auto">
                            {combo.tags.map(t => (
                              <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-accent/50 text-muted-foreground">{t}</span>
                            ))}
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{combo.desc}</p>
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
              <div className="bg-muted/30 rounded-xl p-4">
                <p className="text-xs text-foreground/80 leading-relaxed">
                  Sức mạnh thực sự nằm ở việc <strong className="text-foreground">kết hợp</strong> các công cụ. Dưới đây là {COMBO_SCENARIOS.length} kịch bản thực tế
                  giúp bạn hình dung cách ứng dụng vào kinh doanh.
                </p>
              </div>

              {COMBO_SCENARIOS.map((combo, i) => (
                <div key={i} className={`border rounded-xl p-4 space-y-2.5 bg-muted/10 ${combo.color}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{combo.icon}</span>
                    <h3 className="text-xs font-bold text-foreground">{combo.title}</h3>
                    <div className="flex gap-1 ml-auto">
                      {combo.tags.map(t => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-accent/50 text-muted-foreground">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{combo.desc}</p>
                  {/* Flow diagram */}
                  <div className="flex items-center gap-1.5 text-[10px] flex-wrap pt-1">
                    {combo.flow.map((step, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span className="text-muted-foreground">→</span>}
                        <span className="bg-card text-foreground/80 px-2 py-0.5 rounded-md border border-border/60 whitespace-nowrap inline-flex items-center gap-1">{step.icon} {step.text}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border/60 flex-shrink-0 flex justify-end">
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
