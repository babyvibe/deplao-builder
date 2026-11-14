/**
 * Task management notifications via Zalo: the notification types that can be selected, the settings (Boss's app_settings) and the message text.
 * Shared by main (ErpNotificationService: if a notification of a selected type exists → send it along with the Zalo message) and the UI
 * (Task management → Settings).
 *
 * One shop Zalo account sends 1-1 messages to the employee's phone number (Staff profile), queued per account like auto-reply messages
 * (AccountSendQueue, a few seconds apart) so Zalo does not treat them as spam. Previously only the
 * `erp.notify_zalo_account_id` key existed and no UI wrote it → the feature never ran.
 */
import type { ErpNotificationType } from '../../models/erp';
import { tr } from '../i18n';

export interface ErpZaloNotifyTypeOption {
  type: ErpNotificationType;
  label: string;
  /** Sub-line: when to send / to whom. */
  hint?: string;
}

/** Notification types that can be sent via Zalo, in the order shown in the UI. */
export const ERP_ZALO_NOTIFY_TYPES: readonly ErpZaloNotifyTypeOption[] = [
  { type: 'task_assigned', label: tr('Được giao task') },
  { type: 'task_due_soon', label: tr('Task sắp đến hạn'), hint: tr('Trước hạn 1 giờ') },
  { type: 'task_overdue', label: tr('Task quá hạn'), hint: tr('Tóm tắt lúc 9 giờ sáng') },
  { type: 'event_invited', label: tr('Được mời tham dự lịch') },
  { type: 'event_reminder', label: tr('Nhắc lịch'), hint: tr('Theo mốc nhắc của lịch') },
  { type: 'leave_request_new', label: tr('Đơn nghỉ phép mới'), hint: tr('Gửi quản lý trực tiếp') },
  { type: 'leave_request_decided', label: tr('Kết quả duyệt nghỉ phép'), hint: tr('Gửi người xin nghỉ') },
  { type: 'note_shared', label: tr('Được chia sẻ ghi chú') },
];

/** On by default: exactly the notifications that were previously tied to the Zalo channel (due soon, overdue, calendar invitation, leave). */
export const DEFAULT_ERP_ZALO_TYPES: readonly ErpNotificationType[] = [
  'task_due_soon', 'task_overdue', 'event_invited', 'leave_request_new', 'leave_request_decided',
];

/** Key in Boss's app_settings. */
export const ERP_ZALO_SETTING_KEYS = {
  enabled: 'erp.notify_zalo_enabled',
  accountId: 'erp.notify_zalo_account_id',
  types: 'erp.notify_zalo_types',
} as const;

/** Each recipient gets at most this many Zalo messages per day (beyond that, only the in-app notification is sent). */
export const ERP_ZALO_DAILY_CAP = 30;

export interface ErpZaloNotifySettings {
  enabled: boolean;
  /** accounts.zalo_id of the sending account ('' = not selected yet). */
  accountId: string;
  types: ErpNotificationType[];
}

const KNOWN_TYPES = new Set<string>(ERP_ZALO_NOTIFY_TYPES.map(option => option.type));

/** Only types in the list, duplicates removed, in list order. */
export function sanitizeErpZaloTypes(value: unknown): ErpNotificationType[] {
  const picked = new Set(Array.isArray(value) ? value.map(String).filter(type => KNOWN_TYPES.has(type)) : []);
  return ERP_ZALO_NOTIFY_TYPES.map(option => option.type).filter(type => picked.has(type));
}

/**
 * Settings from the app_settings value (null = not saved yet). No switch yet but an account already set (configured by hand before) = on;
 * no types saved / broken types → default types.
 */
export function parseErpZaloSettings(raw: { enabled?: string | null; accountId?: string | null; types?: string | null }): ErpZaloNotifySettings {
  const accountId = String(raw.accountId ?? '').trim();
  const enabled = raw.enabled === null || raw.enabled === undefined ? !!accountId : raw.enabled === '1';
  let types: ErpNotificationType[] = [...DEFAULT_ERP_ZALO_TYPES];
  if (raw.types !== null && raw.types !== undefined) {
    try {
      const parsed = JSON.parse(raw.types);
      if (Array.isArray(parsed)) types = sanitizeErpZaloTypes(parsed);
    } catch { /* keep the default */ }
  }
  return { enabled, accountId, types };
}

/** Apply the changes (only fields that are sent, with the right type) to the current settings. */
export function mergeErpZaloSettings(current: ErpZaloNotifySettings, patch: unknown): ErpZaloNotifySettings {
  const p = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {};
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    accountId: typeof p.accountId === 'string' ? p.accountId.trim() : current.accountId,
    types: Array.isArray(p.types) ? sanitizeErpZaloTypes(p.types) : [...current.types],
  };
}

/** Zalo message for a notification: "🔔 Tiêu đề" (title) + body (line 2). */
export function erpZaloMessageText(title: string, body: string): string {
  const text = [`🔔 ${String(title ?? '').trim()}`, String(body ?? '').trim()].filter(Boolean).join('\n');
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/**
 * Phone number to look up on Zalo: digits only, "0…" → "84…" (zca-js only converts it by itself when the language is vi). Fewer than 9 digits → '' (not
 * a phone number, so it does not use up a Zalo phone lookup).
 */
export function zaloPhoneDigits(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `84${digits.slice(1)}`;
  return digits.length >= 9 ? digits : '';
}

// ── Status (Settings → Zalo notifications) ──────────────────────────────────────────────────────────────────────

/**
 * ok = the Zalo account of the phone number was found; not_found = the phone number has no Zalo (or phone lookup is off); unchecked = the phone number has not been looked up in
 * this session (it is looked up on the first send).
 */
export type ErpZaloRecipientState = 'ok' | 'not_found' | 'unchecked' | 'no_phone';

export interface ErpZaloRecipient {
  employeeId: string;
  name: string;
  /** Phone number in the Staff profile (as entered). */
  phone: string;
  state: ErpZaloRecipientState;
  /** Most recent send in this session. */
  last?: { at: number; ok: boolean; error?: string };
}

export interface ErpZaloSendLog {
  at: number;
  employeeId: string;
  name: string;
  title: string;
  ok: boolean;
  error?: string;
  /** Not sent because the daily limit of ERP_ZALO_DAILY_CAP messages was already reached (not an error). */
  skipped?: boolean;
  /** Test message sent from the Settings page. */
  test?: boolean;
}

export interface ErpZaloNotifyStatus {
  settings: ErpZaloNotifySettings;
  /** Selected sending account: name, whether it is connected (null = not selected). */
  account: { id: string; name: string; ready: boolean; missing?: boolean; notZalo?: boolean } | null;
  recipients: ErpZaloRecipient[];
  /** Recently sent messages (newest first), this run only. */
  recent: ErpZaloSendLog[];
  /** Number of messages waiting for their turn to send. */
  pending: number;
  gapSeconds: { min: number; max: number };
  dailyCap: number;
}

export const ERP_ZALO_RECIPIENT_STATE_LABELS: Record<ErpZaloRecipientState, string> = {
  ok: tr('Có Zalo'),
  not_found: tr('Không tìm thấy Zalo'),
  unchecked: tr('Chưa kiểm tra'),
  no_phone: tr('Chưa có SĐT'),
};
