/**
 * PublicAddressCard — một component cho mọi chỗ hiện địa chỉ Internet của máy chủ (Nhân viên → Kết nối,
 * API → Truy cập từ xa, Webhook → Nhận dữ liệu vào, Tích hợp Casso/SePay, node Webhook workflow), đọc cùng một
 * trạng thái (cloudflare.tunnel.addresses()) nên chữ và trạng thái luôn khớp nhau.
 *
 * Thẻ CHỈ ĐỂ XEM: bật / tắt / đổi địa chỉ nằm ở một chỗ — Cài đặt → Internet & Đám mây → Địa chỉ Internet
 * (link "Cấu hình địa chỉ →"; chưa bật hoặc chưa có địa chỉ → "Chưa bật" + "Bật ở Cài đặt →").
 *  - Máy nhân viên / workspace từ xa: "Địa chỉ Internet do máy chủ quản lý", không có link.
 *  - Bản app không có module Cloudflare, chưa đọc xong hoặc đọc lỗi: không hiện gì (không link sang trang Cloudflare).
 *  - Mặc định chỉ hiện khi cách tạo địa chỉ là "Cloudflare tự động"; `anyMode` hiện mọi cách (địa chỉ tạm, ngrok,
 *    Cloudflare thủ công). `usePublicAddresses()` cho chỗ gọi tự quyết.
 *
 * Trạng thái dùng chung ở mức module (một lần đọc + một lắng nghe cho mọi thẻ đang mở: CLOUD_CHANGED_EVENT và sự kiện
 * tunnel kiểu cũ 'tunnel:changed' / 'relay:tunnelStatusUpdate'; đọc lại 15 s/lần khi cửa sổ đang hiện). Chỗ nào vừa
 * nhận danh sách địa chỉ mới (configureAuto, setServiceEnabled, moveHere) gọi publishPublicAddresses() để mọi thẻ
 * cập nhật ngay.
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';
import { CopyIcon } from '@/components/common/icons';
import { Badge, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { copyWithToast } from '../settings/RelayAddressNotice';
import {
  CLOUD_CHANGED_EVENT,
  type CloudChangedPayload,
  type PublicAddress,
  type TunnelMode,
  type TunnelServiceId,
} from '../../../shared/cloudContracts';
import {
  addressStatus,
  cloudApi,
  MODE_LABEL,
  navigateSettings,
  SERVICE_META,
} from '../settings/cloud/cloudUi';

// ─── Trạng thái dùng chung (module) ─────────────────────────────────────────────────────

interface AddressSnapshot {
  loaded: boolean;
  addresses: PublicAddress[];
  /** Mã lỗi của lần đọc gần nhất (vd 'EMPLOYEE_MACHINE', 'UNAVAILABLE'); null khi đọc được. */
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

/** Main từ chối vì máy này không tự quản lý địa chỉ Internet (máy nhân viên, workspace từ xa). */
const SERVER_MANAGED_CODES = new Set(['EMPLOYEE_MACHINE', 'REMOTE_WORKSPACE']);

export function isServerManagedFailure(code: string | null | undefined): boolean {
  return !!code && SERVER_MANAGED_CODES.has(code);
}

/** Cập nhật danh sách địa chỉ cho mọi thẻ đang mở (sau configureAuto / setServiceEnabled / moveHere…). */
export function publishPublicAddresses(addresses: PublicAddress[] | null | undefined): void {
  if (!Array.isArray(addresses)) return;
  snapshot = { loaded: true, addresses, failure: null };
  emit();
}

/** Đọc lỗi: máy do máy chủ quản lý thì bỏ địa chỉ cũ; lỗi khác giữ địa chỉ đã biết (thẻ ẩn link cấu hình). */
function markFailed(code: string): void {
  const managed = isServerManagedFailure(code);
  if (snapshot.loaded && snapshot.failure === code && (!managed || snapshot.addresses.length === 0)) return;
  snapshot = { loaded: true, addresses: managed ? [] : snapshot.addresses, failure: code };
  emit();
}

let inflight: Promise<void> | null = null;

/** Đọc lại địa chỉ từ main (gộp các lần gọi trùng nhau). */
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
    // Tunnel kiểu cũ (địa chỉ tạm, ngrok, Cloudflare thủ công) không phát CLOUD_CHANGED_EVENT
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
  /** Bản app có module Cloudflare. */
  available: boolean;
  /** Đã đọc ít nhất một lần (kể cả đọc lỗi). */
  loaded: boolean;
  /** Máy nhân viên / workspace từ xa: địa chỉ Internet do máy chủ quản lý, không cấu hình ở máy này. */
  serverManaged: boolean;
  /** Được mở Cài đặt → Internet & Đám mây (máy chủ, có module Cloudflare, lần đọc gần nhất không lỗi). */
  canConfigure: boolean;
  /** Cách tạo địa chỉ đang dùng (theo địa chỉ của dịch vụ relay). */
  mode: TunnelMode | null;
  /** Đang dùng "Cloudflare tự động". */
  isAuto: boolean;
  addresses: PublicAddress[];
  get: (service: TunnelServiceId) => PublicAddress | null;
  refresh: () => Promise<void>;
}

