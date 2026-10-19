/**
 * Sticker động Telegram (.tgs = Lottie JSON nén gzip). Giữ chuỗi JSON đã giải nén của vài chục file gần nhất — rê chuột
 * qua lại trong lưới không tải + giải nén lại. Trả về CHUỖI: lottie-web sửa trực tiếp object animationData, mỗi lần dựng
 * phải JSON.parse bản mới.
 */
const MAX_CACHED = 40;
const cache = new Map<string, Promise<string>>();

/** Giải nén gzip → chuỗi (DecompressionStream của Chromium). Dùng chung: .tgs, tin zinstant v2 của Zalo OA. */
export async function gunzipToText(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function loadTgsJson(url: string): Promise<string> {
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    cache.set(url, cached);
    return cached;
  }
  const request = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`TGS ${response.status}`);
    const data = await response.arrayBuffer();
    const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
    // Một số file .tgs là JSON thô (không nén)
    return head[0] === 0x1f && head[1] === 0x8b ? gunzipToText(data) : new TextDecoder().decode(data);
  })();
  request.catch(() => { if (cache.get(url) === request) cache.delete(url); });
  cache.set(url, request);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return request;
}
