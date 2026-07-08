import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import PageLoading from '@/components/common/PageLoading';
import { AwardIcon, ChartIcon, ChatIcon, EditIcon, PackageIcon, SearchIcon, TrendingUpIcon, UsersIcon } from '@/components/common/icons';


interface Props {
  accountId: string;
}

interface StatsData {
  totalTabs: number;
  totalItems: number;
  successCount: number;
  errorCount: number;
  byType: Record<string, number>;
  topTabs: Array<{ id: string; name: string; itemsCount: number }>;
}

export default function ScanStatsTab({ accountId }: Props) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const res = await ipc.fb?.scanGetStats({ accountId });
      if (res?.success) {
        setStats({
          totalTabs: res.totalTabs || 0,
          totalItems: res.totalItems || 0,
          successCount: res.successCount || 0,
          errorCount: res.errorCount || 0,
          byType: res.byType || {},
          topTabs: res.topTabs || [],
        });
      }
    } catch {}
    setLoading(false);
  }, [accountId]);

  useEffect(() => { loadStats(); }, [loadStats]);

  if (loading) return <PageLoading variant="inline" text="Đang tải thống kê..." />;

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">Không có dữ liệu</div>
    );
  }

  const totalRequests = stats.successCount + stats.errorCount;
  const successRate = totalRequests > 0 ? Math.round((stats.successCount / totalRequests) * 100) : 0;

  const typeLabels: Record<string, string> = {
    group_members: '👥 Thành viên nhóm',
    group_keyword: '🔍 Nhóm theo từ khóa',
    fanpage_keyword: '🔎 Fanpage theo từ khóa',
    post_comments: '💬 Bình luận bài viết',
    post_keyword: '📝 Bài viết theo từ khóa',
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white"><ChartIcon className="w-4 h-4 inline" /> Thống kê quét dữ liệu</h2>
        <button onClick={loadStats} className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="Làm mới">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/>
          </svg>
        </button>
      </div>

      {/* ── Overview chart ────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700/50">
        <div className="flex items-center gap-8">
          {/* Donut chart: tỷ lệ thành công */}
          <div className="flex-shrink-0 relative w-28 h-28">
            <svg className="w-28 h-28 -rotate-90" viewBox="0 0 72 72">
              {/* Background circle */}
              <circle cx="36" cy="36" r="30" fill="none" stroke="rgb(55 65 81)" strokeWidth="6" />
              {/* Success arc */}
              {totalRequests > 0 && (
                <circle cx="36" cy="36" r="30" fill="none" stroke="url(#successGrad)" strokeWidth="6"
                  strokeDasharray={`${(stats.successCount / totalRequests) * 188.5} 188.5`}
                  strokeLinecap="round"
                />
              )}
              {/* Error arc */}
              {stats.errorCount > 0 && (
                <circle cx="36" cy="36" r="30" fill="none" stroke="url(#errorGrad)" strokeWidth="6"
                  strokeDasharray={`${(stats.errorCount / totalRequests) * 188.5} 188.5`}
                  strokeDashoffset={`${-(stats.successCount / totalRequests) * 188.5}`}
                  strokeLinecap="round"
                />
              )}
              <defs>
                <linearGradient id="successGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#22c55e" />
                  <stop offset="100%" stopColor="#4ade80" />
                </linearGradient>
                <linearGradient id="errorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#ef4444" />
                  <stop offset="100%" stopColor="#f87171" />
                </linearGradient>
                <linearGradient id="tabsGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#60a5fa" />
                </linearGradient>
                <linearGradient id="itemsGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#a78bfa" />
                </linearGradient>
              </defs>
            </svg>
            {/* Center text */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`text-lg font-bold ${successRate >= 80 ? 'text-green-400' : successRate >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                {successRate}%
              </span>
              <span className="text-[9px] text-gray-400 -mt-0.5">thành công</span>
            </div>
          </div>

          {/* Legend + mini bar chart for tabs vs items */}
          <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-3">
            {/* Tabs */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400">📂 Tổng số tab</span>
                <span className="text-sm font-bold text-white">{stats.totalTabs}</span>
              </div>
              <div className="w-full h-2.5 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-700"
                  style={{ width: `${Math.min(100, stats.totalTabs * 15)}%` }} />
              </div>
            </div>
            {/* Items */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400"><PackageIcon className="w-4 h-4 inline" /> Dữ liệu đã quét</span>
                <span className="text-sm font-bold text-purple-400">{stats.totalItems.toLocaleString()}</span>
              </div>
              <div className="w-full h-2.5 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-purple-500 to-purple-400 transition-all duration-700"
                  style={{ width: `${Math.min(100, stats.totalItems > 0 ? (stats.totalItems / Math.max(stats.totalItems, 1000)) * 100 : 0)}%` }} />
              </div>
            </div>
            {/* Success requests */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400">✅ Request thành công</span>
                <span className="text-sm font-bold text-green-400">{stats.successCount.toLocaleString()}</span>
              </div>
              <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-700"
                  style={{ width: `${totalRequests > 0 ? (stats.successCount / totalRequests) * 100 : 0}%` }} />
              </div>
            </div>
            {/* Error requests */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-400">❌ Request thất bại</span>
                <span className="text-sm font-bold text-red-400">{stats.errorCount.toLocaleString()}</span>
              </div>
              <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-red-500 to-red-400 transition-all duration-700"
                  style={{ width: `${totalRequests > 0 ? (stats.errorCount / totalRequests) * 100 : 0}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 1: Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <div className="text-[11px] text-gray-400 uppercase tracking-wider">Tổng số tab</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.totalTabs}</div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <div className="text-[11px] text-gray-400 uppercase tracking-wider">Dữ liệu đã quét</div>
          <div className="text-2xl font-bold text-blue-400 mt-1">{stats.totalItems.toLocaleString()}</div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <div className="text-[11px] text-gray-400 uppercase tracking-wider">Tổng request</div>
          <div className="text-2xl font-bold text-purple-400 mt-1">{totalRequests.toLocaleString()}</div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <div className="text-[11px] text-gray-400 uppercase tracking-wider">Tỷ lệ thành công</div>
          <div className={`text-2xl font-bold mt-1 ${successRate >= 80 ? 'text-green-400' : successRate >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
            {successRate}%
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            <span className="text-green-400">✓ {stats.successCount}</span>
            {' / '}
            <span className="text-red-400">✗ {stats.errorCount}</span>
          </div>
        </div>
      </div>

      {/* Row 2: By type + Top tabs */}
      <div className="grid grid-cols-2 gap-4">
        {/* By type */}
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">📂 Theo loại quét</h3>
          {Object.keys(stats.byType).length === 0 ? (
            <p className="text-xs text-gray-400 py-4 text-center">Chưa có dữ liệu</p>
          ) : (
            <>
              {/* Vertical bar chart */}
              <div className="flex items-end gap-2 h-28 mb-3">
                {Object.entries(stats.byType)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => {
                    const maxCount = Math.max(...Object.values(stats.byType));
                    const heightPct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                    const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-amber-500', 'bg-rose-500'];
                    const colorIdx = Object.keys(stats.byType).indexOf(type) % colors.length;
                    return (
                      <div key={type} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                        <span className="text-[10px] text-gray-400 font-mono">{count}</span>
                        <div className="w-full rounded-t-md overflow-hidden" style={{ height: `${heightPct}%` }}>
                          <div className={`w-full h-full ${colors[colorIdx]} opacity-80 hover:opacity-100 transition-opacity`} />
                        </div>
                        <span className="text-[9px] text-gray-400 truncate w-full text-center leading-tight" title={typeLabels[type] || type}>
                          {(typeLabels[type] || type).split(' ').pop()}
                        </span>
                      </div>
                    );
                  })}
              </div>
              {/* List */}
              <div className="space-y-1.5 border-t border-gray-700/30 pt-2">
                {Object.entries(stats.byType)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between">
                      <span className="text-xs text-gray-300">{typeLabels[type] || type}</span>
                      <span className="text-xs text-gray-400 font-mono">{count}</span>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>

        {/* Top tabs */}
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <h3 className="text-sm font-semibold text-gray-200 mb-3"><AwardIcon className="w-4 h-4 inline" /> Top tab nhiều dữ liệu nhất</h3>
          {stats.topTabs.length === 0 ? (
            <p className="text-xs text-gray-400 py-4 text-center">Chưa có dữ liệu</p>
          ) : (
            <div className="space-y-2.5">
              {stats.topTabs.map((tab, idx) => {
                const maxItems = Math.max(...stats.topTabs.map(t => t.itemsCount || 0));
                const pct = maxItems > 0 ? ((tab.itemsCount || 0) / maxItems) * 100 : 0;
                return (
                  <div key={tab.id}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-xs font-mono ${idx === 0 ? 'text-yellow-400' : idx === 1 ? 'text-gray-300' : idx === 2 ? 'text-orange-400' : 'text-gray-400'}`}>
                          #{idx + 1}
                        </span>
                        <span className="text-xs text-gray-300 truncate">{tab.name}</span>
                      </div>
                      <span className="text-xs text-blue-400 font-mono flex-shrink-0">{(tab.itemsCount || 0).toLocaleString()} items</span>
                    </div>
                    <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${idx === 0 ? 'bg-gradient-to-r from-yellow-500 to-yellow-400' : idx === 1 ? 'bg-gradient-to-r from-gray-400 to-gray-300' : idx === 2 ? 'bg-gradient-to-r from-orange-500 to-orange-400' : 'bg-blue-500/60'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Row 3: Success/Error bar */}
      {totalRequests > 0 && (
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700/50">
          <h3 className="text-sm font-semibold text-gray-200 mb-3"><TrendingUpIcon className="w-4 h-4 inline" /> Tỷ lệ thành công / thất bại</h3>
          <div className="h-6 bg-gray-700 rounded-full overflow-hidden flex">
            {stats.successCount > 0 && (
              <div
                className="h-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-500 flex items-center justify-center"
                style={{ width: `${(stats.successCount / totalRequests) * 100}%` }}
              >
                {stats.successCount / totalRequests > 0.15 && (
                  <span className="text-[10px] text-white font-semibold">{Math.round((stats.successCount / totalRequests) * 100)}%</span>
                )}
              </div>
            )}
            {stats.errorCount > 0 && (
              <div
                className="h-full bg-gradient-to-r from-red-500 to-red-400 transition-all duration-500 flex items-center justify-center"
                style={{ width: `${(stats.errorCount / totalRequests) * 100}%` }}
              >
                {stats.errorCount / totalRequests > 0.15 && (
                  <span className="text-[10px] text-white font-semibold">{Math.round((stats.errorCount / totalRequests) * 100)}%</span>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-between mt-2 text-[11px]">
            <span className="text-green-400">✓ Thành công: {stats.successCount}</span>
            <span className="text-red-400">✗ Thất bại: {stats.errorCount}</span>
          </div>
        </div>
      )}
    </div>
  );
}
