/**
 * cloudUi.tsx — phần dùng chung của tab Cài đặt → Internet & Đám mây (Cloudflare: địa chỉ cố định, lưu media R2,
 * đồng bộ DB) và của PublicAddressCard. Chỉ dùng token màu của hệ thống giao diện (bg-card, text-foreground,
 * primary / success / warning / destructive / info…).
 *
 * Mọi lệnh đi qua window.electronAPI.cloudflare (CloudflareIpc, src/shared/cloud/cloudContracts.ts). Bản app cũ không có
 * module này → cloudApi() trả undefined và giao diện tự ẩn / báo cập nhật.
 *
 * Kho lưu (R2 hoặc Google Drive): CloudSettings đọc storage.status() và đặt vào StorageContext; các mảnh bên dưới đọc
 * useStoreLabel() để ghép câu ("lên R2" / "lên Google Drive"). Chưa biết kho (bản app cũ, test) = R2 như trước.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { cn } from '@/lib/cn';
import { AlertIcon, CheckCircleIcon, ExternalLinkIcon, InfoIcon, RefreshIcon } from '@/components/common/icons';
import { Button, type BadgeVariant } from '@/components/ui';
import {
  CLOUD_CHANGED_EVENT,
  normalizeScope,
  SINGLE_HOST_PATH_RULES,
  splitHostname,
  storageLabel,
  type AddressLayout,
  type CloudChangedPayload,
  type CloudConnectionStatus,
  type CloudFeature,
  type CloudflareIpc,
  type CloudPermissionCheck,
  type CloudScope,
  type CloudStorageProvider,
  type CloudStorageStatus,
  type MediaSyncStatus,
  type PublicAddress,
  type TunnelMode,
  type TunnelServiceId,
} from '../../../../shared/cloud/cloudContracts';

declare const __APP_VERSION__: string;

export type CloudArea = CloudChangedPayload['area'];
/** Hai phần của trang: Địa chỉ Internet · Đồng bộ dữ liệu (dữ liệu + ảnh/file chung một thiết lập). */
export type CloudSection = 'address' | 'sync';
export const CLOUD_AREAS: CloudArea[] = ['connection', 'tunnel', 'media', 'db'];
export const CLOUD_SECTIONS: CloudSection[] = ['address', 'sync'];

/** Id cũ của "Lưu media" / "Đồng bộ DB" (đã gộp vào "Đồng bộ dữ liệu") — link cũ vẫn mở đúng chỗ. */
const LEGACY_SECTIONS: Record<string, CloudSection> = { media: 'sync', db: 'sync' };

export function isCloudSection(value: unknown): value is CloudSection {
  return typeof value === 'string' && (CLOUD_SECTIONS as string[]).includes(value);
}

/** subtab của nav:settings → phần của trang ('media' / 'db' cũ → 'sync'); không nhận ra → null. */
export function toCloudSection(value: unknown): CloudSection | null {
  if (isCloudSection(value)) return value;
  return typeof value === 'string' ? LEGACY_SECTIONS[value] ?? null : null;
}

/** API Cloudflare của main; undefined ở bản app cũ. Đọc lúc gọi (không cache) để test thay được mock. */
export function cloudApi(): CloudflareIpc | undefined {
  return (ipc as unknown as { cloudflare?: CloudflareIpc } | undefined)?.cloudflare;
}

/** Lỗi IPC của Electron → câu cho người dùng (bỏ tiền tố "Error invoking remote method…"). */
export function cleanIpcError(err: unknown): string {
  const raw = String((err as { message?: string } | null)?.message ?? err ?? '').trim();
  if (/No handler registered/i.test(raw)) return 'Bản app này chưa có tính năng này. Hãy cập nhật Deplao.';
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^(Cloud)?Error:\s*/i, '').trim();
  return text || 'Thao tác không thành công, thử lại sau.';
}

// ─── Định dạng số, dung lượng, thời gian (cố định kiểu Việt Nam, không phụ thuộc ICU) ────────

const p2 = (n: number) => String(n).padStart(2, '0');

/** 12400 → "12.400". */
export function fmtNum(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return v < 0 ? `-${s}` : s;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function byteUnit(bytes: number): number {
  let i = 0;
  let v = Math.max(0, bytes);
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i += 1; }
  return i;
}

