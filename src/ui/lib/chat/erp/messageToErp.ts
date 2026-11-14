/**
 * Message → appointment / note of Task management (ERP): right-click a message → "Thêm vào lịch" (Add to calendar) / "Lưu vào ghi chú" (Save to note), select
 * several messages and click in the bar below, or the "Tạo lịch hẹn" (Create appointment) button right under a message with an upcoming date and time. The data pre-fills
 * QuickEventDialog / QuickNoteDialog: the title comes from the message (date and time removed, filler words dropped), the date and time are read from the message
 * (lib/chat/erp/viDateTime, counted from the moment the message was sent: "mai 9h" (tomorrow 9h) in yesterday's message is 9:00 today), the note = the message content with
 * the sender, the time sent and the conversation. Default reminder 15 minutes before (bell) + at the appointment time (popup like a Zalo appointment reminder).
 */
import type { ErpEventType } from '../../../../models/erp/CalendarEvent';
import { DEFAULT_ERP_REMINDERS } from '../../../../shared/erp/erpReminderText';
import { parseViDateTime, titleWithoutDateTime } from './viDateTime';
import { tr } from '../../../../shared/i18n';

export interface ErpSourceMessage {
  /** The text content of the message (extractMsgText). */
  text: string;
  /** Sender name; my own messages: "Bạn" (You). */
  sender: string;
  timestamp: number;
}

export interface ErpSourceContext {
  conversation: string;
  channelLabel?: string;
  accountName?: string;
  now?: Date;
}

export interface ErpEventDraft {
  title: string;
  /** null = the date and time could not be read from the message (the dialog uses the default time). */
  start: number | null;
  /** Only the date could be read, no time. */
  dateOnly: boolean;
  type: ErpEventType;
  /** Reminder time (minutes before the appointment, 0 = at the appointment time). */
  reminders: number[];
  description: string;
  /** Position (in the list passed in) of the message for the title / date and time: the appointment is attached to this message. */
  sourceIndex: number;
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const stamp = (ts: number) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
};

const usable = (messages: readonly ErpSourceMessage[]) =>
  messages.filter(m => m.text && m.text.trim() && m.text !== '[Tin nhắn]');

/** Note: one line per message "[10:24 26/10] Hà: …", the end is conversation · channel · account. */
export function messagesAsNote(messages: readonly ErpSourceMessage[], ctx: ErpSourceContext): string {
  const lines = usable(messages).map(m => `[${stamp(m.timestamp)}] ${m.sender}: ${m.text.trim()}`);
  const from = [`Hội thoại: ${ctx.conversation}`, ctx.channelLabel, ctx.accountName].filter(Boolean).join(' · ');
  return [...lines, '', from].join('\n').trim();
}

/** "họp" (meeting) with diacritics; a message typed without diacritics: "hop" stands alone. */
function looksLikeMeeting(text: string): boolean {
  const lower = text.normalize('NFC').toLowerCase();
  if (/(?<![\p{L}\p{N}])họp(?![\p{L}\p{N}])/u.test(lower)) return true;
  const unaccented = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === lower && !lower.includes('đ');
  return unaccented && /(?<![a-z0-9])hop(?![a-z0-9])/.test(lower);
}

