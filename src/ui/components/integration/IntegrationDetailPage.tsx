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

/** Bước Workflow có sẵn cho từng tích hợp — tên và mô tả lấy từ bảng node của Workflow. */
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

/** Phần mềm bán hàng gửi webhook vào Deplao (services/integrations/posWebhook.ts) — luôn cần khoá xác thực. */
const POS_WEBHOOK_TYPES = ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'];

/** Trạng thái webhook Casso / SePay / phần mềm bán hàng (IntegrationRegistry.listConfigs) — lần nhận / từ chối chỉ tính từ khi mở app. */
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

/** Nơi lấy khoá bảo mật webhook trong trang quản trị của từng nền tảng. */
const WEBHOOK_SECRET_GUIDE: Record<string, React.ReactNode> = {
  casso: <>Trong Casso: <strong>Kết nối → Tích hợp → Webhook V2</strong> (khuyên dùng), chép <strong>Key bảo mật</strong> và dán vào ô <strong>Secret Key (webhook)</strong> ở trên rồi bấm Cập nhật. Dùng Webhook cũ thì dán key bảo mật của webhook đó.</>,
  sepay: <>Trong SePay: <strong>Webhooks → sửa webhook → bước Bảo mật</strong>, chọn <strong>HMAC-SHA256</strong> (khuyên dùng) hoặc <strong>API Key</strong>, chép Secret Key / API Key và dán vào ô <strong>Webhook Secret</strong> ở trên rồi bấm Cập nhật.</>,
  kiotviet: <>KiotViet chỉ đăng ký webhook qua API — dùng mục <strong>Đăng ký webhook tự động</strong> bên dưới: Deplao tự tạo Secret, lưu vào ô <strong>Webhook Secret</strong> và đăng ký các sự kiện đã chọn. Webhook đã đăng ký bằng công cụ khác thì dán đúng Secret (chuỗi Base64) đã dùng vào ô đó rồi bấm Cập nhật.</>,
  haravan: <>Trong Haravan: <strong>Cài đặt → Thông báo → Webhook</strong>, tạo webhook (JSON) với địa chỉ nhận bên dưới, chép <strong>mã xác thực</strong> Haravan hiện ở đó và dán vào ô <strong>Mã xác thực webhook</strong> ở trên rồi bấm Cập nhật. Webhook do app Haravan đăng ký thì dùng Client Secret của app.</>,
  sapo: <>Sapo ký webhook bằng <strong>API Secret</strong> của ứng dụng riêng — đã nhập ô API Secret thì không cần ô <strong>Khoá xác thực webhook</strong>. Dùng mục <strong>Đăng ký webhook tự động</strong> bên dưới để Deplao tạo webhook cho các topic đã chọn (orders/create, orders/paid…).</>,
  nhanh: <>Trong <strong>open.nhanh.vn → Ứng dụng của tôi → ứng dụng → Webhooks</strong>: nhập địa chỉ nhận bên dưới, đặt <strong>Webhooks verify token</strong> (chuỗi tự đặt) và chọn sự kiện (orderAdd, orderUpdate…), rồi dán đúng token đó vào ô <strong>Webhooks verify token</strong> ở trên và bấm Cập nhật trước khi bật webhook.</>,
  pancake: <>Trong phần <strong>cấu hình Webhook</strong> của Pancake POS: nhập địa chỉ nhận bên dưới, ở <strong>Request Headers</strong> thêm header <strong>X-API-KEY</strong> = một chuỗi bí mật tự đặt, chọn loại dữ liệu (đơn hàng, khách hàng…), rồi dán đúng chuỗi đó vào ô <strong>Khoá webhook X-API-KEY</strong> ở trên và bấm Cập nhật.</>,
};

