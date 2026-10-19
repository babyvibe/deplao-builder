/**
 * Cài đặt → Internet & Đám mây → Đồng bộ DB: chế độ Tắt · Theo giờ · Realtime (bật lần đầu bắt buộc đặt mật khẩu sao
 * lưu), trạng thái bản trên R2, Khôi phục… / Đồng bộ ngay, mật khẩu sao lưu, nhật ký đồng bộ và máy dự phòng
 * (máy chủ thấy máy nào đang theo dõi; máy dự phòng thấy "Đang theo dõi bản của …" + Chuyển sang máy này).
 */
import React, { useEffect, useId, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { AlertIcon, RefreshIcon } from '@/components/common/icons';
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
import type {
  CloudConnectionStatus,
  DbSyncMode,
  DbSyncStatus,
  DbSyncWorkspaceStatus,
  RemoteDbCopy,
  SyncLogEntry,
} from '../../../../shared/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  fmtBytes,
  fmtLag,
  fmtLogTime,
  fmtNum,
  fmtSyncTime,
  fmtWhen,
  isR2Ready,
  Notice,
  PillGroup,
  R2RequiredNotice,
  useCloudAction,
} from './cloudUi';
import { RemoteCopyList, RestoreWizard, type RestoreWizardOptions } from './RestoreWizard';
import { RestoreStateBanner } from './RestoreStateBanner';

export interface DbSyncSectionProps {
  connection: CloudConnectionStatus | null;
  status: DbSyncStatus | null;
  onStatus?: (status: DbSyncStatus) => void;
  onRefresh?: () => void;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Nhật ký đã đọc trước (test). */
  initialLog?: SyncLogEntry[] | null;
  /** Hiện dải "Đã khôi phục dữ liệu…" (CloudSettings đã hiện ở đầu trang thì tắt). */
  showRestoreBanner?: boolean;
}

const MODE_LABEL: Record<DbSyncMode, string> = { off: 'Tắt', hourly: 'Theo giờ', realtime: 'Realtime' };

const MODE_NOTE: Record<DbSyncMode, string> = {
  off: 'Không đồng bộ. Bản đã có trên R2 vẫn giữ và khôi phục được.',
  hourly: 'Đẩy thay đổi mỗi giờ · không có thay đổi thì không gọi R2',
  realtime: 'Trễ tối đa 5 giây · không có thay đổi thì không gọi R2',
};

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

type PassDialogState = { kind: 'set' | 'change' | 'enable'; target?: DbSyncMode } | null;

