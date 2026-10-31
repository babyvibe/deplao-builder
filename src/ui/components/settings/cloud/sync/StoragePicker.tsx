/**
 * Đồng bộ dữ liệu → "Kho lưu": chọn nơi đặt ảnh/file + bản sao dữ liệu — Cloudflare R2 hoặc Google Drive (Google One).
 *  - Hai thẻ chọn một (role="radio"): bảng giá / hạn mức tóm tắt (số lấy từ R2_PRICING, GDRIVE_LIMITS) và trạng thái
 *    của từng kho.
 *  - Google (GoogleAccountBlock, dùng lại ở trình khôi phục): đăng nhập trên trình duyệt (google.connect chờ tới khi
 *    người dùng đồng ý, Huỷ = cancelConnect), dung lượng tài khoản (quota), Đọc lại / Đổi tài khoản / Ngắt kết nối;
 *    "Nâng cao: dùng client OAuth riêng" (Client ID + secret + hướng dẫn tạo trên Google Cloud).
 *  - Đổi kho chỉ khi đồng bộ đang tắt (main cũng chặn, code STORAGE_SWITCH_BLOCKED — run() hiện lỗi); hỏi lại trước.
 */
import React, { useId, useRef, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  AlertIcon,
  ExternalLinkIcon,
  HardDriveIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  UnlinkIcon,
} from '@/components/common/icons';
import { Badge, Button, Card, FormField, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  GDRIVE_LIMITS,
  R2_PRICING,
  storageLabel,
  type CloudConnectionStatus,
  type CloudStorageProvider,
  type CloudStorageStatus,
  type GoogleClientInput,
  type GoogleDriveQuota,
  type GoogleDriveStatus,
} from '../../../../../shared/cloud/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  CloudSpinner,
  fmtBytes,
  fmtBytesPair,
  fmtMillions,
  fmtPercent,
  fmtUsdPrice,
  GOOGLE_CLOUD_CREDENTIALS_URL,
  isR2Ready,
  meterTone,
  METER_TEXT,
  Notice,
  openExternalUrl,
  permissionOf,
  ProgressBar,
  shortClientId,
  useCloudAction,
} from '../cloudUi';

// ─── Bảng giá / hạn mức tóm tắt ──────────────────────────────────────────────────────────

/** Một dòng trong thẻ kho: chấm đầu dòng (hoặc biểu tượng cảnh báo) + chữ, kèm dòng giải thích nhỏ (i). */
function PriceLine({ children, hint, warning = false }: { children: React.ReactNode; hint?: string; warning?: boolean }) {
  return (
    <span className={cn('block text-xs leading-relaxed', warning ? 'text-warning' : 'text-foreground/90')}>
      <span className="flex items-start gap-1.5">
        {warning ? (
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <span aria-hidden="true" className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground" />
        )}
        <span className="min-w-0">{children}</span>
      </span>
      {hint && (
        <span className="mt-0.5 flex items-start gap-1 pl-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <InfoIcon className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span className="min-w-0">{hint}</span>
        </span>
      )}
    </span>
  );
}

function R2Lines() {
  const P = R2_PRICING;
  return (
    <>
      <PriceLine>{`${P.freeStorageGbMonth} GB miễn phí mỗi tháng, sau đó ${fmtUsdPrice(P.storageUsdPerGbMonth)} USD/GB-tháng`}</PriceLine>
      <PriceLine hint="mỗi lần đẩy file / phần file, tạo bản sao, liệt kê">
        <strong className="font-medium text-foreground">Ghi (Class A)</strong>
        {` — ${fmtMillions(P.freeClassA)} lượt/tháng miễn phí, sau đó ${fmtUsdPrice(P.classAUsdPerMillion)} USD/triệu`}
      </PriceLine>
      <PriceLine hint="mỗi lần tải file về hoặc kiểm tra file">
        <strong className="font-medium text-foreground">Đọc (Class B)</strong>
        {` — ${fmtMillions(P.freeClassB)} lượt/tháng miễn phí, sau đó ${fmtUsdPrice(P.classBUsdPerMillion)} USD/triệu`}
      </PriceLine>
      <PriceLine>Xoá file: miễn phí · Tải xuống: miễn phí, không giới hạn</PriceLine>
    </>
  );
}

