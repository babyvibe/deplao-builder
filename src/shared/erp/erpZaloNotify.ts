/**
 * Thông báo Quản lý công việc qua Zalo: loại thông báo chọn được, cài đặt (app_settings của Boss) và chữ tin nhắn.
 * Dùng chung main (ErpNotificationService: có thông báo thuộc loại đã chọn → gửi kèm tin Zalo) và giao diện
 * (Quản lý công việc → Cài đặt).
 *
 * Một tài khoản Zalo của cửa hàng gửi tin 1-1 tới SĐT nhân viên (hồ sơ Nhân sự), xếp hàng theo tài khoản như tin trả lời
 * tự động (AccountSendQueue, cách nhau vài giây) để Zalo không coi là spam. Trước đây chỉ có khoá
 * `erp.notify_zalo_account_id` mà không giao diện nào ghi → tính năng chưa bao giờ chạy.
 */
import type { ErpNotificationType } from '../../models/erp';

export interface ErpZaloNotifyTypeOption {
  type: ErpNotificationType;
  label: string;
  /** Dòng phụ: khi nào gửi / gửi cho ai. */
  hint?: string;
}

/** Loại thông báo gửi được qua Zalo, theo thứ tự hiện trên giao diện. */
export const ERP_ZALO_NOTIFY_TYPES: readonly ErpZaloNotifyTypeOption[] = [
  { type: 'task_assigned', label: 'Được giao task' },
  { type: 'task_due_soon', label: 'Task sắp đến hạn', hint: 'Trước hạn 1 giờ' },
  { type: 'task_overdue', label: 'Task quá hạn', hint: 'Tóm tắt lúc 9 giờ sáng' },
  { type: 'event_invited', label: 'Được mời tham dự lịch' },
  { type: 'event_reminder', label: 'Nhắc lịch', hint: 'Theo mốc nhắc của lịch' },
  { type: 'leave_request_new', label: 'Đơn nghỉ phép mới', hint: 'Gửi quản lý trực tiếp' },
  { type: 'leave_request_decided', label: 'Kết quả duyệt nghỉ phép', hint: 'Gửi người xin nghỉ' },
  { type: 'note_shared', label: 'Được chia sẻ ghi chú' },
];

/** Bật sẵn: đúng các thông báo trước đây gắn kênh Zalo (sắp đến hạn, quá hạn, mời lịch, nghỉ phép). */
export const DEFAULT_ERP_ZALO_TYPES: readonly ErpNotificationType[] = [
  'task_due_soon', 'task_overdue', 'event_invited', 'leave_request_new', 'leave_request_decided',
];

/** Khoá trong app_settings của Boss. */
export const ERP_ZALO_SETTING_KEYS = {
  enabled: 'erp.notify_zalo_enabled',
  accountId: 'erp.notify_zalo_account_id',
  types: 'erp.notify_zalo_types',
} as const;

/** Mỗi người nhận tối đa bấy nhiêu tin Zalo mỗi ngày (vượt thì chỉ còn thông báo trong app). */
export const ERP_ZALO_DAILY_CAP = 30;

export interface ErpZaloNotifySettings {
  enabled: boolean;
  /** accounts.zalo_id của tài khoản gửi ('' = chưa chọn). */
  accountId: string;
  types: ErpNotificationType[];
}

const KNOWN_TYPES = new Set<string>(ERP_ZALO_NOTIFY_TYPES.map(option => option.type));

/** Chỉ loại có trong danh sách, bỏ trùng, theo thứ tự danh sách. */
export function sanitizeErpZaloTypes(value: unknown): ErpNotificationType[] {
  const picked = new Set(Array.isArray(value) ? value.map(String).filter(type => KNOWN_TYPES.has(type)) : []);
  return ERP_ZALO_NOTIFY_TYPES.map(option => option.type).filter(type => picked.has(type));
}

/**
 * Cài đặt từ giá trị app_settings (null = chưa lưu). Chưa có công tắc mà đã có tài khoản (cấu hình tay trước đây) = bật;
 * chưa lưu loại / loại hỏng → loại mặc định.
 */
