/**
 * Zalo access status using existing data, without asking Zalo again (SRS ZL-01 phase 2, FR-ZL01.6):
 *  - ZaloOnlineDot: a green dot on the avatar in the conversation list, for friends who are in the online list.
 *  - ZaloHeaderPresence: the line under the name in the header of a 1:1 conversation: "Trực tuyến" (Online) or "Truy cập 14:05" (Last seen 14:05) from that list /
 *    the last time the profile was opened (chatStore.userPresence).
 */
import React from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { isZaloFriendOnline, useZaloOnlineStore } from '@/store/zalo/zaloOnlineStore';
import { describeZaloPresence, zaloCachedPresence } from '../../../../../shared/zalo/zaloPresence';
import { capitalizeFirst } from '../../../../../shared/chat/presenceText';
import { tr } from '../../../../../shared/i18n';

export function ZaloOnlineDot({ accountId, userId, className = '' }: {
  accountId: string | null | undefined;
  userId: string | null | undefined;
  className?: string;
}) {
  const online = useZaloOnlineStore((s) => isZaloFriendOnline(s, accountId, userId));
  if (!online) return null;
  return (
    <span title={tr('Đang trực tuyến (Zalo)')} aria-label={tr('Đang trực tuyến')}
      className={`absolute z-10 h-3 w-3 rounded-full border-2 border-card bg-green-500 ${className}`} />
  );
}

export function ZaloHeaderPresence({ accountId, userId, className = '' }: {
  accountId: string;
  userId: string;
  className?: string;
}) {
  const onlineFriend = useZaloOnlineStore((s) => isZaloFriendOnline(s, accountId, userId));
  const entry = useChatStore((s) => s.userPresence[`${accountId}_${userId}`]);
  const presence = zaloCachedPresence(onlineFriend, entry);
  const text = capitalizeFirst(describeZaloPresence(presence));
  if (!text) return null;
  const online = presence?.status === 'online';
  return (
    <p className={`mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground ${className}`} title={tr('Trạng thái truy cập theo Zalo')}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${online ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
      {text}
    </p>
  );
}
