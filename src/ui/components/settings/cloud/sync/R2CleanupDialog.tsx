/**
 * Clean up files on R2 (Settings → Internet & Cloud → Data sync → Advanced). Deleting messages in the app does NOT delete them on
 * R2; this box is how to free up R2 space, always scanning first before deleting:
 *  1 Pick the files to clean: deleted messages · of an account · older than a date · outside the saved scope (OR), with safety options
 *    (by default keeps files that exist only on R2, does not delete copies on the machine) → Scan = media.cleanupPreview (deletes nothing).
 *  2 Scan result: number of files, size, per criterion, examples → "Xoá N file trên R2" (Delete N files on R2) (asks again) = media.cleanupRun.
 *  3 Delete result.
 * Scan / delete progress comes from CLOUD_CLEANUP_PROGRESS_EVENT. A scan result expires after 15 minutes (PREVIEW_EXPIRED → scan again).
 * R2CleanupPanel (body + button) is split from the Dialog so rendering can be tested on the server side.
 * Used for the selected storage: the wording builds in the storage name (useStoreLabel: "R2" / "Google Drive"), the component name stays the same.
 */
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { TrashIcon } from '@/components/common/icons';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  CLOUD_CLEANUP_PROGRESS_EVENT,
  isAllScope,
  normalizeScope,
  type CloudScope,
  type R2CleanupPreview,
  type R2CleanupProgress,
  type R2CleanupRequest,
  type R2CleanupResult,
} from '../../../../../shared/cloud/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  describeScope,
  fmtBytes,
  fmtDate,
  fmtHm,
  fmtNum,
  Notice,
  ProgressBar,
  useStoreLabel,
  type ScopeAccount,
} from '../cloudUi';
import { AccountChecklist, DateField, useScopeAccounts } from './ScopePicker';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── Choices in step 1 ──────────────────────────────────────────────────────────────────

export interface R2CleanupForm {
  /** Files of the messages deleted in the app. */
  orphans: boolean;
  byAccounts: boolean;
  accounts: string[];
  byDate: boolean;
  olderThanTs: number | null;
  outOfScope: boolean;
  /** Allow deleting even files that exist only on R2 (permanently lost). */
  includeCloudOnly: boolean;
  /** Also delete the copy on the machine of the deleted messages. */
  deleteLocalOrphans: boolean;
}

/** Default: only the files of deleted messages; keep files that exist only on R2; delete nothing on the machine. */
export const DEFAULT_CLEANUP_FORM: R2CleanupForm = {
  orphans: true,
  byAccounts: false,
  accounts: [],
  byDate: false,
  olderThanTs: null,
  outOfScope: false,
  includeCloudOnly: false,
  deleteLocalOrphans: false,
};

/** Reason the scan cannot run yet; null = can scan. */
export function cleanupFormProblem(form: R2CleanupForm): string | null {
  if (!form.orphans && !form.byAccounts && !form.byDate && !form.outOfScope) return tr('Chọn ít nhất một loại file cần dọn.');
  if (form.byAccounts && form.accounts.length === 0) return tr('Chọn ít nhất một tài khoản.');
  if (form.byDate && !form.olderThanTs) return tr('Chọn ngày.');
  return null;
}

export function cleanupRequest(form: R2CleanupForm): R2CleanupRequest {
  return {
    orphans: form.orphans,
    accounts: form.byAccounts ? [...form.accounts] : undefined,
    olderThanTs: form.byDate ? form.olderThanTs : null,
    outOfScope: form.outOfScope,
    includeCloudOnly: form.includeCloudOnly,
    deleteLocalOrphans: form.orphans && form.deleteLocalOrphans,
  };
}

/** Suggested date for "File cũ hơn ngày…" (Files older than…): the 1st of the month 12 months ago (00:00 local time). */
export function defaultCleanupBefore(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - 12, 1).getTime();
}

function Criterion({ checked, onChange, label, description, disabled, children }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} label={label} description={description} />
      {children ? <div className="space-y-2 pl-6">{children}</div> : null}
    </div>
  );
}

