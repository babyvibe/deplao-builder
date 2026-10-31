/**
 * Dọn file trên R2 (Cài đặt → Internet & Đám mây → Đồng bộ dữ liệu → Nâng cao). Xoá tin trong app KHÔNG tự xoá trên
 * R2; hộp này là cách để bớt dung lượng R2, luôn quét trước rồi mới xoá:
 *  1 Chọn file cần dọn: tin đã xoá · của tài khoản · cũ hơn ngày · ngoài phạm vi lưu (OR), kèm tuỳ chọn an toàn
 *    (mặc định giữ file chỉ còn trên R2, không xoá bản trên máy) → Quét = media.cleanupPreview (không xoá gì).
 *  2 Kết quả quét: số file, dung lượng, theo từng tiêu chí, ví dụ → "Xoá N file trên R2" (hỏi lại) = media.cleanupRun.
 *  3 Kết quả xoá.
 * Tiến độ quét / xoá lấy từ CLOUD_CLEANUP_PROGRESS_EVENT. Kết quả quét hết hạn sau 15 phút (PREVIEW_EXPIRED → quét lại).
 * R2CleanupPanel (thân + nút) tách khỏi Dialog để test render phía server được.
 * Dùng cho kho đang chọn: câu chữ ghép tên kho (useStoreLabel: "R2" / "Google Drive"), tên component giữ nguyên.
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

// ─── Lựa chọn ở bước 1 ──────────────────────────────────────────────────────────────────

export interface R2CleanupForm {
  /** File của tin đã xoá trong app. */
  orphans: boolean;
  byAccounts: boolean;
  accounts: string[];
  byDate: boolean;
  olderThanTs: number | null;
  outOfScope: boolean;
  /** Cho phép xoá cả file chỉ còn trên R2 (mất hẳn). */
  includeCloudOnly: boolean;
  /** Xoá luôn bản trên máy của tin đã xoá. */
  deleteLocalOrphans: boolean;
}

/** Mặc định: chỉ file của tin đã xoá; giữ file chỉ còn trên R2; không xoá gì trên máy. */
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

