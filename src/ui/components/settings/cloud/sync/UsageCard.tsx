/**
 * Đồng bộ dữ liệu → "Mức sử dụng & chi phí" của kho đang chọn (usage.get — src/shared/cloud/cloudContracts.ts):
 *  - R2: phí ước tính tháng này + dự kiến cả tháng (USD, kèm quy đổi ₫ ước tính); từng mục: dung lượng (GB-tháng), ghi
 *    (Class A), đọc (Class B), tải xuống.
 *  - Google Drive: không tính phí theo lượt (dưới ngưỡng); dung lượng tài khoản Google, đơn vị Drive API, tải xuống /
 *    tải lên hôm nay (ngày theo giờ Thái Bình Dương).
 * Đọc khi mở, khi đổi kho / đăng nhập (reloadKey), khi main báo đổi (connection / media / db — giãn ≥ 60 s) và 5 phút/lần
 * khi cửa sổ đang hiện; "Cập nhật" = đọc lại số liệu toàn tài khoản ngay (giãn 60 s). Bản app cũ chưa có usage → không
 * hiện gì.
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

/** Giãn tối thiểu giữa hai lần đọc khi main báo đổi, và giữa hai lần bấm "Cập nhật". */
const REFRESH_GAP_MS = 60_000;
const POLL_MS = 5 * 60_000;

const P = R2_PRICING;
const G = GDRIVE_LIMITS;

/** Tên + dòng giải thích "tính những gì" của từng mục. */
export const METER_INFO: Record<CloudUsageMeterId, { label: string; hint: string }> = {
  r2Storage: {
    label: 'Dung lượng đang lưu',
    hint: `Tính theo GB-tháng: trung bình dung lượng cao nhất mỗi ngày. ${P.freeStorageGbMonth} GB-tháng miễn phí, sau đó ${fmtUsdPrice(P.storageUsdPerGbMonth)} USD/GB-tháng.`,
  },
  r2ClassA: {
    label: 'Ghi (Class A)',
    hint: `Mỗi lần đẩy file hoặc một phần file lớn, tạo / hoàn tất tải lên nhiều phần, liệt kê file. ${fmtMillions(P.freeClassA)} lượt/tháng miễn phí, sau đó ${fmtUsdPrice(P.classAUsdPerMillion)} USD/triệu.`,
  },
  r2ClassB: {
    label: 'Đọc (Class B)',
    hint: `Mỗi lần tải file về máy hoặc kiểm tra file đã có trên kho. ${fmtMillions(P.freeClassB)} lượt/tháng miễn phí, sau đó ${fmtUsdPrice(P.classBUsdPerMillion)} USD/triệu.`,
  },
  r2Egress: {
    label: 'Tải xuống',
    hint: 'Miễn phí, không giới hạn — chỉ để biết.',
  },
  gdriveStorage: {
    label: 'Dung lượng tài khoản Google',
    hint: 'Dùng chung Gmail, Drive, Photos. Đầy thì không tải lên được và Gmail có thể không nhận thư.',
  },
  gdriveUnitsDay: {
    label: 'Lượt dùng Drive API hôm nay',
    hint: `Đơn vị quota: đọc thông tin ${G.unitsRead}, liệt kê ${G.unitsList}, tải xuống ${G.unitsDownload}, ghi/sửa ${G.unitsEdit}. Ngưỡng miễn phí ${fmtMillions(G.unitsPerDayPerProject)} đơn vị/ngày cho cả client OAuth; Google báo sẽ tính phí phần vượt từ cuối 2026.`,
  },
  gdriveEgressDay: {
    label: 'Tải xuống hôm nay',
    hint: `Miễn phí dưới ${fmtBytes(G.egressBytesPerDayPerProject)}/ngày cho cả client OAuth.`,
  },
  gdriveUploadDay: {
    label: 'Tải lên hôm nay',
    hint: `Google giới hạn ${fmtBytes(G.uploadBytesPerDayPerUser)}/ngày mỗi tài khoản.`,
  },
};

// ─── Định dạng ───────────────────────────────────────────────────────────────────────────

/** GB-tháng: "3,2", "0,05", "< 0,01", "120". */
function fmtGb(v: number): string {
  const n = Math.max(0, Number(v) || 0);
  if (n > 0 && n < 0.01) return '< 0,01';
  if (n >= 100) return fmtNum(n);
  return String(Number(n.toFixed(n < 10 ? 2 : 1))).replace('.', ',');
}