/** Step 1: pick the files to clean + the safety option. */
export function R2CleanupOptions({ form, onChange, accounts, scopeText, scopeIsAll = false, disabled = false }: {
  form: R2CleanupForm;
  onChange: (next: R2CleanupForm) => void;
  accounts: ReadonlyArray<ScopeAccount>;
  /** Summary sentence of the current media storage scope. */
  scopeText?: string;
  /** Saving everything (no files outside the scope). */
  scopeIsAll?: boolean;
  disabled?: boolean;
}) {
  const label = useStoreLabel();
  const set = (patch: Partial<R2CleanupForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{tr('Chọn file cần dọn')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr('Chọn ít nhất một loại. Chỉ xét file của workspace đang mở; quét chỉ đếm file, chưa xoá gì.')}
          </p>
        </div>

        <Criterion
          checked={form.orphans}
          disabled={disabled}
          onChange={orphans => set({ orphans })}
          label={tr('File của tin đã xoá trong app')}
          description={tr('File không còn tin nhắn, ghim hay thư viện nào dùng tới.')}
        >
          {form.orphans && (
            <Checkbox
              checked={form.deleteLocalOrphans}
              disabled={disabled}
              onCheckedChange={deleteLocalOrphans => set({ deleteLocalOrphans })}
              label={tr('Xoá luôn bản trên máy của tin đã xoá')}
              description={tr('Mặc định giữ bản trên máy.')}
            />
          )}
        </Criterion>

        <Criterion
          checked={form.byAccounts}
          disabled={disabled}
          onChange={byAccounts => set({ byAccounts })}
          label={tr('File của tài khoản…')}
          description={tr('Toàn bộ file của các tài khoản chọn dưới đây.')}
        >
          {form.byAccounts && (
            <>
              <AccountChecklist accounts={accounts} selected={form.accounts} disabled={disabled} onChange={ids => set({ accounts: ids })} />
              <p className="text-xs text-subtle-foreground">
                {tr('Danh sách chỉ có tài khoản đang có trong app; tài khoản đã gỡ khỏi app có thể không có ở đây.')}
              </p>
            </>
          )}
        </Criterion>

        <Criterion
          checked={form.byDate}
          disabled={disabled}
          onChange={byDate => set({ byDate, olderThanTs: byDate ? (form.olderThanTs ?? defaultCleanupBefore()) : form.olderThanTs })}
          label={tr('File cũ hơn ngày…')}
        >
          {form.byDate && (
            <DateField label={tr('Cũ hơn ngày')} value={form.olderThanTs} disabled={disabled} onChange={olderThanTs => set({ olderThanTs })} />
          )}
        </Criterion>

        <Criterion
          checked={form.outOfScope && !scopeIsAll}
          disabled={disabled || scopeIsAll}
          onChange={outOfScope => set({ outOfScope })}
          label={tr('File ngoài phạm vi lưu hiện tại')}
          description={scopeIsAll
            ? tr('Đang lưu tất cả nên không có file ngoài phạm vi.')
            : tr('Phạm vi lưu hiện tại: {{v1}}.', { v1: scopeText || tr('đã giới hạn') })}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-semibold text-foreground">{tr('An toàn')}</p>
        <div className={cn('rounded-lg border p-3', form.includeCloudOnly ? 'border-destructive/50 bg-destructive/10' : 'border-destructive/30')}>
          <Checkbox
            checked={form.includeCloudOnly}
            disabled={disabled}
            onCheckedChange={includeCloudOnly => set({ includeCloudOnly })}
            label={<span className="text-destructive">{tr('Xoá cả file chỉ còn trên {{label}} (đã dọn khỏi máy) — mất hẳn', { label })}</span>}
            description={tr('Mặc định giữ lại: các file này không còn bản nào trên máy.')}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Steps 2, 3 ─────────────────────────────────────────────────────────────────────────

/** Step 2: scan result (nothing deleted yet). */
export function R2CleanupPreviewView({ preview, request }: { preview: R2CleanupPreview; request?: R2CleanupRequest | null }) {
  const label = useStoreLabel();
  const byReason = preview.byReason ?? { orphans: 0, accounts: 0, olderThan: 0, outOfScope: 0 };
  const reasons = [
    { key: 'orphans', label: tr('Của tin đã xoá trong app'), count: byReason.orphans, on: !!request?.orphans },
    { key: 'accounts', label: tr('Của tài khoản đã chọn'), count: byReason.accounts, on: !!request?.accounts?.length },
    {
      key: 'olderThan',
      label: request?.olderThanTs ? tr('Cũ hơn ngày {{v1}}', { v1: fmtDate(request.olderThanTs) }) : tr('Cũ hơn ngày đã chọn'),
      count: byReason.olderThan,
      on: !!request?.olderThanTs,
    },
    { key: 'outOfScope', label: tr('Ngoài phạm vi lưu hiện tại'), count: byReason.outOfScope, on: !!request?.outOfScope },
  ].filter(r => r.on || r.count > 0);
  const samples = preview.samples ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-foreground">{tr('Kết quả quét')}</p>
      {preview.files === 0 ? (
        <Notice tone="info" title={tr('Không có file nào cần dọn')}>
          <p>{tr('Không có file nào trên {{label}} khớp lựa chọn. Quay lại để chọn loại khác.', { label })}</p>
        </Notice>
      ) : (
        <>
          <div className="rounded-xl border border-border p-4">
            <p className="text-lg font-semibold tabular-nums text-foreground">{trx('{{v1}} file · {{v2}}', { v1: fmtNum(preview.files), v2: fmtBytes(preview.bytes) })}</p>
            <p className="text-xs text-muted-foreground">{tr('sẽ bị xoá trên {{label}} nếu bấm Xoá. Hiện chưa xoá gì.', { label })}</p>
          </div>
          {reasons.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{trx('Theo từng loại <0>(một file có thể thuộc nhiều loại)</0>', { 0: <span className="font-normal text-subtle-foreground" /> })}</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {reasons.map(r => (
                  <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className="tabular-nums text-foreground">{trx('{{v1}} file', { v1: fmtNum(r.count) })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.cloudOnlyFiles > 0 && (
            <Notice tone="destructive">
              <p>
                {tr('Trong đó {{v1}} file ({{v2}}) chỉ còn trên {{label}}: xoá là mất hẳn, không còn bản nào trên máy.', { v1: fmtNum(preview.cloudOnlyFiles), v2: fmtBytes(preview.cloudOnlyBytes), label })}
              </p>
            </Notice>
          )}
          {preview.localFiles > 0 && (
            <p className="text-xs text-warning">{trx('Xoá luôn {{v1}} file trên máy của tin đã xoá.', { v1: fmtNum(preview.localFiles) })}</p>
          )}
        </>
      )}
      {preview.skippedCloudOnly > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr('{{v1}} file chỉ còn trên {{label}} được giữ lại.', { v1: fmtNum(preview.skippedCloudOnly), label })}
        </p>
      )}
      {preview.files > 0 && samples.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">{tr('Ví dụ')}</p>
          <ul className="max-h-36 overflow-y-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {samples.map(path => <li key={path} className="truncate" title={path}>{path}</li>)}
          </ul>
        </div>
      )}
      {preview.scannedAt > 0 && (
        <p className="text-[11px] text-subtle-foreground">{trx('Quét lúc {{v1}} · kết quả dùng được trong 15 phút.', { v1: fmtHm(preview.scannedAt) })}</p>
      )}
    </div>
  );
}

/** Step 3: delete result. */
export function R2CleanupResultView({ result }: { result: R2CleanupResult }) {
  const label = useStoreLabel();
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">{tr('Đã dọn xong')}</p>
      <Notice
        tone={result.failed > 0 ? 'warning' : 'success'}
        title={tr('Đã xoá {{v1}} file · {{v2}} trên {{label}}', { v1: fmtNum(result.deleted), v2: fmtBytes(result.bytes), label })}
      >
        {result.failed > 0 && <p>{trx('{{v1}} file chưa xoá được. Quét lại sau để thử tiếp.', { v1: fmtNum(result.failed) })}</p>}
        {result.localDeleted > 0 && <p>{trx('Đã xoá {{v1}} file trên máy của tin đã xoá.', { v1: fmtNum(result.localDeleted) })}</p>}
        {result.failed === 0 && result.localDeleted === 0 && <p>{tr('File trên máy không bị đụng tới.')}</p>}
      </Notice>
    </div>
  );
}

function progressText(work: 'scan' | 'delete', p: R2CleanupProgress | null): string {
  if (p?.message) return p.message;
  const verb = work === 'scan' ? tr('Đang quét') : tr('Đang xoá');
  return p && p.total > 0 ? `${verb} · ${fmtNum(p.done)}/${fmtNum(p.total)} file` : `${verb}…`;
}

// ─── Dialog body (stateful) ─────────────────────────────────────────────────────────

export interface R2CleanupPanelProps {
  onClose: () => void;
  /** Delete finished on R2 → refresh the media status. */
  onDone?: () => void;
  /** Shows that a scan / delete is running (the dialog cannot be closed). */
  onBusyChange?: (busy: boolean) => void;
  /** Scan result already available (test): jump straight to step 2. */
  initialPreview?: R2CleanupPreview | null;
  initialForm?: R2CleanupForm;
  /** Account to pick; defaults to the account of the open workspace. */
  accounts?: ReadonlyArray<ScopeAccount>;
  /** Current media storage scope (explains "File ngoài phạm vi lưu hiện tại" (Files outside the current storage scope)). */
  scope?: CloudScope | null;
  includeShared?: boolean;
}

type CleanupStep = 'options' | 'preview' | 'result';
type CleanupMessage = { tone: 'warning' | 'destructive'; text: string } | null;

export function R2CleanupPanel({
  onClose,
  onDone,
  onBusyChange,
  initialPreview = null,
  initialForm,
  accounts: accountsProp,
  scope,
  includeShared = true,
}: R2CleanupPanelProps) {
  const accounts = useScopeAccounts(accountsProp);
  const label = useStoreLabel();
  const [form, setForm] = useState<R2CleanupForm>(initialForm ?? DEFAULT_CLEANUP_FORM);
  const [request, setRequest] = useState<R2CleanupRequest | null>(() => (initialPreview ? cleanupRequest(initialForm ?? DEFAULT_CLEANUP_FORM) : null));
  const [preview, setPreview] = useState<R2CleanupPreview | null>(initialPreview);
  const [result, setResult] = useState<R2CleanupResult | null>(null);
  const [step, setStep] = useState<CleanupStep>(initialPreview ? 'preview' : 'options');
  const [work, setWork] = useState<'scan' | 'delete' | null>(null);
  const [progress, setProgress] = useState<R2CleanupProgress | null>(null);
  const [message, setMessage] = useState<CleanupMessage>(null);

  useEffect(() => { onBusyChange?.(work != null); }, [work, onBusyChange]);

  const normalized = normalizeScope(scope);
  const scopeIsAll = isAllScope(normalized) && includeShared !== false;
  const scopeText = `${describeScope(normalized, accounts)}${includeShared === false ? tr(' · không kèm file chung') : ''}`;
  const problem = cleanupFormProblem(scopeIsAll ? { ...form, outOfScope: false } : form);

  const listen = () => ipc.on?.(CLOUD_CLEANUP_PROGRESS_EVENT, (p: R2CleanupProgress) => {
    if (p && typeof p.done === 'number') setProgress(p);
  });

  const scan = async () => {
    if (problem) return;
    const api = cloudApi();
    if (typeof api?.media?.cleanupPreview !== 'function') {
      setMessage({ tone: 'warning', text: tr('Bản app này chưa có tính năng dọn file trên {{label}}. Hãy cập nhật Deplao.', { label }) });
      return;
    }
    const req = cleanupRequest(scopeIsAll ? { ...form, outOfScope: false } : form);
    setWork('scan');
    setMessage(null);
    setProgress(null);
    const off = listen();
    try {
      const res = await api.media.cleanupPreview(req);
      if (!res?.success || !res.preview) {
        setMessage({ tone: 'destructive', text: res?.error || tr('Quét không thành công, thử lại sau.') });
        return;
      }
      setRequest(req);
      setPreview(res.preview);
      setStep('preview');
    } catch (err) {
      setMessage({ tone: 'destructive', text: cleanIpcError(err) });
    } finally {
      off?.();
      setWork(null);
    }
  };

  const remove = async () => {
    if (!preview || preview.files === 0) return;
    const ok = await showConfirm({
      title: tr('Xoá {{v1}} file trên {{label}}?', { v1: fmtNum(preview.files), label }),
      message: tr('Không hoàn tác được. File đã xoá trên {{label}} không tải về được nữa.', { label }),
      confirmText: tr('Xoá trên {{label}}', { label }),
      variant: 'danger',
    });
    if (!ok) return;
    const api = cloudApi();
    if (typeof api?.media?.cleanupRun !== 'function') {
      setMessage({ tone: 'warning', text: tr('Bản app này chưa có tính năng dọn file trên {{label}}. Hãy cập nhật Deplao.', { label }) });
      return;
    }
    setWork('delete');
    setMessage(null);
    setProgress(null);
    const off = listen();
    try {
      const res = await api.media.cleanupRun(preview.previewId);
      if (!res?.success || !res.result) {
        if (res?.code === 'PREVIEW_EXPIRED') {
          setPreview(null);
          setStep('options');
          setMessage({ tone: 'warning', text: tr('Kết quả quét đã quá 15 phút, chưa xoá gì. Bấm Quét để xem lại danh sách mới.') });
          return;
        }
        setMessage({ tone: 'destructive', text: res?.error || tr('Xoá không thành công, thử lại sau.') });
        return;
      }
      setResult(res.result);
      setStep('result');
      onDone?.();
    } catch (err) {
      setMessage({ tone: 'destructive', text: cleanIpcError(err) });
    } finally {
      off?.();
      setWork(null);
    }
  };

  const back = () => {
    setPreview(null);
    setMessage(null);
    setStep('options');
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (step === 'result' && result) {
    body = <R2CleanupResultView result={result} />;
    footer = <Button onClick={onClose}>{tr('Đóng')}</Button>;
  } else if (step === 'preview' && preview) {
    body = <R2CleanupPreviewView preview={preview} request={request} />;
    footer = (
      <>
        <Button variant="ghost" disabled={work != null} onClick={back}>{tr('Quay lại')}</Button>
        {preview.files > 0 ? (
          <Button variant="destructive" leftIcon={<TrashIcon className="h-4 w-4" />} loading={work === 'delete'} onClick={() => void remove()}>
            {tr('Xoá {{v1}} file trên {{label}}', { v1: fmtNum(preview.files), label })}
          </Button>
        ) : (
          <Button onClick={onClose}>{tr('Đóng')}</Button>
        )}
      </>
    );
  } else {
    body = (
      <R2CleanupOptions
        form={form}
        onChange={next => { setForm(next); setMessage(null); }}
        accounts={accounts}
        scopeText={scopeText}
        scopeIsAll={scopeIsAll}
        disabled={work != null}
      />
    );
    footer = (
      <>
        {problem && <span className="mr-auto text-xs text-warning">{problem}</span>}
        <Button variant="ghost" disabled={work != null} onClick={onClose}>{tr('Huỷ')}</Button>
        <Button loading={work === 'scan'} disabled={!!problem} onClick={() => void scan()}>{tr('Quét')}</Button>
      </>
    );
  }

  return (
    <>
      <DialogBody className="space-y-4 py-4">
        {message && <Notice tone={message.tone}><p>{message.text}</p></Notice>}
        {body}
        {work && (
          <div className="space-y-1.5">
            <ProgressBar
              value={progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
              tone={work === 'delete' ? 'destructive' : 'primary'}
              label={work === 'scan' ? tr('Tiến độ quét') : tr('Tiến độ xoá')}
            />
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <CloudSpinner className="h-3.5 w-3.5" />
              {progressText(work, progress)}
            </p>
          </div>
        )}
      </DialogBody>
      <DialogFooter className="flex-wrap border-t border-border">{footer}</DialogFooter>
    </>
  );
}

// ─── Box ──────────────────────────────────────────────────────────────────────────────

export interface R2CleanupDialogProps extends Omit<R2CleanupPanelProps, 'onBusyChange'> {
  open: boolean;
}

export function R2CleanupDialog({ open, onClose, ...panel }: R2CleanupDialogProps) {
  const [busy, setBusy] = useState(false);
  const label = useStoreLabel();
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={next => { if (!next && !busy) onClose(); }}
      size="lg"
      closeOnOverlay={false}
      closeOnEscape={!busy}
    >
      <DialogHeader className="border-b border-border">
        <div className="min-w-0">
          <DialogTitle>{tr('Dọn file trên {{label}}', { label })}</DialogTitle>
          <DialogDescription>{tr('Quét trước để xem số file, chỉ xoá khi bạn bấm Xoá. Xoá trên {{label}} thì không tải về được nữa.', { label })}</DialogDescription>
        </div>
        {!busy && <DialogClose />}
      </DialogHeader>
      <R2CleanupPanel {...panel} onClose={onClose} onBusyChange={setBusy} />
    </Dialog>
  );
}

export default R2CleanupDialog;
