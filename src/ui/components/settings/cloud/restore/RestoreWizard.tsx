/**
 * Trình khôi phục từ Cloudflare — 6 bước:
 *   1 Kết nối Cloudflare · 2 Chọn workspace · 3 Nhập mật khẩu · 4 Khôi phục dữ liệu · 5 Đăng nhập lại kênh ·
 *   6 Bật lại tự động hoá.
 *  - mode 'new'     : máy mới / cài lại Windows, đi đủ 6 bước. Mở từ màn đầu hoặc hộp Thêm tài khoản bằng
 *                     openRestoreWizard() (tự gắn vào document.body, không cần đặt component ở đâu).
 *  - mode 'same'    : khôi phục trên máy này (Đồng bộ dữ liệu → Khôi phục…), bắt đầu ở bước 2.
 *  - mode 'promote' : máy dự phòng đang theo dõi → dùng bản đã có trên máy (bỏ qua bước 2–3).
 * Dữ liệu khôi phục không bao giờ tự kết nối kênh; tự động hoá tạm dừng tới khi người dùng xác nhận máy cũ đã tắt
 * (db.resumeAutomations). Tiến độ bước 4 lấy từ CLOUD_RESTORE_PROGRESS_EVENT.
 * Kho lưu: hộp tự đọc storage.status() (mở bằng openRestoreWizard thì không nằm trong CloudSettings). Bước 1 cho chọn
 * bản sao nằm ở Cloudflare R2 hay Google Drive; Google Drive thì bước 1 là đăng nhập Google thay cho token Cloudflare.
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

export type RestoreWizardMode = 'new' | 'same' | 'promote';

export interface RestoreWizardOptions {
  /** 'new' (mặc định) = máy mới · 'same' = khôi phục trên máy này · 'promote' = máy dự phòng chuyển thành máy chính. */
  mode?: RestoreWizardMode;
  /** Workspace chọn sẵn (same) / workspace đang theo dõi (promote). */
  workspaceId?: string;
  /** promote: tên máy chủ đang được theo dõi. */
  sourceMachine?: string;
  /** Máy này đã lưu mật khẩu sao lưu (cho phép để trống ở bước 3). */
  passphraseSet?: boolean;
}

export interface RestoreWizardProps extends RestoreWizardOptions {
  open: boolean;
  onClose: () => void;
}

type StepNo = 1 | 2 | 3 | 4 | 5 | 6;

export const RESTORE_STEPS = [
  'Kết nối Cloudflare',
  'Chọn workspace',
  'Nhập mật khẩu',
  'Khôi phục dữ liệu',
  'Đăng nhập lại kênh',
  'Bật lại tự động hoá',
] as const;

/** Bước 1 khi bản sao nằm trên Google Drive. */
const GOOGLE_FIRST_STEP = 'Đăng nhập Google Drive';

/** Tên các bước theo kho: Google Drive thì bước 1 là đăng nhập Google. */
export function restoreSteps(provider: CloudStorageProvider = 'r2'): readonly string[] {
  return provider === 'gdrive' ? [GOOGLE_FIRST_STEP, ...RESTORE_STEPS.slice(1)] : RESTORE_STEPS;
}

/** Tiêu đề bước 4 theo tiến độ; `label` = tên kho. */
function progressLabel(step: RestoreProgress['step'], label: string): string {
  switch (step) {
    case 'download': return `Đang tải bản sao từ ${label}`;
    case 'decrypt': return 'Đang giải mã';
    case 'apply': return 'Đang ghép các đoạn thay đổi';
    case 'verify': return 'Đang kiểm tra dữ liệu';
    case 'swap': return 'Đang thay dữ liệu trên máy';
    case 'done': return 'Đã khôi phục xong';
    default: return 'Khôi phục bị lỗi';
  }
}

const CHANNEL_INFO: Record<string, { label: string; how: string }> = {
  zalo: { label: 'Zalo', how: 'Cần đăng nhập lại bằng mã QR' },
  facebook: { label: 'Facebook', how: 'Cần đăng nhập lại tài khoản Facebook' },
  telegram_user: { label: 'Telegram', how: 'Cần đăng nhập lại bằng số điện thoại' },
  telegram_bot: { label: 'Telegram bot', how: 'Cần dán lại token bot' },
};

