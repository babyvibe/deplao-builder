/**
 * Cài đặt → Internet & Đám mây → Địa chỉ Internet: cấu hình nhà cung cấp tunnel của "Nhân viên và API" (relay, cổng 9900)
 * cho hai cách tạo địa chỉ ngrok và Cloudflare thủ công (trước nằm ở Cài đặt → Nhân viên → Kết nối).
 *  - Đọc / lưu qua IPC có sẵn relay:getTunnelConfig / relay:setTunnelConfig: token lưu mã hoá ở main, renderer chỉ biết
 *    "đã lưu" (ô nhập hiện "Đã lưu … (dán để thay)", không bao giờ hiện token).
 *  - Lưu khi rời ô; trước khi bật relay / bấm "Áp dụng" thì lưu nốt ô đang gõ dở (flush).
 *  - Tunnel relay đang chạy mà đổi cấu hình / cách tạo địa chỉ → AddressSection hiện "Áp dụng" (relay:restartTunnel,
 *    make-before-break). Nhà cung cấp đang chạy đọc từ relay:getTunnelStatus + 'relay:tunnelStatusUpdate'.
 * Thanh toán và webhook workflow không dùng các nhà cung cấp này: ở mọi chế độ khác Cloudflare tự động chúng dùng Cloudflare
 * Quick Tunnel riêng (địa chỉ tạm).
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { FormField, Input } from '@/components/ui';
import type { TunnelMode } from '../../../../../shared/cloud/cloudContracts';
import { tunnelAddressKind, type TunnelProviderId } from '../../../../../shared/cloud/tunnelAddress';
import { cleanIpcError, Notice, SERVICE_META } from '../cloudUi';

export type LegacyTunnelMode = Exclude<TunnelMode, 'cloudflare_auto'>;
export type RelayProviderMode = Extract<TunnelMode, 'ngrok' | 'cloudflare_manual'>;

/** Nhà cung cấp tunnel của relay (relay_tunnel_provider) theo cách tạo địa chỉ. */
export const RELAY_PROVIDER: Record<LegacyTunnelMode, TunnelProviderId> = {
  quick: 'cloudflare',
  ngrok: 'ngrok',
  cloudflare_manual: 'cloudflare_named',
};

/** Cấu hình đã lưu của relay — không có token, chỉ biết đã lưu hay chưa. */
export interface RelayTunnelConfig {
  ngrokTokenSet: boolean;
  domain: string;
  cfTokenSet: boolean;
  cfPublicUrl: string;
}

export const EMPTY_RELAY_CONFIG: RelayTunnelConfig = { ngrokTokenSet: false, domain: '', cfTokenSet: false, cfPublicUrl: '' };

type RelayConfigPatch = { authtoken?: string; domain?: string; cfToken?: string; cfPublicUrl?: string };
export type RelayDraftField = 'ngrokToken' | 'ngrokDomain' | 'cfToken' | 'cfPublicUrl';

