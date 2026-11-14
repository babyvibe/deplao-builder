/**
 * "Đã xem" (Seen) + the photos of the people who have seen it (up to 5) below the last message.
 */
import { useAppStore } from '@/store/app/appStore';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import type { OpenThread } from '../hooks/useOpenThread';
import { tr } from '../../../../../shared/i18n';

type SeenIndicatorProps = Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'contactList' | 'threadSeen'>;

export function SeenIndicator({ activeAccountId, activeThreadId, contactList, threadSeen }: SeenIndicatorProps) {
  const seen = threadSeen;
  if (!seen || !seen.seenUids?.length) return null;

  // Get the info of the people who have seen it
  const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
  const allContacts = contactList;

  interface SeenUser { userId: string; name: string; avatar: string; }
  const seenUsers: SeenUser[] = seen.seenUids.map((uid: string) => {
    // Try to find them in the group members
    const member = groupCache?.members?.find((m: any) => m.userId === uid);
    if (member) return { userId: uid, name: member.displayName || uid, avatar: member.avatar || '' };
    // Try to find them in the contacts list
    const contact = allContacts.find(c => c.contact_id === uid);
    if (contact) return { userId: uid, name: contact.alias || contact.display_name || uid, avatar: contact.avatar_url || '' };
    return { userId: uid, name: uid, avatar: '' };
  });

  const MAX_SHOW = 5;
  const shown = seenUsers.slice(0, MAX_SHOW);
  const extra = seenUsers.length - MAX_SHOW;

  return (
    <div className="px-4 pb-2 flex justify-end items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground mr-0.5">{tr('Đã xem')}</span>
      <div className="flex items-center -space-x-1">
        {shown.map((u) => (
          <div key={u.userId} title={u.name} className="w-4 h-4 rounded-full ring-1 ring-border overflow-hidden flex-shrink-0">
            {u.avatar ? (
              <img src={u.avatar} alt={u.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ) : (
              <PeerInitials id={u.userId} name={u.name} single className="w-full h-full text-[7px]" />
            )}
          </div>
        ))}
        {extra > 0 && (
          <div className="w-4 h-4 rounded-full ring-1 ring-border bg-accent flex items-center justify-center text-foreground" style={{ fontSize: '0.4375rem' }}>
            +{extra}
          </div>
        )}
      </div>
    </div>
  );
}
