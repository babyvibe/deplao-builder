import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { AlertIcon, BellIcon, BotIcon, ClipboardListIcon, CreditCardIcon, EditIcon, GlobeIcon, LightningIcon, LinkIcon, PackageIcon, SunIcon, UsersIcon } from '@/components/common/icons';
import { Spinner } from '@/components/common/PageLoading';

type TunnelState = {
  active: boolean;
  url: string | null;
  loading: boolean;
  error?: string;
};

interface WebhookService {
  key: string;
  port: number;
  label: string;
  icon: React.ReactNode;
  description: string;
  uses: string[];
  guideTitle: string;
  guideSteps: string[];
  guideExtra?: React.ReactNode;
  showPortConfig: boolean;
  getStatus: () => Promise<any>;
  start: () => Promise<any>;
  stop: () => Promise<any>;
}

const PORT_KEYS = {
  INTEGRATION: 'webhook_port_integration',
  WORKFLOW: 'webhook_port_workflow',
};

export default function TunnelSettings() {
  const [integration, setIntegration] = useState<TunnelState>({ active: false, url: null, loading: true });
  const [workflow, setWorkflow] = useState<TunnelState>({ active: false, url: null, loading: true });

  // Port config
  const [intPort, setIntPort] = useState(9888);
  const [wfPort, setWfPort] = useState(9889);
  const [portLoading, setPortLoading] = useState(true);
  const [portSaving, setPortSaving] = useState<string | null>(null);

  // Load port config from DB
  useEffect(() => {
    (async () => {
      try {
        const res = await ipc.workflow?.getPortConfig();
        if (res?.success) {
          if (res.integrationPort) setIntPort(res.integrationPort);
          if (res.workflowPort) setWfPort(res.workflowPort);
        }
      } catch {} finally {
        setPortLoading(false);
      }
    })();
  }, []);

  const savePort = async (key: string, port: number, label: string) => {
    setPortSaving(key);
    try {
      await ipc.workflow?.setPortConfig(key, port);
    } catch {} finally {
      setPortSaving(null);
    }
  };

  const loadAll = useCallback(async () => {
    // Integration tunnel
    setIntegration(prev => ({ ...prev, loading: true }));
    try {
      const res = await ipc.tunnel?.status();
      if (res) setIntegration({ active: res.active, url: res.url, loading: false });
    } catch { setIntegration(prev => ({ ...prev, loading: false, error: 'Lỗi' })); }

    // Workflow gateway tunnel
    setWorkflow(prev => ({ ...prev, loading: true }));
    try {
      const res = await ipc.workflow?.getTunnelStatus();
      if (res?.success) setWorkflow({ active: res.tunnelActive ?? false, url: res.tunnelUrl ?? null, loading: false });
      else setWorkflow(prev => ({ ...prev, loading: false }));
    } catch { setWorkflow(prev => ({ ...prev, loading: false, error: 'Lỗi' })); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const services: WebhookService[] = [
    {
      key: 'integration',
      port: intPort,
      label: 'Tích hợp & Thanh toán',
      icon: <LinkIcon className="w-4 h-4" />,
      description: 'Nhận webhook thanh toán (Casso, SePay) và dữ liệu từ các nền tảng POS, vận chuyển.',
      uses: [
        'Nhận thông báo chuyển khoản VietQR từ Casso / SePay → trigger workflow thanh toán',
        'Đồng bộ đơn hàng, khách hàng từ KiotViet, Sapo, Haravan, GHN, GHTK',
      ],
      guideTitle: 'Hướng dẫn: Webhook Thanh toán (Casso / SePay)',
      guideSteps: [
        'Bật nút "Tích hợp & Thanh toán" bên trên để tạo tunnel Internet',
        'Vào module Tích hợp, thêm kết nối Casso hoặc SePay',
        'Sao chép URL webhook hiển thị ở trên, dán vào ứng dụng Casso/SePay',
        'Khi có người chuyển khoản, Deplao nhận webhook → trigger workflow "Khi nhận thanh toán"',
      ],
      showPortConfig: true,
      getStatus: () => ipc.tunnel?.status() ?? Promise.resolve({}),
      start: () => ipc.tunnel?.start() ?? Promise.resolve({}),
      stop: () => ipc.tunnel?.stop() ?? Promise.resolve({}),
    },
    {
      key: 'workflow',
      port: wfPort,
      label: 'Workflow Webhook',
      icon: <LightningIcon className="w-4 h-4" />,
      description: 'Cho phép bên thứ 3 gọi API để kích hoạt workflow của bạn.',
      uses: [
        'Website, app bắn dữ liệu sang → tự động xử lý qua workflow',
        'Tiếp nhận đơn hàng, feedback, lead, callback từ dịch vụ bên ngoài',
        'Tích hợp với bất kỳ hệ thống nào hỗ trợ webhook (Zapier, Make, ...)',
      ],
      guideTitle: 'Hướng dẫn: Webhook trong Workflow',
      guideSteps: [
        'Bật nút "Workflow Webhook" bên trên để tạo tunnel Internet',
        'Vào module Workflow, tạo kịch bản mới, chọn trigger "Webhook bên ngoài"',
        'Lưu kịch bản → URL webhook tự động được tạo trong phần cấu hình node',
        'Copy URL đó gửi cho đối tác / hệ thống bên thứ 3',
        'Khi họ POST dữ liệu đến URL, workflow chạy tự động',
        'Dùng biến {{ $trigger.body }}, {{ $trigger.headers }} trong workflow',
      ],
      guideExtra: (
        <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg px-3 py-2 mt-2">
          <p className="text-[11px] text-blue-300 font-medium"><EditIcon className="w-4 h-4 inline" /> Ví dụ dữ liệu webhook từ website:</p>
          <pre className="text-[11px] text-gray-400 bg-gray-950 rounded px-2 py-1.5 mt-1 overflow-x-auto font-mono">
{`POST /api/workflow/webhook/a1b2c3
{
  "orderId": "ORD123",
  "customer": { "name": "Nguyen Van A", "phone": "090xxxx" },
  "total": 500000
}`}
          </pre>
          <p className="text-xs text-blue-400 mt-1 leading-relaxed">
            → Workflow dùng{' '}
            <code className="text-yellow-300">{'{{ $trigger.body.orderId }}'}</code>{' '}
            và{' '}
            <code className="text-yellow-300">{'{{ $trigger.body.customer.name }}'}</code>
          </p>
        </div>
      ),
      showPortConfig: true,
      getStatus: () => ipc.workflow?.getTunnelStatus() ?? Promise.resolve({}),
      start: () => ipc.workflow?.startTunnel() ?? Promise.resolve({}),
      stop: () => ipc.workflow?.stopTunnel() ?? Promise.resolve({}),
    },
  ];

  const handleToggle = async (svc: WebhookService, current: TunnelState, setter: (s: TunnelState) => void) => {
    setter({ ...current, loading: true, error: undefined });
    try {
      if (current.active) {
        const res = await svc.stop();
        if (res?.success !== false) setter({ active: false, url: null, loading: false });
        else setter({ ...current, loading: false, error: res?.error || 'Lỗi tắt tunnel' });
      } else {
        const res = await svc.start();
        if (res?.success !== false) setter({ active: true, url: res?.tunnelUrl || res?.url || null, loading: false });
        else setter({ ...current, loading: false, error: res?.error || 'Lỗi bật tunnel' });
      }
    } catch (err: any) {
      setter({ ...current, loading: false, error: err?.message || 'Lỗi' });
    }
  };

  const getState = (key: string): [TunnelState, (s: TunnelState) => void] => {
    if (key === 'integration') return [integration, setIntegration];
    return [workflow, setWorkflow];
  };

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-white"><LinkIcon className="w-4 h-4 inline" /> Webhooks</h2>

      {/* ─── Tunnel là gì? ─── */}
      <div className="rounded-xl p-4 space-y-3 border border-amber-600 dark:border-0">
        <div className="flex items-center gap-2">
          <span className="text-lg"><GlobeIcon className="w-4 h-4" /></span>
          <p className="text-sm font-semibold ">Tunnel - công nghệ hoạt động phía sau Webhook</p>
        </div>
        <p className="text-xs dark:text-gray-400 leading-relaxed">
          Để nhận được webhook từ Internet, máy tính của bạn cần một <strong>địa chỉ công khai</strong>.
          Tunnel tạo một URL dạng <code className="text-green-600 dark:text-green-300">https://xxx.trycloudflare.com</code> (miễn phí) trỏ về máy bạn,
          cho phép bên thứ 3 (ngân hàng, website, POS...) gửi dữ liệu đến.
        </p>
        <p className="text-xs dark:text-gray-400 leading-relaxed">
          Deplao dùng <strong className="text-blue-600 dark:text-blue-300">Cloudflare Quick Tunnel</strong> (miễn phí, không cần tài khoản)
          để tạo các URL này. Mỗi nhóm webhook có một URL riêng.
        </p>
        <div className="border rounded-lg px-3 py-2 space-y-1.5">
          <p className="text-xs font-medium "><SunIcon className="w-4 h-4 inline" /> Nếu bạn chỉ dùng Deplao trong mạng LAN (cùng WiFi) thì <strong>không cần bật tunnel</strong>.
            Chỉ bật khi cần nhận dữ liệu từ Internet.
          </p>
          <p className="text-[11px] leading-relaxed">
            <AlertIcon className="w-4 h-4 inline" /> Tunnel chỉ hoạt động khi app đang chạy. Khi bạn tắt máy hoặc đóng app, tunnel ngừng
            và URL cũ không còn dùng được. Khi khởi động lại, bạn phải bật lại tunnel và sẽ nhận được
            <strong> địa chỉ URL mới</strong>. Các bên thứ 3 đang dùng URL cũ sẽ cần được cập nhật.
          </p>
        </div>
      </div>

      {/* ─── Service cards ─── */}
      {services.map(svc => {
        const [state, setState] = getState(svc.key);
        const cardColor = state.active ? 'bg-green-500/20 border-green-500/50' : 'bg-gray-800/60 border-gray-700/50';

        return (
          <div key={svc.key} className={`rounded-xl border ${cardColor} p-4 space-y-4`}>
            {/* Header: icon + toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">{svc.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-white">{svc.label}</p>
                  <p className="text-xs text-gray-400">Port {svc.port}</p>
                </div>
              </div>
              <button
                onClick={() => handleToggle(svc, state, setState)}
                disabled={state.loading}
                className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
                  state.active ? 'bg-green-600' : 'bg-gray-600'
                }`}
              >
                {state.loading ? (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </span>
                ) : (
                  <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    state.active ? 'translate-x-5.5 left-0.5' : 'translate-x-0.5 left-0'
                  }`} />
                )}
              </button>
            </div>

            {/* Description */}
            <p className="text-xs text-gray-400 leading-relaxed">{svc.description}</p>

            {/* URL */}
            {state.active && state.url && (
              <div className="bg-gray-900/60 rounded-lg px-3 py-2">
                <p className="text-[11px] text-gray-400 mb-0.5"><GlobeIcon className="w-4 h-4 inline" /> URL webhook gốc:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs text-green-300 break-word select-all font-mono">{state.url}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(state.url!)}
                    className="text-blue-400 hover:text-blue-300 text-xs flex-shrink-0"
                    title="Copy URL"
                  ><ClipboardListIcon className="w-4 h-4 inline" /> </button>
                </div>
              </div>
            )}

            {/* Error */}
            {state.error && (
              <div className="bg-red-900/30 border border-red-500/40 rounded-lg px-3 py-2">
                <p className="text-xs text-red-300"><AlertIcon className="w-4 h-4 inline" /> {state.error}</p>
              </div>
            )}

            {/* Uses */}
            <div className="bg-gray-900/40 rounded-lg px-3 py-2 space-y-1">
              <p className="text-[11px] text-gray-400 font-medium">Dùng để:</p>
              {svc.uses.map((item, i) => (
                <p key={i} className="text-xs text-gray-400 leading-relaxed">{item}</p>
              ))}
            </div>

            {/* Port config */}
            {svc.showPortConfig && (
              <div className="flex items-center gap-3 bg-gray-900/40 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-400">Cổng:</p>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={svc.port}
                  disabled={state.active}
                  onChange={e => {
                    const newPort = Number(e.target.value);
                    if (svc.key === 'integration') setIntPort(newPort);
                    else setWfPort(newPort);
                  }}
                  className="w-20 bg-gray-700 text-white text-xs rounded-lg px-2 py-1.5 border border-gray-600 disabled:opacity-30"
                />
                <button
                  disabled={state.active || portLoading || portSaving === svc.key}
                  onClick={async () => {
                    await savePort(
                      svc.key === 'integration' ? PORT_KEYS.INTEGRATION : PORT_KEYS.WORKFLOW,
                      svc.port,
                      svc.label
                    );
                  }}
                  className="px-2.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white rounded-lg transition-colors"
                >
                  {portSaving === svc.key ? <Spinner size={3} /> : 'Lưu'}
                </button>
                {state.active && (
                  <p className="text-xs text-yellow-400">Tắt tunnel trước khi đổi port</p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* ─── Employee Relay note ─── */}
      <div className="bg-gray-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <span className="text-lg flex-shrink-0 mt-0.5"><UsersIcon className="w-4 h-4" /></span>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-white">Kết nối nhân viên từ xa</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              Để cho phép nhân viên kết nối từ xa qua Internet, bạn cần bật tunnel riêng cho Relay.
              Tính năng này được quản lý trong <strong>Cài đặt → Nhân viên</strong> sau khi bật Relay Server.
              Port kết nối nhân viên (9900) cố định để tránh gián đoạn cho nhân viên đang làm việc.
            </p>
          </div>
        </div>
      </div>

      {/* ─── Hướng dẫn chi tiết ─── */}
      {services.map(svc => (
        <div key={`guide-${svc.key}`} className="bg-gray-800 rounded-xl p-4 space-y-2">
          <p className="font-semibold text-white">{svc.guideTitle}</p>
          <ol className="space-y-1.5 pl-4 list-decimal text-gray-400 leading-relaxed">
            {svc.guideSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {svc.guideExtra}
        </div>
      ))}
    </div>
  );
}
