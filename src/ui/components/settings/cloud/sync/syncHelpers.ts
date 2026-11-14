/**
 * syncHelpers - the pure part (no React) of Settings → Internet & Cloud → Data sync: mode labels, default values
 * used when main has not returned a status yet, comparing the draft with the saved settings, the summary sentence
 * "2 tài khoản (A, B) · từ 01/01/2026 · Theo giờ · kèm ảnh" (2 accounts (A, B) · from 01/01/2026 · Hourly · with images) and the label of the section card ("Theo giờ · 13:03", "ảnh 614/24.625").
 * Sentences that mention the storage take an extra `label` (storage name: "R2" by default, "Google Drive" - storageLabel()).
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
import { tr } from '../../../../../shared/i18n';

export const SYNC_MODES: DbSyncMode[] = ['off', 'hourly', 'realtime'];

export const SYNC_MODE_LABEL: Record<DbSyncMode, string> = { off: tr('Tắt'), hourly: tr('Theo giờ'), realtime: 'Realtime' };

/** Explanation line under the mode choice buttons; `label` = storage name ("R2", "Google Drive"). */
export function syncModeNote(mode: DbSyncMode, label = 'R2'): string {
  switch (mode) {
    case 'hourly': return tr('Đẩy thay đổi mỗi giờ · không có thay đổi thì không gọi {{label}}', { label });
    case 'realtime': return tr('Trễ tối đa 5 giây · không có thay đổi thì không gọi {{label}}', { label });
    default: return tr('Không đồng bộ. Bản đã có trên {{label}} vẫn giữ và khôi phục được.', { label });
  }
}

/** Same as syncModeNote with the R2 storage (kept for the existing callers). */
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

/** Settings from main / the draft → standard shape (a missing "kèm ảnh" (with images) / "file chung" (shared files) = on). */
export function normalizeSyncConfig(value: Partial<SyncConfig> | null | undefined): SyncConfig {
  const v = value || {};
  return {
    mode: SYNC_MODES.includes(v.mode as DbSyncMode) ? (v.mode as DbSyncMode) : 'off',
    scope: normalizeScope(v.scope),
    includeMedia: v.includeMedia !== false,
    includeShared: v.includeShared !== false,
  };
}

/** The overview always has all fields to draw (main has not returned it / old build missing fields → defaults). */
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

/** "Tất cả tài khoản" (All accounts) · "1 tài khoản (Shop Hoa Lan)" (1 account) · "2 tài khoản (Shop Hoa Lan, Kho tổng)" (2 accounts) · "5 tài khoản (A, B, C, …)" (5 accounts). */
export function describeSyncAccounts(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  const s = normalizeScope(scope);
  if (s.accounts === 'all') return tr('Tất cả tài khoản');
  if (s.accounts.length === 0) return tr('Chưa chọn tài khoản');
  const byId = new Map(accounts.map(a => [a.zalo_id, a] as [string, ScopeAccount]));
  const names = s.accounts
    .map(id => byId.get(id))
    .filter((a): a is ScopeAccount => !!a)
    .map(scopeAccountName);
  const count = tr('{{v1}} tài khoản', { v1: fmtNum(s.accounts.length) });
  if (!names.length) return count;
  const shown = names.slice(0, 3);
  return `${count} (${shown.join(', ')}${s.accounts.length > shown.length ? ', …' : ''})`;
}

/** Settings summary sentence: "2 tài khoản (A, B) · từ 01/01/2026 · Theo giờ · kèm ảnh" (2 accounts (A, B) · from 01/01/2026 · Hourly · with images). */
export function describeSyncConfig(config: SyncConfig, accounts: ReadonlyArray<ScopeAccount> = []): string {
  return [
    describeSyncAccounts(config.scope, accounts),
    describeScopeTime(config.scope),
    SYNC_MODE_LABEL[config.mode],
    config.includeMedia ? tr('kèm ảnh') : tr('không kèm ảnh'),
  ].join(' · ');
}

