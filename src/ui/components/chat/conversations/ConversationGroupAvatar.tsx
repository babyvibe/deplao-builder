/**
 * Group avatar for a row in the conversation list. Reads its own group info from the cache (only this row re-renders
 * when the group finishes loading) and only asks to load the image when the row enters the viewport (the list's shared observer →
 * groupAvatarLoader). A group that already has an image / enough member avatars does not watch anything.
 */
import React, { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/app/appStore';
import GroupAvatar from '../../common/avatars/GroupAvatar';
import { groupAvatarSatisfied } from '@/lib/chat/conversations/groupAvatarLoader';

function ConversationGroupAvatar({ accountId, groupId, avatarUrl, name, observer }: {
  accountId: string;
  groupId: string;
  avatarUrl?: string;
  name: string;
  /** The list's IntersectionObserver (null until it is built). */
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
