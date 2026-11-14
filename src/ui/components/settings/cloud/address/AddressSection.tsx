/**
 * Settings → Internet & Cloud → Internet address: the ONLY place to configure and turn the Internet address on / off (other screens only
 * show the address and link back here).
 *  - "Cách tạo địa chỉ" (How to create an address): Temporary address · Cloudflare automatic · ngrok · Cloudflare manual (tunnel.setMode - any mode other
 *    than Cloudflare automatic also saves the relay's tunnel provider).
 *  - Cloudflare automatic: pick a domain + "Tên máy" (Machine name), preview as you type, "Áp dụng" (Apply) → tunnel.configureAuto.
 *    One address by default for all services (split by path); "Tách tên riêng cho từng dịch vụ" (Separate name per service) under Advanced.
 *  - ngrok / Cloudflare manual: token + domain / public address form + guide (RelayProviderForm, saved via
 *    relay:getTunnelConfig / setTunnelConfig). If the relay tunnel is running and the config changes → "Áp dụng" (Apply) (relay:restartTunnel,
 *    does not disconnect employees).
 *  - Table of three services (9900 / 9888 / 9889): address + type (Fixed / Temporary address) + copy, status, a separate switch
 *    (tunnel.setServiceEnabled - every mode; in modes other than Cloudflare automatic it turns the old per-port tunnel on / off in main).
 *  - "Tự bật khi mở app" (Start when the app opens) for every mode (tunnel.setAutoStart).
 *  - Tunnel status (tunnel.health - called on open and when "Kiểm tra lại" (Recheck) is clicked, not on a timer because it calls Cloudflare).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { CopyIcon, ExternalLinkIcon, RefreshIcon } from '@/components/common/icons';
import { Badge, Button, Card, FormField, Input, Select, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import { copyWithToast } from '../../employees/RelayAddressNotice';
import { publishPublicAddresses } from '../../../common/cloud/PublicAddressCard';
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
} from '../../../../../shared/cloud/cloudContracts';
import type { TunnelProviderId } from '../../../../../shared/cloud/tunnelAddress';
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
} from '../cloudUi';
import {
  RELAY_PROVIDER,
  RelayProviderForm,
  useRelayProviderConfig,
  type LegacyTunnelMode,
  type RelayTunnelConfig,
} from './RelayProviderForm';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface AddressSectionProps {
  connection: CloudConnectionStatus | null;
  config: TunnelConfigView | null;
  addresses: PublicAddress[];
  /** New result from main (configureAuto / setMode / setServiceEnabled / moveHere). */
  onTunnelChange?: (patch: { config?: TunnelConfigView; addresses?: PublicAddress[] }) => void;
  /** Re-read the config + address. */
  onRefresh?: () => void;
  /** Take the user to the Connect Cloudflare card. */
  onConnect?: () => void;
  /** Recheck the token (after adding a domain / permission). */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Tunnel status read earlier (test). */
  initialHealth?: TunnelHealth | null;
  /** Relay tunnel config + the running provider, read earlier (test). */
  initialRelay?: { config?: Partial<RelayTunnelConfig> | null; runningProvider?: TunnelProviderId | null } | null;
}

const MODE_ORDER: TunnelMode[] = ['quick', 'cloudflare_auto', 'ngrok', 'cloudflare_manual'];

/** "Tự bật khi mở app" (Start when the app opens) in a mode other than Cloudflare automatic = the relay's relay_tunnel_autostart (as before). */
const LEGACY_AUTOSTART_HINT =
  tr('Chỉ áp dụng cho Nhân viên và API: tunnel bật lại khi máy chủ nhân viên (LAN) tự chạy lúc mở app (bật "Tự bật khi mở app" ở Cài đặt → Nhân viên → Kết nối). Thanh toán, tích hợp và Webhook workflow không tự bật, bật lại ở bảng trên khi cần.', {  });

