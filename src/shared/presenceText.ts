/**
 * presenceText.ts — chữ "truy cập lần cuối" dùng chung mọi kênh (Telegram UserStatus, Zalo lastOnline).
 * Thời gian tính bằng ms, theo giờ máy.
 */

const pad2 = (value: number) => String(value).padStart(2, '0');

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "truy cập 14:05", "truy cập hôm qua 21:30", "truy cập 03/10" (khác năm: "03/10/2025"); không có mốc → "truy cập đã lâu". */
export function describeLastSeen(lastSeenMs: number | undefined | null, now: number = Date.now()): string {
  if (!lastSeenMs) return 'truy cập đã lâu';
  const d = new Date(lastSeenMs);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = startOfDay(now);
  if (lastSeenMs >= today) return `truy cập ${time}`;
  if (lastSeenMs >= today - 86400000) return `truy cập hôm qua ${time}`;
  return `truy cập ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}${d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : ''}`;
}

/** Viết hoa chữ đầu để hiện riêng một dòng ("Truy cập 14:05"). */
export function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1) : text;
}
