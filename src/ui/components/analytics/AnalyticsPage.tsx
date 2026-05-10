import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import AccountSelectorDropdown from '@/components/common/AccountSelectorDropdown';
import EmployeeAnalyticsTab from './EmployeeAnalyticsTab';

// ── IPC helper ─────────────────────────────────────────────────────────────────
const api = () => window.electronAPI?.analytics;

// ── Types ──────────────────────────────────────────────────────────────────────
interface OverviewData {
  totalMessages: number; totalSent: number; totalReceived: number;
  totalContacts: number; totalFriends: number; totalGroups: number;
  todayMessages: number; todaySent: number; todayReceived: number;
  yesterdayMessages: number; activeCampaigns: number; totalCampaigns: number;
}
interface VolumePoint { bucket: string; sent: number; received: number; total: number; }
interface HeatmapPoint { dayOfWeek: number; hour: number; count: number; }
interface SegmentData {
  byType: Array<{ type: string; count: number }>;
  tagged: number; untagged: number; withNotes: number; withoutNotes: number;
}
interface CampaignRow {
  id: number; name: string; type: string; status: string; created_at: number;
  total: number; sent: number; failed: number; pending: number; replied: number;
  deliveryRate: number; replyRate: number;
}
interface WorkflowData {
  totalRuns: number; successRuns: number; errorRuns: number; successRate: number;
  avgDuration: number;
  topWorkflows: Array<{ workflowName: string; runs: number; successRate: number }>;
  timeline: Array<{ bucket: string; success: number; error: number }>;
}
interface AIData {
  totalRequests: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number;
  byModel: Array<{ model: string; requests: number; tokens: number }>;
  byAssistant: Array<{ assistantName: string; requests: number; tokens: number }>;
  timeline: Array<{ bucket: string; requests: number; tokens: number }>;
}
interface ContactGrowthPoint { bucket: string; newContacts: number; newFriends: number; }
interface ResponseTimeData {
  avgSeconds: number; medianSeconds: number; minSeconds: number; maxSeconds: number;
  totalConversations: number; totalReplies: number;
  distribution: Array<{ bucket: string; count: number }>;
  byHour: Array<{ hour: number; avgSeconds: number; count: number }>;
}
interface LabelUsageData {
  totalAssignments: number; totalLabelsUsed: number; avgPerDay: number;
  timeline: Array<{ bucket: string; count: number }>;
  byLabel: Array<{ labelId: number; name: string; emoji: string; color: string; count: number }>;
  recentAssignments: Array<{ labelName: string; emoji: string; color: string; threadId: string; createdAt: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const DAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const PIE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316', '#14b8a6'];
const ST_CLS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400', paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-blue-500/20 text-blue-400', draft: 'bg-gray-700 text-gray-400',
};
const ST_LABEL: Record<string, string> = { active: '▶ Chạy', paused: '⏸ Dừng', done: '✓ Xong', draft: 'Nháp' };

// ── Shared UI Components ──────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, trend, color = 'blue' }: {
  icon: string; label: string; value: string | number; sub?: string;
  trend?: { value: string; positive: boolean }; color?: string;
}) {
  const bg: Record<string, string> = {
    blue: 'from-blue-500/10 to-blue-600/5 border-blue-500/20',
    green: 'from-green-500/10 to-green-600/5 border-green-500/20',
    purple: 'from-purple-500/10 to-purple-600/5 border-purple-500/20',
    yellow: 'from-yellow-500/10 to-yellow-600/5 border-yellow-500/20',
    red: 'from-red-500/10 to-red-600/5 border-red-500/20',
    cyan: 'from-cyan-500/10 to-cyan-600/5 border-cyan-500/20',
    orange: 'from-orange-500/10 to-orange-600/5 border-orange-500/20',
  };
  return (
    <div className={`bg-gradient-to-br ${bg[color] || bg.blue} border rounded-xl p-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{icon}</span>
        <span className="text-xs text-gray-400 font-medium">{label}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-white">{typeof value === 'number' ? value.toLocaleString('vi-VN') : value}</span>
        {trend && (
          <span className={`text-xs font-semibold pb-0.5 ${trend.positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {trend.positive ? '▲' : '▼'} {trend.value}
          </span>
        )}
      </div>
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

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1 font-medium">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color || p.fill }} />
            <span className="text-gray-300">{p.name}</span>
          </span>
          <span className="font-bold text-white">{typeof p.value === 'number' ? p.value.toLocaleString('vi-VN') : p.value}</span>
        </div>
      ))}
    </div>
  );
};

const PieTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.fill || d.color }} />
        <span className="text-white font-medium">{d.name || d.type}</span>
      </div>
      <span className="text-blue-300 font-bold">{(d.value || d.count || 0).toLocaleString('vi-VN')}</span>
    </div>
  );
};

function HeatmapGrid({ data }: { data: HeatmapPoint[] }) {
  const maxCount = useMemo(() => Math.max(1, ...data.map(d => d.count)), [data]);
  const getColor = (count: number) => {
    if (count === 0) return 'bg-gray-800';
    const ratio = count / maxCount;
    if (ratio < 0.2) return 'bg-blue-900/40';
    if (ratio < 0.4) return 'bg-blue-700/50';
    if (ratio < 0.6) return 'bg-blue-600/60';
    if (ratio < 0.8) return 'bg-blue-500/70';
    return 'bg-blue-400/80';
  };
  const grid = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data) m.set(`${d.dayOfWeek}_${d.hour}`, d.count);
    return m;
  }, [data]);
  const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21];
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[500px]">
        <div className="flex gap-px mb-1 ml-8">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-gray-500">
              {hourLabels.includes(h) ? `${h}h` : ''}
            </div>
          ))}
        </div>
        {DAY_NAMES.map((day, d) => (
          <div key={d} className="flex items-center gap-px mb-px">
            <span className="w-7 text-[10px] text-gray-500 text-right pr-1 flex-shrink-0">{day}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const count = grid.get(`${d}_${h}`) || 0;
              return (
                <div key={h}
                  className={`flex-1 aspect-square rounded-sm ${getColor(count)} transition-colors`}
                  title={`${day} ${h}:00 — ${count} tin nhắn`}
                />
              );
            })}
          </div>
        ))}
        <div className="flex items-center gap-1 mt-2 ml-8">
          <span className="text-[9px] text-gray-500">Ít</span>
          {['bg-gray-800', 'bg-blue-900/40', 'bg-blue-700/50', 'bg-blue-600/60', 'bg-blue-500/70', 'bg-blue-400/80'].map((c, i) => (
            <div key={i} className={`w-3 h-3 rounded-sm ${c}`} />
          ))}
          <span className="text-[9px] text-gray-500">Nhiều</span>
        </div>
      </div>
    </div>
  );
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
function SkeletonChart() {
  return <div className="h-52 bg-gray-700/20 rounded-xl animate-pulse" />;
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
type TabId = 'overview' | 'messages' | 'contacts' | 'labels' | 'campaigns' | 'workflow' | 'ai' | 'employees';
const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'overview', icon: '📊', label: 'Tổng quan' },
  { id: 'messages', icon: '💬', label: 'Tin nhắn' },
  { id: 'contacts', icon: '👥', label: 'Liên hệ' },
  { id: 'labels', icon: '🏷️', label: 'Nhãn' },
  { id: 'employees', icon: '👤', label: 'Nhân viên' },
  { id: 'campaigns', icon: '📢', label: 'Chiến dịch' },
  { id: 'workflow', icon: '⚡', label: 'Workflow' },
  { id: 'ai', icon: '🤖', label: 'AI' },
];

