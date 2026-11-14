/**
 * cloudUi.tsx - shared parts of the Settings → Internet & Cloud tab (Cloudflare: fixed address, media storage in R2,
 * DB sync) and of PublicAddressCard. Only uses the color tokens of the UI system (bg-card, text-foreground,
 * primary / success / warning / destructive / info…).
 *
 * Every command goes through window.electronAPI.cloudflare (CloudflareIpc, src/shared/cloud/cloudContracts.ts). Old app builds without
 * this module → cloudApi() returns undefined and the UI hides itself / asks for an update.
 *
 * Storage (R2 or Google Drive): CloudSettings reads storage.status() and sets it into StorageContext; the pieces below read
 * useStoreLabel() to build sentences ("lên R2" (to R2) / "lên Google Drive" (to Google Drive)). Unknown storage (old app build, tests) = R2 as before.
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
import { tr } from '../../../../shared/i18n';

declare const __APP_VERSION__: string;

export type CloudArea = CloudChangedPayload['area'];
/** The two parts of the page: Internet address · Data sync (data + images/files under one setting). */
export type CloudSection = 'address' | 'sync';
export const CLOUD_AREAS: CloudArea[] = ['connection', 'tunnel', 'media', 'db'];
export const CLOUD_SECTIONS: CloudSection[] = ['address', 'sync'];

/** Old ids of "Lưu media" (Media storage) / "Đồng bộ DB" (DB sync), merged into "Đồng bộ dữ liệu" (Data sync): old links still open the right place. */
const LEGACY_SECTIONS: Record<string, CloudSection> = { media: 'sync', db: 'sync' };

export function isCloudSection(value: unknown): value is CloudSection {
  return typeof value === 'string' && (CLOUD_SECTIONS as string[]).includes(value);
}

/** Section of the page for nav:settings's subtab ('media' / 'db' old → 'sync'); unrecognized → null. */
export function toCloudSection(value: unknown): CloudSection | null {
  if (isCloudSection(value)) return value;
  return typeof value === 'string' ? LEGACY_SECTIONS[value] ?? null : null;
}

/** The main process Cloudflare API; undefined in old app builds. Read at call time (not cached) so tests can swap the mock. */
export function cloudApi(): CloudflareIpc | undefined {
  return (ipc as unknown as { cloudflare?: CloudflareIpc } | undefined)?.cloudflare;
}

/** Electron IPC error → a sentence for the user (strips the "Error invoking remote method…" prefix). */
export function cleanIpcError(err: unknown): string {
  const raw = String((err as { message?: string } | null)?.message ?? err ?? '').trim();
  if (/No handler registered/i.test(raw)) return tr('Bản app này chưa có tính năng này. Hãy cập nhật Deplao.');
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^(Cloud)?Error:\s*/i, '').trim();
  return text || tr('Thao tác không thành công, thử lại sau.');
}

// ─── Number, storage size and time formatting (fixed to Vietnamese style, independent of ICU) ────────

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

/** Two sizes in the same unit: "38 / 50 GB". */
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

/** "02:00 hôm nay" (02:00 today), "23:10 hôm qua" (23:10 yesterday), "14:05 12/10/2026". */
export function fmtWhen(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  if (sameDay(ts, now)) return tr('{{v1}} hôm nay', { v1: fmtHm(ts) });
  if (sameDay(ts, now - 86_400_000)) return tr('{{v1}} hôm qua', { v1: fmtHm(ts) });
  return `${fmtHm(ts)} ${fmtDate(ts)}`;
}

/** Sync time: "10:32:15" within the day, with the date if it is another day. */
export function fmtSyncTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  return sameDay(ts, now) ? fmtClock(ts) : fmtWhen(ts, now);
}

/** Short time for labels: "13:03" within the day, "13:03 hôm qua" (yesterday), "13:03 12/10/2026". */
export function fmtShortWhen(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  return sameDay(ts, now) ? fmtHm(ts) : fmtWhen(ts, now);
}

