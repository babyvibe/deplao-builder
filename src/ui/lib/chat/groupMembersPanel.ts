/**
 * Panel "Thành viên" của khung chat — phần thuần (test ở src/__tests__/groupMembersPanel.test.ts).
 *
 * Danh sách lấy từ DB (page_group_member — cùng nguồn với CRM Nhóm: quét thành viên ẩn, thu thập từ lịch sử tin
 * Telegram, đồng bộ API), phân trang + tìm trong DB. API của Zalo / Telegram chỉ gọi khi mở panel LẦN ĐẦU cho nhóm đó
 * (đánh dấu ở localStorage) hoặc khi bấm làm mới — API thường trả ít hơn DB (Zalo khoá xem thành viên, Telegram chỉ
 * trả ~200 người gần đây).
 */
import type { GroupMember } from '@/store/appStore';

export const GROUP_MEMBERS_PAGE_SIZE = 50;

const API_SYNC_PREFIX = 'deplao:groupMembersApiSync:';

function apiSyncKey(accountId: string, groupId: string): string {
  return `${API_SYNC_PREFIX}${accountId}:${groupId}`;
}

/** Lần đồng bộ thành viên qua API gần nhất của nhóm (0 = chưa bao giờ). */
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
    // localStorage đầy / bị chặn: lần sau mở panel gọi API lại, không sao
  }
}

/** Hàng page_group_member → thành viên. */
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
 * Gộp danh sách mới (API) vào danh sách đang có: KHÔNG bỏ ai đang có (API trả thiếu), người có trong cả hai lấy vai
 * trò / trạng thái mới, tên / ảnh mới nếu có (không thì giữ cũ).
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
 * Hàng DB + thông tin sống trong cache nhóm (trạng thái online / lần cuối hoạt động của Telegram, tên / ảnh vừa lấy
 * được mà DB chưa kịp có).
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

/** Nối trang sau vào danh sách đang hiện, bỏ người đã có (DB đổi giữa 2 lần đọc làm lệch OFFSET). */
export function appendMemberPage(current: GroupMember[], page: GroupMember[]): GroupMember[] {
  const seen = new Set(current.map((member) => member.userId));
  return [...current, ...page.filter((member) => member.userId && !seen.has(member.userId))];
}
