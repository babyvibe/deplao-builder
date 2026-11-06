/**
 * Cài đặt → Proxy: danh sách proxy (HTTP, HTTPS, SOCKS4, SOCKS5) cho tài khoản Zalo, Facebook. Mỗi proxy có thử kết nối,
 * sửa, xoá và dòng "Tài khoản" để gán / gỡ tài khoản ngay tại chỗ: tài khoản tự kết nối lại qua proxy mới, không cần đăng
 * nhập lại (issue #73). Sửa thông tin hoặc xoá proxy đang dùng thì các tài khoản đó cũng kết nối lại ngay.
 */
import React, { useState, useEffect, useCallback, useId } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useApplyAccountProxy } from '@/hooks/accounts/useAccountProxy';
import { showConfirm } from '../../common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { CheckIcon, CloseIcon, EditIcon, GlobeIcon, PlusIcon, TrashIcon, UsersIcon } from '@/components/common/icons';
import { Button, Input, Label } from '@/components/ui';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { supportsAccountProxy } from '../../../../shared/accounts/accountProxy';
import { MiniAccountAvatar } from '../notifications/InAppNotifySettings';
import { SettingLine, SettingsPage, SettingsSection } from '../settingsUi';


// ─── Types ────────────────────────────────────────────────────────────────────
export interface ProxyItem {
  id: number;
  name: string;
  type: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  account_count?: number;
}

const PROXY_TYPES = ['http', 'https', 'socks5', 'socks4'] as const;

// ─── Form initial state ───────────────────────────────────────────────────────
const EMPTY_FORM = {
  name: '',
  type: 'http' as ProxyItem['type'],
  host: '',
  port: '',
  username: '',
  password: '',
};

// ─── TestProxyButton ─────────────────────────────────────────────────────────
function TestProxyButton({ proxy }: { proxy: any }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [info, setInfo] = useState('');

  const handleTest = async () => {
    if (!proxy?.host || !proxy?.port) return;
    setState('testing');
    setInfo('');
    const res = await ipc.proxy?.test(proxy);
    if (res?.success) {
      setState('ok');
      setInfo(`${res.ms}ms`);
    } else {
      setState('fail');
      setInfo(res?.error || 'Lỗi không xác định');
    }
    // Reset về idle sau 6s
    setTimeout(() => { setState('idle'); setInfo(''); }, 6000);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleTest}
      disabled={state === 'testing' || !proxy?.host || !proxy?.port}
      title={state === 'ok' ? `Kết nối được (${info})` : state === 'fail' ? info : 'Thử kết nối qua proxy'}
      className={cn(
        state === 'ok' && 'text-success hover:text-success',
        state === 'fail' && 'text-destructive hover:text-destructive',
      )}
    >
      {state === 'testing' ? (
        <><Spinner size={3} /> Đang thử...</>
      ) : state === 'ok' ? (
        <><CheckIcon className="h-4 w-4" /> {info}</>
      ) : state === 'fail' ? (
        <><CloseIcon className="h-4 w-4" /> Lỗi</>
      ) : (
        'Thử kết nối'
      )}
    </Button>
  );
}