export function parseErpZaloSettings(raw: { enabled?: string | null; accountId?: string | null; types?: string | null }): ErpZaloNotifySettings {
  const accountId = String(raw.accountId ?? '').trim();
  const enabled = raw.enabled === null || raw.enabled === undefined ? !!accountId : raw.enabled === '1';
  let types: ErpNotificationType[] = [...DEFAULT_ERP_ZALO_TYPES];
  if (raw.types !== null && raw.types !== undefined) {
    try {
      const parsed = JSON.parse(raw.types);
      if (Array.isArray(parsed)) types = sanitizeErpZaloTypes(parsed);
    } catch { /* giữ mặc định */ }
  }
  return { enabled, accountId, types };
}

/** Áp phần thay đổi (chỉ trường có gửi, đúng kiểu) lên cài đặt hiện tại. */
export function mergeErpZaloSettings(current: ErpZaloNotifySettings, patch: unknown): ErpZaloNotifySettings {
  const p = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    accountId: typeof p.accountId === 'string' ? p.accountId.trim() : current.accountId,
    types: Array.isArray(p.types) ? sanitizeErpZaloTypes(p.types) : [...current.types],
  };
}

/** Tin Zalo của một thông báo: "🔔 Tiêu đề" + nội dung (dòng 2). */
export function erpZaloMessageText(title: string, body: string): string {
  const text = [`🔔 ${String(title ?? '').trim()}`, String(body ?? '').trim()].filter(Boolean).join('\n');
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/**
 * SĐT để tìm trên Zalo: chỉ chữ số, "0…" → "84…" (zca-js chỉ tự đổi khi ngôn ngữ là vi). Ít hơn 9 chữ số → '' (không
 * phải SĐT, không tốn lượt tìm SĐT của Zalo).
 */
export function zaloPhoneDigits(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `84${digits.slice(1)}`;
  return digits.length >= 9 ? digits : '';
}

// ── Trạng thái (Cài đặt → Thông báo qua Zalo) ──────────────────────────────────────────────────────────────────────

/**
 * ok = đã tìm thấy Zalo của SĐT; not_found = SĐT không có Zalo (hoặc tắt tìm qua SĐT); unchecked = chưa tìm SĐT trong
 * phiên này (tìm ở lần gửi đầu tiên).
 */
export type ErpZaloRecipientState = 'ok' | 'not_found' | 'unchecked' | 'no_phone';

export interface ErpZaloRecipient {
  employeeId: string;
  name: string;
  /** SĐT trong hồ sơ Nhân sự (như đã nhập). */
  phone: string;
  state: ErpZaloRecipientState;
  /** Lần gửi gần nhất trong phiên này. */
  last?: { at: number; ok: boolean; error?: string };
}

export interface ErpZaloSendLog {
  at: number;
  employeeId: string;
  name: string;
  title: string;
  ok: boolean;
  error?: string;
  /** Không gửi vì đã đủ ERP_ZALO_DAILY_CAP tin trong ngày (không phải lỗi). */
  skipped?: boolean;
  /** Tin gửi thử từ trang Cài đặt. */
  test?: boolean;
}

export interface ErpZaloNotifyStatus {
  settings: ErpZaloNotifySettings;
  /** Tài khoản gửi đang chọn: tên, đã kết nối chưa (null = chưa chọn). */
  account: { id: string; name: string; ready: boolean; missing?: boolean; notZalo?: boolean } | null;
  recipients: ErpZaloRecipient[];
  /** Tin gửi gần đây (mới nhất trước), chỉ trong phiên chạy này. */
  recent: ErpZaloSendLog[];
  /** Số tin đang chờ tới lượt gửi. */
  pending: number;
  gapSeconds: { min: number; max: number };
  dailyCap: number;
}

export const ERP_ZALO_RECIPIENT_STATE_LABELS: Record<ErpZaloRecipientState, string> = {
  ok: 'Có Zalo',
  not_found: 'Không tìm thấy Zalo',
  unchecked: 'Chưa kiểm tra',
  no_phone: 'Chưa có SĐT',
};
