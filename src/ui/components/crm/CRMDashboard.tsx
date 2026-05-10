import DateInputVN from '@/components/common/DateInputVN';
import React, { useEffect, useState, useCallback } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';
import { useCRMStore, ContactTypeFilter } from '@/store/crmStore';
import { useAppStore, LabelData } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import ipc from '@/lib/ipc';

// ── Mini stat card ─────────────────────────────────────────────────────────────
function MiniStat({ icon, label, value, sub, color = 'blue', onClick }: {
  icon: string; label: string; value: string | number; sub?: string; color?: string;
  onClick?: () => void;
}) {
  const bg: Record<string, string> = {
    blue:   'bg-blue-500/10 border-blue-500/20',
    green:  'bg-green-500/10 border-green-500/20',
    yellow: 'bg-yellow-500/10 border-yellow-500/20',
    purple: 'bg-purple-500/10 border-purple-500/20',
    red:    'bg-red-500/10 border-red-500/20',
    gray:   'bg-gray-700/40 border-gray-600',
  };
  const content = (
    <>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-sm leading-none">{icon}</span>
        <span className="text-[11px] text-gray-400 leading-tight">{label}</span>
      </div>
      <span className="text-xl font-bold text-white leading-tight">{value}</span>
      {sub && <span className="text-[11px] text-gray-500 mt-0.5">{sub}</span>}
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} title="Nhấn để xem chi tiết"
        className={`flex flex-col p-3 rounded-xl border ${bg[color]} cursor-pointer hover:brightness-125 transition-all text-left w-full`}>
        {content}
      </button>
    );
  }
  return (
    <div className={`flex flex-col p-3 rounded-xl border ${bg[color]}`}>
      {content}
    </div>
  );
}

function ProgressBar({ value, color = '#22c55e' }: { value: number; color?: string }) {
  return (
    <div className="h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
      <div className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: color }} />
    </div>
  );
}

interface CampaignStat {
  id: number; name: string; campaign_type: string; status: string;
  created_at: number; total_contacts: number;
  sent_count: number; failed_count: number; pending_count: number; replied_count: number;
}

const TYPE_LABEL: Record<string, string> = { message: '💬', friend_request: '🤝', mixed: '🔀', invite_to_group: '👥' };
const ST_STYLE: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400', paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-blue-500/20 text-blue-400', draft: 'bg-gray-700 text-gray-400',
};
const ST_LABEL: Record<string, string> = { active: '▶ Chạy', paused: '⏸ Dừng', done: '✓ Xong', draft: 'Nháp' };

const DonutTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
        {d.emoji && <span>{d.emoji}</span>}
        <span className="text-white font-medium">{d.name}</span>
      </div>
      <span className="text-blue-300 font-bold">{d.value}</span>
      <span className="text-gray-400 ml-1">hội thoại</span>
    </div>
  );
};

const CampTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const full = payload[0]?.payload?.fullName;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl max-w-[220px]">
      {full && <p className="text-white font-medium mb-1.5 truncate">{full}</p>}
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.fill }} />
            <span className="text-gray-300">{p.name}</span>
          </span>
          <span className="font-bold" style={{ color: p.fill }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
};

