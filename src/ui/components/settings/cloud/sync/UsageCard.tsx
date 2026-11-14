/**
 * Data sync → "Mức sử dụng & chi phí" (Usage & cost) of the selected storage (usage.get - src/shared/cloud/cloudContracts.ts):
 *  - R2: estimated cost this month + projected for the whole month (USD, with an estimated ₫ conversion); each item: storage (GB-month), writes
 *    (Class A), reads (Class B), downloads.
 *  - Google Drive: no per-operation charge (below the limits); Google account space, Drive API units, downloads /
 *    uploads today (the day is in Pacific time).
 * Read on open, when the storage / sign-in changes (reloadKey), when main reports a change (connection / media / db - spaced at least 60 s) and every 5 minutes
 * while the window is visible; "Cập nhật" (Refresh) = re-read the numbers for all accounts right away (spaced 60 s). Old app builds without usage show
 * nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLinkIcon, InfoIcon, RefreshIcon } from '@/components/common/icons';
import { Badge, Button, Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  GDRIVE_LIMITS,
  R2_PRICING,
  type CloudStorageProvider,
  type CloudUsageMeter,
  type CloudUsageMeterId,
  type CloudUsageReport,
} from '../../../../../shared/cloud/cloudContracts';
import {
  cleanIpcError,
  cloudApi,
  cloudflareBillingUrl,
  CloudSpinner,
  fmtBytes,
  fmtCost,
  fmtMillions,
  fmtNum,
  fmtPercent,
  fmtShortWhen,
  fmtUsdPrice,
  fmtVnd,
  GOOGLE_ONE_STORAGE_URL,
  meterTone,
  METER_TEXT,
  Notice,
  openExternalUrl,
  ProgressBar,
  USD_VND_RATE,
  useCloudAction,
  useCloudChanged,
  useVisibleInterval,
} from '../cloudUi';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Minimum spacing between two reads when main reports a change, and between two clicks of "Cập nhật" (Refresh). */
const REFRESH_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;

const P = R2_PRICING;
const G = GDRIVE_LIMITS;

/** Name + an explanation line of "tính những gì" (what it counts) for each item. */
export const METER_INFO: Record<CloudUsageMeterId, { label: string; hint: string }> = {
  r2Storage: {
    label: tr('Dung lượng đang lưu'),
    hint: tr('Tính theo GB-tháng: trung bình dung lượng cao nhất mỗi ngày. {{freeStorageGbMonth}} GB-tháng miễn phí, sau đó {{v1}} USD/GB-tháng.', { freeStorageGbMonth: P.freeStorageGbMonth, v1: fmtUsdPrice(P.storageUsdPerGbMonth) }),
  },
  r2ClassA: {
    label: tr('Ghi (Class A)'),
    hint: tr('Mỗi lần đẩy file hoặc một phần file lớn, tạo / hoàn tất tải lên nhiều phần, liệt kê file. {{v1}} lượt/tháng miễn phí, sau đó {{v2}} USD/triệu.', { v1: fmtMillions(P.freeClassA), v2: fmtUsdPrice(P.classAUsdPerMillion) }),
  },
  r2ClassB: {
    label: tr('Đọc (Class B)'),
    hint: tr('Mỗi lần tải file về máy hoặc kiểm tra file đã có trên kho. {{v1}} lượt/tháng miễn phí, sau đó {{v2}} USD/triệu.', { v1: fmtMillions(P.freeClassB), v2: fmtUsdPrice(P.classBUsdPerMillion) }),
  },
  r2Egress: {
    label: tr('Tải xuống'),
    hint: tr('Miễn phí, không giới hạn — chỉ để biết.'),
  },
  gdriveStorage: {
    label: tr('Dung lượng tài khoản Google'),
    hint: tr('Dùng chung Gmail, Drive, Photos. Đầy thì không tải lên được và Gmail có thể không nhận thư.'),
  },
  gdriveUnitsDay: {
    label: tr('Lượt dùng Drive API hôm nay'),
    hint: tr('Đơn vị quota: đọc thông tin {{unitsRead}}, liệt kê {{unitsList}}, tải xuống {{unitsDownload}}, ghi/sửa {{unitsEdit}}. Ngưỡng miễn phí {{v1}} đơn vị/ngày cho cả client OAuth; Google báo sẽ tính phí phần vượt từ cuối 2026.', { unitsRead: G.unitsRead, unitsList: G.unitsList, unitsDownload: G.unitsDownload, unitsEdit: G.unitsEdit, v1: fmtMillions(G.unitsPerDayPerProject) }),
  },
  gdriveEgressDay: {
    label: tr('Tải xuống hôm nay'),
    hint: tr('Miễn phí dưới {{v1}}/ngày cho cả client OAuth.', { v1: fmtBytes(G.egressBytesPerDayPerProject) }),
  },
  gdriveUploadDay: {
    label: tr('Tải lên hôm nay'),
    hint: tr('Google giới hạn {{v1}}/ngày mỗi tài khoản.', { v1: fmtBytes(G.uploadBytesPerDayPerUser) }),
  },
};

