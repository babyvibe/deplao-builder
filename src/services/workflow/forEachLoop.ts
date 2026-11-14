/**
 * forEachLoop.ts: pure rules of the "Lặp qua danh sách" (loop over list, logic.forEach) node, shared by the engine and the tests.
 *
 * The node has two output ports:
 *  - "Mỗi phần tử" (for each item, id `default`, like the node's old edges): the nodes wired from this port are the loop body, run again for each
 *    item with {{ $var.<variable name> }} = the item, {{ $var.<variable name>Index }} = the position (from 1);
 *  - "Xong" (done, id `done`): runs once after the loop finishes, variables saved inside the loop are still available (e.g. join a list, then send 1 message).
 */

/** The "Xong" (done) output port of logic.forEach. Every other port (default / unset) = loop body. */
export const FOR_EACH_DONE_HANDLE = 'done';
/** Max number of items per loop (default limit and the cap of the "Tối đa" (max) field). */
export const MAX_FOREACH_ITEMS = 100;
/** Total number of loop passes in one workflow run (including nested loops): stops endless runs / bursts of messages. */
export const MAX_LOOP_ITERATIONS_PER_RUN = 1000;

/** Number of items to loop over: the "Tối đa" (max) field (1…100), empty / invalid = 100. */
export function forEachItemLimit(maxItems: unknown): number {
  const n = Math.floor(Number(maxItems));
  if (!Number.isFinite(n) || n <= 0) return MAX_FOREACH_ITEMS;
  return Math.min(n, MAX_FOREACH_ITEMS);
}

/** Name of the variable holding the current item: letters / digits / _ (must not start with a digit); invalid or empty = 'item'. */
export function forEachVariableName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'item';
}

/**
 * List to loop over: an array is kept as is; a JSON array string → array; other strings → each non-empty line is one item;
 * object / number / empty → [] (no loop).
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
    } catch { /* not JSON → split into lines */ }
  }
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

interface LoopEdge { source: string; target: string; sourceHandle?: string | null; data?: { telegramInline?: boolean } | null }

/**
 * Loop body: every node reachable from the forEach node through an edge that is NOT on the "Xong" (done) port (inline Telegram button edges
 * do not count: they only run when someone clicks). The forEach node itself is not part of the body.
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
