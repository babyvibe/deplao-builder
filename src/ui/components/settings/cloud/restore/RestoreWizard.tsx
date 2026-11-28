/**
 * Cloudflare restore wizard - 6 steps:
 *   1 Connect Cloudflare · 2 Choose workspace · 3 Enter password · 4 Restore data · 5 Log in to channels again ·
 *   6 Turn automations back on.
 *  - mode 'new'     : new machine / Windows reinstall, goes through all 6 steps. Opened from the first screen or from the Add account box via
 *                     openRestoreWizard() (attaches itself to document.body, no need to place a component anywhere).
 *  - mode 'same'    : restore on this machine (Data sync → Restore…), starts at step 2.
 *  - mode 'promote' : standby machine being monitored → use the copy already on the machine (skips steps 2–3).
 * Restored data never connects channels by itself; automations stay paused until the user confirms the old machine is off
 * (db.resumeAutomations). Step 4 progress comes from CLOUD_RESTORE_PROGRESS_EVENT.
 * Storage: the box reads storage.status() itself (when opened by openRestoreWizard it is not inside CloudSettings). Step 1 lets you choose
 * whether the copy is on Cloudflare R2 or Google Drive; for Google Drive, step 1 is a Google sign-in instead of the Cloudflare token.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { CheckIcon, DownloadIcon, RefreshIcon, TrashIcon } from '@/components/common/icons';
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
  FormField,
  Input,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { publishPublicAddresses } from '../../../common/cloud/PublicAddressCard';
import {
  CLOUD_RESTORE_PROGRESS_EVENT,
  isAllScope,
  normalizeScope,
  storageLabel,
  type CloudConnectionStatus,
  type CloudStorageProvider,
  type CloudStorageStatus,
  type RemoteDbCopy,
  type RestoreProgress,
  type RestoreRequest,
} from '../../../../../shared/cloud/cloudContracts';
import {
  APP_VERSION,
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  fmtBytes,
  fmtDate,
  fmtNum,
  fmtWhen,
  isNewerThanApp,
  isStorageReady,
  Notice,
  PillGroup,
  ProgressBar,
  R2RequiredNotice,
  StorageContext,
  toLocalInput,
  useCloudAction,
  useCloudChanged,
  useStorage,
  useStoreLabel,
} from '../cloudUi';
import { ConnectForm } from '../CloudConnect';
import { EMPTY_GOOGLE_STATUS, GoogleAccountBlock } from '../sync/StoragePicker';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export type RestoreWizardMode = 'new' | 'same' | 'promote';

export interface RestoreWizardOptions {
  /** 'new' (default) = new machine · 'same' = restore on this machine · 'promote' = standby machine becomes the main machine. */
  mode?: RestoreWizardMode;
  /** Workspace preselected (same) / workspace being monitored (promote). */
  workspaceId?: string;
  /** promote: name of the main machine being monitored. */
  sourceMachine?: string;
  /** This machine has a saved backup password (can be left empty at step 3). */
  passphraseSet?: boolean;
}

export interface RestoreWizardProps extends RestoreWizardOptions {
  open: boolean;
  onClose: () => void;
}

type StepNo = 1 | 2 | 3 | 4 | 5 | 6;

export const RESTORE_STEPS = [
  tr('Kết nối Cloudflare'),
  tr('Chọn workspace'),
  tr('Nhập mật khẩu'),
  tr('Khôi phục dữ liệu'),
  tr('Đăng nhập lại kênh'),
  tr('Bật lại tự động hoá'),
] as const;

/** Step 1 when the copy is on Google Drive. */
const GOOGLE_FIRST_STEP = tr('Đăng nhập Google Drive');

/** Step names per storage: on Google Drive, step 1 is the Google sign-in. */
export function restoreSteps(provider: CloudStorageProvider = 'r2'): readonly string[] {
  return provider === 'gdrive' ? [GOOGLE_FIRST_STEP, ...RESTORE_STEPS.slice(1)] : RESTORE_STEPS;
}

/** Step 4 title by progress; `label` = storage name. */
function progressLabel(step: RestoreProgress['step'], label: string): string {
  switch (step) {
    case 'download': return tr('Đang tải bản sao từ {{label}}', { label });
    case 'decrypt': return tr('Đang giải mã');
    case 'apply': return tr('Đang ghép các đoạn thay đổi');
    case 'verify': return tr('Đang kiểm tra dữ liệu');
    case 'swap': return tr('Đang thay dữ liệu trên máy');
    case 'done': return tr('Đã khôi phục xong');
    default: return tr('Khôi phục bị lỗi');
  }
}

