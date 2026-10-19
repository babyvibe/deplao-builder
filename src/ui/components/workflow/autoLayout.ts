/**
 * autoLayout.ts - "Sắp xếp tự động" for the workflow map.
 *
 * Pure and deterministic (no React / React Flow imports) so it can be unit-tested.
 * Layered (Sugiyama-style) drawing, flow from top to bottom:
 *
 *  1. Weakly connected components. Components holding a trigger come first, then bigger ones,
 *     then by their current left-most x. Isolated nodes go to a small grid on the right.
 *  2. Cycles are broken by a DFS from the sources (triggers first); back edges are ignored.
 *  3. Longest-path layering. A source that only feeds deep nodes moves down to sit one layer
 *     above its shallowest child.
 *  4. Edges spanning several layers get virtual "lane" vertices. Order inside each layer:
 *     DFS in handle order (IF: Đúng → Sai, Switch: cases → Mặc định, others by current x),
 *     then barycenter sweeps (down, up, down, up) that know where each handle sits on its card,
 *     then adjacent swaps; the ordering with the fewest crossings wins.
 *  5. X: Brandes–Köpf alignment + compaction (4 runs, balanced) with handle offsets, so
 *     single-child chains are perfectly straight and a parent sits centred over its branches.
 *     React Flow draws every edge as ONE bezier between its two handles (it ignores lanes),
 *     so a long edge whose curve would cut through a card is straightened: its two end
 *     cards are aligned with its lane and the layout is recomputed.
 *  6. Y: layers stacked with a 90px gap (+24px below IF/Switch for the hanging branch labels).
 *  7. Components side by side (120px gap, top aligned); the result is translated so its
 *     bounding box starts where the old one started.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LayoutNode {
  id: string;
  position: { x: number; y: number };
  /** Measured by React Flow once rendered. */
  width?: number | null;
  height?: number | null;
  data?: { type?: string; config?: any } | null;
}

export interface LayoutEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export type LayoutPositions = Record<string, { x: number; y: number }>;

/** Spacing used by the layout (flow coordinates, px). */
export const AUTO_LAYOUT_SPACING = {
  nodeWidth: 264,     // fallback when React Flow has not measured a card yet
  nodeHeight: 96,
  layerGap: 90,       // bottom of the tallest card of a layer → top of the next layer
  branchLabelGap: 24, // extra room below a layer holding IF/Switch (branch labels hang below)
  nodeGap: 48,        // between two cards of the same layer
  laneGap: 32,        // between a card and a long edge passing by
  laneLaneGap: 24,    // between two long edges running side by side
  componentGap: 120,  // between disconnected parts of the workflow
  gridColumns: 3,     // isolated nodes per row
  gridGap: 48,
} as const;

/**
 * Returns the new top-left position of every node.
 * Positions are rounded to whole pixels; the bounding box keeps its old top-left corner.
 */
