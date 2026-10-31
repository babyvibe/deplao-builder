/**
 * Cài đặt → Internet & Đám mây → Đồng bộ dữ liệu: MỘT thiết lập cho dữ liệu (DB) và ảnh/file (media) của workspace đang
 * mở (sync.get / sync.apply — src/shared/cloud/cloudContracts.ts):
 *  1. Thiết lập đồng bộ — form nháp, lưu bằng MỘT nút ("Lưu thiết lập", "Bật đồng bộ" khi đang tắt): tài khoản, thời
 *     gian, chế độ (Tắt · Theo giờ · Realtime), kèm ảnh/video/file (mặc định bật) + file chung, mật khẩu sao lưu.
 *     Đang đồng bộ thì thu gọn thành một dòng tóm tắt + "Thay đổi".
 *  2. Trạng thái — Dữ liệu (lần đồng bộ, bản trên R2, phạm vi, tiến độ chụp bản gốc; Đồng bộ ngay, Khôi phục…) và
 *     Ảnh & file (đã lên bao nhiêu, tiến độ, lý do đang chờ; Tạm dừng / Tiếp tục).
 *  3. Nâng cao (SyncAdvanced, mở sẵn) — tải ảnh, giữ / xoá file trên máy, dọn R2, máy dự phòng, bản sao DB, nhật ký.
 * Bật lần đầu cần mật khẩu sao lưu: chưa đặt (hoặc main báo PASSPHRASE_REQUIRED) → hộp đặt mật khẩu rồi lưu tiếp.
 *
 * Kho lưu (khi biết trạng thái kho — storage.status()): thẻ "Kho lưu" (StoragePicker: R2 / Google Drive) ở đầu phần và
 * "Mức sử dụng & chi phí" (UsageCard) dưới phần Trạng thái; câu chữ dùng tên kho đang chọn (StorageContext). Chưa biết
 * kho (bản app cũ) → như trước: R2, sẵn sàng theo kết nối Cloudflare, không có hai thẻ này.
 */
import React, { useRef, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  AlertIcon,
  DatabaseIcon,
  EditIcon,
  ExternalLinkIcon,
  ImageIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
} from '@/components/common/icons';
import { Badge, Button, Card, Checkbox } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  sameScope,
  storageLabel,
  type CloudConnectionStatus,
  type CloudScope,
  type CloudStorageProvider,
  type CloudStorageStatus,
  type DbSyncMode,
  type DbSyncStatus,
  type DbSyncWorkspaceStatus,
  type MediaSyncStatus,
  type SyncConfig,
  type SyncLogEntry,
  type SyncOverview,
} from '../../../../../shared/cloud/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  describeScope,
  fmtBytes,
  fmtBytesPair,
  fmtNum,
  fmtSyncTime,
  fmtUsd,
  fmtWhen,
  GOOGLE_DRIVE_URL,
  isMediaBackingOff,
  isStorageReady,
  mediaDetail,
  Notice,
  openExternalUrl,
  PillGroup,
  ProgressBar,
  r2DashboardUrl,
  r2MonthlyUsd,
  scopeProblem,
  StorageContext,
  StorageRequiredNotice,
  useCloudAction,
  useStorage,
  useStoreLabel,
  type ScopeAccount,
} from '../cloudUi';
import { RestoreStateBanner } from '../restore/RestoreStateBanner';
import { RestoreWizard, type RestoreWizardOptions } from '../restore/RestoreWizard';
import { ScopePicker, ScopeRow, useScopeAccounts } from './ScopePicker';
import { StoragePicker } from './StoragePicker';
import { SyncAdvanced } from './SyncAdvanced';
import {
  describeSyncConfig,
  normalizeSyncConfig,
  overviewOrDefault,
  sameSyncConfig,
  SYNC_MODE_LABEL,
  SYNC_MODES,
  syncModeNote,
  syncSavedMessage,
} from './syncHelpers';
import { PassphraseDialog, SnapshotProgress, StandbyCard, type PassphraseDialogKind } from './syncParts';
import { UsageCard } from './UsageCard';

