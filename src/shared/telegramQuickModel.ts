/**
 * Telegram "Nhóm mới / Kênh mới / Danh bạ / Cuộc gọi" (thao tác nhanh) — quy tắc thuần dùng chung main + renderer:
 * kiểm tra tên link công khai, nhãn lịch sử cuộc gọi, trạng thái truy cập của liên hệ, tự xoá tin nhắn.
 * Test: src/__tests__/telegramQuickModel.test.ts
 */
import type { TelegramPeerType } from '../models/telegram';

// ─── Link công khai t.me/<tên> (kênh / siêu nhóm) ────────────────────────────

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
 * Quy tắc tên công khai của Telegram (giống kiểm tra phía ứng dụng chính thức, máy chủ vẫn là nơi quyết định
 * cuối cùng qua channels.checkUsername): 5–32 ký tự a–z, 0–9, "_"; bắt đầu bằng chữ cái; không kết thúc bằng "_";
 * không có 2 dấu "_" liền nhau.
 */
export function validateTelegramUsername(input: string): TelegramUsernameCheck {
  const username = normalizeTelegramUsernameInput(input);
  if (!username) return { ok: false, error: 'Nhập tên cho link công khai' };
  if (/[^a-zA-Z0-9_]/.test(username)) return { ok: false, error: 'Chỉ dùng chữ a–z, số 0–9 và dấu gạch dưới (_)' };
  if (!/^[a-zA-Z]/.test(username)) return { ok: false, error: 'Tên phải bắt đầu bằng chữ cái' };
  if (username.length < TELEGRAM_USERNAME_MIN) return { ok: false, error: `Tên cần ít nhất ${TELEGRAM_USERNAME_MIN} ký tự` };
  if (username.length > TELEGRAM_USERNAME_MAX) return { ok: false, error: `Tên tối đa ${TELEGRAM_USERNAME_MAX} ký tự` };
  if (username.endsWith('_')) return { ok: false, error: 'Tên không được kết thúc bằng dấu gạch dưới' };
  if (username.includes('__')) return { ok: false, error: 'Không dùng 2 dấu gạch dưới liền nhau' };
  return { ok: true, username };
}

/** Lỗi RPC khi kiểm tra / đặt tên công khai → câu dễ hiểu. */
export function telegramUsernameError(raw: string): string {
  const message = String(raw || '');
  if (message.includes('USERNAME_OCCUPIED')) return 'Tên này đã có người dùng';
  if (message.includes('USERNAME_PURCHASE_AVAILABLE')) return 'Tên này đang được bán trên fragment.com — chọn tên khác';
  if (message.includes('USERNAME_INVALID')) return 'Tên không hợp lệ';
  if (message.includes('CHANNELS_ADMIN_PUBLIC_TOO_MUCH')) return 'Tài khoản đang quản lý quá nhiều kênh / nhóm công khai — chuyển bớt sang riêng tư';
  if (message.includes('USERNAME_NOT_MODIFIED')) return 'Kênh đang dùng đúng tên này';
  if (message.includes('CHAT_ADMIN_REQUIRED')) return 'Cần quyền quản trị để đổi link';
  return message || 'Không kiểm tra được tên';
}

// ─── Tự xoá tin nhắn (ttl_period) ────────────────────────────────────────────

export const TELEGRAM_TTL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Tắt' },
  { value: 86400, label: 'Sau 1 ngày' },
  { value: 7 * 86400, label: 'Sau 1 tuần' },
  { value: 31 * 86400, label: 'Sau 1 tháng' },
];

/** Máy chủ chỉ nhận bội số của 1 ngày, tối đa 1 năm; giá trị khác → tắt. */
export function normalizeTelegramTtl(value: unknown): number {
  const seconds = Math.floor(Number(value) || 0);
  if (seconds <= 0 || seconds % 86400 !== 0 || seconds > 365 * 86400) return 0;
  return seconds;
}

// ─── Lịch sử cuộc gọi (messageActionPhoneCall) ───────────────────────────────

export type TelegramCallReason = 'missed' | 'busy' | 'hangup' | 'disconnect' | 'conference' | null;
export type TelegramCallKind = 'outgoing' | 'cancelled' | 'busy' | 'incoming' | 'missed' | 'declined';

export interface TelegramCallInfo {
  /** Mình gọi đi. */
  out: boolean;
  reason: TelegramCallReason;
  /** Giây; chỉ có khi cuộc gọi đã kết nối. */
  duration?: number | null;
  video?: boolean;
}

/** Tên lớp GramJS của PhoneCallDiscardReason → lý do. */
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
 * Như Telegram: gọi đi bị nhỡ = "Đã huỷ" (mình huỷ / không ai nghe); gọi đến bị nhỡ = "Gọi nhỡ"; gọi đến lý do bận =
 * mình đã từ chối; gọi đi lý do bận = bên kia từ chối hoặc đang bận cuộc gọi khác.
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
  cancelled: 'Đã huỷ',
  busy: 'Máy bận',
  incoming: 'Cuộc gọi đến',
  missed: 'Gọi nhỡ',
  declined: 'Đã từ chối',
};

/** Cuộc gọi không kết nối được (hiện màu đỏ trong lịch sử, đếm vào "Gọi nhỡ"). */
export function isUnansweredTelegramCall(kind: TelegramCallKind): boolean {
  return kind === 'missed' || kind === 'declined' || kind === 'cancelled' || kind === 'busy';
}

