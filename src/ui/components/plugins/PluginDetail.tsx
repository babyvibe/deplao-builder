/**
 * PluginDetail — ngăn bên phải khi bấm một ứng dụng trên trang Ứng dụng.
 * Trình bày theo ngôn ngữ người dùng: ứng dụng làm gì, hiện ở đâu, được phép gì; cài đặt và nhật ký
 * tách thành tab; thao tác kỹ thuật (tải lại, thư mục, gỡ) gom ở cuối.
 */
import React, { useMemo, useState } from 'react';
import ipc, { PluginInfo, PluginUiContribution } from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { AlertIcon, CloseIcon } from '@/components/common/icons';
import { Badge, btn, fmtTime, Toggle } from '@/components/settings/api/apiUi';
import PluginAvatar from './PluginAvatar';
import { PluginLogs, PluginSettingsForm, RUNTIME, RuntimeLine, STATUS, uninstallPlugin } from './pluginUi';

type Tab = 'overview' | 'settings' | 'logs';

interface Place { title: string; items: string[]; hint?: string }

/** "Hiện ở đâu trong Deplao" — đọc từ manifest.contributes. */
export function pluginPlaces(p: PluginInfo): Place[] {
  const c = p.manifest.contributes || {};
  const names = (list: any[] | undefined, key = 'title') => (list || []).map(x => String(x?.[key] || x?.id || x?.type || '')).filter(Boolean);
  const out: Place[] = [];
  if (c.pages?.length) out.push({ title: 'Trang riêng', items: names(c.pages), hint: 'Mở từ Công cụ → Ứng dụng, API & Webhook (nút Mở).' });
  if (c.chatPanels?.length) out.push({ title: 'Panel trong màn chat', items: names(c.chatPanels), hint: 'Bấm biểu tượng ứng dụng trên thanh tiêu đề hội thoại.' });
  if (c.composerButtons?.length) out.push({ title: 'Nút trong ô soạn tin', items: names(c.composerButtons) });
  const wf = [...names(c.workflowNodes, 'label'), ...names(c.triggers, 'label')];
  if (wf.length) out.push({ title: 'Workflow', items: wf, hint: 'Kéo vào kịch bản trong trang Workflow.' });
  if (c.routes?.length) {
    out.push({
      title: 'API cho hệ thống ngoài',
      items: (c.routes as any[]).map(r => `${r.method} /api/v1/plugins/${p.id}${r.path}${r.description ? ` — ${r.description}` : ''}`),
    });
  }
  if (c.schedules?.length) out.push({ title: 'Chạy định kỳ', items: (c.schedules as any[]).map(s => s.description || s.id) });
  return out;
}