function GoogleLines() {
  const G = GDRIVE_LIMITS;
  return (
    <>
      <PriceLine>
        15 GB miễn phí, dùng chung Gmail và Google Photos; thêm dung lượng theo gói Google One (vd 100 GB 45.000 ₫/tháng)
      </PriceLine>
      <PriceLine hint={`đọc thông tin ${G.unitsRead}, liệt kê ${G.unitsList}, tải xuống ${G.unitsDownload}, ghi/sửa ${G.unitsEdit} đơn vị`}>
        <strong className="font-medium text-foreground">Không tính phí theo lượt đọc / ghi</strong>
        {` — hạn mức ${fmtMillions(G.unitsPerDayPerProject)} đơn vị/ngày cho cả client OAuth`}
      </PriceLine>
      <PriceLine>
        {`Tải xuống: miễn phí dưới ${fmtBytes(G.egressBytesPerDayPerProject)}/ngày · Tải lên: tối đa ${fmtBytes(G.uploadBytesPerDayPerUser)}/ngày mỗi tài khoản`}
      </PriceLine>
      <PriceLine warning>
        Dung lượng đầy thì không tải lên được và Gmail có thể không nhận thư — nên dùng một tài khoản Google riêng cho sao lưu.
      </PriceLine>
    </>
  );
}

// ─── Một thẻ kho ─────────────────────────────────────────────────────────────────────────

/**
 * Phần trên (nút role="radio": tên kho + bảng giá) chọn kho; phần dưới (trạng thái, đăng nhập Google…) nằm ngoài nút
 * để không lồng nút trong nút.
 */
function StoreOption({ value, title, active, busy = false, onSelect, lines, footer }: {
  value: CloudStorageProvider;
  title: string;
  active: boolean;
  busy?: boolean;
  onSelect: () => void;
  lines: React.ReactNode;
  footer: React.ReactNode;
}) {
  const descId = useId();
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-xl border-2 transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={title}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        data-value={value}
        onClick={onSelect}
        className={cn(
          'flex w-full items-start gap-3 rounded-t-[10px] p-4 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
            active ? 'border-primary' : 'border-input bg-muted',
          )}
        >
          {active && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('flex flex-wrap items-center gap-2 text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}>
            {title}
            {active && <Badge size="sm" variant="primary">Đang dùng</Badge>}
            {busy && <CloudSpinner className="h-3.5 w-3.5" />}
          </span>
          <span id={descId} className="mt-2 block space-y-1.5">{lines}</span>
        </span>
      </button>
      <div className="mt-auto border-t border-border px-4 py-3">{footer}</div>
    </div>
  );
}

// ─── Tài khoản Google ────────────────────────────────────────────────────────────────────

/** Trạng thái Google khi main chưa trả (phòng hờ): chưa đăng nhập, có client chung. */
export const EMPTY_GOOGLE_STATUS: GoogleDriveStatus = {
  connected: false,
  email: null,
  displayName: null,
  customClient: false,
  builtinClient: true,
  clientId: null,
  quota: null,
  checkedAt: null,
  lastError: null,
  connecting: false,
};

function GoogleQuota({ quota }: { quota: GoogleDriveQuota }) {
  const limit = quota.limit && quota.limit > 0 ? quota.limit : null;
  const pct = limit ? (quota.usage / limit) * 100 : null;
  const tone = meterTone(pct);
  const trash = quota.usageInDriveTrash > 0 ? ` (thùng rác ${fmtBytes(quota.usageInDriveTrash)})` : '';
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-foreground">
        <span>{limit ? `Đã dùng ${fmtBytesPair(quota.usage, limit)}` : `Đã dùng ${fmtBytes(quota.usage)} · không giới hạn`}</span>
        {pct != null && <span className={cn('font-medium tabular-nums', METER_TEXT[tone])}>{fmtPercent(pct)}</span>}
      </p>
      {pct != null && <ProgressBar value={pct} tone={tone} label="Dung lượng tài khoản Google" />}
      <p className="text-[11px] text-subtle-foreground">
        {`Trong đó Drive ${fmtBytes(quota.usageInDrive)}${trash} · dùng chung Gmail, Google Photos`}
      </p>
    </div>
  );
}

