/**
 * Settings → Internet & Cloud → Internet address: configures the tunnel provider of "Nhân viên và API" (Employees and API) (relay, port 9900)
 * for the two ways of creating an address, ngrok and Cloudflare manual (previously under Settings → Employees → Connection).
 *  - Read / save through the existing IPC relay:getTunnelConfig / relay:setTunnelConfig: the token is stored encrypted in main, the renderer only knows
 *    "đã lưu" (saved) (the input shows "Đã lưu … (dán để thay)" (Saved … (paste to replace)), it never shows the token).
 *  - Saved when the field loses focus; before turning the relay on / clicking "Áp dụng" (Apply), the half-typed field is saved too (flush).
 *  - The running relay tunnel with a changed config / address mode → AddressSection shows "Áp dụng" (Apply) (relay:restartTunnel,
 *    make-before-break). The running provider is read from relay:getTunnelStatus + 'relay:tunnelStatusUpdate'.
 * Payments and workflow webhooks do not use these providers: in every mode other than Cloudflare automatic they use a separate Cloudflare
 * Quick Tunnel (temporary address).
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { FormField, Input } from '@/components/ui';
import type { TunnelMode } from '../../../../../shared/cloud/cloudContracts';
import { tunnelAddressKind, type TunnelProviderId } from '../../../../../shared/cloud/tunnelAddress';
import { cleanIpcError, Notice, SERVICE_META } from '../cloudUi';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export type LegacyTunnelMode = Exclude<TunnelMode, 'cloudflare_auto'>;
export type RelayProviderMode = Extract<TunnelMode, 'ngrok' | 'cloudflare_manual'>;

/** The relay's tunnel provider (relay_tunnel_provider) for the address creation mode. */
export const RELAY_PROVIDER: Record<LegacyTunnelMode, TunnelProviderId> = {
  quick: 'cloudflare',
  ngrok: 'ngrok',
  cloudflare_manual: 'cloudflare_named',
};

/** Saved relay config: no token, only knows whether one is saved. */
export interface RelayTunnelConfig {
  ngrokTokenSet: boolean;
  domain: string;
  cfTokenSet: boolean;
  cfPublicUrl: string;
}

export const EMPTY_RELAY_CONFIG: RelayTunnelConfig = { ngrokTokenSet: false, domain: '', cfTokenSet: false, cfPublicUrl: '' };

type RelayConfigPatch = { authtoken?: string; domain?: string; cfToken?: string; cfPublicUrl?: string };
export type RelayDraftField = 'ngrokToken' | 'ngrokDomain' | 'cfToken' | 'cfPublicUrl';

