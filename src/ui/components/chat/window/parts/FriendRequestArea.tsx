/**
 * Friend request bar: only for 1-1 chats (not groups, not Zalo My Documents).
 */
import { isMyDocumentsThread } from '@/lib/chat/zalo/myDocuments';
import FriendRequestBar from './FriendRequestBar';
import type { OpenThread } from '../hooks/useOpenThread';
import type { SenderDirectory } from '../hooks/useSenderDirectory';
import type { MessageActions } from '../hooks/useMessageActions';
import type { MessageListState } from '../hooks/useMessageListState';

type FriendRequestAreaProps = Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'allAccounts'>
  & Pick<SenderDirectory, 'contactMap'> & Pick<MessageActions, 'getAuth'> & Pick<MessageListState, 'messagesContainerRef'>;

export function FriendRequestArea({ activeAccountId, activeThreadId, allAccounts, contactMap, getAuth, messagesContainerRef }: FriendRequestAreaProps) {
  const contact = contactMap.get(activeThreadId);
  const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
  if (isGroup) return null;
  // Zalo My Documents is not a person → no friend request
  if (isMyDocumentsThread(allAccounts.find(a => a.zalo_id === activeAccountId), activeThreadId, contact?.avatar_url)) return null;
  return (
    <FriendRequestBar
      zaloId={activeAccountId}
      userId={activeThreadId}
      contact={contact}
      getAuth={getAuth}
      onReady={() => {
        // When FriendRequestBar appears (async check finished) → the bar takes up more height
        // → needs to scroll to the bottom so it does not get pushed up
        requestAnimationFrame(() => {
          const el = messagesContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }}
    />
  );
}
