/**
 * PluginHub — trang "Ứng dụng, API & Webhook" (Công cụ → Ứng dụng, API & Webhook): mọi thứ mở Deplao ra bên ngoài ở một chỗ.
 *  - Ứng dụng (plugin): lưới ứng dụng đã cài, mỗi ô có Mở / Bật; bấm ô → ngăn chi tiết (giới thiệu, cài đặt, nhật ký, gỡ);
 *    nút "Phát triển ứng dụng" (cạnh "Cài ứng dụng") mở ngăn: thêm thư mục dev, các bước, tài liệu API/SDK.
 *  - API (trước ở Cài đặt → API): server, truy cập từ xa, API key, nhật ký, cài đặt nâng cao.
 *  - Webhook: nhận dữ liệu vào (trước ở Cài đặt → Webhooks) và gửi sự kiện ra ngoài (trước là tab Webhook của API).
 * Cài từ .zip hoặc thư mục dev đều qua màn duyệt quyền (InstallDialog).
 */
import React, { useEffect, useMemo, useState } from 'react';
import ipc, { PluginInfo, PluginInstallPreview, PluginUiContribution } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { usePluginStore } from '@/store/plugins/pluginStore';
import { Spinner } from '@/components/common/PageLoading';
import { BookIcon, CloseIcon, KeyIcon, PluginIcon, PlusIcon, SearchIcon, SettingsIcon, TerminalIcon, WebhookIcon } from '@/components/common/icons';
import { Badge, Button, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { markFeatureSeen, useFeatureSeen } from '@/lib/app/settingsSeenTabs';
import { OneTimeSecret } from '@/components/settings/api/apiUi';
import ApiSettings from '@/components/settings/api/ApiSettings';
import WebhooksSection from '@/components/settings/api/WebhooksSection';
import PluginAvatar from './PluginAvatar';
import PluginDetail from './PluginDetail';
import PluginDevPanel, { openDocs } from './PluginDevPanel';
import PluginLimitsDialog from './PluginLimitsDialog';
import { InstallDialog, RUNTIME } from './pluginUi';

/** Ứng dụng làm được gì — chip trên ô. */
export function pluginFeatures(p: PluginInfo): string[] {
  const c = p.manifest.contributes || {};
  const out: string[] = [];
  if (c.pages?.length) out.push('Trang riêng');
  if (c.chatPanels?.length) out.push('Panel chat');
  if (c.composerButtons?.length) out.push('Nút soạn tin');
  if (c.workflowNodes?.length || c.triggers?.length) out.push('Workflow');
  if (c.routes?.length) out.push('API');
  if (c.schedules?.length) out.push('Chạy định kỳ');
  return out;
}

type HubSection = 'plugins' | 'api' | 'webhooks';

type Modal =
  | { kind: 'install'; preview: PluginInstallPreview }
  | { kind: 'credentials'; name: string; apiKey: string; secret: string; baseUrl: string }
  | null;

export default function PluginHub() {
  const plugins = usePluginStore(s => s.plugins);
  const pages = usePluginStore(s => s.contributions.pages);
  const loaded = usePluginStore(s => s.loaded);
  const reload = usePluginStore(s => s.load);
  const openPluginPage = useAppStore(s => s.openPluginPage);
  const showNotification = useAppStore(s => s.showNotification);
  const tab = useAppStore(s => s.pluginHubTab);
  const setTab = useAppStore(s => s.setPluginHubTab);
  const section = useAppStore(s => s.pluginHubSection) ?? 'plugins';
  const setSection = useAppStore(s => s.setPluginHubSection);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [apiState, setApiState] = useState<{ running: boolean; port: number } | null>(null);
  const [webhookState, setWebhookState] = useState<{ inbound: number; outbound: number } | null>(null);

  // Trạng thái nhỏ trên thẻ API / Webhook — vài IPC nhẹ, đọc lại khi đổi phần.
  useEffect(() => {
    let alive = true;
    ipc.api?.status()
      .then(res => { if (alive && res?.success) setApiState({ running: !!res.server?.running, port: Number(res.server?.port) || 0 }); })
      .catch(() => undefined);
    Promise.all([
      ipc.tunnel?.status().catch(() => null),
      ipc.workflow?.getTunnelStatus().catch(() => null),
      ipc.api?.listWebhooks().catch(() => null),
    ]).then(([integration, workflow, hooks]) => {
      if (!alive) return;
      setWebhookState({
        inbound: (integration?.active ? 1 : 0) + (workflow?.success && workflow.tunnelActive ? 1 : 0),
        outbound: hooks?.success ? (hooks.webhooks || []).filter(h => h.active).length : 0,
      });
    });
    return () => { alive = false; };
  }, [section]);

  // API là tính năng mới, Webhook vừa chuyển từ Cài đặt sang: chấm đỏ trên thẻ (và trên Công cụ ở rail) tới khi mở lần đầu.
  const apiSeen = useFeatureSeen('api');
  const webhooksSeen = useFeatureSeen('webhooks');
  useEffect(() => {
    if (section === 'api' || section === 'webhooks') markFeatureSeen(section);
  }, [section]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter(p => `${p.name} ${p.manifest.description || ''} ${p.id}`.toLowerCase().includes(q));
  }, [plugins, query]);
  const detail = detailId ? plugins.find(p => p.id === detailId) || null : null;

  // Esc đóng ngăn trên cùng (chi tiết ứng dụng, rồi ngăn Phát triển ứng dụng); hộp thoại cài đặt tự xử lý.
  useEffect(() => {
    if (modal || limitsOpen || (!detailId && tab !== 'dev')) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detailId) setDetailId(null);
      else setTab('installed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, limitsOpen, detailId, tab, setTab]);
  const pagesOf = (id: string) => pages.filter(pg => pg.pluginId === id);

  const pick = async (kind: 'zip' | 'dev') => {
    setBusy(`pick-${kind}`);
    try {
      const res = kind === 'zip' ? await ipc.plugins!.pickZip() : await ipc.plugins!.pickDevFolder();
      if (!res.success) { showNotification(res.error || 'Gói ứng dụng không hợp lệ', 'error'); return; }
      if (!res.canceled && res.preview) setModal({ kind: 'install', preview: res.preview });
    } finally {
      setBusy(null);
    }
  };

  const enable = async (p: PluginInfo) => {
    setBusy(p.id);
    try {
      const res = await ipc.plugins!.enable(p.id);
      if (!res.success) showNotification(res.error || 'Không bật được ứng dụng', 'error');
      else showNotification(`Đã bật ${p.name}`, 'success');
    } finally {
      setBusy(null);
      reload();
    }
  };

  if (!ipc.plugins) return null;

  const webhookStatus = !webhookState ? null
    : webhookState.inbound && webhookState.outbound ? 'Nhận + gửi'
    : webhookState.inbound ? 'Đang nhận'
    : webhookState.outbound ? 'Đang gửi'
    : 'Đang tắt';
  const sections: Array<{ id: HubSection; icon: React.ReactNode; title: string; desc: string; meta: React.ReactNode; isNew?: boolean }> = [
    {
      id: 'plugins', icon: <PluginIcon />, title: 'Ứng dụng',
      desc: 'Thêm tính năng chạy ngay trong Deplao: trang riêng, panel chat, node workflow…',
      meta: <Badge size="sm" variant={plugins.length ? 'primary' : 'default'}>{plugins.length ? `${plugins.length} đã cài` : 'Chưa cài'}</Badge>,
    },
    {
      id: 'api', icon: <KeyIcon />, title: 'API',
      desc: 'Cho website, phần mềm, n8n… đọc dữ liệu và gửi tin qua Deplao',
      meta: apiState
        ? <Badge size="sm" dot variant={apiState.running ? 'success' : 'default'}>{apiState.running ? `Đang chạy · ${apiState.port}` : 'Đang tắt'}</Badge>
        : null,
      isNew: !apiSeen,
    },
    {
      id: 'webhooks', icon: <WebhookIcon />, title: 'Webhook',
      desc: 'Nhận dữ liệu từ hệ thống khác, báo sự kiện ra URL của bạn',
      meta: webhookStatus
        ? <Badge size="sm" dot variant={webhookStatus === 'Đang tắt' ? 'default' : 'success'}>{webhookStatus}</Badge>
        : null,
      isNew: !webhooksSeen,
    },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2"><PluginIcon className="w-5 h-5 text-primary" /> Ứng dụng, API & Webhook</h1>
            <p className="text-sm text-muted-foreground mt-1">Cài ứng dụng để thêm tính năng, kết nối website và phần mềm khác qua API và webhook.</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {([['#overview', 'Tài liệu API'], ['#guide/plugins', 'Tài liệu phát triển ứng dụng']] as const).map(([hash, label]) => (
              <Button key={hash} variant="ghost" size="sm" leftIcon={<BookIcon className="w-4 h-4" />} title="Mở trong trình duyệt" onClick={() => openDocs(hash, showNotification)}>
                {label} ↗
              </Button>
            ))}
          </div>
        </div>

        {/* Ba phần của trang: thẻ lớn, phần đang mở có viền + nền màu chính */}
        <div role="tablist" aria-label="Phần của trang" className="grid gap-3 md:grid-cols-3">
          {sections.map(sec => {
            const active = section === sec.id;
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
                {sec.isNew && <span className="pointer-events-none absolute right-3 top-3 h-2 w-2 rounded-full bg-destructive" />}
                <span className={cn(
                  'flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5',
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground',
                )}>
                  {sec.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('flex flex-wrap items-center gap-2 text-[15px] font-semibold', active ? 'text-primary' : 'text-foreground')}>
                    {sec.title}{sec.meta}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{sec.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        {section === 'plugins' && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
            <h2 className="mr-auto text-base font-semibold text-foreground">Ứng dụng đã cài</h2>
            {plugins.length > 0 && (
              <div className="relative">
                <SearchIcon className="w-4 h-4 text-subtle-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" />
                <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm ứng dụng…" className="w-56 pl-8" />
              </div>
            )}
            <Button variant="outline" size="icon" aria-label="Giới hạn chung cho ứng dụng" title="Giới hạn chung cho ứng dụng" onClick={() => setLimitsOpen(true)}>
              <SettingsIcon className="w-4 h-4" />
            </Button>
            <Button variant="outline" leftIcon={<TerminalIcon className="w-4 h-4" />} title="Thêm thư mục đang phát triển, hướng dẫn và tài liệu API" onClick={() => setTab('dev')}>
              Phát triển ứng dụng
            </Button>
            <Button leftIcon={<PlusIcon className="w-4 h-4" />} disabled={!!busy} onClick={() => pick('zip')}>
              Cài ứng dụng
            </Button>
          </div>
        )}

        {section === 'api' ? (
          <ApiSettings />
        ) : section === 'webhooks' ? (
          <WebhooksSection />
        ) : (
        <>

        {!loaded ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : plugins.length === 0 ? (
          <EmptyHub onInstall={() => pick('zip')} onDev={() => setTab('dev')} busy={!!busy} />
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
            {filtered.map(p => (
              <PluginTile
                key={p.id}
                plugin={p}
                pages={pagesOf(p.id)}
                busy={busy === p.id}
                onOpen={pg => openPluginPage(p.id, pg.id)}
                onEnable={() => enable(p)}
                onDetail={() => setDetailId(p.id)}
              />
            ))}
            {!query && (
              <button
                type="button"
                onClick={() => pick('zip')}
                disabled={!!busy}
                className="rounded-2xl border-2 border-dashed border-border hover:border-primary/60 text-muted-foreground hover:text-foreground min-h-[190px] flex flex-col items-center justify-center gap-2 transition-colors"
              >
                <PlusIcon className="w-7 h-7" />
                <span className="text-sm font-medium">Cài ứng dụng từ file .zip</span>
              </button>
            )}
            {filtered.length === 0 && <p className="text-sm text-subtle-foreground col-span-full">Không có ứng dụng khớp "{query}".</p>}
          </div>
        )}
        </>
        )}
      </div>

      {limitsOpen && <PluginLimitsDialog onClose={() => setLimitsOpen(false)} />}

      {tab === 'dev' && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={() => setTab('installed')}>
          <aside
            className="h-full w-full max-w-[920px] bg-background border-l border-border shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
            aria-label="Phát triển ứng dụng"
          >
            <div className="px-5 py-4 border-b border-border flex items-center gap-3">
              <span className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center"><TerminalIcon className="w-5 h-5" /></span>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-semibold text-foreground">Phát triển ứng dụng</p>
                <p className="text-xs text-subtle-foreground">Thêm thư mục đang phát triển, các bước làm ứng dụng, tài liệu API và SDK</p>
              </div>
              <button type="button" onClick={() => setTab('installed')} title="Đóng" className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-card hover:text-foreground">
                <CloseIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <PluginDevPanel plugins={plugins} busy={!!busy} onAddDevFolder={() => pick('dev')} onOpenDetail={p => setDetailId(p.id)} />
            </div>
          </aside>
        </div>
      )}

      {detail && (
        <PluginDetail plugin={detail} pages={pagesOf(detail.id)} onClose={() => setDetailId(null)} onChanged={() => { reload(); }} />
      )}

      {modal && (
        <div className="fixed inset-0 z-[45] bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl bg-popover border border-border shadow-2xl">
            {modal.kind === 'install' && (
              <div className="p-4">
                <InstallDialog
                  preview={modal.preview}
                  onCancel={async () => { await ipc.plugins!.cancelInstall(modal.preview.token); setModal(null); }}
                  onDone={(name, creds) => {
                    reload();
                    if (creds) setModal({ kind: 'credentials', name, ...creds });
                    else { setModal(null); showNotification(`Đã cài ${name}`, 'success'); }
                  }}
                />
              </div>
            )}
            {modal.kind === 'credentials' && (
              <div className="p-4 space-y-3">
                <OneTimeSecret title={`API key cho "${modal.name}" (server ${modal.baseUrl} dùng để gọi ngược Deplao)`} value={modal.apiKey || '(ứng dụng không xin quyền API nào)'} onDone={() => undefined} />
                <OneTimeSecret title="Secret ký request (cấu hình ở server của ứng dụng để kiểm tra X-Deplao-Signature)" value={modal.secret} onDone={() => setModal(null)} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PluginTile({ plugin: p, pages, busy, onOpen, onEnable, onDetail }: {
  plugin: PluginInfo;
  pages: PluginUiContribution[];
  busy: boolean;
  onOpen: (page: PluginUiContribution) => void;
  onEnable: () => void;
  onDetail: () => void;
}) {
  const enabled = p.status === 'enabled';
  const broken = p.status === 'invalid' || p.status === 'disabled_crash';
  const features = pluginFeatures(p);
  const c = p.manifest.contributes || {};
  const where = !pages.length && enabled
    ? [c.chatPanels?.length ? 'màn chat' : '', (c.workflowNodes?.length || c.triggers?.length) ? 'Workflow' : ''].filter(Boolean).join(' và ')
    : '';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onDetail}
      onKeyDown={e => { if (e.key === 'Enter') onDetail(); }}
      className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3 hover:border-primary/50 transition-colors cursor-pointer text-left"
    >
      <div className="flex items-start gap-3">
        <PluginAvatar id={p.id} name={p.name} icon={p.icon} size={48} rounded={14} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate" title={p.name}>{p.name}</p>
          <p className="text-[11px] text-subtle-foreground truncate">{p.manifest.author ? `${p.manifest.author} · ` : ''}v{p.version}{p.source_type === 'dev' ? ' · dev' : ''}</p>
          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-success' : broken ? 'bg-destructive' : 'bg-accent'}`} />
            <span className={enabled ? 'text-success' : broken ? 'text-destructive' : 'text-muted-foreground'}>{enabled ? 'Đang bật' : broken ? 'Có lỗi' : 'Đang tắt'}</span>
            <span className="text-subtle-foreground">·</span>
            <span className="text-muted-foreground">{RUNTIME[p.runtime].label}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 min-h-[3.2em]">{p.manifest.description || 'Không có mô tả.'}</p>
      {features.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {features.map(f => <span key={f} className="px-2 py-0.5 rounded-full text-[10px] bg-muted text-foreground/80">{f}</span>)}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2 pt-1" onClick={e => e.stopPropagation()}>
        {enabled && pages.length > 0 && (
          <button type="button" onClick={() => onOpen(pages[0])} className="flex-1 py-2 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium">
            Mở
          </button>
        )}
        {enabled && !pages.length && (
          <span className="flex-1 text-[11px] text-muted-foreground">{where ? `Dùng trong ${where}` : 'Đang chạy nền'}</span>
        )}
        {!enabled && (
          <button type="button" disabled={busy} onClick={onEnable} className="flex-1 py-2 rounded-lg bg-muted hover:bg-accent text-foreground text-sm font-medium disabled:opacity-50">
            {busy ? 'Đang bật…' : broken ? 'Bật lại' : 'Bật'}
          </button>
        )}
        <button type="button" onClick={onDetail} title="Chi tiết, cài đặt, nhật ký" className="w-9 h-9 rounded-lg bg-muted hover:bg-accent text-foreground/80 flex items-center justify-center">
          <SettingsIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function EmptyHub({ onInstall, onDev, busy }: { onInstall: () => void; onDev: () => void; busy: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-6 py-14 text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 text-primary flex items-center justify-center mb-4">
        <PluginIcon className="w-7 h-7" />
      </div>
      <p className="text-base font-semibold text-foreground">Chưa có ứng dụng nào</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">Cài ứng dụng từ file .zip do nhà cung cấp gửi. Ứng dụng hiện ngay tại đây, trong màn chat và trong Workflow.</p>
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" disabled={busy} onClick={onInstall} className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium disabled:opacity-50">
          <PlusIcon className="w-4 h-4 inline mr-1" />Cài ứng dụng
        </button>
        <button type="button" onClick={onDev} className="px-4 py-2 rounded-lg bg-muted hover:bg-accent text-foreground text-sm">
          Tự làm ứng dụng
        </button>
      </div>
    </div>
  );
}
