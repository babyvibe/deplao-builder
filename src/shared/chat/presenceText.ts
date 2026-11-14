/**
 * presenceText.ts: the "truy cập lần cuối" (last seen) text shared by all channels (Telegram UserStatus, Zalo lastOnline).
 * Times are in ms, in local machine time.
 */

import { tr } from '../i18n';

const pad2 = (value: number) => String(value).padStart(2, '0');

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "truy cập 14:05" (last seen 14:05), "truy cập hôm qua 21:30" (last seen yesterday 21:30), "truy cập 03/10" (other year: "03/10/2025"); no timestamp → "truy cập đã lâu" (last seen long ago). */
export function describeLastSeen(lastSeenMs: number | undefined | null, now: number = Date.now()): string {
  if (!lastSeenMs) return tr('truy cập đã lâu');
  const d = new Date(lastSeenMs);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = startOfDay(now);
  if (lastSeenMs >= today) return tr('truy cập {{time}}', { time });
  if (lastSeenMs >= today - 86400000) return tr('truy cập hôm qua {{time}}', { time });
  return tr('truy cập {{v1}}/{{v2}}{{v3}}', { v1: pad2(d.getDate()), v2: pad2(d.getMonth() + 1), v3: d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : '' });
}

/** Capitalize the first letter so it shows on its own line ("Truy cập 14:05"). */
export function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1) : text;
}
