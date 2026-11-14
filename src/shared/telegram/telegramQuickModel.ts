/**
 * Telegram quick actions "Nhóm mới / Kênh mới / Danh bạ / Cuộc gọi" (New group / New channel / Contacts / Calls): pure rules shared by main + renderer:
 * checks for public link names, call history labels, contact access status, auto-deleting messages.
 * Test: src/__tests__/telegram/telegramQuickModel.test.ts
 */
import type { TelegramPeerType } from '../../models/telegram/telegram';
import { describeLastSeen } from '../chat/presenceText';
import { tr } from '../i18n';

// ─── Public link t.me/<name> (channel / supergroup) ────────────────────────────

export const TELEGRAM_USERNAME_MIN = 5;
export const TELEGRAM_USERNAME_MAX = 32;

/** "https://t.me/ten_kenh", "t.me/ten_kenh", "@ten_kenh", " ten_kenh " → "ten_kenh". */
export function normalizeTelegramUsernameInput(input: string): string {
  return String(input || '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .trim();
}

export type TelegramUsernameCheck = { ok: true; username: string } | { ok: false; error: string };

/**
 * Telegram public name rules (same as the official app's checks; the server still makes the final decision
 * through channels.checkUsername): 5-32 characters a-z, 0-9, "_"; starts with a letter; does not end with "_";
 * no 2 "_" in a row.
 */
export function validateTelegramUsername(input: string): TelegramUsernameCheck {
  const username = normalizeTelegramUsernameInput(input);
  if (!username) return { ok: false, error: tr('Nhập tên cho link công khai') };
  if (/[^a-zA-Z0-9_]/.test(username)) return { ok: false, error: tr('Chỉ dùng chữ a–z, số 0–9 và dấu gạch dưới (_)') };
  if (!/^[a-zA-Z]/.test(username)) return { ok: false, error: tr('Tên phải bắt đầu bằng chữ cái') };
  if (username.length < TELEGRAM_USERNAME_MIN) return { ok: false, error: tr('Tên cần ít nhất {{TELEGRAM_USERNAME_MIN}} ký tự', { TELEGRAM_USERNAME_MIN }) };
  if (username.length > TELEGRAM_USERNAME_MAX) return { ok: false, error: tr('Tên tối đa {{TELEGRAM_USERNAME_MAX}} ký tự', { TELEGRAM_USERNAME_MAX }) };
  if (username.endsWith('_')) return { ok: false, error: tr('Tên không được kết thúc bằng dấu gạch dưới') };
  if (username.includes('__')) return { ok: false, error: tr('Không dùng 2 dấu gạch dưới liền nhau') };
  return { ok: true, username };
}

/** RPC error when checking / setting the public name → an easy-to-understand message. */
export function telegramUsernameError(raw: string): string {
  const message = String(raw || '');
  if (message.includes('USERNAME_OCCUPIED')) return tr('Tên này đã có người dùng');
  if (message.includes('USERNAME_PURCHASE_AVAILABLE')) return tr('Tên này đang được bán trên fragment.com — chọn tên khác');
  if (message.includes('USERNAME_INVALID')) return tr('Tên không hợp lệ');
  if (message.includes('CHANNELS_ADMIN_PUBLIC_TOO_MUCH')) return tr('Tài khoản đang quản lý quá nhiều kênh / nhóm công khai — chuyển bớt sang riêng tư');
  if (message.includes('USERNAME_NOT_MODIFIED')) return tr('Kênh đang dùng đúng tên này');
  if (message.includes('CHAT_ADMIN_REQUIRED')) return tr('Cần quyền quản trị để đổi link');
  return message || tr('Không kiểm tra được tên');
}

// ─── Auto-delete messages (ttl_period) ────────────────────────────────────────

export const TELEGRAM_TTL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: tr('Tắt') },
  { value: 86400, label: tr('Sau 1 ngày') },
  { value: 7 * 86400, label: tr('Sau 1 tuần') },
  { value: 31 * 86400, label: tr('Sau 1 tháng') },
];

/** The server only accepts multiples of 1 day, up to 1 year; other values → off. */
export function normalizeTelegramTtl(value: unknown): number {
  const seconds = Math.floor(Number(value) || 0);
  if (seconds <= 0 || seconds % 86400 !== 0 || seconds > 365 * 86400) return 0;
  return seconds;
}

// ─── Call history (messageActionPhoneCall) ───────────────────────────────

export type TelegramCallReason = 'missed' | 'busy' | 'hangup' | 'disconnect' | 'conference' | null;
export type TelegramCallKind = 'outgoing' | 'cancelled' | 'busy' | 'incoming' | 'missed' | 'declined';

export interface TelegramCallInfo {
  /** I made the outgoing call. */
  out: boolean;
  reason: TelegramCallReason;
  /** Seconds; only present when the call was connected. */
  duration?: number | null;
  video?: boolean;
}

