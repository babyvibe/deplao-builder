/**
 * "Đăng ký webhook tự động" trong trang tích hợp KiotViet / Sapo: Deplao gọi API của nền tảng để tạo webhook trỏ về địa
 * chỉ nhận webhook (services/integrations/posWebhookRegistration.ts, chạy trên Boss — máy nhân viên chuyển lên Boss).
 * KiotViet không có màn hình quản trị webhook nên đây là cách không cần người kỹ thuật. Danh sách hiện mọi webhook của cửa
 * hàng: của Deplao (đúng / cũ địa chỉ) hay của hệ thống khác; gỡ webhook của hệ thống khác phải xác nhận lại.
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

const OWNERSHIP: Record<WebhookOwnership, { label: string; className: string }> = {
  current: { label: 'Deplao — đang nhận', className: 'bg-success/15 text-success' },
  stale: { label: 'Deplao — địa chỉ cũ', className: 'bg-warning/15 text-warning' },
  other: { label: 'Hệ thống khác', className: 'bg-muted text-muted-foreground' },
};

const INTRO: Record<WebhookRegistrationType, string> = {
  kiotviet: 'KiotViet không có màn hình quản trị webhook — Deplao đăng ký giúp qua API: tự tạo Webhook Secret (lưu vào ô Webhook Secret ở trên) và trỏ các sự kiện đã chọn về địa chỉ nhận webhook ở trên. Bấm lại bất cứ lúc nào để làm mới — webhook cũ của Deplao được thay, webhook của hệ thống khác giữ nguyên.',
  sapo: 'Deplao tạo webhook trên Sapo bằng ứng dụng riêng đã kết nối, trỏ về địa chỉ nhận webhook ở trên. Sapo ký webhook bằng API Secret nên không cần khoá riêng. Webhook đã đúng địa chỉ được giữ nguyên, địa chỉ cũ được sửa.',
};

export default function WebhookRegistrationCard({ type, name, integrationId, onChanged }: {
  type: WebhookRegistrationType;
  name: string;
  /** Chưa lưu kết nối → chưa đăng ký được. */
  integrationId?: string;
  /** Sau khi đăng ký (KiotViet vừa lưu Secret) → trang làm mới mục Bảo mật webhook. */
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
      // Lỗi trước khi đọc được danh sách (chưa bật địa chỉ…) → giữ danh sách đang hiện
      setState(prev => ({ ...res, webhooks: res.success || res.webhooks?.length ? res.webhooks || [] : prev?.webhooks || [] }));
      const done = (res.created?.length || 0) + (res.updated?.length || 0) + (res.kept?.length || 0);
      const notes = (res.notes || []).join('. ');
      const text = res.success
        ? `Đã đăng ký ${done} sự kiện trên ${name}${notes ? ` — ${notes}` : ''}`
        : res.error || 'Đăng ký webhook thất bại';
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
      title: 'Gỡ webhook',
      message: webhook.ownership === 'other'
        ? `Webhook ${webhook.event} trỏ tới ${webhook.url} không phải của kết nối Deplao này — hệ thống đó sẽ ngừng nhận dữ liệu. Vẫn gỡ?`
        : `Gỡ webhook ${webhook.event} khỏi ${name}? Workflow "Khi phần mềm bán hàng gửi webhook" sẽ không nhận sự kiện này nữa.`,
      confirmText: 'Gỡ',
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.removeWebhook(integrationId, webhook.id);
      if (res.success || res.webhooks?.length) setState(res);
      showNotification(res.success ? 'Đã gỡ webhook' : res.error || 'Không gỡ được webhook', res.success ? 'success' : 'error');
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
        <h2 className="text-sm font-semibold text-foreground/80"><WebhookIcon className="w-4 h-4 inline" /> Đăng ký webhook tự động</h2>
        {integrationId && (
          <button type="button" onClick={() => { void load(); }} className="text-[11px] text-muted-foreground hover:text-foreground">
            <RefreshIcon className="w-3.5 h-3.5 inline" /> Làm mới
          </button>
        )}
      </div>
      <div className="bg-card rounded-xl p-4 space-y-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{INTRO[type]}</p>

        {!integrationId ? (
          <p className="text-[11px] text-subtle-foreground">Bấm <strong className="text-foreground">Kết nối</strong> để lưu kết nối trước, rồi quay lại đăng ký webhook.</p>
        ) : (
          <>
            {state && !address && (
              <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[11px] text-foreground">
                <AlertIcon className="w-4 h-4 inline text-warning" /> Chưa bật địa chỉ nhận webhook — bật <strong>Thanh toán, tích hợp</strong> ở
                Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet rồi bấm Làm mới.
              </div>
            )}
            {address && state?.temporary && (
              <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[11px] text-foreground">
                <AlertIcon className="w-4 h-4 inline text-warning" /> Đang dùng địa chỉ tạm (đổi mỗi lần khởi động lại Deplao) — sau mỗi lần
                mở lại phải bấm Đăng ký webhook để {name} gửi tới địa chỉ mới. Dùng Cloudflare tự động để có địa chỉ cố định.
              </div>
            )}

            <div>
              <p className="mb-1.5 text-[11px] font-medium text-foreground">Sự kiện gửi về Deplao</p>
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
                {busy ? 'Đang xử lý...' : 'Đăng ký webhook'}
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
              <p className="text-[11px] font-medium text-foreground">Webhook đang có trên {name}</p>
              {loading ? (
                <p className="text-[11px] text-subtle-foreground">Đang tải...</p>
              ) : webhooks.length === 0 ? (
                <p className="text-[11px] text-subtle-foreground">Chưa có webhook nào.</p>
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
                    title="Gỡ webhook"
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
