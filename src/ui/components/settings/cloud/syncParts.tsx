/**
 * Mảnh dùng lại của Cài đặt → Internet & Đám mây → Đồng bộ dữ liệu (chuyển từ phần "Đồng bộ DB" cũ):
 *  - SnapshotProgress: tiến độ chụp bản gốc (bước x/5, %, dung lượng, tốc độ, thời gian còn lại, đang gửi lại phần nào).
 *  - SyncLogTable: nhật ký đồng bộ.
 *  - PassphraseDialog: đặt / đổi mật khẩu sao lưu (bật đồng bộ lần đầu bắt buộc có).
 *  - StandbyCard + FollowDialog: máy dự phòng (máy chủ thấy máy nào đang theo dõi; máy dự phòng thấy
 *    "Đang theo dõi bản của …" + Chuyển sang máy này).
 *  - RemoteCopiesCard: "Bản sao DB trên R2" (đọc khi bấm, xoá hẳn bản của máy cũ — db.deleteRemote).
 * Câu chữ dùng tên kho đang chọn (useStoreLabel: "R2" / "Google Drive").
 */
import React, { useEffect, useId, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { RefreshIcon, TrashIcon } from '@/components/common/icons';
import {
  Badge,
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
} from '@/components/ui';
import { cn } from '@/lib/cn';
import type { DbSyncProgress, DbSyncStatus, RemoteDbCopy, SyncLogEntry } from '../../../../shared/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  fmtBytes,
  fmtHm,
  fmtLag,
  fmtLogTime,
  fmtNum,
  fmtWhen,
  Notice,
  ProgressBar,
  useCloudAction,
  useStorageProvider,
  useStoreLabel,
} from './cloudUi';
import { CopyScopeNotice, RemoteCopyDetails, RemoteCopyList, type RestoreWizardOptions } from './RestoreWizard';

// ─── Tiến độ chụp bản gốc ────────────────────────────────────────────────────────────────

/** Các bước chụp bản gốc; bước cuối "Tải lên <kho>" ghép tên kho lúc vẽ. */
const SNAPSHOT_STEPS: Array<{ phase: DbSyncProgress['phase']; label: string }> = [
  { phase: 'copy', label: 'Sao chép DB' },
  { phase: 'filter', label: 'Lọc theo phạm vi' },
  { phase: 'compress', label: 'Nén' },
  { phase: 'encrypt', label: 'Mã hoá' },
  { phase: 'upload', label: 'Tải lên' },
];

/** "45 giây", "12 phút", "1 giờ 5 phút". */
function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} giây`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} phút`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}

/** Tiến độ chụp bản gốc: bước hiện tại, %, dung lượng, tốc độ + thời gian còn lại khi tải lên, đang gửi lại phần nào. */
export function SnapshotProgress({ progress, now = Date.now() }: { progress: DbSyncProgress; now?: number }) {
  const store = useStoreLabel();
  const idx = Math.max(0, SNAPSHOT_STEPS.findIndex(st => st.phase === progress.phase));
  const step = SNAPSHOT_STEPS[idx] ?? SNAPSHOT_STEPS[0];
  const stepLabel = step.phase === 'upload' ? `${step.label} ${store}` : step.label;
  const parts: string[] = [`Bước ${idx + 1}/${SNAPSHOT_STEPS.length}: ${stepLabel}`];
  if (progress.total > 0) parts.push(`${fmtBytes(progress.done)} / ${fmtBytes(progress.total)}`);
  if (progress.phase === 'upload' && progress.rate && progress.rate > 0) {
    parts.push(`${fmtBytes(progress.rate)}/s`);
    if (progress.total > progress.done) parts.push(`còn khoảng ${fmtDuration(((progress.total - progress.done) / progress.rate) * 1000)}`);
  }
  const retry = progress.retry;
  return (
    <div className="space-y-1.5 pt-1">
      <ProgressBar value={progress.percent} tone={retry ? 'warning' : 'primary'} label="Tiến độ chụp bản gốc" />
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <CloudSpinner className="h-3.5 w-3.5" />
        <span>{parts.join(' · ')}</span>
        <span className="font-medium text-foreground">{progress.percent}%</span>
      </p>
      <p className="text-[11px] text-subtle-foreground">
        Bắt đầu {fmtHm(progress.startedAt)} · đã chạy {fmtDuration(now - progress.startedAt)}
      </p>
      {retry && (
        <p className="text-xs text-warning">
          Mạng chậm: phần {retry.part ?? '?'} đang gửi lại (lần {retry.attempt}/{retry.maxAttempts}) — vẫn tiếp tục, không cần làm gì.
        </p>
      )}
    </div>
  );
}

