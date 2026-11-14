/**
 * Per-account notification settings (Settings → Notifications → "Áp dụng cho tài khoản" (Apply to account)): sound, screen popup,
 * volume. Only saves the account settings that DIFFER from the default, per machine (localStorage, like the default settings
 * `app_notifSettings`): the owner's machine and employee machines are set separately and do not affect each other.
 *
 * - Setting an item back to its default → drops that item's override (the account follows the default for that item again).
 * - Items not changed this time keep their earlier custom choice.
 * - Changing the default later still applies to the items the account does not override.
 *
 * Previously the overrides lived only in memory: the owner's machine called a preload function that did not exist (the error was swallowed), and nothing
 * read them back when the app opened → they were lost on restart.
 */
import type { NotifSettings } from '../../store/app/appStore';

export type NotifSettingsOverride = Partial<NotifSettings>;

export const NOTIF_OVERRIDES_STORAGE_KEY = 'app_notifSettingsByAccount';

const FIELDS = ['soundEnabled', 'desktopEnabled', 'volume'] as const;

/** Read the saved value: drop items of the wrong type, clamp volume to 0–1, drop an account that has no items left. */
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

/** Settings in use for the account: defaults + its overrides. */
export function effectiveNotifSettings(defaults: NotifSettings, override?: NotifSettingsOverride | null): NotifSettings {
  return override ? { ...defaults, ...override } : defaults;
}

/** Change one account: an item equal to the default drops its override, a different value is saved as an override. */
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
