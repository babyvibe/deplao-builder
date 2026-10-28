/**
 * Cài đặt thông báo riêng của từng tài khoản (Cài đặt → Thông báo → "Áp dụng cho tài khoản"): âm thanh, popup màn hình,
 * âm lượng. Chỉ lưu phần tài khoản chỉnh KHÁC mặc định, trên từng máy (localStorage, như cài đặt mặc định
 * `app_notifSettings`): máy Boss và máy nhân viên chỉnh riêng, không ảnh hưởng nhau.
 *
 * - Chỉnh một mục về đúng mặc định → bỏ phần riêng của mục đó (tài khoản lại theo mặc định cho mục đó).
 * - Mục không chỉnh lần này giữ nguyên lựa chọn riêng trước đó.
 * - Đổi mặc định sau này vẫn áp cho các mục tài khoản không chỉnh riêng.
 *
 * Trước đây phần riêng chỉ nằm trong bộ nhớ: máy Boss gọi một hàm preload không tồn tại (lỗi bị nuốt) và không nơi nào
 * đọc lại khi mở app → khởi động lại là mất.
 */
import type { NotifSettings } from '../store/appStore';

export type NotifSettingsOverride = Partial<NotifSettings>;

export const NOTIF_OVERRIDES_STORAGE_KEY = 'app_notifSettingsByAccount';

const FIELDS = ['soundEnabled', 'desktopEnabled', 'volume'] as const;

/** Đọc giá trị đã lưu: bỏ mục sai kiểu, âm lượng ép về 0–1, tài khoản không còn mục nào thì bỏ. */
export function normalizeNotifOverrides(raw: unknown): Record<string, NotifSettingsOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const overrides: Record<string, NotifSettingsOverride> = {};
  for (const [accountId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!accountId || !value || typeof value !== 'object') continue;
    const stored = value as Record<string, unknown>;
    const entry: NotifSettingsOverride = {};
    if (typeof stored.soundEnabled === 'boolean') entry.soundEnabled = stored.soundEnabled;
    if (typeof stored.desktopEnabled === 'boolean') entry.desktopEnabled = stored.desktopEnabled;
    if (typeof stored.volume === 'number' && Number.isFinite(stored.volume)) entry.volume = Math.min(1, Math.max(0, stored.volume));
    if (Object.keys(entry).length) overrides[accountId] = entry;
  }
  return overrides;
}

/** Cài đặt tài khoản đang dùng: mặc định + phần riêng. */
export function effectiveNotifSettings(defaults: NotifSettings, override?: NotifSettingsOverride | null): NotifSettings {
  return override ? { ...defaults, ...override } : defaults;
}

/** Chỉnh một tài khoản: mục bằng mặc định thì bỏ phần riêng của mục đó, khác thì lưu riêng. */
export function withAccountNotifSettings(
  defaults: NotifSettings,
  overrides: Readonly<Record<string, NotifSettingsOverride>>,
  accountId: string,
  patch: Partial<NotifSettings>,
): Record<string, NotifSettingsOverride> {
  const entry: NotifSettingsOverride = { ...(overrides[accountId] || {}) };
  for (const field of FIELDS) {
    if (!(field in patch) || patch[field] === undefined) continue;
    if (patch[field] === defaults[field]) delete entry[field];
    else (entry as Record<string, unknown>)[field] = patch[field];
  }
  const next = { ...overrides };
  if (Object.keys(entry).length) next[accountId] = entry;
  else delete next[accountId];
  return next;
}