/** Địa chỉ Internet của ba dịch vụ (relay 9900, payments 9888, workflow 9889), tự cập nhật khi main báo đổi. */
export function usePublicAddresses(): PublicAddressesState {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const employeeMachine = useEmployeeStore(s => s.mode) === 'employee';
  useEffect(() => {
    startWatch();
    return endWatch;
  }, []);
  const available = !!cloudApi();
  // Không có module Cloudflare: không dùng địa chỉ đã nhớ (chỗ gọi tự lấy địa chỉ tunnel kiểu cũ nếu cần)
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

// ─── Thẻ địa chỉ (chỉ xem) ──────────────────────────────────────────────────────────────

export interface PublicAddressCardProps {
  service: TunnelServiceId;
  title: string;
  /** Đuôi đường dẫn nối sau địa chỉ gốc, vd '/api/v1', '/webhook/casso'. Có '…' hoặc '<' thì chỉ sao chép phần gốc. */
  pathSuffix?: string;
  /** @deprecated Bỏ qua — thẻ chỉ để xem; bật / tắt ở Cài đặt → Internet & Đám mây → Địa chỉ Internet. */
  showSwitch?: boolean;
  /** Gọn: ít khoảng trắng, trạng thái và link cùng một dòng. */
  compact?: boolean;
  /** Hiện cả khi không phải Cloudflare tự động (địa chỉ tạm, ngrok, thủ công). Mặc định chỉ Cloudflare tự động. */
  anyMode?: boolean;
  /** Chữ sau trạng thái, vd "dùng chung với nhân viên". Mặc định là cách tạo địa chỉ. */
  statusNote?: string;
  className?: string;
}

/** Máy nhân viên / workspace từ xa: chỉ báo địa chỉ do máy chủ quản lý (không link sang trang cấu hình). */
function ServerManagedNote({ title, compact, className }: { title: string; compact: boolean; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border bg-card', compact ? 'space-y-0.5 px-3 py-2' : 'space-y-1 p-3', className)}>
      <p className="truncate text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">Địa chỉ Internet do máy chủ quản lý.</p>
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
  // Đang bật nhưng địa chỉ chưa lên (tunnel tạm vừa bật / đang chạy lại) — chưa phải "Chưa bật"
  const pending = !fullUrl && addr.enabled && (addr.state === 'starting' || addr.state === 'restarting');
  const off = !fullUrl && !pending;
  const temporary = !!fullUrl && addr.kind === 'temporary';
  const status = off ? { label: 'Chưa bật', dot: 'bg-accent' } : addressStatus(addr, SERVICE_META[service].activeLabel);
  const statusLine = (off ? [status.label, statusNote] : [status.label, statusNote || MODE_LABEL[addr.mode]]).filter(Boolean).join(' · ');

  const link = pub.canConfigure ? (
    <Button variant="link" size="sm" className="text-xs" onClick={() => navigateSettings('cloud', 'address')}>
      {off ? 'Bật ở Cài đặt →' : temporary ? 'Dùng địa chỉ cố định →' : 'Cấu hình địa chỉ →'}
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
          <Badge size="sm" variant={temporary ? 'warning' : 'success'}>{temporary ? 'Địa chỉ tạm, sẽ đổi' : 'Cố định'}</Badge>
        )}
      </div>

      {fullUrl ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-foreground" title={fullUrl}>{fullUrl}</code>
          <button
            type="button"
            onClick={() => copyWithToast(copyValue || fullUrl, 'Đã sao chép địa chỉ')}
            title={copyValue === base && copyValue !== fullUrl ? 'Sao chép địa chỉ gốc' : 'Sao chép'}
            aria-label={`Sao chép địa chỉ ${title}`}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <CopyIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : pending ? (
        <p className="text-xs text-subtle-foreground">{addr.state === 'restarting' ? 'Đang chạy lại…' : 'Đang tạo địa chỉ…'}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', status.dot)} aria-hidden="true" />
          <span className="truncate">{statusLine}</span>
        </p>
        {(compact || off) && link}
      </div>
      {addr.enabled && addr.state === 'error' && addr.error && <p className="text-xs text-destructive">{addr.error}</p>}
      {temporary && <p className="text-xs text-muted-foreground">Đổi mỗi lần khởi động lại; phải gửi lại cho nhân viên và đối tác.</p>}
      {!compact && !off && link && <div className="flex justify-end">{link}</div>}
    </div>
  );
}