function fmtMeterValue(unit: CloudUsageMeter['unit'], v: number): string {
  switch (unit) {
    case 'bytes': return fmtBytes(v);
    case 'gbMonth': return `${fmtGb(v)} GB-tháng`;
    case 'ops': return `${fmtNum(v)} lượt`;
    default: return `${fmtNum(v)} đơn vị`;
  }
}

/** "3,2 / 10 GB-tháng" · "12,3 GB / 15 GB" · "12.400 / 1.000.000 lượt" · "38 GB / Không giới hạn". */
export function meterAmount(m: Pick<CloudUsageMeter, 'unit' | 'used' | 'limit'>): string {
  if (m.limit == null) return `${fmtMeterValue(m.unit, m.used)} / Không giới hạn`;
  switch (m.unit) {
    case 'bytes': return `${fmtBytes(m.used)} / ${fmtBytes(m.limit)}`;
    case 'gbMonth': return `${fmtGb(m.used)} / ${fmtGb(m.limit)} GB-tháng`;
    case 'ops': return `${fmtNum(m.used)} / ${fmtNum(m.limit)} lượt`;
    default: return `${fmtNum(m.used)} / ${fmtNum(m.limit)} đơn vị`;
  }
}

/** % đã dùng so với phần miễn phí / ngưỡng (có thể quá 100); null khi không có ngưỡng. */
export function meterPercent(m: Pick<CloudUsageMeter, 'used' | 'limit'>): number | null {
  return m.limit != null && m.limit > 0 ? (Math.max(0, Number(m.used) || 0) / m.limit) * 100 : null;
}