/** Timestamp column of the log: "10:32" within the day, "12/10 10:32" on other days. */
export function fmtLogTime(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return fmtHm(ts);
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${fmtHm(ts)}`;
}

/** Standby machine lag: "40 giây" (40 seconds), "3 phút" (3 minutes). */
export function fmtLag(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return tr('chưa rõ');
  if (ms < 1000) return tr('dưới 1 giây');
  if (ms < 60_000) return tr('{{v1}} giây', { v1: Math.round(ms / 1000) });
  if (ms < 3_600_000) return tr('{{v1}} phút', { v1: Math.round(ms / 60_000) });
  return tr('{{v1}} giờ', { v1: Math.round(ms / 3_600_000) });
}

/** Estimated R2 Standard storage cost: the first 10 GB-month free, then 0,015 USD/GB-month (operations not included). */
export function r2MonthlyUsd(bytes: number): number {
  const gb = Math.max(0, Number(bytes) || 0) / 1024 ** 3;
  return Math.max(0, gb - 10) * 0.015;
}

/** 0.6 → "0,6". */
export function fmtUsd(n: number): string {
  return String(Number((Number(n) || 0).toFixed(2))).replace('.', ',');
}

/** Fee (USD): 0 → "0", under 0,01 → "< 0,01", otherwise as fmtUsd ("0,42"). */
export function fmtCost(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return '0';
  return v < 0.01 ? '< 0,01' : fmtUsd(v);
}

/** Unit price in the price table: 0.015 → "0,015", 4.5 → "4,50", 0.36 → "0,36". */
export function fmtUsdPrice(n: number): string {
  const v = Number(n) || 0;
  return v.toFixed(v > 0 && v < 0.1 ? 3 : 2).replace('.', ',');
}

/** 1_000_000 → "1 triệu" (1 million), 400_000_000 → "400 triệu" (400 million). */
export function fmtMillions(n: number): string {
  return tr('{{v1}} triệu', { v1: fmtNum((Number(n) || 0) / 1_000_000) });
}

/** Exchange rate used for the estimate conversion (only to give the user a sense of scale, not a real rate). */
export const USD_VND_RATE = 26_000;

/** USD → "≈ 11.000 ₫" (rounded to the thousand; under 1.000 ₫ rounded to the hundred). */
export function fmtVnd(usd: number): string {
  const v = Math.max(0, Number(usd) || 0) * USD_VND_RATE;
  const step = v < 1000 ? 100 : 1000;
  return `≈ ${fmtNum(Math.round(v / step) * step)} ₫`;
}

/** Percent used: "< 1%" when very small, otherwise rounded (can exceed 100). */
export function fmtPercent(pct: number): string {
  const v = Number(pct) || 0;
  if (v > 0 && v < 1) return '< 1%';
  return `${Math.round(v)}%`;
}

/** Usage bar color: under 70% normal, 70–100% warning, over 100% red. */
export function meterTone(pct: number | null | undefined): 'primary' | 'warning' | 'destructive' {
  const v = Number(pct) || 0;
  if (v > 100) return 'destructive';
  if (v >= 70) return 'warning';
  return 'primary';
}

/** Color of the % text that goes with meterTone. */
export const METER_TEXT: Record<ReturnType<typeof meterTone>, string> = {
  primary: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/** "YYYY-MM-DDTHH:mm" in local time, for <input type="datetime-local">. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 00:00 local time of the day that contains `ts`. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "YYYY-MM-DD" in local time, for <input type="date">; no date → ''. */
export function toDateInput(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** "YYYY-MM-DD" from <input type="date"> → 00:00 local time (ms). Wrong format, a date that does not exist, before the year 2000 → null. */
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

// ─── App version (restore: do not open a backup made by a newer app) ─────────────────────────────

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

function versionParts(v: string): number[] {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
}

/** Compare "26.10.0" part by part as numbers: >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** A backup made by a newer Deplao than the running one (the schema may be newer). Unknown version → do not block. */
export function isNewerThanApp(version: string, appVersion: string = APP_VERSION): boolean {
  if (!version || !appVersion || !/\d/.test(appVersion)) return false;
  return compareVersions(version, appVersion) > 0;
}

// ─── Token permissions ─────────────────────────────────────────────────────────────────────

export function permissionOf(c: CloudConnectionStatus | null | undefined, feature: CloudFeature): CloudPermissionCheck | null {
  return c?.permissions?.find(p => p.feature === feature) ?? null;
}

/** Names of each permission group of the token (the check line in the Cloudflare account bar). */
export const CLOUD_FEATURE_LABELS: Record<CloudFeature, string> = {
  tunnel: tr('Địa chỉ cố định'),
  r2: tr('Đồng bộ dữ liệu'),
  workers: tr('Worker, D1 (cho ứng dụng)'),
};

/**
 * The "Worker, D1 (cho ứng dụng)" (Worker, D1 (for apps)) line: these permissions are NOT required (only apps that deploy themselves to Cloudflare need them), so it is only
 * information, not a connection problem. null when not connected or when main has not checked yet (old app build, Recheck not yet run).
 */
export function workersAccessLine(c: CloudConnectionStatus | null | undefined): { ok: boolean; text: string } | null {
  if (!c?.connected) return null;
  const p = permissionOf(c, 'workers');
  if (!p) return null;
  if (p.ok) return { ok: true, text: tr('{{workers}}: đủ quyền', { workers: CLOUD_FEATURE_LABELS.workers }) };
  const detail = p.missing?.length ? p.missing.join(', ') : tr('thiếu quyền Workers Scripts, D1');
  return { ok: false, text: tr('{{workers}}: {{detail}} — chỉ cần khi dùng ứng dụng triển khai lên Cloudflare', { workers: CLOUD_FEATURE_LABELS.workers, detail }) };
}

/** Connected and R2 usable (if no check result yet, treat it as usable; main reports a clear error when it is called). */
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

// ─── Selected storage (R2 / Google Drive) ─────────────────────────────────────────────────

/**
 * Storage status (storage.status()) for the pieces below: CloudSettings / SyncSection / the restore wizard.
 * null = unknown (old app build, tests, not read yet) → every place behaves as before: R2 storage, ready when the Cloudflare connection is ready.
 */
export const StorageContext = createContext<CloudStorageStatus | null>(null);

export function useStorage(): CloudStorageStatus | null {
  return useContext(StorageContext);
}

/** Selected storage; unknown → 'r2'. */
export function useStorageProvider(): CloudStorageProvider {
  return useContext(StorageContext)?.provider ?? 'r2';
}

/** Storage name used in sentences: "R2" (default) / "Google Drive". */
export function useStoreLabel(): string {
  return storageLabel(useContext(StorageContext)?.provider);
}

/** Storage usable right away: with a storage status it follows main; without one (old build / tests) it is as before: R2 connected + enough permissions. */
export function isStorageReady(storage: CloudStorageStatus | null | undefined, connection: CloudConnectionStatus | null | undefined): boolean {
  return storage ? !!storage.ready : isR2Ready(connection);
}

/** "123456789012-abc…xyz9" - the shortened OAuth client_id shown on screen (the .apps.googleusercontent.com suffix removed). */
export function shortClientId(clientId: string | null | undefined): string {
  const id = String(clientId || '').trim().replace(/\.apps\.googleusercontent\.com$/i, '');
  if (!id) return tr('chưa rõ');
  return id.length > 20 ? `${id.slice(0, 14)}…${id.slice(-4)}` : id;
}

// ─── Internet address: service names, status, domain name preview ─────────────────────────

const portOf = (service: TunnelServiceId) => SINGLE_HOST_PATH_RULES.find(r => r.service === service)?.port ?? 0;

export const SERVICE_ORDER: TunnelServiceId[] = ['relay', 'payments', 'workflow'];

export const SERVICE_META: Record<TunnelServiceId, { name: string; activeLabel: string; suffix: string; port: number; offWarning: string }> = {
  relay: {
    name: tr('Nhân viên và API'),
    activeLabel: tr('Đang chạy'),
    suffix: '',
    port: portOf('relay'),
    offWarning: tr('Nhân viên làm việc từ xa sẽ mất kết nối và API không gọi được từ Internet cho tới khi bật lại.'),
  },
  payments: {
    name: tr('Thanh toán, tích hợp'),
    activeLabel: tr('Đang nhận'),
    suffix: '/webhook/…',
    port: portOf('payments'),
    offWarning: tr('Casso, SePay và phần mềm bán hàng sẽ không gửi được giao dịch / đơn hàng vào (workflow "Khi nhận thanh toán", "Khi phần mềm bán hàng gửi webhook" không chạy) cho tới khi bật lại.'),
  },
  workflow: {
    name: 'Webhook workflow',
    activeLabel: tr('Đang nhận'),
    suffix: '/api/workflow/webhook/…',
    port: portOf('workflow'),
    offWarning: tr('Website và dịch vụ bên ngoài sẽ không kích hoạt được workflow cho tới khi bật lại.'),
  },
};

export const MODE_LABEL: Record<TunnelMode, string> = {
  quick: tr('Địa chỉ tạm'),
  cloudflare_auto: tr('Cloudflare tự động'),
  ngrok: 'ngrok',
  cloudflare_manual: tr('Cloudflare thủ công'),
};

/** Label + status color of one address (services table, PublicAddressCard). */
export function addressStatus(addr: PublicAddress | null | undefined, activeLabel = tr('Đang chạy')): { label: string; variant: BadgeVariant; dot: string } {
  if (!addr) return { label: tr('Chưa có'), variant: 'default', dot: 'bg-accent' };
  if (!addr.enabled) return { label: tr('Tắt'), variant: 'default', dot: 'bg-accent' };
  switch (addr.state) {
    case 'active': return { label: activeLabel, variant: 'success', dot: 'bg-success' };
    case 'starting': return { label: tr('Đang bật'), variant: 'info', dot: 'bg-info' };
    case 'restarting': return { label: tr('Đang chạy lại'), variant: 'warning', dot: 'bg-warning' };
    case 'error': return { label: tr('Lỗi'), variant: 'destructive', dot: 'bg-destructive' };
    default: return { label: tr('Tắt'), variant: 'default', dot: 'bg-accent' };
  }
}

/** "Tên máy" (Machine name) field: strips Vietnamese diacritics, spaces → '-', keeps only a-z 0-9 '-'. */
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
  if (!prefix) return tr('Nhập tên máy, ví dụ shop.');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix)) return tr('Tên máy chỉ gồm chữ a–z, số và dấu -, không bắt đầu hay kết thúc bằng dấu -.');
  return null;
}

/** Expected hostname while typing (same rule as main: one name for every service, or shop / shop-pay / shop-hook). */
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

// ─── Media storage: progress sentences ────────────────────────────────────────────────────────

/** Media queue temporarily backing off (network error / R2 rate limit): the error at that point is temporary, not a blocking error. */
export function isMediaBackingOff(s: MediaSyncStatus | null | undefined, now = Date.now()): boolean {
  return !!s?.backoffUntil && s.backoffUntil > now;
}

export function mediaDetail(s: MediaSyncStatus, now = Date.now()): { text: string; tone: 'muted' | 'warning' | 'destructive' } {
  const t = s.totals;
  const failed = t.failed > 0 ? tr(' · {{v1}} file lỗi, sẽ thử lại', { v1: fmtNum(t.failed) }) : '';
  if (!s.enabled) return { text: tr('Đang tắt, file mới không được tải lên.'), tone: 'muted' };
  if (s.paused) return { text: tr('Đã tạm dừng · còn {{v1}} file{{failed}}', { v1: fmtNum(t.pending), failed }), tone: 'warning' };
  if (isMediaBackingOff(s, now)) {
    // Reason for backing off (slow network / R2 rate limit / temporary error) written by main into lastError
    const reason = (s.lastError || 'Tạm dừng tải lên').trim().replace(/[.。]+$/, '');
    return { text: tr('{{reason}} — tự thử lại lúc {{v1}}{{failed}}', { reason, v1: fmtHm(s.backoffUntil as number), failed }), tone: 'warning' };
  }
  if (s.running) return { text: tr('Đang tải lên · còn {{v1}} file{{failed}}', { v1: fmtNum(t.pending), failed }), tone: 'muted' };
  if (t.pending > 0 && s.options.nightOnly) return { text: tr('Chờ tới 22:00 để chạy tiếp · còn {{v1}} file{{failed}}', { v1: fmtNum(t.pending), failed }), tone: 'muted' };
  if (t.pending > 0) return { text: tr('Còn {{v1}} file chờ tải lên{{failed}}', { v1: fmtNum(t.pending), failed }), tone: 'muted' };
  return { text: tr('Đã lên hết{{failed}}', { failed }), tone: t.failed > 0 ? 'warning' : 'muted' };
}

// ─── Data scope (Media storage, DB sync): which accounts, from which date ──────────────────

/** Minimum account to choose from / show the name in the scope (same field as useAccountStore). */
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

/** "Tất cả tài khoản" (All accounts) · the name when there is only one account · "2 tài khoản" (2 accounts). */
export function describeScopeAccounts(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  const s = normalizeScope(scope);
  if (s.accounts === 'all') return tr('Tất cả tài khoản');
  if (s.accounts.length === 0) return tr('Chưa chọn tài khoản');
  if (s.accounts.length === 1) {
    const only = s.accounts[0];
    const account = accounts.find(a => a.zalo_id === only);
    return account ? scopeAccountName(account) : tr('1 tài khoản');
  }
  return tr('{{v1}} tài khoản', { v1: fmtNum(s.accounts.length) });
}

/** "toàn bộ thời gian" (all time) · "từ 01/01/2026" (from 01/01/2026). */
export function describeScopeTime(scope: CloudScope | null | undefined): string {
  const s = normalizeScope(scope);
  return s.fromTs ? tr('từ {{v1}}', { v1: fmtDate(s.fromTs) }) : tr('toàn bộ thời gian');
}

/** Scope summary sentence: "Tất cả tài khoản" (All accounts) · "toàn bộ thời gian" (all time), "2 tài khoản" (2 accounts) · "từ 01/01/2026" (from 01/01/2026). Missing = all. */
export function describeScope(scope: CloudScope | null | undefined, accounts: ReadonlyArray<ScopeAccount> = []): string {
  return `${describeScopeAccounts(scope, accounts)} · ${describeScopeTime(scope)}`;
}

/** Reason the scope cannot be saved yet (main rejects an empty account list); null = can be saved. */
export function scopeProblem(scope: CloudScope | null | undefined): string | null {
  return Array.isArray(scope?.accounts) && scope.accounts.length === 0 ? tr('Chọn ít nhất một tài khoản.') : null;
}

/** Suggested date when "Từ ngày" (From date) is first picked: the 1st of the month 3 months ago (00:00 local time). */
export function defaultScopeFromTs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() - 3, 1).getTime();
}

// ─── Navigation, opening the browser ─────────────────────────────────────────────────────────

/** Open Settings → a tab (e.g. 'cloud' + 'address', or 'employees') from any screen. */
export function navigateSettings(tab: string, subtab?: string): void {
  useAppStore.getState().setView('settings');
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab, subtab } })), 100);
}

export function openExternalUrl(url: string): void {
  try { ipc.shell?.openExternal(url); } catch { /* old build has no shell */ }
}

// ─── Hook ───────────────────────────────────────────────────────────────────────────────

type IpcLike = { success: boolean; error?: string; code?: string } | null | undefined;

/**
 * Runs one IPC command with a busy state + notification. Returns the result on success, null on error (the user has been told).
 * `fn` returns undefined (old app build without the module) → asks for an update.
 */
export function useCloudAction() {
  const notify = useAppStore(s => s.showNotification);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R extends IpcLike>(key: string, fn: () => Promise<R> | undefined, okMessage?: string): Promise<NonNullable<R> | null> => {
    setBusy(key);
    try {
      const pending = fn();
      if (!pending) {
        notify(tr('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.'), 'warning');
        return null;
      }
      const res = await pending;
      if (!res || res.success === false) {
        notify(res?.error || tr('Thao tác không thành công, thử lại sau.'), 'error');
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
 * Listens for CLOUD_CHANGED_EVENT. Merges bursts of pushes (e.g. media progress) into at most one call per `delayMs`,
 * along with the list of sections that changed.
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

/** Calls `tick` every `ms` while the window is visible (paused when hidden / minimized); calls it once right away when shown again. */
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

// ─── UI pieces ─────────────────────────────────────────────────────────────────────────

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

/** Notice bar on the page: icon + title + content + button on the right. */
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

/** Group of round buttons where one is chosen (Address creation mode, Sync mode). */
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
  /** Small explanation line under a label. */
  description?: React.ReactNode;
  disabled?: boolean;
}

/** Group of radio-style choices (round dot + text): stacked vertically, or `inline` in one row. */
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

/** One settings row: name + description on the left, control on the right. */
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
 * Why the Data sync section is not usable yet: not connected to Cloudflare, the account has not enabled R2 (error 10042),
 * or the token lacks R2 permission. Returns null when R2 is usable.
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
        title={tr('Cần kết nối Cloudflare')}
        action={onConnect && <Button size="sm" onClick={onConnect}>{tr('Kết nối Cloudflare')}</Button>}
      >
        <p>{tr('Phần này lưu dữ liệu lên R2 trong tài khoản Cloudflare của bạn. Kết nối Cloudflare ở đầu trang để bật.')}</p>
      </Notice>
    );
  }
  const perm = permissionOf(connection, 'r2');
  if (perm?.r2NotEnabled) {
    return (
      <Notice
        tone="warning"
        title={tr('Tài khoản Cloudflare chưa bật R2')}
        action={(
          <>
            <Button size="sm" variant="outline" rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />} onClick={() => openExternalUrl(r2DashboardUrl(connection.accountId))}>
              {tr('Mở trang R2')}
            </Button>
            {onRecheck && (
              <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
                {tr('Kiểm tra lại')}
              </Button>
            )}
          </>
        )}
      >
        <p>
          {tr('Vào Cloudflare → R2 Object Storage và bật R2. Cloudflare yêu cầu thêm phương thức thanh toán dù chỉ dùng phần miễn phí (10 GB mỗi tháng). Bật xong bấm Kiểm tra lại.')}
        </p>
      </Notice>
    );
  }
  if (perm && !perm.ok) {
    return (
      <Notice
        tone="warning"
        title={tr('Token thiếu quyền R2')}
        action={onRecheck && (
          <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
            {tr('Kiểm tra lại')}
          </Button>
        )}
      >
        <p>
          {perm.missing?.length ? `${perm.missing.join(' · ')}. ` : tr('Token chưa có quyền Workers R2 Storage: Edit. ')}
          {tr('Tạo token mới đủ quyền rồi bấm Quản lý → Đổi token.')}
        </p>
      </Notice>
    );
  }
  return null;
}

/**
 * The selected storage is not usable yet. R2 (or unknown storage) → R2RequiredNotice as before; Google Drive not signed in
 * → "Cần đăng nhập Google Drive" (Google Drive sign-in needed) + a button to the Storage card. Returns null when the storage is usable.
 */
export function StorageRequiredNotice({ storage, connection, onConnect, onRecheck, rechecking, onPickStore }: {
  storage: CloudStorageStatus | null | undefined;
  connection: CloudConnectionStatus | null;
  onConnect?: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Scroll to and highlight the Storage card. */
  onPickStore?: () => void;
}) {
  if (storage?.provider === 'gdrive') {
    if (storage.ready) return null;
    return (
      <Notice
        tone="info"
        title={tr('Cần đăng nhập Google Drive')}
        action={onPickStore && <Button size="sm" onClick={onPickStore}>{tr('Chọn kho lưu')}</Button>}
      >
        <p>
          {storage.notReadyReason || tr('Kho lưu đang chọn là Google Drive. Đăng nhập tài khoản Google ở thẻ Kho lưu để bật đồng bộ.')}
        </p>
      </Notice>
    );
  }
  // Cloudflare is fine per the connection, but main still says R2 is not usable (another reason) → show main's exact reason.
  if (storage && !storage.ready && isR2Ready(connection)) {
    return (
      <Notice
        tone="warning"
        title={tr('Kho R2 chưa dùng được')}
        action={onRecheck && (
          <Button size="sm" variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />} loading={rechecking} onClick={onRecheck}>
            {tr('Kiểm tra lại')}
          </Button>
        )}
      >
        <p>{storage.notReadyReason || tr('Kiểm tra lại token Cloudflare hoặc chọn kho khác ở thẻ Kho lưu.')}</p>
      </Notice>
    );
  }
  return <R2RequiredNotice connection={connection} onConnect={onConnect} onRecheck={onRecheck} rechecking={rechecking} />;
}
