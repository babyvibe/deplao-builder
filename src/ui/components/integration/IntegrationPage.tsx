import React, { useEffect, useState, useCallback, useRef } from 'react';
import PageLoading from '@/components/common/PageLoading';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useEmployeeStore } from '@/store/employeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import PublicAddressCard, { usePublicAddresses } from '@/components/common/PublicAddressCard';
import { navigateSettings } from '@/components/settings/cloud/cloudUi';
import IntegrationDetailPage, { type IntegrationWebhookInfo } from './IntegrationDetailPage';
import AIAssistantPage from './AIAssistantPage';
import type { CredentialAlternative } from './credentialRules';
import { AlertIcon, BotIcon, ChatIcon, CheckCircleIcon, CreditCardIcon, DollarIcon, GlobeIcon, LightningIcon, MenuIcon, PackageIcon, PinIcon, PluginIcon, RefreshIcon, RocketIcon, ShoppingCartIcon, ShuffleIcon, SparklesIcon, StoreIcon, TargetIcon, TruckIcon } from '@/components/common/icons';

// ─── Catalog definition ───────────────────────────────────────────────────────

interface CatalogItem {
  type: string;
  name: string;
  desc: string;
  icon: React.ReactNode;
  color: string;
  priority: 'p0' | 'p1' | 'p2';
  credentialFields: { key: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean }[];
  /** Nhiều cách đăng nhập: phải điền đủ ít nhất một nhóm (credentialRules.ts). */
  credentialAlternatives?: CredentialAlternative[];
  settingFields?: { key: string; label: string; type?: string; options?: { value: string; label: string }[] }[];
}

type TabKey = 'all' | 'pos' | 'payment' | 'shipping' | 'ai' | 'messaging';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'all',       label: 'Tất cả',            icon: <PinIcon className="w-4 h-4" /> },
  { key: 'pos',       label: 'POS / Bán hàng',    icon: <ShoppingCartIcon className="w-4 h-4" /> },
  { key: 'payment',   label: 'Thanh toán',        icon: <CreditCardIcon className="w-4 h-4" /> },
  { key: 'shipping',  label: 'Vận chuyển',        icon: <PackageIcon className="w-4 h-4" /> },
  { key: 'messaging', label: 'Tin nhắn',          icon: <ChatIcon className="w-4 h-4" /> },
  { key: 'ai',        label: 'Trợ lý AI',         icon: <BotIcon className="w-4 h-4" /> },
];

const SECTION_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  ai:        { label: 'Trợ lý AI',      icon: <BotIcon className="w-4 h-4" />, color: 'bg-amber-600' },
  pos:       { label: 'POS / Bán hàng', icon: <ShoppingCartIcon className="w-4 h-4" />, color: 'bg-orange-500' },
  payment:   { label: 'Thanh toán',     icon: <CreditCardIcon className="w-4 h-4" />, color: 'bg-green-600' },
  shipping:  { label: 'Vận chuyển',     icon: <PackageIcon className="w-4 h-4" />, color: 'bg-red-500' },
  messaging: { label: 'Tin nhắn',       icon: <ChatIcon className="w-4 h-4" />, color: 'bg-blue-500' },
};

const AI_PLATFORMS: { key: string; label: string; icon: React.ReactNode; color: string; desc: string }[] = [
  { key: 'openai',   label: 'OpenAI',   icon: <BotIcon className="w-4 h-4" />, color: 'bg-green-600',   desc: 'GPT-4o, GPT-4.1, o3, o4-mini' },
  { key: 'gemini',   label: 'Gemini',   icon: <SparklesIcon className="w-4 h-4" />, color: 'bg-blue-600',    desc: 'Gemini 2.0 Flash, 2.5 Pro' },
  { key: 'claude',   label: 'Claude',   icon: <AlertIcon className="w-4 h-4" />, color: 'bg-amber-600',   desc: 'Sonnet 4.6, Opus 4.8, Haiku 4.5' },
  { key: 'deepseek', label: 'DeepSeek', icon: <TargetIcon className="w-4 h-4" />, color: 'bg-purple-600',  desc: 'DeepSeek V3, R1' },
  { key: 'grok',     label: 'Grok',     icon: <LightningIcon className="w-4 h-4" />, color: 'bg-orange-600',  desc: 'Grok 3, Grok 3 Mini' },
  { key: 'openrouter', label: 'OpenRouter', icon: <ShuffleIcon className="w-4 h-4" />, color: 'bg-indigo-600', desc: 'Gateway nhiều model qua một API key' },
];

