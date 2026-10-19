import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIcon,
  BarChartIcon,
  BellIcon,
  BookIcon,
  BotIcon,
  BriefcaseIcon,
  CalendarIcon,
  CampaignIcon,
  ChartIcon,
  ChatIcon,
  ClipboardIcon,
  ClipboardListIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  HardDriveIcon,
  HelpCircleIcon,
  HomeIcon,
  InboxIcon,
  KeyIcon,
  LinkIcon,
  MessageIcon,
  PackageIcon,
  PaletteIcon,
  PluginIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TagIcon,
  TargetIcon,
  TruckIcon,
  UserCheckIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
  WebhookIcon,
  WrenchIcon,
} from '@/components/common/icons';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useCRMStore, CRMTabView } from '@/store/crmStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { usePluginStore } from '@/store/pluginStore';
import { FeatureVisibilityKey, useFeatureVisibilityStore } from '@/store/featureVisibilityStore';
import PluginAvatar from '@/components/plugins/PluginAvatar';
import { pluginLauncherItems } from '@/components/plugins/pluginLauncher';

type FeatureSection = 'Truy cập chính' | 'CRM' | 'Workflow' | 'Tích hợp' | 'Báo cáo' | 'Quản lý công việc' | 'Ứng dụng, API & Webhook' | 'Cài đặt';

interface FeatureNode {
  id: string;
  section: FeatureSection;
  label: string;
  description: string;
  icon: React.ReactNode;
  /** Thay ô icon (vd. biểu tượng riêng của ứng dụng). */
  avatar?: React.ReactNode;
  onClick: () => void;
}

interface FeatureLauncherPanelProps {
  onClose: () => void;
}

/**
 * Flat launcher for the existing application navigation.
 * Every card is an independent destination; it deliberately does not duplicate
 * channel filters or create a second menu hierarchy.
 */
