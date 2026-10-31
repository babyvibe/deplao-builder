import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import ipc from '@/lib/ipc';
import PageLoading, { Spinner } from '@/components/common/PageLoading';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { addLocalDays } from '../../../shared/analytics/localTimeBuckets';
import { ActivityIcon, ChartIcon, ChatIcon, ClipboardListIcon, ClockIcon, FolderIcon, InboxIcon, InfoIcon, PieChartIcon, RefreshIcon, TrendingUpIcon, UsersIcon } from '@/components/common/icons';



// ── Colors ──────────────────────────────────────────────────────────────────
const EMPLOYEE_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444',
  '#06b6d4', '#f97316', '#14b8a6', '#ec4899', '#84cc16',
  '#6366f1', '#a855f7', '#22d3ee', '#e11d48', '#facc15',
];

// ── Types ───────────────────────────────────────────────────────────────────
interface EmployeeComparisonRow {
  employee_id: string;
  display_name: string;
  avatar_url: string;
  role: string;
  is_active: number;
  group_id: string | null;
  messages_sent: number;
  conversations_handled: number;
  avg_response_time_ms: number;
  total_online_hours: number;
}

interface Props {
  sinceTs: number;
  untilTs: number;
  periodDays: number;
  /** Reports account filter: only activity on these accounts; undefined = every account. */
  zaloIds?: string[];
  /** Bumped by the page's "Làm mới" (closed ranges keep the same sinceTs / untilTs). */
  refreshKey?: number;
}

// ── Shared UI ───────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, color = 'blue' }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string; color?: string;
}) {
  const bg: Record<string, string> = {
    blue: 'from-blue-500/10 to-blue-600/5 border-blue-500/20',
    green: 'from-green-500/10 to-green-600/5 border-green-500/20',
    purple: 'from-purple-500/10 to-purple-600/5 border-purple-500/20',
    yellow: 'from-yellow-500/10 to-yellow-600/5 border-yellow-500/20',
    red: 'from-red-500/10 to-red-600/5 border-red-500/20',
    cyan: 'from-cyan-500/10 to-cyan-600/5 border-cyan-500/20',
    orange: 'from-orange-500/10 to-orange-600/5 border-orange-500/20',
    amber: 'from-amber-500/10 to-amber-600/5 border-amber-500/20',
  };
  return (
    <div className={`bg-gradient-to-br ${bg[color] || bg.blue} border rounded-xl p-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{icon}</span>
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold text-foreground">{typeof value === 'number' ? value.toLocaleString('vi-VN') : value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function Section({ title, children, className = '' }: { title: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card border border-foreground/5 rounded-2xl p-5 ${className}`}>
      <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-1.5">{title}</h3>
      {children}
    </div>
  );
}

