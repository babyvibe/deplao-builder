import React, { useEffect, useState, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';
import IntegrationDetailPage from './IntegrationDetailPage';
import AIAssistantPage from './AIAssistantPage';

// ─── Catalog definition ───────────────────────────────────────────────────────

interface CatalogItem {
  type: string;
  name: string;
  desc: string;
  icon: string;
  color: string;
  priority: 'p0' | 'p1' | 'p2';
  credentialFields: { key: string; label: string; secret?: boolean; placeholder?: string }[];
  settingFields?: { key: string; label: string; type?: string; options?: { value: string; label: string }[] }[];
}

type TabKey = 'all' | 'pos' | 'payment' | 'shipping' | 'ai';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'all',      label: 'Tất cả',            icon: '📌' },
  { key: 'pos',      label: 'POS / Bán hàng',    icon: '🛒' },
  { key: 'payment',  label: 'Thanh toán',        icon: '💳' },
  { key: 'shipping', label: 'Vận chuyển',        icon: '📦' },
  { key: 'ai',       label: 'Trợ lý AI',         icon: '🤖' },
];

const SECTION_META: Record<string, { label: string; icon: string; color: string }> = {
  ai:       { label: 'Trợ lý AI',      icon: '🤖', color: 'bg-amber-600' },
  pos:      { label: 'POS / Bán hàng', icon: '🛒', color: 'bg-orange-500' },
  payment:  { label: 'Thanh toán',     icon: '💳', color: 'bg-green-600' },
  shipping: { label: 'Vận chuyển',     icon: '📦', color: 'bg-red-500' },
};

const AI_PLATFORMS: { key: string; label: string; icon: string; color: string; desc: string }[] = [
  { key: 'openai',   label: 'OpenAI',   icon: '🤖', color: 'bg-green-600',   desc: 'GPT-4o, GPT-4.1, o3, o4-mini' },
  { key: 'gemini',   label: 'Gemini',   icon: '✨', color: 'bg-blue-600',    desc: 'Gemini 2.0 Flash, 2.5 Pro' },
  { key: 'claude',   label: 'Claude',   icon: '🟠', color: 'bg-amber-600',   desc: 'Sonnet 4.6, Opus 4.8, Haiku 4.5' },
  { key: 'deepseek', label: 'DeepSeek', icon: '🔮', color: 'bg-purple-600',  desc: 'DeepSeek V3, R1' },
  { key: 'grok',     label: 'Grok',     icon: '⚡', color: 'bg-orange-600',  desc: 'Grok 3, Grok 3 Mini' },
  { key: 'openrouter', label: 'OpenRouter', icon: '🔀', color: 'bg-indigo-600', desc: 'Gateway nhiều model qua một API key' },
];

const AI_PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  openai:   { label: 'OpenAI',   color: 'bg-green-600',   icon: '🤖' },
  gemini:   { label: 'Gemini',   color: 'bg-blue-600',    icon: '✨' },
  claude:   { label: 'Claude',   color: 'bg-amber-600',   icon: '🟠' },
  deepseek: { label: 'DeepSeek', color: 'bg-purple-600',  icon: '🔮' },
  grok:     { label: 'Grok',     color: 'bg-orange-600',  icon: '⚡' },
  openrouter: { label: 'OpenRouter', color: 'bg-indigo-600', icon: '🔀' },
};