function inByteUnit(bytes: number, unit: number): string {
  const v = Math.max(0, bytes) / 1024 ** unit;
  const s = unit === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return s.replace('.', ',');
}

/** 4404019 → "4,2 MB". */
export function fmtBytes(bytes: number | null | undefined): string {
  const b = Number(bytes) || 0;
  const unit = byteUnit(b);
  return `${inByteUnit(b, unit)} ${BYTE_UNITS[unit]}`;
}

/** Hai dung lượng cùng đơn vị: "38 / 50 GB". */
export function fmtBytesPair(done: number, total: number): string {
  const unit = byteUnit(Math.max(Number(done) || 0, Number(total) || 0));
  return `${inByteUnit(Number(done) || 0, unit)} / ${inByteUnit(Number(total) || 0, unit)} ${BYTE_UNITS[unit]}`;
}

export function fmtHm(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "10:32:15". */
export function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "02:00 hôm nay", "23:10 hôm qua", "14:05 12/10/2026". */
export function fmtWhen(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  if (sameDay(ts, now)) return `${fmtHm(ts)} hôm nay`;
  if (sameDay(ts, now - 86_400_000)) return `${fmtHm(ts)} hôm qua`;
  return `${fmtHm(ts)} ${fmtDate(ts)}`;
}

/** Lần đồng bộ: "10:32:15" trong ngày, ngày khác thì kèm ngày. */
export function fmtSyncTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  return sameDay(ts, now) ? fmtClock(ts) : fmtWhen(ts, now);
}

/** Giờ ngắn cho nhãn: "13:03" trong ngày, "13:03 hôm qua", "13:03 12/10/2026". */
export function fmtShortWhen(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  return sameDay(ts, now) ? fmtHm(ts) : fmtWhen(ts, now);
}

/** Cột thời điểm của nhật ký: "10:32" trong ngày, "12/10 10:32" ngày khác. */
export function fmtLogTime(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return fmtHm(ts);
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${fmtHm(ts)}`;
}

/** Độ trễ của máy dự phòng: "40 giây", "3 phút". */
export function fmtLag(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'chưa rõ';
  if (ms < 1000) return 'dưới 1 giây';
  if (ms < 60_000) return `${Math.round(ms / 1000)} giây`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} phút`;
  return `${Math.round(ms / 3_600_000)} giờ`;
}

/** Ước tính tiền lưu trữ R2 Standard: 10 GB-tháng đầu miễn phí, sau đó 0,015 USD/GB-tháng (chưa tính thao tác). */
export function r2MonthlyUsd(bytes: number): number {
  const gb = Math.max(0, Number(bytes) || 0) / 1024 ** 3;
  return Math.max(0, gb - 10) * 0.015;
}

/** 0.6 → "0,6". */
export function fmtUsd(n: number): string {
  return String(Number((Number(n) || 0).toFixed(2))).replace('.', ',');
}

/** Tiền phí (USD): 0 → "0", dưới 0,01 → "< 0,01", còn lại như fmtUsd ("0,42"). */
export function fmtCost(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0';
  return v < 0.01 ? '< 0,01' : fmtUsd(v);
}

/** Đơn giá trong bảng giá: 0.015 → "0,015", 4.5 → "4,50", 0.36 → "0,36". */
export function fmtUsdPrice(n: number): string {
  const v = Number(n) || 0;
  return v.toFixed(v > 0 && v < 0.1 ? 3 : 2).replace('.', ',');
}

/** 1_000_000 → "1 triệu", 400_000_000 → "400 triệu". */
export function fmtMillions(n: number): string {
  return `${fmtNum((Number(n) || 0) / 1_000_000)} triệu`;
}

/** Tỷ giá dùng để quy đổi ước tính (chỉ để người dùng hình dung, không phải tỷ giá thật). */
export const USD_VND_RATE = 26_000;

/** USD → "≈ 11.000 ₫" (làm tròn nghìn; dưới 1.000 ₫ làm tròn trăm). */
export function fmtVnd(usd: number): string {
  const v = Math.max(0, Number(usd) || 0) * USD_VND_RATE;
  const step = v < 1000 ? 100 : 1000;
  return `≈ ${fmtNum(Math.round(v / step) * step)} ₫`;
}

