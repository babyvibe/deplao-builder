/**
 * forEachLoop.ts — quy tắc thuần của node "Lặp qua danh sách" (logic.forEach), dùng chung engine + test.
 *
 * Node có hai cổng ra:
 *  - "Mỗi phần tử" (id `default`, như cạnh cũ của node): các node nối từ cổng này là thân vòng lặp, chạy lại cho từng
 *    phần tử với {{ $var.<tên biến> }} = phần tử, {{ $var.<tên biến>Index }} = số thứ tự (từ 1);
 *  - "Xong" (id `done`): chạy một lần sau khi lặp hết, biến đã lưu trong vòng lặp vẫn còn (vd. ghép danh sách rồi gửi 1 tin).
 */

/** Cổng ra "Xong" của logic.forEach. Mọi cổng khác (default / không đặt) = thân vòng lặp. */
export const FOR_EACH_DONE_HANDLE = 'done';
/** Số phần tử tối đa mỗi vòng lặp (giới hạn mặc định và trần của ô "Tối đa"). */
export const MAX_FOREACH_ITEMS = 100;
/** Tổng số lượt lặp trong một lần chạy workflow (cả vòng lặp lồng nhau) — chặn chạy vô hạn / gửi tin dồn dập. */
export const MAX_LOOP_ITERATIONS_PER_RUN = 1000;

/** Số phần tử được lặp: ô "Tối đa" (1…100), trống / sai = 100. */
export function forEachItemLimit(maxItems: unknown): number {
  const n = Math.floor(Number(maxItems));
  if (!Number.isFinite(n) || n <= 0) return MAX_FOREACH_ITEMS;
  return Math.min(n, MAX_FOREACH_ITEMS);
}

/** Tên biến chứa phần tử hiện tại: chữ / số / _ (không bắt đầu bằng số), sai hoặc trống = 'item'. */
export function forEachVariableName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'item';
}

/**
 * Danh sách cần lặp: mảng giữ nguyên; chuỗi JSON mảng → mảng; chuỗi khác → mỗi dòng không trống là một phần tử;
 * object / số / rỗng → [] (không lặp).
 */
export function parseForEachList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* không phải JSON → tách dòng */ }
  }
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

interface LoopEdge { source: string; target: string; sourceHandle?: string | null; data?: { telegramInline?: boolean } | null }

/**
 * Thân vòng lặp: mọi node đi tới được từ node forEach qua cạnh KHÔNG thuộc cổng "Xong" (cạnh nút Telegram inline
 * không tính — chỉ chạy khi có người bấm). Node forEach không nằm trong thân.
 */
export function forEachBodyNodeIds(edges: readonly LoopEdge[], forEachNodeId: string): Set<string> {
  const body = new Set<string>();
  const queue: string[] = [];
  for (const edge of edges) {
    if (edge.source !== forEachNodeId || edge.data?.telegramInline || edge.sourceHandle === FOR_EACH_DONE_HANDLE) continue;
    if (edge.target !== forEachNodeId && !body.has(edge.target)) { body.add(edge.target); queue.push(edge.target); }
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== id || edge.data?.telegramInline) continue;
      if (edge.target === forEachNodeId || body.has(edge.target)) continue;
      body.add(edge.target);
      queue.push(edge.target);
    }
  }
  return body;
}
