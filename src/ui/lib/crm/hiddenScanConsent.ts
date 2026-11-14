/**
 * Consent to "Quét thành viên nhóm ẩn qua máy chủ Deplao" (Hidden group member scan via the Deplao server) (Zalo). Saved per machine (localStorage), OFF by default from 26.11.0.
 *
 * Why consent is needed: the hidden group member scan runs on the deplaoapp.com server (kept private, not in the app's open source code),
 * so the app must send the ZALO LOGIN SESSION (cookie + IMEI) of the account being scanned to the server
 * (`scanGroupViaBackend`, lib/crm/backendService.ts). Anyone with that cookie can use the Zalo account, so it is only sent when the user
 * has clearly agreed:
 *   - Not agreed yet: every scan place asks with a dialog (components/crm/groups/HiddenScanConsentDialog.tsx) BEFORE sending;
 *     "Không đồng ý" (Do not agree) = nothing is sent, the other features still work (refreshing groups through the Zalo API on the machine is still allowed).
 *     Scan places: CRM → "Nhóm" → "Quét thành viên" (the "Quét" (Scan) button), CRM → "Nhóm" → "Thành viên nhóm" ("Tải thông tin thành viên" (Load member info)),
 *     the group member panel in the conversation (the "Quét đủ thành viên" (Scan all members) button; the reload button only scans when agreed),
 *     bulk group import into the shared group library (counts members).
 *   - Agreeing (in the dialog or the CRM → "Nhóm" → "Quét thành viên" switch) is remembered on this machine; it can be turned off at any time,
 *     turning it off stops sending at once.
 *   - `scanGroupViaBackend` checks `hasHiddenScanConsent()` again itself: not agreed → it returns an error and makes no network call. A new call site
 *     that forgets to ask also does not expose the cookie.
 * The server only uses the cookie during that scan and does not store it; the server log only has the account ID, group ID, IP, user agent,
 * time, and result code (dep-lao-backend-payment: scan.controller.ts, middleware/publicApiLogger.ts).
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'deplao.crm.hiddenScanConsent';

export interface HiddenScanConsent {
  granted: boolean;
  /** Time of agreeing (ms); null when not agreed / turned off. */
  at: number | null;
}

const OFF: HiddenScanConsent = { granted: false, at: null };
let cached: HiddenScanConsent | null = null;
const listeners = new Set<() => void>();

function readStored(): HiddenScanConsent {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return OFF;
    const parsed = JSON.parse(raw) as Partial<HiddenScanConsent> | null;
    return parsed?.granted === true ? { granted: true, at: Number(parsed.at) || null } : OFF;
  } catch {
    return OFF;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getHiddenScanConsent(): HiddenScanConsent {
  if (!cached) cached = readStored();
  return cached;
}

/** Agreed to send the Zalo login session to the Deplao server to scan hidden groups (on this machine). */
export function hasHiddenScanConsent(): boolean {
  return getHiddenScanConsent().granted;
}

/** On (the user just agreed) / off (agreement withdrawn, sending stops at once). */
export function setHiddenScanConsent(granted: boolean, now: number = Date.now()): void {
  cached = granted ? { granted: true, at: now } : OFF;
  try {
    if (granted) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cached));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* localStorage broken: still applies in this session */ }
  notify();
}

export function subscribeHiddenScanConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Another window of the app changed the choice → read it again
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = readStored();
    notify();
  });
}

export function useHiddenScanConsent(): HiddenScanConsent {
  return useSyncExternalStore(subscribeHiddenScanConsent, getHiddenScanConsent, () => OFF);
}

/** Test only: forget the value already read. */
export function resetHiddenScanConsentCache(): void {
  cached = null;
}
