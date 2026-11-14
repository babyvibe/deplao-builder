/**
 * useChannelCapability.ts
 * Hook that normalizes getting the ChannelCapability from the active contact.
 * Avoids repeating the getCapability + find-contact pattern in every component.
 */

import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { getCapability, type ChannelCapability } from '@/../configs/channels/channelConfig';
import { resolveChannel } from '@/lib/channels/channelHelper';

/**
 * Gets the ChannelCapability for the active thread.
 * Channel by resolveChannel: Telegram / Facebook account → the account's channel; Zalo → the conversation's channel.
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
  return getCapability(resolveChannel(contact, account));
}

/**
 * Utility to get the ChannelCapability from a contact/account object.
 * Used outside React components (store callbacks, event handlers).
 */
export function getChannelCapabilityForContact(
  contact?: { channel?: string },
  account?: { channel?: string },
): ChannelCapability {
  return getCapability(resolveChannel(contact, account));
}