/** Message after the settings are saved; `label` = storage name. */
export function syncSavedMessage(before: SyncConfig, after: SyncConfig, rebase: boolean, label = 'R2'): string {
  if (before.mode === 'off' && after.mode !== 'off') {
    return tr('Đã bật đồng bộ {{v1}}. Deplao chụp bản gốc ngay{{v2}}.', { v1: SYNC_MODE_LABEL[after.mode], v2: after.includeMedia ? tr(', ảnh và file tải dần lên {{label}}', { label }) : '' });
  }
  if (before.mode !== 'off' && after.mode === 'off') return tr('Đã tắt đồng bộ. Bản trên {{label}} vẫn giữ.', { label });
  if (rebase) return tr('Đã lưu. Deplao tạo bản gốc mới theo lựa chọn mới.');
  return tr('Đã lưu thiết lập đồng bộ');
}

// ─── Labels of the section cards (CloudSettings) ─────────────────────────────────────────────────

export type SyncMeta = { text: string; variant: BadgeVariant } | null;

/**
 * "Chưa kết nối" (Not connected) · "Chưa đăng nhập Google" (Not signed in to Google) · "Đang tắt" (Off) · "Đang chụp bản gốc · 45%" (Taking base snapshot · 45%) · "Theo giờ · 13:03" (Hourly · 13:03) ·
 * "Máy dự phòng · trễ 40 giây" (Standby machine · lag 40 seconds). `storage` (storage.status()) missing = R2 storage as before: not connected to Cloudflare means
 * "Chưa kết nối" (Not connected); Google Drive storage does not need Cloudflare, it only needs a Google sign-in.
 */
export function syncMeta(
  connection: CloudConnectionStatus | null,
  overview: SyncOverview | null,
  now = Date.now(),
  storage?: CloudStorageStatus | null,
): SyncMeta {
  if (storage?.provider === 'gdrive') {
    if (!storage.ready) {
      // Sync is on but the Google sign-in was lost → warning; when sync is off it only means not set up yet.
      const syncing = !!overview && normalizeSyncConfig(overview.config).mode !== 'off';
      return { text: tr('Chưa đăng nhập Google'), variant: syncing ? 'warning' : 'default' };
    }
  } else if (!connection?.connected) {
    return { text: tr('Chưa kết nối'), variant: 'default' };
  }
  if (!overview) return null;
  const { config, db, media } = overviewOrDefault(overview);
  if (db.following) return { text: tr('Máy dự phòng · trễ {{v1}}', { v1: fmtLag(db.following.lagMs) }), variant: 'primary' };
  if (config.mode === 'off') {
    // Old settings: data off but images still uploaded (turned on separately in the old screen)
    return media.enabled ? { text: tr('Chỉ đang tải ảnh, file'), variant: 'warning' } : { text: tr('Đang tắt'), variant: 'default' };
  }
  const snapshot = db.workspaces.find(w => w.progress)?.progress;
  if (snapshot) return { text: tr('Đang chụp bản gốc · {{percent}}%', { percent: snapshot.percent }), variant: 'primary' };
  const last = db.workspaces.reduce<number | null>((acc, w) => (w.lastSyncAt && (!acc || w.lastSyncAt > acc) ? w.lastSyncAt : acc), null);
  const text = `${SYNC_MODE_LABEL[config.mode]} · ${last ? fmtShortWhen(last, now) : tr('chưa đồng bộ')}`;
  if (db.workspaces.some(w => w.state === 'error')) return { text, variant: 'destructive' };
  const mediaOn = config.includeMedia && media.enabled;
  if (mediaOn && media.lastError && !isMediaBackingOff(media, now)) return { text, variant: 'destructive' };
  if (mediaOn && (media.paused || isMediaBackingOff(media, now))) return { text, variant: 'warning' };
  return { text, variant: 'success' };
}

/** "ảnh 614/24.625" (images 614/24.625) next to the section card label while images are included; not included / no file yet → null. */
export function syncMediaHint(overview: SyncOverview | null): string | null {
  if (!overview) return null;
  const { config, media } = overviewOrDefault(overview);
  if (!config.includeMedia || !media.enabled || media.totals.files <= 0) return null;
  return tr('ảnh {{v1}}/{{v2}}', { v1: fmtNum(media.totals.uploaded), v2: fmtNum(media.totals.files) });
}
