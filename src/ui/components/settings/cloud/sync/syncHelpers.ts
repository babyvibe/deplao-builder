/**
 * syncHelpers — phần thuần (không React) của Cài đặt → Internet & Đám mây → Đồng bộ dữ liệu: nhãn chế độ, giá trị mặc
 * định khi main chưa trả trạng thái, so sánh nháp với thiết lập đã lưu, câu tóm tắt
 * "2 tài khoản (A, B) · từ 01/01/2026 · Theo giờ · kèm ảnh" và nhãn của thẻ phần ("Theo giờ · 13:03", "ảnh 614/24.625").
 * Câu có nhắc tới kho nhận thêm `label` (tên kho: "R2" mặc định, "Google Drive" — storageLabel()).
 */
import type { BadgeVariant } from '@/components/ui';
import {
  ALL_SCOPE,
  normalizeScope,
  sameScope,
  type CloudConnectionStatus,
  type CloudScope,
  type CloudStorageStatus,
  type DbSyncMode,
  type DbSyncStatus,
  type MediaSyncOptions,
  type MediaSyncStatus,
  type SyncConfig,
  type SyncOverview,
} from '../../../../../shared/cloud/cloudContracts';
import {
  describeScopeTime,
  fmtLag,
  fmtNum,
  fmtShortWhen,
  isMediaBackingOff,
  scopeAccountName,
  type ScopeAccount,
} from '../cloudUi';

export const SYNC_MODES: DbSyncMode[] = ['off', 'hourly', 'realtime'];

export const SYNC_MODE_LABEL: Record<DbSyncMode, string> = { off: 'Tắt', hourly: 'Theo giờ', realtime: 'Realtime' };

/** Dòng giải thích dưới nút chọn chế độ; `label` = tên kho ("R2", "Google Drive"). */
export function syncModeNote(mode: DbSyncMode, label = 'R2'): string {
  switch (mode) {
    case 'hourly': return `Đẩy thay đổi mỗi giờ · không có thay đổi thì không gọi ${label}`;
    case 'realtime': return `Trễ tối đa 5 giây · không có thay đổi thì không gọi ${label}`;
    default: return `Không đồng bộ. Bản đã có trên ${label} vẫn giữ và khôi phục được.`;
  }
}

/** Như syncModeNote với kho R2 (giữ cho chỗ dùng cũ). */
export const SYNC_MODE_NOTE: Record<DbSyncMode, string> = {
  off: syncModeNote('off'),
  hourly: syncModeNote('hourly'),
  realtime: syncModeNote('realtime'),
};

export const DEFAULT_MEDIA_OPTIONS: MediaSyncOptions = {
  concurrency: 3,
  nightOnly: false,
  bandwidthKbps: 0,
  evictEnabled: false,
  evictKeepDays: 30,
  evictMinFreeGb: 20,
};

export const EMPTY_DB_STATUS: DbSyncStatus = {
  mode: 'off',
  passphraseSet: false,
  bucket: null,
  scope: ALL_SCOPE,
  workspaces: [],
  followers: [],
  following: null,
};

export const EMPTY_MEDIA_STATUS: MediaSyncStatus = {
  enabled: false,
  bucket: null,
  running: false,
  paused: false,
  totals: { files: 0, uploaded: 0, pending: 0, failed: 0, evicted: 0, bytesTotal: 0, bytesUploaded: 0 },
  backoffUntil: null,
  options: DEFAULT_MEDIA_OPTIONS,
  lastError: null,
};

/** Thiết lập từ main / nháp → dạng chuẩn (thiếu "kèm ảnh" / "file chung" = bật). */
export function normalizeSyncConfig(value: Partial<SyncConfig> | null | undefined): SyncConfig {
  const v = value || {};
  return {
    mode: SYNC_MODES.includes(v.mode as DbSyncMode) ? (v.mode as DbSyncMode) : 'off',
    scope: normalizeScope(v.scope),
    includeMedia: v.includeMedia !== false,
    includeShared: v.includeShared !== false,
  };
}

/** Overview luôn đủ trường để vẽ (main chưa trả / bản cũ thiếu trường → mặc định). */
export function overviewOrDefault(overview: SyncOverview | null | undefined): SyncOverview {
  const media = overview?.media ?? EMPTY_MEDIA_STATUS;
  return {
    config: normalizeSyncConfig(overview?.config),
    db: overview?.db ?? EMPTY_DB_STATUS,
    media: { ...media, options: { ...DEFAULT_MEDIA_OPTIONS, ...(media.options || {}) } },
  };
}

export function sameSyncConfig(a: SyncConfig, b: SyncConfig): boolean {
  return a.mode === b.mode
    && sameScope(a.scope, b.scope)
    && a.includeMedia === b.includeMedia
    && a.includeShared === b.includeShared;
}

