/**
 * App (plugin) management UI shared by the Apps page: the permission review screen at install, the settings form,
 * logs, the running-part status line, and the uninstall action.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ipc, { PluginInfo, PluginInstallPreview, PluginSettingsSchema } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, PluginIcon } from '@/components/common/icons';
import { AccountPicker, Badge, btn, ErrorBox, Field, fmtTime, inputCls, Section, Toggle } from '@/components/settings/api/apiUi';
import { useAccountOptions } from '@/components/settings/api/ApiKeysPanel';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export const STATUS: Record<PluginInfo['status'], { label: string; tone: 'green' | 'gray' | 'red' | 'yellow'; hint: string }> = {
  enabled: { label: tr('Đang bật'), tone: 'green', hint: tr('Ứng dụng đang chạy và hiện trong Deplao.') },
  disabled: { label: tr('Đang tắt'), tone: 'gray', hint: tr('Ứng dụng không chạy, không hiện trong Deplao. Dữ liệu vẫn giữ.') },
  invalid: { label: tr('Lỗi gói'), tone: 'red', hint: tr('Gói ứng dụng hỏng hoặc không hợp lệ với bản Deplao này.') },
  disabled_crash: { label: tr('Tắt do lỗi'), tone: 'red', hint: tr('Ứng dụng lỗi nhiều lần liên tiếp nên Deplao đã tự tắt nó.') },
};

export const RUNTIME: Record<PluginInfo['runtime'], { label: string; hint: string }> = {
  web: { label: tr('Chỉ giao diện'), hint: tr('Chỉ có giao diện chạy trong Deplao, không chạy code nền.') },
  local: { label: tr('Chạy trên máy'), hint: tr('Có phần chạy nền trên máy này, trong tiến trình riêng tách khỏi Deplao.') },
  remote: { label: tr('Dịch vụ ngoài'), hint: tr('Phần xử lý chạy trên server của nhà cung cấp; Deplao gọi tới qua HTTPS có chữ ký.') },
};

/** Uninstall an app: asks for confirmation, then asks whether to delete its data (like the old action in Settings). Returns true if uninstalled. */
export async function uninstallPlugin(p: PluginInfo, notify: (msg: string, kind: 'success' | 'error') => void): Promise<boolean> {
  const ok = await showConfirm({
    title: tr('Gỡ ứng dụng "{{name}}"?', { name: p.name }),
    message: p.source_type === 'dev'
      ? tr('Ứng dụng sẽ bị gỡ khỏi Deplao. Thư mục dev của bạn KHÔNG bị xoá.')
      : tr('Mã của ứng dụng sẽ bị xoá khỏi máy. Dữ liệu riêng của ứng dụng (lưu trữ, file, nhật ký) được giữ lại để cài lại sau.'),
    confirmText: tr('Gỡ'),
    variant: 'danger',
  });
  if (!ok) return false;
  const wipe = await showConfirm({
    title: tr('Xoá luôn dữ liệu của ứng dụng?'),
    message: tr('Chọn "Xoá dữ liệu" để xoá lưu trữ, file và nhật ký của ứng dụng. Không thể hoàn tác.'),
    confirmText: tr('Xoá dữ liệu'),
    cancelText: tr('Giữ dữ liệu'),
    variant: 'warning',
  });
  const res = await ipc.plugins!.uninstall(p.id, wipe);
  if (!res.success) { notify(res.error || tr('Gỡ ứng dụng thất bại'), 'error'); return false; }
  notify(tr('Đã gỡ {{name}}', { name: p.name }), 'success');
  return true;
}

