/**
 * Loads one tab of the Reports page (AnalyticsPage) for one or several accounts.
 *
 * - Per-account metrics: the existing single-account DataAccessor calls, at most
 *   ANALYTICS_CONCURRENCY in flight, merged with ./mergeAnalytics.
 * - Metrics that cannot be merged client-side (workflows, response time) use the multi-account
 *   DataAccessor variants, asked AFTER the per-account calls with the accounts that loaded, so every
 *   block of the tab covers the same accounts.
 * - AI usage is not per account (ai_usage_logs has no account): loaded once.
 * - An account with any failed call is left out of every metric of the tab (totals and charts stay
 *   consistent) and listed in `failedAccounts`; the other accounts still render.
 */
import DataAccessor from '@/lib/data/DataAccessor';
import {
  mapWithConcurrency,
  mergeCampaignLists,
  mergeContactGrowth,
  mergeFriendRequests,
  mergeHeatmaps,
  mergeLabelUsages,
  mergeOverviews,
  mergeSegmentations,
  mergeVolumes,
  type AccountResult,
  type AIAnalytics,
  type CampaignRow,
  type ContactGrowthPoint,
  type ContactSegmentation,
  type DashboardOverview,
  type FriendRequestStats,
  type HeatmapPoint,
  type LabelUsage,
  type ResponseTimeStats,
  type VolumePoint,
  type WorkflowAnalytics,
} from './mergeAnalytics';

export type AnalyticsTabId = 'overview' | 'messages' | 'contacts' | 'labels' | 'campaigns' | 'workflow' | 'ai' | 'employees';

/** Max analytics calls in flight (IPC / REST to the Boss); the DB answers them one by one anyway. */
export const ANALYTICS_CONCURRENCY = 4;

type AccountMetric = 'overview' | 'volume' | 'heatmap' | 'friendRequests' | 'contactGrowth' | 'segmentation' | 'campaigns' | 'labelUsage';
export type SharedMetric = 'workflow' | 'responseTime' | 'ai';

const TAB_PLANS: Record<AnalyticsTabId, { perAccount: AccountMetric[]; shared: SharedMetric[] }> = {
  overview: { perAccount: ['overview', 'volume', 'friendRequests', 'contactGrowth', 'labelUsage'], shared: ['workflow', 'ai'] },
  messages: { perAccount: ['overview', 'volume', 'heatmap'], shared: ['responseTime'] },
  contacts: { perAccount: ['overview', 'segmentation', 'friendRequests', 'contactGrowth'], shared: [] },
  labels: { perAccount: ['labelUsage'], shared: [] },
  campaigns: { perAccount: ['overview', 'campaigns'], shared: [] },
  workflow: { perAccount: [], shared: ['workflow'] },
  ai: { perAccount: [], shared: ['ai'] },
  employees: { perAccount: [], shared: [] }, // EmployeeAnalyticsTab loads its own data
};

export interface AnalyticsQuery {
  zaloIds: string[];
  sinceTs: number;
  untilTs: number;
  granularity: 'hour' | 'day';
  /** 0 = 1-1, 1 = groups, undefined = every conversation */
  threadType?: number;
}

export interface AccountFailure { zaloId: string; error: string }
export interface SectionFailure { section: SharedMetric; error: string }

/** Metrics of the tab only: a key left undefined was not loaded for this tab. */
export interface AnalyticsReport {
  overview?: DashboardOverview | null;
  /** Overview of each loaded account (per-account breakdown). */
  overviewByAccount?: Array<AccountResult<DashboardOverview>>;
  volume?: VolumePoint[];
  heatmap?: HeatmapPoint[];
  friendRequests?: FriendRequestStats | null;
  contactGrowth?: ContactGrowthPoint[];
  segmentation?: ContactSegmentation | null;
  campaigns?: CampaignRow[];
  labelUsage?: LabelUsage | null;
  workflow?: WorkflowAnalytics | null;
  responseTime?: ResponseTimeStats | null;
  ai?: AIAnalytics | null;
  /** Accounts included in the report, in query order. */
  loadedAccounts: string[];
  failedAccounts: AccountFailure[];
  failedSections: SectionFailure[];
}