export default function PluginDetail({ plugin: p, pages, onClose, onChanged }: {
  plugin: PluginInfo;
  pages: PluginUiContribution[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const showNotification = useAppStore(s => s.showNotification);
  const openPluginPage = useAppStore(s => s.openPluginPage);
  const accounts = useAccountStore(s => s.accounts);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState<string | null>(null);

  const enabled = p.status === 'enabled';
  const st = STATUS[p.status] || STATUS.disabled;
  const hasSettings = !!p.manifest.contributes?.settings?.schema;
  const places = useMemo(() => pluginPlaces(p), [p]);
  const permGroups = useMemo(() => {
    const m = new Map<string, PluginInfo['permissions']>();
    for (const perm of p.permissions) {
      const list = m.get(perm.group) || [];
      list.push(perm);
      m.set(perm.group, list);
    }
    return Array.from(m.entries());
  }, [p.permissions]);
  const accountNames = p.account_ids
    ? p.account_ids.map(id => accounts.find(a => a.zalo_id === id)?.full_name || id)
    : null;

  const act = async (key: string, fn: () => Promise<{ success: boolean; error?: string }>, ok: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (!res.success) showNotification(res.error || 'Thao tác thất bại', 'error');
      else showNotification(ok, 'success');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const remove = async () => {
    setBusy('uninstall');
    try {
      if (await uninstallPlugin(p, showNotification)) { onChanged(); onClose(); }
    } finally {
      setBusy(null);
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Giới thiệu' },
    ...(hasSettings ? [{ id: 'settings' as Tab, label: 'Cài đặt' }] : []),
    { id: 'logs', label: 'Nhật ký' },
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-[560px] bg-background border-l border-border shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        aria-label={`Chi tiết ứng dụng ${p.name}`}
      >
        {/* Đầu ngăn: biểu tượng, tên, trạng thái, nút chính */}
        <div className="px-5 pt-5 pb-4 border-b border-border space-y-4">
          <div className="flex items-start gap-4">
            <PluginAvatar id={p.id} name={p.name} icon={p.icon} size={56} rounded={16} />
            <div className="flex-1 min-w-0">
              <p className="text-lg font-semibold text-foreground truncate">{p.name}</p>
              <p className="text-xs text-subtle-foreground truncate">{p.manifest.author ? `${p.manifest.author} · ` : ''}v{p.version}{p.source_type === 'dev' ? ' · thư mục dev' : ''}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={st.tone}>{st.label}</Badge>
                <Badge tone="blue" title={RUNTIME[p.runtime].hint}>{RUNTIME[p.runtime].label}</Badge>
              </div>
            </div>
            <button type="button" onClick={onClose} title="Đóng" className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-card hover:text-foreground">
              <CloseIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            {enabled && pages.length > 0 && (
              <button type="button" onClick={() => { onClose(); openPluginPage(p.id, pages[0].id); }} className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium">
                Mở {pages.length === 1 ? pages[0].title : 'ứng dụng'}
              </button>
            )}
            <label className="flex items-center gap-2 text-sm text-foreground/80">
              <Toggle
                checked={enabled}
                busy={busy === 'toggle'}
                onChange={next => act('toggle', () => (next ? ipc.plugins!.enable(p.id) : ipc.plugins!.disable(p.id)), next ? `Đã bật ${p.name}` : `Đã tắt ${p.name}`)}
              />
              {enabled ? 'Đang bật' : 'Đang tắt'}
            </label>
          </div>
          {p.status_reason && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
              <p className="text-xs text-destructive"><AlertIcon className="w-3.5 h-3.5 inline mr-1" />{p.status_reason}</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">{st.hint} Xem tab Nhật ký để biết chi tiết, sửa xong bật lại.</p>
            </div>
          )}
        </div>

        <div className="flex gap-1 px-5 border-b border-border">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${tab === t.id ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'overview' && (
            <div className="space-y-5">
              {p.manifest.description && <p className="text-sm text-foreground/80 leading-relaxed">{p.manifest.description}</p>}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Có trong Deplao</h3>
                {places.length === 0 ? (
                  <p className="text-xs text-subtle-foreground">Ứng dụng chạy nền, không thêm giao diện.</p>
                ) : (
                  <div className="space-y-2">
                    {places.map(pl => (
                      <div key={pl.title} className="rounded-xl bg-card border border-border px-3 py-2.5">
                        <p className="text-sm font-medium text-foreground">{pl.title}</p>
                        <ul className="mt-1 space-y-0.5">
                          {pl.items.map(it => <li key={it} className="text-xs text-foreground/80 break-all">• {it}</li>)}
                        </ul>
                        {pl.hint && <p className="text-[11px] text-subtle-foreground mt-1">{pl.hint}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Được phép</h3>
                {permGroups.length === 0 ? (
                  <p className="text-xs text-subtle-foreground">Không xin quyền nào.</p>
                ) : (
                  <div className="rounded-xl bg-card border border-border divide-y divide-border">
                    {permGroups.map(([group, perms]) => (
                      <div key={group} className="px-3 py-2">
                        <p className="text-[11px] font-semibold text-subtle-foreground mb-0.5">{group}</p>
                        {perms.map(perm => (
                          <p key={perm.id} className={`text-xs ${perm.risky ? 'text-warning' : 'text-foreground/80'}`} title={perm.id}>
                            {perm.risky ? '⚠ ' : '✓ '}{perm.label}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-subtle-foreground">
                  Tài khoản: {accountNames ? accountNames.join(', ') : 'tất cả tài khoản trên máy'}.
                </p>
              </section>

              {p.stats && (
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Đang chạy</h3>
                  <RuntimeLine stats={p.stats} />
                </section>
              )}

              <section className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground">Thông tin</h3>
                <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-subtle-foreground">Mã ứng dụng</dt><dd className="text-foreground/80 font-mono break-all">{p.id}</dd>
                  <dt className="text-subtle-foreground">Nguồn</dt><dd className="text-foreground/80 break-all">{p.source_type === 'dev' ? `Thư mục dev: ${p.install_path}` : 'Gói .zip'}</dd>
                  {p.manifest.homepage && (<><dt className="text-subtle-foreground">Trang chủ</dt><dd className="text-foreground/80 break-all">{p.manifest.homepage}</dd></>)}
                  <dt className="text-subtle-foreground">Cài lúc</dt><dd className="text-foreground/80">{fmtTime(p.installed_at)}</dd>
                  <dt className="text-subtle-foreground">Cập nhật</dt><dd className="text-foreground/80">{fmtTime(p.updated_at)}</dd>
                </dl>
              </section>
            </div>
          )}
          {tab === 'settings' && <PluginSettingsForm pluginId={p.id} />}
          {tab === 'logs' && <PluginLogs pluginId={p.id} />}
        </div>

        <div className="px-5 py-3 border-t border-border flex flex-wrap items-center gap-2">
          {enabled && (
            <button type="button" className={btn.secondary} disabled={!!busy} onClick={() => act('reload', () => ipc.plugins!.reload(p.id), 'Đã tải lại ứng dụng')}>
              Tải lại
            </button>
          )}
          <button type="button" className={btn.secondary} onClick={() => ipc.plugins!.openFolder(p.id, 'code')}>Thư mục ứng dụng</button>
          <button type="button" className={btn.secondary} onClick={() => ipc.plugins!.openFolder(p.id, 'data')}>Thư mục dữ liệu</button>
          <button type="button" className="ml-auto text-xs text-destructive hover:text-destructive/80 px-2 py-1.5" disabled={!!busy} onClick={remove}>
            Gỡ ứng dụng
          </button>
        </div>
      </aside>
    </div>
  );
}
