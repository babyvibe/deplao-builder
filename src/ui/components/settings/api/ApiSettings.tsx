/**
 * Phần API của trang Công cụ → Ứng dụng, API & Webhook: server, truy cập từ xa, API key, nhật ký, cài đặt nâng cao.
 * (Trước nằm ở Cài đặt → API; webhook gửi sự kiện ra ngoài nay ở phần Webhook của trang.)
 */
import React, { useCallback, useEffect, useState } from 'react';
import ipc, { ApiStatusResult } from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { ErrorBox } from './apiUi';
import ApiOverviewPanel from './ApiOverviewPanel';
import ApiKeysPanel from './ApiKeysPanel';
import ApiLogsPanel from './ApiLogsPanel';
import ApiAdvancedPanel from './ApiAdvancedPanel';

export type ApiSubTab = 'overview' | 'keys' | 'logs' | 'advanced';

const TABS: Array<{ id: ApiSubTab; label: string }> = [
  { id: 'overview', label: 'Tổng quan' },
  { id: 'keys', label: 'API key' },
  { id: 'logs', label: 'Nhật ký' },
  { id: 'advanced', label: 'Nâng cao' },
];

export default function ApiSettings() {
  const [sub, setSub] = useState<ApiSubTab>('overview');
  const [status, setStatus] = useState<ApiStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ipc.api) return;
    try {
      const res = await ipc.api.status();
      if (res?.success) {
        setStatus(res);
        setError(null);
      } else {
        setError(res?.error || 'Không đọc được trạng thái API');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Chỉ tab Tổng quan cần số liệu sống; IPC nhẹ, 5 giây/lần.
  useEffect(() => {
    if (sub !== 'overview') return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [sub, refresh]);

  if (!ipc.api) {
    return <ErrorBox message="Bản app này chưa có module API. Hãy cập nhật app." />;
  }

  return (
    <div className="space-y-4">
      <Tabs value={sub} onValueChange={v => setSub(v as ApiSubTab)}>
        <TabsList aria-label="Mục API">
          {TABS.map(t => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <ErrorBox message={error} />
      {loading || !status ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <>
          {sub === 'overview' && <ApiOverviewPanel status={status} onRefresh={refresh} />}
          {sub === 'keys' && <ApiKeysPanel scopes={status.scopes || []} presets={status.presets || {}} />}
          {sub === 'logs' && <ApiLogsPanel />}
          {sub === 'advanced' && <ApiAdvancedPanel settings={status.settings || {}} defaults={status.defaults || {}} onSaved={refresh} />}
        </>
      )}
    </div>
  );
}