/** Phần trăm đã dùng: "< 1%" khi rất nhỏ, còn lại làm tròn (có thể quá 100). */
export function fmtPercent(pct: number): string {
  const v = Number(pct) || 0;
  if (v > 0 && v < 1) return '< 1%';
  return `${Math.round(v)}%`;
}

/** Màu thanh mức dùng: dưới 70% bình thường, 70–100% cảnh báo, quá 100% đỏ. */
export function meterTone(pct: number | null | undefined): 'primary' | 'warning' | 'destructive' {
  const v = Number(pct) || 0;
  if (v > 100) return 'destructive';
  if (v >= 70) return 'warning';
  return 'primary';
}

/** Màu chữ % đi cùng meterTone. */
export const METER_TEXT: Record<ReturnType<typeof meterTone>, string> = {
  primary: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/** "YYYY-MM-DDTHH:mm" theo giờ máy, cho <input type="datetime-local">. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 00:00 giờ máy của ngày chứa `ts`. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "YYYY-MM-DD" theo giờ máy, cho <input type="date">; không có ngày → ''. */
export function toDateInput(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** "YYYY-MM-DD" của <input type="date"> → 00:00 giờ máy (ms). Sai định dạng, ngày không có thật, trước năm 2000 → null. */
export function fromDateInput(value: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (y < 2000) return null;
  const d = new Date(y, month, day);
  if (d.getFullYear() !== y || d.getMonth() !== month || d.getDate() !== day) return null;
  return d.getTime();
}

// ─── Phiên bản app (khôi phục: không mở bản do app mới hơn tạo) ─────────────────────────────

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

function versionParts(v: string): number[] {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
}

/** So sánh "26.10.0" theo từng phần số: >0 khi a mới hơn b. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Bản sao do Deplao mới hơn bản đang chạy tạo ra (schema có thể mới hơn). Không rõ phiên bản thì không chặn. */
export function isNewerThanApp(version: string, appVersion: string = APP_VERSION): boolean {
  if (!version || !appVersion || !/\d/.test(appVersion)) return false;
  return compareVersions(version, appVersion) > 0;
}

// ─── Quyền của token ─────────────────────────────────────────────────────────────────────

export function permissionOf(c: CloudConnectionStatus | null | undefined, feature: CloudFeature): CloudPermissionCheck | null {
  return c?.permissions?.find(p => p.feature === feature) ?? null;
}

/** Tên từng nhóm quyền của token (dòng kiểm tra ở dải tài khoản Cloudflare). */
export const CLOUD_FEATURE_LABELS: Record<CloudFeature, string> = {
  tunnel: 'Địa chỉ cố định',
  r2: 'Đồng bộ dữ liệu',
  workers: 'Worker, D1 (cho ứng dụng)',
};

/**
 * Dòng "Worker, D1 (cho ứng dụng)": quyền KHÔNG bắt buộc (chỉ ứng dụng tự triển khai lên Cloudflare cần) nên chỉ là
 * thông tin, không phải vấn đề của kết nối. null khi chưa kết nối hoặc main chưa kiểm (bản app cũ, chưa Kiểm tra lại).
 */
export function workersAccessLine(c: CloudConnectionStatus | null | undefined): { ok: boolean; text: string } | null {
  if (!c?.connected) return null;
  const p = permissionOf(c, 'workers');
  if (!p) return null;
  if (p.ok) return { ok: true, text: `${CLOUD_FEATURE_LABELS.workers}: đủ quyền` };
  const detail = p.missing?.length ? p.missing.join(', ') : 'thiếu quyền Workers Scripts, D1';
  return { ok: false, text: `${CLOUD_FEATURE_LABELS.workers}: ${detail} — chỉ cần khi dùng ứng dụng triển khai lên Cloudflare` };
}

/** Đã kết nối và R2 dùng được (chưa có kết quả kiểm tra thì coi là được, main sẽ báo lỗi rõ khi gọi). */
export function isR2Ready(c: CloudConnectionStatus | null | undefined): boolean {
  if (!c?.connected) return false;
  const p = permissionOf(c, 'r2');
  return !p || (p.ok && !p.r2NotEnabled);
}

export function r2DashboardUrl(accountId: string | null | undefined): string {
  return accountId ? `https://dash.cloudflare.com/${accountId}/r2/overview` : 'https://dash.cloudflare.com/?to=/:account/r2/overview';
}

export function cloudflareBillingUrl(accountId: string | null | undefined): string {
  return accountId ? `https://dash.cloudflare.com/${accountId}/billing` : 'https://dash.cloudflare.com/?to=/:account/billing';
}

export const GOOGLE_DRIVE_URL = 'https://drive.google.com/';
export const GOOGLE_ONE_STORAGE_URL = 'https://one.google.com/storage';
export const GOOGLE_CLOUD_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials';

// ─── Kho lưu đang chọn (R2 / Google Drive) ─────────────────────────────────────────────────

/**
 * Trạng thái kho lưu (storage.status()) cho các mảnh bên dưới CloudSettings / SyncSection / trình khôi phục.
 * null = chưa biết (bản app cũ, test, chưa đọc xong) → mọi chỗ cư xử như trước: kho R2, sẵn sàng theo kết nối Cloudflare.
 */
export const StorageContext = createContext<CloudStorageStatus | null>(null);

export function useStorage(): CloudStorageStatus | null {
  return useContext(StorageContext);
}

/** Kho đang chọn; chưa biết → 'r2'. */
export function useStorageProvider(): CloudStorageProvider {
  return useContext(StorageContext)?.provider ?? 'r2';
}

/** Tên kho để ghép câu: "R2" (mặc định) / "Google Drive". */
export function useStoreLabel(): string {
  return storageLabel(useContext(StorageContext)?.provider);
}

/** Kho dùng được ngay: có trạng thái kho thì theo main; chưa có (bản cũ / test) thì như trước — R2 đã kết nối + đủ quyền. */
export function isStorageReady(storage: CloudStorageStatus | null | undefined, connection: CloudConnectionStatus | null | undefined): boolean {
  return storage ? !!storage.ready : isR2Ready(connection);
}

/** "123456789012-abc…xyz9" — client_id OAuth rút gọn để hiện (bỏ đuôi .apps.googleusercontent.com). */
export function shortClientId(clientId: string | null | undefined): string {
  const id = String(clientId || '').trim().replace(/\.apps\.googleusercontent\.com$/i, '');
  if (!id) return 'chưa rõ';
  return id.length > 20 ? `${id.slice(0, 14)}…${id.slice(-4)}` : id;
}

// ─── Địa chỉ Internet: tên dịch vụ, trạng thái, xem trước tên miền ─────────────────────────

const portOf = (service: TunnelServiceId) => SINGLE_HOST_PATH_RULES.find(r => r.service === service)?.port ?? 0;

export const SERVICE_ORDER: TunnelServiceId[] = ['relay', 'payments', 'workflow'];

export const SERVICE_META: Record<TunnelServiceId, { name: string; activeLabel: string; suffix: string; port: number; offWarning: string }> = {
  relay: {
    name: 'Nhân viên và API',
    activeLabel: 'Đang chạy',
    suffix: '',
    port: portOf('relay'),
    offWarning: 'Nhân viên làm việc từ xa sẽ mất kết nối và API không gọi được từ Internet cho tới khi bật lại.',
  },
  payments: {
    name: 'Thanh toán, tích hợp',
    activeLabel: 'Đang nhận',
    suffix: '/webhook/…',
    port: portOf('payments'),
    offWarning: 'Casso, SePay và phần mềm bán hàng sẽ không gửi được giao dịch / đơn hàng vào (workflow "Khi nhận thanh toán", "Khi phần mềm bán hàng gửi webhook" không chạy) cho tới khi bật lại.',
  },
  workflow: {
    name: 'Webhook workflow',
    activeLabel: 'Đang nhận',
    suffix: '/api/workflow/webhook/…',
    port: portOf('workflow'),
    offWarning: 'Website và dịch vụ bên ngoài sẽ không kích hoạt được workflow cho tới khi bật lại.',
  },
};

export const MODE_LABEL: Record<TunnelMode, string> = {
  quick: 'Địa chỉ tạm',
  cloudflare_auto: 'Cloudflare tự động',
  ngrok: 'ngrok',
  cloudflare_manual: 'Cloudflare thủ công',
};

/** Nhãn + màu trạng thái của một địa chỉ (bảng dịch vụ, PublicAddressCard). */
export function addressStatus(addr: PublicAddress | null | undefined, activeLabel = 'Đang chạy'): { label: string; variant: BadgeVariant; dot: string } {
  if (!addr) return { label: 'Chưa có', variant: 'default', dot: 'bg-accent' };
  if (!addr.enabled) return { label: 'Tắt', variant: 'default', dot: 'bg-accent' };
  switch (addr.state) {
    case 'active': return { label: activeLabel, variant: 'success', dot: 'bg-success' };
    case 'starting': return { label: 'Đang bật', variant: 'info', dot: 'bg-info' };
    case 'restarting': return { label: 'Đang chạy lại', variant: 'warning', dot: 'bg-warning' };
    case 'error': return { label: 'Lỗi', variant: 'destructive', dot: 'bg-destructive' };
    default: return { label: 'Tắt', variant: 'default', dot: 'bg-accent' };
  }
}

/** Ô "Tên máy": bỏ dấu tiếng Việt, khoảng trắng → '-', chỉ giữ a-z 0-9 '-'. */
export function sanitizeHostPrefix(raw: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
}

export function hostPrefixError(prefix: string): string | null {
  if (!prefix) return 'Nhập tên máy, ví dụ shop.';
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix)) return 'Tên máy chỉ gồm chữ a–z, số và dấu -, không bắt đầu hay kết thúc bằng dấu -.';
  return null;
}

