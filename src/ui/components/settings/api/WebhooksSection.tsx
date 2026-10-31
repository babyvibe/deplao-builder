/**
 * Phần Webhook của trang Ứng dụng, API & Webhook — gộp hai chiều dữ liệu cho dễ hiểu:
 *  - Nhận dữ liệu vào: hệ thống khác gửi vào Deplao (trước là Cài đặt → Webhooks).
 *  - Gửi sự kiện ra ngoài: Deplao báo sự kiện tới URL của bạn (trước là tab Webhook của API).
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

export type WebhookSub = 'inbound' | 'outbound';

const SUBS: Array<{ id: WebhookSub; label: string; direction: string; icon: React.ReactNode }> = [
  { id: 'inbound', label: 'Nhận dữ liệu vào', direction: 'Hệ thống khác → Deplao', icon: <DownloadIcon /> },
  { id: 'outbound', label: 'Gửi sự kiện ra ngoài', direction: 'Deplao → URL của bạn', icon: <SendIcon /> },
];

export default function WebhooksSection({ initial = 'inbound' }: { initial?: WebhookSub }) {
  const showNotification = useAppStore(s => s.showNotification);
  const setSection = useAppStore(s => s.setPluginHubSection);
  const [sub, setSub] = useState<WebhookSub>(initial);
  // Webhook gửi ra chạy cả khi API server tắt, chỉ dừng khi "Cho phép gọi API" bị tắt.
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
          <TabsList aria-label="Chiều dữ liệu">
            {SUBS.map(s => (
              <TabsTrigger key={s.id} value={s.id} icon={s.icon} title={s.direction}>
                {s.label}
                <span className="ml-1.5 hidden font-normal text-subtle-foreground lg:inline">· {s.direction}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {sub === 'outbound' && (
          <Button variant="ghost" size="sm" leftIcon={<BookIcon className="w-4 h-4" />} title="Định dạng sự kiện, kiểm tra chữ ký, thử lại" onClick={() => openDocs('#guide/webhooks', showNotification)}>
            Tài liệu webhook ↗
          </Button>
        )}
      </div>

      {sub === 'inbound' ? (
        <InboundWebhooksPanel />
      ) : !ipc.api ? (
        <ErrorBox message="Bản app này chưa có module API. Hãy cập nhật app." />
      ) : (
        <>
          {apiBlocked && (
            <div role="alert" className="flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground">
              <AlertIcon className="w-4 h-4 flex-shrink-0 text-warning" />
              <span>
                Đang tạm dừng gửi vì công tắc <strong>Cho phép gọi API</strong> đang tắt. Bật lại ở{' '}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setSection('api')}>API → Tổng quan</button>.
              </span>
            </div>
          )}
          <ApiWebhooksPanel />
        </>
      )}
    </div>
  );
}