const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/i;

/** "Nâng cao: dùng client OAuth riêng": hướng dẫn tạo client Desktop trên Google Cloud + ô Client ID / secret. */
function CustomClientSection({ google, disabled, onConnect, initialOpen }: {
  google: GoogleDriveStatus;
  disabled: boolean;
  onConnect: (client: GoogleClientInput) => void;
  initialOpen?: boolean;
}) {
  const idField = useId();
  const secretField = useId();
  // Bản app không có client chung thì đây là cách duy nhất để đăng nhập → mở sẵn.
  const [open, setOpen] = useState(initialOpen ?? !google.builtinClient);
  const [clientId, setClientId] = useState(google.customClient ? google.clientId ?? '' : '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const id = clientId.trim();
    if (!CLIENT_ID_RE.test(id)) {
      setError('Client ID có dạng …apps.googleusercontent.com (Credentials → OAuth 2.0 Client IDs).');
      return;
    }
    setError(null);
    onConnect({ clientId: id, clientSecret: secret.trim() || null });
    setSecret('');
  };

  return (
    <details open={open} onToggle={e => setOpen(e.currentTarget.open)} className="rounded-lg border border-border">
      <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50">
        Nâng cao: dùng client OAuth riêng
      </summary>
      <form
        className="space-y-3 border-t border-border px-3 py-3"
        autoComplete="off"
        onSubmit={e => { e.preventDefault(); if (!disabled) submit(); }}
      >
        {!google.builtinClient && (
          <Notice tone="info">
            <p>
              Bản Deplao này không có sẵn client Google chung. Tạo client OAuth riêng (miễn phí) theo hướng dẫn dưới đây
              rồi bấm Đăng nhập bằng client này.
            </p>
          </Notice>
        )}
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>Mở Google Cloud Console, tạo một project.</li>
          <li>{'APIs & Services → Library: bật Google Drive API.'}</li>
          <li>
            OAuth consent screen: chọn External, thêm quyền (scope) drive.file; Publishing status chọn In production — để
            Testing thì sau 7 ngày phải đăng nhập lại.
          </li>
          <li>Credentials → Create credentials → OAuth client ID → Application type: Desktop app, rồi dán Client ID và Client secret vào đây.</li>
        </ol>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Dùng client riêng thì hạn mức Drive API mỗi ngày là của riêng bạn. Quyền drive.file chỉ thấy file do chính client
          (project) đó tạo: máy khác muốn khôi phục phải đăng nhập bằng cùng client.
        </p>
        <Button
          variant="link"
          size="sm"
          className="text-xs"
          rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
          onClick={() => openExternalUrl(GOOGLE_CLOUD_CREDENTIALS_URL)}
        >
          Mở Google Cloud Console
        </Button>
        <FormField label="Client ID" htmlFor={idField}>
          <Input
            id={idField}
            spellCheck={false}
            autoComplete="off"
            value={clientId}
            placeholder="…apps.googleusercontent.com"
            className="font-mono text-xs"
            onChange={e => { setClientId(e.target.value); setError(null); }}
          />
        </FormField>
        <FormField label="Client secret" htmlFor={secretField} hint="Không bắt buộc (client Desktop dùng PKCE); có thì dán vào.">
          <Input
            id={secretField}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={secret}
            onChange={e => { setSecret(e.target.value); setError(null); }}
          />
        </FormField>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" size="sm" variant="outline" disabled={disabled || !clientId.trim()}>
          Đăng nhập bằng client này
        </Button>
      </form>
    </details>
  );
}

