/**
 * Cài đặt → Internet & Đám mây (chỉ máy chủ): mọi cấu hình Cloudflare ở một chỗ.
 *  - Dải tài khoản Cloudflare ở đầu (đã kết nối: quyền từng tính năng + Quản lý; chưa kết nối: thẻ Kết nối 3 bước).
 *  - Hai thẻ lớn chọn phần (cùng kiểu trang Ứng dụng, API & Webhook): Địa chỉ Internet · Đồng bộ dữ liệu (dữ liệu +
 *    ảnh/file chung một thiết lập — SyncSection, đọc bằng sync.get()).
 *  - Trạng thái đọc khi mở, 15 s/lần khi cửa sổ đang hiện, và ngay khi main báo CLOUD_CHANGED_EVENT (gộp dồn dập).
 *    Các lệnh đọc trạng thái đều cục bộ ở main; lệnh gọi Cloudflare (recheck, health) chỉ chạy khi người dùng bấm.
 *  - nav:settings { tab: 'cloud', subtab: 'address' | 'sync' } mở đúng phần ('media' / 'db' cũ → 'sync'); phần đang
 *    chọn được nhớ tới khi tắt app.
 *  - Kho lưu (R2 / Google Drive): storage.status() đọc cùng lúc với kết nối (area 'connection'), đặt vào StorageContext
 *    và truyền xuống SyncSection. Bản app cũ không có storage → như trước (R2).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  ChevronDownIcon,
  CloudIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyIcon,
  RefreshIcon,
  UnlinkIcon,
} from '@/components/common/icons';
import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  type BadgeVariant,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { publishPublicAddresses } from '../../common/PublicAddressCard';
import type {
  CloudConnectionStatus,
  CloudStorageProvider,
  CloudStorageStatus,
  PublicAddress,
  SyncOverview,
  TunnelConfigView,
} from '../../../../shared/cloudContracts';
import AddressSection from './AddressSection';
import SyncSection from './SyncSection';
import { ConnectCard } from './CloudConnect';
import { RestoreStateBanner } from './RestoreStateBanner';
import { syncMediaHint, syncMeta } from './syncHelpers';
import {
  CLOUD_AREAS,
  cloudApi,
  CloudSpinner,
  fmtDate,
  Notice,
  openExternalUrl,
  permissionOf,
  StorageContext,
  toCloudSection,
  useCloudAction,
  useCloudChanged,
  useVisibleInterval,
  workersAccessLine,
  type CloudArea,
  type CloudSection,
} from './cloudUi';

export type { CloudSection } from './cloudUi';

/** Dữ liệu ban đầu (test / đã đọc trước). */
export interface CloudSnapshot {
  connection: CloudConnectionStatus | null;
  tunnelConfig: TunnelConfigView | null;
  addresses: PublicAddress[];
  /** Đồng bộ dữ liệu (sync.get()). */
  sync: SyncOverview | null;
  /** Kho lưu (storage.status()); null = chưa biết / bản app cũ → R2 như trước. */
  storage: CloudStorageStatus | null;
}

export interface CloudSettingsProps {
  /** Phần mở sẵn (nav:settings { tab: 'cloud', subtab }); nhận cả id cũ 'media' / 'db' (→ 'sync'). */
  initialSubtab?: CloudSection | 'media' | 'db' | null;
  initial?: Partial<CloudSnapshot>;
}

// Phần đang chọn, nhớ tới khi tắt app (rời tab Cài đặt rồi quay lại vẫn đúng chỗ).
let rememberedSection: CloudSection = 'address';

/** Nhóm đọc trạng thái: 'media' / 'db' của main đều đọc lại overview của Đồng bộ dữ liệu. */
type CloudLoad = 'connection' | 'tunnel' | 'sync';

function loadsFor(areas: CloudArea[]): CloudLoad[] {
  return Array.from(new Set(areas.map((area): CloudLoad => (area === 'media' || area === 'db' ? 'sync' : area))));
}

type Meta = { text: string; variant: BadgeVariant } | null;

