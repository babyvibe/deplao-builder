import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import AccountMultiDropdown from '@/components/common/accounts/AccountMultiDropdown';
import EmployeeAnalyticsTab from './EmployeeAnalyticsTab';
import PageLoading from '@/components/common/PageLoading';
import { ActivityIcon, AlertIcon, AwardIcon, BarChartIcon, BotIcon, BrainIcon, CalendarIcon, CampaignIcon, ChartIcon, ChatIcon, CheckIcon, ClipboardIcon, ClipboardListIcon, ClockIcon, CloseIcon, InboxIcon, InfoIcon, LightningIcon, MailIcon, MessageIcon, PieChartIcon, RocketIcon, SearchIcon, SendIcon, StarIcon, SunIcon, TagIcon, TrendingUpIcon, UserCheckIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { resolveAnalyticsRange, toLocalDateInput } from '@/lib/analytics/analyticsRange';
import {
  ANALYTICS_ACCOUNTS_STORAGE_KEY, isAllAccounts, parseStoredAccountSelection, resolveSelectedAccounts,
  serializeAccountSelection, type StoredAccountSelection,
} from '@/lib/analytics/accountSelection';
import {
  loadAnalyticsReport, type AccountFailure, type AnalyticsTabId, type SectionFailure,
} from '@/lib/analytics/loadAnalyticsReport';
import {
  campaignTotals, percent, todayTrend as overviewTodayTrend, topCampaignsBySent,
  type AccountResult, type AIAnalytics, type CampaignRow, type ContactGrowthPoint, type ContactSegmentation,
  type DashboardOverview, type FriendRequestStats, type HeatmapPoint, type LabelUsage, type ResponseTimeStats,
  type VolumePoint, type WorkflowAnalytics,
} from '@/lib/analytics/mergeAnalytics';

// ── Types (DB report shapes, shared with the multi-account merge) ──────────────
type OverviewData = DashboardOverview;
type SegmentData = ContactSegmentation;
type WorkflowData = WorkflowAnalytics;
type AIData = AIAnalytics;
type ResponseTimeData = ResponseTimeStats;
type LabelUsageData = LabelUsage;

// ── Helpers ────────────────────────────────────────────────────────────────────
const DAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const PIE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316', '#14b8a6'];
const ST_CLS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400', paused: 'bg-yellow-500/20 text-yellow-400',
  done: 'bg-blue-500/20 text-blue-400', draft: 'bg-muted text-muted-foreground',
};
const ST_LABEL: Record<string, string> = { active: '▶ Chạy', paused: '⏸ Dừng', done: '✓ Xong', draft: 'Nháp' };
const EMPTY_FRIEND_REQUESTS: FriendRequestStats = { totalSent: 0, totalReceived: 0, timeline: [] };

/** Account name as in the account filter (AccountMultiDropdown). */
function accountLabel(account: AccountInfo | undefined, zaloId: string): string {
  return account?.full_name || account?.display_name || zaloId;
}

function AccountName({ account, zaloId }: { account?: AccountInfo; zaloId: string }) {
  const name = accountLabel(account, zaloId);
  return (
    <span className="flex items-center gap-2 min-w-0">
      {account?.avatar_url ? (
        <img src={account.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
      ) : (
        <span className="w-5 h-5 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-[9px] font-bold shrink-0">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="truncate text-foreground">{name}</span>
    </span>
  );
}

/** One-line note about how a block is computed (multi-account rules, account-independent data). */
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <InfoIcon className="w-3.5 h-3.5 shrink-0 mt-px" />
      <span>{children}</span>
    </p>
  );
}

const SECTION_LABEL: Record<SectionFailure['section'], string> = {
  workflow: 'Workflow', responseTime: 'thời gian phản hồi', ai: 'AI',
};

/** Non-blocking warning: the report still shows the accounts / blocks that loaded. */
function ReportWarnings({ failedAccounts, failedSections, loadError, totalAccounts, accountsById }: {
  failedAccounts: AccountFailure[]; failedSections: SectionFailure[]; loadError: string | null;
  totalAccounts: number; accountsById: Map<string, AccountInfo>;
}) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertIcon className="w-4 h-4 shrink-0 mt-px" />
      <div className="space-y-0.5 min-w-0">
        {failedAccounts.length > 0 && (
          <p>
            Không tải được dữ liệu của{' '}
            {failedAccounts.map((f, i) => (
              <React.Fragment key={f.zaloId}>
                {i > 0 && ', '}
                <span className="font-semibold" title={f.error}>{accountLabel(accountsById.get(f.zaloId), f.zaloId)}</span>
              </React.Fragment>
            ))}
            {' '}- số liệu bên dưới chỉ gồm {Math.max(0, totalAccounts - failedAccounts.length)}/{totalAccounts} tài khoản.
          </p>
        )}
        {failedSections.map(f => (
          <p key={f.section}>Không tải được mục {SECTION_LABEL[f.section]}: {f.error}</p>
        ))}
        {loadError && <p>Không tải được báo cáo: {loadError}</p>}
      </div>
    </div>
  );
}