/** Running-part status line: local process (PID, RAM) or remote server (connection). */
export function RuntimeLine({ stats }: { stats: NonNullable<PluginInfo['stats']> }) {
  const r = stats.remote;
  if (r) {
    return (
      <p className="text-[11px] text-subtle-foreground break-all">
        {trx('Server <0>{{v1}}</0> · ', { 0: <span className="font-mono text-muted-foreground" />, v1: r.baseUrl || '—' })}
        {r.connected === true && <span className="text-success">{tr('kết nối tốt')}</span>}
        {r.connected === false && <span className="text-destructive">{trx('không kết nối được{{v1}}', { v1: stats.lastError ? ` (${stats.lastError})` : '' })}</span>}
        {r.connected === null && <span>{tr('chưa gọi lần nào')}</span>}
        {r.lastOkAt ? tr(' · lần cuối OK {{v1}}', { v1: fmtTime(r.lastOkAt) }) : ''}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-subtle-foreground">
      {stats.running ? (stats.pid ? tr('Đang chạy (PID {{pid}})', { pid: stats.pid }) : tr('Đang chạy')) : tr('Không chạy')}
      {stats.memoryMb ? ` · ${stats.memoryMb} MB RAM` : ''}
      {stats.restarts ? tr(' · khởi động lại {{restarts}} lần', { restarts: stats.restarts }) : ''}
      {stats.lastError ? tr(' · lỗi gần nhất: {{lastError}}', { lastError: stats.lastError }) : ''}
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
    if (accountIds !== null && accountIds.length === 0) { setError(tr('Chọn ít nhất một tài khoản hoặc để "Tất cả tài khoản".')); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.plugins!.confirmInstall(preview.token, accountIds);
      if (!res.success) { setError(res.error || tr('Cài thất bại')); return; }
      onDone(m.name, res.remoteCredentials || null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={isUpdate ? tr('Cập nhật {{name}}: {{version}} → {{version1}}', { name: m.name, version: preview.existing!.version, version1: m.version }) : tr('Cài {{name}} {{version}}', { name: m.name, version: m.version })} icon={<PluginIcon className="w-4 h-4" />}>
      <div className="flex flex-wrap gap-1">
        <Badge tone="blue">{RUNTIME[m.runtime].label}</Badge>
        {preview.source === 'dev' && <Badge tone="yellow">{tr('Thư mục dev (chạy tại chỗ)')}</Badge>}
        {m.author && <Badge>{m.author}</Badge>}
      </div>
      {m.description && <p className="text-xs text-muted-foreground leading-relaxed">{m.description}</p>}
      {m.runtime === 'remote' && m.remote?.baseUrl && (
        <p className="text-[11px] text-muted-foreground">{trx('Server của ứng dụng: <0>{{baseUrl}}</0>', { 0: <span className="font-mono text-foreground/80" />, baseUrl: m.remote.baseUrl })}</p>
      )}
      {preview.hasBackend && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          <p className="text-xs text-destructive">{trx('<0/> Ứng dụng này chạy code trên máy bạn. Chỉ cài từ nguồn bạn tin cậy.', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground/80">{tr('Ứng dụng xin các quyền:')}</p>
        <ul className="space-y-0.5">
          {preview.permissions.map(perm => (
            <li key={perm.id} className={`text-xs ${perm.risky ? 'text-destructive' : 'text-foreground/80'}`}>
              • {perm.label} <span className="text-[10px] text-subtle-foreground font-mono">{perm.id}</span>
              {isUpdate && preview.newPermissions.includes(perm.id) && <Badge tone="yellow">{tr('mới')}</Badge>}
            </li>
          ))}
        </ul>
      </div>
      <Field label={tr('Tài khoản ứng dụng được dùng')}>
        <AccountPicker accounts={accounts} value={accountIds} onChange={setAccountIds} />
      </Field>
      {preview.readme && (
        <details className="bg-card rounded-lg px-3 py-2">
          <summary className="text-xs text-foreground/80 cursor-pointer">{tr('README của ứng dụng')}</summary>
          <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto font-sans">{preview.readme}</pre>
        </details>
      )}
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn.secondary} disabled={saving} onClick={onCancel}>{tr('Huỷ')}</button>
        <button type="button" className={btn.primary} disabled={saving} onClick={confirm}>{saving ? <Spinner size={3} /> : isUpdate ? tr('Cập nhật') : tr('Cài và bật')}</button>
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
      else setError(res.error || tr('Không đọc được cài đặt'));
      setLoading(false);
    })();
  }, [pluginId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.plugins!.setSettings(pluginId, values);
      if (!res.success) { setError(res.error || tr('Lưu thất bại')); return; }
      setValues(res.values || values);
      showNotification(tr('Đã lưu cài đặt ứng dụng'), 'success');
      window.dispatchEvent(new CustomEvent('plugins:settingsChanged', { detail: { pluginId, values: res.values } }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-3"><Spinner size={4} /></div>;
  if (!schema) return <p className="text-xs text-subtle-foreground">{tr('Ứng dụng không có cài đặt.')}</p>;

  return (
    <div className="space-y-3">
      <SettingsFields schema={schema} values={values} onChange={setValues} />
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <button type="button" className={btn.primary} disabled={saving} onClick={save}>{saving ? <Spinner size={3} /> : tr('Lưu cài đặt')}</button>
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
                placeholder={f['x-secret'] ? tr('Để trống nếu không đổi') : ''}
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
        <p className="text-[11px] text-subtle-foreground">{tr('300 dòng gần nhất (console.log của ứng dụng, lỗi, cảnh báo của Deplao).')}</p>
        <button type="button" className={btn.link} onClick={load}>{tr('Tải lại')}</button>
      </div>
      {rows === null ? (
        <div className="flex justify-center py-3"><Spinner size={4} /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-subtle-foreground py-4 text-center">{tr('Chưa có nhật ký.')}</p>
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