/** Như relay:setTunnelConfig lưu: domain ngrok chỉ là hostname (bỏ https:// và "/" cuối). */
export function normalizeNgrokDomain(raw: string): string {
  return String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Như relay:setTunnelConfig lưu: địa chỉ công khai bỏ "/" cuối. */
export function normalizePublicUrl(raw: string): string {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/** Lỗi cấu hình của cách tạo địa chỉ (null = đủ để bật Nhân viên và API) — cùng kiểm tra với màn Nhân viên trước đây. */
export function relayConfigProblem(
  mode: TunnelMode,
  saved: RelayTunnelConfig,
  draft: { ngrokToken: string; cfToken: string; cfPublicUrl: string },
): string | null {
  if (mode === 'cloudflare_manual') {
    if (!saved.cfTokenSet && !draft.cfToken.trim()) return 'Dán Cloudflare Tunnel token.';
    if (!/^https:\/\/[^/\s]+\/?$/i.test(draft.cfPublicUrl.trim())) return 'Nhập địa chỉ công khai dạng https://ten-mien-cua-ban.';
  }
  if (mode === 'ngrok' && !saved.ngrokTokenSet && !draft.ngrokToken.trim()) return 'Dán ngrok authtoken.';
  return null;
}

export interface RelayProviderConfig {
  saved: RelayTunnelConfig;
  ngrokToken: string;
  ngrokDomain: string;
  cfToken: string;
  cfPublicUrl: string;
  /** Gõ vào một ô (tunnel relay đang chạy → đánh dấu cần "Áp dụng"). */
  edit: (field: RelayDraftField, value: string) => void;
  /** Rời ô: lưu nếu khác bản đã lưu (token: chỉ khi có dán). */
  commit: (field: RelayDraftField) => void;
  problem: (mode: TunnelMode) => string | null;
  /** Lưu các ô đang gõ dở của cách tạo địa chỉ; false khi lưu lỗi (đã báo người dùng). */
  flush: (mode: TunnelMode) => Promise<boolean>;
  /** Đã đổi cấu hình khi tunnel relay đang chạy (chưa áp dụng). */
  dirty: boolean;
  markDirty: () => void;
  clearDirty: () => void;
  /** Nhà cung cấp của tunnel relay đang chạy (null khi tắt / chưa đọc được). */
  runningProvider: TunnelProviderId | null;
}

/**
 * Trạng thái cấu hình tunnel của relay cho trang Địa chỉ Internet. active = đang ở chế độ khác Cloudflare tự động (đọc
 * cấu hình + nghe trạng thái relay); relayOn = tunnel relay kiểu cũ đang bật.
 */
export function useRelayProviderConfig({ active, relayOn, initial, initialRunningProvider = null }: {
  active: boolean;
  relayOn: boolean;
  /** Cấu hình đã đọc trước (test). */
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
    }).catch(() => { /* bản cũ / main chưa sẵn sàng */ });
    return () => { alive = false; };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = (s: { state?: string; provider?: TunnelProviderId | null } | null | undefined) => {
      if (alive) setRunningProvider(s?.state && s.state !== 'stopped' && s.provider ? s.provider : null);
    };
    ipc.relay?.getTunnelStatus?.().then(res => { if (res?.success) read(res); }).catch(() => { /* bản cũ */ });
    const off = ipc.on?.('relay:tunnelStatusUpdate', read);
    return () => {
      alive = false;
      off?.();
    };
  }, [active]);

  // Tắt tunnel relay → không còn gì để "Áp dụng"
  useEffect(() => {
    if (!relayOn) setDirty(false);
  }, [relayOn]);

  const save = useCallback(async (cfg: RelayConfigPatch): Promise<boolean> => {
    try {
      const res = await ipc.relay?.setTunnelConfig?.(cfg);
      if (!res) {
        notify('Bản app này chưa lưu được cấu hình tunnel. Hãy cập nhật Deplao.', 'warning');
        return false;
      }
      if (!res.success) {
        notify(res.error || 'Không lưu được cấu hình tunnel', 'error');
        return false;
      }
      setSaved(prev => ({
        ngrokTokenSet: prev.ngrokTokenSet || !!cfg.authtoken?.trim(),
        domain: cfg.domain !== undefined ? normalizeNgrokDomain(cfg.domain) : prev.domain,
        cfTokenSet: prev.cfTokenSet || !!cfg.cfToken?.trim(),
        cfPublicUrl: cfg.cfPublicUrl !== undefined ? normalizePublicUrl(cfg.cfPublicUrl) : prev.cfPublicUrl,
      }));
      // Token đã lưu mã hoá ở main — không giữ lại trong ô nhập
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

/** Form ngrok / Cloudflare thủ công + hướng dẫn, dưới nút chọn cách tạo địa chỉ. */
export function RelayProviderForm({ mode, config }: { mode: RelayProviderMode; config: RelayProviderConfig }) {
  const secretId = useId();
  const valueId = useId();
  const [relayPort, setRelayPort] = useState<number>(SERVICE_META.relay.port);
  useEffect(() => {
    if (mode !== 'cloudflare_manual') return;
    let alive = true;
    ipc.relay?.getServerStatus?.().then(res => {
      if (alive && res?.success && res.port) setRelayPort(res.port);
    }).catch(() => { /* giữ cổng mặc định */ });
    return () => { alive = false; };
  }, [mode]);

  const problem = config.problem(mode);
  const ngrok = mode === 'ngrok';
  const temporaryNgrok = ngrok && tunnelAddressKind('ngrok', { domain: config.ngrokDomain }) === 'temporary';

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{ngrok ? 'ngrok' : 'Cloudflare thủ công'}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {ngrok
            ? 'Dùng tài khoản ngrok của bạn (gói miễn phí có một domain tĩnh, dạng ten-ban.ngrok-free.app) cho Nhân viên và API.'
            : 'Bạn tự tạo tunnel trong Cloudflare Zero Trust rồi dán token, dành cho người đã tự cấu hình tunnel. Dùng cho Nhân viên và API.'}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          label={ngrok ? 'Authtoken' : 'Tunnel token'}
          htmlFor={secretId}
          hint={(ngrok ? config.saved.ngrokTokenSet : config.saved.cfTokenSet) ? 'Đã lưu mã hoá trên máy này. Chỉ dán khi muốn thay.' : undefined}
        >
          <Input
            id={secretId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={ngrok ? config.ngrokToken : config.cfToken}
            placeholder={ngrok
              ? (config.saved.ngrokTokenSet ? 'Đã lưu authtoken (dán để thay)' : 'ngrok authtoken')
              : (config.saved.cfTokenSet ? 'Đã lưu token (dán để thay)' : 'Cloudflare Tunnel token')}
            onChange={e => config.edit(ngrok ? 'ngrokToken' : 'cfToken', e.target.value)}
            onBlur={() => config.commit(ngrok ? 'ngrokToken' : 'cfToken')}
          />
        </FormField>
        <FormField label={ngrok ? 'Domain tĩnh' : 'Địa chỉ công khai'} htmlFor={valueId}>
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
          <li>Đăng ký tại dashboard.ngrok.com → Your Authtoken → sao chép rồi dán vào ô Authtoken.</li>
          <li>Mục Domains → lấy domain tĩnh miễn phí rồi dán vào ô Domain tĩnh.</li>
          <li>Bật Nhân viên và API ở bảng bên dưới (đang chạy thì bấm Áp dụng).</li>
        </ol>
      ) : (
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>Vào one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel (Cloudflared), đặt tên.</li>
          <li>Ở bước cài connector, sao chép token (chuỗi dài sau <code className={CODE}>--token</code>) rồi dán vào ô Tunnel token.</li>
          <li>
            Thêm Public Hostname: tên miền con + tên miền của bạn, Service <code className={CODE}>HTTP</code> →{' '}
            <code className={CODE}>localhost:{relayPort}</code>.
          </li>
          <li>Nhập địa chỉ công khai <code className={CODE}>https://…</code> rồi bật Nhân viên và API ở bảng bên dưới (đang chạy thì bấm Áp dụng).</li>
        </ol>
      )}

      {temporaryNgrok && <p className="text-xs text-warning">Chưa nhập domain tĩnh: địa chỉ có thể đổi khi khởi động lại.</p>}
      {problem && <p role="alert" className="text-xs text-warning">{problem}</p>}

      <Notice tone="info">
        <p>
          Chỉ Nhân viên và API dùng {ngrok ? 'ngrok' : 'tunnel Cloudflare thủ công'}. Thanh toán, tích hợp và Webhook workflow
          vẫn dùng Địa chỉ tạm (Cloudflare Quick Tunnel), đổi mỗi lần bật lại. Muốn cả ba có địa chỉ cố định, chọn Cloudflare
          tự động.
        </p>
      </Notice>
    </div>
  );
}
