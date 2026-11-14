/**
 * mediaDims.ts: image sizes in messages, to draw the frame at the right ratio RIGHT from the start (like Telegram):
 * no fixed placeholder frame is needed, and the layout does not jump when an image finishes loading → scrolling does not stutter.
 *
 * Sources of the size, in order:
 *   1. Measured last time (naturalWidth/Height after the image loaded): LRU cache, saved to localStorage.
 *   2. The message metadata: Telegram/Facebook `attachments[i].width/height`, Zalo `content.params.width/height`.
 * If neither exists → the component uses a temporary frame, measures it when the image loads and remembers it for next time (it is off only once).
 */

export interface MediaDims {
  w: number;
  h: number;
}

export interface MediaBox {
  width: number;
  height: number;
}

const STORAGE_KEY = 'deplao_media_dims_v1';
const MAX_ENTRIES = 5000;

let cache: Map<string, MediaDims> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureCache(): Map<string, MediaDims> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const rows = JSON.parse(raw) as [string, number, number][];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (Array.isArray(row) && row[1] > 0 && row[2] > 0) cache.set(String(row[0]), { w: row[1], h: row[2] });
        }
      }
    }
  } catch {
    /* localStorage broken / blocked → use the in-session cache only */
  }
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const rows = [...ensureCache().entries()].slice(-MAX_ENTRIES).map(([k, d]) => [k, d.w, d.h]);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {
      /* quota exceeded → skip */
    }
  }, 1500);
}

/** Telegram msg_id is not unique per account → the key includes the thread too. */
function keyOf(msg: any, index: number): string {
  return `${msg?.owner_zalo_id || ''}:${msg?.thread_id || ''}:${msg?.msg_id || ''}:${index}`;
}

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseObj(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Size taken from the message metadata (not measured). */
export function getMetaDims(msg: any, index = 0): MediaDims | null {
  const atts = parseObj(msg?.attachments);
  if (Array.isArray(atts) && atts[index]) {
    const a = atts[index] || {};
    const w = positive(a.width ?? a.w);
    const h = positive(a.height ?? a.h);
    if (w && h) return { w, h };
  }
  const content = parseObj(msg?.content);
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const params = parseObj(content.params) || {};
    const w = positive(params.width ?? params.photo_width ?? content.width);
    const h = positive(params.height ?? params.photo_height ?? content.height);
    if (w && h) return { w, h };
  }
  return null;
}

/** Known size: measured earlier (most accurate) or from the metadata. */
export function getKnownDims(msg: any, index = 0): MediaDims | null {
  if (!msg) return null;
  return ensureCache().get(keyOf(msg, index)) || getMetaDims(msg, index);
}

/** Records the real size after the image has loaded (onLoad). */
export function rememberDims(msg: any, w: number, h: number, index = 0): void {
  if (!(w > 0 && h > 0) || !msg?.msg_id) return;
  const c = ensureCache();
  const key = keyOf(msg, index);
  const prev = c.get(key);
  if (prev && prev.w === w && prev.h === h) return;
  c.delete(key); // move to the end = most recently used
  c.set(key, { w, h });
  scheduleSave();
}

/** Is the ratio noticeably different (> 2%)? */
export function ratioDiffers(a: MediaDims | null | undefined, b: MediaDims): boolean {
  if (!a) return true;
  return Math.abs(a.w / a.h - b.w / b.h) > 0.02 * (b.w / b.h);
}

/**
 * Display frame: fit inside at most maxW × maxH keeping the ratio, small images are enlarged up to 2 times,
 * images that are too flat / too tall are clamped to the min (the excess is cropped with object-cover; see the full image in the viewer).
 */
export function fitMediaBox(
  d: MediaDims,
  opts: { maxW?: number; maxH?: number; minW?: number; minH?: number } = {},
): MediaBox {
  const maxW = opts.maxW ?? MEDIA_MAX_WIDTH;
  const maxH = opts.maxH ?? 360;
  const minW = opts.minW ?? 96;
  const minH = opts.minH ?? 64;
  const scale = Math.min(maxW / d.w, maxH / d.h, 2);
  return {
    width: Math.max(minW, Math.min(maxW, Math.round(d.w * scale))),
    height: Math.max(minH, Math.min(maxH, Math.round(d.h * scale))),
  };
}

/** Maximum image width in the chat (px, does not scale with the font size). */
export const MEDIA_MAX_WIDTH = 320;

/**
 * A photo bubble with a caption is at most as wide as the largest image (20rem = 320px at the default font size), as in Telegram (the same 430px);
 * it follows the font size the user chose but never exceeds 4/3 of the largest image, so a wide image still fills the bubble when the text is very large.
 */
export const CAPTION_BUBBLE_MAX_WIDTH = `min(20rem, ${Math.round((MEDIA_MAX_WIDTH * 4) / 3)}px)`;
/** Narrowest photo bubble with a caption (Telegram historyPhotoBubbleMinWidth). */
export const CAPTION_BUBBLE_MIN_WIDTH = 200;

export interface CaptionMediaLayout {
  /** Height of the image frame. */
  areaHeight: string;
  /** Image width, centered in the frame. */
  photoWidth: string;
  /** Width of the blurred image layer filling both sides: 0 when the image covers the whole frame. */
  fillWidth: string;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Photo frame with a caption, like Telegram Desktop (history_view_photo.cpp: adjustHeightForLessCrop + DecideFrameResize):
 * the bubble is as wide as the caption and does not shrink to a narrow image. The bubble is up to 4/3 of the image (enlarging the image crops no more than 1/4
 * of its height) → the image is enlarged to fill the bubble, and its height follows the ratio; wider than that → the image keeps its size, centered, and the two sides are the image itself
 * blurred.
 *
 * The bubble width is measured by the browser from the text (not measured with JS → no jumping frame), so every value is written in CSS as
 * 100cqw = the bubble width (the frame around the image is the container). "Nếu" (if) is written in CSS: max(0px, (a - b) * 1e6) is 0 when
 * a ≤ b, very large when a > b. The threshold is 0.3px off the browser's 1/64px grid so the width never lands exactly on the threshold.
 */
export function captionMediaLayout(box: MediaBox): CaptionMediaLayout {
  const { width: w, height: h } = box;
  const limit = Math.round((w * 4) / 3) + 0.3;
  const grows = `max(0px, (${limit}px - 100cqw) * 1000000)`;
  const sides = `max(0px, (100cqw - ${limit}px) * 1000000)`;
  return {
    areaHeight: `min(100cqw * ${round4(h / w)}, ${h}px + ${grows})`,
    photoWidth: `min(100cqw, ${w}px + ${grows})`,
    fillWidth: `min(100cqw, ${sides})`,
  };
}