/** "Tháng 10/2026" (R2: tháng dương lịch UTC) · "Hôm nay (giờ Mỹ – Thái Bình Dương)" (Google). */
export function usagePeriodText(report: Pick<CloudUsageReport, 'period'>): string {
  if (report.period.kind === 'day') return 'Hôm nay (giờ Mỹ – Thái Bình Dương)';
  // Giữa kỳ: đúng tháng dù main tính mốc theo UTC hay giờ máy.
  const d = new Date((report.period.startTs + (report.period.endTs || report.period.startTs)) / 2);
  return `Tháng ${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}

// ─── Mảnh ────────────────────────────────────────────────────────────────────────────────

function CostSummary({ report }: { report: CloudUsageReport }) {
  if (report.provider === 'gdrive') {
    return (
      <p className="text-sm text-foreground">
        Không tính phí theo lượt dùng (dưới ngưỡng) — bạn chỉ trả tiền gói Google One nếu dùng quá 15 GB.
      </p>
    );
  }
  const soFar = Number(report.cost?.soFar) || 0;
  const projected = Number(report.cost?.projected) || 0;
  if (soFar === 0 && projected === 0) {
    return <p className="text-sm font-medium text-success">Chưa phát sinh phí — vẫn trong phần miễn phí tháng này</p>;
  }
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium text-foreground">
        {`Phí ước tính tháng này: ${fmtCost(soFar)} USD · dự kiến cả tháng ${fmtCost(projected)} USD`}
      </p>
      <p className="text-xs text-muted-foreground">
        {`${fmtVnd(soFar)} · cả tháng ${fmtVnd(projected)} (ước tính theo ${fmtNum(USD_VND_RATE)} ₫/USD)`}
      </p>
    </div>
  );
}

function MeterRow({ meter, periodKind }: { meter: CloudUsageMeter; periodKind: 'month' | 'day' }) {
  const info = METER_INFO[meter.id] ?? { label: String(meter.id), hint: '' };
  const pct = meterPercent(meter);
  const tone = meterTone(pct);
  const periodWord = periodKind === 'month' ? 'tháng' : 'ngày';
  const projectedOver = meter.projected != null && meter.limit != null && meter.projected > meter.limit;
  const costSoFar = Number(meter.costSoFar) || 0;
  const costProjected = Number(meter.costProjected) || 0;
  const cost = costSoFar > 0 ? `≈ ${fmtCost(costSoFar)} USD` : '';
  const costAll = costProjected > costSoFar ? `cả ${periodWord} ≈ ${fmtCost(costProjected)} USD` : '';

  return (
    <li className="space-y-1.5 py-3" data-meter={meter.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {info.label}
          {meter.source === 'local' && (
            <Badge size="sm" title="Chỉ tính Deplao trên máy này, chưa gồm máy khác hay ứng dụng khác">máy này</Badge>
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
              {`Dự kiến cuối ${periodWord}: ${fmtMeterValue(meter.unit, meter.projected)}`}
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

// ─── Thẻ ─────────────────────────────────────────────────────────────────────────────────

export interface UsageCardProps {
  /** Kho đang chọn (đổi kho → đọc lại). */
  provider: CloudStorageProvider;
  /** Account ID Cloudflare (link hoá đơn). */
  accountId?: string | null;
  /** Đổi giá trị → đọc lại ngay (vd vừa đăng nhập Google, vừa đổi token Cloudflare). */
  reloadKey?: string;
  /** Báo cáo có sẵn (test): hiện ngay, không đọc khi mở. */
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

  /** Đọc báo cáo; trả câu lỗi cho người dùng, null khi được (hoặc bản app chưa có usage). */
  const load = useCallback(async (refresh = false): Promise<string | null> => {
    const usage = cloudApi()?.usage;
    if (typeof usage?.get !== 'function') return null;
    const mine = ++seq.current;
    lastLoad.current = Date.now();
    try {
      const res = await usage.get(refresh ? { refresh: true } : undefined);
      if (!alive.current || mine !== seq.current) return null; // đã có lần đọc mới hơn (vd vừa đổi kho)
      if (res?.success && res.report) {
        setReport(res.report);
        setError(null);
        return null;
      }
      const message = res?.error || 'Chưa đọc được mức sử dụng, thử lại sau.';
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

  // Main báo đổi (ảnh tải lên, đồng bộ, đăng nhập…): đọc lại, giãn ít nhất 60 s (lần dồn cuối chạy khi hết giãn).
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

  // Báo cáo của kho cũ (vừa đổi kho, chưa đọc xong) thì chưa hiện.
  const view = report && report.provider === provider ? report : null;
  const r2 = provider === 'r2';

  return (
    <Card className={cn('space-y-3 p-4', className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground">
            Mức sử dụng &amp; chi phí
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
          title={cooldown ? 'Vừa cập nhật — bấm lại sau 1 phút' : 'Đọc lại số liệu toàn tài khoản ngay'}
          onClick={() => void refreshNow()}
        >
          Cập nhật
        </Button>
      </div>

      {!view ? (
        error ? (
          <p className="text-xs text-muted-foreground">{error}</p>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CloudSpinner className="h-3.5 w-3.5" /> Đang đọc mức sử dụng…
          </p>
        )
      ) : (
        <>
          {!view.accountData && (
            <Notice
              tone="info"
              title="Chưa có số liệu toàn tài khoản"
              action={r2 ? (
                <Button
                  size="sm"
                  variant="outline"
                  rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
                  loading={busy === 'template'}
                  onClick={() => void openTokenTemplate()}
                >
                  Tạo token mới đủ quyền
                </Button>
              ) : undefined}
            >
              <p>
                {view.accountNote || (r2
                  ? 'Số liệu dưới đây chỉ tính Deplao trên máy này.'
                  : 'Chưa đọc được dung lượng tài khoản Google.')}
              </p>
              {r2 && <p className="text-muted-foreground">Tạo xong, bấm Quản lý → Đổi token ở đầu trang để dán token mới.</p>}
            </Notice>
          )}

          {view.meters.length > 0 && (
            <ul className="divide-y divide-border">
              {view.meters.map(meter => <MeterRow key={meter.id} meter={meter} periodKind={view.period.kind} />)}
            </ul>
          )}

          {view.sharedProject && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Đang dùng client Google chung của Deplao: hạn mức ngày tính chung cho mọi người dùng Deplao, phí (nếu có) do
              Deplao chịu — bạn chỉ trả gói Google One.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[11px] text-subtle-foreground">
            <span>
              {`${r2
                ? 'Ước tính theo bảng giá R2 Standard; số trên hoá đơn Cloudflare là chính xác.'
                : 'Theo hạn mức Google Drive API đã công bố.'} Số liệu lúc ${fmtShortWhen(view.generatedAt)}.`}
            </span>
            <Button
              variant="link"
              size="sm"
              className="text-xs"
              rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
              onClick={() => openExternalUrl(r2 ? cloudflareBillingUrl(accountId) : GOOGLE_ONE_STORAGE_URL)}
            >
              {r2 ? 'Xem hoá đơn trên Cloudflare' : 'Quản lý dung lượng Google One'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default UsageCard;
