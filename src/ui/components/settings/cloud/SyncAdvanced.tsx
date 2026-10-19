/**
 * Đồng bộ dữ liệu → Nâng cao (mở sẵn mặc định, bấm tiêu đề để thu gọn):
 *  - Ảnh & file: tải song song, giới hạn băng thông, chỉ chạy 22:00–07:00 (media.setOptions, lưu ngay khi đổi);
 *    "Sau khi lưu lên R2": giữ nguyên file trên máy (mặc định) / xoá bản trên máy của file cũ (số ngày giữ, GB trống);
 *    Dọn file trên R2 (R2CleanupDialog: quét trước, xem rồi mới xoá) + Tải lại toàn bộ file đã dọn.
 *  - Máy dự phòng (khi máy này chưa theo dõi máy khác — đang theo dõi thì thẻ nằm ở đầu phần), Bản sao DB trên R2,
 *    Nhật ký đồng bộ (chỉ đọc khi mở phần này).
 * Câu chữ dùng tên kho đang chọn (useStoreLabel: "R2" / "Google Drive").
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
} from '../../../../shared/cloudContracts';
import { cloudApi, CloudSpinner, fmtNum, RadioList, useCloudAction, useStorageProvider, useStoreLabel } from './cloudUi';
import { R2CleanupDialog } from './R2CleanupDialog';
import type { RestoreWizardOptions } from './RestoreWizard';
import { RemoteCopiesCard, remoteCopyRules, StandbyCard, SyncLogTable } from './syncParts';

export interface SyncAdvancedProps {
  /** Trạng thái đủ trường (overviewOrDefault). */
  overview: SyncOverview;
  ready: boolean;
  /** Trạng thái media mới từ main (setOptions). */
  onMedia?: (status: MediaSyncStatus) => void;
  /** Trạng thái DB mới từ main (bật / tắt theo dõi). */
  onDb?: (status: DbSyncStatus) => void;
  onRefresh?: () => void;
  /** Mở trình khôi phục (máy dự phòng → Chuyển sang máy này). */
  onWizard: (options: RestoreWizardOptions) => void;
  /** Thẻ Máy dự phòng đã hiện ở đầu phần (máy này đang theo dõi máy khác) → không lặp lại. */
  hideStandby?: boolean;
  /** Mở sẵn khi vào trang (mặc định có). */
  initialOpen?: boolean;
  /** Nhật ký đã đọc trước (test). */
  initialLog?: SyncLogEntry[] | null;
}

const CONCURRENCY = [1, 2, 3, 4, 6, 8, 12, 16];

const LIMITS = {
  bandwidthKbps: [0, 1_000_000],
  evictKeepDays: [1, 3650],
  evictMinFreeGb: [1, 10_000],
} as const;

