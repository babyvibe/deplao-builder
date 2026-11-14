/**
 * CloudMediaSummary - one "Media trên đám mây" (Cloud media) line in Settings → Storage (server): how much has been uploaded to storage (R2 / Google Drive), how many
 * files were freed on the machine, and a link to Internet & Cloud → Data sync. If not turned on yet, it suggests setting it up.
 * Reads media.status() + storage.status() on open + when main reports a change (no polling). Old app builds without the module show
 * nothing; if no storage has been chosen yet → treated as R2 as before.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CloudIcon } from '@/components/common/icons';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { storageLabel, type CloudStorageProvider, type MediaSyncStatus } from '../../../../shared/cloud/cloudContracts';
import {
  cloudApi,
  fmtBytes,
  fmtNum,
  isMediaBackingOff,
  mediaDetail,
  navigateSettings,
  ProgressBar,
  useCloudChanged,
  useStorage,
} from './cloudUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export default function CloudMediaSummary({ className }: { className?: string }) {
  const [status, setStatus] = useState<MediaSyncStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const contextProvider = useStorage()?.provider ?? null;
  const [ownProvider, setOwnProvider] = useState<CloudStorageProvider | null>(null);
  const provider = ownProvider ?? contextProvider ?? 'r2';

  const load = useCallback(() => {
    const api = cloudApi();
    if (!api?.media?.status) { setLoaded(true); return; }
    api.media.status()
      .then(res => { if (res?.success && res.status) setStatus(res.status); })
      .catch(() => { /* old build / employee machine: hidden */ })
      .finally(() => setLoaded(true));
    if (typeof api.storage?.status === 'function') {
      api.storage.status()
        .then(res => { if (res?.success && res.storage) setOwnProvider(res.storage.provider); })
        .catch(() => { /* old build: treat as R2 */ });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useCloudChanged(areas => { if (areas.includes('media') || areas.includes('connection')) load(); }, 1500);

  if (!loaded || !cloudApi()) return null;

  const open = () => navigateSettings('cloud', 'sync');
  const t = status?.totals;

  if (!status?.enabled || !t) {
    return (
      <div className={cn('flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3', className)}>
        <CloudIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{tr('Media trên đám mây')}</p>
          <p className="text-xs text-muted-foreground">
            {tr('Chưa bật. Bật Đồng bộ dữ liệu kèm ảnh, video, file để có bản sao trên {{v1}} của bạn (tuỳ chọn giải phóng ổ máy).', { v1: provider === 'gdrive' ? 'Google Drive' : 'Cloudflare R2' })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={open}>{tr('Thiết lập →')}</Button>
      </div>
    );
  }

  const percent = t.files > 0 ? Math.round((t.uploaded / t.files) * 100) : 100;
  const detail = mediaDetail(status);
  return (
    <div className={cn('space-y-2 rounded-xl border border-border bg-card px-4 py-3', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <CloudIcon className="h-4 w-4 flex-shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{tr('Media trên đám mây')}</p>
          <p className="text-xs text-muted-foreground">
            {trx('Đã lên {{v1}} {{v2}} / {{v3}} file · {{v4}}{{v5}}', { v1: storageLabel(provider), v2: fmtNum(t.uploaded), v3: fmtNum(t.files), v4: fmtBytes(t.bytesUploaded), v5: t.evicted > 0 ? tr(' · đã giải phóng {{v1}} file trên máy', { v1: fmtNum(t.evicted) }) : '' })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={open}>{tr('Quản lý →')}</Button>
      </div>
      {t.files > 0 && percent < 100 && <ProgressBar value={percent} />}
      <p className={cn('text-xs', detail.tone === 'destructive' ? 'text-destructive' : detail.tone === 'warning' ? 'text-warning' : 'text-subtle-foreground')}>
        {status.lastError && !isMediaBackingOff(status) ? status.lastError : detail.text}
      </p>
    </div>
  );
}
