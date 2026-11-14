/**
 * Animated Telegram sticker (.tgs = gzip-compressed Lottie JSON). Keeps the decompressed JSON strings of the last few dozen files, so moving the mouse back and forth
 * over the grid does not download and decompress again. Returns a STRING: lottie-web modifies the animationData object in place, so each render
 * must JSON.parse a fresh copy.
 */
const MAX_CACHED = 40;
const cache = new Map<string, Promise<string>>();

/** Gzip decompress → string (Chromium's DecompressionStream). Shared by: .tgs and Zalo OA zinstant v2 messages. */
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
    // Some .tgs files are raw JSON (not compressed)
    return head[0] === 0x1f && head[1] === 0x8b ? gunzipToText(data) : new TextDecoder().decode(data);
  })();
  request.catch(() => { if (cache.get(url) === request) cache.delete(url); });
  cache.set(url, request);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return request;
}
