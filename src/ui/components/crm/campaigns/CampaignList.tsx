import React, { useState, useMemo } from 'react';
import type { CRMCampaign } from '@/store/crmStore';
import { showConfirm } from '@/components/common/ConfirmDialog';

interface CampaignListProps {
  campaigns: CRMCampaign[];
  loading: boolean;
  activeId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
  onClone: (id: number) => void;
  onUpdateStatus: (id: number, status: string) => void;
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-600/30 text-gray-400',
  active: 'bg-green-500/20 text-green-400',
  paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-blue-500/20 text-blue-400',
};
const STATUS_LABEL: Record<string, string> = { draft: 'Nháp', active: '▶ Đang chạy', paused: '⏸ Tạm dừng', done: '✓ Hoàn thành' };

const PAGE_SIZE = 10;

function fmtDate(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function CampaignList({ campaigns, loading, activeId, onSelect, onCreate, onDelete, onClone, onUpdateStatus }: CampaignListProps) {
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let list = campaigns;
    if (filterStatus !== 'all') list = list.filter(c => c.status === filterStatus);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q));
    }
    return list;
  }, [campaigns, search, filterStatus]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const resetPage = () => setPage(0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <span className="text-sm font-semibold text-gray-200">{campaigns.length} chiến dịch</span>
        <button onClick={onCreate}
          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Tạo mới
        </button>
      </div>

      {/* Filters */}
      <div className="px-3 pt-2.5 pb-2 border-b border-gray-700 flex-shrink-0 space-y-2">
        <div className="relative">
          <svg width="12" height="12" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={search} onChange={e => { setSearch(e.target.value); resetPage(); }}
            placeholder="Tìm tên chiến dịch..."
            className="w-full bg-gray-700 border border-gray-600 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
        </div>
        <div className="flex gap-1 flex-wrap">
          {(['all', 'draft', 'active', 'paused', 'done'] as const).map(s => (
            <button key={s} onClick={() => { setFilterStatus(s); resetPage(); }}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                filterStatus === s ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'
              }`}>
              {s === 'all' ? 'Tất cả' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && [...Array(3)].map((_, i) => <div key={i} className="h-20 bg-gray-700/50 rounded-xl animate-pulse" />)}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
            <p className="text-sm">{search || filterStatus !== 'all' ? 'Không tìm thấy chiến dịch' : 'Chưa có chiến dịch nào'}</p>
            {!search && filterStatus === 'all' && (
              <button onClick={onCreate} className="mt-3 text-xs text-blue-400 hover:text-blue-300">Tạo chiến dịch đầu tiên →</button>
            )}
          </div>
        )}

        {paged.map(c => {
          const progress = c.total_contacts > 0 ? (c.sent_count / c.total_contacts) * 100 : 0;
          return (
            <div key={c.id} onClick={() => onSelect(c.id)}
              className={`rounded-xl border p-3 cursor-pointer transition-colors ${activeId === c.id ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{c.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {/* Campaign type badge */}
                    {c.campaign_type === 'friend_request' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">🤝 Kết bạn</span>
                    )}
                    {c.campaign_type === 'invite_to_group' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">👥 Mời nhóm</span>
                    )}
                    {c.campaign_type === 'mixed' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">🔀 Hỗn hợp</span>
                    )}
                    <span className="text-[11px] text-gray-500">
                      ⏱ {c.delay_seconds}s delay
                      {c.created_at ? <> · 📅 {fmtDate(c.created_at)}</> : null}
                    </span>
                  </div>
                </div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 ${STATUS_STYLE[c.status]}`}>
                  {STATUS_LABEL[c.status]}
                </span>
              </div>

              {c.total_contacts > 0 && (
                <div className="mb-2">
                  <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                    <span>{c.sent_count}/{c.total_contacts} đã gửi</span>
                    {c.failed_count > 0 && <span className="text-red-400">{c.failed_count} lỗi</span>}
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              <div className="flex gap-1.5 mt-1.5" onClick={e => e.stopPropagation()}>
                {c.status === 'draft' && (
                  <button onClick={() => onUpdateStatus(c.id, 'active')}
                    className="flex-1 text-[11px] py-1 rounded-lg bg-green-600 hover:bg-green-700 text-white">▶ Bắt đầu</button>
                )}
                {c.status === 'active' && (
                  <button onClick={() => onUpdateStatus(c.id, 'paused')}
                    className="flex-1 text-[11px] py-1 rounded-lg bg-yellow-600 hover:bg-yellow-700 text-white">⏸ Tạm dừng</button>
                )}
                {c.status === 'paused' && (
                  <button onClick={() => onUpdateStatus(c.id, 'active')}
                    className="flex-1 text-[11px] py-1 rounded-lg bg-green-600 hover:bg-green-700 text-white">▶ Tiếp tục</button>
                )}
                <button onClick={() => onClone(c.id)}
                  title="Nhân bản chiến dịch"
                  className="px-2 text-[11px] py-1 rounded-lg bg-gray-700 hover:bg-blue-700/50 text-gray-400 hover:text-blue-300 transition-colors">📋</button>
                <button
                  onClick={async () => {
                    const ok = await showConfirm({
                      title: 'Xóa chiến dịch?',
                      message: `"${c.name}" sẽ bị xóa vĩnh viễn cùng toàn bộ dữ liệu gửi. Hành động này không thể hoàn tác.`,
                      variant: 'danger',
                      confirmText: 'Xóa',
                    });
                    if (ok) onDelete(c.id);
                  }}
                  className="px-2 text-[11px] py-1 rounded-lg bg-gray-700 hover:bg-red-700/50 text-gray-400 hover:text-red-300 transition-colors">🗑</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-3 py-2 border-t border-gray-700 flex-shrink-0">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
            className="px-2.5 py-1 rounded-lg bg-gray-700 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40">‹</button>
          <span className="text-xs text-gray-400">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
            className="px-2.5 py-1 rounded-lg bg-gray-700 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40">›</button>
        </div>
      )}
    </div>
  );
}
