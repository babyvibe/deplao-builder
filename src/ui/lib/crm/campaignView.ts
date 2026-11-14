/**
 * Pure helpers for the CRM campaign screens (CampaignList + CampaignDetail).
 *
 * Reads the stored template / mixed config with the same rules as
 * `CRMQueueService` so the screen shows what the queue will actually send.
 * No React, no IPC — covered by `src/__tests__/crm/campaignView.test.ts`.
 */
import { parseMarkup } from '../../../services/crm/message-markup';
import {
  DEFAULT_CAMPAIGN_SEND_OPTIONS,
  planBlockSend,
  readCampaignSendOptions,
  type BlockSendPlan,
  type CampaignSendOptions,
} from '../../../shared/crm/campaignSendPlan';
import { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, effectiveContactDelayRange } from '../../../shared/crm/campaignDelay';
import { partialFailureOf } from '../../../shared/crm/campaignOutcome';
import { campaignFlag } from '../../../shared/crm/campaignAutoStop';
import {
  matchesEngagementFilter,
  type EngagementFilter,
  type EngagementState,
  type EngagementSupport,
} from '../../../shared/analytics/messageEngagement';
import { tr, appLocale } from '../../../shared/i18n';

export { partialFailureOf };

export type CampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'done';
export type CampaignContactStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type MixedAction = 'message' | 'friend_request' | 'invite_to_groups';
export type SendMode = 'random' | 'all';
type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'info';

export interface ContentBlock { id: string; text: string; images: string[]; tagAll?: boolean; tagAllText?: string; }
/** `order` / `combine`: how text and images of a block are sent (shared/crm/campaignSendPlan). */
export interface ContentConfig extends CampaignSendOptions { mode: SendMode; blocks: ContentBlock[]; }

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  message: tr('Tin nhắn'),
  friend_request: tr('Kết bạn'),
  invite_to_group: tr('Mời vào nhóm'),
  mixed: tr('Hỗn hợp'),
};

export const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: tr('Nháp'), tone: 'default' },
  active: { label: tr('Đang chạy'), tone: 'success' },
  paused: { label: tr('Tạm dừng'), tone: 'warning' },
  done: { label: tr('Hoàn thành'), tone: 'primary' },
};

/** Paused because of consecutive errors (CRMQueueService stops itself, shared/crm/campaignAutoStop): replaces the "Tạm dừng" (Paused) label. */
export const CAMPAIGN_AUTO_STOPPED_META: { label: string; tone: BadgeTone } = { label: tr('Tự dừng'), tone: 'destructive' };

export const CONTACT_STATUS_META: Record<CampaignContactStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: tr('Chờ gửi'), tone: 'default' },
  sending: { label: tr('Đang gửi'), tone: 'info' },
  sent: { label: tr('Đã gửi'), tone: 'success' },
  failed: { label: tr('Lỗi'), tone: 'destructive' },
};

/** "Đã gửi" (Sent) but some actions of the mixed campaign failed (shared/crm/campaignOutcome). */
export const CONTACT_PARTIAL_META: { label: string; tone: BadgeTone } = { label: tr('Gửi một phần'), tone: 'warning' };

export function campaignTypeOf(value: string | null | undefined): CampaignType {
  return value === 'friend_request' || value === 'mixed' || value === 'invite_to_group' ? value : 'message';
}

export function campaignStatusOf(value: string | null | undefined): CampaignStatus {
  return value === 'active' || value === 'paused' || value === 'done' ? value : 'draft';
}

/** The campaign is paused because of consecutive errors (the reason stays until "Tiếp tục" (Continue) is pressed). */
export function isCampaignAutoStopped(campaign: { status?: string | null; auto_stop_reason?: string | null }): boolean {
  return campaign.status === 'paused' && !!String(campaign.auto_stop_reason || '').trim();
}

/** When the campaign stops itself, "Mai gửi tiếp" (Send again tomorrow) runs again automatically (0 = no schedule: press "Tiếp tục" (Continue)). */
export function campaignScheduledResumeAt(campaign: {
  status?: string | null; auto_stop_reason?: string | null; auto_resume_at?: number | null; stop_resume_next_day?: number | null;
}): number {
  if (!isCampaignAutoStopped(campaign) || campaignFlag(campaign.stop_resume_next_day) !== 1) return 0;
  return Number(campaign.auto_resume_at) > 0 ? Number(campaign.auto_resume_at) : 0;
}

