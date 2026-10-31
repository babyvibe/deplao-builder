/**
 * Thanh mời kết bạn: chỉ chat 1-1 (không nhóm, không My Documents của Zalo).
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
  // My Documents của Zalo không phải một người → không mời kết bạn
  if (isMyDocumentsThread(allAccounts.find(a => a.zalo_id === activeAccountId), activeThreadId, contact?.avatar_url)) return null;
  return (
    <FriendRequestBar
      zaloId={activeAccountId}
      userId={activeThreadId}
      contact={contact}
      getAuth={getAuth}
      onReady={() => {
        // Khi FriendRequestBar xuất hiện (async check xong) → thanh bar chiếm thêm chiều cao
        // → cần scroll xuống bottom để không bị đẩy lên
        requestAnimationFrame(() => {
          const el = messagesContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }}
    />
  );
}