export interface SyncSectionProps {
  connection: CloudConnectionStatus | null;
  /**
   * Kho lưu (storage.status()). Thiếu (undefined) = lấy từ StorageContext; null = chưa biết (bản app cũ) → như trước:
   * kho R2, sẵn sàng theo kết nối Cloudflare, không có thẻ Kho lưu / Mức sử dụng.
   */
  storage?: CloudStorageStatus | null;
  /** Trạng thái kho mới từ main (đổi kho, đăng nhập / ngắt Google). */
  onStorage?: (storage: CloudStorageStatus) => void;
  /** sync.get(); null = chưa đọc được (vẽ theo mặc định). */
  overview: SyncOverview | null;
  /** Trạng thái mới từ main (sync.apply, media.setOptions, db.follow…). */
  onOverview?: (overview: SyncOverview) => void;
  onRefresh?: () => void;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Hiện dải "Đã khôi phục dữ liệu…" (CloudSettings đã hiện ở đầu trang thì tắt). */
  showRestoreBanner?: boolean;
  /** Tài khoản để chọn / hiện tên; mặc định tài khoản của workspace đang mở. */
  accounts?: ReadonlyArray<ScopeAccount>;
  /** Mở sẵn form khi đồng bộ đang bật (test). */
  initialEditing?: boolean;
  /** Mở sẵn phần Nâng cao (mặc định có). */
  initialAdvancedOpen?: boolean;
  /** Nhật ký đã đọc trước (test). */
  initialLog?: SyncLogEntry[] | null;
}

