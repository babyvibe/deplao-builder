/**
 * Cài đặt → Internet & Đám mây → Địa chỉ Internet — nơi DUY NHẤT cấu hình và bật / tắt địa chỉ Internet (các màn khác chỉ
 * hiện địa chỉ và dẫn về đây).
 *  - "Cách tạo địa chỉ": Địa chỉ tạm · Cloudflare tự động · ngrok · Cloudflare thủ công (tunnel.setMode — chế độ khác
 *    Cloudflare tự động ghi luôn nhà cung cấp tunnel của relay).
 *  - Cloudflare tự động: chọn tên miền + "Tên máy", xem trước ngay khi gõ, "Áp dụng" → tunnel.configureAuto.
 *    Mặc định một địa chỉ cho mọi dịch vụ (chia theo đường dẫn); "Tách tên riêng cho từng dịch vụ" ở Nâng cao.
 *  - ngrok / Cloudflare thủ công: form token + domain / địa chỉ công khai + hướng dẫn (RelayProviderForm, lưu qua
 *    relay:getTunnelConfig / setTunnelConfig). Tunnel relay đang chạy mà đổi cấu hình → "Áp dụng" (relay:restartTunnel,
 *    không ngắt nhân viên).
 *  - Bảng ba dịch vụ (9900 / 9888 / 9889): địa chỉ + loại (Cố định / Địa chỉ tạm) + sao chép, trạng thái, công tắc riêng
 *    (tunnel.setServiceEnabled — mọi chế độ; chế độ khác Cloudflare tự động bật / tắt tunnel kiểu cũ của từng cổng ở main).
 *  - "Tự bật khi mở app" cho mọi chế độ (tunnel.setAutoStart).
 *  - Tình trạng tunnel (tunnel.health — gọi khi mở và khi bấm "Kiểm tra lại", không theo chu kỳ vì có gọi Cloudflare).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { CopyIcon, ExternalLinkIcon, RefreshIcon } from '@/components/common/icons';
import { Badge, Button, Card, FormField, Input, Select, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { copyWithToast } from '../RelayAddressNotice';
import { publishPublicAddresses } from '../../common/PublicAddressCard';
import type {
  AddressLayout,
  CloudConnectionStatus,
  CloudZone,
  PublicAddress,
  TunnelAutoConfig,
  TunnelConfigView,
  TunnelHealth,
  TunnelMode,
  TunnelServiceId,
} from '../../../../shared/cloudContracts';
import type { TunnelProviderId } from '../../../../shared/tunnelAddress';
import {
  addressStatus,
  cleanIpcError,
  cloudApi,
  hostPrefixError,
  MODE_LABEL,
  Notice,
  openExternalUrl,
  permissionOf,
  PillGroup,
  previewHosts,
  sanitizeHostPrefix,
  SERVICE_META,
  SERVICE_ORDER,
  SettingRow,
  useCloudAction,
} from './cloudUi';
import {
  RELAY_PROVIDER,
  RelayProviderForm,
  useRelayProviderConfig,
  type LegacyTunnelMode,
  type RelayTunnelConfig,
} from './RelayProviderForm';

export interface AddressSectionProps {
  connection: CloudConnectionStatus | null;
  config: TunnelConfigView | null;
  addresses: PublicAddress[];
  /** Kết quả mới từ main (configureAuto / setMode / setServiceEnabled / moveHere). */
  onTunnelChange?: (patch: { config?: TunnelConfigView; addresses?: PublicAddress[] }) => void;
  /** Đọc lại cấu hình + địa chỉ. */
  onRefresh?: () => void;
  /** Đưa người dùng tới thẻ Kết nối Cloudflare. */
  onConnect?: () => void;
  /** Kiểm tra lại token (sau khi thêm tên miền / quyền). */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Tình trạng tunnel đã đọc trước (test). */
  initialHealth?: TunnelHealth | null;
  /** Cấu hình tunnel của relay + nhà cung cấp đang chạy đã đọc trước (test). */
  initialRelay?: { config?: Partial<RelayTunnelConfig> | null; runningProvider?: TunnelProviderId | null } | null;
}

