/**
 * Trạng thái truy cập Zalo dùng dữ liệu đã có, không hỏi Zalo thêm (SRS ZL-01 giai đoạn 2, FR-ZL01.6):
 *  - ZaloOnlineDot: chấm xanh ở ảnh đại diện trong danh sách hội thoại — bạn bè có trong danh sách đang online.
 *  - ZaloHeaderPresence: dòng dưới tên trên header hội thoại 1:1 — "Trực tuyến" hoặc "Truy cập 14:05" từ danh sách đó /
 *    lần mở hồ sơ gần nhất (chatStore.userPresence).
 */
import React from 'react';
import { useChatStore } from '@/store/chatStore';
import { isZaloFriendOnline, useZaloOnlineStore } from '@/store/zaloOnlineStore';
import { describeZaloPresence, zaloCachedPresence } from '../../../../shared/zaloPresence';
import { capitalizeFirst } from '../../../../shared/presenceText';

export function ZaloOnlineDot({ accountId, userId, className = '' }: {
  accountId: string | null | undefined;
  userId: string | null | undefined;
  className?: string;
}) {
  const online = useZaloOnlineStore((s) => isZaloFriendOnline(s, accountId, userId));
  if (!online) return null;
  return (
    <span title="Đang trực tuyến (Zalo)" aria-label="Đang trực tuyến"
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
    <p className={`mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground ${className}`} title="Trạng thái truy cập theo Zalo">
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${online ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
      {text}
    </p>
  );
}
