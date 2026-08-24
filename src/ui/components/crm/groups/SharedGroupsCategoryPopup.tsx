import React, { useState, useEffect, useCallback, useMemo } from 'react';
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

const CopyIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

const CheckSmallIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const SearchIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);

const ShareIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
  </svg>
);

const PrevIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);

const NextIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────

interface SharedGroupsCategoryPopupProps {
  pageId: string;
  onClose: () => void;
  onShareGroup: () => void;
  onBulkImport?: () => void;
}

const PAGE_SIZE = 50;

/** Bỏ dấu tiếng Việt để search */
function removeDiacritics(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SharedGroupsCategoryPopup({ pageId, onClose, onShareGroup, onBulkImport }: SharedGroupsCategoryPopupProps) {
  const [allGroups, setAllGroups] = useState<SharedGroupItem[]>([]);
  const [categories, setCategories] = useState<SharedGroupCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  // ── Copy link handler ─────────────────────────────────────────────────────
  const handleCopyLink = useCallback(async (group: SharedGroupItem) => {
    const link = group.groupLink || `https://zalo.me/g/${group.groupId}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = link;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedId(group.shareId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // ── Load groups (server-side pagination + category filter) ──────────────────
  const loadGroups = useCallback(async (categoryId?: number | null, page?: number) => {
    setLoading(true);
    try {
      const res = await getSharedGroups({
        pageId,
        categoryId: categoryId ?? undefined,
        page: page ?? 1,
        limit: PAGE_SIZE,
      });
      if (res.success) {
        setAllGroups(res.items);
        setCategories(res.categories);
        setTotalCount(res.pagination?.total ?? res.items.length);
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [pageId]);

  // Initial load
  useEffect(() => { loadGroups(); }, [loadGroups]);

  // ── Search (client-side on current page) ───────────────────────────────────
  const filteredGroups = useMemo(() => {
    let items = allGroups;
    if (searchText.trim()) {
      const q = removeDiacritics(searchText.toLowerCase());
      items = items.filter(g =>
        removeDiacritics(g.groupName.toLowerCase()).includes(q) ||
        g.groupId.includes(q) ||
        removeDiacritics(g.submittedBy.toLowerCase()).includes(q) ||
        (g.submittedByUid && g.submittedByUid.includes(q))
      );
    }
    return items;
  }, [allGroups, searchText]);

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const pagedGroups = filteredGroups; // API already returns one page

  // Reset page when category changes → refetch from server
  const handleCategoryChange = (catId: number | null) => {
    setSelectedCategoryId(catId);
    setCurrentPage(1);
    loadGroups(catId, 1);
  };

  // Page change → refetch from server
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    loadGroups(selectedCategoryId, page);
  };

  const selectedCategory = categories.find(c => c.id === selectedCategoryId);
  const totalGroups = totalCount || categories.reduce((sum, c) => sum + (c.count ?? 0), 0);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-2xl w-[720px] h-[540px] shadow-2xl flex overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* ── Left: Category List ─────────────────────────────────────── */}
        <div className="w-52 flex-shrink-0 border-r border-gray-700 flex flex-col">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">Nhóm chung</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">{totalGroups} nhóm</p>
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          {/* Category list */}
          <div className="flex-1 overflow-y-auto py-1">
            {/* "Tất cả" */}
            <button onClick={() => handleCategoryChange(null)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors
                ${selectedCategoryId === null
                  ? 'bg-green-500/10 border-r-2 border-green-500 text-white'
                  : 'text-gray-200 hover:bg-gray-700 hover:text-gray-200'}`}>
              <span className="text-lg flex-shrink-0">📋</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">Tất cả</p>
              </div>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full
                ${selectedCategoryId === null ? 'bg-green-500/10 text-green-400' : 'bg-gray-700 text-gray-200'}`}>
                {totalGroups}
              </span>
            </button>

            {/* Divider */}
            <div className="mx-4 my-1 border-t border-gray-700/50" />

            {loading && !selectedCategoryId && (
              <div className="flex items-center justify-center py-6 text-gray-400 text-xs gap-2">
                {SpinIcon}
              </div>
            )}
            {categories.map(cat => {
              const isActive = selectedCategoryId === cat.id;
              return (
                <button key={cat.id} onClick={() => handleCategoryChange(cat.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors
                    ${isActive
                      ? 'bg-green-500/10 border-r-2 border-green-500 text-white'
                      : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'}`}>
                  <span className="text-lg flex-shrink-0">{cat.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{cat.name}</p>
                  </div>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full
                    ${isActive ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-300'}`}>
                    {cat.count ?? 0}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Share group button */}
          <div className="px-3 py-3 border-t border-gray-700 flex gap-2">
            {/*{onBulkImport && (*/}
            {/*  <button onClick={onBulkImport}*/}
            {/*    className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5">*/}
            {/*    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">*/}
            {/*      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>*/}
            {/*      <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>*/}
            {/*    </svg>*/}
            {/*    Nhập hàng loạt*/}
            {/*  </button>*/}
            {/*)}*/}
            <button onClick={onShareGroup}
              className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5">
              {ShareIcon} Chia sẻ nhóm
            </button>
          </div>
        </div>

        {/* ── Right: Group List ───────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header + Search */}
          <div className="px-4 py-3 border-b border-gray-700 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                {selectedCategory ? `${selectedCategory.icon} ${selectedCategory.name}` : '📋 Tất cả nhóm'}
              </h3>
              <span className="text-[11px] text-gray-400">{filteredGroups.length} kết quả</span>
            </div>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">{SearchIcon}</div>
              <input type="text" value={searchText} onChange={e => setSearchText(e.target.value)}
                placeholder="Tìm theo tên nhóm, ID, người chia sẻ..."
                className="w-full bg-gray-700 border border-gray-600 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-green-500" />
            </div>
          </div>

          {/* Group list */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-12 text-gray-400 text-sm gap-2">
                {SpinIcon} Đang tải...
              </div>
            )}

            {!loading && pagedGroups.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <div className="text-3xl mb-2">{searchText ? '🔍' : '📭'}</div>
                <p className="text-sm text-gray-400">
                  {searchText ? 'Không tìm thấy nhóm' : 'Chưa có nhóm nào'}
                </p>
                {!searchText && (
                  <button onClick={onShareGroup}
                    className="mt-3 px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5">
                    {ShareIcon} Chia sẻ nhóm đầu tiên
                  </button>
                )}
              </div>
            )}

            {!loading && pagedGroups.length > 0 && (
              <div className="p-2 space-y-1">
                {pagedGroups.map(group => (
                  <div key={group.shareId}
                    className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-700/50 transition-colors">

                    {/* Avatar */}
                    {group.groupAvatar ? (
                      <img src={group.groupAvatar} alt={group.groupName}
                        className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
                        {(group.groupName || '?').charAt(0).toUpperCase()}
                      </div>
                    )}

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-white font-medium truncate">{group.groupName}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {group.memberCount.toLocaleString('vi-VN')} thành viên
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {group.submittedByAvatar ? (
                          <img src={group.submittedByAvatar} alt={group.submittedBy}
                            className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-3.5 h-3.5 rounded-full bg-gray-600 flex items-center justify-center text-[7px] text-gray-300 flex-shrink-0">
                            {(group.submittedBy || '?').charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="text-[10px] text-gray-500 truncate">{group.submittedBy}</span>
                        {group.submittedByUid && (
                          <span className="text-[10px] text-gray-600">· {group.submittedByUid}</span>
                        )}
                      </div>
                    </div>

                    {/* Actions — use group */}
                    <div className="flex-shrink-0">
                      <button onClick={() => handleCopyLink(group)}
                        className={`px-2.5 py-1.5 text-[10px] font-medium rounded-md transition-colors flex items-center justify-center gap-1 whitespace-nowrap
                          ${copiedId === group.shareId
                            ? 'bg-green-600 text-white'
                            : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>
                        {copiedId === group.shareId ? <>{CheckSmallIcon} Đã copy</> : <>{CopyIcon} Copy link</>}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-2.5 border-t border-gray-700 flex items-center justify-between">
              <span className="text-[11px] text-gray-500">
                Trang {currentPage}/{totalPages} · {totalCount} nhóm
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                  className="w-7 h-7 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-gray-300 transition-colors">
                  {PrevIcon}
                </button>
                {/* Page numbers */}
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  let page: number;
                  if (totalPages <= 5) {
                    page = i + 1;
                  } else if (currentPage <= 3) {
                    page = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    page = totalPages - 4 + i;
                  } else {
                    page = currentPage - 2 + i;
                  }
                  return (
                    <button key={page} onClick={() => handlePageChange(page)}
                      className={`w-7 h-7 rounded-md text-[11px] font-medium transition-colors
                        ${currentPage === page
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}>
                      {page}
                    </button>
                  );
                })}
                <button onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                  className="w-7 h-7 rounded-md bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-gray-300 transition-colors">
                  {NextIcon}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