/** GramJS class name of PhoneCallDiscardReason → reason. */
export function telegramCallReasonOf(className: string | null | undefined): TelegramCallReason {
  switch (className) {
    case 'PhoneCallDiscardReasonMissed': return 'missed';
    case 'PhoneCallDiscardReasonBusy': return 'busy';
    case 'PhoneCallDiscardReasonHangup': return 'hangup';
    case 'PhoneCallDiscardReasonDisconnect': return 'disconnect';
    case 'PhoneCallDiscardReasonMigrateConferenceCall': return 'conference';
    default: return null;
  }
}

/**
 * Like Telegram: a missed outgoing call = "Đã huỷ" (Cancelled) (I cancelled it / nobody answered); a missed incoming call = "Gọi nhỡ" (Missed call); an incoming call with a busy reason =
 * I declined it; an outgoing call with a busy reason = the other side declined it or is busy on another call.
 */
export function telegramCallKind(call: TelegramCallInfo): TelegramCallKind {
  if (call.out) {
    if (call.reason === 'missed') return 'cancelled';
    if (call.reason === 'busy') return 'busy';
    return 'outgoing';
  }
  if (call.reason === 'missed') return 'missed';
  if (call.reason === 'busy') return 'declined';
  return 'incoming';
}

const CALL_LABEL: Record<TelegramCallKind, string> = {
  outgoing: 'Cuộc gọi đi',
  cancelled: tr('Đã huỷ'),
  busy: tr('Máy bận'),
  incoming: 'Cuộc gọi đến',
  missed: tr('Gọi nhỡ'),
  declined: tr('Đã từ chối'),
};

/** A call that never connected (shown in red in the history, counted as "Gọi nhỡ" (Missed call)). */
export function isUnansweredTelegramCall(kind: TelegramCallKind): boolean {
  return kind === 'missed' || kind === 'declined' || kind === 'cancelled' || kind === 'busy';
}

/** 42 → "42 giây", 300 → "5 phút", 3725 → "1 giờ 2 phút". */
export function formatTelegramCallDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return tr('{{total}} giây', { total });
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? tr('{{hours}} giờ {{minutes}} phút', { hours, minutes }) : tr('{{hours}} giờ', { hours });
  return tr('{{minutes}} phút', { minutes });
}

export function describeTelegramCall(call: TelegramCallInfo): { kind: TelegramCallKind; label: string; detail: string } {
  const kind = telegramCallKind(call);
  const base = call.video ? CALL_LABEL[kind].replace('Cuộc gọi', 'Cuộc gọi video') : CALL_LABEL[kind];
  const label = call.video && isUnansweredTelegramCall(kind) ? `${base} (video)` : base;
  const duration = Number(call.duration) > 0 ? formatTelegramCallDuration(call.duration) : '';
  const detail = duration || (call.reason === 'disconnect' ? tr('Mất kết nối') : call.reason === 'conference' ? tr('Chuyển sang gọi nhóm') : '');
  return { kind, label, detail };
}

/** Preview line (conversation list, notifications): "📞 Cuộc gọi đến · 2 phút" (Incoming call · 2 min), "📵 Gọi nhỡ" (Missed call). */
export function telegramCallPreview(call: TelegramCallInfo): string {
  const { kind, label, detail } = describeTelegramCall(call);
  return `${kind === 'missed' ? '📵' : '📞'} ${label}${detail ? ` · ${detail}` : ''}`;
}

/**
 * A call message saved to the 1-1 conversation: same format as the Zalo call card (msg_type chat.recommended, action
 * recommened.calltime / recommened.misscall, so the chat window's CallBubble can draw it right away), with Telegram-style labels so that
 * the preview line is accurate (cancelled / line busy / declined).
 * The `reason` code as used by CallBubble: 2 = declined, 4 = caller cancelled.
 */
export function telegramCallCardContent(call: TelegramCallInfo): string {
  const { kind, label, detail } = describeTelegramCall(call);
  const answered = kind === 'outgoing' || kind === 'incoming';
  const reason = kind === 'cancelled' ? 4 : kind === 'declined' || kind === 'busy' ? 2 : 0;
  return JSON.stringify({
    action: answered ? 'recommened.calltime' : 'recommened.misscall',
    params: {
      duration: Math.max(0, Math.floor(Number(call.duration) || 0)),
      reason,
      isCaller: call.out ? 1 : 0,
      calltype: call.video ? 1 : 0,
      source: 'telegram',
      kind,
      label,
      detail,
    },
  });
}

/** The reverse of telegramCallCardContent for the preview line: null if it is not a Telegram call card. */
export function telegramCallPreviewFromContent(content: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(String(content || ''));
    const params = parsed?.params;
    if (params?.source !== 'telegram' || !params?.label) return null;
    return `${params.kind === 'missed' ? '📵' : '📞'} ${params.label}${params.detail ? ` · ${params.detail}` : ''}`;
  } catch {
    return null;
  }
}

