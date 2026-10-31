/**
 * Multi-account Reports (AnalyticsPage): merge the per-account results of the analytics
 * DataAccessor methods into one report. Pure — covered by src/__tests__/analytics/analyticsMerge.test.ts.
 *
 * Merge rules:
 *  - counters are summed (contacts / friends / groups / campaigns are per-account relationships,
 *    so a person known by two selected accounts counts once per account, as each account's CRM does);
 *  - time series are summed bucket by bucket: every account is queried with the same range and
 *    granularity, so they share one bucket list. A label that repeats inside a series ("09:00" of two
 *    days in hour mode) is told apart by its occurrence, never merged with the other day;
 *  - top lists are merged by key, summed and re-ranked;
 *  - ratios / percentages / averages are recomputed from summed numerators and denominators
 *    (averages weighted by their sample count), never averaged across accounts;
 *  - "today vs yesterday" sums both sides over the same accounts before comparing.
 *
 * Metrics that cannot be merged here are computed by the multi-account data-layer variants
 * (DataAccessor.getWorkflowAnalyticsForAccounts / getResponseTimeForAccounts): the response-time
 * median, and workflows, whose runs are not attributed to an account (a workflow attached to two
 * selected accounts would be counted twice).
 */

// ── Report shapes (as returned by DatabaseService analytics methods) ──────────────────────────

export interface DashboardOverview {
  totalMessages: number; totalSent: number; totalReceived: number;
  totalContacts: number; totalFriends: number; totalGroups: number;
  todayMessages: number; todaySent: number; todayReceived: number;
  yesterdayMessages: number; activeCampaigns: number; totalCampaigns: number;
}

export const OVERVIEW_FIELDS: ReadonlyArray<keyof DashboardOverview> = [
  'totalMessages', 'totalSent', 'totalReceived',
  'totalContacts', 'totalFriends', 'totalGroups',
  'todayMessages', 'todaySent', 'todayReceived',
  'yesterdayMessages', 'activeCampaigns', 'totalCampaigns',
];

export interface VolumePoint { bucket: string; sent: number; received: number; total: number }
export interface HeatmapPoint { dayOfWeek: number; hour: number; count: number }
export interface ContactGrowthPoint { bucket: string; newContacts: number; newFriends: number }
export interface FriendRequestPoint { bucket: string; sent: number; received: number }

export interface FriendRequestStats {
  totalSent: number; totalReceived: number;
  timeline: FriendRequestPoint[];
}

export interface ContactSegmentation {
  byType: Array<{ type: string; count: number }>;
  tagged: number; untagged: number; withNotes: number; withoutNotes: number;
}

export interface CampaignRow {
  id: number; name: string; type: string; status: string; created_at: number;
  total: number; sent: number; failed: number; pending: number; replied: number;
  deliveryRate: number; replyRate: number;
  /** Owning account — set when lists of several accounts are merged. */
  zaloId?: string;
}

export interface WorkflowAnalytics {
  totalRuns: number; successRuns: number; errorRuns: number; successRate: number;
  avgDuration: number;
  topWorkflows: Array<{ workflowName: string; runs: number; successRate: number }>;
  timeline: Array<{ bucket: string; success: number; error: number }>;
}

export interface AIAnalytics {
  totalRequests: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number;
  byModel: Array<{ model: string; requests: number; tokens: number }>;
  byAssistant: Array<{ assistantName: string; requests: number; tokens: number }>;
  timeline: Array<{ bucket: string; requests: number; tokens: number }>;
}

export interface ResponseTimeStats {
  avgSeconds: number; medianSeconds: number; minSeconds: number; maxSeconds: number;
  totalConversations: number; totalReplies: number;
  distribution: Array<{ bucket: string; count: number }>;
  byHour: Array<{ hour: number; avgSeconds: number; count: number }>;
}

export interface LabelUsageByLabel { labelId: number; name: string; emoji: string; color: string; count: number }
export interface LabelUsageRecent { labelName: string; emoji: string; color: string; threadId: string; createdAt: number }

export interface LabelUsage {
  totalAssignments: number; totalLabelsUsed: number; avgPerDay: number;
  timeline: Array<{ bucket: string; count: number }>;
  byLabel: LabelUsageByLabel[];
  recentAssignments: LabelUsageRecent[];
}

/** One account's payload. */
export interface AccountResult<T> { zaloId: string; data: T }

type Maybe<T> = T | null | undefined;

// ── Numbers ────────────────────────────────────────────────────────────────────

/** Finite number or 0 — IPC/REST payloads may carry strings, nulls or nothing. */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Integer percentage of part / whole (0 when whole is 0), rounded like the DB reports. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function present<T>(list: ReadonlyArray<Maybe<T>>): T[] {
  return list.filter((item): item is T => item !== null && item !== undefined);
}