// ── Response unwrapping ────────────────────────────────────────────────────────

function failureOf(res: any): string | null {
  if (!res) return 'Không có phản hồi';
  if (res.success === false) return String(res.error || 'Lỗi không rõ');
  return null;
}

/** Object reports: IPC spreads the fields next to `success`; REST puts them in `data`. */
function unwrapObject<T>(res: any): T {
  const failure = failureOf(res);
  if (failure) throw new Error(failure);
  const payload = res.data !== undefined && res.data !== null ? res.data : res;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Dữ liệu không hợp lệ');
  const { success: _success, error: _error, ...rest } = payload;
  return rest as T;
}

/** List reports: `data` in both IPC and REST. */
function unwrapArray<T>(res: any): T[] {
  const failure = failureOf(res);
  if (failure) throw new Error(failure);
  if (!Array.isArray(res.data)) throw new Error('Dữ liệu không hợp lệ');
  return res.data as T[];
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message || 'Lỗi không rõ';
  return String(reason ?? 'Lỗi không rõ');
}

// ── Calls ──────────────────────────────────────────────────────────────────────

async function fetchAccountMetric(metric: AccountMetric, zaloId: string, q: AnalyticsQuery): Promise<unknown> {
  const range = { zaloId, sinceTs: q.sinceTs, untilTs: q.untilTs };
  switch (metric) {
    case 'overview':
      return unwrapObject<DashboardOverview>(await DataAccessor.getDashboardOverview({ ...range, threadType: q.threadType }));
    case 'volume':
      return unwrapArray<VolumePoint>(await DataAccessor.getMessageVolume({ ...range, granularity: q.granularity, threadType: q.threadType }));
    case 'heatmap':
      return unwrapArray<HeatmapPoint>(await DataAccessor.getPeakHours({ ...range, threadType: q.threadType }));
    case 'friendRequests':
      return unwrapObject<FriendRequestStats>(await DataAccessor.getFriendRequestAnalytics(range));
    case 'contactGrowth':
      return unwrapArray<ContactGrowthPoint>(await DataAccessor.getContactGrowth(range));
    case 'segmentation':
      return unwrapObject<ContactSegmentation>(await DataAccessor.getContactSegmentation(zaloId));
    case 'campaigns':
      return unwrapArray<CampaignRow>(await DataAccessor.getCampaignComparison(zaloId));
    case 'labelUsage':
      return unwrapObject<LabelUsage>(await DataAccessor.getLabelUsage(range));
    default:
      throw new Error(`Unknown metric ${metric as string}`);
  }
}