// ── Shared UI Components ──────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, trend, color = 'blue' }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string;
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
        <span className="flex-shrink-0">{icon}</span>
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-foreground">{typeof value === 'number' ? value.toLocaleString('vi-VN') : value}</span>
        {trend && (
          <span className={`text-xs font-semibold pb-0.5 ${trend.positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {trend.positive ? '▲' : '▼'} {trend.value}
          </span>
        )}
      </div>
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

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-muted-foreground mb-1 font-medium">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color || p.fill }} />
            <span className="text-foreground/80">{p.name}</span>
          </span>
          <span className="font-bold text-foreground">{typeof p.value === 'number' ? p.value.toLocaleString('vi-VN') : p.value}</span>
        </div>
      ))}
    </div>
  );
};

const PieTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.fill || d.color }} />
        <span className="text-foreground font-medium">{d.name || d.type}</span>
      </div>
      <span className="text-blue-300 font-bold">{(d.value || d.count || 0).toLocaleString('vi-VN')}</span>
    </div>
  );
};

function HeatmapGrid({ data }: { data: HeatmapPoint[] }) {
  const maxCount = useMemo(() => Math.max(1, ...data.map(d => d.count)), [data]);
  const getColor = (count: number) => {
    if (count === 0) return 'bg-card';
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
            <div key={h} className="flex-1 text-center text-[9px] text-muted-foreground">
              {hourLabels.includes(h) ? `${h}h` : ''}
            </div>
          ))}
        </div>
        {DAY_NAMES.map((day, d) => (
          <div key={d} className="flex items-center gap-px mb-px">
            <span className="w-7 text-[10px] text-muted-foreground text-right pr-1 flex-shrink-0">{day}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const count = grid.get(`${d}_${h}`) || 0;
              return (
                <div key={h}
                  className={`flex-1 aspect-square rounded-sm ${getColor(count)} transition-colors`}
                  title={`${day} ${h}:00 - ${count} tin nhắn`}
                />
              );
            })}
          </div>
        ))}
        <div className="flex items-center gap-1 mt-2 ml-8">
          <span className="text-[9px] text-muted-foreground">Ít</span>
          {['bg-card', 'bg-blue-900/40', 'bg-blue-700/50', 'bg-blue-600/60', 'bg-blue-500/70', 'bg-blue-400/80'].map((c, i) => (
            <div key={i} className={`w-3 h-3 rounded-sm ${c}`} />
          ))}
          <span className="text-[9px] text-muted-foreground">Nhiều</span>
        </div>
      </div>
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
type TabId = AnalyticsTabId;
const TABS: { id: TabId; icon: React.ReactNode; label: string }[] = [
  { id: 'overview', icon: <ChartIcon className="w-4 h-4" />, label: 'Tổng quan' },
  { id: 'messages', icon: <ChatIcon className="w-4 h-4" />, label: 'Tin nhắn' },
  { id: 'contacts', icon: <UsersIcon className="w-4 h-4" />, label: 'Liên hệ' },
  { id: 'labels', icon: <TagIcon className="w-4 h-4" />, label: 'Nhãn' },
  { id: 'employees', icon: <UserIcon className="w-4 h-4" />, label: 'Nhân viên' },
  { id: 'campaigns', icon: <CampaignIcon className="w-4 h-4" />, label: 'Chiến dịch' },
  { id: 'workflow', icon: <LightningIcon className="w-4 h-4" />, label: 'Workflow' },
  { id: 'ai', icon: <BotIcon className="w-4 h-4" />, label: 'AI' },
];

type TimePeriod = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'custom';
type ContactType = 'all' | 'user' | 'group';

/** Format Date to yyyy-MM-dd for <input type="date"> */

// ── Guide Modal ────────────────────────────────────────────────────────────────
const GUIDE_CONTENT: Record<TabId, { title: string; sections: Array<{ heading: string; content: string }> }> = {
  overview: {
    title: 'Hướng dẫn - Tổng quan',
    sections: [
      { heading: 'Tin nhắn hôm nay', content: 'Tin gửi + nhận từ 00:00 hôm nay đến hiện tại. Mũi tên ▲ / ▼ so sánh với cả ngày hôm qua (không hiện khi hôm qua không có tin).' },
      { heading: 'Tổng tin nhắn', content: 'Tin gửi + nhận trong khoảng thời gian và loại hội thoại đang chọn.' },
      { heading: 'Liên hệ, Nhóm', content: 'Liên hệ: số liên hệ cá nhân đã lưu, kèm số bạn bè. Nhóm: số nhóm đã lưu. Hai số này là tổng hiện có, không đổi theo khoảng thời gian.' },
      { heading: 'Chiến dịch, Lời mời KB', content: 'Chiến dịch: tổng số chiến dịch và số đang chạy. Lời mời KB: lời mời kết bạn đã gửi và đã nhận trong khoảng thời gian.' },
      { heading: 'Workflow chạy, AI requests', content: 'Workflow chạy: số lượt chạy và % thành công trong khoảng thời gian. AI requests: số request và tokens, tính trên toàn ứng dụng.' },
      { heading: 'Biểu đồ tin nhắn', content: 'Tin gửi / nhận theo giờ khi khoảng thời gian từ 2 ngày trở xuống (Hôm nay, Hôm qua), theo ngày lịch khi dài hơn. Ngày tính theo giờ máy: "7 ngày" = hôm nay và 6 ngày trước, mỗi điểm là một ngày từ 00:00 đến 23:59, điểm cuối là hôm nay.' },
      { heading: 'Tăng trưởng liên hệ', content: 'Số hội thoại 1-1 theo ngày: mỗi hội thoại được tính một lần, vào ngày có tin nhắn đầu tiên trong khoảng thời gian đang chọn.' },
      { heading: 'Chi tiết theo từng nhãn', content: 'Số lượt gắn Nhãn Local trong khoảng thời gian, nhãn dùng nhiều nhất ở trên (không gồm nhãn Zalo).' },
      { heading: 'Theo tài khoản', content: 'Hiện khi chọn từ 2 tài khoản: tin nhắn, gửi, nhận, hôm nay, liên hệ, bạn bè, nhóm và tỷ trọng tin nhắn của từng tài khoản, nhiều tin nhất ở trên.' },
    ],
  },
  messages: {
    title: 'Hướng dẫn - Tin nhắn',
    sections: [
      { heading: 'KPI', content: 'Hôm nay: tin gửi + nhận từ 00:00 hôm nay. Tổng tin nhắn: trong khoảng thời gian đang chọn. TB/ngày: tổng tin chia số ngày của khoảng. Tỷ lệ gửi: % tin bạn gửi trên tổng.' },
      { heading: 'Thời gian phản hồi', content: 'Đo từ lúc khách nhắn đến khi bạn trả lời, chỉ tính chat 1-1 và các lần trả lời trong vòng 7 ngày (bỏ qua hội thoại bị bỏ quên). Không hiện khi chọn loại hội thoại "Nhóm".\n\n• TB phản hồi: thời gian trả lời trung bình\n• Trung vị: một nửa số lần trả lời nhanh hơn con số này\n• Nhanh nhất / Chậm nhất: hai mức cực trị\n• Hội thoại: số chat 1-1 có ít nhất một lần trả lời' },
      { heading: 'Phân bổ thời gian phản hồi', content: 'Số lần trả lời theo từng khoảng: < 1 phút, 1–5 phút, 5–15 phút … > 24 giờ (xanh = nhanh, đỏ = chậm), kèm % tin được phản hồi trong 15 phút.' },
      { heading: 'Thời gian phản hồi TB theo giờ', content: 'Thời gian trả lời trung bình theo giờ khách nhắn đến (0h–23h), chỉ ra giờ bạn trả lời nhanh nhất và chậm nhất.' },
      { heading: 'Lượng tin nhắn', content: 'Tin gửi, nhận và tổng theo thời gian: khoảng từ 2 ngày trở xuống vẽ theo giờ, dài hơn vẽ theo ngày lịch (00:00–23:59, điểm cuối là hôm nay).' },
      { heading: 'Heatmap giờ cao điểm', content: 'Lưới Thứ 2 → Chủ nhật × 24 giờ, ô càng đậm càng nhiều tin - giúp tìm khung giờ khách nhắn nhiều nhất.' },
    ],
  },
  contacts: {
    title: 'Hướng dẫn - Liên hệ',
    sections: [
      { heading: 'KPI', content: 'Tổng liên hệ, Bạn bè, Nhóm và Đã gắn tag (kèm số chưa gắn). Đây là tổng hiện có, không đổi theo khoảng thời gian. Khi chọn nhiều tài khoản, mỗi tài khoản được đếm riêng: một người là liên hệ của 2 tài khoản được tính 2 lần.' },
      { heading: 'Tăng trưởng liên hệ', content: 'Số hội thoại 1-1 theo ngày: mỗi hội thoại được tính một lần, vào ngày có tin nhắn đầu tiên trong khoảng thời gian đang chọn.' },
      { heading: 'Phân loại liên hệ', content: 'Biểu đồ tròn chia liên hệ thành Bạn bè, Người lạ và Nhóm.' },
      { heading: 'Lời mời kết bạn', content: 'Số lời mời kết bạn Đã gửi và Đã nhận trong khoảng thời gian, kèm biểu đồ theo ngày (tối đa 14 ngày gần nhất có lời mời).' },
    ],
  },
  labels: {
    title: 'Hướng dẫn - Nhãn (Local)',
    sections: [
      { heading: 'Phạm vi dữ liệu', content: 'Tab này chỉ thống kê Nhãn Local - nhãn bạn tạo và gắn cho hội thoại trong ứng dụng. Không gồm nhãn Zalo.' },
      { heading: 'Cách tính', content: '• Mỗi lần gắn một nhãn cho một hội thoại là một lượt, tính theo thời điểm gắn nằm trong khoảng thời gian đang chọn\n• Nhãn đã gỡ khỏi hội thoại không còn được tính\n• Theo ngày: chia theo ngày lịch trên giờ máy (00:00–23:59)' },
      { heading: 'Chỉ số hiển thị', content: '• Tổng lượt gắn nhãn trong khoảng thời gian\n• Số nhãn sử dụng: số nhãn khác nhau đã được gắn\n• TB/ngày: tổng lượt chia số ngày của khoảng\n• Lượt gắn nhãn theo ngày (biểu đồ cột)\n• Chi tiết theo từng nhãn: nhãn dùng nhiều nhất ở trên, mỗi thanh mang màu của nhãn' },
    ],
  },
  campaigns: {
    title: 'Hướng dẫn - Chiến dịch',
    sections: [
      { heading: 'KPI', content: 'Tổng chiến dịch, Đã gửi, Lỗi, Trả lời và Gửi thành công (kèm Phản hồi). Gửi thành công % = tổng đã gửi ÷ tổng liên hệ của các chiến dịch; Phản hồi % = tổng trả lời ÷ tổng đã gửi.' },
      { heading: 'Trả lời', content: 'Số người nhận đã nhắn lại sau thời điểm nhận tin của chiến dịch.' },
      { heading: 'Top chiến dịch (theo số gửi)', content: 'Biểu đồ ngang so sánh Đã gửi, Trả lời, Lỗi của 10 chiến dịch gửi nhiều nhất.' },
      { heading: 'Chi tiết chiến dịch', content: 'Bảng 20 chiến dịch mới nhất với trạng thái, Tổng, Đã gửi, Lỗi, Trả lời, Gửi thành công % và Phản hồi lại %; có thêm cột Tài khoản khi chọn nhiều tài khoản.' },
      { heading: 'Phạm vi', content: 'Tab này tính trên mọi chiến dịch của các tài khoản đang chọn, không phụ thuộc khoảng thời gian.' },
    ],
  },
  workflow: {
    title: 'Hướng dẫn - Workflow',
    sections: [
      { heading: 'KPI', content: 'Tổng lượt chạy, Thành công, Lỗi, Tỷ lệ thành công (lượt thành công ÷ tổng lượt) và TB thời gian của một lượt chạy, trong khoảng thời gian đang chọn.' },
      { heading: 'Lượt chạy theo ngày', content: 'Biểu đồ cột chồng lượt thành công và lỗi theo từng ngày lịch.' },
      { heading: 'Phân bổ kết quả', content: 'Biểu đồ tròn tỷ lệ thành công / lỗi tổng thể.' },
      { heading: 'Top Workflows', content: 'Tối đa 10 workflow chạy nhiều nhất, kèm tỷ lệ thành công của từng workflow.' },
      { heading: 'Nhiều tài khoản', content: 'Tính các workflow gắn với tài khoản đang chọn; workflow gắn nhiều tài khoản đã chọn chỉ được tính một lần.' },
    ],
  },
  ai: {
    title: 'Hướng dẫn - AI',
    sections: [
      { heading: 'KPI', content: 'Tổng requests, Tổng tokens, Prompt tokens (phần gửi cho AI) và Completion tokens (phần AI trả lời). Token là đơn vị đo lượng chữ AI xử lý.' },
      { heading: 'AI usage theo ngày', content: 'Biểu đồ kết hợp: cột = số requests, đường = tokens tiêu thụ theo ngày lịch.' },
      { heading: 'Phân bổ theo Model', content: 'Biểu đồ tròn tokens theo từng model AI đã dùng.' },
      { heading: 'Chi tiết', content: 'Bảng theo Model (requests, tokens, TB tokens/request) và theo AI Assistant (requests, tokens), dùng nhiều tokens nhất ở trên.' },
      { heading: 'Phạm vi', content: 'Số liệu AI tính trên toàn ứng dụng: nhật ký AI không ghi theo tài khoản nên bộ lọc tài khoản không áp dụng.' },
    ],
  },
  employees: {
    title: 'Hướng dẫn - Báo cáo Nhân viên',
    sections: [
      { heading: 'KPI tổng hợp', content: 'Số nhân viên (kèm số đang hoạt động), Tổng tin gửi, Hội thoại xử lý (số hội thoại khác nhau nhân viên đã gửi tin), TB phản hồi của team và Tổng giờ online (kèm trung bình mỗi nhân viên) trong khoảng thời gian.' },
      { heading: 'So sánh tin nhắn & hội thoại', content: 'Biểu đồ cột ngang so sánh số tin đã gửi và số hội thoại xử lý của từng nhân viên.' },
      { heading: 'Phân bổ', content: 'Hai biểu đồ tròn: tỷ lệ đóng góp tin nhắn và giờ online của mỗi nhân viên.' },
      { heading: 'Theo ngày', content: 'Tin nhắn theo ngày (mỗi nhân viên một màu) và giờ online theo ngày (cột chồng), chia theo ngày lịch.' },
      { heading: 'Tốc độ phản hồi', content: 'TB phản hồi = thời gian từ tin nhắn gần nhất của khách đến khi nhân viên trả lời (chỉ tính các lần dưới 24 giờ). Xếp hạng tốc độ phản hồi: xanh dưới 5 phút, vàng dưới 15 phút, đỏ chậm hơn; kèm phân bổ thời gian phản hồi theo nhóm.' },
      { heading: 'So sánh đa chiều', content: 'Biểu đồ radar: tin gửi, hội thoại, giờ online, tốc độ phản hồi - thấy điểm mạnh / yếu của từng người (cần ít nhất 2 nhân viên, hiện tối đa 6 người).' },
      { heading: 'Hoạt động theo giờ', content: 'Mức hoạt động của nhân viên theo từng giờ trong ngày - xác định khung giờ làm việc nhiều nhất.' },
      { heading: 'Bảng chi tiết', content: 'Từng nhân viên với Tin gửi, Hội thoại, TB phản hồi, Online và Hiệu suất (số tin gửi so với người gửi nhiều nhất), dòng Tổng ở cuối; nút Xuất CSV để báo cáo.' },
      { heading: 'Bộ lọc', content: 'Chọn một hoặc nhiều nhân viên để so sánh, hoặc "Tất cả" để xem cả team; kết hợp với bộ lọc thời gian và tài khoản ở đầu trang. Giờ online tính theo phiên đăng nhập của nhân viên nên không tách theo tài khoản.' },
    ],
  },
};

function GuideModal({ activeTab, onClose }: { activeTab: TabId; onClose: () => void }) {
  const guide = GUIDE_CONTENT[activeTab];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-input rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto m-4"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between rounded-t-2xl">
          <h3 className="text-base font-bold text-foreground">{guide.title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted/50">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {guide.sections.map((s, i) => (
            <div key={i}>
              <h4 className="text-sm font-semibold text-blue-400 mb-1">{s.heading}</h4>
              <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-line">{s.content}</p>
            </div>
          ))}
          <div className="border-t border-border pt-3 mt-3">
            <p className="text-[11px] text-muted-foreground"><SunIcon className="w-4 h-4 inline" /> <strong className="text-muted-foreground">Loại hội thoại:</strong> "Cá nhân" = chat 1-1, "Nhóm" = nhóm chat, "Tất cả" = tổng hợp. Áp dụng cho số liệu tin nhắn (Tổng quan, Tin nhắn).
            </p>
            <p className="text-[11px] text-muted-foreground mt-1"><CalendarIcon className="w-4 h-4 inline" /> <strong className="text-muted-foreground">Thời gian:</strong> "Hôm nay", "Hôm qua", 7 / 30 / 90 ngày hoặc Tuỳ chọn (mặc định 7 ngày), tính theo ngày lịch trên giờ máy.
            </p>
            <p className="text-[11px] text-muted-foreground mt-1"><UsersIcon className="w-4 h-4 inline" /> <strong className="text-muted-foreground">Tài khoản:</strong> Chọn một, nhiều tài khoản hoặc "Tất cả tài khoản" (lựa chọn được ghi nhớ). Số liệu được cộng gộp; tỷ lệ % và giá trị trung bình được tính lại từ tổng, không lấy trung bình các %. Liên hệ, bạn bè, nhóm được đếm theo từng tài khoản. Thống kê AI tính trên toàn ứng dụng.
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
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const analyticsInitialTab = useAppStore(s => s.analyticsInitialTab);
  const setAnalyticsInitialTab = useAppStore(s => s.setAnalyticsInitialTab);

  // Account filter: one, several or all accounts; remembered (null = never chosen → active account).
  const [storedSelection, setStoredSelection] = useState<StoredAccountSelection>(() => {
    try { return parseStoredAccountSelection(localStorage.getItem(ANALYTICS_ACCOUNTS_STORAGE_KEY)); } catch { return null; }
  });
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (analyticsInitialTab && TABS.some(t => t.id === analyticsInitialTab)) {
      return analyticsInitialTab as TabId;
    }
    return 'overview';
  });
  const [period, setPeriod] = useState<TimePeriod>('7d');
  const [contactType, setContactType] = useState<ContactType>('all');
  // true from the start: a report load always follows the first render (avoids an empty-state flash).
  const [loading, setLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  // Clear the initial tab after consuming it
  useEffect(() => {
    if (analyticsInitialTab) {
      setAnalyticsInitialTab(null);
    }
  }, []);

  // Custom date range
  const [customFrom, setCustomFrom] = useState<string>(() => toLocalDateInput(new Date(Date.now() - 30 * 86400000)));
  const [customTo, setCustomTo] = useState<string>(() => toLocalDateInput(new Date()));
  /** Bumped by "Làm mới": open ranges end at `now`, so the range must be recomputed to count new messages. */
  const [rangeNonce, setRangeNonce] = useState(0);

  // Data
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewByAccount, setOverviewByAccount] = useState<Array<AccountResult<OverviewData>>>([]);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapPoint[]>([]);
  const [segmentation, setSegmentation] = useState<SegmentData | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [friendReqs, setFriendReqs] = useState<FriendRequestStats>(EMPTY_FRIEND_REQUESTS);
  const [contactGrowth, setContactGrowth] = useState<ContactGrowthPoint[]>([]);
  const [workflowData, setWorkflowData] = useState<WorkflowData | null>(null);
  const [aiData, setAIData] = useState<AIData | null>(null);
  const [responseTimeData, setResponseTimeData] = useState<ResponseTimeData | null>(null);
  const [labelUsageData, setLabelUsageData] = useState<LabelUsageData | null>(null);
  // Accounts / blocks that failed in the last load (non-blocking warning)
  const [failedAccounts, setFailedAccounts] = useState<AccountFailure[]>([]);
  const [failedSections, setFailedSections] = useState<SectionFailure[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  // Local calendar days: "7 ngày" = today + the 6 days before, from 00:00 (was now − 7×24h,
  // which split every chart point across two days and left "today" empty).
  const { from, to, periodDays } = useMemo(
    () => resolveAnalyticsRange(period, customFrom, customTo),
    [period, customFrom, customTo, rangeNonce], // rangeNonce: "Làm mới" re-reads `now`
  );

  const periodLabel = period === 'today' ? 'hôm nay'
    : period === 'yesterday' ? 'hôm qua'
      : period === '7d' ? '7 ngày'
        : period === '30d' ? '30 ngày'
          : period === '90d' ? '90 ngày'
            : `${periodDays} ngày`;

  // Map contactType to threadType for IPC calls (-1 = all)
  const threadType = useMemo(() => {
    if (contactType === 'user') return 0;
    if (contactType === 'group') return 1;
    return -1; // all
  }, [contactType]);

  // Selected accounts, keyed by content: the accounts array is replaced on every status / listener
  // update, which must not rebuild `selectedIds` (and reload the report).
  const accountIdsKey = useMemo(() => JSON.stringify(accounts.map(a => a.zalo_id)), [accounts]);
  const allAccountIds = useMemo<string[]>(() => JSON.parse(accountIdsKey), [accountIdsKey]);
  const selectedKey = useMemo(
    () => JSON.stringify(resolveSelectedAccounts(storedSelection, allAccountIds, activeAccountId)),
    [storedSelection, allAccountIds, activeAccountId],
  );
  const selectedIds = useMemo<string[]>(() => JSON.parse(selectedKey), [selectedKey]);
  const allSelected = isAllAccounts(selectedIds, allAccountIds);
  const multiAccount = selectedIds.length > 1;
  const accountsById = useMemo(() => new Map(accounts.map(a => [a.zalo_id, a] as [string, AccountInfo])), [accounts]);

  const handleAccountsChange = useCallback((ids: string[]) => {
    if (ids.length === 0) return; // at least one account
    setStoredSelection(isAllAccounts(ids, allAccountIds) ? 'all' : ids);
    try { localStorage.setItem(ANALYTICS_ACCOUNTS_STORAGE_KEY, serializeAccountSelection(ids, allAccountIds)); } catch { /* storage unavailable */ }
  }, [allAccountIds]);

  const loadData = useCallback(async () => {
    if (selectedIds.length === 0) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setFailedAccounts([]);
    setFailedSections([]);
    setLoadError(null);
    try {
      // Only the data the visible tab renders (heatmap / response-time scans are expensive on large
      // archives); every selected account in parallel (bounded), merged into one report.
      const report = await loadAnalyticsReport(activeTab, {
        zaloIds: selectedIds, sinceTs: from, untilTs: to,
        granularity: periodDays <= 2 ? 'hour' : 'day',
        threadType: threadType === -1 ? undefined : threadType,
      });
      if (seq !== loadSeqRef.current) return; // a newer load (tab / filter change) owns the state
      if (report.overview !== undefined) setOverview(report.overview);
      if (report.overviewByAccount !== undefined) setOverviewByAccount(report.overviewByAccount);
      if (report.volume !== undefined) setVolume(report.volume);
      if (report.heatmap !== undefined) setHeatmap(report.heatmap);
      if (report.friendRequests !== undefined) setFriendReqs(report.friendRequests ?? EMPTY_FRIEND_REQUESTS);
      if (report.contactGrowth !== undefined) setContactGrowth(report.contactGrowth);
      if (report.segmentation !== undefined) setSegmentation(report.segmentation);
      if (report.campaigns !== undefined) setCampaigns(report.campaigns);
      if (report.labelUsage !== undefined) setLabelUsageData(report.labelUsage);
      if (report.workflow !== undefined) setWorkflowData(report.workflow);
      if (report.responseTime !== undefined) setResponseTimeData(report.responseTime);
      if (report.ai !== undefined) setAIData(report.ai);
      setFailedAccounts(report.failedAccounts);
      setFailedSections(report.failedSections);
    } catch (err: any) {
      if (seq === loadSeqRef.current) setLoadError(err?.message || 'Lỗi không rõ');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
    // rangeNonce: "Làm mới" also reloads closed ranges (Hôm qua / Tuỳ chọn) whose from/to do not change.
  }, [activeTab, selectedIds, from, to, periodDays, threadType, rangeNonce]);

  useEffect(() => { loadData(); }, [loadData]);

  // Trend: today vs yesterday, both summed over the same accounts
  const todayTrend = overviewTodayTrend(overview);

  // Pie data
  const pieData = (segmentation?.byType || []).filter((b: any) => b.count > 0).map((b: any, i: number) => ({
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
  const aiModelPie = (aiData?.byModel || []).map((m: any, i: number) => ({
    name: m.model, value: m.tokens, fill: PIE_COLORS[i % PIE_COLORS.length],
  })) || [];

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Chưa có tài khoản nào. Hãy thêm tài khoản Zalo trước.
      </div>
    );
  }

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 space-y-5">
      {/* ── Header: Account Selector + Period + Refresh ──────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-foreground mr-2"><ChartIcon className="w-4 h-4 inline" /> Báo cáo & Phân tích</h2>

        {/* Account filter: several accounts are merged into one report */}
        <AccountMultiDropdown
          accounts={accounts}
          selectedIds={selectedIds}
          onChange={handleAccountsChange}
          selectAllLabel="Tất cả tài khoản"
          minSelected={1}
          showOnlyAction
        />

        {/* Period presets */}
        <div className="flex gap-1">
          {(['today', 'yesterday', '7d', '30d', '90d', 'custom'] as TimePeriod[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                period === p ? 'bg-blue-600 text-white' : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}>
              {p === 'today' ? 'Hôm nay' : p === 'yesterday' ? 'Hôm qua' : p === '7d' ? '7 ngày' : p === '30d' ? '30 ngày' : p === '90d' ? '90 ngày' : 'Tuỳ chọn'}
            </button>
          ))}
        </div>

        {/* Contact type filter */}
        <div className="flex gap-1 border-l border-border pl-3">
          {([['all', 'Tất cả'], ['user', 'Cá nhân'], ['group', 'Nhóm']] as [ContactType, string][]).map(([ct, label]) => (
            <button key={ct} onClick={() => setContactType(ct)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                contactType === ct ? 'bg-purple-600 text-white' : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted'
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
              className="bg-muted/60 border border-input rounded-lg text-xs text-foreground px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-muted-foreground text-xs">→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={toLocalDateInput(new Date())}
              onChange={e => setCustomTo(e.target.value)}
              className="bg-muted/60 border border-input rounded-lg text-xs text-foreground px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}

        {/* Help / Guide */}
        <button onClick={() => setShowGuide(true)} title="Hướng dẫn báo cáo"
          className="text-muted-foreground hover:text-blue-400 transition-colors p-1.5 rounded-lg hover:bg-muted/50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>

        {/* Refresh */}
        <button onClick={() => setRangeNonce(n => n + 1)} title="Làm mới"
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* ── Guide Modal ───────────────────────────────────────────── */}
      {showGuide && <GuideModal activeTab={activeTab} onClose={() => setShowGuide(false)} />}

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-border pb-px overflow-x-auto">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-card/80 text-foreground border-b-2 border-blue-500'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            }`}>
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* ── Partial-load warning (the rest of the report still renders) ─────── */}
      {!loading && (failedAccounts.length > 0 || failedSections.length > 0 || loadError) && (
        <ReportWarnings
          failedAccounts={failedAccounts} failedSections={failedSections} loadError={loadError}
          totalAccounts={selectedIds.length} accountsById={accountsById}
        />
      )}

      {/* ── Tab Content ──────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <OverviewTab
          loading={loading} overview={overview} todayTrend={todayTrend}
          friendReqs={friendReqs} workflowData={workflowData} aiData={aiData}
          volume={volume} periodDays={periodDays} periodLabel={periodLabel}
          contactGrowth={contactGrowth} labelUsage={labelUsageData}
          overviewByAccount={multiAccount ? overviewByAccount : []} accountsById={accountsById}
        />
      )}
      {activeTab === 'messages' && (
        <MessagesTab loading={loading} volume={volume} heatmap={heatmap} periodDays={periodDays} periodLabel={periodLabel} overview={overview} responseTime={responseTimeData} contactType={contactType} />
      )}
      {activeTab === 'contacts' && (
        <ContactsTab loading={loading} overview={overview} segmentation={segmentation}
          pieData={pieData} tagPieData={tagPieData} contactGrowth={contactGrowth}
          friendReqs={friendReqs} multiAccount={multiAccount} />
      )}
      {activeTab === 'labels' && (
        <LabelsTab loading={loading} labelUsage={labelUsageData} periodDays={periodDays} />
      )}
      {activeTab === 'campaigns' && (
        <CampaignsTab loading={loading} campaigns={campaigns} overview={overview}
          multiAccount={multiAccount} accountsById={accountsById} />
      )}
      {activeTab === 'workflow' && (
        <WorkflowTab loading={loading} workflowData={workflowData} wfPieData={wfPieData} multiAccount={multiAccount} />
      )}
      {activeTab === 'ai' && (
        <AITab loading={loading} aiData={aiData} aiModelPie={aiModelPie} />
      )}
      {activeTab === 'employees' && (
        <EmployeeAnalyticsTab sinceTs={from} untilTs={to} periodDays={periodDays}
          zaloIds={allSelected ? undefined : selectedIds} refreshKey={rangeNonce} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Overview
// ══════════════════════════════════════════════════════════════════════════════
function OverviewTab({ loading, overview, todayTrend, friendReqs, workflowData, aiData, volume, periodDays, periodLabel, contactGrowth, labelUsage, overviewByAccount, accountsById }: {
  loading: boolean; overview: OverviewData | null;
  todayTrend?: { value: string; positive: boolean };
  friendReqs: FriendRequestStats;
  workflowData: WorkflowData | null; aiData: AIData | null;
  volume: VolumePoint[]; periodDays: number; periodLabel: string;
  contactGrowth: ContactGrowthPoint[]; labelUsage: LabelUsageData | null;
  /** Per-account rows (only when several accounts are selected). */
  overviewByAccount: Array<AccountResult<OverviewData>>; accountsById: Map<string, AccountInfo>;
}) {
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="cards" text="Đang tải tổng quan..." />;
  if (!overview) {
    return <div className="text-center py-16 text-muted-foreground text-sm">Chưa có dữ liệu tổng quan</div>;
  }
  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard icon={<ChatIcon className="w-4 h-4" />} label="Tin nhắn hôm nay" value={overview.todayMessages}
          sub={`${overview.todaySent} gửi · ${overview.todayReceived} nhận`}
          trend={todayTrend} color="blue" />
        <KPICard icon={<SendIcon className="w-4 h-4" />} label={`Tổng tin nhắn (${periodLabel})`} value={overview.totalMessages}
          sub={`${overview.totalSent} gửi · ${overview.totalReceived} nhận`} color="purple" />
        <KPICard icon={<UsersIcon className="w-4 h-4" />} label="Liên hệ" value={overview.totalContacts}
          sub={`${overview.totalFriends} bạn bè`} color="green" />
        <KPICard icon={<UsersIcon className="w-4 h-4" />} label="Nhóm" value={overview.totalGroups} color="cyan" />
        <KPICard icon={<CampaignIcon className="w-4 h-4" />} label="Chiến dịch" value={overview.totalCampaigns}
          sub={overview.activeCampaigns > 0 ? `${overview.activeCampaigns} đang chạy` : 'Không có đang chạy'}
          color={overview.activeCampaigns > 0 ? 'green' : 'yellow'} />
        <KPICard icon={<UserCheckIcon className="w-4 h-4" />} label="Lời mời KB" value={friendReqs.totalReceived + friendReqs.totalSent}
          sub={`${friendReqs.totalSent} gửi · ${friendReqs.totalReceived} nhận`} color="yellow" />
        <KPICard icon={<LightningIcon className="w-4 h-4" />} label="Workflow chạy" value={workflowData?.totalRuns ?? 0}
          sub={workflowData ? `${workflowData.successRate}% thành công` : '-'} color="orange" />
        <KPICard icon={<BotIcon className="w-4 h-4" />} label="AI requests" value={aiData?.totalRequests ?? 0}
          sub={`${aiData?.totalTokens ? `${aiData.totalTokens.toLocaleString('vi-VN')} tokens · ` : ''}toàn ứng dụng`} color="purple" />
      </div>


      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Section title={<><TrendingUpIcon className="w-4 h-4" /> Tin nhắn {periodDays <= 2 ? 'theo giờ' : `${periodDays} ngày qua`}</>}>
          {volume.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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

        {/* Contact Growth */}
        <Section title={<><TrendingUpIcon className="w-4 h-4" /> Tăng trưởng liên hệ</>}>
          {contactGrowth.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
      {labelUsage?.byLabel?.length > 0 && (
        <Section title={<><ChartIcon className="w-4 h-4" /> Chi tiết theo từng nhãn</>}>
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
                    <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                      <p className="text-foreground font-medium mb-1">{d.emoji} {d.name}</p>
                      <p className="text-blue-400 font-bold">{d.count} lượt <span className="text-muted-foreground font-normal">({pct}%)</span></p>
                    </div>
                  );
                }} />
                <Bar dataKey="count" name="Lượt" radius={[0, 3, 3, 0]} maxBarSize={18}>
                  {(labelUsage?.byLabel || []).slice(0, 30).map((d: any, i: number) => (
                    <Cell key={i} fill={d.color || PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Per-account breakdown (several accounts selected) */}
      {overviewByAccount.length > 1 && (
        <AccountBreakdown rows={overviewByAccount} accountsById={accountsById} periodLabel={periodLabel} />
      )}
    </div>
  );
}

/** Overview counters of each selected account, busiest first; the share is of the period's messages. */
function AccountBreakdown({ rows, accountsById, periodLabel }: {
  rows: Array<AccountResult<OverviewData>>; accountsById: Map<string, AccountInfo>; periodLabel: string;
}) {
  const sorted = [...rows].sort((a, b) => b.data.totalMessages - a.data.totalMessages);
  const grandTotal = sorted.reduce((sum, row) => sum + row.data.totalMessages, 0);
  const fmt = (value: number) => value.toLocaleString('vi-VN');
  return (
    <Section title={<><UsersIcon className="w-4 h-4" /> Theo tài khoản</>}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-2 px-2 font-medium">Tài khoản</th>
              <th className="text-right py-2 px-2 font-medium">Tin nhắn ({periodLabel})</th>
              <th className="text-right py-2 px-2 font-medium">Gửi</th>
              <th className="text-right py-2 px-2 font-medium">Nhận</th>
              <th className="text-right py-2 px-2 font-medium">Hôm nay</th>
              <th className="text-right py-2 px-2 font-medium">Liên hệ</th>
              <th className="text-right py-2 px-2 font-medium">Bạn bè</th>
              <th className="text-right py-2 px-2 font-medium">Nhóm</th>
              <th className="text-left py-2 px-2 font-medium w-36">Tỷ trọng tin nhắn</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ zaloId, data }) => {
              const share = percent(data.totalMessages, grandTotal);
              return (
                <tr key={zaloId} className="border-b border-border/50 hover:bg-muted/40 transition-colors">
                  <td className="py-2 px-2 max-w-[220px]"><AccountName account={accountsById.get(zaloId)} zaloId={zaloId} /></td>
                  <td className="py-2 px-2 text-right font-semibold text-foreground">{fmt(data.totalMessages)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.totalSent)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.totalReceived)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.todayMessages)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.totalContacts)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.totalFriends)}</td>
                  <td className="py-2 px-2 text-right text-foreground/80">{fmt(data.totalGroups)}</td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                      </div>
                      <span className="w-9 text-right text-muted-foreground">{share}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
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
  periodLabel: string;
  overview: OverviewData | null;
  responseTime: ResponseTimeData | null;
  contactType: ContactType;
}

