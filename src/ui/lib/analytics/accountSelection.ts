/**
 * Account filter of the Reports page (AnalyticsPage): several accounts, remembered in localStorage.
 * Pure — covered by src/__tests__/analyticsMerge.test.ts.
 */

export const ANALYTICS_ACCOUNTS_STORAGE_KEY = 'deplao:analytics-accounts:v1';

/** 'all' = every account, including ones added later; null = never chosen (→ the active account). */
export type StoredAccountSelection = 'all' | string[] | null;

export function parseStoredAccountSelection(raw: string | null | undefined): StoredAccountSelection {
  if (!raw) return null;
  if (raw === 'all') return 'all';
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const ids = Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** 'all' when every account is selected, else the JSON list. */
export function serializeAccountSelection(selected: ReadonlyArray<string>, accountIds: ReadonlyArray<string>): string {
  return isAllAccounts(selected, accountIds) ? 'all' : JSON.stringify(Array.from(new Set(selected)));
}

export function isAllAccounts(selected: ReadonlyArray<string>, accountIds: ReadonlyArray<string>): boolean {
  if (accountIds.length === 0) return false;
  const chosen = new Set(selected);
  return accountIds.every(id => chosen.has(id));
}

/**
 * Accounts to report on, in account-list order. Stored ids that no longer exist are dropped; when
 * nothing usable is left (or nothing was stored) the active account is used — the page's behaviour
 * before multi-select — or the first account.
 */
export function resolveSelectedAccounts(
  stored: StoredAccountSelection,
  accountIds: ReadonlyArray<string>,
  activeAccountId: string | null | undefined,
): string[] {
  if (accountIds.length === 0) return [];
  if (stored === 'all') return [...accountIds];
  if (Array.isArray(stored)) {
    const chosen = new Set(stored);
    const kept = accountIds.filter(id => chosen.has(id));
    if (kept.length > 0) return kept;
  }
  return [activeAccountId && accountIds.includes(activeAccountId) ? activeAccountId : accountIds[0]];
}