/** Lý do chưa quét được; null = quét được. */
export function cleanupFormProblem(form: R2CleanupForm): string | null {
  if (!form.orphans && !form.byAccounts && !form.byDate && !form.outOfScope) return 'Chọn ít nhất một loại file cần dọn.';
  if (form.byAccounts && form.accounts.length === 0) return 'Chọn ít nhất một tài khoản.';
  if (form.byDate && !form.olderThanTs) return 'Chọn ngày.';
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

/** Ngày gợi ý cho "File cũ hơn ngày…": ngày 1 của tháng cách đây 12 tháng (00:00 giờ máy). */
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

/** Bước 1: chọn file cần dọn + tuỳ chọn an toàn. */
export function R2CleanupOptions({ form, onChange, accounts, scopeText, scopeIsAll = false, disabled = false }: {
  form: R2CleanupForm;
  onChange: (next: R2CleanupForm) => void;
  accounts: ReadonlyArray<ScopeAccount>;
  /** Câu tóm tắt phạm vi lưu media hiện tại. */
  scopeText?: string;
  /** Đang lưu tất cả (không có file ngoài phạm vi). */
  scopeIsAll?: boolean;
  disabled?: boolean;
}) {
  const label = useStoreLabel();
  const set = (patch: Partial<R2CleanupForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Chọn file cần dọn</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Chọn ít nhất một loại. Chỉ xét file của workspace đang mở; quét chỉ đếm file, chưa xoá gì.
          </p>
        </div>

        <Criterion
          checked={form.orphans}
          disabled={disabled}
          onChange={orphans => set({ orphans })}
          label="File của tin đã xoá trong app"
          description="File không còn tin nhắn, ghim hay thư viện nào dùng tới."
        >
          {form.orphans && (
            <Checkbox
              checked={form.deleteLocalOrphans}
              disabled={disabled}
              onCheckedChange={deleteLocalOrphans => set({ deleteLocalOrphans })}
              label="Xoá luôn bản trên máy của tin đã xoá"
              description="Mặc định giữ bản trên máy."
            />
          )}
        </Criterion>

        <Criterion
          checked={form.byAccounts}
          disabled={disabled}
          onChange={byAccounts => set({ byAccounts })}
          label="File của tài khoản…"
          description="Toàn bộ file của các tài khoản chọn dưới đây."
        >
          {form.byAccounts && (
            <>
              <AccountChecklist accounts={accounts} selected={form.accounts} disabled={disabled} onChange={ids => set({ accounts: ids })} />
              <p className="text-xs text-subtle-foreground">
                Danh sách chỉ có tài khoản đang có trong app; tài khoản đã gỡ khỏi app có thể không có ở đây.
              </p>
            </>
          )}
        </Criterion>

        <Criterion
          checked={form.byDate}
          disabled={disabled}
          onChange={byDate => set({ byDate, olderThanTs: byDate ? (form.olderThanTs ?? defaultCleanupBefore()) : form.olderThanTs })}
          label="File cũ hơn ngày…"
        >
          {form.byDate && (
            <DateField label="Cũ hơn ngày" value={form.olderThanTs} disabled={disabled} onChange={olderThanTs => set({ olderThanTs })} />
          )}
        </Criterion>

        <Criterion
          checked={form.outOfScope && !scopeIsAll}
          disabled={disabled || scopeIsAll}
          onChange={outOfScope => set({ outOfScope })}
          label="File ngoài phạm vi lưu hiện tại"
          description={scopeIsAll
            ? 'Đang lưu tất cả nên không có file ngoài phạm vi.'
            : `Phạm vi lưu hiện tại: ${scopeText || 'đã giới hạn'}.`}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-semibold text-foreground">An toàn</p>
        <div className={cn('rounded-lg border p-3', form.includeCloudOnly ? 'border-destructive/50 bg-destructive/10' : 'border-destructive/30')}>
          <Checkbox
            checked={form.includeCloudOnly}
            disabled={disabled}
            onCheckedChange={includeCloudOnly => set({ includeCloudOnly })}
            label={<span className="text-destructive">{`Xoá cả file chỉ còn trên ${label} (đã dọn khỏi máy) — mất hẳn`}</span>}
            description="Mặc định giữ lại: các file này không còn bản nào trên máy."
          />
        </div>
      </div>
    </div>
  );
}

// ─── Bước 2, 3 ─────────────────────────────────────────────────────────────────────────

/** Bước 2: kết quả quét (chưa xoá gì). */
export function R2CleanupPreviewView({ preview, request }: { preview: R2CleanupPreview; request?: R2CleanupRequest | null }) {
  const label = useStoreLabel();
  const byReason = preview.byReason ?? { orphans: 0, accounts: 0, olderThan: 0, outOfScope: 0 };
  const reasons = [
    { key: 'orphans', label: 'Của tin đã xoá trong app', count: byReason.orphans, on: !!request?.orphans },
    { key: 'accounts', label: 'Của tài khoản đã chọn', count: byReason.accounts, on: !!request?.accounts?.length },
    {
      key: 'olderThan',
      label: request?.olderThanTs ? `Cũ hơn ngày ${fmtDate(request.olderThanTs)}` : 'Cũ hơn ngày đã chọn',
      count: byReason.olderThan,
      on: !!request?.olderThanTs,
    },
    { key: 'outOfScope', label: 'Ngoài phạm vi lưu hiện tại', count: byReason.outOfScope, on: !!request?.outOfScope },
  ].filter(r => r.on || r.count > 0);
  const samples = preview.samples ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-foreground">Kết quả quét</p>
      {preview.files === 0 ? (
        <Notice tone="info" title="Không có file nào cần dọn">
          <p>{`Không có file nào trên ${label} khớp lựa chọn. Quay lại để chọn loại khác.`}</p>
        </Notice>
      ) : (
        <>
          <div className="rounded-xl border border-border p-4">
            <p className="text-lg font-semibold tabular-nums text-foreground">{fmtNum(preview.files)} file · {fmtBytes(preview.bytes)}</p>
            <p className="text-xs text-muted-foreground">{`sẽ bị xoá trên ${label} nếu bấm Xoá. Hiện chưa xoá gì.`}</p>
          </div>
          {reasons.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Theo từng loại <span className="font-normal text-subtle-foreground">(một file có thể thuộc nhiều loại)</span></p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {reasons.map(r => (
                  <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className="tabular-nums text-foreground">{fmtNum(r.count)} file</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.cloudOnlyFiles > 0 && (
            <Notice tone="destructive">
              <p>
                {`Trong đó ${fmtNum(preview.cloudOnlyFiles)} file (${fmtBytes(preview.cloudOnlyBytes)}) chỉ còn trên ${label}: xoá là mất hẳn, không còn bản nào trên máy.`}
              </p>
            </Notice>
          )}
          {preview.localFiles > 0 && (
            <p className="text-xs text-warning">Xoá luôn {fmtNum(preview.localFiles)} file trên máy của tin đã xoá.</p>
          )}
        </>
      )}
      {preview.skippedCloudOnly > 0 && (
        <p className="text-xs text-muted-foreground">
          {`${fmtNum(preview.skippedCloudOnly)} file chỉ còn trên ${label} được giữ lại.`}
        </p>
      )}
      {preview.files > 0 && samples.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Ví dụ</p>
          <ul className="max-h-36 overflow-y-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {samples.map(path => <li key={path} className="truncate" title={path}>{path}</li>)}
          </ul>
        </div>
      )}
      {preview.scannedAt > 0 && (
        <p className="text-[11px] text-subtle-foreground">Quét lúc {fmtHm(preview.scannedAt)} · kết quả dùng được trong 15 phút.</p>
      )}
    </div>
  );
}

/** Bước 3: kết quả xoá. */
export function R2CleanupResultView({ result }: { result: R2CleanupResult }) {
  const label = useStoreLabel();
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">Đã dọn xong</p>
      <Notice
        tone={result.failed > 0 ? 'warning' : 'success'}
        title={`Đã xoá ${fmtNum(result.deleted)} file · ${fmtBytes(result.bytes)} trên ${label}`}
      >
        {result.failed > 0 && <p>{fmtNum(result.failed)} file chưa xoá được. Quét lại sau để thử tiếp.</p>}
        {result.localDeleted > 0 && <p>Đã xoá {fmtNum(result.localDeleted)} file trên máy của tin đã xoá.</p>}
        {result.failed === 0 && result.localDeleted === 0 && <p>File trên máy không bị đụng tới.</p>}
      </Notice>
    </div>
  );
}

function progressText(work: 'scan' | 'delete', p: R2CleanupProgress | null): string {
  if (p?.message) return p.message;
  const verb = work === 'scan' ? 'Đang quét' : 'Đang xoá';
  return p && p.total > 0 ? `${verb} · ${fmtNum(p.done)}/${fmtNum(p.total)} file` : `${verb}…`;
}

// ─── Thân hộp (có trạng thái) ─────────────────────────────────────────────────────────

export interface R2CleanupPanelProps {
  onClose: () => void;
  /** Đã xoá xong trên R2 → làm mới trạng thái media. */
  onDone?: () => void;
  /** Báo đang quét / xoá (hộp không cho đóng). */
  onBusyChange?: (busy: boolean) => void;
  /** Kết quả quét có sẵn (test): mở thẳng bước 2. */
  initialPreview?: R2CleanupPreview | null;
  initialForm?: R2CleanupForm;
  /** Tài khoản để chọn; mặc định tài khoản của workspace đang mở. */
  accounts?: ReadonlyArray<ScopeAccount>;
  /** Phạm vi lưu media hiện tại (giải thích "File ngoài phạm vi lưu hiện tại"). */
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
  const scopeText = `${describeScope(normalized, accounts)}${includeShared === false ? ' · không kèm file chung' : ''}`;
  const problem = cleanupFormProblem(scopeIsAll ? { ...form, outOfScope: false } : form);

  const listen = () => ipc.on?.(CLOUD_CLEANUP_PROGRESS_EVENT, (p: R2CleanupProgress) => {
    if (p && typeof p.done === 'number') setProgress(p);
  });

  const scan = async () => {
    if (problem) return;
    const api = cloudApi();
    if (typeof api?.media?.cleanupPreview !== 'function') {
      setMessage({ tone: 'warning', text: `Bản app này chưa có tính năng dọn file trên ${label}. Hãy cập nhật Deplao.` });
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
        setMessage({ tone: 'destructive', text: res?.error || 'Quét không thành công, thử lại sau.' });
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
      title: `Xoá ${fmtNum(preview.files)} file trên ${label}?`,
      message: `Không hoàn tác được. File đã xoá trên ${label} không tải về được nữa.`,
      confirmText: `Xoá trên ${label}`,
      variant: 'danger',
    });
    if (!ok) return;
    const api = cloudApi();
    if (typeof api?.media?.cleanupRun !== 'function') {
      setMessage({ tone: 'warning', text: `Bản app này chưa có tính năng dọn file trên ${label}. Hãy cập nhật Deplao.` });
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
          setMessage({ tone: 'warning', text: 'Kết quả quét đã quá 15 phút, chưa xoá gì. Bấm Quét để xem lại danh sách mới.' });
          return;
        }
        setMessage({ tone: 'destructive', text: res?.error || 'Xoá không thành công, thử lại sau.' });
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
    footer = <Button onClick={onClose}>Đóng</Button>;
  } else if (step === 'preview' && preview) {
    body = <R2CleanupPreviewView preview={preview} request={request} />;
    footer = (
      <>
        <Button variant="ghost" disabled={work != null} onClick={back}>Quay lại</Button>
        {preview.files > 0 ? (
          <Button variant="destructive" leftIcon={<TrashIcon className="h-4 w-4" />} loading={work === 'delete'} onClick={() => void remove()}>
            {`Xoá ${fmtNum(preview.files)} file trên ${label}`}
          </Button>
        ) : (
          <Button onClick={onClose}>Đóng</Button>
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
        <Button variant="ghost" disabled={work != null} onClick={onClose}>Huỷ</Button>
        <Button loading={work === 'scan'} disabled={!!problem} onClick={() => void scan()}>Quét</Button>
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
              label={work === 'scan' ? 'Tiến độ quét' : 'Tiến độ xoá'}
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

// ─── Hộp ──────────────────────────────────────────────────────────────────────────────

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
          <DialogTitle>{`Dọn file trên ${label}`}</DialogTitle>
          <DialogDescription>{`Quét trước để xem số file, chỉ xoá khi bạn bấm Xoá. Xoá trên ${label} thì không tải về được nữa.`}</DialogDescription>
        </div>
        {!busy && <DialogClose />}
      </DialogHeader>
      <R2CleanupPanel {...panel} onClose={onClose} onBusyChange={setBusy} />
    </Dialog>
  );
}

export default R2CleanupDialog;