/** Label + colour of the campaign status (self-stopped replaces "Tạm dừng" (Paused)). */
export function campaignStatusMeta(campaign: { status?: string | null; auto_stop_reason?: string | null }): { label: string; tone: BadgeTone } {
  return isCampaignAutoStopped(campaign) ? CAMPAIGN_AUTO_STOPPED_META : CAMPAIGN_STATUS_META[campaignStatusOf(campaign.status)];
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
  name: tr('Tên người nhận'),
  userId: tr('ID người nhận'),
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
 * 30-second minimum (shared/crm/campaignDelay) so a stored "5–10 s" shows what is really sent.
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

// Unit ids stay Vietnamese (compared above); the text shows the name in the UI language
const DELAY_UNIT_LABEL: Record<DelayUnit, string> = { 'giây': tr('giây'), 'phút': tr('phút'), 'giờ': tr('giờ') };

function delayAmount(seconds: number, unit: DelayUnit): string {
  const value = unit === 'giây' ? seconds : unit === 'phút' ? seconds / 60 : seconds / 3600;
  // decimal separator of the UI language: "1,8" in Vietnamese, "1.8" in English
  return (Math.round(value * 10) / 10).toLocaleString(appLocale(), { maximumFractionDigits: 1, useGrouping: false });
}

/** "2 phút", "1,8–2,2 phút", "30–45 giây", "45 giây – 2 phút" (examples of formatted durations). */
export function formatDelayRange(minSeconds: number, maxSeconds: number): string {
  const lo = Math.max(0, Math.round(Math.min(minSeconds, maxSeconds)));
  const hi = Math.max(0, Math.round(Math.max(minSeconds, maxSeconds)));
  const loUnit = delayUnit(lo);
  const hiUnit = delayUnit(hi);
  if (loUnit === hiUnit) {
    const a = delayAmount(lo, loUnit);
    const b = delayAmount(hi, hiUnit);
    return a === b ? `${a} ${DELAY_UNIT_LABEL[loUnit]}` : `${a}–${b} ${DELAY_UNIT_LABEL[loUnit]}`;
  }
  return `${delayAmount(lo, loUnit)} ${DELAY_UNIT_LABEL[loUnit]} – ${delayAmount(hi, hiUnit)} ${DELAY_UNIT_LABEL[hiUnit]}`;
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
  /** Among `sent`: mixed-campaign contacts with a failed action */
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

/** Send status + effect (replied / seen but not replied / not seen / not received: only contacts that were sent to). */
export type ContactFilter = 'all' | 'waiting' | 'sent' | 'failed' | 'partial' | EngagementFilter;

/** Effect for the contacts that were sent to, by contact_id (crm:getCampaignEngagement). */
export interface CampaignEngagementView {
  byContact: ReadonlyMap<string, EngagementState>;
  support: EngagementSupport;
}

export type EngagementLevel = 'replied' | 'seen' | 'delivered';

/** The highest level reached: replied ⇒ seen ⇒ received. null = only sent so far (no signal yet). */
export function engagementLevelOf(state: EngagementState | null | undefined): EngagementLevel | null {
  if (!state) return null;
  if (state.replied) return 'replied';
  if (state.seen) return 'seen';
  if (state.delivered) return 'delivered';
  return null;
}

export const ENGAGEMENT_LEVEL_META: Record<EngagementLevel, { label: string; tone: BadgeTone }> = {
  replied: { label: tr('Đã phản hồi'), tone: 'success' },
  seen: { label: tr('Đã xem'), tone: 'info' },
  delivered: { label: tr('Đã nhận'), tone: 'primary' },
};

export const ENGAGEMENT_FILTER_LABEL: Record<EngagementFilter, string> = {
  replied: tr('Đã phản hồi'),
  seen_no_reply: tr('Đã xem, chưa phản hồi'),
  not_seen: tr('Chưa xem'),
  not_delivered: tr('Chưa nhận'),
};

export function isEngagementFilter(filter: ContactFilter): filter is EngagementFilter {
  return filter === 'replied' || filter === 'seen_no_reply' || filter === 'not_seen' || filter === 'not_delivered';
}

/** Number of sent-to contacts matching each effect filter. */
export function engagementFilterCounts(contacts: readonly CampaignContactRow[], engagement: CampaignEngagementView | null | undefined): Record<EngagementFilter, number> {
  const counts: Record<EngagementFilter, number> = { replied: 0, seen_no_reply: 0, not_seen: 0, not_delivered: 0 };
  if (!engagement) return counts;
  for (const contact of contacts) {
    if (contactStatusOf(contact.status) !== 'sent') continue;
    const state = engagement.byContact.get(String(contact.contact_id));
    for (const filter of Object.keys(counts) as EngagementFilter[]) {
      if (matchesEngagementFilter(state, filter, engagement.support)) counts[filter]++;
    }
  }
  return counts;
}

export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export function filterCampaignContacts<T extends CampaignContactRow>(
  contacts: readonly T[],
  filter: ContactFilter,
  query: string,
  engagement?: CampaignEngagementView | null,
): T[] {
  const needle = foldSearchText(query.trim());
  return contacts.filter(contact => {
    const status = contactStatusOf(contact.status);
    if (isEngagementFilter(filter)) {
      if (status !== 'sent' || !engagement) return false;
      if (!matchesEngagementFilter(engagement.byContact.get(String(contact.contact_id)), filter, engagement.support)) return false;
    }
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

/** CSV with a UTF-8 BOM-less body (the caller prepends the BOM for Excel). `engagement`: adds an "Hiệu quả" (Effect) column. */
export function buildCampaignContactsCsv(contacts: readonly CampaignContactRow[], engagement?: CampaignEngagementView | null): string {
  const header = ['STT', tr('Tên'), 'UID', tr('Số điện thoại'), tr('Trạng thái'), tr('Thời gian gửi'), tr('Lỗi')];
  if (engagement) header.push(tr('Hiệu quả'));
  const rows = contacts.map((contact, index) => {
    const cells = [
      index + 1,
      csvCell(contact.display_name || ''),
      csvCell(contact.contact_id || ''),
      csvCell(contact.phone || ''),
      csvCell(contact.status || ''),
      csvCell(contact.sent_at ? new Date(contact.sent_at).toLocaleString(appLocale()) : ''),
      csvCell(contact.error || ''),
    ];
    if (engagement) {
      const sent = contactStatusOf(contact.status) === 'sent';
      const level = sent ? engagementLevelOf(engagement.byContact.get(String(contact.contact_id))) : null;
      cells.push(csvCell(level ? ENGAGEMENT_LEVEL_META[level].label : sent ? CONTACT_STATUS_META.sent.label : ''));
    }
    return cells.join(',');
  });
  return [header.join(','), ...rows].join('\r\n');
}
