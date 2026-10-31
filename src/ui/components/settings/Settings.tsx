/**
 * Màn Cài đặt: cột menu chia nhóm (Chung · Tài khoản & nhóm · Dữ liệu & mạng · Hỗ trợ) + trang bên phải. Mỗi trang dùng
 * khung chung settingsUi (tiêu đề + 1 dòng mô tả, khối, dòng cài đặt). Mã tab giữ nguyên vì nhiều nơi mở thẳng một tab qua
 * sự kiện nav:settings { tab, subtab }.
 */
import React, { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAccountStore } from '@/store/accounts/accountStore';
import { FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP, useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { playNotificationSound, requestNotificationPermission, showDesktopNotification } from '@/lib/notifications/NotificationService';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/lib/app/apiError';
import {
  BellIcon, BookIcon, BriefcaseIcon, CheckIcon, ClipboardIcon, CloudIcon, FolderIcon, GlobeIcon, HardDriveIcon, MessageIcon,
  MoonIcon, PaletteIcon, ShieldIcon, SunIcon, TerminalIcon, UserIcon, UsersIcon,
} from '../common/icons';
import IntroductionSettings from './introduction/IntroductionSettings';
import ChangelogSettings from './changelog/ChangelogSettings';
import ConversationSettings from './conversation/ConversationSettings';
import EmployeeSettings from './employees/EmployeeSettings';
import WorkspaceSettings from './workspace/WorkspaceSettings';
import ProxySettings from './proxy/ProxySettings';
import LockScreenSettings from './security/LockScreenSettings';
import AccountSettings from './accounts/AccountSettings';
import InAppNotifySettings from './notifications/InAppNotifySettings';
import AutoLaunchSettings from './notifications/AutoLaunchSettings';
import LogViewer from './logs/LogViewer';
import CloudSettings, { type CloudSection } from './cloud/CloudSettings';
import CloudMediaSummary from './cloud/CloudMediaSummary';
import { toCloudSection } from './cloud/cloudUi';
import { useCloudAlert } from './cloud/useCloudAlert';
import { loadSeenTabs, markTabSeen, SETTINGS_WATCHLIST, hasUnseenChangelog, markChangelogSeen } from '@/lib/app/settingsSeenTabs';
import { Button, Select, Switch } from '@/components/ui';
import { DesignSystemPage } from '@/components/ui/DesignSystemPage';
import { isZalo, isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { Notice, PathText, SettingsPage, SettingsRow, SettingsSection } from './settingsUi';

type SettingsTab = 'notifications' | 'accounts' | 'storage' | 'cloud' | 'conversation' | 'employees' | 'workspace' | 'introduction' | 'changelog' | 'appearance' | 'proxy' | 'security' | 'logs';

interface NavItem { id: SettingsTab; icon: React.ReactNode; label: string; requiredPerm?: string }

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Chung',
    items: [
      { id: 'conversation',  icon: <MessageIcon className="w-4 h-4" />, label: 'Hội thoại' },
      { id: 'notifications', icon: <BellIcon className="w-4 h-4" />, label: 'Thông báo' },
      { id: 'appearance',    icon: <PaletteIcon className="w-4 h-4" />, label: 'Giao diện' },
      { id: 'security',      icon: <ShieldIcon className="w-4 h-4" />, label: 'Bảo mật' },
    ],
  },
  {
    label: 'Tài khoản & nhóm',
    items: [
      { id: 'accounts',  icon: <UserIcon className="w-4 h-4" />, label: 'Tài khoản', requiredPerm: 'settings_accounts' },
      { id: 'employees', icon: <UsersIcon className="w-4 h-4" />, label: 'Nhân viên', requiredPerm: 'settings_employees' },
      { id: 'workspace', icon: <BriefcaseIcon className="w-4 h-4" />, label: 'Workspace' },
    ],
  },
  {
    label: 'Dữ liệu & mạng',
    items: [
      { id: 'storage', icon: <HardDriveIcon className="w-4 h-4" />, label: 'Lưu trữ' },
      { id: 'cloud',   icon: <CloudIcon className="w-4 h-4" />, label: 'Internet & Đám mây' },
      { id: 'proxy',   icon: <GlobeIcon className="w-4 h-4" />, label: 'Proxy' },
    ],
  },
  {
    label: 'Hỗ trợ',
    items: [
      { id: 'introduction', icon: <BookIcon className="w-4 h-4" />, label: 'Giới thiệu' },
      { id: 'changelog',    icon: <ClipboardIcon className="w-4 h-4" />, label: 'Log phiên bản' },
      { id: 'logs',         icon: <TerminalIcon className="w-4 h-4" />, label: 'Nhật ký' },
    ],
  },
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('conversation');
  const [introSubtab, setIntroSubtab] = useState<string | null>(null);
  // Internet & Đám mây: phần mở sẵn theo nav:settings { tab: 'cloud', subtab: 'address' | 'sync' } ('media' / 'db' cũ → 'sync')
  const [cloudSubtab, setCloudSubtab] = useState<CloudSection | null>(null);
  const [seenTabs, setSeenTabs] = useState<Set<string>>(() => loadSeenTabs());
  const [unreadChangelog, setUnreadChangelog] = useState(() => hasUnseenChangelog());
  const [storagePath, setStoragePath] = useState<string>('');
  const [defaultStoragePath, setDefaultStoragePath] = useState<string>('');
  const [actualDbPath, setActualDbPath] = useState<string>('');
  const [isEmployee, setIsEmployee] = useState(false);
  const [mediaCachePath, setMediaCachePath] = useState('');
  const [mediaCacheSize, setMediaCacheSize] = useState(0);
  const [changingStorage, setChangingStorage] = useState(false);
  // Pending folder with existing data - shown in choice modal
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  // Live progress khi đang copy media
  const [copyProgress, setCopyProgress] = useState<number>(0);
  const [copyTotal, setCopyTotal] = useState<number>(0);
  const showNotification = useAppStore(s => s.showNotification);

  useEffect(() => {
    ipc.db?.getStoragePath().then((res: any) => {
      if (res?.success) {
        setStoragePath(res.path || '');
        setDefaultStoragePath(res.defaultPath || '');
        setActualDbPath(res.actualDbPath || '');
        setIsEmployee(res.isEmployee || false);
        if (res.isEmployee) {
          setMediaCachePath(res.mediaCachePath || '');
          setMediaCacheSize(res.mediaCacheSize || 0);
        }
      }
    });
  }, []);

  // Lắng nghe sự kiện điều hướng từ các màn hình khác (ví dụ: link điều khoản trong modal đăng nhập)
  useEffect(() => {
    const handler = (e: Event) => {
      const { tab, subtab } = (e as CustomEvent).detail || {};
      // Webhooks đã chuyển sang Công cụ → Ứng dụng, API & Webhook (link cũ vẫn tới đúng chỗ).
      if (tab === 'webhooks') {
        const app = useAppStore.getState();
        app.setPluginHubSection('webhooks');
        app.openPluginHub();
        return;
      }
      if (tab) setActiveTab(tab as SettingsTab);
      if (subtab) {
        if (tab === 'cloud') setCloudSubtab(toCloudSection(subtab));
        else setIntroSubtab(subtab);
      }
    };
    window.addEventListener('nav:settings', handler);
    return () => window.removeEventListener('nav:settings', handler);
  }, []);

  // Đánh dấu tab đã xem khi người dùng mở lần đầu
  useEffect(() => {
    if ((SETTINGS_WATCHLIST as readonly string[]).includes(activeTab)) {
      markTabSeen(activeTab);
      setSeenTabs(loadSeenTabs());
    }
    // Changelog: đánh dấu đã đọc log phiên bản hiện tại
    if (activeTab === 'changelog') {
      markChangelogSeen();
      setUnreadChangelog(false);
    }
  }, [activeTab]);

  const handleChangeStorageFolder = async () => {
    setChangingStorage(true);
    try {
      const folderRes = await ipc.db?.selectStorageFolder();
      if (!folderRes?.success || folderRes.canceled) return;
      const newFolder = folderRes.folder;
      if (!newFolder) return;

      // Thư mục đích đã có dữ liệu cũ → hỏi người dùng muốn làm gì
      if (folderRes.hasExistingData) {
        setPendingFolder(newFolder);
        return; // modal sẽ gọi applyStorageChange
      }

      // Thư mục trống → xác nhận sao chép bình thường
      const ok = await showConfirm({
        title: 'Đổi thư mục lưu trữ?',
        message: `Thư mục mới:\n${newFolder}\n\nDữ liệu hiện tại sẽ được sao chép sang đây.`,
        confirmText: 'Tiếp tục',
        variant: 'warning',
      });
      if (!ok) return;
      await applyStorageChange(newFolder, false);
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi đổi thư mục'), 'error');
    } finally {
      setChangingStorage(false);
    }
  };

  /** Áp dụng đổi thư mục - useExisting=true: chỉ đổi con trỏ, không copy */
  const applyStorageChange = async (newFolder: string, useExisting: boolean) => {
    setChangingStorage(true);
    setCopyProgress(0);
    setCopyTotal(0);

    // Lắng nghe progress event từ main process
    const unsub = ipc.on?.('db:copyProgress', (data: { copied: number; total?: number; done?: boolean }) => {
      setCopyProgress(data.copied);
      if (data.total) setCopyTotal(data.total);
    });

    try {
      const res = await ipc.db?.setStoragePath({ newFolder, useExisting });
      if (res?.success) {
        setStoragePath(newFolder);
        setActualDbPath(res.newPath || '');
        const msg = res.message || 'Đã đổi thư mục lưu trữ thành công!';
        const extra = res.mediaError ? ` (Media: ${res.mediaError})` : '';
        showNotification(msg + extra, res.mediaError ? 'warning' : 'success');
      } else {
        showNotification(extractApiError(res, 'Không thể đổi thư mục'), 'error');
      }
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi đổi thư mục'), 'error');
    } finally {
      unsub?.();
      setChangingStorage(false);
      setCopyProgress(0);
      setCopyTotal(0);
      setPendingFolder(null);
    }
  };

  const handleResetStoragePath = async () => {
    const ok = await showConfirm({
      title: 'Đặt lại thư mục mặc định?',
      message: 'Dữ liệu sẽ được sao chép về thư mục mặc định và áp dụng ngay.',
      confirmText: 'Đặt lại',
      variant: 'warning',
    });
    if (!ok) return;
    await applyStorageChange(defaultStoragePath, false);
  };

  // Filter nav items by permission - employee/simulation mode may hide certain tabs
  const { mode: empMode, permissions: empPermissions } = useEmployeeStore(useShallow(s => ({ mode: s.mode, permissions: s.permissions })));
  const hasSettingsPerm = (perm?: string) => {
    if (!perm) return true; // no permission required
    return useEmployeeStore.getState().hasPermission(perm);
  };
  // Internet & Đám mây (Cloudflare) chỉ dành cho máy chủ — máy nhân viên không thấy.
  const hideCloud = isEmployee || empMode === 'employee';
  const isVisible = (item: NavItem) => hasSettingsPerm(item.requiredPerm) && (item.id !== 'cloud' || !hideCloud);
  const visibleGroups = NAV_GROUPS
    .map(group => ({ ...group, items: group.items.filter(isVisible) }))
    .filter(group => group.items.length > 0);
  const visibleNavItems = visibleGroups.flatMap(group => group.items);
  // Chấm đỏ khi phần Cloudflare cần xem (lỗi token / địa chỉ / media / đồng bộ DB, hoặc vừa khôi phục).
  const cloudAlert = useCloudAlert(!hideCloud);

  // Guard: nếu activeTab không còn trong visibleNavItems (do đổi workspace/quyền) → reset về tab đầu tiên
  useEffect(() => {
    const visible = visibleNavItems.some(item => item.id === activeTab);
    if (!visible && visibleNavItems.length > 0) {
      setActiveTab(visibleNavItems[0].id);
    }
  }, [empMode, empPermissions, hideCloud]);

  const dotFor = (id: SettingsTab): string | null => {
    if ((SETTINGS_WATCHLIST as readonly string[]).includes(id) && !seenTabs.has(id)) return 'Mới';
    if (id === 'changelog' && unreadChangelog) return 'Có bản cập nhật mới';
    if (id === 'cloud' && cloudAlert.reasons.length > 0) return cloudAlert.reasons.join(' · ');
    return null;
  };

  return (
    <>
    <div className="flex h-full overflow-hidden">
      {/* ─── Menu trái ─── */}
      <nav aria-label="Cài đặt" className="flex w-52 flex-shrink-0 flex-col overflow-y-auto border-r border-border bg-card pb-4 pt-4">
        <p className="px-5 text-base font-semibold text-foreground">Cài đặt</p>
        {visibleGroups.map(group => (
          <div key={group.label} className="pt-4">
            <p className="px-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{group.label}</p>
            {group.items.map(item => {
              const active = activeTab === item.id;
              const dot = dotFor(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => { setActiveTab(item.id); setCloudSubtab(null); }}
                  className={cn(
                    'relative flex w-full items-center gap-2.5 px-5 py-2 text-left text-sm transition-colors',
                    active ? 'bg-selected font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {active && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-[3px] rounded-r-full bg-primary" />}
                  <span className="flex-shrink-0">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {/* Chấm đỏ: tab mới chưa xem / log phiên bản chưa đọc / Internet & Đám mây cần xem */}
                  {dot && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-destructive" title={dot} aria-label={dot} />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ─── Trang ─── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {activeTab === 'appearance' && <AppearancePage />}
        {activeTab === 'notifications' && <NotificationsPage />}
        {activeTab === 'accounts' && <AccountSettings />}
        {activeTab === 'storage' && (
          <StoragePage
            isEmployee={isEmployee}
            storagePath={storagePath}
            defaultStoragePath={defaultStoragePath}
            actualDbPath={actualDbPath}
            mediaCachePath={mediaCachePath}
            mediaCacheSize={mediaCacheSize}
            changing={changingStorage}
            copyProgress={copyProgress}
            copyTotal={copyTotal}
            onChangeFolder={handleChangeStorageFolder}
            onReset={handleResetStoragePath}
          />
        )}
        {activeTab === 'conversation' && <ConversationSettings />}
        {activeTab === 'security' && <LockScreenSettings />}
        {activeTab === 'logs' && <LogViewer />}
        {activeTab === 'proxy' && <ProxySettings />}
        {activeTab === 'employees' && <EmployeeSettings />}
        {activeTab === 'workspace' && <WorkspaceSettings />}
        {/* Internet & Đám mây (Cloudflare, chỉ máy chủ) */}
        {activeTab === 'cloud' && !hideCloud && <CloudSettings initialSubtab={cloudSubtab} />}
        {activeTab === 'introduction' && <IntroductionSettings initialSubtab={introSubtab as any} />}
        {activeTab === 'changelog' && <ChangelogSettings />}
      </main>
    </div>

    {/* ── Thư mục đích đã có dữ liệu: dùng dữ liệu đó hay ghi đè bằng dữ liệu hiện tại ── */}
    {pendingFolder && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onClick={() => !changingStorage && setPendingFolder(null)}>
        <div role="dialog" aria-modal="true" aria-labelledby="storage-existing-title"
          className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
          onClick={e => e.stopPropagation()}>
          <div className="border-b border-border px-5 pb-3 pt-5">
            <h3 id="storage-existing-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
              <FolderIcon className="h-5 w-5 text-primary" /> Thư mục đã có dữ liệu
            </h3>
            <PathText value={pendingFolder} className="mt-2" />
            <p className="mt-2 text-xs text-muted-foreground">Ở đây đã có file dữ liệu Deplao. Bạn muốn làm gì?</p>
          </div>

          <div className="space-y-2.5 p-4">
            <button
              type="button"
              disabled={changingStorage}
              onClick={() => applyStorageChange(pendingFolder, true)}
              className="flex w-full items-start gap-3 rounded-xl border-2 border-primary bg-primary/5 p-3.5 text-left transition-colors hover:bg-primary/10 disabled:opacity-50"
            >
              <HardDriveIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Dùng dữ liệu có sẵn ở đây</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Dữ liệu hiện tại vẫn giữ ở chỗ cũ, không bị xoá.</p>
              </div>
            </button>

            <button
              type="button"
              disabled={changingStorage}
              onClick={async () => {
                const ok = await showConfirm({
                  title: 'Ghi đè dữ liệu cũ?',
                  message: `Dữ liệu hiện tại sẽ được sao chép vào:\n${pendingFolder}\n\nFile deplao-tool.db cũ tại đó sẽ bị GHI ĐÈ. Thao tác không thể hoàn tác.`,
                  confirmText: 'Ghi đè',
                  variant: 'danger',
                });
                if (!ok) return;
                await applyStorageChange(pendingFolder, false);
              }}
              className="flex w-full items-start gap-3 rounded-xl border border-border p-3.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <FolderIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Chép dữ liệu hiện tại sang đây</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Chép cả ảnh, video, file. <span className="text-destructive">Dữ liệu cũ ở đây sẽ bị ghi đè.</span>
                </p>
              </div>
            </button>
          </div>

          <div className="px-4 pb-4">
            {changingStorage && (
              <div className="mb-3 rounded-xl bg-muted px-3 py-3">
                {copyProgress > 0 ? (
                  <>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-medium text-primary">
                        <span className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        Đang chép ảnh, file...
                      </span>
                      <span className="font-mono tabular-nums text-foreground/80">
                        {copyProgress.toLocaleString()}
                        {copyTotal > 0 && <span className="text-muted-foreground"> / {copyTotal.toLocaleString()}</span>}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-200"
                        style={{ width: copyTotal > 0 ? `${Math.min(100, (copyProgress / copyTotal) * 100).toFixed(1)}%` : '100%' }}
                      />
                    </div>
                    {copyTotal > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {((copyProgress / copyTotal) * 100).toFixed(0)}% - đừng đóng ứng dụng
                      </p>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    Đang chuẩn bị...
                  </div>
                )}
              </div>
            )}
            <Button variant="ghost" className="w-full" disabled={changingStorage} onClick={() => setPendingFolder(null)}>
              {changingStorage ? 'Đang xử lý...' : 'Huỷ'}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ─── Giao diện ──────────────────────────────────────────────────────────────────────────

/** Màu xem trước của từng chủ đề (cố định, để thẻ "Tối" vẫn tối khi app đang sáng và ngược lại). */
const THEME_PREVIEW = {
  dark: { bg: '#131518', panel: '#1c1f25', line: '#373f49', primary: '#2f7bff' },
  light: { bg: '#eceef3', panel: '#ffffff', line: '#dde1e7', primary: '#1f6bf2' },
} as const;

function ThemeCard({ label, icon, preview, active, onSelect }: {
  label: string;
  icon: React.ReactNode;
  preview: (typeof THEME_PREVIEW)[keyof typeof THEME_PREVIEW];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        'w-44 rounded-xl border-2 p-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-primary' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex h-20 gap-1.5 overflow-hidden rounded-lg p-1.5" style={{ backgroundColor: preview.bg }}>
        <div className="w-7 rounded-md" style={{ backgroundColor: preview.panel }} />
        <div className="flex flex-1 flex-col justify-end gap-1.5 rounded-md p-1.5" style={{ backgroundColor: preview.panel }}>
          <div className="h-2 w-3/4 rounded-full" style={{ backgroundColor: preview.line }} />
          <div className="h-2 w-1/2 self-end rounded-full" style={{ backgroundColor: preview.primary }} />
          <div className="h-2 w-2/3 rounded-full" style={{ backgroundColor: preview.line }} />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-1 text-sm">
        <span className={active ? 'text-primary' : 'text-muted-foreground'}>{icon}</span>
        <span className={cn('flex-1', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
        {active && <CheckIcon className="h-4 w-4 text-primary" />}
      </div>
    </button>
  );
}

function AppearancePage() {
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);
  const fontSizeScale = useAppStore(s => s.fontSizeScale);
  const setFontSizeScale = useAppStore(s => s.setFontSizeScale);
  const [showDesignSystem, setShowDesignSystem] = useState(false);
  // Kéo thanh cỡ chữ: hiện số ngay, áp dụng khi thả (đổi cỡ chữ vẽ lại cả app)
  const [fontDraft, setFontDraft] = useState(fontSizeScale);
  useEffect(() => { setFontDraft(fontSizeScale); }, [fontSizeScale]);
  const commitFont = () => { if (fontDraft !== fontSizeScale) setFontSizeScale(fontDraft); };
  const px = (scale: number) => Math.round(16 * scale);

  return (
    <SettingsPage title="Giao diện" description="Màu nền và cỡ chữ, áp dụng ngay.">
      <SettingsSection title="Chủ đề" flush bodyClassName="p-4">
        <div role="radiogroup" aria-label="Chủ đề" className="flex flex-wrap gap-3">
          <ThemeCard label="Sáng" icon={<SunIcon className="h-4 w-4" />} preview={THEME_PREVIEW.light}
            active={theme === 'light'} onSelect={() => setTheme('light')} />
          <ThemeCard label="Tối" icon={<MoonIcon className="h-4 w-4" />} preview={THEME_PREVIEW.dark}
            active={theme === 'dark'} onSelect={() => setTheme('dark')} />
        </div>
      </SettingsSection>

      <SettingsSection title="Cỡ chữ">
        <SettingsRow
          title={`${px(fontDraft)} px`}
          description="Cỡ chữ của cả ứng dụng. Cũng chỉnh được ở thanh tiêu đề."
          control={px(fontDraft) !== 16 && (
            <Button variant="ghost" size="sm" onClick={() => { setFontDraft(1); setFontSizeScale(1); }}>Mặc định</Button>
          )}
        >
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">A</span>
            <input
              type="range"
              aria-label="Cỡ chữ"
              min={FONT_SCALE_MIN}
              max={FONT_SCALE_MAX}
              step={FONT_SCALE_STEP}
              value={fontDraft}
              onChange={e => setFontDraft(Number(e.target.value))}
              onMouseUp={commitFont}
              onTouchEnd={commitFont}
              onKeyUp={commitFont}
              onBlur={commitFont}
              className="w-64 accent-primary"
            />
            <span className="text-base text-muted-foreground">A</span>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          title="Bộ giao diện"
          description="Màu và các thành phần giao diện dùng chung (cho người phát triển)."
          control={<Button variant="outline" size="sm" onClick={() => setShowDesignSystem(v => !v)}>{showDesignSystem ? 'Ẩn' : 'Xem'}</Button>}
        >
          {showDesignSystem ? <DesignSystemPage /> : undefined}
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}

// ─── Thông báo ──────────────────────────────────────────────────────────────────────────

function NotificationsPage() {
  const accounts = useAccountStore(s => s.accounts);
  const {
    showNotification, notifSettings, setNotifSettings, notifSettingsOverrides, getNotifSettingsForAccount,
    setNotifSettingsForAccount, resetNotifSettingsForAccount,
  } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, notifSettings: s.notifSettings, setNotifSettings: s.setNotifSettings,
    notifSettingsOverrides: s.notifSettingsOverrides, getNotifSettingsForAccount: s.getNotifSettingsForAccount,
    setNotifSettingsForAccount: s.setNotifSettingsForAccount, resetNotifSettingsForAccount: s.resetNotifSettingsForAccount,
  })));
  const [selectedNotifAccount, setSelectedNotifAccount] = useState<string>('__global__');

  const isGlobal = selectedNotifAccount === '__global__';
  const settings = isGlobal ? notifSettings : getNotifSettingsForAccount(selectedNotifAccount);
  const saveSettings = isGlobal
    ? setNotifSettings
    : (partial: any) => setNotifSettingsForAccount(selectedNotifAccount, partial);
  const hasOverride = !isGlobal && !!notifSettingsOverrides[selectedNotifAccount];

  const accountOption = (acc: (typeof accounts)[number]) => (
    <option key={acc.zalo_id} value={acc.zalo_id}>
      {acc.full_name || acc.zalo_id}{notifSettingsOverrides[acc.zalo_id] ? ' · riêng' : ''}
    </option>
  );
  const zaloAccounts = accounts.filter(a => isZalo(a.channel));
  const facebookAccounts = accounts.filter(a => isFacebook(a.channel));
  const telegramAccounts = accounts.filter(a => isTelegram(a.channel));

  return (
    <SettingsPage title="Thông báo" description="Cách Deplao báo tin nhắn mới. Lưu riêng trên máy này.">
      <SettingsSection
        title="Popup và âm thanh"
        footer="Hội thoại đã tắt thông báo sẽ không báo. Không thấy popup? Bật thông báo cho Deplao trong cài đặt Windows / macOS."
        action={(
          <Select
            aria-label="Áp dụng cho tài khoản"
            value={selectedNotifAccount}
            onChange={e => setSelectedNotifAccount(e.target.value)}
            wrapperClassName="w-60"
            className="h-8 text-xs"
          >
            <option value="__global__">Tất cả tài khoản (mặc định)</option>
            {zaloAccounts.length > 0 && <optgroup label="Zalo">{zaloAccounts.map(accountOption)}</optgroup>}
            {facebookAccounts.length > 0 && <optgroup label="Facebook">{facebookAccounts.map(accountOption)}</optgroup>}
            {telegramAccounts.length > 0 && <optgroup label="Telegram">{telegramAccounts.map(accountOption)}</optgroup>}
          </Select>
        )}
      >
        {!isGlobal && (
          <div className="flex flex-wrap items-center gap-2 py-2.5 text-xs text-muted-foreground">
            {hasOverride ? (
              <>
                <span>Tài khoản này đang dùng cài đặt riêng.</span>
                <Button variant="link" size="sm" className="text-xs" onClick={() => resetNotifSettingsForAccount(selectedNotifAccount)}>
                  Dùng mặc định
                </Button>
              </>
            ) : (
              <span>Đang theo mặc định. Đổi bên dưới để đặt riêng cho tài khoản này.</span>
            )}
          </div>
        )}
        <SettingsRow
          title="Popup trên màn hình"
          description="Hiện ở góc màn hình khi có tin mới."
          control={(
            <Switch
              aria-label="Popup trên màn hình"
              checked={settings.desktopEnabled}
              onCheckedChange={(v) => {
                if (v) requestNotificationPermission().then(granted => {
                  if (!granted) { showNotification('Máy đang chặn thông báo của Deplao. Hãy cho phép trong cài đặt hệ thống.', 'warning'); return; }
                  saveSettings({ desktopEnabled: true });
                });
                else saveSettings({ desktopEnabled: false });
              }}
            />
          )}
        />
        <SettingsRow
          title="Âm thanh"
          description="Phát tiếng khi có tin mới."
          control={<Switch aria-label="Âm thanh thông báo" checked={settings.soundEnabled} onCheckedChange={(v) => saveSettings({ soundEnabled: v })} />}
        >
          {settings.soundEnabled ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Âm lượng</span>
              <input type="range" min="0" max="100" step="5" aria-label="Âm lượng"
                value={Math.round(settings.volume * 100)}
                onChange={e => saveSettings({ volume: parseInt(e.target.value) / 100 })}
                className="w-56 accent-primary" />
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Math.round(settings.volume * 100)}%</span>
            </div>
          ) : undefined}
        </SettingsRow>
        <SettingsRow
          title="Thử thông báo"
          control={(
            <>
              <Button variant="outline" size="sm"
                onClick={() => { if (settings.soundEnabled) playNotificationSound(settings.volume); else showNotification('Hãy bật âm thanh trước', 'info'); }}>
                Âm thanh
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => {
                  requestNotificationPermission().then(granted => {
                    if (!granted) { showNotification('Cần cấp quyền thông báo', 'warning'); return; }
                    showDesktopNotification('Deplao', 'Đây là thông báo thử nghiệm 🎉');
                  });
                }}>
                Popup
              </Button>
            </>
          )}
        />
      </SettingsSection>

      <SettingsSection title="Thông báo trong app" description="Thẻ tin nhắn mới ở góc trên bên phải khi đang dùng app." flush bodyClassName="p-2">
        <InAppNotifySettings />
      </SettingsSection>

      {/* Tự mở cùng máy: khởi động lại máy xong không phải nhớ mở Deplao (lưu theo máy) */}
      <SettingsSection title="Khởi động cùng máy" flush bodyClassName="p-4">
        <AutoLaunchSettings />
      </SettingsSection>
    </SettingsPage>
  );
}

// ─── Lưu trữ ────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  return bytes > 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StoragePage({
  isEmployee, storagePath, defaultStoragePath, actualDbPath, mediaCachePath, mediaCacheSize, changing, copyProgress, copyTotal,
  onChangeFolder, onReset,
}: {
  isEmployee: boolean;
  storagePath: string;
  defaultStoragePath: string;
  actualDbPath: string;
  mediaCachePath: string;
  mediaCacheSize: number;
  changing: boolean;
  copyProgress: number;
  copyTotal: number;
  onChangeFolder: () => void;
  onReset: () => void;
}) {
  if (isEmployee) {
    // Máy nhân viên: chỉ có bộ nhớ đệm, dữ liệu gốc do máy chủ quản lý
    return (
      <SettingsPage title="Lưu trữ" description="Máy nhân viên: dữ liệu gốc nằm trên máy chủ.">
        <SettingsSection title="Bộ nhớ đệm trên máy này" description="Ảnh, video, file đã xem được giữ lại để lần sau mở nhanh. Tự dọn khi quá 2 GB.">
          <SettingsRow
            title="Thư mục"
            control={mediaCachePath ? (
              <Button variant="outline" size="sm" onClick={() => ipc.file?.openPath(mediaCachePath)} leftIcon={<FolderIcon className="h-4 w-4" />}>Mở</Button>
            ) : undefined}
          >
            <PathText value={mediaCachePath || 'Đang tải...'} />
          </SettingsRow>
          <SettingsRow
            title="Dung lượng"
            control={<span className="text-sm font-medium text-foreground">{mediaCacheSize > 0 ? formatBytes(mediaCacheSize) : 'Đang tính...'}</span>}
          />
        </SettingsSection>
      </SettingsPage>
    );
  }

  // Ổ C: của Windows: dễ đầy, mất khi cài lại Windows → gợi ý chuyển (đã ở ổ khác thì không nhắc)
  const onSystemDrive = /^c:[\\/]/i.test(storagePath);
  const mismatch = !!actualDbPath && !!storagePath && !actualDbPath.startsWith(storagePath);
  const progressText = copyProgress > 0
    ? `${copyProgress.toLocaleString()}${copyTotal > 0 ? ` / ${copyTotal.toLocaleString()}` : ''} file…`
    : 'Đang xử lý...';

  return (
    <SettingsPage title="Lưu trữ" description="Nơi lưu tin nhắn, danh bạ, ảnh và file trên máy này.">
      {onSystemDrive && (
        <Notice tone="warning" title="Nên chuyển dữ liệu khỏi ổ C:">
          <p>Ổ C: hay đầy và bị xoá khi cài lại Windows. Chuyển sang ổ D:, E: hoặc ổ ngoài, dữ liệu tự chép sang.</p>
        </Notice>
      )}
      {mismatch && (
        <Notice tone="destructive" title="Dữ liệu đang đọc ở thư mục khác">
          <p>Thường do cập nhật app. Bấm "Chọn thư mục khác" và trỏ lại đúng thư mục chứa dữ liệu.</p>
        </Notice>
      )}

      <SettingsSection title="Thư mục dữ liệu" description="Đổi thư mục thì dữ liệu tự chép sang và dùng ngay, không cần mở lại app.">
        <SettingsRow
          title="Thư mục"
          control={(
            <>
              {storagePath && storagePath !== defaultStoragePath && (
                <Button variant="ghost" size="sm" onClick={onReset} disabled={changing}>Đặt lại mặc định</Button>
              )}
              {storagePath && (
                <Button variant="outline" size="sm" onClick={() => ipc.file?.openPath(storagePath)} leftIcon={<FolderIcon className="h-4 w-4" />}>Mở</Button>
              )}
              <Button size="sm" onClick={onChangeFolder} disabled={changing}>
                {changing ? progressText : 'Chọn thư mục khác'}
              </Button>
            </>
          )}
        >
          <PathText value={storagePath || 'Đang tải...'} />
          {actualDbPath && (
            <p className="mt-1.5 truncate text-xs text-muted-foreground" title={actualDbPath}>File dữ liệu: {actualDbPath}</p>
          )}
        </SettingsRow>
      </SettingsSection>

      {/* Media trên đám mây (Cloudflare R2 / Google Drive), chỉ máy chủ, bản app có module Cloudflare */}
      <CloudMediaSummary />
    </SettingsPage>
  );
}