function formatResponseTime(ms: number): string {
  if (!ms || ms <= 0) return '-';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

// ── MAIN COMPONENT ─────────────────────────────────────────────────────────
export default function EmployeeAnalyticsTab({ sinceTs, untilTs, periodDays, zaloIds, refreshKey = 0 }: Props) {
  const [loading, setLoading] = useState(true);
  const loadSeqRef = useRef(0);
  // Content key: a new array holding the same accounts must not reload.
  const zaloIdsKey = zaloIds ? JSON.stringify(zaloIds) : '';
  const [comparison, setComparison] = useState<EmployeeComparisonRow[]>([]);
  const [msgTimeline, setMsgTimeline] = useState<any[]>([]);
  const [onlineTimeline, setOnlineTimeline] = useState<any[]>([]);
  const [responseDist, setResponseDist] = useState<any[]>([]);
  const [hourlyActivity, setHourlyActivity] = useState<any[]>([]);

  // Multi-select: empty = all employees selected
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  const toggleEmployee = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // "all" means selectedIds is empty
  const isAll = selectedIds.size === 0;
  const filteredComparison = isAll ? comparison : comparison.filter(e => selectedIds.has(e.employee_id));

  // Derived selectedEmployeeId for legacy single-emp charts (use first selected or 'all')
  const selectedEmployeeId = isAll ? 'all' : (filteredComparison[0]?.employee_id || 'all');

  const loadData = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const accountFilter: string[] | undefined = zaloIdsKey ? JSON.parse(zaloIdsKey) : undefined;
      const [compRes, msgRes, onlRes, respRes, hourRes] = await Promise.all([
        ipc.employee?.analyticsComparison(sinceTs, untilTs, accountFilter),
        ipc.employee?.analyticsMessageTimeline(sinceTs, untilTs, accountFilter),
        // Online hours come from login sessions, which are not per account.
        ipc.employee?.analyticsOnlineTimeline(sinceTs, untilTs),
        ipc.employee?.analyticsResponseDist(sinceTs, untilTs, accountFilter),
        ipc.employee?.analyticsHourlyActivity(sinceTs, untilTs, accountFilter),
      ]);
      if (seq !== loadSeqRef.current) return; // a newer load (filter / range change) owns the state
      if (compRes?.success) setComparison(compRes.data || []);
      if (msgRes?.success) setMsgTimeline(msgRes.data || []);
      if (onlRes?.success) setOnlineTimeline(onlRes.data || []);
      if (respRes?.success) setResponseDist(respRes.data || []);
      if (hourRes?.success) setHourlyActivity(hourRes.data || []);
    } catch { /* silent */ }
    finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [sinceTs, untilTs, zaloIdsKey, refreshKey]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Employee color mapping ─────────────────────────────────────
  const empColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    comparison.forEach((emp, i) => { map[emp.employee_id] = EMPLOYEE_COLORS[i % EMPLOYEE_COLORS.length]; });
    return map;
  }, [comparison]);

  const empNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    comparison.forEach(emp => { map[emp.employee_id] = emp.display_name; });
    return map;
  }, [comparison]);

  // ── Totals (based on filtered) ─────────────────────────────────
  const totals = useMemo(() => filteredComparison.reduce(
    (acc, s) => ({
      messages_sent: acc.messages_sent + s.messages_sent,
      conversations: acc.conversations + s.conversations_handled,
      online_hours: acc.online_hours + s.total_online_hours,
    }),
    { messages_sent: 0, conversations: 0, online_hours: 0 }
  ), [filteredComparison]);

  const avgResponseTime = useMemo(() => {
    const withResponse = filteredComparison.filter(e => e.avg_response_time_ms > 0);
    if (withResponse.length === 0) return 0;
    return withResponse.reduce((sum, e) => sum + e.avg_response_time_ms, 0) / withResponse.length;
  }, [filteredComparison]);

  // ── Message timeline chart data ────────────────────────────────
  const msgTimelineChart = useMemo(() => {
    if (msgTimeline.length === 0 || filteredComparison.length === 0) return [];
    const maxDay = Math.max(...msgTimeline.map(r => r.day_index), 0);
    const rows: any[] = [];
    for (let d = 0; d <= maxDay; d++) {
      // day_index = local calendar days from the day of sinceTs (DatabaseService employee timelines).
      const date = new Date(addLocalDays(sinceTs, d));
      const label = `${date.getDate()}/${date.getMonth() + 1}`;
      const row: any = { day: label };
      for (const emp of filteredComparison) {
        const found = msgTimeline.find(r => r.employee_id === emp.employee_id && r.day_index === d);
        row[emp.employee_id] = found?.sent || 0;
      }
      rows.push(row);
    }
    return rows;
  }, [msgTimeline, filteredComparison, sinceTs]);

  // ── Online timeline chart data ────────────────────────────────
  const onlineTimelineChart = useMemo(() => {
    if (onlineTimeline.length === 0 || filteredComparison.length === 0) return [];
    const maxDay = Math.max(...onlineTimeline.map(r => r.day_index), 0);
    const rows: any[] = [];
    for (let d = 0; d <= maxDay; d++) {
      // day_index = local calendar days from the day of sinceTs (DatabaseService employee timelines).
      const date = new Date(addLocalDays(sinceTs, d));
      const label = `${date.getDate()}/${date.getMonth() + 1}`;
      const row: any = { day: label };
      for (const emp of filteredComparison) {
        const found = onlineTimeline.find(r => r.employee_id === emp.employee_id && r.day_index === d);
        row[emp.employee_id] = found?.online_hours || 0;
      }
      rows.push(row);
    }
    return rows;
  }, [onlineTimeline, filteredComparison, sinceTs]);

  // ── Horizontal bar comparison data ─────────────────────────────
  const barCompData = useMemo(() => {
    return filteredComparison
      .filter(e => e.messages_sent > 0 || e.conversations_handled > 0 || e.total_online_hours > 0)
      .sort((a, b) => b.messages_sent - a.messages_sent)
      .map(e => ({
        name: e.display_name,
        employee_id: e.employee_id,
        messages: e.messages_sent,
        conversations: e.conversations_handled,
        online: e.total_online_hours,
      }));
  }, [filteredComparison]);

  // ── Response time bar data ─────────────────────────────────────
  const responseBarData = useMemo(() => {
    return filteredComparison
      .filter(e => e.avg_response_time_ms > 0)
      .sort((a, b) => a.avg_response_time_ms - b.avg_response_time_ms)
      .map(e => ({
        name: e.display_name,
        employee_id: e.employee_id,
        avg_ms: e.avg_response_time_ms,
        display: formatResponseTime(e.avg_response_time_ms),
      }));
  }, [filteredComparison]);

  // ── Response distribution per employee ─────────────────────────
  const responseDistChart = useMemo(() => {
    const buckets = ['<1m', '1-5m', '5-15m', '15-30m', '30-60m', '1-4h', '4-24h', '>24h'];
    const filtered = isAll
      ? responseDist
      : responseDist.filter(r => selectedIds.has(r.employee_id));
    return buckets.map(bucket => ({
      bucket,
      count: filtered.filter(r => r.bucket === bucket).reduce((s, r) => s + r.count, 0),
    }));
  }, [responseDist, selectedIds, isAll]);

  // ── Hourly activity chart data ─────────────────────────────────
  const hourlyChart = useMemo(() => {
    const rows: any[] = [];
    for (let h = 0; h < 24; h++) {
      const filtered = isAll
        ? hourlyActivity.filter(r => r.hour === h)
        : hourlyActivity.filter(r => r.hour === h && selectedIds.has(r.employee_id));
      rows.push({ hour: `${h}h`, count: filtered.reduce((s, r) => s + r.count, 0) });
    }
    return rows;
  }, [hourlyActivity, selectedIds, isAll]);

  // ── Pie data: message share ────────────────────────────────────
  const msgPieData = useMemo(() => {
    return filteredComparison
      .filter(e => e.messages_sent > 0)
      .map((e, i) => ({
        name: e.display_name,
        value: e.messages_sent,
        fill: EMPLOYEE_COLORS[comparison.findIndex(c => c.employee_id === e.employee_id) % EMPLOYEE_COLORS.length],
      }));
  }, [filteredComparison, comparison]);

  // ── Pie data: online hours share ───────────────────────────────
  const onlinePieData = useMemo(() => {
    return filteredComparison
      .filter(e => e.total_online_hours > 0)
      .map((e, i) => ({
        name: e.display_name,
        value: e.total_online_hours,
        fill: EMPLOYEE_COLORS[comparison.findIndex(c => c.employee_id === e.employee_id) % EMPLOYEE_COLORS.length],
      }));
  }, [filteredComparison, comparison]);

  // ── Radar data ─────────────────────────────────────────────────
  const radarData = useMemo(() => {
    if (filteredComparison.length === 0) return [];
    const maxMsg = Math.max(1, ...filteredComparison.map(e => e.messages_sent));
    const maxConv = Math.max(1, ...filteredComparison.map(e => e.conversations_handled));
    const maxOnline = Math.max(1, ...filteredComparison.map(e => e.total_online_hours));
    const maxRT = Math.max(1, ...filteredComparison.filter(e => e.avg_response_time_ms > 0).map(e => e.avg_response_time_ms));
    const metrics = ['Tin gửi', 'Hội thoại', 'Online (h)', 'Tốc độ PH'];
    return metrics.map(metric => {
      const row: any = { metric };
      for (const emp of filteredComparison) {
        let val = 0;
        if (metric === 'Tin gửi') val = (emp.messages_sent / maxMsg) * 100;
        else if (metric === 'Hội thoại') val = (emp.conversations_handled / maxConv) * 100;
        else if (metric === 'Online (h)') val = (emp.total_online_hours / maxOnline) * 100;
        else if (metric === 'Tốc độ PH') val = emp.avg_response_time_ms > 0 ? ((1 - emp.avg_response_time_ms / maxRT) * 100) : 0;
        row[emp.employee_id] = Math.max(0, Math.round(val));
      }
      return row;
    });
  }, [filteredComparison]);

  // ── Export CSV ─────────────────────────────────────────────────
  const handleExportCSV = () => {
    const headers = ['Nhân viên', 'Vai trò', 'Tin gửi', 'TB phản hồi', 'Hội thoại', 'Online (giờ)'];
    const rows = filteredComparison.map(s => [
      s.display_name, s.role, s.messages_sent,
      formatResponseTime(s.avg_response_time_ms), s.conversations_handled, s.total_online_hours,
    ]);
    rows.push(['TỔNG', '', totals.messages_sent, '-', totals.conversations, totals.online_hours]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BaoCao_NhanVien_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <PageLoading variant="skeleton" skeletonVariant="cards" text="Đang tải thống kê nhân viên..." />;

  if (comparison.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <span className="text-4xl mb-3"><UsersIcon className="w-4 h-4" /></span>
        <p className="text-sm">Chưa có nhân viên nào. Vào <span className="text-blue-400">Cài đặt → Nhân viên</span> để thêm.</p>
      </div>
    );
  }

  const filterLabel = isAll
    ? 'Tất cả nhân viên'
    : `${selectedIds.size} nhân viên`;

  return (
    <div className="space-y-5">
      {/* ── Filter bar ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Multi-select employee filter */}
        <div className="relative" ref={filterRef}>
          <button
            onClick={() => setFilterOpen(o => !o)}
            className="flex items-center gap-2 bg-muted/60 border border-input rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:border-blue-500 transition-colors focus:outline-none"
          >
            <span className="text-muted-foreground">Nhân viên:</span>
            {/* Stacked avatars */}
            <div className="flex -space-x-1.5">
              {(isAll ? comparison : comparison.filter(e => selectedIds.has(e.employee_id))).slice(0, 4).map((emp) => (
                <div key={emp.employee_id}
                  className="w-5 h-5 rounded-full border border-border bg-accent flex items-center justify-center text-[9px] overflow-hidden flex-shrink-0"
                  style={{ borderColor: empColorMap[emp.employee_id] }}>
                  {emp.avatar_url
                    ? <img src={emp.avatar_url} className="w-full h-full object-cover" alt="" />
                    : <span className="text-foreground/80">{emp.display_name?.charAt(0)?.toUpperCase()}</span>}
                </div>
              ))}
            </div>
            <span className="font-medium text-foreground">{filterLabel}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-muted-foreground ml-0.5">
              <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            </svg>
          </button>

          {filterOpen && (
            <div className="absolute left-0 top-full mt-1.5 w-64 bg-card border border-input rounded-xl shadow-2xl z-50 overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wide">Lọc nhân viên</span>
                <button onClick={() => setSelectedIds(new Set())}
                  className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
                  Tất cả
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto py-1">
                {comparison.map(emp => {
                  const checked = isAll || selectedIds.has(emp.employee_id);
                  return (
                    <button
                      key={emp.employee_id}
                      onClick={() => toggleEmployee(emp.employee_id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted/60 transition-colors ${checked && !isAll ? 'bg-blue-600/10' : ''}`}
                    >
                      {/* Checkbox */}
                      <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border ${selectedIds.has(emp.employee_id) ? 'bg-blue-600 border-blue-600' : 'border-border-strong bg-transparent'}`}>
                        {selectedIds.has(emp.employee_id) && (
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="white">
                            <path d="M1.5 5.5l2.5 2.5 5-5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      {/* Avatar */}
                      <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-[10px] flex-shrink-0 overflow-hidden"
                        style={{ borderLeft: `3px solid ${empColorMap[emp.employee_id]}` }}>
                        {emp.avatar_url
                          ? <img src={emp.avatar_url} className="w-full h-full object-cover" alt="" />
                          : <span className="text-foreground/80">{emp.display_name?.charAt(0)?.toUpperCase()}</span>}
                      </div>
                      {/* Name + role */}
                      <div className="flex-1 text-left min-w-0">
                        <p className="text-xs text-foreground font-medium truncate">{emp.display_name}</p>
                        <p className="text-[9px] text-muted-foreground">{emp.role === 'boss' ? 'Boss' : 'Nhân viên'}{!emp.is_active ? ' · Tắt' : ''}</p>
                      </div>
                      {/* Color dot */}
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: empColorMap[emp.employee_id] }} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1" />
        <button
          onClick={handleExportCSV}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2.5 py-1.5 rounded-lg hover:bg-muted border border-border transition-colors"
        ><InboxIcon className="w-4 h-4 inline" /> Xuất CSV
        </button>
        <button
          onClick={loadData}
          disabled={loading}
          className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-lg hover:bg-muted transition-colors"
          title="Làm mới"
        >
          {loading ? <Spinner size={3} /> : <RefreshIcon className="w-4 h-4" />}
        </button>
      </div>

      {zaloIds && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <InfoIcon className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            Tin gửi, hội thoại, thời gian phản hồi và hoạt động theo giờ chỉ tính trên {zaloIds.length} tài khoản đã chọn.
            Giờ online tính theo phiên đăng nhập của nhân viên, không tách theo tài khoản.
          </span>
        </p>
      )}

      {/* ── KPI Summary ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon={<UsersIcon className="w-4 h-4" />} label="Nhân viên" value={filteredComparison.length}
          sub={`${filteredComparison.filter(e => e.is_active).length} hoạt động`} color="blue" />
        <KPICard icon={<ChatIcon className="w-4 h-4" />} label="Tổng tin gửi" value={totals.messages_sent}
          sub={`${periodDays} ngày`} color="green" />
        <KPICard icon={<FolderIcon className="w-4 h-4" />} label="Hội thoại xử lý" value={totals.conversations}
          sub="tổng cộng" color="purple" />
        <KPICard icon={<ClockIcon className="w-4 h-4" />} label="TB phản hồi" value={formatResponseTime(avgResponseTime)}
          sub="trung bình team" color="cyan" />
        <KPICard icon={<ClockIcon className="w-4 h-4" />} label="Tổng giờ online" value={`${totals.online_hours}h`}
          sub={`TB ${filteredComparison.length > 0 ? (totals.online_hours / filteredComparison.length).toFixed(1) : 0}h/NV`} color="amber" />
      </div>

      {/* ── Row 1: Comparison bars + Pie charts ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Bar: Messages per employee */}
        <Section title={<><ChartIcon className="w-4 h-4" />  So sánh tin nhắn & hội thoại</>}>
          {barCompData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barCompData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#d1d5db', fontSize: 11 }} width={80} />
                  <Tooltip content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-foreground font-medium mb-1">{d.name}</p>
                        <p className="text-blue-400"><ChatIcon className="w-4 h-4 inline" /> {d.messages} tin gửi</p>
                        <p className="text-green-400"><FolderIcon className="w-4 h-4 inline" /> {d.conversations} hội thoại</p>
                        <p className="text-amber-400"><ClockIcon className="w-4 h-4 inline" /> {d.online}h online</p>
                      </div>
                    );
                  }} />
                  <Bar dataKey="messages" name="Tin gửi" fill="#3b82f6" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  <Bar dataKey="conversations" name="Hội thoại" fill="#10b981" radius={[0, 4, 4, 0]} maxBarSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        {/* Pie: Message share + Online share */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Section title={<><PieChartIcon className="w-4 h-4" />  Phân bổ tin nhắn</>}>
            {msgPieData.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
            ) : (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={msgPieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                      innerRadius={35} outerRadius={65} paddingAngle={3} strokeWidth={0}>
                      {msgPieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const total = msgPieData.reduce((s, p) => s + p.value, 0);
                      const pct = total > 0 ? Math.round(d.value / total * 100) : 0;
                      return (
                        <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-foreground font-medium">{d.name}</p>
                          <p className="text-blue-400 font-bold">{d.value} tin ({pct}%)</p>
                        </div>
                      );
                    }} />
                    <Legend formatter={(v: string) => <span className="text-[10px] text-muted-foreground">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>

          <Section title={<><ClockIcon className="w-4 h-4" />  Phân bổ giờ online</>}>
            {onlinePieData.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
            ) : (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={onlinePieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                      innerRadius={35} outerRadius={65} paddingAngle={3} strokeWidth={0}>
                      {onlinePieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const total = onlinePieData.reduce((s, p) => s + p.value, 0);
                      const pct = total > 0 ? Math.round(d.value / total * 100) : 0;
                      return (
                        <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-foreground font-medium">{d.name}</p>
                          <p className="text-amber-400 font-bold">{d.value}h ({pct}%)</p>
                        </div>
                      );
                    }} />
                    <Legend formatter={(v: string) => <span className="text-[10px] text-muted-foreground">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* ── Row 2: Message timeline + Online timeline ────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title={<><TrendingUpIcon className="w-4 h-4" />  Tin nhắn theo ngày (so sánh nhân viên)</>}>
          {msgTimelineChart.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={msgTimelineChart} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-muted-foreground mb-1 font-medium">{label}</p>
                        {payload.map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.stroke || p.fill }} />
                            <span className="text-foreground/80">{empNameMap[p.dataKey] || p.dataKey}</span>
                            <span className="font-bold text-foreground ml-auto">{p.value}</span>
                          </div>
                        ))}
                      </div>
                    );
                  }} />
                  {filteredComparison.map(emp => (
                    <Area key={emp.employee_id} type="monotone" dataKey={emp.employee_id}
                      name={emp.display_name} stroke={empColorMap[emp.employee_id]}
                      fill={empColorMap[emp.employee_id]} fillOpacity={0.1} strokeWidth={2} dot={false} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title={<><ClockIcon className="w-4 h-4" />  Giờ online theo ngày (so sánh nhân viên)</>}>
          {onlineTimelineChart.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={onlineTimelineChart} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} unit="h" />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-muted-foreground mb-1 font-medium">{label}</p>
                        {payload.filter((p: any) => p.value > 0).map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.fill }} />
                            <span className="text-foreground/80">{empNameMap[p.dataKey] || p.dataKey}</span>
                            <span className="font-bold text-foreground ml-auto">{p.value}h</span>
                          </div>
                        ))}
                      </div>
                    );
                  }} />
                  {filteredComparison.map(emp => (
                    <Bar key={emp.employee_id} dataKey={emp.employee_id} stackId="online"
                      name={emp.display_name} fill={empColorMap[emp.employee_id]}
                      radius={[2, 2, 0, 0]} maxBarSize={30} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* ── Row 3: Response time comparison + Radar ───────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title={<><ClockIcon className="w-4 h-4" />  Xếp hạng tốc độ phản hồi</>}>
          {responseBarData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu phản hồi</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={responseBarData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }}
                    tickFormatter={(v: number) => formatResponseTime(v)} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#d1d5db', fontSize: 11 }} width={80} />
                  <Tooltip content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-foreground font-medium">{d.name}</p>
                        <p className={`font-bold ${d.avg_ms < 300000 ? 'text-green-400' : d.avg_ms < 900000 ? 'text-amber-400' : 'text-red-400'}`}>
                          ⏱️ TB: {d.display}
                        </p>
                      </div>
                    );
                  }} />
                  <Bar dataKey="avg_ms" name="TB phản hồi" radius={[0, 4, 4, 0]} maxBarSize={16}>
                    {responseBarData.map((d, i) => (
                      <Cell key={i} fill={d.avg_ms < 300000 ? '#10b981' : d.avg_ms < 900000 ? '#f59e0b' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title={<><ActivityIcon className="w-4 h-4" />  So sánh đa chiều nhân viên</>}>
          {radarData.length === 0 || filteredComparison.length < 2 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Cần ít nhất 2 nhân viên có dữ liệu</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
                  <PolarGrid stroke="#374151" />
                  <PolarAngleAxis dataKey="metric" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} />
                  {filteredComparison.slice(0, 6).map(emp => (
                    <Radar key={emp.employee_id} name={emp.display_name}
                      dataKey={emp.employee_id}
                      stroke={empColorMap[emp.employee_id]}
                      fill={empColorMap[emp.employee_id]}
                      fillOpacity={0.15} strokeWidth={2} />
                  ))}
                  <Legend formatter={(v: string) => <span className="text-[10px] text-muted-foreground">{v}</span>} />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-muted-foreground mb-1 font-medium">{label}</p>
                        {payload.map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.stroke }} />
                            <span className="text-foreground/80">{p.name}</span>
                            <span className="font-bold text-foreground ml-auto">{p.value}%</span>
                          </div>
                        ))}
                      </div>
                    );
                  }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* ── Row 4: Response distribution + Hourly activity ────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title={<><ChartIcon className="w-4 h-4" /> Phân bổ thời gian phản hồi{!isAll ? ` - ${filterLabel}` : ''}</>}>
          {responseDistChart.every(r => r.count === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={responseDistChart} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="bucket" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-muted-foreground mb-1">{label}</p>
                        <p className="text-foreground font-bold">{payload[0].value} lượt</p>
                      </div>
                    );
                  }} />
                  <Bar dataKey="count" name="Số lượt" radius={[4, 4, 0, 0]} maxBarSize={28}>
                    {responseDistChart.map((_, i) => {
                      const colors = ['#10b981', '#10b981', '#3b82f6', '#f59e0b', '#f59e0b', '#ef4444', '#ef4444', '#991b1b'];
                      return <Cell key={i} fill={colors[i]} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title={<><ClockIcon className="w-4 h-4" /> Hoạt động theo giờ{!isAll ? ` - ${filterLabel}` : ''}</>}>
          {hourlyChart.every(r => r.count === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyChart} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="hour" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-muted-foreground mb-1">{label}</p>
                        <p className="text-foreground font-bold">{payload[0].value} tin nhắn</p>
                      </div>
                    );
                  }} />
                  <Bar dataKey="count" name="Tin nhắn" fill="#8b5cf6" radius={[3, 3, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* ── Row 5: Detailed table ────────────────────────────────── */}
      <Section title={<><ClipboardListIcon className="w-4 h-4" /> Bảng chi tiết nhân viên</>}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left py-2.5 px-3 font-medium">#</th>
                <th className="text-left py-2.5 px-3 font-medium">Nhân viên</th>
                <th className="text-left py-2.5 px-3 font-medium">Vai trò</th>
                <th className="text-right py-2.5 px-3 font-medium">Tin gửi</th>
                <th className="text-right py-2.5 px-3 font-medium">Hội thoại</th>
                <th className="text-right py-2.5 px-3 font-medium">TB phản hồi</th>
                <th className="text-right py-2.5 px-3 font-medium">Online</th>
                <th className="text-right py-2.5 px-3 font-medium">Hiệu suất</th>
              </tr>
            </thead>
            <tbody>
              {filteredComparison.map((emp, idx) => {
                const maxMsg = Math.max(1, ...filteredComparison.map(e => e.messages_sent));
                const perf = maxMsg > 0 ? Math.round(emp.messages_sent / maxMsg * 100) : 0;
                return (
                  <tr key={emp.employee_id}
                    className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${!emp.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-2.5 px-3 text-muted-foreground font-mono">{idx + 1}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-[10px] flex-shrink-0 overflow-hidden"
                          style={{ borderLeft: `3px solid ${empColorMap[emp.employee_id]}` }}>
                          {emp.avatar_url ? (
                            <img src={toLocalMediaUrl(emp.avatar_url)} className="w-full h-full object-cover" alt="" />
                          ) : (
                            <span className="text-foreground/80">{emp.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                          )}
                        </div>
                        <div>
                          <span className="text-foreground font-medium">{emp.display_name}</span>
                          {!emp.is_active && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-red-600/25 text-red-400">Tắt</span>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${emp.role === 'boss' ? 'bg-amber-600/25 text-amber-400' : 'bg-accent/40 text-muted-foreground'}`}>
                        {emp.role === 'boss' ? 'Boss' : 'NV'}
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 text-foreground/80 font-mono font-medium">{emp.messages_sent.toLocaleString('vi-VN')}</td>
                    <td className="text-right py-2.5 px-3 text-foreground/80 font-mono">{emp.conversations_handled}</td>
                    <td className="text-right py-2.5 px-3">
                      <span className={`font-medium ${emp.avg_response_time_ms > 300_000 ? 'text-red-400' : emp.avg_response_time_ms > 120_000 ? 'text-amber-400' : emp.avg_response_time_ms > 0 ? 'text-green-400' : 'text-muted-foreground'}`}>
                        {formatResponseTime(emp.avg_response_time_ms)}
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 text-foreground/80">{emp.total_online_hours}h</td>
                    <td className="text-right py-2.5 px-3">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${perf}%`, backgroundColor: empColorMap[emp.employee_id] }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">{perf}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* Totals */}
              <tr className="border-t border-input font-semibold bg-muted/20">
                <td className="py-2.5 px-3" colSpan={2}>
                  <span className="text-foreground/80">Tổng ({filteredComparison.length} NV)</span>
                </td>
                <td className="py-2.5 px-3" />
                <td className="text-right py-2.5 px-3 text-blue-400 font-mono">{totals.messages_sent.toLocaleString('vi-VN')}</td>
                <td className="text-right py-2.5 px-3 text-green-400 font-mono">{totals.conversations}</td>
                <td className="text-right py-2.5 px-3 text-cyan-400">{formatResponseTime(avgResponseTime)}</td>
                <td className="text-right py-2.5 px-3 text-amber-400">{totals.online_hours}h</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

