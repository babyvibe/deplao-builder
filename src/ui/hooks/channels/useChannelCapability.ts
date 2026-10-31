/**
 * useChannelCapability.ts
 * Hook chuẩn hoá để lấy ChannelCapability từ contact đang active.
 * Tránh lặp pattern getCapability + tìm contact ở mỗi component.
 */

import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { getCapability, type ChannelCapability, type Channel } from '@/../configs/channels/channelConfig';
import { CHANNEL } from '@/lib/channels/channelHelper';

/**
 * Lấy ChannelCapability cho thread đang active.
 * Derive channel từ: active contact → active account → fallback 'zalo'
 */
export function useChannelCapability(): ChannelCapability {
  const activeThreadId = useChatStore(s => s.activeThreadId);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const contacts = useChatStore(s => s.contacts);
  const accounts = useAccountStore(s => s.accounts);

  const contact = activeAccountId
    ? (contacts[activeAccountId] || []).find(c => c.contact_id === activeThreadId)
    : undefined;
  const account = accounts.find(a => a.zalo_id === activeAccountId);
  const channel = (contact?.channel || account?.channel || CHANNEL.ZALO) as Channel;

  return getCapability(channel);
}

/**
 * Utility để lấy ChannelCapability từ contact/account object.
 * Dùng ngoài React components (store callbacks, event handlers).
 */
export function getChannelCapabilityForContact(
  contact?: { channel?: string },
  account?: { channel?: string },
): ChannelCapability {
  const channel = (contact?.channel || account?.channel || CHANNEL.ZALO) as Channel;
  return getCapability(channel);
}
