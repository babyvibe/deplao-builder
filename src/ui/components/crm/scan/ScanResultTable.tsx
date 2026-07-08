import React, { useMemo, useState, useCallback } from 'react';
import { SCAN_EXCEL_COLUMNS, type ScanType, type ExcelColumn } from '../../../../services/facebook/FacebookScanTypes';
import ipc from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import { LinkIcon, SearchIcon } from '@/components/common/icons';


interface Props {
  scanType: ScanType;
  items: any[];
  totalItems?: number;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onExportExcel: () => void;
}

export default function ScanResultTable({
  scanType,
  items,
  totalItems,
  loading,
  hasMore,
  onLoadMore,
  onExportExcel,
}: Props) {
  const [searchText, setSearchText] = useState('');
  const [sortKey, setSortKey] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const columns = SCAN_EXCEL_COLUMNS[scanType] || [];

  // Filter + Sort
  const processed = useMemo(() => {
    let result = [...items];

    // Filter
    if (searchText.trim()) {
      const q = searchText.toLowerCase().trim();
      result = result.filter(item =>
        Object.values(item).some((v: any) =>
          String(v || '').toLowerCase().includes(q)
        )
      );
    }

    // Sort
    if (sortKey) {
      result.sort((a, b) => {
        const va = a[sortKey] ?? '';
        const vb = b[sortKey] ?? '';
        let cmp = 0;
        if (typeof va === 'number' && typeof vb === 'number') {
          cmp = va - vb;
        } else {
          cmp = String(va).localeCompare(String(vb));
        }
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  }, [items, searchText, sortKey, sortDir]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(processed.length / pageSize));
  const pageItems = processed.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = useCallback((key: string) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  const handlePageChange = useCallback((newPage: number) => {
    setPage(Math.max(0, Math.min(newPage, totalPages - 1)));
  }, [totalPages]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
    setPage(0);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 bg-gray-800/40 flex-shrink-0">
        <div className="relative flex-1 max-w-xs">
          <input
            type="text"
            value={searchText}
            onChange={handleSearchChange}
            placeholder="🔍 Lọc kết quả..."
            className="w-full bg-gray-700/60 text-gray-200 text-xs rounded-lg pl-8 pr-3 py-1.5 border border-gray-600/50 focus:outline-none focus:border-blue-500 placeholder-gray-500"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <span className="text-xs text-gray-400">
          {totalItems !== undefined && totalItems !== items.length ? (
            <>{processed.length} / {items.length} (lọc từ {totalItems})</>
          ) : (
            <>{processed.length} / {items.length} kết quả</>
          )}
        </span>
        {/* Copy all UIDs */}
        {items.length > 0 && (
          <button
            onClick={() => copyAllUids(items)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-700/40 text-blue-300 hover:bg-blue-700/60 transition-colors"
            title="Copy tất cả UID/ID"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
            Copy UID
          </button>
        )}
        <button
          onClick={onExportExcel}
          disabled={items.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-700/40 text-green-300 hover:bg-green-700/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          Xuất Excel
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3">
              <Spinner size={8} />
              <p className="text-sm text-gray-400">Đang quét dữ liệu...</p>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p className="text-sm">Chưa có dữ liệu. Nhập thông tin và nhấn "Bắt đầu quét".</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-800/90 backdrop-blur z-10">
              <tr className="border-b border-gray-700">
                {/* Copy UID column */}
                <th className="px-2 py-2 text-left font-medium text-gray-400 w-8"><LinkIcon className="w-4 h-4" /></th>
                {columns.map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="px-3 py-2 text-left font-medium text-gray-400 cursor-pointer hover:text-white whitespace-nowrap select-none"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortKey === col.key && (
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {sortDir === 'asc'
                            ? <path d="M12 5v14M5 12l7-7 7 7"/>
                            : <path d="M12 19V5M5 12l7 7 7-7"/>
                          }
                        </svg>
                      )}
                    </span>
                  </th>
                ))}
                {/* Batch source column (if any item has _batchSource) */}
                {items.some((i: any) => i._batchSource) && (
                  <th className="px-3 py-2 text-left font-medium text-gray-400 whitespace-nowrap">Nguồn</th>
                )}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item, idx) => {
                const uid = item.uid || item.commentId || item.postId || item.authorId || item.reactorId || '';
                return (
                  <tr key={uid || idx}
                    className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors">
                    {/* Copy UID button */}
                    <td className="px-2 py-2">
                      {uid && (
                        <button
                          onClick={(e) => { e.stopPropagation(); copyUid(uid); }}
                          className="p-1 rounded hover:bg-blue-700/40 text-gray-400 hover:text-blue-300 transition-colors"
                          title={`Copy ${uid}`}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                          </svg>
                        </button>
                      )}
                    </td>
                    {columns.map(col => (
                      <td key={col.key} className="px-3 py-2 text-gray-300 max-w-[300px] truncate">
                        {col.key === 'index' ? page * pageSize + idx + 1
                          : col.key === 'timestamp' ? formatTimestamp(item[col.key])
                          : col.key === 'picture' || col.key === 'reactorAvatar' || col.key === 'authorAvatar' ? (
                            item[col.key] ? (
                              <img src={item[col.key]} alt="" className="w-7 h-7 rounded-full object-cover"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            ) : null
                          )
                          : col.key === 'url' && item[col.key] ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); ipc.shell?.openExternal(item[col.key]); }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 transition-colors text-[10px]"
                              title={item[col.key]}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                              </svg>
                              Mở
                            </button>
                          )
                          : col.key === 'postId' && item[col.key] ? (
                            <span className="font-mono text-[10px] text-gray-400">{item[col.key]}</span>
                          )
                          : item[col.key] ?? ''}
                      </td>
                    ))}
                    {/* Batch source */}
                    {item._batchSource && (
                      <td className="px-3 py-2 text-gray-400 max-w-[120px] truncate text-[10px]" title={item._batchSource}>
                        {item._batchSource}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination + Load More */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700 bg-gray-800/40 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0}
            className="px-2.5 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30"
          >
            ◀ Trước
          </button>
          <span className="text-xs text-gray-400">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages - 1}
            className="px-2.5 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30"
          >
            Sau ▶
          </button>
        </div>
        <div className="flex items-center gap-2">
          {hasMore && (
            <button
              onClick={onLoadMore}
              disabled={loading}
              className="px-3 py-1 rounded text-xs bg-blue-700/40 text-blue-300 hover:bg-blue-700/60 transition-colors disabled:opacity-40"
            >
              {loading ? 'Đang tải...' : 'Tải thêm'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Copy 1 UID vào clipboard */
function copyUid(uid: string) {
  navigator.clipboard.writeText(uid).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = uid;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

/** Copy tất cả UID/ID từ kết quả vào clipboard (mỗi dòng 1 ID) */
function copyAllUids(items: any[]) {
  const ids = items
    .map(item => item.uid || item.commentId || item.postId || item.authorId || item.reactorId || '')
    .filter(Boolean);
  if (ids.length === 0) return;
  const text = ids.join('\n');
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}