// ─── Access status (UserStatus) ────────────────────────────────────────

export type TelegramPresence =
  | { kind: 'online'; expires?: number }
  | { kind: 'offline'; wasOnline: number }
  | { kind: 'recently' }
  | { kind: 'lastWeek' }
  | { kind: 'lastMonth' }
  | { kind: 'unknown' };

/** GramJS UserStatus* → plain status (the main process sends it to the renderer). Times in ms. */
export function telegramPresenceOf(status: any): TelegramPresence {
  switch (status?.className) {
    case 'UserStatusOnline': return { kind: 'online', expires: Number(status.expires || 0) * 1000 || undefined };
    case 'UserStatusOffline': return { kind: 'offline', wasOnline: Number(status.wasOnline || 0) * 1000 };
    case 'UserStatusRecently': return { kind: 'recently' };
    case 'UserStatusLastWeek': return { kind: 'lastWeek' };
    case 'UserStatusLastMonth': return { kind: 'lastMonth' };
    default: return { kind: 'unknown' };
  }
}

/** "trực tuyến", "truy cập 14:05", "truy cập hôm qua 21:30", "truy cập 03/10", "truy cập gần đây"… */
export function describeTelegramPresence(presence: TelegramPresence, now: number = Date.now()): string {
  switch (presence.kind) {
    case 'online':
      return presence.expires && presence.expires < now ? tr('truy cập gần đây') : 'trực tuyến';
    case 'offline': return describeLastSeen(presence.wasOnline, now);
    case 'recently': return tr('truy cập gần đây');
    case 'lastWeek': return tr('truy cập trong tuần');
    case 'lastMonth': return tr('truy cập trong tháng');
    default: return tr('truy cập đã lâu');
  }
}

/**
 * Contact list sort key (higher → comes first) like Telegram: online right now, then by most recent last-seen time; hidden status
 * is mapped to a time mark ("gần đây" (recently) ≈ 3 days, "trong tuần" (within the week) ≈ 7, "trong tháng" (within the month) ≈ 30) so it sorts with the rest.
 */
export function telegramPresenceRank(presence: TelegramPresence, now: number = Date.now()): number {
  const DAY = 86400000;
  switch (presence.kind) {
    case 'online': return presence.expires && presence.expires < now ? now - 1 : now + 1;
    case 'offline': return presence.wasOnline || 1;
    case 'recently': return now - 3 * DAY;
    case 'lastWeek': return now - 7 * DAY;
    case 'lastMonth': return now - 30 * DAY;
    default: return 0;
  }
}

// ─── Results of Telegram actions (main ↔ renderer) ─────────────────────────

export interface TelegramMissingInvitee {
  userId: string;
  name: string;
  /** This account needs Telegram Premium to add this person. */
  premiumWouldAllowInvite?: boolean;
  /** This person only accepts direct messages from Premium accounts (an invite link cannot be sent). */
  premiumRequiredForPm?: boolean;
  /** Error when adding this person alone (e.g. already in too many groups). Not set = due to their privacy settings. */
  error?: string;
}

export interface TelegramCreateChannelResult {
  success: boolean;
  chatId?: string;
  title?: string;
  username?: string;
  usernameError?: string;
  inviteLink?: string;
  invited?: number;
  missingInvitees?: TelegramMissingInvitee[];
  photoError?: string;
  inviteError?: string;
  error?: string;
}

export interface TelegramChatSettings {
  peerType: TelegramPeerType;
  title: string;
  about: string;
  /** Public link name ('' = private). */
  username: string;
  /** Main invite link (only admins with invite permission can see it). */
  inviteLink: string;
  membersCount: number;
  isCreator: boolean;
  isAdmin: boolean;
  canChangeInfo: boolean;
  canInviteUsers: boolean;
  canSetUsername: boolean;
  canDelete: boolean;
  /** Channel: show the poster's name under posts. */
  signatures: boolean;
  /** Channel → discussion group; supergroup → the linked channel. */
  linkedChat: { id: string; title: string } | null;
  /** Auto-delete messages after N seconds (0 = off). */
  ttlPeriod: number;
  /** Joining through the link needs admin approval. */
  joinRequest: boolean;
}

export interface TelegramContactItem {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
  avatar: string;
  /** The two sides have saved each other's number. */
  mutual: boolean;
  presence: TelegramPresence;
  /** A conversation already exists in Deplao. */
  hasChat: boolean;
  bot: boolean;
}

export interface TelegramCallHistoryItem {
  msgId: string;
  userId: string;
  name: string;
  avatar: string;
  /** ms */
  date: number;
  out: boolean;
  reason: TelegramCallReason;
  duration: number;
  video: boolean;
}