type TimePeriod = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'custom';
type ContactType = 'all' | 'user' | 'group';

/** Format Date to yyyy-MM-dd for <input type="date"> */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse yyyy-MM-dd string to start-of-day timestamp */
function dateStrToTs(s: string): number {
  const d = new Date(s + 'T00:00:00');
  return d.getTime();
}

// ── Guide Modal ────────────────────────────────────────────────────────────────
const GUIDE_CONTENT: Record<TabId, { title: string; sections: Array<{ heading: string; content: string }> }> = {
  overview: {
    title: '📊 Hướng dẫn — Tổng quan',
    sections: [
      { heading: 'Tin nhắn hôm nay', content: 'Tổng số tin nhắn gửi + nhận trong ngày hôm nay. So sánh % thay đổi với hôm qua.' },
      { heading: 'Tổng tin nhắn', content: 'Tổng số tin nhắn tích lũy toàn bộ thời gian, bao gồm cả gửi và nhận.' },
      { heading: 'Liên hệ & Nhóm', content: 'Tổng số liên hệ cá nhân (bạn bè + người lạ) và nhóm chat đã lưu trong hệ thống.' },
      { heading: '⏱️ Thời gian phản hồi', content: 'TB phản hồi, trung vị, nhanh nhất, chậm nhất — đo thời gian từ khi nhận tin đến khi trả lời (chỉ tính hội thoại 1-1).' },
      { heading: 'Biểu đồ lượng tin nhắn', content: 'Hiển thị xu hướng tin nhắn gửi/nhận theo giờ (≤7 ngày) hoặc theo ngày (>7 ngày) trong khoảng thời gian đã chọn.' },
      { heading: '📈 Tăng trưởng liên hệ', content: 'Biểu đồ số liên hệ mới xuất hiện theo ngày (dựa trên lần nhắn tin đầu tiên).' },
      { heading: '📊 Chi tiết theo nhãn', content: 'Biểu đồ ngang hiển thị top nhãn local được sử dụng nhiều nhất trong khoảng thời gian.' },
    ],
  },
  messages: {
    title: '💬 Hướng dẫn — Tin nhắn',
    sections: [
      { heading: 'KPI tổng quan', content: 'Hôm nay: tin nhắn trong ngày. Tổng: tất cả tin nhắn. TB/ngày: trung bình tin nhắn theo ngày trong khoảng thời gian. Tỷ lệ gửi: % tin bạn gửi / tổng.' },
      { heading: '⏱️ Thời gian phản hồi', content: 'Đo thời gian từ khi nhận tin nhắn đến khi bạn trả lời (chỉ tính hội thoại 1-1). Khi chọn "Nhóm" sẽ không hiển thị phần này.\n\n• TB phản hồi: thời gian trả lời trung bình\n• Trung vị: 50% tin nhắn được trả lời nhanh hơn con số này\n• Nhanh nhất / Chậm nhất: khoảng cực trị\n• Chỉ tính các phản hồi trong 7 ngày (bỏ qua hội thoại bị bỏ quên)' },
      { heading: '📊 Phân bổ thời gian phản hồi', content: 'Histogram chia nhóm thời gian phản hồi: <1 phút, 1–5 phút, 5–15 phút, ... >24 giờ. Màu xanh = nhanh, màu đỏ = chậm. Hiển thị % phản hồi trong 15 phút.' },
      { heading: '🕐 Phản hồi theo giờ', content: 'Thời gian phản hồi trung bình theo từng giờ trong ngày (0h–23h). Giúp xác định giờ bạn phản hồi nhanh/chậm nhất.' },
      { heading: '📈 Biểu đồ lượng tin nhắn', content: 'Biểu đồ area chart hiển thị tin gửi, nhận, tổng theo thời gian. Granularity tự động: ≤7 ngày = theo giờ, >7 ngày = theo ngày.' },
      { heading: '🔥 Heatmap', content: 'Ma trận 7 ngày × 24 giờ thể hiện mật độ tin nhắn. Giúp tìm giờ cao điểm giao tiếp.' },
    ],
  },
  contacts: {
    title: '👥 Hướng dẫn — Liên hệ',
    sections: [
      { heading: 'KPI', content: 'Tổng liên hệ, bạn bè, nhóm, và số liên hệ đã gắn tag.' },
      { heading: '📈 Tăng trưởng liên hệ', content: 'Biểu đồ số liên hệ mới xuất hiện theo ngày (dựa trên lần nhắn tin đầu tiên). Hiển thị ngay sau KPI để dễ theo dõi xu hướng.' },
      { heading: '🥧 Phân loại liên hệ', content: 'Biểu đồ tròn chia liên hệ theo loại: bạn bè, người lạ, OA, nhóm, v.v.' },
      { heading: '🤝 Lời mời kết bạn', content: 'Số lời mời kết bạn đã gửi và đã nhận trong khoảng thời gian, kèm biểu đồ xu hướng theo ngày.' },
    ],
  },
  labels: {
    title: '🏷️ Hướng dẫn — Nhãn (Local)',
    sections: [
      { heading: '⚠️ Phạm vi dữ liệu', content: 'Tab này CHỈ thống kê nhãn local (local labels) — nhãn do bạn tạo và gắn cho hội thoại trong ứng dụng. Không bao gồm nhãn từ Zalo.' },
      { heading: '📐 Logic truy vấn', content: '• Nguồn dữ liệu: bảng local_label_threads JOIN local_labels\n• Thời gian: lọc theo trường created_at (thời điểm gắn nhãn) trong khoảng thời gian đã chọn\n• Timeline: GROUP BY ngày bằng công thức CAST((created_at - sinceTs) / 86400000 AS INTEGER) — đếm số lượt gắn nhãn mỗi ngày\n• Theo nhãn: GROUP BY label_id, lấy tên/emoji/màu từ bảng local_labels, sắp xếp giảm dần theo số lượt' },
      { heading: '📊 Chỉ số hiển thị', content: '• Tổng lượt gắn nhãn: COUNT tổng trong khoảng thời gian\n• Số nhãn sử dụng: COUNT DISTINCT label_id\n• TB/ngày: tổng lượt ÷ số ngày trong khoảng thời gian\n• Biểu đồ cột theo ngày: lượt gắn nhãn mỗi ngày\n• Biểu đồ ngang theo nhãn: top 12 nhãn, mỗi thanh hiển thị màu riêng của nhãn' },
    ],
  },
  campaigns: {
    title: '📢 Hướng dẫn — Chiến dịch',
    sections: [
      { heading: 'KPI', content: 'Tổng chiến dịch, đã gửi, lỗi, trả lời, % gửi thành công. Tính trên toàn bộ chiến dịch.' },
      { heading: '📊 Top chiến dịch', content: 'Biểu đồ ngang so sánh top 10 chiến dịch theo số tin đã gửi, trả lời, lỗi.' },
      { heading: '📋 Chi tiết', content: 'Bảng liệt kê tất cả chiến dịch với trạng thái, số liệu gửi/lỗi/trả lời, tỷ lệ gửi thành công và phản hồi.' },
    ],
  },
  workflow: {
    title: '⚡ Hướng dẫn — Workflow',
    sections: [
      { heading: 'KPI', content: 'Tổng lượt chạy, thành công, lỗi, tỷ lệ thành công, thời gian chạy trung bình.' },
      { heading: '📈 Timeline', content: 'Biểu đồ lượt chạy thành công vs lỗi theo ngày trong khoảng thời gian.' },
      { heading: '🥧 Phân bổ kết quả', content: 'Biểu đồ tròn tỷ lệ thành công / lỗi tổng thể.' },
      { heading: '🏆 Top Workflows', content: 'Bảng xếp hạng các workflow theo lượt chạy và tỷ lệ thành công.' },
    ],
  },
  ai: {
    title: '🤖 Hướng dẫn — AI',
    sections: [
      { heading: 'KPI', content: 'Tổng requests, tổng tokens (prompt + completion). Token là đơn vị đo lường dữ liệu AI xử lý.' },
      { heading: '📈 Usage theo ngày', content: 'Biểu đồ kết hợp: cột = số requests, đường = tokens tiêu thụ theo ngày.' },
      { heading: '🥧 Phân bổ Model', content: 'Biểu đồ tròn tokens phân bổ theo từng model AI (GPT-4, GPT-3.5, v.v.).' },
      { heading: '📋 Chi tiết', content: 'Bảng chi tiết theo model và theo AI assistant: requests, tokens, TB tokens/request.' },
    ],
  },
  employees: {
    title: '👤 Hướng dẫn — Báo cáo Nhân viên',
    sections: [
      { heading: 'KPI tổng hợp', content: 'Số nhân viên, tổng tin gửi, hội thoại xử lý, TB phản hồi, tổng giờ online — tổng quan team trong khoảng thời gian.' },
      { heading: '📊 So sánh tin nhắn & hội thoại', content: 'Biểu đồ cột ngang so sánh hiệu suất từng nhân viên: số tin đã gửi và số hội thoại xử lý.' },
      { heading: '🥧 Phân bổ', content: 'Biểu đồ tròn thể hiện tỷ lệ đóng góp tin nhắn và giờ online của mỗi nhân viên.' },
      { heading: '📈 Timeline', content: 'Biểu đồ đường so sánh tin nhắn theo ngày giữa các nhân viên. Biểu đồ cột chồng so sánh giờ online theo ngày.' },
      { heading: '⏱️ Tốc độ phản hồi', content: 'Xếp hạng nhân viên theo thời gian phản hồi trung bình (xanh = nhanh, đỏ = chậm). Phân bổ thời gian phản hồi theo nhóm.' },
      { heading: '🕸️ Radar', content: 'So sánh đa chiều: tin gửi, hội thoại, online, tốc độ phản hồi — trực quan hóa điểm mạnh/yếu của từng nhân viên.' },
      { heading: '🕐 Hoạt động theo giờ', content: 'Biểu đồ tin nhắn theo từng giờ trong ngày — xác định khung giờ nhân viên hoạt động nhiều nhất.' },
      { heading: '📋 Bảng chi tiết', content: 'Bảng đầy đủ với thanh hiệu suất, hỗ trợ xuất CSV để báo cáo.' },
      { heading: '🔍 Bộ lọc', content: 'Chọn từng nhân viên để xem chi tiết riêng hoặc "Tất cả" để so sánh toàn team. Kết hợp với bộ lọc thời gian ở header.' },
    ],
  },
};

