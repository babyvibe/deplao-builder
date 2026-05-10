import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, RadarChart, Radar,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';

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
}

// ── Shared UI ───────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, color = 'blue' }: {
  icon: string; label: string; value: string | number; sub?: string; color?: string;
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
        <span className="text-xs text-gray-400 font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold text-white">{typeof value === 'number' ? value.toLocaleString('vi-VN') : value}</span>
      {sub && <span className="text-[11px] text-gray-500">{sub}</span>}
    </div>
  );
}

function Section({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-gray-800/60 border border-white/5 rounded-2xl p-5 ${className}`}>
      <h3 className="text-sm font-semibold text-gray-200 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function formatResponseTime(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-24 bg-gray-700/30 rounded-xl animate-pulse" />
      ))}
    </div>
  );
}

// ── MAIN COMPONENT ─────────────────────────────────────────────────────────
export default function EmployeeAnalyticsTab({ sinceTs, untilTs, periodDays }: Props) {
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    try {
      const [compRes, msgRes, onlRes, respRes, hourRes] = await Promise.all([
        ipc.employee?.analyticsComparison(sinceTs, untilTs),
        ipc.employee?.analyticsMessageTimeline(sinceTs, untilTs),
        ipc.employee?.analyticsOnlineTimeline(sinceTs, untilTs),
        ipc.employee?.analyticsResponseDist(sinceTs, untilTs),
        ipc.employee?.analyticsHourlyActivity(sinceTs, untilTs),
      ]);
      if (compRes?.success) setComparison(compRes.data || []);
      if (msgRes?.success) setMsgTimeline(msgRes.data || []);
      if (onlRes?.success) setOnlineTimeline(onlRes.data || []);
      if (respRes?.success) setResponseDist(respRes.data || []);
      if (hourRes?.success) setHourlyActivity(hourRes.data || []);
    } catch { /* silent */ }
    setLoading(false);
  }, [sinceTs, untilTs]);

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
    const startDate = new Date(sinceTs);
    const rows: any[] = [];
    for (let d = 0; d <= maxDay; d++) {
      const date = new Date(startDate.getTime() + d * 86400000);
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
    const startDate = new Date(sinceTs);
    const rows: any[] = [];
    for (let d = 0; d <= maxDay; d++) {
      const date = new Date(startDate.getTime() + d * 86400000);
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
    rows.push(['TỔNG', '', totals.messages_sent, '—', totals.conversations, totals.online_hours]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BaoCao_NhanVien_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <SkeletonCards count={8} />;

  if (comparison.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <span className="text-4xl mb-3">👥</span>
        <p className="text-sm">Chưa có nhân viên nào. Vào <span className="text-blue-400">Cài đặt → Quản lý nhân viên</span> để thêm.</p>
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
            className="flex items-center gap-2 bg-gray-700/60 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 hover:border-blue-500 transition-colors focus:outline-none"
          >
            <span className="text-gray-400">Nhân viên:</span>
            {/* Stacked avatars */}
            <div className="flex -space-x-1.5">
              {(isAll ? comparison : comparison.filter(e => selectedIds.has(e.employee_id))).slice(0, 4).map((emp) => (
                <div key={emp.employee_id}
                  className="w-5 h-5 rounded-full border border-gray-700 bg-gray-600 flex items-center justify-center text-[9px] overflow-hidden flex-shrink-0"
                  style={{ borderColor: empColorMap[emp.employee_id] }}>
                  {emp.avatar_url
                    ? <img src={emp.avatar_url} className="w-full h-full object-cover" alt="" />
                    : <span className="text-gray-300">{emp.display_name?.charAt(0)?.toUpperCase()}</span>}
                </div>
              ))}
            </div>
            <span className="font-medium text-white">{filterLabel}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-gray-400 ml-0.5">
              <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            </svg>
          </button>

          {filterOpen && (
            <div className="absolute left-0 top-full mt-1.5 w-64 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-50 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
                <span className="text-[11px] text-gray-400 font-semibold uppercase tracking-wide">Lọc nhân viên</span>
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
                      className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-700/60 transition-colors ${checked && !isAll ? 'bg-blue-600/10' : ''}`}
                    >
                      {/* Checkbox */}
                      <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border ${selectedIds.has(emp.employee_id) ? 'bg-blue-600 border-blue-600' : 'border-gray-500 bg-transparent'}`}>
                        {selectedIds.has(emp.employee_id) && (
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="white">
                            <path d="M1.5 5.5l2.5 2.5 5-5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      {/* Avatar */}
                      <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-[10px] flex-shrink-0 overflow-hidden"
                        style={{ borderLeft: `3px solid ${empColorMap[emp.employee_id]}` }}>
                        {emp.avatar_url
                          ? <img src={emp.avatar_url} className="w-full h-full object-cover" alt="" />
                          : <span className="text-gray-300">{emp.display_name?.charAt(0)?.toUpperCase()}</span>}
                      </div>
                      {/* Name + role */}
                      <div className="flex-1 text-left min-w-0">
                        <p className="text-xs text-gray-200 font-medium truncate">{emp.display_name}</p>
                        <p className="text-[9px] text-gray-500">{emp.role === 'boss' ? 'Boss' : 'Nhân viên'}{!emp.is_active ? ' · Tắt' : ''}</p>
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
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200 px-2.5 py-1.5 rounded-lg hover:bg-gray-700 border border-gray-700 transition-colors"
        >
          📥 Xuất CSV
        </button>
        <button
          onClick={loadData}
          disabled={loading}
          className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1.5 rounded-lg hover:bg-gray-700 transition-colors"
          title="Làm mới"
        >
          {loading ? '⏳' : '🔄'}
        </button>
      </div>

      {/* ── KPI Summary ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon="👥" label="Nhân viên" value={filteredComparison.length}
          sub={`${filteredComparison.filter(e => e.is_active).length} hoạt động`} color="blue" />
        <KPICard icon="💬" label="Tổng tin gửi" value={totals.messages_sent}
          sub={`${periodDays} ngày`} color="green" />
        <KPICard icon="🗂️" label="Hội thoại xử lý" value={totals.conversations}
          sub="tổng cộng" color="purple" />
        <KPICard icon="⏱️" label="TB phản hồi" value={formatResponseTime(avgResponseTime)}
          sub="trung bình team" color="cyan" />
        <KPICard icon="🕐" label="Tổng giờ online" value={`${totals.online_hours}h`}
          sub={`TB ${filteredComparison.length > 0 ? (totals.online_hours / filteredComparison.length).toFixed(1) : 0}h/NV`} color="amber" />
      </div>

      {/* ── Row 1: Comparison bars + Pie charts ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Bar: Messages per employee */}
        <Section title="📊 So sánh tin nhắn & hội thoại">
          {barCompData.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-white font-medium mb-1">{d.name}</p>
                        <p className="text-blue-400">💬 {d.messages} tin gửi</p>
                        <p className="text-green-400">🗂️ {d.conversations} hội thoại</p>
                        <p className="text-amber-400">🕐 {d.online}h online</p>
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
          <Section title="🥧 Phân bổ tin nhắn">
            {msgPieData.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                        <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-white font-medium">{d.name}</p>
                          <p className="text-blue-400 font-bold">{d.value} tin ({pct}%)</p>
                        </div>
                      );
                    }} />
                    <Legend formatter={(v: string) => <span className="text-[10px] text-gray-400">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>

          <Section title="🕐 Phân bổ giờ online">
            {onlinePieData.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                        <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-white font-medium">{d.name}</p>
                          <p className="text-amber-400 font-bold">{d.value}h ({pct}%)</p>
                        </div>
                      );
                    }} />
                    <Legend formatter={(v: string) => <span className="text-[10px] text-gray-400">{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* ── Row 2: Message timeline + Online timeline ────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title="📈 Tin nhắn theo ngày (so sánh nhân viên)">
          {msgTimelineChart.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-gray-400 mb-1 font-medium">{label}</p>
                        {payload.map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.stroke || p.fill }} />
                            <span className="text-gray-300">{empNameMap[p.dataKey] || p.dataKey}</span>
                            <span className="font-bold text-white ml-auto">{p.value}</span>
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

        <Section title="🕐 Giờ online theo ngày (so sánh nhân viên)">
          {onlineTimelineChart.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-gray-400 mb-1 font-medium">{label}</p>
                        {payload.filter((p: any) => p.value > 0).map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.fill }} />
                            <span className="text-gray-300">{empNameMap[p.dataKey] || p.dataKey}</span>
                            <span className="font-bold text-white ml-auto">{p.value}h</span>
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
        <Section title="⏱️ Xếp hạng tốc độ phản hồi">
          {responseBarData.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu phản hồi</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-white font-medium">{d.name}</p>
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

        <Section title="🕸️ So sánh đa chiều nhân viên">
          {radarData.length === 0 || filteredComparison.length < 2 ? (
            <p className="text-xs text-gray-500 text-center py-8">Cần ít nhất 2 nhân viên có dữ liệu</p>
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
                  <Legend formatter={(v: string) => <span className="text-[10px] text-gray-400">{v}</span>} />
                  <Tooltip content={({ active, payload, label }: any) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-gray-400 mb-1 font-medium">{label}</p>
                        {payload.map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.stroke }} />
                            <span className="text-gray-300">{p.name}</span>
                            <span className="font-bold text-white ml-auto">{p.value}%</span>
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
        <Section title={`📊 Phân bổ thời gian phản hồi${!isAll ? ` — ${filterLabel}` : ''}`}>
          {responseDistChart.every(r => r.count === 0) ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-gray-400 mb-1">{label}</p>
                        <p className="text-white font-bold">{payload[0].value} lượt</p>
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

        <Section title={`🕐 Hoạt động theo giờ${!isAll ? ` — ${filterLabel}` : ''}`}>
          {hourlyChart.every(r => r.count === 0) ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
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
                      <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                        <p className="text-gray-400 mb-1">{label}</p>
                        <p className="text-white font-bold">{payload[0].value} tin nhắn</p>
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
      <Section title="📋 Bảng chi tiết nhân viên">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
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
                    className={`border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors ${!emp.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-2.5 px-3 text-gray-500 font-mono">{idx + 1}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-[10px] flex-shrink-0 overflow-hidden"
                          style={{ borderLeft: `3px solid ${empColorMap[emp.employee_id]}` }}>
                          {emp.avatar_url ? (
                            <img src={toLocalMediaUrl(emp.avatar_url)} className="w-full h-full object-cover" alt="" />
                          ) : (
                            <span className="text-gray-300">{emp.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                          )}
                        </div>
                        <div>
                          <span className="text-gray-200 font-medium">{emp.display_name}</span>
                          {!emp.is_active && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-red-600/25 text-red-400">Tắt</span>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${emp.role === 'boss' ? 'bg-amber-600/25 text-amber-400' : 'bg-gray-600/40 text-gray-400'}`}>
                        {emp.role === 'boss' ? 'Boss' : 'NV'}
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 text-gray-300 font-mono font-medium">{emp.messages_sent.toLocaleString('vi-VN')}</td>
                    <td className="text-right py-2.5 px-3 text-gray-300 font-mono">{emp.conversations_handled}</td>
                    <td className="text-right py-2.5 px-3">
                      <span className={`font-medium ${emp.avg_response_time_ms > 300_000 ? 'text-red-400' : emp.avg_response_time_ms > 120_000 ? 'text-amber-400' : emp.avg_response_time_ms > 0 ? 'text-green-400' : 'text-gray-500'}`}>
                        {formatResponseTime(emp.avg_response_time_ms)}
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 text-gray-300">{emp.total_online_hours}h</td>
                    <td className="text-right py-2.5 px-3">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${perf}%`, backgroundColor: empColorMap[emp.employee_id] }} />
                        </div>
                        <span className="text-[10px] text-gray-400 font-mono w-8 text-right">{perf}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {/* Totals */}
              <tr className="border-t border-gray-600 font-semibold bg-gray-700/20">
                <td className="py-2.5 px-3" colSpan={2}>
                  <span className="text-gray-300">Tổng ({filteredComparison.length} NV)</span>
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

