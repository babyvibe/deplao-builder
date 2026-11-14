import React, { useState, useCallback } from 'react';
import type { CachedGroupInfo } from '@/store/app/appStore';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import PeerInitials from './PeerInitials';
import { nameInitial, peerColorIndex } from '@/lib/chat/messages/peerStyle';

type Member = { avatar: string; displayName: string; userId?: string };

// ─── MemberCell: renders 1 tile in the composite grid ─────────────────────────────
function MemberCell({ member, onFallback, className }: { member: Member; onFallback?: () => void; className?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const avatarUrl = member.avatar ? toLocalMediaUrl(member.avatar) : '';
  const showImage = avatarUrl && !imgFailed;
  return (
    <div className={`overflow-hidden${className ? ' ' + className : ''}`}>
      {showImage ? (
        <img src={avatarUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover"
          onError={() => { setImgFailed(true); onFallback?.(); }} />
      ) : (
        <div className={`w-full h-full chat-peer-${peerColorIndex(member.userId, member.displayName) ?? 5} chat-peer-avatar flex items-center justify-center font-bold`}
          style={{ fontSize: 'clamp(6px, 35%, 12px)' }}>
          {/^\d+$/.test(member.displayName) ? '?' : nameInitial(member.displayName)}
        </div>
      )}
    </div>
  );
}

// ─── CompositeGrid: grid showing 4 tiles, pool of 6 backup people ────────────────
// When 1 tile fails → automatically take the next person in the pool to replace it
function CompositeGrid({ allMembers, sizeClass }: { allMembers: Member[]; sizeClass: string }) {
  // active = the 4 tiles on show, pool = waiting list for replacements
  const [active, setActive] = useState<Member[]>(() => allMembers.slice(0, 4));
  const [pool, setPool] = useState<Member[]>(() => allMembers.slice(4, 10));

  const handleFallback = useCallback((failedIndex: number) => {
    setPool(prev => {
      if (prev.length === 0) return prev;
      const [next, ...rest] = prev;
      setActive(curr => {
        const updated = [...curr];
        updated[failedIndex] = next;
        return updated;
      });
      return rest;
    });
  }, []);

  const count = active.length;
  if (count === 0) return null;

  // Grid of 4 tiles
  if (count >= 4) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden grid grid-cols-2 grid-rows-2 bg-muted flex-shrink-0`}>
        {active.slice(0, 4).map((m, i) => <MemberCell key={i} member={m} onFallback={() => handleFallback(i)} />)}
      </div>
    );
  }
  if (count === 3) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-muted flex-shrink-0`}>
        <div className="flex-1 h-full"><MemberCell member={active[0]} onFallback={() => handleFallback(0)} className="h-full" /></div>
        <div className="flex-1 h-full flex flex-col">
          <div className="flex-1"><MemberCell member={active[1]} onFallback={() => handleFallback(1)} className="h-full" /></div>
          <div className="flex-1 border-t border-border/40"><MemberCell member={active[2]} onFallback={() => handleFallback(2)} className="h-full" /></div>
        </div>
      </div>
    );
  }
  if (count === 2) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-muted flex-shrink-0`}>
        <div className="flex-1 h-full"><MemberCell member={active[0]} onFallback={() => handleFallback(0)} className="h-full" /></div>
        <div className="flex-1 h-full border-l border-border/40"><MemberCell member={active[1]} onFallback={() => handleFallback(1)} className="h-full" /></div>
      </div>
    );
  }
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden bg-muted flex-shrink-0`}>
      <MemberCell member={active[0]} onFallback={() => handleFallback(0)} className="h-full w-full" />
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export type GroupAvatarSize = 'xs' | 'sm' | 'md' | 'search' | 'lg';

const SIZE_MAP: Record<GroupAvatarSize, { sizeClass: string; fallbackText: string }> = {
  xs:     { sizeClass: 'w-8 h-8',   fallbackText: 'text-xs' },   // CRM list
  sm:     { sizeClass: 'w-9 h-9',   fallbackText: 'text-sm' },   // FriendList
  md:     { sizeClass: 'w-10 h-10', fallbackText: 'text-base' }, // ConversationList (default)
  search: { sizeClass: 'w-11 h-11', fallbackText: 'text-sm' },   // GlobalSearchPanel
  lg:     { sizeClass: 'w-16 h-16', fallbackText: 'text-2xl' },  // GroupInfoPanel
};

interface GroupAvatarProps {
  /** Group avatar image URL (if any) */
  avatarUrl?: string;
  /** Group info cache (holds members to render the composite) */
  groupInfo?: CachedGroupInfo | null;
  /** Group name, used for the letter fallback */
  name: string;
  /** Group id: the color of the fallback letter image (same color everywhere); missing → color by name */
  id?: string;
  /** Size: xs(32) sm(36) md(40) lg(64) */
  size?: GroupAvatarSize;
  /** Extra CSS class (e.g. hover:ring-2 ...) */
  className?: string;
}

/**
 * GroupAvatar - shows a Zalo group avatar as the original does:
 * 1. If there is an avatarUrl → show the image
 * 2. If not → composite grid from members (2/3/4 tiles)
 * 3. Fallback → the first letter on a purple background
 */
function GroupAvatar({ avatarUrl, groupInfo, name, id, size = 'md', className = '' }: GroupAvatarProps) {
  // Remember the broken URL (not a true/false flag) → when the group avatar changes to a new URL, try to show it again
  const [failedAvatarUrl, setFailedAvatarUrl] = useState('');
  const { sizeClass, fallbackText } = SIZE_MAP[size];
  const cls = `${sizeClass} ${className}`.trim();

  // 1. Avatar URL → show the image (convert local path → Boss REST URL if needed)
  const mainAvatarUrl = avatarUrl ? toLocalMediaUrl(avatarUrl) : '';
  if (mainAvatarUrl && mainAvatarUrl !== failedAvatarUrl) {
    return <img src={mainAvatarUrl} alt="" loading="lazy" decoding="async" className={`${cls} rounded-full object-cover flex-shrink-0`} onError={() => setFailedAvatarUrl(mainAvatarUrl)} />;
  }

  // 2. Composite avatar from the cache, preferring members who have a photo (same as the conversation header),
  //    take 10 people, the grid shows 4, the other 6 are the fallback pool
  const validMembers = (groupInfo?.members || []).filter(m => m.userId && m.userId !== 'undefined');
  const picked = [...validMembers.filter(m => m.avatar), ...validMembers.filter(m => !m.avatar)].slice(0, 10);

  if (picked.length > 0) {
    const members = picked.map(m => ({ avatar: m.avatar || '', displayName: m.displayName || m.userId, userId: m.userId }));
    // CompositeGrid only reads the list at mount → key by members so it rebuilds when the cache changes.
    // New group: at first the cache only has the first sender (no photo yet); the full members + photos arrive later.
    const gridKey = picked.map(m => `${m.userId}:${m.avatar || ''}:${m.displayName || ''}`).join('|');
    return <CompositeGrid key={gridKey} allMembers={members} sizeClass={cls} />;
  }

  // 3. Fallback: Telegram-style initials, color by group id
  return <PeerInitials id={id} name={name} fallback="G" className={`${cls} ${fallbackText}`} />;
}

/**
 * Memoized by props (photo, group cache, name): when the conversation list / search redraws, group photos that did not change are not
 * redrawn. Photos load lazily (`loading="lazy"`): rows outside the visible area do not load / decode the photo yet.
 */
export default React.memo(GroupAvatar);
