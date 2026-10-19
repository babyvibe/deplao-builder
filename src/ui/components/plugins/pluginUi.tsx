/**
 * Phần giao diện quản lý ứng dụng (plugin) dùng chung cho trang Ứng dụng: màn duyệt quyền khi cài, form cài đặt,
 * nhật ký, dòng trạng thái phần chạy, thao tác gỡ.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ipc, { PluginInfo, PluginInstallPreview, PluginSettingsSchema } from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, PluginIcon } from '@/components/common/icons';
import { AccountPicker, Badge, btn, ErrorBox, Field, fmtTime, inputCls, Section, Toggle } from '@/components/settings/api/apiUi';
import { useAccountOptions } from '@/components/settings/api/ApiKeysPanel';

export const STATUS: Record<PluginInfo['status'], { label: string; tone: 'green' | 'gray' | 'red' | 'yellow'; hint: string }> = {
  enabled: { label: 'Đang bật', tone: 'green', hint: 'Ứng dụng đang chạy và hiện trong Deplao.' },
  disabled: { label: 'Đang tắt', tone: 'gray', hint: 'Ứng dụng không chạy, không hiện trong Deplao. Dữ liệu vẫn giữ.' },
  invalid: { label: 'Lỗi gói', tone: 'red', hint: 'Gói ứng dụng hỏng hoặc không hợp lệ với bản Deplao này.' },
  disabled_crash: { label: 'Tắt do lỗi', tone: 'red', hint: 'Ứng dụng lỗi nhiều lần liên tiếp nên Deplao đã tự tắt nó.' },
};

export const RUNTIME: Record<PluginInfo['runtime'], { label: string; hint: string }> = {
  web: { label: 'Chỉ giao diện', hint: 'Chỉ có giao diện chạy trong Deplao, không chạy code nền.' },
  local: { label: 'Chạy trên máy', hint: 'Có phần chạy nền trên máy này, trong tiến trình riêng tách khỏi Deplao.' },
  remote: { label: 'Dịch vụ ngoài', hint: 'Phần xử lý chạy trên server của nhà cung cấp; Deplao gọi tới qua HTTPS có chữ ký.' },
};

/** Gỡ ứng dụng: hỏi xác nhận rồi hỏi có xoá dữ liệu không (như thao tác cũ ở Cài đặt). Trả true nếu đã gỡ. */
export async function uninstallPlugin(p: PluginInfo, notify: (msg: string, kind: 'success' | 'error') => void): Promise<boolean> {
  const ok = await showConfirm({
    title: `Gỡ ứng dụng "${p.name}"?`,
    message: p.source_type === 'dev'
      ? 'Ứng dụng sẽ bị gỡ khỏi Deplao. Thư mục dev của bạn KHÔNG bị xoá.'
      : 'Mã của ứng dụng sẽ bị xoá khỏi máy. Dữ liệu riêng của ứng dụng (lưu trữ, file, nhật ký) được giữ lại để cài lại sau.',
    confirmText: 'Gỡ',
    variant: 'danger',
  });
  if (!ok) return false;
  const wipe = await showConfirm({
    title: 'Xoá luôn dữ liệu của ứng dụng?',
    message: 'Chọn "Xoá dữ liệu" để xoá lưu trữ, file và nhật ký của ứng dụng. Không thể hoàn tác.',
    confirmText: 'Xoá dữ liệu',
    cancelText: 'Giữ dữ liệu',
    variant: 'warning',
  });
  const res = await ipc.plugins!.uninstall(p.id, wipe);
  if (!res.success) { notify(res.error || 'Gỡ ứng dụng thất bại', 'error'); return false; }
  notify(`Đã gỡ ${p.name}`, 'success');
  return true;
}

