import React, { useState, useEffect } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { AlertIcon, ChatIcon, CheckIcon, ClipboardListIcon, CloseIcon, CreditCardIcon, GlobeIcon, HardDriveIcon, KeyIcon, PackageIcon, PluginIcon, SearchIcon, SettingsIcon, SunIcon, TruckIcon, UserIcon , EditIcon } from '@/components/common/icons';

interface CatalogItem {
  type: string;
  name: string;
  desc: string;
  icon: React.ReactNode;
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
      const res = await DataAccessor.saveIntegration(payload);
      const savedId = (res as any)?.data?.id || (res as any)?.id;
      if (res?.success && savedId) {
        setSavedId(savedId);
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
          <h2 className="text-sm font-semibold text-gray-300 mb-3"><KeyIcon className="w-4 h-4 inline" /> Thông tin xác thực</h2>
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
            <p className="text-xs text-gray-400 mt-1">Để trống các trường bí mật nếu không muốn thay đổi.</p>
          )}
        </div>

        {/* Settings */}
        {catalogItem.settingFields && catalogItem.settingFields.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-3"><SettingsIcon className="w-4 h-4 inline" /> Cài đặt</h2>
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

        {/* Webhook & Tunnel - bắt buộc cho thanh toán */}
        {isPayment && (
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-3"><GlobeIcon className="w-4 h-4 inline" /> Webhook Tunnel - Kết nối Internet</h2>
            <div className="bg-gray-800 rounded-xl p-4 space-y-3">

              {/* WHY - giải thích tại sao cần tunnel */}
              <div className="bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700/30 rounded-xl px-4 py-3">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1.5"><SunIcon className="w-4 h-4 inline" /> Dùng {catalogItem.name} để nhận thanh toán tự động?</p>
                <p className="text-[11px] text-amber-800/90 dark:text-amber-200/90 leading-relaxed">
                  {catalogItem.name} gửi webhook (thông báo giao dịch) từ internet.
                  Nhưng phần mềm đang chạy trên máy tính của bạn (localhost), không có địa chỉ công khai.
                  <strong className="text-amber-900 dark:text-amber-100"> Bạn cần bật Tunnel</strong> để tạo cầu nối giữa internet và máy bạn.
                </p>
              </div>

              {/* Luồng hoạt động trực quan */}
              <div className="bg-amber-50/80 dark:bg-gray-900/40 rounded-xl px-4 py-3 border border-amber-200 dark:border-gray-700/40">
                <p className="text-[10px] text-amber-600 dark:text-gray-400 font-medium mb-2"><ClipboardListIcon className="w-4 h-4 inline" /> Luồng hoạt động:</p>
                <div className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-gray-400 flex-wrap">
                  <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded-lg text-blue-700 dark:text-blue-300">{catalogItem.name}</span>
                  <span className="text-amber-400 dark:text-gray-400">─(webhook)─→</span>
                  <span className="px-2 py-1 bg-green-100 dark:bg-green-900/40 rounded-lg text-green-700 dark:text-green-300">Tunnel URL</span>
                  <span className="text-amber-400 dark:text-gray-400">─(tunnel)─→</span>
                  <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900/40 rounded-lg text-purple-700 dark:text-purple-300">Máy bạn</span>
                  <span className="text-amber-400 dark:text-gray-400">→</span>
                  <span className="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/40 rounded-lg text-emerald-700 dark:text-emerald-300">Tự động XN đơn</span>
                </div>
              </div>

              {/* Lưu ý về tunnel tạm thời */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 rounded-xl px-4 py-3">
                <p className="text-[11px] text-blue-700 dark:text-blue-300/90 leading-relaxed">
                  <AlertIcon className="w-4 h-4 inline" /> <strong>Lưu ý về Tunnel:</strong> Tunnel chỉ hoạt động khi app đang chạy.
                  Khi bạn tắt máy hoặc đóng app, tunnel sẽ ngừng và URL cũ không còn dùng được.
                  Khi khởi động lại app, bạn phải bật lại tunnel và sẽ nhận được <strong>địa chỉ URL mới</strong>.
                  Những bên thứ 3 đang dùng URL cũ sẽ cần được cập nhật URL mới.
                </p>
              </div>

              {/* Public URL (when tunnel is active) */}
              {publicWebhookUrl && (
                <div>
                  <p className="text-[10px] text-green-400 mb-1 font-medium"><CheckIcon className="w-4 h-4 inline" /> URL công khai - dùng để cấu hình webhook trong {catalogItem.name}:</p>
                  <div className="flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2">
                    <code className="text-xs text-green-300 flex-1 break-word">{publicWebhookUrl}</code>
                    <button
                      className="text-gray-400 hover:text-white flex-shrink-0"
                      onClick={() => navigator.clipboard.writeText(publicWebhookUrl)}
                      title="Copy"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </button>
                  </div>
                  <p className="text-[10px] text-green-600 mt-1">Copy URL trên và dán vào webhook settings của {catalogItem.name}.</p>
                </div>
              )}

              {/* No tunnel - Big warning + CTA */}
              {!publicWebhookUrl && (
                <div className="bg-red-900/20 border border-red-700/40 rounded-xl px-4 py-4">
                  <div className="flex items-start gap-3">
                    <span className="text-lg flex-shrink-0"><CloseIcon className="w-4 h-4" /></span>
                    <div>
                      <p className="text-xs font-semibold mb-1">Chưa bật Tunnel - Chưa thể nhận thanh toán tự động</p>
                      <p className="text-[11px] leading-relaxed">
                        Server {catalogItem.name} cần gửi webhook đến một URL công khai trên internet.
                        {tunnelUrl
                          ? 'Tunnel đang chạy nhưng chưa có URL. Thử tắt rồi bật lại.'
                          : 'Bạn cần bật Tunnel ở trang Tích hợp (nút "Bật Tunnel") để nhận webhook.'}
                      </p>
                      <ul className="mt-2 space-y-1 text-[11px]">
                        <li className="flex items-start gap-1.5"><span className="flex-shrink-0">1.</span> Về trang <strong className="text-red-200">Tích hợp → bật Tunnel</strong> (nút xanh trên cùng)</li>
                        <li className="flex items-start gap-1.5"><span className="flex-shrink-0">2.</span> Copy URL công khai hiện ra</li>
                        <li className="flex items-start gap-1.5"><span className="flex-shrink-0">3.</span> Dán URL vào webhook settings của {catalogItem.name}</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Local URL info (informational) */}
              <div className="bg-gray-700/40 rounded-lg px-3 py-2">
                <p className="text-[10px] text-gray-400 mb-0.5">URL local (nội bộ, không dùng để cấu hình webhook):</p>
                <code className="text-[11px] text-gray-400 font-mono">{localWebhookUrl}</code>
              </div>
            </div>
          </div>
        )}

        {/* Usage in conversation (QuickPanel) */}
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-3"><ChatIcon className="w-4 h-4 inline" /> Sử dụng trong hội thoại</h2>
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <p className="text-xs text-gray-400 leading-relaxed">
              Sau khi kết nối, bạn có thể tra cứu thông tin trực tiếp khi đang chat với khách hàng
              mà không cần rời khỏi cửa sổ hội thoại:
            </p>

            <div className="bg-gray-700/50 rounded-lg p-3 border border-gray-600/30">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg"><PluginIcon className="w-4 h-4" /></span>
                <span className="text-xs font-semibold text-white">Bảng điều khiển Tích hợp nhanh</span>
              </div>
              <ol className="space-y-1.5 text-[11px] text-gray-400 ml-1">
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">1.</span>
                  <span>Nhấn nút <span className="text-blue-300 font-medium"><PluginIcon className="w-4 h-4 inline" /> Tích hợp</span> trên thanh toolbar phía trên khung chat</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 font-mono flex-shrink-0">2.</span>
                  <span>Chọn <span className="text-white font-medium">{catalogItem.name}</span> từ danh sách tích hợp trong panel bên phải</span>
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
                  <div key={i} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <div>
                      <p className="text-[11px] font-medium text-gray-200">{act.label}</p>
                      <p className="text-[10px] text-gray-400">{act.desc}</p>
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
                  <div key={i} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-gray-200">{act.label}</p>
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
                  <div key={i} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-gray-200">{act.label}</p>
                  </div>
                ))}
              </div>
            )}
            {(catalogItem.type === 'casso' || catalogItem.type === 'sepay') && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { icon: <CreditCardIcon className="w-4 h-4" />, label: 'LS giao dịch' },
                ].map((act, i) => (
                  <div key={i} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600/30">
                    <span className="text-base flex-shrink-0">{act.icon}</span>
                    <p className="text-[11px] font-medium text-gray-200">{act.label}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] text-gray-400 flex items-start gap-1.5">
              <span className="flex-shrink-0"><SunIcon className="w-4 h-4" /></span>
              <span>
                Kết quả tra cứu hiển thị ngay trong panel - có thể xem chi tiết đơn hàng,
                sản phẩm, thông tin khách hàng. Hỗ trợ <strong className="text-gray-300">ghim thao tác</strong> ra toolbar
                để truy cập nhanh hơn.
              </span>
            </p>
          </div>
        </div>

        {/* Workflow hint */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-blue-300 mb-2"><SunIcon className="w-4 h-4 inline" /> Workflow Nodes có sẵn</h3>
          <ul className="text-xs text-blue-200 space-y-1">
            {catalogItem.type === 'kiotviet' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.lookupCustomer</code> - Tra cứu khách hàng theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.lookupOrder</code> - Tra cứu đơn hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">kiotviet.createOrder</code> - Tạo đơn hàng mới</li>
            </>}
            {catalogItem.type === 'haravan' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.lookupCustomer</code> - Tra cứu khách hàng Haravan theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.lookupOrder</code> - Tra cứu đơn hàng Haravan</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">haravan.createOrder</code> - Tạo đơn hàng mới trong Haravan</li>
            </>}
            {catalogItem.type === 'sapo' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.lookupCustomer</code> - Tra cứu khách hàng Sapo theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.lookupOrder</code> - Tra cứu đơn hàng Sapo</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">sapo.createOrder</code> - Tạo đơn hàng mới trong Sapo</li>
            </>}
            {catalogItem.type === 'nhanh' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.lookupCustomer</code> - Tra cứu khách hàng Nhanh.vn theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.lookupOrder</code> - Tra cứu đơn hàng Nhanh.vn</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">nhanh.createOrder</code> - Tạo đơn hàng mới trong Nhanh.vn</li>
            </>}
            {catalogItem.type === 'pancake' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.lookupCustomer</code> - Tra cứu khách hàng Pancake theo SĐT</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.lookupOrder</code> - Tra cứu đơn hàng Pancake</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">pancake.createOrder</code> - Tạo đơn hàng mới trong Pancake</li>
            </>}
            {(catalogItem.type === 'casso' || catalogItem.type === 'sepay') && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">trigger.payment</code> - Kích hoạt khi nhận thanh toán</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">payment.getTransactions</code> - Lấy lịch sử giao dịch</li>
            </>}
            {catalogItem.type === 'ghn' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.createOrder</code> - Tạo đơn giao hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getTracking</code> - Tra cứu vận đơn</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getProvinces</code> - Lấy tỉnh/thành GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getDistricts</code> - Lấy quận/huyện GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getWards</code> - Lấy phường/xã GHN</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghn.getServices</code> - Lấy dịch vụ khả dụng GHN</li>
            </>}
            {catalogItem.type === 'ghtk' && <>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghtk.createOrder</code> - Tạo đơn giao hàng</li>
              <li>• <code className="bg-blue-900/40 px-1 rounded">ghtk.getTracking</code> - Tra cứu vận đơn</li>
            </>}
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

