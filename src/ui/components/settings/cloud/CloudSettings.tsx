/**
 * Settings → Internet & Cloud (server only): all Cloudflare configuration in one place.
 *  - The Cloudflare account bar at the top (connected: permission per feature + Manage; not connected: the 3-step Connect card).
 *  - Two big cards pick the section (same style as the Apps, API & Webhook page): Internet address · Data sync (data +
 *    images/files under one setting - SyncSection, read with sync.get()).
 *  - State is read on open, every 15 s while the window is visible, and right away when main reports CLOUD_CHANGED_EVENT (bursts are merged).
 *    All state reads are local in main; Cloudflare calls (recheck, health) only run when the user clicks.
 *  - nav:settings { tab: 'cloud', subtab: 'address' | 'sync' } opens the right section ('media' / 'db' old ids → 'sync'); the section
 *    last chosen is remembered until the app is closed.
 *  - Storage (R2 / Google Drive): storage.status() is read together with the connection (area 'connection'), set into StorageContext
 *    and passed down to SyncSection. Old app builds without storage → as before (R2).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  ChevronDownIcon,
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
import { publishPublicAddresses } from '../../common/cloud/PublicAddressCard';
import type {
  CloudConnectionStatus,
  CloudStorageProvider,
  CloudStorageStatus,
  PublicAddress,
  SyncOverview,
  TunnelConfigView,
} from '../../../../shared/cloud/cloudContracts';
import AddressSection from './address/AddressSection';
import SyncSection from './sync/SyncSection';
import { ConnectCard } from './CloudConnect';
import { RestoreStateBanner } from './restore/RestoreStateBanner';
import { syncMediaHint, syncMeta } from './sync/syncHelpers';
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
import { SettingsPage } from '../settingsUi';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export type { CloudSection } from './cloudUi';

/** Initial data (test / pre-read). */
export interface CloudSnapshot {
  connection: CloudConnectionStatus | null;
  tunnelConfig: TunnelConfigView | null;
  addresses: PublicAddress[];
  /** Data sync (sync.get()). */
  sync: SyncOverview | null;
  /** Storage (storage.status()); null = unknown / old app build → R2 as before. */
  storage: CloudStorageStatus | null;
}

export interface CloudSettingsProps {
  /** Section to open by default (nav:settings { tab: 'cloud', subtab }); also accepts the old ids 'media' / 'db' (→ 'sync'). */
  initialSubtab?: CloudSection | 'media' | 'db' | null;
  initial?: Partial<CloudSnapshot>;
}

// Section currently selected, remembered until the app is closed (leaving the Settings tab and coming back still lands in the right place).
let rememberedSection: CloudSection = 'address';

/** Status read group: both main's 'media' and 'db' re-read the Data sync overview. */
type CloudLoad = 'connection' | 'tunnel' | 'sync';

function loadsFor(areas: CloudArea[]): CloudLoad[] {
  return Array.from(new Set(areas.map((area): CloudLoad => (area === 'media' || area === 'db' ? 'sync' : area))));
}

type Meta = { text: string; variant: BadgeVariant } | null;

function addressMeta(config: TunnelConfigView | null, addresses: PublicAddress[]): Meta {
  if (!config) return null;
  const enabled = addresses.filter(a => a.enabled);
  if (enabled.some(a => a.state === 'error')) return { text: tr('Có lỗi'), variant: 'destructive' };
  if (enabled.some(a => a.state === 'restarting')) return { text: tr('Đang chạy lại'), variant: 'warning' };
  if (config.mode === 'cloudflare_auto') {
    if (!config.auto) return { text: tr('Chưa cấu hình'), variant: 'default' };
    if (!enabled.length) return { text: tr('Đang tắt'), variant: 'default' };
    return { text: config.auto.layout === 'split' ? tr('Cố định · 3 tên') : tr('Cố định · 1 tên miền'), variant: 'success' };
  }
  if (!enabled.length) return { text: tr('Đang tắt'), variant: 'default' };
  if (config.mode === 'quick') return { text: tr('Địa chỉ tạm'), variant: 'warning' };
  const relay = addresses.find(a => a.service === 'relay');
  const label = config.mode === 'ngrok' ? 'ngrok' : tr('thủ công');
  return relay?.kind === 'temporary'
    ? { text: tr('Địa chỉ tạm · {{label}}', { label }), variant: 'warning' }
    : { text: tr('Cố định · {{label}}', { label }), variant: 'success' };
}

