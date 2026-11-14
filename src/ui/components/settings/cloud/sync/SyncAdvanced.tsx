/**
 * Data sync → Advanced (open by default, click the title to collapse):
 *  - Images & files: download in parallel, bandwidth limit, runs only 22:00–07:00 (media.setOptions, saved immediately on change);
 *    "Sau khi lưu lên R2" (After saving to R2): keep the files on the machine (default) / delete the copy on the machine of older files (days to keep, GB free);
 *    File cleanup on R2 (R2CleanupDialog: scan first, review, then delete) + re-download all cleaned files.
 *  - Standby machine (when this machine is not monitoring another machine - if it is, the card sits at the top of the section), DB copy on R2,
 *    sync log (read only when this section is open).
 * The wording uses the selected storage name (useStoreLabel: "R2" / "Google Drive").
 */
import React, { useEffect, useId, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { DownloadIcon, TrashIcon } from '@/components/common/icons';
import { Button, Card, Checkbox, FormField, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import type {
  DbSyncStatus,
  MediaSyncOptions,
  MediaSyncStatus,
  SyncLogEntry,
  SyncOverview,
} from '../../../../../shared/cloud/cloudContracts';
import { cloudApi, CloudSpinner, fmtNum, RadioList, useCloudAction, useStorageProvider, useStoreLabel } from '../cloudUi';
import { R2CleanupDialog } from './R2CleanupDialog';
import type { RestoreWizardOptions } from '../restore/RestoreWizard';
import { RemoteCopiesCard, remoteCopyRules, StandbyCard, SyncLogTable } from './syncParts';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface SyncAdvancedProps {
  /** Status with all fields filled in (overviewOrDefault). */
  overview: SyncOverview;
  ready: boolean;
  /** New media status from main (setOptions). */
  onMedia?: (status: MediaSyncStatus) => void;
  /** New DB status from main (turned on / off following). */
  onDb?: (status: DbSyncStatus) => void;
  onRefresh?: () => void;
  /** Open the restore wizard (standby machine → Switch to this machine). */
  onWizard: (options: RestoreWizardOptions) => void;
  /** The Standby machine card is already shown at the top of the section (this machine is monitoring another machine) → do not repeat it. */
  hideStandby?: boolean;
  /** Open by default when the page is entered (default on). */
  initialOpen?: boolean;
  /** Log read earlier (test). */
  initialLog?: SyncLogEntry[] | null;
}

const CONCURRENCY = [1, 2, 3, 4, 6, 8, 12, 16];

const LIMITS = {
  bandwidthKbps: [0, 1_000_000],
  evictKeepDays: [1, 3650],
  evictMinFreeGb: [1, 10_000],
} as const;

/** Number field: draft while typing, saved on leaving the field or on Enter; outside the allowed range it restores the old number. */
function NumberInput({ value, limits, label, id, disabled, className, onCommit, onInvalid }: {
  value: number;
  limits: readonly [number, number];
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  onCommit: (value: number) => void;
  onInvalid: (message: string) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const [min, max] = limits;

  const commit = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || n < min || n > max) {
      setText(String(value));
      onInvalid(tr('Nhập số từ {{v1}} đến {{v2}}', { v1: fmtNum(min), v2: fmtNum(max) }));
      return;
    }
    if (n !== value) onCommit(n);
  };

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={text}
      disabled={disabled}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('h-8 w-20 text-center', className)}
    />
  );
}

