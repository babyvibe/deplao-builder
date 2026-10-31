/**
 * Webhook → Nhận dữ liệu vào (trước là Cài đặt → Webhooks): ngân hàng (Casso, SePay) gửi giao dịch, phần mềm bán hàng gửi
 * đơn hàng / khách hàng, website / hệ thống khác kích hoạt workflow qua địa chỉ Internet của máy chủ.
 * Địa chỉ ở đây CHỈ ĐỂ XEM (PublicAddressCard, mọi cách tạo địa chỉ); bật / tắt / đổi địa chỉ ở
 * Cài đặt → Internet & Đám mây → Địa chỉ Internet. Đổi cổng nhận vẫn ở đây: workflow:getPortConfig / setPortConfig
 * (Thanh toán & tích hợp 9888, Webhook workflow 9889).
 */
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { CreditCardIcon, InfoIcon, LightningIcon } from '@/components/common/icons';
import { Badge, Button, Card, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import PublicAddressCard, { usePublicAddresses } from '@/components/common/cloud/PublicAddressCard';
import type { TunnelServiceId } from '../../../../shared/cloud/cloudContracts';

const PORT_KEYS = { integration: 'webhook_port_integration', workflow: 'webhook_port_workflow' } as const;
type ServiceKey = keyof typeof PORT_KEYS;

interface InboundService {
  key: ServiceKey;
  /** Dịch vụ tương ứng ở Cài đặt → Internet & Đám mây → Địa chỉ Internet. */
  service: TunnelServiceId;
  /** Đuôi đường dẫn hiện sau địa chỉ gốc ('<…>' → nút sao chép lấy địa chỉ gốc). */
  suffix: string;
  title: string;
  icon: React.ReactNode;
  description: string;
  uses: string[];
  steps: string[];
  urlHint?: string;
  extra?: React.ReactNode;
}

const SERVICES: InboundService[] = [
  {
    key: 'integration',
    service: 'payments',
    suffix: '/webhook/<loại>',
    title: 'Thanh toán & tích hợp',
    icon: <CreditCardIcon className="w-5 h-5" />,
    description: 'Nhận báo chuyển khoản từ Casso, SePay và đơn hàng / khách hàng từ phần mềm bán hàng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS). Đơn vị vận chuyển không gửi vào đây — Deplao tự hỏi khi tra cứu.',
    uses: [
      'Có người chuyển khoản VietQR → chạy workflow "Khi nhận thanh toán"',
      'Phần mềm bán hàng có đơn mới / đổi trạng thái → chạy workflow "Khi phần mềm bán hàng gửi webhook" (chỉ webhook xác thực đúng khoá)',
      'Website, hệ thống khác muốn đẩy dữ liệu vào: dùng "Kích hoạt workflow" bên dưới (trigger "Webhook bên ngoài")',
    ],
    steps: [
      'Bật địa chỉ "Thanh toán, tích hợp" ở Cài đặt → Internet & Đám mây → Địa chỉ Internet',
      'Vào Công cụ → Tích hợp, thêm kết nối Casso / SePay hoặc phần mềm bán hàng (đặt khoá xác thực webhook)',
      'Sao chép địa chỉ nhận trong trang tích hợp đó, dán vào phần webhook của Casso / SePay / phần mềm bán hàng',
      'Có giao dịch / đơn hàng → Deplao kiểm tra chữ ký → workflow "Khi nhận thanh toán" / "Khi phần mềm bán hàng gửi webhook" chạy',
    ],
    urlHint: 'Mỗi tích hợp có đường dẫn riêng dạng <địa chỉ>/webhook/<loại> (xem trong trang tích hợp đó).',
  },
  {
    key: 'workflow',
    service: 'workflow',
    suffix: '/api/workflow/webhook/<token>',
    title: 'Kích hoạt workflow',
    icon: <LightningIcon className="w-5 h-5" />,
    description: 'Website, app, Zapier, Make… gửi dữ liệu vào để chạy kịch bản có trigger "Webhook bên ngoài".',
    uses: [
      'Website bắn đơn hàng, lead, phản hồi sang → workflow tự xử lý',
      'Nhận callback từ dịch vụ bên ngoài, hệ thống bất kỳ hỗ trợ webhook',
    ],
    steps: [
      'Bật địa chỉ "Webhook workflow" ở Cài đặt → Internet & Đám mây → Địa chỉ Internet',
      'Vào Công cụ → Workflow, tạo kịch bản với trigger "Webhook bên ngoài" rồi lưu',
      'Đường dẫn riêng của kịch bản hiện trong cấu hình trigger — gửi cho đối tác / hệ thống bên ngoài',
      'Họ gửi (POST) dữ liệu tới đường dẫn đó → workflow chạy; dùng {{ $trigger.body }}, {{ $trigger.headers }}',
    ],
    urlHint: 'Mỗi kịch bản có đường dẫn riêng dạng <địa chỉ>/api/workflow/webhook/<token> (xem trong trigger của kịch bản).',
    extra: (
      <pre className="mt-2 rounded-lg bg-muted px-3 py-2 text-[11px] leading-relaxed text-muted-foreground font-mono overflow-x-auto">
{`POST /api/workflow/webhook/a1b2c3
{ "orderId": "ORD123", "customer": { "name": "Nguyen Van A" } }

→ trong workflow: {{ $trigger.body.orderId }}`}
      </pre>
    ),
  },
];

export default function InboundWebhooksPanel() {
  const [ports, setPorts] = useState<Record<ServiceKey, number>>({ integration: 9888, workflow: 9889 });
  const [savingPort, setSavingPort] = useState<ServiceKey | null>(null);
  // Địa chỉ Internet chỉ để xem — bật / tắt / đổi ở Cài đặt → Internet & Đám mây → Địa chỉ Internet.
  const publicAddresses = usePublicAddresses();

  useEffect(() => {
    ipc.workflow?.getPortConfig?.().then(res => {
      if (res?.success) setPorts(prev => ({ integration: res.integrationPort || prev.integration, workflow: res.workflowPort || prev.workflow }));
    }).catch(() => undefined);
  }, []);

  const savePort = async (key: ServiceKey) => {
    setSavingPort(key);
    try { await ipc.workflow?.setPortConfig(PORT_KEYS[key], ports[key]); } catch { /* giữ nguyên */ } finally { setSavingPort(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-xl border border-info/30 bg-info/10 px-4 py-3">
        <InfoIcon className="w-4 h-4 mt-0.5 flex-shrink-0 text-info" />
        <div className="space-y-1 text-xs text-foreground/90 leading-relaxed">
          <p>
            Hệ thống khác gửi dữ liệu vào Deplao qua <strong>địa chỉ Internet</strong> của máy chủ.{' '}
            {publicAddresses.serverManaged
              ? 'Địa chỉ do máy chủ quản lý.'
              : 'Bật, tắt hoặc đổi địa chỉ ở Cài đặt → Internet & Đám mây → Địa chỉ Internet.'}
          </p>
          <p className="text-muted-foreground">Chỉ dùng trong cùng mạng LAN thì không cần bật. Địa chỉ chỉ chạy khi Deplao đang mở.</p>
        </div>
      </div>

      {SERVICES.map(svc => {
        const addr = publicAddresses.get(svc.service);
        // Đang nhận thật (địa chỉ đã lên); đổi cổng thì khoá ngay khi địa chỉ đang bật (kể cả đang khởi động / lỗi)
        const active = !!(addr?.enabled && addr.url && addr.state === 'active');
        const portLocked = !!addr?.enabled;
        return (
          <Card key={svc.key} className={cn('overflow-hidden', active && 'border-success/40')}>
            <div className="flex items-start gap-3 p-4">
              <span className={cn('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl', active ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
                {svc.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">{svc.title}</p>
                  {active && <Badge size="sm" dot variant="success">Đang nhận</Badge>}
                  <span className="text-[11px] text-subtle-foreground">cổng {ports[svc.key]}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{svc.description}</p>
              </div>
            </div>

            <div className="mx-4 mb-3 space-y-1.5">
              <PublicAddressCard service={svc.service} title="Địa chỉ nhận" pathSuffix={svc.suffix} anyMode compact />
              {svc.urlHint && <p className="text-[11px] text-subtle-foreground leading-relaxed">{svc.urlHint}</p>}
            </div>

            <div className="grid gap-4 border-t border-border px-4 py-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Dùng để</p>
                <ul className="space-y-1">
                  {svc.uses.map(u => <li key={u} className="text-xs text-muted-foreground leading-relaxed">• {u}</li>)}
                </ul>
              </div>
              <details className="group">
                <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground hover:text-foreground">Cách dùng</summary>
                <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs text-muted-foreground leading-relaxed">
                  {svc.steps.map(s => <li key={s}>{s}</li>)}
                </ol>
                {svc.extra}
              </details>
            </div>

            <details className="border-t border-border px-4 py-2">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">Nâng cao: đổi cổng</summary>
              <div className="flex flex-wrap items-center gap-2 py-2">
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={ports[svc.key]}
                  disabled={portLocked}
                  onChange={e => setPorts(prev => ({ ...prev, [svc.key]: Number(e.target.value) }))}
                  className="w-28"
                  aria-label={`Cổng nhận ${svc.title}`}
                />
                <Button size="sm" variant="outline" disabled={portLocked || savingPort === svc.key} loading={savingPort === svc.key} onClick={() => savePort(svc.key)}>Lưu cổng</Button>
                <span className="text-[11px] text-subtle-foreground">
                  {portLocked ? 'Tắt địa chỉ này ở Cài đặt → Internet & Đám mây trước khi đổi cổng.' : 'Chỉ đổi khi cổng mặc định bị phần mềm khác dùng.'}
                </span>
              </div>
            </details>
          </Card>
        );
      })}
    </div>
  );
}