// ─── ProxyForm ────────────────────────────────────────────────────────────────
function ProxyForm({
  initial,
  onSave,
  onCancel,
  loading,
}: {
  initial?: Partial<typeof EMPTY_FORM & { id?: number }>;
  onSave: (data: typeof EMPTY_FORM) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.host.trim() || !form.port) return;
    await onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 py-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="proxy-name">Tên</Label>
          <Input id="proxy-name" placeholder="VD: Proxy HN 1" value={form.name} onChange={(e) => set('name', e.target.value)} disabled={loading} />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Giao thức</span>
          <div role="radiogroup" aria-label="Giao thức" className="flex gap-1.5">
            {PROXY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={form.type === t}
                onClick={() => set('type', t)}
                disabled={loading}
                className={cn(
                  'h-9 flex-1 rounded-lg border text-xs font-semibold transition-colors',
                  form.type === t ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground hover:border-border-strong',
                )}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="proxy-host">Host / IP</Label>
          <Input id="proxy-host" placeholder="proxy.example.com" value={form.host} onChange={(e) => set('host', e.target.value)} required disabled={loading} />
        </div>
        <div className="w-28 space-y-1.5">
          <Label htmlFor="proxy-port">Cổng</Label>
          <Input id="proxy-port" placeholder="8080" type="number" min={1} max={65535} value={form.port}
            onChange={(e) => set('port', e.target.value)} required disabled={loading} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="proxy-user">Tài khoản <span className="font-normal text-muted-foreground">(nếu có)</span></Label>
          <Input id="proxy-user" placeholder="user" value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" disabled={loading} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proxy-pass">Mật khẩu <span className="font-normal text-muted-foreground">(nếu có)</span></Label>
          <Input id="proxy-pass" placeholder="••••••••" type="password" value={form.password}
            onChange={(e) => set('password', e.target.value)} autoComplete="new-password" disabled={loading} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {form.host && form.port ? (
          <>
            <code className="min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground">
              {form.type}://{form.username ? `${form.username}:••••@` : ''}{form.host}:{form.port}
            </code>
            <TestProxyButton proxy={{ type: form.type, host: form.host, port: Number(form.port), username: form.username, password: form.password }} />
          </>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>Huỷ</Button>
          <Button type="submit" disabled={loading || !form.host.trim() || !form.port}>{loading ? 'Đang lưu...' : 'Lưu proxy'}</Button>
        </div>
      </div>
    </form>
  );
}

// ─── Tài khoản dùng proxy ─────────────────────────────────────────────────────
const accountName = (acc: AccountInfo) => acc.full_name || acc.zalo_id;

export function ProxyAccountsLine({ proxy, proxies, accounts }: {
  proxy: ProxyItem;
  proxies: ProxyItem[];
  /** Tài khoản Zalo, Facebook (kênh dùng được proxy) */
  accounts: AccountInfo[];
}) {
  const panelId = useId();
  const applyProxy = useApplyAccountProxy();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const using = accounts.filter((acc) => acc.proxy_id === proxy.id);
  const summary = using.length > 0 ? `Dùng cho: ${using.map(accountName).join(', ')}` : 'Chưa gán tài khoản nào';

  const toggleAccount = async (acc: AccountInfo, on: boolean) => {
    const id = acc.zalo_id;
    setPending((p) => ({ ...p, [id]: true }));
    setErrors((e) => ({ ...e, [id]: '' }));
    const outcome = await applyProxy(id, on ? proxy.id : null);
    setPending((p) => ({ ...p, [id]: false }));
    if (!outcome.ok) setErrors((e) => ({ ...e, [id]: outcome.error || 'Không đổi được proxy' }));
    else if (outcome.connected === false) setErrors((e) => ({ ...e, [id]: `Đã lưu nhưng chưa kết nối lại được: ${outcome.error}` }));
  };

  return (
    <div className="-mx-2 mt-1.5">
      <SettingLine panelId={panelId} icon={<UsersIcon className="h-4 w-4" />} title="Tài khoản" summary={summary}
        open={open} onToggle={() => setOpen((v) => !v)}>
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Chưa có tài khoản Zalo, Facebook nào.</p>
        ) : (
          <div className="space-y-0.5">
            {accounts.map((acc) => {
              const id = acc.zalo_id;
              const busy = !!pending[id];
              const other = acc.proxy_id != null && acc.proxy_id !== proxy.id ? proxies.find((p) => p.id === acc.proxy_id) : undefined;
              return (
                <div key={id}>
                  <label className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted', busy && 'cursor-wait')}>
                    <input type="checkbox" checked={acc.proxy_id === proxy.id} disabled={busy}
                      onChange={(e) => void toggleAccount(acc, e.target.checked)} className="accent-primary" />
                    <MiniAccountAvatar account={acc} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">{accountName(acc)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {getChannelLabel(resolveAccountChannel(acc))}{other ? ` · đang dùng ${other.name}` : ''}
                      </span>
                    </span>
                    {busy && <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"><Spinner size={3} /> Đang kết nối lại...</span>}
                  </label>
                  {errors[id] && <p role="alert" className="pb-1 pl-9 text-[11px] text-destructive">{errors[id]}</p>}
                </div>
              );
            })}
            <p className="px-2 pt-1 text-[11px] text-muted-foreground">Tick là tài khoản tự kết nối lại qua proxy này, không cần đăng nhập lại.</p>
          </div>
        )}
      </SettingLine>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ProxySettings() {
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [formMode, setFormMode] = useState<'none' | 'add' | 'edit'>('none');
  const [editTarget, setEditTarget] = useState<ProxyItem | null>(null);
  const showNotification = useAppStore(s => s.showNotification);
  const accounts = useAccountStore(s => s.accounts);
  const applyProxy = useApplyAccountProxy();
  // Kênh dùng được proxy riêng (Telegram chưa hỗ trợ)
  const proxyAccounts = React.useMemo(() => accounts.filter((acc) => supportsAccountProxy(acc.channel)), [accounts]);

  // Accounts indexed by proxy_id
  const accountsByProxy = React.useMemo(() => {
    const map: Record<number, typeof accounts> = {};
    for (const acc of accounts) {
      if (acc.proxy_id) {
        if (!map[acc.proxy_id]) map[acc.proxy_id] = [];
        map[acc.proxy_id].push(acc);
      }
    }
    return map;
  }, [accounts]);

  /** Kết nối lại lần lượt các tài khoản (proxy vừa sửa / xoá) rồi báo một lần. proxyId null = kết nối thẳng. */
  const reconnectAccounts = async (list: AccountInfo[], proxyId: number | null) => {
    if (list.length === 0) return;
    showNotification(`Đang kết nối lại ${list.length} tài khoản...`, 'info');
    const failed: string[] = [];
    for (const acc of list) {
      const outcome = await applyProxy(acc.zalo_id, proxyId, { force: true, quiet: true });
      if (!outcome.ok || outcome.connected === false) failed.push(accountName(acc));
    }
    if (failed.length === 0) showNotification(`Đã kết nối lại ${list.length} tài khoản`, 'success');
    else showNotification(`Chưa kết nối lại được: ${failed.join(', ')}`, 'warning');
  };

  const loadProxies = useCallback(async () => {
    const res = await ipc.proxy?.list();
    if (res?.success) setProxies(res.proxies || []);
  }, []);

  useEffect(() => { loadProxies(); }, [loadProxies]);

  const handleSave = async (form: typeof EMPTY_FORM) => {
    setLoading(true);
    try {
      if (formMode === 'edit' && editTarget) {
        const res = await ipc.proxy?.update(editTarget.id, {
          name: form.name || `${form.host}:${form.port}`,
          type: form.type,
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username,
          password: form.password,
        });
        if (res?.success) {
          const target = editTarget;
          const connectionChanged = form.type !== target.type || form.host.trim() !== target.host || Number(form.port) !== Number(target.port)
            || (form.username || '') !== (target.username || '') || (form.password || '') !== (target.password || '');
          showNotification('Đã cập nhật proxy', 'success');
          setFormMode('none');
          setEditTarget(null);
          loadProxies();
          // Tài khoản đang dùng proxy này dùng ngay thông tin mới
          if (connectionChanged) void reconnectAccounts(accountsByProxy[target.id] || [], target.id);
        } else {
          showNotification(res?.error || 'Cập nhật thất bại', 'error');
        }
      } else {
        const res = await ipc.proxy?.save({
          name: form.name || `${form.host}:${form.port}`,
          type: form.type,
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username,
          password: form.password,
        });
        if (res?.success) {
          showNotification('Đã thêm proxy mới', 'success');
          setFormMode('none');
          loadProxies();
        } else {
          showNotification(res?.error || 'Thêm proxy thất bại', 'error');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (proxy: ProxyItem) => {
    const used = accountsByProxy[proxy.id] || [];
    const confirmed = await showConfirm({
      title: `Xóa proxy "${proxy.name}"?`,
      message: used.length > 0
        ? `Proxy đang được dùng bởi ${used.length} tài khoản (${used.map(accountName).join(', ')}). Xoá xong các tài khoản này kết nối lại không qua proxy. Muốn giữ proxy thì gán proxy khác cho chúng trước.`
        : 'Proxy sẽ bị xóa vĩnh viễn.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.proxy?.delete(proxy.id);
    if (res?.success) {
      showNotification('Đã xóa proxy', 'success');
      loadProxies();
      void reconnectAccounts(used, null);
    } else {
      showNotification(res?.error || 'Xóa proxy thất bại', 'error');
    }
  };

  const handleEdit = (proxy: ProxyItem) => {
    setEditTarget(proxy);
    setFormMode('edit');
  };

  return (
    <SettingsPage
      title="Proxy"
      description="Proxy riêng cho tài khoản Zalo, Facebook. Đổi lúc nào cũng được."
      actions={formMode === 'none' && (
        <Button size="sm" onClick={() => setFormMode('add')} leftIcon={<PlusIcon className="h-4 w-4" />}>Thêm proxy</Button>
      )}
    >
      {/* Thêm / sửa */}
      {formMode !== 'none' && (
        <SettingsSection title={formMode === 'add' ? 'Thêm proxy' : `Sửa "${editTarget?.name}"`}>
          <ProxyForm
            initial={formMode === 'edit' && editTarget ? {
              name: editTarget.name,
              type: editTarget.type,
              host: editTarget.host,
              port: String(editTarget.port),
              username: editTarget.username || '',
              password: editTarget.password || '',
            } : undefined}
            onSave={handleSave}
            onCancel={() => { setFormMode('none'); setEditTarget(null); }}
            loading={loading}
          />
        </SettingsSection>
      )}

      {/* Danh sách */}
      {proxies.length === 0 ? (
        formMode === 'none' && (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <GlobeIcon className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">Chưa có proxy nào</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Thêm proxy rồi gán cho tài khoản ngay tại đây.</p>
          </div>
        )
      ) : (
        <SettingsSection title={`Danh sách (${proxies.length})`}>
          {proxies.map((proxy) => {
            return (
              <div key={proxy.id} className="py-3">
              <div className="flex items-center gap-3">
                <span className="w-16 flex-shrink-0 rounded-md bg-muted px-2 py-0.5 text-center text-[11px] font-semibold text-muted-foreground">
                  {proxy.type.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{proxy.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {proxy.username ? `${proxy.username}@` : ''}{proxy.host}:{proxy.port}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <TestProxyButton proxy={proxy} />
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(proxy)} aria-label="Sửa" title="Sửa">
                    <EditIcon className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(proxy)} aria-label="Xoá" title="Xoá"
                    className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <ProxyAccountsLine proxy={proxy} proxies={proxies} accounts={proxyAccounts} />
              </div>
            );
          })}
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
