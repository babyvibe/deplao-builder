/**
 * Friend request bar: only for 1-1 chats (not groups, not Zalo My Documents).
 */
import { isMyDocumentsThread } from '@/lib/chat/zalo/myDocuments';
import FriendRequestBar from './FriendRequestBar';
import FacebookRequestBar from './FacebookRequestBar';
import FacebookEncryptedHistoryBar from './FacebookEncryptedHistoryBar';
import FacebookBlockedBar from './FacebookBlockedBar';
import { isFacebook } from '@/lib/channels/channelHelper';
import type { OpenThread } from '../hooks/useOpenThread';
import type { SenderDirectory } from '../hooks/useSenderDirectory';
import type { MessageActions } from '../hooks/useMessageActions';
import type { MessageListState } from '../hooks/useMessageListState';

type FriendRequestAreaProps = Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'allAccounts'>
  & Pick<SenderDirectory, 'contactMap'> & Pick<MessageActions, 'getAuth'> & Pick<MessageListState, 'messagesContainerRef'>;

export function FriendRequestArea({ activeAccountId, activeThreadId, allAccounts, contactMap, getAuth, messagesContainerRef }: FriendRequestAreaProps) {
  const contact = contactMap.get(activeThreadId);
  // Messenger does not let the account reply (blocked): unblock from here
  const cannotReply = String((contact as any)?.fb_cannot_reply || '');
  if (cannotReply) {
    return <FacebookBlockedBar accountId={activeAccountId} threadId={activeThreadId} reason={cannotReply} />;
  }
  // Messenger message request (people and groups): accept / delete
  if (Number((contact as any)?.fb_request) === 1) {
    return <FacebookRequestBar accountId={activeAccountId} threadId={activeThreadId} />;
  }
  // Encrypted Messenger chat: unlock old messages with the Messenger PIN (shown when loading older messages stops there)
  if (isFacebook(contact?.channel || allAccounts.find(a => a.zalo_id === activeAccountId)?.channel)) {
    return <FacebookEncryptedHistoryBar accountId={activeAccountId} threadId={activeThreadId} />;
  }
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
