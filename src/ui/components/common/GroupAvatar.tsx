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
        <img src={avatarUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover"
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
function GroupAvatar({ avatarUrl, groupInfo, name, size = 'md', className = '' }: GroupAvatarProps) {
  // Nhớ URL bị lỗi (không phải cờ true/false) → avatar nhóm đổi sang URL mới thì thử hiển thị lại
  const [failedAvatarUrl, setFailedAvatarUrl] = useState('');
  const { sizeClass, fallbackText } = SIZE_MAP[size];
  const cls = `${sizeClass} ${className}`.trim();

  // 1. Avatar URL → hiển thị ảnh (convert local path → Boss REST URL nếu cần)
  const mainAvatarUrl = avatarUrl ? toLocalMediaUrl(avatarUrl) : '';
  if (mainAvatarUrl && mainAvatarUrl !== failedAvatarUrl) {
    return <img src={mainAvatarUrl} alt="" loading="lazy" decoding="async" className={`${cls} rounded-full object-cover flex-shrink-0`} onError={() => setFailedAvatarUrl(mainAvatarUrl)} />;
  }

  // 2. Composite avatar từ cache — ưu tiên thành viên có ảnh (giống header hội thoại),
  //    lấy 10 người, grid hiển thị 4, 6 còn lại là pool fallback
  const validMembers = (groupInfo?.members || []).filter(m => m.userId && m.userId !== 'undefined');
  const picked = [...validMembers.filter(m => m.avatar), ...validMembers.filter(m => !m.avatar)].slice(0, 10);

  if (picked.length > 0) {
    const members = picked.map(m => ({ avatar: m.avatar || '', displayName: m.displayName || m.userId }));
    // CompositeGrid chỉ đọc danh sách lúc mount → key theo thành viên để dựng lại khi cache đổi.
    // Nhóm mới: cache lúc đầu chỉ có người gửi tin đầu tiên (chưa có ảnh), sau mới đủ thành viên + ảnh.
    const gridKey = picked.map(m => `${m.userId}:${m.avatar || ''}:${m.displayName || ''}`).join('|');
    return <CompositeGrid key={gridKey} allMembers={members} sizeClass={cls} />;
  }

  // 3. Fallback: chữ cái đầu
  return (
    <div className={`${cls} rounded-full bg-purple-600 flex items-center justify-center text-white ${fallbackText} font-bold flex-shrink-0`}>
      {(name || 'G').charAt(0).toUpperCase()}
    </div>
  );
}

/**
 * Ghi nhớ theo props (ảnh, cache nhóm, tên): danh sách hội thoại / tìm kiếm dựng lại thì các ảnh nhóm không đổi không
 * dựng lại. Ảnh tải lười (`loading="lazy"`) — hàng ngoài vùng nhìn thấy chưa tải / giải mã ảnh.
 */
export default React.memo(GroupAvatar);
