/**
 * Reusable pieces of Settings → Internet & Cloud → Data sync (moved from the old "Đồng bộ DB" (DB sync) section):
 *  - SnapshotProgress: base snapshot progress (step x/5, %, size, speed, time left, which part is being re-sent).
 *  - SyncLogTable: sync log.
 *  - PassphraseDialog: set / change the backup password (required the first time sync is turned on).
 *  - StandbyCard + FollowDialog: standby machine (the server sees which machine is monitoring; a standby machine sees
 *    "Đang theo dõi bản của …" (Monitoring the copy of …) + Switch to this machine).
 *  - RemoteCopiesCard: "Bản sao DB trên R2" (DB copies on R2) (read on click, permanently deletes the copy of an old machine - db.deleteRemote).
 * The wording uses the selected storage name (useStoreLabel: "R2" / "Google Drive").
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
import type { DbSyncProgress, DbSyncStatus, RemoteDbCopy, SyncLogEntry } from '../../../../../shared/cloud/cloudContracts';
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
} from '../cloudUi';
import { CopyScopeNotice, RemoteCopyDetails, RemoteCopyList, type RestoreWizardOptions } from '../restore/RestoreWizard';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── Base snapshot progress ────────────────────────────────────────────────────────────────

/** The base snapshot steps; the last step "Tải lên <kho>" (Upload to <storage>) gets the storage name filled in when drawn. */
const SNAPSHOT_STEPS: Array<{ phase: DbSyncProgress['phase']; label: string }> = [
  { phase: 'copy', label: tr('Sao chép DB') },
  { phase: 'filter', label: tr('Lọc theo phạm vi') },
  { phase: 'compress', label: tr('Nén') },
  { phase: 'encrypt', label: tr('Mã hoá') },
  { phase: 'upload', label: tr('Tải lên') },
];

/** "45 giây" (45 seconds), "12 phút" (12 minutes), "1 giờ 5 phút" (1 hour 5 minutes). */
function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return tr('{{sec}} giây', { sec });
  const min = Math.round(sec / 60);
  if (min < 60) return tr('{{min}} phút', { min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? tr('{{h}} giờ {{m}} phút', { h, m }) : tr('{{h}} giờ', { h });
}

/** Base snapshot progress: current step, %, size, speed + time left while uploading, which part is being re-sent. */
export function SnapshotProgress({ progress, now = Date.now() }: { progress: DbSyncProgress; now?: number }) {
  const store = useStoreLabel();
  const idx = Math.max(0, SNAPSHOT_STEPS.findIndex(st => st.phase === progress.phase));
  const step = SNAPSHOT_STEPS[idx] ?? SNAPSHOT_STEPS[0];
  const stepLabel = step.phase === 'upload' ? `${step.label} ${store}` : step.label;
  const parts: string[] = [tr('Bước {{v1}}/{{count}}: {{stepLabel}}', { v1: idx + 1, count: SNAPSHOT_STEPS.length, stepLabel })];
  if (progress.total > 0) parts.push(`${fmtBytes(progress.done)} / ${fmtBytes(progress.total)}`);
  if (progress.phase === 'upload' && progress.rate && progress.rate > 0) {
    parts.push(`${fmtBytes(progress.rate)}/s`);
    if (progress.total > progress.done) parts.push(tr('còn khoảng {{v1}}', { v1: fmtDuration(((progress.total - progress.done) / progress.rate) * 1000) }));
  }
  const retry = progress.retry;
  return (
    <div className="space-y-1.5 pt-1">
      <ProgressBar value={progress.percent} tone={retry ? 'warning' : 'primary'} label={tr('Tiến độ chụp bản gốc')} />
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <CloudSpinner className="h-3.5 w-3.5" />
        <span>{parts.join(' · ')}</span>
        <span className="font-medium text-foreground">{progress.percent}%</span>
      </p>
      <p className="text-[11px] text-subtle-foreground">
        {trx('Bắt đầu {{v1}} · đã chạy {{v2}}', { v1: fmtHm(progress.startedAt), v2: fmtDuration(now - progress.startedAt) })}
      </p>
      {retry && (
        <p className="text-xs text-warning">
          {trx('Mạng chậm: phần {{v1}} đang gửi lại (lần {{attempt}}/{{maxAttempts}}) — vẫn tiếp tục, không cần làm gì.', { v1: retry.part ?? '?', attempt: retry.attempt, maxAttempts: retry.maxAttempts })}
        </p>
      )}
    </div>
  );
}

// ─── Sync log ─────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<SyncLogEntry['kind'], string> = {
  base: tr('Chụp gốc mới'),
  segment: tr('Đoạn thay đổi'),
  'segments-hour': tr('Đoạn thay đổi'),
  restore: tr('Khôi phục'),
  follow: tr('Máy dự phòng tải về'),
};