const AI_PLATFORM_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  openai:   { label: 'OpenAI',   color: 'bg-green-600',   icon: <BotIcon className="w-4 h-4" /> },
  gemini:   { label: 'Gemini',   color: 'bg-blue-600',    icon: <SparklesIcon className="w-4 h-4" /> },
  claude:   { label: 'Claude',   color: 'bg-amber-600',   icon: <AlertIcon className="w-4 h-4" /> },
  deepseek: { label: 'DeepSeek', color: 'bg-purple-600',  icon: <TargetIcon className="w-4 h-4" /> },
  grok:     { label: 'Grok',     color: 'bg-orange-600',  icon: <LightningIcon className="w-4 h-4" /> },
  openrouter: { label: 'OpenRouter', color: 'bg-indigo-600', icon: <ShuffleIcon className="w-4 h-4" /> },
};

const CATALOG: Record<string, CatalogItem[]> = {
  pos: [
    {
      type: 'kiotviet', name: 'KiotViet', priority: 'p0',
      icon: <ShoppingCartIcon className="w-4 h-4" />, color: 'bg-orange-500',
      desc: 'Tra cứu đơn hàng, khách hàng ngay trong chat. Tạo đơn hàng từ workflow.',
      credentialFields: [
        { key: 'clientId',     label: 'Client ID',     placeholder: 'KiotViet client_id' },
        { key: 'clientSecret', label: 'Client Secret', secret: true, placeholder: 'KiotViet client_secret' },
        { key: 'retailerName', label: 'Tên gian hàng (Retailer)', placeholder: 'vd: myshop' },
        // Khoá xác thực webhook (posWebhook.ts) — chỉ cần khi nhận webhook; trống = webhook bị từ chối
        { key: 'webhookSecret', label: 'Webhook Secret (không bắt buộc)', secret: true, optional: true, placeholder: 'Secret (chuỗi Base64) đã dùng khi đăng ký webhook KiotViet — cần khi nhận webhook' },
      ],
      settingFields: [
        { key: 'defaultBranchId', label: 'Branch ID mặc định (tùy chọn)' },
      ],
    },
    {
      type: 'haravan', name: 'Haravan', priority: 'p0',
      icon: <StoreIcon className="w-4 h-4" />, color: 'bg-indigo-500',
      desc: 'Nền tảng TMĐT Việt Nam. Tra cứu đơn hàng, khách hàng Haravan trong chat.',
      // Đăng nhập bằng Access Token (Custom App) HOẶC API Key + Password (ứng dụng riêng) — HaravanAdapter.getHeaders
      credentialFields: [
        { key: 'accessToken',   label: 'Access Token (khuyên dùng)', secret: true, placeholder: 'Access Token từ Custom App — bỏ trống nếu dùng API Key + Password', optional: true },
        { key: 'apiKey',        label: 'API Key (ứng dụng riêng)', placeholder: 'Bỏ trống nếu dùng Access Token', optional: true },
        { key: 'password',      label: 'Password (ứng dụng riêng)', secret: true, placeholder: 'Bỏ trống nếu dùng Access Token', optional: true },
        { key: 'retailerDomain', label: 'Tên shop (subdomain)', placeholder: 'vd: myshop hoặc myshop.myharavan.com' },
        { key: 'webhookSecret', label: 'Mã xác thực webhook (không bắt buộc)', secret: true, optional: true, placeholder: 'Mã xác thực ở Cài đặt → Thông báo → Webhook (app: Client Secret) — cần khi nhận webhook' },
      ],
      credentialAlternatives: [
        { label: 'Access Token', keys: ['accessToken'] },
        { label: 'API Key + Password', keys: ['apiKey', 'password'] },
      ],
    },
    {
      type: 'sapo', name: 'Sapo', priority: 'p0',
      icon: <CheckCircleIcon className="w-4 h-4" />, color: 'bg-emerald-500',
      desc: 'Quản lý bán hàng đa kênh Sapo. Tra cứu đơn, khách hàng theo SĐT.',
      credentialFields: [
        // Ứng dụng riêng (Private App): API Key + API Secret, xác thực Basic — không cần domain / Redirect URL.
        // Access Token chỉ có khi đi luồng OAuth của ứng dụng Partner (support.sapo.vn/oauth).
        { key: 'storeDomain', label: 'Tên cửa hàng', placeholder: 'vd: myshop hoặc myshop.mysapo.net' },
        { key: 'apiKey',      label: 'API Key', placeholder: 'Sapo Web → Ứng dụng → Ứng dụng riêng → Tạo ứng dụng riêng' },
        { key: 'apiSecret',   label: 'API Secret', secret: true, placeholder: 'Mật khẩu đi kèm API Key của ứng dụng riêng' },
        { key: 'accessToken', label: 'Access Token OAuth (không bắt buộc)', secret: true, placeholder: 'Bỏ trống nếu dùng API Key + API Secret', optional: true },
        { key: 'webhookSecret', label: 'Khoá xác thực webhook (không bắt buộc)', secret: true, optional: true, placeholder: 'Bỏ trống = dùng API Secret (Sapo ký webhook bằng API Secret của ứng dụng riêng)' },
      ],
    },
    {
      type: 'nhanh', name: 'Nhanh.vn', priority: 'p0',
      icon: <LightningIcon className="w-4 h-4" />, color: 'bg-yellow-600',
      desc: 'Phần mềm bán hàng đa kênh Nhanh.vn. Quản lý đơn hàng, kho, khách hàng.',
      credentialFields: [
        { key: 'appId',       label: 'App ID',       placeholder: 'Nhanh.vn Open API App ID' },
        { key: 'businessId',  label: 'Business ID',  placeholder: 'Nhanh.vn Business ID' },
        { key: 'accessToken', label: 'Access Token v3', secret: true, placeholder: 'Lấy từ open.nhanh.vn → Ứng dụng của tôi' },
        { key: 'webhookSecret', label: 'Webhooks verify token (không bắt buộc)', secret: true, optional: true, placeholder: 'Token tự đặt trong phần Webhooks của ứng dụng Nhanh.vn — cần khi nhận webhook' },
      ],
    },
    {
      type: 'pancake', name: 'Pancake POS', priority: 'p0',
      icon: <MenuIcon className="w-4 h-4" />, color: 'bg-amber-500',
      desc: 'Pancake POS/OMS. Tra cứu khách hàng, đơn hàng, sản phẩm và tạo đơn ngay trong chat.',
      credentialFields: [
        { key: 'accessToken', label: 'API Key (api_key)', secret: true, placeholder: 'Pancake Open API key' },
        { key: 'shopId', label: 'Shop ID', placeholder: 'Mã shop Pancake' },
        { key: 'webhookSecret', label: 'Khoá webhook X-API-KEY (không bắt buộc)', secret: true, optional: true, placeholder: 'Chuỗi bí mật tự đặt, khai báo làm header X-API-KEY khi cấu hình webhook Pancake' },
      ],
    },
  ],
  payment: [
    {
      type: 'casso', name: 'Casso', priority: 'p0',
      icon: <CreditCardIcon className="w-4 h-4" />, color: 'bg-green-600',
      desc: 'Nhận webhook khi có giao dịch chuyển khoản VietQR. Tự động xác nhận đơn.',
      credentialFields: [
        { key: 'apiKey',    label: 'API Key', secret: true, placeholder: 'Casso API Key' },
        // Có khoá → Deplao chỉ nhận webhook có chữ ký hợp lệ (X-Casso-Signature / secure-token)
        { key: 'secretKey', label: 'Secret Key (webhook)', secret: true, optional: true, placeholder: 'Key bảo mật của tích hợp Webhook V2 trong Casso (khuyên dùng)' },
      ],
    },
    {
      type: 'sepay', name: 'SePay', priority: 'p0',
      icon: <DollarIcon className="w-4 h-4" />, color: 'bg-teal-600',
      desc: 'Nhận webhook giao dịch từ SePay. Kích hoạt workflow tự động khi nhận tiền.',
      credentialFields: [
        { key: 'apiKey',          label: 'API Key', secret: true, placeholder: 'SePay API Key' },
        // Có khoá → Deplao chỉ nhận webhook có chữ ký hợp lệ (X-SePay-Signature / Authorization: Apikey)
        { key: 'webhookSecretKey', label: 'Webhook Secret', secret: true, optional: true, placeholder: 'Secret Key (HMAC-SHA256, khuyên dùng) hoặc API Key ở bước Bảo mật của webhook SePay' },
      ],
    },
  ],
  shipping: [
    {
      type: 'ghn', name: 'GHN Express', priority: 'p0',
      icon: <PackageIcon className="w-4 h-4" />, color: 'bg-red-500',
      desc: 'Tạo đơn, tra cứu vận đơn GHN. Khách hỏi tracking → tự động reply.',
      credentialFields: [
        { key: 'token',  label: 'Token GHN', secret: true, placeholder: 'GHN Token' },
        { key: 'shopId', label: 'Shop ID',   placeholder: 'GHN Shop ID' },
      ],
      settingFields: [
        { key: 'environment', label: 'Môi trường', type: 'select', options: [
          { value: 'production', label: 'Production' },
          { value: 'sandbox',    label: 'Sandbox (test)' },
        ]},
      ],
    },
    {
      type: 'ghtk', name: 'GHTK', priority: 'p0',
      icon: <TruckIcon className="w-4 h-4" />, color: 'bg-blue-500',
      desc: 'Tạo đơn, tra cứu vận đơn GHTK. Tự động gửi cập nhật trạng thái đơn.',
      credentialFields: [
        { key: 'token', label: 'Token GHTK', secret: true, placeholder: 'GHTK API Token' },
      ],
    },
  ],
  messaging: [
    {
      type: 'telegram_bot', name: 'Telegram Bot', priority: 'p0',
      icon: <ChatIcon className="w-4 h-4" />, color: 'bg-blue-500',
      desc: 'Kết nối Bot Telegram để gửi thông báo từ Workflow và nhận lệnh từ khách hàng. Tạo bot miễn phí qua @BotFather trên Telegram.',
      credentialFields: [
        { key: 'botToken', label: 'Bot Token', secret: true, placeholder: '7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' },
      ],
      settingFields: [
        { key: 'defaultChatId', label: 'Chat ID mặc định (tùy chọn)' },
      ],
    },
  ],
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SavedIntegration {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  connectedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Casso / SePay / phần mềm bán hàng: đã đặt khoá bảo mật webhook chưa + lần nhận / từ chối gần nhất (IntegrationRegistry.listConfigs) */
  webhook?: IntegrationWebhookInfo;
}

// ─── Tunnel Status Card ───────────────────────────────────────────────────────

interface AIAssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
}