const CHANNEL_INFO: Record<string, { label: string; how: string }> = {
  zalo: { label: 'Zalo', how: tr('Cần đăng nhập lại bằng mã QR') },
  facebook: { label: 'Facebook Messenger', how: tr('Cần đăng nhập lại tài khoản Facebook') },
  telegram_user: { label: 'Telegram', how: tr('Cần đăng nhập lại bằng số điện thoại') },
  telegram_bot: { label: 'Telegram bot', how: tr('Cần dán lại token bot') },
};

function channelInfo(channel: string) {
  return CHANNEL_INFO[channel] ?? { label: channel || 'Zalo', how: tr('Cần đăng nhập lại') };
}

interface WizardAccount {
  id: string;
  name: string;
  channel: string;
  connected: boolean;
  proxyId: number | null;
}

// ─── Reused pieces ──────────────────────────────────────────────────────────────────────

/** Column of steps on the left of the restore box. `provider` missing = follows the storage in StorageContext (unknown = R2). */
export function RestoreStepper({ step, skipped = [], provider }: { step: number; skipped?: number[]; provider?: CloudStorageProvider }) {
  const contextProvider = useStorage()?.provider;
  return (
    <ol className="space-y-1" aria-label={tr('Các bước khôi phục')}>
      {restoreSteps(provider ?? contextProvider ?? 'r2').map((label, index) => {
        const n = index + 1;
        const current = n === step;
        const done = !current && (n < step || skipped.includes(n));
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="flex items-center gap-2.5 py-1.5">
            <span
              className={cn(
                'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                done ? 'border-success/60 bg-success/15 text-success'
                  : current ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-subtle-foreground',
              )}
            >
              {done ? <CheckIcon className="h-3.5 w-3.5" /> : n}
            </span>
            <span className={cn('text-sm', current ? 'font-semibold text-foreground' : done ? 'text-muted-foreground' : 'text-subtle-foreground')}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The copy holds only part of the data (chosen accounts or from a date). An old copy with no recorded scope = complete. */
export function isPartialCopy(copy: Pick<RemoteDbCopy, 'scope'>): boolean {
  return !!copy.scope && !isAllScope(normalizeScope(copy.scope));
}

/** Scope of the copy: "Tất cả tài khoản" (All accounts), "Shop Hoa Lan (Zalo), Kho tổng (Facebook) · từ 01/01/2026" (from 01/01/2026), "3 tài khoản" (3 accounts). */
export function describeCopyScope(copy: Pick<RemoteDbCopy, 'scope' | 'accountNames'>): string {
  const scope = normalizeScope(copy.scope);
  let who = tr('Tất cả tài khoản');
  if (scope.accounts !== 'all') {
    const ids = scope.accounts;
    const byId = new Map((copy.accountNames ?? []).map(a => [a.id, a] as const));
    const named = ids.map(id => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    if (!named.length) {
      who = ids.length ? tr('{{v1}} tài khoản', { v1: fmtNum(ids.length) }) : tr('Chưa có tài khoản');
    } else {
      const shown = named.slice(0, 3).map(a => `${a.name || a.id}${a.channel ? ` (${channelInfo(a.channel).label})` : ''}`);
      const rest = ids.length - shown.length;
      who = rest > 0 ? tr('{{v1}} và {{v2}} tài khoản khác', { v1: shown.join(', '), v2: fmtNum(rest) }) : shown.join(', ');
    }
  }
  return scope.fromTs ? tr('{{who}} · từ {{v1}}', { who, v1: fmtDate(scope.fromTs) }) : who;
}

/** Warning when the copy holds only part of the data (confirm-restore step, choosing the copy to monitor). */
export function CopyScopeNotice({ copy }: { copy: RemoteDbCopy }) {
  if (!isPartialCopy(copy)) return null;
  return (
    <Notice tone="warning" title={tr('Gồm: {{v1}}', { v1: describeCopyScope(copy) })}>
      <p>{tr('Bản sao chỉ có các tài khoản / khoảng thời gian trên.')}</p>
    </Notice>
  );
}

/** Details of one copy on R2: name, machine, last sync, size, scope ("Gồm: …" (Includes: …)), Deplao version. */
export function RemoteCopyDetails({ copy, appVersion = APP_VERSION }: { copy: RemoteDbCopy; appVersion?: string }) {
  const newer = isNewerThanApp(copy.appVersion, appVersion);
  return (
    <span className="block min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-foreground">{copy.name}</span>
      <span className="block text-xs text-muted-foreground">
        {trx('Máy {{machine}} · đồng bộ {{v1}} · {{v2}}', { machine: copy.machine, v1: fmtWhen(copy.lastSyncAt), v2: fmtBytes(copy.bytes) })}
      </span>
      <span className="block text-xs text-muted-foreground">{trx('Gồm: {{v1}}', { v1: describeCopyScope(copy) })}</span>
      <span className={cn('block text-[11px]', newer ? 'text-warning' : 'text-subtle-foreground')}>
        {newer
          ? tr('Tạo bởi Deplao {{appVersion}}, mới hơn bản đang dùng ({{appVersion1}}). Cập nhật app trước khi khôi phục.', { appVersion: copy.appVersion, appVersion1: appVersion })
          : `Deplao ${copy.appVersion}`}
      </span>
    </span>
  );
}

/**
 * List of workspace copies on R2 (pick one). A copy made by a newer Deplao is locked.
 * `onDelete` + `canDelete`: the "Xoá bản này trên R2" (Delete this copy on R2) button next to the copies that may be deleted (outside the select button).
 */
export function RemoteCopyList({ copies, selectedId, onSelect, appVersion = APP_VERSION, canDelete, onDelete, deletingId = null }: {
  copies: RemoteDbCopy[];
  selectedId: string;
  onSelect: (workspaceId: string) => void;
  appVersion?: string;
  canDelete?: (copy: RemoteDbCopy) => boolean;
  onDelete?: (copy: RemoteDbCopy) => void;
  /** Copy being deleted (the button shows a spinner). */
  deletingId?: string | null;
}) {
  const label = useStoreLabel();
  const deleteLabel = tr('Xoá bản này trên {{label}}', { label });
  return (
    <div role="radiogroup" aria-label={tr('Bản sao trên {{label}}', { label })} className="space-y-2">
      {copies.map(copy => {
        const newer = isNewerThanApp(copy.appVersion, appVersion);
        const active = copy.workspaceId === selectedId;
        const deletable = !!onDelete && !!canDelete?.(copy);
        return (
          <div
            key={copy.workspaceId}
            className={cn(
              'flex items-start rounded-xl border transition-colors',
              active ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40 hover:bg-muted',
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={active}
              disabled={newer}
              onClick={() => onSelect(copy.workspaceId)}
              className={cn(
                'flex min-w-0 flex-1 items-start gap-3 rounded-xl p-3 text-left',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              <span className={cn('mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border', active ? 'border-primary' : 'border-input')}>
                {active && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <RemoteCopyDetails copy={copy} appVersion={appVersion} />
            </button>
            {deletable && (
              <Button
                size="icon"
                variant="ghost"
                className="m-2 h-8 w-8 flex-shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={deleteLabel}
                title={deleteLabel}
                loading={deletingId === copy.workspaceId}
                onClick={() => onDelete?.(copy)}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children != null && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><CloudSpinner className="h-3.5 w-3.5" />{text}</p>;
}

/** Restored workspace is not the open workspace yet → switch to it (App reloads accounts through workspace:switched). */
async function switchToWorkspace(id: string): Promise<void> {
  try {
    const active = await ipc.workspace?.getActive();
    const activeId = active?.workspace?.id;
    if (activeId && activeId !== id) await ipc.workspace?.switch(id);
  } catch { /* main switches by itself when the DB is replaced */ }
}

// ─── Restore wizard ────────────────────────────────────────────────────────────────────

export function RestoreWizard({
  open,
  onClose,
  mode = 'new',
  workspaceId: presetWorkspace,
  sourceMachine,
  passphraseSet = false,
}: RestoreWizardProps) {
  const addAccountOpen = useAppStore(s => s.addAccountModalOpen);
  const openAddAccount = useAppStore(s => s.setAddAccountModalOpen);
  const { busy, run } = useCloudAction();
  const passId = useId();
  const contextStorage = useStorage();

  const [step, setStep] = useState<StepNo>(mode === 'new' ? 1 : mode === 'same' ? 2 : 4);
  const skipped = mode === 'promote' ? [1, 2, 3] : [];
  const [connection, setConnection] = useState<CloudConnectionStatus | null>(null);
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  // Storage: the box reads it itself (when opened from the first screen it is not inside CloudSettings); until it has been read, use the storage of the Settings page.
  const [ownStorage, setOwnStorage] = useState<CloudStorageStatus | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [tunnelAuto, setTunnelAuto] = useState(false);
  const [copies, setCopies] = useState<RemoteDbCopy[] | null>(null);
  const [copiesError, setCopiesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(presetWorkspace ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [passError, setPassError] = useState<string | null>(null);
  const [untilTs, setUntilTs] = useState<number | null>(null);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [accounts, setAccounts] = useState<WizardAccount[] | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [oldMachineOff, setOldMachineOff] = useState(false);
  const [moveAddress, setMoveAddress] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const copiesLoading = useRef(false);
  const sawLoginModal = useRef(false);

  const selected = copies?.find(c => c.workspaceId === selectedId) ?? null;
  const storage = ownStorage ?? contextStorage;
  const provider: CloudStorageProvider = storage?.provider ?? 'r2';
  const label = storageLabel(provider);
  const gdrive = provider === 'gdrive';
  const storeReady = isStorageReady(storage, connection);
  const labelRef = useRef(label);
  labelRef.current = label;

  const loadStorage = useCallback(async () => {
    const api = cloudApi();
    if (typeof api?.storage?.status !== 'function') {
      setStorageLoaded(true);
      return;
    }
    try {
      const res = await api.storage.status();
      if (res?.success && res.storage) setOwnStorage(res.storage);
    } catch { /* old build / error: treat as the R2 storage */ }
    finally {
      setStorageLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (open) void loadStorage();
  }, [open, loadStorage]);
  // Signing in / out of Google, or changing storage elsewhere → main reports 'connection'.
  useCloudChanged(areas => {
    if (open && areas.includes('connection')) void loadStorage();
  });

  // Changing storage in step 1 → the list of copies of the old storage is no longer valid.
  const shownProvider = useRef(provider);
  useEffect(() => {
    if (shownProvider.current === provider) return;
    shownProvider.current = provider;
    setCopies(null);
    setCopiesError(null);
  }, [provider]);

  // Connection + tunnel config (step 6 asks to switch the Internet address when Cloudflare automatic is in use).
  useEffect(() => {
    if (!open) return;
    const api = cloudApi();
    if (!api) { setConnectionLoaded(true); return; }
    let alive = true;
    api.status()
      .then(res => { if (alive && res?.success && res.connection) setConnection(res.connection); })
      .catch(() => undefined)
      .finally(() => { if (alive) setConnectionLoaded(true); });
    api.tunnel.getConfig()
      .then(res => { if (alive && res?.success && res.config) setTunnelAuto(res.config.mode === 'cloudflare_auto' && !!res.config.auto); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  const loadCopies = useCallback(async () => {
    const api = cloudApi();
    if (!api || copiesLoading.current) return;
    copiesLoading.current = true;
    setCopies(null);
    setCopiesError(null);
    try {
      const res = await api.db.listRemote();
      if (res?.success) {
        const list = res.copies ?? [];
        setCopies(list);
        setSelectedId(prev => (prev && list.some(c => c.workspaceId === prev)
          ? prev
          : list.find(c => !isNewerThanApp(c.appVersion))?.workspaceId ?? ''));
      } else {
        setCopies([]);
        setCopiesError(res?.error || tr('Không đọc được danh sách bản sao trên {{current}}.', { current: labelRef.current }));
      }
    } catch (err) {
      setCopies([]);
      setCopiesError(cleanIpcError(err));
    } finally {
      copiesLoading.current = false;
    }
  }, []);
  useEffect(() => {
    if (open && step === 2 && copies === null) void loadCopies();
  }, [open, step, copies, loadCopies]);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await ipc.login?.getAccounts();
      const list: any[] = Array.isArray(res?.accounts) ? res.accounts : [];
      setAccounts(list.map(a => ({
        id: String(a.zalo_id),
        name: String(a.full_name || a.display_name || a.username || a.zalo_id),
        channel: String(a.channel || 'zalo'),
        connected: !!(a.isConnected || a.isOnline),
        proxyId: a.proxy_id ?? null,
      })));
    } catch {
      setAccounts([]);
    }
  }, []);
  useEffect(() => {
    if (open && step === 5) void loadAccounts();
  }, [open, step, loadAccounts]);

  // Step 5: hide the restore box while the Add account box is open; once it closes, reload the account list.
  useEffect(() => {
    if (!loginPending) return;
    if (addAccountOpen) { sawLoginModal.current = true; return; }
    if (sawLoginModal.current) {
      sawLoginModal.current = false;
      setLoginPending(false);
      void loadAccounts();
      return;
    }
    const timer = setTimeout(() => { if (!sawLoginModal.current) setLoginPending(false); }, 1500);
    return () => clearTimeout(timer);
  }, [loginPending, addAccountOpen, loadAccounts]);

  const requestClose = () => {
    if (restoring) return;
    onClose();
  };

  const recheck = async () => {
    const res = await run('recheck', () => cloudApi()?.recheck());
    if (res?.connection) setConnection(res.connection);
    if (res) void loadStorage();
  };

  /** Step 1 (new machine): which storage the copy is on. Main refuses when sync is on on this machine (run() reports an error). */
  const pickStore = async (next: CloudStorageProvider) => {
    if (next === provider) return;
    const res = await run('provider', () => cloudApi()?.storage?.setProvider(next));
    if (res?.storage) setOwnStorage(res.storage);
    else if (res) void loadStorage();
  };

  const startRestore = async () => {
    const api = cloudApi();
    const workspaceId = selectedId || presetWorkspace;
    if (!api || !workspaceId) return;
    setStep(4);
    setRestoring(true);
    setRestoreError(null);
    setRestored(false);
    setProgress({ step: 'download', percent: 0 });
    const off = ipc.on?.(CLOUD_RESTORE_PROGRESS_EVENT, (p: RestoreProgress) => {
      if (p && typeof p.percent === 'number') setProgress(p);
    });
    try {
      const req: RestoreRequest = { workspaceId };
      if (passphrase) req.passphrase = passphrase;
      if (untilTs) req.untilTs = untilTs;
      const res = await api.db.restore(req);
      if (!res?.success) {
        setRestoreError(res?.error || tr('Khôi phục không thành công.'));
        setProgress(prev => ({ step: 'error', percent: prev?.percent ?? 0 }));
        return;
      }
      setPassphrase('');
      setProgress({ step: 'done', percent: 100 });
      setRestored(true);
      await switchToWorkspace(res.restoredWorkspaceId || workspaceId);
    } catch (err) {
      setRestoreError(cleanIpcError(err));
      setProgress(prev => ({ step: 'error', percent: prev?.percent ?? 0 }));
    } finally {
      off?.();
      setRestoring(false);
    }
  };

  const goNext = () => {
    if (step === 1) { setStep(2); return; }
    if (step === 2) { if (selected && !isNewerThanApp(selected.appVersion)) setStep(3); return; }
    if (step === 3) {
      if (!passphrase && !passphraseSet) { setPassError(tr('Nhập mật khẩu sao lưu.')); return; }
      if (untilTs && selected && (untilTs < selected.baseAt || untilTs > selected.lastSyncAt)) {
        setPassError(null);
        return;
      }
      void startRestore();
      return;
    }
    if (step === 4 && restored) { setStep(5); return; }
    if (step === 5) setStep(6);
  };

  const goBack = () => {
    if (step === 2 && mode === 'new') setStep(1);
    else if (step === 3) setStep(2);
    else if (step === 4 && restoreError && mode !== 'promote') setStep(3);
  };

  const login = (account: WizardAccount) => {
    setLoginPending(true);
    sawLoginModal.current = false;
    if (account.channel === 'zalo') openAddAccount(true);
    else openAddAccount(true, account.channel, account.channel === 'facebook' ? account.proxyId : null);
  };

  const rehydrate = async () => {
    await run('rehydrate', () => cloudApi()?.media.rehydrateAll(), tr('Đang tải media từ {{label}} về máy', { label }));
  };

  const finish = async () => {
    const api = cloudApi();
    if (!api) return;
    setFinishing(true);
    try {
      if (moveAddress) {
        const moved = await run('move', () => api.tunnel.moveHere(), tr('Đã chuyển địa chỉ Internet sang máy này'));
        if (moved?.addresses) publishPublicAddresses(moved.addresses);
      }
      if (typeof api.db.resumeAutomations === 'function') {
        const res = await run('resume', () => api.db.resumeAutomations(), tr('Đã bật lại chiến dịch, workflow và lịch của ứng dụng'));
        if (!res) return;
      }
      onClose();
    } finally {
      setFinishing(false);
    }
  };

  const untilOutOfRange = !!(untilTs && selected && (untilTs < selected.baseAt || untilTs > selected.lastSyncAt));
  const canResume = typeof cloudApi()?.db?.resumeAutomations === 'function';
  const subtitle = mode === 'promote'
    ? tr('Dùng bản theo dõi của {{v1}} trên máy này.', { v1: sourceMachine || tr('máy chủ') })
    : mode === 'same'
      ? tr('Khôi phục dữ liệu của máy này từ bản sao trên {{label}}.', { label })
      : tr('Cài máy mới hoặc cài lại Windows: lấy lại dữ liệu từ bản sao trên {{label}}.', { label });

  let body: React.ReactNode = null;
  if (step === 1) {
    // New machine: choose which storage the copy is on (app build with storage choice), then connect that storage.
    const canPickStore = !!storage && typeof cloudApi()?.storage?.setProvider === 'function';
    const storeChoice = canPickStore ? (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{tr('Bản sao lưu nằm ở')}</p>
        <PillGroup
          label={tr('Kho lưu của bản sao')}
          value={provider}
          disabled={busy === 'provider'}
          onChange={next => void pickStore(next)}
          options={[
            { value: 'r2', label: 'Cloudflare R2' },
            { value: 'gdrive', label: 'Google Drive' },
          ]}
        />
      </div>
    ) : null;
    let connectBody: React.ReactNode;
    if (!connectionLoaded || !storageLoaded) {
      connectBody = <Loading text={tr('Đang kiểm tra kết nối…')} />;
    } else if (gdrive && storage) {
      connectBody = (
        <div className="space-y-3">
          <StepTitle title={GOOGLE_FIRST_STEP}>{tr('Đăng nhập đúng tài khoản Google đã dùng để sao lưu trên máy cũ.')}</StepTitle>
          {storage.ready && (
            <Notice tone="success" title={tr('Đã đăng nhập Google Drive')}>
              <p>{tr('Tiếp tục để chọn bản sao lưu trên Google Drive.')}</p>
            </Notice>
          )}
          <GoogleAccountBlock google={storage.google ?? EMPTY_GOOGLE_STATUS} onStorage={setOwnStorage} />
        </div>
      );
    } else if (connection?.connected) {
      connectBody = (
        <div className="space-y-3">
          <Notice tone="success" title={tr('Đã kết nối Cloudflare{{v1}}', { v1: connection.accountName ? ` · ${connection.accountName}` : '' })}>
            <p>{tr('Tiếp tục để chọn bản sao lưu trên R2.')}</p>
          </Notice>
          <R2RequiredNotice connection={connection} onRecheck={() => void recheck()} rechecking={busy === 'recheck'} />
        </div>
      );
    } else {
      connectBody = (
        <div className="space-y-3">
          <StepTitle title={tr('Kết nối Cloudflare')}>{tr('Dán token Cloudflare cho máy này: token của máy cũ được khoá theo máy cũ.')}</StepTitle>
          <ConnectForm onConnected={setConnection} initialAccountId={connection?.accountId ?? ''} />
        </div>
      );
    }
    body = storeChoice ? <div className="space-y-4">{storeChoice}{connectBody}</div> : connectBody;
  } else if (step === 2) {
    body = (
      <div className="space-y-3">
        <StepTitle title={tr('Chọn workspace')}>{tr('Mỗi workspace có một bản trên {{label}}. Chọn bản cần khôi phục về máy này.', { label })}</StepTitle>
        {copies === null ? (
          <Loading text={tr('Đang đọc bản sao trên {{label}}…', { label })} />
        ) : copies.length === 0 ? (
          <Notice
            tone={copiesError ? 'destructive' : 'info'}
            action={<Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} onClick={() => void loadCopies()}>{tr('Tải lại')}</Button>}
          >
            <p>{copiesError || tr('Chưa có bản sao lưu nào trên {{label}} của tài khoản này.', { label })}</p>
          </Notice>
        ) : (
          <RemoteCopyList copies={copies} selectedId={selectedId} onSelect={setSelectedId} />
        )}
      </div>
    );
  } else if (step === 3) {
    body = (
      <div className="space-y-4">
        <StepTitle title={tr('Nhập mật khẩu sao lưu')}>
          {tr('Mật khẩu đặt khi bật Đồng bộ dữ liệu trên máy chủ. Deplao giải mã trên máy này, không gửi mật khẩu đi đâu.')}
        </StepTitle>
        <FormField
          label={tr('Mật khẩu sao lưu')}
          htmlFor={passId}
          error={passError}
          hint={passphraseSet ? tr('Máy này đã lưu mật khẩu: để trống để dùng mật khẩu đã lưu.') : undefined}
        >
          <Input
            id={passId}
            type="password"
            autoComplete="off"
            value={passphrase}
            autoFocus
            onChange={e => { setPassphrase(e.target.value); setPassError(null); }}
            onKeyDown={e => { if (e.key === 'Enter') goNext(); }}
          />
        </FormField>
        {selected && selected.baseAt > 0 && (
          <details className="rounded-lg bg-muted px-3 py-2">
            <summary className="cursor-pointer select-none text-xs font-medium text-foreground">{tr('Khôi phục tới một thời điểm cũ hơn')}</summary>
            <div className="mt-2 space-y-2 text-xs text-muted-foreground">
              <p>
                {trx('Chọn thời điểm trong khoảng từ bản gốc ({{v1}}) tới lần đồng bộ cuối ({{v2}}). Để trống là bản mới nhất.', { v1: fmtWhen(selected.baseAt), v2: fmtWhen(selected.lastSyncAt) })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  className="w-60"
                  aria-label={tr('Khôi phục tới thời điểm')}
                  min={toLocalInput(selected.baseAt)}
                  max={toLocalInput(selected.lastSyncAt)}
                  value={untilTs ? toLocalInput(untilTs) : ''}
                  invalid={untilOutOfRange}
                  onChange={e => setUntilTs(e.target.value ? new Date(e.target.value).getTime() : null)}
                />
                {untilTs && <Button size="sm" variant="ghost" onClick={() => setUntilTs(null)}>{tr('Dùng bản mới nhất')}</Button>}
              </div>
              {untilOutOfRange && <p className="text-destructive">{tr('Thời điểm phải nằm trong khoảng trên.')}</p>}
            </div>
          </details>
        )}
        {selected && <CopyScopeNotice copy={selected} />}
        <Notice tone="warning">
          <p>
            {tr('Dữ liệu của workspace này trên máy sẽ được thay bằng bản trên {{label}}. Kênh chat không tự kết nối; chiến dịch, workflow và lịch của ứng dụng tạm dừng tới bước 6.', { label })}
          </p>
        </Notice>
      </div>
    );
  } else if (step === 4) {
    const notStarted = mode === 'promote' && !restoring && !restored && !restoreError && !progress;
    body = notStarted ? (
      <div className="space-y-3">
        <StepTitle title={tr('Chuyển sang máy này')}>
          {trx('Dữ liệu của {{v1}} đã có trên máy này. Bấm Chuyển sang máy này để dùng ngay; kênh chat đăng nhập lại ở bước sau.', { v1: sourceMachine || tr('máy chủ') })}
        </StepTitle>
        <Notice tone="warning"><p>{tr('Chỉ làm khi máy chủ cũ đã hỏng hoặc đã tắt, tránh hai máy cùng gửi tin.')}</p></Notice>
      </div>
    ) : (
      <div className="space-y-3">
        <StepTitle title={progressLabel(restored ? 'done' : restoreError ? 'error' : progress?.step ?? 'download', label)} />
        <ProgressBar
          value={progress?.percent ?? 0}
          tone={restoreError ? 'destructive' : restored ? 'success' : 'primary'}
          label={tr('Tiến độ khôi phục')}
        />
        <p className="text-xs text-muted-foreground">{progress?.message || `${Math.round(progress?.percent ?? 0)}%`}</p>
        {restoring && <Notice tone="warning"><p>{tr('Không đóng app trong lúc khôi phục.')}</p></Notice>}
        {restoreError && <Notice tone="destructive"><p>{restoreError}</p></Notice>}
        {restored && <Notice tone="success"><p>{tr('Dữ liệu đã về máy. Bước tiếp theo: đăng nhập lại các kênh chat.')}</p></Notice>}
      </div>
    );
  } else if (step === 5) {
    body = (
      <div className="space-y-3">
        <StepTitle title={tr('Đăng nhập lại từng kênh')}>
          {tr('Lịch sử đã khôi phục; đăng nhập xong, tin mới vào đúng hội thoại. Tài khoản chưa đăng nhập vẫn xem được lịch sử.')}
        </StepTitle>
        {accounts === null ? (
          <Loading text={tr('Đang đọc danh sách tài khoản…')} />
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr('Bản khôi phục không có tài khoản kênh nào.')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {accounts.map(acc => {
              const info = channelInfo(acc.channel);
              return (
                <li key={acc.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{acc.name} · {info.label}</p>
                    {acc.connected ? (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />{tr('Đã đăng nhập')}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{info.how}</p>
                    )}
                  </div>
                  {!acc.connected && <Button size="sm" onClick={() => login(acc)}>{tr('Đăng nhập')}</Button>}
                </li>
              );
            })}
          </ul>
        )}
        <Notice tone="warning" title={tr('Chiến dịch, workflow và lịch của ứng dụng đang tạm dừng')}>
          <p>{tr('Bật lại ở bước 6, khi đã chắc máy cũ không còn chạy.')}</p>
        </Notice>
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {tr('Media tự tải từ {{label}} khi mở. Muốn có sẵn trên máy:', { label })}
          <Button variant="link" size="sm" className="text-xs" leftIcon={<DownloadIcon className="h-3.5 w-3.5" />} loading={busy === 'rehydrate'} onClick={() => void rehydrate()}>
            {tr('Tải hết media về máy')}
          </Button>
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        <StepTitle title={tr('Bật lại tự động hoá')}>
          {tr('Chiến dịch, workflow và lịch của ứng dụng đang tạm dừng để không gửi trùng với máy cũ. Chỉ bật khi máy cũ đã tắt hoặc đã ngắt Deplao.')}
        </StepTitle>
        <Checkbox checked={oldMachineOff} onCheckedChange={setOldMachineOff} label={tr('Máy cũ đã tắt hoặc đã ngắt Deplao')} />
        {tunnelAuto && (
          <Checkbox
            checked={moveAddress}
            onCheckedChange={setMoveAddress}
            label={tr('Chuyển địa chỉ Internet sang máy này')}
            description={tr('Trỏ tên miền về máy này để nhân viên ở xa, Casso, SePay, website tiếp tục dùng địa chỉ cũ.')}
          />
        )}
        {!canResume && (
          <Notice tone="info"><p>{tr('Bản app này chưa tự bật lại được: mở Chiến dịch và Workflow để bật lại từng mục.')}</p></Notice>
        )}
      </div>
    );
  }

  let footer: React.ReactNode = null;
  if (step === 1) {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>{tr('Huỷ')}</Button>
        <Button disabled={!storageLoaded || !storeReady} onClick={goNext}>{tr('Tiếp tục')}</Button>
      </>
    );
  } else if (step === 2) {
    footer = (
      <>
        {mode === 'new'
          ? <Button variant="ghost" onClick={goBack}>{tr('Quay lại')}</Button>
          : <Button variant="ghost" onClick={requestClose}>{tr('Huỷ')}</Button>}
        <Button disabled={!selected || isNewerThanApp(selected.appVersion)} onClick={goNext}>{tr('Tiếp tục')}</Button>
      </>
    );
  } else if (step === 3) {
    footer = (
      <>
        <Button variant="ghost" onClick={goBack}>{tr('Quay lại')}</Button>
        <Button disabled={untilOutOfRange} onClick={goNext}>{tr('Khôi phục')}</Button>
      </>
    );
  } else if (step === 4) {
    if (restoring) {
      footer = <Button disabled leftIcon={<CloudSpinner className="h-4 w-4 text-current" />}>{tr('Đang khôi phục…')}</Button>;
    } else if (restored) {
      footer = <Button onClick={goNext}>{tr('Tiếp tục')}</Button>;
    } else if (restoreError) {
      footer = (
        <>
          {mode === 'promote'
            ? <Button variant="ghost" onClick={requestClose}>{tr('Đóng')}</Button>
            : <Button variant="ghost" onClick={goBack}>{tr('Quay lại')}</Button>}
          <Button onClick={() => void startRestore()}>{tr('Thử lại')}</Button>
        </>
      );
    } else {
      footer = (
        <>
          <Button variant="ghost" onClick={requestClose}>{tr('Huỷ')}</Button>
          <Button onClick={() => void startRestore()}>{tr('Chuyển sang máy này')}</Button>
        </>
      );
    }
  } else if (step === 5) {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>{tr('Để sau')}</Button>
        <Button onClick={goNext}>{tr('Tiếp tục')}</Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>{tr('Để sau')}</Button>
        <Button disabled={!oldMachineOff} loading={finishing} onClick={() => void finish()}>{tr('Bật lại tự động hoá')}</Button>
      </>
    );
  }

  return (
    <StorageContext.Provider value={storage}>
      <Dialog
        open={open && !loginPending}
        onOpenChange={next => { if (!next) requestClose(); }}
        size="lg"
        closeOnOverlay={false}
        closeOnEscape={!restoring}
        className="overflow-hidden"
      >
        <DialogHeader className="border-b border-border">
          <div className="min-w-0">
            <DialogTitle>{gdrive ? tr('Khôi phục từ Google Drive') : tr('Khôi phục từ Cloudflare')}</DialogTitle>
            <DialogDescription>{subtitle}</DialogDescription>
          </div>
          {!restoring && <DialogClose />}
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="border-b border-border px-5 py-4 md:w-52 md:flex-shrink-0 md:border-b-0 md:border-r">
            <RestoreStepper step={step} skipped={skipped} provider={provider} />
          </aside>
          <DialogBody className="py-4">{body}</DialogBody>
        </div>
        <DialogFooter className="border-t border-border">{footer}</DialogFooter>
      </Dialog>
    </StorageContext.Provider>
  );
}

// ─── Opened from anywhere (first screen, Add account box…) ──────────────────────────────────────

let closeActiveWizard: (() => void) | null = null;

/**
 * Opens the restore wizard with its own React root attached to document.body (no need to place a component in the tree).
 * Opening it again while it is open reuses the open box. Returns a close function.
 */
export function openRestoreWizard(options: RestoreWizardOptions = {}): () => void {
  if (closeActiveWizard) return closeActiveWizard;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const close = () => {
    if (closeActiveWizard !== close) return;
    closeActiveWizard = null;
    window.setTimeout(() => {
      root.unmount();
      container.remove();
    }, 0);
  };
  closeActiveWizard = close;
  // The Add account box (if open) makes room for the restore wizard.
  const app = useAppStore.getState();
  if (app.addAccountModalOpen) app.setAddAccountModalOpen(false);
  root.render(<RestoreWizard {...options} open onClose={close} />);
  return close;
}

export default RestoreWizard;