export default function FeatureLauncherPanel({ onClose }: FeatureLauncherPanelProps) {
  const theme = useAppStore(state => state.theme);
  const visibility = useFeatureVisibilityStore(state => state.enabled);
  const toggleFeature = useFeatureVisibilityStore(state => state.toggle);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const plugins = usePluginStore(state => state.plugins);
  const pluginPages = usePluginStore(state => state.contributions.pages);
  const isEmployee = useEmployeeStore(state => state.mode === 'employee');
  const isDark = theme === 'dark';

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const openView = (view: string, eventName?: string, detail?: Record<string, unknown>) => {
    onClose();
    window.dispatchEvent(new CustomEvent('nav:view', { detail: { view } }));
    if (eventName) {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(eventName, { detail })), 80);
    }
  };

  const openSettings = (tab: string, subtab?: string) => openView('settings', 'nav:settings', { tab, subtab });
  const openCRM = (tab: CRMTabView) => {
    useCRMStore.getState().setTab(tab);
    openView('crm');
  };
  const openAnalytics = (tab: string) => {
    onClose();
    useAppStore.getState().navigateToAnalytics(tab);
  };

  const nodes = useMemo<FeatureNode[]>(() => [
    // Main destinations — Chat intentionally remains a single node.
    { id: 'dashboard', section: 'Truy cập chính', label: 'Dashboard', description: 'Tổng quan tài khoản, trạng thái kết nối và hoạt động gần đây', icon: <HomeIcon />, onClick: () => openView('dashboard') },
    { id: 'chat', section: 'Truy cập chính', label: 'Chat', description: 'Hộp thư đa kênh để đọc, tìm kiếm và gửi tin nhắn', icon: <ChatIcon />, onClick: () => openView('chat') },

    // CRM tabs from CRMPage — each is a real tab, not a placeholder.
    { id: 'crm-search', section: 'CRM', label: 'Tìm kiếm', description: 'Tìm liên hệ theo tên, số điện thoại hoặc UID', icon: <SearchIcon />, onClick: () => openCRM('search') },
    { id: 'crm-contacts', section: 'CRM', label: 'Liên hệ', description: 'Xem, lọc, gắn nhãn và quản lý danh sách khách hàng', icon: <UserIcon />, onClick: () => openCRM('contacts') },
    { id: 'crm-groups', section: 'CRM', label: 'Nhóm', description: 'Quản lý nhóm và truy cập các công cụ thành viên', icon: <UsersIcon />, onClick: () => openCRM('groups') },
    { id: 'crm-requests', section: 'CRM', label: 'Lời mời', description: 'Xem và xử lý các lời mời kết bạn đang chờ', icon: <UserPlusIcon />, onClick: () => openCRM('requests') },
    { id: 'crm-campaigns', section: 'CRM', label: 'Chiến dịch', description: 'Tạo, cấu hình và theo dõi các chiến dịch gửi tin', icon: <CampaignIcon />, onClick: () => openCRM('campaigns') },
    { id: 'crm-history', section: 'CRM', label: 'Lịch sử', description: 'Kiểm tra lịch sử gửi và kết quả của chiến dịch', icon: <ClipboardListIcon />, onClick: () => openCRM('history') },
    { id: 'crm-scan', section: 'CRM', label: 'Quét dữ liệu', description: 'Tạo phiên quét thành viên và dữ liệu nhóm', icon: <DatabaseIcon />, onClick: () => openCRM('scan') },
    { id: 'crm-scan-history', section: 'CRM', label: 'Lịch sử quét', description: 'Xem lại các phiên quét đã chạy và trạng thái xử lý', icon: <FileTextIcon />, onClick: () => openCRM('scan_history') },
    { id: 'crm-scan-stats', section: 'CRM', label: 'Thống kê quét', description: 'Theo dõi kết quả, số lượng và tỷ lệ thành công của phiên quét', icon: <ChartIcon />, onClick: () => openCRM('scan_stats') },

    // Workflow has only the two requested destinations.
    { id: 'workflow-list', section: 'Workflow', label: 'Danh sách workflow', description: 'Quản lý, tạo mới, bật/tắt và chỉnh sửa workflow', icon: <WrenchIcon />, onClick: () => openView('workflow', 'nav:workflow', { subview: 'list' }) },
    { id: 'workflow-store', section: 'Workflow', label: 'Kho mẫu', description: 'Chọn workflow mẫu để dùng ngay hoặc tùy chỉnh theo nhu cầu', icon: <FolderIcon />, onClick: () => openView('workflow', 'nav:workflow', { subview: 'store' }) },

    // Integration tabs from IntegrationPage.
    { id: 'integration-all', section: 'Tích hợp', label: 'Tất cả tích hợp', description: 'Xem toàn bộ kết nối và dịch vụ đang được hỗ trợ', icon: <PluginIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'all' }) },
    { id: 'integration-pos', section: 'Tích hợp', label: 'POS / Bán hàng', description: 'Kết nối KiotViet, Haravan, Sapo, Nhanh.vn và Pancake', icon: <ShoppingCartIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'pos' }) },
    { id: 'integration-payment', section: 'Tích hợp', label: 'Thanh toán', description: 'Cấu hình Casso và SePay để nhận giao dịch tự động', icon: <CreditCardIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'payment' }) },
    { id: 'integration-shipping', section: 'Tích hợp', label: 'Vận chuyển', description: 'Kết nối GHN, GHTK và các dịch vụ giao hàng', icon: <TruckIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'shipping' }) },
    { id: 'integration-messaging', section: 'Tích hợp', label: 'Tin nhắn', description: 'Cấu hình kết nối Telegram Bot và dịch vụ nhắn tin', icon: <MessageIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'messaging' }) },
    { id: 'integration-ai', section: 'Tích hợp', label: 'Trợ lý AI', description: 'Kết nối OpenAI, Gemini, Claude, DeepSeek, Grok và OpenRouter', icon: <BotIcon />, onClick: () => openView('integration', 'nav:integration', { tab: 'ai' }) },

    // Analytics tabs from AnalyticsPage.
    { id: 'analytics-overview', section: 'Báo cáo', label: 'Tổng quan', description: 'Tổng hợp các chỉ số hoạt động quan trọng của workspace', icon: <BarChartIcon />, onClick: () => openAnalytics('overview') },
    { id: 'analytics-messages', section: 'Báo cáo', label: 'Tin nhắn', description: 'Sản lượng gửi, tỷ lệ thành công và thời gian phản hồi', icon: <MessageIcon />, onClick: () => openAnalytics('messages') },
    { id: 'analytics-contacts', section: 'Báo cáo', label: 'Liên hệ', description: 'Theo dõi tăng trưởng và phân loại liên hệ', icon: <UserCheckIcon />, onClick: () => openAnalytics('contacts') },
    { id: 'analytics-labels', section: 'Báo cáo', label: 'Nhãn', description: 'Phân tích mức độ sử dụng và phân bổ nhãn', icon: <TagIcon />, onClick: () => openAnalytics('labels') },
    { id: 'analytics-employees', section: 'Báo cáo', label: 'Nhân viên', description: 'Báo cáo hiệu suất và hoạt động của nhân viên', icon: <UsersIcon />, onClick: () => openAnalytics('employees') },
    { id: 'analytics-campaigns', section: 'Báo cáo', label: 'Chiến dịch', description: 'Đánh giá hiệu quả các chiến dịch gửi tin', icon: <TargetIcon />, onClick: () => openAnalytics('campaigns') },
    { id: 'analytics-workflows', section: 'Báo cáo', label: 'Workflow', description: 'Theo dõi số lượt chạy, lỗi và tỷ lệ thành công', icon: <ActivityIcon />, onClick: () => openAnalytics('workflow') },
    { id: 'analytics-ai', section: 'Báo cáo', label: 'AI', description: 'Theo dõi lượt dùng, token và model AI', icon: <SparklesIcon />, onClick: () => openAnalytics('ai') },

    // ERP navigation from ErpPage.
    { id: 'erp-inbox', section: 'Quản lý công việc', label: 'Của tôi', description: 'Danh sách việc cần xử lý và nhắc việc cá nhân', icon: <InboxIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'inbox' }) },
    { id: 'erp-tasks', section: 'Quản lý công việc', label: 'Task', description: 'Bảng công việc, trạng thái và người được giao', icon: <ClipboardIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'tasks' }) },
    { id: 'erp-calendar', section: 'Quản lý công việc', label: 'Lịch', description: 'Lịch làm việc, lịch hẹn và các mốc quan trọng', icon: <CalendarIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'calendar' }) },
    { id: 'erp-notes', section: 'Quản lý công việc', label: 'Note', description: 'Ghi chú nội bộ, tài liệu và nội dung chia sẻ', icon: <FileTextIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'notes' }) },
    { id: 'erp-hrm', section: 'Quản lý công việc', label: 'Nhân sự', description: 'Hồ sơ nhân sự, phân quyền và thông tin nhân viên', icon: <BriefcaseIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'hrm' }) },
    { id: 'erp-reports', section: 'Quản lý công việc', label: 'Báo cáo công việc', description: 'Theo dõi tiến độ, khối lượng và kết quả công việc', icon: <ChartIcon />, onClick: () => openView('erp', 'nav:erp', { subView: 'reports' }) },

    // Settings navigation from Settings.tsx.
    { id: 'settings-conversation', section: 'Cài đặt', label: 'Hội thoại', description: 'Tùy chỉnh cách hiển thị và xử lý hội thoại', icon: <ChatIcon />, onClick: () => openSettings('conversation') },
    { id: 'settings-appearance', section: 'Cài đặt', label: 'Giao diện', description: 'Theme, cỡ chữ và các tùy chỉnh hiển thị', icon: <PaletteIcon />, onClick: () => openSettings('appearance') },
    { id: 'settings-notifications', section: 'Cài đặt', label: 'Thông báo', description: 'Cấu hình âm thanh và thông báo desktop', icon: <BellIcon />, onClick: () => openSettings('notifications') },
    { id: 'settings-account', section: 'Cài đặt', label: 'Tài khoản', description: 'Quản lý tài khoản, phiên đăng nhập và kết nối', icon: <KeyIcon />, onClick: () => openSettings('accounts') },
    { id: 'settings-proxy', section: 'Cài đặt', label: 'Proxy', description: 'Cấu hình proxy cho các kết nối mạng', icon: <GlobeIcon />, onClick: () => openSettings('proxy') },
    { id: 'settings-security', section: 'Cài đặt', label: 'Bảo mật', description: 'Khóa ứng dụng và thiết lập bảo vệ dữ liệu', icon: <ShieldIcon />, onClick: () => openSettings('security') },
    { id: 'settings-employees', section: 'Cài đặt', label: 'Nhân viên', description: 'Quản lý nhân viên, vai trò và quyền truy cập', icon: <UsersIcon />, onClick: () => openSettings('employees') },
    { id: 'settings-workspace', section: 'Cài đặt', label: 'Workspace', description: 'Thiết lập không gian làm việc hiện tại', icon: <ServerIcon />, onClick: () => openSettings('workspace') },
    { id: 'settings-storage', section: 'Cài đặt', label: 'Lưu trữ', description: 'Quản lý thư mục dữ liệu, media và bộ nhớ', icon: <HardDriveIcon />, onClick: () => openSettings('storage') },
    { id: 'settings-introduction', section: 'Cài đặt', label: 'Giới thiệu', description: 'Hướng dẫn sử dụng và thông tin về Deplao', icon: <BookIcon />, onClick: () => openSettings('introduction', 'overview') },
    { id: 'settings-changelog', section: 'Cài đặt', label: 'Log phiên bản', description: 'Xem các thay đổi và tính năng mới theo phiên bản', icon: <FileIcon />, onClick: () => openSettings('changelog') },
    { id: 'settings-logs', section: 'Cài đặt', label: 'Nhật ký', description: 'Xem log hoạt động và chẩn đoán lỗi ứng dụng', icon: <ActivityIcon />, onClick: () => openSettings('logs') },
  ], []);

  // Ứng dụng, API & Webhook: trang Ứng dụng, API, Webhook, phát triển ứng dụng, rồi từng ứng dụng đang bật (mỗi trang là một ô).
  const pluginNodes = useMemo<FeatureNode[]>(() => {
    if (!ipc.plugins || isEmployee) return [];
    const app = useAppStore.getState();
    return pluginLauncherItems(plugins, pluginPages).map(item => ({
      id: item.id,
      section: 'Ứng dụng, API & Webhook' as const,
      label: item.label,
      description: item.description,
      icon: item.id === 'plugin-dev' ? <WrenchIcon /> : item.id === 'plugin-api' ? <KeyIcon /> : item.id === 'plugin-webhooks' ? <WebhookIcon /> : <PluginIcon />,
      avatar: item.plugin ? <PluginAvatar id={item.plugin.id} name={item.plugin.name} icon={item.plugin.icon} size={36} rounded={10} /> : undefined,
      onClick: () => {
        onClose();
        const t = item.target;
        if (t.kind === 'page') app.openPluginPage(t.pluginId, t.pageId);
        else if (t.kind === 'api' || t.kind === 'webhooks') { app.setPluginHubSection(t.kind); app.openPluginHub(); }
        else { app.setPluginHubSection('plugins'); app.setPluginHubTab(t.tab); app.openPluginHub(); }
      },
    }));
  }, [plugins, pluginPages, isEmployee, onClose]);

  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return [...nodes, ...pluginNodes].filter(node => !normalized || `${node.label} ${node.description} ${node.section}`.toLocaleLowerCase().includes(normalized));
  }, [nodes, pluginNodes, query]);

  const sections = useMemo(() => {
    const order: FeatureSection[] = ['Truy cập chính', 'CRM', 'Workflow', 'Tích hợp', 'Báo cáo', 'Quản lý công việc', 'Ứng dụng, API & Webhook', 'Cài đặt'];
    const toggleable: FeatureSection[] = ['CRM', 'Workflow', 'Tích hợp', 'Báo cáo', 'Quản lý công việc', ...(pluginNodes.length ? ['Ứng dụng, API & Webhook' as const] : []), 'Cài đặt'];
    return order
      .map(section => ({ section, nodes: filteredNodes.filter(node => node.section === section) }))
      .filter(group => group.nodes.length > 0 || (!query.trim() && toggleable.includes(group.section)));
  }, [filteredNodes, query, pluginNodes.length]);

  const shell = isDark ? 'bg-background border-border text-foreground' : 'bg-background border-border text-gray-900';
  const muted = isDark ? 'text-muted-foreground' : 'text-subtle-foreground';
  const input = isDark ? 'bg-card border-border text-foreground placeholder-subtle-foreground' : 'bg-muted border-border text-gray-900 placeholder-subtle-foreground';
  const card = isDark
    ? 'border-border bg-background hover:border-blue-500/60 hover:bg-blue-500/10 hover:shadow-lg hover:shadow-blue-950/20'
    : 'border-border bg-muted hover:border-blue-400/70 hover:bg-accent hover:shadow-md hover:shadow-blue-100/60';
  const iconBox = isDark
    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 group-hover:bg-blue-500/20 group-hover:text-blue-300'
    : 'bg-blue-50 text-blue-600 border border-blue-100 group-hover:bg-blue-100 group-hover:text-blue-700';
  const sectionFeatureKey: Partial<Record<FeatureSection, FeatureVisibilityKey>> = {
    CRM: 'crm',
    Workflow: 'workflow',
    'Tích hợp': 'integration',
    'Báo cáo': 'analytics',
    'Quản lý công việc': 'erp',
    'Ứng dụng, API & Webhook': 'plugins',
    'Cài đặt': 'settings',
  };
  return (
    <div className="fixed inset-0 top-10 z-[9990]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <aside
        className={`absolute right-0 top-0 bottom-0 w-[min(600px,calc(100vw-12px))] border-l shadow-2xl flex flex-col ${shell}`}
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
        aria-label="Tất cả tính năng"
      >
        <div className={`px-5 py-4 border-b ${isDark ? 'border-border' : 'border-border'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Tất cả tính năng</h2>
              <p className={`text-xs mt-1 ${muted}`}>Truy cập nhanh các menu đã có trong Deplao</p>
            </div>
            <button onClick={onClose} className={`w-8 h-8 rounded-lg flex items-center justify-center ${muted} hover:text-current ${isDark ? 'hover:bg-card' : 'hover:bg-gray-100'}`} aria-label="Đóng">
              <span className="text-xl leading-none">×</span>
            </button>
          </div>
          <label className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 ${input}`}>
            <SearchIcon className={`w-4 h-4 flex-shrink-0 ${muted}`} />
            <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent outline-none text-sm" placeholder="Tìm tính năng..." />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {sections.length === 0 && <p className={`py-10 text-center text-sm ${muted}`}>Không tìm thấy tính năng phù hợp.</p>}
          {sections.map(group => (
            <section key={group.section}>
              {(() => {
                const feature = sectionFeatureKey[group.section];
                const enabled = !feature || visibility[feature];
                return (
                  <>
                    <div className="flex items-center justify-between px-1 mb-2">
                      <h3 className={`text-[11px] font-semibold uppercase tracking-wider ${muted}`}>{group.section}</h3>
                      {feature && (
                        <button
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`${enabled ? 'Tắt' : 'Bật'} ${group.section}`}
                          onClick={() => toggleFeature(feature)}
                          className={`relative left-0 w-9 h-5 rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-blue-600' : (isDark ? 'bg-muted' : 'bg-gray-300')}`}
                        >
                          <span className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                      )}
                    </div>
                    {enabled ? (
                      <div className="grid grid-cols-2 gap-2">
                        {group.nodes.map(node => (
                          <button key={node.id} onClick={node.onClick} className={`group w-full h-full flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${card}`}>
                            {node.avatar ? (
                              <span className="mt-0.5 flex-shrink-0">{node.avatar}</span>
                            ) : (
                              <span className={`mt-0.5 w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBox}`}>
                                {React.isValidElement(node.icon) ? React.cloneElement(node.icon as React.ReactElement<{ className?: string; size?: number }>, { className: 'w-5 h-5' }) : node.icon}
                              </span>
                            )}
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{node.label}</span>
                              <span className={`block mt-0.5 text-xs leading-5 ${muted}`}>{node.description}</span>
                            </span>
                            <span className={`ml-auto mt-1 text-base ${muted}`} aria-hidden="true">›</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className={`px-1 text-xs ${muted}`}>Đã ẩn khỏi thanh bên.</p>
                    )}
                  </>
                );
              })()}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