export function SyncAdvanced({
  overview,
  ready,
  onMedia,
  onDb,
  onRefresh,
  onWizard,
  hideStandby = false,
  initialOpen = true,
  initialLog = null,
}: SyncAdvancedProps) {
  const { config, db, media } = overview;
  const opts = media.options;
  const totals = media.totals;
  const label = useStoreLabel();
  const provider = useStorageProvider();
  const { busy, run, notify } = useCloudAction();
  const concurrencyId = useId();
  const bandwidthId = useId();
  const [open, setOpen] = useState(initialOpen);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  // Log: read only while this section is open, re-read each time a new sync happens.
  const [log, setLog] = useState<SyncLogEntry[] | null>(initialLog);
  const [logLimit, setLogLimit] = useState(20);
  const logKey = db.workspaces.map(w => `${w.workspaceId}:${w.lastSyncAt ?? 0}:${w.baseAt ?? 0}:${w.state}`).join('|');
  useEffect(() => {
    if (!open) return;
    const dbApi = cloudApi()?.db;
    if (!dbApi) return;
    let alive = true;
    dbApi.log({ limit: logLimit })
      .then(res => { if (alive && res?.success && Array.isArray(res.entries)) setLog(res.entries); })
      .catch(() => { if (alive) setLog(prev => prev ?? []); });
    return () => { alive = false; };
  }, [open, logKey, logLimit]);

  // Image & file options only take effect when the sync includes images.
  const mediaOff = !config.includeMedia;
  const optsDisabled = !ready || mediaOff || busy === 'options';
  const concurrencyChoices = CONCURRENCY.includes(opts.concurrency)
    ? CONCURRENCY
    : [...CONCURRENCY, opts.concurrency].sort((a, b) => a - b);

  const setOptions = async (patch: Partial<MediaSyncOptions>, okMessage?: string) => {
    const res = await run('options', () => cloudApi()?.media.setOptions(patch), okMessage);
    if (res?.status) onMedia?.(res.status);
    else if (res) onRefresh?.();
  };

  const warn = (message: string) => notify(message, 'warning');

  /** Keep the files on the machine (default) or delete the copy on the machine of older files (asks again before turning on). */
  const chooseEvict = async (on: boolean) => {
    if (on === opts.evictEnabled) return;
    if (on) {
      const ok = await showConfirm({
        title: tr('Xoá bản trên máy của file cũ?'),
        message: tr('Chỉ xoá bản trên máy của file đã có trên {{label}} và không mở trong {{v1}} ngày, khi ổ còn trống dưới {{v2}} GB. Mở lại thì tự tải về từ {{label}}.', { label, v1: fmtNum(opts.evictKeepDays), v2: fmtNum(opts.evictMinFreeGb) }),
        confirmText: tr('Xoá bản trên máy'),
        variant: 'warning',
      });
      if (!ok) return;
    }
    await setOptions({ evictEnabled: on }, on ? tr('Đã chọn xoá bản trên máy của file cũ') : tr('Đã chọn giữ nguyên file trên máy'));
  };

  const rehydrate = async () => {
    const ok = await showConfirm({
      title: tr('Tải lại toàn bộ file đã dọn?'),
      message: tr('{{v1}} file sẽ được tải từ {{label}} về máy này, cần đủ chỗ trống trên ổ.', { v1: fmtNum(totals.evicted), label }),
      confirmText: tr('Tải về máy'),
      variant: 'info',
    });
    if (!ok) return;
    if (await run('rehydrate', () => cloudApi()?.media.rehydrateAll(), tr('Đang tải file đã dọn về máy'))) onRefresh?.();
  };

  const { canDelete, tagOf } = remoteCopyRules(db);
  const wsNames = db.workspaces.length > 1
    ? new Map<string, string>(db.workspaces.map(w => [w.workspaceId, w.name] as [string, string]))
    : null;
  // R2 is called a bucket; Google Drive is a folder.
  const container = provider === 'gdrive' ? tr('Thư mục') : 'Bucket';
  const buckets = [
    db.bucket ? tr('{{container}} dữ liệu {{bucket}} · mã hoá trên máy trước khi tải lên', { container, bucket: db.bucket }) : null,
    media.bucket ? tr('{{container}} ảnh, file {{bucket}} · riêng tư', { container, bucket: media.bucket }) : null,
  ].filter((line): line is string => !!line);
  const afterSaveTitle = tr('Sau khi lưu lên {{label}}', { label });
  const cleanupTitle = tr('Dọn file trên {{label}}', { label });

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)} className="group rounded-xl border border-border bg-card">
      <summary className="cursor-pointer select-none rounded-xl px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/50">
        {trx('Nâng cao<0>{{v1}}</0>', { 0: <span className="ml-2 text-xs font-normal text-muted-foreground" />, v1: tr('tải ảnh, giữ file trên máy, dọn {{label}}, máy dự phòng, nhật ký', { label }) })}
      </summary>
      <div className="space-y-4 border-t border-border p-4">
        <Card className="divide-y divide-border px-4">
          <div className={cn('space-y-3 py-4', mediaOff && 'opacity-60')}>
            <div>
              <p className="text-sm font-semibold text-foreground">{tr('Tải ảnh & file')}</p>
              {mediaOff && <p className="mt-0.5 text-xs text-muted-foreground">{tr('Chỉ dùng khi đồng bộ kèm ảnh, video, file.')}</p>}
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <FormField label={tr('Tải song song')} htmlFor={concurrencyId} className="w-36">
                <Select
                  id={concurrencyId}
                  value={String(opts.concurrency)}
                  disabled={optsDisabled}
                  onChange={e => void setOptions({ concurrency: Number(e.target.value) })}
                >
                  {concurrencyChoices.map(n => <option key={n} value={n}>{tr('{{n}} file', { n })}</option>)}
                </Select>
              </FormField>
              <FormField label={tr('Giới hạn băng thông (Kbps)')} htmlFor={bandwidthId} hint={tr('0 = không giới hạn')}>
                <NumberInput
                  id={bandwidthId}
                  value={opts.bandwidthKbps}
                  limits={LIMITS.bandwidthKbps}
                  label={tr('Giới hạn băng thông (Kbps)')}
                  disabled={!ready || mediaOff}
                  className="w-32"
                  onCommit={n => void setOptions({ bandwidthKbps: n })}
                  onInvalid={warn}
                />
              </FormField>
            </div>
            <Checkbox
              checked={opts.nightOnly}
              disabled={optsDisabled}
              onCheckedChange={next => void setOptions({ nightOnly: next })}
              label={tr('Chỉ chạy từ 22:00 đến 07:00')}
            />
          </div>

          <div className={cn('space-y-3 py-4', mediaOff && 'opacity-60')}>
            <p className="text-sm font-semibold text-foreground">{afterSaveTitle}</p>
            <RadioList
              label={afterSaveTitle}
              value={opts.evictEnabled ? 'evict' : 'keep'}
              disabled={optsDisabled}
              onChange={next => void chooseEvict(next === 'evict')}
              options={[
                {
                  value: 'keep',
                  label: <>{trx('Giữ nguyên file trên máy <0>(mặc định)</0>', { 0: <span className="text-muted-foreground" /> })}</>,
                  description: tr('Không xoá gì trên máy; {{label}} giữ thêm một bản sao.', { label }),
                },
                {
                  value: 'evict',
                  label: tr('Xoá bản trên máy của file cũ để giải phóng ổ'),
                  description: tr('Chỉ xoá bản trên máy của file đã có trên {{label}}; mở lại thì tự tải về.', { label }),
                },
              ]}
            />
            {opts.evictEnabled && (
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2 pl-[26px] text-xs text-foreground">
                <span className="flex items-center gap-2">
                  {trx('Giữ file mở trong<0/>ngày gần đây', { 0: <NumberInput
                    value={opts.evictKeepDays}
                    limits={LIMITS.evictKeepDays}
                    label={tr('Số ngày giữ file trên máy')}
                    disabled={!ready || mediaOff}
                    onCommit={n => void setOptions({ evictKeepDays: n })}
                    onInvalid={warn}
                  /> })}
                </span>
                <span className="flex items-center gap-2">
                  {trx('Giữ ổ còn trống ít nhất<0/>GB', { 0: <NumberInput
                    value={opts.evictMinFreeGb}
                    limits={LIMITS.evictMinFreeGb}
                    label={tr('Số GB trống tối thiểu')}
                    disabled={!ready || mediaOff}
                    onCommit={n => void setOptions({ evictMinFreeGb: n })}
                    onInvalid={warn}
                  /> })}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-3 py-4">
            <div>
              <p className="text-sm font-semibold text-foreground">{cleanupTitle}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {tr('Xoá tin trong app vẫn giữ file trên {{label}}. Muốn bớt dung lượng thì dùng {{cleanupTitle}}.', { label, cleanupTitle })}
              </p>
            </div>
            {totals.evicted > 0 && (
              <p className="text-xs text-muted-foreground">{tr('Đã dọn {{v1}} file khỏi máy, vẫn mở được từ {{label}}.', { v1: fmtNum(totals.evicted), label })}</p>
            )}
            {/* Main only scans / cleans up / re-downloads while the image sync is running (needs the cloud_media index of the open workspace). */}
            {!media.enabled && (
              <p className="text-xs text-muted-foreground">{tr('Bật đồng bộ kèm ảnh, video, file để dùng các nút này.')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<TrashIcon className="h-4 w-4" />}
                disabled={!ready || !media.bucket || !media.enabled}
                onClick={() => setCleanupOpen(true)}
              >
                {cleanupTitle}
              </Button>
              {totals.evicted > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<DownloadIcon className="h-4 w-4" />}
                  loading={busy === 'rehydrate'}
                  disabled={!ready || !media.enabled}
                  onClick={() => void rehydrate()}
                >
                  {tr('Tải lại toàn bộ file đã dọn')}
                </Button>
              )}
            </div>
          </div>
        </Card>

        {!hideStandby && <StandbyCard status={db} ready={ready} onWizard={onWizard} onStatus={onDb} onRefresh={onRefresh} />}

        <RemoteCopiesCard ready={ready} canDelete={canDelete} tagOf={tagOf} />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{tr('Nhật ký đồng bộ')}</p>
            {log && log.length >= logLimit && logLimit < 200 && (
              <Button variant="link" size="sm" className="text-xs" onClick={() => setLogLimit(200)}>{tr('Xem tất cả')}</Button>
            )}
          </div>
          {!log ? (
            <p className="flex items-center gap-2 text-xs text-subtle-foreground">{trx('<0/> Đang tải…', { 0: <CloudSpinner className="h-3.5 w-3.5" /> })}</p>
          ) : log.length === 0 ? (
            <p className="text-xs text-subtle-foreground">{tr('Chưa có lần đồng bộ nào.')}</p>
          ) : (
            <SyncLogTable entries={log} workspaceNames={wsNames} />
          )}
        </div>

        <div className="space-y-0.5 border-t border-border pt-3 text-xs text-subtle-foreground">
          {buckets.map(line => <p key={line}>{line}</p>)}
          <p>{tr('Mỗi workspace của máy chủ có thư mục riêng trên {{label}}; máy nhân viên không tải lên.', { label })}</p>
        </div>
      </div>

      {cleanupOpen && (
        <R2CleanupDialog
          open
          onClose={() => setCleanupOpen(false)}
          onDone={() => onRefresh?.()}
          scope={config.scope}
          includeShared={config.includeShared}
        />
      )}
    </details>
  );
}

export default SyncAdvanced;
