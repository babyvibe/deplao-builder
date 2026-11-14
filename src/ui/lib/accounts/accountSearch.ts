/**
 * Quick search of chat accounts by name (accent-insensitive), @username, UID and phone number (0912…, 84912…, +84 912… count as one).
 * Used in Settings → Accounts and the Dashboard.
 */
export interface SearchableAccount {
  zalo_id: string;
  full_name?: string;
  display_name?: string;
  username?: string;
  phone?: string;
  facebook_id?: string;
}

const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

/** The different ways to write the same Vietnamese number: 0912… ↔ 84912… */
function phoneVariants(digits: string): string[] {
  const variants = new Set([digits]);
  if (digits.startsWith('84') && digits.length > 2) variants.add(`0${digits.slice(2)}`);
  if (digits.startsWith('0') && digits.length > 1) variants.add(`84${digits.slice(1)}`);
  return [...variants];
}

export function matchAccountSearch(account: SearchableAccount, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const folded = fold(q).replace(/^@/, '');
  const names = [account.full_name, account.display_name, account.username];
  if (folded && names.some((name) => name && fold(name).includes(folded))) return true;
  if (account.zalo_id.includes(q) || (!!account.facebook_id && account.facebook_id.includes(q))) return true;
  // Phone number: at least 3 digits are needed so that "0" does not match every account
  const queryDigits = q.replace(/\D/g, '');
  const phoneDigits = (account.phone || '').replace(/\D/g, '');
  if (queryDigits.length < 3 || !phoneDigits) return false;
  const phones = phoneVariants(phoneDigits);
  return phoneVariants(queryDigits).some((variant) => phones.some((phone) => phone.includes(variant)));
}
