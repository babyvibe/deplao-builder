/**
 * contactRefresh.ts: automatically refreshes the name / avatar of Zalo contacts by UID.
 *
 * Zalo's avatar CDN expires after a while (the image returns 403); many contacts who are not friends yet only have a UID
 * as their name. Two entry points:
 *   1. `refreshStaleContacts(accountId, contacts)`: when the CRM finishes loading a page of contacts: pick the contacts
 *      missing a name / missing an avatar / with an avatar already reported broken / not refreshed for over 7 days, call
 *      `zalo:refreshContactsInfo` (the main process calls getUserInfo in batches of 50, writes to the DB by UID), then patch
 *      the CRM store + chat store in place. Each new page (new UIDs) is a new run; the same UID is not asked again within
 *      6 hours (the DB also stamps `info_refreshed_at` on every UID asked).
 *   2. `reportBrokenAvatar(accountId, contactId)`: from `<img onError>`: broken / 403 avatars are collected
 *      (debounced) and refreshed in a batch, regardless of the 7-day mark.
 *
 * Fire-and-forget: does not block rendering, no setState during render, errors are only logged.
 * Skipped in employee mode (there is no local Zalo session) and for accounts that are not Zalo.
 *
 * TODO(facebook/telegram): `fb:refreshContactAvatar` reloads the whole thread list through GraphQL for each
 * contact, and `telegramUser:refreshContactAvatar` downloads each person's avatar file (easily hits flood-wait):
 * there is no batch refresh path cheap enough for these two channels yet; a separate batch API is needed before enabling it.
 */
import ipc, { buildZaloAuth } from '../ipc';
import { isZalo } from '../channels/channelHelper';
import type { ContactInfoProfile } from '../../../models/chat/contact';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { useCRMStore } from '@/store/crm/crmStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';

/** Not refreshed for over 7 days → treated as stale. */
export const CONTACT_INFO_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** The same UID is not asked again within 6 hours (even if the API returns no profile or a new avatar is still broken). */
export const CONTACT_REFRESH_RETRY_MS = 6 * 60 * 60 * 1000;
/** At most 500 UIDs per run (= 10 getUserInfo batches). */
export const CONTACT_REFRESH_MAX_PER_RUN = 500;

/** Call interval: tests can set it to 0 via `configureContactRefresh`. */
const timing = {
  /** Two runs of the same account are at least this far apart (merged when pages are flipped quickly). */
  minGapMs: 1500,
  /** Broken-avatar reports are collected for this long before one run is called. */
  brokenDebounceMs: 800,
};
export function configureContactRefresh(opts: Partial<typeof timing>): void {
  Object.assign(timing, opts);
}

/** The minimal shape the filter needs: matches both CRMContact (`avatar`) and ContactItem (`avatar_url`). */
export interface RefreshableContact {
  contact_id: string;
  display_name?: string;
  avatar?: string;
  avatar_url?: string;
  contact_type?: string;
  channel?: string;
  info_refreshed_at?: number | null;
}

export interface StaleSelection {
  /** Deduplicated, sorted by priority: missing name → missing / broken avatar → oldest first */
  contacts: RefreshableContact[];
  nameMissing: number;
  avatarMissing: number;
  expired: number;
}

// ─── Session state ──────────────────────────────────────────────────────────────────────────────────────────────────
/** accountId → contactId → time it was sent (not asked again within 6 hours). */
const attemptedByAccount = new Map<string, Map<string, number>>();
/** accountId → UIDs whose avatar was reported broken (403 / broken), waiting to be refreshed. */
const brokenByAccount = new Map<string, Set<string>>();
const brokenTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runningAccounts = new Set<string>();
/** The newest list requested while a run is in progress → run again when it finishes. */
const queuedByAccount = new Map<string, RefreshableContact[]>();
const lastRunByAccount = new Map<string, number>();
const gapTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isContactNameMissing(c: RefreshableContact): boolean {
  const name = String(c.display_name || '').trim();
  return !name || name === String(c.contact_id) || /^-?\d+$/.test(name);
}

export function isContactAvatarMissing(c: RefreshableContact): boolean {
  return !String(c.avatar || c.avatar_url || '').trim();
}

export function isContactInfoExpired(c: RefreshableContact, now: number = Date.now()): boolean {
  const ts = Number(c.info_refreshed_at || 0);
  return !ts || now - ts > CONTACT_INFO_STALE_MS;
}

function isGroupContact(c: RefreshableContact): boolean {
  const t = String(c.contact_type ?? '');
  return t === 'group' || t === '1';
}

/**
 * Filters the contacts that need refreshing: missing name (empty / same as the UID / all digits), missing avatar or an avatar already reported broken
 * (`brokenIds`), or over 7 days old (no `info_refreshed_at` yet also counts as stale). Zalo users only: drops groups
 * and other channels. Deduplicates.
 */
