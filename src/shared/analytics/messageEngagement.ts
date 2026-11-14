/**
 * Effectiveness of the messages I SEND: Sent → Delivered → Read → Replied. Shared by main (DatabaseService: CRM campaigns, Reports → Messages / Campaigns / Workflow) and the renderer (filtering the contacts of a campaign, merging reports of several accounts).
 *
 * No new send status is added (crm_campaign_contacts.status keeps pending / sent / failed). Every metric is computed at read time from existing data, compared with the ANCHOR = the time of the first message I sent to that person in the send being checked (the campaign's message; the first message in the report range; the message sent by the workflow):
 *  - Delivered: the conversation's delivered mark contacts.peer_delivered_ts ≥ anchor. Only Zalo and Facebook report "đã nhận"; Telegram has no such concept, so it is not counted (deliveredBase = 0, the UI shows a dash).
 *  - Read: contacts.peer_read_ts ≥ anchor (Zalo, Facebook, personal Telegram) OR replied.
 *  - Replied: the recipient has a REAL message that arrives AFTER the anchor (at any time, even after the report range). System messages, OA broadcasts, Page template messages and deleted messages are not counted (REPLY_STATE_IGNORED_MSG_TYPES, like the "đã trả lời" (replied) state).
 * Same rule as the ✓✓ marks in the chat frame (ui/lib/chat/messages/messageStatus.ts): replied ⇒ read ⇒ delivered.
 *
 * Limits (the UI shows a note): the delivered / read marks are only recorded while Deplao is open when the platform reports them (services/receipts/peerReceipts.ts). Zalo only reports "đã xem" when the recipient (and my account) turn on "Hiện trạng thái Đã xem", so on Zalo most "đã xem" comes from the customer replying. The mark belongs to the whole conversation, so "đã xem" means read up to (at least) that message, as of when the report is viewed.
 */
import { REPLY_STATE_IGNORED_MSG_TYPES } from '../chat/replyState';

export interface EngagementSupport {
  /** Platforms that report "đã nhận" (delivered): Zalo, Facebook. */
  delivered: boolean;
  /** Platforms that report "đã xem" (read): Zalo, Facebook, personal Telegram. Without it, read = replied. */
  seen: boolean;
}

/** What each channel reports (same table as receiptSupport of the chat frame). */
export function engagementSupport(channel: string | null | undefined): EngagementSupport {
  const ch = String(channel || 'zalo');
  if (ch === 'zalo' || ch === 'facebook') return { delivered: true, seen: true };
  if (ch === 'telegram_user') return { delivered: false, seen: true };
  return { delivered: false, seen: false };
}

/** List of message types that do not count as "phản hồi" (replied), in SQL form: ('system', 'chat.webcontent', …). */
export const ENGAGEMENT_IGNORED_TYPES_SQL = `(${REPLY_STATE_IGNORED_MSG_TYPES.map((type) => `'${type}'`).join(', ')})`;

/**
 * Campaign: the campaign's message is the earliest message I sent within [sent_at − LOOKBACK, sent_at + LOOKAHEAD] (sent_at is recorded AFTER every step
 * finishes, in local machine time; message times use the platform server's clock, so they differ by a few seconds). If no message is found on the machine (e.g.
 * a campaign that only sends friend requests) → anchor = sent_at − CLOCK_SKEW.
 */
export const CAMPAIGN_ANCHOR_LOOKBACK_MS = 5 * 60_000;
export const CAMPAIGN_ANCHOR_LOOKAHEAD_MS = 60_000;
export const ENGAGEMENT_CLOCK_SKEW_MS = 60_000;

/** Read signals from the DB for one recipient (ms; 0 = none). */
export interface EngagementSignals {
  anchorTs: number;
  deliveredTs: number;
  readTs: number;
  /** The recipient's first real message after the anchor. */
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
 * Counter (can be summed across campaigns / accounts). `deliveredBase`: the number of recipients on channels that report "đã nhận" (delivered), the denominator of the delivered rate (0 → no data, shown as "-").
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

/** Add one recipient to the counter. */
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

/** Percentage rounded like the other reports; null = no denominator (channel does not report it / nothing sent yet). */
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

/** One sent contact of a campaign (crm:getCampaignEngagement). */
export interface CampaignEngagementItem extends EngagementState {
  contactId: string;
  /** Time of the first reply message (0 = none yet). */
  replyTs: number;
}

export interface CampaignEngagementReport {
  campaignId: number;
  channel: string;
  /** A campaign with a message-sending step (friend request / group invite only: only "đã phản hồi" (replied) is available). */
  sendsMessage: boolean;
  support: EngagementSupport;
  counts: EngagementCounts;
  items: CampaignEngagementItem[];
}

export type CampaignEngagementResponse = ({ success: true } & CampaignEngagementReport) | { success: false; error?: string };

/** Report → Messages: 1:1 recipients in the range (analytics:outreach). */
export interface OutreachStats extends EngagementCounts {
  channel: string;
  support: EngagementSupport;
  timeline: Array<EngagementCounts & { bucket: string }>;
}

/** Contact filter by effectiveness (only contacts that were sent to). */
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

/** Whether the campaign has a message-sending step (friend request / group invite only: there is no message to view / reply to). */
export function campaignSendsMessage(campaignType: string | null | undefined, mixedConfig: string | null | undefined): boolean {
  const type = String(campaignType || 'message');
  if (type === 'friend_request' || type === 'invite_to_group') return false;
  if (type !== 'mixed') return true;
  try {
    const actions = JSON.parse(mixedConfig || '{}')?.actions;
    // Legacy mixed kind (no actions): send a message, send a friend request only when the recipient blocks strangers
    if (!Array.isArray(actions) || actions.length === 0) return true;
    return actions.includes('message');
  } catch {
    return true;
  }
}
