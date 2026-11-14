/**
 * PublicAddressCard: one component for every place that shows the server's Internet address (Employees → Connection,
 * API → Remote access, Webhook → Receive data, Casso / SePay integrations, the Webhook workflow node). It reads the same
 * state (cloudflare.tunnel.addresses()), so the text and the status always match.
 *
 * The card is VIEW ONLY: turning it on / off / changing the address is done in one place: Settings → Internet & Cloud → Internet address
 * (link "Cấu hình địa chỉ →" (Configure address →); not enabled or no address yet → "Chưa bật" (Not enabled) + "Bật ở Cài đặt →" (Enable in Settings →)).
 *  - Employee machine / remote workspace: "Địa chỉ Internet do máy chủ quản lý" (Internet address managed by the server), no link.
 *  - App build without the Cloudflare module, not read yet, or read error: shows nothing (no link to the Cloudflare page).
 *  - By default it only shows when the address creation mode is "Cloudflare tự động" (Cloudflare automatic); `anyMode` shows every mode (temporary address, ngrok,
 *    manual Cloudflare). `usePublicAddresses()` is for callers that decide for themselves.
 *
 * The state is shared at module level (one read + one listener for every open card: CLOUD_CHANGED_EVENT and the old-style tunnel
 * events 'tunnel:changed' / 'relay:tunnelStatusUpdate'; re-reads every 15 s while the window is visible). Wherever a new
 * address list is received (configureAuto, setServiceEnabled, moveHere) it calls publishPublicAddresses() so every card
 * updates at once.
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { CopyIcon } from '@/components/common/icons';
import { Badge, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { copyWithToast } from '../../settings/employees/RelayAddressNotice';
import {
  CLOUD_CHANGED_EVENT,
  type CloudChangedPayload,
  type PublicAddress,
  type TunnelMode,
  type TunnelServiceId,
} from '../../../../shared/cloud/cloudContracts';
import {
  addressStatus,
  cloudApi,
  MODE_LABEL,
  navigateSettings,
  SERVICE_META,
} from '../../settings/cloud/cloudUi';
import { tr } from '../../../../shared/i18n';

// ─── Shared state (module) ─────────────────────────────────────────────────────

interface AddressSnapshot {
  loaded: boolean;
  addresses: PublicAddress[];
  /** Error code of the latest read (e.g. 'EMPLOYEE_MACHINE', 'UNAVAILABLE'); null when the read worked. */
  failure: string | null;
}

let snapshot: AddressSnapshot = { loaded: false, addresses: [], failure: null };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): AddressSnapshot {
  return snapshot;
}

/** Main refused because this machine does not manage its own Internet address (employee machine, remote workspace). */
const SERVER_MANAGED_CODES = new Set(['EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE']);

export function isServerManagedFailure(code: string | null | undefined): boolean {
  return !!code && SERVER_MANAGED_CODES.has(code);
}

/** Update the address list for every open card (after configureAuto / setServiceEnabled / moveHere…). */
export function publishPublicAddresses(addresses: PublicAddress[] | null | undefined): void {
  if (!Array.isArray(addresses)) return;
  snapshot = { loaded: true, addresses, failure: null };
  emit();
}

/** Read error: if the machine is managed by the server, drop the old address; other errors keep the known address (the card hides the configure link). */
function markFailed(code: string): void {
  const managed = isServerManagedFailure(code);
  if (snapshot.loaded && snapshot.failure === code && (!managed || snapshot.addresses.length === 0)) return;
  snapshot = { loaded: true, addresses: managed ? [] : snapshot.addresses, failure: code };
  emit();
}

let inflight: Promise<void> | null = null;