export function eventDraftFromMessages(messages: readonly ErpSourceMessage[], ctx: ErpSourceContext): ErpEventDraft {
  const now = ctx.now ?? new Date();
  const list = usable(messages);
  // Date and time: the LAST selected message that has a date and time (usually the one that confirms it); the title comes from that message
  let parsed: ReturnType<typeof parseViDateTime> = null;
  let source = list[0];
  for (const message of list) {
    const found = parseViDateTime(message.text, message.timestamp ? new Date(message.timestamp) : now);
    if (found) { parsed = found; source = message; }
  }
  const sourceIndex = Math.max(0, source ? messages.indexOf(source) : 0);
  const firstLine = (source?.text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const title = (parsed ? titleWithoutDateTime(firstLine, parsed.spans.filter(([start]) => start < firstLine.length)) : titleWithoutDateTime(firstLine, []))
    || tr('Hẹn với {{conversation}}', { conversation: ctx.conversation });
  return {
    title,
    start: parsed ? parsed.at : null,
    dateOnly: !!parsed && !parsed.hasTime,
    type: list.some(m => looksLikeMeeting(m.text)) ? 'meeting' : 'appointment',
    reminders: [...DEFAULT_ERP_REMINDERS],
    description: messagesAsNote(messages, ctx),
    sourceIndex,
  };
}

export function noteDraftFromMessages(messages: readonly ErpSourceMessage[], ctx: ErpSourceContext): { title: string; content: string } {
  const first = usable(messages)[0];
  const firstLine = (first?.text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const title = firstLine
    ? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine)
    : tr('Ghi chú từ {{conversation}}', { conversation: ctx.conversation });
  return { title, content: messagesAsNote(messages, ctx) };
}

// ─── Task ───────────────────────────────────────────────────────────────────

export interface ErpTaskSourceMessage extends ErpSourceMessage {
  /** Image of the message (data URL / link) inserted into the task content. */
  images?: string[];
}

export interface ErpTaskDraft {
  title: string;
  /** Task content (HTML for the task editor). */
  description: string;
  /** Due date read from the message ("mai 9h gửi báo giá" (tomorrow 9h, send the quote)); null = none. */
  dueAt: number | null;
}

const escapeHtml = (text: string) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const textParagraph = (text: string) => `<p>${text.split(/\r?\n/).map(escapeHtml).join('<br>')}</p>`;

/**
 * "Tạo task" (Create task) from a message: title = the first line of text (date and time removed), due = the date and time read from the message (the last selected message with
 * a date and time, like an appointment; date only → 17:00 that day), content = one block per message "Hà · 10:24 26/10" + text + the message's image,
 * and the end is conversation · channel · account. Image-only messages are included too.
 */
export function taskDraftFromMessages(messages: readonly ErpTaskSourceMessage[], ctx: ErpSourceContext): ErpTaskDraft {
  const now = ctx.now ?? new Date();
  const list = messages.filter(m => (m.text && m.text.trim() && m.text !== '[Tin nhắn]') || m.images?.length);
  const withText = list.filter(m => m.text && m.text.trim() && m.text !== '[Tin nhắn]');
  let parsed: ReturnType<typeof parseViDateTime> = null;
  let source = withText[0];
  for (const message of withText) {
    const found = parseViDateTime(message.text, message.timestamp ? new Date(message.timestamp) : now);
    if (found) { parsed = found; source = message; }
  }
  const firstLine = (source?.text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const cleaned = firstLine
    ? titleWithoutDateTime(firstLine, parsed ? parsed.spans.filter(([start]) => start < firstLine.length) : [])
    : '';
  const title = cleaned
    ? (cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned)
    : tr('Task từ {{conversation}}', { conversation: ctx.conversation });

  let dueAt: number | null = null;
  if (parsed) {
    const at = new Date(parsed.at);
    if (!parsed.hasTime) at.setHours(17, 0, 0, 0);
    dueAt = at.getTime();
  }

  const blocks = list.map((m) => {
    const parts = [`<p><strong>${escapeHtml(m.sender)}</strong> · ${escapeHtml(stamp(m.timestamp))}</p>`];
    if (m.text && m.text.trim() && m.text !== '[Tin nhắn]') parts.push(textParagraph(m.text.trim()));
    for (const src of m.images || []) parts.push(`<p><img src="${escapeHtml(src)}"></p>`);
    return parts.join('');
  });
  const from = [tr('Hội thoại: {{conversation}}', { conversation: ctx.conversation }), ctx.channelLabel, ctx.accountName].filter(Boolean).join(' · ');
  return { title, description: [...blocks, `<p><em>${escapeHtml(from)}</em></p>`].join(''), dueAt };
}
