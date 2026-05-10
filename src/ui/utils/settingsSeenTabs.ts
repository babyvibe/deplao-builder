/**
 * Tracks which settings tabs the user has already visited.
 * Tabs in WATCHLIST show a red "new" dot until the user opens them.
 * State is persisted in localStorage (per-device, not per-account).
 */

const LS_KEY = 'settings_seen_tabs';

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
    if (seen.has(tab)) return; // already seen — no-op
    seen.add(tab);
    localStorage.setItem(LS_KEY, JSON.stringify([...seen]));
    window.dispatchEvent(new CustomEvent('settings:tabSeen'));
  } catch {}
}

/** Returns true if any watched tab has NOT been seen yet */
export function hasUnseenSettingsTabs(): boolean {
  const seen = loadSeenTabs();
  return SETTINGS_WATCHLIST.some(t => !seen.has(t));
}

