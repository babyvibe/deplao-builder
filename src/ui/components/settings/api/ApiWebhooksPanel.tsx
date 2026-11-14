/**
 * Webhook: Deplao POSTs events to your URL (signed with HMAC, retried automatically).
 * A webhook created here belongs to the app (receives all selected accounts, may point to the internal network).
 * Webhooks created by an API key also show up here so the machine owner can manage them.
 */
import { cn } from '@/lib/cn';
import React, { useCallback, useEffect, useState } from 'react';
import ipc, { ApiWebhookDelivery, ApiWebhookRecord } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { PlusIcon, WebhookIcon } from '@/components/common/icons';
import { AccountOption, AccountPicker, Badge, btn, ErrorBox, Field, fmtAgo, fmtTime, httpTone, inputCls, OneTimeSecret, Section, Toggle } from './apiUi';
import { useAccountOptions } from './ApiKeysPanel';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

type EventTypeInfo = { type: string; description: string; ephemeral?: boolean; global?: boolean };

export default function ApiWebhooksPanel() {
  const showNotification = useAppStore(s => s.showNotification);
  const accounts = useAccountOptions();
  const [hooks, setHooks] = useState<ApiWebhookRecord[]>([]);
  const [types, setTypes] = useState<EventTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [list, t] = await Promise.all([ipc.api!.listWebhooks(), ipc.api!.eventTypes()]);
      if (list.success) { setHooks(list.webhooks || []); setError(null); }
      else setError(list.error || tr('Không tải được webhook'));
      if (t.success) setTypes((t.types || []).filter(x => !x.ephemeral));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setActive = async (h: ApiWebhookRecord, active: boolean) => {
    const res = await ipc.api!.updateWebhook(h.id, { active });
    if (!res.success) showNotification(res.error || tr('Không cập nhật được'), 'error');
    load();
  };

  const remove = async (h: ApiWebhookRecord) => {
    const ok = await showConfirm({
      title: tr('Xoá webhook "{{v1}}"?', { v1: h.name || h.url }),
      message: tr('Lịch sử gửi của webhook cũng bị xoá.'),
      confirmText: tr('Xoá'),
      variant: 'danger',
    });
    if (!ok) return;
    const res = await ipc.api!.deleteWebhook(h.id);
    if (!res.success) showNotification(res.error || tr('Xoá thất bại'), 'error');
    if (openId === h.id) setOpenId(null);
    load();
  };

  const test = async (h: ApiWebhookRecord) => {
    setTesting(h.id);
    try {
      const res = await ipc.api!.testWebhook(h.id);
      const r = res.result;
      const text = !res.success
        ? res.error || tr('Lỗi')
        : r?.ok
          ? tr('Thành công: HTTP {{status}} trong {{took_ms}} ms', { status: r.status, took_ms: r.took_ms })
          : tr('Thất bại: {{v1}}{{v2}}', { v1: r?.error || `HTTP ${r?.status}`, v2: r?.body ? ` · ${r.body.slice(0, 120)}` : '' });
      setTestResult(prev => ({ ...prev, [h.id]: text }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground leading-relaxed">
        {trx('Deplao gửi sự kiện (tin nhắn mới, kết bạn, thanh toán…) tới URL của bạn ngay khi có, kèm chữ ký<0>X-Deplao-Signature</0> để kiểm tra. Lỗi thì tự thử lại sau 30 giây, 2 phút, 10 phút, 1 giờ, 6 giờ.', { 0: <code className="mx-1 text-success" /> })}
      </p>

      {created && (
        <OneTimeSecret title={tr('Secret của webhook "{{name}}"', { name: created.name })} value={created.secret} onDone={() => setCreated(null)} />
      )}

      {creating ? (
        <WebhookForm
          types={types}
          accounts={accounts}
          onCancel={() => setCreating(false)}
          onCreated={(name, secret) => {
            setCreating(false);
            setCreated({ name, secret });
            load();
          }}
        />
      ) : (
        <div className="flex justify-end">
          <button type="button" className={btn.primary} onClick={() => setCreating(true)}>
            {trx('<0/>Thêm webhook', { 0: <PlusIcon className="w-3.5 h-3.5 inline mr-1" /> })}
          </button>
        </div>
      )}

      <ErrorBox message={error} />
      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <WebhookList
          hooks={hooks}
          openId={openId}
          testing={testing}
          testResult={testResult}
          onToggleOpen={id => setOpenId(prev => (prev === id ? null : id))}
          onActive={setActive}
          onTest={test}
          onRemove={remove}
        />
      )}
    </div>
  );
}

export function WebhookList({ hooks, openId, testing, testResult, onToggleOpen, onActive, onTest, onRemove }: {
  hooks: ApiWebhookRecord[];
  openId: string | null;
  testing: string | null;
  testResult: Record<string, string>;
  onToggleOpen: (id: string) => void;
  onActive: (h: ApiWebhookRecord, active: boolean) => void;
  onTest: (h: ApiWebhookRecord) => void;
  onRemove: (h: ApiWebhookRecord) => void;
}) {
  if (hooks.length === 0) {
    return (
      <Section title={tr('Chưa có webhook')} icon={<WebhookIcon className="w-4 h-4" />}>
        <p className="text-xs text-muted-foreground">{tr('Thêm URL nhận sự kiện (n8n, Make, server riêng…). Hệ thống ngoài cũng có thể tự đăng ký qua API.')}</p>
      </Section>
    );
  }
  return (
    <div className="space-y-2">
      {hooks.map(h => (
        <div key={h.id} className="bg-card rounded-xl p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{h.name || h.url}</p>
              <p className="text-[11px] text-muted-foreground font-mono break-all">{h.url}</p>
            </div>
            <Toggle checked={h.active} onChange={next => onActive(h, next)} title={h.active ? tr('Đang bật') : tr('Đang tắt')} />
          </div>
          <div className="flex flex-wrap gap-1">
            {h.events.map(e => <Badge key={e} tone="blue">{e}</Badge>)}
            <Badge>{h.owner === 'app' ? tr('tạo trong Deplao') : h.owner.startsWith('plugin:') ? tr('ứng dụng: {{v1}}', { v1: h.owner.slice(7) }) : tr('key: {{owner}}', { owner: h.owner })}</Badge>
            {h.account_ids && <Badge>{trx('{{count}} tài khoản', { count: h.account_ids.length })}</Badge>}
            {h.consecutive_failures > 0 && <Badge tone="yellow">{trx('{{consecutive_failures}} lỗi liên tiếp', { consecutive_failures: h.consecutive_failures })}</Badge>}
          </div>
          {h.disabled_reason && <p className="text-[11px] text-destructive">{trx('{{disabled_reason}}. Sửa server nhận rồi bật lại.', { disabled_reason: h.disabled_reason })}</p>}
          <p className="text-[11px] text-subtle-foreground">{trx('Gửi thành công gần nhất: {{v1}}', { v1: fmtAgo(h.last_delivery_at) })}</p>
          {testResult[h.id] && <p className="text-[11px] text-primary">{testResult[h.id]}</p>}
          <div className="flex gap-3 justify-end">
            <button type="button" className={btn.link} disabled={testing === h.id} onClick={() => onTest(h)}>
              {testing === h.id ? tr('Đang gửi…') : tr('Gửi thử')}
            </button>
            <button type="button" className={btn.link} onClick={() => onToggleOpen(h.id)}>{openId === h.id ? tr('Ẩn lịch sử') : tr('Lịch sử gửi')}</button>
            <button type="button" className="text-xs text-destructive hover:text-destructive/80" onClick={() => onRemove(h)}>{tr('Xoá')}</button>
          </div>
          {openId === h.id && <Deliveries webhookId={h.id} />}
        </div>
      ))}
    </div>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const [rows, setRows] = useState<ApiWebhookDelivery[] | null>(null);
  const [status, setStatus] = useState<'' | 'pending' | 'delivered' | 'failed'>('');

  const load = useCallback(async () => {
    const res = await ipc.api!.webhookDeliveries(webhookId, status || undefined, 50);
    setRows(res.success ? res.deliveries || [] : []);
  }, [webhookId, status]);

  useEffect(() => { load(); }, [load]);

  const retry = async (d: ApiWebhookDelivery) => {
    await ipc.api!.retryDelivery(d.id);
    setTimeout(load, 800);
  };

  return (
    <div className="bg-muted rounded-lg p-2 space-y-2">
      <div className="flex items-center gap-2">
        <select className={cn(inputCls, 'w-auto min-w-[180px]')} value={status} onChange={e => setStatus(e.target.value as any)}>
          <option value="">{tr('Tất cả')}</option>
          <option value="pending">{tr('Đang chờ thử lại')}</option>
          <option value="delivered">{tr('Thành công')}</option>
          <option value="failed">{tr('Thất bại')}</option>
        </select>
        <button type="button" className={btn.link} onClick={load}>{tr('Tải lại')}</button>
      </div>
      {rows === null ? (
        <div className="flex justify-center py-3"><Spinner size={4} /></div>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-subtle-foreground px-1">{tr('Chưa có lần gửi nào.')}</p>
      ) : (
        <DeliveryTable rows={rows} onRetry={retry} />
      )}
    </div>
  );
}

export function DeliveryTable({ rows, onRetry }: { rows: ApiWebhookDelivery[]; onRetry: (d: ApiWebhookDelivery) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-subtle-foreground text-left">
            <th className="py-1 pr-2 font-medium">{tr('Thời gian')}</th>
            <th className="py-1 pr-2 font-medium">{tr('Sự kiện')}</th>
            <th className="py-1 pr-2 font-medium">{tr('Lần')}</th>
            <th className="py-1 pr-2 font-medium">{tr('Kết quả')}</th>
            <th className="py-1 pr-2 font-medium">{tr('Lỗi')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(d => (
            <tr key={d.id} className="border-t border-border/60 text-foreground/80 align-top">
              <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(d.created_at)}</td>
              <td className="py-1 pr-2 font-mono">{d.event_type}</td>
              <td className="py-1 pr-2">{d.attempt}</td>
              <td className="py-1 pr-2">
                {d.status === 'delivered' && <Badge tone="green">HTTP {d.response_status}</Badge>}
                {d.status === 'pending' && <Badge tone="yellow" title={d.next_retry_at ? tr('Thử lại lúc {{v1}}', { v1: fmtTime(d.next_retry_at) }) : ''}>{tr('chờ thử lại')}</Badge>}
                {d.status === 'failed' && <Badge tone={httpTone(d.response_status)}>{tr('thất bại')}</Badge>}
              </td>
              <td className="py-1 pr-2 text-muted-foreground break-all">{d.error || ''}</td>
              <td className="py-1 text-right whitespace-nowrap">
                {d.status !== 'delivered' && <button type="button" className={btn.link} onClick={() => onRetry(d)}>{tr('Gửi lại')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WebhookForm({ types, accounts, onCancel, onCreated }: {
  types: EventTypeInfo[];
  accounts: AccountOption[];
  onCancel: () => void;
  onCreated: (name: string, secret: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [allEvents, setAllEvents] = useState(false);
  const [events, setEvents] = useState<Set<string>>(() => new Set(['message.received']));
  const [accountIds, setAccountIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (t: string) => {
    setEvents(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const submit = async () => {
    if (!/^https?:\/\//i.test(url.trim())) { setError(tr('URL phải bắt đầu bằng https:// (hoặc http:// trong mạng nội bộ).')); return; }
    if (!allEvents && events.size === 0) { setError(tr('Chọn ít nhất một loại sự kiện.')); return; }
    if (accountIds !== null && accountIds.length === 0) { setError(tr('Chọn ít nhất một tài khoản hoặc để "Tất cả tài khoản".')); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await ipc.api!.createWebhook({
        name: name.trim(),
        url: url.trim(),
        events: allEvents ? ['*'] : Array.from(events),
        accountIds,
      });
      if (res.success && res.secret) onCreated(name.trim() || url.trim(), res.secret);
      else setError(res.error || tr('Không tạo được webhook'));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={tr('Thêm webhook')} icon={<WebhookIcon className="w-4 h-4" />}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={tr('Tên')}>
          <input className={inputCls} value={name} maxLength={100} placeholder={tr('n8n đơn hàng')} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label={tr('URL nhận')}>
          <input className={`${inputCls} font-mono`} value={url} placeholder="https://n8n.example.com/webhook/deplao" onChange={e => setUrl(e.target.value)} />
        </Field>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground/80 cursor-pointer">
          <input type="checkbox" checked={allEvents} onChange={e => setAllEvents(e.target.checked)} /> {tr('Mọi sự kiện')}
        </label>
        {!allEvents && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1 max-h-56 overflow-y-auto rounded-lg border border-border p-2">
            {types.map(t => (
              <label key={t.type} className="flex items-start gap-2 text-xs text-foreground/80 cursor-pointer" title={t.description}>
                <input type="checkbox" className="mt-0.5" checked={events.has(t.type)} onChange={() => toggle(t.type)} />
                <span>
                  <span className="font-mono">{t.type}</span>
                  <span className="block text-[10px] text-subtle-foreground leading-snug">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <Field label={tr('Tài khoản')}>
        <AccountPicker accounts={accounts} value={accountIds} onChange={setAccountIds} />
      </Field>
      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onCancel} disabled={saving}>{tr('Huỷ')}</button>
        <button type="button" className={btn.primary} onClick={submit} disabled={saving}>{saving ? <Spinner size={3} /> : tr('Tạo webhook')}</button>
      </div>
    </Section>
  );
}
