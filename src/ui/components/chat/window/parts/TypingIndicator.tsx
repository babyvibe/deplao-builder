/**
 * "… đang nhập..." trên ô soạn tin (người gõ trong 5 giây gần nhất, useTypingTicker vẽ lại mỗi 500 ms).
 */
import { useChatStore } from '@/store/chat/chatStore';
import { useAppStore } from '@/store/app/appStore';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { OpenThread } from '../hooks/useOpenThread';

type TypingIndicatorProps = Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'contactList'>;

export function TypingIndicator({ activeAccountId, activeThreadId, contactList }: TypingIndicatorProps) {
  const prefix = `${activeAccountId}_${activeThreadId}_`;
  const nowTs = Date.now();
  const typingEntries = Object.entries(useChatStore.getState().typingUsers).filter(
    ([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000
  );
  if (!typingEntries.length) return null;

  const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];

  const resolveName = (uid: string): string => {
    const c = contactList.find(x => x.contact_id === uid);
    if (c?.alias) return c.alias;
    if (c?.display_name && c.display_name !== uid) return c.display_name;
    const m = groupCache?.members?.find((x: any) => x.userId === uid);
    if (m?.displayName) return m.displayName;
    return uid;
  };

  const typingUids = typingEntries.map(([k]) => k.replace(prefix, ''));
  const names = typingUids.map(resolveName);
  const nameText = names.length === 1
    ? `${names[0]} đang nhập...`
    : names.length === 2
      ? `${names[0]}, ${names[1]} đang nhập...`
      : `${names[0]}, ${names[1]} và ${names.length - 2} người khác đang nhập...`;

  const firstUid = typingUids[0];
  const firstContact = contactList.find(c => c.contact_id === firstUid);
  const firstMember = groupCache?.members?.find((m: any) => m.userId === firstUid);
  const rawAvatar = firstContact?.avatar_url || firstMember?.avatar || '';
  const firstAvatar = rawAvatar ? toLocalMediaUrl(rawAvatar, activeAccountId) : '';

  return (
    <div className="flex items-center gap-1.5 px-4 py-1.5 flex-shrink-0 pointer-events-none">
      {firstAvatar ? (
        <img src={firstAvatar} className="w-4 h-4 rounded-full object-cover flex-shrink-0 opacity-80" alt="" />
      ) : (
        <PeerInitials id={firstUid} name={resolveName(firstUid)} single className="w-4 h-4 text-[9px] opacity-80" />
      )}
      <div className="flex items-center gap-1.5 bg-card backdrop-blur-sm border border-border/60 rounded-full px-2.5 py-1 shadow-md">
        <div className="flex items-center gap-0.5">
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-[11px] text-muted-foreground italic leading-none">{nameText}</span>
      </div>
    </div>
  );
}
