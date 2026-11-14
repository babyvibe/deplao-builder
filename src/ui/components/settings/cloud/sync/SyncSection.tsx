/**
 * Settings → Internet & Cloud → Data sync: ONE setting for the data (DB) and the images/files (media) of the open
 * workspace (sync.get / sync.apply - src/shared/cloud/cloudContracts.ts):
 *  1. Sync settings: draft form, saved with ONE button ("Lưu thiết lập" (Save settings), "Bật đồng bộ" (Turn on sync) when it is off): account, time
 *     range, mode (Off · Hourly · Realtime), with images/videos/files (on by default) + shared files, backup password.
 *     While syncing, it collapses into a one-line summary + "Thay đổi" (Change).
 *  2. Status: Data (last sync, copy on R2, scope, progress of the original snapshot; Sync now, Restore…) and
 *     Images & files (how much is uploaded, progress, reason for waiting; Pause / Resume).
 *  3. Advanced (SyncAdvanced, open by default): image download, keep / delete files on the machine, R2 cleanup, standby machine, DB copy, log.
 * The first time you turn it on, a backup password is needed: not set (or main reports PASSPHRASE_REQUIRED) → password dialog, then save again.
 *
 * Storage (when the storage status is known - storage.status()): the "Kho lưu" (Storage) card (StoragePicker: R2 / Google Drive) at the top of the section and
 * "Mức sử dụng & chi phí" (Usage & cost) (UsageCard) below the Status part; the wording uses the selected storage name (StorageContext). Unknown
 * storage (old app build) → as before: R2, ready when the Cloudflare connection is ready, without these two cards.
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
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface SyncSectionProps {
  connection: CloudConnectionStatus | null;
  /**
   * Storage (storage.status()). Missing (undefined) = taken from StorageContext; null = unknown (old app build) → as before:
   * R2 storage, ready when the Cloudflare connection is ready, no Storage / Usage cards shown.
   */
  storage?: CloudStorageStatus | null;
  /** New storage status from main (switch storage, sign in / disconnect Google). */
  onStorage?: (storage: CloudStorageStatus) => void;
  /** sync.get(); null = could not be read yet (drawn with defaults). */
  overview: SyncOverview | null;
  /** New state from main (sync.apply, media.setOptions, db.follow…). */
  onOverview?: (overview: SyncOverview) => void;
  onRefresh?: () => void;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Shows the "Đã khôi phục dữ liệu…" (Data restored…) strip (turned off when CloudSettings already shows it at the top of the page). */
  showRestoreBanner?: boolean;
  /** Account to pick / show the name; defaults to the account of the open workspace. */
  accounts?: ReadonlyArray<ScopeAccount>;
  /** Open the form by default when sync is on (test). */
  initialEditing?: boolean;
  /** Open the Advanced section by default (default on). */
  initialAdvancedOpen?: boolean;
  /** Log read earlier (test). */
  initialLog?: SyncLogEntry[] | null;
}