export interface GoogleAccountBlockProps {
  google: GoogleDriveStatus;
  /** Trạng thái kho mới từ main (đăng nhập, ngắt, đọc lại dung lượng). */
  onStorage?: (storage: CloudStorageStatus) => void;
  /** Đồng bộ đang dùng kho Google Drive (hỏi kỹ hơn trước khi ngắt). */
  inUse?: boolean;
  /** Mở sẵn phần client OAuth riêng (test); mặc định chỉ mở khi bản app không có client chung. */
  initialClientOpen?: boolean;
}

/**
 * Tài khoản Google của kho Google Drive: chưa đăng nhập → "Đăng nhập Google" (đang chờ trình duyệt: vòng quay + Huỷ);
 * đã đăng nhập → email, dung lượng tài khoản, Đọc lại / Đổi tài khoản / Ngắt kết nối. Dùng ở thẻ Kho lưu và bước 1 của
 * trình khôi phục.
 */
export function GoogleAccountBlock({ google, onStorage, inUse = false, initialClientOpen }: GoogleAccountBlockProps) {
  const { busy, run, notify } = useCloudAction();
  const [waiting, setWaiting] = useState(false);
  const cancelled = useRef(false);
  const connecting = waiting || !!google.connecting;
  // Đăng nhập / Đổi tài khoản: client riêng đã lưu (chỉ gửi client_id — main dùng lại secret đã lưu), không thì client chung.
  const savedClient: GoogleClientInput | null = google.customClient && google.clientId ? { clientId: google.clientId } : null;
  const canSignIn = !!savedClient || !!google.builtinClient;

  const reloadStorage = async () => {
    try {
      const res = await cloudApi()?.storage?.status?.();
      if (res?.success && res.storage) onStorage?.(res.storage);
    } catch { /* main còn báo qua CLOUD_CHANGED_EVENT */ }
  };

  const connect = async (client: GoogleClientInput | null) => {
    const api = cloudApi()?.google;
    if (typeof api?.connect !== 'function') {
      notify('Bản app này chưa có tính năng Google Drive. Hãy cập nhật Deplao.', 'warning');
      return;
    }
    cancelled.current = false;
    setWaiting(true);
    try {
      const res = await api.connect(client);
      if (res?.storage) onStorage?.(res.storage);
      if (cancelled.current) return; // người dùng bấm Huỷ: không báo lỗi
      if (!res?.success) {
        notify(res?.error || 'Chưa đăng nhập được Google, thử lại sau.', 'error');
        return;
      }
      const email = res.storage?.google?.email;
      notify(email ? `Đã đăng nhập Google Drive · ${email}` : 'Đã đăng nhập Google Drive', 'success');
    } catch (err) {
      if (!cancelled.current) notify(cleanIpcError(err), 'error');
    } finally {
      setWaiting(false);
    }
  };

  const cancel = async () => {
    cancelled.current = true;
    await run('google-cancel', () => cloudApi()?.google?.cancelConnect());
    setWaiting(false);
    await reloadStorage();
  };

  const refresh = async () => {
    const res = await run('google-refresh', () => cloudApi()?.google?.refresh());
    if (res?.storage) onStorage?.(res.storage);
  };

  const disconnect = async () => {
    const ok = await showConfirm({
      title: 'Ngắt kết nối Google Drive?',
      message: `Deplao thu hồi quyền truy cập và xoá đăng nhập Google trên máy này. File đã lên Google Drive vẫn giữ nguyên.${inUse ? ' Đồng bộ dữ liệu sẽ dừng cho tới khi đăng nhập lại.' : ''}`,
      confirmText: 'Ngắt kết nối',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await run('google-disconnect', () => cloudApi()?.google?.disconnect(), 'Đã ngắt kết nối Google Drive');
    if (res?.storage) onStorage?.(res.storage);
    else if (res) await reloadStorage();
  };

  return (
    <div className="space-y-3">
      {google.connected ? (
        <div className="space-y-2.5">
          <div className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-success" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground" title={google.email ?? undefined}>
                {google.email || 'Đã đăng nhập Google'}
              </p>
              {google.displayName && <p className="truncate text-xs text-muted-foreground">{google.displayName}</p>}
            </div>
          </div>
          {google.quota && <GoogleQuota quota={google.quota} />}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              leftIcon={<RefreshIcon className="h-4 w-4" />}
              loading={busy === 'google-refresh'}
              disabled={connecting}
              onClick={() => void refresh()}
            >
              Đọc lại
            </Button>
            {canSignIn && (
              <Button size="sm" variant="outline" disabled={connecting} onClick={() => void connect(savedClient)}>
                Đổi tài khoản
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              leftIcon={<UnlinkIcon className="h-4 w-4" />}
              loading={busy === 'google-disconnect'}
              disabled={connecting}
              onClick={() => void disconnect()}
            >
              Ngắt kết nối
            </Button>
          </div>
        </div>
      ) : !connecting && (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Đăng nhập trên trình duyệt của máy. Deplao chỉ xem được file do chính Deplao tạo trên Drive của bạn.
          </p>
          {canSignIn && <Button size="sm" onClick={() => void connect(savedClient)}>Đăng nhập Google</Button>}
        </div>
      )}
      {connecting && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <CloudSpinner className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1">Đang chờ đăng nhập trên trình duyệt…</span>
          <Button size="sm" variant="ghost" loading={busy === 'google-cancel'} onClick={() => void cancel()}>Huỷ</Button>
        </div>
      )}
      {google.lastError && !connecting && <p className="text-xs text-destructive">{google.lastError}</p>}
      {google.customClient && (
        <p className="text-[11px] text-subtle-foreground">Đang dùng client riêng ({shortClientId(google.clientId)})</p>
      )}
      <CustomClientSection
        google={google}
        disabled={connecting}
        onConnect={client => void connect(client)}
        initialOpen={initialClientOpen}
      />
    </div>
  );
}

// ─── Thẻ Kho lưu ─────────────────────────────────────────────────────────────────────────

export interface StoragePickerProps {
  storage: CloudStorageStatus;
  connection: CloudConnectionStatus | null;
  /** Lý do chưa đổi được kho (đồng bộ đang bật, máy dự phòng…); null = đổi được. */
  lockReason?: string | null;
  /** Đồng bộ đang chạy trên kho đang chọn (hỏi kỹ hơn khi ngắt Google). */
  inUse?: boolean;
  /** Trạng thái kho mới từ main (đổi kho, đăng nhập / ngắt Google). */
  onStorage?: (storage: CloudStorageStatus) => void;
  /** Đã đổi kho → đọc lại trạng thái đồng bộ. */
  onProviderChanged?: (provider: CloudStorageProvider) => void;
  /** Cuộn tới ô kết nối Cloudflare ở đầu trang. */
  onConnect?: () => void;
  /** Làm nổi thẻ (bấm "Chọn kho lưu" ở thông báo phía trên). */
  highlight?: boolean;
  /** Mở sẵn "Nâng cao: dùng client OAuth riêng" (test). */
  initialClientOpen?: boolean;
  className?: string;
}

export function StoragePicker({
  storage,
  connection,
  lockReason = null,
  inUse = false,
  onStorage,
  onProviderChanged,
  onConnect,
  highlight = false,
  initialClientOpen,
  className,
}: StoragePickerProps) {
  const { busy, run } = useCloudAction();
  const [nudge, setNudge] = useState(false);
  const [target, setTarget] = useState<CloudStorageProvider | null>(null);
  const provider = storage.provider;

  const choose = async (next: CloudStorageProvider) => {
    if (next === provider || busy === 'provider') return;
    if (lockReason) {
      setNudge(true);
      return;
    }
    const ok = await showConfirm({
      title: `Đổi kho lưu sang ${storageLabel(next)}?`,
      message: `Ảnh, file sẽ được tải lên lại từ đầu lên kho mới; dữ liệu tạo bản gốc mới. Bản trên ${storageLabel(provider)} vẫn giữ — chọn lại kho cũ để khôi phục từ đó.`,
      confirmText: 'Đổi kho lưu',
      variant: 'warning',
    });
    if (!ok) return;
    setTarget(next);
    try {
      const res = await run('provider', () => cloudApi()?.storage?.setProvider(next), `Đã chọn kho ${storageLabel(next)}`);
      if (!res) return;
      if (res.storage) onStorage?.(res.storage);
      onProviderChanged?.(next);
    } finally {
      setTarget(null);
    }
  };

  // Trạng thái R2: đang chọn thì theo main; không chọn thì xem kết nối Cloudflare ở đầu trang.
  const r2Active = provider === 'r2';
  const r2Ready = r2Active ? storage.ready : isR2Ready(connection);
  let r2Status: string;
  if (r2Ready) r2Status = 'Dùng tài khoản Cloudflare đã kết nối ở đầu trang';
  else if (r2Active && storage.notReadyReason) r2Status = storage.notReadyReason;
  else if (!connection?.connected) r2Status = 'Cần kết nối Cloudflare ở đầu trang';
  else if (permissionOf(connection, 'r2')?.r2NotEnabled) r2Status = 'Tài khoản Cloudflare chưa bật R2';
  else r2Status = 'Token Cloudflare thiếu quyền R2';

  return (
    <Card
      className={cn(
        'space-y-3 p-4 transition-shadow',
        highlight && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        className,
      )}
    >
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HardDriveIcon className="h-4 w-4 text-muted-foreground" />
          Kho lưu
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          Nơi đặt ảnh, file và bản sao dữ liệu. Mỗi lúc dùng một kho; Địa chỉ Internet vẫn chạy trên Cloudflare.
        </p>
      </div>

      <div role="radiogroup" aria-label="Kho lưu" className="grid gap-3 md:grid-cols-2">
        <StoreOption
          value="r2"
          title="Cloudflare R2"
          active={r2Active}
          busy={target === 'r2'}
          onSelect={() => void choose('r2')}
          lines={<R2Lines />}
          footer={(
            <div className="space-y-1.5">
              <p className={cn('flex items-start gap-2 text-xs', !r2Ready && r2Active ? 'text-warning' : 'text-muted-foreground')}>
                <span
                  aria-hidden="true"
                  className={cn('mt-1 h-2 w-2 flex-shrink-0 rounded-full', r2Ready ? 'bg-success' : r2Active ? 'bg-warning' : 'bg-accent')}
                />
                <span className="min-w-0">{r2Status}</span>
              </p>
              {!r2Ready && !connection?.connected && onConnect && (
                <Button variant="link" size="sm" className="text-xs" onClick={onConnect}>Kết nối Cloudflare</Button>
              )}
            </div>
          )}
        />
        <StoreOption
          value="gdrive"
          title="Google Drive (Google One)"
          active={provider === 'gdrive'}
          busy={target === 'gdrive'}
          onSelect={() => void choose('gdrive')}
          lines={<GoogleLines />}
          footer={(
            <GoogleAccountBlock
              google={storage.google ?? EMPTY_GOOGLE_STATUS}
              onStorage={onStorage}
              inUse={inUse && provider === 'gdrive'}
              initialClientOpen={initialClientOpen}
            />
          )}
        />
      </div>

      {lockReason && (
        <p className={cn('flex items-center gap-1.5 text-xs', nudge ? 'font-medium text-warning' : 'text-muted-foreground')}>
          <LockIcon className="h-3.5 w-3.5 flex-shrink-0" />
          {lockReason}
        </p>
      )}
    </Card>
  );
}

export default StoragePicker;