function AISection({ onNavigateAi }: { onNavigateAi: () => void }) {
  const [assistants, setAssistants] = useState<AIAssistantSummary[]>([]);
  const [loadingAi, setLoadingAi] = useState(true);
  const wsIdAISection = useWorkspaceStore(s => s.activeWorkspaceId);

  useEffect(() => {
    DataAccessor.getAssistants().then(res => {
      if (res?.success) setAssistants(res.assistants || []);
    }).catch(() => {}).finally(() => setLoadingAi(false));
  }, [wsIdAISection]);

  const hasAssistants = assistants.length > 0;

  return (
    <div id="section-ai" className="scroll-mt-20">
      {/* 🚀 9Router FREE Banner */}
      <div className="mb-4 bg-card border-l-4 border-l-blue-500 border border-border/60 rounded-xl p-3.5">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center text-lg flex-shrink-0 border border-blue-500/30"><RocketIcon className="w-4 h-4 inline" /> </div>
          <div className="flex-1 min-w-0">
            <p className="text-foreground/80 text-xs font-semibold mb-1.5">
              Cài đặt <strong className="text-foreground">9Router</strong> để dùng AI <strong className="text-green-400">FREE</strong> cho:
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                'Gợi ý trả lời trong hội thoại',
                'Hỏi đáp với AI trong hội thoại',
                'Dùng AI tạo workflow bằng câu lệnh',
                'Node AI trả lời - tạo chatbot 24/7',
              ].map((text, i) => (
                <p key={i} className="text-foreground/80 text-[11px] flex items-center gap-1.5">
                  <span className="text-blue-500/70">▸</span>
                  {text}
                </p>
              ))}
            </div>
          </div>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
              setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', {
                detail: { tab: 'introduction', subtab: 'ai-assistant' },
              })), 80);
            }}
            className="flex-shrink-0 px-3 py-1.5 text-[11px] rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-600/40 hover:border-blue-500/60 transition-colors font-medium"
          >
            Hướng dẫn →
          </button>
        </div>
      </div>

      {/* Section header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center text-base text-white-important"><BotIcon className="w-4 h-4 inline" /> </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Trợ lý AI</h2>
            {hasAssistants && (
              <span className="text-[10px] text-muted-foreground ml-1">({assistants.length} trợ lý)</span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Nhiều nền tảng AI · Tự động gợi ý trả lời, chat với AI, knowledge base
          </p>
        </div>
        <button
          onClick={onNavigateAi}
          className="flex-shrink-0 px-3 py-1.5 text-[11px] rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-600/30 hover:border-blue-500/50 transition-colors font-medium"
        >
          Quản lý →
        </button>
      </div>

      {loadingAi ? (
        <PageLoading variant="inline" text="Đang tải trợ lý AI..." size="sm" />
      ) : hasAssistants ? (
        /* ── Show actual assistant cards ── */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {assistants.map(a => {
            const meta = AI_PLATFORM_META[a.platform] || AI_PLATFORM_META.openai;
            return (
              <button
                key={a.id}
                onClick={onNavigateAi}
                className="text-left p-4 rounded-xl border border-border hover:border-blue-500 bg-card hover:bg-muted transition-all group"
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg ${meta.color} flex items-center justify-center text-lg flex-shrink-0 text-white-important`}>
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground text-sm truncate">{a.name}</span>
                      {a.isDefault && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 font-bold flex-shrink-0">MẶC ĐỊNH</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{meta.label} - {a.model}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className={`text-xs flex items-center gap-1 ${a.enabled ? 'text-green-400' : 'text-muted-foreground'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? 'bg-green-400' : 'bg-accent'}`}/>
                    {a.enabled ? 'Đang bật' : 'Đã tắt'}
                  </span>
                  <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">Cấu hình →</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        /* ── Show platform cards (clickable) ── */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {AI_PLATFORMS.map(platform => (
            <button
              key={platform.key}
              onClick={onNavigateAi}
              className="p-4 rounded-xl border border-border hover:border-blue-500 bg-card hover:bg-muted transition-all group text-left"
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg ${platform.color} flex items-center justify-center text-xl flex-shrink-0 text-white-important`}>
                  {platform.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground text-sm mb-1">{platform.label}</div>
                  <p className="text-xs text-muted-foreground leading-snug">{platform.desc}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Địa chỉ nhận webhook thanh toán / tích hợp (cổng 9888) — CHỈ XEM. Bật / tắt / đổi địa chỉ ở
 * Cài đặt → Internet & Đám mây → Địa chỉ Internet.
 */
function WebhookAddressCard({ webhookPort, tunnelUrl, savedList }: {
  webhookPort: number;
  /** Địa chỉ đang nhận (tunnel:status) — dùng khi bản app không có module Cloudflare. */
  tunnelUrl: string | null;
  savedList: SavedIntegration[];
}) {
  const pub = usePublicAddresses();
  const payments = pub.get('payments');
  // Đã bật (kể cả đang khởi động / lỗi — thẻ địa chỉ tự báo); bản app không có module Cloudflare thì theo tunnel:status
  const enabled = payments ? payments.enabled : !!tunnelUrl;
  const isPaymentType = (type: string) => type === 'casso' || type === 'sepay';
  // Cần địa chỉ nhận: thanh toán đã kết nối, phần mềm bán hàng đã đặt khoá webhook (muốn nhận webhook)
  const receivers = savedList
    .filter(s => (isPaymentType(s.type) && s.connectedAt) || (!isPaymentType(s.type) && s.enabled && s.webhook?.secretConfigured))
    .map(s => s.name);
  const paymentIntegrations = savedList.filter(s => isPaymentType(s.type) && s.enabled && s.webhook);
  // Chưa đặt khoá → ai biết địa chỉ cũng gửi được giao dịch giả (phần mềm bán hàng chưa đặt khoá thì webhook bị từ chối)
  const unsecured = paymentIntegrations.filter(s => !s.webhook!.secretConfigured).map(s => s.name);
  // Đang từ chối (chưa đặt khoá / thiếu / sai chữ ký) → workflow thanh toán / webhook bán hàng không chạy
  const rejecting = savedList.filter(s => s.enabled && s.webhook).filter(s => {
    const { lastAccepted, lastRejected } = s.webhook!;
    return !!lastRejected && lastRejected.reason !== 'disabled' && (!lastAccepted || lastRejected.at >= lastAccepted.at);
  }).map(s => s.name);

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <GlobeIcon className="h-4 w-4" /> Địa chỉ nhận webhook
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Casso và SePay gửi giao dịch chuyển khoản vào Deplao qua địa chỉ Internet này để chạy workflow
          “Khi nhận thanh toán”; KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS gửi đơn hàng / khách hàng để chạy workflow
          “Khi phần mềm bán hàng gửi webhook” (cần đặt khoá xác thực webhook trong trang tích hợp). Đơn vị vận chuyển không gửi
          dữ liệu vào đây — Deplao tự hỏi khi bạn tra cứu. Chỉ chạy khi Deplao đang mở.
          {!pub.serverManaged && (
            <> Bật, tắt hoặc đổi địa chỉ ở <strong className="text-foreground">Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet</strong>.</>
          )}
        </p>
      </div>

      <PublicAddressCard service="payments" title="Thanh toán, tích hợp" pathSuffix="/webhook/<loại>" anyMode compact />

      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Trên máy này (chỉ dùng nội bộ): <code className="font-mono">http://127.0.0.1:{webhookPort}/webhook/&lt;loại&gt;</code>.
        Đường dẫn đầy đủ để dán vào từng nền tảng nằm trong trang tích hợp của nền tảng đó.
      </p>

      {!enabled && receivers.length > 0 && !pub.serverManaged && (
        <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
          <p className="text-xs font-medium text-foreground">
            <AlertIcon className="inline h-4 w-4 text-warning" /> Đã kết nối {receivers.join(', ')} nhưng chưa bật địa chỉ nhận
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Webhook chưa vào được Deplao (thanh toán tự động, workflow theo webhook chưa chạy). Bật ở Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet.
          </p>
        </div>
      )}

      {(unsecured.length > 0 || rejecting.length > 0) && (
        <div role="alert" className="space-y-0.5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
          {unsecured.length > 0 && (
            <p className="text-[11px] text-foreground">
              <AlertIcon className="inline h-4 w-4 text-warning" /> {unsecured.join(', ')} chưa đặt khoá bảo mật webhook — ai biết địa chỉ
              cũng gửi được giao dịch giả. Mở trang tích hợp để đặt khoá.
            </p>
          )}
          {rejecting.length > 0 && (
            <p className="text-[11px] text-foreground">
              <AlertIcon className="inline h-4 w-4 text-warning" /> {rejecting.join(', ')} đang từ chối webhook (chưa đặt khoá hoặc thiếu / sai
              chữ ký) — xem mục Bảo mật webhook trong trang tích hợp.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section Component ────────────────────────────────────────────────────────

function IntegrationSection({ sectionKey, catalog, savedList, onSelect }: {
  sectionKey: string;
  catalog: CatalogItem[];
  savedList: SavedIntegration[];
  onSelect: (item: CatalogItem, saved?: SavedIntegration) => void;
}) {
  const meta = SECTION_META[sectionKey];
  if (!meta || !catalog.length) return null;

  const connectedCount = catalog.filter(c => savedList.some(s => s.type === c.type && s.connectedAt)).length;

  return (
    <div id={`section-${sectionKey}`} className="scroll-mt-20">
      {/* Section header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-8 h-8 rounded-lg ${meta.color} flex items-center justify-center text-base text-white-important`}>
          {meta.icon}
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{meta.label}</h2>
          <p className="text-[10px] text-muted-foreground">
            {catalog.length} nền tảng
            {connectedCount > 0 && <span className="text-green-500"> · {connectedCount} đã kết nối</span>}
          </p>
        </div>
      </div>

      {/* Items grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-8">
        {catalog.map(item => {
          const saved = savedList.find(s => s.type === item.type);
          const connected = !!saved?.connectedAt;
          return (
            <button
              key={item.type}
              onClick={() => onSelect(item, saved)}
              className="text-left p-4 rounded-xl border border-border hover:border-blue-500 bg-card hover:bg-muted transition-all group"
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg ${item.color} flex items-center justify-center text-xl flex-shrink-0 text-white-important`}>
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-foreground text-sm">{item.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">{item.desc}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className={`text-xs flex items-center gap-1 ${connected ? 'text-green-400' : 'text-muted-foreground'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-accent'}`}/>
                  {connected ? 'Đã kết nối' : saved ? 'Chưa xác nhận' : 'Chưa kết nối'}
                </span>
                <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  {saved ? 'Cấu hình →' : 'Kết nối →'}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function IntegrationPage() {
  const empMode = useEmployeeStore(s => s.mode);
  const bossConnected = useEmployeeStore(s => s.bossConnected);
  const isOfflineEmployee = empMode === 'employee' && !bossConnected;
  const [savedList, setSavedList] = useState<SavedIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<{ catalogItem: CatalogItem; saved?: SavedIntegration } | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [webhookPort, setWebhookPort] = useState<number>(9888);
  // Địa chỉ nhận webhook đang chạy (chỉ đọc) — bật / tắt ở Cài đặt → Internet & Đám mây → Địa chỉ Internet
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  // Allow the global feature launcher to select a specific integration category.
  useEffect(() => {
    const handler = (event: Event) => {
      const tab = (event as CustomEvent).detail?.tab as TabKey | undefined;
      if (tab && TABS.some(item => item.key === tab)) setActiveTab(tab);
    };
    window.addEventListener('nav:integration', handler);
    return () => window.removeEventListener('nav:integration', handler);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      // Employee mode: integration list trả về empty từ IPC guard
      const res = await DataAccessor.getIntegrations();
      if (res?.success) {
        setSavedList(res.integrations || []);
        if (res.webhookPort) setWebhookPort(res.webhookPort);
      }
    } catch {}
    try {
      const ts = await ipc.tunnel?.status();
      setTunnelUrl(ts?.active ? ts.url ?? null : null);
    } catch {}
    setLoading(false);
  }, [workspaceId]); // ← reload khi chuyển workspace

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    const unsub = ipc.on?.('tunnel:changed', (data: { url: string | null }) => {
      setTunnelUrl(data?.url ?? null);
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  const handleNavigateAi = () => {
    setActiveTab('ai');
  };

  const scrollToSection = (key: TabKey) => {
    setActiveTab(key);
    if (key === 'ai') return;
    setTimeout(() => {
      const el = key === 'all' ? contentRef.current : document.getElementById(`section-${key}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const handleSelectItem = (item: CatalogItem, saved?: SavedIntegration) => {
    setSelectedDetail({ catalogItem: item, saved });
  };

  if (selectedDetail) {
    return (
      <IntegrationDetailPage
        catalogItem={selectedDetail.catalogItem}
        saved={selectedDetail.saved}
        webhookPort={webhookPort}
        onBack={() => { setSelectedDetail(null); loadList(); }}
      />
    );
  }

  if (activeTab === 'ai') {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        {/* Top bar */}
        <TopBar activeTab={activeTab} onTabChange={scrollToSection} tunnelUrl={tunnelUrl} />
        <div className="flex-1 overflow-hidden">
          <AIAssistantPage />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Top horizontal tab bar */}
      <TopBar activeTab={activeTab} onTabChange={scrollToSection} tunnelUrl={tunnelUrl} />

      {/* Scrollable content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 space-y-2">

          {isOfflineEmployee ? (
            <div className="flex flex-col items-center justify-center h-full py-20 text-center text-muted-foreground">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-muted-foreground mb-4">
                <rect x="2" y="2" width="20" height="20" rx="3" />
                <path d="M9 12h6M12 9v6" />
              </svg>
              <p className="text-muted-foreground font-semibold mb-1">Không có dữ liệu</p>
              <p className="text-muted-foreground text-sm">Mất kết nối tới Boss. Dữ liệu tích hợp không khả dụng.</p>
            </div>
          ) : loading ? (
            <PageLoading variant="inline" text="Đang tải tích hợp..." />
          ) : activeTab === 'all' ? (
            /* ── "Tất cả" - AI first, then sections ── */
            <>
              <AISection onNavigateAi={handleNavigateAi} />

              {Object.entries(CATALOG).map(([key, items]) => (
                <IntegrationSection
                  key={key}
                  sectionKey={key}
                  catalog={items}
                  savedList={savedList}
                  onSelect={handleSelectItem}
                />
              ))}

              {/* Divider before webhook address */}
              <div className="border-t border-border/40 pt-6">
                <WebhookAddressCard webhookPort={webhookPort} tunnelUrl={tunnelUrl} savedList={savedList} />
              </div>
            </>
          ) : (
            /* ── Single tab: show that section only ── */
            <>
              <IntegrationSection
                sectionKey={activeTab}
                catalog={CATALOG[activeTab] || []}
                savedList={savedList}
                onSelect={handleSelectItem}
              />

              {/* Webhook address card for payment section */}
              {activeTab === 'payment' && (
                <div className="pt-4">
                  <WebhookAddressCard webhookPort={webhookPort} tunnelUrl={tunnelUrl} savedList={savedList} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Top Navigation Bar ───────────────────────────────────────────────────────

/**
 * Trạng thái địa chỉ nhận webhook (một dòng, chỉ xem). Bấm → Cài đặt → Internet & Đám mây → Địa chỉ Internet;
 * máy nhân viên không hiện, bản app không có module Cloudflare thì chỉ hiện chữ.
 */
function WebhookStatusPill({ tunnelUrl }: { tunnelUrl: string | null }) {
  const pub = usePublicAddresses();
  if (pub.serverManaged) return null;
  const payments = pub.get('payments');
  // Bản app không có module Cloudflare: theo tunnel:status (chỉ có địa chỉ khi đang chạy)
  const url = payments ? (payments.enabled && payments.state === 'active' ? payments.url : null) : tunnelUrl;
  const pending = !url && !!payments?.enabled;
  const className = 'flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground';
  const content = (
    <>
      <span className={cn('h-2 w-2 rounded-full', url ? 'bg-success' : pending ? 'bg-warning' : 'bg-accent')} aria-hidden="true" />
      <span>{url ? 'Đang nhận webhook' : pending ? 'Webhook chưa sẵn sàng' : 'Webhook chưa bật'}</span>
    </>
  );
  if (!pub.canConfigure) return <span className={className} title={url || undefined}>{content}</span>;
  return (
    <button
      type="button"
      onClick={() => navigateSettings('cloud', 'address')}
      className={cn(className, 'transition-colors hover:bg-muted hover:text-foreground')}
      title={url ? `${url} — đổi ở Cài đặt → Internet & Đám mây` : 'Bật ở Cài đặt → Internet & Đám mây → Địa chỉ Internet'}
    >
      {content}
    </button>
  );
}

function TopBar({ activeTab, onTabChange, tunnelUrl }: {
  activeTab: TabKey;
  onTabChange: (key: TabKey) => void;
  tunnelUrl: string | null;
}) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-card/95">
      <div className="px-6">
        {/* Title row */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-foreground"><PluginIcon className="w-4 h-4 inline" /> Tích hợp</h1>
            <p className="text-[11px] text-muted-foreground">Kết nối nền tảng bên ngoài</p>
          </div>
          {/* Địa chỉ nhận webhook — chỉ xem, bật / tắt ở Cài đặt → Internet & Đám mây */}
          <WebhookStatusPill tunnelUrl={tunnelUrl} />
        </div>

        {/* Horizontal tabs */}
        <nav className="flex gap-1 -mb-px">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'text-blue-400 border-blue-500 bg-blue-600/10'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border-strong'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