function sumOf<T>(items: ReadonlyArray<T>, pick: (item: T) => unknown): number {
  let total = 0;
  for (const item of items) total += num(pick(item));
  return total;
}

// ── Time series ────────────────────────────────────────────────────────────────

/**
 * Sums series of `{ bucket, ...counters }` point by point, in first-seen bucket order.
 * The nth occurrence of a label is matched with the nth occurrence in the other series, so hour
 * buckets of a two-day range ("09:00" twice) stay two points.
 */
export function mergeBucketSeries<T extends { bucket: string }>(
  seriesList: ReadonlyArray<Maybe<ReadonlyArray<T>>>,
  fields: ReadonlyArray<keyof T>,
): T[] {
  const merged = new Map<string, T>();
  for (const series of seriesList) {
    if (!Array.isArray(series)) continue;
    const occurrences = new Map<string, number>();
    for (const point of series) {
      if (!point) continue;
      const label = String(point.bucket ?? '');
      const nth = occurrences.get(label) || 0;
      occurrences.set(label, nth + 1);
      const key = `${nth}#${label}`;
      const current = merged.get(key);
      if (current) {
        for (const field of fields) (current as any)[field] = num(current[field]) + num(point[field]);
      } else {
        const copy: any = { ...point, bucket: label };
        for (const field of fields) copy[field] = num(point[field]);
        merged.set(key, copy as T);
      }
    }
  }
  return Array.from(merged.values());
}

export function mergeVolumes(list: ReadonlyArray<Maybe<ReadonlyArray<VolumePoint>>>): VolumePoint[] {
  return mergeBucketSeries(list, ['sent', 'received', 'total']);
}

export function mergeContactGrowth(list: ReadonlyArray<Maybe<ReadonlyArray<ContactGrowthPoint>>>): ContactGrowthPoint[] {
  return mergeBucketSeries(list, ['newContacts', 'newFriends']);
}

/** 7 × 24 grids summed cell by cell, sorted by day then hour. */
export function mergeHeatmaps(list: ReadonlyArray<Maybe<ReadonlyArray<HeatmapPoint>>>): HeatmapPoint[] {
  const grid = new Map<string, HeatmapPoint>();
  for (const series of list) {
    if (!Array.isArray(series)) continue;
    for (const point of series) {
      if (!point) continue;
      const dayOfWeek = num(point.dayOfWeek);
      const hour = num(point.hour);
      const key = `${dayOfWeek}_${hour}`;
      const current = grid.get(key);
      if (current) current.count += num(point.count);
      else grid.set(key, { dayOfWeek, hour, count: num(point.count) });
    }
  }
  return Array.from(grid.values()).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour);
}

// ── Overview ───────────────────────────────────────────────────────────────────

export function emptyOverview(): DashboardOverview {
  const overview = {} as DashboardOverview;
  for (const field of OVERVIEW_FIELDS) overview[field] = 0;
  return overview;
}

/** Every overview counter summed; null when no account loaded. */
export function mergeOverviews(list: ReadonlyArray<Maybe<Partial<DashboardOverview>>>): DashboardOverview | null {
  const items = present(list);
  if (items.length === 0) return null;
  const merged = emptyOverview();
  for (const item of items) {
    for (const field of OVERVIEW_FIELDS) merged[field] += num(item[field]);
  }
  return merged;
}

/** Today vs yesterday (same accounts on both sides); undefined when yesterday had no message. */
export function todayTrend(
  overview: Maybe<Pick<DashboardOverview, 'todayMessages' | 'yesterdayMessages'>>,
): { value: string; positive: boolean } | undefined {
  if (!overview) return undefined;
  const previous = num(overview.yesterdayMessages);
  const current = num(overview.todayMessages);
  if (previous === 0) return undefined;
  const pct = Math.round(((current - previous) / previous) * 100);
  return { value: `${pct >= 0 ? '+' : ''}${pct}%`, positive: pct >= 0 };
}

// ── Contacts ───────────────────────────────────────────────────────────────────

export function mergeFriendRequests(list: ReadonlyArray<Maybe<Partial<FriendRequestStats>>>): FriendRequestStats | null {
  const items = present(list);
  if (items.length === 0) return null;
  return {
    totalSent: sumOf(items, item => item.totalSent),
    totalReceived: sumOf(items, item => item.totalReceived),
    timeline: mergeBucketSeries(items.map(item => item.timeline), ['sent', 'received']),
  };
}

/** Types merged by name (first-seen order), counts and tag / note splits summed. */
export function mergeSegmentations(list: ReadonlyArray<Maybe<Partial<ContactSegmentation>>>): ContactSegmentation | null {
  const items = present(list);
  if (items.length === 0) return null;
  const byType = new Map<string, number>();
  for (const item of items) {
    for (const row of Array.isArray(item.byType) ? item.byType : []) {
      if (!row) continue;
      const type = String(row.type ?? '');
      byType.set(type, (byType.get(type) || 0) + num(row.count));
    }
  }
  return {
    byType: Array.from(byType, ([type, count]) => ({ type, count })),
    tagged: sumOf(items, item => item.tagged),
    untagged: sumOf(items, item => item.untagged),
    withNotes: sumOf(items, item => item.withNotes),
    withoutNotes: sumOf(items, item => item.withoutNotes),
  };
}

