/**
 * CloudMediaSummary — một dòng "Media trên đám mây" ở Cài đặt → Lưu trữ (máy chủ): đã lên kho (R2 / Google Drive) bao
 * nhiêu, đã giải phóng bao nhiêu file trên máy, link sang Internet & Đám mây → Đồng bộ dữ liệu. Chưa bật thì gợi ý thiết lập.
 * Đọc media.status() + storage.status() khi mở + khi main báo đổi (không chu kỳ). Bản app cũ không có module → không
 * hiện gì; chưa có chọn kho → coi là R2 như trước.
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
      .catch(() => { /* bản cũ / máy nhân viên: ẩn */ })
      .finally(() => setLoaded(true));
    if (typeof api.storage?.status === 'function') {
      api.storage.status()
        .then(res => { if (res?.success && res.storage) setOwnProvider(res.storage.provider); })
        .catch(() => { /* bản cũ: coi như R2 */ });
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
          <p className="text-sm font-medium text-foreground">Media trên đám mây</p>
          <p className="text-xs text-muted-foreground">
            {`Chưa bật. Bật Đồng bộ dữ liệu kèm ảnh, video, file để có bản sao trên ${provider === 'gdrive' ? 'Google Drive' : 'Cloudflare R2'} của bạn (tuỳ chọn giải phóng ổ máy).`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={open}>Thiết lập →</Button>
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
          <p className="text-sm font-medium text-foreground">Media trên đám mây</p>
          <p className="text-xs text-muted-foreground">
            Đã lên {storageLabel(provider)} {fmtNum(t.uploaded)} / {fmtNum(t.files)} file · {fmtBytes(t.bytesUploaded)}
            {t.evicted > 0 ? ` · đã giải phóng ${fmtNum(t.evicted)} file trên máy` : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={open}>Quản lý →</Button>
      </div>
      {t.files > 0 && percent < 100 && <ProgressBar value={percent} />}
      <p className={cn('text-xs', detail.tone === 'destructive' ? 'text-destructive' : detail.tone === 'warning' ? 'text-warning' : 'text-subtle-foreground')}>
        {status.lastError && !isMediaBackingOff(status) ? status.lastError : detail.text}
      </p>
    </div>
  );
}
