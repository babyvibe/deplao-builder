/**
 * @mention list in the group composer, like Telegram:
 *  - reads straight from the DB by page (page_group_member, the same source as the "Thành viên" (Members) panel, includes @username), accent-insensitive search by
 *    name / @username / id; scroll or ↓ to the end to load the next page
 *  - Telegram: the first time (or after 24 hours) it fetches ~200 recent members via the API, main saves them to the DB with @username; typing a name in a
 *    large group → searches more on Telegram, saves to the DB, remembers the search (lib/chat/members/mentionMembers)
 *  - if no one in the DB matches → filter the in-memory group cache as before (the group has not saved its members to the DB yet)
 * A late result is only dropped when a newer read has started (seq). DO NOT use an "already mounted" flag: StrictMode (dev build) runs the
 * mount effect twice, the flag is reset to false so every result is dropped (only @all stays, "Đang tải…" (Loading…) spins forever).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import type { GroupMember } from '@/store/app/appStore';
import { appendMemberPage, groupMembersApiSyncedAt, memberFromRow, withLiveMemberInfo } from '@/lib/chat/members/groupMembersPanel';
import {
  MENTION_PAGE_SIZE, MENTION_REMOTE_SEARCH_DELAY_MS, filterCachedMentionMembers, markMentionMembersSynced,
  mentionMembersComplete, mentionMembersNeedSync, mentionMembersSyncedAt, rememberMentionRemoteSearch,
  shouldSearchMentionRemote,
} from '@/lib/chat/members/mentionMembers';
import { groupOwnerRole } from '../../../shared/chat/groupMemberRoles';

/** The spinner for "Đang tải thành viên…" (Loading members…) / "Đang tìm…" (Searching…) stops after this long even if Telegram has not replied (RPC hung); late results still show. */
export const MENTION_SYNC_SPINNER_MAX_MS = 20_000;
export const MENTION_SEARCH_SPINNER_MAX_MS = 12_000;

/** Group currently fetching recent members via the API (open / close the quick @ box; StrictMode does not call it twice). */
const syncInFlight = new Set<string>();

/** Waits for `promise` for at most `ms` (timeout → undefined); error → undefined. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

export interface MentionMembersState {
  members: GroupMember[];
  /** Currently fetching recent members via the API (first time / after 24 hours). */
  syncing: boolean;
  /** Currently searching Telegram for the typed text. */
  searching: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