/** "Tất cả tài khoản" · "1 tài khoản (Shop Hoa Lan)" · "2 tài khoản (Shop Hoa Lan, Kho tổng)" · "5 tài khoản (A, B, C, …)". */
export function describeSyncAccounts(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  const s = normalizeScope(scope);
  if (s.accounts === 'all') return 'Tất cả tài khoản';
  if (s.accounts.length === 0) return 'Chưa chọn tài khoản';
  const byId = new Map(accounts.map(a => [a.zalo_id, a] as [string, ScopeAccount]));
  const names = s.accounts
    .map(id => byId.get(id))
    .filter((a): a is ScopeAccount => !!a)
    .map(scopeAccountName);
  const count = `${fmtNum(s.accounts.length)} tài khoản`;
  if (!names.length) return count;
  const shown = names.slice(0, 3);
  return `${count} (${shown.join(', ')}${s.accounts.length > shown.length ? ', …' : ''})`;
}

/** Câu tóm tắt thiết lập: "2 tài khoản (A, B) · từ 01/01/2026 · Theo giờ · kèm ảnh". */
export function describeSyncConfig(config: SyncConfig, accounts: ReadonlyArray<ScopeAccount> = []): string {
  return [
    describeSyncAccounts(config.scope, accounts),
    describeScopeTime(config.scope),
    SYNC_MODE_LABEL[config.mode],
    config.includeMedia ? 'kèm ảnh' : 'không kèm ảnh',
  ].join(' · ');
}

/** Thông báo sau khi lưu thiết lập; `label` = tên kho. */
export function syncSavedMessage(before: SyncConfig, after: SyncConfig, rebase: boolean, label = 'R2'): string {
  if (before.mode === 'off' && after.mode !== 'off') {
    return `Đã bật đồng bộ ${SYNC_MODE_LABEL[after.mode]}. Deplao chụp bản gốc ngay${after.includeMedia ? `, ảnh và file tải dần lên ${label}` : ''}.`;
  }
  if (before.mode !== 'off' && after.mode === 'off') return `Đã tắt đồng bộ. Bản trên ${label} vẫn giữ.`;
  if (rebase) return 'Đã lưu. Deplao tạo bản gốc mới theo lựa chọn mới.';
  return 'Đã lưu thiết lập đồng bộ';
}

// ─── Nhãn của thẻ phần (CloudSettings) ─────────────────────────────────────────────────

export type SyncMeta = { text: string; variant: BadgeVariant } | null;

/**
 * "Chưa kết nối" · "Chưa đăng nhập Google" · "Đang tắt" · "Đang chụp bản gốc · 45%" · "Theo giờ · 13:03" ·
 * "Máy dự phòng · trễ 40 giây". `storage` (storage.status()) thiếu = kho R2 như trước: chưa kết nối Cloudflare là
 * "Chưa kết nối"; kho Google Drive thì không cần Cloudflare, chỉ cần đã đăng nhập Google.
 */
export function syncMeta(
  connection: CloudConnectionStatus | null,
  overview: SyncOverview | null,
  now = Date.now(),
  storage?: CloudStorageStatus | null,
): SyncMeta {
  if (storage?.provider === 'gdrive') {
    if (!storage.ready) {
      // Đang bật đồng bộ mà mất đăng nhập Google → cảnh báo; đang tắt thì chỉ là chưa thiết lập.
      const syncing = !!overview && normalizeSyncConfig(overview.config).mode !== 'off';
      return { text: 'Chưa đăng nhập Google', variant: syncing ? 'warning' : 'default' };
    }
  } else if (!connection?.connected) {
    return { text: 'Chưa kết nối', variant: 'default' };
  }
  if (!overview) return null;
  const { config, db, media } = overviewOrDefault(overview);
  if (db.following) return { text: `Máy dự phòng · trễ ${fmtLag(db.following.lagMs)}`, variant: 'primary' };
  if (config.mode === 'off') {
    // Thiết lập cũ: dữ liệu tắt nhưng ảnh vẫn tải lên (bật riêng ở màn hình cũ)
    return media.enabled ? { text: 'Chỉ đang tải ảnh, file', variant: 'warning' } : { text: 'Đang tắt', variant: 'default' };
  }
  const snapshot = db.workspaces.find(w => w.progress)?.progress;
  if (snapshot) return { text: `Đang chụp bản gốc · ${snapshot.percent}%`, variant: 'primary' };
  const last = db.workspaces.reduce<number | null>((acc, w) => (w.lastSyncAt && (!acc || w.lastSyncAt > acc) ? w.lastSyncAt : acc), null);
  const text = `${SYNC_MODE_LABEL[config.mode]} · ${last ? fmtShortWhen(last, now) : 'chưa đồng bộ'}`;
  if (db.workspaces.some(w => w.state === 'error')) return { text, variant: 'destructive' };
  const mediaOn = config.includeMedia && media.enabled;
  if (mediaOn && media.lastError && !isMediaBackingOff(media, now)) return { text, variant: 'destructive' };
  if (mediaOn && (media.paused || isMediaBackingOff(media, now))) return { text, variant: 'warning' };
  return { text, variant: 'success' };
}

/** "ảnh 614/24.625" cạnh nhãn của thẻ phần khi đang kèm ảnh; không kèm / chưa có file → null. */
export function syncMediaHint(overview: SyncOverview | null): string | null {
  if (!overview) return null;
  const { config, media } = overviewOrDefault(overview);
  if (!config.includeMedia || !media.enabled || media.totals.files <= 0) return null;
  return `ảnh ${fmtNum(media.totals.uploaded)}/${fmtNum(media.totals.files)}`;
}
