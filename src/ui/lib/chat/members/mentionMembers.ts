/**
 * The @mention box in a group: the pure part (hook: hooks/chat/useMentionMembers.ts; test: src/__tests__/chat/composer/mentionMembers.test.ts).
 *
 * As in Telegram: the list is read straight from the DB (page_group_member, with the saved @username), Telegram is only asked when needed, and the
 * past queries are REMEMBERED. Before, every @ keypress asked for the @username of EACH person through the API (large group: several minutes) without saving anything, and the
 * list only had the first 50 people of the group cache.
 */
import type { GroupMember } from '@/store/app/appStore';
import { foldSearchText } from '../../../../shared/chat/searchFold';

export const MENTION_PAGE_SIZE = 50;
/** Re-fetch about 200 recent members of a Telegram group through the API after this long (people joining / leaving gradually). */
export const MENTION_MEMBERS_SYNC_TTL_MS = 24 * 60 * 60 * 1000;
/** Remember a Telegram search for this long: typing the same text again does not ask again (the results are already in the DB). */
export const MENTION_REMOTE_SEARCH_TTL_MS = 10 * 60 * 1000;
/** Search Telegram only after typing has paused this long. */
export const MENTION_REMOTE_SEARCH_DELAY_MS = 350;

const SYNC_PREFIX = 'deplao:mentionMembersSync:';

/** Time of the most recent API fetch of recent members for the @mention box (0 = never). */
export function mentionMembersSyncedAt(accountId: string, groupId: string): number {
  try {
    return Number(localStorage.getItem(`${SYNC_PREFIX}${accountId}:${groupId}`)) || 0;
  } catch {
    return 0;
  }
}

export function markMentionMembersSynced(accountId: string, groupId: string, at = Date.now()): void {
  try {
    localStorage.setItem(`${SYNC_PREFIX}${accountId}:${groupId}`, String(at));
  } catch {
    // localStorage full / blocked: the next @ will fetch again, which is fine
  }
}

/** Recent members need fetching again: never fetched (including from the "Thành viên" panel) or the TTL has passed. */
export function mentionMembersNeedSync(lastSyncedAt: number, now = Date.now()): boolean {
  return !lastSyncedAt || now - lastSyncedAt > MENTION_MEMBERS_SYNC_TTL_MS;
}

type RemoteSearch = { at: number; complete: boolean };
/** Per group (`accountId:groupId`): the text searched (lowercase) → when it was searched + whether enough matches were found. Lasts the whole session. */
const remoteSearches = new Map<string, Map<string, RemoteSearch>>();

const searchKey = (query: string) => String(query || '').trim().toLowerCase();

/**
 * Whether a search on Telegram is needed. It is not, if: the same text was just searched; or an earlier search is a prefix of this text and already
 * returned enough matches (Telegram searches by word start: if "ka" returns enough, the matches for "kae" are already in the DB). Matching keeps diacritics (does not
 * merge "le" with "lê") so that no search that needs asking is missed.
 */
export function shouldSearchMentionRemote(groupKey: string, query: string, now = Date.now()): boolean {
  const key = searchKey(query);
  if (!groupKey || !key) return false;
  const entries = remoteSearches.get(groupKey);
  if (!entries) return true;
  for (const [previous, entry] of entries) {
    if (now - entry.at > MENTION_REMOTE_SEARCH_TTL_MS) continue;
    if (previous === key) return false;
    if (entry.complete && key.startsWith(previous)) return false;
  }
  return true;
}

export function rememberMentionRemoteSearch(groupKey: string, query: string, complete: boolean, now = Date.now()): void {
  const key = searchKey(query);
  if (!groupKey || !key) return;
  let entries = remoteSearches.get(groupKey);
  if (!entries) {
    entries = new Map();
    remoteSearches.set(groupKey, entries);
  }
  entries.set(key, { at: now, complete });
}

/** Forget all searches (test). */
export function resetMentionRemoteSearches(): void {
  remoteSearches.clear();
}

/** Has a name to mention (people with only an id are not shown, since a label like "@123456" is meaningless). */
export function isNamedMember(member: Pick<GroupMember, 'userId' | 'displayName'>): boolean {
  const name = String(member?.displayName || '').trim();
  return !!name && name !== member.userId;
}

/**
 * Fallback when the DB has no match (the group's members are not saved in the DB yet, or the new name is only in the group cache): filter the group cache
 * by name / @username / id, ignoring diacritics.
 */
export function filterCachedMentionMembers(members: GroupMember[] | undefined, query: string, limit = MENTION_PAGE_SIZE * 4): GroupMember[] {
  const needle = foldSearchText(query);
  const result: GroupMember[] = [];
  for (const member of members || []) {
    if (!member?.userId || !isNamedMember(member)) continue;
    if (needle
      && !foldSearchText(member.displayName).includes(needle)
      && !foldSearchText(member.username || '').includes(needle)
      && !String(member.userId).includes(needle)) continue;
    result.push(member);
    if (result.length >= limit) break;
  }
  return result;
}

/** The group already has every member in the DB (small / regular group) → no more searching on Telegram is needed. */
export function mentionMembersComplete(dbTotal: number | null | undefined, memberCount: number | null | undefined): boolean {
  const total = Number(dbTotal) || 0;
  const count = Number(memberCount) || 0;
  return count > 0 && total >= count;
}