function MessagesTab({ loading, volume, heatmap, periodDays, periodLabel, overview, responseTime, contactType }: MessagesTabProps) {
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;
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
          <KPICard icon={<ChatIcon className="w-4 h-4" />} label="Hôm nay" value={overview.todayMessages}
            sub={`${overview.todaySent} gửi · ${overview.todayReceived} nhận`} color="blue" />
          <KPICard icon={<SendIcon className="w-4 h-4" />} label={`Tổng tin nhắn (${periodLabel})`} value={overview.totalMessages} color="purple" />
          <KPICard icon={<ChartIcon className="w-4 h-4" />} label="TB/ngày" value={avgPerDay} color="cyan" />
          <KPICard icon={<SendIcon className="w-4 h-4" />} label="Tỷ lệ gửi" value={`${sentRatio}%`}
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
            <KPICard icon={<ChartIcon className="w-4 h-4" />} label="Trung vị" value={fmtDuration(responseTime.medianSeconds)}
              sub="50% trả lời nhanh hơn" color="cyan" />
            <KPICard icon={<RocketIcon className="w-4 h-4" />} label="Nhanh nhất" value={fmtDuration(responseTime.minSeconds)} color="green" />
            <KPICard icon="🐢" label="Chậm nhất" value={fmtDuration(responseTime.maxSeconds)} color="red" />
            <KPICard icon={<ChatIcon className="w-4 h-4" />} label="Hội thoại" value={responseTime.totalConversations}
              sub="có phản hồi" color="purple" />
          </div>

          {/* Distribution + By-hour charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Distribution chart */}
            <Section title={<><ChartIcon className="w-4 h-4" /> Phân bổ thời gian phản hồi</>}>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(responseTime?.distribution || []).filter((d: any) => d.count > 0)} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} interval={0} angle={-20} textAnchor="end" height={45} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const total = responseTime.totalReplies;
                      const pct = total > 0 ? Math.round(d.count / total * 100) : 0;
                      return (
                        <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-muted-foreground mb-1 font-medium">{d.bucket}</p>
                          <p className="text-foreground font-bold">{d.count} lượt <span className="text-muted-foreground font-normal">({pct}%)</span></p>
                        </div>
                      );
                    }} />
                    <Bar dataKey="count" name="Số lượt" radius={[4, 4, 0, 0]} maxBarSize={32}>
                      {(responseTime?.distribution || []).filter((d: any) => d.count > 0).map((_, i) => (
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
                  <p className="text-[11px] text-muted-foreground mt-2 text-center">
                    <CheckIcon className="w-4 h-4 inline" /> <span className="text-green-400 font-semibold">{pct}%</span> tin nhắn được phản hồi trong <span className="text-foreground">15 phút</span>
                    {' · '}Tổng <span className="text-foreground">{responseTime.totalReplies}</span> lượt
                  </p>
                );
              })()}
            </Section>

            {/* By-hour chart */}
            <Section title={<><ClockIcon className="w-4 h-4" /> Thời gian phản hồi TB theo giờ trong ngày</>}>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(responseTime?.byHour || []).filter((h: any) => h.count > 0)} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                      tickFormatter={(h: number) => `${h}h`} />
                    <YAxis tick={{ fontSize: 9, fill: '#6b7280' }} axisLine={false} tickLine={false}
                      tickFormatter={(v: number) => fmtDurationShort(v)} />
                    <Tooltip content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                          <p className="text-muted-foreground mb-1 font-medium">{d.hour}:00 – {d.hour}:59</p>
                          <p className="text-foreground">TB: <span className="font-bold text-blue-400">{fmtDuration(d.avgSeconds)}</span></p>
                          <p className="text-muted-foreground">{d.count} lượt trả lời</p>
                        </div>
                      );
                    }} />
                    <Bar dataKey="avgSeconds" name="TB phản hồi" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Find peak & low hours */}
              {(() => {
                const active = (responseTime?.byHour || []).filter((h: any) => h.count > 0);
                if (active.length === 0) return null;
                const fastest = active.reduce((a, b) => a.avgSeconds < b.avgSeconds ? a : b);
                const slowest = active.reduce((a, b) => a.avgSeconds > b.avgSeconds ? a : b);
                return (
                  <p className="text-[11px] text-muted-foreground mt-2 text-center"><RocketIcon className="w-4 h-4 inline" /> Nhanh nhất lúc <span className="text-green-400 font-semibold">{fastest.hour}h</span>
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
        <Section title={<><ClockIcon className="w-4 h-4" /> Thời gian phản hồi</>}>
          <p className="text-xs text-muted-foreground text-center py-6">
            Chưa có dữ liệu phản hồi trong khoảng thời gian này.
            <br />
            <span className="text-muted-foreground">Cần có tin nhắn đến và tin trả lời để đo thời gian phản hồi.</span>
          </p>
        </Section>
      )}

      <Section title={<><TrendingUpIcon className="w-4 h-4" /> {'Lượng tin nhắn '}{periodDays <= 2 ? 'theo giờ' : periodDays + ' ngày qua'}</>}>
        {volume.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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

      <Section title={<><ActivityIcon className="w-4 h-4" /> Heatmap giờ cao điểm (7 ngày × 24 giờ)</>}>
        {heatmap.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
function ContactsTab({ loading, overview, segmentation, pieData, tagPieData, contactGrowth, friendReqs, multiAccount }: {
  loading: boolean; overview: OverviewData | null; segmentation: SegmentData | null;
  pieData: any[]; tagPieData: any[];  contactGrowth: ContactGrowthPoint[];
  friendReqs: FriendRequestStats; multiAccount: boolean;
}) {
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;
  return (
    <div className="space-y-5">
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KPICard icon={<UsersIcon className="w-4 h-4" />} label="Tổng liên hệ" value={overview.totalContacts} color="green" />
          <KPICard icon={<UserCheckIcon className="w-4 h-4" />} label="Bạn bè" value={overview.totalFriends} color="blue" />
          <KPICard icon={<UsersIcon className="w-4 h-4" />} label="Nhóm" value={overview.totalGroups} color="cyan" />
          <KPICard icon={<TagIcon className="w-4 h-4" />} label="Đã gắn tag" value={segmentation?.tagged ?? 0}
            sub={segmentation ? `${segmentation.untagged} chưa gắn` : ''} color="purple" />
        </div>
      )}
      {overview && multiAccount && (
        <Hint>Liên hệ, bạn bè và nhóm được cộng theo từng tài khoản: một người là liên hệ của 2 tài khoản được tính 2 lần.</Hint>
      )}

      {/* Contact growth chart - right after KPI */}
      {contactGrowth.length > 0 && (
        <Section title={<><TrendingUpIcon className="w-4 h-4" /> Tăng trưởng liên hệ</>}>
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
        <Section title={<><PieChartIcon className="w-4 h-4" /> Phân loại liên hệ</>}>
          {pieData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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

        <Section title={<><UserCheckIcon className="w-4 h-4" /> Lời mời kết bạn</>}>
          {(!friendReqs.timeline || friendReqs.timeline.length === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
          ) : (
            <div>
              <div className="flex gap-3 mb-3">
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 flex-1 text-center">
                  <div className="text-lg font-bold text-blue-400">{friendReqs.totalSent}</div>
                  <div className="text-[10px] text-muted-foreground">Đã gửi</div>
                </div>
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex-1 text-center">
                  <div className="text-lg font-bold text-green-400">{friendReqs.totalReceived}</div>
                  <div className="text-[10px] text-muted-foreground">Đã nhận</div>
                </div>
              </div>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(friendReqs?.timeline || []).filter((t: any) => t.sent + t.received > 0).slice(-14)} margin={{ top: 0, right: 0, bottom: 0, left: -24 }}>
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
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;
  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 rounded-xl px-4 py-2.5">
        <span className="text-base"><TagIcon className="w-4 h-4" /></span>
        <p className="text-xs text-purple-300">
          <strong>Chỉ thống kê nhãn local</strong> - Nhãn do bạn tự tạo và gắn cho hội thoại trong ứng dụng. Không bao gồm nhãn từ Zalo.
        </p>
      </div>

      {labelUsage?.totalAssignments > 0 && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <KPICard icon={<TagIcon className="w-4 h-4" />} label="Tổng lượt gắn nhãn" value={labelUsage.totalAssignments}
              sub={`trong ${periodDays} ngày`} color="purple" />
            <KPICard icon={<ChartIcon className="w-4 h-4" />} label="Số nhãn sử dụng" value={labelUsage.totalLabelsUsed} color="blue" />
            <KPICard icon={<TrendingUpIcon className="w-4 h-4" />} label="TB/ngày" value={labelUsage.avgPerDay} color="cyan" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* Timeline chart */}
            <Section title={<><TagIcon className="w-4 h-4" /> {'Lượt gắn nhãn theo ngày ('}{periodDays}{' ngày)'}</>}>
              {(labelUsage?.timeline || []).filter((t: any) => t.count > 0).length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
                          <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                            <p className="text-muted-foreground mb-1 font-medium">{d.bucket}</p>
                            <p className="text-foreground font-bold">{d.count} lượt gắn nhãn</p>
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
            <Section title={<><ChartIcon className="w-4 h-4" /> Chi tiết theo từng nhãn</>}>
              {(!labelUsage.byLabel || labelUsage.byLabel.length === 0) ? (
                <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
                          <div className="bg-card border border-input rounded-xl px-3 py-2 text-xs shadow-xl">
                            <p className="text-foreground font-medium mb-1">{d.emoji} {d.name}</p>
                            <p className="text-blue-400 font-bold">{d.count} lượt <span className="text-muted-foreground font-normal">({pct}%)</span></p>
                          </div>
                        );
                      }} />
                      <Bar dataKey="count" name="Lượt" radius={[0, 3, 3, 0]} maxBarSize={18}>
                        {(labelUsage?.byLabel || []).slice(0, 30).map((d: any, i: number) => (
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

      {labelUsage?.totalAssignments === 0 && (
        <Section title={<><TagIcon className="w-4 h-4" /> Thống kê sử dụng nhãn</>}>
          <p className="text-xs text-muted-foreground text-center py-6">
            Chưa có dữ liệu gắn nhãn trong khoảng thời gian này.
            <br />
            <span className="text-muted-foreground">Gắn nhãn local cho các hội thoại để xem thống kê tại đây.</span>
          </p>
        </Section>
      )}

      {!labelUsage && (
        <div className="text-center py-16 text-muted-foreground text-sm">Chưa có dữ liệu nhãn</div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Campaigns
// ══════════════════════════════════════════════════════════════════════════════
function CampaignsTab({ loading, campaigns, overview, multiAccount, accountsById }: {
  loading: boolean; campaigns: CampaignRow[]; overview: OverviewData | null;
  multiAccount: boolean; accountsById: Map<string, AccountInfo>;
}) {
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;

  // Rates from the summed counts of every campaign (not the mean of per-campaign rates)
  const totals = campaignTotals(campaigns);

  // Bar chart data: top 10 campaigns by sent
  const barData = topCampaignsBySent(campaigns, 10).map(c => ({
    name: c.name.length > 18 ? c.name.slice(0, 16) + '…' : c.name,
    sent: c.sent, failed: c.failed, replied: c.replied,
  }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon={<CampaignIcon className="w-4 h-4" />} label="Tổng chiến dịch" value={overview?.totalCampaigns ?? campaigns.length} color="blue" />
        <KPICard icon={<CheckIcon className="w-4 h-4" />} label="Đã gửi" value={totals.sent} color="green" />
        <KPICard icon={<CloseIcon className="w-4 h-4" />} label="Lỗi" value={totals.failed} color="red" />
        <KPICard icon={<ChatIcon className="w-4 h-4" />} label="Trả lời" value={totals.replied} color="cyan" />
        <KPICard icon={<ChartIcon className="w-4 h-4" />} label="Gửi thành công" value={`${totals.deliveryRate}%`}
          sub={`Phản hồi: ${totals.replyRate}%`} color="purple" />
      </div>

      {/* Top campaigns bar chart */}
      {barData.length > 0 && (
        <Section title={<><ChartIcon className="w-4 h-4" /> Top chiến dịch (theo số gửi)</>}>
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
        <Section title={<><ClipboardIcon className="w-4 h-4" /> Chi tiết chiến dịch</>}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2 font-medium">Tên</th>
                  {multiAccount && <th className="text-left py-2 px-2 font-medium">Tài khoản</th>}
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
                {(campaigns || []).slice(0, 20).map(c => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-2 text-foreground font-medium max-w-[200px] truncate">{c.name}</td>
                    {multiAccount && (
                      <td className="py-2 px-2 max-w-[180px]">
                        {c.zaloId ? <AccountName account={accountsById.get(c.zaloId)} zaloId={c.zaloId} /> : '-'}
                      </td>
                    )}
                    <td className="py-2 px-2 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${ST_CLS[c.status] || 'bg-muted text-muted-foreground'}`}>
                        {ST_LABEL[c.status] || c.status}
                      </span>
                    </td>
                    <td className="py-2 px-1 text-right text-foreground/80">{c.total}</td>
                    <td className="py-2 px-1 text-right text-green-400">{c.sent}</td>
                    <td className="py-2 px-1 text-right text-red-400">{c.failed || 0}</td>
                    <td className="py-2 px-1 text-right text-blue-400">{c.replied}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={c.deliveryRate >= 80 ? 'text-green-400' : c.deliveryRate >= 50 ? 'text-yellow-400' : 'text-red-400'}>
                        {c.deliveryRate}%
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <span className={c.replyRate >= 30 ? 'text-green-400' : c.replyRate >= 10 ? 'text-yellow-400' : 'text-muted-foreground'}>
                        {c.replyRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {campaigns.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có chiến dịch nào</p>
          )}
        </Section>
      )}

      {campaigns.length === 0 && (
        <div className="text-center py-16 text-muted-foreground text-sm">
          <span className="text-3xl mb-3 block"><CampaignIcon className="w-4 h-4" /></span>
          {multiAccount ? 'Chưa có chiến dịch nào cho các tài khoản đã chọn' : 'Chưa có chiến dịch nào cho tài khoản này'}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: Workflow
// ══════════════════════════════════════════════════════════════════════════════
function WorkflowTab({ loading, workflowData, wfPieData, multiAccount }: {
  loading: boolean; workflowData: WorkflowData | null; wfPieData: any[]; multiAccount: boolean;
}) {
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;
  if (!workflowData || workflowData.totalRuns === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Chưa có dữ liệu workflow trong khoảng thời gian đã chọn
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard icon={<LightningIcon className="w-4 h-4" />} label="Tổng lượt chạy" value={workflowData.totalRuns} color="blue" />
        <KPICard icon={<CheckIcon className="w-4 h-4" />} label="Thành công" value={workflowData.successRuns} color="green" />
        <KPICard icon={<CloseIcon className="w-4 h-4" />} label="Lỗi" value={workflowData.errorRuns} color="red" />
        <KPICard icon={<ChartIcon className="w-4 h-4" />} label="Tỷ lệ thành công" value={`${workflowData.successRate}%`} color="cyan" />
        <KPICard icon="⏱️" label="TB thời gian" value={`${(workflowData.avgDuration / 1000).toFixed(1)}s`} color="purple" />
      </div>
      {multiAccount && (
        <Hint>Workflow gắn với nhiều tài khoản đã chọn chỉ được tính một lần.</Hint>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Timeline */}
        <Section title={<><TrendingUpIcon className="w-4 h-4" /> Lượt chạy theo ngày</>}>
          {(!workflowData.timeline || workflowData.timeline.length === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
        <Section title={<><PieChartIcon className="w-4 h-4" /> Phân bổ kết quả</>}>
          {wfPieData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
      {workflowData.topWorkflows?.length > 0 && (
        <Section title={<><AwardIcon className="w-4 h-4" /> Top Workflows</>}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2 font-medium">#</th>
                  <th className="text-left py-2 px-2 font-medium">Tên Workflow</th>
                  <th className="text-right py-2 px-2 font-medium">Lượt chạy</th>
                  <th className="text-right py-2 px-2 font-medium">Tỷ lệ thành công</th>
                </tr>
              </thead>
              <tbody>
                {(workflowData?.topWorkflows || []).map((wf: any, i: number) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-2 text-muted-foreground">{i + 1}</td>
                    <td className="py-2 px-2 text-foreground font-medium">{wf.workflowName}</td>
                    <td className="py-2 px-2 text-right text-foreground/80">{wf.runs}</td>
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
  if (loading) return <PageLoading variant="skeleton" skeletonVariant="chart" />;
  if (!aiData || aiData.totalRequests === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Chưa có dữ liệu AI trong khoảng thời gian đã chọn
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Hint>Thống kê AI tính trên toàn ứng dụng: nhật ký AI không ghi theo tài khoản nên bộ lọc tài khoản không áp dụng.</Hint>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard icon={<BotIcon className="w-4 h-4" />} label="Tổng requests" value={aiData.totalRequests} color="blue" />
        <KPICard icon="🔤" label="Tổng tokens" value={aiData.totalTokens} color="purple" />
        <KPICard icon={<InboxIcon className="w-4 h-4" />} label="Prompt tokens" value={aiData.totalPromptTokens} color="cyan" />
        <KPICard icon={<SendIcon className="w-4 h-4" />} label="Completion tokens" value={aiData.totalCompletionTokens} color="green" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Timeline: requests + tokens */}
        <Section title={<><TrendingUpIcon className="w-4 h-4" /> AI usage theo ngày</>}>
          {(!aiData.timeline || aiData.timeline.length === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
        <Section title={<><PieChartIcon className="w-4 h-4" /> Phân bổ theo Model</>}>
          {aiModelPie.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Chưa có dữ liệu</p>
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
        <Section title={<><ClipboardIcon className="w-4 h-4" /> Chi tiết theo Model</>}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2 font-medium">Model</th>
                  <th className="text-right py-2 px-2 font-medium">Requests</th>
                  <th className="text-right py-2 px-2 font-medium">Tokens</th>
                  <th className="text-right py-2 px-2 font-medium">TB tokens/req</th>
                </tr>
              </thead>
              <tbody>
                {aiData.byModel.map((m, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-2 text-foreground font-medium">{m.model}</td>
                    <td className="py-2 px-2 text-right text-foreground/80">{m.requests.toLocaleString('vi-VN')}</td>
                    <td className="py-2 px-2 text-right text-blue-400">{m.tokens.toLocaleString('vi-VN')}</td>
                    <td className="py-2 px-2 text-right text-muted-foreground">
                      {m.requests > 0 ? Math.round(m.tokens / m.requests).toLocaleString('vi-VN') : '-'}
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
        <Section title={<><BrainIcon className="w-4 h-4" /> Chi tiết theo AI Assistant</>}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left py-2 px-2 font-medium">Assistant</th>
                  <th className="text-right py-2 px-2 font-medium">Requests</th>
                  <th className="text-right py-2 px-2 font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {aiData.byAssistant.map((a, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-2 text-foreground font-medium">{a.assistantName}</td>
                    <td className="py-2 px-2 text-right text-foreground/80">{a.requests.toLocaleString('vi-VN')}</td>
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
