import React, { useState, useEffect, useCallback } from 'react';
import {
  getSharedGroups,
  DEFAULT_CATEGORIES,
  type SharedGroupItem,
  type SharedGroupCategory,
} from '@/lib/backendService';

// ─── Icons ──────────────────────────────────────────────────────────────────

const SpinIcon = (
  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const SearchIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

const ExternalLinkIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────

interface SharedGroupsSectionProps {
  activeAccountId: string;
  onJoinGroup: (groupId: string) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SharedGroupsSection({ activeAccountId, onJoinGroup }: SharedGroupsSectionProps) {
  const [groups, setGroups] = useState<SharedGroupItem[]>([]);
  const [categories, setCategories] = useState<SharedGroupCategory[]>(DEFAULT_CATEGORIES);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  // ── Load shared groups ────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await getSharedGroups({
        pageId: activeAccountId,
        categoryId: selectedCategoryId || undefined,
      });
      if (res.success) {
        setGroups(res.items);
        setCategories(res.categories);
      }
    } catch (err) {
      console.error('[SharedGroupsSection] load error:', err);
    } finally {
      setLoading(false);
    }
  }, [activeAccountId, selectedCategoryId]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // ── Filtered by search ────────────────────────────────────────────────────
  const filteredGroups = groups.filter(g =>
    !searchText.trim() ||
    g.groupName.toLowerCase().includes(searchText.toLowerCase()) ||
    g.groupId.includes(searchText)
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground">Nhóm chung</h3>
          {loading && SpinIcon}
        </div>
        <p className="text-[11px] text-muted-foreground">Danh sách nhóm đã được chia sẻ và duyệt bởi admin</p>
      </div>

      {/* Category filter tabs */}
      <div className="px-4 py-2 border-b border-border/50 flex-shrink-0 overflow-x-auto">
        <div className="flex gap-1.5 min-w-max">
          <button onClick={() => setSelectedCategoryId(null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap
              ${selectedCategoryId === null
                ? 'bg-blue-600 text-white'
                : 'bg-muted text-muted-foreground hover:bg-accent'}`}>
            Tất cả
          </button>
          {categories.filter(c => (c.count ?? 0) > 0).map(cat => (
            <button key={cat.id} onClick={() => setSelectedCategoryId(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap flex items-center gap-1
                ${selectedCategoryId === cat.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-muted text-muted-foreground hover:bg-accent'}`}>
              <span>{cat.icon}</span>
              <span>{cat.name}</span>
              <span className="text-[10px] opacity-60">({cat.count ?? 0})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-border/50 flex-shrink-0">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle-foreground">{SearchIcon}</div>
          <input type="text" value={searchText} onChange={e => setSearchText(e.target.value)}
            placeholder="Tìm nhóm theo tên hoặc ID..."
            className="w-full bg-card border border-input rounded-lg pl-9 pr-3 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
        </div>
      </div>

      {/* Group list */}
      <div className="flex-1 overflow-y-auto bg-card">
        {groups.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-full px-5 py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-card flex items-center justify-center mb-3 opacity-70">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <p className="text-sm text-foreground/80 font-medium mb-1">Chưa có nhóm nào</p>
            <p className="text-xs text-muted-foreground">Các nhóm được chia sẻ sẽ hiển thị ở đây</p>
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
            Không tìm thấy nhóm
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filteredGroups.map(group => (
              <div key={group.shareId}
                className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-card/60 transition-colors border border-transparent hover:border-border">
                {/* Avatar */}
                {group.groupAvatar ? (
                  <img src={group.groupAvatar} alt={group.groupName}
                    className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                    {(group.groupName || '?').charAt(0).toUpperCase()}
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm text-foreground font-medium truncate">{group.groupName}</p>
                    <span className="text-xs">{group.category.icon}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {group.memberCount.toLocaleString('vi-VN')} thành viên
                    <span className="mx-1.5">·</span>
                    <span className="text-subtle-foreground">Chia sẻ bởi {group.submittedBy}</span>
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button onClick={() => onJoinGroup(group.groupId)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1">
                    Tham gia
                  </button>
                  <button onClick={() => {
                    const url = `https://zalo.me/g/${group.groupId}`;
                    window.open(url, '_blank');
                  }}
                    className="w-8 h-8 rounded-lg bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground transition-colors"
                    title="Mở link nhóm">
                    {ExternalLinkIcon}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