// ─── Nhật ký đồng bộ ─────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<SyncLogEntry['kind'], string> = {
  base: 'Chụp gốc mới',
  segment: 'Đoạn thay đổi',
  'segments-hour': 'Đoạn thay đổi',
  restore: 'Khôi phục',
  follow: 'Máy dự phòng tải về',
};

const RESULT: Record<SyncLogEntry['result'], { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  ok: { label: 'Thành công', variant: 'success' },
  retried: { label: 'Thử lại', variant: 'warning' },
  error: { label: 'Lỗi', variant: 'destructive' },
};

export function SyncLogTable({ entries, workspaceNames }: { entries: SyncLogEntry[]; workspaceNames?: Map<string, string> | null }) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-subtle-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Thời điểm</th>
            <th className="px-3 py-2 font-medium">Loại</th>
            <th className="px-3 py-2 font-medium">Thay đổi</th>
            <th className="px-3 py-2 font-medium">Dung lượng</th>
            <th className="px-3 py-2 font-medium">Kết quả</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map(e => {
            const result = RESULT[e.result] ?? RESULT.error;
            const time = e.endAt && e.kind === 'segments-hour'
              ? `${fmtLogTime(e.at, now)}–${fmtLogTime(e.endAt, now).slice(-5)}`
              : fmtLogTime(e.at, now);
            const kind = e.kind === 'segments-hour' ? `${KIND_LABEL[e.kind]} · ${fmtNum(e.pushes)} lần đẩy` : (KIND_LABEL[e.kind] ?? e.kind);
            const ws = workspaceNames?.get(e.workspaceId);
            return (
              <tr key={e.id} className="text-foreground">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{time}</td>
                <td className="px-3 py-2">{ws ? <span className="text-muted-foreground">{ws} · </span> : null}{kind}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.kind === 'base' ? 'toàn bộ' : `${fmtNum(e.rows)} dòng`}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtBytes(e.bytes)}</td>
                <td className="px-3 py-2">
                  <Badge size="sm" variant={result.variant} title={e.error || undefined}>{result.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Mật khẩu sao lưu ────────────────────────────────────────────────────────────────────

/** 'enable' = đang bật đồng bộ lần đầu (lưu mật khẩu xong thì lưu luôn thiết lập). */
export type PassphraseDialogKind = 'set' | 'change' | 'enable';

/**
 * Đặt / đổi mật khẩu sao lưu: nhập hai lần + xác nhận đã hiểu quên mật khẩu là mất bản trên R2.
 * Chỉ gắn khi đang mở (đóng là bỏ hết chữ đã gõ).
 */
export function PassphraseDialog({ kind, busy, onCancel, onSubmit }: {
  kind: PassphraseDialogKind;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (passphrase: string) => void;
}) {
  const label = useStoreLabel();
  const firstId = useId();
  const secondId = useId();
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (first.length < 8) { setError('Mật khẩu cần ít nhất 8 ký tự.'); return; }
    if (first !== second) { setError('Hai lần nhập không khớp.'); return; }
    if (!ack) { setError('Tick ô xác nhận để tiếp tục.'); return; }
    setError(null);
    onSubmit(first);
  };

  const change = kind === 'change';
  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} size="sm">
      <form className="flex min-h-0 flex-col" onSubmit={e => { e.preventDefault(); submit(); }}>
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{change ? 'Đổi mật khẩu sao lưu' : 'Đặt mật khẩu sao lưu'}</DialogTitle>
            <DialogDescription>
              {change
                ? `Bản mới trên ${label} dùng mật khẩu mới. Máy dự phòng phải nhập lại mật khẩu mới.`
                : `Bản trên ${label} được mã hoá bằng mật khẩu này trước khi tải lên. Máy khác phải nhập mật khẩu khi khôi phục.`}
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label="Mật khẩu" htmlFor={firstId} hint="Ít nhất 8 ký tự. Ghi lại ở nơi an toàn.">
            <Input id={firstId} type="password" autoComplete="new-password" value={first} onChange={e => { setFirst(e.target.value); setError(null); }} autoFocus />
          </FormField>
          <FormField label="Nhập lại mật khẩu" htmlFor={secondId}>
            <Input id={secondId} type="password" autoComplete="new-password" value={second} onChange={e => { setSecond(e.target.value); setError(null); }} />
          </FormField>
          <Checkbox checked={ack} onCheckedChange={next => { setAck(next); setError(null); }} label={`Tôi hiểu quên mật khẩu là mất bản trên ${label}`} />
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Huỷ</Button>
          <Button type="submit" loading={busy}>{kind === 'enable' ? 'Đặt mật khẩu và bật' : 'Lưu mật khẩu'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ─── Bản sao trên R2: được xoá bản nào, nhãn cạnh bản sao ───────────────────────────────

type CloudRun = ReturnType<typeof useCloudAction>['run'];

const DELETE_KEY = 'delete:';

/** Bản đang xoá (theo khoá bận của useCloudAction). */
function deletingIdOf(busy: string | null): string | null {
  return busy?.startsWith(DELETE_KEY) ? busy.slice(DELETE_KEY.length) : null;
}

/**
 * Hỏi lại rồi xoá hẳn một bản sao DB trên kho (`label` = tên kho). Lỗi của main (vd COPY_IN_USE) hiện nguyên văn.
 * Trả true khi đã xoá.
 */
async function deleteRemoteCopy(copy: RemoteDbCopy, run: CloudRun, label = 'R2'): Promise<boolean> {
  const ok = await showConfirm({
    title: `Xoá hẳn bản sao DB "${copy.name}" trên ${label}?`,
    message: `Máy ${copy.machine} · đồng bộ ${fmtWhen(copy.lastSyncAt)} · ${fmtBytes(copy.bytes)}. Không khôi phục được nữa.`,
    confirmText: 'Xoá bản này',
    variant: 'danger',
  });
  if (!ok) return false;
  const res = await run(
    `${DELETE_KEY}${copy.workspaceId}`,
    () => {
      const db = cloudApi()?.db;
      return typeof db?.deleteRemote === 'function' ? db.deleteRemote(copy.workspaceId) : undefined;
    },
    `Đã xoá bản sao trên ${label}`,
  );
  return !!res;
}

/**
 * Không cho xoá bản máy này đang đồng bộ lên, hay bản máy này đang theo dõi (main cũng chặn); nhãn
 * "Đang đồng bộ từ máy này" / "Của máy này" / "Máy này đang theo dõi".
 */
export function remoteCopyRules(status: DbSyncStatus): {
  canDelete: (copy: RemoteDbCopy) => boolean;
  tagOf: (copy: RemoteDbCopy) => string | null;
} {
  const following = status.following;
  const syncing = status.mode !== 'off';
  // Bản của máy này: mã bản sao trên R2 (bucket/uid) của từng workspace; id workspace trên máy giữ lại cho bản cũ của main.
  const ownIds = new Set<string>();
  for (const w of status.workspaces) {
    if (w.copyId) ownIds.add(w.copyId);
    ownIds.add(w.workspaceId);
  }
  return {
    canDelete: copy => copy.workspaceId !== following?.workspaceId && !(syncing && ownIds.has(copy.workspaceId)),
    tagOf: copy => {
      if (copy.workspaceId === following?.workspaceId) return 'Máy này đang theo dõi';
      if (ownIds.has(copy.workspaceId)) return syncing ? 'Đang đồng bộ từ máy này' : 'Của máy này';
      return null;
    },
  };
}

// ─── Máy dự phòng ────────────────────────────────────────────────────────────────────────

/**
 * Máy dự phòng: máy chủ thấy máy nào đang theo dõi + nút bật theo dõi bản của máy khác; máy dự phòng thấy
 * "Đang theo dõi bản của …" + Chuyển sang máy này (mở trình khôi phục chế độ promote) / Tắt theo dõi.
 */
export function StandbyCard({ status, ready, onWizard, onStatus, onRefresh, className }: {
  status: DbSyncStatus;
  ready: boolean;
  /** Mở trình khôi phục (Chuyển sang máy này). */
  onWizard: (options: RestoreWizardOptions) => void;
  /** Trạng thái DB mới từ main (follow on/off). */
  onStatus?: (status: DbSyncStatus) => void;
  onRefresh?: () => void;
  className?: string;
}) {
  const { busy, run, notify } = useCloudAction();
  const provider = useStorageProvider();
  const [followOpen, setFollowOpen] = useState(false);
  const following = status.following ?? null;
  const followers = status.followers ?? [];
  const { canDelete } = remoteCopyRules(status);

  const applyStatus = (next: DbSyncStatus | null | undefined) => {
    if (next) onStatus?.(next);
    onRefresh?.();
  };

  const stopFollow = async () => {
    if (!following) return;
    const ok = await showConfirm({
      title: 'Tắt theo dõi?',
      message: `Máy này ngừng tải bản sao của ${following.sourceMachine}. Dữ liệu đã tải về máy vẫn giữ.`,
      confirmText: 'Tắt theo dõi',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('follow', () => cloudApi()?.db.follow({ workspaceId: following.workspaceId, on: false }), 'Đã tắt theo dõi');
    if (res) applyStatus(res.status);
  };

  const promote = () => {
    if (!following) return;
    onWizard({ mode: 'promote', workspaceId: following.workspaceId, sourceMachine: following.sourceMachine, passphraseSet: !!status.passphraseSet });
  };

  return (
    <Card className={cn('space-y-2 p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Máy dự phòng</p>
        {!following && (
          <span className="text-xs text-muted-foreground">
            {followers.length
              ? `${followers.length} máy đang theo dõi · ${followers.map(f => `${f.machine} · trễ ${fmtLag(f.lagMs)}`).join(', ')}`
              : 'Chưa có máy nào theo dõi'}
          </span>
        )}
      </div>
      {following ? (
        <>
          <p className="text-sm text-foreground">
            Đang theo dõi bản của <strong>{following.sourceMachine}</strong> · trễ {fmtLag(following.lagMs)}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Máy này tải đoạn mới mỗi phút. Khi máy chủ hỏng, bấm Chuyển sang máy này để dùng dữ liệu ngay; kênh chat
            đăng nhập lại ở bước sau.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={promote}>Chuyển sang máy này</Button>
            <Button size="sm" variant="outline" loading={busy === 'follow'} onClick={() => void stopFollow()}>Tắt theo dõi</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-foreground">
            {provider === 'gdrive'
              ? 'Máy khác cài Deplao, chọn kho Google Drive và đăng nhập cùng tài khoản Google rồi bật Theo dõi bản sao.'
              : 'Máy khác cài Deplao, kết nối cùng Cloudflare rồi bật Theo dõi bản sao.'}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Máy đó tải đoạn mới mỗi phút; khi cần thì bấm Chuyển sang máy này ngay trên máy đó.
          </p>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => setFollowOpen(true)}>
            Dùng máy này theo dõi bản của máy khác…
          </Button>
        </>
      )}
      {followOpen && (
        <FollowDialog
          passphraseSet={!!status.passphraseSet}
          canDelete={canDelete}
          onClose={() => setFollowOpen(false)}
          onDone={next => {
            setFollowOpen(false);
            applyStatus(next);
            notify('Đã bật theo dõi bản sao', 'success');
          }}
        />
      )}
    </Card>
  );
}

/**
 * Bật chế độ máy dự phòng: chọn bản sao của máy khác trên kho → nhập mật khẩu sao lưu → db.follow({ on: true }).
 * Bản của máy / workspace không dùng nữa xoá được ngay trong danh sách (nút thùng rác).
 */
export function FollowDialog({ passphraseSet, canDelete, onClose, onDone }: {
  passphraseSet: boolean;
  canDelete: (copy: RemoteDbCopy) => boolean;
  onClose: () => void;
  onDone: (status: DbSyncStatus | null) => void;
}) {
  const passId = useId();
  const label = useStoreLabel();
  const { busy, run } = useCloudAction();
  const [copies, setCopies] = useState<RemoteDbCopy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selectedCopy = copies?.find(c => c.workspaceId === selected) ?? null;

  const load = async () => {
    setCopies(null);
    setLoadError(null);
    try {
      const res = await cloudApi()?.db.listRemote();
      if (res?.success) setCopies(res.copies ?? []);
      else { setCopies([]); setLoadError(res?.error || `Không đọc được danh sách bản sao trên ${label}.`); }
    } catch (err) {
      setCopies([]);
      setLoadError(cleanIpcError(err));
    }
  };
  useEffect(() => { void load(); }, []);

  const removeCopy = async (copy: RemoteDbCopy) => {
    if (!(await deleteRemoteCopy(copy, run, label))) return;
    setCopies(prev => (prev ?? []).filter(c => c.workspaceId !== copy.workspaceId));
    setSelected(prev => (prev === copy.workspaceId ? '' : prev));
  };

  const submit = async () => {
    if (!selected) { setError('Chọn bản sao cần theo dõi.'); return; }
    if (!passphrase && !passphraseSet) { setError('Nhập mật khẩu sao lưu của máy chủ.'); return; }
    setError(null);
    const res = await run('follow', () => cloudApi()?.db.follow({ workspaceId: selected, on: true, passphrase: passphrase || undefined }));
    if (!res) return;
    setPassphrase('');
    onDone(res.status ?? null);
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && busy !== 'follow') onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>Theo dõi bản sao của máy khác</DialogTitle>
          <DialogDescription>Máy này tải đoạn mới mỗi phút; khi máy chủ hỏng thì chuyển sang dùng ngay.</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-4">
        {copies === null ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CloudSpinner className="h-3.5 w-3.5" /> {`Đang đọc bản sao trên ${label}…`}
          </p>
        ) : copies.length === 0 ? (
          <Notice tone={loadError ? 'destructive' : 'info'} action={<Button size="sm" variant="ghost" onClick={() => void load()}>Tải lại</Button>}>
            <p>{loadError || `Chưa có bản sao nào trên ${label} của tài khoản này.`}</p>
          </Notice>
        ) : (
          <RemoteCopyList
            copies={copies}
            selectedId={selected}
            onSelect={id => { setSelected(id); setError(null); }}
            canDelete={canDelete}
            onDelete={copy => void removeCopy(copy)}
            deletingId={deletingIdOf(busy)}
          />
        )}
        {selectedCopy && <CopyScopeNotice copy={selectedCopy} />}
        <FormField
          label="Mật khẩu sao lưu của máy chủ"
          htmlFor={passId}
          hint={passphraseSet ? 'Để trống nếu giống mật khẩu đã lưu trên máy này.' : undefined}
        >
          <Input id={passId} type="password" autoComplete="off" value={passphrase} onChange={e => { setPassphrase(e.target.value); setError(null); }} />
        </FormField>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy === 'follow'}>Huỷ</Button>
        <Button loading={busy === 'follow'} disabled={!copies?.length} onClick={() => void submit()}>Bật theo dõi</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── Bản sao DB trên R2 ──────────────────────────────────────────────────────────────────

/**
 * "Bản sao DB trên R2": chỉ đọc danh sách khi bấm "Xem các bản trên R2" (không tự đọc định kỳ); xoá hẳn bản của máy /
 * workspace không dùng nữa. Bản máy này đang đồng bộ lên hoặc đang theo dõi thì không có nút xoá.
 */
export function RemoteCopiesCard({ ready, canDelete, tagOf, initialCopies = null }: {
  ready: boolean;
  canDelete: (copy: RemoteDbCopy) => boolean;
  /** Nhãn cạnh bản sao ("Đang đồng bộ từ máy này", "Máy này đang theo dõi", "Của máy này"). */
  tagOf?: (copy: RemoteDbCopy) => string | null;
  /** Danh sách đã đọc trước (test). */
  initialCopies?: RemoteDbCopy[] | null;
}) {
  const label = useStoreLabel();
  const provider = useStorageProvider();
  const { busy, run } = useCloudAction();
  const [copies, setCopies] = useState<RemoteDbCopy[] | null>(initialCopies);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = deletingIdOf(busy);

  const load = async () => {
    const db = cloudApi()?.db;
    if (!db) return;
    setLoading(true);
    setError(null);
    try {
      const res = await db.listRemote();
      if (res?.success) setCopies(res.copies ?? []);
      else { setCopies([]); setError(res?.error || `Không đọc được danh sách bản sao trên ${label}.`); }
    } catch (err) {
      setCopies([]);
      setError(cleanIpcError(err));
    } finally {
      setLoading(false);
    }
  };

  const remove = async (copy: RemoteDbCopy) => {
    if (await deleteRemoteCopy(copy, run, label)) setCopies(prev => (prev ?? []).filter(c => c.workspaceId !== copy.workspaceId));
  };

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{`Bản sao DB trên ${label}`}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {provider === 'gdrive'
              ? 'Các bản đang có trên Google Drive (của mọi máy dùng tài khoản Google này). Xoá bản của máy cũ không dùng nữa để bớt dung lượng.'
              : 'Các bản đang có trong kho R2 (của mọi máy dùng tài khoản Cloudflare này). Xoá bản của máy cũ không dùng nữa để bớt dung lượng.'}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          leftIcon={copies ? <RefreshIcon className="h-4 w-4" /> : undefined}
          loading={loading}
          disabled={!ready}
          onClick={() => void load()}
        >
          {copies ? 'Tải lại' : `Xem các bản trên ${label}`}
        </Button>
      </div>
      {error && <Notice tone="destructive"><p>{error}</p></Notice>}
      {copies && !error && copies.length === 0 && <p className="text-xs text-muted-foreground">{`Chưa có bản sao nào trên ${label}.`}</p>}
      {copies && copies.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {copies.map(copy => {
            const tag = tagOf?.(copy) ?? null;
            return (
              <li key={copy.workspaceId} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <RemoteCopyDetails copy={copy} />
                <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                  {tag && <Badge size="sm" variant="primary">{tag}</Badge>}
                  {canDelete(copy) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      leftIcon={<TrashIcon className="h-4 w-4" />}
                      loading={deleting === copy.workspaceId}
                      disabled={!ready || (deleting != null && deleting !== copy.workspaceId)}
                      onClick={() => void remove(copy)}
                    >
                      {`Xoá bản này trên ${label}`}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