export function selectStaleContacts(
  contacts: RefreshableContact[],
  now: number = Date.now(),
  brokenIds?: Set<string>,
): StaleSelection {
  const seen = new Set<string>();
  const nameMissing: RefreshableContact[] = [];
  const avatarMissing: RefreshableContact[] = [];
  const expired: RefreshableContact[] = [];
  for (const c of contacts || []) {
    const id = String(c?.contact_id || '').trim();
    if (!id || id === 'undefined' || seen.has(id)) continue;
    if (isGroupContact(c) || !isZalo(c.channel)) continue;
    seen.add(id);
    if (isContactNameMissing(c)) nameMissing.push(c);
    else if (isContactAvatarMissing(c) || brokenIds?.has(id)) avatarMissing.push(c);
    else if (isContactInfoExpired(c, now)) expired.push(c);
  }
  expired.sort((a, b) => Number(a.info_refreshed_at || 0) - Number(b.info_refreshed_at || 0));
  return {
    contacts: [...nameMissing, ...avatarMissing, ...expired],
    nameMissing: nameMissing.length,
    avatarMissing: avatarMissing.length,
    expired: expired.length,
  };
}

function wasAttemptedRecently(accountId: string, contactId: string, now: number): boolean {
  const ts = attemptedByAccount.get(accountId)?.get(contactId);
  return !!ts && now - ts < CONTACT_REFRESH_RETRY_MS;
}

function markAttempted(accountId: string, ids: string[], now: number): void {
  let map = attemptedByAccount.get(accountId);
  if (!map) {
    map = new Map();
    attemptedByAccount.set(accountId, map);
  }
  for (const id of ids) map.set(id, now);
}

/** A call that could not run (e.g. the account is not connected) → hand the UIDs back so the next load tries again. */
function unmarkAttempted(accountId: string, ids: string[]): void {
  const map = attemptedByAccount.get(accountId);
  for (const id of ids) map?.delete(id);
}

function canUseAccount(accountId: string): { ok: boolean; account?: any } {
  if (useEmployeeStore.getState().mode === 'employee') return { ok: false };
  const account = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
  if (!account || !isZalo(account.channel)) return { ok: false };
  return { ok: true, account };
}

/**
 * Updates the name / avatar in the CRM store + chat store in place: one setState per store, only edits rows that already exist
 * (does not add new contacts to the conversation list), returns the old state if nothing changed.
 * `checkedIds`: every UID that was asked (the DB already stamped them) → stamps `info_refreshed_at` in the CRM store too.
 */
export function applyRefreshedProfiles(accountId: string, profiles: ContactInfoProfile[], checkedIds: string[] = []): void {
  const byId = new Map((profiles || []).map(p => [String(p.contactId), p]));
  const checked = new Set(checkedIds.map(String));
  if (byId.size === 0 && checked.size === 0) return;
  const now = Date.now();

  const broken = brokenByAccount.get(accountId);
  if (broken) {
    for (const p of profiles || []) if (p.avatarUrl) broken.delete(String(p.contactId));
  }

  useCRMStore.setState(state => {
    let changed = false;
    const contacts = state.contacts.map(c => {
      const id = String(c.contact_id);
      const p = byId.get(id);
      if (!p && !checked.has(id)) return c;
      changed = true;
      return {
        ...c,
        display_name: p?.displayName || c.display_name,
        avatar: p?.avatarUrl || c.avatar,
        info_refreshed_at: now,
      };
    });
    return changed ? { contacts } : state;
  });

  if (byId.size === 0) return;
  useChatStore.setState(state => {
    const list = state.contacts[accountId];
    if (!list || list.length === 0) return state;
    let changed = false;
    const next = list.map(c => {
      const p = byId.get(String(c.contact_id));
      if (!p) return c;
      const display_name = p.displayName || c.display_name;
      const avatar_url = p.avatarUrl || c.avatar_url;
      if (display_name === c.display_name && avatar_url === c.avatar_url) return c;
      changed = true;
      return { ...c, display_name, avatar_url };
    });
    return changed ? { contacts: { ...state.contacts, [accountId]: next } } : state;
  });
}

