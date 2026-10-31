/**
 * mediaDims.ts — kích thước ảnh trong tin nhắn để vẽ khung đúng tỉ lệ NGAY từ đầu (như Telegram):
 * không cần khung soạn sẵn cố định, ảnh tải xong không làm nhảy layout → cuộn không giật.
 *
 * Nguồn kích thước, theo thứ tự:
 *   1. Đã đo lần trước (naturalWidth/Height sau khi ảnh tải) — cache LRU, lưu localStorage.
 *   2. Metadata của tin: Telegram/Facebook `attachments[i].width/height`, Zalo `content.params.width/height`.
 * Không có cả hai → component dùng khung tạm, đo khi ảnh tải xong rồi nhớ lại cho lần sau (chỉ lệch 1 lần).
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
    /* localStorage hỏng / bị chặn → chỉ dùng cache trong phiên */
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
      /* quota → bỏ qua */
    }
  }, 1500);
}

/** msg_id Telegram không duy nhất theo tài khoản → khoá gồm cả thread. */
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

/** Kích thước lấy từ metadata của tin (không đo). */
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

/** Kích thước đã biết: đo trước đó (chính xác nhất) hoặc từ metadata. */
export function getKnownDims(msg: any, index = 0): MediaDims | null {
  if (!msg) return null;
  return ensureCache().get(keyOf(msg, index)) || getMetaDims(msg, index);
}

/** Ghi lại kích thước thật sau khi ảnh tải xong (onLoad). */
export function rememberDims(msg: any, w: number, h: number, index = 0): void {
  if (!(w > 0 && h > 0) || !msg?.msg_id) return;
  const c = ensureCache();
  const key = keyOf(msg, index);
  const prev = c.get(key);
  if (prev && prev.w === w && prev.h === h) return;
  c.delete(key); // đưa xuống cuối = mới dùng gần nhất
  c.set(key, { w, h });
  scheduleSave();
}

/** Tỉ lệ khác nhau đáng kể (> 2%)? */
export function ratioDiffers(a: MediaDims | null | undefined, b: MediaDims): boolean {
  if (!a) return true;
  return Math.abs(a.w / a.h - b.w / b.h) > 0.02 * (b.w / b.h);
}

/**
 * Khung hiển thị: thu vào tối đa maxW × maxH giữ tỉ lệ, ảnh nhỏ phóng tối đa 2 lần,
 * ảnh quá dẹt / quá cao được kẹp min (phần thừa cắt bằng object-cover, xem đầy đủ trong viewer).
 */
export function fitMediaBox(
  d: MediaDims,
  opts: { maxW?: number; maxH?: number; minW?: number; minH?: number } = {},
): MediaBox {
  const maxW = opts.maxW ?? 320;
  const maxH = opts.maxH ?? 360;
  const minW = opts.minW ?? 96;
  const minH = opts.minH ?? 64;
  const scale = Math.min(maxW / d.w, maxH / d.h, 2);
  return {
    width: Math.max(minW, Math.min(maxW, Math.round(d.w * scale))),
    height: Math.max(minH, Math.min(maxH, Math.round(d.h * scale))),
  };
}