/** Dòng trạng thái phần chạy: tiến trình trên máy (PID, RAM) hoặc server remote (kết nối). */
export function RuntimeLine({ stats }: { stats: NonNullable<PluginInfo['stats']> }) {
  const r = stats.remote;
  if (r) {
    return (
      <p className="text-[11px] text-subtle-foreground break-all">
        Server <span className="font-mono text-muted-foreground">{r.baseUrl || '—'}</span>
        {' · '}
        {r.connected === true && <span className="text-success">kết nối tốt</span>}
        {r.connected === false && <span className="text-destructive">không kết nối được{stats.lastError ? ` (${stats.lastError})` : ''}</span>}
        {r.connected === null && <span>chưa gọi lần nào</span>}
        {r.lastOkAt ? ` · lần cuối OK ${fmtTime(r.lastOkAt)}` : ''}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-subtle-foreground">
      {stats.running ? (stats.pid ? `Đang chạy (PID ${stats.pid})` : 'Đang chạy') : 'Không chạy'}
      {stats.memoryMb ? ` · ${stats.memoryMb} MB RAM` : ''}
      {stats.restarts ? ` · khởi động lại ${stats.restarts} lần` : ''}
      {stats.lastError ? ` · lỗi gần nhất: ${stats.lastError}` : ''}
    </p>
  );
}

export function InstallDialog({ preview, onCancel, onDone }: {
  preview: PluginInstallPreview;
  onCancel: () => void;
  onDone: (name: string, creds: { apiKey: string; secret: string; baseUrl: string } | null) => void;
}) {
  const accounts = useAccountOptions();
  const [accountIds, setAccountIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = preview.manifest;
  const isUpdate = !!preview.existing;

  const confirm = async () => {
    if (accountIds !== null && accountIds.length === 0) { setError('Chọn ít nhất một tài khoản hoặc để "Tất cả tài khoản".'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.plugins!.confirmInstall(preview.token, accountIds);
      if (!res.success) { setError(res.error || 'Cài thất bại'); return; }
      onDone(m.name, res.remoteCredentials || null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={isUpdate ? `Cập nhật ${m.name}: ${preview.existing!.version} → ${m.version}` : `Cài ${m.name} ${m.version}`} icon={<PluginIcon className="w-4 h-4" />}>
      <div className="flex flex-wrap gap-1">
        <Badge tone="blue">{RUNTIME[m.runtime].label}</Badge>
        {preview.source === 'dev' && <Badge tone="yellow">Thư mục dev (chạy tại chỗ)</Badge>}
        {m.author && <Badge>{m.author}</Badge>}
      </div>
      {m.description && <p className="text-xs text-muted-foreground leading-relaxed">{m.description}</p>}
      {m.runtime === 'remote' && m.remote?.baseUrl && (
        <p className="text-[11px] text-muted-foreground">Server của ứng dụng: <span className="font-mono text-foreground/80">{m.remote.baseUrl}</span></p>
      )}
      {preview.hasBackend && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          <p className="text-xs text-destructive"><AlertIcon className="w-4 h-4 inline" /> Ứng dụng này chạy code trên máy bạn. Chỉ cài từ nguồn bạn tin cậy.</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground/80">Ứng dụng xin các quyền:</p>
        <ul className="space-y-0.5">
          {preview.permissions.map(perm => (
            <li key={perm.id} className={`text-xs ${perm.risky ? 'text-destructive' : 'text-foreground/80'}`}>
              • {perm.label} <span className="text-[10px] text-subtle-foreground font-mono">{perm.id}</span>
              {isUpdate && preview.newPermissions.includes(perm.id) && <Badge tone="yellow">mới</Badge>}
            </li>
          ))}
        </ul>
      </div>
      <Field label="Tài khoản ứng dụng được dùng">
        <AccountPicker accounts={accounts} value={accountIds} onChange={setAccountIds} />
      </Field>
      {preview.readme && (
        <details className="bg-card rounded-lg px-3 py-2">
          <summary className="text-xs text-foreground/80 cursor-pointer">README của ứng dụng</summary>
          <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto font-sans">{preview.readme}</pre>
        </details>
      )}
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn.secondary} disabled={saving} onClick={onCancel}>Huỷ</button>
        <button type="button" className={btn.primary} disabled={saving} onClick={confirm}>{saving ? <Spinner size={3} /> : isUpdate ? 'Cập nhật' : 'Cài và bật'}</button>
      </div>
    </Section>
  );
}

export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const showNotification = useAppStore(s => s.showNotification);
  const [schema, setSchema] = useState<PluginSettingsSchema | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await ipc.plugins!.getSettings(pluginId);
      if (res.success) { setSchema(res.schema || null); setValues(res.values || {}); }
      else setError(res.error || 'Không đọc được cài đặt');
      setLoading(false);
    })();
  }, [pluginId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.plugins!.setSettings(pluginId, values);
      if (!res.success) { setError(res.error || 'Lưu thất bại'); return; }
      setValues(res.values || values);
      showNotification('Đã lưu cài đặt ứng dụng', 'success');
      window.dispatchEvent(new CustomEvent('plugins:settingsChanged', { detail: { pluginId, values: res.values } }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-3"><Spinner size={4} /></div>;
  if (!schema) return <p className="text-xs text-subtle-foreground">Ứng dụng không có cài đặt.</p>;

  return (
    <div className="space-y-3">
      <SettingsFields schema={schema} values={values} onChange={setValues} />
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <button type="button" className={btn.primary} disabled={saving} onClick={save}>{saving ? <Spinner size={3} /> : 'Lưu cài đặt'}</button>
      </div>
    </div>
  );
}

export function SettingsFields({ schema, values, onChange }: { schema: PluginSettingsSchema; values: Record<string, any>; onChange: (next: Record<string, any>) => void }) {
  const set = (key: string, v: any) => onChange({ ...values, [key]: v });
  return (
    <>
      {Object.entries(schema.properties).map(([key, f]) => {
        const label = `${f.title || key}${schema.required?.includes(key) ? ' *' : ''}`;
        const v = values[key];
        if (f.type === 'boolean') {
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-foreground/80">{label}</p>
                {f.description && <p className="text-[11px] text-subtle-foreground">{f.description}</p>}
              </div>
              <Toggle checked={!!v} onChange={next => set(key, next)} />
            </div>
          );
        }
        return (
          <Field key={key} label={label} hint={f.description}>
            {f.enum ? (
              <select className={inputCls} value={v ?? ''} onChange={e => set(key, e.target.value)}>
                <option value="">—</option>
                {f.enum.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
              </select>
            ) : f.type === 'number' || f.type === 'integer' ? (
              <input className={inputCls} type="number" min={f.minimum} max={f.maximum} step={f.type === 'integer' ? 1 : 'any'} value={v ?? ''} onChange={e => set(key, e.target.value)} />
            ) : f['x-multiline'] ? (
              <textarea className={inputCls} rows={4} maxLength={f.maxLength} value={v ?? ''} onChange={e => set(key, e.target.value)} />
            ) : (
              <input
                className={inputCls}
                type={f['x-secret'] ? 'password' : 'text'}
                maxLength={f.maxLength}
                value={v ?? ''}
                placeholder={f['x-secret'] ? 'Để trống nếu không đổi' : ''}
                onChange={e => set(key, e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

export function PluginLogs({ pluginId }: { pluginId: string }) {
  const [rows, setRows] = useState<Array<{ id: number; level: string; message: string; created_at: number }> | null>(null);
  const load = useCallback(async () => {
    const res = await ipc.plugins!.logs(pluginId, 300);
    setRows(res.success ? res.logs || [] : []);
  }, [pluginId]);
  useEffect(() => { load(); }, [load]);
  const color = (level: string) => (level === 'error' ? 'text-destructive' : level === 'warn' ? 'text-warning' : level === 'debug' ? 'text-subtle-foreground' : 'text-foreground/80');
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-subtle-foreground">300 dòng gần nhất (console.log của ứng dụng, lỗi, cảnh báo của Deplao).</p>
        <button type="button" className={btn.link} onClick={load}>Tải lại</button>
      </div>
      {rows === null ? (
        <div className="flex justify-center py-3"><Spinner size={4} /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-subtle-foreground py-4 text-center">Chưa có nhật ký.</p>
      ) : (
        <div className="bg-card border border-border rounded-lg p-2 max-h-[52vh] overflow-y-auto font-mono text-[11px] space-y-0.5">
          {rows.map(r => (
            <p key={r.id} className={`${color(r.level)} break-all`}>
              <span className="text-subtle-foreground">{fmtTime(r.created_at)}</span> [{r.level}] {r.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
