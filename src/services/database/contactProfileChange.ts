/**
 * contactProfileChange.ts: whether a contact's profile ACTUALLY changes after a write (pure logic, has tests).
 *
 * Boss calls db:updateContactProfile for almost every incoming message (sender name / avatar), and every Zalo reconnect saves
 * the aliases of the whole contact list. Emitting db:contactProfileUpdated / db:contactAliasChanged on every write = one relay event
 * to the employees for every message. Compare the record before / after (matching the CASE … ELSE semantics that keep the old value in the UPDATE statement).
 */

/** UI profile columns shown (conversation list, contact info). */
export const CONTACT_PROFILE_COLUMNS = ['display_name', 'avatar_url', 'phone', 'gender', 'birthday', 'contact_type'] as const;

type Row = Record<string, unknown> | null | undefined;

function norm(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

/** The record after differs from the one before in one profile column (not yet set → set also counts as a change). No record after → false. */
export function contactProfileChanged(before: Row, after: Row): boolean {
  if (!after) return false;
  if (!before) return true;
  return CONTACT_PROFILE_COLUMNS.some((column) => norm(before[column]) !== norm(after[column]));
}

/** The new alias differs from the stored alias. A contact not yet in the DB → false (the UPDATE statement writes nothing). */
export function contactAliasChanged(before: Row, alias: unknown): boolean {
  if (!before) return false;
  return String(before.alias ?? '') !== String(alias ?? '');
}
