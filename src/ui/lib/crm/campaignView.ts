/**
 * Pure helpers for the CRM campaign screens (CampaignList + CampaignDetail).
 *
 * Reads the stored template / mixed config with the same rules as
 * `CRMQueueService` so the screen shows what the queue will actually send.
 * No React, no IPC — covered by `src/__tests__/campaignView.test.ts`.
 */
import { parseMarkup } from '../../../services/crm/message-markup';
import {
  DEFAULT_CAMPAIGN_SEND_OPTIONS,
  planBlockSend,
  readCampaignSendOptions,
  type BlockSendPlan,
  type CampaignSendOptions,
} from '../../../shared/campaignSendPlan';
import { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, effectiveContactDelayRange } from '../../../shared/campaignDelay';
import { partialFailureOf } from '../../../shared/campaignOutcome';

export { partialFailureOf };

export type CampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'done';
export type CampaignContactStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type MixedAction = 'message' | 'friend_request' | 'invite_to_groups';
export type SendMode = 'random' | 'all';
type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'info';

export interface ContentBlock { id: string; text: string; images: string[]; tagAll?: boolean; tagAllText?: string; }
/** `order` / `combine`: how text and images of a block are sent (shared/campaignSendPlan). */
export interface ContentConfig extends CampaignSendOptions { mode: SendMode; blocks: ContentBlock[]; }

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  message: 'Tin nhắn',
  friend_request: 'Kết bạn',
  invite_to_group: 'Mời vào nhóm',
  mixed: 'Hỗn hợp',
};

export const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Nháp', tone: 'default' },
  active: { label: 'Đang chạy', tone: 'success' },
  paused: { label: 'Tạm dừng', tone: 'warning' },
  done: { label: 'Hoàn thành', tone: 'primary' },
};

export const CONTACT_STATUS_META: Record<CampaignContactStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Chờ gửi', tone: 'default' },
  sending: { label: 'Đang gửi', tone: 'info' },
  sent: { label: 'Đã gửi', tone: 'success' },
  failed: { label: 'Lỗi', tone: 'destructive' },
};

/** "Đã gửi" nhưng một số hành động của chiến dịch Hỗn hợp lỗi (shared/campaignOutcome). */
export const CONTACT_PARTIAL_META: { label: string; tone: BadgeTone } = { label: 'Gửi một phần', tone: 'warning' };

export function campaignTypeOf(value: string | null | undefined): CampaignType {
  return value === 'friend_request' || value === 'mixed' || value === 'invite_to_group' ? value : 'message';
}

export function campaignStatusOf(value: string | null | undefined): CampaignStatus {
  return value === 'active' || value === 'paused' || value === 'done' ? value : 'draft';
}

export function contactStatusOf(value: string | null | undefined): CampaignContactStatus {
  return value === 'sending' || value === 'sent' || value === 'failed' ? value : 'pending';
}

// ── Stored config ────────────────────────────────────────────────────────────

/** `template_message`: JSON `{ mode, blocks, order?, combine? }`, or a legacy plain-text template (CRMQueueService.parseContentBlocks). */
export function readContentConfig(raw: string | null | undefined): ContentConfig {
  const source = raw ?? '';
  if (!source.trim()) return { mode: 'random', blocks: [], ...DEFAULT_CAMPAIGN_SEND_OPTIONS };
  try {
    const parsed = JSON.parse(source);
    if (parsed && Array.isArray(parsed.blocks)) {
      return {
        ...readCampaignSendOptions(parsed),
        mode: parsed.mode === 'all' ? 'all' : 'random',
        blocks: parsed.blocks.map((block: any, index: number): ContentBlock => ({
          id: String(block?.id ?? index),
          text: typeof block?.text === 'string' ? block.text : '',
          images: Array.isArray(block?.images)
            ? block.images.filter((path: unknown): path is string => typeof path === 'string' && path.length > 0)
            : [],
          tagAll: !!block?.tagAll,
          tagAllText: typeof block?.tagAllText === 'string' ? block.tagAllText : undefined,
        })),
      };
    }
  } catch { /* legacy plain-text template */ }
  return { mode: 'random', blocks: [{ id: 'legacy', text: source, images: [] }], ...DEFAULT_CAMPAIGN_SEND_OPTIONS };
}