function addressMeta(config: TunnelConfigView | null, addresses: PublicAddress[]): Meta {
  if (!config) return null;
  const enabled = addresses.filter(a => a.enabled);
  if (enabled.some(a => a.state === 'error')) return { text: 'Có lỗi', variant: 'destructive' };
  if (enabled.some(a => a.state === 'restarting')) return { text: 'Đang chạy lại', variant: 'warning' };
  if (config.mode === 'cloudflare_auto') {
    if (!config.auto) return { text: 'Chưa cấu hình', variant: 'default' };
    if (!enabled.length) return { text: 'Đang tắt', variant: 'default' };
    return { text: config.auto.layout === 'split' ? 'Cố định · 3 tên' : 'Cố định · 1 tên miền', variant: 'success' };
  }
  if (!enabled.length) return { text: 'Đang tắt', variant: 'default' };
  if (config.mode === 'quick') return { text: 'Địa chỉ tạm', variant: 'warning' };
  const relay = addresses.find(a => a.service === 'relay');
  const label = config.mode === 'ngrok' ? 'ngrok' : 'thủ công';
  return relay?.kind === 'temporary'
    ? { text: `Địa chỉ tạm · ${label}`, variant: 'warning' }
    : { text: `Cố định · ${label}`, variant: 'success' };
}

/**
 * Câu tóm tắt quyền của token + các vấn đề cần sửa. Kho lưu là Google Drive thì quyền R2 không còn cần cho Đồng bộ dữ
 * liệu → không nhắc.
 */
function connectionSummary(c: CloudConnectionStatus, now = Date.now(), provider: CloudStorageProvider = 'r2') {
  const zonesText = c.zones.length ? `tên miền ${c.zones.map(z => z.name).join(', ')}` : 'chưa có tên miền';
  const tunnel = permissionOf(c, 'tunnel');
  const r2 = provider === 'r2' ? permissionOf(c, 'r2') : null;
  const issues: Array<{ tone: 'warning' | 'destructive'; text: string }> = [];
  if (tunnel && !tunnel.ok) {
    issues.push({ tone: 'warning', text: `Địa chỉ cố định: thiếu ${tunnel.missing?.length ? tunnel.missing.join(', ') : 'quyền Cloudflare Tunnel, DNS'}` });
  }
  if (r2?.r2NotEnabled) {
    issues.push({ tone: 'warning', text: 'Đồng bộ dữ liệu: tài khoản chưa bật R2 (Cloudflare → R2 Object Storage)' });
  } else if (r2 && !r2.ok) {
    issues.push({ tone: 'warning', text: `Đồng bộ dữ liệu: thiếu ${r2.missing?.length ? r2.missing.join(', ') : 'quyền Workers R2 Storage'}` });
  }
  if (c.tokenExpiresOn) {
    const exp = Date.parse(c.tokenExpiresOn);
    if (Number.isFinite(exp)) {
      const days = (exp - now) / 86_400_000;
      if (days < 0) issues.push({ tone: 'destructive', text: `Token đã hết hạn ngày ${fmtDate(exp)}, tạo token mới rồi bấm Quản lý → Đổi token.` });
      else if (days <= 14) issues.push({ tone: 'warning', text: `Token hết hạn ngày ${fmtDate(exp)}.` });
    }
  }
  if (c.lastError) issues.push({ tone: 'destructive', text: c.lastError });
  const allOk = !issues.length;
  const perms = provider === 'r2' ? 'Tunnel, DNS, R2' : 'Tunnel, DNS';
  const line = allOk ? `Token hợp lệ · đủ quyền ${perms} · ${zonesText}` : `Token hợp lệ · ${zonesText}`;
  const dot = issues.some(i => i.tone === 'destructive') ? 'bg-destructive' : allOk ? 'bg-success' : 'bg-warning';
  return { line, issues, dot };
}