const DETAIL_TONE = {
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const;

/**
 * Asks again before saving: turning sync off; changing account / time range when a copy is already on the storage (the new base snapshot replaces the old one);
 * stopping image download while some files cleaned from the machine remain (only on the storage). `label` = storage name. Returns true when saved.
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
    ? tr('{{v1}} file đã dọn khỏi máy (chỉ còn trên {{label}}) sẽ không mở được cho tới khi bật lại — nên tải về máy trước: Nâng cao → Tải lại toàn bộ file đã dọn.', { v1: fmtNum(evicted), label })
    : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

  if (turningOff) {
    return showConfirm({
      title: tr('Tắt đồng bộ?'),
      message: join(
        tr('Bản trên {{label}} vẫn giữ và vẫn khôi phục được.', { label }),
        rebase ? tr('Lần bật sau sẽ tạo bản gốc mới theo tài khoản / thời gian mới.') : '',
        strandText,
      ),
      confirmText: tr('Tắt đồng bộ'),
      variant: 'warning',
    });
  }
  if (rebase) {
    return showConfirm({
      title: tr('Đổi tài khoản / thời gian?'),
      message: join(
        tr('Đổi tài khoản / thời gian sẽ tạo bản gốc mới trên {{label}} theo lựa chọn mới; bản cũ sẽ bị thay. File ảnh đã lên {{label}} vẫn giữ.', { label }),
        strandText,
      ),
      confirmText: tr('Lưu và tạo bản mới'),
      variant: 'warning',
    });
  }
  if (strands) {
    return showConfirm({ title: tr('Bỏ kèm ảnh, video, file?'), message: strandText, confirmText: tr('Vẫn lưu'), variant: 'warning' });
  }
  return true;
}

/** Puts the storage into StorageContext for every piece below (SyncAdvanced, the file cleanup box, the restore wizard…). */
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

  // "Chọn kho lưu" (Choose storage) in the notice above: scroll to the Storage card and highlight it for a while.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerFlash, setPickerFlash] = useState(false);
  const focusPicker = () => {
    pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPickerFlash(true);
    window.setTimeout(() => setPickerFlash(false), 1800);
  };

  // Draft form: null = showing exactly the saved settings. Only saved when the button is clicked.
  const [draft, setDraft] = useState<SyncConfig | null>(null);
  const [formOpen, setFormOpen] = useState(initialEditing);
  const [applying, setApplying] = useState(false);
  const [passDialog, setPassDialog] = useState<PassphraseDialogKind | null>(null);
  // Settings waiting to be saved after setting the password (turning sync on for the first time).
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

  /** Merge a module's new state into the existing overview (without an overview yet → re-read). */
  const patchOverview = (patch: Partial<SyncOverview>) => {
    if (overview && onOverview) onOverview({ ...overview, ...patch });
    else onRefresh?.();
  };

  const apply = async (cfg: SyncConfig) => {
    const sync = cloudApi()?.sync;
    if (typeof sync?.apply !== 'function') {
      notify(tr('Bản app này chưa có tính năng này. Hãy cập nhật Deplao.'), 'warning');
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
        notify(res?.error || tr('Lưu không thành công, thử lại sau.'), 'error');
        onRefresh?.(); // steps before the error point may have been saved
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
    const okMessage = kind === 'change' ? tr('Đã đổi mật khẩu sao lưu') : kind === 'set' ? tr('Đã đặt mật khẩu sao lưu') : undefined;
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
    if (await run('sync', () => cloudApi()?.db.syncNow(), tr('Đang đồng bộ lên {{label}}', { label }))) onRefresh?.();
  };
  const pauseMedia = async () => { if (await run('pause', () => cloudApi()?.media.pause())) onRefresh?.(); };
  // Old settings: data sync off but images still uploaded (turned on separately in the old screen) → stop the images so they match one switch.
  const stopMediaOnly = async () => {
    const res = await run('media-off', () => cloudApi()?.media.setEnabled(false), tr('Đã dừng tải ảnh, file'));
    if (res?.status) patchOverview({ media: res.status });
    else if (res) onRefresh?.();
  };
  const resumeMedia = async () => { if (await run('resume', () => cloudApi()?.media.resume())) onRefresh?.(); };
  const openRestore = () => setWizard({ mode: 'same', workspaceId: db.workspaces[0]?.workspaceId, passphraseSet: !!db.passphraseSet });

  // Switch storage only when nothing is running on the current storage (main blocks it too: STORAGE_SWITCH_BLOCKED).
  const storeLockReason = syncOn || media.enabled
    ? tr('Tắt đồng bộ để đổi kho lưu.')
    : db.following
      ? tr('Tắt theo dõi bản sao (máy dự phòng) để đổi kho lưu.')
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
          title={tr('Ảnh, file vẫn đang tải lên {{label}}', { label })}
          action={(
            <Button size="sm" variant="outline" loading={busy === 'media-off'} onClick={() => void stopMediaOnly()}>
              {tr('Dừng tải ảnh')}
            </Button>
          )}
        >
          <p>{tr('Thiết lập cũ: đồng bộ dữ liệu đang tắt nhưng ảnh, file vẫn tải lên. Bật đồng bộ để chạy cả hai, hoặc dừng tải ảnh.')}</p>
        </Notice>
      )}

      {/* This machine is monitoring another machine's copy: its main job, shown right at the top of the section. */}
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
            <p className="text-sm font-semibold text-foreground">{tr('Thiết lập đồng bộ')}</p>
            {syncOn ? (
              <p className="mt-1 flex items-start gap-2 text-sm text-foreground">
                <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span>{trx('Đang đồng bộ: {{v1}}', { v1: describeSyncConfig(saved, accounts) })}</span>
              </p>
            ) : (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {hasCopy
                  ? tr('Đang tắt. Bản trên {{label}} vẫn giữ và vẫn khôi phục được.', { label })
                  : tr('Chọn tài khoản, thời gian và chế độ rồi bấm Bật đồng bộ. Dữ liệu được mã hoá trên máy trước khi tải lên {{label}} của bạn.', { label })}
              </p>
            )}
          </div>
          {syncOn && !formOpen && (
            <Button size="sm" variant="outline" leftIcon={<EditIcon className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
              {tr('Thay đổi')}
            </Button>
          )}
        </div>

        {editing && (
          <div className="space-y-4">
            <ScopePicker
              label={tr('Tài khoản và thời gian đồng bộ')}
              value={value.scope}
              accounts={accounts}
              disabled={formDisabled}
              onChange={scope => edit({ scope })}
            />
            <ScopeRow label={tr('Chế độ')}>
              <PillGroup
                label={tr('Chế độ đồng bộ')}
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
            <ScopeRow label={tr('Ảnh, file')}>
              <div className="space-y-2.5 pt-1.5">
                <Checkbox
                  checked={value.includeMedia}
                  disabled={formDisabled}
                  onCheckedChange={includeMedia => edit({ includeMedia })}
                  label={tr('Kèm ảnh, video, file')}
                  description={tr('Chạy nền, tải dần lên {{label}}. Bỏ chọn thì chỉ đồng bộ tin nhắn, danh bạ, cài đặt.', { label })}
                />
                {value.includeMedia && (
                  <Checkbox
                    className="pl-6"
                    checked={value.includeShared}
                    disabled={formDisabled}
                    onCheckedChange={includeShared => edit({ includeShared })}
                    label={tr('File chung (thư viện media, công việc, file tải lên)')}
                  />
                )}
              </div>
            </ScopeRow>
          </div>
        )}

        <div className="space-y-1 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{tr('Mật khẩu sao lưu')}</p>
            <Badge size="sm" variant={db.passphraseSet ? 'success' : 'default'}>{db.passphraseSet ? tr('Đã đặt') : tr('Chưa đặt')}</Badge>
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              disabled={!ready || locked}
              onClick={() => setPassDialog(db.passphraseSet ? 'change' : 'set')}
            >
              {db.passphraseSet ? tr('Đổi mật khẩu') : tr('Đặt mật khẩu')}
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
            <span>{tr('Lưu mã hoá trên máy này để app tự đồng bộ. Quên mật khẩu thì máy khác không mở được bản trên {{label}}.', { label })}</span>
          </p>
        </div>

        {editing && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {dirty && <span className="mr-auto text-xs text-warning">{problem || tr('Chưa lưu thay đổi')}</span>}
            {(dirty || formOpen) && (
              <Button size="sm" variant="ghost" disabled={locked} onClick={cancelEdit}>{tr('Huỷ')}</Button>
            )}
            <Button
              size="sm"
              loading={applying}
              disabled={!dirty || !!problem || busy === 'pass' || (!ready && value.mode !== 'off')}
              onClick={() => void save()}
            >
              {turningOn ? tr('Bật đồng bộ') : tr('Lưu thiết lập')}
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-sm font-semibold text-foreground">{tr('Trạng thái')}</p>
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

// ─── Status ────────────────────────────────────────────────────────────────────────

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

/** Data: one block for each workspace on the machine (last sync, copy on the storage, scope, progress of the original snapshot / errors). */
function DataStatus({ db, mode, scope, accounts, ready, syncing, onSyncNow, onRestore }: {
  db: DbSyncStatus;
  mode: DbSyncMode;
  /** Saved scope (a workspace without its own scope uses this one). */
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
    <section aria-label={tr('Dữ liệu')} className="space-y-3 py-3">
      <StatusHeading
        icon={<DatabaseIcon />}
        title={tr('Dữ liệu')}
        actions={(
          <>
            <Button size="sm" variant="outline" disabled={!ready} onClick={onRestore}>{tr('Khôi phục…')}</Button>
            <Button
              size="sm"
              leftIcon={<RefreshIcon className="h-4 w-4" />}
              loading={syncing}
              disabled={!ready || mode === 'off' || working}
              onClick={onSyncNow}
            >
              {tr('Đồng bộ ngay')}
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
          {mode === 'off' ? tr('Chưa có bản nào trên {{label}}.', { label }) : tr('Đang chuẩn bị bản gốc đầu tiên…')}
        </p>
      )}
    </section>
  );
}

function WorkspaceStatus({ ws, showName, scopeText }: { ws: DbSyncWorkspaceStatus; showName: boolean; scopeText: string }) {
  const label = useStoreLabel();
  const working = ws.state === 'syncing' || ws.state === 'snapshotting';
  const dot = ws.state === 'error' ? 'bg-destructive' : ws.state === 'paused' ? 'bg-warning' : ws.lastSyncAt ? 'bg-success' : 'bg-accent';
  const stateText = ws.state === 'syncing' ? tr('Đang đồng bộ…')
    : ws.state === 'snapshotting' ? tr('Đang chụp bản gốc…')
      : ws.state === 'paused' ? tr('Đang tạm dừng')
        : ws.state === 'error' ? (ws.lastError || tr('Đồng bộ bị lỗi, sẽ thử lại.'))
          : null;
  // New base snapshot (copies + compresses the whole DB, heavy on disk) waits until the machine is idle
  const waitText = ws.baseWaiting === 'battery' ? tr('Chụp bản gốc mới khi cắm sạc')
    : ws.baseWaiting === 'active' ? tr('Chụp bản gốc mới khi máy rảnh')
      : ws.baseWaiting === 'wake' ? tr('Chụp bản gốc mới sau ít phút')
        : null;
  return (
    <div className="flex items-start gap-2.5">
      <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {showName && <p className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">{ws.name}</p>}
        <p className="text-sm text-foreground">
          {ws.lastSyncAt ? tr('Đồng bộ gần nhất {{v1}} · {{v2}} thay đổi', { v1: fmtSyncTime(ws.lastSyncAt), v2: fmtNum(ws.lastChanges) }) : tr('Chưa đồng bộ lần nào')}
        </p>
        <p className="text-xs text-muted-foreground">
          {ws.baseAt
            ? tr('Bản trên {{label}}: gốc {{v1}} + {{v2}} đoạn · {{v3}} · đã mã hoá', { label, v1: fmtWhen(ws.baseAt), v2: fmtNum(ws.segments), v3: fmtBytes(ws.bytes) })
            : tr('Chưa có bản trên {{label}}', { label })}
        </p>
        <p className="text-xs text-muted-foreground">{trx('Phạm vi: {{scopeText}}', { scopeText })}</p>
        {ws.progress && <SnapshotProgress progress={ws.progress} />}
        {stateText && !ws.progress && (
          <p className={cn('flex items-center gap-1.5 text-xs', ws.state === 'error' ? 'text-destructive' : ws.state === 'paused' ? 'text-warning' : 'text-muted-foreground')}>
            {working && <CloudSpinner className="h-3.5 w-3.5" />}{stateText}
          </p>
        )}
        {!stateText && !ws.progress && waitText && (
          <p className="text-xs text-muted-foreground" title={tr('Bản gốc chép và nén cả dữ liệu nên chờ lúc máy rảnh.')}>{waitText}</p>
        )}
      </div>
    </div>
  );
}

/** Images & files: how much is uploaded, progress, reason for waiting (backed off due to network / storage limit = warning), Pause / Resume. */
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
        {tr('Tiếp tục')}
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
        {tr('Tạm dừng')}
      </Button>
    )
  ) : undefined;

  return (
    <section aria-label={tr('Ảnh và file')} className="space-y-2 py-3">
      <StatusHeading icon={<ImageIcon />} title={tr('Ảnh & file')} actions={actions} />
      {!includeMedia ? (
        <p className="text-xs text-muted-foreground">
          {tr('Không kèm ảnh, video, file')}{t.uploaded > 0 ? tr(' · {{v1}} file đã lên {{label}} vẫn giữ', { v1: fmtNum(t.uploaded), label }) : ''}.
        </p>
      ) : (
        <>
          {showTotals && (
            <>
              <p className="text-sm text-foreground">
                {trx('Đã lên {{v1}} / {{v2}} file · {{v3}}', { v1: fmtNum(t.uploaded), v2: fmtNum(t.files), v3: fmtBytesPair(t.bytesUploaded, t.bytesTotal) })}
              </p>
              <ProgressBar value={pct} tone={media.lastError ? 'warning' : 'primary'} label={tr('Tiến độ tải ảnh, file lên {{label}}', { label })} />
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
 * Space used on the storage (data + images/files). R2: with the estimated monthly cost + a link to the R2 page on Cloudflare;
 * Google Drive: space used + a link to Google Drive (account quota and limits are in the "Mức sử dụng & chi phí" (Usage & cost) card).
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
        <span>{tr('Dung lượng trên Google Drive: {{v1}}', { v1: fmtBytes(total) })}</span>
        <Button
          variant="link"
          size="sm"
          className="text-xs"
          rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
          onClick={() => openExternalUrl(GOOGLE_DRIVE_URL)}
        >
          {tr('Mở Google Drive')}
        </Button>
      </div>
    );
  }
  const cost = r2MonthlyUsd(total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
      <span>{trx('Dung lượng R2: {{v1}} · {{v2}}', { v1: fmtBytes(total), v2: cost > 0 ? tr('ước tính {{v1}} USD/tháng', { v1: fmtUsd(cost) }) : tr('trong phần miễn phí 10 GB') })}</span>
      <Button
        variant="link"
        size="sm"
        className="text-xs"
        rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
        onClick={() => openExternalUrl(r2DashboardUrl(accountId))}
      >
        {tr('Mở R2 trên Cloudflare')}
      </Button>
    </div>
  );
}