const CF_STATUS: Record<string, { label: string; dot: string }> = {
  healthy: { label: tr('Healthy'), dot: 'bg-success' },
  degraded: { label: tr('Degraded'), dot: 'bg-warning' },
  down: { label: tr('Down'), dot: 'bg-destructive' },
  inactive: { label: tr('Inactive'), dot: 'bg-accent' },
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

  // "Cloudflare tự động" (Cloudflare automatic) when never configured: only open the form (the old way keeps running until Apply finishes).
  const [draftMode, setDraftMode] = useState<TunnelMode | null>(null);
  const shownMode = draftMode ?? mode;

  // Form draft; reset to the saved config whenever the config changes.
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

  // ── Tunnel status ──
  const [health, setHealth] = useState<TunnelHealth | null>(initialHealth);
  const [healthBusy, setHealthBusy] = useState(false);
  const autoConfigured = mode === 'cloudflare_auto' && !!auto;
  const checkHealth = useCallback(async (quiet = false) => {
    const api = cloudApi();
    if (!api) return;
    setHealthBusy(true);
    try {
      // Click "Kiểm tra lại" (Recheck) → re-read from Cloudflare's side; checks automatically when the page opens, using the cached copy.
      const res = await api.tunnel.health(quiet ? undefined : { refresh: true });
      if (res?.success && res.health) setHealth(res.health);
      else if (!quiet) notify(res?.error || tr('Không kiểm tra được tunnel'), 'error');
    } catch (err) {
      if (!quiet) notify(cleanIpcError(err), 'error');
    } finally {
      setHealthBusy(false);
    }
  }, [notify]);
  useEffect(() => {
    if (autoConfigured) void checkHealth(true);
  }, [autoConfigured, checkHealth]);

  // ── Temporary address / ngrok / Cloudflare manual: the old per-port tunnel + the relay's tunnel config ──
  const legacyMode = mode !== 'cloudflare_auto';
  const relayOn = legacyMode && !!addresses.find(a => a.service === 'relay')?.enabled;
  const relayCfg = useRelayProviderConfig({
    active: legacyMode,
    relayOn,
    initial: initialRelay?.config,
    initialRunningProvider: initialRelay?.runningProvider ?? null,
  });
  const relayProblem = legacyMode ? relayCfg.problem(mode) : null;
  // The running relay tunnel uses the old way / config → "Áp dụng" (Apply) (the new tunnel comes up first, employees are not disconnected)
  const providerChanged = relayOn && !!relayCfg.runningProvider && relayCfg.runningProvider !== RELAY_PROVIDER[mode as LegacyTunnelMode];
  const needsApply = relayOn && !draftMode && (relayCfg.dirty || providerChanged);

  // Old-style tunnel changed (it restarts by itself with a new temporary address, on / off) → re-read the address right away instead of waiting for the 15 s cycle
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

  // ── Apply the Cloudflare automatic config ──
  const apply = async (override?: Partial<TunnelAutoConfig>): Promise<boolean> => {
    const input: TunnelAutoConfig | null = zone
      ? { zoneId: zone.id, zoneName: zone.name, hostPrefix: prefix, layout, ...override }
      : null;
    const err = !input ? tr('Chọn tên miền.') : hostPrefixError(input.hostPrefix);
    if (err || !input) { setFormError(err); return false; }
    setFormError(null);
    const inUse = !!auto && addresses.some(a => a.enabled && !!a.url);
    const changesHost = !!auto && (auto.zoneId !== input.zoneId || auto.hostPrefix !== input.hostPrefix || auto.layout !== input.layout);
    if (inUse && changesHost) {
      const ok = await showConfirm({
        title: tr('Đổi địa chỉ Internet?'),
        message: tr('Địa chỉ cũ sẽ ngừng hoạt động. Nhớ cập nhật địa chỉ mới ở Casso, SePay, website và gửi cho nhân viên làm việc từ xa.'),
        confirmText: tr('Đổi địa chỉ'),
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
    notify(auto ? tr('Đã cập nhật địa chỉ cố định') : tr('Đã tạo địa chỉ cố định'), 'success');
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

  // ── Change how the address is created ──
  const chooseMode = async (next: TunnelMode) => {
    if (next === mode) { setDraftMode(null); return; }
    if (next === shownMode) return;
    if (next === 'cloudflare_auto' && !auto) { setDraftMode('cloudflare_auto'); return; }
    if (mode === 'cloudflare_auto' && auto) {
      const ok = await showConfirm({
        title: tr('Chuyển sang {{v1}}?', { v1: MODE_LABEL[next] }),
        message: tr('Địa chỉ cố định ngừng dùng trên máy này (tunnel và tên miền vẫn giữ trên Cloudflare, chuyển lại được). Nhân viên ở xa và đối tác phải dùng địa chỉ mới.'),
        confirmText: tr('Chuyển'),
        variant: 'warning',
      });
      if (!ok) return;
    }
    const res = await run('mode', () => cloudApi()?.tunnel.setMode(next));
    if (!res) return;
    setDraftMode(null);
    if (res.config) applyTunnel({ config: res.config });
    // The relay tunnel keeps running the old way until "Áp dụng" (Apply) is clicked (as before under Settings → Employees). Knowing the running
    // provider: compare directly (providerChanged); if unknown, mark it so the "Áp dụng" (Apply) button still shows.
    if (next !== 'cloudflare_auto' && !relayCfg.runningProvider) relayCfg.markDirty();
    onRefresh?.();
  };

  // ── Services ──
  const toggleService = async (service: TunnelServiceId, enabled: boolean) => {
    if (!enabled) {
      const ok = await showConfirm({
        title: tr('Tắt địa chỉ {{name}}?', { name: SERVICE_META[service].name }),
        message: SERVICE_META[service].offWarning,
        confirmText: tr('Tắt'),
        variant: 'warning',
      });
      if (!ok) return;
    }
    if (enabled && service === 'relay' && legacyMode) {
      // ngrok / manual: turn on only once the config is complete; save the half-typed field too so the relay uses the right config
      if (relayProblem) { notify(relayProblem, 'warning'); return; }
      if (!(await relayCfg.flush(mode))) return;
    }
    const res = await run(`svc:${service}`, () => cloudApi()?.tunnel.setServiceEnabled(service, enabled));
    if (res?.addresses) applyTunnel({ addresses: res.addresses });
    else if (res) onRefresh?.();
    if (res && service === 'relay') relayCfg.clearDirty();
  };

  // ── Apply the new config to the running relay tunnel (make-before-break) ──
  const applyRelay = async () => {
    if (relayProblem) { notify(relayProblem, 'warning'); return; }
    const res = await run('relay-apply', async () => {
      if (!(await relayCfg.flush(mode))) return { success: false, error: tr('Chưa lưu được cấu hình tunnel, tunnel cũ vẫn chạy') };
      const out = await ipc.relay?.restartTunnel?.();
      if (!out || out.success) return out;
      return { ...out, error: tr('{{v1}} — tunnel cũ vẫn chạy', { v1: out.error || tr('Không chuyển được tunnel') }) };
    }, tr('Đã áp dụng. Nhân viên đang kết nối được báo địa chỉ mới tự động.'));
    if (res) relayCfg.clearDirty();
    onRefresh?.();
  };

  const setAutoStart = async (on: boolean) => {
    const okMessage = on
      ? (legacyMode ? tr('Tunnel của Nhân viên và API sẽ tự bật khi mở app') : tr('Tunnel sẽ tự bật khi mở app'))
      : tr('Đã tắt tự bật khi mở app');
    const res = await run('autostart', () => cloudApi()?.tunnel.setAutoStart(on), okMessage);
    if (res) onRefresh?.();
  };

  // ── Advanced ──
  const moveHere = async () => {
    const ok = await showConfirm({
      title: tr('Chuyển địa chỉ sang máy này?'),
      message: tr('Deplao tạo tunnel mới trên máy này và trỏ tên miền về đây. Máy đang giữ địa chỉ sẽ ngừng nhận nhân viên, API và webhook.'),
      confirmText: tr('Chuyển sang máy này'),
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('move', () => cloudApi()?.tunnel.moveHere(), tr('Đã chuyển địa chỉ sang máy này'));
    if (!res) return;
    if (res.addresses) applyTunnel({ addresses: res.addresses });
    void checkHealth(true);
    onRefresh?.();
  };

  const disconnectForeign = async () => {
    const ok = await showConfirm({
      title: tr('Ngắt máy lạ?'),
      message: tr('Máy khác đang chạy cùng tunnel sẽ mất kết nối tới địa chỉ này. Nếu không rõ máy đó của ai, nên đổi token Cloudflare.'),
      confirmText: tr('Ngắt máy lạ'),
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('foreign', () => cloudApi()?.tunnel.disconnectForeign(), tr('Đã ngắt máy lạ'));
    if (res) void checkHealth(true);
  };

  const teardown = async () => {
    const ok = await showConfirm({
      title: tr('Gỡ tunnel và địa chỉ?'),
      message: tr('Xoá tunnel và tên miền con Deplao đã tạo trên Cloudflare. Nhân viên ở xa và đối tác sẽ không vào được cho tới khi tạo lại. Dữ liệu trong app không bị ảnh hưởng.'),
      confirmText: tr('Gỡ tunnel'),
      variant: 'danger',
    });
    if (!ok) return;
    const res = await run('teardown', () => cloudApi()?.tunnel.teardown(), tr('Đã gỡ tunnel và địa chỉ'));
    if (!res) return;
    setHealth(null);
    onRefresh?.();
  };

  const byService = (service: TunnelServiceId) => addresses.find(a => a.service === service) ?? null;
  const restarting = addresses.some(a => a.enabled && a.state === 'restarting');
  const failed = addresses.find(a => a.enabled && a.state === 'error');
  const foreign = health?.foreignConnectors ?? 0;
  const showTable = !draftMode && addresses.length > 0;
  // Turning on an old-style address can take tens of seconds (download / run cloudflared): lock the other switches until it is done
  const serviceBusy = !!busy && busy.startsWith('svc:');
  const showAutoStart = !draftMode && !!config && (legacyMode || !!auto);

  const modeOptions = MODE_ORDER.map(value => ({
    value,
    label: MODE_LABEL[value],
    disabled: value === 'cloudflare_auto' && !connected && mode !== 'cloudflare_auto',
    title: value === 'cloudflare_auto' && !connected ? tr('Kết nối Cloudflare trước') : undefined,
  }));

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">{tr('Cách tạo địa chỉ')}</p>
        <PillGroup label={tr('Cách tạo địa chỉ')} value={shownMode} options={modeOptions} onChange={m => void chooseMode(m)} disabled={busy === 'mode'} />
      </div>

      {shownMode === 'quick' && (
        <Notice tone="info" title={tr('Địa chỉ tạm')}>
          <p>
            {tr('Cloudflare Quick Tunnel, không cần tài khoản. Địa chỉ đổi mỗi lần khởi động lại; phải gửi lại cho nhân viên và đối tác. Chỉ nên dùng thử.')}
          </p>
          <p className="text-muted-foreground">
            {connected
              ? tr('Đã kết nối Cloudflare: chọn Cloudflare tự động để có địa chỉ cố định trên tên miền của bạn.')
              : tr('Có tên miền trên Cloudflare? Kết nối Cloudflare ở đầu trang để có địa chỉ cố định.')}
          </p>
        </Notice>
      )}

      {(shownMode === 'ngrok' || shownMode === 'cloudflare_manual') && (
        <RelayProviderForm mode={shownMode} config={relayCfg} />
      )}

      {needsApply && (
        <Notice
          tone="warning"
          title={tr('Nhân viên và API chưa dùng cấu hình mới')}
          action={(
            <Button size="sm" loading={busy === 'relay-apply'} disabled={!!relayProblem} onClick={() => void applyRelay()}>
              {tr('Áp dụng')}
            </Button>
          )}
        >
          <p>
            {tr('Tunnel của Nhân viên và API vẫn chạy theo cấu hình cũ. Bấm Áp dụng: tunnel mới bật trước, nhân viên đang kết nối được báo địa chỉ mới rồi tunnel cũ mới tắt.')}
          </p>
          {relayProblem && <p className="text-warning">{relayProblem}</p>}
        </Notice>
      )}

      {shownMode === 'cloudflare_auto' && (
        <Card className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold text-foreground">{tr('Cloudflare tự động')} <Badge size="sm" variant="primary" className="ml-1 align-middle">{tr('Khuyên dùng')}</Badge></p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {tr('Deplao tự tạo tunnel và tên miền con trên Cloudflare của bạn. Địa chỉ không đổi khi khởi động lại; nhân viên và đối tác chỉ cần cài một lần.')}
            </p>
          </div>

          {!connected ? (
            <Notice
              tone="info"
              title={tr('Cần kết nối Cloudflare')}
              action={onConnect && <Button size="sm" onClick={onConnect}>{tr('Kết nối Cloudflare')}</Button>}
            >
              <p>{tr('Kết nối tài khoản Cloudflare có tên miền để tạo địa chỉ cố định.')}</p>
            </Notice>
          ) : (
            <>
              {tunnelPerm && !tunnelPerm.ok && (
                <Notice tone="warning" title={tr('Token thiếu quyền tạo địa chỉ')}>
                  <p>
                    {tunnelPerm.missing?.length ? `${tunnelPerm.missing.join(' · ')}. ` : tr('Cần quyền Cloudflare Tunnel, DNS và Zone. ')}
                    {tr('Tạo token mới đủ quyền rồi bấm Quản lý → Đổi token.')}
                  </p>
                </Notice>
              )}
              {zones.length === 0 && (
                <Notice
                  tone="warning"
                  title={tr('Tài khoản chưa có tên miền trên Cloudflare')}
                  action={(
                    <>
                      <Button size="sm" variant="outline" rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />} onClick={() => openExternalUrl('https://dash.cloudflare.com/')}>
                        {tr('Mở Cloudflare')}
                      </Button>
                      {onRecheck && (
                        <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
                          {tr('Kiểm tra lại')}
                        </Button>
                      )}
                    </>
                  )}
                >
                  <p>{tr('Thêm tên miền vào Cloudflare (gói Free là đủ) và đổi nameserver theo hướng dẫn của Cloudflare, rồi bấm Kiểm tra lại.')}</p>
                </Notice>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <FormField label={tr('Tên miền')} htmlFor={zoneFieldId} className="w-56">
                  <Select id={zoneFieldId} value={zoneId} disabled={zones.length === 0 && !auto} onChange={e => { setZoneId(e.target.value); setFormError(null); }}>
                    {zones.length === 0 && !zone && <option value="">{tr('Chưa có tên miền')}</option>}
                    {zone && !zones.some(z => z.id === zone.id) && <option value={zone.id}>{zone.name}</option>}
                    {zones.map(z => (
                      <option key={z.id} value={z.id}>{z.name}{z.status && z.status !== 'active' ? ` (${z.status})` : ''}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label={tr('Tên máy')} htmlFor={prefixFieldId} className="w-40">
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
                      : <>{trx('→ <0>{{relay}}</0> cho mọi dịch vụ', { 0: <span className="font-mono text-foreground" />, relay: hosts.relay })}</>
                    : tr('Nhập tên máy để xem trước địa chỉ')}
                </p>
              </div>
              {formError && <p role="alert" className="text-xs text-destructive">{formError}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void apply()}
                  loading={busy === 'apply'}
                  disabled={!dirty || !zone || (!!tunnelPerm && !tunnelPerm.ok)}
                >
                  {tr('Áp dụng')}
                </Button>
                {draftMode && <Button variant="ghost" onClick={() => setDraftMode(null)}>{tr('Huỷ')}</Button>}
                {auto && dirty && <span className="text-xs text-warning">{tr('Chưa áp dụng thay đổi')}</span>}
                {!auto && <span className="text-xs text-muted-foreground">{tr('Cách đang dùng vẫn chạy cho tới khi tạo xong địa chỉ.')}</span>}
              </div>
            </>
          )}
        </Card>
      )}

      {showTable && (restarting || failed || foreign > 0) && (
        <div className="space-y-2">
          {restarting && <Notice tone="warning"><p>{tr('Tunnel mất kết nối, đang tự chạy lại.')}</p></Notice>}
          {failed && <Notice tone="destructive"><p>{failed.error || tr('Địa chỉ {{name}} đang lỗi.', { name: SERVICE_META[failed.service].name })}</p></Notice>}
          {foreign > 0 && (
            <Notice
              tone="warning"
              action={<Button size="sm" variant="outline" loading={busy === 'foreign'} onClick={() => void disconnectForeign()}>{tr('Ngắt máy lạ')}</Button>}
            >
              <p>{trx('Có {{foreign}} máy khác đang chạy cùng tunnel này, request có thể đi nhầm máy.', { foreign })}</p>
            </Notice>
          )}
        </div>
      )}

      {showTable && (
        <Card className="overflow-hidden">
          <div role="table" aria-label={tr('Địa chỉ của từng dịch vụ')} className="text-sm">
            <div role="row" className="hidden grid-cols-[170px_minmax(0,1fr)_120px_48px] gap-3 border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground md:grid">
              <span role="columnheader">{tr('Dịch vụ')}</span>
              <span role="columnheader">{tr('Địa chỉ')}</span>
              <span role="columnheader">{tr('Trạng thái')}</span>
              <span role="columnheader" className="text-right">{tr('Bật')}</span>
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
                {trx('Tunnel {{v1}} · {{label}} · {{connections}} kết nối · {{v2}}', { v1: health.tunnelName || '—', label: (CF_STATUS[health.cfStatus ?? ''] ?? { label: health.cfStatus || tr('Chưa rõ') }).label, connections: health.connections, v2: config?.autoStart ? tr('tự bật khi mở app') : tr('không tự bật khi mở app') })}
                {!health.localReady && <span className="text-warning"> {tr('· cloudflared trên máy chưa sẵn sàng')}</span>}
              </span>
            </p>
          ) : (
            <p>{tr('Chưa kiểm tra tình trạng tunnel.')}</p>
          )}
          <Button variant="link" size="sm" className="text-xs" loading={healthBusy} onClick={() => void checkHealth()}>
            {tr('Kiểm tra lại')}
          </Button>
        </div>
      )}

      {showAutoStart && (
        <Card className="px-4">
          <SettingRow
            title={tr('Tự bật khi mở app')}
            description={legacyMode ? LEGACY_AUTOSTART_HINT : tr('Tunnel chạy lại ngay khi mở Deplao, nhân viên và đối tác không phải chờ.')}
            control={(
              <Switch
                checked={!!config?.autoStart}
                disabled={busy === 'autostart'}
                onCheckedChange={next => void setAutoStart(next)}
                aria-label={tr('Tự bật tunnel khi mở app')}
              />
            )}
          />
        </Card>
      )}

      {shownMode === 'cloudflare_auto' && connected && (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/50">
            {trx('Nâng cao<0>tách tên riêng cho từng dịch vụ, chuyển sang máy này, gỡ tunnel, ngắt máy lạ</0>', { 0: <span className="ml-2 text-xs font-normal text-muted-foreground" /> })}
          </summary>
          <div className="divide-y divide-border border-t border-border px-4">
            <SettingRow
              title={tr('Tách tên riêng cho từng dịch vụ')}
              description={tr('Mỗi dịch vụ một tên ({{v1}}, {{v1}}-pay, {{v1}}-hook) thay vì một địa chỉ chia theo đường dẫn.', { v1: prefix || 'shop' })}
              control={(
                <Switch
                  checked={layout === 'split'}
                  disabled={busy === 'apply'}
                  onCheckedChange={next => void changeLayout(next ? 'split' : 'single')}
                  aria-label={tr('Tách tên riêng cho từng dịch vụ')}
                />
              )}
            />
            {auto && (
              <>
                <SettingRow
                  title={tr('Chuyển sang máy này')}
                  description={tr('Dùng khi đổi máy chủ: tạo tunnel mới trên máy này và trỏ tên miền về đây.')}
                  control={<Button size="sm" variant="outline" loading={busy === 'move'} onClick={() => void moveHere()}>{tr('Chuyển sang máy này')}</Button>}
                />
                {foreign > 0 && (
                  <SettingRow
                    title={tr('Ngắt máy lạ')}
                    description={tr('Có {{foreign}} máy khác đang chạy cùng tunnel này.', { foreign })}
                    control={<Button size="sm" variant="outline" loading={busy === 'foreign'} onClick={() => void disconnectForeign()}>{tr('Ngắt máy lạ')}</Button>}
                  />
                )}
                <SettingRow
                  title={tr('Gỡ tunnel và địa chỉ')}
                  description={tr('Xoá tunnel và tên miền con Deplao đã tạo trên Cloudflare.')}
                  control={<Button size="sm" variant="destructive" loading={busy === 'teardown'} onClick={() => void teardown()}>{tr('Gỡ tunnel và địa chỉ')}</Button>}
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
  /** Turning one other service on / off. */
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
        <p className="text-[11px] text-subtle-foreground">{trx('cổng {{port}}', { port: meta.port })}</p>
      </div>
      <div role="cell" className="min-w-0">
        {url && address?.enabled ? (
          <div className="flex min-w-0 items-center gap-1">
            {address.kind && (
              <Badge size="sm" variant={address.kind === 'fixed' ? 'success' : 'warning'} className="flex-shrink-0">
                {address.kind === 'fixed' ? tr('Cố định') : tr('Địa chỉ tạm')}
              </Badge>
            )}
            <code className="min-w-0 truncate font-mono text-xs text-foreground" title={`${url}${meta.suffix}`}>
              {url}<span className="text-subtle-foreground">{meta.suffix}</span>
            </code>
            <button
              type="button"
              onClick={() => copyWithToast(url, tr('Đã sao chép địa chỉ'))}
              title={meta.suffix ? tr('Sao chép địa chỉ gốc') : tr('Sao chép địa chỉ')}
              aria-label={tr('Sao chép địa chỉ {{name}}', { name: meta.name })}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CopyIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-subtle-foreground">
            {!address
              ? tr('Chưa có địa chỉ')
              : busy && !address.enabled
                ? tr('Đang tạo địa chỉ…')
                : !address.enabled ? tr('Đang tắt') : address.state === 'starting' ? tr('Đang tạo địa chỉ…') : tr('Chưa có địa chỉ')}
          </span>
        )}
        {address?.enabled && url && address.kind === 'temporary' && (
          <p className="text-[11px] text-warning">{tr('Địa chỉ tạm, đổi mỗi lần khởi động lại')}</p>
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
          aria-label={tr('{{v1}} địa chỉ {{name}}', { v1: address?.enabled ? tr('Tắt') : tr('Bật'), name: meta.name })}
        />
      </div>
    </div>
  );
}