function GuideModal({ activeTab, onClose }: { activeTab: TabId; onClose: () => void }) {
  const guide = GUIDE_CONTENT[activeTab];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto m-4"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between rounded-t-2xl">
          <h3 className="text-base font-bold text-white">{guide.title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-700/50">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {guide.sections.map((s, i) => (
            <div key={i}>
              <h4 className="text-sm font-semibold text-blue-400 mb-1">{s.heading}</h4>
              <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-line">{s.content}</p>
            </div>
          ))}
          <div className="border-t border-gray-700 pt-3 mt-3">
            <p className="text-[11px] text-gray-500">
              💡 <strong className="text-gray-400">Bộ lọc liên hệ:</strong> Chọn "Cá nhân" để chỉ xem tin nhắn 1-1, "Nhóm" để chỉ xem nhóm chat, "Tất cả" để xem tổng hợp. Bộ lọc này ảnh hưởng đến báo cáo Tin nhắn, Tổng quan (biểu đồ).
            </p>
            <p className="text-[11px] text-gray-500 mt-1">
              📅 <strong className="text-gray-400">Thời gian:</strong> Chọn "Hôm nay", "Hôm qua", hoặc khoảng thời gian tùy chọn. Mặc định là 7 ngày gần nhất.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
export default function AnalyticsPage() {
  const { accounts, activeAccountId } = useAccountStore();
  const { analyticsInitialTab, setAnalyticsInitialTab } = useAppStore();

  const [selectedAccountId, setSelectedAccountId] = useState<string>(activeAccountId || '');
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (analyticsInitialTab && TABS.some(t => t.id === analyticsInitialTab)) {
      return analyticsInitialTab as TabId;
    }
    return 'overview';
  });
  const [period, setPeriod] = useState<TimePeriod>('7d');
  const [contactType, setContactType] = useState<ContactType>('all');
  const [loading, setLoading] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // Clear the initial tab after consuming it
  useEffect(() => {
    if (analyticsInitialTab) {
      setAnalyticsInitialTab(null);
    }
  }, []);

  // Custom date range
  const [customFrom, setCustomFrom] = useState<string>(() => toDateStr(new Date(Date.now() - 30 * 86400000)));
  const [customTo, setCustomTo] = useState<string>(() => toDateStr(new Date()));

  // Data
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapPoint[]>([]);
  const [segmentation, setSegmentation] = useState<SegmentData | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [friendReqs, setFriendReqs] = useState<{ totalSent: number; totalReceived: number; timeline: any[] }>({ totalSent: 0, totalReceived: 0, timeline: [] });
  const [contactGrowth, setContactGrowth] = useState<ContactGrowthPoint[]>([]);
  const [workflowData, setWorkflowData] = useState<WorkflowData | null>(null);
  const [aiData, setAIData] = useState<AIData | null>(null);
  const [responseTimeData, setResponseTimeData] = useState<ResponseTimeData | null>(null);
  const [labelUsageData, setLabelUsageData] = useState<LabelUsageData | null>(null);

  // Compute date range based on period
  const { from, to, periodDays } = useMemo(() => {
    if (period === 'custom') {
      const f = dateStrToTs(customFrom);
      const t = dateStrToTs(customTo) + 86400000 - 1; // end of day
      const days = Math.max(1, Math.ceil((t - f) / 86400000));
      return { from: f, to: t, periodDays: days };
    }
    if (period === 'today') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return { from: start, to: Date.now(), periodDays: 1 };
    }
    if (period === 'yesterday') {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      return { from: todayStart - 86400000, to: todayStart - 1, periodDays: 1 };
    }
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const t = Date.now();
    const f = t - days * 86400000;
    return { from: f, to: t, periodDays: days };
  }, [period, customFrom, customTo]);

  // Map contactType to threadType for IPC calls (-1 = all)
  const threadType = useMemo(() => {
    if (contactType === 'user') return 0;
    if (contactType === 'group') return 1;
    return -1; // all
  }, [contactType]);

  // Account options for AccountSelectorDropdown
  const accountOptions = useMemo(
    () => accounts.map(a => ({ id: a.zalo_id, name: a.display_name || a.full_name, phone: a.phone, avatarUrl: a.avatar_url })),
    [accounts]
  );

  // Auto-select first account
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccountId) {
      setSelectedAccountId(activeAccountId || accounts[0].zalo_id);
    }
  }, [accounts, selectedAccountId, activeAccountId]);

  const loadData = useCallback(async () => {
    if (!selectedAccountId) return;
    setLoading(true);
    const ipc = api();
    try {
      const tt = threadType === -1 ? undefined : threadType;
      const [overviewRes, volumeRes, heatmapRes, segRes, campRes, frRes, growthRes, wfRes, aiRes, rtRes, luRes] = await Promise.all([
        ipc?.dashboardOverview({ zaloId: selectedAccountId }),
        ipc?.messageVolume({ zaloId: selectedAccountId, sinceTs: from, untilTs: to, granularity: periodDays <= 7 ? 'hour' : 'day', threadType: tt }),
        ipc?.peakHours({ zaloId: selectedAccountId, sinceTs: from, untilTs: to, threadType: tt }),
        ipc?.contactSegmentation({ zaloId: selectedAccountId }),
        ipc?.campaignComparison({ zaloId: selectedAccountId }),
        ipc?.friendRequests({ zaloId: selectedAccountId, sinceTs: from, untilTs: to }),
        ipc?.contactGrowth({ zaloId: selectedAccountId, sinceTs: from, untilTs: to }),
        ipc?.workflowAnalytics({ zaloId: selectedAccountId, sinceTs: from, untilTs: to }),
        ipc?.aiAnalytics({ sinceTs: from, untilTs: to }),
        ipc?.responseTime({ zaloId: selectedAccountId, sinceTs: from, untilTs: to, threadType: tt }),
        ipc?.labelUsage({ zaloId: selectedAccountId, sinceTs: from, untilTs: to }),
      ]);
      if (overviewRes?.success) setOverview(overviewRes as any);
      if (volumeRes?.success) setVolume(volumeRes.data || []);
      if (heatmapRes?.success) setHeatmap(heatmapRes.data || []);
      if (segRes?.success) setSegmentation(segRes as any);
      if (campRes?.success) setCampaigns(campRes.data || []);
      if (frRes?.success) setFriendReqs({ totalSent: frRes.totalSent, totalReceived: frRes.totalReceived, timeline: frRes.timeline || [] });
      if (growthRes?.success) setContactGrowth(growthRes.data || []);
      if (wfRes?.success) setWorkflowData(wfRes as any);
      if (aiRes?.success) setAIData(aiRes as any);
      if (rtRes?.success) setResponseTimeData(rtRes as any);
      if (luRes?.success) setLabelUsageData(luRes as any);
    } catch { /* silent */ }
    setLoading(false);
  }, [selectedAccountId, from, to, periodDays, threadType]);

  useEffect(() => { loadData(); }, [loadData]);

  // Trend
  const todayTrend = overview ? (() => {
    const prev = overview.yesterdayMessages;
    const cur = overview.todayMessages;
    if (prev === 0) return undefined;
    const pct = Math.round((cur - prev) / prev * 100);
    return { value: `${pct >= 0 ? '+' : ''}${pct}%`, positive: pct >= 0 };
  })() : undefined;

  // Pie data
  const pieData = segmentation?.byType.filter(b => b.count > 0).map((b, i) => ({
    ...b, name: b.type, value: b.count, fill: PIE_COLORS[i % PIE_COLORS.length],
  })) || [];

  const tagPieData = segmentation ? [
    { name: 'Đã gắn tag', value: segmentation.tagged, fill: '#3b82f6' },
    { name: 'Chưa gắn tag', value: segmentation.untagged, fill: '#4b5563' },
  ].filter(d => d.value > 0) : [];

  // Workflow pie
  const wfPieData = workflowData ? [
    { name: 'Thành công', value: workflowData.successRuns, fill: '#10b981' },
    { name: 'Lỗi', value: workflowData.errorRuns, fill: '#ef4444' },
  ].filter(d => d.value > 0) : [];

  // AI model pie
  const aiModelPie = aiData?.byModel.map((m, i) => ({
    name: m.model, value: m.tokens, fill: PIE_COLORS[i % PIE_COLORS.length],
  })) || [];

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Chưa có tài khoản nào. Hãy thêm tài khoản Zalo trước.
      </div>
    );
  }

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 space-y-5">
      {/* ── Header: Account Selector + Period + Refresh ──────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-white mr-2">📊 Báo cáo & Phân tích</h2>

        {/* Account selector */}
        <AccountSelectorDropdown
          options={accountOptions}
          activeId={selectedAccountId}
          onSelect={setSelectedAccountId}
        />

        {/* Period presets */}
        <div className="flex gap-1">
          {(['today', 'yesterday', '7d', '30d', '90d', 'custom'] as TimePeriod[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                period === p ? 'bg-blue-600 text-white' : 'bg-gray-700/50 text-gray-400 hover:text-white hover:bg-gray-700'
              }`}>
              {p === 'today' ? 'Hôm nay' : p === 'yesterday' ? 'Hôm qua' : p === '7d' ? '7 ngày' : p === '30d' ? '30 ngày' : p === '90d' ? '90 ngày' : '📅 Tuỳ chọn'}
            </button>
          ))}
        </div>

        {/* Contact type filter */}
        <div className="flex gap-1 border-l border-gray-700 pl-3">
          {([['all', '👤👥 Tất cả'], ['user', '👤 Cá nhân'], ['group', '👥 Nhóm']] as [ContactType, string][]).map(([ct, label]) => (
            <button key={ct} onClick={() => setContactType(ct)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                contactType === ct ? 'bg-purple-600 text-white' : 'bg-gray-700/50 text-gray-400 hover:text-white hover:bg-gray-700'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Custom date range inputs */}
        {period === 'custom' && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={e => setCustomFrom(e.target.value)}
              className="bg-gray-700/60 border border-gray-600 rounded-lg text-xs text-gray-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-gray-500 text-xs">→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={toDateStr(new Date())}
              onChange={e => setCustomTo(e.target.value)}
              className="bg-gray-700/60 border border-gray-600 rounded-lg text-xs text-gray-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}

        {/* Help / Guide */}
        <button onClick={() => setShowGuide(true)} title="Hướng dẫn báo cáo"
          className="text-gray-400 hover:text-blue-400 transition-colors p-1.5 rounded-lg hover:bg-gray-700/50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>

        {/* Refresh */}
        <button onClick={loadData} title="Làm mới"
          className="text-gray-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-gray-700/50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* ── Guide Modal ───────────────────────────────────────────── */}
      {showGuide && <GuideModal activeTab={activeTab} onClose={() => setShowGuide(false)} />}

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-gray-700 pb-px overflow-x-auto">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-gray-800/80 text-white border-b-2 border-blue-500'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/30'
            }`}>
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ──────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <OverviewTab
          loading={loading} overview={overview} todayTrend={todayTrend}
          friendReqs={friendReqs} workflowData={workflowData} aiData={aiData}
          volume={volume} periodDays={periodDays}
          responseTime={responseTimeData} contactType={contactType}
          contactGrowth={contactGrowth} labelUsage={labelUsageData}
        />
      )}
      {activeTab === 'messages' && (
        <MessagesTab loading={loading} volume={volume} heatmap={heatmap} periodDays={periodDays} overview={overview} responseTime={responseTimeData} contactType={contactType} />
      )}
      {activeTab === 'contacts' && (
        <ContactsTab loading={loading} overview={overview} segmentation={segmentation}
          pieData={pieData} tagPieData={tagPieData} contactGrowth={contactGrowth}
          friendReqs={friendReqs} />
      )}
      {activeTab === 'labels' && (
        <LabelsTab loading={loading} labelUsage={labelUsageData} periodDays={periodDays} />
      )}
      {activeTab === 'campaigns' && (
        <CampaignsTab loading={loading} campaigns={campaigns} overview={overview} />
      )}
      {activeTab === 'workflow' && (
        <WorkflowTab loading={loading} workflowData={workflowData} wfPieData={wfPieData} />
      )}
      {activeTab === 'ai' && (
        <AITab loading={loading} aiData={aiData} aiModelPie={aiModelPie} />
      )}
      {activeTab === 'employees' && (
        <EmployeeAnalyticsTab sinceTs={from} untilTs={to} periodDays={periodDays} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Overview
// ══════════════════════════════════════════════════════════════════════════════
function OverviewTab({ loading, overview, todayTrend, friendReqs, workflowData, aiData, volume, periodDays, responseTime, contactType, contactGrowth, labelUsage }: {
  loading: boolean; overview: OverviewData | null;
  todayTrend?: { value: string; positive: boolean };
  friendReqs: { totalSent: number; totalReceived: number; timeline: any[] };
  workflowData: WorkflowData | null; aiData: AIData | null;
  volume: VolumePoint[]; periodDays: number;
  responseTime: ResponseTimeData | null; contactType: ContactType;
  contactGrowth: ContactGrowthPoint[]; labelUsage: LabelUsageData | null;
}) {
  if (loading || !overview) return <SkeletonCards count={8} />;
  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard icon="💬" label="Tin nhắn hôm nay" value={overview.todayMessages}
          sub={`${overview.todaySent} gửi · ${overview.todayReceived} nhận`}
          trend={todayTrend} color="blue" />
        <KPICard icon="📨" label="Tổng tin nhắn" value={overview.totalMessages}
          sub={`${overview.totalSent} gửi · ${overview.totalReceived} nhận`} color="purple" />
        <KPICard icon="👥" label="Liên hệ" value={overview.totalContacts}
          sub={`${overview.totalFriends} bạn bè`} color="green" />
        <KPICard icon="👨‍👩‍👧‍👦" label="Nhóm" value={overview.totalGroups} color="cyan" />
        <KPICard icon="📢" label="Chiến dịch" value={overview.totalCampaigns}
          sub={overview.activeCampaigns > 0 ? `${overview.activeCampaigns} đang chạy` : 'Không có đang chạy'}
          color={overview.activeCampaigns > 0 ? 'green' : 'yellow'} />
        <KPICard icon="🤝" label="Lời mời KB" value={friendReqs.totalReceived + friendReqs.totalSent}
          sub={`${friendReqs.totalSent} gửi · ${friendReqs.totalReceived} nhận`} color="yellow" />
        <KPICard icon="⚡" label="Workflow chạy" value={workflowData?.totalRuns ?? 0}
          sub={workflowData ? `${workflowData.successRate}% thành công` : '—'} color="orange" />
        <KPICard icon="🤖" label="AI requests" value={aiData?.totalRequests ?? 0}
          sub={aiData ? `${aiData.totalTokens.toLocaleString('vi-VN')} tokens` : '—'} color="purple" />
      </div>


      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title={`📈 Tin nhắn ${periodDays <= 7 ? 'theo giờ' : `${periodDays} ngày qua`}`}>
          {volume.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={volume} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gRecv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={ChartTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                  <Area type="monotone" dataKey="sent" name="Gửi" stroke="#3b82f6" fill="url(#gSent)" strokeWidth={2} />
                  <Area type="monotone" dataKey="received" name="Nhận" stroke="#10b981" fill="url(#gRecv)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        {/* ── Response Time by hour (overview) ────────────────────────── */}
        {contactType !== 'group' && responseTime && responseTime.totalReplies > 0 && (
            <Section title="🕐 Thời gian phản hồi trung bình theo giờ trong ngày">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={responseTime.byHour.filter(h => h.count > 0)} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                           tickFormatter={(h: number) => `${h}h`} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false}
                           tickFormatter={(v: number) => fmtDurationShort(v)} />
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                          <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                            <p className="text-gray-400 mb-1 font-medium">{d.hour}:00 – {d.hour}:59</p>
                            <p className="text-white">TB: <span className="font-bold text-blue-400">{fmtDuration(d.avgSeconds)}</span></p>
                            <p className="text-gray-500">{d.count} lượt trả lời</p>
                          </div>
                      );
                    }} />
                    <Bar dataKey="avgSeconds" name="TB phản hồi" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {(() => {
                const active = responseTime.byHour.filter(h => h.count > 0);
                if (active.length === 0) return null;
                const fastest = active.reduce((a, b) => a.avgSeconds < b.avgSeconds ? a : b);
                const slowest = active.reduce((a, b) => a.avgSeconds > b.avgSeconds ? a : b);
                return (
                    <p className="text-[11px] text-gray-500 mt-2 text-center">
                      🚀 Nhanh nhất lúc <span className="text-green-400 font-semibold">{fastest.hour}h</span>
                      {' '}({fmtDuration(fastest.avgSeconds)})
                      {' · '}
                      🐢 Chậm nhất lúc <span className="text-red-400 font-semibold">{slowest.hour}h</span>
                      {' '}({fmtDuration(slowest.avgSeconds)})
                    </p>
                );
              })()}
            </Section>
        )}

        {/* Contact Growth */}
        <Section title="📈 Tăng trưởng liên hệ">
          {contactGrowth.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={contactGrowth} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="gGrowthOv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={ChartTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                  <Area type="monotone" dataKey="newContacts" name="Liên hệ mới" stroke="#8b5cf6" fill="url(#gGrowthOv)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* Label details */}
      {labelUsage && labelUsage.byLabel.length > 0 && (
        <Section title="📊 Chi tiết theo từng nhãn">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={labelUsage.byLabel.slice(0, 30)} layout="vertical"
                margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                  width={90} tickFormatter={(v: string) => v.length > 12 ? v.slice(0, 10) + '…' : v} />
                <Tooltip content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  const pct = labelUsage.totalAssignments > 0 ? Math.round(d.count / labelUsage.totalAssignments * 100) : 0;
                  return (
                    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                      <p className="text-white font-medium mb-1">{d.emoji} {d.name}</p>
                      <p className="text-blue-400 font-bold">{d.count} lượt <span className="text-gray-400 font-normal">({pct}%)</span></p>
                    </div>
                  );
                }} />
                <Bar dataKey="count" name="Lượt" radius={[0, 3, 3, 0]} maxBarSize={18}>
                  {labelUsage.byLabel.slice(0, 30).map((d, i) => (
                    <Cell key={i} fill={d.color || PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Messages
// ══════════════════════════════════════════════════════════════════════════════

/** Format seconds into a human-friendly string */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}p ${s}s` : `${m} phút`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}p` : `${h} giờ`;
}

/** Short format for charts */
function fmtDurationShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}p`;
  return `${Math.round(seconds / 3600 * 10) / 10}h`;
}

interface MessagesTabProps {
  loading: boolean;
  volume: VolumePoint[];
  heatmap: HeatmapPoint[];
  periodDays: number;
  overview: OverviewData | null;
  responseTime: ResponseTimeData | null;
  contactType: ContactType;
}

function MessagesTab({ loading, volume, heatmap, periodDays, overview, responseTime, contactType }: MessagesTabProps) {
  if (loading) return <SkeletonChart />;
  const avgPerDay = overview && periodDays > 0
    ? Math.round(overview.totalMessages / periodDays) : 0;
  const sentRatio = overview && overview.totalMessages > 0
    ? Math.round(overview.totalSent / overview.totalMessages * 100) : 0;

  // Response time distribution bar colors
  const RT_COLORS = ['#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b', '#f97316', '#ef4444', '#dc2626', '#991b1b', '#7f1d1d'];

  return (
    <div className="space-y-5">
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPICard icon="💬" label="Hôm nay" value={overview.todayMessages}
            sub={`${overview.todaySent} gửi · ${overview.todayReceived} nhận`} color="blue" />
          <KPICard icon="📨" label="Tổng tin nhắn" value={overview.totalMessages} color="purple" />
          <KPICard icon="📊" label="TB/ngày" value={avgPerDay} color="cyan" />
          <KPICard icon="📤" label="Tỷ lệ gửi" value={`${sentRatio}%`}
            sub={`${overview.totalSent} / ${overview.totalMessages}`} color="green" />
        </div>
      )}

      {/* ── Response Time Section ───────────────────────────────────── */}
      {contactType !== 'group' && responseTime && responseTime.totalReplies > 0 && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <KPICard icon="⏱️" label="TB phản hồi" value={fmtDuration(responseTime.avgSeconds)}
              sub={`${responseTime.totalReplies} lượt trả lời`} color="blue" />
            <KPICard icon="📊" label="Trung vị" value={fmtDuration(responseTime.medianSeconds)}
              sub="50% trả lời nhanh hơn" color="cyan" />
            <KPICard icon="🚀" label="Nhanh nhất" value={fmtDuration(responseTime.minSeconds)} color="green" />
            <KPICard icon="🐢" label="Chậm nhất" value={fmtDuration(responseTime.maxSeconds)} color="red" />
            <KPICard icon="💬" label="Hội thoại" value={responseTime.totalConversations}
              sub="có phản hồi" color="purple" />
          </div>

          {/* Distribution + By-hour charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Distribution chart */}
            <Section title="📊 Phân bổ thời gian phản hồi">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={responseTime.distribution.filter(d => d.count > 0)} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} interval={0} angle={-20} textAnchor="end" height={45} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const total = responseTime.totalReplies;
                      const pct = total > 0 ? Math.round(d.count / total * 100) : 0;
                      return (
                        <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-gray-400 mb-1 font-medium">{d.bucket}</p>
                          <p className="text-white font-bold">{d.count} lượt <span className="text-gray-400 font-normal">({pct}%)</span></p>
                        </div>
                      );
                    }} />
                    <Bar dataKey="count" name="Số lượt" radius={[4, 4, 0, 0]} maxBarSize={32}>
                      {responseTime.distribution.filter(d => d.count > 0).map((_, i) => (
                        <Cell key={i} fill={RT_COLORS[i % RT_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Quick summary */}
              {(() => {
                const fast = responseTime.distribution.slice(0, 3).reduce((s, d) => s + d.count, 0);
                const pct = responseTime.totalReplies > 0 ? Math.round(fast / responseTime.totalReplies * 100) : 0;
                return (
                  <p className="text-[11px] text-gray-500 mt-2 text-center">
                    ✅ <span className="text-green-400 font-semibold">{pct}%</span> tin nhắn được phản hồi trong <span className="text-white">15 phút</span>
                    {' · '}Tổng <span className="text-white">{responseTime.totalReplies}</span> lượt
                  </p>
                );
              })()}
            </Section>

            {/* By-hour chart */}
            <Section title="🕐 Thời gian phản hồi TB theo giờ trong ngày">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={responseTime.byHour.filter(h => h.count > 0)} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                      tickFormatter={(h: number) => `${h}h`} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false}
                      tickFormatter={(v: number) => fmtDurationShort(v)} />
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-gray-400 mb-1 font-medium">{d.hour}:00 – {d.hour}:59</p>
                          <p className="text-white">TB: <span className="font-bold text-blue-400">{fmtDuration(d.avgSeconds)}</span></p>
                          <p className="text-gray-500">{d.count} lượt trả lời</p>
                        </div>
                      );
                    }} />
                    <Bar dataKey="avgSeconds" name="TB phản hồi" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Find peak & low hours */}
              {(() => {
                const active = responseTime.byHour.filter(h => h.count > 0);
                if (active.length === 0) return null;
                const fastest = active.reduce((a, b) => a.avgSeconds < b.avgSeconds ? a : b);
                const slowest = active.reduce((a, b) => a.avgSeconds > b.avgSeconds ? a : b);
                return (
                  <p className="text-[11px] text-gray-500 mt-2 text-center">
                    🚀 Nhanh nhất lúc <span className="text-green-400 font-semibold">{fastest.hour}h</span>
                    {' '}({fmtDuration(fastest.avgSeconds)})
                    {' · '}
                    🐢 Chậm nhất lúc <span className="text-red-400 font-semibold">{slowest.hour}h</span>
                    {' '}({fmtDuration(slowest.avgSeconds)})
                  </p>
                );
              })()}
            </Section>
          </div>
        </>
      )}

      {contactType !== 'group' && responseTime && responseTime.totalReplies === 0 && (
        <Section title="⏱️ Thời gian phản hồi">
          <p className="text-xs text-gray-500 text-center py-6">
            Chưa có dữ liệu phản hồi trong khoảng thời gian này.
            <br />
            <span className="text-gray-600">Cần có tin nhắn đến và tin trả lời để đo thời gian phản hồi.</span>
          </p>
        </Section>
      )}

      <Section title={`📈 Lượng tin nhắn ${periodDays <= 7 ? 'theo giờ' : `${periodDays} ngày qua`}`}>
        {volume.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={volume} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="gSent2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gRecv2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={ChartTooltip} />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Area type="monotone" dataKey="sent" name="Gửi" stroke="#3b82f6" fill="url(#gSent2)" strokeWidth={2} />
                <Area type="monotone" dataKey="received" name="Nhận" stroke="#10b981" fill="url(#gRecv2)" strokeWidth={2} />
                <Area type="monotone" dataKey="total" name="Tổng" stroke="#8b5cf6" fill="none" strokeWidth={1.5} strokeDasharray="4 2" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      <Section title="🔥 Heatmap giờ cao điểm (7 ngày × 24 giờ)">
        {heatmap.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
        ) : (
          <HeatmapGrid data={heatmap} />
        )}
      </Section>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Contacts
// ══════════════════════════════════════════════════════════════════════════════
function ContactsTab({ loading, overview, segmentation, pieData, tagPieData, contactGrowth, friendReqs }: {
  loading: boolean; overview: OverviewData | null; segmentation: SegmentData | null;
  pieData: any[]; tagPieData: any[];  contactGrowth: ContactGrowthPoint[];
  friendReqs: { totalSent: number; totalReceived: number; timeline: any[] };
}) {
  if (loading) return <SkeletonChart />;
  return (
    <div className="space-y-5">
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPICard icon="👥" label="Tổng liên hệ" value={overview.totalContacts} color="green" />
          <KPICard icon="🤝" label="Bạn bè" value={overview.totalFriends} color="blue" />
          <KPICard icon="👨‍👩‍👧‍👦" label="Nhóm" value={overview.totalGroups} color="cyan" />
          <KPICard icon="🏷️" label="Đã gắn tag" value={segmentation?.tagged ?? 0}
            sub={segmentation ? `${segmentation.untagged} chưa gắn` : ''} color="purple" />
        </div>
      )}

      {/* Contact growth chart — right after KPI */}
      {contactGrowth.length > 0 && (
        <Section title="📈 Tăng trưởng liên hệ">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={contactGrowth} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="gGrowth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={ChartTooltip} />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Area type="monotone" dataKey="newContacts" name="Mới" stroke="#8b5cf6" fill="url(#gGrowth)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <Section title="🥧 Phân loại liên hệ">
          {pieData.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    innerRadius={40} outerRadius={70} paddingAngle={3} strokeWidth={0}>
                    {pieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip content={PieTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title="🤝 Lời mời kết bạn">
          {friendReqs.timeline.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div>
              <div className="flex gap-3 mb-3">
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 flex-1 text-center">
                  <div className="text-lg font-bold text-blue-400">{friendReqs.totalSent}</div>
                  <div className="text-[10px] text-gray-500">Đã gửi</div>
                </div>
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex-1 text-center">
                  <div className="text-lg font-bold text-green-400">{friendReqs.totalReceived}</div>
                  <div className="text-[10px] text-gray-500">Đã nhận</div>
                </div>
              </div>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={friendReqs.timeline.filter(t => t.sent + t.received > 0).slice(-14)} margin={{ top: 0, right: 0, bottom: 0, left: -24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 8, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 8, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={ChartTooltip} />
                    <Bar dataKey="sent" name="Gửi" fill="#3b82f6" radius={[2, 2, 0, 0]} maxBarSize={12} />
                    <Bar dataKey="received" name="Nhận" fill="#10b981" radius={[2, 2, 0, 0]} maxBarSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Labels (Nhãn Local)
// ══════════════════════════════════════════════════════════════════════════════
function LabelsTab({ loading, labelUsage, periodDays }: {
  loading: boolean; labelUsage: LabelUsageData | null; periodDays: number;
}) {
  if (loading) return <SkeletonChart />;
  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 rounded-xl px-4 py-2.5">
        <span className="text-base">🏷️</span>
        <p className="text-xs text-purple-300">
          <strong>Chỉ thống kê nhãn local</strong> — Nhãn do bạn tự tạo và gắn cho hội thoại trong ứng dụng. Không bao gồm nhãn từ Zalo.
        </p>
      </div>

      {labelUsage && labelUsage.totalAssignments > 0 && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <KPICard icon="🏷️" label="Tổng lượt gắn nhãn" value={labelUsage.totalAssignments}
              sub={`trong ${periodDays} ngày`} color="purple" />
            <KPICard icon="📊" label="Số nhãn sử dụng" value={labelUsage.totalLabelsUsed} color="blue" />
            <KPICard icon="📈" label="TB/ngày" value={labelUsage.avgPerDay} color="cyan" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Timeline chart */}
            <Section title={`🏷️ Lượt gắn nhãn theo ngày (${periodDays} ngày)`}>
              {labelUsage.timeline.filter(t => t.count > 0).length === 0 ? (
                <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
              ) : (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={labelUsage.timeline} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="gLabel" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.6} />
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.1} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                      <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip content={({ active, payload }: any) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                            <p className="text-gray-400 mb-1 font-medium">{d.bucket}</p>
                            <p className="text-white font-bold">{d.count} lượt gắn nhãn</p>
                          </div>
                        );
                      }} />
                      <Bar dataKey="count" name="Lượt gắn" fill="url(#gLabel)" radius={[3, 3, 0, 0]} maxBarSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Section>

            {/* By-label breakdown chart */}
            <Section title="📊 Chi tiết theo từng nhãn">
              {labelUsage.byLabel.length === 0 ? (
                <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
              ) : (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={labelUsage.byLabel.slice(0, 30)} layout="vertical"
                      margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                        width={90} tickFormatter={(v: string) => v.length > 12 ? v.slice(0, 10) + '…' : v} />
                      <Tooltip content={({ active, payload }: any) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        const pct = labelUsage.totalAssignments > 0 ? Math.round(d.count / labelUsage.totalAssignments * 100) : 0;
                        return (
                          <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
                            <p className="text-white font-medium mb-1">{d.emoji} {d.name}</p>
                            <p className="text-blue-400 font-bold">{d.count} lượt <span className="text-gray-400 font-normal">({pct}%)</span></p>
                          </div>
                        );
                      }} />
                      <Bar dataKey="count" name="Lượt" radius={[0, 3, 3, 0]} maxBarSize={18}>
                        {labelUsage.byLabel.slice(0, 30).map((d, i) => (
                          <Cell key={i} fill={d.color || PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Section>
          </div>
        </>
      )}

      {labelUsage && labelUsage.totalAssignments === 0 && (
        <Section title="🏷️ Thống kê sử dụng nhãn">
          <p className="text-xs text-gray-500 text-center py-6">
            Chưa có dữ liệu gắn nhãn trong khoảng thời gian này.
            <br />
            <span className="text-gray-600">Gắn nhãn local cho các hội thoại để xem thống kê tại đây.</span>
          </p>
        </Section>
      )}

      {!labelUsage && <SkeletonChart />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Campaigns
// ══════════════════════════════════════════════════════════════════════════════
function CampaignsTab({ loading, campaigns, overview }: {
  loading: boolean; campaigns: CampaignRow[]; overview: OverviewData | null;
}) {
  if (loading) return <SkeletonChart />;

  const totalSent = campaigns.reduce((s, c) => s + c.sent, 0);
  const totalFailed = campaigns.reduce((s, c) => s + c.failed, 0);
  const totalReplied = campaigns.reduce((s, c) => s + c.replied, 0);
  const avgDelivery = campaigns.length > 0
    ? Math.round(campaigns.reduce((s, c) => s + c.deliveryRate, 0) / campaigns.length) : 0;
  const avgReply = campaigns.length > 0
    ? Math.round(campaigns.reduce((s, c) => s + c.replyRate, 0) / campaigns.length) : 0;

  // Bar chart data: top 10 campaigns by sent
  const barData = campaigns.slice(0, 10).map(c => ({
    name: c.name.length > 18 ? c.name.slice(0, 16) + '…' : c.name,
    sent: c.sent, failed: c.failed, replied: c.replied,
  }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon="📢" label="Tổng chiến dịch" value={overview?.totalCampaigns ?? campaigns.length} color="blue" />
        <KPICard icon="✅" label="Đã gửi" value={totalSent} color="green" />
        <KPICard icon="❌" label="Lỗi" value={totalFailed} color="red" />
        <KPICard icon="💬" label="Trả lời" value={totalReplied} color="cyan" />
        <KPICard icon="📊" label="Gửi thành công" value={`${avgDelivery}%`}
          sub={`Reply: ${avgReply}%`} color="purple" />
      </div>

      {/* Top campaigns bar chart */}
      {barData.length > 0 && (
        <Section title="📊 Top chiến dịch (theo số gửi)">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip content={ChartTooltip} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="sent" name="Đã gửi" fill="#3b82f6" radius={[0, 2, 2, 0]} maxBarSize={16} />
                <Bar dataKey="replied" name="Trả lời" fill="#10b981" radius={[0, 2, 2, 0]} maxBarSize={16} />
                <Bar dataKey="failed" name="Lỗi" fill="#ef4444" radius={[0, 2, 2, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Campaign table */}
      {campaigns.length > 0 && (
        <Section title="📋 Chi tiết chiến dịch">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 px-2 font-medium">Tên</th>
                  <th className="text-center py-2 px-2 font-medium">Trạng thái</th>
                  <th className="text-right py-2 px-1 font-medium">Tổng</th>
                  <th className="text-right py-2 px-1 font-medium">Đã gửi</th>
                  <th className="text-right py-2 px-1 font-medium">Lỗi</th>
                  <th className="text-right py-2 px-1 font-medium">Trả lời</th>
                  <th className="text-right py-2 px-2 font-medium">Gửi thành công %</th>
                  <th className="text-right py-2 px-2 font-medium">Phản hồi lại %</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.slice(0, 20).map(c => (
                  <tr key={c.id} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                    <td className="py-2 px-2 text-gray-200 font-medium max-w-[200px] truncate">{c.name}</td>
                    <td className="py-2 px-2 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${ST_CLS[c.status] || 'bg-gray-700 text-gray-400'}`}>
                        {ST_LABEL[c.status] || c.status}
                      </span>
                    </td>
                    <td className="py-2 px-1 text-right text-gray-300">{c.total}</td>
                    <td className="py-2 px-1 text-right text-green-400">{c.sent}</td>
                    <td className="py-2 px-1 text-right text-red-400">{c.failed || 0}</td>
                    <td className="py-2 px-1 text-right text-blue-400">{c.replied}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={c.deliveryRate >= 80 ? 'text-green-400' : c.deliveryRate >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                        {c.deliveryRate}%
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <span className={c.replyRate >= 30 ? 'text-green-400' : c.replyRate >= 10 ? 'text-yellow-400' : 'text-gray-500'}>
                        {c.replyRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {campaigns.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có chiến dịch nào</p>
          )}
        </Section>
      )}

      {campaigns.length === 0 && (
        <div className="text-center py-16 text-gray-500 text-sm">
          <span className="text-3xl mb-3 block">📢</span>
          Chưa có chiến dịch nào cho tài khoản này
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Workflow
// ══════════════════════════════════════════════════════════════════════════════
function WorkflowTab({ loading, workflowData, wfPieData }: {
  loading: boolean; workflowData: WorkflowData | null; wfPieData: any[];
}) {
  if (loading) return <SkeletonChart />;
  if (!workflowData || workflowData.totalRuns === 0) {
    return (
      <div className="text-center py-16 text-gray-500 text-sm">
        <span className="text-3xl mb-3 block">⚡</span>
        Chưa có dữ liệu workflow trong khoảng thời gian đã chọn
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon="⚡" label="Tổng lượt chạy" value={workflowData.totalRuns} color="blue" />
        <KPICard icon="✅" label="Thành công" value={workflowData.successRuns} color="green" />
        <KPICard icon="❌" label="Lỗi" value={workflowData.errorRuns} color="red" />
        <KPICard icon="📊" label="Tỷ lệ thành công" value={`${workflowData.successRate}%`} color="cyan" />
        <KPICard icon="⏱️" label="TB thời gian" value={`${(workflowData.avgDuration / 1000).toFixed(1)}s`} color="purple" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Timeline */}
        <Section title="📈 Lượt chạy theo ngày">
          {workflowData.timeline.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={workflowData.timeline} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={ChartTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="success" name="Thành công" fill="#10b981" radius={[2, 2, 0, 0]} maxBarSize={16} stackId="wf" />
                  <Bar dataKey="error" name="Lỗi" fill="#ef4444" radius={[2, 2, 0, 0]} maxBarSize={16} stackId="wf" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        {/* Success/Error pie */}
        <Section title="🥧 Phân bổ kết quả">
          {wfPieData.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={wfPieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    innerRadius={40} outerRadius={70} paddingAngle={3} strokeWidth={0}>
                    {wfPieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip content={PieTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* Top workflows table */}
      {workflowData.topWorkflows.length > 0 && (
        <Section title="🏆 Top Workflows">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 px-2 font-medium">#</th>
                  <th className="text-left py-2 px-2 font-medium">Tên Workflow</th>
                  <th className="text-right py-2 px-2 font-medium">Lượt chạy</th>
                  <th className="text-right py-2 px-2 font-medium">Tỷ lệ thành công</th>
                </tr>
              </thead>
              <tbody>
                {workflowData.topWorkflows.map((wf, i) => (
                  <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                    <td className="py-2 px-2 text-gray-500">{i + 1}</td>
                    <td className="py-2 px-2 text-gray-200 font-medium">{wf.workflowName}</td>
                    <td className="py-2 px-2 text-right text-gray-300">{wf.runs}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={wf.successRate >= 80 ? 'text-green-400' : wf.successRate >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                        {wf.successRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: AI
// ══════════════════════════════════════════════════════════════════════════════
function AITab({ loading, aiData, aiModelPie }: {
  loading: boolean; aiData: AIData | null; aiModelPie: any[];
}) {
  if (loading) return <SkeletonChart />;
  if (!aiData || aiData.totalRequests === 0) {
    return (
      <div className="text-center py-16 text-gray-500 text-sm">
        <span className="text-3xl mb-3 block">🤖</span>
        Chưa có dữ liệu AI trong khoảng thời gian đã chọn
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard icon="🤖" label="Tổng requests" value={aiData.totalRequests} color="blue" />
        <KPICard icon="🔤" label="Tổng tokens" value={aiData.totalTokens} color="purple" />
        <KPICard icon="📥" label="Prompt tokens" value={aiData.totalPromptTokens} color="cyan" />
        <KPICard icon="📤" label="Completion tokens" value={aiData.totalCompletionTokens} color="green" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Timeline: requests + tokens */}
        <Section title="📈 AI usage theo ngày">
          {aiData.timeline.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={aiData.timeline} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={ChartTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar yAxisId="left" dataKey="requests" name="Requests" fill="#3b82f6" radius={[2, 2, 0, 0]} maxBarSize={16} />
                  <Line yAxisId="right" type="monotone" dataKey="tokens" name="Tokens" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        {/* Model breakdown pie */}
        <Section title="🥧 Phân bổ theo Model">
          {aiModelPie.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div className="h-52 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={aiModelPie} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    innerRadius={40} outerRadius={70} paddingAngle={3} strokeWidth={0}>
                    {aiModelPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip content={PieTooltip} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
      </div>

      {/* By model table */}
      {aiData.byModel.length > 0 && (
        <Section title="📋 Chi tiết theo Model">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 px-2 font-medium">Model</th>
                  <th className="text-right py-2 px-2 font-medium">Requests</th>
                  <th className="text-right py-2 px-2 font-medium">Tokens</th>
                  <th className="text-right py-2 px-2 font-medium">TB tokens/req</th>
                </tr>
              </thead>
              <tbody>
                {aiData.byModel.map((m, i) => (
                  <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                    <td className="py-2 px-2 text-gray-200 font-medium">{m.model}</td>
                    <td className="py-2 px-2 text-right text-gray-300">{m.requests.toLocaleString('vi-VN')}</td>
                    <td className="py-2 px-2 text-right text-blue-400">{m.tokens.toLocaleString('vi-VN')}</td>
                    <td className="py-2 px-2 text-right text-gray-400">
                      {m.requests > 0 ? Math.round(m.tokens / m.requests).toLocaleString('vi-VN') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* By assistant table */}
      {aiData.byAssistant.length > 0 && (
        <Section title="🧠 Chi tiết theo AI Assistant">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-2 px-2 font-medium">Assistant</th>
                  <th className="text-right py-2 px-2 font-medium">Requests</th>
                  <th className="text-right py-2 px-2 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {aiData.byAssistant.map((a, i) => (
                  <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                    <td className="py-2 px-2 text-gray-200 font-medium">{a.assistantName}</td>
                    <td className="py-2 px-2 text-right text-gray-300">{a.requests.toLocaleString('vi-VN')}</td>
                    <td className="py-2 px-2 text-right text-blue-400">{a.tokens.toLocaleString('vi-VN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}