/** Same as relay:setTunnelConfig saves it: an ngrok domain is only a hostname (https:// and the trailing "/" are removed). */
export function normalizeNgrokDomain(raw: string): string {
  return String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Same as relay:setTunnelConfig saves it: the public address without the trailing "/". */
export function normalizePublicUrl(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/** Config error for the address creation mode (null = enough to turn on Employees and API): the same check as the old Employees screen. */
export function relayConfigProblem(
  mode: TunnelMode,
  saved: RelayTunnelConfig,
  draft: { ngrokToken: string; cfToken: string; cfPublicUrl: string },
): string | null {
  if (mode === 'cloudflare_manual') {
    if (!saved.cfTokenSet && !draft.cfToken.trim()) return tr('Dán Cloudflare Tunnel token.');
    if (!/^https:\/\/[^/\s]+\/?$/i.test(draft.cfPublicUrl.trim())) return tr('Nhập địa chỉ công khai dạng https://ten-mien-cua-ban.');
  }
  if (mode === 'ngrok' && !saved.ngrokTokenSet && !draft.ngrokToken.trim()) return tr('Dán ngrok authtoken.');
  return null;
}

export interface RelayProviderConfig {
  saved: RelayTunnelConfig;
  ngrokToken: string;
  ngrokDomain: string;
  cfToken: string;
  cfPublicUrl: string;
  /** Typing in a field (running relay tunnel → mark as needing "Áp dụng" (Apply)). */
  edit: (field: RelayDraftField, value: string) => void;
  /** Leaving a field: save if it differs from the saved value (token: only when something was pasted). */
  commit: (field: RelayDraftField) => void;
  problem: (mode: TunnelMode) => string | null;
  /** Save the half-typed fields of the address creation mode; false on a save error (the user has been told). */
  flush: (mode: TunnelMode) => Promise<boolean>;
  /** Config changed while the relay tunnel is running (not applied yet). */
  dirty: boolean;
  markDirty: () => void;
  clearDirty: () => void;
  /** Provider of the running relay tunnel (null when off / not read yet). */
  runningProvider: TunnelProviderId | null;
}

/**
 * Relay tunnel config status for the Internet address page. active = in a mode other than Cloudflare automatic (reads the
 * config + listens for relay status); relayOn = the old-style relay tunnel is on.
 */
export function useRelayProviderConfig({ active, relayOn, initial, initialRunningProvider = null }: {
  active: boolean;
  relayOn: boolean;
  /** Config read earlier (test). */
  initial?: Partial<RelayTunnelConfig> | null;
  initialRunningProvider?: TunnelProviderId | null;
}): RelayProviderConfig {
  const notify = useAppStore(s => s.showNotification);
  const [saved, setSaved] = useState<RelayTunnelConfig>(() => ({ ...EMPTY_RELAY_CONFIG, ...(initial ?? {}) }));
  const [ngrokToken, setNgrokToken] = useState('');
  const [ngrokDomain, setNgrokDomain] = useState(() => initial?.domain ?? '');
  const [cfToken, setCfToken] = useState('');
  const [cfPublicUrl, setCfPublicUrl] = useState(() => initial?.cfPublicUrl ?? '');
  const [dirty, setDirty] = useState(false);
  const [runningProvider, setRunningProvider] = useState<TunnelProviderId | null>(initialRunningProvider);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    ipc.relay?.getTunnelConfig?.().then(res => {
      if (!alive || !res?.success) return;
      const next: RelayTunnelConfig = {
        ngrokTokenSet: !!res.ngrokTokenSet,
        domain: res.domain || '',
        cfTokenSet: !!res.cfTokenSet,
        cfPublicUrl: res.cfPublicUrl || '',
      };
      setSaved(next);
      setNgrokDomain(next.domain);
      setCfPublicUrl(next.cfPublicUrl);
    }).catch(() => { /* old build / main not ready yet */ });
    return () => { alive = false; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = (s: { state?: string; provider?: TunnelProviderId | null } | null | undefined) => {
      if (alive) setRunningProvider(s?.state && s.state !== 'stopped' && s.provider ? s.provider : null);
    };
    ipc.relay?.getTunnelStatus?.().then(res => { if (res?.success) read(res); }).catch(() => { /* old build */ });
    const off = ipc.on?.('relay:tunnelStatusUpdate', read);
    return () => {
      alive = false;
      off?.();
    };
  }, [active]);

  // Relay tunnel off → nothing left to "Áp dụng" (Apply)
  useEffect(() => {
    if (!relayOn) setDirty(false);
  }, [relayOn]);

  const save = useCallback(async (cfg: RelayConfigPatch): Promise<boolean> => {
    try {
      const res = await ipc.relay?.setTunnelConfig?.(cfg);
      if (!res) {
        notify(tr('Bản app này chưa lưu được cấu hình tunnel. Hãy cập nhật Deplao.'), 'warning');
        return false;
      }
      if (!res.success) {
        notify(res.error || tr('Không lưu được cấu hình tunnel'), 'error');
        return false;
      }
      setSaved(prev => ({
        ngrokTokenSet: prev.ngrokTokenSet || !!cfg.authtoken?.trim(),
        domain: cfg.domain !== undefined ? normalizeNgrokDomain(cfg.domain) : prev.domain,
        cfTokenSet: prev.cfTokenSet || !!cfg.cfToken?.trim(),
        cfPublicUrl: cfg.cfPublicUrl !== undefined ? normalizePublicUrl(cfg.cfPublicUrl) : prev.cfPublicUrl,
      }));
      // Token is stored encrypted in main: not kept in the input field
      if (cfg.authtoken) setNgrokToken('');
      if (cfg.cfToken) setCfToken('');
      return true;
    } catch (err) {
      notify(cleanIpcError(err), 'error');
      return false;
    }
  }, [notify]);

  const markDirty = useCallback(() => {
    if (relayOn) setDirty(true);
  }, [relayOn]);

  const edit = (field: RelayDraftField, value: string) => {
    if (field === 'ngrokToken') setNgrokToken(value);
    else if (field === 'ngrokDomain') setNgrokDomain(value);
    else if (field === 'cfToken') setCfToken(value);
    else setCfPublicUrl(value);
    markDirty();
  };

  const commit = (field: RelayDraftField) => {
    if (field === 'ngrokToken') {
      if (ngrokToken.trim()) void save({ authtoken: ngrokToken });
    } else if (field === 'cfToken') {
      if (cfToken.trim()) void save({ cfToken });
    } else if (field === 'ngrokDomain') {
      const domain = normalizeNgrokDomain(ngrokDomain);
      setNgrokDomain(domain);
      if (domain !== saved.domain) void save({ domain });
    } else {
      const url = normalizePublicUrl(cfPublicUrl);
      setCfPublicUrl(url);
      if (url !== saved.cfPublicUrl) void save({ cfPublicUrl: url });
    }
  };

  const flush = async (mode: TunnelMode): Promise<boolean> => {
    const cfg: RelayConfigPatch = {};
    if (mode === 'ngrok') {
      if (ngrokToken.trim()) cfg.authtoken = ngrokToken;
      const domain = normalizeNgrokDomain(ngrokDomain);
      if (domain !== saved.domain) cfg.domain = domain;
    } else if (mode === 'cloudflare_manual') {
      if (cfToken.trim()) cfg.cfToken = cfToken;
      const url = normalizePublicUrl(cfPublicUrl);
      if (url !== saved.cfPublicUrl) cfg.cfPublicUrl = url;
    }
    if (!Object.keys(cfg).length) return true;
    return save(cfg);
  };

  return {
    saved,
    ngrokToken,
    ngrokDomain,
    cfToken,
    cfPublicUrl,
    edit,
    commit,
    problem: mode => relayConfigProblem(mode, saved, { ngrokToken, cfToken, cfPublicUrl }),
    flush,
    dirty,
    markDirty,
    clearDirty: () => setDirty(false),
    runningProvider,
  };
}

const CODE = 'rounded bg-muted px-1 font-mono text-[11px] text-foreground';

/** ngrok / manual Cloudflare form + guide, under the address creation mode buttons. */
export function RelayProviderForm({ mode, config }: { mode: RelayProviderMode; config: RelayProviderConfig }) {
  const secretId = useId();
  const valueId = useId();
  const [relayPort, setRelayPort] = useState<number>(SERVICE_META.relay.port);
  useEffect(() => {
    if (mode !== 'cloudflare_manual') return;
    let alive = true;
    ipc.relay?.getServerStatus?.().then(res => {
      if (alive && res?.success && res.port) setRelayPort(res.port);
    }).catch(() => { /* keep the default port */ });
    return () => { alive = false; };
  }, [mode]);

  const problem = config.problem(mode);
  const ngrok = mode === 'ngrok';
  const temporaryNgrok = ngrok && tunnelAddressKind('ngrok', { domain: config.ngrokDomain }) === 'temporary';

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{ngrok ? 'ngrok' : tr('Cloudflare thủ công')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {ngrok
            ? tr('Dùng tài khoản ngrok của bạn (gói miễn phí có một domain tĩnh, dạng ten-ban.ngrok-free.app) cho Nhân viên và API.')
            : tr('Bạn tự tạo tunnel trong Cloudflare Zero Trust rồi dán token, dành cho người đã tự cấu hình tunnel. Dùng cho Nhân viên và API.')}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          label={ngrok ? tr('Authtoken') : tr('Tunnel token')}
          htmlFor={secretId}
          hint={(ngrok ? config.saved.ngrokTokenSet : config.saved.cfTokenSet) ? tr('Đã lưu mã hoá trên máy này. Chỉ dán khi muốn thay.') : undefined}
        >
          <Input
            id={secretId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ngrok ? config.ngrokToken : config.cfToken}
            placeholder={ngrok
              ? (config.saved.ngrokTokenSet ? tr('Đã lưu authtoken (dán để thay)') : tr('ngrok authtoken'))
              : (config.saved.cfTokenSet ? tr('Đã lưu token (dán để thay)') : tr('Cloudflare Tunnel token'))}
            onChange={e => config.edit(ngrok ? 'ngrokToken' : 'cfToken', e.target.value)}
            onBlur={() => config.commit(ngrok ? 'ngrokToken' : 'cfToken')}
          />
        </FormField>
        <FormField label={ngrok ? tr('Domain tĩnh') : tr('Địa chỉ công khai')} htmlFor={valueId}>
          <Input
            id={valueId}
            autoComplete="off"
            spellCheck={false}
            value={ngrok ? config.ngrokDomain : config.cfPublicUrl}
            placeholder={ngrok ? 'ten-ban.ngrok-free.app' : 'https://nhanvien.ten-mien.vn'}
            onChange={e => config.edit(ngrok ? 'ngrokDomain' : 'cfPublicUrl', e.target.value)}
            onBlur={() => config.commit(ngrok ? 'ngrokDomain' : 'cfPublicUrl')}
          />
        </FormField>
      </div>

      {ngrok ? (
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>{tr('Đăng ký tại dashboard.ngrok.com → Your Authtoken → sao chép rồi dán vào ô Authtoken.')}</li>
          <li>{tr('Mục Domains → lấy domain tĩnh miễn phí rồi dán vào ô Domain tĩnh.')}</li>
          <li>{tr('Bật Nhân viên và API ở bảng bên dưới (đang chạy thì bấm Áp dụng).')}</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>{tr('Vào one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel (Cloudflared), đặt tên.')}</li>
          <li>{trx('Ở bước cài connector, sao chép token (chuỗi dài sau <0>--token</0>) rồi dán vào ô Tunnel token.', { 0: <code className={CODE} /> })}</li>
          <li>
            {trx('Thêm Public Hostname: tên miền con + tên miền của bạn, Service <0>HTTP</0> → <1>localhost:{{relayPort}}</1>.', { 0: <code className={CODE} />, 1: <code className={CODE} />, relayPort })}
          </li>
          <li>{trx('Nhập địa chỉ công khai <0>https://…</0> rồi bật Nhân viên và API ở bảng bên dưới (đang chạy thì bấm Áp dụng).', { 0: <code className={CODE} /> })}</li>
        </ol>
      )}

      {temporaryNgrok && <p className="text-xs text-warning">{tr('Chưa nhập domain tĩnh: địa chỉ có thể đổi khi khởi động lại.')}</p>}
      {problem && <p role="alert" className="text-xs text-warning">{problem}</p>}

      <Notice tone="info">
        <p>
          {trx('Chỉ Nhân viên và API dùng {{v1}}. Thanh toán, tích hợp và Webhook workflow vẫn dùng Địa chỉ tạm (Cloudflare Quick Tunnel), đổi mỗi lần bật lại. Muốn cả ba có địa chỉ cố định, chọn Cloudflare tự động.', { v1: ngrok ? 'ngrok' : tr('tunnel Cloudflare thủ công') })}
        </p>
      </Notice>
    </div>
  );
}