function WebhookSecurityCard({ type, name, info, required, onRefresh }: {
  type: string;
  name: string;
  info: IntegrationWebhookInfo | null;
  /** Phần mềm bán hàng: chưa đặt khoá thì webhook bị từ chối (Casso / SePay vẫn nhận nhưng không kiểm tra được). */
  required?: boolean;
  onRefresh: () => void;
}) {
  const configured = !!info?.secretConfigured;
  const rejectedLatest = !!info?.lastRejected && (!info.lastAccepted || info.lastRejected.at >= info.lastAccepted.at);
  const signatureProblem = info?.lastRejected?.reason === 'missing_signature' || info?.lastRejected?.reason === 'invalid_signature';
  const time = (at: number) => new Date(at).toLocaleString('vi-VN');

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground/80"><LockIcon className="w-4 h-4 inline" /> Bảo mật webhook</h2>
        <button type="button" onClick={onRefresh} className="text-[11px] text-muted-foreground hover:text-foreground">
          <RefreshIcon className="w-3.5 h-3.5 inline" /> Làm mới
        </button>
      </div>
      <div className="bg-card rounded-xl p-4 space-y-3">
        {configured ? (
          <div className="rounded-xl border border-success/40 bg-success/10 px-4 py-3">
            <p className="text-xs font-semibold text-foreground"><CheckIcon className="w-4 h-4 inline text-success" /> Đã đặt khoá — chỉ nhận webhook có chữ ký hợp lệ</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Webhook thiếu hoặc sai chữ ký bị từ chối và không kích hoạt workflow. Khoá ở đây phải trùng khoá đang dùng trong {name}.
            </p>
          </div>
        ) : required ? (
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <p className="text-xs font-semibold text-foreground"><LockIcon className="w-4 h-4 inline" /> Chưa đặt khoá — {name} gửi webhook vào sẽ bị từ chối</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Webhook của phần mềm bán hàng chỉ kích hoạt workflow <strong className="text-foreground">Khi phần mềm bán hàng gửi webhook</strong> khi
              Deplao xác thực được người gửi. Chỉ tra cứu / tạo đơn trong hội thoại thì không cần mục này.
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{WEBHOOK_SECRET_GUIDE[type]}</p>
          </div>
        ) : (
          <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
            <p className="text-xs font-semibold text-foreground"><AlertIcon className="w-4 h-4 inline text-warning" /> Chưa đặt khoá bảo mật webhook</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Deplao vẫn nhận webhook nhưng không kiểm tra được ai gửi: ai biết địa chỉ nhận webhook đều có thể gửi giao dịch giả
              để kích hoạt workflow <strong className="text-foreground">Khi nhận thanh toán</strong> (xác nhận đơn, gửi tin, ghi sổ…). Nên đặt khoá.
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{WEBHOOK_SECRET_GUIDE[type]}</p>
          </div>
        )}

        {info?.lastAccepted && (
          <p className="text-[11px] text-muted-foreground">
            <CheckIcon className="w-3.5 h-3.5 inline text-success" /> Nhận gần nhất {time(info.lastAccepted.at)}: {info.lastAccepted.message}
          </p>
        )}
        {info?.lastRejected && (
          <p className={`text-[11px] ${rejectedLatest ? 'text-destructive' : 'text-muted-foreground'}`}>
            <CloseIcon className="w-3.5 h-3.5 inline" /> Từ chối gần nhất {time(info.lastRejected.at)}: {info.lastRejected.message}
            {rejectedLatest && signatureProblem && ` — kiểm tra khoá ở đây có trùng khoá trong ${name} không.`}
          </p>
        )}
        {!info?.lastAccepted && !info?.lastRejected && (
          <p className="text-[11px] text-subtle-foreground">Chưa nhận webhook nào từ khi mở Deplao.</p>
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
  /** KiotViet / Sapo: Deplao đăng ký webhook giúp qua API của nền tảng. */
  const registrationType = isWebhookRegistrationType(catalogItem.type) ? catalogItem.type : null;
  /** Nhận webhook từ Internet: thanh toán (Casso / SePay) và phần mềm bán hàng. */
  const receivesWebhook = isPayment || isPos;

  /** Đọc lại trạng thái webhook (đã đặt khoá chưa, lần nhận / từ chối gần nhất). */
  const refreshWebhookInfo = useCallback(async (id?: string) => {
    if (!receivesWebhook || !id) return;
    try {
      const res = await DataAccessor.getIntegrations();
      const item = (res?.integrations || []).find((i: any) => i.id === id);
      if (item) setWebhookInfo(item.webhook ?? null);
    } catch { /* giữ trạng thái đang hiện */ }
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
    // Kết nối mới: ô bắt buộc + đủ một cách đăng nhập (Haravan: Access Token hoặc API Key + Password).
    // Cập nhật: ô trống = giữ giá trị cũ.
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
        showNotification('Đã lưu cấu hình!', 'success');
      } else {
        showNotification('Lưu thất bại: ' + (res?.error || 'Lỗi không xác định'), 'error');
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    }
    setSaving(false);
  };

  const handleTest = async () => {
    if (!saved_id) {
      showNotification('Vui lòng lưu cấu hình trước khi test kết nối.', 'warning');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await ipc.integration?.test(saved_id);
      const success = !!res?.success;
      const message = res?.message || (success ? 'Kết nối thành công' : 'Kết nối thất bại');
      setTestResult({ success, message });
      showNotification(success ? message : `Test thất bại: ${message}`, success ? 'success' : 'error');
    } catch (e: any) {
      const message = e.message || 'Lỗi không xác định';
      setTestResult({ success: false, message });
      showNotification('Test thất bại: ' + message, 'error');
    }
    setTesting(false);
  };

  const handleDelete = async () => {
    if (!saved_id) { onBack(); return; }
    if (!confirm(`Xóa tích hợp ${catalogItem.name}? Dữ liệu sẽ mất hoàn toàn.`)) return;
    setDeleting(true);
    try {
      await DataAccessor.deleteIntegration(saved_id);
      showNotification(`Đã xoá tích hợp ${catalogItem.name}`, 'success');
      onBack();
    } catch (e: any) {
      showNotification('Lỗi xóa: ' + e.message, 'error');
    }
    setDeleting(false);
  };

  const localWebhookUrl  = `http://127.0.0.1:${webhookPort}/webhook/${saved_id || catalogItem.type}`;

  // Địa chỉ nhận webhook chỉ để xem (mọi cách tạo địa chỉ) — bật / đổi ở Cài đặt → Internet & Đám mây → Địa chỉ Internet.
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
            <span className="text-xs text-muted-foreground">Kích hoạt</span>
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
          <h2 className="text-sm font-semibold text-foreground/80 mb-3"><KeyIcon className="w-4 h-4 inline" /> Thông tin xác thực</h2>
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
            <p className="text-xs text-muted-foreground mt-1">Để trống các trường bí mật nếu không muốn thay đổi.</p>
          )}
        </div>

        {/* Khoá bảo mật webhook: có khoá → chỉ nhận webhook có chữ ký hợp lệ; chưa có → thanh toán: cảnh báo nên đặt,
            phần mềm bán hàng: webhook bị từ chối */}
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
            <h2 className="text-sm font-semibold text-foreground/80 mb-3"><SettingsIcon className="w-4 h-4 inline" /> Cài đặt</h2>
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

        {/* Địa chỉ nhận webhook — thanh toán, phần mềm bán hàng. Chỉ xem: bật / đổi ở Cài đặt → Internet & Đám mây → Địa chỉ Internet */}
        {receivesWebhook && (
          <div>
            <h2 className="text-sm font-semibold text-foreground/80 mb-3"><GlobeIcon className="w-4 h-4 inline" /> Địa chỉ nhận webhook</h2>
            <div className="bg-card rounded-xl p-4 space-y-3">

              {/* Vì sao cần địa chỉ Internet */}
              <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
                <p className="mb-1.5 text-xs font-semibold text-foreground">
                  <SunIcon className="w-4 h-4 inline text-warning" />{' '}
                  {isPayment ? `Dùng ${catalogItem.name} để nhận thanh toán tự động?` : `Chạy workflow khi ${catalogItem.name} có đơn hàng, khách hàng mới?`}
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {catalogItem.name} gửi webhook ({isPayment ? 'thông báo giao dịch' : 'thông báo đơn hàng, khách hàng…'}) từ Internet, còn Deplao chạy trên máy của bạn nên cần một
                  <strong className="text-foreground"> địa chỉ Internet</strong> trỏ về máy.{' '}
                  {serverManaged ? 'Địa chỉ này do máy chủ quản lý.' : 'Bật ở Cài đặt → Internet & Đám mây → Địa chỉ Internet.'}
                </p>
              </div>

              {/* Luồng hoạt động trực quan */}
              <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
                <p className="mb-2 text-[10px] font-medium text-muted-foreground"><ClipboardListIcon className="w-4 h-4 inline" /> Luồng hoạt động:</p>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-lg bg-info/15 px-2 py-1 text-info">{catalogItem.name}</span>
                  <span>─(webhook)─→</span>
                  <span className="rounded-lg bg-success/15 px-2 py-1 text-success">Địa chỉ Internet</span>
                  <span>─→</span>
                  <span className="rounded-lg bg-primary/15 px-2 py-1 text-primary">Máy bạn</span>
                  <span>→</span>
                  <span className="rounded-lg bg-success/15 px-2 py-1 text-success">{isPayment ? 'Tự động XN đơn' : 'Workflow chạy'}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <PublicAddressCard
                  service="payments"
                  title={`Địa chỉ nhận webhook của ${catalogItem.name}`}
                  pathSuffix={`/webhook/${saved_id || catalogItem.type}`}
                  anyMode
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Sao chép địa chỉ trên, dán vào phần webhook của {catalogItem.name}. Địa chỉ chỉ chạy khi Deplao đang mở;
                  địa chỉ tạm đổi mỗi lần khởi động lại (phải dán lại), địa chỉ cố định thì không.
                </p>
              </div>

              {/* Local URL info (informational) */}
              <div className="bg-muted/40 rounded-lg px-3 py-2">
                <p className="text-[10px] text-muted-foreground mb-0.5">URL local (nội bộ, không dùng để cấu hình webhook):</p>
                <code className="text-[11px] text-muted-foreground font-mono">{localWebhookUrl}</code>
              </div>
            </div>
          </div>
        )}

        {/* KiotViet / Sapo: Deplao đăng ký webhook giúp (Secret KiotViet lưu vào kết nối → làm mới mục Bảo mật webhook) */}
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
          <h2 className="text-sm font-semibold text-foreground/80 mb-3"><ChatIcon className="w-4 h-4 inline" /> Sử dụng trong hội thoại</h2>
          <div className="bg-card rounded-xl p-4 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Sau khi kết nối, bạn có thể tra cứu thông tin trực tiếp khi đang chat với khách hàng
              mà không cần rời khỏi cửa sổ hội thoại:
            </p>

            <div className="bg-muted/50 rounded-lg p-3 border border-input/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg"><PluginIcon className="w-4 h-4" /></span>
                <span className="text-xs font-semibold text-foreground">Bảng điều khiển Tích hợp nhanh</span>
              </div>
              <ol className="space-y-1.5 text-[11px] text-muted-foreground ml-1">
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">1.</span>
                  <span>Nhấn nút <span className="text-blue-300 font-medium"><LinkIcon className="w-4 h-4 inline" /> Tích hợp nhanh</span> (hình mắt xích) trên thanh tiêu đề hội thoại, hoặc nút ⋯ Thêm tính năng ở ô soạn tin → Tích hợp nhanh</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">2.</span>
                  <span>Chọn <span className="text-foreground font-medium">{catalogItem.name}</span> từ danh sách tích hợp trong panel bên phải</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">3.</span>
                  <span>Chọn thao tác muốn thực hiện bên dưới:</span>
                </li>
              </ol>
            </div>

            {/* Available quick actions for this integration type */}
            {(catalogItem.type === 'kiotviet' || catalogItem.type === 'haravan' || catalogItem.type === 'sapo' || catalogItem.type === 'nhanh' || catalogItem.type === 'pancake') && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: <UserIcon className="w-4 h-4" />, label: 'Tra cứu KH', desc: 'Theo SĐT' },
                  { icon: <ClipboardListIcon className="w-4 h-4" />, label: 'Tra cứu đơn', desc: 'Theo mã/SĐT' },
                  { icon: <SearchIcon className="w-4 h-4" />, label: 'Tìm sản phẩm', desc: 'Theo tên/SKU' },
                  { icon: <EditIcon className="w-4 h-4" />, label: 'Tạo đơn hàng', desc: 'Tạo đơn mới' },
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
                  { icon: '🗺️', label: 'DS tỉnh/thành' },
                  { icon: '🏙️', label: 'DS quận/huyện' },
                  { icon: '📍', label: 'DS phường/xã' },
                  { icon: '🚛', label: 'Dịch vụ GHN' },
                  { icon: <PackageIcon className="w-4 h-4" />, label: 'Tra vận đơn' },
                  { icon: '💵', label: 'Tính phí ship' },
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
                  { icon: <TruckIcon className="w-4 h-4" />, label: 'Tra vận đơn' },
                  { icon: '💵', label: 'Tính phí ship' },
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
                  { icon: <CreditCardIcon className="w-4 h-4" />, label: 'LS giao dịch' },
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
                Kết quả tra cứu hiển thị ngay trong panel - có thể xem chi tiết đơn hàng,
                sản phẩm, thông tin khách hàng. Hỗ trợ <strong className="text-foreground/80">ghim thao tác</strong> ra toolbar
                để truy cập nhanh hơn.
              </span>
            </p>
          </div>
        </div>

        {/* Workflow hint */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-blue-300 mb-2"><SunIcon className="w-4 h-4 inline" /> Bước Workflow có sẵn</h3>
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
            {deleting ? 'Đang xóa...' : 'Xóa'}
          </button>
        )}
        <div className="flex-1"/>
        {saved_id && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-4 py-2 text-sm rounded-lg bg-muted hover:bg-accent text-foreground transition-colors"
          >
            {testing ? 'Đang test...' : <><SearchIcon className="w-4 h-4 inline" /> Test kết nối</>}
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {saving ? 'Đang lưu...' : saved_id ? <><HardDriveIcon className="w-3.5 h-3.5 inline" /> Cập nhật</> : 'Kết nối'}
        </button>
      </div>
    </div>
  );
}