/** Hostname dự kiến khi gõ (giống quy tắc của main: một tên cho mọi dịch vụ, hoặc shop / shop-pay / shop-hook). */
export function previewHosts(prefix: string, zoneName: string, layout: AddressLayout): Record<TunnelServiceId, string> | null {
  if (!prefix || !zoneName) return null;
  if (layout === 'split') {
    return {
      relay: splitHostname(prefix, 'relay', zoneName),
      payments: splitHostname(prefix, 'payments', zoneName),
      workflow: splitHostname(prefix, 'workflow', zoneName),
    };
  }
  const host = `${prefix}.${zoneName}`;
  return { relay: host, payments: host, workflow: host };
}

// ─── Lưu media: câu mô tả tiến độ ────────────────────────────────────────────────────────

/** Hàng đợi media đang lùi tạm thời (lỗi mạng / R2 giới hạn tốc độ) — lỗi khi đó là tạm thời, không phải lỗi chặn. */
export function isMediaBackingOff(s: MediaSyncStatus | null | undefined, now = Date.now()): boolean {
  return !!s?.backoffUntil && s.backoffUntil > now;
}

export function mediaDetail(s: MediaSyncStatus, now = Date.now()): { text: string; tone: 'muted' | 'warning' | 'destructive' } {
  const t = s.totals;
  const failed = t.failed > 0 ? ` · ${fmtNum(t.failed)} file lỗi, sẽ thử lại` : '';
  if (!s.enabled) return { text: 'Đang tắt, file mới không được tải lên.', tone: 'muted' };
  if (s.paused) return { text: `Đã tạm dừng · còn ${fmtNum(t.pending)} file${failed}`, tone: 'warning' };
  if (isMediaBackingOff(s, now)) {
    // Lý do lùi (mạng chậm / R2 giới hạn tốc độ / lỗi tạm thời) do main ghi vào lastError
    const reason = (s.lastError || 'Tạm dừng tải lên').trim().replace(/[.。]+$/, '');
    return { text: `${reason} — tự thử lại lúc ${fmtHm(s.backoffUntil as number)}${failed}`, tone: 'warning' };
  }
  if (s.running) return { text: `Đang tải lên · còn ${fmtNum(t.pending)} file${failed}`, tone: 'muted' };
  if (t.pending > 0 && s.options.nightOnly) return { text: `Chờ tới 22:00 để chạy tiếp · còn ${fmtNum(t.pending)} file${failed}`, tone: 'muted' };
  if (t.pending > 0) return { text: `Còn ${fmtNum(t.pending)} file chờ tải lên${failed}`, tone: 'muted' };
  return { text: `Đã lên hết${failed}`, tone: t.failed > 0 ? 'warning' : 'muted' };
}

