/**
 * zaloGroupEventActor.ts — nhóm Zalo ẩn danh sách thành viên: sự kiện vào / rời / xoá / chặn gửi `updateMembers` RỖNG
 * (không tên, không id) → trước đây hiện "Thành viên đã rời khỏi nhóm". Người thực hiện (`sourceId`) vẫn có trong sự
 * kiện: người rời / người vào, hoặc quản trị viên đã xoá / chặn. EventBroadcaster tra tên trong DB, không có thì gọi
 * getUserInfo rồi sửa dòng thông báo.
 */

export const MEMBER_EVENT_TYPES: ReadonlySet<string> = new Set(['join', 'leave', 'remove_member', 'block_member']);

/** id người thực hiện khi sự kiện thành viên không kèm thông tin thành viên; '' = không cần (đã có updateMembers). */
export function groupEventActorId(eventType: string, rawEvent: any): string {
  if (!MEMBER_EVENT_TYPES.has(eventType)) return '';
  const data = rawEvent?.data || rawEvent || {};
  const members: any[] = Array.isArray(data.updateMembers) ? data.updateMembers : [];
  if (members.some((m) => m && (m.id || m.dName || m.zaloName))) return '';
  const id = String(data.sourceId ?? '').trim();
  return /^\d+$/.test(id) ? id : '';
}

/** Dòng thông báo theo người thực hiện; chưa biết tên → "Thành viên" / "Quản trị viên" (xoá / chặn do quản trị làm). */
export function groupEventActorText(eventType: string, actorName: string, rawEvent: any): string {
  const data = rawEvent?.data || rawEvent || {};
  const name = String(actorName || '').trim();
  switch (eventType) {
    case 'join':
      // isAdd = 1: người thực hiện thêm người khác vào (danh sách bị ẩn), 0: tự tham gia
      return Number(data.isAdd) === 1
        ? `${name || 'Thành viên'} đã thêm thành viên vào nhóm`
        : `${name || 'Thành viên'} đã tham gia nhóm`;
    case 'leave':
      return `${name || 'Thành viên'} đã rời khỏi nhóm`;
    case 'remove_member':
      return `${name || 'Quản trị viên'} đã xóa một thành viên khỏi nhóm`;
    case 'block_member':
      return `${name || 'Quản trị viên'} đã chặn một thành viên khỏi nhóm`;
    default:
      return '';
  }
}

/** Hồ sơ trong phản hồi getUserInfo (zca-js gửi "<uid>_0", khoá trả về có thể kèm hậu tố). */
export function profileFromUserInfo(response: any, uid: string): { name: string; avatar: string } | null {
  const changed = response?.changed_profiles || response?.data || {};
  const profile = changed[uid] ?? changed[`${uid}_0`] ?? null;
  if (!profile) return null;
  const name = String(profile.displayName || profile.zaloName || '').trim();
  const avatar = String(profile.avatar || '').trim();
  return name || avatar ? { name, avatar } : null;
}
