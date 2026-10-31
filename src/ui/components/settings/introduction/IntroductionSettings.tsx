import React, { useState, useEffect } from 'react';
import { BookIcon, BotIcon, BugIcon, ChartIcon, ChatIcon, CloudIcon, CoffeeIcon, CreditCardIcon, FileTextIcon, FolderIcon, HomeIcon, LightningIcon, LockIcon, PackageIcon, PluginIcon, ShoppingCartIcon, SmartphoneIcon, TrendingUpIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { OverviewPanel } from './OverviewPanel';
import { MultiAccountPanel } from './MultiAccountPanel';
import { MessagingPanel } from './MessagingPanel';
import { HistorySyncPanel } from './HistorySyncPanel';
import { ErpPanel } from './ErpPanel';
import { CrmPanel } from './CrmPanel';
import { WorkflowPanel } from './WorkflowPanel';
import { IntegrationPOSPanel } from './IntegrationPOSPanel';
import { IntegrationPaymentPanel } from './IntegrationPaymentPanel';
import { IntegrationShippingPanel } from './IntegrationShippingPanel';
import { AppsApiPanel } from './AppsApiPanel';
import { AIAssistantPanel } from './AIAssistantPanel';
import { AnalyticsPanel } from './AnalyticsPanel';
import { DashboardPanel } from './DashboardPanel';
import { SecurityPanel } from './SecurityPanel';
import { EmployeesPanel } from './EmployeesPanel';
import { CloudPanel } from './CloudPanel';
import { PolicyPanel } from './PolicyPanel';
import { BugReportPanel } from './BugReportPanel';
import { DonateCoffeePanel } from './DonateCoffeePanel';
import { SettingsPage } from '../settingsUi';

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
    <SettingsPage title="Giới thiệu & Hướng dẫn sử dụng" description="Deplao làm được gì và cách dùng từng tính năng." width="full" fill>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-card">
        {/* Trái: danh sách mục */}
        <nav aria-label="Mục hướng dẫn" className="flex w-52 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 py-2">
          {FEATURES.map(f => {
            const active = activeFeature === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setActiveFeature(f.id)}
                className={`relative flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] transition-colors ${
                  active ? 'bg-selected font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {active && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-[3px] rounded-r-full bg-primary" />}
                <span className="flex-shrink-0 leading-none">{f.icon}</span>
                <span className="leading-tight">{f.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Phải: nội dung (tự cuộn, danh sách mục đứng yên) */}
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="max-w-4xl">
            <Panel />
          </div>
        </div>
      </div>
    </SettingsPage>
  );
}

