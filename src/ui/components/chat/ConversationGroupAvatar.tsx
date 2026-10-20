/**
 * Ảnh nhóm của một hàng trong danh sách hội thoại. Tự đọc thông tin nhóm của mình trong cache (chỉ hàng này dựng lại
 * khi nhóm tải xong) và chỉ xin tải ảnh khi hàng vào vùng nhìn thấy (observer dùng chung của danh sách →
 * groupAvatarLoader). Nhóm đã có ảnh / đủ ảnh thành viên thì không theo dõi gì.
 */
import React, { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/appStore';
import GroupAvatar from '../common/GroupAvatar';
import { groupAvatarSatisfied } from '@/lib/chat/groupAvatarLoader';

function ConversationGroupAvatar({ accountId, groupId, avatarUrl, name, observer }: {
  accountId: string;
  groupId: string;
  avatarUrl?: string;
  name: string;
  /** IntersectionObserver của danh sách (null khi chưa dựng xong). */
  observer: IntersectionObserver | null;
}) {
  const groupInfo = useAppStore(s => s.groupInfoCache[accountId]?.[groupId]);
  const ref = useRef<HTMLDivElement>(null);
  const needsData = !groupAvatarSatisfied(avatarUrl, groupInfo);

  useEffect(() => {
    const el = ref.current;
    if (!el || !observer || !needsData) return undefined;
    observer.observe(el);
    return () => observer.unobserve(el);
  }, [observer, needsData]);

  return (
    <div ref={ref} data-avatar-account={accountId} data-avatar-group={groupId} className="flex">
      <GroupAvatar avatarUrl={avatarUrl} groupInfo={groupInfo} name={name} id={groupId} size="md" />
    </div>
  );
}

export default React.memo(ConversationGroupAvatar);