/** Ô số: nháp khi gõ, lưu khi rời ô hoặc Enter; ngoài khoảng cho phép thì trả lại số cũ. */
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
      onInvalid(`Nhập số từ ${fmtNum(min)} đến ${fmtNum(max)}`);
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

  // Nhật ký: chỉ đọc khi phần này đang mở, đọc lại mỗi khi có lần đồng bộ mới.
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

  // Tuỳ chọn ảnh & file chỉ có tác dụng khi đồng bộ kèm ảnh.
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

  /** Giữ nguyên file trên máy (mặc định) hay xoá bản trên máy của file cũ (hỏi lại trước khi bật). */
  const chooseEvict = async (on: boolean) => {
    if (on === opts.evictEnabled) return;
    if (on) {
      const ok = await showConfirm({
        title: 'Xoá bản trên máy của file cũ?',
        message: `Chỉ xoá bản trên máy của file đã có trên ${label} và không mở trong ${fmtNum(opts.evictKeepDays)} ngày, khi ổ còn trống dưới ${fmtNum(opts.evictMinFreeGb)} GB. Mở lại thì tự tải về từ ${label}.`,
        confirmText: 'Xoá bản trên máy',
        variant: 'warning',
      });
      if (!ok) return;
    }
    await setOptions({ evictEnabled: on }, on ? 'Đã chọn xoá bản trên máy của file cũ' : 'Đã chọn giữ nguyên file trên máy');
  };

  const rehydrate = async () => {
    const ok = await showConfirm({
      title: 'Tải lại toàn bộ file đã dọn?',
      message: `${fmtNum(totals.evicted)} file sẽ được tải từ ${label} về máy này, cần đủ chỗ trống trên ổ.`,
      confirmText: 'Tải về máy',
      variant: 'info',
    });
    if (!ok) return;
    if (await run('rehydrate', () => cloudApi()?.media.rehydrateAll(), 'Đang tải file đã dọn về máy')) onRefresh?.();
  };

  const { canDelete, tagOf } = remoteCopyRules(db);
  const wsNames = db.workspaces.length > 1
    ? new Map<string, string>(db.workspaces.map(w => [w.workspaceId, w.name] as [string, string]))
    : null;
  // R2 gọi là bucket; Google Drive là thư mục.
  const container = provider === 'gdrive' ? 'Thư mục' : 'Bucket';
  const buckets = [
    db.bucket ? `${container} dữ liệu ${db.bucket} · mã hoá trên máy trước khi tải lên` : null,
    media.bucket ? `${container} ảnh, file ${media.bucket} · riêng tư` : null,
  ].filter((line): line is string => !!line);
  const afterSaveTitle = `Sau khi lưu lên ${label}`;
  const cleanupTitle = `Dọn file trên ${label}`;

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)} className="group rounded-xl border border-border bg-card">
      <summary className="cursor-pointer select-none rounded-xl px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/50">
        Nâng cao
        <span className="ml-2 text-xs font-normal text-muted-foreground">{`tải ảnh, giữ file trên máy, dọn ${label}, máy dự phòng, nhật ký`}</span>
      </summary>
      <div className="space-y-4 border-t border-border p-4">
        <Card className="divide-y divide-border px-4">
          <div className={cn('space-y-3 py-4', mediaOff && 'opacity-60')}>
            <div>
              <p className="text-sm font-semibold text-foreground">Tải ảnh &amp; file</p>
              {mediaOff && <p className="mt-0.5 text-xs text-muted-foreground">Chỉ dùng khi đồng bộ kèm ảnh, video, file.</p>}
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <FormField label="Tải song song" htmlFor={concurrencyId} className="w-36">
                <Select
                  id={concurrencyId}
                  value={String(opts.concurrency)}
                  disabled={optsDisabled}
                  onChange={e => void setOptions({ concurrency: Number(e.target.value) })}
                >
                  {concurrencyChoices.map(n => <option key={n} value={n}>{n} file</option>)}
                </Select>
              </FormField>
              <FormField label="Giới hạn băng thông (Kbps)" htmlFor={bandwidthId} hint="0 = không giới hạn">
                <NumberInput
                  id={bandwidthId}
                  value={opts.bandwidthKbps}
                  limits={LIMITS.bandwidthKbps}
                  label="Giới hạn băng thông (Kbps)"
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
              label="Chỉ chạy từ 22:00 đến 07:00"
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
                  label: <>Giữ nguyên file trên máy <span className="text-muted-foreground">(mặc định)</span></>,
                  description: `Không xoá gì trên máy; ${label} giữ thêm một bản sao.`,
                },
                {
                  value: 'evict',
                  label: 'Xoá bản trên máy của file cũ để giải phóng ổ',
                  description: `Chỉ xoá bản trên máy của file đã có trên ${label}; mở lại thì tự tải về.`,
                },
              ]}
            />
            {opts.evictEnabled && (
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2 pl-[26px] text-xs text-foreground">
                <span className="flex items-center gap-2">
                  Giữ file mở trong
                  <NumberInput
                    value={opts.evictKeepDays}
                    limits={LIMITS.evictKeepDays}
                    label="Số ngày giữ file trên máy"
                    disabled={!ready || mediaOff}
                    onCommit={n => void setOptions({ evictKeepDays: n })}
                    onInvalid={warn}
                  />
                  ngày gần đây
                </span>
                <span className="flex items-center gap-2">
                  Giữ ổ còn trống ít nhất
                  <NumberInput
                    value={opts.evictMinFreeGb}
                    limits={LIMITS.evictMinFreeGb}
                    label="Số GB trống tối thiểu"
                    disabled={!ready || mediaOff}
                    onCommit={n => void setOptions({ evictMinFreeGb: n })}
                    onInvalid={warn}
                  />
                  GB
                </span>
              </div>
            )}
          </div>

          <div className="space-y-3 py-4">
            <div>
              <p className="text-sm font-semibold text-foreground">{cleanupTitle}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {`Xoá tin trong app vẫn giữ file trên ${label}. Muốn bớt dung lượng thì dùng ${cleanupTitle}.`}
              </p>
            </div>
            {totals.evicted > 0 && (
              <p className="text-xs text-muted-foreground">{`Đã dọn ${fmtNum(totals.evicted)} file khỏi máy, vẫn mở được từ ${label}.`}</p>
            )}
            {/* Main chỉ quét / dọn / tải lại khi đồng bộ ảnh đang chạy (cần chỉ mục cloud_media của workspace đang mở). */}
            {!media.enabled && (
              <p className="text-xs text-muted-foreground">Bật đồng bộ kèm ảnh, video, file để dùng các nút này.</p>
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
                  Tải lại toàn bộ file đã dọn
                </Button>
              )}
            </div>
          </div>
        </Card>

        {!hideStandby && <StandbyCard status={db} ready={ready} onWizard={onWizard} onStatus={onDb} onRefresh={onRefresh} />}

        <RemoteCopiesCard ready={ready} canDelete={canDelete} tagOf={tagOf} />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Nhật ký đồng bộ</p>
            {log && log.length >= logLimit && logLimit < 200 && (
              <Button variant="link" size="sm" className="text-xs" onClick={() => setLogLimit(200)}>Xem tất cả</Button>
            )}
          </div>
          {!log ? (
            <p className="flex items-center gap-2 text-xs text-subtle-foreground"><CloudSpinner className="h-3.5 w-3.5" /> Đang tải…</p>
          ) : log.length === 0 ? (
            <p className="text-xs text-subtle-foreground">Chưa có lần đồng bộ nào.</p>
          ) : (
            <SyncLogTable entries={log} workspaceNames={wsNames} />
          )}
        </div>

        <div className="space-y-0.5 border-t border-border pt-3 text-xs text-subtle-foreground">
          {buckets.map(line => <p key={line}>{line}</p>)}
          <p>{`Mỗi workspace của máy chủ có thư mục riêng trên ${label}; máy nhân viên không tải lên.`}</p>
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