export function computeAutoLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutPositions {
  const graph: GNode[] = [];
  const indexOf = new Map<string, number>();
  for (const node of nodes || []) {
    if (!node || node.id === undefined || node.id === null) continue;
    const id = String(node.id);
    if (indexOf.has(id)) continue;
    const type = String(node.data?.type || '');
    const w = positiveOr(node.width, S.nodeWidth);
    indexOf.set(id, graph.length);
    graph.push({
      id,
      x: finiteOr(node.position?.x, 0),
      y: finiteOr(node.position?.y, 0),
      w,
      h: positiveOr(node.height, S.nodeHeight),
      trigger: type.startsWith('trigger.') || type.includes('.trigger.'),
      branching: type === 'logic.if' || type === 'logic.switch',
      ports: handlePorts(type, node.data?.config, w),
    });
  }
  if (!graph.length) return {};

  const links: GLink[] = [];
  const seen = new Set<string>();
  for (const edge of edges || []) {
    if (!edge) continue;
    const s = indexOf.get(String(edge.source));
    const t = indexOf.get(String(edge.target));
    if (s === undefined || t === undefined || s === t) continue; // dangling edge / self-loop
    const port = resolvePort(graph[s], edge.sourceHandle);
    const key = `${s}>${t}>${port.order}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ s, t, port });
  }

  // 1. Components: trigger components first, then bigger, then by current left-most x.
  const comps = weakComponents(graph.length, links);
  const leftMost = (members: number[]) => members.reduce((m, g) => Math.min(m, graph[g].x), Infinity);
  const hasTrigger = (members: number[]) => (members.some(g => graph[g].trigger) ? 1 : 0);
  const connected = comps
    .filter(c => c.length > 1)
    .sort((a, b) => hasTrigger(b) - hasTrigger(a) || b.length - a.length || leftMost(a) - leftMost(b) || a[0] - b[0]);
  const isolated = comps
    .filter(c => c.length === 1)
    .map(c => c[0])
    .sort((a, b) => Number(graph[b].trigger) - Number(graph[a].trigger)
      || graph[a].y - graph[b].y || graph[a].x - graph[b].x || a - b);

  const placed: { x: number; y: number }[] = new Array(graph.length);
  let cursor = 0;
  for (const members of connected) {
    const local = layoutComponent(graph, members, links);
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    members.forEach((g, k) => {
      left = Math.min(left, local.x[k]);
      top = Math.min(top, local.y[k]);
      right = Math.max(right, local.x[k] + graph[g].w);
    });
    members.forEach((g, k) => { placed[g] = { x: cursor + local.x[k] - left, y: local.y[k] - top }; });
    cursor += right - left + S.componentGap;
  }

  // Isolated nodes: compact grid to the right of everything else.
  if (isolated.length) {
    const cellW = isolated.reduce((m, g) => Math.max(m, graph[g].w), 0) + S.gridGap;
    let rowTop = 0;
    for (let r = 0; r < isolated.length; r += S.gridColumns) {
      const row = isolated.slice(r, r + S.gridColumns);
      row.forEach((g, c) => { placed[g] = { x: cursor + c * cellW, y: rowTop }; });
      rowTop += row.reduce((m, g) => Math.max(m, graph[g].h), 0) + S.gridGap;
    }
  }

  // 7. Translate so the drawing stays where the user was looking.
  let oldX = Infinity;
  let oldY = Infinity;
  let newX = Infinity;
  let newY = Infinity;
  graph.forEach((node, g) => {
    oldX = Math.min(oldX, node.x);
    oldY = Math.min(oldY, node.y);
    newX = Math.min(newX, placed[g].x);
    newY = Math.min(newY, placed[g].y);
  });
  const result: LayoutPositions = {};
  graph.forEach((node, g) => {
    result[node.id] = {
      x: Math.round(placed[g].x + oldX - newX),
      y: Math.round(placed[g].y + oldY - newY),
    };
  });
  return result;
}

// ─── Internals ────────────────────────────────────────────────────────────────

const S = AUTO_LAYOUT_SPACING;
/** Centre of the Switch "Mặc định" handle: `right: 1rem` + 12px handle shifted by -50%. */
const SWITCH_DEFAULT_INSET = 28;
const ORDER_SWEEPS = 4;
const TRANSPOSE_ROUNDS = 8;
const STRAIGHTEN_ROUNDS = 4;
const STRAIGHTEN_MAX_SEGMENTS = 4000;
const CURVE_SAMPLES_PER_LAYER = 16;
const CURVE_MARGIN = 4;

interface PortDef { id: string; frac: number; aliases: string[] }
/** order: handle order on the card (left → right); frac: horizontal position of the handle (0..1). */
interface Port { order: number; frac: number }

interface GNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  trigger: boolean;
  branching: boolean;
  /** Source handles of multi-output cards (IF / Switch); null = one centred handle. */
  ports: PortDef[] | null;
}

interface GLink { s: number; t: number; port: Port }

interface Seg {
  u: number;      // vertex in the upper layer
  v: number;      // vertex in the layer right below
  frac: number;   // source handle position on u (0..1); 0.5 for virtual vertices
  order: number;  // source handle order on u
  off: number;    // px offset of that handle from u's centre
  edge: number;   // component-local edge index
}

interface LayeredGraph {
  n: number;                       // real vertices are 0..n-1, virtual ones follow
  layerOf: number[];
  width: number[];
  virtual: boolean[];
  segs: Seg[];
  up: number[][];                  // per vertex: segments coming from the layer above
  down: number[][];                // per vertex: segments going to the layer below
  edgeSegs: Map<number, number[]>; // edge → its segments, top to bottom
  layers: number[][];              // vertices per layer, left → right
  pos: number[];                   // index of a vertex inside its layer
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Switch case handle id - mirrors LogicNode (nodes/WorkflowNodes.tsx): `c[1] || c.label || String(i)`. */
function switchCaseHandleId(c: any, i: number): string {
  const id = c === null || c === undefined ? undefined : c[1] || c.label;
  return id ? String(id) : String(i);
}

/** Other spellings seen in saved workflows / templates for the same case. */
function switchCaseAliases(c: any, i: number): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (v !== undefined && v !== null && v !== '') out.push(String(v)); };
  if (Array.isArray(c)) { add(c[1]); add(c[0]); }
  else if (c && typeof c === 'object') { add(c.label); add(c.match); add(c.value); }
  else add(c);
  out.push(`case-${i}`, `case_${i}`, `case${i}`, String(i));
  return out;
}

/** Source handles as rendered by LogicNode; other cards have one handle in the middle. */
function handlePorts(type: string, config: any, w: number): PortDef[] | null {
  if (type === 'logic.if') {
    return [
      { id: 'true', frac: 0.3, aliases: [] },
      { id: 'false', frac: 0.7, aliases: [] },
    ];
  }
  if (type === 'logic.switch') {
    const cases: any[] = Array.isArray(config?.cases) ? config.cases : [];
    const ports: PortDef[] = cases.map((c, i) => ({
      id: switchCaseHandleId(c, i),
      frac: (i + 1) / (cases.length + 2),
      aliases: switchCaseAliases(c, i),
    }));
    ports.push({
      id: String(config?.defaultLabel || 'default'),
      frac: Math.min(1, Math.max(0.5, (w - SWITCH_DEFAULT_INSET) / w)),
      aliases: ['default'],
    });
    return ports;
  }
  return null;
}

function resolvePort(node: GNode, handle: string | null | undefined): Port {
  const ports = node.ports;
  if (!ports) return { order: 0, frac: 0.5 };
  // React Flow attaches an edge without a handle id to the first source handle.
  if (handle === undefined || handle === null || handle === '') return { order: 0, frac: ports[0].frac };
  const h = String(handle);
  let i = ports.findIndex(p => p.id === h);
  if (i < 0) i = ports.findIndex(p => p.aliases.includes(h));
  return i >= 0 ? { order: i, frac: ports[i].frac } : { order: ports.length, frac: 0.5 };
}

function weakComponents(n: number, links: GLink[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const l of links) { adj[l.s].push(l.t); adj[l.t].push(l.s); }
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const members = [i];
    for (let k = 0; k < members.length; k++) {
      for (const j of adj[members[k]]) {
        if (!seen[j]) { seen[j] = 1; members.push(j); }
      }
    }
    out.push(members.sort((a, b) => a - b));
  }
  return out;
}

/** Lays out one connected component; returns top-left positions in member order. */
function layoutComponent(graph: GNode[], members: number[], links: GLink[]): { x: number[]; y: number[] } {
  const localOf = new Map<number, number>();
  members.forEach((g, k) => localOf.set(g, k));
  const nodes = members.map(g => graph[g]);
  const edges: GLink[] = [];
  for (const l of links) {
    const s = localOf.get(l.s);
    const t = localOf.get(l.t);
    if (s !== undefined && t !== undefined) edges.push({ s, t, port: l.port });
  }

  const back = backEdges(nodes, edges);                                  // 2
  const dag = edges.map((_, i) => i).filter(i => !back[i]);
  const layer = assignLayers(nodes.length, edges, dag);                  // 3
  const lg = buildLayeredGraph(nodes, edges, dag, layer);                // 4
  orderLayers(lg, nodes, edges);
  const layerY = layerTops(lg, nodes);                                   // 6
  const cx = placeX(lg, nodes, edges, dag, layer, layerY);               // 5

  return {
    x: nodes.map((node, k) => cx[k] - node.w / 2),
    y: nodes.map((_, k) => layerY[layer[k]]),
  };
}

/** Child order: handle order, then the target's current x (then y, index). */
function childOrder(nodes: GNode[], edges: GLink[]) {
  return (a: number, b: number) => {
    const ta = nodes[edges[a].t];
    const tb = nodes[edges[b].t];
    return edges[a].port.order - edges[b].port.order
      || ta.x - tb.x || ta.y - tb.y || edges[a].t - edges[b].t || a - b;
  };
}

/** 2. DFS from the sources (triggers first, then top-most, left-most); marks back edges. */
function backEdges(nodes: GNode[], edges: GLink[]): Uint8Array {
  const n = nodes.length;
  const out: number[][] = nodes.map(() => []);
  const indeg = new Array<number>(n).fill(0);
  edges.forEach((e, i) => { out[e.s].push(i); indeg[e.t]++; });
  const byChild = childOrder(nodes, edges);
  out.forEach(list => list.sort(byChild));

  const startOrder = (a: number, b: number) => Number(nodes[b].trigger) - Number(nodes[a].trigger)
    || nodes[a].y - nodes[b].y || nodes[a].x - nodes[b].x || a - b;
  const all = nodes.map((_, i) => i);
  // Sources first; the full list afterwards catches cycles that have no source at all.
  const starts = all.filter(v => indeg[v] === 0).sort(startOrder).concat(all.slice().sort(startOrder));

  const state = new Uint8Array(n); // 0 = new, 1 = on the DFS stack, 2 = done
  const back = new Uint8Array(edges.length);
  for (const start of starts) {
    if (state[start]) continue;
    state[start] = 1;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const v = top[0];
      if (top[1] < out[v].length) {
        const ei = out[v][top[1]++];
        const w = edges[ei].t;
        if (state[w] === 1) back[ei] = 1;
        else if (state[w] === 0) { state[w] = 1; stack.push([w, 0]); }
      } else {
        state[v] = 2;
        stack.pop();
      }
    }
  }
  return back;
}

/** 3. Longest path from the sources; then sources move down next to their shallowest child. */
function assignLayers(n: number, edges: GLink[], dag: number[]): number[] {
  const out: number[][] = Array.from({ length: n }, () => []);
  const pending = new Array<number>(n).fill(0);
  for (const i of dag) { out[edges[i].s].push(i); pending[edges[i].t]++; }
  const isSource = pending.map(c => c === 0);
  const layer = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (pending[v] === 0) queue.push(v);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const i of out[v]) {
      const w = edges[i].t;
      if (layer[v] + 1 > layer[w]) layer[w] = layer[v] + 1;
      if (--pending[w] === 0) queue.push(w);
    }
  }
  for (let v = 0; v < n; v++) {
    if (!isSource[v] || !out[v].length) continue;
    let shallowest = Infinity;
    for (const i of out[v]) shallowest = Math.min(shallowest, layer[edges[i].t]);
    layer[v] = shallowest - 1;
  }
  return layer;
}

/** 4a. Splits edges spanning several layers into segments through virtual vertices. */
function buildLayeredGraph(nodes: GNode[], edges: GLink[], dag: number[], layer: number[]): LayeredGraph {
  const layerOf = layer.slice();
  const width = nodes.map(node => node.w);
  const virtual = nodes.map(() => false);
  const segs: Seg[] = [];
  const edgeSegs = new Map<number, number[]>();
  for (const i of dag) {
    const e = edges[i];
    const list: number[] = [];
    let u = e.s;
    for (let l = layer[e.s] + 1; l <= layer[e.t]; l++) {
      let v = e.t;
      if (l < layer[e.t]) {
        v = layerOf.length;
        layerOf.push(l);
        width.push(0);
        virtual.push(true);
      }
      const first = u === e.s;
      segs.push({
        u,
        v,
        frac: first ? e.port.frac : 0.5,
        order: first ? e.port.order : 0,
        off: first ? (e.port.frac - 0.5) * nodes[e.s].w : 0,
        edge: i,
      });
      list.push(segs.length - 1);
      u = v;
    }
    edgeSegs.set(i, list);
  }
  const count = layerOf.length;
  const up: number[][] = Array.from({ length: count }, () => []);
  const down: number[][] = Array.from({ length: count }, () => []);
  segs.forEach((s, i) => { down[s.u].push(i); up[s.v].push(i); });
  const depth = layerOf.reduce((m, l) => Math.max(m, l), 0) + 1;
  return {
    n: nodes.length,
    layerOf,
    width,
    virtual,
    segs,
    up,
    down,
    edgeSegs,
    layers: Array.from({ length: depth }, () => []),
    pos: new Array<number>(count).fill(0),
  };
}

/** 4b. Order inside each layer: DFS in handle order, barycenter sweeps, adjacent swaps. */
function orderLayers(lg: LayeredGraph, nodes: GNode[], edges: GLink[]): void {
  const { segs, up, down, layerOf, layers, pos } = lg;
  const count = layerOf.length;

  // Initial order: pre-order DFS from the sources, children in handle order / current x.
  const byChild = childOrder(nodes, edges);
  const children = down.map(list => list.slice().sort((a, b) => byChild(segs[a].edge, segs[b].edge) || a - b));
  const roots: number[] = [];
  for (let v = 0; v < lg.n; v++) if (!up[v].length) roots.push(v);
  roots.sort((a, b) => Number(nodes[b].trigger) - Number(nodes[a].trigger)
    || nodes[a].x - nodes[b].x || nodes[a].y - nodes[b].y || a - b);
  const seen = new Uint8Array(count);
  const visit = (start: number) => {
    seen[start] = 1;
    layers[layerOf[start]].push(start);
    const stack: [number, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = children[top[0]];
      if (top[1] < list.length) {
        const w = segs[list[top[1]++]].v;
        if (!seen[w]) {
          seen[w] = 1;
          layers[layerOf[w]].push(w);
          stack.push([w, 0]);
        }
      } else {
        stack.pop();
      }
    }
  };
  roots.forEach(r => { if (!seen[r]) visit(r); });
  for (let v = 0; v < count; v++) if (!seen[v]) visit(v); // safety net, unreachable in a DAG

  const reindex = (li: number) => layers[li].forEach((v, i) => { pos[v] = i; });
  layers.forEach((_, li) => reindex(li));

  // Crossings between consecutive layers; the upper end of a segment sits at its handle.
  // Segments sorted by upper end, then inversions of the lower ends (Fenwick tree).
  const crossings = () => {
    let total = 0;
    for (let li = 0; li + 1 < layers.length; li++) {
      const ends: [number, number][] = [];
      for (const v of layers[li]) {
        for (const si of down[v]) ends.push([pos[v] + segs[si].frac, pos[segs[si].v]]);
      }
      ends.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const size = layers[li + 1].length;
      const tree = new Array<number>(size + 1).fill(0);
      ends.forEach(([, b], seen) => {
        let notAbove = 0; // earlier segments whose lower end is at or left of b
        for (let i = b + 1; i > 0; i -= i & -i) notAbove += tree[i];
        total += seen - notAbove;
        for (let i = b + 1; i <= size; i += i & -i) tree[i]++;
      });
    }
    return total;
  };

  // Barycenter of a vertex w.r.t. the neighbouring layer (handle-aware); vertices without
  // neighbours there keep their slot.
  const sortLayer = (li: number, fromAbove: boolean) => {
    const layer = layers[li];
    const slots: (number | undefined)[] = new Array(layer.length);
    const movable: { v: number; bc: number; i: number }[] = [];
    layer.forEach((v, i) => {
      const list = fromAbove ? up[v] : down[v];
      if (!list.length) { slots[i] = v; return; }
      let sum = 0;
      for (const si of list) {
        const s = segs[si];
        sum += fromAbove ? pos[s.u] + s.frac - 0.5 : pos[s.v] - (s.frac - 0.5);
      }
      movable.push({ v, bc: sum / list.length, i });
    });
    movable.sort((p, q) => p.bc - q.bc || p.i - q.i);
    let k = 0;
    for (let i = 0; i < slots.length; i++) if (slots[i] === undefined) slots[i] = movable[k++].v;
    layers[li] = slots as number[];
    reindex(li);
  };

  let best = layers.map(l => l.slice());
  let bestCrossings = crossings();
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep++) {
    if (sweep % 2 === 0) for (let li = 1; li < layers.length; li++) sortLayer(li, true);
    else for (let li = layers.length - 2; li >= 0; li--) sortLayer(li, false);
    const c = crossings();
    if (c < bestCrossings) { bestCrossings = c; best = layers.map(l => l.slice()); }
  }
  best.forEach((l, li) => { layers[li] = l; reindex(li); });
  if (bestCrossings === 0) return;

  // Adjacent swaps while they strictly remove crossings (handle order breaks ties).
  const pairCrossings = (left: number, right: number) => {
    let c = 0;
    for (const s1 of up[left]) {
      for (const s2 of up[right]) {
        if (pos[segs[s1].u] + segs[s1].frac > pos[segs[s2].u] + segs[s2].frac) c++;
      }
    }
    for (const s1 of down[left]) {
      for (const s2 of down[right]) if (pos[segs[s1].v] > pos[segs[s2].v]) c++;
    }
    return c;
  };
  for (let round = 0; round < TRANSPOSE_ROUNDS; round++) {
    let improved = false;
    for (const layer of layers) {
      for (let i = 0; i + 1 < layer.length; i++) {
        const a = layer[i];
        const b = layer[i + 1];
        if (pairCrossings(b, a) < pairCrossings(a, b)) {
          layer[i] = b;
          layer[i + 1] = a;
          pos[b] = i;
          pos[a] = i + 1;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

/** 6. Top y of every layer (cards are top-aligned inside their layer). */
function layerTops(lg: LayeredGraph, nodes: GNode[]): number[] {
  const depth = lg.layers.length;
  const height = new Array<number>(depth).fill(0);
  const branching = new Array<boolean>(depth).fill(false);
  for (let v = 0; v < lg.n; v++) {
    const l = lg.layerOf[v];
    height[l] = Math.max(height[l], nodes[v].h);
    if (nodes[v].branching) branching[l] = true;
  }
  const top = new Array<number>(depth).fill(0);
  for (let l = 1; l < depth; l++) {
    top[l] = top[l - 1] + height[l - 1] + S.layerGap + (branching[l - 1] ? S.branchLabelGap : 0);
  }
  return top;
}

/**
 * Fallback combinations of the four BK runs (top-down left/right, bottom-up left/right) tried when
 * the balanced placement still lets an edge cut through a card. Any average of runs keeps the
 * minimum gaps (each run does). [runs, penalty]: the balanced median of all four is preferred.
 */
const RUN_MIXES: [number[], number][] = [
  [[0, 1, 2, 3], 0],
  [[0, 1], 1],
  [[2, 3], 1],
  [[0], 2],
  [[1], 2],
  [[2], 2],
  [[3], 2],
];

/**
 * 5. Centre x of every vertex. Runs Brandes–Köpf; long edges whose rendered bezier would cross
 * a card get straightened and the placement is recomputed (a few rounds). The placement with the
 * fewest edges cutting through cards wins (the balanced one on ties).
 */
function placeX(
  lg: LayeredGraph, nodes: GNode[], edges: GLink[], dag: number[], layer: number[], layerY: number[],
): number[] {
  const base = innerSegmentConflicts(lg);
  const straight = new Set<number>();
  if (lg.segs.length > STRAIGHTEN_MAX_SEGMENTS) { // huge graph: plain balanced BK, keep it fast
    return combineRuns(brandesKoepfRuns(lg, alignmentRules(lg, base, straight)), RUN_MIXES[0][0]);
  }
  const rows = cardRows(lg, nodes, layerY);
  let best: number[] = [];
  let bestScore = Infinity;
  for (let round = 0; round <= STRAIGHTEN_ROUNDS && bestScore > 0; round++) {
    const runs = brandesKoepfRuns(lg, alignmentRules(lg, base, straight));
    let hits: number[] = [];
    for (const [mix, penalty] of RUN_MIXES) {
      const cx = combineRuns(runs, mix);
      const cut = edgesCuttingCards(nodes, edges, dag, layer, rows, cx);
      if (!penalty) hits = cut;
      const score = cut.length * RUN_MIXES.length + penalty;
      if (score < bestScore) { best = cx; bestScore = score; }
      if (!cut.length) break; // later mixes are only fallbacks
    }
    const fresh = hits.filter(i => !straight.has(i));
    if (!fresh.length) break;
    fresh.forEach(i => straight.add(i));
  }
  return best;
}

const segKey = (u: number, v: number, count: number) => u * count + v;

/** Type-1 conflicts: a non-inner segment crossing an inner (virtual → virtual) one is not aligned. */
function innerSegmentConflicts(lg: LayeredGraph): Set<number> {
  const { layers, pos, up, segs, virtual } = lg;
  const count = lg.layerOf.length;
  const conflicts = new Set<number>();
  const innerUpper = (v: number) => {
    if (!virtual[v]) return -1;
    for (const si of up[v]) if (virtual[segs[si].u]) return segs[si].u;
    return -1;
  };
  for (let li = 1; li < layers.length; li++) {
    const prevLength = layers[li - 1].length;
    const layer = layers[li];
    let k0 = 0;
    let scan = 0;
    for (let i = 0; i < layer.length; i++) {
      const w = innerUpper(layer[i]);
      if (w < 0 && i !== layer.length - 1) continue;
      const k1 = w >= 0 ? pos[w] : prevLength;
      for (let j = scan; j <= i; j++) {
        const v = layer[j];
        for (const si of up[v]) {
          const u = segs[si].u;
          if ((pos[u] < k0 || pos[u] > k1) && !(virtual[u] && virtual[v])) conflicts.add(segKey(u, v, count));
        }
      }
      scan = i + 1;
      k0 = k1;
    }
  }
  return conflicts;
}

interface AlignmentRules {
  /** segKey(u, v) of segments that must not be used for a vertical alignment. */
  conflicts: Set<number>;
  /** Vertex → the only segments it may align with, upwards / downwards (straightened edges). */
  onlyUp: Map<number, Set<number>>;
  onlyDown: Map<number, Set<number>>;
}

/**
 * Straightened edges: both end cards must align with the edge's lane in all four BK runs, so
 * the lane is their only alignment candidate, every other alignment at those cards is a conflict
 * (otherwise a sibling could take the card first) and so is every segment crossing the edge (an
 * alignment there would block the edge's own, like BK's type-1 conflicts do for inner segments).
 */
function alignmentRules(lg: LayeredGraph, base: Set<number>, straight: Set<number>): AlignmentRules {
  const onlyUp = new Map<number, Set<number>>();
  const onlyDown = new Map<number, Set<number>>();
  if (!straight.size) return { conflicts: base, onlyUp, onlyDown };
  const { segs, pos, layerOf } = lg;
  const count = layerOf.length;
  const keep = (map: Map<number, Set<number>>, v: number, si: number) => {
    if (!map.has(v)) map.set(v, new Set());
    map.get(v)!.add(si);
  };
  const lane = new Set<number>();
  for (const ei of straight) {
    const list = lg.edgeSegs.get(ei);
    if (!list || list.length < 2) continue;
    keep(onlyDown, segs[list[0]].u, list[0]);
    keep(onlyUp, segs[list[list.length - 1]].v, list[list.length - 1]);
    list.forEach(si => lane.add(si));
  }
  const conflicts = new Set(base);
  const forbid = (si: number) => conflicts.add(segKey(segs[si].u, segs[si].v, count));
  onlyDown.forEach((kept, v) => { for (const si of lg.down[v]) if (!kept.has(si)) forbid(si); });
  onlyUp.forEach((kept, v) => { for (const si of lg.up[v]) if (!kept.has(si)) forbid(si); });

  const byLayer: number[][] = lg.layers.map(() => []);
  segs.forEach((s, si) => { if (!lane.has(si)) byLayer[layerOf[s.u]].push(si); });
  const anchor = (si: number) => pos[segs[si].u] + segs[si].frac;
  lane.forEach(si => {
    for (const sj of byLayer[layerOf[segs[si].u]]) {
      if ((anchor(si) - anchor(sj)) * (pos[segs[si].v] - pos[segs[sj].v]) < 0) forbid(sj);
    }
  });
  return { conflicts, onlyUp, onlyDown };
}

/**
 * The four BK runs: [top-down, left], [top-down, right], [bottom-up, left], [bottom-up, right],
 * each shifted onto the narrowest one.
 */
function brandesKoepfRuns(lg: LayeredGraph, rules: AlignmentRules): number[][] {
  const count = lg.layerOf.length;
  const runs = [
    bkRun(lg, rules, true, true),
    bkRun(lg, rules, true, false),
    bkRun(lg, rules, false, true),
    bkRun(lg, rules, false, false),
  ];
  const extents = runs.map(xs => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v < count; v++) {
      lo = Math.min(lo, xs[v] - lg.width[v] / 2);
      hi = Math.max(hi, xs[v] + lg.width[v] / 2);
    }
    return [lo, hi];
  });
  let ref = 0;
  for (let r = 1; r < runs.length; r++) {
    if (extents[r][1] - extents[r][0] < extents[ref][1] - extents[ref][0]) ref = r;
  }
  runs.forEach((xs, r) => {
    // Left-packed runs share the left edge of the reference, right-packed runs its right edge.
    const delta = r % 2 === 0 ? extents[ref][0] - extents[r][0] : extents[ref][1] - extents[r][1];
    for (let v = 0; v < count; v++) xs[v] += delta;
  });
  return runs;
}

/** Per vertex: median of the chosen runs (mean of the two middle values; BK "balanced" for all four). */
function combineRuns(runs: number[][], mix: number[]): number[] {
  const count = runs[0].length;
  const lo = Math.floor((mix.length - 1) / 2);
  const hi = Math.ceil((mix.length - 1) / 2);
  const out = new Array<number>(count);
  for (let v = 0; v < count; v++) {
    const xs = mix.map(r => runs[r][v]).sort((a, b) => a - b);
    out[v] = (xs[lo] + xs[hi]) / 2;
  }
  return out;
}

/**
 * One BK run. topDown: align with upper neighbours (else lower); leftToRight: scan direction
 * (right-to-left runs work in a mirrored space). Inside a block a vertex keeps an offset from
 * the block root, so a child lines up under the exact handle it hangs from.
 */
function bkRun(lg: LayeredGraph, rules: AlignmentRules, topDown: boolean, leftToRight: boolean): number[] {
  const { segs, width, virtual } = lg;
  const { conflicts } = rules;
  const count = lg.layerOf.length;
  const sign = leftToRight ? 1 : -1;
  const layers = lg.layers.map(l => (leftToRight ? l.slice() : l.slice().reverse()));
  if (!topDown) layers.reverse();
  const p = new Array<number>(count).fill(0);
  layers.forEach(l => l.forEach((v, i) => { p[v] = i; }));

  // Vertical alignment.
  const root = Array.from({ length: count }, (_, v) => v);
  const rel = new Array<number>(count).fill(0);
  const aligned = new Uint8Array(count);
  const other = (si: number) => (topDown ? segs[si].u : segs[si].v);
  const only = topDown ? rules.onlyUp : rules.onlyDown;
  for (const layer of layers) {
    let prevIdx = -1;
    for (const v of layer) {
      const kept = only.get(v);
      const list = kept ? [...kept] : topDown ? lg.up[v] : lg.down[v];
      if (!list.length) continue;
      const sorted = list.slice().sort((a, b) => p[other(a)] - p[other(b)] || sign * (segs[a].off - segs[b].off) || a - b);
      const mid = (sorted.length - 1) / 2;
      for (let i = Math.floor(mid); i <= Math.ceil(mid); i++) {
        const si = sorted[i];
        const w = other(si);
        if (!aligned[v] && prevIdx < p[w] && !conflicts.has(segKey(segs[si].u, segs[si].v, count))) {
          aligned[v] = 1;
          root[v] = root[w];
          const off = sign * segs[si].off;
          rel[v] = topDown ? rel[w] + off : rel[w] - off;
          prevIdx = p[w];
        }
      }
    }
  }

  // Horizontal compaction on the block graph (two passes, as in dagre).
  const separation = (a: number, b: number) => {
    const gap = virtual[a] && virtual[b] ? S.laneLaneGap : virtual[a] || virtual[b] ? S.laneGap : S.nodeGap;
    return (width[a] + width[b]) / 2 + gap;
  };
  const roots: number[] = [];
  for (const layer of layers) for (const v of layer) if (root[v] === v) roots.push(v);
  const preds = new Map<number, Map<number, number>>();
  const succs = new Map<number, Map<number, number>>();
  roots.forEach(r => { preds.set(r, new Map()); succs.set(r, new Map()); });
  for (const layer of layers) {
    for (let i = 1; i < layer.length; i++) {
      const a = layer[i - 1];
      const b = layer[i];
      const weight = separation(a, b) + rel[a] - rel[b];
      const ra = root[a];
      const rb = root[b];
      const current = succs.get(ra)!.get(rb);
      if (current === undefined || weight > current) {
        succs.get(ra)!.set(rb, weight);
        preds.get(rb)!.set(ra, weight);
      }
    }
  }
  const pending = new Map<number, number>();
  roots.forEach(r => pending.set(r, preds.get(r)!.size));
  const topo = roots.filter(r => pending.get(r) === 0);
  for (let q = 0; q < topo.length; q++) {
    succs.get(topo[q])!.forEach((_, s) => {
      const left = pending.get(s)! - 1;
      pending.set(s, left);
      if (left === 0) topo.push(s);
    });
  }
  if (topo.length < roots.length) { // safety net, the block graph is acyclic
    const done = new Set(topo);
    roots.forEach(r => { if (!done.has(r)) topo.push(r); });
  }
  const xs = new Map<number, number>();
  for (const r of topo) {
    let x = 0;
    let first = true;
    preds.get(r)!.forEach((weight, pr) => {
      const candidate = (xs.get(pr) ?? 0) + weight;
      if (first || candidate > x) { x = candidate; first = false; }
    });
    xs.set(r, x);
  }
  for (let q = topo.length - 1; q >= 0; q--) {
    const r = topo[q];
    let limit = Infinity;
    succs.get(r)!.forEach((weight, s) => { limit = Math.min(limit, xs.get(s)! - weight); });
    if (limit !== Infinity && limit > xs.get(r)!) xs.set(r, limit);
  }

  const out = new Array<number>(count);
  for (let v = 0; v < count; v++) out[v] = sign * (xs.get(root[v])! + rel[v]);
  return out;
}

/** Cards per layer, for the edge / card intersection test. */
interface CardRows {
  top: number[];      // top y of every layer
  bottom: number[];   // bottom y of the tallest card of every layer
  cards: number[][];  // real vertices of every layer
}

function cardRows(lg: LayeredGraph, nodes: GNode[], layerY: number[]): CardRows {
  const cards = lg.layers.map(l => l.filter(v => v < lg.n));
  const bottom = cards.map((list, l) => list.reduce((m, v) => Math.max(m, layerY[l] + nodes[v].h), layerY[l]));
  return { top: layerY, bottom, cards };
}

/**
 * Long edges whose bezier (drawn by React Flow straight from handle to handle, see
 * getBezierPath: both control points at mid height) passes through a card of a layer in between.
 */
function edgesCuttingCards(
  nodes: GNode[], edges: GLink[], dag: number[], layer: number[], rows: CardRows, cx: number[],
): number[] {
  const hits: number[] = [];
  for (const i of dag) {
    const e = edges[i];
    const ls = layer[e.s];
    const lt = layer[e.t];
    if (lt - ls < 2) continue;
    const sx = cx[e.s] + (e.port.frac - 0.5) * nodes[e.s].w;
    const sy = rows.top[ls] + nodes[e.s].h;
    const tx = cx[e.t];
    const ty = rows.top[lt];
    const my = (sy + ty) / 2;
    const samples = CURVE_SAMPLES_PER_LAYER * (lt - ls);
    let l = ls + 1;
    let hit = false;
    // y grows monotonically along the curve, so the layer being crossed only moves down.
    for (let k = 1; k < samples && !hit; k++) {
      const t = k / samples;
      const r = 1 - t;
      const y = r * r * r * sy + 3 * r * t * my + t * t * t * ty;
      while (l < lt && y > rows.bottom[l] + CURVE_MARGIN) l++;
      if (l >= lt) break;
      if (y < rows.top[l] - CURVE_MARGIN) continue;
      const x = (r * r * r + 3 * r * r * t) * sx + (3 * r * t * t + t * t * t) * tx;
      for (const v of rows.cards[l]) {
        if (Math.abs(x - cx[v]) < nodes[v].w / 2 + CURVE_MARGIN && y < rows.top[l] + nodes[v].h + CURVE_MARGIN) {
          hit = true;
          break;
        }
      }
    }
    if (hit) hits.push(i);
  }
  return hits;
}