export default function DbSyncSection({
  connection,
  status,
  onStatus,
  onRefresh,
  onConnect,
  onRecheck,
  rechecking,
  initialLog = null,
  showRestoreBanner = true,
}: DbSyncSectionProps) {
  const { busy, run, notify } = useCloudAction();
  const ready = isR2Ready(connection);
  const mode: DbSyncMode = status?.mode ?? 'off';
  const workspaces = status?.workspaces ?? [];
  const following = status?.following ?? null;
  const [passDialog, setPassDialog] = useState<PassDialogState>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [wizard, setWizard] = useState<RestoreWizardOptions | null>(null);

  // ── Nhật ký: đọc khi mở và mỗi khi có lần đồng bộ mới ──
  const [log, setLog] = useState<SyncLogEntry[] | null>(initialLog);
  const [logLimit, setLogLimit] = useState(20);
  const logKey = workspaces.map(w => `${w.workspaceId}:${w.lastSyncAt ?? 0}:${w.baseAt ?? 0}:${w.state}`).join('|');
  useEffect(() => {
    const db = cloudApi()?.db;
    if (!db) return;
    let alive = true;
    db.log({ limit: logLimit })
      .then(res => { if (alive && res?.success && Array.isArray(res.entries)) setLog(res.entries); })
      .catch(() => { if (alive) setLog(prev => prev ?? []); });
    return () => { alive = false; };
  }, [logKey, logLimit]);

  const applyStatus = (res: { status?: DbSyncStatus } | null) => {
    if (res?.status) onStatus?.(res.status);
    else if (res) onRefresh?.();
  };

  const setModeNow = async (next: DbSyncMode) => {
    const ok = next === 'off' ? 'Đã tắt đồng bộ DB' : `Đã bật đồng bộ ${MODE_LABEL[next]}. Deplao chụp bản gốc ngay.`;
    applyStatus(await run('mode', () => cloudApi()?.db.setMode(next), ok));
  };

  const chooseMode = async (next: DbSyncMode) => {
    if (next === mode) return;
    if (next === 'off') {
      const ok = await showConfirm({
        title: 'Tắt đồng bộ DB?',
        message: 'Deplao dừng đẩy thay đổi lên R2. Bản đã có trên R2 vẫn còn và vẫn khôi phục được.',
        confirmText: 'Tắt đồng bộ',
        variant: 'warning',
      });
      if (ok) await setModeNow('off');
      return;
    }
    if (!status?.passphraseSet) { setPassDialog({ kind: 'enable', target: next }); return; }
    await setModeNow(next);
  };

  const submitPassphrase = async (passphrase: string) => {
    const dlg = passDialog;
    if (!dlg) return;
    const res = await run('pass', () => cloudApi()?.db.setPassphrase(passphrase), dlg.kind === 'change' ? 'Đã đổi mật khẩu sao lưu' : dlg.target ? undefined : 'Đã đặt mật khẩu sao lưu');
    if (!res) return;
    setPassDialog(null);
    if (dlg.target) await setModeNow(dlg.target);
    else onRefresh?.();
  };

  const syncNow = async () => {
    if (await run('sync', () => cloudApi()?.db.syncNow(), 'Đang đồng bộ lên R2')) onRefresh?.();
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
    applyStatus(await run('follow', () => cloudApi()?.db.follow({ workspaceId: following.workspaceId, on: false }), 'Đã tắt theo dõi'));
  };

  const openRestore = () => setWizard({ mode: 'same', workspaceId: workspaces[0]?.workspaceId, passphraseSet: !!status?.passphraseSet });
  const promote = () => {
    if (!following) return;
    setWizard({ mode: 'promote', workspaceId: following.workspaceId, sourceMachine: following.sourceMachine, passphraseSet: !!status?.passphraseSet });
  };

  const wsName = new Map<string, string>(workspaces.map(w => [w.workspaceId, w.name] as [string, string]));
  const followers = status?.followers ?? [];

  return (
    <div className="space-y-5">
      {showRestoreBanner && <RestoreStateBanner />}
      <R2RequiredNotice connection={connection} onConnect={onConnect} onRecheck={onRecheck} rechecking={rechecking} />

      <p className="text-xs leading-relaxed text-muted-foreground">
        R2 là kho file của Cloudflare, cất được cả ảnh lẫn file dữ liệu. Deplao giữ một bản sao file DB của bạn trong kho này:
        mã hoá bằng mật khẩu sao lưu ngay trên máy rồi mới tải lên, chỉ đẩy phần thay đổi. Đổi máy thì tải về, giải mã và dùng tiếp.
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm font-semibold text-foreground">Chế độ</p>
        <PillGroup
          label="Chế độ đồng bộ DB"
          value={mode}
          disabled={busy === 'mode' || busy === 'pass'}
          onChange={m => void chooseMode(m)}
          options={(['off', 'hourly', 'realtime'] as DbSyncMode[]).map(value => ({
            value,
            label: MODE_LABEL[value],
            disabled: value !== 'off' && !ready,
          }))}
        />
        <p className="ml-auto text-xs text-muted-foreground">{MODE_NOTE[mode]}</p>
      </div>

      {workspaces.length > 0 ? (
        <div className="space-y-2">
          {workspaces.map(ws => (
            <WorkspaceSyncBox
              key={ws.workspaceId}
              ws={ws}
              showName={workspaces.length > 1}
              mode={mode}
              syncing={busy === 'sync'}
              ready={ready}
              onRestore={openRestore}
              onSyncNow={() => void syncNow()}
            />
          ))}
        </div>
      ) : (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {mode === 'off'
              ? 'Chưa sao lưu workspace nào. Chọn Theo giờ hoặc Realtime để bắt đầu.'
              : 'Đang chuẩn bị bản gốc đầu tiên…'}
          </p>
          <Button size="sm" variant="outline" disabled={!ready} onClick={openRestore}>Khôi phục…</Button>
        </Card>
      )}

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">Mật khẩu sao lưu</p>
          <Badge size="sm" variant={status?.passphraseSet ? 'success' : 'default'}>{status?.passphraseSet ? 'Đã đặt' : 'Chưa đặt'}</Badge>
          <Button
            variant="link"
            size="sm"
            className="text-xs"
            disabled={!ready}
            onClick={() => setPassDialog({ kind: status?.passphraseSet ? 'change' : 'set' })}
          >
            {status?.passphraseSet ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}
          </Button>
        </div>
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <span>Lưu mã hoá trên máy này để app tự đồng bộ. Quên mật khẩu thì máy khác không mở được bản trên R2.</span>
        </p>
      </div>

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
          <SyncLogTable entries={log} workspaceNames={workspaces.length > 1 ? wsName : null} />
        )}
      </div>

      <Card className="space-y-2 p-4">
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
            <p className="text-xs text-foreground">Máy khác cài Deplao, kết nối cùng Cloudflare rồi bật Theo dõi bản sao.</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Máy đó tải đoạn mới mỗi phút; khi cần thì bấm Chuyển sang máy này ngay trên máy đó.
            </p>
            <Button size="sm" variant="outline" disabled={!ready} onClick={() => setFollowOpen(true)}>
              Dùng máy này theo dõi bản của máy khác…
            </Button>
          </>
        )}
      </Card>

      {status?.bucket && (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Bucket {status.bucket} · mã hoá trên máy trước khi tải lên
        </p>
      )}

      {passDialog && (
        <PassphraseDialog
          state={passDialog}
          busy={busy === 'pass' || busy === 'mode'}
          onCancel={() => setPassDialog(null)}
          onSubmit={pass => void submitPassphrase(pass)}
        />
      )}
      {followOpen && (
        <FollowDialog
          passphraseSet={!!status?.passphraseSet}
          onClose={() => setFollowOpen(false)}
          onDone={next => {
            setFollowOpen(false);
            if (next) onStatus?.(next);
            else onRefresh?.();
            notify('Đã bật theo dõi bản sao', 'success');
          }}
        />
      )}
      {wizard && (
        <RestoreWizard
          {...wizard}
          open
          onClose={() => { setWizard(null); onRefresh?.(); }}
        />
      )}
    </div>
  );
}