function channelInfo(channel: string) {
  return CHANNEL_INFO[channel] ?? { label: channel || 'Zalo', how: 'Cần đăng nhập lại' };
}

interface WizardAccount {
  id: string;
  name: string;
  channel: string;
  connected: boolean;
  proxyId: number | null;
}

// ─── Mảnh dùng lại ──────────────────────────────────────────────────────────────────────

/** Cột các bước bên trái hộp khôi phục. `provider` thiếu = theo kho trong StorageContext (chưa biết = R2). */
export function RestoreStepper({ step, skipped = [], provider }: { step: number; skipped?: number[]; provider?: CloudStorageProvider }) {
  const contextProvider = useStorage()?.provider;
  return (
    <ol className="space-y-1" aria-label="Các bước khôi phục">
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

/** Bản sao chỉ có một phần dữ liệu (chọn tài khoản hoặc từ ngày). Bản cũ không ghi phạm vi = đủ. */
export function isPartialCopy(copy: Pick<RemoteDbCopy, 'scope'>): boolean {
  return !!copy.scope && !isAllScope(normalizeScope(copy.scope));
}

/** Phạm vi của bản sao: "Tất cả tài khoản", "Shop Hoa Lan (Zalo), Kho tổng (Facebook) · từ 01/01/2026", "3 tài khoản". */
export function describeCopyScope(copy: Pick<RemoteDbCopy, 'scope' | 'accountNames'>): string {
  const scope = normalizeScope(copy.scope);
  let who = 'Tất cả tài khoản';
  if (scope.accounts !== 'all') {
    const ids = scope.accounts;
    const byId = new Map((copy.accountNames ?? []).map(a => [a.id, a] as const));
    const named = ids.map(id => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
    if (!named.length) {
      who = ids.length ? `${fmtNum(ids.length)} tài khoản` : 'Chưa có tài khoản';
    } else {
      const shown = named.slice(0, 3).map(a => `${a.name || a.id}${a.channel ? ` (${channelInfo(a.channel).label})` : ''}`);
      const rest = ids.length - shown.length;
      who = rest > 0 ? `${shown.join(', ')} và ${fmtNum(rest)} tài khoản khác` : shown.join(', ');
    }
  }
  return scope.fromTs ? `${who} · từ ${fmtDate(scope.fromTs)}` : who;
}

/** Cảnh báo khi bản sao chỉ có một phần dữ liệu (bước xác nhận khôi phục, chọn bản để theo dõi). */
export function CopyScopeNotice({ copy }: { copy: RemoteDbCopy }) {
  if (!isPartialCopy(copy)) return null;
  return (
    <Notice tone="warning" title={`Gồm: ${describeCopyScope(copy)}`}>
      <p>Bản sao chỉ có các tài khoản / khoảng thời gian trên.</p>
    </Notice>
  );
}

/** Chi tiết một bản sao trên R2: tên, máy, lần đồng bộ, dung lượng, phạm vi ("Gồm: …"), phiên bản Deplao. */
export function RemoteCopyDetails({ copy, appVersion = APP_VERSION }: { copy: RemoteDbCopy; appVersion?: string }) {
  const newer = isNewerThanApp(copy.appVersion, appVersion);
  return (
    <span className="block min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-foreground">{copy.name}</span>
      <span className="block text-xs text-muted-foreground">
        Máy {copy.machine} · đồng bộ {fmtWhen(copy.lastSyncAt)} · {fmtBytes(copy.bytes)}
      </span>
      <span className="block text-xs text-muted-foreground">Gồm: {describeCopyScope(copy)}</span>
      <span className={cn('block text-[11px]', newer ? 'text-warning' : 'text-subtle-foreground')}>
        {newer
          ? `Tạo bởi Deplao ${copy.appVersion}, mới hơn bản đang dùng (${appVersion}). Cập nhật app trước khi khôi phục.`
          : `Deplao ${copy.appVersion}`}
      </span>
    </span>
  );
}

/**
 * Danh sách bản sao workspace trên R2 (chọn một). Bản do Deplao mới hơn tạo bị khoá.
 * `onDelete` + `canDelete`: nút "Xoá bản này trên R2" cạnh bản được phép xoá (nằm ngoài nút chọn).
 */
export function RemoteCopyList({ copies, selectedId, onSelect, appVersion = APP_VERSION, canDelete, onDelete, deletingId = null }: {
  copies: RemoteDbCopy[];
  selectedId: string;
  onSelect: (workspaceId: string) => void;
  appVersion?: string;
  canDelete?: (copy: RemoteDbCopy) => boolean;
  onDelete?: (copy: RemoteDbCopy) => void;
  /** Bản đang xoá (nút hiện vòng quay). */
  deletingId?: string | null;
}) {
  const label = useStoreLabel();
  const deleteLabel = `Xoá bản này trên ${label}`;
  return (
    <div role="radiogroup" aria-label={`Bản sao trên ${label}`} className="space-y-2">
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

/** Workspace vừa khôi phục chưa phải workspace đang mở → chuyển sang (App tải lại tài khoản qua workspace:switched). */
async function switchToWorkspace(id: string): Promise<void> {
  try {
    const active = await ipc.workspace?.getActive();
    const activeId = active?.workspace?.id;
    if (activeId && activeId !== id) await ipc.workspace?.switch(id);
  } catch { /* main tự chuyển khi thay DB */ }
}

// ─── Trình khôi phục ────────────────────────────────────────────────────────────────────

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
  // Kho lưu: hộp tự đọc (mở từ màn đầu thì không nằm trong CloudSettings); chưa đọc xong thì dùng kho của trang Cài đặt.
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
    } catch { /* bản cũ / lỗi: coi như kho R2 */ }
    finally {
      setStorageLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (open) void loadStorage();
  }, [open, loadStorage]);
  // Đăng nhập / ngắt Google, đổi kho ở nơi khác → main báo 'connection'.
  useCloudChanged(areas => {
    if (open && areas.includes('connection')) void loadStorage();
  });

  // Đổi kho ở bước 1 → danh sách bản sao của kho cũ không còn đúng.
  const shownProvider = useRef(provider);
  useEffect(() => {
    if (shownProvider.current === provider) return;
    shownProvider.current = provider;
    setCopies(null);
    setCopiesError(null);
  }, [provider]);

  // Kết nối + cấu hình tunnel (bước 6 hỏi chuyển địa chỉ Internet khi đang dùng Cloudflare tự động).
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
        setCopiesError(res?.error || `Không đọc được danh sách bản sao trên ${labelRef.current}.`);
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

  // Bước 5: ẩn hộp khôi phục khi hộp Thêm tài khoản đang mở; đóng xong thì đọc lại danh sách tài khoản.
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

  /** Bước 1 (máy mới): bản sao nằm ở kho nào. Main từ chối khi đồng bộ trên máy này đang bật (run() báo lỗi). */
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
        setRestoreError(res?.error || 'Khôi phục không thành công.');
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
      if (!passphrase && !passphraseSet) { setPassError('Nhập mật khẩu sao lưu.'); return; }
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
    await run('rehydrate', () => cloudApi()?.media.rehydrateAll(), `Đang tải media từ ${label} về máy`);
  };

  const finish = async () => {
    const api = cloudApi();
    if (!api) return;
    setFinishing(true);
    try {
      if (moveAddress) {
        const moved = await run('move', () => api.tunnel.moveHere(), 'Đã chuyển địa chỉ Internet sang máy này');
        if (moved?.addresses) publishPublicAddresses(moved.addresses);
      }
      if (typeof api.db.resumeAutomations === 'function') {
        const res = await run('resume', () => api.db.resumeAutomations(), 'Đã bật lại chiến dịch, workflow và lịch của ứng dụng');
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
    ? `Dùng bản theo dõi của ${sourceMachine || 'máy chủ'} trên máy này.`
    : mode === 'same'
      ? `Khôi phục dữ liệu của máy này từ bản sao trên ${label}.`
      : `Cài máy mới hoặc cài lại Windows: lấy lại dữ liệu từ bản sao trên ${label}.`;

  let body: React.ReactNode = null;
  if (step === 1) {
    // Máy mới: chọn bản sao nằm ở kho nào (bản app có chọn kho), rồi kết nối kho đó.
    const canPickStore = !!storage && typeof cloudApi()?.storage?.setProvider === 'function';
    const storeChoice = canPickStore ? (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Bản sao lưu nằm ở</p>
        <PillGroup
          label="Kho lưu của bản sao"
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
      connectBody = <Loading text="Đang kiểm tra kết nối…" />;
    } else if (gdrive && storage) {
      connectBody = (
        <div className="space-y-3">
          <StepTitle title={GOOGLE_FIRST_STEP}>Đăng nhập đúng tài khoản Google đã dùng để sao lưu trên máy cũ.</StepTitle>
          {storage.ready && (
            <Notice tone="success" title="Đã đăng nhập Google Drive">
              <p>Tiếp tục để chọn bản sao lưu trên Google Drive.</p>
            </Notice>
          )}
          <GoogleAccountBlock google={storage.google ?? EMPTY_GOOGLE_STATUS} onStorage={setOwnStorage} />
        </div>
      );
    } else if (connection?.connected) {
      connectBody = (
        <div className="space-y-3">
          <Notice tone="success" title={`Đã kết nối Cloudflare${connection.accountName ? ` · ${connection.accountName}` : ''}`}>
            <p>Tiếp tục để chọn bản sao lưu trên R2.</p>
          </Notice>
          <R2RequiredNotice connection={connection} onRecheck={() => void recheck()} rechecking={busy === 'recheck'} />
        </div>
      );
    } else {
      connectBody = (
        <div className="space-y-3">
          <StepTitle title="Kết nối Cloudflare">Dán token Cloudflare cho máy này: token của máy cũ được khoá theo máy cũ.</StepTitle>
          <ConnectForm onConnected={setConnection} initialAccountId={connection?.accountId ?? ''} />
        </div>
      );
    }
    body = storeChoice ? <div className="space-y-4">{storeChoice}{connectBody}</div> : connectBody;
  } else if (step === 2) {
    body = (
      <div className="space-y-3">
        <StepTitle title="Chọn workspace">{`Mỗi workspace có một bản trên ${label}. Chọn bản cần khôi phục về máy này.`}</StepTitle>
        {copies === null ? (
          <Loading text={`Đang đọc bản sao trên ${label}…`} />
        ) : copies.length === 0 ? (
          <Notice
            tone={copiesError ? 'destructive' : 'info'}
            action={<Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} onClick={() => void loadCopies()}>Tải lại</Button>}
          >
            <p>{copiesError || `Chưa có bản sao lưu nào trên ${label} của tài khoản này.`}</p>
          </Notice>
        ) : (
          <RemoteCopyList copies={copies} selectedId={selectedId} onSelect={setSelectedId} />
        )}
      </div>
    );
  } else if (step === 3) {
    body = (
      <div className="space-y-4">
        <StepTitle title="Nhập mật khẩu sao lưu">
          Mật khẩu đặt khi bật Đồng bộ dữ liệu trên máy chủ. Deplao giải mã trên máy này, không gửi mật khẩu đi đâu.
        </StepTitle>
        <FormField
          label="Mật khẩu sao lưu"
          htmlFor={passId}
          error={passError}
          hint={passphraseSet ? 'Máy này đã lưu mật khẩu: để trống để dùng mật khẩu đã lưu.' : undefined}
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
            <summary className="cursor-pointer select-none text-xs font-medium text-foreground">Khôi phục tới một thời điểm cũ hơn</summary>
            <div className="mt-2 space-y-2 text-xs text-muted-foreground">
              <p>
                Chọn thời điểm trong khoảng từ bản gốc ({fmtWhen(selected.baseAt)}) tới lần đồng bộ cuối
                ({fmtWhen(selected.lastSyncAt)}). Để trống là bản mới nhất.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  className="w-60"
                  aria-label="Khôi phục tới thời điểm"
                  min={toLocalInput(selected.baseAt)}
                  max={toLocalInput(selected.lastSyncAt)}
                  value={untilTs ? toLocalInput(untilTs) : ''}
                  invalid={untilOutOfRange}
                  onChange={e => setUntilTs(e.target.value ? new Date(e.target.value).getTime() : null)}
                />
                {untilTs && <Button size="sm" variant="ghost" onClick={() => setUntilTs(null)}>Dùng bản mới nhất</Button>}
              </div>
              {untilOutOfRange && <p className="text-destructive">Thời điểm phải nằm trong khoảng trên.</p>}
            </div>
          </details>
        )}
        {selected && <CopyScopeNotice copy={selected} />}
        <Notice tone="warning">
          <p>
            {`Dữ liệu của workspace này trên máy sẽ được thay bằng bản trên ${label}. Kênh chat không tự kết nối; chiến dịch, workflow và lịch của ứng dụng tạm dừng tới bước 6.`}
          </p>
        </Notice>
      </div>
    );
  } else if (step === 4) {
    const notStarted = mode === 'promote' && !restoring && !restored && !restoreError && !progress;
    body = notStarted ? (
      <div className="space-y-3">
        <StepTitle title="Chuyển sang máy này">
          Dữ liệu của {sourceMachine || 'máy chủ'} đã có trên máy này. Bấm Chuyển sang máy này để dùng ngay; kênh chat
          đăng nhập lại ở bước sau.
        </StepTitle>
        <Notice tone="warning"><p>Chỉ làm khi máy chủ cũ đã hỏng hoặc đã tắt, tránh hai máy cùng gửi tin.</p></Notice>
      </div>
    ) : (
      <div className="space-y-3">
        <StepTitle title={progressLabel(restored ? 'done' : restoreError ? 'error' : progress?.step ?? 'download', label)} />
        <ProgressBar
          value={progress?.percent ?? 0}
          tone={restoreError ? 'destructive' : restored ? 'success' : 'primary'}
          label="Tiến độ khôi phục"
        />
        <p className="text-xs text-muted-foreground">{progress?.message || `${Math.round(progress?.percent ?? 0)}%`}</p>
        {restoring && <Notice tone="warning"><p>Không đóng app trong lúc khôi phục.</p></Notice>}
        {restoreError && <Notice tone="destructive"><p>{restoreError}</p></Notice>}
        {restored && <Notice tone="success"><p>Dữ liệu đã về máy. Bước tiếp theo: đăng nhập lại các kênh chat.</p></Notice>}
      </div>
    );
  } else if (step === 5) {
    body = (
      <div className="space-y-3">
        <StepTitle title="Đăng nhập lại từng kênh">
          Lịch sử đã khôi phục; đăng nhập xong, tin mới vào đúng hội thoại. Tài khoản chưa đăng nhập vẫn xem được lịch sử.
        </StepTitle>
        {accounts === null ? (
          <Loading text="Đang đọc danh sách tài khoản…" />
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Bản khôi phục không có tài khoản kênh nào.</p>
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
                        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />Đã đăng nhập
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{info.how}</p>
                    )}
                  </div>
                  {!acc.connected && <Button size="sm" onClick={() => login(acc)}>Đăng nhập</Button>}
                </li>
              );
            })}
          </ul>
        )}
        <Notice tone="warning" title="Chiến dịch, workflow và lịch của ứng dụng đang tạm dừng">
          <p>Bật lại ở bước 6, khi đã chắc máy cũ không còn chạy.</p>
        </Notice>
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {`Media tự tải từ ${label} khi mở. Muốn có sẵn trên máy:`}
          <Button variant="link" size="sm" className="text-xs" leftIcon={<DownloadIcon className="h-3.5 w-3.5" />} loading={busy === 'rehydrate'} onClick={() => void rehydrate()}>
            Tải hết media về máy
          </Button>
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        <StepTitle title="Bật lại tự động hoá">
          Chiến dịch, workflow và lịch của ứng dụng đang tạm dừng để không gửi trùng với máy cũ. Chỉ bật khi máy cũ đã tắt
          hoặc đã ngắt Deplao.
        </StepTitle>
        <Checkbox checked={oldMachineOff} onCheckedChange={setOldMachineOff} label="Máy cũ đã tắt hoặc đã ngắt Deplao" />
        {tunnelAuto && (
          <Checkbox
            checked={moveAddress}
            onCheckedChange={setMoveAddress}
            label="Chuyển địa chỉ Internet sang máy này"
            description="Trỏ tên miền về máy này để nhân viên ở xa, Casso, SePay, website tiếp tục dùng địa chỉ cũ."
          />
        )}
        {!canResume && (
          <Notice tone="info"><p>Bản app này chưa tự bật lại được: mở Chiến dịch và Workflow để bật lại từng mục.</p></Notice>
        )}
      </div>
    );
  }

  let footer: React.ReactNode = null;
  if (step === 1) {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>Huỷ</Button>
        <Button disabled={!storageLoaded || !storeReady} onClick={goNext}>Tiếp tục</Button>
      </>
    );
  } else if (step === 2) {
    footer = (
      <>
        {mode === 'new'
          ? <Button variant="ghost" onClick={goBack}>Quay lại</Button>
          : <Button variant="ghost" onClick={requestClose}>Huỷ</Button>}
        <Button disabled={!selected || isNewerThanApp(selected.appVersion)} onClick={goNext}>Tiếp tục</Button>
      </>
    );
  } else if (step === 3) {
    footer = (
      <>
        <Button variant="ghost" onClick={goBack}>Quay lại</Button>
        <Button disabled={untilOutOfRange} onClick={goNext}>Khôi phục</Button>
      </>
    );
  } else if (step === 4) {
    if (restoring) {
      footer = <Button disabled leftIcon={<CloudSpinner className="h-4 w-4 text-current" />}>Đang khôi phục…</Button>;
    } else if (restored) {
      footer = <Button onClick={goNext}>Tiếp tục</Button>;
    } else if (restoreError) {
      footer = (
        <>
          {mode === 'promote'
            ? <Button variant="ghost" onClick={requestClose}>Đóng</Button>
            : <Button variant="ghost" onClick={goBack}>Quay lại</Button>}
          <Button onClick={() => void startRestore()}>Thử lại</Button>
        </>
      );
    } else {
      footer = (
        <>
          <Button variant="ghost" onClick={requestClose}>Huỷ</Button>
          <Button onClick={() => void startRestore()}>Chuyển sang máy này</Button>
        </>
      );
    }
  } else if (step === 5) {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>Để sau</Button>
        <Button onClick={goNext}>Tiếp tục</Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="ghost" onClick={requestClose}>Để sau</Button>
        <Button disabled={!oldMachineOff} loading={finishing} onClick={() => void finish()}>Bật lại tự động hoá</Button>
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
            <DialogTitle>{gdrive ? 'Khôi phục từ Google Drive' : 'Khôi phục từ Cloudflare'}</DialogTitle>
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

// ─── Mở từ bất kỳ đâu (màn đầu, hộp Thêm tài khoản…) ──────────────────────────────────────

let closeActiveWizard: (() => void) | null = null;

/**
 * Mở trình khôi phục bằng một root React riêng gắn vào document.body (không cần đặt component trong cây).
 * Mở lần nữa khi đang mở thì dùng lại hộp đang mở. Trả hàm đóng.
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
  // Hộp Thêm tài khoản (nếu đang mở) nhường chỗ cho trình khôi phục.
  const app = useAppStore.getState();
  if (app.addAccountModalOpen) app.setAddAccountModalOpen(false);
  root.render(<RestoreWizard {...options} open onClose={close} />);
  return close;
}

export default RestoreWizard;
