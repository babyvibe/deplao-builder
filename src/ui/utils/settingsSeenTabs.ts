/**
 * Tracks which settings tabs the user has already visited.
 * Tabs in WATCHLIST show a red "new" dot until the user opens them.
 * State is persisted in localStorage (per-device, not per-account).
 */

declare const __APP_VERSION__: string;

const LS_KEY = 'settings_seen_tabs';
const LS_CHANGELOG_KEY = 'changelog_last_seen_version';
const LS_AFFILIATE_KEY = 'affiliate_intro_seen';

/** Tabs that show a red dot until first visit */
export const SETTINGS_WATCHLIST = ['storage', 'introduction'] as const;

export function loadSeenTabs(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Mark a tab as seen and fire a window event so other components can react */
export function markTabSeen(tab: string): void {
  try {
    const seen = loadSeenTabs();
    if (seen.has(tab)) return; // already seen - no-op
    seen.add(tab);
    localStorage.setItem(LS_KEY, JSON.stringify([...seen]));
    window.dispatchEvent(new CustomEvent('settings:tabSeen'));
  } catch {}
}

/** Returns true if any watched tab has NOT been seen yet */
export function hasUnseenSettingsTabs(): boolean {
  const seen = loadSeenTabs();
  return SETTINGS_WATCHLIST.some(t => !seen.has(t)) || hasUnseenChangelog();
}

// ── Changelog version tracking ───────────────────────────────────────────────
// Khi app cập nhật lên phiên bản mới, changelog_last_seen_version sẽ khác với
// phiên bản hiện tại → hiện chấm đỏ trên nút Settings và tab Log phiên bản.

const CURRENT_APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

/** Returns true if the user hasn't read the changelog for the current version */
export function hasUnseenChangelog(): boolean {
  try {
    return localStorage.getItem(LS_CHANGELOG_KEY) !== CURRENT_APP_VERSION;
  } catch {
    return false;
  }
}

/** Mark the current version's changelog as read and fire a window event */
export function markChangelogSeen(): void {
  try {
    if (localStorage.getItem(LS_CHANGELOG_KEY) === CURRENT_APP_VERSION) return;
    localStorage.setItem(LS_CHANGELOG_KEY, CURRENT_APP_VERSION);
    window.dispatchEvent(new CustomEvent('settings:tabSeen'));
  } catch {}
}

// ── Affiliate intro tracking ────────────────────────────────────────────────
// Hiện chấm đỏ trên nút "Kiếm tiền" cho đến khi khách click vào.

/** Returns true if the user hasn't seen the affiliate intro yet */
export function hasUnseenAffiliate(): boolean {
  try {
    return localStorage.getItem(LS_AFFILIATE_KEY) !== 'true';
  } catch {
    return true;
  }
}

/** Mark affiliate intro as seen and fire a window event */
export function markAffiliateSeen(): void {
  try {
    if (localStorage.getItem(LS_AFFILIATE_KEY) === 'true') return;
    localStorage.setItem(LS_AFFILIATE_KEY, 'true');
    window.dispatchEvent(new CustomEvent('settings:tabSeen'));
  } catch {}
}