// ─── Formatting ───────────────────────────────────────────────────────────────────────────

/** GB-month: "3,2", "0,05", "< 0,01", "120". */
function fmtGb(v: number): string {
  const n = Math.max(0, Number(v) || 0);
  if (n > 0 && n < 0.01) return '< 0,01';
  if (n >= 100) return fmtNum(n);
  return String(Number(n.toFixed(n < 10 ? 2 : 1))).replace('.', ',');
}

function fmtMeterValue(unit: CloudUsageMeter['unit'], v: number): string {
  switch (unit) {
    case 'bytes': return fmtBytes(v);
    case 'gbMonth': return tr('{{v1}} GB-tháng', { v1: fmtGb(v) });
    case 'ops': return tr('{{v1}} lượt', { v1: fmtNum(v) });
    default: return tr('{{v1}} đơn vị', { v1: fmtNum(v) });
  }
}

/** "3,2 / 10 GB-tháng" (GB-month) · "12,3 GB / 15 GB" · "12.400 / 1.000.000 lượt" (operations) · "38 GB / Không giới hạn" (Unlimited). */
export function meterAmount(m: Pick<CloudUsageMeter, 'unit' | 'used' | 'limit'>): string {
  if (m.limit == null) return tr('{{v1}} / Không giới hạn', { v1: fmtMeterValue(m.unit, m.used) });
  switch (m.unit) {
    case 'bytes': return `${fmtBytes(m.used)} / ${fmtBytes(m.limit)}`;
    case 'gbMonth': return tr('{{v1}} / {{v2}} GB-tháng', { v1: fmtGb(m.used), v2: fmtGb(m.limit) });
    case 'ops': return tr('{{v1}} / {{v2}} lượt', { v1: fmtNum(m.used), v2: fmtNum(m.limit) });
    default: return tr('{{v1}} / {{v2}} đơn vị', { v1: fmtNum(m.used), v2: fmtNum(m.limit) });
  }
}

/** % used against the free tier / limit (can exceed 100); null when there is no limit. */
export function meterPercent(m: Pick<CloudUsageMeter, 'used' | 'limit'>): number | null {
  return m.limit != null && m.limit > 0 ? (Math.max(0, Number(m.used) || 0) / m.limit) * 100 : null;
}

/** "Tháng 10/2026" (R2: calendar month in UTC) · "Hôm nay (giờ Mỹ – Thái Bình Dương)" (Today, US Pacific time) (Google). */
export function usagePeriodText(report: Pick<CloudUsageReport, 'period'>): string {
  if (report.period.kind === 'day') return tr('Hôm nay (giờ Mỹ – Thái Bình Dương)');
  // Mid-period: the correct month, whether main computes the boundary in UTC or machine time.
  const d = new Date((report.period.startTs + (report.period.endTs || report.period.startTs)) / 2);
  return tr('Tháng {{v1}}/{{v2}}', { v1: d.getUTCMonth() + 1, v2: d.getUTCFullYear() });
}

// ─── Pieces ────────────────────────────────────────────────────────────────────────────────

function CostSummary({ report }: { report: CloudUsageReport }) {
  if (report.provider === 'gdrive') {
    return (
      <p className="text-sm text-foreground">
        {tr('Không tính phí theo lượt dùng (dưới ngưỡng) — bạn chỉ trả tiền gói Google One nếu dùng quá 15 GB.')}
      </p>
    );
  }
  const soFar = Number(report.cost?.soFar) || 0;
  const projected = Number(report.cost?.projected) || 0;
  if (soFar === 0 && projected === 0) {
    return <p className="text-sm font-medium text-success">{tr('Chưa phát sinh phí — vẫn trong phần miễn phí tháng này')}</p>;
  }
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium text-foreground">
        {tr('Phí ước tính tháng này: {{v1}} USD · dự kiến cả tháng {{v2}} USD', { v1: fmtCost(soFar), v2: fmtCost(projected) })}
      </p>
      <p className="text-xs text-muted-foreground">
        {tr('{{v1}} · cả tháng {{v2}} (ước tính theo {{v3}} ₫/USD)', { v1: fmtVnd(soFar), v2: fmtVnd(projected), v3: fmtNum(USD_VND_RATE) })}
      </p>
    </div>
  );
}