const DETAIL_TONE = {
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const;

/**
 * Hỏi lại trước khi lưu: tắt đồng bộ; đổi tài khoản / thời gian khi đã có bản trên kho (bản gốc mới thay bản cũ);
 * thôi tải ảnh khi còn file đã dọn khỏi máy (chỉ còn trên kho). `label` = tên kho. Trả true khi được lưu.
 */
async function confirmSyncChange(
  before: SyncConfig,
  after: SyncConfig,
  db: DbSyncStatus,
  media: MediaSyncStatus,
  label = 'R2',
): Promise<boolean> {
  const turningOff = before.mode !== 'off' && after.mode === 'off';
  const rebase = !sameScope(before.scope, after.scope) && db.workspaces.some(w => !!w.baseAt);
  const evicted = media.totals.evicted;
  const strands = media.enabled && evicted > 0 && !(after.mode !== 'off' && after.includeMedia);
  const strandText = strands
    ? `${fmtNum(evicted)} file đã dọn khỏi máy (chỉ còn trên ${label}) sẽ không mở được cho tới khi bật lại — nên tải về máy trước: Nâng cao → Tải lại toàn bộ file đã dọn.`
    : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

  if (turningOff) {
    return showConfirm({
      title: 'Tắt đồng bộ?',
      message: join(
        `Bản trên ${label} vẫn giữ và vẫn khôi phục được.`,
        rebase ? 'Lần bật sau sẽ tạo bản gốc mới theo tài khoản / thời gian mới.' : '',
        strandText,
      ),
      confirmText: 'Tắt đồng bộ',
      variant: 'warning',
    });
  }
  if (rebase) {
    return showConfirm({
      title: 'Đổi tài khoản / thời gian?',
      message: join(
        `Đổi tài khoản / thời gian sẽ tạo bản gốc mới trên ${label} theo lựa chọn mới; bản cũ sẽ bị thay. File ảnh đã lên ${label} vẫn giữ.`,
        strandText,
      ),
      confirmText: 'Lưu và tạo bản mới',
      variant: 'warning',
    });
  }
  if (strands) {
    return showConfirm({ title: 'Bỏ kèm ảnh, video, file?', message: strandText, confirmText: 'Vẫn lưu', variant: 'warning' });
  }
  return true;
}

/** Đặt kho lưu vào StorageContext cho mọi mảnh bên dưới (SyncAdvanced, hộp dọn file, trình khôi phục…). */
export default function SyncSection(props: SyncSectionProps) {
  const contextStorage = useStorage();
  const storage = props.storage !== undefined ? props.storage : contextStorage;
  return (
    <StorageContext.Provider value={storage ?? null}>
      <SyncSectionBody {...props} storage={storage ?? null} />
    </StorageContext.Provider>
  );
}

function SyncSectionBody({
  connection,
  storage,
  onStorage,
  overview,
  onOverview,
  onRefresh,
  onConnect,
  onRecheck,
  rechecking,
  showRestoreBanner = true,
  accounts: accountsProp,
  initialEditing = false,
  initialAdvancedOpen = true,
  initialLog = null,
}: SyncSectionProps) {
  const view = overviewOrDefault(overview);
  const saved = view.config;
  const { db, media } = view;
  const accounts = useScopeAccounts(accountsProp);
  const provider: CloudStorageProvider = storage?.provider ?? 'r2';
  const label = storageLabel(provider);
  const ready = isStorageReady(storage, connection);
  const { busy, run, notify } = useCloudAction();

  // "Chọn kho lưu" ở thông báo phía trên: cuộn tới thẻ Kho lưu và làm nổi một lúc.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerFlash, setPickerFlash] = useState(false);
  const focusPicker = () => {
    pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPickerFlash(true);
    window.setTimeout(() => setPickerFlash(false), 1800);
  };

  // Form nháp: null = đang hiện đúng thiết lập đã lưu. Chỉ lưu khi bấm nút.
  const [draft, setDraft] = useState<SyncConfig | null>(null);
  const [formOpen, setFormOpen] = useState(initialEditing);
  const [applying, setApplying] = useState(false);
  const [passDialog, setPassDialog] = useState<PassphraseDialogKind | null>(null);
  // Thiết lập chờ lưu sau khi đặt mật khẩu (bật đồng bộ lần đầu).
  const pendingApply = useRef<SyncConfig | null>(null);
  const [wizard, setWizard] = useState<RestoreWizardOptions | null>(null);

  const syncOn = saved.mode !== 'off';
  const editing = !syncOn || formOpen;
  const value = draft ?? saved;
  const dirty = !sameSyncConfig(value, saved);
  const problem = scopeProblem(value.scope);
  const turningOn = !syncOn && value.mode !== 'off';
  const hasCopy = db.workspaces.some(w => !!w.baseAt);
  const locked = applying || busy === 'pass';
  const formDisabled = !ready || locked;

  const edit = (patch: Partial<SyncConfig>) => setDraft(prev => ({ ...(prev ?? saved), ...patch }));
  const cancelEdit = () => {
    setDraft(null);
    setFormOpen(false);
  };

  /** Gộp trạng thái mới của một module vào overview đang có (chưa có overview thì đọc lại). */
  const patchOverview = (patch: Partial<SyncOverview>) => {
    if (overview && onOverview) onOverview({ ...overview, ...patch });
    else onRefresh?.();
  };

  const apply = async (cfg: SyncConfig) => {
    const sync = cloudApi()?.sync;
    if (typeof sync?.apply !== 'function') {
      notify('Bản app này chưa có tính năng này. Hãy cập nhật Deplao.', 'warning');
      return;
    }
    const before = saved;
    setApplying(true);
    try {
      const res = await sync.apply(cfg);
      if (!res?.success) {
        if (res?.code === 'PASSPHRASE_REQUIRED') {
          pendingApply.current = cfg;
          setPassDialog('enable');
          return;
        }
        notify(res?.error || 'Lưu không thành công, thử lại sau.', 'error');
        onRefresh?.(); // các bước trước chỗ lỗi có thể đã lưu
        return;
      }
      if (res.overview && onOverview) onOverview(res.overview);
      else onRefresh?.();
      setDraft(null);
      setFormOpen(false);
      notify(syncSavedMessage(before, cfg, !!res.rebase, label), 'success');
    } catch (err) {
      notify(cleanIpcError(err), 'error');
      onRefresh?.();
    } finally {
      setApplying(false);
    }
  };

  const save = async () => {
    if (!dirty || locked) return;
    if (problem) { notify(problem, 'warning'); return; }
    const cfg = normalizeSyncConfig(value);
    if (!(await confirmSyncChange(saved, cfg, db, media, label))) return;
    if (cfg.mode !== 'off' && !db.passphraseSet) {
      pendingApply.current = cfg;
      setPassDialog('enable');
      return;
    }
    await apply(cfg);
  };

  const submitPassphrase = async (passphrase: string) => {
    const kind = passDialog;
    if (!kind) return;
    const okMessage = kind === 'change' ? 'Đã đổi mật khẩu sao lưu' : kind === 'set' ? 'Đã đặt mật khẩu sao lưu' : undefined;
    const res = await run('pass', () => cloudApi()?.db.setPassphrase(passphrase), okMessage);
    if (!res) return;
    setPassDialog(null);
    const pending = pendingApply.current;
    pendingApply.current = null;
    if (kind === 'enable' && pending) await apply(pending);
    else onRefresh?.();
  };

  const closePassDialog = () => {
    pendingApply.current = null;
    setPassDialog(null);
  };

  const syncNow = async () => {
    if (await run('sync', () => cloudApi()?.db.syncNow(), `Đang đồng bộ lên ${label}`)) onRefresh?.();
  };
  const pauseMedia = async () => { if (await run('pause', () => cloudApi()?.media.pause())) onRefresh?.(); };
  // Thiết lập cũ: đồng bộ dữ liệu tắt mà ảnh vẫn tải lên (bật riêng ở màn hình cũ) — dừng ảnh cho khớp một công tắc.
  const stopMediaOnly = async () => {
    const res = await run('media-off', () => cloudApi()?.media.setEnabled(false), 'Đã dừng tải ảnh, file');
    if (res?.status) patchOverview({ media: res.status });
    else if (res) onRefresh?.();
  };
  const resumeMedia = async () => { if (await run('resume', () => cloudApi()?.media.resume())) onRefresh?.(); };
  const openRestore = () => setWizard({ mode: 'same', workspaceId: db.workspaces[0]?.workspaceId, passphraseSet: !!db.passphraseSet });

  // Đổi kho chỉ khi không còn gì chạy trên kho hiện tại (main cũng chặn — STORAGE_SWITCH_BLOCKED).
  const storeLockReason = syncOn || media.enabled
    ? 'Tắt đồng bộ để đổi kho lưu.'
    : db.following
      ? 'Tắt theo dõi bản sao (máy dự phòng) để đổi kho lưu.'
      : null;

  return (
    <div className="space-y-4">
      {showRestoreBanner && <RestoreStateBanner />}
      <StorageRequiredNotice
        storage={storage}
        connection={connection}
        onConnect={onConnect}
        onRecheck={onRecheck}
        rechecking={rechecking}
        onPickStore={storage ? focusPicker : undefined}
      />

      {storage && (
        <div ref={pickerRef} className="scroll-mt-4">
          <StoragePicker
            storage={storage}
            connection={connection}
            lockReason={storeLockReason}
            inUse={syncOn || media.enabled}
            onStorage={onStorage}
            onProviderChanged={() => onRefresh?.()}
            onConnect={onConnect}
            highlight={pickerFlash}
          />
        </div>
      )}

      {!syncOn && media.enabled && (
        <Notice
          tone="warning"
          title={`Ảnh, file vẫn đang tải lên ${label}`}
          action={(
            <Button size="sm" variant="outline" loading={busy === 'media-off'} onClick={() => void stopMediaOnly()}>
              Dừng tải ảnh
            </Button>
          )}
        >
          <p>Thiết lập cũ: đồng bộ dữ liệu đang tắt nhưng ảnh, file vẫn tải lên. Bật đồng bộ để chạy cả hai, hoặc dừng tải ảnh.</p>
        </Notice>
      )}

      {/* Máy này đang theo dõi bản của máy khác: việc chính của máy này, hiện ngay đầu phần. */}
      {db.following && (
        <StandbyCard
          status={db}
          ready={ready}
          onWizard={setWizard}
          onStatus={next => patchOverview({ db: next })}
          onRefresh={onRefresh}
          className="border-primary/40"
        />
      )}

      <Card className={cn('space-y-4 p-4', !ready && 'opacity-60')}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Thiết lập đồng bộ</p>
            {syncOn ? (
              <p className="mt-1 flex items-start gap-2 text-sm text-foreground">
                <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span>Đang đồng bộ: {describeSyncConfig(saved, accounts)}</span>
              </p>
            ) : (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {hasCopy
                  ? `Đang tắt. Bản trên ${label} vẫn giữ và vẫn khôi phục được.`
                  : `Chọn tài khoản, thời gian và chế độ rồi bấm Bật đồng bộ. Dữ liệu được mã hoá trên máy trước khi tải lên ${label} của bạn.`}
              </p>
            )}
          </div>
          {syncOn && !formOpen && (
            <Button size="sm" variant="outline" leftIcon={<EditIcon className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
              Thay đổi
            </Button>
          )}
        </div>

        {editing && (
          <div className="space-y-4">
            <ScopePicker
              label="Tài khoản và thời gian đồng bộ"
              value={value.scope}
              accounts={accounts}
              disabled={formDisabled}
              onChange={scope => edit({ scope })}
            />
            <ScopeRow label="Chế độ">
              <PillGroup
                label="Chế độ đồng bộ"
                value={value.mode}
                disabled={locked}
                onChange={(mode: DbSyncMode) => edit({ mode })}
                options={SYNC_MODES.map(mode => ({
                  value: mode,
                  label: SYNC_MODE_LABEL[mode],
                  disabled: mode !== 'off' && !ready,
                }))}
              />
              <p className="text-xs text-muted-foreground">{syncModeNote(value.mode, label)}</p>
            </ScopeRow>
            <ScopeRow label="Ảnh, file">
              <div className="space-y-2.5 pt-1.5">
                <Checkbox
                  checked={value.includeMedia}
                  disabled={formDisabled}
                  onCheckedChange={includeMedia => edit({ includeMedia })}
                  label="Kèm ảnh, video, file"
                  description={`Chạy nền, tải dần lên ${label}. Bỏ chọn thì chỉ đồng bộ tin nhắn, danh bạ, cài đặt.`}
                />
                {value.includeMedia && (
                  <Checkbox
                    className="pl-6"
                    checked={value.includeShared}
                    disabled={formDisabled}
                    onCheckedChange={includeShared => edit({ includeShared })}
                    label="File chung (thư viện media, công việc, file tải lên)"
                  />
                )}
              </div>
            </ScopeRow>
          </div>
        )}

        <div className="space-y-1 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Mật khẩu sao lưu</p>
            <Badge size="sm" variant={db.passphraseSet ? 'success' : 'default'}>{db.passphraseSet ? 'Đã đặt' : 'Chưa đặt'}</Badge>
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              disabled={!ready || locked}
              onClick={() => setPassDialog(db.passphraseSet ? 'change' : 'set')}
            >
              {db.passphraseSet ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
            <span>{`Lưu mã hoá trên máy này để app tự đồng bộ. Quên mật khẩu thì máy khác không mở được bản trên ${label}.`}</span>
          </p>
        </div>

        {editing && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {dirty && <span className="mr-auto text-xs text-warning">{problem || 'Chưa lưu thay đổi'}</span>}
            {(dirty || formOpen) && (
              <Button size="sm" variant="ghost" disabled={locked} onClick={cancelEdit}>Huỷ</Button>
            )}
            <Button
              size="sm"
              loading={applying}
              disabled={!dirty || !!problem || busy === 'pass' || (!ready && value.mode !== 'off')}
              onClick={() => void save()}
            >
              {turningOn ? 'Bật đồng bộ' : 'Lưu thiết lập'}
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-sm font-semibold text-foreground">Trạng thái</p>
        <div className="divide-y divide-border">
          <DataStatus
            db={db}
            mode={saved.mode}
            scope={saved.scope}
            accounts={accounts}
            ready={ready}
            syncing={busy === 'sync'}
            onSyncNow={() => void syncNow()}
            onRestore={openRestore}
          />
          <MediaStatus
            media={media}
            includeMedia={saved.includeMedia}
            ready={ready}
            busy={busy}
            onPause={() => void pauseMedia()}
            onResume={() => void resumeMedia()}
          />
        </div>
        <StoreUsage db={db} media={media} provider={provider} accountId={connection?.accountId ?? null} />
      </Card>

      {storage && (
        <UsageCard
          provider={provider}
          accountId={connection?.accountId ?? null}
          reloadKey={`${storage.ready ? 1 : 0}|${storage.google?.email ?? ''}|${connection?.accountId ?? ''}`}
        />
      )}

      <SyncAdvanced
        overview={view}
        ready={ready}
        onMedia={next => patchOverview({ media: next })}
        onDb={next => patchOverview({ db: next })}
        onRefresh={onRefresh}
        onWizard={setWizard}
        hideStandby={!!db.following}
        initialOpen={initialAdvancedOpen}
        initialLog={initialLog}
      />

      {passDialog && (
        <PassphraseDialog
          kind={passDialog}
          busy={busy === 'pass' || applying}
          onCancel={closePassDialog}
          onSubmit={pass => void submitPassphrase(pass)}
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

// ─── Trạng thái ────────────────────────────────────────────────────────────────────────

function StatusHeading({ icon, title, actions }: { icon: React.ReactNode; title: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{icon}</span>
        {title}
      </p>
      {actions != null && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Dữ liệu: một khối cho mỗi workspace trên máy (lần đồng bộ, bản trên kho, phạm vi, tiến độ chụp bản gốc / lỗi). */
function DataStatus({ db, mode, scope, accounts, ready, syncing, onSyncNow, onRestore }: {
  db: DbSyncStatus;
  mode: DbSyncMode;
  /** Phạm vi đã lưu (workspace không ghi phạm vi riêng thì dùng cái này). */
  scope: CloudScope;
  accounts: ReadonlyArray<ScopeAccount>;
  ready: boolean;
  syncing: boolean;
  onSyncNow: () => void;
  onRestore: () => void;
}) {
  const label = useStoreLabel();
  const workspaces = db.workspaces;
  const working = workspaces.some(w => w.state === 'syncing' || w.state === 'snapshotting');
  return (
    <section aria-label="Dữ liệu" className="space-y-3 py-3">
      <StatusHeading
        icon={<DatabaseIcon />}
        title="Dữ liệu"
        actions={(
          <>
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
          </>
        )}
      />
      {workspaces.length > 0 ? (
        <div className="space-y-3">
          {workspaces.map(ws => (
            <WorkspaceStatus
              key={ws.workspaceId}
              ws={ws}
              showName={workspaces.length > 1}
              scopeText={describeScope(ws.scope ?? scope, accounts)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {mode === 'off' ? `Chưa có bản nào trên ${label}.` : 'Đang chuẩn bị bản gốc đầu tiên…'}
        </p>
      )}
    </section>
  );
}

function WorkspaceStatus({ ws, showName, scopeText }: { ws: DbSyncWorkspaceStatus; showName: boolean; scopeText: string }) {
  const label = useStoreLabel();
  const working = ws.state === 'syncing' || ws.state === 'snapshotting';
  const dot = ws.state === 'error' ? 'bg-destructive' : ws.state === 'paused' ? 'bg-warning' : ws.lastSyncAt ? 'bg-success' : 'bg-accent';
  const stateText = ws.state === 'syncing' ? 'Đang đồng bộ…'
    : ws.state === 'snapshotting' ? 'Đang chụp bản gốc…'
      : ws.state === 'paused' ? 'Đang tạm dừng'
        : ws.state === 'error' ? (ws.lastError || 'Đồng bộ bị lỗi, sẽ thử lại.')
          : null;
  return (
    <div className="flex items-start gap-2.5">
      <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {showName && <p className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">{ws.name}</p>}
        <p className="text-sm text-foreground">
          {ws.lastSyncAt ? `Đồng bộ gần nhất ${fmtSyncTime(ws.lastSyncAt)} · ${fmtNum(ws.lastChanges)} thay đổi` : 'Chưa đồng bộ lần nào'}
        </p>
        <p className="text-xs text-muted-foreground">
          {ws.baseAt
            ? `Bản trên ${label}: gốc ${fmtWhen(ws.baseAt)} + ${fmtNum(ws.segments)} đoạn · ${fmtBytes(ws.bytes)} · đã mã hoá`
            : `Chưa có bản trên ${label}`}
        </p>
        <p className="text-xs text-muted-foreground">Phạm vi: {scopeText}</p>
        {ws.progress && <SnapshotProgress progress={ws.progress} />}
        {stateText && !ws.progress && (
          <p className={cn('flex items-center gap-1.5 text-xs', ws.state === 'error' ? 'text-destructive' : ws.state === 'paused' ? 'text-warning' : 'text-muted-foreground')}>
            {working && <CloudSpinner className="h-3.5 w-3.5" />}{stateText}
          </p>
        )}
      </div>
    </div>
  );
}

/** Ảnh & file: đã lên bao nhiêu, tiến độ, lý do đang chờ (lùi vì mạng / kho giới hạn = cảnh báo), Tạm dừng / Tiếp tục. */
function MediaStatus({ media, includeMedia, ready, busy, onPause, onResume }: {
  media: MediaSyncStatus;
  includeMedia: boolean;
  ready: boolean;
  busy: string | null;
  onPause: () => void;
  onResume: () => void;
}) {
  const label = useStoreLabel();
  const t = media.totals;
  const detail = mediaDetail(media);
  const pct = t.files > 0 ? (t.uploaded / t.files) * 100 : 0;
  const showTotals = media.enabled || t.files > 0;
  const actions = includeMedia && media.enabled ? (
    media.paused ? (
      <Button size="sm" variant="outline" leftIcon={<PlayIcon className="h-4 w-4" />} loading={busy === 'resume'} disabled={!ready} onClick={onResume}>
        Tiếp tục
      </Button>
    ) : (
      <Button
        size="sm"
        variant="outline"
        leftIcon={<PauseIcon className="h-4 w-4" />}
        loading={busy === 'pause'}
        disabled={!ready || (!media.running && t.pending === 0)}
        onClick={onPause}
      >
        Tạm dừng
      </Button>
    )
  ) : undefined;

  return (
    <section aria-label="Ảnh và file" className="space-y-2 py-3">
      <StatusHeading icon={<ImageIcon />} title="Ảnh & file" actions={actions} />
      {!includeMedia ? (
        <p className="text-xs text-muted-foreground">
          Không kèm ảnh, video, file{t.uploaded > 0 ? ` · ${fmtNum(t.uploaded)} file đã lên ${label} vẫn giữ` : ''}.
        </p>
      ) : (
        <>
          {showTotals && (
            <>
              <p className="text-sm text-foreground">
                Đã lên {fmtNum(t.uploaded)} / {fmtNum(t.files)} file · {fmtBytesPair(t.bytesUploaded, t.bytesTotal)}
              </p>
              <ProgressBar value={pct} tone={media.lastError ? 'warning' : 'primary'} label={`Tiến độ tải ảnh, file lên ${label}`} />
            </>
          )}
          <p className={cn('text-xs', DETAIL_TONE[detail.tone])}>{detail.text}</p>
          {media.enabled && media.lastError && !isMediaBackingOff(media) && (
            <p className="text-xs text-destructive">{media.lastError}</p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Dung lượng đang dùng trên kho (dữ liệu + ảnh/file). R2: kèm ước tính tiền mỗi tháng + link trang R2 trên Cloudflare;
 * Google Drive: dung lượng + link Google Drive (dung lượng tài khoản, hạn mức ở thẻ Mức sử dụng & chi phí).
 */
function StoreUsage({ db, media, provider, accountId }: {
  db: DbSyncStatus;
  media: MediaSyncStatus;
  provider: CloudStorageProvider;
  accountId: string | null;
}) {
  const dbBytes = db.workspaces.reduce((sum, w) => sum + (Number(w.bytes) || 0), 0);
  const total = dbBytes + (Number(media.totals.bytesUploaded) || 0);
  if (total <= 0) return null;
  if (provider === 'gdrive') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>{`Dung lượng trên Google Drive: ${fmtBytes(total)}`}</span>
        <Button
          variant="link"
          size="sm"
          className="text-xs"
          rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
          onClick={() => openExternalUrl(GOOGLE_DRIVE_URL)}
        >
          Mở Google Drive
        </Button>
      </div>
    );
  }
  const cost = r2MonthlyUsd(total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <span>Dung lượng R2: {fmtBytes(total)} · {cost > 0 ? `ước tính ${fmtUsd(cost)} USD/tháng` : 'trong phần miễn phí 10 GB'}</span>
      <Button
        variant="link"
        size="sm"
        className="text-xs"
        rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
        onClick={() => openExternalUrl(r2DashboardUrl(accountId))}
      >
        Mở R2 trên Cloudflare
      </Button>
    </div>
  );
}
