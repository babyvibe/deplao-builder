/**
 * Hiệu quả tin MÌNH gửi đi: Đã gửi → Đã nhận → Đã xem → Đã phản hồi. Dùng chung main (DatabaseService: chiến dịch CRM,
 * Báo cáo → Tin nhắn / Chiến dịch / Workflow) và renderer (lọc liên hệ của chiến dịch, gộp báo cáo nhiều tài khoản).
 *
 * Không thêm trạng thái gửi mới (crm_campaign_contacts.status giữ pending / sent / failed): mọi chỉ số tính lúc đọc từ dữ
 * liệu sẵn có, so với MỐC (anchor) = thời điểm tin đầu tiên mình gửi cho người đó trong lần gửi đang xét (tin của chiến
 * dịch; tin đầu tiên trong khoảng báo cáo; tin workflow gửi):
 *  - Đã nhận: mốc đã nhận của hội thoại contacts.peer_delivered_ts ≥ anchor. Chỉ Zalo, Facebook báo "đã nhận"; Telegram
 *    không có khái niệm này → không tính (deliveredBase = 0, giao diện hiện "—").
 *  - Đã xem: contacts.peer_read_ts ≥ anchor (Zalo, Facebook, Telegram cá nhân) HOẶC đã phản hồi.
 *  - Đã phản hồi: người nhận có tin THẬT đến SAU anchor (lúc nào cũng được, kể cả sau khoảng báo cáo); tin hệ thống, bản
 *    tin OA, tin mẫu của Trang, tin đã xoá không tính (REPLY_STATE_IGNORED_MSG_TYPES, như trạng thái "đã trả lời").
 * Quy tắc như dấu ✓✓ trong khung chat (ui/lib/chat/messages/messageStatus.ts): đã phản hồi ⇒ đã xem ⇒ đã nhận.
 *
 * Giới hạn (giao diện có ghi chú): mốc đã nhận / đã xem chỉ được ghi khi Deplao đang mở lúc nền tảng báo
 * (services/receipts/peerReceipts.ts); Zalo chỉ báo "đã xem" khi người nhận (và tài khoản mình) bật "Hiện trạng thái
 * Đã xem" → với Zalo, "đã xem" phần lớn đến từ việc khách trả lời. Mốc là của cả hội thoại, nên "đã xem" nghĩa là đã xem
 * tới (ít nhất) tin đó, tính tới lúc xem báo cáo.
 */
import { REPLY_STATE_IGNORED_MSG_TYPES } from '../chat/replyState';

export interface EngagementSupport {
  /** Nền tảng báo "đã nhận" (Zalo, Facebook). */
  delivered: boolean;
  /** Nền tảng báo "đã xem" (Zalo, Facebook, Telegram cá nhân). Không có thì đã xem = đã phản hồi. */
  seen: boolean;
}

/** Kênh báo được gì (cùng bảng với receiptSupport của khung chat). */
export function engagementSupport(channel: string | null | undefined): EngagementSupport {
  const ch = String(channel || 'zalo');
  if (ch === 'zalo' || ch === 'facebook') return { delivered: true, seen: true };
  if (ch === 'telegram_user') return { delivered: false, seen: true };
  return { delivered: false, seen: false };
}

/** Danh sách loại tin không tính là "phản hồi", dạng SQL: ('system', 'chat.webcontent', …). */
export const ENGAGEMENT_IGNORED_TYPES_SQL = `(${REPLY_STATE_IGNORED_MSG_TYPES.map((type) => `'${type}'`).join(', ')})`;

/**
 * Chiến dịch: tin của chiến dịch là tin mình gửi sớm nhất trong [sent_at − LOOKBACK, sent_at + LOOKAHEAD] (sent_at ghi
 * SAU khi gửi xong mọi bước, giờ máy; giờ tin là giờ máy chủ nền tảng nên lệch vài giây). Không thấy tin trong máy (vd
 * chiến dịch chỉ kết bạn) → anchor = sent_at − CLOCK_SKEW.
 */
export const CAMPAIGN_ANCHOR_LOOKBACK_MS = 5 * 60_000;
export const CAMPAIGN_ANCHOR_LOOKAHEAD_MS = 60_000;
export const ENGAGEMENT_CLOCK_SKEW_MS = 60_000;

/** Tín hiệu đọc từ DB cho một người nhận (ms; 0 = không có). */
export interface EngagementSignals {
  anchorTs: number;
  deliveredTs: number;
  readTs: number;
  /** Tin thật đầu tiên của người nhận sau anchor. */
  replyTs: number;
}

export interface EngagementState {
  delivered: boolean;
  seen: boolean;
  replied: boolean;
}