/** Read the addresses again from main (merges duplicate calls). */
export function refreshPublicAddresses(): Promise<void> {
  if (inflight) return inflight;
  const api = cloudApi();
  if (!api?.tunnel?.addresses) {
    markFailed('UNAVAILABLE');
    return Promise.resolve();
  }
  inflight = (async () => {
    try {
      const res = await api.tunnel.addresses();
      if (res?.success && Array.isArray(res.addresses)) publishPublicAddresses(res.addresses);
      else markFailed(res?.code || 'FAILED');
    } catch {
      markFailed('FAILED');
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

let watchers = 0;
let stopWatching: (() => void) | null = null;

function startWatch(): void {
  watchers += 1;
  if (watchers > 1) return;
  void refreshPublicAddresses();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void refreshPublicAddresses(); }, 500);
  };
  const offs = [
    ipc.on?.(CLOUD_CHANGED_EVENT, (payload: CloudChangedPayload) => {
      if (!payload?.area || payload.area === 'tunnel' || payload.area === 'connection') schedule();
    }),
    // Old-style tunnels (temporary address, ngrok, manual Cloudflare) do not emit CLOUD_CHANGED_EVENT
    ipc.on?.('tunnel:changed', schedule),
    ipc.on?.('relay:tunnelStatusUpdate', schedule),
  ];
  const poll = setInterval(() => { if (document.visibilityState !== 'hidden') void refreshPublicAddresses(); }, 15_000);
  const onVisibility = () => { if (document.visibilityState !== 'hidden') schedule(); };
  document.addEventListener('visibilitychange', onVisibility);
  stopWatching = () => {
    offs.forEach(off => off?.());
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function endWatch(): void {
  watchers = Math.max(0, watchers - 1);
  if (watchers === 0 && stopWatching) {
    stopWatching();
    stopWatching = null;
  }
}

export interface PublicAddressesState {
  /** This app build has the Cloudflare module. */
  available: boolean;
  /** Read at least once (including a read that failed). */
  loaded: boolean;
  /** Employee machine / remote workspace: the Internet address is managed by the server, not configured on this machine. */
  serverManaged: boolean;
  /** Can open Settings → Internet & Cloud (server, has the Cloudflare module, the latest read had no error). */
  canConfigure: boolean;
  /** The address creation mode in use (from the relay service's address). */
  mode: TunnelMode | null;
  /** Using "Cloudflare tự động" (Cloudflare automatic). */
  isAuto: boolean;
  addresses: PublicAddress[];
  get: (service: TunnelServiceId) => PublicAddress | null;
  refresh: () => Promise<void>;
}

/** Internet addresses of the three services (relay 9900, payments 9888, workflow 9889), updated automatically when main reports a change. */
export function usePublicAddresses(): PublicAddressesState {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const employeeMachine = useEmployeeStore(s => s.mode) === 'employee';
  useEffect(() => {
    startWatch();
    return endWatch;
  }, []);
  const available = !!cloudApi();
  // No Cloudflare module: do not use the remembered address (the caller fetches the old-style tunnel address itself if needed)
  const addresses = available ? snap.addresses : [];
  const relay = addresses.find(a => a.service === 'relay') ?? null;
  const mode = relay?.mode ?? addresses[0]?.mode ?? null;
  return {
    available,
    loaded: snap.loaded,
    serverManaged: employeeMachine || isServerManagedFailure(snap.failure),
    canConfigure: available && !employeeMachine && snap.failure === null,
    mode,
    isAuto: available && mode === 'cloudflare_auto',
    addresses,
    get: (service: TunnelServiceId) => addresses.find(a => a.service === service) ?? null,
    refresh: refreshPublicAddresses,
  };
}

// ─── Address card (view only) ──────────────────────────────────────────────────────────────

export interface PublicAddressCardProps {
  service: TunnelServiceId;
  title: string;
  /** Path suffix appended after the base address, e.g. '/api/v1', '/webhook/casso'. If it contains '…' or '<', only the base part is copied. */
  pathSuffix?: string;
  /** @deprecated Ignored: the card is for viewing only; turn it on / off in Settings → Internet & Cloud → Internet address. */
  showSwitch?: boolean;
  /** Compact: less spacing, status and link on one line. */
  compact?: boolean;
  /** Also shown when it is not Cloudflare automatic (temporary address, ngrok, manual). Default: Cloudflare automatic only. */
  anyMode?: boolean;
  /** Text after the status, e.g. "dùng chung với nhân viên" (shared with employees). Default is the address creation mode. */
  statusNote?: string;
  className?: string;
}

/** Employee machine / remote workspace: only reports the address managed by the server (no link to the configuration page). */
function ServerManagedNote({ title, compact, className }: { title: string; compact: boolean; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-card', compact ? 'space-y-0.5 px-3 py-2' : 'space-y-1 p-3', className)}>
      <p className="truncate text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{tr('Địa chỉ Internet do máy chủ quản lý.')}</p>
    </div>
  );
}

export default function PublicAddressCard({
  service,
  title,
  pathSuffix = '',
  compact = false,
  anyMode = false,
  statusNote,
  className,
}: PublicAddressCardProps) {
  const pub = usePublicAddresses();
  if (pub.serverManaged) return <ServerManagedNote title={title} compact={compact} className={className} />;
  const addr = pub.get(service);
  if (!pub.available || !pub.loaded || !addr || (!anyMode && !pub.isAuto)) return null;

  const base = addr.enabled && addr.url ? addr.url.replace(/\/+$/, '') : null;
  const fullUrl = base ? `${base}${pathSuffix}` : null;
  const copyValue = base && (pathSuffix.includes('…') || pathSuffix.includes('<')) ? base : fullUrl;
  // Enabled but the address is not up yet (the temporary tunnel just started / is restarting) → not yet "Chưa bật" (Not enabled)
  const pending = !fullUrl && addr.enabled && (addr.state === 'starting' || addr.state === 'restarting');
  const off = !fullUrl && !pending;
  const temporary = !!fullUrl && addr.kind === 'temporary';
  const status = off ? { label: tr('Chưa bật'), dot: 'bg-accent' } : addressStatus(addr, SERVICE_META[service].activeLabel);
  const statusLine = (off ? [status.label, statusNote] : [status.label, statusNote || MODE_LABEL[addr.mode]]).filter(Boolean).join(' · ');

  const link = pub.canConfigure ? (
    <Button variant="link" size="sm" className="text-xs" onClick={() => navigateSettings('cloud', 'address')}>
      {off ? tr('Bật ở Cài đặt →') : temporary ? tr('Dùng địa chỉ cố định →') : tr('Cấu hình địa chỉ →')}
    </Button>
  ) : null;

  return (
    <div
      className={cn(
        'rounded-xl border',
        temporary ? 'border-warning/40 bg-warning/5' : 'border-border bg-card',
        compact ? 'space-y-1 px-3 py-2' : 'space-y-2 p-3',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</p>
        {fullUrl && (
          <Badge size="sm" variant={temporary ? 'warning' : 'success'}>{temporary ? tr('Địa chỉ tạm, sẽ đổi') : tr('Cố định')}</Badge>
        )}
      </div>

      {fullUrl ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-foreground" title={fullUrl}>{fullUrl}</code>
          <button
            type="button"
            onClick={() => copyWithToast(copyValue || fullUrl, tr('Đã sao chép địa chỉ'))}
            title={copyValue === base && copyValue !== fullUrl ? tr('Sao chép địa chỉ gốc') : tr('Sao chép')}
            aria-label={tr('Sao chép địa chỉ {{title}}', { title })}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <CopyIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : pending ? (
        <p className="text-xs text-subtle-foreground">{addr.state === 'restarting' ? tr('Đang chạy lại…') : tr('Đang tạo địa chỉ…')}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', status.dot)} aria-hidden="true" />
          <span className="truncate">{statusLine}</span>
        </p>
        {(compact || off) && link}
      </div>
      {addr.enabled && addr.state === 'error' && addr.error && <p className="text-xs text-destructive">{addr.error}</p>}
      {temporary && <p className="text-xs text-muted-foreground">{tr('Đổi mỗi lần khởi động lại; phải gửi lại cho nhân viên và đối tác.')}</p>}
      {!compact && !off && link && <div className="flex justify-end">{link}</div>}
    </div>
  );
}