function MeterRow({ meter, periodKind }: { meter: CloudUsageMeter; periodKind: 'month' | 'day' }) {
  const info = METER_INFO[meter.id] ?? { label: String(meter.id), hint: '' };
  const pct = meterPercent(meter);
  const tone = meterTone(pct);
  const periodWord = periodKind === 'month' ? tr('tháng') : tr('ngày');
  const projectedOver = meter.projected != null && meter.limit != null && meter.projected > meter.limit;
  const costSoFar = Number(meter.costSoFar) || 0;
  const costProjected = Number(meter.costProjected) || 0;
  const cost = costSoFar > 0 ? `≈ ${fmtCost(costSoFar)} USD` : '';
  const costAll = costProjected > costSoFar ? tr('cả {{periodWord}} ≈ {{v1}} USD', { periodWord, v1: fmtCost(costProjected) }) : '';

  return (
    <li className="space-y-1.5 py-3" data-meter={meter.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {info.label}
          {meter.source === 'local' && (
            <Badge size="sm" title={tr('Chỉ tính Deplao trên máy này, chưa gồm máy khác hay ứng dụng khác')}>{tr('máy này')}</Badge>
          )}
        </p>
        <p className="text-sm tabular-nums text-foreground">
          {meterAmount(meter)}
          {pct != null && <span className={cn('ml-2 text-xs font-medium', METER_TEXT[tone])}>{fmtPercent(pct)}</span>}
        </p>
      </div>
      {pct != null && <ProgressBar value={Math.min(100, pct)} tone={tone} label={`${info.label}: ${fmtPercent(pct)}`} />}
      {(meter.projected != null || cost || costAll) && (
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {meter.projected != null && (
            <span className={projectedOver ? 'text-warning' : undefined}>
              {tr('Dự kiến cuối {{periodWord}}: {{v1}}', { periodWord, v1: fmtMeterValue(meter.unit, meter.projected) })}
            </span>
          )}
          {cost && <span className="font-medium text-foreground">{cost}</span>}
          {costAll && <span>{costAll}</span>}
        </p>
      )}
      {info.hint && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-subtle-foreground">
          <InfoIcon className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{info.hint}</span>
        </p>
      )}
    </li>
  );
}

// ─── Cards ─────────────────────────────────────────────────────────────────────────────────

export interface UsageCardProps {
  /** Selected storage (changing storage → re-read). */
  provider: CloudStorageProvider;
  /** Cloudflare Account ID (billing link). */
  accountId?: string | null;
  /** Change of value → re-read right away (e.g. just signed in to Google, or just changed the Cloudflare token). */
  reloadKey?: string;
  /** Report already available (test): show right away, do not read on open. */
  initialReport?: CloudUsageReport | null;
  className?: string;
}

