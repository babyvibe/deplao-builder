import { isTelegramUser } from '@/lib/channels/channelHelper';

type MembershipContact = {
  channel?: string | null;
  telegram_membership_state?: string | null;
} | null | undefined;

export type TelegramMembershipNotice = {
  /** Short label for the conversation list. */
  label: string;
  /** Why the conversation does not update. */
  description: string;
};

const MEMBERSHIP_LABELS: Record<string, string> = {
  left: 'Đã rời',
  joinable: 'Chưa tham gia',
  request: 'Chờ duyệt',
  pending: 'Chờ duyệt',
  forbidden: 'Không khả dụng',
};

/**
 * A Telegram group/channel the account is not (or no longer) a member of.
 * Telegram does not deliver its new messages, so it never syncs in realtime;
 * the conversation stays for its history and is marked instead.
 */
export function getTelegramMembershipNotice(contact: MembershipContact): TelegramMembershipNotice | null {
  if (!contact || !isTelegramUser(contact.channel || undefined)) return null;
  const state = String(contact.telegram_membership_state || 'member');
  if (state === 'member') return null;
  const canRejoin = state === 'joinable' || state === 'request';
  return {
    label: MEMBERSHIP_LABELS[state] || 'Không còn là thành viên',
    description: `Bạn không còn là thành viên nên tin nhắn mới không được đồng bộ realtime.${canRejoin ? ' Tham gia lại để tiếp tục nhận tin.' : ''}`,
  };
}

export function isTelegramNonMember(contact: MembershipContact): boolean {
  return getTelegramMembershipNotice(contact) !== null;
}
