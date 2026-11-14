/**
 * CRM: handles a failed read on the secondary CRM screens (Dashboard, choosing campaign recipients, adding contacts, search, groups).
 *
 * Employee mode: DataAccessor returns `success: false` when a read fails (connection to BOSS lost...): see `isReadFailure`.
 * Rules:
 *  - an error does NOT replace the data on screen with an empty set (the last good copy is kept), unless that copy belongs to another account / group;
 *  - an error must not lead to an empty / incomplete recipient set, or to a write based on incomplete read data.
 * Pure functions: the caller computes the `failed` flag with `isReadFailure(res)` itself, so the tests need no React / store / REST.
 */

/** What to do with the data on screen after a read. */
import { tr } from '../../../shared/i18n';

export type ReadOutcome = 'replace' | 'keep' | 'clear';

/**
 * After a read of the data of `owner` (an account, or `tàiKhoản:nhóm`) when the data on screen belongs to `shownOwner`:
 *  - read succeeded → `replace`;
 *  - error, and the data on screen is of the same `owner` → `keep` (keeps the last good copy and shows an error with a retry option);
 *  - error, and the data on screen belongs to another owner (the account / group was just changed) or nothing has been loaded yet → `clear`: never
 *    shows or acts on another account's data.
 */
export function readOutcome(failed: boolean, shownOwner: string | null, owner: string): ReadOutcome {
  if (!failed) return 'replace';
  return shownOwner != null && shownOwner === owner ? 'keep' : 'clear';
}

// ── Groups & group members (GroupMembersTab) ─────────────────────────────────

/** Number of member rows per group (every row of the group member table, as before). */
export function countMembersByGroup(rows: Array<{ group_id?: string | null }> | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const groupId = row?.group_id;
    if (groupId) counts[groupId] = (counts[groupId] || 0) + 1;
  }
  return counts;
}

export interface GroupListRow {
  contact_id: string;
  display_name: string;
  avatar_url: string;
  last_message_time: number;
  memberCount: number;
}

/**
 * Group list (contact_type = 'group') from the conversation list. `counts` = null when reading the member counts failed → keeps the known count
 * of the same group in `previous` (same account) instead of 0 (a fake "Chưa có thành viên" (No members yet)).
 */
export function buildGroupRows(
  contacts: any[] | null | undefined,
  counts: Record<string, number> | null,
  previous: GroupListRow[] = [],
): GroupListRow[] {
  const known = new Map(previous.map(g => [g.contact_id, g.memberCount]));
  return (contacts || [])
    .filter((c: any) => c?.contact_type === 'group')
    .map((c: any) => ({
      contact_id: c.contact_id,
      display_name: c.display_name || c.contact_id,
      avatar_url: c.avatar_url || '',
      last_message_time: c.last_message_time || 0,
      memberCount: counts ? (counts[c.contact_id] ?? 0) : (known.get(c.contact_id) ?? 0),
    }));
}

/** Phone numbers by contact_id from the conversation list. */
export function phonesByContact(contacts: any[] | null | undefined): Record<string, string> {
  const phones: Record<string, string> = {};
  for (const c of contacts || []) {
    if (c?.contact_id && c.phone) phones[c.contact_id] = c.phone;
  }
  return phones;
}

/**
 * Merges phone numbers into the member list. `phones` = null when reading the address book failed → keeps the phone numbers currently shown for the same member
 * (`previous`, same group) instead of clearing them.
 */
export function withMemberPhones<T extends { member_id: string }>(
  rows: T[],
  phones: Record<string, string> | null,
  previous: Array<{ member_id: string; phone?: string }> = [],
): Array<T & { phone: string }> {
  if (phones) return rows.map(m => ({ ...m, phone: phones[m.member_id] || '' }));
  const known = new Map(previous.map(m => [m.member_id, m.phone || '']));
  return rows.map(m => ({ ...m, phone: known.get(m.member_id) || '' }));
}

// ── Choosing campaign recipients (TargetSelector) ──────────────────────────────

export type TargetSelectMode = 'manual' | 'by_label' | 'friends_only' | 'groups_only' | 'by_phone' | 'by_uid' | 'by_group';

export interface TargetLoadFlags {
  /** The most recent load of the CRM contact list failed (the list on screen is empty or stale). */
  contactsFailed: boolean;
  /** Loading the "Nhãn Local" (Local label) assignment table in use (self-loaded copy) failed. */
  localLabelMapFailed: boolean;
  /** Filtering by at least one "Nhãn Local" (Local label). */
  filteringByLocalLabel: boolean;
}

/**
 * Reason to lock the recipient confirm button (null = allowed). A failed load can leave the recipient set empty / incomplete without the
 * user noticing → locked until it can be loaded again.
 *  - By UID: the recipient is taken as typed in the input, not dependent on the contact list → not locked.
 *  - By phone number: matches phone number ↔ UID and prevents duplicates using the contact list → locked when the list failed.
 *  - By group member: the group list comes from the contact list → locked when the list failed.
 */
export function targetConfirmBlockReason(mode: TargetSelectMode, flags: TargetLoadFlags): string | null {
  if (mode === 'by_uid') return null;
  if (flags.contactsFailed) return tr('Không tải được danh sách liên hệ');
  if (mode === 'by_label' && flags.filteringByLocalLabel && flags.localLabelMapFailed) return tr('Không tải được Nhãn Local');
  return null;
}

export interface GroupMembersRead {
  groupId: string;
  /** Read failed (`isReadFailure` or a thrown error). */
  failed: boolean;
  members?: any[] | null;
}

export interface GroupTargets {
  members: any[];
  /** A group whose read failed: if it is not empty, its `members` (an incomplete set) must NOT be added to the campaign. */
  failedGroupIds: string[];
}

/**
 * Recipients from the members of the selected groups: numeric UIDs not yet in the campaign (as before), plus the groups whose read failed.
 * Before, a group whose read failed was silently skipped → the campaign got an incomplete / empty recipient set.
 */
export function collectGroupTargets(reads: GroupMembersRead[], existingIds: Set<string>): GroupTargets {
  const members: any[] = [];
  const failedGroupIds: string[] = [];
  for (const read of reads) {
    if (read.failed) {
      failedGroupIds.push(read.groupId);
      continue;
    }
    for (const m of read.members || []) {
      const id = String(m?.member_id || m?.memberId || '').trim();
      if (!id || !/^\d+$/.test(id)) continue;
      const uid = m.member_id || m.memberId || '';
      if (uid && !existingIds.has(uid)) {
        members.push({
          contact_id: uid,
          display_name: m.display_name || m.displayName || uid,
          avatar: m.avatar || '',
          source: 'group',
          groupId: read.groupId,
        });
      }
    }
  }
  return { members, failedGroupIds };
}