async function fetchSharedMetric(metric: SharedMetric, zaloIds: string[], q: AnalyticsQuery): Promise<unknown> {
  switch (metric) {
    case 'workflow':
      return unwrapObject<WorkflowAnalytics>(await DataAccessor.getWorkflowAnalyticsForAccounts({ zaloIds, sinceTs: q.sinceTs, untilTs: q.untilTs }));
    case 'responseTime':
      return unwrapObject<ResponseTimeStats>(await DataAccessor.getResponseTimeForAccounts({
        zaloIds, sinceTs: q.sinceTs, untilTs: q.untilTs, threadType: q.threadType,
      }));
    case 'ai':
      return unwrapObject<AIAnalytics>(await DataAccessor.getAIAnalytics({ sinceTs: q.sinceTs, untilTs: q.untilTs }));
    default:
      throw new Error(`Unknown metric ${metric as string}`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────

type Job = { kind: 'account'; zaloId: string; metric: AccountMetric } | { kind: 'shared'; metric: SharedMetric };

export async function loadAnalyticsReport(
  tab: AnalyticsTabId,
  query: AnalyticsQuery,
  concurrency: number = ANALYTICS_CONCURRENCY,
): Promise<AnalyticsReport> {
  const plan = TAB_PLANS[tab] || TAB_PLANS.overview;
  const zaloIds = Array.from(new Set(query.zaloIds.filter(Boolean)));
  // The Messages tab hides response time for groups: do not run its (expensive) query then.
  const shared = plan.shared.filter(metric => !(metric === 'responseTime' && query.threadType === 1));
  const accountScoped = shared.filter(metric => metric !== 'ai');

  // Phase 1 — per-account calls + account-independent ones (AI).
  const jobs: Job[] = [];
  for (const zaloId of zaloIds) {
    for (const metric of plan.perAccount) jobs.push({ kind: 'account', zaloId, metric });
  }
  for (const metric of shared) if (metric === 'ai') jobs.push({ kind: 'shared', metric });

  const settled = await mapWithConcurrency(jobs, concurrency, job =>
    job.kind === 'account' ? fetchAccountMetric(job.metric, job.zaloId, query) : fetchSharedMetric(job.metric, zaloIds, query));

  const perAccount = new Map<string, Partial<Record<AccountMetric, unknown>>>();
  const accountErrors = new Map<string, string>();
  const sharedValues = new Map<SharedMetric, unknown>();
  const failedSections: SectionFailure[] = [];

  settled.forEach((result, index) => {
    const job = jobs[index];
    if (job.kind === 'account') {
      if (result.status === 'fulfilled') {
        const entry = perAccount.get(job.zaloId) || {};
        entry[job.metric] = result.value;
        perAccount.set(job.zaloId, entry);
      } else if (!accountErrors.has(job.zaloId)) {
        accountErrors.set(job.zaloId, errorText(result.reason));
      }
    } else if (result.status === 'fulfilled') {
      sharedValues.set(job.metric, result.value);
    } else {
      failedSections.push({ section: job.metric, error: errorText(result.reason) });
    }
  });

  const loadedAccounts = zaloIds.filter(id => !accountErrors.has(id));

  // Phase 2 — multi-account queries over the accounts that loaded.
  if (accountScoped.length > 0 && loadedAccounts.length > 0) {
    const results = await mapWithConcurrency(accountScoped, concurrency, metric => fetchSharedMetric(metric, loadedAccounts, query));
    results.forEach((result, index) => {
      const metric = accountScoped[index];
      if (result.status === 'fulfilled') sharedValues.set(metric, result.value);
      else failedSections.push({ section: metric, error: errorText(result.reason) });
    });
  }

  const report: AnalyticsReport = {
    loadedAccounts,
    failedAccounts: zaloIds.filter(id => accountErrors.has(id)).map(zaloId => ({ zaloId, error: accountErrors.get(zaloId) || '' })),
    failedSections,
  };

  const pick = <T,>(metric: AccountMetric): Array<AccountResult<T>> =>
    loadedAccounts.map(zaloId => ({ zaloId, data: perAccount.get(zaloId)?.[metric] as T }));
  const loads = (metric: AccountMetric) => plan.perAccount.includes(metric);

  if (loads('overview')) {
    const list = pick<DashboardOverview>('overview');
    report.overview = mergeOverviews(list.map(entry => entry.data));
    report.overviewByAccount = list;
  }
  if (loads('volume')) report.volume = mergeVolumes(pick<VolumePoint[]>('volume').map(entry => entry.data));
  if (loads('heatmap')) report.heatmap = mergeHeatmaps(pick<HeatmapPoint[]>('heatmap').map(entry => entry.data));
  if (loads('friendRequests')) report.friendRequests = mergeFriendRequests(pick<FriendRequestStats>('friendRequests').map(entry => entry.data));
  if (loads('contactGrowth')) report.contactGrowth = mergeContactGrowth(pick<ContactGrowthPoint[]>('contactGrowth').map(entry => entry.data));
  if (loads('segmentation')) report.segmentation = mergeSegmentations(pick<ContactSegmentation>('segmentation').map(entry => entry.data));
  if (loads('campaigns')) report.campaigns = mergeCampaignLists(pick<CampaignRow[]>('campaigns'));
  if (loads('labelUsage')) report.labelUsage = mergeLabelUsages(pick<LabelUsage>('labelUsage').map(entry => entry.data));

  if (shared.includes('workflow')) report.workflow = (sharedValues.get('workflow') as WorkflowAnalytics | undefined) ?? null;
  if (shared.includes('responseTime')) report.responseTime = (sharedValues.get('responseTime') as ResponseTimeStats | undefined) ?? null;
  if (shared.includes('ai')) report.ai = (sharedValues.get('ai') as AIAnalytics | undefined) ?? null;

  return report;
}