const CATALOG: Record<string, CatalogItem[]> = {
  pos: [
    {
      type: 'kiotviet', name: 'KiotViet', priority: 'p0',
      icon: '🛒', color: 'bg-orange-500',
      desc: 'Tra cứu đơn hàng, khách hàng ngay trong chat. Tạo đơn hàng từ workflow.',
      credentialFields: [
        { key: 'clientId',     label: 'Client ID',     placeholder: 'KiotViet client_id' },
        { key: 'clientSecret', label: 'Client Secret', secret: true, placeholder: 'KiotViet client_secret' },
        { key: 'retailerName', label: 'Tên gian hàng (Retailer)', placeholder: 'vd: myshop' },
      ],
      settingFields: [
        { key: 'defaultBranchId', label: 'Branch ID mặc định (tùy chọn)' },
      ],
    },
    {
      type: 'haravan', name: 'Haravan', priority: 'p0',
      icon: '🏪', color: 'bg-indigo-500',
      desc: 'Nền tảng TMĐT Việt Nam. Tra cứu đơn hàng, khách hàng Haravan trong chat.',
      credentialFields: [
        { key: 'accessToken',   label: 'Access Token (khuyên dùng)', secret: true, placeholder: 'Haravan Access Token từ Custom App' },
        { key: 'apiKey',        label: 'API Key (legacy)', placeholder: 'Bỏ trống nếu dùng Access Token' },
        { key: 'password',      label: 'Password (legacy)', secret: true, placeholder: 'Bỏ trống nếu dùng Access Token' },
        { key: 'retailerDomain', label: 'Tên shop (subdomain)', placeholder: 'vd: myshop hoặc myshop.myharavan.com' },
      ],
    },
    {
      type: 'sapo', name: 'Sapo', priority: 'p0',
      icon: '🟢', color: 'bg-emerald-500',
      desc: 'Quản lý bán hàng đa kênh Sapo. Tra cứu đơn, khách hàng theo SĐT.',
      credentialFields: [
        { key: 'accessToken',  label: 'Access Token', secret: true, placeholder: 'Lấy từ SAPO Admin → Cài đặt → Phát triển → Quản lý API → Token' },
        { key: 'storeDomain', label: 'Tên store (subdomain)', placeholder: 'vd: myshop (myshop.mysapo.net)' },
      ],
    },
    {
      type: 'nhanh', name: 'Nhanh.vn', priority: 'p0',
      icon: '⚡', color: 'bg-yellow-600',
      desc: 'Phần mềm bán hàng đa kênh Nhanh.vn. Quản lý đơn hàng, kho, khách hàng.',
      credentialFields: [
        { key: 'appId',       label: 'App ID',       placeholder: 'Nhanh.vn Open API App ID' },
        { key: 'businessId',  label: 'Business ID',  placeholder: 'Nhanh.vn Business ID' },
        { key: 'accessToken', label: 'Access Token v3', secret: true, placeholder: 'Lấy từ open.nhanh.vn → Ứng dụng của tôi' },
      ],
    },
    {
      type: 'pancake', name: 'Pancake POS', priority: 'p0',
      icon: '🥞', color: 'bg-amber-500',
      desc: 'Pancake POS/OMS. Tra cứu khách hàng, đơn hàng, sản phẩm và tạo đơn ngay trong chat.',
      credentialFields: [
        { key: 'accessToken', label: 'API Key (api_key)', secret: true, placeholder: 'Pancake Open API key' },
        { key: 'shopId', label: 'Shop ID', placeholder: 'Mã shop Pancake' },
      ],
    },
  ],
  payment: [
    {
      type: 'casso', name: 'Casso', priority: 'p0',
      icon: '💳', color: 'bg-green-600',
      desc: 'Nhận webhook khi có giao dịch chuyển khoản VietQR. Tự động xác nhận đơn.',
      credentialFields: [
        { key: 'apiKey',    label: 'API Key', secret: true, placeholder: 'Casso API Key' },
        { key: 'secretKey', label: 'Secret Key (webhook)', secret: true, placeholder: 'Để trống nếu không dùng' },
      ],
    },
    {
      type: 'sepay', name: 'SePay', priority: 'p0',
      icon: '💰', color: 'bg-teal-600',
      desc: 'Nhận webhook giao dịch từ SePay. Kích hoạt workflow tự động khi nhận tiền.',
      credentialFields: [
        { key: 'apiKey',          label: 'API Key', secret: true, placeholder: 'SePay API Key' },
        { key: 'webhookSecretKey', label: 'Webhook Secret', secret: true, placeholder: 'Để trống nếu không cần' },
      ],
    },
  ],
  shipping: [
    {
      type: 'ghn', name: 'GHN Express', priority: 'p0',
      icon: '📦', color: 'bg-red-500',
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
      icon: '🚚', color: 'bg-blue-500',
      desc: 'Tạo đơn, tra cứu vận đơn GHTK. Tự động gửi cập nhật trạng thái đơn.',
      credentialFields: [
        { key: 'token', label: 'Token GHTK', secret: true, placeholder: 'GHTK API Token' },
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

  useEffect(() => {
    ipc.ai?.listAssistants().then(res => {
      if (res?.success) setAssistants(res.assistants || []);
    }).catch(() => {}).finally(() => setLoadingAi(false));
  }, []);

  const hasAssistants = assistants.length > 0;

  return (
    <div id="section-ai" className="scroll-mt-20">
      {/* 🚀 9Router FREE Banner */}
      <div className="mb-4 bg-gray-900/60 border-l-4 border-l-blue-500 border border-gray-700/60 rounded-xl p-3.5">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center text-lg flex-shrink-0 border border-blue-500/30">
            🚀
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-gray-300 text-xs font-semibold mb-1.5">
              Cài đặt <strong className="text-white">9Router</strong> để dùng AI <strong className="text-green-400">FREE</strong> cho:
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                '💬 Gợi ý trả lời trong hội thoại',
                '🤖 Hỏi đáp với AI trong hội thoại',
                '⚡ Dùng AI tạo workflow bằng câu lệnh',
                '🔄 Node AI trả lời — tạo chatbot 24/7',
              ].map((text, i) => (
                <p key={i} className="text-gray-300 text-[11px] flex items-center gap-1.5">
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
        <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center text-base">
          🤖
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Trợ lý AI</h2>
            {hasAssistants && (
              <span className="text-[10px] text-gray-500 ml-1">({assistants.length} trợ lý)</span>
            )}
          </div>
          <p className="text-[10px] text-gray-500">
            5 nền tảng · Tự động gợi ý trả lời, chat với AI, knowledge base
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
        <div className="flex items-center justify-center h-24 mb-8">
          <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        </div>
      ) : hasAssistants ? (
        /* ── Show actual assistant cards ── */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {assistants.map(a => {
            const meta = AI_PLATFORM_META[a.platform] || AI_PLATFORM_META.openai;
            return (
              <button
                key={a.id}
                onClick={onNavigateAi}
                className="text-left p-4 rounded-xl border border-gray-700 hover:border-blue-500 bg-gray-800 hover:bg-gray-750 transition-all group"
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg ${meta.color} flex items-center justify-center text-lg flex-shrink-0`}>
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-white text-sm truncate">{a.name}</span>
                      {a.isDefault && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 font-bold flex-shrink-0">MẶC ĐỊNH</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">{meta.label} — {a.model}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className={`text-xs flex items-center gap-1 ${a.enabled ? 'text-green-400' : 'text-gray-500'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? 'bg-green-400' : 'bg-gray-600'}`}/>
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
              className="p-4 rounded-xl border border-gray-700 hover:border-blue-500 bg-gray-800/60 hover:bg-gray-750 transition-all group text-left"
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg ${platform.color} flex items-center justify-center text-xl flex-shrink-0`}>
                  {platform.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white text-sm mb-1">{platform.label}</div>
                  <p className="text-xs text-gray-400 leading-snug">{platform.desc}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TunnelStatusCard({ webhookPort, tunnelUrl, tunnelLoading, onToggle, savedList }: {
  webhookPort: number;
  tunnelUrl: string | null;
  tunnelLoading: boolean;
  onToggle: () => void;
  savedList: SavedIntegration[];
}) {
  const hasPaymentIntegration = savedList.some(s => (s.type === 'casso' || s.type === 'sepay') && s.connectedAt);

  return (
    <div className="bg-gray-700 dark:bg-gray-800 border border-gray-200 dark:border-gray-700/60 rounded-2xl p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <span>🌐</span> Webhook Tunnel — Kết nối Internet
          </h3>
          <p className="text-xs mt-1">
            Tunnel expose server local ra internet để nhận webhook thanh toán,
            tự động xác nhận đơn hàng, kích hoạt workflow từ bên ngoài.
          </p>
        </div>
        <button
          onClick={onToggle}
          disabled={tunnelLoading}
          className={`flex-shrink-0 px-4 py-2 text-xs rounded-xl font-semibold transition-colors ${
            tunnelUrl
              ? 'bg-green-100 dark:bg-green-700/50 hover:bg-red-100 dark:hover:bg-red-700/50 text-green-700 dark:text-green-300 hover:text-red-700 dark:hover:text-red-300 border border-green-300 dark:border-green-600/50 hover:border-red-300 dark:hover:border-red-600/50'
              : 'bg-blue-600 hover:bg-blue-500 text-white border border-blue-500/50'
          }`}
        >
          {tunnelLoading ? (
            <span className="flex items-center gap-1.5">
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Đang kết nối...
            </span>
          ) : tunnelUrl ? '🌐 Đang Online' : '🔒 Bật Tunnel'}
        </button>
      </div>

      {/* URL display */}
      <div className="flex items-center gap-2 bg-gray-200/80 dark:bg-gray-900/60 rounded-xl px-4 py-3 border border-gray-300 dark:border-gray-700/40">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-gray-500 dark:text-gray-500 mb-0.5 font-medium">
            {tunnelUrl ? 'URL công khai (internet):' : '⚠️ URL local (chỉ hoạt động nội bộ):'}
          </p>
          <p className={`text-xs font-mono truncate ${tunnelUrl ? 'text-green-600 dark:text-green-400' : 'text-yellow-700 dark:text-yellow-500'}`}>
            {tunnelUrl || `http://127.0.0.1:${webhookPort}`}
          </p>
        </div>
        {tunnelUrl && (
          <button
            onClick={() => navigator.clipboard.writeText(tunnelUrl)}
            title="Copy URL"
            className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white flex items-center justify-center transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        )}
      </div>

      {/* Billing explanation — always visible */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-700/30 rounded-xl p-3">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">💳 Khi nào cần bật Tunnel?</p>
          <ul className="text-[11px] text-blue-600/80 dark:text-blue-200/80 space-y-1">
            <li>• Dùng <strong>Casso</strong> hoặc <strong>SePay</strong> để nhận thông báo chuyển khoản tự động</li>
            <li>• Hệ thống thanh toán <strong>cần server công khai</strong> để gửi webhook về</li>
            <li>• Khi nhận được tiền → tự động xác nhận đơn, kích hoạt workflow</li>
            <li>• <strong>Bắt buộc</strong> nếu muốn tự động hoá xác nhận thanh toán</li>
          </ul>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900 border border-purple-200 dark:border-purple-700/30 rounded-xl p-3">
          <p className="text-xs font-semibold text-purple-700 dark:text-purple-300 mb-1">🧪 Tunnel hoạt động thế nào?</p>
          <ul className="text-[11px] text-purple-600/80 dark:text-purple-200/80 space-y-1">
            <li>• Tạo một <strong>URL công khai</strong> (VD: abc.loca.lt) trỏ về máy bạn</li>
            <li>• Casso/SePay gửi dữ liệu giao dịch đến URL này</li>
            <li>• Phần mềm nhận được → cập nhật trạng thái đơn hàng</li>
            <li>• Dùng <strong>miễn phí</strong>, không cần đăng ký tài khoản bên thứ ba</li>
          </ul>
        </div>
      </div>

      {/* Warning if no tunnel but has payment integration connected */}
      {!tunnelUrl && hasPaymentIntegration && (
        <div className="mt-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700/40 rounded-xl px-4 py-3">
          <p className="text-xs text-yellow-800 dark:text-yellow-400 font-medium mb-1">⚠️ Bạn đang dùng Casso/SePay nhưng Tunnel chưa bật</p>
          <p className="text-[11px] text-yellow-700 dark:text-yellow-500">
            Thanh toán tự động sẽ không hoạt động. Hãy bật Tunnel ở nút bên trên để nhận webhook từ internet.
          </p>
        </div>
      )}

      {/* How to use in billing flow */}
      {tunnelUrl && (
        <div className="mt-3 bg-green-50 dark:bg-green-900/15 border border-green-300 dark:border-green-700/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-green-600 dark:text-green-400 text-sm">✅</span>
            <p className="text-xs text-green-800 dark:text-green-300 font-medium">Tunnel đang hoạt động — sẵn sàng nhận webhook thanh toán</p>
          </div>
          <p className="text-[11px] text-green-700/70 dark:text-green-400/70 mt-1 ml-5">
            Casso/SePay sẽ gửi thông báo giao dịch qua URL công khai bên trên. Khi có chuyển khoản, hệ thống tự động xử lý.
          </p>
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
        <div className={`w-8 h-8 rounded-lg ${meta.color} flex items-center justify-center text-base`}>
          {meta.icon}
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">{meta.label}</h2>
          <p className="text-[10px] text-gray-500">
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
              className="text-left p-4 rounded-xl border border-gray-700 hover:border-blue-500 bg-gray-800 hover:bg-gray-750 transition-all group"
            >
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg ${item.color} flex items-center justify-center text-xl flex-shrink-0`}>
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-white text-sm">{item.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                      item.priority === 'p0' ? 'bg-red-900/50 text-red-400' :
                      item.priority === 'p1' ? 'bg-orange-900/50 text-orange-400' :
                      'bg-gray-700 text-gray-400'
                    }`}>
                      {item.priority.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 leading-snug">{item.desc}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className={`text-xs flex items-center gap-1 ${connected ? 'text-green-400' : 'text-gray-500'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-600'}`}/>
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
  const [savedList, setSavedList] = useState<SavedIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<{ catalogItem: CatalogItem; saved?: SavedIntegration } | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [webhookPort, setWebhookPort] = useState<number>(9888);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.integration?.list();
      if (res?.success) {
        setSavedList(res.integrations || []);
        if (res.webhookPort) setWebhookPort(res.webhookPort);
      }
    } catch {}
    try {
      const ts = await ipc.tunnel?.status();
      if (ts?.active) setTunnelUrl(ts.url);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    const unsub = ipc.on?.('tunnel:changed', (data: { url: string | null }) => {
      setTunnelUrl(data?.url ?? null);
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  const handleTunnelToggle = async () => {
    setTunnelLoading(true);
    try {
      if (tunnelUrl) {
        await ipc.tunnel?.stop();
        setTunnelUrl(null);
      } else {
        const res = await ipc.tunnel?.start();
        if (res?.success && res.url) setTunnelUrl(res.url);
        else alert('❌ Không thể mở Tunnel: ' + (res?.error || 'Lỗi không xác định'));
      }
    } catch (e: any) {
      alert('❌ Lỗi tunnel: ' + e.message);
    }
    setTunnelLoading(false);
  };

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
        tunnelUrl={tunnelUrl}
        onBack={() => { setSelectedDetail(null); loadList(); }}
      />
    );
  }

  if (activeTab === 'ai') {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-gray-900">
        {/* Top bar */}
        <TopBar activeTab={activeTab} onTabChange={scrollToSection} tunnelUrl={tunnelUrl} tunnelLoading={tunnelLoading} onTunnelToggle={handleTunnelToggle} />
        <div className="flex-1 overflow-hidden">
          <AIAssistantPage />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Top horizontal tab bar */}
      <TopBar activeTab={activeTab} onTabChange={scrollToSection} tunnelUrl={tunnelUrl} tunnelLoading={tunnelLoading} onTunnelToggle={handleTunnelToggle} />

      {/* Scrollable content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 space-y-2">

          {loading ? (
            <div className="flex items-center justify-center h-40">
              <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            </div>
          ) : activeTab === 'all' ? (
            /* ── "Tất cả" — AI first, then sections ── */
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

              {/* Divider before tunnel */}
              <div className="border-t border-gray-700/40 pt-6">
                <TunnelStatusCard
                  webhookPort={webhookPort}
                  tunnelUrl={tunnelUrl}
                  tunnelLoading={tunnelLoading}
                  onToggle={handleTunnelToggle}
                  savedList={savedList}
                />
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

              {/* Tunnel card for payment section */}
              {activeTab === 'payment' && (
                <div className="pt-4">
                  <TunnelStatusCard
                    webhookPort={webhookPort}
                    tunnelUrl={tunnelUrl}
                    tunnelLoading={tunnelLoading}
                    onToggle={handleTunnelToggle}
                    savedList={savedList}
                  />
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

function TopBar({ activeTab, onTabChange, tunnelUrl, tunnelLoading, onTunnelToggle }: {
  activeTab: TabKey;
  onTabChange: (key: TabKey) => void;
  tunnelUrl: string | null;
  tunnelLoading: boolean;
  onTunnelToggle: () => void;
}) {
  return (
    <div className="flex-shrink-0 border-b border-gray-700 bg-gray-900/95">
      <div className="px-6">
        {/* Title row */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-white">🔌 Tích hợp</h1>
            <p className="text-[11px] text-gray-500">Kết nối nền tảng bên ngoài</p>
          </div>
          {/* Compact tunnel toggle in top bar */}
          <button
            onClick={onTunnelToggle}
            disabled={tunnelLoading}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-lg font-medium transition-colors ${
              tunnelUrl
                ? 'bg-green-800/40 text-green-300 border border-green-700/50 hover:bg-red-800/40 hover:text-red-300 hover:border-red-700/50'
                : 'bg-gray-700/60 text-gray-400 border border-gray-600/50 hover:bg-gray-700 hover:text-white'
            }`}
            title={tunnelUrl ? 'Nhấn để tắt Tunnel' : 'Bật Tunnel để nhận webhook từ internet'}
          >
            {tunnelLoading ? (
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : tunnelUrl ? (
              <span className="w-2 h-2 rounded-full bg-green-400"/>
            ) : (
              <span className="w-2 h-2 rounded-full bg-gray-500"/>
            )}
            <span>{tunnelUrl ? 'Online' : 'Tunnel'}</span>
          </button>
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
                  : 'text-gray-400 border-transparent hover:text-gray-200 hover:border-gray-500'
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
