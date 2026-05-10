import React, { useEffect, useState, useCallback } from 'react';
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

type TabKey = 'pos' | 'payment' | 'shipping' | 'ai';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'pos',      label: 'POS / Bán hàng', icon: '🛒' },
  { key: 'payment',  label: 'Thanh toán',      icon: '💳' },
  { key: 'shipping', label: 'Vận chuyển',      icon: '📦' },
  { key: 'ai',       label: 'Trợ lý AI',       icon: '🤖' },
];

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
        { key: 'apiKey',     label: 'API Key',    placeholder: 'Sapo API Key' },
        { key: 'secretKey',  label: 'Secret Key', secret: true, placeholder: 'Sapo Secret Key' },
        { key: 'storeDomain', label: 'Tên store (subdomain)', placeholder: 'vd: myshop (myshop.mysapo.net)' },
      ],
    },
    {
      type: 'ipos', name: 'iPOS', priority: 'p0',
      icon: '🍽️', color: 'bg-rose-500',
      desc: 'POS nhà hàng / F&B Việt Nam. Tra cứu đơn, khách hàng, doanh thu.',
      credentialFields: [
        { key: 'apiKey',    label: 'API Key',   secret: true, placeholder: 'iPOS API Key / Token' },
        { key: 'storeCode', label: 'Mã cửa hàng (store_code)', placeholder: 'vd: STORE01' },
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function IntegrationPage() {
  const [savedList, setSavedList] = useState<SavedIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<{ catalogItem: CatalogItem; saved?: SavedIntegration } | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('pos');
  const [webhookPort, setWebhookPort] = useState<number>(9888);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);

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

  const getSavedByType = (type: string) =>
    savedList.find(s => s.type === type);

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

  return (
    <div className="flex h-full overflow-hidden bg-gray-900">
      {/* Left sidebar - tabs */}
      <div className="w-52 flex-shrink-0 border-r border-gray-700 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-700">
          <h1 className="text-base font-semibold text-white">🔌 Tích hợp</h1>
          <p className="text-[10px] text-gray-500 mt-0.5">Kết nối nền tảng bên ngoài</p>
        </div>
        <nav className="flex-1 py-2 space-y-0.5 px-2">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                activeTab === tab.key
                  ? 'bg-blue-600/20 text-blue-400 font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span className="text-base">{tab.icon}</span>
              <span className="truncate">{tab.label}</span>
            </button>
          ))}
        </nav>
        {/* Tunnel / webhook status */}
        <div className="px-3 py-3 border-t border-gray-700 space-y-2">
          <div className="text-[10px] text-gray-500">Webhook</div>
          {tunnelUrl ? (
            <div className="flex items-center gap-1">
              <p className="text-[10px] font-mono text-green-400 truncate flex-1" title={tunnelUrl}>{tunnelUrl}</p>
              <button
                onClick={() => navigator.clipboard.writeText(tunnelUrl)}
                title="Copy"
                className="text-green-500 hover:text-green-300 flex-shrink-0"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            </div>
          ) : (
            <p className="text-[10px] font-mono text-yellow-500 truncate">127.0.0.1:{webhookPort}</p>
          )}
          <button
            onClick={handleTunnelToggle}
            disabled={tunnelLoading}
            className={`w-full px-2 py-1.5 text-[10px] rounded-lg font-medium transition-colors ${
              tunnelUrl
                ? 'bg-green-800/50 hover:bg-red-900/50 text-green-300 hover:text-red-300 border border-green-700/50'
                : 'bg-gray-700 hover:bg-blue-700 text-gray-300 border border-gray-600'
            }`}
          >
            {tunnelLoading ? '⏳' : tunnelUrl ? '🌐 Online' : '🔒 Mở Tunnel'}
          </button>
        </div>
      </div>

      {/* Right content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeTab === 'ai' ? (
          <AIAssistantPage />
        ) : (
          <>
            {/* Tab header */}
            <div className="px-6 py-4 border-b border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold text-white">
                {TABS.find(t => t.key === activeTab)?.icon} {TABS.find(t => t.key === activeTab)?.label}
              </h2>
            </div>

            {/* Items grid */}
            <div className="flex-1 overflow-y-auto p-6">
              {loading ? (
                <div className="flex items-center justify-center h-40">
                  <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {(CATALOG[activeTab] || []).map(item => {
                    const saved = getSavedByType(item.type);
                    const connected = !!saved?.connectedAt;
                    return (
                      <button
                        key={item.type}
                        onClick={() => setSelectedDetail({ catalogItem: item, saved })}
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
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
