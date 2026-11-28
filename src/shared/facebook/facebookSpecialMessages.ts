/**
 * Facebook message kinds that have no media of their own: locations, link previews, call logs, polls and @mentions.
 * Pure helpers shared by the main process (saving) and the renderer (drawing / voting). Locations and link previews are
 * stored as `fb.template` cards (one drawing path); call logs as the `chat.recommended` call card the other channels use;
 * polls as `fb.poll` with a `poll` attachment.
 */
import { tr } from '../i18n';
import { templateFromBridgeAttachment, type FbTemplate } from './facebookTemplate';

export const FB_POLL_MSG_TYPE = 'fb.poll';
/** Call log card (same message type and content as Zalo / Telegram call cards). */
export const FB_CALL_MSG_TYPE = 'chat.recommended';
/** Attachment entry of an @mention inside a text message. */
export const FB_MENTION_ATTACHMENT = 'fb_mention';

const finite = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Google Maps link for a coordinate pair, '' when the pair is not valid. */
export function mapsUrl(latitude: unknown, longitude: unknown): string {
  const lat = finite(latitude);
  const lng = finite(longitude);
  if (lat === null || lng === null || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** Bridge `location` attachment (static or live) as a card: place name, address, map image, link to Google Maps. */
export function templateFromLocation(att: any): FbTemplate | null {
  if (!att || typeof att !== 'object') return null;
  const url = mapsUrl(att.latitude, att.longitude);
  const title = String(att.title ?? att.fileName ?? att.name ?? '').trim();
  const address = String(att.subtitle ?? att.description ?? '').trim();
  const card = templateFromBridgeAttachment({
    title: title || (att.live ? tr('Đang chia sẻ vị trí trực tiếp') : tr('Vị trí')),
    subtitle: address || (url ? `${finite(att.latitude)?.toFixed(5)}, ${finite(att.longitude)?.toFixed(5)}` : ''),
    previewUrl: att.previewUrl,
    imageUrl: att.imageUrl,
    url,
    sourceText: url ? 'Google Maps' : '',
  });
  return card;
}

/**
 * A bridge attachment that has no media of its own becomes a card: `location` (coordinates kept as a Maps link), `link`
 * (title, description, image, source) and cards carrying a shared reel / video (`playableUrl`). Other attachments are
 * returned unchanged (null = drop).
 */
export function normalizeBridgeAttachment(att: any): any {
  if (!att || typeof att !== 'object') return att;
  const type = String(att.type || att.attachmentType || '');
  if (type === 'location') {
    const card = templateFromLocation(att);
    return card ? { ...card } : att;
  }
  if (type === 'link') {
    const card = templateFromBridgeAttachment(att);
    // A bare URL without any preview stays a link: the URL is the message text.
    if (card && (card.title || card.subtitle || card.imageUrl)) return { ...card };
    return att;
  }
  return att;
}

/** "1:23", "01:02:03", "2 phút", "45 giây", "3 mins" → seconds (0 when the text has no duration). */
export function parseCallDuration(text: unknown): number {
  const s = String(text ?? '').toLowerCase();
  const clock = s.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (clock) return (Number(clock[1] || 0) * 3600) + Number(clock[2]) * 60 + Number(clock[3]);
  let total = 0;
  const hours = s.match(/(\d+)\s*(?:giờ|hrs?|hours?)/);
  const minutes = s.match(/(\d+)\s*(?:phút|mins?|minutes?)/);
  const seconds = s.match(/(\d+)\s*(?:giây|secs?|seconds?)/);
  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (seconds) total += Number(seconds[1]);
  return total;
}

/**
 * Content of a call card (`chat.recommended`, read by the shared CallBubble and the list preview):
 * missed → recommened.misscall, otherwise recommened.calltime with the length in seconds.
 */
export function callLogContent(input: { missed?: boolean; video?: boolean; durationSec?: number; isCaller?: boolean }): string {
  return JSON.stringify({
    action: input.missed ? 'recommened.misscall' : 'recommened.calltime',
    params: {
      duration: Math.max(0, Math.round(Number(input.durationSec) || 0)),
      calltype: input.video ? 1 : 0,
      isCaller: input.isCaller ? 1 : 0,
      reason: 0,
    },
  });
}

/** Call log XMA of a LightSpeed message (bridge attachment type "call"). */
export function callLogFromAttachment(att: any): { missed: boolean; video: boolean; durationSec: number } | null {
  if (!att || typeof att !== 'object' || String(att.type || '') !== 'call') return null;
  const kind = String(att.xmaType || '');
  return {
    missed: att.missed === true || kind.includes('_missed_'),
    video: att.callType === 'video' || kind.includes('video'),
    durationSec: parseCallDuration(`${att.subtitle || ''} ${att.title || ''}`),
  };
}

// ── Polls ────────────────────────────────────────────────────────────────────

export interface FbPollOption {
  id: string;
  text: string;
  /** People who chose this option (as far as Deplao has seen the votes). */
  voter_ids: string[];
  voters: number;
  chosen?: boolean;
}

export interface FbPollAttachment {
  type: 'poll';
  poll_id: string;
  question: string;
  options: FbPollOption[];
  total_voters: number;
  /** Messenger polls allow several choices. */
  multiple_choice: true;
}

/** Poll data sent by the bridge with the admin message that created / changed a poll (bridge PollInfo). */
export interface BridgePollInfo {
  pollId: string;
  eventType: number;
  question?: string;
  options?: Array<{ id: string; text: string }>;
  optionsComplete?: boolean;
  votes?: Array<{ optionId: string; voterId: string; voteCount?: number }>;
  removals?: Array<{ optionId: string; voterId: string }>;
}

export const POLL_EVENT_CREATE = 1;

const uniqueStrings = (list: unknown): string[] =>
  Array.from(new Set((Array.isArray(list) ? list : []).map(v => String(v ?? '').trim()).filter(Boolean)));

function countVoters(options: FbPollOption[]): number {
  return new Set(options.flatMap(o => o.voter_ids)).size;
}

/** Poll attachment for a newly created poll (votes the creation message already carries are applied). */
export function pollAttachmentFromBridge(poll: BridgePollInfo | null | undefined, ownId: string): FbPollAttachment | null {
  if (!poll?.pollId || !Array.isArray(poll.options) || poll.options.length === 0) return null;
  const options: FbPollOption[] = poll.options
    .map(o => ({ id: String(o?.id ?? ''), text: String(o?.text ?? '').trim(), voter_ids: [] as string[], voters: 0 }))
    .filter(o => o.id && o.text);
  if (!options.length) return null;
  const base: FbPollAttachment = {
    type: 'poll',
    poll_id: String(poll.pollId),
    question: String(poll.question || '').trim() || tr('Bình chọn'),
    options,
    total_voters: 0,
    multiple_choice: true,
  };
  return applyPollVotes(base, poll, ownId);
}

/** Applies the votes / removals of a poll event to a stored poll attachment; new options are added. */
export function applyPollVotes(stored: FbPollAttachment, poll: BridgePollInfo, ownId: string): FbPollAttachment {
  const options = stored.options.map(o => ({ ...o, voter_ids: [...o.voter_ids] }));
  for (const option of poll.options || []) {
    const id = String(option?.id ?? '');
    const text = String(option?.text ?? '').trim();
    if (id && text && !options.some(o => o.id === id)) options.push({ id, text, voter_ids: [], voters: 0 });
  }
  for (const removal of poll.removals || []) {
    const option = options.find(o => o.id === String(removal.optionId));
    if (option) option.voter_ids = option.voter_ids.filter(v => v !== String(removal.voterId));
  }
  for (const vote of poll.votes || []) {
    const option = options.find(o => o.id === String(vote.optionId));
    const voter = String(vote.voterId || '');
    if (option && voter && !option.voter_ids.includes(voter)) option.voter_ids.push(voter);
  }
  const own = String(ownId || '');
  for (const option of options) {
    option.voter_ids = uniqueStrings(option.voter_ids);
    option.voters = option.voter_ids.length;
    option.chosen = !!own && option.voter_ids.includes(own);
  }
  return { ...stored, options, total_voters: countVoters(options) };
}

/** The account's own choice changed in Deplao (optimistic update before Messenger confirms). */
export function withOwnPollChoice(stored: FbPollAttachment, optionIds: string[], ownId: string): FbPollAttachment {
  const chosen = new Set(optionIds.map(String));
  const own = String(ownId || '');
  const options = stored.options.map(o => {
    const others = o.voter_ids.filter(v => v !== own);
    const voter_ids = chosen.has(o.id) && own ? [...others, own] : others;
    return { ...o, voter_ids, voters: voter_ids.length, chosen: chosen.has(o.id) };
  });
  return { ...stored, options, total_voters: countVoters(options) };
}

/** First poll attachment of a stored `attachments` column (JSON or array). */
export function fbPollFromAttachments(raw: unknown): FbPollAttachment | null {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw || '[]'); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const found = list.find((a: any) => a && typeof a === 'object' && a.type === 'poll' && a.poll_id);
  return found ? (found as FbPollAttachment) : null;
}

/**
 * A poll's vote line ("… đã bình chọn cho …"): the admin line remembers which poll it changed, so the newest line of each
 * poll can show the poll card again (like Messenger, which shows the updated poll under its update lines).
 */
export interface FbPollUpdateRef {
  type: 'poll_update';
  poll_id: string;
  /** msg_id of the stored poll card (the creation message). */
  poll_msg_id: string;
}

export function pollUpdateAttachment(pollId: string, pollMsgId: string): FbPollUpdateRef {
  return { type: 'poll_update', poll_id: String(pollId), poll_msg_id: String(pollMsgId) };
}

/** Poll link of a stored vote line (`attachments` JSON or array), null for any other line. */
export function fbPollUpdateFromAttachments(raw: unknown): FbPollUpdateRef | null {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.includes('poll_update')) return null;
    try { list = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const found = list.find((a: any) => a && typeof a === 'object' && a.type === 'poll_update' && a.poll_msg_id);
  return found ? pollUpdateAttachment(String((found as any).poll_id || ''), String((found as any).poll_msg_id)) : null;
}

/** Text of a poll for the conversation list, search and notifications. */
export function fbPollText(poll: FbPollAttachment | null | undefined): string {
  if (!poll) return tr('📊 Bình chọn');
  return tr('📊 Bình chọn: {{question}}', { question: poll.question });
}

// ── Mentions ────────────────────────────────────────────────────────────────

/** Bridge mentions ({ userId, offset, length }) as attachment entries of a text message. */
export function mentionAttachments(mentions: unknown): Array<{ type: string; offset: number; length: number; user_id: string }> {
  if (!Array.isArray(mentions)) return [];
  const out: Array<{ type: string; offset: number; length: number; user_id: string }> = [];
  for (const m of mentions) {
    const userId = String(m?.userId ?? m?.user_id ?? m?.id ?? '').replace(/@.*$/, '');
    const offset = Number(m?.offset);
    const length = Number(m?.length);
    if (!/^\d+$/.test(userId) || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) continue;
    out.push({ type: FB_MENTION_ATTACHMENT, offset, length, user_id: userId });
  }
  return out;
}