// ─── Phạm vi dữ liệu (Lưu media, Đồng bộ DB): tài khoản nào, từ ngày nào ──────────────────

/** Tài khoản tối thiểu để chọn / hiện tên trong phạm vi (cùng trường với useAccountStore). */
export interface ScopeAccount {
  zalo_id: string;
  full_name?: string;
  display_name?: string;
  channel?: string | null;
  avatar_url?: string;
}

export function scopeAccountName(account: ScopeAccount): string {
  return account.full_name || account.display_name || account.zalo_id;
}

/** "Tất cả tài khoản" · tên khi chỉ một tài khoản · "2 tài khoản". */
export function describeScopeAccounts(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  const s = normalizeScope(scope);
  if (s.accounts === 'all') return 'Tất cả tài khoản';
  if (s.accounts.length === 0) return 'Chưa chọn tài khoản';
  if (s.accounts.length === 1) {
    const only = s.accounts[0];
    const account = accounts.find(a => a.zalo_id === only);
    return account ? scopeAccountName(account) : '1 tài khoản';
  }
  return `${fmtNum(s.accounts.length)} tài khoản`;
}

/** "toàn bộ thời gian" · "từ 01/01/2026". */
export function describeScopeTime(scope: CloudScope | null | undefined): string {
  const s = normalizeScope(scope);
  return s.fromTs ? `từ ${fmtDate(s.fromTs)}` : 'toàn bộ thời gian';
}