// ── Campaigns ──────────────────────────────────────────────────────────────────

/** Campaigns of every account (each tagged with its zaloId), newest first like the DB list. */
export function mergeCampaignLists(list: ReadonlyArray<AccountResult<Maybe<ReadonlyArray<CampaignRow>>>>): CampaignRow[] {
  const rows: CampaignRow[] = [];
  for (const entry of list) {
    if (!entry || !Array.isArray(entry.data)) continue;
    for (const row of entry.data) if (row) rows.push({ ...row, zaloId: entry.zaloId });
  }
  return rows.sort((a, b) => num(b.created_at) - num(a.created_at) || num(b.id) - num(a.id));
}

export interface CampaignTotals {
  campaigns: number; total: number; sent: number; failed: number; pending: number; replied: number;
  /** sent / total contacts of all campaigns, % */
  deliveryRate: number;
  /** replied / sent of all campaigns, % */
  replyRate: number;
}

/** Totals of a campaign list; rates from the summed counts (not the mean of per-campaign rates). */
export function campaignTotals(rows: ReadonlyArray<CampaignRow>): CampaignTotals {
  const total = sumOf(rows, row => row.total);
  const sent = sumOf(rows, row => row.sent);
  const replied = sumOf(rows, row => row.replied);
  return {
    campaigns: rows.length,
    total,
    sent,
    failed: sumOf(rows, row => row.failed),
    pending: sumOf(rows, row => row.pending),
    replied,
    deliveryRate: percent(sent, total),
    replyRate: percent(replied, sent),
  };
}

/** Top campaigns by messages sent (newest first on ties). */
export function topCampaignsBySent(rows: ReadonlyArray<CampaignRow>, limit = 10): CampaignRow[] {
  return [...rows]
    .sort((a, b) => num(b.sent) - num(a.sent) || num(b.created_at) - num(a.created_at) || num(b.id) - num(a.id))
    .slice(0, Math.max(0, limit));
}

// ── Labels ─────────────────────────────────────────────────────────────────────

/**
 * Local labels are shared between accounts (local_labels.page_ids), so byLabel is merged by labelId
 * and "labels used" counts distinct label ids — not the sum of each account's count. byLabel lists
 * every label an account used in the range, which makes the distinct count exact.
 */
export function mergeLabelUsages(list: ReadonlyArray<Maybe<Partial<LabelUsage>>>): LabelUsage | null {
  const items = present(list);
  if (items.length === 0) return null;
  const totalAssignments = sumOf(items, item => item.totalAssignments);
  const byLabel = new Map<string, LabelUsageByLabel>();
  // Label ids counted by the DB but absent from byLabel (a deleted label): kept, cannot be de-duplicated.
  let unlistedLabels = 0;
  for (const item of items) {
    const rows = Array.isArray(item.byLabel) ? item.byLabel.filter(Boolean) : [];
    unlistedLabels += Math.max(0, num(item.totalLabelsUsed) - rows.length);
    for (const row of rows) {
      const key = String(row.labelId);
      const current = byLabel.get(key);
      if (current) current.count += num(row.count);
      else byLabel.set(key, { ...row, count: num(row.count) });
    }
  }
  const ranked = Array.from(byLabel.values())
    .sort((a, b) => b.count - a.count || String(a.name ?? '').localeCompare(String(b.name ?? '')));
  const timeline = mergeBucketSeries(items.map(item => item.timeline), ['count']);
  // Same as the DB: assignments ÷ calendar days of the range (= buckets of the merged timeline).
  const avgPerDay = totalAssignments > 0 ? Math.round((totalAssignments / Math.max(1, timeline.length)) * 10) / 10 : 0;
  const recentAssignments = items
    .flatMap(item => (Array.isArray(item.recentAssignments) ? item.recentAssignments.filter(Boolean) : []))
    .sort((a, b) => num(b.createdAt) - num(a.createdAt))
    .slice(0, 50);
  return {
    totalAssignments,
    totalLabelsUsed: byLabel.size + unlistedLabels,
    avgPerDay,
    timeline,
    byLabel: ranked,
    recentAssignments,
  };
}

// ── Loading ────────────────────────────────────────────────────────────────────

/**
 * Runs `worker` over `items` with at most `limit` calls in flight. Results keep the input order and
 * a failing call does not stop the others (Promise.allSettled semantics).
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const lanes = Math.max(1, Math.min(Math.floor(num(limit)) || 1, items.length));
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