/** Calls IPC for exactly this list of UIDs (already filtered), patches the store. Does not throw. */
async function runRefresh(accountId: string, account: any, userIds: string[], reason: string): Promise<void> {
  if (userIds.length === 0) return;
  const now = Date.now();
  runningAccounts.add(accountId);
  lastRunByAccount.set(accountId, now);
  markAttempted(accountId, userIds, now);
  console.log(`[contactRefresh] ${accountId}: làm mới ${userIds.length} liên hệ (${reason})`);
  try {
    const res = await ipc.zalo?.refreshContactsInfo({ auth: buildZaloAuth(account, accountId), userIds });
    if (!res?.success || !res.response) {
      console.warn(`[contactRefresh] ${accountId}: IPC thất bại: ${res?.error || 'không rõ'}`);
      unmarkAttempted(accountId, userIds);
      return;
    }
    const r = res.response;
    console.log(`[contactRefresh] ${accountId}: ${r.updated} dòng DB cập nhật, ${r.profiles.length} profile, ${r.checked}/${userIds.length} UID đã hỏi, ${r.failed.length} lỗi${r.error ? ` (${r.error})` : ''}`);
    applyRefreshedProfiles(accountId, r.profiles, userIds.slice(0, r.checked || userIds.length));
    if (r.error) unmarkAttempted(accountId, userIds.slice(r.checked || 0));
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi`, err?.message || err);
    unmarkAttempted(accountId, userIds);
  } finally {
    runningAccounts.delete(accountId);
    const queued = queuedByAccount.get(accountId);
    if (queued) {
      queuedByAccount.delete(accountId);
      void refreshStaleContacts(accountId, queued);
    } else if (brokenByAccount.get(accountId)?.size) {
      scheduleBrokenRefresh(accountId);
    }
  }
}

/**
 * Picks the stale contacts in `contacts` (one CRM page), calls IPC to refresh them in a batch, then updates the store.
 * Never throws. Each page is one run; UIDs asked within 6 hours are not asked again. If a run is
 * already in progress, the newest list is queued and runs right after it finishes; two runs are at least 1.5 seconds apart.
 */
export async function refreshStaleContacts(accountId: string, contacts: RefreshableContact[]): Promise<void> {
  if (!accountId || !Array.isArray(contacts) || contacts.length === 0) return;
  try {
    const { ok, account } = canUseAccount(accountId);
    if (!ok) return;

    const now = Date.now();
    const selection = selectStaleContacts(contacts, now, brokenByAccount.get(accountId));
    const pending = selection.contacts.filter(c => !wasAttemptedRecently(accountId, String(c.contact_id), now));
    if (pending.length === 0) return;

    if (runningAccounts.has(accountId)) {
      queuedByAccount.set(accountId, contacts);
      return;
    }
    const sinceLast = now - (lastRunByAccount.get(accountId) || 0);
    if (sinceLast < timing.minGapMs) {
      const prev = gapTimers.get(accountId);
      if (prev) clearTimeout(prev);
      gapTimers.set(accountId, setTimeout(() => {
        gapTimers.delete(accountId);
        void refreshStaleContacts(accountId, contacts);
      }, timing.minGapMs - sinceLast));
      return;
    }

    const userIds = pending.slice(0, CONTACT_REFRESH_MAX_PER_RUN).map(c => String(c.contact_id));
    await runRefresh(
      accountId, account, userIds,
      `thiếu tên ${selection.nameMissing}, thiếu/hỏng avatar ${selection.avatarMissing}, quá hạn ${selection.expired}, chọn ${userIds.length}/${pending.length}`,
    );
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi`, err?.message || err);
  }
}

function scheduleBrokenRefresh(accountId: string): void {
  const prev = brokenTimers.get(accountId);
  if (prev) clearTimeout(prev);
  brokenTimers.set(accountId, setTimeout(() => {
    brokenTimers.delete(accountId);
    void flushBrokenAvatars(accountId);
  }, timing.brokenDebounceMs));
}

async function flushBrokenAvatars(accountId: string): Promise<void> {
  try {
    const set = brokenByAccount.get(accountId);
    if (!set || set.size === 0) return;
    const { ok, account } = canUseAccount(accountId);
    if (!ok) { set.clear(); return; }
    if (runningAccounts.has(accountId)) return; // runRefresh calls scheduleBrokenRefresh again when it finishes
    const now = Date.now();
    const userIds = [...set].filter(id => !wasAttemptedRecently(accountId, id, now)).slice(0, CONTACT_REFRESH_MAX_PER_RUN);
    // UIDs asked within 6 hours whose avatar is still broken: drop them from the queue, do not loop forever
    for (const id of set) if (!userIds.includes(id)) set.delete(id);
    if (userIds.length === 0) return;
    await runRefresh(accountId, account, userIds, `avatar lỗi ${userIds.length}`);
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi avatar`, err?.message || err);
  }
}

/**
 * Called from `<img onError>` when a contact's avatar cannot load (CDN 403 expired, broken link): groups by
 * account, and after `brokenDebounceMs` calls one refresh run for those UIDs. Each UID at most once per 6 hours.
 */
export function reportBrokenAvatar(accountId: string, contactId: string): void {
  const id = String(contactId || '').trim();
  if (!accountId || !id) return;
  if (wasAttemptedRecently(accountId, id, Date.now())) return;
  let set = brokenByAccount.get(accountId);
  if (!set) {
    set = new Set();
    brokenByAccount.set(accountId, set);
  }
  set.add(id);
  scheduleBrokenRefresh(accountId);
}

/** Test only: clears the session state. */
export function __resetContactRefreshState(): void {
  attemptedByAccount.clear();
  brokenByAccount.clear();
  for (const t of brokenTimers.values()) clearTimeout(t);
  brokenTimers.clear();
  for (const t of gapTimers.values()) clearTimeout(t);
  gapTimers.clear();
  runningAccounts.clear();
  queuedByAccount.clear();
  lastRunByAccount.clear();
}