export function useMentionMembers({ open, accountId, groupId, channel, peerType, memberCount, query, cachedMembers }: {
  open: boolean;
  accountId?: string | null;
  groupId?: string | null;
  channel?: string | null;
  /** contacts.telegram_peer_type: channels (broadcast) do not fetch / search members. */
  peerType?: string | null;
  /** Real member count of the Telegram group: if the DB already has enough, do not search Telegram again. */
  memberCount?: number;
  query: string;
  /** In-memory group cache: name / photo just fetched that the DB does not have yet; fallback when the DB has no match. */
  cachedMembers?: GroupMember[];
}): MentionMembersState {
  const [rows, setRows] = useState<GroupMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /** Number of people (with a name) in the group in the DB: the last read had no search text. */
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [syncingKey, setSyncingKey] = useState('');
  const [searchingKey, setSearchingKey] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const seqRef = useRef(0);
  const rowsRef = useRef<GroupMember[]>([]);
  rowsRef.current = rows;
  /** Search text of the list currently shown (null = not read yet). */
  const readQueryRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const searchSeqRef = useRef(0);

  const groupKey = accountId && groupId ? `${accountId}:${groupId}` : '';
  const telegramGroup = channel === 'telegram_user' && peerType !== 'channel';
  const ownerRole = groupOwnerRole(channel);
  const trimmedQuery = query.trim();

  const fetchPage = useCallback((offset: number, limit: number) => DataAccessor.getGroupMembersPage({
    zaloId: accountId || '', groupId: groupId || '', query: trimmedQuery, limit, offset, ownerRole, namedOnly: true,
  }).catch((err: any) => ({ success: false as const, error: err?.message || String(err), members: [] as any[], total: 0 })),
  [accountId, groupId, trimmedQuery, ownerRole]);

  // Switching group → drop the old group's list immediately
  useEffect(() => {
    setRows([]);
    setTotal(null);
    setAllTotal(null);
    readQueryRef.current = null;
  }, [groupKey]);

  // Closing the @ box → the next open reads again from the start (does not show the old search's results)
  useEffect(() => {
    if (open) return;
    seqRef.current += 1;
    setRows([]);
    setTotal(null);
    readQueryRef.current = null;
  }, [open]);

  // First page: opening the @ box, changing the search text, or the DB just got more people (after a Telegram fetch / search finishes: keep the member count shown)
  useEffect(() => {
    if (!open || !groupKey) return;
    const seq = ++seqRef.current;
    const sameQuery = readQueryRef.current === trimmedQuery;
    const limit = sameQuery ? Math.min(Math.max(rowsRef.current.length, MENTION_PAGE_SIZE), 500) : MENTION_PAGE_SIZE;
    void fetchPage(0, limit).then((res: any) => {
      if (seq !== seqRef.current || isReadFailure(res)) return;
      readQueryRef.current = trimmedQuery;
      setRows((res.members || []).map(memberFromRow).filter((member: GroupMember) => member.userId));
      const nextTotal = Number(res.total) || 0;
      setTotal(nextTotal);
      if (!trimmedQuery) setAllTotal(nextTotal);
    });
  }, [open, groupKey, trimmedQuery, refreshTick, fetchPage]);

  const loadMore = useCallback(() => {
    if (!open || loadingMoreRef.current || total === null || rowsRef.current.length >= total) return;
    if (readQueryRef.current !== trimmedQuery) return; // first page of the new text has not arrived yet
    loadingMoreRef.current = true;
    const seq = seqRef.current;
    void fetchPage(rowsRef.current.length, MENTION_PAGE_SIZE).then((res: any) => {
      loadingMoreRef.current = false;
      if (seq !== seqRef.current || isReadFailure(res)) return;
      setRows((previous) => appendMemberPage(previous, (res.members || []).map(memberFromRow)));
      setTotal(Number(res.total) || 0);
    });
  }, [open, total, trimmedQuery, fetchPage]);

  // Telegram: the first time (the Members panel has never fetched) or after 24 hours → ~200 recent members via the API, main saves them to the DB.
  // The DB list is still shown during the wait; when done, read it again.
  useEffect(() => {
    if (!open || !groupKey || !telegramGroup || !accountId || !groupId) return;
    const lastSyncedAt = Math.max(mentionMembersSyncedAt(accountId, groupId), groupMembersApiSyncedAt(accountId, groupId));
    if (!mentionMembersNeedSync(lastSyncedAt) || syncInFlight.has(groupKey)) return;
    syncInFlight.add(groupKey);
    setSyncingKey(groupKey);
    const call = Promise.resolve(ipc.telegramUser?.getGroupMembers({ accountId, chatId: groupId, limit: 200 }));
    void call.then(
      (res) => {
        if (res?.success) markMentionMembersSynced(accountId, groupId);
        setRefreshTick((tick) => tick + 1);
      },
      () => {},
    ).finally(() => syncInFlight.delete(groupKey));
    void settleWithin(call, MENTION_SYNC_SPINNER_MAX_MS)
      .then(() => setSyncingKey((key) => (key === groupKey ? '' : key)));
  }, [open, groupKey, telegramGroup, accountId, groupId]);

  // Telegram, large group: typing a name → searches Telegram (after 350 ms of no typing), saves to the DB, then reads again; remembers the search
  const knownAll = mentionMembersComplete(allTotal, memberCount);
  useEffect(() => {
    if (!open || !groupKey || !telegramGroup || !accountId || !groupId || !trimmedQuery || knownAll) return;
    if (!shouldSearchMentionRemote(groupKey, trimmedQuery)) return;
    const timer = setTimeout(() => {
      if (!shouldSearchMentionRemote(groupKey, trimmedQuery)) return;
      const seq = ++searchSeqRef.current;
      setSearchingKey(groupKey);
      const call = Promise.resolve(ipc.telegramUser?.searchGroupMembers({ accountId, chatId: groupId, query: trimmedQuery, limit: MENTION_PAGE_SIZE }));
      void call.then(
        (res) => {
          // Errors (no network, members hidden in the group…) are also remembered: do not ask again for the same text over and over
          rememberMentionRemoteSearch(groupKey, trimmedQuery, !!res?.success && !!res.complete);
          if (res?.success && Number(res.found) > 0) setRefreshTick((tick) => tick + 1);
        },
        () => rememberMentionRemoteSearch(groupKey, trimmedQuery, false),
      );
      void settleWithin(call, MENTION_SEARCH_SPINNER_MAX_MS).then(() => {
        if (seq === searchSeqRef.current) setSearchingKey('');
      });
    }, MENTION_REMOTE_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, groupKey, telegramGroup, accountId, groupId, trimmedQuery, knownAll]);

  const members = useMemo(() => {
    const live = withLiveMemberInfo(rows, cachedMembers);
    if (live.length > 0 || total === null) return live;
    return filterCachedMentionMembers(cachedMembers, trimmedQuery);
  }, [rows, total, cachedMembers, trimmedQuery]);

  return {
    members,
    syncing: !!groupKey && syncingKey === groupKey,
    searching: !!groupKey && searchingKey === groupKey,
    hasMore: total !== null && rows.length < total,
    loadMore,
  };
}