const RESULT: Record<SyncLogEntry['result'], { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  ok: { label: tr('Thành công'), variant: 'success' },
  retried: { label: tr('Thử lại'), variant: 'warning' },
  error: { label: tr('Lỗi'), variant: 'destructive' },
};

export function SyncLogTable({ entries, workspaceNames }: { entries: SyncLogEntry[]; workspaceNames?: Map<string, string> | null }) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-subtle-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{tr('Thời điểm')}</th>
            <th className="px-3 py-2 font-medium">{tr('Loại')}</th>
            <th className="px-3 py-2 font-medium">{tr('Thay đổi')}</th>
            <th className="px-3 py-2 font-medium">{tr('Dung lượng')}</th>
            <th className="px-3 py-2 font-medium">{tr('Kết quả')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map(e => {
            const result = RESULT[e.result] ?? RESULT.error;
            const time = e.endAt && e.kind === 'segments-hour'
              ? `${fmtLogTime(e.at, now)}–${fmtLogTime(e.endAt, now).slice(-5)}`
              : fmtLogTime(e.at, now);
            const kind = e.kind === 'segments-hour' ? tr('{{v1}} · {{v2}} lần đẩy', { v1: KIND_LABEL[e.kind], v2: fmtNum(e.pushes) }) : (KIND_LABEL[e.kind] ?? e.kind);
            const ws = workspaceNames?.get(e.workspaceId);
            return (
              <tr key={e.id} className="text-foreground">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{time}</td>
                <td className="px-3 py-2">{ws ? <span className="text-muted-foreground">{ws} · </span> : null}{kind}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{e.kind === 'base' ? tr('toàn bộ') : tr('{{v1}} dòng', { v1: fmtNum(e.rows) })}</td>
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

// ─── Backup password ────────────────────────────────────────────────────────────────────

/** 'enable' = turning sync on for the first time (after saving the password, the settings are saved too). */
export type PassphraseDialogKind = 'set' | 'change' | 'enable';

/**
 * Set / change the backup password: enter it twice + confirm you understand that forgetting the password means losing the copy on R2.
 * Only mounted while open (closing discards everything typed).
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
    if (first.length < 8) { setError(tr('Mật khẩu cần ít nhất 8 ký tự.')); return; }
    if (first !== second) { setError(tr('Hai lần nhập không khớp.')); return; }
    if (!ack) { setError(tr('Tick ô xác nhận để tiếp tục.')); return; }
    setError(null);
    onSubmit(first);
  };

  const change = kind === 'change';
  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} size="sm">
      <form className="flex min-h-0 flex-col" onSubmit={e => { e.preventDefault(); submit(); }}>
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{change ? tr('Đổi mật khẩu sao lưu') : tr('Đặt mật khẩu sao lưu')}</DialogTitle>
            <DialogDescription>
              {change
                ? tr('Bản mới trên {{label}} dùng mật khẩu mới. Máy dự phòng phải nhập lại mật khẩu mới.', { label })
                : tr('Bản trên {{label}} được mã hoá bằng mật khẩu này trước khi tải lên. Máy khác phải nhập mật khẩu khi khôi phục.', { label })}
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label={tr('Mật khẩu')} htmlFor={firstId} hint={tr('Ít nhất 8 ký tự. Ghi lại ở nơi an toàn.')}>
            <Input id={firstId} type="password" autoComplete="new-password" value={first} onChange={e => { setFirst(e.target.value); setError(null); }} autoFocus />
          </FormField>
          <FormField label={tr('Nhập lại mật khẩu')} htmlFor={secondId}>
            <Input id={secondId} type="password" autoComplete="new-password" value={second} onChange={e => { setSecond(e.target.value); setError(null); }} />
          </FormField>
          <Checkbox checked={ack} onCheckedChange={next => { setAck(next); setError(null); }} label={tr('Tôi hiểu quên mật khẩu là mất bản trên {{label}}', { label })} />
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{tr('Huỷ')}</Button>
          <Button type="submit" loading={busy}>{kind === 'enable' ? tr('Đặt mật khẩu và bật') : tr('Lưu mật khẩu')}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ─── Copies on R2: which copies can be deleted, labels next to the copies ───────────────────────────────

type CloudRun = ReturnType<typeof useCloudAction>['run'];

const DELETE_KEY = 'delete:';

/** Copy being deleted (by the busy lock of useCloudAction). */
function deletingIdOf(busy: string | null): string | null {
  return busy?.startsWith(DELETE_KEY) ? busy.slice(DELETE_KEY.length) : null;
}

/**
 * Asks again, then permanently deletes one DB copy on the storage (`label` = storage name). Errors from main (e.g. COPY_IN_USE) are shown as is.
 * Returns true when deleted.
 */
async function deleteRemoteCopy(copy: RemoteDbCopy, run: CloudRun, label = 'R2'): Promise<boolean> {
  const ok = await showConfirm({
    title: tr('Xoá hẳn bản sao DB "{{name}}" trên {{label}}?', { name: copy.name, label }),
    message: tr('Máy {{machine}} · đồng bộ {{v1}} · {{v2}}. Không khôi phục được nữa.', { machine: copy.machine, v1: fmtWhen(copy.lastSyncAt), v2: fmtBytes(copy.bytes) }),
    confirmText: tr('Xoá bản này'),
    variant: 'danger',
  });
  if (!ok) return false;
  const res = await run(
    `${DELETE_KEY}${copy.workspaceId}`,
    () => {
      const db = cloudApi()?.db;
      return typeof db?.deleteRemote === 'function' ? db.deleteRemote(copy.workspaceId) : undefined;
    },
    tr('Đã xoá bản sao trên {{label}}', { label }),
  );
  return !!res;
}

/**
 * Blocks deleting the copy this machine is syncing up, or the copy this machine is monitoring (main blocks it too); labels
 * "Đang đồng bộ từ máy này" (Syncing from this machine) / "Của máy này" (This machine's) / "Máy này đang theo dõi" (This machine is monitoring).
 */
export function remoteCopyRules(status: DbSyncStatus): {
  canDelete: (copy: RemoteDbCopy) => boolean;
  tagOf: (copy: RemoteDbCopy) => string | null;
} {
  const following = status.following;
  const syncing = status.mode !== 'off';
  // This machine's copy: the copy code on R2 (bucket/uid) of each workspace; the workspace id on the machine is kept for main's old copies.
  const ownIds = new Set<string>();
  for (const w of status.workspaces) {
    if (w.copyId) ownIds.add(w.copyId);
    ownIds.add(w.workspaceId);
  }
  return {
    canDelete: copy => copy.workspaceId !== following?.workspaceId && !(syncing && ownIds.has(copy.workspaceId)),
    tagOf: copy => {
      if (copy.workspaceId === following?.workspaceId) return tr('Máy này đang theo dõi');
      if (ownIds.has(copy.workspaceId)) return syncing ? tr('Đang đồng bộ từ máy này') : tr('Của máy này');
      return null;
    },
  };
}

// ─── Standby machine ────────────────────────────────────────────────────────────────────────

/**
 * Standby machine: the server sees which machine is monitoring + a button to start monitoring another machine's copy; a standby machine sees
 * "Đang theo dõi bản của …" (Monitoring the copy of …) + Switch to this machine (opens the restore wizard in promote mode) / Stop monitoring.
 */
export function StandbyCard({ status, ready, onWizard, onStatus, onRefresh, className }: {
  status: DbSyncStatus;
  ready: boolean;
  /** Open the restore wizard (Switch to this machine). */
  onWizard: (options: RestoreWizardOptions) => void;
  /** New DB status from main (follow on/off). */
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
      title: tr('Tắt theo dõi?'),
      message: tr('Máy này ngừng tải bản sao của {{sourceMachine}}. Dữ liệu đã tải về máy vẫn giữ.', { sourceMachine: following.sourceMachine }),
      confirmText: tr('Tắt theo dõi'),
      variant: 'warning',
    });
    if (!ok) return;
    const res = await run('follow', () => cloudApi()?.db.follow({ workspaceId: following.workspaceId, on: false }), tr('Đã tắt theo dõi'));
    if (res) applyStatus(res.status);
  };

  const promote = () => {
    if (!following) return;
    onWizard({ mode: 'promote', workspaceId: following.workspaceId, sourceMachine: following.sourceMachine, passphraseSet: !!status.passphraseSet });
  };

  return (
    <Card className={cn('space-y-2 p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{tr('Máy dự phòng')}</p>
        {!following && (
          <span className="text-xs text-muted-foreground">
            {followers.length
              ? tr('{{count}} máy đang theo dõi · {{v1}}', { count: followers.length, v1: followers.map(f => tr('{{machine}} · trễ {{v1}}', { machine: f.machine, v1: fmtLag(f.lagMs) })).join(', ') })
              : tr('Chưa có máy nào theo dõi')}
          </span>
        )}
      </div>
      {following ? (
        <>
          <p className="text-sm text-foreground">
            {trx('Đang theo dõi bản của <0>{{sourceMachine}}</0> · trễ {{v1}}', { 0: <strong />, sourceMachine: following.sourceMachine, v1: fmtLag(following.lagMs) })}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr('Máy này tải đoạn mới mỗi phút. Khi máy chủ hỏng, bấm Chuyển sang máy này để dùng dữ liệu ngay; kênh chat đăng nhập lại ở bước sau.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={promote}>{tr('Chuyển sang máy này')}</Button>
            <Button size="sm" variant="outline" loading={busy === 'follow'} onClick={() => void stopFollow()}>{tr('Tắt theo dõi')}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-foreground">
            {provider === 'gdrive'
              ? tr('Máy khác cài Deplao, chọn kho Google Drive và đăng nhập cùng tài khoản Google rồi bật Theo dõi bản sao.')
              : tr('Máy khác cài Deplao, kết nối cùng Cloudflare rồi bật Theo dõi bản sao.')}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr('Máy đó tải đoạn mới mỗi phút; khi cần thì bấm Chuyển sang máy này ngay trên máy đó.')}
          </p>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => setFollowOpen(true)}>
            {tr('Dùng máy này theo dõi bản của máy khác…')}
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
            notify(tr('Đã bật theo dõi bản sao'), 'success');
          }}
        />
      )}
    </Card>
  );
}

/**
 * Turn on standby mode: pick another machine's copy on the storage → enter the backup password → db.follow({ on: true }).
 * Copies of machines / workspaces that are no longer used can be deleted right in the list (trash button).
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
      else { setCopies([]); setLoadError(res?.error || tr('Không đọc được danh sách bản sao trên {{label}}.', { label })); }
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
    if (!selected) { setError(tr('Chọn bản sao cần theo dõi.')); return; }
    if (!passphrase && !passphraseSet) { setError(tr('Nhập mật khẩu sao lưu của máy chủ.')); return; }
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
          <DialogTitle>{tr('Theo dõi bản sao của máy khác')}</DialogTitle>
          <DialogDescription>{tr('Máy này tải đoạn mới mỗi phút; khi máy chủ hỏng thì chuyển sang dùng ngay.')}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-4">
        {copies === null ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CloudSpinner className="h-3.5 w-3.5" /> {tr('Đang đọc bản sao trên {{label}}…', { label })}
          </p>
        ) : copies.length === 0 ? (
          <Notice tone={loadError ? 'destructive' : 'info'} action={<Button size="sm" variant="ghost" onClick={() => void load()}>{tr('Tải lại')}</Button>}>
            <p>{loadError || tr('Chưa có bản sao nào trên {{label}} của tài khoản này.', { label })}</p>
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
          label={tr('Mật khẩu sao lưu của máy chủ')}
          htmlFor={passId}
          hint={passphraseSet ? tr('Để trống nếu giống mật khẩu đã lưu trên máy này.') : undefined}
        >
          <Input id={passId} type="password" autoComplete="off" value={passphrase} onChange={e => { setPassphrase(e.target.value); setError(null); }} />
        </FormField>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy === 'follow'}>{tr('Huỷ')}</Button>
        <Button loading={busy === 'follow'} disabled={!copies?.length} onClick={() => void submit()}>{tr('Bật theo dõi')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── DB copy on R2 ──────────────────────────────────────────────────────────────────

/**
 * "Bản sao DB trên R2" (DB copies on R2): the list is only read when "Xem các bản trên R2" (View copies on R2) is clicked (it does not read on a timer); permanently deletes the copy of a machine /
 * workspace that is no longer used. A copy this machine is syncing up or monitoring has no delete button.
 */
export function RemoteCopiesCard({ ready, canDelete, tagOf, initialCopies = null }: {
  ready: boolean;
  canDelete: (copy: RemoteDbCopy) => boolean;
  /** Label next to a copy ("Đang đồng bộ từ máy này" (Syncing from this machine), "Máy này đang theo dõi" (This machine is monitoring), "Của máy này" (This machine's)). */
  tagOf?: (copy: RemoteDbCopy) => string | null;
  /** List read earlier (test). */
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
      else { setCopies([]); setError(res?.error || tr('Không đọc được danh sách bản sao trên {{label}}.', { label })); }
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
          <p className="text-sm font-semibold text-foreground">{tr('Bản sao DB trên {{label}}', { label })}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {provider === 'gdrive'
              ? tr('Các bản đang có trên Google Drive (của mọi máy dùng tài khoản Google này). Xoá bản của máy cũ không dùng nữa để bớt dung lượng.')
              : tr('Các bản đang có trong kho R2 (của mọi máy dùng tài khoản Cloudflare này). Xoá bản của máy cũ không dùng nữa để bớt dung lượng.')}
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
          {copies ? tr('Tải lại') : tr('Xem các bản trên {{label}}', { label })}
        </Button>
      </div>
      {error && <Notice tone="destructive"><p>{error}</p></Notice>}
      {copies && !error && copies.length === 0 && <p className="text-xs text-muted-foreground">{tr('Chưa có bản sao nào trên {{label}}.', { label })}</p>}
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
                      {tr('Xoá bản này trên {{label}}', { label })}
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
