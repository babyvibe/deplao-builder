/**
 * Group member role in `page_group_member.role`. EACH CHANNEL HAS ITS OWN CONVENTION (the data is stored that way, keep it):
 *   - Zalo (zaloGroupUtils, CRM groups, scanning hidden members, group info panel): 2 = group owner, 1 = deputy.
 *   - Telegram (TelegramUserListener.getGroupMembers): 1 = creator, 2 = admin.
 * Display / sorting / admin actions always go through here. Before, the members panel read the Telegram convention for the whole
 * Zalo group: the owner showed "Phó nhóm" (deputy), and the deputies showed "Trưởng nhóm" (owner).
 */

import { tr } from '../i18n';

export type GroupRoleKind = 'owner' | 'admin' | 'member';

function isTelegramChannel(channel?: string | null): boolean {
  return String(channel || '').startsWith('telegram');
}

/** The `role` value of the group owner, per channel. */
export function groupOwnerRole(channel?: string | null): number {
  return isTelegramChannel(channel) ? 1 : 2;
}

/** The `role` value of the deputy / admin, per channel. */
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
 * The account's own role in the group: from its own member row (per-channel role convention). If there is no role yet, from the
 * creatorId / adminIds of the group info (Zalo getGroupInfo). Before, the group info panel compared `role === 1` and used the fallback creator = 1 / admin = 2 (Telegram convention) for Zalo too: a Zalo deputy saw "Giải tán nhóm" (Disband group) and lost "Rời nhóm" (Leave group),
 * while the group owner had it the other way round.
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

export function groupRoleLabel(kind: GroupRoleKind, channel?: string | null): string {
  // Messenger groups only have administrators (the bubbles say the same, peerStyle.groupRankLabel)
  if (String(channel || '') === 'facebook') return kind === 'member' ? '' : tr('Quản trị viên');
  return kind === 'owner' ? tr('Trưởng nhóm') : kind === 'admin' ? tr('Phó nhóm') : '';
}
