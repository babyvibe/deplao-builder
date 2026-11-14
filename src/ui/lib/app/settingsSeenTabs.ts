/**
 * Tracks which settings tabs the user has already visited.
 * Tabs in WATCHLIST show a red "new" dot until the user opens them.
 * State is persisted in localStorage (per-device, not per-account).
 * Features outside Settings use the same idea via isFeatureSeen / markFeatureSeen / useFeatureSeen.
 */

import { useEffect, useState } from 'react';

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
// When the app updates to a new version, changelog_last_seen_version will differ from
// the current version → show the red dot on the Settings button and the Version log tab.

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
// Show a red dot on the "Kiếm tiền" (Earn money) button until the user clicks it.

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

// ── New features outside Settings ─────────────────────────────────────────────
// Red dot on the button of a new feature until the user opens it for the first time.
// To add a feature: add a key to FeatureKey, show the dot while !useFeatureSeen(key),
// call markFeatureSeen(key) where the feature is opened.

const LS_FEATURES_KEY = 'features_seen';

/** Window event fired after a feature is marked seen (detail: { key }). */
export const FEATURE_SEEN_EVENT = 'feature:seen';

/**
 * mobileSync: the sync-from-phone button · plugins: the Apps, API & Webhook page · api: the API section of that page ·
 * webhooks: the Webhook section (moved from Settings → Webhooks; red dot so users find the new place).
 */
export type FeatureKey = 'mobileSync' | 'plugins' | 'api' | 'webhooks';

function loadSeenFeatures(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_FEATURES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** True once the user has opened the feature. */
export function isFeatureSeen(key: FeatureKey): boolean {
  return loadSeenFeatures().has(key);
}

/** Mark a feature as opened and fire FEATURE_SEEN_EVENT (no-op when already seen). */
export function markFeatureSeen(key: FeatureKey): void {
  try {
    const seen = loadSeenFeatures();
    if (seen.has(key)) return;
    seen.add(key);
    localStorage.setItem(LS_FEATURES_KEY, JSON.stringify([...seen]));
    window.dispatchEvent(new CustomEvent(FEATURE_SEEN_EVENT, { detail: { key } }));
  } catch {}
}

/** Live "seen" flag for a feature: re-renders when any feature is marked seen. */
export function useFeatureSeen(key: FeatureKey): boolean {
  const [seen, setSeen] = useState(() => isFeatureSeen(key));
  useEffect(() => {
    const sync = () => setSeen(isFeatureSeen(key));
    window.addEventListener(FEATURE_SEEN_EVENT, sync);
    sync(); // a mark between the first render and this subscription would be missed otherwise
    return () => window.removeEventListener(FEATURE_SEEN_EVENT, sync);
  }, [key]);
  return seen;
}

