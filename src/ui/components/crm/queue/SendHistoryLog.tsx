import DateInputVN from '@/components/common/DateInputVN';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { formatPhone } from '@/utils/phoneUtils';

interface SendLogEntry {
  id: number;
  owner_zalo_id: string;
  contact_id: string;
  display_name: string;
  phone: string;
  contact_type: string;
  campaign_id: number | null;
  message: string;
  sent_at: number;
  status: 'sent' | 'failed';
  error: string;
  send_type: string;
  data_request?: string;
  data_response?: string;
}

interface SendHistoryLogProps {
  campaigns?: Array<{ id: number; name: string }>;
}

function oneMonthAgo(): string {
  const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().split('T')[0];
}
function today(): string { return new Date().toISOString().split('T')[0]; }

function escapeCSV(val: any): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function tryFmtJson(raw: string | undefined): string {
  if (!raw?.trim()) return '(trống)';
  try { return JSON.stringify(JSON.parse(raw), null, 2); }
  catch { return raw; }
}

// ── Debug modal ──────────────────────────────────────────────────────────────
function DebugModal({ log, onClose }: { log: SendLogEntry; onClose: () => void }) {
  const campName = log.campaign_id ? `#${log.campaign_id}` : '—';
  const fmt = (ts: number) => ts
    ? new Date(ts).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '-';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-600 rounded-2xl w-[680px] max-w-[96vw] max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-700 flex-shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-white">🔍 Debug Log #{log.id}</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {log.display_name || log.contact_id}
              {log.phone ? ` · ${formatPhone(log.phone)}` : ''}
              {' · '}Chiến dịch {campName}
              {' · '}{fmt(log.sent_at)}
            </p>
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Meta row */}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 rounded-lg bg-gray-700 text-gray-300">
              UID: <span className="text-white font-mono">{log.contact_id}</span>
            </span>
            <span className={`px-2 py-1 rounded-lg font-medium ${
              log.status === 'sent' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
            }`}>
              {log.status === 'sent' ? '✓ Đã gửi' : '✕ Lỗi'}
            </span>
            {log.send_type && (
              <span className="px-2 py-1 rounded-lg bg-blue-500/15 text-blue-300">{log.send_type}</span>
            )}
            {log.error && (
              <span className="flex-1 px-2 py-1 rounded-lg bg-red-500/10 text-red-400 truncate">⚠ {log.error}</span>
            )}
          </div>

          {/* Message */}
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1.5">Nội dung gửi</p>
            <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-xs text-gray-200 whitespace-pre-wrap break-all">
              {log.message || '(trống)'}
            </div>
          </div>

          {/* Request */}
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1.5">Data Request</p>
            <pre className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-[11px] text-green-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto">
              {tryFmtJson(log.data_request)}
            </pre>
          </div>

          {/* Response */}
          <div>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide mb-1.5">Data Response</p>
            <pre className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-[11px] text-blue-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto">
              {tryFmtJson(log.data_response)}
            </pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="w-full py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function SendHistoryLog(_props: SendHistoryLogProps) {
  const { activeAccountId } = useAccountStore();
  const [logs, setLogs] = useState<SendLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [allCampaigns, setAllCampaigns] = useState<Array<{ id: number; name: string; campaign_type: string }>>([]);
  const [debugLog, setDebugLog] = useState<SendLogEntry | null>(null);

  const [filterCampaignName, setFilterCampaignName] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'sent' | 'failed'>('all');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterSendType, setFilterSendType] = useState<'all' | 'message' | 'friend_request' | 'invite_to_group'>('all');
  const [dateFrom, setDateFrom] = useState(oneMonthAgo);
  const [dateTo, setDateTo] = useState(today);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const campaignInputRef = useRef<HTMLDivElement>(null);
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const campaignMap = useMemo(() =>
    Object.fromEntries(allCampaigns.map(c => [c.id, { name: c.name, campaign_type: c.campaign_type || 'message' }])),
    [allCampaigns]
  );

  const suggestions = useMemo(() => {
    if (!filterCampaignName.trim()) return [];
    const q = filterCampaignName.toLowerCase();
    return allCampaigns.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [filterCampaignName, allCampaigns]);

  // Close suggestions on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (campaignInputRef.current && !campaignInputRef.current.contains(e.target as Node))
        setShowSuggestions(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const loadData = useCallback(async () => {
    if (!activeAccountId) return;
    setLoading(true);
    // Load logs + all campaigns in parallel
    const [logsRes, campsRes] = await Promise.all([
      ipc.crm?.getSendLog({ zaloId: activeAccountId, opts: { limit: 2000 } }),
      ipc.crm?.getCampaigns({ zaloId: activeAccountId }),
    ]);
    if (logsRes?.success) setLogs(logsRes.logs);
    if (campsRes?.success) setAllCampaigns(campsRes.campaigns.map((c: any) => ({ id: c.id, name: c.name, campaign_type: c.campaign_type || 'message' })));
    setLoading(false);
    setPage(0);
  }, [activeAccountId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh when queue sends a message
  useEffect(() => {
    const unsub = ipc.on?.('crm:queueUpdate', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
      reloadDebounceRef.current = setTimeout(() => loadData(), 3000);
    });
    return () => {
      unsub?.();
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    };
  }, [activeAccountId, loadData]);

  const fmt = (ts: number) => ts
    ? new Date(ts).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '-';

  const selectCampaign = (c: { id: number; name: string }) => {
    setFilterCampaignName(c.name); setSelectedCampaignId(c.id); setShowSuggestions(false); setPage(0);
  };
  const clearCampaignFilter = () => { setFilterCampaignName(''); setSelectedCampaignId(null); setPage(0); };
  const handleCampaignInput = (val: string) => {
    setFilterCampaignName(val); setSelectedCampaignId(null); setShowSuggestions(true); setPage(0);
  };

  // ── Filter logic (dùng log.send_type trực tiếp, không còn case 'mixed') ──
  const filtered = logs.filter(log => {
    if (filterStatus !== 'all' && log.status !== filterStatus) return false;
    if (filterSearch.trim()) {
      const q = filterSearch.toLowerCase();
      if (
        !log.contact_id.toLowerCase().includes(q) &&
        !(log.display_name || '').toLowerCase().includes(q) &&
        !(log.phone || '').includes(q) &&
        !log.message.toLowerCase().includes(q)
      ) return false;
    }
    if (selectedCampaignId !== null) {
      if (log.campaign_id !== selectedCampaignId) return false;
    } else if (filterCampaignName.trim()) {
      const name = campaignMap[log.campaign_id ?? -1]?.name || '';
      if (!name.toLowerCase().includes(filterCampaignName.toLowerCase())) return false;
    }
    if (filterSendType !== 'all') {
      const st = log.send_type || 'message';
      if (st !== filterSendType) return false;
    }
    if (dateFrom) {
      if (log.sent_at < new Date(dateFrom).setHours(0, 0, 0, 0)) return false;
    }
    if (dateTo) {
      if (log.sent_at > new Date(dateTo).setHours(23, 59, 59, 999)) return false;
    }
    return true;
  });

  const exportToCSV = useCallback(() => {
    if (filtered.length === 0) return;
    const headers = ['ID', 'Người nhận', 'SĐT', 'UID', 'Loại liên hệ', 'Chiến dịch', 'Nội dung', 'Loại gửi', 'Trạng thái', 'Lỗi', 'Thời gian'];
    const rows = filtered.map(log => {
      const campInfo = campaignMap[log.campaign_id ?? -1];
      const st = log.send_type || 'message';
      const stLabel = st === 'friend_request' ? 'Kết bạn' : st === 'invite_to_group' ? 'Mời vào nhóm' : 'Tin nhắn';
      return [
        log.id,
        escapeCSV(log.display_name || log.contact_id),
        escapeCSV(log.phone ? formatPhone(log.phone) : ''),
        escapeCSV(log.contact_id),
        log.contact_type === 'group' ? 'Nhóm' : 'Người dùng',
        escapeCSV(campInfo?.name || (log.campaign_id ? `#${log.campaign_id}` : '')),
        escapeCSV(log.message),
        stLabel,
        log.status === 'sent' ? 'Đã gửi' : 'Lỗi',
        escapeCSV(log.error || ''),
        fmt(log.sent_at),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lich_su_gui_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filtered, campaignMap, fmt]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const sentCount = logs.filter(l => l.status === 'sent').length;
  const failedCount = logs.filter(l => l.status === 'failed').length;

  return (
    <div className="flex flex-col h-full">
      {/* Debug modal */}
      {debugLog && <DebugModal log={debugLog} onClose={() => setDebugLog(null)} />}

      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-700 flex-shrink-0">
        <h3 className="text-sm font-semibold text-white">📋 Lịch sử gửi</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-green-400">{sentCount} đã gửi</span>
          {failedCount > 0 && <span className="text-red-400">{failedCount} lỗi</span>}
          <span className="text-gray-500">/ {logs.length} tổng</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {filtered.length > 0 && (
            <button onClick={exportToCSV}
              title={`Xuất ${filtered.length} dòng đang hiển thị ra CSV`}
              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors border border-gray-600 hover:border-gray-500">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Xuất CSV
            </button>
          )}
          <button onClick={loadData} className="text-xs text-gray-400 hover:text-white transition-colors">↻ Tải lại</button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-700 flex-shrink-0 flex-wrap">
        {/* Search */}
        <div className="relative">
          <svg width="12" height="12" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={filterSearch} onChange={e => { setFilterSearch(e.target.value); setPage(0); }}
            placeholder="Tên, SĐT, UID, nội dung..."
            className="bg-gray-700 border border-gray-600 rounded-full pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 w-44" />
        </div>

        {/* Campaign autocomplete */}
        <div ref={campaignInputRef} className="relative">
          <div className="flex items-center bg-gray-700 border border-gray-600 rounded-full overflow-hidden focus-within:border-blue-500 transition-colors">
            <input value={filterCampaignName}
              onChange={e => handleCampaignInput(e.target.value)}
              onFocus={() => { if (filterCampaignName.trim()) setShowSuggestions(true); }}
              placeholder="Tên chiến dịch..."
              className="bg-transparent pl-3 pr-1 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none w-36" />
            {filterCampaignName && (
              <button onClick={clearCampaignFilter} className="pr-2.5 text-gray-500 hover:text-white text-xs flex-shrink-0">✕</button>
            )}
          </div>
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[200px] max-h-48 overflow-y-auto">
              {suggestions.map(c => (
                <button key={c.id} onClick={() => selectCampaign(c)}
                  className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors truncate">
                  📢 {c.name}
                </button>
              ))}
            </div>
          )}
          {showSuggestions && filterCampaignName.trim() && suggestions.length === 0 && (
            <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 px-3 py-2 min-w-[200px]">
              <p className="text-xs text-gray-500">Không tìm thấy chiến dịch</p>
            </div>
          )}
        </div>

        {/* Date range */}
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span className="flex-shrink-0">Từ</span>
          <DateInputVN value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(0); }}
            className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 w-32" />
          <span className="flex-shrink-0">→</span>
          <DateInputVN value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(0); }}
            className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 w-32" />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setPage(0); }}
              className="text-gray-500 hover:text-white text-xs" title="Xóa lọc ngày">✕</button>
          )}
        </div>

        {/* Status filter */}
        <select
          value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value as typeof filterStatus); setPage(0); }}
          className="bg-gray-700 border border-gray-600 rounded-full text-xs text-gray-300 px-2.5 py-1.5 focus:outline-none focus:border-blue-500 flex-shrink-0">
          <option value="all">Tất cả trạng thái</option>
          <option value="sent">✓ Đã gửi</option>
          <option value="failed">✕ Lỗi</option>
        </select>

        {/* Send type filter */}
        <select
          value={filterSendType}
          onChange={e => { setFilterSendType(e.target.value as typeof filterSendType); setPage(0); }}
          className="bg-gray-700 border border-gray-600 rounded-full text-xs text-gray-300 px-2.5 py-1.5 focus:outline-none focus:border-blue-500 flex-shrink-0">
          <option value="all">Tất cả loại</option>
          <option value="message">💬 Tin nhắn</option>
          <option value="friend_request">🤝 Kết bạn</option>
          <option value="invite_to_group">👥 Mời nhóm</option>
        </select>

        <span className="ml-auto text-xs text-gray-500">{filtered.length} kết quả</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-5 space-y-2">{[...Array(8)].map((_, i) => <div key={i} className="h-9 bg-gray-700/50 rounded animate-pulse" />)}</div>
        ) : paged.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 py-16">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z"/>
            </svg>
            <p className="text-sm">Không có lịch sử gửi</p>
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo(''); setPage(0); }}
                className="mt-2 text-xs text-blue-400 hover:text-blue-300">Xóa lọc ngày →</button>
            )}
          </div>
        ) : (
          <>
            {/* Column headers — added debug col at end */}
            <div className="grid grid-cols-[1fr_2fr_1fr_90px_80px_28px] gap-2 px-5 py-2 text-[11px] text-gray-500 border-b border-gray-700 sticky top-0 bg-gray-900 z-10">
              <span>Người nhận</span>
              <span>Nội dung</span>
              <span>Chiến dịch</span>
              <span>Loại gửi</span>
              <span className="text-right">Trạng thái / Giờ</span>
              <span />
            </div>
            {paged.map(log => {
              const campInfo = campaignMap[log.campaign_id ?? -1];
              const campaignName = campInfo?.name;
              // Always use log.send_type directly — mixed campaigns now log each action separately
              const sendType = log.send_type || 'message';
              const recipientName = log.display_name || log.contact_id;
              const phone = log.phone ? formatPhone(log.phone) : '';
              return (
                <div key={log.id}
                  className={`grid grid-cols-[1fr_2fr_1fr_90px_80px_28px] gap-2 px-5 py-2.5 border-b border-gray-700/50 text-xs hover:bg-gray-800/50 transition-colors group ${
                    log.status === 'failed' ? 'bg-red-500/5' : ''
                  }`}>
                  {/* Recipient */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-gray-300 truncate font-medium">{recipientName}</p>
                      {log.contact_type === 'group' && (
                        <span className="text-[9px] text-purple-400 flex-shrink-0 bg-purple-400/10 px-1 rounded">nhóm</span>
                      )}
                    </div>
                    {phone && <p className="text-gray-500 text-[11px] truncate">{phone}</p>}
                    {!log.display_name && <p className="text-gray-600 font-mono text-[11px] truncate">{log.contact_id}</p>}
                  </div>
                  {/* Message */}
                  <div className="min-w-0">
                    <p className="text-gray-200 truncate">{log.message}</p>
                    {log.error && <p className="text-red-400 text-[11px] truncate">⚠ {log.error}</p>}
                  </div>
                  {/* Campaign */}
                  <span className="text-gray-500 truncate self-center">
                    {campaignName || (log.campaign_id ? `#${log.campaign_id} - Đã xoá` : '—')}
                  </span>
                  {/* Send type badge — 3 types only */}
                  <span className="flex-shrink-0 self-center">
                    {sendType === 'friend_request' ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">🤝 Kết bạn</span>
                    ) : sendType === 'invite_to_group' ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">👥 Mời nhóm</span>
                    ) : (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">💬 Tin nhắn</span>
                    )}
                  </span>
                  {/* Status + time */}
                  <div className="text-right self-center">
                    <div className="flex items-center justify-center">
                        <span className={`block font-medium ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                          {log.status === 'sent' ? '✓ Đã gửi' : '✕ Thất bại'}
                        </span>
                        <span>
                        <button
                            onClick={() => setDebugLog(log)}
                            title="Xem data request / response"
                            className="opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 rounded flex items-center justify-center text-gray-500 hover:text-blue-400 hover:bg-blue-500/10">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="16 18 22 12 16 6"/>
                            <polyline points="8 6 2 12 8 18"/>
                          </svg>
                        </button>
                      </span>
                    </div>
                    <span className="text-[11px] text-gray-600">{fmt(log.sent_at)}</span>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-gray-700 flex-shrink-0">
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
