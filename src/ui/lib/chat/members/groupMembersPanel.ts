/**
 * The "Thành viên" (Members) panel of the chat window: the pure part (tests in src/__tests__/chat/groupMembersPanel.test.ts).
 *
 * The list comes from the DB (page_group_member, the same source as the CRM "Nhóm" (Groups) tab: hidden-member scans, members collected from Telegram message history,
 * API sync), paged + searched in the DB. The Zalo / Telegram APIs are only called when the panel is opened for the FIRST time for that group
 * (marked in localStorage) or when the user taps refresh. The API usually returns fewer members than the DB (Zalo locks member viewing, Telegram only
 * returns about 200 recent members).
 */
import type { GroupMember } from '@/store/app/appStore';

export const GROUP_MEMBERS_PAGE_SIZE = 50;

const API_SYNC_PREFIX = 'deplao:groupMembersApiSync:';

function apiSyncKey(accountId: string, groupId: string): string {
  return `${API_SYNC_PREFIX}${accountId}:${groupId}`;
}

/** Time of the group's most recent member sync through the API (0 = never). */
export function groupMembersApiSyncedAt(accountId: string, groupId: string): number {
  try {
    return Number(localStorage.getItem(apiSyncKey(accountId, groupId))) || 0;
  } catch {
    return 0;
  }
}

export function markGroupMembersApiSynced(accountId: string, groupId: string, at = Date.now()): void {
  try {
    localStorage.setItem(apiSyncKey(accountId, groupId), String(at));
  } catch {
    // localStorage full / blocked: the API is called again the next time the panel opens, which is fine
  }
}

/** The "first sync" spinner stops after this even if the API never answers (the list from the DB stays usable). */
export const MEMBERS_SYNC_SPINNER_MAX_MS = 45_000;

const membersApiSyncs = new Map<string, Promise<unknown>>();

/**
 * The first API sync of a group's members (key "account:group"). A caller that arrives while one runs (a second panel,
 * React's double effect in development) waits for the same run: no second request, and never skipped, since a skipped
 * caller had nothing to turn its spinner off. Always resolves; the entry is dropped once the run ends.
 */
export function joinGroupMembersApiSync(key: string, start: () => Promise<unknown>): Promise<unknown> {
  const running = membersApiSyncs.get(key);
  if (running) return running;
  const sync = new Promise<unknown>((resolve) => resolve(start()))
    .catch(() => false)
    .finally(() => { membersApiSyncs.delete(key); });
  membersApiSyncs.set(key, sync);
  return sync;
}

/** page_group_member row → member. */
export function memberFromRow(row: any): GroupMember {
  return {
    userId: String(row?.member_id ?? '').trim(),
    displayName: row?.display_name || '',
    avatar: row?.avatar || '',
    role: Number(row?.role || 0),
    ...(row?.username ? { username: String(row.username) } : {}),
  };
}

/**
 * Merges the new list (from the API) into the current list: nobody who is already there is removed (the API returns incomplete lists). A person in both lists takes the new
 * role / status, and the new name / photo if there is one (otherwise the old one is kept).
 */
export function mergeGroupMembers(existing: GroupMember[] | undefined, fresh: GroupMember[]): GroupMember[] {
  const byId = new Map<string, GroupMember>();
  for (const member of existing || []) {
    if (member?.userId) byId.set(String(member.userId), member);
  }
  for (const member of fresh) {
    const userId = String(member?.userId || '');
    if (!userId) continue;
    const previous = byId.get(userId);
    byId.set(userId, {
      ...previous,
      ...member,
      userId,
      displayName: member.displayName || previous?.displayName || '',
      avatar: member.avatar || previous?.avatar || '',
    });
  }
  return Array.from(byId.values());
}

/**
 * A DB row + live info from the group cache (Telegram online status / last seen, and the name / photo just fetched
 * that the DB does not have yet).
 */
export function withLiveMemberInfo(rows: GroupMember[], cached: GroupMember[] | undefined): GroupMember[] {
  if (!cached?.length) return rows;
  const byId = new Map(cached.map((member) => [String(member.userId), member]));
  return rows.map((row) => {
    const live = byId.get(row.userId);
    if (!live) return row;
    const unnamed = !row.displayName || row.displayName === row.userId;
    return {
      ...row,
      displayName: unnamed && live.displayName ? live.displayName : row.displayName,
      avatar: row.avatar || live.avatar || '',
      status: live.status ?? row.status,
      statusText: live.statusText ?? row.statusText,
      lastSeenAt: live.lastSeenAt ?? row.lastSeenAt,
      onlineUntil: live.onlineUntil ?? row.onlineUntil,
    };
  });
}

/** Appends the next page to the list on screen, skipping people already there (the DB changed between two reads and shifted the OFFSET). */
export function appendMemberPage(current: GroupMember[], page: GroupMember[]): GroupMember[] {
  const seen = new Set(current.map((member) => member.userId));
  return [...current, ...page.filter((member) => member.userId && !seen.has(member.userId))];
}