function WorkspaceSyncBox({ ws, showName, mode, syncing, ready, onRestore, onSyncNow }: {
  ws: DbSyncWorkspaceStatus;
  showName: boolean;
  mode: DbSyncMode;
  syncing: boolean;
  ready: boolean;
  onRestore: () => void;
  onSyncNow: () => void;
}) {
  const working = ws.state === 'syncing' || ws.state === 'snapshotting';
  const dot = ws.state === 'error' ? 'bg-destructive' : ws.state === 'paused' ? 'bg-warning' : ws.lastSyncAt ? 'bg-success' : 'bg-accent';
  const stateText = ws.state === 'syncing' ? 'Đang đồng bộ…'
    : ws.state === 'snapshotting' ? 'Đang chụp bản gốc…'
    : ws.state === 'paused' ? 'Đang tạm dừng'
    : ws.state === 'error' ? (ws.lastError || 'Đồng bộ bị lỗi, sẽ thử lại.')
    : null;
  return (
    <Card className="flex flex-wrap items-start gap-3 p-4">
      <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {showName && <p className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">{ws.name}</p>}
        <p className="text-sm font-semibold text-foreground">
          {ws.lastSyncAt ? `Đồng bộ gần nhất ${fmtSyncTime(ws.lastSyncAt)} · ${fmtNum(ws.lastChanges)} thay đổi` : 'Chưa đồng bộ lần nào'}
        </p>
        <p className="text-xs text-muted-foreground">
          {ws.baseAt
            ? `Bản trên R2: gốc ${fmtWhen(ws.baseAt)} + ${fmtNum(ws.segments)} đoạn · ${fmtBytes(ws.bytes)} · đã mã hoá`
            : 'Chưa có bản trên R2'}
        </p>
        {stateText && (
          <p className={cn('flex items-center gap-1.5 text-xs', ws.state === 'error' ? 'text-destructive' : ws.state === 'paused' ? 'text-warning' : 'text-muted-foreground')}>
            {working && <CloudSpinner className="h-3.5 w-3.5" />}{stateText}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!ready} onClick={onRestore}>Khôi phục…</Button>
        <Button
          size="sm"
          leftIcon={<RefreshIcon className="h-4 w-4" />}
          loading={syncing}
          disabled={!ready || mode === 'off' || working}
          onClick={onSyncNow}
        >
          Đồng bộ ngay
        </Button>
      </div>
    </Card>
  );
}

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

/**
 * Đặt / đổi mật khẩu sao lưu: nhập hai lần + xác nhận đã hiểu quên mật khẩu là mất bản trên R2.
 * Chỉ gắn khi đang mở (đóng là bỏ hết chữ đã gõ).
 */
function PassphraseDialog({ state, busy, onCancel, onSubmit }: {
  state: NonNullable<PassDialogState>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (passphrase: string) => void;
}) {
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

  const change = state.kind === 'change';
  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onCancel(); }} size="sm">
      <form className="flex min-h-0 flex-col" onSubmit={e => { e.preventDefault(); submit(); }}>
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{change ? 'Đổi mật khẩu sao lưu' : 'Đặt mật khẩu sao lưu'}</DialogTitle>
            <DialogDescription>
              {change
                ? 'Bản mới trên R2 dùng mật khẩu mới. Máy dự phòng phải nhập lại mật khẩu mới.'
                : 'Bản trên R2 được mã hoá bằng mật khẩu này trước khi tải lên. Máy khác phải nhập mật khẩu khi khôi phục.'}
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
          <Checkbox checked={ack} onCheckedChange={next => { setAck(next); setError(null); }} label="Tôi hiểu quên mật khẩu là mất bản trên R2" />
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Huỷ</Button>
          <Button type="submit" loading={busy}>{state.kind === 'enable' ? 'Đặt mật khẩu và bật' : 'Lưu mật khẩu'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Bật chế độ máy dự phòng: chọn bản sao của máy khác trên R2 → nhập mật khẩu sao lưu → db.follow({ on: true }). */
function FollowDialog({ passphraseSet, onClose, onDone }: {
  passphraseSet: boolean;
  onClose: () => void;
  onDone: (status: DbSyncStatus | null) => void;
}) {
  const passId = useId();
  const { busy, run } = useCloudAction();
  const [copies, setCopies] = useState<RemoteDbCopy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setCopies(null);
    setLoadError(null);
    try {
      const res = await cloudApi()?.db.listRemote();
      if (res?.success) setCopies(res.copies ?? []);
      else { setCopies([]); setLoadError(res?.error || 'Không đọc được danh sách bản sao trên R2.'); }
    } catch (err) {
      setCopies([]);
      setLoadError(cleanIpcError(err));
    }
  };
  useEffect(() => { void load(); }, []);

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
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><CloudSpinner className="h-3.5 w-3.5" /> Đang đọc bản sao trên R2…</p>
        ) : copies.length === 0 ? (
          <Notice tone={loadError ? 'destructive' : 'info'} action={<Button size="sm" variant="ghost" onClick={() => void load()}>Tải lại</Button>}>
            <p>{loadError || 'Chưa có bản sao nào trên R2 của tài khoản này.'}</p>
          </Notice>
        ) : (
          <RemoteCopyList copies={copies} selectedId={selected} onSelect={id => { setSelected(id); setError(null); }} />
        )}
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
