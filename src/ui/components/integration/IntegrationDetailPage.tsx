import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';

interface CatalogItem {
  type: string;
  name: string;
  desc: string;
  icon: string;
  color: string;
  priority: string;
  credentialFields: { key: string; label: string; secret?: boolean; placeholder?: string }[];
  settingFields?: { key: string; label: string; type?: string; options?: { value: string; label: string }[] }[];
}

interface SavedIntegration {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  connectedAt?: number;
  settings?: Record<string, any>;
}

interface Props {
  catalogItem: CatalogItem;
  saved?: SavedIntegration;
  webhookPort: number;
  tunnelUrl?: string | null;
  onBack: () => void;
}

export default function IntegrationDetailPage({ catalogItem, saved, webhookPort, tunnelUrl, onBack }: Props) {
  const { showNotification } = useAppStore();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [saved_id, setSavedId] = useState<string | undefined>(saved?.id);
  const [deleting, setDeleting] = useState(false);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

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
    // Validate required credential fields
    for (const field of catalogItem.credentialFields) {
      const value = credentials[field.key]?.trim();
      // Create mode: require all credentials. Update mode: allow blank to keep old credential.
      if (!saved_id && !value) {
        showNotification(`Vui lòng nhập ${field.label}`, 'warning');
        return;
      }
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
      const res = await ipc.integration?.save(payload);
      if (res?.success && res.id) {
        setSavedId(res.id);
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
      await ipc.integration?.delete(saved_id);
      showNotification(`Đã xoá tích hợp ${catalogItem.name}`, 'success');
      onBack();
    } catch (e: any) {
      showNotification('Lỗi xóa: ' + e.message, 'error');
    }
    setDeleting(false);
  };

  const localWebhookUrl  = `http://127.0.0.1:${webhookPort}/webhook/${saved_id || catalogItem.type}`;
  const publicWebhookUrl = tunnelUrl ? `${tunnelUrl}/webhook/${saved_id || catalogItem.type}` : null;

  const isPayment = catalogItem.type === 'casso' || catalogItem.type === 'sepay';

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-700 flex-shrink-0 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div className={`w-9 h-9 rounded-lg ${catalogItem.color} flex items-center justify-center text-lg`}>
          {catalogItem.icon}
        </div>
        <div>
          <h1 className="text-base font-semibold text-white">{catalogItem.name}</h1>
          <p className="text-xs text-gray-400">{catalogItem.desc}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Enable toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-gray-400">Kích hoạt</span>
            <div
              className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
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
          <h2 className="text-sm font-semibold text-gray-300 mb-3">🔑 Thông tin xác thực</h2>
          <div className="space-y-3 bg-gray-800 rounded-xl p-4">
            {catalogItem.credentialFields.map(field => (
              <div key={field.key}>
                <label className="block text-xs text-gray-400 mb-1">{field.label}</label>
                <div className="relative">
                  <input
                    type={field.secret && !showSecret[field.key] ? 'password' : 'text'}
                    value={credentials[field.key] || ''}
                    onChange={e => setCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder || (saved_id ? '••••••••' : '')}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 pr-10"
                  />
                  {field.secret && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
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
            <p className="text-xs text-gray-500 mt-1">Để trống các trường bí mật nếu không muốn thay đổi.</p>
          )}
        </div>

        {/* Settings */}
        {catalogItem.settingFields && catalogItem.settingFields.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-3">⚙️ Cài đặt</h2>
            <div className="space-y-3 bg-gray-800 rounded-xl p-4">
              {catalogItem.settingFields.map(field => (
                <div key={field.key}>
                  <label className="block text-xs text-gray-400 mb-1">{field.label}</label>
                  {field.type === 'select' ? (
                    <select
                      value={settings[field.key] || ''}
                      onChange={e => setSettings(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
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
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Webhook info for payment integrations */}
        {isPayment && (
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-3">🌐 Webhook URL</h2>
            <div className="bg-gray-800 rounded-xl p-4 space-y-3">
              <p className="text-xs text-gray-400">
                Cấu hình URL này trong trang quản trị {catalogItem.name} để nhận thông báo thanh toán tự động:
              </p>

              {/* Public URL (when tunnel is active) */}
              {publicWebhookUrl && (
                <div>
                  <p className="text-[10px] text-green-400 mb-1 font-medium">✅ URL công khai (đang hoạt động):</p>
                  <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2">
                    <code className="text-xs text-green-300 flex-1 break-all">{publicWebhookUrl}</code>
                    <button
                      className="text-gray-400 hover:text-white flex-shrink-0"
                      onClick={() => navigator.clipboard.writeText(publicWebhookUrl)}
                      title="Copy"
                    >📋</button>
                  </div>
                  <p className="text-[10px] text-green-600 mt-1">Dùng URL này để cấu hình webhook trong {catalogItem.name}.</p>
                </div>
              )}

              {/* Local URL (always shown) */}
              <div>
                <p className="text-[10px] text-gray-500 mb-1">{publicWebhookUrl ? 'URL localhost (backup):' : 'URL localhost (chưa expose ra internet):'}</p>
                <div className="flex items-center gap-2 bg-gray-700 rounded-lg px-3 py-2">
                  <code className="text-xs text-yellow-400 flex-1 break-all">{localWebhookUrl}</code>
                  <button
                    className="text-gray-400 hover:text-white flex-shrink-0"
                    onClick={() => navigator.clipboard.writeText(localWebhookUrl)}
                    title="Copy"
                  >📋</button>
                </div>
              </div>

              {/* Warning when no tunnel */}
              {!publicWebhookUrl && (
                <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-2">
                  <p className="text-xs text-yellow-400 font-medium mb-1">⚠️ Webhook chưa nhận được từ internet</p>
                  <p className="text-xs text-yellow-600">
                    URL 127.0.0.1 chỉ hoạt động nội bộ — server SePay/Casso không thể gọi vào đây.
                    Vào trang <strong>Tích hợp</strong> → bấm nút <strong>"🔒 Offline"</strong> để mở tunnel.
                  </p>
                  <div className="mt-2 pt-2 border-t border-yellow-800/40">
                    <p className="text-[10px] text-yellow-700 font-medium mb-1">Hoặc dùng thủ công:</p>
                    <code className="text-[10px] text-gray-400 block">ngrok http {webhookPort}</code>
                    <code className="text-[10px] text-gray-400 block">cloudflared tunnel --url http://localhost:{webhookPort}</code>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Workflow hint */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-blue-300 mb-2">💡 Workflow Nodes có sẵn</h3>
          <ul className="text-xs text-blue-200 space-y-1">
            {catalogItem.type === 'kiotviet' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.lookupCustomer</code> — Tra cứu khách hàng theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.lookupOrder</code> — Tra cứu đơn hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.createOrder</code> — Tạo đơn hàng mới</li>
            </>}
            {catalogItem.type === 'haravan' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.lookupCustomer</code> — Tra cứu khách hàng Haravan theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.lookupOrder</code> — Tra cứu đơn hàng Haravan</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.createOrder</code> — Tạo đơn hàng mới trong Haravan</li>
            </>}
            {catalogItem.type === 'sapo' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.lookupCustomer</code> — Tra cứu khách hàng Sapo theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.lookupOrder</code> — Tra cứu đơn hàng Sapo</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.createOrder</code> — Tạo đơn hàng mới trong Sapo</li>
            </>}
            {catalogItem.type === 'ipos' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ipos.lookupCustomer</code> — Tra cứu khách hàng iPOS theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ipos.lookupOrder</code> — Tra cứu đơn / hóa đơn iPOS</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ipos.createOrder</code> — Tạo đơn hàng mới trong iPOS</li>
            </>}
            {catalogItem.type === 'nhanh' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.lookupCustomer</code> — Tra cứu khách hàng Nhanh.vn theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.lookupOrder</code> — Tra cứu đơn hàng Nhanh.vn</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.createOrder</code> — Tạo đơn hàng mới trong Nhanh.vn</li>
            </>}
            {catalogItem.type === 'pancake' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.lookupCustomer</code> — Tra cứu khách hàng Pancake theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.lookupOrder</code> — Tra cứu đơn hàng Pancake</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.createOrder</code> — Tạo đơn hàng mới trong Pancake</li>
            </>}
            {(catalogItem.type === 'casso' || catalogItem.type === 'sepay') && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">trigger.payment</code> — Kích hoạt khi nhận thanh toán</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">payment.getTransactions</code> — Lấy lịch sử giao dịch</li>
            </>}
            {catalogItem.type === 'ghn' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.createOrder</code> — Tạo đơn giao hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getTracking</code> — Tra cứu vận đơn</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getProvinces</code> — Lấy tỉnh/thành GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getDistricts</code> — Lấy quận/huyện GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getWards</code> — Lấy phường/xã GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getServices</code> — Lấy dịch vụ khả dụng GHN</li>
            </>}
            {catalogItem.type === 'ghtk' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghtk.createOrder</code> — Tạo đơn giao hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghtk.getTracking</code> — Tra cứu vận đơn</li>
            </>}
          </ul>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`p-3 rounded-lg text-sm ${testResult.success ? 'bg-green-900/30 border border-green-700 text-green-300' : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
            {testResult.success ? '✅' : '❌'} {testResult.message}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-6 py-4 border-t border-gray-700 flex-shrink-0 flex items-center gap-3">
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
            className="px-4 py-2 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-white transition-colors"
          >
            {testing ? 'Đang test...' : '🔍 Test kết nối'}
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {saving ? 'Đang lưu...' : saved_id ? '💾 Cập nhật' : '🔌 Kết nối'}
        </button>
      </div>
    </div>
  );
}

