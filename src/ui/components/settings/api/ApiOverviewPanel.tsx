/**
 * Tổng quan: server, công tắc API, địa chỉ gọi, truy cập từ xa (địa chỉ Internet dùng chung với nhân viên ở xa — chỉ xem,
 * bật / tắt / đổi ở Cài đặt → Internet & Đám mây → Địa chỉ Internet), giám sát, nút khẩn cấp.
 */
import React, { useEffect, useState } from 'react';
import ipc, { ApiStatusResult } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { ActivityIcon, AlertIcon, BookIcon, GlobeIcon, ServerIcon, ShieldIcon } from '@/components/common/icons';
import RelayAddressNotice from '../employees/RelayAddressNotice';
import PublicAddressCard, { usePublicAddresses } from '@/components/common/cloud/PublicAddressCard';
import { STOPPED_RELAY_TUNNEL, type RelayTunnelStatus } from '../../../../shared/cloud/tunnelAddress';
import { Badge, btn, CopyField, Section, Toggle } from './apiUi';

interface Props {
  status: ApiStatusResult;
  onRefresh: () => Promise<void> | void;
}

export default function ApiOverviewPanel({ status, onRefresh }: Props) {
  const showNotification = useAppStore(s => s.showNotification);
  const [busy, setBusy] = useState<string | null>(null);

  const server = status.server;
  const platform = status.platform;
  const settings = status.settings || {};
  const running = !!server?.running;
  const port = server?.port || 9900;
  const enabled = settings.api_enabled !== '0';
  const autostart = settings.api_server_autostart === '1';
  const localOnly = settings.api_bind_localhost_only === '1';
  const lanIp = (server?.localIPs || [])[0];

  // Tunnel của server (chỉ đọc) — dùng chung cho API và nhân viên làm việc từ xa: địa chỉ vừa đổi, cảnh báo cấu hình.
  const [relayTunnel, setRelayTunnel] = useState<RelayTunnelStatus>(STOPPED_RELAY_TUNNEL);
  const tunnelKey = `${server?.tunnelActive ? 1 : 0}|${server?.tunnelUrl || ''}`;
  useEffect(() => {
    if (status.employeeMachine) return;
    let alive = true;
    ipc.relay?.getServerStatus?.()
      .then(res => { if (alive && res?.success) setRelayTunnel({ ...STOPPED_RELAY_TUNNEL, ...(res.tunnel || {}) }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [tunnelKey, status.employeeMachine]);
  useEffect(() => {
    if (status.employeeMachine) return;
    return ipc.on?.('relay:tunnelStatusUpdate', data => setRelayTunnel({ ...STOPPED_RELAY_TUNNEL, ...(data || {}) }));
  }, [status.employeeMachine]);
  // Địa chỉ Internet của relay (mọi cách tạo địa chỉ) — cấu hình ở Cài đặt → Internet & Đám mây → Địa chỉ Internet.
  const publicAddresses = usePublicAddresses();
  const relayAddr = publicAddresses.get('relay');
  // Bản app không có module Cloudflare: theo tunnel server báo về
  const remoteOn = relayAddr ? !!(relayAddr.enabled && relayAddr.url) : !!(server?.tunnelActive && server.tunnelUrl);
  const remoteActive = relayAddr ? relayAddr.state === 'active' : !!server?.tunnelActive;
  const remoteFixed = (relayAddr?.url ? relayAddr.kind : relayTunnel.kind) === 'fixed';

  const run = async (key: string, fn: () => Promise<any>, okMsg?: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res && res.success === false) showNotification(res.error || 'Thao tác thất bại', 'error');
      else if (okMsg) showNotification(okMsg, 'success');
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setBusy(null);
      await onRefresh();
    }
  };

  const setSetting = (key: string, value: string, okMsg?: string) => run(key, () => ipc.api!.setSetting(key, value), okMsg);

  const stopServer = async () => {
    const employees = server?.connectedEmployees || 0;
    const ok = await showConfirm({
      title: 'Tắt server?',
      message: employees > 0
        ? `API dùng chung server với chế độ nhân viên. Đang có ${employees} nhân viên kết nối, tắt server sẽ ngắt kết nối của họ.\n\nNếu chỉ muốn chặn API, hãy tắt "Cho phép gọi API".`
        : 'API, kết nối nhân viên và tunnel trên cổng này sẽ ngừng cho tới khi bật lại.',
      confirmText: 'Tắt server',
      variant: 'warning',
    });
    if (ok) await run('server', () => ipc.api!.stopServer(), 'Đã tắt server');
  };

  /** Mở tài liệu: server chưa chạy thì main tự bật rồi mở trình duyệt. */
  const openDocs = () => run('docs', async () => {
    const res = await ipc.api!.openDocs();
    if (res?.success && (res as any).started) showNotification('Đã tự bật API server để mở tài liệu', 'success');
    return res;
  });

  const toggleEnabled = async (next: boolean) => {
    if (!next) {
      const ok = await showConfirm({
        title: 'Chặn toàn bộ API?',
        message: 'Mọi lời gọi /api/v1 sẽ nhận lỗi 503 ngay lập tức, không ghi sự kiện, không gửi webhook. Chế độ nhân viên không bị ảnh hưởng.',
        confirmText: 'Chặn API',
        variant: 'warning',
      });
      if (!ok) return;
    }
    await setSetting('api_enabled', next ? '1' : '0', next ? 'Đã bật API' : 'Đã chặn API');
  };

  const revokeAll = async () => {
    const ok = await showConfirm({
      title: 'Thu hồi TẤT CẢ API key?',
      message: 'Mọi website, worker, n8n… đang dùng key sẽ bị từ chối ngay. Key của các ứng dụng đã cài không bị ảnh hưởng. Không thể hoàn tác.',
      confirmText: 'Thu hồi tất cả',
      variant: 'danger',
    });
    if (ok) await run('revokeAll', () => ipc.api!.revokeAllKeys(), 'Đã thu hồi tất cả key');
  };

  if (status.employeeMachine) {
    return (
      <Section title="Máy nhân viên" icon={<AlertIcon className="w-4 h-4" />}>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Máy đang ở chế độ nhân viên nên không chạy API server. Hãy dùng API trên máy chủ (máy của chủ shop).
        </p>
      </Section>
    );
  }

  const m = platform?.metrics;
  const ipcStats = platform?.ipc;

  return (
    <div className="space-y-4">
      <Section
        title="API server"
        icon={<ServerIcon className="w-4 h-4" />}
        right={running
          ? <Badge tone="green">Đang chạy · cổng {port}</Badge>
          : <Badge>Đang tắt</Badge>}
      >
        <p className="text-xs text-muted-foreground leading-relaxed">
          API chạy chung cổng với server kết nối nhân viên. Mọi lời gọi dùng cùng logic với giao diện app, nên kết quả giống hệt thao tác bằng tay.
        </p>
        <div className="flex flex-wrap gap-2">
          {running
            ? <button type="button" className={btn.secondary} disabled={busy === 'server'} onClick={stopServer}>Tắt server</button>
            : <button type="button" className={btn.primary} disabled={busy === 'server'} onClick={() => run('server', () => ipc.api!.startServer(), 'Đã bật API server')}>Bật server</button>}
          <button type="button" className={btn.secondary} disabled={busy === 'docs'} onClick={openDocs}>
            <BookIcon className="w-3.5 h-3.5 inline mr-1" />Mở tài liệu API
          </button>
        </div>

        <div className="divide-y divide-border/60">
          <div className="flex items-center justify-between gap-3 py-2">
            <div>
              <p className="text-xs font-medium text-foreground">Cho phép gọi API</p>
              <p className="text-[11px] text-subtle-foreground">Công tắc khẩn cấp: tắt là mọi lời gọi /api/v1 trả 503 ngay.</p>
            </div>
            <Toggle checked={enabled} busy={busy === 'api_enabled'} onChange={toggleEnabled} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <div>
              <p className="text-xs font-medium text-foreground">Tự bật server khi mở app</p>
              <p className="text-[11px] text-subtle-foreground">Dành cho máy chạy bot/worker 24/7.</p>
            </div>
            <Toggle checked={autostart} busy={busy === 'api_server_autostart'} onChange={next => setSetting('api_server_autostart', next ? '1' : '0')} />
          </div>
        </div>

        {running && (
          <div className="space-y-2">
            <CopyField label="Trên máy này" value={`http://127.0.0.1:${port}/api/v1`} />
            {!localOnly && lanIp && <CopyField label="Trong mạng LAN" value={`http://${lanIp}:${port}/api/v1`} />}
            {server?.tunnelActive && server.tunnelUrl && <CopyField label="Từ Internet (tunnel)" value={`${server.tunnelUrl.replace(/\/$/, '')}/api/v1`} />}
          </div>
        )}
      </Section>

      <Section
        title="Truy cập từ xa"
        icon={<GlobeIcon className="w-4 h-4" />}
        right={remoteOn
          ? <Badge tone={!remoteActive ? 'gray' : remoteFixed ? 'green' : 'yellow'}>{remoteFixed ? 'Địa chỉ cố định' : 'Địa chỉ tạm'}</Badge>
          : <Badge>Chưa bật</Badge>}
      >
        <p className="text-xs text-muted-foreground leading-relaxed">
          Server, n8n, Make… ở ngoài gọi API qua địa chỉ Internet của máy này. Đây cũng là địa chỉ <strong className="text-foreground">nhân viên làm việc từ xa</strong> dùng
          để kết nối (không kèm <code className="font-mono">/api/v1</code>, dán vào ô "Kết nối lại").
        </p>
        {publicAddresses.available ? (
          <PublicAddressCard service="relay" title="Gọi API từ Internet" pathSuffix="/api/v1" anyMode statusNote="dùng chung với nhân viên" />
        ) : server?.tunnelActive && server.tunnelUrl ? (
          <CopyField label="Địa chỉ Internet" value={server.tunnelUrl.replace(/\/$/, '')} />
        ) : null}
        {relayTunnel.warning && relayTunnel.warning !== relayAddr?.error && (
          <p className="text-xs text-warning"><AlertIcon className="w-4 h-4 inline mr-1" />{relayTunnel.warning}</p>
        )}
        <RelayAddressNotice status={relayTunnel} />
        <p className="text-[11px] text-subtle-foreground leading-relaxed">
          Khi mở ra Internet: tạo key riêng cho từng hệ thống, chỉ cấp scope và tài khoản cần thiết, đặt IP được phép nếu server gọi có IP cố định.
        </p>
      </Section>

      <Section title="Giám sát (5 phút gần nhất)" icon={<ActivityIcon className="w-4 h-4" />}>
        {platform?.initialized ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Request/phút" value={m ? String(m.requests_per_min) : '0'} />
            <Stat label="p95" value={m ? `${m.p95_ms} ms` : '—'} />
            <Stat label="Lỗi 5xx" value={m ? String(m.errors_5xx) : '0'} tone={m && m.errors_5xx > 0 ? 'red' : undefined} />
            <Stat label="IPC đang chạy / chờ" value={ipcStats ? `${ipcStats.active} / ${ipcStats.queued}` : '0 / 0'} />
            <Stat label="Kết nối realtime" value={String(platform?.events.sockets ?? 0)} />
            <Stat label="Ghi sự kiện" value={platform?.events.capturing ? 'Đang ghi' : 'Không'} />
            <Stat label="Số endpoint" value={String(platform?.routes ?? 0)} />
            <Stat label="IP bị tạm chặn" value={String(platform?.blocked_ips.length ?? 0)} tone={platform && platform.blocked_ips.length > 0 ? 'yellow' : undefined} />
          </div>
        ) : (
          <p className="text-xs text-subtle-foreground">Chưa có lời gọi API nào kể từ khi mở app.</p>
        )}
        {platform && platform.blocked_ips.length > 0 && (
          <p className="text-[11px] text-warning">IP gửi sai key quá nhiều (tạm chặn 10 phút): {platform.blocked_ips.join(', ')}</p>
        )}
      </Section>

      <Section title="Khẩn cấp" icon={<ShieldIcon className="w-4 h-4" />}>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Nghi lộ key? Thu hồi tất cả rồi tạo lại key cho từng hệ thống. Có thể chặn tạm toàn bộ API bằng công tắc "Cho phép gọi API" ở trên.
        </p>
        <button type="button" className={btn.danger} disabled={busy === 'revokeAll'} onClick={revokeAll}>Thu hồi tất cả API key</button>
      </Section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'yellow' }) {
  const color = tone === 'red' ? 'text-destructive' : tone === 'yellow' ? 'text-warning' : 'text-foreground';
  return (
    <div className="bg-muted rounded-lg px-3 py-2">
      <p className="text-[11px] text-subtle-foreground">{label}</p>
      <p className={`text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}