/**
 * Summary of the token's permissions + the issues to fix. When the storage is Google Drive, R2 permissions are no longer needed for Data sync
 * → no reminder.
 */
function connectionSummary(c: CloudConnectionStatus, now = Date.now(), provider: CloudStorageProvider = 'r2') {
  const zonesText = c.zones.length ? tr('tên miền {{v1}}', { v1: c.zones.map(z => z.name).join(', ') }) : tr('chưa có tên miền');
  const tunnel = permissionOf(c, 'tunnel');
  const r2 = provider === 'r2' ? permissionOf(c, 'r2') : null;
  const issues: Array<{ tone: 'warning' | 'destructive'; text: string }> = [];
  if (tunnel && !tunnel.ok) {
    issues.push({ tone: 'warning', text: tr('Địa chỉ cố định: thiếu {{v1}}', { v1: tunnel.missing?.length ? tunnel.missing.join(', ') : tr('quyền Cloudflare Tunnel, DNS') }) });
  }
  if (r2?.r2NotEnabled) {
    issues.push({ tone: 'warning', text: tr('Đồng bộ dữ liệu: tài khoản chưa bật R2 (Cloudflare → R2 Object Storage)') });
  } else if (r2 && !r2.ok) {
    issues.push({ tone: 'warning', text: tr('Đồng bộ dữ liệu: thiếu {{v1}}', { v1: r2.missing?.length ? r2.missing.join(', ') : tr('quyền Workers R2 Storage') }) });
  }
  if (c.tokenExpiresOn) {
    const exp = Date.parse(c.tokenExpiresOn);
    if (Number.isFinite(exp)) {
      const days = (exp - now) / 86_400_000;
      if (days < 0) issues.push({ tone: 'destructive', text: tr('Token đã hết hạn ngày {{v1}}, tạo token mới rồi bấm Quản lý → Đổi token.', { v1: fmtDate(exp) }) });
      else if (days <= 14) issues.push({ tone: 'warning', text: tr('Token hết hạn ngày {{v1}}.', { v1: fmtDate(exp) }) });
    }
  }
  if (c.lastError) issues.push({ tone: 'destructive', text: c.lastError });
  const allOk = !issues.length;
  const perms = provider === 'r2' ? 'Tunnel, DNS, R2' : 'Tunnel, DNS';
  const line = allOk ? tr('Token hợp lệ · đủ quyền {{perms}} · {{zonesText}}', { perms, zonesText }) : tr('Token hợp lệ · {{zonesText}}', { zonesText });
  const dot = issues.some(i => i.tone === 'destructive') ? 'bg-destructive' : allOk ? 'bg-success' : 'bg-warning';
  return { line, issues, dot };
}