/** Stored template with new send options; every other key of the template is kept as is. */
export function withSendOptions(raw: string | null | undefined, patch: Partial<CampaignSendOptions>): string {
  const source = raw ?? '';
  let parsed: any = null;
  try { parsed = JSON.parse(source); } catch { /* legacy plain-text template */ }
  const base = parsed && Array.isArray(parsed.blocks)
    ? parsed
    : { mode: 'random', blocks: source.trim() ? [{ id: 'legacy', text: source, images: [] }] : [] };
  return JSON.stringify({ ...base, ...patch });
}

/** The send options only matter when a block has both text and images. */
export function hasTextWithImages(content: Pick<ContentConfig, 'blocks'>): boolean {
  return content.blocks.some(block => block.text.trim().length > 0 && block.images.some(Boolean));
}

/** Text as the recipient gets it in a caption: Zalo drops the markup (a photo caption has no styles). */
export function captionText(text: string, channel: string): string {
  return channel === 'zalo' ? parseMarkup(text).text : text;
}

export function hasMarkupStyles(text: string): boolean {
  return parseMarkup(text).styles.length > 0;
}

/** Same decision as the queue (services/crm/campaignBlockSender) for one block. */
export function previewBlockPlan(block: ContentBlock, channel: string, options: CampaignSendOptions): BlockSendPlan {
  return planBlockSend({ text: captionText(block.text, channel), images: block.images, channel, options });
}

export function isEmptyBlock(block: ContentBlock): boolean {
  return !block.text.trim() && block.images.length === 0;
}

const MIXED_ACTIONS: readonly MixedAction[] = ['message', 'friend_request', 'invite_to_groups'];

/**
 * `mixed_config`. `actions: null` = legacy mixed campaign: the queue sends the
 * message and only falls back to a friend request when the recipient blocks strangers.
 */
export function readMixedConfig(raw: string | null | undefined): { actions: MixedAction[] | null; groupIds: string[] } {
  try {
    const parsed = JSON.parse(raw || '{}');
    const groupIds = Array.isArray(parsed?.group_ids) ? parsed.group_ids.map(String).filter(Boolean) : [];
    const actions = Array.isArray(parsed?.actions) && parsed.actions.length > 0
      ? parsed.actions.filter((action: unknown): action is MixedAction => MIXED_ACTIONS.includes(action as MixedAction))
      : null;
    return { actions, groupIds };
  } catch {
    return { actions: null, groupIds: [] };
  }
}

export interface CampaignStep {
  kind: 'message' | 'friend_request' | 'invite';
  /** Legacy mixed: only runs when the message step fails because the recipient blocks strangers. */
  fallback?: boolean;
  /** Invite step without groups — the queue skips it. */
  skipped?: boolean;
}

/** What the queue does for every (personal) contact, in order. */
export function campaignSteps(type: string | null | undefined, mixedRaw: string | null | undefined): CampaignStep[] {
  const campaignType = campaignTypeOf(type);
  if (campaignType === 'friend_request') return [{ kind: 'friend_request' }];
  if (campaignType === 'invite_to_group') {
    return [{ kind: 'invite', skipped: readMixedConfig(mixedRaw).groupIds.length === 0 }];
  }
  if (campaignType === 'mixed') {
    const { actions, groupIds } = readMixedConfig(mixedRaw);
    if (!actions) return [{ kind: 'message' }, { kind: 'friend_request', fallback: true }];
    return actions.map((action): CampaignStep => action === 'invite_to_groups'
      ? { kind: 'invite', skipped: groupIds.length === 0 }
      : { kind: action });
  }
  return [{ kind: 'message' }];
}

// ── Template text ────────────────────────────────────────────────────────────

export type TemplateVariable = 'name' | 'userId';