/** Câu tóm tắt phạm vi: "Tất cả tài khoản · toàn bộ thời gian", "2 tài khoản · từ 01/01/2026". Thiếu = tất cả. */
export function describeScope(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  return `${describeScopeAccounts(scope, accounts)} · ${describeScopeTime(scope)}`;
}

/** Lý do chưa lưu được phạm vi (main từ chối danh sách tài khoản rỗng); null = lưu được. */
export function scopeProblem(scope: CloudScope | null | undefined): string | null {
  return Array.isArray(scope?.accounts) && scope.accounts.length === 0 ? 'Chọn ít nhất một tài khoản.' : null;
}

/** Ngày gợi ý khi vừa chọn "Từ ngày": ngày 1 của tháng cách đây 3 tháng (00:00 giờ máy). */
export function defaultScopeFromTs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - 3, 1).getTime();
}

// ─── Điều hướng, mở trình duyệt ─────────────────────────────────────────────────────────

/** Mở Cài đặt → tab (vd 'cloud' + 'address', hoặc 'employees') từ bất kỳ màn nào. */
export function navigateSettings(tab: string, subtab?: string): void {
  useAppStore.getState().setView('settings');
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab, subtab } })), 100);
}

export function openExternalUrl(url: string): void {
  try { ipc.shell?.openExternal(url); } catch { /* bản cũ không có shell */ }
}

// ─── Hook ───────────────────────────────────────────────────────────────────────────────

type IpcLike = { success: boolean; error?: string; code?: string } | null | undefined;

/**
 * Chạy một lệnh IPC có trạng thái bận + thông báo. Trả kết quả khi thành công, null khi lỗi (đã báo người dùng).
 * `fn` trả undefined (bản app cũ không có module) → báo cần cập nhật.
 */
export function useCloudAction() {
  const notify = useAppStore(s => s.showNotification);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R extends IpcLike>(key: string, fn: () => Promise<R> | undefined, okMessage?: string): Promise<NonNullable<R> | null> => {
    setBusy(key);
    try {
      const pending = fn();
      if (!pending) {
        notify('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.', 'warning');
        return null;
      }
      const res = await pending;
      if (!res || res.success === false) {
        notify(res?.error || 'Thao tác không thành công, thử lại sau.', 'error');
        return null;
      }
      if (okMessage) notify(okMessage, 'success');
      return res as NonNullable<R>;
    } catch (err) {
      notify(cleanIpcError(err), 'error');
      return null;
    } finally {
      setBusy(prev => (prev === key ? null : prev));
    }
  }, [notify]);
  return { busy, run, notify };
}

/**
 * Nghe CLOUD_CHANGED_EVENT. Gộp các lần đẩy dồn dập (vd tiến độ media) thành tối đa một lần gọi mỗi `delayMs`,
 * kèm danh sách phần đã đổi.
 */
