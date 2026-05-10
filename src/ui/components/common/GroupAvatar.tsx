import React, { useState } from 'react';
import type { CachedGroupInfo } from '@/store/appStore';

// ─── MemberCell: render 1 ô trong composite grid ─────────────────────────────
function MemberCell({ member, className }: { member: { avatar: string; displayName: string }; className?: string }) {
  return (
    <div className={`overflow-hidden${className ? ' ' + className : ''}`}>
      {member.avatar ? (
        <img src={member.avatar} alt="" className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div className="w-full h-full bg-purple-600 flex items-center justify-center text-white font-bold"
          style={{ fontSize: 'clamp(6px, 35%, 12px)' }}>
          {(member.displayName || '?').charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

// ─── Composite grid layouts ──────────────────────────────────────────────────
function Grid4({ members, sizeClass }: { members: { avatar: string; displayName: string }[]; sizeClass: string }) {
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden grid grid-cols-2 grid-rows-2 bg-gray-700 flex-shrink-0`}>
      {members.slice(0, 4).map((m, i) => <MemberCell key={i} member={m} />)}
    </div>
  );
}

function Grid3({ members, sizeClass }: { members: { avatar: string; displayName: string }[]; sizeClass: string }) {
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-gray-700 flex-shrink-0`}>
      <div className="flex-1 h-full"><MemberCell member={members[0]} className="h-full" /></div>
      <div className="flex-1 h-full flex flex-col">
        <div className="flex-1"><MemberCell member={members[1]} className="h-full" /></div>
        <div className="flex-1 border-t border-gray-900/40"><MemberCell member={members[2]} className="h-full" /></div>
      </div>
    </div>
  );
}

function Grid2({ members, sizeClass }: { members: { avatar: string; displayName: string }[]; sizeClass: string }) {
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-gray-700 flex-shrink-0`}>
      <div className="flex-1 h-full"><MemberCell member={members[0]} className="h-full" /></div>
      <div className="flex-1 h-full border-l border-gray-900/40"><MemberCell member={members[1]} className="h-full" /></div>
    </div>
  );
}

function Grid1({ members, sizeClass }: { members: { avatar: string; displayName: string }[]; sizeClass: string }) {
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden bg-gray-700 flex-shrink-0`}>
      <MemberCell member={members[0]} className="h-full w-full" />
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
  /** URL ảnh avatar nhóm (nếu có) */
  avatarUrl?: string;
  /** Cache info nhóm (chứa members để render composite) */
  groupInfo?: CachedGroupInfo | null;
  /** Tên nhóm — dùng cho fallback chữ cái đầu */
  name: string;
  /** Kích thước: xs(32) sm(36) md(40) lg(64) */
  size?: GroupAvatarSize;
  /** CSS class phụ (vd: hover:ring-2 ...) */
  className?: string;
}

/**
 * GroupAvatar — hiển thị avatar nhóm Zalo giống gốc:
 * 1. Nếu có avatarUrl → hiển thị ảnh
 * 2. Nếu không → composite grid từ members (2/3/4 ô)
 * 3. Fallback → chữ cái đầu trên nền tím
 */
export default function GroupAvatar({ avatarUrl, groupInfo, name, size = 'md', className = '' }: GroupAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const { sizeClass, fallbackText } = SIZE_MAP[size];
  const cls = `${sizeClass} ${className}`.trim();

  // 1. Avatar URL → hiển thị ảnh
  if (avatarUrl && !imgError) {
    return <img src={avatarUrl} alt="" className={`${cls} rounded-full object-cover flex-shrink-0`} onError={() => setImgError(true)} />;
  }

  // 2. Composite avatar từ members cache
  const members = (groupInfo?.members || [])
    .filter(m => m.avatar && m.userId && m.userId !== 'undefined')
    .slice(0, 4)
    .map(m => ({ avatar: m.avatar, displayName: m.displayName || m.userId }));

  if (members.length >= 4) return <Grid4 members={members} sizeClass={cls} />;
  if (members.length === 3) return <Grid3 members={members} sizeClass={cls} />;
  if (members.length === 2) return <Grid2 members={members} sizeClass={cls} />;
  if (members.length === 1) return <Grid1 members={members} sizeClass={cls} />;

  // 3. Fallback: chữ cái đầu
  return (
    <div className={`${cls} rounded-full bg-purple-600 flex items-center justify-center text-white ${fallbackText} font-bold flex-shrink-0`}>
      {(name || 'G').charAt(0).toUpperCase()}
    </div>
  );
}

