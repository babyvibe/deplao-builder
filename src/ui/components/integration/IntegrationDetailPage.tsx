import React, { useState, useEffect, useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import PublicAddressCard, { usePublicAddresses } from '@/components/common/cloud/PublicAddressCard';
import { AlertIcon, ChatIcon, CheckIcon, ClipboardListIcon, CloseIcon, CreditCardIcon, GlobeIcon, HardDriveIcon, KeyIcon, LinkIcon, LockIcon, PackageIcon, PluginIcon, RefreshIcon, SearchIcon, SettingsIcon, SunIcon, TruckIcon, UserIcon , EditIcon } from '@/components/common/icons';
import { getNodeLabel } from '@/components/workflow/nodes/workflowConfig';
import { getNodeDescription } from '@/components/workflow/nodes/nodeVisuals';
import { missingCredentialMessage, type CredentialAlternative } from './credentialRules';
import WebhookRegistrationCard from './WebhookRegistrationCard';
import { isWebhookRegistrationType } from '../../../shared/integrations/posWebhookTopics';
import { tr, appLocale } from '../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Workflow steps available for each integration: name and description come from the Workflow node table. */
const WORKFLOW_NODE_TYPES: Record<string, string[]> = {
  kiotviet: ['trigger.posWebhook', 'kiotviet.lookupCustomer', 'kiotviet.lookupOrder', 'kiotviet.lookupProduct', 'kiotviet.createOrder'],
  haravan:  ['trigger.posWebhook', 'haravan.lookupCustomer', 'haravan.lookupOrder', 'haravan.lookupProduct', 'haravan.createOrder'],
  sapo:     ['trigger.posWebhook', 'sapo.lookupCustomer', 'sapo.lookupOrder', 'sapo.lookupProduct', 'sapo.getInventory', 'sapo.createOrder'],
  nhanh:    ['trigger.posWebhook', 'nhanh.lookupCustomer', 'nhanh.lookupOrder', 'nhanh.lookupProduct', 'nhanh.createOrder'],
  pancake:  ['trigger.posWebhook', 'pancake.lookupCustomer', 'pancake.lookupOrder', 'pancake.lookupProduct', 'pancake.createOrder'],
  casso:    ['trigger.payment', 'payment.getTransactions'],
  sepay:    ['trigger.payment', 'payment.getTransactions'],
  ghn:      ['ghn.createOrder', 'ghn.getTracking', 'ghn.getProvinces', 'ghn.getDistricts', 'ghn.getWards', 'ghn.getServices'],
  ghtk:     ['ghtk.createOrder', 'ghtk.getTracking'],
};

interface CatalogItem {
  type: string;
  name: string;
  desc: string;
  icon: React.ReactNode;
  color: string;
  priority: string;
  credentialFields: { key: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean }[];
  credentialAlternatives?: CredentialAlternative[];
  settingFields?: { key: string; label: string; type?: string; options?: { value: string; label: string }[] }[];
}

/** Point-of-sale software sends webhooks into Deplao (services/integrations/posWebhook.ts): an auth key is always required. */
const POS_WEBHOOK_TYPES = ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'];

/** Webhook status for Casso / SePay / point-of-sale software (IntegrationRegistry.listConfigs): received / rejected counts only count from when the app was opened. */
export interface IntegrationWebhookInfo {
  secretConfigured: boolean;
  lastAccepted?: { at: number; message: string; method?: string };
  lastRejected?: { at: number; message: string; reason?: string };
}

interface SavedIntegration {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  connectedAt?: number;
  settings?: Record<string, any>;
  webhook?: IntegrationWebhookInfo;
}

/** Where to get the webhook security key in each platform's admin page. */
const WEBHOOK_SECRET_GUIDE: Record<string, React.ReactNode> = {
  casso: <>{trx('Trong Casso: <0>Kết nối → Tích hợp → Webhook V2</0> (khuyên dùng), chép <1>Key bảo mật</1> và dán vào ô <2>Secret Key (webhook)</2> ở trên rồi bấm Cập nhật. Dùng Webhook cũ thì dán key bảo mật của webhook đó.', { 0: <strong />, 1: <strong />, 2: <strong /> })}</>,
  sepay: <>{trx('Trong SePay: <0>Webhooks → sửa webhook → bước Bảo mật</0>, chọn <1>HMAC-SHA256</1> (khuyên dùng) hoặc <2>API Key</2>, chép Secret Key / API Key và dán vào ô <3>Webhook Secret</3> ở trên rồi bấm Cập nhật.', { 0: <strong />, 1: <strong />, 2: <strong />, 3: <strong /> })}</>,
  kiotviet: <>{trx('KiotViet chỉ đăng ký webhook qua API — dùng mục <0>Đăng ký webhook tự động</0> bên dưới: Deplao tự tạo Secret, lưu vào ô <1>Webhook Secret</1> và đăng ký các sự kiện đã chọn. Webhook đã đăng ký bằng công cụ khác thì dán đúng Secret (chuỗi Base64) đã dùng vào ô đó rồi bấm Cập nhật.', { 0: <strong />, 1: <strong /> })}</>,
  haravan: <>{trx('Trong Haravan: <0>Cài đặt → Thông báo → Webhook</0>, tạo webhook (JSON) với địa chỉ nhận bên dưới, chép <1>mã xác thực</1> Haravan hiện ở đó và dán vào ô <2>Mã xác thực webhook</2> ở trên rồi bấm Cập nhật. Webhook do app Haravan đăng ký thì dùng Client Secret của app.', { 0: <strong />, 1: <strong />, 2: <strong /> })}</>,
  sapo: <>{trx('Sapo ký webhook bằng <0>API Secret</0> của ứng dụng riêng — đã nhập ô API Secret thì không cần ô <1>Khoá xác thực webhook</1>. Dùng mục <2>Đăng ký webhook tự động</2> bên dưới để Deplao tạo webhook cho các topic đã chọn (orders/create, orders/paid…).', { 0: <strong />, 1: <strong />, 2: <strong /> })}</>,
  nhanh: <>{trx('Trong <0>open.nhanh.vn → Ứng dụng của tôi → ứng dụng → Webhooks</0>: nhập địa chỉ nhận bên dưới, đặt <1>Webhooks verify token</1> (chuỗi tự đặt) và chọn sự kiện (orderAdd, orderUpdate…), rồi dán đúng token đó vào ô <2>Webhooks verify token</2> ở trên và bấm Cập nhật trước khi bật webhook.', { 0: <strong />, 1: <strong />, 2: <strong /> })}</>,
  pancake: <>{trx('Trong phần <0>cấu hình Webhook</0> của Pancake POS: nhập địa chỉ nhận bên dưới, ở <1>Request Headers</1> thêm header <2>X-API-KEY</2> = một chuỗi bí mật tự đặt, chọn loại dữ liệu (đơn hàng, khách hàng…), rồi dán đúng chuỗi đó vào ô <3>Khoá webhook X-API-KEY</3> ở trên và bấm Cập nhật.', { 0: <strong />, 1: <strong />, 2: <strong />, 3: <strong /> })}</>,
};

function WebhookSecurityCard({ type, name, info, required, onRefresh }: {
  type: string;
  name: string;
  info: IntegrationWebhookInfo | null;
  /** Point-of-sale software: without a key, webhooks are rejected (Casso / SePay are still received but cannot be verified). */
  required?: boolean;
  onRefresh: () => void;
}) {
  const configured = !!info?.secretConfigured;
  const rejectedLatest = !!info?.lastRejected && (!info.lastAccepted || info.lastRejected.at >= info.lastAccepted.at);
  const signatureProblem = info?.lastRejected?.reason === 'missing_signature' || info?.lastRejected?.reason === 'invalid_signature';
  const time = (at: number) => new Date(at).toLocaleString(appLocale());

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground/80">{trx('<0/> Bảo mật webhook', { 0: <LockIcon className="w-4 h-4 inline" /> })}</h2>
        <button type="button" onClick={onRefresh} className="text-[11px] text-muted-foreground hover:text-foreground">
          {trx('<0/> Làm mới', { 0: <RefreshIcon className="w-3.5 h-3.5 inline" /> })}
        </button>
      </div>
      <div className="bg-card rounded-xl p-4 space-y-3">
        {configured ? (
          <div className="rounded-xl border border-success/40 bg-success/10 px-4 py-3">
            <p className="text-xs font-semibold text-foreground">{trx('<0/> Đã đặt khoá — chỉ nhận webhook có chữ ký hợp lệ', { 0: <CheckIcon className="w-4 h-4 inline text-success" /> })}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {trx('Webhook thiếu hoặc sai chữ ký bị từ chối và không kích hoạt workflow. Khoá ở đây phải trùng khoá đang dùng trong {{name}}.', { name })}
            </p>
          </div>
        ) : required ? (
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <p className="text-xs font-semibold text-foreground">{trx('<0/> Chưa đặt khoá — {{name}} gửi webhook vào sẽ bị từ chối', { 0: <LockIcon className="w-4 h-4 inline" />, name })}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {trx('Webhook của phần mềm bán hàng chỉ kích hoạt workflow <0>Khi phần mềm bán hàng gửi webhook</0> khi Deplao xác thực được người gửi. Chỉ tra cứu / tạo đơn trong hội thoại thì không cần mục này.', { 0: <strong className="text-foreground" /> })}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{WEBHOOK_SECRET_GUIDE[type]}</p>
          </div>
        ) : (
          <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
            <p className="text-xs font-semibold text-foreground">{trx('<0/> Chưa đặt khoá bảo mật webhook', { 0: <AlertIcon className="w-4 h-4 inline text-warning" /> })}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {trx('Deplao vẫn nhận webhook nhưng không kiểm tra được ai gửi: ai biết địa chỉ nhận webhook đều có thể gửi giao dịch giả để kích hoạt workflow <0>Khi nhận thanh toán</0> (xác nhận đơn, gửi tin, ghi sổ…). Nên đặt khoá.', { 0: <strong className="text-foreground" /> })}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{WEBHOOK_SECRET_GUIDE[type]}</p>
          </div>
        )}

        {info?.lastAccepted && (
          <p className="text-[11px] text-muted-foreground">
            {trx('<0/> Nhận gần nhất {{v1}}: {{message}}', { 0: <CheckIcon className="w-3.5 h-3.5 inline text-success" />, v1: time(info.lastAccepted.at), message: info.lastAccepted.message })}
          </p>
        )}
        {info?.lastRejected && (
          <p className={`text-[11px] ${rejectedLatest ? 'text-destructive' : 'text-muted-foreground'}`}>
            {trx('<0/> Từ chối gần nhất {{v1}}: {{message}}', { 0: <CloseIcon className="w-3.5 h-3.5 inline" />, v1: time(info.lastRejected.at), message: info.lastRejected.message })}
            {rejectedLatest && signatureProblem && tr(' — kiểm tra khoá ở đây có trùng khoá trong {{name}} không.', { name })}
          </p>
        )}
        {!info?.lastAccepted && !info?.lastRejected && (
          <p className="text-[11px] text-subtle-foreground">{tr('Chưa nhận webhook nào từ khi mở Deplao.')}</p>
        )}
      </div>
    </div>
  );
}