export function engagementState(signals: EngagementSignals, support: EngagementSupport): EngagementState {
  const anchor = Number(signals.anchorTs) || 0;
  const replied = Number(signals.replyTs) > 0;
  const seen = replied || (support.seen && anchor > 0 && Number(signals.readTs) >= anchor);
  const delivered = seen || (support.delivered && anchor > 0 && Number(signals.deliveredTs) >= anchor);
  return { delivered, seen, replied };
}

/**
 * Bộ đếm (cộng được giữa chiến dịch / tài khoản). `deliveredBase`: số người nhận trên kênh có báo "đã nhận" — mẫu số của
 * tỷ lệ đã nhận (0 → không có số liệu, hiện "—").
 */
export interface EngagementCounts {
  sent: number;
  delivered: number;
  deliveredBase: number;
  seen: number;
  replied: number;
}

export function emptyEngagement(): EngagementCounts {
  return { sent: 0, delivered: 0, deliveredBase: 0, seen: 0, replied: 0 };
}

/** Thêm một người nhận vào bộ đếm. */
export function addEngagement(counts: EngagementCounts, state: EngagementState, support: EngagementSupport): EngagementCounts {
  counts.sent += 1;
  if (support.delivered) {
    counts.deliveredBase += 1;
    if (state.delivered) counts.delivered += 1;
  }
  if (state.seen) counts.seen += 1;
  if (state.replied) counts.replied += 1;
  return counts;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function mergeEngagementCounts(list: ReadonlyArray<Partial<EngagementCounts> | null | undefined>): EngagementCounts {
  const out = emptyEngagement();
  for (const item of list) {
    if (!item) continue;
    out.sent += num(item.sent);
    out.delivered += num(item.delivered);
    out.deliveredBase += num(item.deliveredBase);
    out.seen += num(item.seen);
    out.replied += num(item.replied);
  }
  return out;
}

/** % làm tròn như các báo cáo khác; null = không có mẫu số (kênh không báo / chưa gửi). */
export interface EngagementRates {
  deliveredRate: number | null;
  seenRate: number | null;
  repliedRate: number | null;
}

const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

export function engagementRates(counts: Partial<EngagementCounts> | null | undefined): EngagementRates {
  const sent = num(counts?.sent);
  return {
    deliveredRate: rate(num(counts?.delivered), num(counts?.deliveredBase)),
    seenRate: rate(num(counts?.seen), sent),
    repliedRate: rate(num(counts?.replied), sent),
  };
}

/** Một liên hệ đã gửi của chiến dịch (crm:getCampaignEngagement). */
export interface CampaignEngagementItem extends EngagementState {
  contactId: string;
  /** Giờ tin trả lời đầu tiên (0 = chưa). */
  replyTs: number;
}

export interface CampaignEngagementReport {
  campaignId: number;
  channel: string;
  /** Chiến dịch có bước gửi tin (chỉ kết bạn / mời nhóm: chỉ có "đã phản hồi"). */
  sendsMessage: boolean;
  support: EngagementSupport;
  counts: EngagementCounts;
  items: CampaignEngagementItem[];
}

export type CampaignEngagementResponse = ({ success: true } & CampaignEngagementReport) | { success: false; error?: string };

/** Báo cáo → Tin nhắn: người nhận 1:1 trong khoảng (analytics:outreach). */
export interface OutreachStats extends EngagementCounts {
  channel: string;
  support: EngagementSupport;
  timeline: Array<EngagementCounts & { bucket: string }>;
}

/** Bộ lọc liên hệ theo hiệu quả (chỉ liên hệ đã gửi). */
export type EngagementFilter = 'replied' | 'seen_no_reply' | 'not_seen' | 'not_delivered';

export function matchesEngagementFilter(state: EngagementState | null | undefined, filter: EngagementFilter, support: EngagementSupport): boolean {
  if (!state) return false;
  switch (filter) {
    case 'replied': return state.replied;
    case 'seen_no_reply': return state.seen && !state.replied;
    case 'not_seen': return !state.seen;
    case 'not_delivered': return support.delivered && !state.delivered;
    default: return false;
  }
}

/** Chiến dịch có bước gửi tin nhắn không (chỉ kết bạn / mời vào nhóm: không có tin để xem / phản hồi). */
export function campaignSendsMessage(campaignType: string | null | undefined, mixedConfig: string | null | undefined): boolean {
  const type = String(campaignType || 'message');
  if (type === 'friend_request' || type === 'invite_to_group') return false;
  if (type !== 'mixed') return true;
  try {
    const actions = JSON.parse(mixedConfig || '{}')?.actions;
    // Hỗn hợp kiểu cũ (không có actions): gửi tin, chỉ kết bạn khi người nhận chặn người lạ
    if (!Array.isArray(actions) || actions.length === 0) return true;
    return actions.includes('message');
  } catch {
    return true;
  }
}