export function useCloudChanged(onChange: (areas: CloudArea[]) => void, delayMs = 800): void {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  useEffect(() => {
    const pending = new Set<CloudArea>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = ipc.on?.(CLOUD_CHANGED_EVENT, (payload: CloudChangedPayload) => {
      if (payload?.area) pending.add(payload.area);
      else CLOUD_AREAS.forEach(a => pending.add(a));
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const areas = Array.from(pending);
        pending.clear();
        cbRef.current(areas);
      }, delayMs);
    });
    return () => {
      off?.();
      if (timer) clearTimeout(timer);
    };
  }, [delayMs]);
}

/** Gọi `tick` mỗi `ms` khi cửa sổ đang hiện (ẩn / thu nhỏ thì nghỉ); hiện lại thì gọi ngay một lần. */
export function useVisibleInterval(tick: () => void, ms: number, enabled = true): void {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!enabled) return;
    const visible = () => document.visibilityState !== 'hidden';
    const timer = setInterval(() => { if (visible()) ref.current(); }, ms);
    const onVisibility = () => { if (visible()) ref.current(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, enabled]);
}

// ─── Mảnh giao diện ─────────────────────────────────────────────────────────────────────

export type NoticeTone = 'info' | 'warning' | 'destructive' | 'success';

const NOTICE_BOX: Record<NoticeTone, string> = {
  info: 'border-info/30 bg-info/10',
  warning: 'border-warning/40 bg-warning/10',
  destructive: 'border-destructive/40 bg-destructive/10',
  success: 'border-success/40 bg-success/10',
};

const NOTICE_ICON: Record<NoticeTone, string> = {
  info: 'text-info',
  warning: 'text-warning',
  destructive: 'text-destructive',
  success: 'text-success',
};

/** Dải thông báo trong trang: icon + tiêu đề + nội dung + nút bên phải. */
export function Notice({ tone = 'info', title, children, action, className }: {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === 'success' ? CheckCircleIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div
      role={tone === 'warning' || tone === 'destructive' ? 'alert' : undefined}
      className={cn('flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3', NOTICE_BOX[tone], className)}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', NOTICE_ICON[tone])} />
      <div className="min-w-0 flex-1 space-y-1 text-xs leading-relaxed text-foreground/90">
        {title != null && <p className="text-sm font-semibold text-foreground">{title}</p>}
        {children}
      </div>
      {action != null && <div className="flex flex-shrink-0 flex-wrap items-center gap-2 self-center">{action}</div>}
    </div>
  );
}

export function CloudSpinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-4 w-4 animate-spin text-primary', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

const BAR_FILL = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
} as const;