export interface TemplateSegment {
  text: string;
  variable?: TemplateVariable;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Zalo text colour (the recipient sees this exact colour). */
  color?: string;
  size?: 'big' | 'small';
}

type SegmentStyle = Omit<TemplateSegment, 'text' | 'variable'>;

/** zca-js style codes produced by `parseMarkup` → display flags. */
const STYLE_FLAGS: Record<string, SegmentStyle> = {
  b: { bold: true },
  i: { italic: true },
  u: { underline: true },
  s: { strike: true },
  c_db342e: { color: '#db342e' },
  c_f27806: { color: '#f27806' },
  c_f7b503: { color: '#f7b503' },
  c_15a85f: { color: '#15a85f' },
  f_18: { size: 'big' },
  f_13: { size: 'small' },
};

export const TEMPLATE_VARIABLE_HINT: Record<TemplateVariable, string> = {
  name: 'Tên người nhận',
  userId: 'ID người nhận',
};

const VARIABLE_RE = /\{(name|userId)\}/g;

/**
 * Splits a template into display segments: Zalo markup (`[b]…[/b]`, `[red]…`)
 * becomes style flags (only when `formatting` — Telegram sends brackets literally)
 * and `{name}` / `{userId}` become variable segments.
 */
export function tokenizeTemplate(raw: string | null | undefined, options: { formatting: boolean }): TemplateSegment[] {
  const parsed = options.formatting ? parseMarkup(raw || '') : { text: raw || '', styles: [] };
  const text = parsed.text;
  if (!text) return [];

  const charStyle: SegmentStyle[] = Array.from({ length: text.length }, () => ({}));
  for (const style of parsed.styles) {
    const flags = STYLE_FLAGS[style.st];
    if (!flags) continue;
    const end = Math.min(text.length, style.start + style.len);
    for (let i = Math.max(0, style.start); i < end; i++) Object.assign(charStyle[i], flags);
  }

  const variableAt: Array<TemplateVariable | undefined> = new Array(text.length);
  const variableStart = new Set<number>();
  VARIABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_RE.exec(text)) !== null) {
    variableStart.add(match.index);
    for (let i = match.index; i < match.index + match[0].length; i++) variableAt[i] = match[1] as TemplateVariable;
  }

  const styleKey = (style: SegmentStyle) => JSON.stringify(style);
  const segments: TemplateSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const variable = variableAt[i];
    const key = styleKey(charStyle[i]);
    let j = i + 1;
    while (
      j < text.length
      && !variableStart.has(j)
      && variableAt[j] === variable
      // A variable is one chip even if a markup tag starts or ends inside it.
      && (variable !== undefined || styleKey(charStyle[j]) === key)
    ) j++;
    segments.push({ text: text.slice(i, j), ...charStyle[i], ...(variable ? { variable } : {}) });
    i = j;
  }
  return segments;
}

// ── Numbers / time ───────────────────────────────────────────────────────────

/**
 * Delay between two contacts, with the fallback CampaignList always used for old rows — clamped to the queue's
 * 30-second minimum (shared/campaignDelay) so a stored "5–10 s" shows what is really sent.
 */
export function campaignDelayRange(campaign: { delay_seconds?: number; delay_min_seconds?: number; delay_max_seconds?: number }): [number, number] {
  const base = campaign.delay_seconds || 60;
  const min = campaign.delay_min_seconds || Math.max(CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, base - 10);
  const max = campaign.delay_max_seconds || base + 10;
  return effectiveContactDelayRange(min, max);
}

type DelayUnit = 'giây' | 'phút' | 'giờ';

function delayUnit(seconds: number): DelayUnit {
  if (seconds < 60) return 'giây';
  return seconds < 3600 ? 'phút' : 'giờ';
}