const SECTIONS: Array<{ id: CloudSection; icon: React.ReactNode; title: string; desc: string }> = [
  { id: 'address', icon: <GlobeIcon />, title: 'Địa chỉ Internet', desc: 'Cho nhân viên ở xa, API, thanh toán và webhook' },
  { id: 'sync', icon: <RefreshIcon />, title: 'Đồng bộ dữ liệu', desc: 'Sao lưu tin nhắn, danh bạ, ảnh, file lên R2 hoặc Google Drive; khôi phục khi đổi máy' },
];

function safe<T>(p: Promise<T> | undefined): Promise<T | null> {
  return Promise.resolve(p).then(v => v ?? null, () => null);
}

export default function CloudSettings({ initialSubtab, initial }: CloudSettingsProps) {
  const setView = useAppStore(s => s.setView);
  const { busy, run } = useCloudAction();
  const api = cloudApi();

  const [section, setSectionState] = useState<CloudSection>(() => toCloudSection(initialSubtab) ?? rememberedSection);
  const setSection = useCallback((next: CloudSection) => {
    rememberedSection = next;
    setSectionState(next);
  }, []);
  useEffect(() => {
    const next = toCloudSection(initialSubtab);
    if (next) setSection(next);
  }, [initialSubtab, setSection]);
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const next = detail.tab === 'cloud' ? toCloudSection(detail.subtab) : null;
      if (next) setSection(next);
    };
    window.addEventListener('nav:settings', onNav);
    return () => window.removeEventListener('nav:settings', onNav);
  }, [setSection]);

  const [loaded, setLoaded] = useState(initial?.connection !== undefined);
  const [connection, setConnection] = useState<CloudConnectionStatus | null>(initial?.connection ?? null);
  const [tunnelConfig, setTunnelConfig] = useState<TunnelConfigView | null>(initial?.tunnelConfig ?? null);
  const [addresses, setAddresses] = useState<PublicAddress[]>(initial?.addresses ?? []);
  const [sync, setSync] = useState<SyncOverview | null>(initial?.sync ?? null);
  const [storage, setStorage] = useState<CloudStorageStatus | null>(initial?.storage ?? null);
  const [editingToken, setEditingToken] = useState(false);
  const connectRef = useRef<HTMLDivElement | null>(null);

  /** Kho lưu (bản app cũ không có storage → giữ null = R2 như trước). */
  const loadStorage = useCallback(async () => {
    const cf = cloudApi();
    if (typeof cf?.storage?.status !== 'function') return;
    const res = await safe(cf.storage.status());
    if (res?.success && res.storage) setStorage(res.storage);
  }, []);

  const load = useCallback(async (what: CloudLoad) => {
    const cf = cloudApi();
    if (!cf) return;
    if (what === 'connection') {
      // Kho lưu đổi cùng nhóm 'connection' (main báo khi đổi kho / đăng nhập Google).
      const [res] = await Promise.all([safe(cf.status()), loadStorage()]);
      if (res?.success && res.connection) setConnection(res.connection);
    } else if (what === 'tunnel') {
      const [cfg, addr] = await Promise.all([safe(cf.tunnel.getConfig()), safe(cf.tunnel.addresses())]);
      if (cfg?.success && cfg.config) setTunnelConfig(cfg.config);
      if (addr?.success && Array.isArray(addr.addresses)) {
        setAddresses(addr.addresses);
        publishPublicAddresses(addr.addresses);
      }
    } else if (typeof cf.sync?.get === 'function') {
      const res = await safe(cf.sync.get());
      if (res?.success && res.overview) setSync(res.overview);
    }
  }, [loadStorage]);

  const refresh = useCallback(async (areas: CloudArea[] = CLOUD_AREAS) => {
    await Promise.all(loadsFor(areas).map(load));
    setLoaded(true);
  }, [load]);

  useEffect(() => { void refresh(); }, [refresh]);
  useVisibleInterval(() => { void refresh(); }, 15_000, !!api);
  useCloudChanged(areas => { void refresh(areas); });

  const scrollToConnect = useCallback(() => {
    if (connection?.connected) setEditingToken(true);
    window.setTimeout(() => {
      connectRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      connectRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }, 50);
  }, [connection?.connected]);

  const recheck = async () => {
    const res = await run('recheck', () => cloudApi()?.recheck(), 'Đã kiểm tra lại token');
    if (res?.connection) setConnection(res.connection);
    if (res) {
      void loadStorage(); // R2 sẵn sàng hay chưa đổi theo quyền của token
      void refresh(['tunnel', 'media', 'db']);
    }
  };

  const disconnect = async () => {
    const ok = await showConfirm({
      title: 'Ngắt kết nối Cloudflare?',
      message: storage?.provider === 'gdrive'
        ? 'Địa chỉ cố định trên máy này sẽ dừng; đồng bộ dữ liệu lên Google Drive vẫn chạy. Dữ liệu đã có trên Cloudflare vẫn giữ nguyên.'
        : 'Địa chỉ cố định và đồng bộ dữ liệu trên máy này sẽ dừng. Dữ liệu đã có trên Cloudflare vẫn giữ nguyên.',
      confirmText: 'Ngắt kết nối',
      variant: 'danger',
    });
    if (!ok) return;
    if (await run('disconnect', () => cloudApi()?.disconnect(), 'Đã ngắt kết nối Cloudflare')) void refresh();
  };

  const onConnected = (next: CloudConnectionStatus) => {
    setConnection(next);
    setEditingToken(false);
    void refresh();
  };

  const header = (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <CloudIcon className="h-4 w-4 text-primary" /> Internet &amp; Đám mây
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {storage?.provider === 'gdrive'
          ? 'Địa chỉ cố định cho nhân viên và đối tác trên Cloudflare, lưu media và sao lưu lên Google Drive của bạn'
          : 'Địa chỉ cố định cho nhân viên và đối tác, lưu media, sao lưu trên Cloudflare, Google Drive của bạn'}
      </p>
    </div>
  );

  if (!api) {
    return (
      <div className="max-w-5xl space-y-5">
        {header}
        <Notice tone="warning" title="Bản app này chưa có tính năng Cloudflare">
          <p>Cập nhật Deplao lên bản mới nhất để dùng địa chỉ cố định, lưu media và sao lưu lên Cloudflare.</p>
        </Notice>
      </div>
    );
  }

  const connected = !!connection?.connected;
  const brokenToken = !connected && !!connection?.accountId;
  const metas: Record<CloudSection, Meta> = {
    address: addressMeta(tunnelConfig, addresses),
    sync: syncMeta(connection, sync, Date.now(), storage),
  };
  // "ảnh 614/24.625" cạnh nhãn Đồng bộ dữ liệu khi đang kèm ảnh.
  const hints: Partial<Record<CloudSection, string | null>> = { sync: syncMediaHint(sync) };

  let strip: React.ReactNode;
  if (!loaded) {
    strip = (
      <Card className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <CloudSpinner className="h-3.5 w-3.5" /> Đang đọc trạng thái Cloudflare…
      </Card>
    );
  } else if (connected && !editingToken) {
    const summary = connectionSummary(connection!, Date.now(), storage?.provider ?? 'r2');
    // Worker + D1 cho ứng dụng: không bắt buộc → dòng thông tin, không đổi chấm màu / vấn đề của kết nối.
    const workersLine = workersAccessLine(connection);
    strip = (
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3" title={connection!.checkedAt ? `Kiểm tra lúc ${new Date(connection!.checkedAt).toLocaleString('vi-VN')}` : undefined}>
        <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', summary.dot)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Cloudflare đã kết nối{connection!.accountName ? ` · ${connection!.accountName}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">{summary.line}</p>
          {summary.issues.map(issue => (
            <p key={issue.text} className={cn('text-xs', issue.tone === 'destructive' ? 'text-destructive' : 'text-warning')}>{issue.text}</p>
          ))}
          {workersLine && <p className="text-xs text-muted-foreground">{workersLine.text}</p>}
        </div>
        <DropdownMenu
          align="end"
          trigger={(
            <Button variant="outline" size="sm" loading={busy === 'recheck' || busy === 'disconnect'} rightIcon={<ChevronDownIcon className="h-4 w-4" />}>
              Quản lý
            </Button>
          )}
        >
          <DropdownMenuItem icon={<RefreshIcon />} onSelect={() => void recheck()}>Kiểm tra lại token</DropdownMenuItem>
          <DropdownMenuItem icon={<KeyIcon />} onSelect={() => setEditingToken(true)}>Đổi token</DropdownMenuItem>
          <DropdownMenuItem icon={<ExternalLinkIcon />} onSelect={() => openExternalUrl(connection!.accountId ? `https://dash.cloudflare.com/${connection!.accountId}` : 'https://dash.cloudflare.com/')}>
            Mở Cloudflare
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive icon={<UnlinkIcon />} onSelect={() => void disconnect()}>Ngắt kết nối</DropdownMenuItem>
        </DropdownMenu>
      </Card>
    );
  } else {
    strip = (
      <div ref={connectRef} className="space-y-3">
        {brokenToken && !editingToken && (
          <Notice tone="destructive" title="Token Cloudflare không còn dùng được">
            <p>{connection?.lastError || 'Token đã bị thu hồi hoặc hết hạn.'} Dán token mới để các tính năng chạy lại.</p>
          </Notice>
        )}
        <ConnectCard
          title={connected ? 'Đổi token Cloudflare' : 'Kết nối Cloudflare'}
          initialAccountId={connection?.accountId ?? ''}
          onConnected={onConnected}
          onCancel={connected ? () => setEditingToken(false) : undefined}
        />
      </div>
    );
  }

  const page = (
    <div className="max-w-5xl space-y-5">
      {header}
      <RestoreStateBanner onOpenAccounts={() => setView('dashboard')} />
      {strip}

      <div role="tablist" aria-label="Phần của trang" className="grid gap-3 md:grid-cols-2">
        {SECTIONS.map(sec => {
          const active = section === sec.id;
          const meta = metas[sec.id];
          const hint = hints[sec.id];
          return (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-value={sec.id}
              onClick={() => setSection(sec.id)}
              className={cn(
                'group relative flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-primary/40',
              )}
            >
              <span
                className={cn(
                  'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5',
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground',
                )}
              >
                {sec.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('flex flex-wrap items-center gap-2 text-[15px] font-semibold', active ? 'text-primary' : 'text-foreground')}>
                  {sec.title}
                  {meta && <Badge size="sm" dot variant={meta.variant}>{meta.text}</Badge>}
                  {hint && <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{hint}</span>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{sec.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-label={SECTIONS.find(s => s.id === section)?.title}>
        {!loaded && !tunnelConfig && !sync ? (
          <div className="flex justify-center py-12"><CloudSpinner className="h-5 w-5" /></div>
        ) : section === 'address' ? (
          <AddressSection
            connection={connection}
            config={tunnelConfig}
            addresses={addresses}
            onTunnelChange={patch => {
              if (patch.config) setTunnelConfig(patch.config);
              if (patch.addresses) setAddresses(patch.addresses);
            }}
            onRefresh={() => void refresh(['tunnel'])}
            onConnect={scrollToConnect}
            onRecheck={() => void recheck()}
            rechecking={busy === 'recheck'}
          />
        ) : (
          <SyncSection
            connection={connection}
            storage={storage}
            onStorage={setStorage}
            overview={sync}
            onOverview={setSync}
            onRefresh={() => void refresh(['db'])}
            onConnect={scrollToConnect}
            onRecheck={() => void recheck()}
            rechecking={busy === 'recheck'}
            showRestoreBanner={false}
          />
        )}
      </div>
    </div>
  );

  // Kho lưu cho mọi mảnh bên dưới (SyncSection, hộp dọn file, trình khôi phục mở từ trang này…).
  return <StorageContext.Provider value={storage}>{page}</StorageContext.Provider>;
}
