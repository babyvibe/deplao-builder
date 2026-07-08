import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { showConfirm } from '../common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { CheckIcon, CloseIcon, EditIcon, LockIcon, PluginIcon, PlusIcon } from '@/components/common/icons';


// ─── Types ────────────────────────────────────────────────────────────────────
interface ProxyItem {
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

const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  http:   { bg: 'bg-blue-500/20',   text: 'text-blue-400',   label: 'HTTP'   },
  https:  { bg: 'bg-green-500/20',  text: 'text-green-400',  label: 'HTTPS'  },
  socks5: { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'SOCKS5' },
  socks4: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'SOCKS4' },
};

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
function TestProxyButton({ proxy, size = 'sm' }: { proxy: any; size?: 'sm' | 'xs' }) {
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

  if (size === 'xs') {
    return (
      <button
        type="button"
        onClick={handleTest}
        disabled={state === 'testing' || !proxy?.host || !proxy?.port}
        title={state === 'ok' ? `OK (${info})` : state === 'fail' ? info : 'Test kết nối proxy'}
        className={`p-1.5 rounded-lg transition-colors text-xs ${
          state === 'ok' ? 'text-green-400 bg-green-900/20' :
          state === 'fail' ? 'text-red-400 bg-red-900/20' :
          'text-gray-400 hover:text-blue-400 hover:bg-blue-900/20'
        }`}
      >
        {state === 'testing' ? (
          <><Spinner size={3} /> Đang test...</>
        ) : state === 'ok' ? (
          <><CheckIcon className="w-4 h-4 inline" /> OK ({info})</>
        ) : state === 'fail' ? (
          <><CloseIcon className="w-4 h-4 inline" /> Lỗi</>
        ) : (
          <><PluginIcon className="w-4 h-4 inline" /> Test kết nối</>
        )}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleTest}
        disabled={state === 'testing' || !proxy?.host || !proxy?.port}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
          state === 'ok' ? 'border-green-500 text-green-400 bg-green-900/20' :
          state === 'fail' ? 'border-red-500 text-red-400 bg-red-900/20' :
          'border-gray-600 text-gray-400 hover:border-blue-500 hover:text-blue-400'
        }`}
      >
        {state === 'testing' ? (
          <><Spinner size={3} /> Đang test...</>
        ) : state === 'ok' ? (
          <><CheckIcon className="w-4 h-4 inline" /> OK ({info})</>
        ) : state === 'fail' ? (
          <><CloseIcon className="w-4 h-4 inline" /> Lỗi</>
        ) : (
          <><PluginIcon className="w-4 h-4 inline" /> Test kết nối</>
        )}
      </button>
      {state === 'fail' && info && (
        <span className="text-[11px] text-red-400 flex-1 truncate" title={info}>{info}</span>
      )}
    </div>
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
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Name */}
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Tên proxy</label>
        <input
          className="input-field text-sm w-full"
          placeholder="VD: Proxy HN 1"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          disabled={loading}
        />
      </div>

      {/* Type */}
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Giao thức</label>
        <div className="flex gap-2">
          {PROXY_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set('type', t)}
              disabled={loading}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                form.type === t
                  ? `${TYPE_BADGE[t].bg} ${TYPE_BADGE[t].text} border-current`
                  : 'border-gray-600 text-gray-400 hover:border-gray-400'
              }`}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Host + Port */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Host / IP</label>
          <input
            className="input-field text-sm w-full"
            placeholder="proxy.example.com"
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            required
            disabled={loading}
          />
        </div>
        <div className="w-24">
          <label className="text-xs text-gray-400 mb-1 block">Port</label>
          <input
            className="input-field text-sm w-full"
            placeholder="8080"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => set('port', e.target.value)}
            required
            disabled={loading}
          />
        </div>
      </div>

      {/* Username + Password (optional) */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Username <span className="text-gray-400">(tuỳ chọn)</span></label>
          <input
            className="input-field text-sm w-full"
            placeholder="user"
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
            autoComplete="off"
            disabled={loading}
          />
        </div>
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Password <span className="text-gray-400">(tuỳ chọn)</span></label>
          <input
            className="input-field text-sm w-full"
            placeholder="••••••••"
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            autoComplete="new-password"
            disabled={loading}
          />
        </div>
      </div>

      {/* URL preview */}
      {form.host && form.port && (
        <div className="bg-gray-900 rounded-lg px-3 py-2">
          <p className="text-[11px] text-gray-400 mb-0.5">URL proxy</p>
          <code className="text-xs text-green-400 break-word">
            {form.type}://{form.username ? `${form.username}:••••@` : ''}{form.host}:{form.port}
          </code>
        </div>
      )}

      {/* Test + Buttons */}
      <div className="pt-1 space-y-2">
        {form.host && form.port && (
          <TestProxyButton proxy={{ type: form.type, host: form.host, port: Number(form.port), username: form.username, password: form.password }} />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2 rounded-lg border border-gray-600 text-gray-400 text-sm hover:border-gray-400 transition-colors"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={loading || !form.host.trim() || !form.port}
            className="flex-1 btn-primary text-sm py-2 text-white"
          >
            {loading ? 'Đang lưu...' : 'Lưu proxy'}
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ProxySettings() {
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [formMode, setFormMode] = useState<'none' | 'add' | 'edit'>('none');
  const [editTarget, setEditTarget] = useState<ProxyItem | null>(null);
  const { showNotification } = useAppStore();
  const { accounts } = useAccountStore();

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
          showNotification('Đã cập nhật proxy', 'success');
          setFormMode('none');
          setEditTarget(null);
          loadProxies();
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
    const usedCount = accountsByProxy[proxy.id]?.length || 0;
    const confirmed = await showConfirm({
      title: `Xóa proxy "${proxy.name}"?`,
      message: usedCount > 0
        ? `Proxy đang được dùng bởi ${usedCount} tài khoản. Xóa sẽ gỡ proxy khỏi tất cả tài khoản đó.`
        : 'Proxy sẽ bị xóa vĩnh viễn.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.proxy?.delete(proxy.id);
    if (res?.success) {
      showNotification('Đã xóa proxy', 'success');
      loadProxies();
    } else {
      showNotification(res?.error || 'Xóa proxy thất bại', 'error');
    }
  };

  const handleEdit = (proxy: ProxyItem) => {
    setEditTarget(proxy);
    setFormMode('edit');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white"><LockIcon className="w-4 h-4 inline" /> Quản lý Proxy</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Mỗi tài khoản có thể gắn 1 proxy riêng. Hỗ trợ HTTP, HTTPS, SOCKS4, SOCKS5.
          </p>
        </div>
        {formMode === 'none' && (
          <button
            onClick={() => setFormMode('add')}
            className="btn-primary text-sm flex items-center gap-1.5 px-3 py-1.5 text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Thêm proxy
          </button>
        )}
      </div>

      {/* Add / Edit Form */}
      {formMode !== 'none' && (
        <div className="bg-gray-750 border border-gray-600 rounded-xl p-4">
          <p className="text-sm font-semibold text-white mb-3">
            {formMode === 'add' ? <><PlusIcon className="w-4 h-4 inline" /> Thêm proxy mới</> : <><EditIcon className="w-4 h-4 inline" /> Sửa "{editTarget?.name}"</>}
          </p>
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
        </div>
      )}

      {/* Proxy List */}
      {proxies.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3 justify-self-center"><LockIcon className="w-4 h-4" /></div>
          <p className="text-sm font-medium text-gray-400">Chưa có proxy nào</p>
          <p className="text-xs mt-1">Thêm proxy để gán cho từng tài khoản Zalo khi đăng nhập</p>
        </div>
      ) : (
        <div className="space-y-2">
          {proxies.map((proxy) => {
            const badge = TYPE_BADGE[proxy.type] || TYPE_BADGE.http;
            const usedAccounts = accountsByProxy[proxy.id] || [];
            return (
              <div
                key={proxy.id}
                className="bg-gray-750 border border-gray-700 rounded-xl px-4 py-3 flex items-center gap-3 hover:border-gray-600 transition-colors"
              >
                {/* Type badge */}
                <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${badge.bg} ${badge.text} flex-shrink-0`}>
                  {badge.label}
                </span>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{proxy.name}</span>
                  </div>
                  <p className="text-xs text-gray-400 font-mono truncate">
                    {proxy.username ? `${proxy.username}@` : ''}{proxy.host}:{proxy.port}
                  </p>
                </div>

                {/* Account count */}
                <div className="text-center flex-shrink-0">
                  {usedAccounts.length > 0 ? (
                    <div className="text-center">
                      <span className="text-sm font-semibold text-blue-400">{usedAccounts.length}</span>
                      <p className="text-[10px] text-gray-400">tài khoản</p>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">Chưa dùng</span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Test button */}
                  <TestProxyButton proxy={proxy} size="xs" />
                  <button
                    onClick={() => handleEdit(proxy)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                    title="Sửa"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(proxy)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                    title="Xóa"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4h6v2" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Used accounts detail */}
      {proxies.some((p) => (accountsByProxy[p.id]?.length || 0) > 0) && (
        <div className="border-t border-gray-700 pt-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tài khoản đang dùng proxy</h3>
          <div className="space-y-1.5">
            {accounts
              .filter((a) => a.proxy_id)
              .map((acc) => {
                const p = proxies.find((x) => x.id === acc.proxy_id);
                return (
                  <div key={acc.zalo_id} className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded-lg">
                    <img
                      src={acc.avatar_url || ''}
                      alt=""
                      className="w-7 h-7 rounded-full bg-gray-700 flex-shrink-0 object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).src = ''; }}
                    />
                    <span className="text-sm text-gray-200 flex-1 truncate">{acc.full_name || acc.zalo_id}</span>
                    {p && (
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${TYPE_BADGE[p.type]?.bg} ${TYPE_BADGE[p.type]?.text}`}>
                        {p.name}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
