/**
 * Group avatar for a row in the conversation list. Reads its own group info from the cache (only this row re-renders
 * when the group finishes loading) and only asks to load the image when the row enters the viewport (the list's shared observer →
 * groupAvatarLoader). A group that already has an image / enough member avatars does not watch anything.
 * Facebook: a group photo that fails to load (Facebook CDN links expire) is fetched again, like the 1:1 rows do.
 */
import React, { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import GroupAvatar from '../../common/avatars/GroupAvatar';
import { groupAvatarSatisfied } from '@/lib/chat/conversations/groupAvatarLoader';
import { isFacebook } from '@/lib/channels/channelHelper';

function ConversationGroupAvatar({ accountId, groupId, avatarUrl, name, observer, channel }: {
  accountId: string;
  groupId: string;
  avatarUrl?: string;
  name: string;
  /** The list's IntersectionObserver (null until it is built). */
  observer: IntersectionObserver | null;
  channel?: string;
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

  const refetchPhoto = isFacebook(channel) ? () => {
    import('@/lib/contacts/avatarRetry')
      .then(({ handleAvatarError }) => handleAvatarError({ ownerId: accountId, contactId: groupId, channel }))
      .then(newUrl => { if (newUrl) useChatStore.getState().updateContact(accountId, { contact_id: groupId, avatar_url: newUrl }); })
      .catch(() => {});
  } : undefined;

  return (
    <div ref={ref} data-avatar-account={accountId} data-avatar-group={groupId} className="flex">
      <GroupAvatar avatarUrl={avatarUrl} groupInfo={groupInfo} name={name} id={groupId} size="md" onAvatarError={refetchPhoto} />
    </div>
  );
}

export default React.memo(ConversationGroupAvatar);
