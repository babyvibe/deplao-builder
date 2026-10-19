/**
 * Vai trò thành viên nhóm trong `page_group_member.role` — MỖI KÊNH MỘT QUY ƯỚC (dữ liệu đã lưu như vậy, giữ nguyên):
 *   - Zalo (zaloGroupUtils, CRM Nhóm, quét thành viên ẩn, panel thông tin nhóm): 2 = trưởng nhóm, 1 = phó nhóm.
 *   - Telegram (TelegramUserListener.getGroupMembers): 1 = người tạo, 2 = quản trị viên.
 * Hiển thị / sắp xếp / thao tác quản trị luôn đi qua đây — trước đây panel thành viên đọc theo quy ước Telegram cho cả
 * nhóm Zalo: trưởng nhóm hiện "Phó nhóm", các phó nhóm hiện "Trưởng nhóm".
 */

export type GroupRoleKind = 'owner' | 'admin' | 'member';

function isTelegramChannel(channel?: string | null): boolean {
  return String(channel || '').startsWith('telegram');
}

/** Giá trị `role` của chủ nhóm theo kênh. */
export function groupOwnerRole(channel?: string | null): number {
  return isTelegramChannel(channel) ? 1 : 2;
}

/** Giá trị `role` của phó nhóm / quản trị viên theo kênh. */
export function groupAdminRole(channel?: string | null): number {
  return isTelegramChannel(channel) ? 2 : 1;
}

export function groupRoleKind(role: number | string | null | undefined, channel?: string | null): GroupRoleKind {
  const value = Number(role || 0);
  if (value === groupOwnerRole(channel)) return 'owner';
  if (value === groupAdminRole(channel)) return 'admin';
  return 'member';
}

/**
 * Vai trò của chính tài khoản trong nhóm: theo hàng thành viên của mình (quy ước role theo kênh), chưa có role thì theo
 * creatorId / adminIds của thông tin nhóm (Zalo getGroupInfo). Trước đây panel thông tin nhóm so `role === 1` và
 * fallback creator = 1 / admin = 2 (quy ước Telegram) cho cả Zalo: phó nhóm Zalo thấy "Giải tán nhóm" và mất "Rời nhóm",
 * trưởng nhóm thì ngược lại.
 */
export function myGroupRoleKind(
  info: {
    members?: ReadonlyArray<{ userId: string; role?: number | string | null }> | null;
    creatorId?: string | null;
    adminIds?: ReadonlyArray<string> | null;
  } | null | undefined,
  myId: string | null | undefined,
  channel?: string | null,
): GroupRoleKind {
  if (!info || !myId) return 'member';
  const me = info.members?.find(m => m.userId === myId);
  if (me && me.role != null) return groupRoleKind(me.role, channel);
  if (info.creatorId === myId) return 'owner';
  if (info.adminIds?.includes(myId)) return 'admin';
  return 'member';
}

export function groupRoleLabel(kind: GroupRoleKind): string {
  return kind === 'owner' ? 'Trưởng nhóm' : kind === 'admin' ? 'Phó nhóm' : '';
}
