/**
 * The API section of the Tools → Apps, API & Webhook page: server, remote access, API keys, logs, advanced settings.
 * (Previously under Settings → API; outgoing webhook events are now in the Webhook section of the page.)
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
import { tr } from '../../../../shared/i18n';

export type ApiSubTab = 'overview' | 'keys' | 'logs' | 'advanced';

const TABS: Array<{ id: ApiSubTab; label: string }> = [
  { id: 'overview', label: tr('Tổng quan') },
  { id: 'keys', label: tr('API key') },
  { id: 'logs', label: tr('Nhật ký') },
  { id: 'advanced', label: tr('Nâng cao') },
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
        setError(res?.error || tr('Không đọc được trạng thái API'));
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Only the Overview tab needs live numbers; light IPC, every 5 seconds.
  useEffect(() => {
    if (sub !== 'overview') return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [sub, refresh]);

  if (!ipc.api) {
    return <ErrorBox message={tr('Bản app này chưa có module API. Hãy cập nhật app.')} />;
  }

  return (
    <div className="space-y-4">
      <Tabs value={sub} onValueChange={v => setSub(v as ApiSubTab)}>
        <TabsList aria-label={tr('Mục API')}>
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
