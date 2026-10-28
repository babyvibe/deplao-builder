/**
 * Tin nhắn → lịch hẹn / ghi chú của Quản lý công việc (ERP): chuột phải tin → "Thêm vào lịch" / "Lưu vào ghi chú", chọn
 * nhiều tin rồi bấm ở thanh dưới, hoặc nút "Tạo lịch hẹn" ngay dưới tin có ngày giờ sắp tới. Dữ liệu điền sẵn cho
 * QuickEventDialog / QuickNoteDialog: tiêu đề lấy từ tin (bỏ phần ngày giờ, từ đệm), ngày giờ đọc trong tin
 * (lib/chat/viDateTime, tính từ lúc tin được gửi: "mai 9h" trong tin hôm qua là 9:00 hôm nay), ghi chú = nội dung tin kèm
 * người gửi, giờ gửi và hội thoại. Nhắc mặc định 15 phút trước (chuông) + đúng giờ hẹn (popup như nhắc hẹn Zalo).
 */
import type { ErpEventType } from '../../../models/erp/CalendarEvent';
import { DEFAULT_ERP_REMINDERS } from '../../../shared/erpReminderText';
import { parseViDateTime, titleWithoutDateTime } from './viDateTime';

export interface ErpSourceMessage {
  /** Nội dung chữ của tin (extractMsgText). */
  text: string;
  /** Tên người gửi; tin của mình: "Bạn". */
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
  /** null = không đọc được ngày giờ trong tin (hộp thoại dùng giờ mặc định). */
  start: number | null;
  /** Chỉ đọc được ngày, không có giờ. */
  dateOnly: boolean;
  type: ErpEventType;
  /** Mốc nhắc (phút trước giờ hẹn, 0 = đúng giờ hẹn). */
  reminders: number[];
  description: string;
  /** Vị trí (trong danh sách truyền vào) của tin cho tiêu đề / ngày giờ: lịch gắn với tin này. */
  sourceIndex: number;
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const stamp = (ts: number) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
};

const usable = (messages: readonly ErpSourceMessage[]) =>
  messages.filter(m => m.text && m.text.trim() && m.text !== '[Tin nhắn]');

/** Ghi chú: mỗi tin một dòng "[10:24 26/10] Hà: …", cuối là hội thoại · kênh · tài khoản. */
export function messagesAsNote(messages: readonly ErpSourceMessage[], ctx: ErpSourceContext): string {
  const lines = usable(messages).map(m => `[${stamp(m.timestamp)}] ${m.sender}: ${m.text.trim()}`);
  const from = [`Hội thoại: ${ctx.conversation}`, ctx.channelLabel, ctx.accountName].filter(Boolean).join(' · ');
  return [...lines, '', from].join('\n').trim();
}

/** "họp" có dấu; tin gõ không dấu thì "hop" đứng riêng. */
function looksLikeMeeting(text: string): boolean {
  const lower = text.normalize('NFC').toLowerCase();
  if (/(?<![\p{L}\p{N}])họp(?![\p{L}\p{N}])/u.test(lower)) return true;
  const unaccented = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === lower && !lower.includes('đ');
  return unaccented && /(?<![a-z0-9])hop(?![a-z0-9])/.test(lower);
}

export function eventDraftFromMessages(messages: readonly ErpSourceMessage[], ctx: ErpSourceContext): ErpEventDraft {
  const now = ctx.now ?? new Date();
  const list = usable(messages);
  // Ngày giờ: tin chọn SAU CÙNG có ngày giờ (thường là tin chốt lại); tiêu đề lấy từ chính tin đó
  let parsed: ReturnType<typeof parseViDateTime> = null;
  let source = list[0];
  for (const message of list) {
    const found = parseViDateTime(message.text, message.timestamp ? new Date(message.timestamp) : now);
    if (found) { parsed = found; source = message; }
  }
  const sourceIndex = Math.max(0, source ? messages.indexOf(source) : 0);
  const firstLine = (source?.text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  const title = (parsed ? titleWithoutDateTime(firstLine, parsed.spans.filter(([start]) => start < firstLine.length)) : titleWithoutDateTime(firstLine, []))
    || `Hẹn với ${ctx.conversation}`;
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
    : `Ghi chú từ ${ctx.conversation}`;
  return { title, content: messagesAsNote(messages, ctx) };
}
