/**
 * Danh sách @nhắc đến trong ô soạn tin nhóm — như Telegram:
 *  - đọc ngay từ DB theo trang (page_group_member — cùng nguồn panel "Thành viên", có @username), tìm không dấu theo
 *    tên / @username / id; cuộn hoặc ↓ tới cuối để tải trang sau
 *  - Telegram: lần đầu (hoặc sau 24 giờ) lấy ~200 thành viên gần đây qua API — main lưu DB kèm @username; gõ tên trong
 *    nhóm lớn → tìm thêm trên Telegram, lưu DB, nhớ lượt đã tìm (lib/chat/members/mentionMembers)
 *  - DB không có ai khớp → lọc cache nhóm trong bộ nhớ như trước (nhóm chưa lưu thành viên vào DB)
 * Kết quả trả về muộn chỉ bị bỏ khi đã có lượt đọc mới hơn (seq) — KHÔNG dùng cờ "đã mount": StrictMode (bản dev) chạy
 * effect lúc mount 2 lần, cờ bị dọn về false nên mọi kết quả bị bỏ (chỉ còn @all, "Đang tải…" quay mãi).
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

/** Vòng "Đang tải thành viên…" / "Đang tìm…" tắt sau chừng này dù Telegram chưa trả (RPC treo); kết quả về sau vẫn hiện. */
export const MENTION_SYNC_SPINNER_MAX_MS = 20_000;
export const MENTION_SEARCH_SPINNER_MAX_MS = 12_000;

/** Nhóm đang lấy thành viên gần đây qua API (mở / đóng ô @ nhanh, StrictMode không gọi trùng). */
const syncInFlight = new Set<string>();

/** Chờ `promise` tối đa `ms` (hết hạn → undefined); lỗi → undefined. */
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
  /** Đang lấy thành viên gần đây qua API (lần đầu / sau 24 giờ). */
  syncing: boolean;
  /** Đang tìm trên Telegram theo chữ đã gõ. */
  searching: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

export function useMentionMembers({ open, accountId, groupId, channel, peerType, memberCount, query, cachedMembers }: {
  open: boolean;
  accountId?: string | null;
  groupId?: string | null;
  channel?: string | null;
  /** contacts.telegram_peer_type — kênh (broadcast) không lấy / tìm thành viên. */
  peerType?: string | null;
  /** Số thành viên thật của nhóm Telegram — DB đã có đủ thì không tìm thêm trên Telegram. */
  memberCount?: number;
  query: string;
  /** Cache nhóm trong bộ nhớ: tên / ảnh vừa lấy được mà DB chưa có; dự phòng khi DB không có ai khớp. */
  cachedMembers?: GroupMember[];
}): MentionMembersState {
  const [rows, setRows] = useState<GroupMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  /** Số người (có tên) của nhóm trong DB — lần đọc gần nhất không có chữ tìm. */
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [syncingKey, setSyncingKey] = useState('');
  const [searchingKey, setSearchingKey] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const seqRef = useRef(0);
  const rowsRef = useRef<GroupMember[]>([]);
  rowsRef.current = rows;
  /** Chữ tìm của danh sách đang hiện (null = chưa đọc). */
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

  // Đổi nhóm → bỏ danh sách của nhóm cũ ngay
  useEffect(() => {
    setRows([]);
    setTotal(null);
    setAllTotal(null);
    readQueryRef.current = null;
  }, [groupKey]);

  // Đóng ô @ → lần mở sau đọc lại từ đầu (không hiện kết quả của chữ cũ)
  useEffect(() => {
    if (open) return;
    seqRef.current += 1;
    setRows([]);
    setTotal(null);
    readQueryRef.current = null;
  }, [open]);

  // Trang đầu: mở ô @, đổi chữ tìm, hoặc DB vừa có thêm người (lấy / tìm trên Telegram xong — giữ số người đang hiện)
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
    if (readQueryRef.current !== trimmedQuery) return; // trang đầu của chữ mới chưa về
    loadingMoreRef.current = true;
    const seq = seqRef.current;
    void fetchPage(rowsRef.current.length, MENTION_PAGE_SIZE).then((res: any) => {
      loadingMoreRef.current = false;
      if (seq !== seqRef.current || isReadFailure(res)) return;
      setRows((previous) => appendMemberPage(previous, (res.members || []).map(memberFromRow)));
      setTotal(Number(res.total) || 0);
    });
  }, [open, total, trimmedQuery, fetchPage]);

  // Telegram: lần đầu (cả panel Thành viên chưa từng lấy) hoặc sau 24 giờ → ~200 thành viên gần đây qua API, main lưu DB.
  // Danh sách trong DB vẫn hiện ngay trong lúc chờ; xong thì đọc lại.
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

  // Telegram, nhóm lớn: gõ tên → tìm trên Telegram (ngừng gõ 350 ms), lưu DB rồi đọc lại; nhớ lượt đã tìm
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
          // Lỗi (mất mạng, nhóm ẩn thành viên…) cũng nhớ — không hỏi lại cùng chữ liên tục
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
