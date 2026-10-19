/**
 * Cài đặt → Internet & Đám mây → Lưu media: bật R2, theo dõi đẩy dữ liệu cũ (tạm dừng / tiếp tục), chỉ chạy ban đêm,
 * song song + băng thông (Nâng cao), "Giải phóng ổ máy" (chỉ xoá bản trên máy của file đã lên R2) và cách xoá.
 * Chưa kết nối Cloudflare / chưa bật R2 / thiếu quyền → hiện lý do, các điều khiển bị khoá.
 */
import React, { useEffect, useId, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { DownloadIcon, ExternalLinkIcon, PauseIcon, PlayIcon } from '@/components/common/icons';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Select,
  Switch,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CloudConnectionStatus, MediaSyncOptions, MediaSyncStatus } from '../../../../shared/cloudContracts';
import {
  cloudApi,
  fmtBytes,
  fmtBytesPair,
  fmtNum,
  fmtUsd,
  isR2Ready,
  mediaDetail,
  Notice,
  openExternalUrl,
  ProgressBar,
  r2BucketUrl,
  r2MonthlyUsd,
  R2RequiredNotice,
  useCloudAction,
} from './cloudUi';

export interface MediaSectionProps {
  connection: CloudConnectionStatus | null;
  status: MediaSyncStatus | null;
  /** Trạng thái mới từ main (setEnabled / setOptions). */
  onStatus?: (status: MediaSyncStatus) => void;
  onRefresh?: () => void;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
}

const DEFAULT_OPTIONS: MediaSyncOptions = {
  concurrency: 3,
  nightOnly: false,
  bandwidthKbps: 0,
  evictEnabled: false,
  evictKeepDays: 30,
  evictMinFreeGb: 20,
};

const EMPTY_TOTALS: MediaSyncStatus['totals'] = { files: 0, uploaded: 0, pending: 0, failed: 0, evicted: 0, bytesTotal: 0, bytesUploaded: 0 };

type NumberKey = 'evictKeepDays' | 'evictMinFreeGb' | 'bandwidthKbps';
const NUMBER_LIMITS: Record<NumberKey, [number, number]> = {
  evictKeepDays: [1, 3650],
  evictMinFreeGb: [1, 10_000],
  bandwidthKbps: [0, 1_000_000],
};

