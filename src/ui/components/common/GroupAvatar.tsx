import React, { useState, useCallback } from 'react';
import type { CachedGroupInfo } from '@/store/appStore';
import { toLocalMediaUrl } from '@/lib/localMedia';

type Member = { avatar: string; displayName: string };

// ─── MemberCell: render 1 ô trong composite grid ─────────────────────────────
function MemberCell({ member, onFallback, className }: { member: Member; onFallback?: () => void; className?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const avatarUrl = member.avatar ? toLocalMediaUrl(member.avatar) : '';
  const showImage = avatarUrl && !imgFailed;
  return (
    <div className={`overflow-hidden${className ? ' ' + className : ''}`}>
      {showImage ? (
        <img src={avatarUrl} alt="" className="w-full h-full object-cover"
          onError={() => { setImgFailed(true); onFallback?.(); }} />
      ) : (
        <div className="w-full h-full bg-purple-600 flex items-center justify-center text-white font-bold"
          style={{ fontSize: 'clamp(6px, 35%, 12px)' }}>
          {/^\d+$/.test(member.displayName) ? '?' : (member.displayName || '?').charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

// ─── CompositeGrid: Grid hiển thị 4 ô, pool 6 người dự phòng ────────────────
// Khi 1 ô lỗi → tự động lấy người tiếp theo trong pool thay vào
function CompositeGrid({ allMembers, sizeClass }: { allMembers: Member[]; sizeClass: string }) {
  // active = 4 ô đang hiển thị, pool = hàng chờ thay thế
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

  // Grid 4 ô
  if (count >= 4) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden grid grid-cols-2 grid-rows-2 bg-gray-700 flex-shrink-0`}>
        {active.slice(0, 4).map((m, i) => <MemberCell key={i} member={m} onFallback={() => handleFallback(i)} />)}
      </div>
    );
  }
  if (count === 3) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-gray-700 flex-shrink-0`}>
        <div className="flex-1 h-full"><MemberCell member={active[0]} onFallback={() => handleFallback(0)} className="h-full" /></div>
        <div className="flex-1 h-full flex flex-col">
          <div className="flex-1"><MemberCell member={active[1]} onFallback={() => handleFallback(1)} className="h-full" /></div>
          <div className="flex-1 border-t border-gray-900/40"><MemberCell member={active[2]} onFallback={() => handleFallback(2)} className="h-full" /></div>
        </div>
      </div>
    );
  }
  if (count === 2) {
    return (
      <div className={`${sizeClass} rounded-full overflow-hidden flex flex-row bg-gray-700 flex-shrink-0`}>
        <div className="flex-1 h-full"><MemberCell member={active[0]} onFallback={() => handleFallback(0)} className="h-full" /></div>
        <div className="flex-1 h-full border-l border-gray-900/40"><MemberCell member={active[1]} onFallback={() => handleFallback(1)} className="h-full" /></div>
      </div>
    );
  }
  return (
    <div className={`${sizeClass} rounded-full overflow-hidden bg-gray-700 flex-shrink-0`}>
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
  /** URL ảnh avatar nhóm (nếu có) */
  avatarUrl?: string;
  /** Cache info nhóm (chứa members để render composite) */
  groupInfo?: CachedGroupInfo | null;
  /** Tên nhóm - dùng cho fallback chữ cái đầu */
  name: string;
  /** Kích thước: xs(32) sm(36) md(40) lg(64) */
  size?: GroupAvatarSize;
  /** CSS class phụ (vd: hover:ring-2 ...) */
  className?: string;
}

/**
 * GroupAvatar - hiển thị avatar nhóm Zalo giống gốc:
 * 1. Nếu có avatarUrl → hiển thị ảnh
 * 2. Nếu không → composite grid từ members (2/3/4 ô)
 * 3. Fallback → chữ cái đầu trên nền tím
 */
export default function GroupAvatar({ avatarUrl, groupInfo, name, size = 'md', className = '' }: GroupAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const { sizeClass, fallbackText } = SIZE_MAP[size];
  const cls = `${sizeClass} ${className}`.trim();

  // 1. Avatar URL → hiển thị ảnh (convert local path → Boss REST URL nếu cần)
  const mainAvatarUrl = avatarUrl ? toLocalMediaUrl(avatarUrl) : '';
  if (mainAvatarUrl && !imgError) {
    return <img src={mainAvatarUrl} alt="" className={`${cls} rounded-full object-cover flex-shrink-0`} onError={() => setImgError(true)} />;
  }

  // 2. Composite avatar từ cache — lấy 10 người, grid hiển thị 4, 6 còn lại là pool fallback
  const members = (groupInfo?.members || [])
    .filter(m => m.userId && m.userId !== 'undefined')
    .slice(0, 10)
    .map(m => ({ avatar: m.avatar || '', displayName: m.displayName || m.userId }));

  if (members.length > 0) return <CompositeGrid allMembers={members} sizeClass={cls} />;

  // 3. Fallback: chữ cái đầu
  return (
    <div className={`${cls} rounded-full bg-purple-600 flex items-center justify-center text-white ${fallbackText} font-bold flex-shrink-0`}>
      {(name || 'G').charAt(0).toUpperCase()}
    </div>
  );
}

