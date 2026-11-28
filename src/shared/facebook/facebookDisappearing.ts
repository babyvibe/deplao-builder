/**
 * Disappearing messages of encrypted Messenger chats: Messenger deletes the messages after the chat's timer, Deplao keeps
 * them and only shows the timer (contacts.fb_disappearing_ttl, messages.ttl in ms).
 */
import { tr } from '../i18n';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "5 phút", "1 giờ", "1 ngày", "7 ngày" for a timer in ms; '' when off. */
export function disappearingLabel(ttlMs: number | null | undefined): string {
  const value = Math.max(0, Math.round(Number(ttlMs) || 0));
  if (!value) return '';
  if (value % DAY === 0) return tr('{{v1}} ngày', { v1: value / DAY });
  if (value % HOUR === 0) return tr('{{v1}} giờ', { v1: value / HOUR });
  if (value >= MINUTE) return tr('{{v1}} phút', { v1: Math.round(value / MINUTE) });
  return tr('{{v1}} giây', { v1: Math.max(1, Math.round(value / 1000)) });
}

/** Time of a timer change from Messenger (seconds or ms) in ms; 0 when missing. */
export function fbSettingTimeMs(value: unknown): number {
  const n = Math.round(Number(value) || 0);
  if (n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** Timer in a chat line, like Messenger: hours up to a day ("24 giờ"), days above. */
export function disappearingNoticeDuration(ttlMs: number | null | undefined): string {
  const value = Math.max(0, Math.round(Number(ttlMs) || 0));
  if (value && value <= DAY && value % HOUR === 0) return tr('{{v1}} giờ', { v1: value / HOUR });
  return disappearingLabel(value);
}

export interface DisappearingNotice {
  /** New timer in ms, 0 = turned off. */
  ttlMs: number;
  /** The timer starts when the message is seen (otherwise when it is sent). */
  afterRead?: boolean;
  /** The account itself changed it. */
  isSelf?: boolean;
  /** Name of the person who changed it ('' = unknown: the line names nobody). */
  actorName?: string;
}

/** The line Messenger shows in a chat whose disappearing timer changed. */
export function disappearingNoticeText(notice: DisappearingNotice): string {
  const time = disappearingNoticeDuration(notice.ttlMs);
  const name = String(notice.actorName || '').trim();
  if (!time) {
    if (notice.isSelf) return tr('Bạn đã tắt tính năng tin nhắn tự hủy.');
    if (name) return tr('{{name}} đã tắt tính năng tin nhắn tự hủy.', { name });
    return tr('Tính năng tin nhắn tự hủy đã tắt.');
  }
  const after = notice.afterRead
    ? tr('Tin nhắn sẽ biến mất sau {{time}} kể từ khi được xem.', { time })
    : tr('Tin nhắn sẽ biến mất sau {{time}} kể từ khi gửi.', { time });
  if (notice.isSelf) return `${tr('Bạn đã bật tính năng tin nhắn tự hủy.')} ${after}`;
  if (name) return `${tr('{{name}} đã bật tính năng tin nhắn tự hủy.', { name })} ${after}`;
  return `${tr('Tính năng tin nhắn tự hủy đã bật.')} ${after}`;
}
