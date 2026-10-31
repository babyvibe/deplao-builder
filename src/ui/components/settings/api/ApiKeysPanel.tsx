/**
 * API key: tạo (preset scope, tài khoản, IP, giới hạn tự đặt, vai trò ERP, hết hạn), xem, thu hồi.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc, { ApiKeyCreateInput, ApiKeyRecord, ApiScopeInfo, ApiScopePreset } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { KeyIcon, PlusIcon } from '@/components/common/icons';
import { AccountOption, AccountPicker, Badge, btn, ErrorBox, Field, fmtAgo, fmtTime, inputCls, OneTimeSecret, Section } from './apiUi';

const ERP_ROLES: Array<{ id: ApiKeyRecord['erp_role']; label: string }> = [
  { id: 'member', label: 'Thành viên' },
  { id: 'manager', label: 'Quản lý' },
  { id: 'admin', label: 'Quản trị' },
  { id: 'owner', label: 'Chủ' },
  { id: 'guest', label: 'Khách' },
];

const EXPIRY_OPTIONS = [
  { days: 0, label: 'Không hết hạn' },
  { days: 30, label: '30 ngày' },
  { days: 90, label: '90 ngày' },
  { days: 365, label: '1 năm' },
];

export function useAccountOptions(): AccountOption[] {
  const accounts = useAccountStore(s => s.accounts);
  return useMemo(
    () => accounts.map(a => ({ id: a.zalo_id, name: a.full_name, channel: String(a.channel || 'zalo') })),
    [accounts],
  );
}

export function parseIpList(text: string): string[] {
  return text.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
}

export function keyState(k: ApiKeyRecord, now = Date.now()): { label: string; tone: 'green' | 'red' | 'yellow' } {
  if (k.revoked_at) return { label: 'Đã thu hồi', tone: 'red' };
  if (k.expires_at && k.expires_at <= now) return { label: 'Hết hạn', tone: 'yellow' };
  return { label: 'Hoạt động', tone: 'green' };
}

interface Props {
  scopes: ApiScopeInfo[];
  presets: Record<string, ApiScopePreset>;
}

export default function ApiKeysPanel({ scopes, presets }: Props) {
  const showNotification = useAppStore(s => s.showNotification);
  const accounts = useAccountOptions();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [usage, setUsage] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await ipc.api!.listKeys(includeRevoked);
      if (res.success) {
        setKeys(res.keys || []);
        setError(null);
      } else {
        setError(res.error || 'Không tải được danh sách key');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [includeRevoked]);

  useEffect(() => { load(); }, [load]);

  const revoke = async (k: ApiKeyRecord) => {
    const ok = await showConfirm({
      title: `Thu hồi key "${k.name}"?`,
      message: 'Hệ thống đang dùng key này sẽ bị từ chối ngay. Webhook của key ngừng gửi. Không thể hoàn tác.',
      confirmText: 'Thu hồi',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await ipc.api!.revokeKey(k.id);
    showNotification(res.success ? 'Đã thu hồi key' : res.error || 'Thu hồi thất bại', res.success ? 'success' : 'error');
    load();
  };

  const purge = async (k: ApiKeyRecord) => {
    const ok = await showConfirm({
      title: `Xoá hẳn key "${k.name}"?`,
      message: 'Xoá khỏi danh sách cùng các webhook của key. Nhật ký request vẫn giữ theo số ngày đã đặt.',
      confirmText: 'Xoá',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await ipc.api!.purgeKey(k.id);
    if (!res.success) showNotification(res.error || 'Xoá thất bại', 'error');
    load();
  };

  const loadUsage = async (k: ApiKeyRecord) => {
    const res = await ipc.api!.keyUsage(k.id, 24);
    if (res.success && res.usage) {
      const u = res.usage;
      setUsage(prev => ({ ...prev, [k.id]: `24 giờ: ${u.total} request, ${u.errors} lỗi` }));
    }
  };

  return (
    <div className="space-y-4">
      {created && (
        <OneTimeSecret title={`API key "${created.name}"`} value={created.key} onDone={() => setCreated(null)} />
      )}

      {creating ? (
        <KeyForm
          scopes={scopes}
          presets={presets}
          accounts={accounts}
          onCancel={() => setCreating(false)}
          onCreated={(name, key) => {
            setCreating(false);
            setCreated({ name, key });
            load();
          }}
        />
      ) : (
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={includeRevoked} onChange={e => setIncludeRevoked(e.target.checked)} /> Hiện key đã thu hồi
          </label>
          <button type="button" className={btn.primary} onClick={() => setCreating(true)}>
            <PlusIcon className="w-3.5 h-3.5 inline mr-1" />Tạo API key
          </button>
        </div>
      )}

      <ErrorBox message={error} />
      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <KeysTable keys={keys} accounts={accounts} usage={usage} onRevoke={revoke} onPurge={purge} onUsage={loadUsage} />
      )}
    </div>
  );
}

export function KeysTable({ keys, accounts, usage, onRevoke, onPurge, onUsage }: {
  keys: ApiKeyRecord[];
  accounts: AccountOption[];
  usage: Record<string, string>;
  onRevoke: (k: ApiKeyRecord) => void;
  onPurge: (k: ApiKeyRecord) => void;
  onUsage: (k: ApiKeyRecord) => void;
}) {
  if (keys.length === 0) {
    return (
      <Section title="Chưa có API key" icon={<KeyIcon className="w-4 h-4" />}>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Tạo key cho từng hệ thống sẽ gọi vào Deplao (website, n8n, worker, chatbot). Key chỉ hiện một lần lúc tạo.
        </p>
      </Section>
    );
  }
  const accountName = (id: string) => accounts.find(a => a.id === id)?.name || id;
  return (
    <div className="space-y-2">
      {keys.map(k => {
        const st = keyState(k);
        const active = st.tone === 'green';
        return (
          <div key={k.id} className="bg-card rounded-xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{k.name}</p>
                <p className="text-[11px] text-subtle-foreground font-mono">{k.key_prefix}…</p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Badge tone={st.tone}>{st.label}</Badge>
                {k.rate_limit_per_min > 0 && <Badge tone="blue">{k.rate_limit_per_min}/phút</Badge>}
              </div>
            </div>
            <div className="flex flex-wrap gap-1" title={k.scopes.join('\n')}>
              {k.scopes.slice(0, 8).map(s => <Badge key={s}>{s}</Badge>)}
              {k.scopes.length > 8 && <Badge>+{k.scopes.length - 8}</Badge>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
              <p>Tài khoản: {k.account_ids === null ? 'tất cả' : k.account_ids.map(accountName).join(', ') || 'không có'}</p>
              <p>IP được phép: {k.allowed_ips && k.allowed_ips.length ? k.allowed_ips.join(', ') : 'mọi IP'}</p>
              <p>Dùng lần cuối: {fmtAgo(k.last_used_at)}{k.last_used_ip ? ` · ${k.last_used_ip}` : ''}</p>
              <p>Tạo lúc: {fmtTime(k.created_at)}{k.expires_at ? ` · hết hạn ${fmtTime(k.expires_at)}` : ''}</p>
              {k.note && <p className="md:col-span-2">Ghi chú: {k.note}</p>}
              {usage[k.id] && <p className="md:col-span-2 text-primary">{usage[k.id]}</p>}
            </div>
            <div className="flex gap-3 justify-end">
              <button type="button" className={btn.link} onClick={() => onUsage(k)}>Thống kê 24h</button>
              {active && <button type="button" className="text-xs text-destructive hover:text-destructive/80" onClick={() => onRevoke(k)}>Thu hồi</button>}
              {!active && <button type="button" className="text-xs text-destructive hover:text-destructive/80" onClick={() => onPurge(k)}>Xoá hẳn</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function KeyForm({ scopes, presets, accounts, onCancel, onCreated }: {
  scopes: ApiScopeInfo[];
  presets: Record<string, ApiScopePreset>;
  accounts: AccountOption[];
  onCancel: () => void;
  onCreated: (name: string, key: string) => void;
}) {
  const showNotification = useAppStore(s => s.showNotification);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(presets.chatbot?.scopes || []));
  const [accountIds, setAccountIds] = useState<string[] | null>(null);
  const [ips, setIps] = useState('');
  const [rate, setRate] = useState('0');
  const [erpRole, setErpRole] = useState<ApiKeyRecord['erp_role']>('member');
  const [expiryDays, setExpiryDays] = useState(0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, ApiScopeInfo[]>();
    for (const sc of scopes) {
      const list = map.get(sc.group) || [];
      list.push(sc);
      map.set(sc.group, list);
    }
    return Array.from(map.entries());
  }, [scopes]);

  const toggleScope = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim()) { setError('Đặt tên cho key (vd: Website, n8n, Chatbot).'); return; }
    if (selected.size === 0) { setError('Chọn ít nhất một quyền.'); return; }
    if (accountIds !== null && accountIds.length === 0) { setError('Chọn ít nhất một tài khoản hoặc để "Tất cả tài khoản".'); return; }
    const input: ApiKeyCreateInput = {
      name: name.trim(),
      scopes: Array.from(selected),
      accountIds,
      allowedIps: parseIpList(ips),
      rateLimitPerMin: Math.max(0, Math.floor(Number(rate) || 0)),
      erpRole,
      note: note.trim(),
      expiresAt: expiryDays ? Date.now() + expiryDays * 86_400_000 : null,
    };
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.api!.createKey(input);
      if (res.success && res.key) {
        showNotification('Đã tạo API key', 'success');
        onCreated(input.name, res.key);
      } else {
        setError(res.error || 'Tạo key thất bại');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Tạo API key" icon={<KeyIcon className="w-4 h-4" />}>
      <Field label="Tên">
        <input className={inputCls} value={name} maxLength={100} placeholder="Website bán hàng" onChange={e => setName(e.target.value)} />
      </Field>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground/80">Quyền</span>
          {Object.entries(presets).map(([id, p]) => (
            <button key={id} type="button" className={btn.secondary} onClick={() => setSelected(new Set(p.scopes))}>{p.label}</button>
          ))}
          <button type="button" className={btn.link} onClick={() => setSelected(new Set())}>Bỏ chọn hết</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-72 overflow-y-auto pr-1">
          {groups.map(([group, list]) => (
            <div key={group} className="bg-muted rounded-lg px-3 py-2 space-y-1">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{group}</p>
              {list.map(sc => (
                <label key={sc.id} className="flex items-start gap-2 text-xs text-foreground/80 cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={selected.has(sc.id)} onChange={() => toggleScope(sc.id)} />
                  <span>
                    {sc.label} <span className="text-[10px] text-subtle-foreground font-mono">{sc.id}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
        {selected.has('admin') && (
          <p className="text-[11px] text-warning">Quyền "admin" bao gồm mọi quyền khác, kể cả quản lý nhân viên và cài đặt. Chỉ cấp cho hệ thống bạn hoàn toàn tin tưởng.</p>
        )}
      </div>

      <Field label="Tài khoản được dùng">
        <AccountPicker accounts={accounts} value={accountIds} onChange={setAccountIds} />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="IP được phép" hint="Mỗi dòng một IP hoặc dải CIDR (vd 203.0.113.5, 10.0.0.0/8). Để trống = mọi IP.">
          <textarea className={`${inputCls} font-mono`} rows={3} value={ips} onChange={e => setIps(e.target.value)} />
        </Field>
        <div className="space-y-3">
          <Field label="Giới hạn request/phút" hint="0 = không giới hạn (mặc định). Bạn tự đặt nếu muốn chặn hệ thống gọi quá dày.">
            <input className={inputCls} type="number" min={0} value={rate} onChange={e => setRate(e.target.value)} />
          </Field>
          <Field label="Vai trò ERP" hint="Quyền khi key gọi API công việc, dự án, chấm công…">
            <select className={inputCls} value={erpRole} onChange={e => setErpRole(e.target.value as ApiKeyRecord['erp_role'])}>
              {ERP_ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Hết hạn">
          <select className={inputCls} value={expiryDays} onChange={e => setExpiryDays(Number(e.target.value))}>
            {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Ghi chú">
          <input className={inputCls} value={note} maxLength={500} placeholder="Ai dùng, để làm gì" onChange={e => setNote(e.target.value)} />
        </Field>
      </div>

      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onCancel} disabled={saving}>Huỷ</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={saving}>{saving ? <Spinner size={3} /> : 'Tạo key'}</button>
      </div>
    </Section>
  );
}