const MODE_ORDER: TunnelMode[] = ['quick', 'cloudflare_auto', 'ngrok', 'cloudflare_manual'];

/** "Tự bật khi mở app" ở chế độ khác Cloudflare tự động = relay_tunnel_autostart của relay (như trước). */
const LEGACY_AUTOSTART_HINT =
  'Chỉ áp dụng cho Nhân viên và API: tunnel bật lại khi máy chủ nhân viên (LAN) tự chạy lúc mở app (bật "Tự động bật khi mở app" '
  + 'của LAN ở Cài đặt → Nhân viên → Kết nối). Thanh toán, tích hợp và Webhook workflow không tự bật, bật lại ở bảng trên khi cần.';

const CF_STATUS: Record<string, { label: string; dot: string }> = {
  healthy: { label: 'Healthy', dot: 'bg-success' },
  degraded: { label: 'Degraded', dot: 'bg-warning' },
  down: { label: 'Down', dot: 'bg-destructive' },
  inactive: { label: 'Inactive', dot: 'bg-accent' },
};

export default function AddressSection({
  connection,
  config,
  addresses,
  onTunnelChange,
  onRefresh,
  onConnect,
  onRecheck,
  rechecking,
  initialHealth = null,
  initialRelay = null,
}: AddressSectionProps) {
  const { busy, run, notify } = useCloudAction();
  const zoneFieldId = useId();
  const prefixFieldId = useId();
  const connected = !!connection?.connected;
  const zones = useMemo<CloudZone[]>(() => connection?.zones ?? [], [connection]);
  const tunnelPerm = permissionOf(connection, 'tunnel');
  const mode: TunnelMode = config?.mode ?? 'quick';
  const auto = config?.auto ?? null;

  // "Cloudflare tự động" khi chưa từng cấu hình: chỉ mở form (cách cũ vẫn chạy tới khi Áp dụng xong).
  const [draftMode, setDraftMode] = useState<TunnelMode | null>(null);
  const shownMode = draftMode ?? mode;

  // Nháp của form; đặt lại theo cấu hình đã lưu mỗi khi cấu hình đổi.
  const savedKey = auto ? `${auto.zoneId}|${auto.hostPrefix}|${auto.layout}` : '';
  const [zoneId, setZoneId] = useState(auto?.zoneId ?? zones[0]?.id ?? '');
  const [prefix, setPrefix] = useState(auto?.hostPrefix ?? '');
  const [layout, setLayout] = useState<AddressLayout>(auto?.layout ?? 'single');
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    if (!auto) return;
    setZoneId(auto.zoneId);
    setPrefix(auto.hostPrefix);
    setLayout(auto.layout);
    setFormError(null);
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!zoneId && zones[0]) setZoneId(zones[0].id);
  }, [zones, zoneId]);

  const zone: CloudZone | null = zones.find(z => z.id === zoneId)
    ?? (auto && auto.zoneId === zoneId ? { id: auto.zoneId, name: auto.zoneName, status: 'active' } : null);
  const dirty = !auto || auto.zoneId !== zoneId || auto.hostPrefix !== prefix || auto.layout !== layout;
  const hosts = !dirty && config?.preview ? config.preview : previewHosts(prefix, zone?.name ?? '', layout);

  // ── Tình trạng tunnel ──
  const [health, setHealth] = useState<TunnelHealth | null>(initialHealth);
  const [healthBusy, setHealthBusy] = useState(false);
  const autoConfigured = mode === 'cloudflare_auto' && !!auto;
  const checkHealth = useCallback(async (quiet = false) => {
    const api = cloudApi();
    if (!api) return;
    setHealthBusy(true);
    try {
      // Bấm "Kiểm tra lại" → đọc lại phía Cloudflare; tự kiểm khi mở trang dùng bản nhớ.
      const res = await api.tunnel.health(quiet ? undefined : { refresh: true });
      if (res?.success && res.health) setHealth(res.health);
      else if (!quiet) notify(res?.error || 'Không kiểm tra được tunnel', 'error');
    } catch (err) {
      if (!quiet) notify(cleanIpcError(err), 'error');
    } finally {
      setHealthBusy(false);
    }
  }, [notify]);
  useEffect(() => {
    if (autoConfigured) void checkHealth(true);
  }, [autoConfigured, checkHealth]);

  // ── Địa chỉ tạm / ngrok / Cloudflare thủ công: tunnel kiểu cũ của từng cổng + cấu hình tunnel của relay ──
  const legacyMode = mode !== 'cloudflare_auto';
  const relayOn = legacyMode && !!addresses.find(a => a.service === 'relay')?.enabled;
  const relayCfg = useRelayProviderConfig({
    active: legacyMode,
    relayOn,
    initial: initialRelay?.config,
    initialRunningProvider: initialRelay?.runningProvider ?? null,
  });
  const relayProblem = legacyMode ? relayCfg.problem(mode) : null;
  // Tunnel relay đang chạy theo cách / cấu hình cũ → "Áp dụng" (tunnel mới lên trước, không ngắt nhân viên)
  const providerChanged = relayOn && !!relayCfg.runningProvider && relayCfg.runningProvider !== RELAY_PROVIDER[mode as LegacyTunnelMode];
  const needsApply = relayOn && !draftMode && (relayCfg.dirty || providerChanged);

  // Tunnel kiểu cũ đổi (tự chạy lại ra địa chỉ tạm mới, bật / tắt) → đọc lại địa chỉ ngay thay vì chờ lượt 15 s
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (!legacyMode) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current?.();
      }, 500);
    };
    const offs = [ipc.on?.('relay:tunnelStatusUpdate', later), ipc.on?.('tunnel:changed', later)];
    return () => {
      offs.forEach(off => off?.());
      if (timer) clearTimeout(timer);
    };
  }, [legacyMode]);

  const applyTunnel = (patch: { config?: TunnelConfigView; addresses?: PublicAddress[] }) => {
    if (patch.addresses) publishPublicAddresses(patch.addresses);
    onTunnelChange?.(patch);
  };

  // ── Áp dụng cấu hình Cloudflare tự động ──
  const apply = async (override?: Partial<TunnelAutoConfig>): Promise<boolean> => {
    const input: TunnelAutoConfig | null = zone
      ? { zoneId: zone.id, zoneName: zone.name, hostPrefix: prefix, layout, ...override }
      : null;
    const err = !input ? 'Chọn tên miền.' : hostPrefixError(input.hostPrefix);
    if (err || !input) { setFormError(err); return false; }
    setFormError(null);
    const inUse = !!auto && addresses.some(a => a.enabled && !!a.url);
    const changesHost = !!auto && (auto.zoneId !== input.zoneId || auto.hostPrefix !== input.hostPrefix || auto.layout !== input.layout);
    if (inUse && changesHost) {
      const ok = await showConfirm({
        title: 'Đổi địa chỉ Internet?',
        message: 'Địa chỉ cũ sẽ ngừng hoạt động. Nhớ cập nhật địa chỉ mới ở Casso, SePay, website và gửi cho nhân viên làm việc từ xa.',
        confirmText: 'Đổi địa chỉ',
        variant: 'warning',
      });
      if (!ok) return false;
    }
    const res = await run('apply', () => cloudApi()?.tunnel.configureAuto(input));
    if (!res) return false;
    let nextConfig = res.config;
    if (nextConfig && nextConfig.mode !== 'cloudflare_auto') {
      const switched = await run('mode', () => cloudApi()?.tunnel.setMode('cloudflare_auto'));
      if (switched?.config) nextConfig = switched.config;
    }
    setDraftMode(null);
    applyTunnel({ config: nextConfig, addresses: res.addresses });
    notify(auto ? 'Đã cập nhật địa chỉ cố định' : 'Đã tạo địa chỉ cố định', 'success');
    void checkHealth(true);
    onRefresh?.();
    return true;
  };

  const changeLayout = async (next: AddressLayout) => {
    if (!auto) { setLayout(next); return; }
    setLayout(next);
    const ok = await apply({ layout: next });
    if (!ok) setLayout(auto.layout);
  };

  // ── Đổi cách tạo địa chỉ ──
  const chooseMode = async (next: TunnelMode) => {
    if (next === mode) { setDraftMode(null); return; }
    if (next === shownMode) return;
    if (next === 'cloudflare_auto' && !auto) { setDraftMode('cloudflare_auto'); return; }
    if (mode === 'cloudflare_auto' && auto) {
      const ok = await showConfirm({
        title: `Chuyển sang ${MODE_LABEL[next]}?`,
        message: 'Địa chỉ cố định ngừng dùng trên máy này (tunnel và tên miền vẫn giữ trên Cloudflare, chuyển lại được). Nhân viên ở xa và đối tác phải dùng địa chỉ mới.',
        confirmText: 'Chuyển',
        variant: 'warning',
      });
      if (!ok) return;
    }
    const res = await run('mode', () => cloudApi()?.tunnel.setMode(next));
    if (!res) return;
    setDraftMode(null);
    if (res.config) applyTunnel({ config: res.config });
    // Tunnel của relay vẫn chạy theo cách cũ cho tới khi bấm "Áp dụng" (như trước ở Cài đặt → Nhân viên). Biết nhà cung
    // cấp đang chạy thì so trực tiếp (providerChanged); chưa biết thì đánh dấu để vẫn hiện "Áp dụng".
    if (next !== 'cloudflare_auto' && !relayCfg.runningProvider) relayCfg.markDirty();
    onRefresh?.();
  };

  // ── Dịch vụ ──
  const toggleService = async (service: TunnelServiceId, enabled: boolean) => {
    if (!enabled) {
      const ok = await showConfirm({
        title: `Tắt địa chỉ ${SERVICE_META[service].name}?`,
        message: SERVICE_META[service].offWarning,
        confirmText: 'Tắt',
        variant: 'warning',
      });
      if (!ok) return;
    }
    if (enabled && service === 'relay' && legacyMode) {
      // ngrok / thủ công: đủ cấu hình mới bật; lưu nốt ô đang gõ dở để relay dùng đúng cấu hình
      if (relayProblem) { notify(relayProblem, 'warning'); return; }
      if (!(await relayCfg.flush(mode))) return;
    }
    const res = await run(`svc:${service}`, () => cloudApi()?.tunnel.setServiceEnabled(service, enabled));
    if (res?.addresses) applyTunnel({ addresses: res.addresses });
    else if (res) onRefresh?.();
    if (res && service === 'relay') relayCfg.clearDirty();
  };

  // ── Áp dụng cấu hình mới cho tunnel relay đang chạy (make-before-break) ──
  const applyRelay = async () => {
    if (relayProblem) { notify(relayProblem, 'warning'); return; }
    const res = await run('relay-apply', async () => {
      if (!(await relayCfg.flush(mode))) return { success: false, error: 'Chưa lưu được cấu hình tunnel, tunnel cũ vẫn chạy' };
      const out = await ipc.relay?.restartTunnel?.();
      if (!out || out.success) return out;
      return { ...out, error: `${out.error || 'Không chuyển được tunnel'} — tunnel cũ vẫn chạy` };
    }, 'Đã áp dụng. Nhân viên đang kết nối được báo địa chỉ mới tự động.');
    if (res) relayCfg.clearDirty();
    onRefresh?.();
  };

  const setAutoStart = async (on: boolean) => {
    const okMessage = on
      ? (legacyMode ? 'Tunnel của Nhân viên và API sẽ tự bật khi mở app' : 'Tunnel sẽ tự bật khi mở app')
      : 'Đã tắt tự bật khi mở app';
    const res = await run('autostart', () => cloudApi()?.tunnel.setAutoStart(on), okMessage);
    if (res) onRefresh?.();
  };

  // ── Nâng cao ──
  const moveHere = async () => {
    const ok = await showConfirm({
      title: 'Chuyển địa chỉ sang máy này?',
      message: 'Deplao tạo tunnel mới trên máy này và trỏ tên miền về đây. Máy đang giữ địa chỉ sẽ ngừng nhận nhân viên, API và webhook.',
      confirmText: 'Chuyển sang máy này',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('move', () => cloudApi()?.tunnel.moveHere(), 'Đã chuyển địa chỉ sang máy này');
    if (!res) return;
    if (res.addresses) applyTunnel({ addresses: res.addresses });
    void checkHealth(true);
    onRefresh?.();
  };

  const disconnectForeign = async () => {
    const ok = await showConfirm({
      title: 'Ngắt máy lạ?',
      message: 'Máy khác đang chạy cùng tunnel sẽ mất kết nối tới địa chỉ này. Nếu không rõ máy đó của ai, nên đổi token Cloudflare.',
      confirmText: 'Ngắt máy lạ',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('foreign', () => cloudApi()?.tunnel.disconnectForeign(), 'Đã ngắt máy lạ');
    if (res) void checkHealth(true);
  };

  const teardown = async () => {
    const ok = await showConfirm({
      title: 'Gỡ tunnel và địa chỉ?',
      message: 'Xoá tunnel và tên miền con Deplao đã tạo trên Cloudflare. Nhân viên ở xa và đối tác sẽ không vào được cho tới khi tạo lại. Dữ liệu trong app không bị ảnh hưởng.',
      confirmText: 'Gỡ tunnel',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await run('teardown', () => cloudApi()?.tunnel.teardown(), 'Đã gỡ tunnel và địa chỉ');
    if (!res) return;
    setHealth(null);
    onRefresh?.();
  };

  const byService = (service: TunnelServiceId) => addresses.find(a => a.service === service) ?? null;
  const restarting = addresses.some(a => a.enabled && a.state === 'restarting');
  const failed = addresses.find(a => a.enabled && a.state === 'error');
  const foreign = health?.foreignConnectors ?? 0;
  const showTable = !draftMode && addresses.length > 0;
  // Bật một địa chỉ kiểu cũ có thể mất vài chục giây (tải / chạy cloudflared) — khoá các công tắc khác tới khi xong
  const serviceBusy = !!busy && busy.startsWith('svc:');
  const showAutoStart = !draftMode && !!config && (legacyMode || !!auto);

  const modeOptions = MODE_ORDER.map(value => ({
    value,
    label: MODE_LABEL[value],
    disabled: value === 'cloudflare_auto' && !connected && mode !== 'cloudflare_auto',
    title: value === 'cloudflare_auto' && !connected ? 'Kết nối Cloudflare trước' : undefined,
  }));

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">Cách tạo địa chỉ</p>
        <PillGroup label="Cách tạo địa chỉ" value={shownMode} options={modeOptions} onChange={m => void chooseMode(m)} disabled={busy === 'mode'} />
      </div>

      {shownMode === 'quick' && (
        <Notice tone="info" title="Địa chỉ tạm">
          <p>
            Cloudflare Quick Tunnel, không cần tài khoản. Địa chỉ đổi mỗi lần khởi động lại; phải gửi lại cho nhân viên
            và đối tác. Chỉ nên dùng thử.
          </p>
          <p className="text-muted-foreground">
            {connected
              ? 'Đã kết nối Cloudflare: chọn Cloudflare tự động để có địa chỉ cố định trên tên miền của bạn.'
              : 'Có tên miền trên Cloudflare? Kết nối Cloudflare ở đầu trang để có địa chỉ cố định.'}
          </p>
        </Notice>
      )}

      {(shownMode === 'ngrok' || shownMode === 'cloudflare_manual') && (
        <RelayProviderForm mode={shownMode} config={relayCfg} />
      )}

      {needsApply && (
        <Notice
          tone="warning"
          title="Nhân viên và API chưa dùng cấu hình mới"
          action={(
            <Button size="sm" loading={busy === 'relay-apply'} disabled={!!relayProblem} onClick={() => void applyRelay()}>
              Áp dụng
            </Button>
          )}
        >
          <p>
            Tunnel của Nhân viên và API vẫn chạy theo cấu hình cũ. Bấm Áp dụng: tunnel mới bật trước, nhân viên đang kết nối
            được báo địa chỉ mới rồi tunnel cũ mới tắt.
          </p>
          {relayProblem && <p className="text-warning">{relayProblem}</p>}
        </Notice>
      )}

      {shownMode === 'cloudflare_auto' && (
        <Card className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Cloudflare tự động <Badge size="sm" variant="primary" className="ml-1 align-middle">Khuyên dùng</Badge></p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Deplao tự tạo tunnel và tên miền con trên Cloudflare của bạn. Địa chỉ không đổi khi khởi động lại; nhân viên
              và đối tác chỉ cần cài một lần.
            </p>
          </div>

          {!connected ? (
            <Notice
              tone="info"
              title="Cần kết nối Cloudflare"
              action={onConnect && <Button size="sm" onClick={onConnect}>Kết nối Cloudflare</Button>}
            >
              <p>Kết nối tài khoản Cloudflare có tên miền để tạo địa chỉ cố định.</p>
            </Notice>
          ) : (
            <>
              {tunnelPerm && !tunnelPerm.ok && (
                <Notice tone="warning" title="Token thiếu quyền tạo địa chỉ">
                  <p>
                    {tunnelPerm.missing?.length ? `${tunnelPerm.missing.join(' · ')}. ` : 'Cần quyền Cloudflare Tunnel, DNS và Zone. '}
                    Tạo token mới đủ quyền rồi bấm Quản lý → Đổi token.
                  </p>
                </Notice>
              )}
              {zones.length === 0 && (
                <Notice
                  tone="warning"
                  title="Tài khoản chưa có tên miền trên Cloudflare"
                  action={(
                    <>
                      <Button size="sm" variant="outline" rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />} onClick={() => openExternalUrl('https://dash.cloudflare.com/')}>
                        Mở Cloudflare
                      </Button>
                      {onRecheck && (
                        <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
                          Kiểm tra lại
                        </Button>
                      )}
                    </>
                  )}
                >
                  <p>Thêm tên miền vào Cloudflare (gói Free là đủ) và đổi nameserver theo hướng dẫn của Cloudflare, rồi bấm Kiểm tra lại.</p>
                </Notice>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <FormField label="Tên miền" htmlFor={zoneFieldId} className="w-56">
                  <Select id={zoneFieldId} value={zoneId} disabled={zones.length === 0 && !auto} onChange={e => { setZoneId(e.target.value); setFormError(null); }}>
                    {zones.length === 0 && !zone && <option value="">Chưa có tên miền</option>}
                    {zone && !zones.some(z => z.id === zone.id) && <option value={zone.id}>{zone.name}</option>}
                    {zones.map(z => (
                      <option key={z.id} value={z.id}>{z.name}{z.status && z.status !== 'active' ? ` (${z.status})` : ''}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Tên máy" htmlFor={prefixFieldId} className="w-40">
                  <Input
                    id={prefixFieldId}
                    value={prefix}
                    placeholder="shop"
                    maxLength={40}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={e => { setPrefix(sanitizeHostPrefix(e.target.value)); setFormError(null); }}
                  />
                </FormField>
                <p className="min-w-0 flex-1 pb-2 text-xs text-muted-foreground">
                  {hosts
                    ? layout === 'split'
                      ? <>→ <span className="font-mono text-foreground">{hosts.relay}</span>, <span className="font-mono text-foreground">{hosts.payments}</span>, <span className="font-mono text-foreground">{hosts.workflow}</span></>
                      : <>→ <span className="font-mono text-foreground">{hosts.relay}</span> cho mọi dịch vụ</>
                    : 'Nhập tên máy để xem trước địa chỉ'}
                </p>
              </div>
              {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void apply()}
                  loading={busy === 'apply'}
                  disabled={!dirty || !zone || (!!tunnelPerm && !tunnelPerm.ok)}
                >
                  Áp dụng
                </Button>
                {draftMode && <Button variant="ghost" onClick={() => setDraftMode(null)}>Huỷ</Button>}
                {auto && dirty && <span className="text-xs text-warning">Chưa áp dụng thay đổi</span>}
                {!auto && <span className="text-xs text-muted-foreground">Cách đang dùng vẫn chạy cho tới khi tạo xong địa chỉ.</span>}
              </div>
            </>
          )}
        </Card>
      )}

      {showTable && (restarting || failed || foreign > 0) && (
        <div className="space-y-2">
          {restarting && <Notice tone="warning"><p>Tunnel mất kết nối, đang tự chạy lại.</p></Notice>}
          {failed && <Notice tone="destructive"><p>{failed.error || `Địa chỉ ${SERVICE_META[failed.service].name} đang lỗi.`}</p></Notice>}
          {foreign > 0 && (
            <Notice
              tone="warning"
              action={<Button size="sm" variant="outline" loading={busy === 'foreign'} onClick={() => void disconnectForeign()}>Ngắt máy lạ</Button>}
            >
              <p>Có {foreign} máy khác đang chạy cùng tunnel này, request có thể đi nhầm máy.</p>
            </Notice>
          )}
        </div>
      )}

      {showTable && (
        <Card className="overflow-hidden">
          <div role="table" aria-label="Địa chỉ của từng dịch vụ" className="text-sm">
            <div role="row" className="hidden grid-cols-[170px_minmax(0,1fr)_120px_48px] gap-3 border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground md:grid">
              <span role="columnheader">Dịch vụ</span>
              <span role="columnheader">Địa chỉ</span>
              <span role="columnheader">Trạng thái</span>
              <span role="columnheader" className="text-right">Bật</span>
            </div>
            {SERVICE_ORDER.map(service => (
              <ServiceRow
                key={service}
                service={service}
                address={byService(service)}
                busy={busy === `svc:${service}`}
                locked={serviceBusy}
                onToggle={enabled => void toggleService(service, enabled)}
              />
            ))}
          </div>
        </Card>
      )}

      {autoConfigured && !draftMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {health ? (
            <p className="flex min-w-0 items-center gap-2">
              <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', (CF_STATUS[health.cfStatus ?? ''] ?? CF_STATUS.inactive).dot)} aria-hidden="true" />
              <span>
                Tunnel {health.tunnelName || '—'} · {(CF_STATUS[health.cfStatus ?? ''] ?? { label: health.cfStatus || 'Chưa rõ' }).label}
                {' · '}{health.connections} kết nối · {config?.autoStart ? 'tự bật khi mở app' : 'không tự bật khi mở app'}
                {!health.localReady && <span className="text-warning"> · cloudflared trên máy chưa sẵn sàng</span>}
              </span>
            </p>
          ) : (
            <p>Chưa kiểm tra tình trạng tunnel.</p>
          )}
          <Button variant="link" size="sm" className="text-xs" loading={healthBusy} onClick={() => void checkHealth()}>
            Kiểm tra lại
          </Button>
        </div>
      )}

      {showAutoStart && (
        <Card className="px-4">
          <SettingRow
            title="Tự bật khi mở app"
            description={legacyMode ? LEGACY_AUTOSTART_HINT : 'Tunnel chạy lại ngay khi mở Deplao, nhân viên và đối tác không phải chờ.'}
            control={(
              <Switch
                checked={!!config?.autoStart}
                disabled={busy === 'autostart'}
                onCheckedChange={next => void setAutoStart(next)}
                aria-label="Tự bật tunnel khi mở app"
              />
            )}
          />
        </Card>
      )}

      {shownMode === 'cloudflare_auto' && connected && (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/50">
            Nâng cao
            <span className="ml-2 text-xs font-normal text-muted-foreground">tách tên riêng cho từng dịch vụ, chuyển sang máy này, gỡ tunnel, ngắt máy lạ</span>
          </summary>
          <div className="divide-y divide-border border-t border-border px-4">
            <SettingRow
              title="Tách tên riêng cho từng dịch vụ"
              description={`Mỗi dịch vụ một tên (${prefix || 'shop'}, ${prefix || 'shop'}-pay, ${prefix || 'shop'}-hook) thay vì một địa chỉ chia theo đường dẫn.`}
              control={(
                <Switch
                  checked={layout === 'split'}
                  disabled={busy === 'apply'}
                  onCheckedChange={next => void changeLayout(next ? 'split' : 'single')}
                  aria-label="Tách tên riêng cho từng dịch vụ"
                />
              )}
            />
            {auto && (
              <>
                <SettingRow
                  title="Chuyển sang máy này"
                  description="Dùng khi đổi máy chủ: tạo tunnel mới trên máy này và trỏ tên miền về đây."
                  control={<Button size="sm" variant="outline" loading={busy === 'move'} onClick={() => void moveHere()}>Chuyển sang máy này</Button>}
                />
                {foreign > 0 && (
                  <SettingRow
                    title="Ngắt máy lạ"
                    description={`Có ${foreign} máy khác đang chạy cùng tunnel này.`}
                    control={<Button size="sm" variant="outline" loading={busy === 'foreign'} onClick={() => void disconnectForeign()}>Ngắt máy lạ</Button>}
                  />
                )}
                <SettingRow
                  title="Gỡ tunnel và địa chỉ"
                  description="Xoá tunnel và tên miền con Deplao đã tạo trên Cloudflare."
                  control={<Button size="sm" variant="destructive" loading={busy === 'teardown'} onClick={() => void teardown()}>Gỡ tunnel và địa chỉ</Button>}
                />
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function ServiceRow({ service, address, busy, locked = false, onToggle }: {
  service: TunnelServiceId;
  address: PublicAddress | null;
  busy: boolean;
  /** Đang bật / tắt một dịch vụ khác. */
  locked?: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const meta = SERVICE_META[service];
  const status = addressStatus(address, meta.activeLabel);
  const url = address?.url ? address.url.replace(/\/+$/, '') : null;
  return (
    <div role="row" className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[170px_minmax(0,1fr)_120px_48px] md:items-center md:gap-3">
      <div role="cell" className="min-w-0">
        <p className="font-medium text-foreground">{meta.name}</p>
        <p className="text-[11px] text-subtle-foreground">cổng {meta.port}</p>
      </div>
      <div role="cell" className="min-w-0">
        {url && address?.enabled ? (
          <div className="flex min-w-0 items-center gap-1">
            {address.kind && (
              <Badge size="sm" variant={address.kind === 'fixed' ? 'success' : 'warning'} className="flex-shrink-0">
                {address.kind === 'fixed' ? 'Cố định' : 'Địa chỉ tạm'}
              </Badge>
            )}
            <code className="min-w-0 truncate font-mono text-xs text-foreground" title={`${url}${meta.suffix}`}>
              {url}<span className="text-subtle-foreground">{meta.suffix}</span>
            </code>
            <button
              type="button"
              onClick={() => copyWithToast(url, 'Đã sao chép địa chỉ')}
              title={meta.suffix ? 'Sao chép địa chỉ gốc' : 'Sao chép địa chỉ'}
              aria-label={`Sao chép địa chỉ ${meta.name}`}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-subtle-foreground">
            {!address
              ? 'Chưa có địa chỉ'
              : busy && !address.enabled
                ? 'Đang tạo địa chỉ…'
                : !address.enabled ? 'Đang tắt' : address.state === 'starting' ? 'Đang tạo địa chỉ…' : 'Chưa có địa chỉ'}
          </span>
        )}
        {address?.enabled && url && address.kind === 'temporary' && (
          <p className="text-[11px] text-warning">Địa chỉ tạm, đổi mỗi lần khởi động lại</p>
        )}
        {address?.state === 'error' && address.error && <p className="text-[11px] text-destructive">{address.error}</p>}
      </div>
      <div role="cell">
        <Badge size="sm" dot variant={status.variant}>{status.label}</Badge>
      </div>
      <div role="cell" className="md:flex md:justify-end">
        <Switch
          checked={!!address?.enabled}
          disabled={busy || locked || !address}
          onCheckedChange={onToggle}
          aria-label={`${address?.enabled ? 'Tắt' : 'Bật'} địa chỉ ${meta.name}`}
        />
      </div>
    </div>
  );
}
