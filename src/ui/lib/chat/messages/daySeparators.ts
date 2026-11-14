import { localDayKey } from '../../../../shared/analytics/localTimeBuckets';

/**
 * The first DISPLAYED message of each calendar day (on this machine) → where the day marker "Hôm nay / Hôm qua / 15/10" goes (once per day, as in
 * Telegram). `isSkipped`: a message with no row of its own (photo / sticker / poll already merged into the group's first message) is skipped, otherwise an
 * album crossing midnight would lose the marker of the new day.
 */
export function getDayStartIds(
  messages: ReadonlyArray<{ msg_id: string; timestamp: number | string }>,
  isSkipped: (msgId: string) => boolean = () => false,
): Set<string> {
  const ids = new Set<string>();
  let lastDay = '';
  for (const message of messages) {
    if (isSkipped(message.msg_id)) continue;
    const day = localDayKey(Number(message.timestamp) || 0);
    if (day !== lastDay) {
      ids.add(message.msg_id);
      lastDay = day;
    }
  }
  return ids;
}
