/**
 * useChannelInfo.ts — Hook cung cấp channel info cho component hiện tại.
 *
 * Thay vì mỗi component tự resolve channel từ contact/account,
 * dùng hook này để có consistent channel detection.
 *
 * Usage:
 *   const { channel, isZalo, isTelegram, cap, supports } = useChannelInfo();
 *   if (supports('supportsEdit')) { ... }
 *   if (!isZalo) { // use adapter
 *   }
*/


import { useMemo } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { type Channel, type ChannelCapability, channelSupports, getCapability } from '../../../configs/channels/channelConfig';
import { isZalo as _isZalo, isTelegram as _isTelegram, isFacebook as _isFacebook, isNonZalo as _isNonZalo, CHANNEL } from '@/lib/channels/channelHelper';

export interface ChannelInfo {
  channel: Channel;
  cap: ChannelCapability;
  isZalo: boolean;
  isFacebook: boolean;
  isTelegram: boolean;
  isTelegramBot: boolean;
  isTelegramUser: boolean;
  isNonZalo: boolean;
  supports: (feature: keyof ChannelCapability) => boolean;
}

export function useChannelInfo(): ChannelInfo {
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeThreadId = useChatStore(s => s.activeThreadId);
  const contacts = useChatStore(s => s.contacts);
  const getActiveAccount = useAccountStore(s => s.getActiveAccount);

  return useMemo(() => {
    const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
    const contact = contactList.find(c => c.contact_id === activeThreadId);
    const account = getActiveAccount();
    const ch: Channel = ((contact?.channel || account?.channel || CHANNEL.ZALO) as Channel);

    return {
      channel: ch,
      cap: getCapability(ch),
      isZalo: _isZalo(ch),
      isFacebook: _isFacebook(ch),
      isTelegram: _isTelegram(ch),
      isTelegramBot: ch === 'telegram_bot',
      isTelegramUser: ch === 'telegram_user',
      isNonZalo: _isNonZalo(ch),
      supports: (feature: keyof ChannelCapability) => channelSupports(ch, feature),
    };
  }, [activeAccountId, activeThreadId, contacts, getActiveAccount]);
}

/**
 * Phiên bản lightweight — chỉ cần channel string, không cần full hook.
 * Dùng trong utility functions hoặc khi channel đã được resolve sẵn.
 */
export function getChannelInfo(ch: Channel) {
  return {
    channel: ch,
    cap: getCapability(ch),
    isZalo: _isZalo(ch),
    isFacebook: _isFacebook(ch),
    isTelegram: _isTelegram(ch),
    isTelegramBot: ch === 'telegram_bot',
    isTelegramUser: ch === 'telegram_user',
    isNonZalo: _isNonZalo(ch),
    supports: (feature: keyof ChannelCapability) => channelSupports(ch, feature),
  };
}