export default function MediaSection({ connection, status, onStatus, onRefresh, onConnect, onRecheck, rechecking }: MediaSectionProps) {
  const { busy, run, notify } = useCloudAction();
  const concurrencyId = useId();
  const bandwidthId = useId();
  const ready = isR2Ready(connection);
  const enabled = !!status?.enabled;
  const opts = status?.options ?? DEFAULT_OPTIONS;
  const totals = status?.totals ?? EMPTY_TOTALS;
  const [offOpen, setOffOpen] = useState(false);

  // Ô số: nháp khi gõ, lưu khi rời ô hoặc Enter.
  const [draft, setDraft] = useState<Record<NumberKey, string>>({
    evictKeepDays: String(opts.evictKeepDays),
    evictMinFreeGb: String(opts.evictMinFreeGb),
    bandwidthKbps: String(opts.bandwidthKbps),
  });
  useEffect(() => {
    setDraft({
      evictKeepDays: String(opts.evictKeepDays),
      evictMinFreeGb: String(opts.evictMinFreeGb),
      bandwidthKbps: String(opts.bandwidthKbps),
    });
  }, [opts.evictKeepDays, opts.evictMinFreeGb, opts.bandwidthKbps]);

  const applyStatus = (res: { status?: MediaSyncStatus } | null) => {
    if (res?.status) onStatus?.(res.status);
    else if (res) onRefresh?.();
  };

  const setOptions = async (patch: Partial<MediaSyncOptions>, okMessage?: string) => {
    applyStatus(await run('options', () => cloudApi()?.media.setOptions(patch), okMessage));
  };

  const commitNumber = (key: NumberKey) => {
    const [min, max] = NUMBER_LIMITS[key];
    const n = Math.round(Number(draft[key]));
    if (!Number.isFinite(n) || n < min || n > max) {
      setDraft(prev => ({ ...prev, [key]: String(opts[key]) }));
      notify(`Nhập số từ ${fmtNum(min)} đến ${fmtNum(max)}`, 'warning');
      return;
    }
    if (n !== opts[key]) void setOptions({ [key]: n } as Partial<MediaSyncOptions>);
  };

  const numberInput = (key: NumberKey, props: { id?: string; disabled: boolean; className?: string; label: string }) => (
    <Input
      id={props.id}
      type="number"
      inputMode="numeric"
      min={NUMBER_LIMITS[key][0]}
      max={NUMBER_LIMITS[key][1]}
      aria-label={props.label}
      value={draft[key]}
      disabled={props.disabled}
      onChange={e => setDraft(prev => ({ ...prev, [key]: e.target.value }))}
      onBlur={() => commitNumber(key)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('h-8 w-20 text-center', props.className)}
    />
  );

  const toggleEnabled = async (next: boolean) => {
    if (!next) { setOffOpen(true); return; }
    applyStatus(await run('enable', () => cloudApi()?.media.setEnabled(true), 'Đã bật lưu media. File cũ sẽ được tải dần lên R2.'));
  };

  const turnOff = async () => {
    const res = await run('enable', () => cloudApi()?.media.setEnabled(false), 'Đã tắt lưu media');
    if (res) setOffOpen(false);
    applyStatus(res);
  };

  const pause = async () => { if (await run('pause', () => cloudApi()?.media.pause())) onRefresh?.(); };
  const resume = async () => { if (await run('resume', () => cloudApi()?.media.resume())) onRefresh?.(); };

  const rehydrate = async () => {
    const ok = await showConfirm({
      title: 'Tải hết file đã dọn về máy?',
      message: `${fmtNum(totals.evicted)} file sẽ được tải từ R2 về máy này, cần đủ chỗ trống trên ổ.`,
      confirmText: 'Tải về máy',
      variant: 'info',
    });
    if (!ok) return;
    if (await run('rehydrate', () => cloudApi()?.media.rehydrateAll(), 'Đang tải file đã dọn về máy')) onRefresh?.();
  };

  const cost = r2MonthlyUsd(totals.bytesUploaded);
  const controlsDisabled = !ready || !enabled;
  const detail = status ? mediaDetail(status) : null;
  const pct = totals.files > 0 ? (totals.uploaded / totals.files) * 100 : 0;

  return (
    <div className="space-y-4">
      <R2RequiredNotice connection={connection} onConnect={onConnect} onRecheck={onRecheck} rechecking={rechecking} />

      <Card className={cn('space-y-4 p-4', !ready && 'opacity-60')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Lưu media lên Cloudflare R2</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status?.bucket ? `Bucket ${status.bucket} · riêng tư` : 'Deplao tạo một bucket riêng tư khi bật lần đầu.'}
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={!ready || busy === 'enable'}
            onCheckedChange={next => void toggleEnabled(next)}
            aria-label={enabled ? 'Tắt lưu media lên R2' : 'Bật lưu media lên R2'}
          />
        </div>

        {status && (enabled || totals.files > 0) && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm font-semibold text-foreground">
              Đã lên {fmtNum(totals.uploaded)} / {fmtNum(totals.files)} file · {fmtBytesPair(totals.bytesUploaded, totals.bytesTotal)}
            </p>
            <ProgressBar value={pct} tone={status.lastError ? 'warning' : 'primary'} label="Tiến độ tải media lên R2" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {detail && (
                <p className={cn('text-xs', detail.tone === 'warning' ? 'text-warning' : detail.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
                  {detail.text}
                </p>
              )}
              {enabled && (status.paused ? (
                <Button size="sm" variant="outline" leftIcon={<PlayIcon className="h-4 w-4" />} loading={busy === 'resume'} disabled={!ready} onClick={() => void resume()}>
                  Tiếp tục
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<PauseIcon className="h-4 w-4" />}
                  loading={busy === 'pause'}
                  disabled={!ready || (!status.running && totals.pending === 0)}
                  onClick={() => void pause()}
                >
                  Tạm dừng
                </Button>
              ))}
            </div>
            {status.lastError && <p className="text-xs text-destructive">{status.lastError}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Checkbox
            checked={opts.nightOnly}
            disabled={controlsDisabled || busy === 'options'}
            onCheckedChange={next => void setOptions({ nightOnly: next })}
            label="Chỉ chạy từ 22:00 đến 07:00"
          />
          <span className="text-xs text-muted-foreground">
            Song song {opts.concurrency} file · {opts.bandwidthKbps > 0 ? `tối đa ${fmtNum(opts.bandwidthKbps)} Kbps` : 'không giới hạn băng thông'}
          </span>
        </div>

        <details className="rounded-lg bg-muted/60 px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-foreground">Nâng cao</summary>
          <div className="mt-3 flex flex-wrap items-end gap-4 pb-1">
            <FormField label="Tải song song" htmlFor={concurrencyId} className="w-36">
              <Select
                id={concurrencyId}
                value={String(opts.concurrency)}
                disabled={controlsDisabled || busy === 'options'}
                onChange={e => void setOptions({ concurrency: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} file</option>)}
              </Select>
            </FormField>
            <FormField label="Giới hạn băng thông (Kbps)" htmlFor={bandwidthId} hint="0 = không giới hạn">
              {numberInput('bandwidthKbps', { id: bandwidthId, disabled: controlsDisabled, className: 'w-32', label: 'Giới hạn băng thông (Kbps)' })}
            </FormField>
          </div>
        </details>
      </Card>

      <Card className={cn('space-y-3 p-4', controlsDisabled && 'opacity-60')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Giải phóng ổ máy</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Chỉ xoá bản trên máy của file đã lên R2. File vẫn mở được, tự tải về khi cần.</p>
          </div>
          <Switch
            checked={opts.evictEnabled}
            disabled={controlsDisabled || busy === 'options'}
            onCheckedChange={next => void setOptions({ evictEnabled: next }, next ? 'Đã bật giải phóng ổ máy' : 'Đã tắt giải phóng ổ máy')}
            aria-label="Giải phóng ổ máy"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xs text-foreground">
          <span className="flex items-center gap-2">
            Giữ file mở trong {numberInput('evictKeepDays', { disabled: controlsDisabled || !opts.evictEnabled, label: 'Số ngày giữ file trên máy' })} ngày gần đây
          </span>
          <span className="flex items-center gap-2">
            Giữ ổ còn trống ít nhất {numberInput('evictMinFreeGb', { disabled: controlsDisabled || !opts.evictEnabled, label: 'Số GB trống tối thiểu' })} GB
          </span>
        </div>
        {totals.evicted > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span>Đã dọn {fmtNum(totals.evicted)} file khỏi máy, vẫn mở được từ R2.</span>
            <Button size="sm" variant="ghost" leftIcon={<DownloadIcon className="h-4 w-4" />} loading={busy === 'rehydrate'} disabled={!ready} onClick={() => void rehydrate()}>
              Tải hết về máy
            </Button>
          </div>
        )}
      </Card>

      <Notice tone="info">
        <p>Xoá tin trong app vẫn giữ file trên R2; công cụ dọn file trên R2 sẽ có ở bản sau.</p>
      </Notice>

      <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Dung lượng R2: {fmtBytes(totals.bytesUploaded)} · {cost > 0 ? `ước tính ${fmtUsd(cost)} USD/tháng` : 'trong phần miễn phí 10 GB'}
          </span>
          {status?.bucket && (
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
              onClick={() => openExternalUrl(r2BucketUrl(connection?.accountId, status.bucket!))}
            >
              Mở bucket trên Cloudflare
            </Button>
          )}
        </div>
        <p className="text-subtle-foreground">Mỗi workspace của máy chủ có thư mục riêng trên R2; máy nhân viên không tải lên.</p>
      </div>

      {offOpen && (
      <Dialog open onOpenChange={open => { if (!open && busy !== 'enable') setOffOpen(false); }} size="sm">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>Tắt lưu media?</DialogTitle>
            <DialogDescription>File mới sẽ không được tải lên R2. File đã lên R2 vẫn còn.</DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        {totals.evicted > 0 && (
          <DialogBody>
            <Notice tone="warning">
              <p>
                {fmtNum(totals.evicted)} file đã dọn khỏi máy và chỉ còn trên R2. Tắt luôn thì các file này không mở được
                cho tới khi bật lại. Nên tải về máy trước.
              </p>
            </Notice>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOffOpen(false)} disabled={busy === 'enable'}>Huỷ</Button>
          {totals.evicted > 0 && (
            <Button variant="outline" onClick={() => { setOffOpen(false); void rehydrate(); }}>Tải về máy trước</Button>
          )}
          <Button variant="destructive" loading={busy === 'enable'} onClick={() => void turnOff()}>Tắt lưu media</Button>
        </DialogFooter>
      </Dialog>
      )}
    </div>
  );
}
