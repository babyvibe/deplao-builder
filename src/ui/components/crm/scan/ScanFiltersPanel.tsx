import React from 'react';
import type { ScanType } from '../../../../services/facebook/scan/FacebookScanTypes';
import type { ScanFilters } from './ScanSessionTypes';
import { YEAR_OPTIONS, COMMENT_SORT_OPTIONS } from './ScanSessionTypes';

interface Props {
  scanType: ScanType;
  filters: ScanFilters;
  onChange: (filters: ScanFilters) => void;
}

export default function ScanFiltersPanel({ scanType, filters, onChange }: Props) {
  const update = (patch: Partial<ScanFilters>) => {
    onChange({ ...filters, ...patch });
  };

  const showYearFilter = scanType === 'post_keyword' || scanType === 'group_keyword' || scanType === 'fanpage_keyword';
  const showPublicFilter = scanType === 'group_keyword';
  const showRecentFilter = scanType === 'post_keyword';
  const showCommentSort = scanType === 'post_comments';
  const showCommentKeyword = scanType === 'post_comments';
  const showPhoneFilter = scanType === 'post_comments';

  // Không hiển thị gì nếu không có filter nào phù hợp
  if (!showYearFilter && !showPublicFilter && !showRecentFilter && !showCommentSort && !showCommentKeyword && !showPhoneFilter) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto flex-nowrap">
      {/* Public filter (group keyword) */}
      {showPublicFilter && (
        <label className="flex items-center gap-1 cursor-pointer flex-shrink-0">
          <input type="checkbox" checked={!!filters.public} onChange={(e) => update({ public: e.target.checked })}
            className="w-3 h-3 rounded bg-muted border-border-strong text-blue-500" />
          <span className="text-[11px] text-muted-foreground">Công khai</span>
        </label>
      )}

      {/* Recent filter (post keyword) */}
      {showRecentFilter && (
        <label className="flex items-center gap-1 cursor-pointer flex-shrink-0">
          <input type="checkbox" checked={!!filters.recent} onChange={(e) => update({ recent: e.target.checked })}
            className="w-3 h-3 rounded bg-muted border-border-strong text-blue-500" />
          <span className="text-[11px] text-muted-foreground">Gần đây</span>
        </label>
      )}

      {/* Year filter */}
      {showYearFilter && (
        <select value={filters.year || ''} onChange={(e) => update({ year: e.target.value })}
          className="bg-muted/50 text-foreground/80 text-[11px] rounded-lg px-2 py-1.5 border border-input/30 focus:outline-none focus:border-blue-500 flex-shrink-0">
          {YEAR_OPTIONS.map(opt => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
        </select>
      )}

      {/* Comment sort */}
      {showCommentSort && (
        <select value={filters.commentSort || 'chronological'} onChange={(e) => update({ commentSort: e.target.value as 'chronological' | 'relevant' })}
          className="bg-muted/50 text-foreground/80 text-[11px] rounded-lg px-2 py-1.5 border border-input/30 focus:outline-none focus:border-blue-500 flex-shrink-0">
          {COMMENT_SORT_OPTIONS.map(opt => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
        </select>
      )}

      {/* Comment keyword filter */}
      {showCommentKeyword && (
        <input type="text" value={filters.commentKeyword || ''} onChange={(e) => update({ commentKeyword: e.target.value })}
          placeholder="Lọc từ khóa..."
          className="bg-muted/50 text-foreground/80 text-[11px] rounded-lg px-2.5 py-1.5 w-32 border border-input/30 focus:outline-none focus:border-blue-500 placeholder-subtle-foreground flex-shrink-0" />
      )}

      {/* Phone detection (post comments) */}
      {showPhoneFilter && (
        <label className="flex items-center gap-1 cursor-pointer flex-shrink-0">
          <input type="checkbox" checked={!!filters.detectPhone} onChange={(e) => update({ detectPhone: e.target.checked })}
            className="w-3 h-3 rounded bg-muted border-border-strong text-emerald-500" />
          <span className="text-[11px] text-muted-foreground">Có SĐT</span>
        </label>
      )}
    </div>
  );
}