export function ProgressBar({ value, tone = 'primary', className, label }: {
  value: number;
  tone?: keyof typeof BAR_FILL;
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-300', BAR_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface PillOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

/** Nhóm nút tròn chọn một (Cách tạo địa chỉ, Chế độ đồng bộ). */
export function PillGroup<T extends string>({ value, options, onChange, label, disabled }: {
  value: T;
  options: PillOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            disabled={disabled || opt.disabled}
            onClick={() => { if (!active) onChange(opt.value); }}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'border-primary bg-primary/10 font-semibold text-primary'
                : 'border-border text-foreground hover:border-primary/40 hover:bg-muted',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Dòng giải thích nhỏ dưới nhãn. */
  description?: React.ReactNode;
  disabled?: boolean;
}

/** Nhóm chọn một kiểu radio (chấm tròn + chữ): xếp dọc, hoặc `inline` thành một hàng. */
export function RadioList<T extends string>({ value, options, onChange, label, disabled, inline, className }: {
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  inline?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(inline ? 'flex flex-wrap items-center gap-x-5 gap-y-2' : 'space-y-2.5', className)}
    >
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || opt.disabled}
            onClick={() => { if (!active) onChange(opt.value); }}
            className={cn(
              'group flex items-start gap-2.5 rounded-md text-left',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:cursor-not-allowed disabled:opacity-50',
              !inline && 'w-full',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
                active ? 'border-primary' : 'border-input bg-muted group-hover:border-border-strong',
              )}
            >
              {active && <span className="h-2 w-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm leading-5 text-foreground">{opt.label}</span>
              {opt.description != null && (
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{opt.description}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Một dòng cài đặt: tên + mô tả bên trái, điều khiển bên phải. */
export function SettingRow({ title, description, control, className }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description != null && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {control != null && <div className="flex flex-shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}

/**
 * Lý do phần Đồng bộ dữ liệu chưa dùng được: chưa kết nối Cloudflare, tài khoản chưa bật R2 (lỗi 10042),
 * hoặc token thiếu quyền R2. Trả null khi R2 dùng được.
 */
export function R2RequiredNotice({ connection, onConnect, onRecheck, rechecking }: {
  connection: CloudConnectionStatus | null;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  if (!connection?.connected) {
    return (
      <Notice
        tone="info"
        title="Cần kết nối Cloudflare"
        action={onConnect && <Button size="sm" onClick={onConnect}>Kết nối Cloudflare</Button>}
      >
        <p>Phần này lưu dữ liệu lên R2 trong tài khoản Cloudflare của bạn. Kết nối Cloudflare ở đầu trang để bật.</p>
      </Notice>
    );
  }
  const perm = permissionOf(connection, 'r2');
  if (perm?.r2NotEnabled) {
    return (
      <Notice
        tone="warning"
        title="Tài khoản Cloudflare chưa bật R2"
        action={(
          <>
            <Button size="sm" variant="outline" rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />} onClick={() => openExternalUrl(r2DashboardUrl(connection.accountId))}>
              Mở trang R2
            </Button>
            {onRecheck && (
              <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
                Kiểm tra lại
              </Button>
            )}
          </>
        )}
      >
        <p>
          Vào Cloudflare → R2 Object Storage và bật R2. Cloudflare yêu cầu thêm phương thức thanh toán dù chỉ dùng phần
          miễn phí (10 GB mỗi tháng). Bật xong bấm Kiểm tra lại.
        </p>
      </Notice>
    );
  }
  if (perm && !perm.ok) {
    return (
      <Notice
        tone="warning"
        title="Token thiếu quyền R2"
        action={onRecheck && (
          <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
            Kiểm tra lại
          </Button>
        )}
      >
        <p>
          {perm.missing?.length ? `${perm.missing.join(' · ')}. ` : 'Token chưa có quyền Workers R2 Storage: Edit. '}
          Tạo token mới đủ quyền rồi bấm Quản lý → Đổi token.
        </p>
      </Notice>
    );
  }
  return null;
}

/**
 * Kho lưu đang chọn chưa dùng được. R2 (hoặc chưa biết kho) → R2RequiredNotice như trước; Google Drive chưa đăng
 * nhập → "Cần đăng nhập Google Drive" + nút tới thẻ Kho lưu. Trả null khi kho dùng được.
 */
export function StorageRequiredNotice({ storage, connection, onConnect, onRecheck, rechecking, onPickStore }: {
  storage: CloudStorageStatus | null | undefined;
  connection: CloudConnectionStatus | null;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Cuộn tới và làm nổi thẻ Kho lưu. */
  onPickStore?: () => void;
}) {
  if (storage?.provider === 'gdrive') {
    if (storage.ready) return null;
    return (
      <Notice
        tone="info"
        title="Cần đăng nhập Google Drive"
        action={onPickStore && <Button size="sm" onClick={onPickStore}>Chọn kho lưu</Button>}
      >
        <p>
          {storage.notReadyReason || 'Kho lưu đang chọn là Google Drive. Đăng nhập tài khoản Google ở thẻ Kho lưu để bật đồng bộ.'}
        </p>
      </Notice>
    );
  }
  // Cloudflare ổn theo kết nối nhưng main vẫn báo R2 chưa dùng được (lý do khác) → hiện đúng lý do của main.
  if (storage && !storage.ready && isR2Ready(connection)) {
    return (
      <Notice
        tone="warning"
        title="Kho R2 chưa dùng được"
        action={onRecheck && (
          <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
            Kiểm tra lại
          </Button>
        )}
      >
        <p>{storage.notReadyReason || 'Kiểm tra lại token Cloudflare hoặc chọn kho khác ở thẻ Kho lưu.'}</p>
      </Notice>
    );
  }
  return <R2RequiredNotice connection={connection} onConnect={onConnect} onRecheck={onRecheck} rechecking={rechecking} />;
}
