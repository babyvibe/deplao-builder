/**
 * "Đăng ký webhook tự động" (Auto-register webhook) on the KiotViet / Sapo integration page: Deplao calls the platform API to create a webhook pointing to the
 * receiving address (services/integrations/posWebhookRegistration.ts, runs on the owner machine; employee machines hand the work over to the owner).
 * KiotViet has no webhook admin screen, so this needs no technical person. The list shows every webhook of the shop:
 * Deplao's (current or old address) or another system's; removing another system's webhook must be confirmed again.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { AlertIcon, CheckIcon, RefreshIcon, TrashIcon, WebhookIcon } from '@/components/common/icons';
import {
  WEBHOOK_EVENT_OPTIONS, defaultWebhookEvents, webhookEventLabel,
  type PosWebhookListResponse, type PosWebhookView, type WebhookOwnership, type WebhookRegistrationType,
} from '../../../shared/integrations/posWebhookTopics';
import { tr } from '../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const OWNERSHIP: Record<WebhookOwnership, { label: string; className: string }> = {
  current: { label: tr('Deplao — đang nhận'), className: 'bg-success/15 text-success' },
  stale: { label: tr('Deplao — địa chỉ cũ'), className: 'bg-warning/15 text-warning' },
  other: { label: tr('Hệ thống khác'), className: 'bg-muted text-muted-foreground' },
};

const INTRO: Record<WebhookRegistrationType, string> = {
  kiotviet: tr('KiotViet không có màn hình quản trị webhook — Deplao đăng ký giúp qua API: tự tạo Webhook Secret (lưu vào ô Webhook Secret ở trên) và trỏ các sự kiện đã chọn về địa chỉ nhận webhook ở trên. Bấm lại bất cứ lúc nào để làm mới — webhook cũ của Deplao được thay, webhook của hệ thống khác giữ nguyên.'),
  sapo: tr('Deplao tạo webhook trên Sapo bằng ứng dụng riêng đã kết nối, trỏ về địa chỉ nhận webhook ở trên. Sapo ký webhook bằng API Secret nên không cần khoá riêng. Webhook đã đúng địa chỉ được giữ nguyên, địa chỉ cũ được sửa.'),
};

export default function WebhookRegistrationCard({ type, name, integrationId, onChanged }: {
  type: WebhookRegistrationType;
  name: string;
  /** Connection not saved yet → cannot register. */
  integrationId?: string;
  /** After registering (KiotViet just saved the Secret) → the page refreshes the Webhook security section. */
  onChanged?: () => void;
}) {
  const showNotification = useAppStore(s => s.showNotification);
  const [events, setEvents] = useState<string[]>(() => defaultWebhookEvents(type));
  const [state, setState] = useState<PosWebhookListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const api = ipc.integration;

  const load = useCallback(async () => {
    if (!integrationId || !api?.listWebhooks) return;
    setLoading(true);
    try {
      setState(await api.listWebhooks(integrationId));
    } catch (e: any) {
      setState({ success: false, error: e?.message || String(e), webhooks: [] });
    } finally {
      setLoading(false);
    }
  }, [integrationId, api]);

  useEffect(() => { void load(); }, [load]);

  const toggleEvent = (event: string) => {
    setEvents(prev => (prev.includes(event) ? prev.filter(item => item !== event) : [...prev, event]));
  };

  const register = async () => {
    if (!integrationId || !api?.registerWebhooks || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.registerWebhooks(integrationId, events);
      // Error before the list can be read (address not turned on yet…) → keep the list currently shown
      setState(prev => ({ ...res, webhooks: res.success || res.webhooks?.length ? res.webhooks || [] : prev?.webhooks || [] }));
      const done = (res.created?.length || 0) + (res.updated?.length || 0) + (res.kept?.length || 0);
      const notes = (res.notes || []).join('. ');
      const text = res.success
        ? tr('Đã đăng ký {{done}} sự kiện trên {{name}}{{v1}}', { done, name, v1: notes ? ` — ${notes}` : '' })
        : res.error || tr('Đăng ký webhook thất bại');
      setMessage({ ok: !!res.success, text });
      showNotification(text, res.success ? 'success' : 'error');
      onChanged?.();
    } catch (e: any) {
      const text = e?.message || String(e);
      setMessage({ ok: false, text });
      showNotification(text, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (webhook: PosWebhookView) => {
    if (!integrationId || !api?.removeWebhook || busy) return;
    const ok = await showConfirm({
      title: tr('Gỡ webhook'),
      message: webhook.ownership === 'other'
        ? tr('Webhook {{event}} trỏ tới {{url}} không phải của kết nối Deplao này — hệ thống đó sẽ ngừng nhận dữ liệu. Vẫn gỡ?', { event: webhook.event, url: webhook.url })
        : tr('Gỡ webhook {{event}} khỏi {{name}}? Workflow "Khi phần mềm bán hàng gửi webhook" sẽ không nhận sự kiện này nữa.', { event: webhook.event, name }),
      confirmText: tr('Gỡ'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.removeWebhook(integrationId, webhook.id);
      if (res.success || res.webhooks?.length) setState(res);
      showNotification(res.success ? tr('Đã gỡ webhook') : res.error || tr('Không gỡ được webhook'), res.success ? 'success' : 'error');
    } catch (e: any) {
      showNotification(e?.message || String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const address = state?.address;
  const webhooks = state?.webhooks || [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground/80">{trx('<0/> Đăng ký webhook tự động', { 0: <WebhookIcon className="w-4 h-4 inline" /> })}</h2>
        {integrationId && (
          <button type="button" onClick={() => { void load(); }} className="text-[11px] text-muted-foreground hover:text-foreground">
            {trx('<0/> Làm mới', { 0: <RefreshIcon className="w-3.5 h-3.5 inline" /> })}
          </button>
        )}
      </div>
      <div className="bg-card rounded-xl p-4 space-y-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{INTRO[type]}</p>

        {!integrationId ? (
          <p className="text-[11px] text-subtle-foreground">{trx('Bấm <0>Kết nối</0> để lưu kết nối trước, rồi quay lại đăng ký webhook.', { 0: <strong className="text-foreground" /> })}</p>
        ) : (
          <>
            {state && !address && (
              <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[11px] text-foreground">
                {trx('<0/> Chưa bật địa chỉ nhận webhook — bật <1>Thanh toán, tích hợp</1> ở Cài đặt → Internet & Cloud → Địa chỉ Internet rồi bấm Làm mới.', { 0: <AlertIcon className="w-4 h-4 inline text-warning" />, 1: <strong /> })}
              </div>
            )}
            {address && state?.temporary && (
              <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[11px] text-foreground">
                {trx('<0/> Đang dùng địa chỉ tạm (đổi mỗi lần khởi động lại Deplao) — sau mỗi lần mở lại phải bấm Đăng ký webhook để {{name}} gửi tới địa chỉ mới. Dùng Cloudflare tự động để có địa chỉ cố định.', { 0: <AlertIcon className="w-4 h-4 inline text-warning" />, name })}
              </div>
            )}

            <div>
              <p className="mb-1.5 text-[11px] font-medium text-foreground">{tr('Sự kiện gửi về Deplao')}</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {WEBHOOK_EVENT_OPTIONS[type].map(option => (
                  <label key={option.value} className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={events.includes(option.value)}
                      onChange={() => toggleEvent(option.value)}
                      className="h-3.5 w-3.5 accent-blue-600"
                    />
                    <span className="text-foreground">{option.label}</span>
                    <span className="font-mono text-[10px] text-subtle-foreground">{option.value}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void register(); }}
                disabled={busy || events.length === 0 || !address}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {busy ? tr('Đang xử lý...') : tr('Đăng ký webhook')}
              </button>
              {message && (
                <p className={`text-[11px] ${message.ok ? 'text-success' : 'text-destructive'}`}>
                  {message.ok ? <CheckIcon className="w-3.5 h-3.5 inline" /> : <AlertIcon className="w-3.5 h-3.5 inline" />} {message.text}
                </p>
              )}
            </div>

            {state?.success === false && state.error && !message && (
              <p className="text-[11px] text-destructive"><AlertIcon className="w-3.5 h-3.5 inline" /> {state.error}</p>
            )}

            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-foreground">{trx('Webhook đang có trên {{name}}', { name })}</p>
              {loading ? (
                <p className="text-[11px] text-subtle-foreground">{tr('Đang tải...')}</p>
              ) : webhooks.length === 0 ? (
                <p className="text-[11px] text-subtle-foreground">{tr('Chưa có webhook nào.')}</p>
              ) : webhooks.map(webhook => (
                <div key={webhook.id} className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-foreground">
                      {webhookEventLabel(type, webhook.event)} <span className="font-mono text-[10px] text-subtle-foreground">{webhook.event}</span>
                    </p>
                    <p className="truncate font-mono text-[10px] text-subtle-foreground" title={webhook.url}>{webhook.url}</p>
                  </div>
                  <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] ${OWNERSHIP[webhook.ownership].className}`}>
                    {OWNERSHIP[webhook.ownership].label}
                  </span>
                  <button
                    type="button"
                    onClick={() => { void remove(webhook); }}
                    disabled={busy}
                    title={tr('Gỡ webhook')}
                    className="flex-shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
