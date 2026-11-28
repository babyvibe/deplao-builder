/**
 * Whole title of a Zalo reminder card. Zalo cuts long titles in the card it sends ("Gia hạn OA: UWE Bristol - ...");
 * the group board topic keeps the whole one (getReminder with the card's topicId). Looked up once per card, then saved
 * in the message (DatabaseService.saveZaloReminderFullTitle) so later loads need no request.
 */
import DatabaseService from '../database/DatabaseService';
import { isCutReminderTitle, parseZaloReminderCard } from '../../shared/zalo/zaloReminderCard';

export interface ZaloReminderTitleSource {
  getZaloId(): string | null;
  getReminder(reminderId: string): Promise<{ params?: { title?: string } } | null | undefined>;
}

type ReminderTitleDb = Pick<DatabaseService, 'getMessageById' | 'saveZaloReminderFullTitle'>;

export interface ZaloReminderTitleResult {
  /** Title to show: the whole one when found, else the one Zalo sent. */
  title: string;
  /** True when `title` is the whole title (found now or saved before). */
  full: boolean;
}

export async function resolveZaloReminderTitle(
  service: ZaloReminderTitleSource,
  msgId: string,
  threadId?: string,
  db: ReminderTitleDb = DatabaseService.getInstance(),
): Promise<ZaloReminderTitleResult> {
  const owner = service.getZaloId();
  const id = String(msgId || '');
  if (!owner || !id) throw new Error('Missing account or message');
  const thread = threadId ? String(threadId) : undefined;
  const row = db.getMessageById(owner, id, thread);
  const card = row ? parseZaloReminderCard(row.content) : null;
  if (!card) throw new Error('Not a Zalo reminder card');
  if (card.fullTitle) return { title: card.fullTitle, full: true };
  if (!card.topicId || !isCutReminderTitle(card.title)) return { title: card.title, full: false };

  const reminder = await service.getReminder(card.topicId);
  const title = String(reminder?.params?.title || '').trim();
  if (!title) return { title: card.title, full: false };
  db.saveZaloReminderFullTitle(owner, id, thread, title);
  return { title, full: true };
}
