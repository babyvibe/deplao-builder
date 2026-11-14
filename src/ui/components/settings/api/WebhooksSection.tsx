/**
 * The Webhook section of the Apps, API & Webhook page: both directions of data in one place, to make it easier to understand:
 *  - Incoming data: other systems send data into Deplao (previously Settings → Webhooks).
 *  - Outgoing events: Deplao reports events to your URL (previously the Webhook tab of the API).
 */
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { AlertIcon, BookIcon, DownloadIcon, SendIcon } from '@/components/common/icons';
import { Button, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { openDocs } from '@/components/plugins/hub/PluginDevPanel';
import { ErrorBox } from './apiUi';
import InboundWebhooksPanel from './InboundWebhooksPanel';
import ApiWebhooksPanel from './ApiWebhooksPanel';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export type WebhookSub = 'inbound' | 'outbound';

const SUBS: Array<{ id: WebhookSub; label: string; direction: string; icon: React.ReactNode }> = [
  { id: 'inbound', label: tr('Nhận dữ liệu vào'), direction: tr('Hệ thống khác → Deplao'), icon: <DownloadIcon /> },
  { id: 'outbound', label: tr('Gửi sự kiện ra ngoài'), direction: tr('Deplao → URL của bạn'), icon: <SendIcon /> },
];

export default function WebhooksSection({ initial = 'inbound' }: { initial?: WebhookSub }) {
  const showNotification = useAppStore(s => s.showNotification);
  const setSection = useAppStore(s => s.setPluginHubSection);
  const [sub, setSub] = useState<WebhookSub>(initial);
  // Outgoing webhooks keep running even when the API server is off; they only stop when "Cho phép gọi API" (Allow API calls) is turned off.
  const [apiBlocked, setApiBlocked] = useState(false);

  useEffect(() => {
    if (sub !== 'outbound' || !ipc.api) return;
    let alive = true;
    ipc.api.status()
      .then(res => { if (alive && res?.success) setApiBlocked(res.settings?.api_enabled === '0'); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [sub]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={sub} onValueChange={v => setSub(v as WebhookSub)}>
          <TabsList aria-label={tr('Chiều dữ liệu')}>
            {SUBS.map(s => (
              <TabsTrigger key={s.id} value={s.id} icon={s.icon} title={s.direction}>
                {s.label}
                <span className="ml-1.5 hidden font-normal text-subtle-foreground lg:inline">· {s.direction}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {sub === 'outbound' && (
          <Button variant="ghost" size="sm" leftIcon={<BookIcon className="w-4 h-4" />} title={tr('Định dạng sự kiện, kiểm tra chữ ký, thử lại')} onClick={() => openDocs('#guide/webhooks', showNotification)}>
            {tr('Tài liệu webhook ↗')}
          </Button>
        )}
      </div>

      {sub === 'inbound' ? (
        <InboundWebhooksPanel />
      ) : !ipc.api ? (
        <ErrorBox message={tr('Bản app này chưa có module API. Hãy cập nhật app.')} />
      ) : (
        <>
          {apiBlocked && (
            <div role="alert" className="flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground">
              <AlertIcon className="w-4 h-4 flex-shrink-0 text-warning" />
              <span>
                {trx('Đang tạm dừng gửi vì công tắc <0>Cho phép gọi API</0> đang tắt. Bật lại ở ', { 0: <strong /> })}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setSection('api')}>{tr('API → Tổng quan')}</button>.
              </span>
            </div>
          )}
          <ApiWebhooksPanel />
        </>
      )}
    </div>
  );
}
