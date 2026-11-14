/**
 * zaloGroupEventActor.ts: Zalo groups hide the member list. Join / leave / remove / block events send an EMPTY `updateMembers`
 * (no name, no id), so the line used to show "Thành viên đã rời khỏi nhóm" (A member left the group). The actor (`sourceId`) is still in the
 * event: the person who left / joined, or the admin who removed / blocked. EventBroadcaster looks up the name in the DB, and if it is not there calls
 * getUserInfo and fixes the notification line.
 */

import { tr } from '../i18n';

export const MEMBER_EVENT_TYPES: ReadonlySet<string> = new Set(['join', 'leave', 'remove_member', 'block_member']);

/** Actor id when the member event does not include member info; '' = not needed (updateMembers is already there). */
export function groupEventActorId(eventType: string, rawEvent: any): string {
  if (!MEMBER_EVENT_TYPES.has(eventType)) return '';
  const data = rawEvent?.data || rawEvent || {};
  const members: any[] = Array.isArray(data.updateMembers) ? data.updateMembers : [];
  if (members.some((m) => m && (m.id || m.dName || m.zaloName))) return '';
  const id = String(data.sourceId ?? '').trim();
  return /^\d+$/.test(id) ? id : '';
}

/** Notification line by actor; name not known yet → "Thành viên" (Member) / "Quản trị viên" (Admin) (removed / blocked by an admin). */
export function groupEventActorText(eventType: string, actorName: string, rawEvent: any): string {
  const data = rawEvent?.data || rawEvent || {};
  const name = String(actorName || '').trim();
  switch (eventType) {
    case 'join':
      // isAdd = 1: the actor added someone else (list hidden), 0: joined by themselves
      return Number(data.isAdd) === 1
        ? tr('{{v1}} đã thêm thành viên vào nhóm', { v1: name || tr('Thành viên') })
        : tr('{{v1}} đã tham gia nhóm', { v1: name || tr('Thành viên') });
    case 'leave':
      return tr('{{v1}} đã rời khỏi nhóm', { v1: name || tr('Thành viên') });
    case 'remove_member':
      return tr('{{v1}} đã xóa một thành viên khỏi nhóm', { v1: name || tr('Quản trị viên') });
    case 'block_member':
      return tr('{{v1}} đã chặn một thành viên khỏi nhóm', { v1: name || tr('Quản trị viên') });
    default:
      return '';
  }
}

/** Profile in the getUserInfo response (zca-js sends "<uid>_0", and the returned key may carry a suffix). */
export function profileFromUserInfo(response: any, uid: string): { name: string; avatar: string } | null {
  const changed = response?.changed_profiles || response?.data || {};
  const profile = changed[uid] ?? changed[`${uid}_0`] ?? null;
  if (!profile) return null;
  const name = String(profile.displayName || profile.zaloName || '').trim();
  const avatar = String(profile.avatar || '').trim();
  return name || avatar ? { name, avatar } : null;
}