interface Props {
  catalogItem: CatalogItem;
  saved?: SavedIntegration;
  webhookPort: number;
  onBack: () => void;
}

export default function IntegrationDetailPage({ catalogItem, saved, webhookPort, onBack }: Props) {
  const showNotification = useAppStore(s => s.showNotification);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [saved_id, setSavedId] = useState<string | undefined>(saved?.id);
  const [deleting, setDeleting] = useState(false);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [webhookInfo, setWebhookInfo] = useState<IntegrationWebhookInfo | null>(saved?.webhook ?? null);

  const isPayment = catalogItem.type === 'casso' || catalogItem.type === 'sepay';
  const isPos = POS_WEBHOOK_TYPES.includes(catalogItem.type);
  /** KiotViet / Sapo: Deplao registers the webhook for you through the platform's API. */
  const registrationType = isWebhookRegistrationType(catalogItem.type) ? catalogItem.type : null;
  /** Receives webhooks from the Internet: payments (Casso / SePay) and point-of-sale software. */
  const receivesWebhook = isPayment || isPos;

  /** Re-read the webhook status (whether a key is set, last received / rejected). */
  const refreshWebhookInfo = useCallback(async (id?: string) => {
    if (!receivesWebhook || !id) return;
    try {
      const res = await DataAccessor.getIntegrations();
      const item = (res?.integrations || []).find((i: any) => i.id === id);
      if (item) setWebhookInfo(item.webhook ?? null);
    } catch { /* keep the current state */ }
  }, [receivesWebhook]);

  useEffect(() => { refreshWebhookInfo(saved?.id); }, [refreshWebhookInfo, saved?.id]);

  useEffect(() => {
    // Load saved settings (non-credential)
    if (saved?.settings) setSettings(saved.settings);
    // Pre-populate defaults for setting fields
    if (catalogItem.settingFields) {
      const defaults: Record<string, any> = {};
      for (const sf of catalogItem.settingFields) {
        if (sf.options?.[0]) defaults[sf.key] = sf.options[0].value;
      }
      setSettings(prev => ({ ...defaults, ...prev }));
    }
  }, [saved, catalogItem]);

  const handleSave = async () => {
    // New connection: required fields + at least one complete login method (Haravan: Access Token, or API Key + Password).
    // Update: an empty field keeps the old value.
    const missing = missingCredentialMessage(catalogItem.credentialFields, catalogItem.credentialAlternatives, credentials, !!saved_id);
    if (missing) {
      showNotification(missing, 'warning');
      return;
    }
    setSaving(true);
    setTestResult(null);
    try {
      const payload: any = {
        id: saved_id,
        type: catalogItem.type,
        name: catalogItem.name,
        enabled,
        credentials,
        settings,
      };
      const res = await DataAccessor.saveIntegration(payload);
      const savedId = (res as any)?.data?.id || (res as any)?.id;
      if (res?.success && savedId) {
        setSavedId(savedId);
        void refreshWebhookInfo(savedId);
        showNotification(tr('Đã lưu cấu hình!'), 'success');
      } else {
        showNotification(tr('Lưu thất bại: {{v1}}', { v1: (res?.error || tr('Lỗi không xác định')) }), 'error');
      }
    } catch (e: any) {
      showNotification(tr('Lỗi: {{message}}', { message: e.message }), 'error');
    }
    setSaving(false);
  };

  const handleTest = async () => {
    if (!saved_id) {
      showNotification(tr('Vui lòng lưu cấu hình trước khi test kết nối.'), 'warning');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await ipc.integration?.test(saved_id);
      const success = !!res?.success;
      const message = res?.message || (success ? tr('Kết nối thành công') : tr('Kết nối thất bại'));
      setTestResult({ success, message });
      showNotification(success ? message : tr('Test thất bại: {{message}}', { message }), success ? 'success' : 'error');
    } catch (e: any) {
      const message = e.message || tr('Lỗi không xác định');
      setTestResult({ success: false, message });
      showNotification(tr('Test thất bại: {{message}}', { message }), 'error');
    }
    setTesting(false);
  };

  const handleDelete = async () => {
    if (!saved_id) { onBack(); return; }
    if (!confirm(tr('Xóa tích hợp {{name}}? Dữ liệu sẽ mất hoàn toàn.', { name: catalogItem.name }))) return;
    setDeleting(true);
    try {
      await DataAccessor.deleteIntegration(saved_id);
      showNotification(tr('Đã xoá tích hợp {{name}}', { name: catalogItem.name }), 'success');
      onBack();
    } catch (e: any) {
      showNotification(tr('Lỗi xóa: {{message}}', { message: e.message }), 'error');
    }
    setDeleting(false);
  };

  const localWebhookUrl  = `http://127.0.0.1:${webhookPort}/webhook/${saved_id || catalogItem.type}`;

  // The webhook receiving address is view-only (for every way of creating an address); turn it on / change it in Settings → Internet & Cloud → Internet address.
  const serverManaged = usePublicAddresses().serverManaged;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex-shrink-0 flex items-center gap-3">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div className={`w-9 h-9 rounded-lg ${catalogItem.color} flex items-center justify-center text-lg`}>
          {catalogItem.icon}
        </div>
        <div>
          <h1 className="text-base font-semibold text-foreground">{catalogItem.name}</h1>
          <p className="text-xs text-muted-foreground">{catalogItem.desc}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Enable toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">{tr('Kích hoạt')}</span>
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-accent'}`}
              onClick={() => setEnabled(!enabled)}
            >
              <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-5' : ''}`}/>
            </div>
          </label>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Credentials */}
        <div>
          <h2 className="text-sm font-semibold text-foreground/80 mb-3">{trx('<0/> Thông tin xác thực', { 0: <KeyIcon className="w-4 h-4 inline" /> })}</h2>
          <div className="space-y-3 bg-card rounded-xl p-4">
            {catalogItem.credentialFields.map(field => (
              <div key={field.key}>
                <label className="block text-xs text-muted-foreground mb-1">{field.label}</label>
                <div className="relative">
                  <input
                    type={field.secret && !showSecret[field.key] ? 'password' : 'text'}
                    value={credentials[field.key] || ''}
                    onChange={e => setCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder || (saved_id ? '••••••••' : '')}
                    className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 pr-10"
                  />
                  {field.secret && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowSecret(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                    >
                      {showSecret[field.key] ? '🙈' : '👁'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {saved_id && (
            <p className="text-xs text-muted-foreground mt-1">{tr('Để trống các trường bí mật nếu không muốn thay đổi.')}</p>
          )}
        </div>

        {/* Webhook security key: when set → only webhooks with a valid signature are accepted; when not set → payments: warn that it should be set,
            point-of-sale software: webhooks are rejected */}
        {receivesWebhook && (
          <WebhookSecurityCard
            type={catalogItem.type}
            name={catalogItem.name}
            info={webhookInfo}
            required={isPos}
            onRefresh={() => { void refreshWebhookInfo(saved_id); }}
          />
        )}

        {/* Settings */}
        {catalogItem.settingFields && catalogItem.settingFields.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-foreground/80 mb-3">{trx('<0/> Cài đặt', { 0: <SettingsIcon className="w-4 h-4 inline" /> })}</h2>
            <div className="space-y-3 bg-card rounded-xl p-4">
              {catalogItem.settingFields.map(field => (
                <div key={field.key}>
                  <label className="block text-xs text-muted-foreground mb-1">{field.label}</label>
                  {field.type === 'select' ? (
                    <select
                      value={settings[field.key] || ''}
                      onChange={e => setSettings(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
                    >
                      {field.options?.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={settings[field.key] || ''}
                      onChange={e => setSettings(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Webhook receiving address: payments, point-of-sale software. View-only: turn on / change it in Settings → Internet & Cloud → Internet address */}
        {receivesWebhook && (
          <div>
            <h2 className="text-sm font-semibold text-foreground/80 mb-3">{trx('<0/> Địa chỉ nhận webhook', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</h2>
            <div className="bg-card rounded-xl p-4 space-y-3">

              {/* Why an Internet address is needed */}
              <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
                <p className="mb-1.5 text-xs font-semibold text-foreground">
                  <SunIcon className="w-4 h-4 inline text-warning" />{' '}
                  {isPayment ? tr('Dùng {{name}} để nhận thanh toán tự động?', { name: catalogItem.name }) : tr('Chạy workflow khi {{name}} có đơn hàng, khách hàng mới?', { name: catalogItem.name })}
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {trx('{{name}} gửi webhook ({{v1}}) từ Internet, còn Deplao chạy trên máy của bạn nên cần một<0> địa chỉ Internet</0> trỏ về máy. ', { name: catalogItem.name, v1: isPayment ? tr('thông báo giao dịch') : tr('thông báo đơn hàng, khách hàng…'), 0: <strong className="text-foreground" /> })}
                  {serverManaged ? tr('Địa chỉ này do máy chủ quản lý.') : tr('Bật ở Cài đặt → Internet & Cloud → Địa chỉ Internet.')}
                </p>
              </div>

              {/* Visual flow */}
              <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
                <p className="mb-2 text-[10px] font-medium text-muted-foreground">{trx('<0/> Luồng hoạt động:', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</p>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-lg bg-info/15 px-2 py-1 text-info">{catalogItem.name}</span>
                  <span>─(webhook)─→</span>
                  <span className="rounded-lg bg-success/15 px-2 py-1 text-success">{tr('Địa chỉ Internet')}</span>
                  <span>─→</span>
                  <span className="rounded-lg bg-primary/15 px-2 py-1 text-primary">{tr('Máy bạn')}</span>
                  <span>→</span>
                  <span className="rounded-lg bg-success/15 px-2 py-1 text-success">{isPayment ? tr('Tự động XN đơn') : tr('Workflow chạy')}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <PublicAddressCard
                  service="payments"
                  title={tr('Địa chỉ nhận webhook của {{name}}', { name: catalogItem.name })}
                  pathSuffix={`/webhook/${saved_id || catalogItem.type}`}
                  anyMode
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {trx('Sao chép địa chỉ trên, dán vào phần webhook của {{name}}. Địa chỉ chỉ chạy khi Deplao đang mở; địa chỉ tạm đổi mỗi lần khởi động lại (phải dán lại), địa chỉ cố định thì không.', { name: catalogItem.name })}
                </p>
              </div>

              {/* Local URL info (informational) */}
              <div className="bg-muted/40 rounded-lg px-3 py-2">
                <p className="text-[10px] text-muted-foreground mb-0.5">{tr('URL local (nội bộ, không dùng để cấu hình webhook):')}</p>
                <code className="text-[11px] text-muted-foreground font-mono">{localWebhookUrl}</code>
              </div>
            </div>
          </div>
        )}

        {/* KiotViet / Sapo: Deplao registers the webhook for you (the KiotViet Secret is saved to the connection → refresh the Webhook security section) */}
        {registrationType && (
          <WebhookRegistrationCard
            type={registrationType}
            name={catalogItem.name}
            integrationId={saved_id}
            onChanged={() => { void refreshWebhookInfo(saved_id); }}
          />
        )}

        {/* Usage in conversation (QuickPanel) */}
        <div>
          <h2 className="text-sm font-semibold text-foreground/80 mb-3">{trx('<0/> Sử dụng trong hội thoại', { 0: <ChatIcon className="w-4 h-4 inline" /> })}</h2>
          <div className="bg-card rounded-xl p-4 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {tr('Sau khi kết nối, bạn có thể tra cứu thông tin trực tiếp khi đang chat với khách hàng mà không cần rời khỏi cửa sổ hội thoại:')}
            </p>

            <div className="bg-muted/50 rounded-lg p-3 border border-input/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg"><PluginIcon className="w-4 h-4" /></span>
                <span className="text-xs font-semibold text-foreground">{tr('Bảng điều khiển Tích hợp nhanh')}</span>
              </div>
              <ol className="space-y-1.5 text-[11px] text-muted-foreground ml-1">
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">1.</span>
                  <span>{trx('Nhấn nút <0><1/> Tích hợp nhanh</0> (hình mắt xích) trên thanh tiêu đề hội thoại, hoặc nút ⋯ Thêm tính năng ở ô soạn tin → Tích hợp nhanh', { 0: <span className="text-blue-300 font-medium" />, 1: <LinkIcon className="w-4 h-4 inline" /> })}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">2.</span>
                  <span>{trx('Chọn <0>{{name}}</0> từ danh sách tích hợp trong panel bên phải', { 0: <span className="text-foreground font-medium" />, name: catalogItem.name })}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">3.</span>
                  <span>{tr('Chọn thao tác muốn thực hiện bên dưới:')}</span>
                </li>
              </ol>
            </div>

            {/* Available quick actions for this integration type */}
            {(catalogItem.type === 'kiotviet' || catalogItem.type === 'haravan' || catalogItem.type === 'sapo' || catalogItem.type === 'nhanh' || catalogItem.type === 'pancake') && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: <UserIcon className="w-4 h-4" />, label: tr('Tra cứu KH'), desc: tr('Theo SĐT') },
                  { icon: <ClipboardListIcon className="w-4 h-4" />, label: tr('Tra cứu đơn'), desc: tr('Theo mã/SĐT') },
                  { icon: <SearchIcon className="w-4 h-4" />, label: tr('Tìm sản phẩm'), desc: tr('Theo tên/SKU') },
                  { icon: <EditIcon className="w-4 h-4" />, label: tr('Tạo đơn hàng'), desc: tr('Tạo đơn mới') },
                ].map((act, i) => (
                  <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2 border border-input/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <div>
                      <p className="text-[11px] font-medium text-foreground">{act.label}</p>
                      <p className="text-[10px] text-muted-foreground">{act.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {catalogItem.type === 'ghn' && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: '🗺️', label: tr('DS tỉnh/thành') },
                  { icon: '🏙️', label: tr('DS quận/huyện') },
                  { icon: '📍', label: tr('DS phường/xã') },
                  { icon: '🚛', label: tr('Dịch vụ GHN') },
                  { icon: <PackageIcon className="w-4 h-4" />, label: tr('Tra vận đơn') },
                  { icon: '💵', label: tr('Tính phí ship') },
                ].map((act, i) => (
                  <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2 border border-input/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-foreground">{act.label}</p>
                  </div>
                ))}
              </div>
            )}
            {catalogItem.type === 'ghtk' && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: <TruckIcon className="w-4 h-4" />, label: tr('Tra vận đơn') },
                  { icon: '💵', label: tr('Tính phí ship') },
                ].map((act, i) => (
                  <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2 border border-input/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-foreground">{act.label}</p>
                  </div>
                ))}
              </div>
            )}
            {(catalogItem.type === 'casso' || catalogItem.type === 'sepay') && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: <CreditCardIcon className="w-4 h-4" />, label: tr('LS giao dịch') },
                ].map((act, i) => (
                  <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2 border border-input/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-foreground">{act.label}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <span className="flex-shrink-0"><SunIcon className="w-4 h-4" /></span>
              <span>
                {trx('Kết quả tra cứu hiển thị ngay trong panel - có thể xem chi tiết đơn hàng, sản phẩm, thông tin khách hàng. Hỗ trợ <0>ghim thao tác</0> ra toolbar để truy cập nhanh hơn.', { 0: <strong className="text-foreground/80" /> })}
              </span>
            </p>
          </div>
        </div>

        {/* Workflow hint */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-blue-300 mb-2">{trx('<0/> Bước Workflow có sẵn', { 0: <SunIcon className="w-4 h-4 inline" /> })}</h3>
          <ul className="text-xs text-blue-200 space-y-1">
            {(WORKFLOW_NODE_TYPES[catalogItem.type] || []).map(type => (
              <li key={type}>• <span className="bg-blue-900/40 px-1 rounded font-medium">{getNodeLabel(type)}</span> - {getNodeDescription(type)}</li>
            ))}
          </ul>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`p-3 rounded-lg text-sm ${testResult.success ? 'bg-green-900/30 border border-green-700 text-green-300' : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
            {testResult.success ? <CheckIcon className="w-4 h-4 inline" /> : <CloseIcon className="w-4 h-4 inline" />} {testResult.message}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-6 py-4 border-t border-border flex-shrink-0 flex items-center gap-3">
        {saved_id && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-3 py-2 text-sm rounded-lg text-red-400 hover:bg-red-900/30 border border-red-800/40 transition-colors"
          >
            {deleting ? tr('Đang xóa...') : tr('Xóa')}
          </button>
        )}
        <div className="flex-1"/>
        {saved_id && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-4 py-2 text-sm rounded-lg bg-muted hover:bg-accent text-foreground transition-colors"
          >
            {testing ? tr('Đang test...') : <>{trx('<0/> Test kết nối', { 0: <SearchIcon className="w-4 h-4 inline" /> })}</>}
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {saving ? tr('Đang lưu...') : saved_id ? <>{trx('<0/> Cập nhật', { 0: <HardDriveIcon className="w-3.5 h-3.5 inline" /> })}</> : tr('Kết nối')}
        </button>
      </div>
    </div>
  );
}

