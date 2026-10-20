/**
 * Ô @nhắc đến trong nhóm — phần thuần (hook: hooks/useMentionMembers.ts; test: src/__tests__/mentionMembers.test.ts).
 *
 * Như Telegram: danh sách đọc ngay từ DB (page_group_member, có @username đã lưu), chỉ hỏi Telegram khi cần và NHỚ lượt
 * đã hỏi. Trước đây mỗi lần gõ @ lại hỏi @username TỪNG người qua API (nhóm lớn: vài phút) mà không lưu gì, và danh
 * sách chỉ có 50 người đầu của cache nhóm.
 */
import type { GroupMember } from '@/store/appStore';
import { foldSearchText } from '../../../shared/searchFold';

export const MENTION_PAGE_SIZE = 50;
/** Lấy lại ~200 thành viên gần đây của nhóm Telegram qua API sau chừng này (người vào / rời nhóm dần dần). */
export const MENTION_MEMBERS_SYNC_TTL_MS = 24 * 60 * 60 * 1000;
/** Nhớ một lượt tìm trên Telegram chừng này: gõ lại đúng chữ đó không hỏi lại (kết quả đã nằm trong DB). */
export const MENTION_REMOTE_SEARCH_TTL_MS = 10 * 60 * 1000;
/** Ngừng gõ chừng này mới tìm trên Telegram. */
export const MENTION_REMOTE_SEARCH_DELAY_MS = 350;

const SYNC_PREFIX = 'deplao:mentionMembersSync:';

/** Lần lấy thành viên gần đây qua API cho ô @nhắc đến gần nhất (0 = chưa bao giờ). */
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
    // localStorage đầy / bị chặn: lần sau gõ @ lấy lại, không sao
  }
}

/** Cần lấy lại thành viên gần đây: chưa từng lấy (cả ở panel Thành viên) hoặc đã quá TTL. */
export function mentionMembersNeedSync(lastSyncedAt: number, now = Date.now()): boolean {
  return !lastSyncedAt || now - lastSyncedAt > MENTION_MEMBERS_SYNC_TTL_MS;
}

type RemoteSearch = { at: number; complete: boolean };
/** Theo nhóm (`accountId:groupId`): chữ đã tìm (chữ thường) → lúc tìm + đã đủ người khớp chưa. Sống suốt phiên. */
const remoteSearches = new Map<string, Map<string, RemoteSearch>>();

const searchKey = (query: string) => String(query || '').trim().toLowerCase();

/**
 * Có cần tìm trên Telegram không. Không, nếu: vừa tìm đúng chữ này; hoặc một lượt tìm trước là tiền tố của chữ này và đã
 * trả đủ người khớp (Telegram tìm theo đầu từ: "ka" đủ thì người khớp "kae" đều đã có trong DB). So khớp có dấu (không
 * gộp "le" với "lê") để không bỏ sót lượt cần hỏi.
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

/** Quên mọi lượt tìm (test). */
export function resetMentionRemoteSearches(): void {
  remoteSearches.clear();
}

/** Có tên để nhắc đến (người chỉ có id thì không hiện — nhãn "@123456" vô nghĩa). */
export function isNamedMember(member: Pick<GroupMember, 'userId' | 'displayName'>): boolean {
  const name = String(member?.displayName || '').trim();
  return !!name && name !== member.userId;
}

/**
 * Dự phòng khi DB không có ai khớp (nhóm chưa lưu thành viên vào DB, tên mới chỉ có trong cache nhóm): lọc cache nhóm
 * theo tên / @username / id, không phân biệt dấu.
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

/** Nhóm đã có đủ mọi thành viên trong DB (nhóm nhỏ / nhóm thường) → không cần tìm thêm trên Telegram. */
export function mentionMembersComplete(dbTotal: number | null | undefined, memberCount: number | null | undefined): boolean {
  const total = Number(dbTotal) || 0;
  const count = Number(memberCount) || 0;
  return count > 0 && total >= count;
}