const SECTIONS: Array<{ id: CloudSection; icon: React.ReactNode; title: string; desc: string }> = [
  { id: 'address', icon: <GlobeIcon />, title: tr('Địa chỉ Internet'), desc: tr('Cho nhân viên ở xa, API, thanh toán và webhook') },
  { id: 'sync', icon: <RefreshIcon />, title: tr('Đồng bộ dữ liệu'), desc: tr('Sao lưu tin nhắn, danh bạ, ảnh, file lên R2 hoặc Google Drive; khôi phục khi đổi máy') },
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

  /** Storage (old app build without storage → keep null = R2 as before). */
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
      // Storage changes come in the same 'connection' group (main reports when the storage or the Google login changes).
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
    const res = await run('recheck', () => cloudApi()?.recheck(), tr('Đã kiểm tra lại token'));
    if (res?.connection) setConnection(res.connection);
    if (res) {
      void loadStorage(); // Whether R2 is ready changes with the token's permissions
      void refresh(['tunnel', 'media', 'db']);
    }
  };

  const disconnect = async () => {
    const ok = await showConfirm({
      title: tr('Ngắt kết nối Cloudflare?'),
      message: storage?.provider === 'gdrive'
        ? tr('Địa chỉ cố định trên máy này sẽ dừng; đồng bộ dữ liệu lên Google Drive vẫn chạy. Dữ liệu đã có trên Cloudflare vẫn giữ nguyên.')
        : tr('Địa chỉ cố định và đồng bộ dữ liệu trên máy này sẽ dừng. Dữ liệu đã có trên Cloudflare vẫn giữ nguyên.'),
      confirmText: tr('Ngắt kết nối'),
      variant: 'danger',
    });
    if (!ok) return;
    if (await run('disconnect', () => cloudApi()?.disconnect(), tr('Đã ngắt kết nối Cloudflare'))) void refresh();
  };

  const onConnected = (next: CloudConnectionStatus) => {
    setConnection(next);
    setEditingToken(false);
    void refresh();
  };

  const pageDescription = storage?.provider === 'gdrive'
    ? tr('Địa chỉ cố định cho nhân viên và đối tác trên Cloudflare, lưu media và sao lưu lên Google Drive của bạn')
    : tr('Địa chỉ cố định cho nhân viên và đối tác, lưu media, sao lưu trên Cloudflare, Google Drive của bạn');

  if (!api) {
    return (
      <SettingsPage title={tr('Internet & Cloud')} description={pageDescription} width="wide">
      <div className="space-y-5">
        <Notice tone="warning" title={tr('Bản app này chưa có tính năng Cloudflare')}>
          <p>{tr('Cập nhật Deplao lên bản mới nhất để dùng địa chỉ cố định, lưu media và sao lưu lên Cloudflare.')}</p>
        </Notice>
      </div>
      </SettingsPage>
    );
  }

  const connected = !!connection?.connected;
  const brokenToken = !connected && !!connection?.accountId;
  const metas: Record<CloudSection, Meta> = {
    address: addressMeta(tunnelConfig, addresses),
    sync: syncMeta(connection, sync, Date.now(), storage),
  };
  // "ảnh 614/24.625" (images 614/24.625) next to the Data sync label while images are included.
  const hints: Partial<Record<CloudSection, string | null>> = { sync: syncMediaHint(sync) };

  let strip: React.ReactNode;
  if (!loaded) {
    strip = (
      <Card className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        {trx('<0/> Đang đọc trạng thái Cloudflare…', { 0: <CloudSpinner className="h-3.5 w-3.5" /> })}
      </Card>
    );
  } else if (connected && !editingToken) {
    const summary = connectionSummary(connection!, Date.now(), storage?.provider ?? 'r2');
    // Worker + D1 for apps: not required → an info line only, it does not change the color dot / connection issues.
    const workersLine = workersAccessLine(connection);
    strip = (
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3" title={connection!.checkedAt ? tr('Kiểm tra lúc {{v1}}', { v1: new Date(connection!.checkedAt).toLocaleString(appLocale()) }) : undefined}>
        <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', summary.dot)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {trx('Cloudflare đã kết nối{{v1}}', { v1: connection!.accountName ? ` · ${connection!.accountName}` : '' })}
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
              {tr('Quản lý')}
            </Button>
          )}
        >
          <DropdownMenuItem icon={<RefreshIcon />} onSelect={() => void recheck()}>{tr('Kiểm tra lại token')}</DropdownMenuItem>
          <DropdownMenuItem icon={<KeyIcon />} onSelect={() => setEditingToken(true)}>{tr('Đổi token')}</DropdownMenuItem>
          <DropdownMenuItem icon={<ExternalLinkIcon />} onSelect={() => openExternalUrl(connection!.accountId ? `https://dash.cloudflare.com/${connection!.accountId}` : 'https://dash.cloudflare.com/')}>
            {tr('Mở Cloudflare')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive icon={<UnlinkIcon />} onSelect={() => void disconnect()}>{tr('Ngắt kết nối')}</DropdownMenuItem>
        </DropdownMenu>
      </Card>
    );
  } else {
    strip = (
      <div ref={connectRef} className="space-y-3">
        {brokenToken && !editingToken && (
          <Notice tone="destructive" title={tr('Token Cloudflare không còn dùng được')}>
            <p>{trx('{{v1}} Dán token mới để các tính năng chạy lại.', { v1: connection?.lastError || tr('Token đã bị thu hồi hoặc hết hạn.') })}</p>
          </Notice>
        )}
        <ConnectCard
          title={connected ? tr('Đổi token Cloudflare') : tr('Kết nối Cloudflare')}
          initialAccountId={connection?.accountId ?? ''}
          onConnected={onConnected}
          onCancel={connected ? () => setEditingToken(false) : undefined}
        />
      </div>
    );
  }

  const page = (
    <SettingsPage title={tr('Internet & Cloud')} description={pageDescription} width="wide">
    <div className="space-y-5">
      <RestoreStateBanner onOpenAccounts={() => setView('dashboard')} />
      {strip}

      <div role="tablist" aria-label={tr('Phần của trang')} className="grid gap-3 md:grid-cols-2">
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
    </SettingsPage>
  );

  // Storage for every piece below (SyncSection, the file cleanup dialog, the restore wizard opened from this page…).
  return <StorageContext.Provider value={storage}>{page}</StorageContext.Provider>;
}