function delayAmount(seconds: number, unit: DelayUnit): string {
  const value = unit === 'giây' ? seconds : unit === 'phút' ? seconds / 60 : seconds / 3600;
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

/** "2 phút", "1,8–2,2 phút", "30–45 giây", "45 giây – 2 phút". */
export function formatDelayRange(minSeconds: number, maxSeconds: number): string {
  const lo = Math.max(0, Math.round(Math.min(minSeconds, maxSeconds)));
  const hi = Math.max(0, Math.round(Math.max(minSeconds, maxSeconds)));
  const loUnit = delayUnit(lo);
  const hiUnit = delayUnit(hi);
  if (loUnit === hiUnit) {
    const a = delayAmount(lo, loUnit);
    const b = delayAmount(hi, hiUnit);
    return a === b ? `${a} ${loUnit}` : `${a}–${b} ${loUnit}`;
  }
  return `${delayAmount(lo, loUnit)} ${loUnit} – ${delayAmount(hi, hiUnit)} ${hiUnit}`;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** "22:40 · 28/07" (adds "/25" when the year differs from `now`). */
export function formatSentAt(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}${sameYear ? '' : `/${String(date.getFullYear()).slice(-2)}`}`;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())} · ${day}`;
}

/** "28/07/2026". */
export function formatDay(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export interface CampaignContactRow {
  contact_id: string;
  display_name?: string;
  phone?: string;
  status: string;
  sent_at?: number;
  error?: string;
}

export interface CampaignContactStats {
  total: number;
  sent: number;
  /** Trong số `sent`: liên hệ Hỗn hợp có hành động lỗi */
  partial: number;
  /** pending + sending */
  waiting: number;
  sending: number;
  failed: number;
  sentToday: number;
  /** 0–100 of contacts already processed (sent or failed) */
  processedPercent: number;
}

export function campaignContactStats(contacts: readonly CampaignContactRow[], now: number = Date.now()): CampaignContactStats {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();
  let sent = 0;
  let partial = 0;
  let sending = 0;
  let failed = 0;
  let sentToday = 0;
  for (const contact of contacts) {
    const status = contactStatusOf(contact.status);
    if (status === 'sent') {
      sent++;
      if (partialFailureOf(contact)) partial++;
      if ((contact.sent_at || 0) >= startMs) sentToday++;
    } else if (status === 'failed') failed++;
    else if (status === 'sending') sending++;
  }
  const total = contacts.length;
  return {
    total,
    sent,
    partial,
    waiting: total - sent - failed,
    sending,
    failed,
    sentToday,
    processedPercent: total > 0 ? Math.round(((sent + failed) / total) * 100) : 0,
  };
}

export type ContactFilter = 'all' | 'waiting' | 'sent' | 'failed' | 'partial';

export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export function filterCampaignContacts<T extends CampaignContactRow>(contacts: readonly T[], filter: ContactFilter, query: string): T[] {
  const needle = foldSearchText(query.trim());
  return contacts.filter(contact => {
    const status = contactStatusOf(contact.status);
    if (filter === 'sent' && status !== 'sent') return false;
    if (filter === 'failed' && status !== 'failed') return false;
    if (filter === 'partial' && !partialFailureOf(contact)) return false;
    if (filter === 'waiting' && status !== 'pending' && status !== 'sending') return false;
    if (!needle) return true;
    return foldSearchText(`${contact.display_name || ''} ${contact.contact_id || ''} ${contact.phone || ''}`).includes(needle);
  });
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  // Excel turns long digit strings (phone, UID) into scientific notation → force text.
  if (/^\d+$/.test(text) && text.length >= 5) return `="${text}"`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** CSV with a UTF-8 BOM-less body (the caller prepends the BOM for Excel). */
export function buildCampaignContactsCsv(contacts: readonly CampaignContactRow[]): string {
  const header = ['STT', 'Tên', 'UID', 'Số điện thoại', 'Trạng thái', 'Thời gian gửi', 'Lỗi'];
  const rows = contacts.map((contact, index) => [
    index + 1,
    csvCell(contact.display_name || ''),
    csvCell(contact.contact_id || ''),
    csvCell(contact.phone || ''),
    csvCell(contact.status || ''),
    csvCell(contact.sent_at ? new Date(contact.sent_at).toLocaleString('vi-VN') : ''),
    csvCell(contact.error || ''),
  ].join(','));
  return [header.join(','), ...rows].join('\r\n');
}
