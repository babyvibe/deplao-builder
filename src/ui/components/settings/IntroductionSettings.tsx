import React, { useState, useEffect } from 'react';
import { BookIcon, BotIcon, BugIcon, ChartIcon, ChatIcon, CloudIcon, CoffeeIcon, CreditCardIcon, FileTextIcon, FolderIcon, HomeIcon, LightningIcon, LockIcon, PackageIcon, PluginIcon, ShoppingCartIcon, SmartphoneIcon, TrendingUpIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { OverviewPanel } from './introduction/OverviewPanel';
import { MultiAccountPanel } from './introduction/MultiAccountPanel';
import { MessagingPanel } from './introduction/MessagingPanel';
import { HistorySyncPanel } from './introduction/HistorySyncPanel';
import { ErpPanel } from './introduction/ErpPanel';
import { CrmPanel } from './introduction/CrmPanel';
import { WorkflowPanel } from './introduction/WorkflowPanel';
import { IntegrationPOSPanel } from './introduction/IntegrationPOSPanel';
import { IntegrationPaymentPanel } from './introduction/IntegrationPaymentPanel';
import { IntegrationShippingPanel } from './introduction/IntegrationShippingPanel';
import { AppsApiPanel } from './introduction/AppsApiPanel';
import { AIAssistantPanel } from './introduction/AIAssistantPanel';
import { AnalyticsPanel } from './introduction/AnalyticsPanel';
import { DashboardPanel } from './introduction/DashboardPanel';
import { SecurityPanel } from './introduction/SecurityPanel';
import { EmployeesPanel } from './introduction/EmployeesPanel';
import { CloudPanel } from './introduction/CloudPanel';
import { PolicyPanel } from './introduction/PolicyPanel';
import { BugReportPanel } from './introduction/BugReportPanel';
import { DonateCoffeePanel } from './introduction/DonateCoffeePanel';

type FeatureId =
  | 'overview'
  | 'dashboard'
  | 'multiAccount'
  | 'messaging'
  | 'history-sync'
  | 'crm'
  | 'workflow'
  | 'integration-pos'
  | 'integration-payment'
  | 'integration-shipping'
  | 'apps-api'
  | 'ai-assistant'
  | 'analytics'
  | 'erp'
  | 'employees'
  | 'cloud'
  | 'security'
  | 'policy'
  | 'bugreport'
  | 'donate';

interface Feature {
  id: FeatureId;
  icon: React.ReactNode;
  label: string;
}

const FEATURES: Feature[] = [
  { id: 'overview',     icon: <HomeIcon className="w-4 h-4" />, label: 'Tổng quan' },
  { id: 'dashboard',    icon: <ChartIcon className="w-4 h-4" />, label: 'Dashboard' },
  { id: 'multiAccount', icon: <UserIcon className="w-4 h-4" />, label: 'Đa tài khoản' },
  { id: 'messaging',    icon: <ChatIcon className="w-4 h-4" />, label: 'Quản lý tin nhắn' },
  { id: 'history-sync', icon: <SmartphoneIcon className="w-4 h-4" />, label: 'Đồng bộ tin nhắn cũ' },
  { id: 'crm',          icon: <UsersIcon className="w-4 h-4" />, label: 'CRM & Khách hàng' },
  { id: 'workflow',     icon: <LightningIcon className="w-4 h-4" />, label: 'Workflow tự động' },
  { id: 'integration-pos', icon: <ShoppingCartIcon className="w-4 h-4" />, label: 'Tích hợp POS' },
  { id: 'integration-payment', icon: <CreditCardIcon className="w-4 h-4" />, label: 'Tích hợp thanh toán' },
  { id: 'integration-shipping', icon: <PackageIcon className="w-4 h-4" />, label: 'Tích hợp vận chuyển' },
  { id: 'apps-api',     icon: <PluginIcon className="w-4 h-4" />, label: 'Ứng dụng, API & Webhook' },
  { id: 'ai-assistant', icon: <BotIcon className="w-4 h-4" />, label: 'Trợ lý AI' },
  { id: 'analytics',    icon: <TrendingUpIcon className="w-4 h-4" />, label: 'Báo cáo & Phân tích' },
  { id: 'erp',          icon: <FolderIcon className="w-4 h-4" />, label: 'ERP quản trị nội bộ' },
  { id: 'employees',    icon: <UserIcon className="w-4 h-4" />, label: 'Cài đặt nhân viên & workspace' },
  { id: 'cloud',        icon: <CloudIcon className="w-4 h-4" />, label: 'Internet & Đám mây' },
  { id: 'security',     icon: <LockIcon className="w-4 h-4" />, label: 'Bảo mật & Dữ liệu' },
  { id: 'policy',       icon: <FileTextIcon className="w-4 h-4" />, label: 'Chính sách pháp lý' },
  { id: 'bugreport',    icon: <BugIcon className="w-4 h-4" />, label: 'Hướng dẫn báo lỗi' },
  { id: 'donate',       icon: <CoffeeIcon className="w-4 h-4" />, label: 'Donate & Ủng hộ' },
];

const PANEL_MAP = {
  overview:     OverviewPanel,
  dashboard:    DashboardPanel,
  multiAccount: MultiAccountPanel,
  messaging:    MessagingPanel,
  'history-sync': HistorySyncPanel,
  crm:          CrmPanel,
  workflow:     WorkflowPanel,
  'integration-pos': IntegrationPOSPanel,
  'integration-payment': IntegrationPaymentPanel,
  'integration-shipping': IntegrationShippingPanel,
  'apps-api':   AppsApiPanel,
  'ai-assistant': AIAssistantPanel,
  analytics:    AnalyticsPanel,
  erp:          ErpPanel,
  employees:    EmployeesPanel,
  cloud:        CloudPanel,
  security:     SecurityPanel,
  policy:       PolicyPanel,
  bugreport:    BugReportPanel,
  donate:       DonateCoffeePanel,
} satisfies Record<FeatureId, React.FC>;

// ─── Main component ───────────────────────────────────────────────────────────

interface IntroductionSettingsProps {
  initialSubtab?: FeatureId;
}

export default function IntroductionSettings({ initialSubtab }: IntroductionSettingsProps = {}) {
  const [activeFeature, setActiveFeature] = useState<FeatureId>(initialSubtab || 'overview');
  const Panel = PANEL_MAP[activeFeature];

  // Listen for external subtab navigation events
  useEffect(() => {
    const handler = (e: Event) => {
      const { subtab } = (e as CustomEvent).detail || {};
      if (subtab && subtab in PANEL_MAP) {
        setActiveFeature(subtab as FeatureId);
      }
    };
    window.addEventListener('nav:intro-subtab', handler);
    return () => window.removeEventListener('nav:intro-subtab', handler);
  }, []);

  // Reset to initialSubtab when prop changes (e.g. parent re-renders with new event)
  useEffect(() => {
    if (initialSubtab && initialSubtab in PANEL_MAP) {
      setActiveFeature(initialSubtab);
    }
  }, [initialSubtab]);

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-foreground"><BookIcon className="w-4 h-4 inline" /> Giới thiệu & Hướng dẫn sử dụng</h2>

      <div className="flex gap-0 border border-border rounded-xl overflow-hidden" style={{ minHeight: '30rem' }}>
        {/* Left: Feature tabs */}
        <div className="w-44 flex-shrink-0 border-r border-border bg-card flex flex-col py-2 gap-0.5 overflow-y-auto">
          {FEATURES.map(f => (
            <button
              key={f.id}
              onClick={() => setActiveFeature(f.id)}
              className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left transition-colors border-r-2 ${
                activeFeature === f.id
                  ? 'bg-selected text-primary border-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground border-transparent'
              }`}
            >
              <span className="text-sm leading-none flex-shrink-0">{f.icon}</span>
              <span className="font-medium leading-tight">{f.label}</span>
            </button>
          ))}
        </div>

        {/* Right: Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <Panel />
        </div>
      </div>
    </div>
  );
}

