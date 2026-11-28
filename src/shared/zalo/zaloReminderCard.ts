/**
 * Zalo reminder cards (chat.ecard with the action "action.open.reminder"). Zalo cuts long reminder titles in the card it
 * sends ("Gia hạn OA: UWE Bristol - ..."); the group board topic (getReminder with the card's topicId) keeps the whole
 * title. Deplao looks it up once and saves it in the message content as `fullTitle`.
 * Pure helpers shared by the main process (lookup + save) and the card in the chat window.
 */

/** Leading emoji (or the text form some clients send) that the card draws separately. */
const LEADING_EMOJI = /^(?:[⏰📅🔔⭐📌💡🎯🎉]\uFE0F?|Clock:|Calendar:|Bell:|Star:|Pin:|Lightbulb:|Target:)\s*/iu;

export interface ZaloReminderCardInfo {
  /** Group board topic id (getReminder eventId); '' when the card does not carry one. */
  topicId: string;
  /** Title as Zalo sent it, without the leading emoji. May end with "..." when Zalo cut it. */
  title: string;
  /** Whole title saved by Deplao after a lookup; '' until then. */
  fullTitle: string;
  /** Zalo's own date line ("Thứ Tư, 25 tháng 11 lúc 10:28"), shown when the reminder time is missing. */
  description: string;
  emoji: string;
  /** Reminder time (ms), 0 when unknown. */
  startTime: number;
  /** 0 none, 1 daily, 2 weekly, 3 monthly. */
  repeat: number;
}

function jsonObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Reads a reminder card from a chat.ecard content (JSON string or object); null when it is not a reminder card. */
export function parseZaloReminderCard(content: unknown): ZaloReminderCardInfo | null {
  const card = jsonObject(content);
  const params = jsonObject(card.params);
  const actions: any[] = Array.isArray(params.actions) ? params.actions : [];
  const action = actions.find((item) => item && item.actionId === 'action.open.reminder');
  if (!action) return null;
  const data = jsonObject(jsonObject(action.data).data);
  const title = String(params.notifyTxt || card.title || '').replace(LEADING_EMOJI, '');
  return {
    topicId: data.topicId ? String(data.topicId) : '',
    title,
    fullTitle: typeof card.fullTitle === 'string' ? card.fullTitle.trim() : '',
    description: typeof card.description === 'string' ? card.description : '',
    emoji: typeof data.emoji === 'string' && data.emoji ? data.emoji : '⏰',
    startTime: Number(data.startTime || 0) || 0,
    repeat: Number(data.repeat ?? 0) || 0,
  };
}

/** Zalo cut the title ("… - ..." or "…"): only then is a lookup worth a request. */
export function isCutReminderTitle(title: string): boolean {
  return /(?:\.\.\.|…)\s*$/u.test(String(title || ''));
}

/**
 * A cut title without Zalo's ellipsis and the separator left in front of it: "Gia hạn OA: X - ..." → "Gia hạn OA: X".
 * The card never shows those dots (the one-line system notice keeps them).
 */
export function withoutCutMarker(title: string): string {
  const text = String(title || '');
  if (!isCutReminderTitle(text)) return text.trim();
  return text.replace(/\s*(?:\.\.\.|…)\s*$/u, '').replace(/[\s\-\u2013\u2014:,;(/|]+$/u, '').trim();
}

/** Title to show on the card: the saved whole title, else the one Zalo sent without its ellipsis. */
export function reminderCardTitle(info: Pick<ZaloReminderCardInfo, 'title' | 'fullTitle'>): string {
  return info.fullTitle || withoutCutMarker(info.title);
}

/** The card content with the whole title saved (everything else untouched); null when the content is not a JSON object. */
export function withReminderFullTitle(content: string, fullTitle: string): string | null {
  const title = String(fullTitle || '').trim();
  if (!title) return null;
  try {
    const parsed = JSON.parse(String(content || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return JSON.stringify({ ...parsed, fullTitle: title });
  } catch {
    return null;
  }
}