export function UsageCard({ provider, accountId = null, reloadKey = '', initialReport = null, className }: UsageCardProps) {
  const { busy, run, notify } = useCloudAction();
  const [report, setReport] = useState<CloudUsageReport | null>(initialReport);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const lastLoad = useRef(0);
  const seq = useRef(0);
  const alive = useRef(true);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirst = useRef(!!initialReport);
  const supported = typeof cloudApi()?.usage?.get === 'function';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (trailing.current) {
        clearTimeout(trailing.current);
        trailing.current = null;
      }
    };
  }, []);

  /** Reads the report; returns the error sentence for the user, null when OK (or the app build has no usage yet). */
  const load = useCallback(async (refresh = false): Promise<string | null> => {
    const usage = cloudApi()?.usage;
    if (typeof usage?.get !== 'function') return null;
    const mine = ++seq.current;
    lastLoad.current = Date.now();
    try {
      const res = await usage.get(refresh ? { refresh: true } : undefined);
      if (!alive.current || mine !== seq.current) return null; // a newer read has already happened (e.g. the storage was just changed)
      if (res?.success && res.report) {
        setReport(res.report);
        setError(null);
        return null;
      }
      const message = res?.error || tr('Chưa đọc được mức sử dụng, thử lại sau.');
      setError(message);
      return message;
    } catch (err) {
      const message = cleanIpcError(err);
      if (alive.current && mine === seq.current) setError(message);
      return message;
    }
  }, []);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    void load();
  }, [load, provider, reloadKey]);

  // Main reports a change (image upload, sync, sign-in…): re-read, spaced at least 60 s (the last burst runs when the spacing ends).
  useCloudChanged(areas => {
    if (!areas.some(a => a === 'connection' || a === 'media' || a === 'db')) return;
    const wait = lastLoad.current + REFRESH_GAP_MS - Date.now();
    if (wait <= 0) {
      void load();
      return;
    }
    if (!trailing.current) {
      trailing.current = setTimeout(() => {
        trailing.current = null;
        void load();
      }, wait);
    }
  }, 1500);

  useVisibleInterval(() => { void load(); }, POLL_MS, supported);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), REFRESH_GAP_MS);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const refreshNow = async () => {
    setCooldown(true);
    setRefreshing(true);
    try {
      const err = await load(true);
      if (err) notify(err, 'error');
    } finally {
      if (alive.current) setRefreshing(false);
    }
  };

  const openTokenTemplate = async () => {
    const res = await run('template', () => cloudApi()?.tokenTemplateUrl());
    if (res?.url) openExternalUrl(res.url);
  };

  if (!supported && !initialReport) return null;

  // The report of the old storage (just changed storage, not read yet) is not shown yet.
  const view = report && report.provider === provider ? report : null;
  const r2 = provider === 'r2';

  return (
    <Card className={cn('space-y-3 p-4', className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground">
            {tr('Mức sử dụng & chi phí')}
            {view && <span className="text-xs font-normal text-muted-foreground">{usagePeriodText(view)}</span>}
          </p>
          {view && <CostSummary report={view} />}
        </div>
        <Button
          size="sm"
          variant="outline"
          leftIcon={<RefreshIcon className="h-4 w-4" />}
          loading={refreshing}
          disabled={cooldown || !supported}
          title={cooldown ? tr('Vừa cập nhật — bấm lại sau 1 phút') : tr('Đọc lại số liệu toàn tài khoản ngay')}
          onClick={() => void refreshNow()}
        >
          {tr('Cập nhật')}
        </Button>
      </div>

      {!view ? (
        error ? (
          <p className="text-xs text-muted-foreground">{error}</p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {trx('<0/> Đang đọc mức sử dụng…', { 0: <CloudSpinner className="h-3.5 w-3.5" /> })}
          </p>
        )
      ) : (
        <>
          {!view.accountData && (
            <Notice
              tone="info"
              title={tr('Chưa có số liệu toàn tài khoản')}
              action={r2 ? (
                <Button
                  size="sm"
                  variant="outline"
                  rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
                  loading={busy === 'template'}
                  onClick={() => void openTokenTemplate()}
                >
                  {tr('Tạo token mới đủ quyền')}
                </Button>
              ) : undefined}
            >
              <p>
                {view.accountNote || (r2
                  ? tr('Số liệu dưới đây chỉ tính Deplao trên máy này.')
                  : tr('Chưa đọc được dung lượng tài khoản Google.'))}
              </p>
              {r2 && <p className="text-muted-foreground">{tr('Tạo xong, bấm Quản lý → Đổi token ở đầu trang để dán token mới.')}</p>}
            </Notice>
          )}

          {view.meters.length > 0 && (
            <ul className="divide-y divide-border">
              {view.meters.map(meter => <MeterRow key={meter.id} meter={meter} periodKind={view.period.kind} />)}
            </ul>
          )}

          {view.sharedProject && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {tr('Đang dùng client Google chung của Deplao: hạn mức ngày tính chung cho mọi người dùng Deplao, phí (nếu có) do Deplao chịu — bạn chỉ trả gói Google One.')}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[11px] text-subtle-foreground">
            <span>
              {tr('{{v1}} Số liệu lúc {{v2}}.', { v1: r2
                ? tr('Ước tính theo bảng giá R2 Standard; số trên hoá đơn Cloudflare là chính xác.')
                : tr('Theo hạn mức Google Drive API đã công bố.'), v2: fmtShortWhen(view.generatedAt) })}
            </span>
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
              onClick={() => openExternalUrl(r2 ? cloudflareBillingUrl(accountId) : GOOGLE_ONE_STORAGE_URL)}
            >
              {r2 ? tr('Xem hoá đơn trên Cloudflare') : tr('Quản lý dung lượng Google One')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default UsageCard;