/** 42 → "42 giây", 300 → "5 phút", 3725 → "1 giờ 2 phút". */
export function formatTelegramCallDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} giây`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  return `${minutes} phút`;
}

export function describeTelegramCall(call: TelegramCallInfo): { kind: TelegramCallKind; label: string; detail: string } {
  const kind = telegramCallKind(call);
  const base = call.video ? CALL_LABEL[kind].replace('Cuộc gọi', 'Cuộc gọi video') : CALL_LABEL[kind];
  const label = call.video && isUnansweredTelegramCall(kind) ? `${base} (video)` : base;
  const duration = Number(call.duration) > 0 ? formatTelegramCallDuration(call.duration) : '';
  const detail = duration || (call.reason === 'disconnect' ? 'Mất kết nối' : call.reason === 'conference' ? 'Chuyển sang gọi nhóm' : '');
  return { kind, label, detail };
}

/** Dòng xem trước (danh sách hội thoại, thông báo): "📞 Cuộc gọi đến · 2 phút", "📵 Gọi nhỡ". */
export function telegramCallPreview(call: TelegramCallInfo): string {
  const { kind, label, detail } = describeTelegramCall(call);
  return `${kind === 'missed' ? '📵' : '📞'} ${label}${detail ? ` · ${detail}` : ''}`;
}

/**
 * Tin "cuộc gọi" lưu vào hội thoại 1-1: cùng định dạng thẻ cuộc gọi Zalo (msg_type chat.recommended, action
 * recommened.calltime / recommened.misscall — CallBubble của khung chat vẽ được ngay), kèm nhãn kiểu Telegram để
 * dòng xem trước đúng nghĩa (đã huỷ / máy bận / đã từ chối).
 * Mã `reason` theo CallBubble: 2 = từ chối, 4 = người gọi huỷ.
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

/** Ngược lại của telegramCallCardContent cho dòng xem trước: null nếu không phải thẻ cuộc gọi Telegram. */
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

// ─── Trạng thái truy cập (UserStatus) ────────────────────────────────────────

export type TelegramPresence =
  | { kind: 'online'; expires?: number }
  | { kind: 'offline'; wasOnline: number }
  | { kind: 'recently' }
  | { kind: 'lastWeek' }
  | { kind: 'lastMonth' }
  | { kind: 'unknown' };

/** GramJS UserStatus* → trạng thái thuần (main process gửi sang renderer). Thời gian tính bằng ms. */
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

const pad2 = (value: number) => String(value).padStart(2, '0');

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "trực tuyến", "truy cập 14:05", "truy cập hôm qua 21:30", "truy cập 03/10", "truy cập gần đây"… */
export function describeTelegramPresence(presence: TelegramPresence, now: number = Date.now()): string {
  switch (presence.kind) {
    case 'online':
      return presence.expires && presence.expires < now ? 'truy cập gần đây' : 'trực tuyến';
    case 'offline': {
      if (!presence.wasOnline) return 'truy cập đã lâu';
      const d = new Date(presence.wasOnline);
      const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      const today = startOfDay(now);
      if (presence.wasOnline >= today) return `truy cập ${time}`;
      if (presence.wasOnline >= today - 86400000) return `truy cập hôm qua ${time}`;
      return `truy cập ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}${d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : ''}`;
    }
    case 'recently': return 'truy cập gần đây';
    case 'lastWeek': return 'truy cập trong tuần';
    case 'lastMonth': return 'truy cập trong tháng';
    default: return 'truy cập đã lâu';
  }
}

/**
 * Khoá sắp xếp danh bạ (lớn → đứng trước) như Telegram: đang trực tuyến, rồi theo lần truy cập gần nhất; trạng thái
 * bị ẩn được quy ước ra mốc thời gian ("gần đây" ≈ 3 ngày, "trong tuần" ≈ 7, "trong tháng" ≈ 30) để xếp chung.
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

// ─── Kết quả các thao tác Telegram (main ↔ renderer) ─────────────────────────

export interface TelegramMissingInvitee {
  userId: string;
  name: string;
  /** Tài khoản cần Telegram Premium mới thêm được người này. */
  premiumWouldAllowInvite?: boolean;
  /** Người này chỉ nhận tin nhắn riêng từ tài khoản Premium (không gửi link mời được). */
  premiumRequiredForPm?: boolean;
  /** Lỗi khi thêm riêng người này (vd. đã ở quá nhiều nhóm). Không có = do cài đặt riêng tư. */
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
  /** Tên link công khai ('' = riêng tư). */
  username: string;
  /** Link mời chính (chỉ quản trị viên có quyền mời mới thấy). */
  inviteLink: string;
  membersCount: number;
  isCreator: boolean;
  isAdmin: boolean;
  canChangeInfo: boolean;
  canInviteUsers: boolean;
  canSetUsername: boolean;
  canDelete: boolean;
  /** Kênh: ghi tên người đăng dưới bài. */
  signatures: boolean;
  /** Kênh → nhóm thảo luận; siêu nhóm → kênh được liên kết. */
  linkedChat: { id: string; title: string } | null;
  /** Tự xoá tin nhắn sau N giây (0 = tắt). */
  ttlPeriod: number;
  /** Tham gia qua link cần quản trị viên duyệt. */
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
  /** Hai bên đã lưu số của nhau. */
  mutual: boolean;
  presence: TelegramPresence;
  /** Đã có hội thoại trong Deplao. */
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