export default function CRMDashboard() {
  const store = useCRMStore();
  const { campaigns, groupCount } = store;
  const { labels } = useAppStore();
  const { activeAccountId } = useAccountStore();

  const [contactStats, setContactStats] = useState({ total: 0, friendCount: 0, noteCount: 0 });
  const [campaignStats, setCampaignStats] = useState<CampaignStat[]>([]);
  const [loadingCampStats, setLoadingCampStats] = useState(false);

  // Local labels for dashboard
  type LabelSubTab = 'local' | 'zalo';
  const [labelSubTab, setLabelSubTab] = useState<LabelSubTab>('local');
  const [localLabels, setLocalLabels] = useState<{ id: number; name: string; color: string; emoji?: string; text_color?: string }[]>([]);
  const [localLabelCounts, setLocalLabelCounts] = useState<Record<number, number>>({});

  // Activity stats
  type ActivityPeriod = 'day' | 'week' | 'month' | 'custom';
  const [activityPeriod, setActivityPeriod] = useState<ActivityPeriod>('day');
  const emptyStats = { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
  const [curStats, setCurStats] = useState(emptyStats);
  const [prevStats, setPrevStats] = useState(emptyStats);
  const [customStats, setCustomStats] = useState(emptyStats);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // Custom date range
  const todayStr = new Date().toISOString().split('T')[0];
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [customTo, setCustomTo] = useState(todayStr);
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);
  const [customError, setCustomError] = useState('');

  /** Today (0) or yesterday (-1): 00:00 → 23:59 */
  const getDayRange = (offset: 0 | -1): { from: number; to: number } => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return { from: d.getTime(), to: end.getTime() };
  };

  /** Mon 00:00 – Sun 23:59 for current (0) or previous (-1) week */
  const getWeekRange = (offset: 0 | -1): { from: number; to: number } => {
    const now = new Date();
    const dow = now.getDay();
    const daysFromMon = dow === 0 ? 6 : dow - 1;
    const mon = new Date(now);
    mon.setDate(now.getDate() - daysFromMon + offset * 7);
    mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    return { from: mon.getTime(), to: sun.getTime() };
  };

  /** 1st → last day of this month (0) or last month (-1) */
  const getMonthRange = (offset: 0 | -1): { from: number; to: number } => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1, 0, 0, 0, 0);
    const last  = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59, 999);
    return { from: first.getTime(), to: last.getTime() };
  };

  const fmtDay = (ts: number) => new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  const fmtMonthYear = (ts: number) => { const d = new Date(ts); return `T${d.getMonth() + 1}/${d.getFullYear()}`; };

  const zaloLabels: LabelData[] = activeAccountId ? (labels[activeAccountId] || []) : [];

  useEffect(() => {
    if (!activeAccountId) return;
    setLoadingActivity(true);
    const extract = (r: any) => r?.success
      ? { conversationCount: r.conversationCount, messageCount: r.messageCount, sentCount: r.sentCount, receivedCount: r.receivedCount }
      : emptyStats;

    if (activityPeriod === 'custom') {
      if (!customApplied) { setLoadingActivity(false); return; }
      const from = new Date(customApplied.from + 'T00:00:00').getTime();
      const to   = new Date(customApplied.to   + 'T23:59:59.999').getTime();
      ipc.crm?.getActivityStats({ zaloId: activeAccountId, sinceTs: from, untilTs: to } as any)
        .then(r => setCustomStats(extract(r))).catch(() => {}).finally(() => setLoadingActivity(false));
    } else {
      const curRange  = activityPeriod === 'day' ? getDayRange(0)   : activityPeriod === 'week' ? getWeekRange(0)   : getMonthRange(0);
      const prevRange = activityPeriod === 'day' ? getDayRange(-1)  : activityPeriod === 'week' ? getWeekRange(-1)  : getMonthRange(-1);
      Promise.all([
        ipc.crm?.getActivityStats({ zaloId: activeAccountId, sinceTs: curRange.from,  untilTs: curRange.to  } as any),
        ipc.crm?.getActivityStats({ zaloId: activeAccountId, sinceTs: prevRange.from, untilTs: prevRange.to } as any),
      ]).then(([cr, pr]) => { setCurStats(extract(cr)); setPrevStats(extract(pr)); })
        .catch(() => {}).finally(() => setLoadingActivity(false));
    }
  }, [activeAccountId, activityPeriod, customApplied]);

  const handleApplyCustom = useCallback(() => {
    const from = new Date(customFrom);
    const to   = new Date(customTo);
    if (to < from) { setCustomError('Ngày kết thúc phải sau ngày bắt đầu'); return; }
    if (to.getTime() - from.getTime() > 6 * 30 * 24 * 60 * 60 * 1000) {
      setCustomError('Khoảng thời gian tối đa 6 tháng'); return;
    }
    setCustomError('');
    setCustomApplied({ from: customFrom, to: customTo });
  }, [customFrom, customTo]);

  /** Unified comparison view renderer for day / week / month */
  const renderActivityContent = () => {
    if (loadingActivity) {
      return (
        <div className="grid grid-cols-4 gap-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-700/50 rounded-xl animate-pulse" />)}
        </div>
      );
    }

    /* ── Custom date range ── */
    if (activityPeriod === 'custom') {
      return (
        <div>
          <div className="flex items-center flex-wrap gap-2 mb-3">
            <label className="text-[11px] text-gray-500">Từ</label>
            <DateInputVN value={customFrom} max={customTo}
              onChange={e => { setCustomFrom(e.target.value); setCustomError(''); }}
              className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500" />
            <label className="text-[11px] text-gray-500">Đến</label>
            <DateInputVN value={customTo} min={customFrom} max={todayStr}
              onChange={e => { setCustomTo(e.target.value); setCustomError(''); }}
              className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500" />
            <button onClick={handleApplyCustom}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg transition-colors">
              Xem
            </button>
            {customError && <span className="text-red-400 text-[11px]">{customError}</span>}
          </div>
          {customApplied ? (
            <div className="grid grid-cols-4 gap-2">
              <MiniStat icon="🗨️" label="Hội thoại" value={customStats.conversationCount}
                sub={`${customApplied.from} → ${customApplied.to}`} color="blue" />
              <MiniStat icon="📨" label="Tổng tin nhắn" value={customStats.messageCount} color="purple" />
              <MiniStat icon="📤" label="Đã gửi" value={customStats.sentCount}
                sub={customStats.messageCount > 0 ? `${Math.round(customStats.sentCount / customStats.messageCount * 100)}% tổng` : '—'}
                color="green" />
              <MiniStat icon="📥" label="Đã nhận" value={customStats.receivedCount}
                sub={customStats.messageCount > 0 ? `${Math.round(customStats.receivedCount / customStats.messageCount * 100)}% tổng` : '—'}
                color="yellow" />
            </div>
          ) : (
            <p className="text-xs text-gray-500 text-center py-4">Chọn khoảng thời gian và nhấn <strong className="text-gray-400">Xem</strong></p>
          )}
        </div>
      );
    }

    /* ── Comparison view (day / week / month) ── */
    const cfg = activityPeriod === 'day'
      ? { curLabel: 'Hôm nay',    prevLabel: 'Hôm qua',
          curDate:  fmtDay(getDayRange(0).from),
          prevDate: fmtDay(getDayRange(-1).from) }
      : activityPeriod === 'week'
      ? { curLabel: 'Tuần này',   prevLabel: 'Tuần trước',
          curDate:  `${fmtDay(getWeekRange(0).from)} – ${fmtDay(getWeekRange(0).to)}`,
          prevDate: `${fmtDay(getWeekRange(-1).from)} – ${fmtDay(getWeekRange(-1).to)}` }
      : { curLabel: 'Tháng này',  prevLabel: 'Tháng trước',
          curDate:  fmtMonthYear(getMonthRange(0).from),
          prevDate: fmtMonthYear(getMonthRange(-1).from) };

    const pct = (cur: number, prev: number) => {
      if (prev === 0) return '—';
      const v = Math.round((cur - prev) / prev * 100);
      return v >= 0 ? `+${v}%` : `${v}%`;
    };
    const pctColor = (cur: number, prev: number) =>
      prev === 0 ? 'text-gray-500' : cur >= prev ? 'text-emerald-400' : 'text-red-400';
    const pctArrow = (cur: number, prev: number) =>
      prev === 0 ? '' : cur > prev ? '▲' : cur < prev ? '▼' : '→';

    const METRICS = [
      { key: 'conversationCount' as const, icon: '🗨️', label: 'Hội thoại' },
      { key: 'messageCount'      as const, icon: '📨', label: 'Tin nhắn' },
      { key: 'sentCount'         as const, icon: '📤', label: 'Đã gửi' },
      { key: 'receivedCount'     as const, icon: '📥', label: 'Đã nhận' },
    ];

    const chartData = METRICS.map(m => ({
      name: m.label,
      [cfg.curLabel]:  curStats[m.key],
      [cfg.prevLabel]: prevStats[m.key],
    }));

    return (
      <div>
        {/* Period date range labels */}
        <div className="flex items-center gap-3 mb-3 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 inline-block" />
            <span className="text-blue-300 font-medium">{cfg.curLabel}</span>
            <span className="text-gray-500">{cfg.curDate}</span>
          </span>
          <span className="text-gray-700">|</span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-gray-500 inline-block" />
            <span className="text-gray-400 font-medium">{cfg.prevLabel}</span>
            <span className="text-gray-500">{cfg.prevDate}</span>
          </span>
        </div>

        {/* Comparison stat cards */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {METRICS.map(m => {
            const cur  = curStats[m.key];
            const prev = prevStats[m.key];
            return (
              <div key={m.key} className="bg-gray-700/40 border border-gray-600/50 rounded-xl p-3">
                <div className="flex items-center gap-1 mb-1.5">
                  <span className="text-sm leading-none">{m.icon}</span>
                  <span className="text-[11px] text-gray-400">{m.label}</span>
                </div>
                <div className="flex items-end gap-1.5">
                  <span className="text-xl font-bold text-white leading-tight">{cur}</span>
                  {(prev > 0 || cur > 0) && (
                    <span className={`text-[11px] font-semibold pb-0.5 ${pctColor(cur, prev)}`}>
                      {pctArrow(cur, prev)} {pct(cur, prev)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-[11px] text-gray-600">vs</span>
                  <span className="text-[11px] text-gray-500 font-medium">{prev}</span>
                  <span className="text-[11px] text-gray-600">{cfg.prevLabel.toLowerCase()}</span>
                </div>
                {/* Mini split bar */}
                <div className="mt-1.5 flex gap-0.5 h-1">
                  <div className="rounded-full bg-blue-500 transition-all"
                    style={{ width: `${cur + prev > 0 ? Math.round(cur / (cur + prev) * 100) : 50}%` }} />
                  <div className="rounded-full bg-gray-600 flex-1" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Grouped bar chart */}
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }} barCategoryGap="32%" barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                      <p className="text-gray-400 mb-1.5 font-medium">{label}</p>
                      {payload.map((p: any) => (
                        <div key={p.name} className="flex items-center justify-between gap-4">
                          <span className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: p.fill }} />
                            <span className="text-gray-300">{p.name}</span>
                          </span>
                          <span className="font-bold text-white">{p.value}</span>
                        </div>
                      ))}
                    </div>
                  );
                }}
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af', paddingTop: 4 }} />
              <Bar dataKey={cfg.curLabel}  fill="#3b82f6" radius={[3,3,0,0]} maxBarSize={22} />
              <Bar dataKey={cfg.prevLabel} fill="#6b7280" radius={[3,3,0,0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!activeAccountId) return;
    ipc.crm?.getContactStats({ zaloId: activeAccountId })
      .then(r => { if (r?.success) setContactStats({ total: r.total, friendCount: r.friendCount, noteCount: r.noteCount }); })
      .catch(() => {});
    setLoadingCampStats(true);
    ipc.crm?.getCampaignStats({ zaloId: activeAccountId, limit: 10 })
      .then(r => { if (r?.success) setCampaignStats(r.stats); })
      .catch(() => {})
      .finally(() => setLoadingCampStats(false));
    // Load local labels and their counts
    Promise.all([
      ipc.db?.getLocalLabels({ zaloId: activeAccountId }),
      ipc.db?.getLocalLabelThreads({ zaloId: activeAccountId }),
    ]).then(([labelsRes, threadsRes]) => {
      const lbls = (labelsRes?.labels || []).filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name || '').localeCompare(String(b.name || '')));
      setLocalLabels(lbls);
      const counts: Record<number, number> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        const lid = Number(row.label_id);
        counts[lid] = (counts[lid] || 0) + 1;
      });
      setLocalLabelCounts(counts);
    }).catch(() => {});
  }, [activeAccountId]);


  const { total: totalContacts, friendCount, noteCount } = contactStats;
  const activeCamps  = campaigns.filter(c => c.status === 'active').length;
  const pausedCamps  = campaigns.filter(c => c.status === 'paused').length;
  const doneCamps    = campaigns.filter(c => c.status === 'done').length;
  const totalSent    = campaigns.reduce((s, c) => s + (c.sent_count    || 0), 0);
  const totalFailed  = campaigns.reduce((s, c) => s + (c.failed_count  || 0), 0);
  const totalPending = campaigns.reduce((s, c) => s + (c.pending_count || 0), 0);

  const labelData = zaloLabels
    .map(l => ({ id: l.id, name: l.text, emoji: l.emoji || '', color: l.color || '#3b82f6', value: l.conversations?.length || 0 }))
    .filter(l => l.value > 0)
    .sort((a, b) => b.value - a.value);
  const totalLabelConvs = labelData.reduce((s, l) => s + l.value, 0);

  const handleLabelClick = (labelId: number) => {
    store.setFilter({ filterLabelIds: [labelId], filterLocalLabelIds: [], filterContactTypes: [], page: 0 });
    store.setTab('contacts');
  };

  const handleLocalLabelClick = (labelId: number) => {
    store.setFilter({ filterLocalLabelIds: [labelId], filterLabelIds: [], filterContactTypes: [], page: 0 });
    store.setTab('contacts');
  };

  const handleNavigateContacts = (filterContactTypes: ContactTypeFilter[]) => {
    store.setFilter({ filterContactTypes, filterLabelIds: [], filterLocalLabelIds: [], page: 0 });
    store.setTab('contacts');
  };

  const campChartData = campaignStats.map(c => ({
    name: c.name.length > 11 ? c.name.slice(0, 11) + '…' : c.name,
    fullName: c.name,
    'Đã gửi':   c.sent_count,
    'Thất bại': c.failed_count,
    'Phản hồi': c.replied_count,
  }));

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4">

      {/* ── Row 1: Contacts + Campaigns ── */}
      <div className="grid grid-cols-2 gap-4">
        {/* ...existing contacts and campaigns cards... */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
          <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <span>👥</span> Liên hệ
          </h3>
          {(() => {
            const realTotal = totalContacts + (groupCount || 0);
            return (
              <div className="grid grid-cols-2 gap-2">
                <MiniStat icon="👤" label="Tổng liên hệ" value={realTotal}
                  sub={groupCount > 0 ? `Gồm ${groupCount} nhóm` : undefined}
                  color="blue"
                  onClick={() => handleNavigateContacts([])} />
                <MiniStat icon="🤝" label="Bạn bè" value={friendCount}
                  sub={`${realTotal > 0 ? Math.round(friendCount / realTotal * 100) : 0}% tổng`}
                  color="green"
                  onClick={() => handleNavigateContacts(['friend'])} />
                <MiniStat icon="👻" label="Chưa kết bạn" value={totalContacts - friendCount}
                  color="gray"
                  onClick={() => handleNavigateContacts(['non_friend'])} />
                <MiniStat icon="📝" label="Có ghi chú" value={noteCount}
                  color="yellow"
                  onClick={() => handleNavigateContacts(['has_notes'])} />
              </div>
            );
          })()}
        </div>

        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
          <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <span>📢</span> Chiến dịch ({campaigns.length})
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat icon="▶️" label="Đang chạy"   value={activeCamps}  color="green" />
            <MiniStat icon="⏸"  label="Tạm dừng"    value={pausedCamps}  color="yellow" />
            <MiniStat icon="✅" label="Hoàn thành"  value={doneCamps}    color="purple" />
            <MiniStat icon="✉️" label="Tổng tin đã gửi" value={totalSent}
              sub={[totalFailed > 0 ? `${totalFailed} lỗi` : '', totalPending > 0 ? `${totalPending} chờ` : ''].filter(Boolean).join(' · ') || 'không lỗi'}
              color="blue" />
          </div>
        </div>
      </div>

      {/* ── Row 2: Activity Stats ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <span>💬</span> Hoạt động hội thoại
          </h3>
          <div className="flex bg-gray-700/60 rounded-lg p-0.5 gap-0.5">
            {([
              { key: 'day',    label: 'Theo ngày'  },
              { key: 'week',   label: 'Theo tuần'  },
              { key: 'month',  label: 'Theo tháng' },
              { key: 'custom', label: 'Tuỳ chọn'  },
            ] as const).map(({ key, label }) => (
              <button key={key} onClick={() => setActivityPeriod(key)}
                className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  activityPeriod === key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {renderActivityContent()}
      </div>

      {/* ── Row 3: Labels (Local + Zalo tabs) ── */}
      {(localLabels.length > 0 || zaloLabels.length > 0) && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <span>🏷️</span> Nhãn
            </h3>
            <div className="flex bg-gray-700/60 rounded-lg p-0.5 gap-0.5">
              <button onClick={() => setLabelSubTab('local')}
                className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  labelSubTab === 'local' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}>💾 Local</button>
              <button onClick={() => setLabelSubTab('zalo')}
                className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  labelSubTab === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}>☁️ Zalo</button>
            </div>
          </div>

          {labelSubTab === 'local' ? (() => {
            const localLabelData = localLabels
              .map(l => ({ id: l.id, name: l.name, emoji: l.emoji || '', color: l.color || '#3b82f6', value: localLabelCounts[l.id] || 0 }))
              .sort((a, b) => b.value - a.value);
            const totalLocalConvs = localLabelData.reduce((s, l) => s + l.value, 0);

            return localLabelData.length === 0 ? (
              <p className="text-xs text-gray-500 py-4 text-center">Chưa có Nhãn Local nào. Vào Cài đặt → Nhãn để tạo.</p>
            ) : (
              <div className="flex gap-5 items-start">
                {/* Donut */}
                {localLabelData.some(l => l.value > 0) ? (
                  <div className="relative flex-shrink-0 w-44 h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={localLabelData.filter(l => l.value > 0)} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                          paddingAngle={2} dataKey="value" stroke="none">
                          {localLabelData.filter(l => l.value > 0).map(entry => <Cell key={entry.id} fill={entry.color} />)}
                        </Pie>
                        <Tooltip content={<DonutTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-xl font-bold text-white">{totalLocalConvs}</span>
                      <span className="text-[9px] text-gray-500 mt-0.5">hội thoại</span>
                    </div>
                  </div>
                ) : null}

                {/* Legend */}
                <div className="flex-1 grid grid-cols-2 gap-1.5 content-start max-h-44 overflow-y-auto pr-1">
                  {localLabelData.map(l => {
                    const pct = totalLocalConvs > 0 ? Math.round(l.value / totalLocalConvs * 100) : 0;
                    return (
                      <button key={l.id} onClick={() => handleLocalLabelClick(l.id)}
                        title="Click để lọc liên hệ theo nhãn"
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-gray-700/40 hover:bg-gray-700 transition-colors text-left group w-full min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                        {l.emoji && <span className="text-xs flex-shrink-0">{l.emoji}</span>}
                        <span className="flex-1 text-xs text-gray-300 truncate">{l.name}</span>
                        <span className="text-xs font-bold text-blue-400 group-hover:text-blue-300 flex-shrink-0 group-hover:underline">{l.value}</span>
                        {totalLocalConvs > 0 && <span className="text-[11px] text-gray-600 flex-shrink-0">{pct}%</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })() : (
            /* ── Zalo labels tab ── */
            labelData.length > 0 ? (
              <div className="flex gap-5 items-start">
                <div className="relative flex-shrink-0 w-44 h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={labelData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                        paddingAngle={2} dataKey="value" stroke="none">
                        {labelData.map(entry => <Cell key={entry.id} fill={entry.color} />)}
                      </Pie>
                      <Tooltip content={<DonutTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-xl font-bold text-white">{totalLabelConvs}</span>
                    <span className="text-[9px] text-gray-500 mt-0.5">hội thoại</span>
                  </div>
                </div>
                <div className="flex-1 grid grid-cols-2 gap-1.5 content-start max-h-44 overflow-y-auto pr-1">
                  {labelData.map(l => {
                    const pct = totalLabelConvs > 0 ? Math.round(l.value / totalLabelConvs * 100) : 0;
                    return (
                      <button key={l.id} onClick={() => handleLabelClick(l.id)}
                        title="Click để lọc liên hệ theo nhãn"
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-gray-700/40 hover:bg-gray-700 transition-colors text-left group w-full min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                        {l.emoji && <span className="text-xs flex-shrink-0">{l.emoji}</span>}
                        <span className="flex-1 text-xs text-gray-300 truncate">{l.name}</span>
                        <span className="text-xs font-bold text-blue-400 group-hover:text-blue-300 flex-shrink-0 group-hover:underline">
                          {l.value}
                        </span>
                        <span className="text-[11px] text-gray-600 flex-shrink-0">{pct}%</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500 py-4 text-center">{zaloLabels.length > 0 ? 'Các nhãn Zalo chưa có hội thoại nào' : 'Chưa có nhãn Zalo'}</p>
            )
          )}
        </div>
      )}

      {/* ── Row 4: Top 10 campaign stats ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-4">
        <h3 className="text-[14px] font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <span>📊</span> Thống kê 10 chiến dịch gần nhất
        </h3>

        {loadingCampStats ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <div key={i} className="h-9 bg-gray-700/50 rounded-xl animate-pulse" />)}
          </div>
        ) : campaignStats.length === 0 ? (
          <div className="text-center py-10 text-gray-500 text-sm">Chưa có chiến dịch nào</div>
        ) : (
          <>
            {/* Bar chart */}
            <div className="h-44 mb-5">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={campChartData} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap="28%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<CampTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af', paddingTop: 2 }} />
                  <Bar dataKey="Đã gửi"   fill="#22c55e" radius={[3,3,0,0]} maxBarSize={18} />
                  <Bar dataKey="Thất bại" fill="#ef4444" radius={[3,3,0,0]} maxBarSize={18} />
                  <Bar dataKey="Phản hồi" fill="#3b82f6" radius={[3,3,0,0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Detail table */}
            <div className="overflow-x-auto rounded-xl border border-gray-700/50">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-[11px] text-gray-500 bg-gray-800/80">
                    <th className="text-left py-2.5 px-3 font-medium">Chiến dịch</th>
                    <th className="text-center py-2.5 px-2 font-medium">Loại</th>
                    <th className="text-right py-2.5 px-2 font-medium">Tổng KH</th>
                    <th className="text-right py-2.5 px-2 font-medium min-w-[110px]">Thành công</th>
                    <th className="text-right py-2.5 px-2 font-medium min-w-[90px]">Thất bại</th>
                    <th className="text-right py-2.5 px-2 font-medium min-w-[90px]">Phản hồi lại</th>
                    <th className="text-right py-2.5 px-3 font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignStats.map(c => {
                    const sentPct  = c.total_contacts > 0 ? Math.round(c.sent_count    / c.total_contacts * 100) : 0;
                    const failPct  = c.total_contacts > 0 ? Math.round(c.failed_count  / c.total_contacts * 100) : 0;
                    const replyPct = c.sent_count     > 0 ? Math.round(c.replied_count / c.sent_count     * 100) : 0;
                    return (
                      <tr key={c.id} className="border-t border-gray-700/50 hover:bg-gray-800/40 transition-colors">
                        <td className="py-2.5 px-3">
                          <p className="text-gray-200 font-medium truncate max-w-[180px]">{c.name}</p>
                          <p className="text-[11px] text-gray-600 mt-0.5">
                            {new Date(c.created_at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                          </p>
                        </td>
                        <td className="py-2.5 px-2 text-center">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${
                            c.campaign_type === 'friend_request' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' :
                            c.campaign_type === 'mixed'          ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' :
                                                                   'bg-blue-500/20 text-blue-400 border-blue-500/30'
                          }`}>{TYPE_LABEL[c.campaign_type] || '💬'}</span>
                        </td>
                        <td className="py-2.5 px-2 text-right text-gray-300 font-semibold">{c.total_contacts}</td>
                        <td className="py-2.5 px-2 text-right">
                          <span className="text-green-400 font-semibold">{c.sent_count}</span>
                          <span className="text-gray-600 text-[11px] ml-1">({sentPct}%)</span>
                          <ProgressBar value={sentPct} color="#22c55e" />
                        </td>
                        <td className="py-2.5 px-2 text-right">
                          {c.failed_count > 0 ? (
                            <>
                              <span className="text-red-400 font-semibold">{c.failed_count}</span>
                              <span className="text-gray-600 text-[11px] ml-1">({failPct}%)</span>
                              <ProgressBar value={failPct} color="#ef4444" />
                            </>
                          ) : <span className="text-gray-700">—</span>}
                        </td>
                        <td className="py-2.5 px-2 text-right">
                          <span className="text-blue-400 font-semibold">{c.replied_count}</span>
                          <span className="text-gray-600 text-[11px] ml-1">({replyPct}%)</span>
                          <ProgressBar value={replyPct} color="#3b82f6" />
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full ${ST_STYLE[c.status] || ST_STYLE.draft}`}>
                            {ST_LABEL[c.status] || c.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Empty state */}
      {totalContacts === 0 && campaigns.length === 0 && zaloLabels.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mb-3 opacity-30">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <p className="text-sm">Chưa có dữ liệu CRM</p>
          <p className="text-xs mt-1 opacity-60">Chuyển sang tab Liên hệ để tải dữ liệu</p>
        </div>
      )}
    </div>
  );
}

