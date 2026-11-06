/**
 * CSP của giao diện Deplao bản cài (bản dev chạy Vite ở http://localhost:27799, không gắn header này).
 *
 *  - frame-src có `deplao-plugin:`: trang ứng dụng (plugin) chạy trong iframe deplao-plugin://<id>. Thiếu thì bản cài
 *    chặn khung ứng dụng (trang trắng) dù bản dev vẫn chạy.
 *  - Chỉ gắn cho nội dung của chính Deplao. Trang web dùng chung session (trình duyệt nội bộ, cửa sổ mở bằng window.open,
 *    mini app Telegram, khung https nhúng trong chat) giữ nguyên như bản dev: `script-src 'self'` của app chặn script
 *    inline và CDN nên các trang đó không chạy được.
 *  - Phản hồi của deplao-plugin:// giữ nguyên CSP riêng của nó (PluginProtocol.buildCsp: chặt hơn, theo quyền của ứng
 *    dụng); ghi đè bằng CSP của app sẽ nới connect-src / img-src cho ứng dụng.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // img-src và media-src phải có https: để load ảnh/video từ CDN Zalo
  "img-src 'self' data: local-media: blob: https: http:",
  "media-src 'self' local-media: blob: https: http:",
  "connect-src 'self' https: http: wss:",
  "font-src 'self' data: https:",
  "frame-src 'self' https: deplao-plugin:",
].join('; ') + ';';

/** Phần cần dùng của details trong session.webRequest.onHeadersReceived. */
export interface CspResponseDetails {
  url: string;
  resourceType?: string;
  webContentsId?: number;
  responseHeaders?: Record<string, string | string[]>;
}

/** Nội dung của chính Deplao: giao diện bản cài + file đi kèm (file://) và file trên máy (local-media://). */
const OWN_CONTENT_RE = /^(file|local-media):/i;

/**
 * Header trả về cho onHeadersReceived; null = giữ nguyên phản hồi.
 * Gắn CSP của app cho nội dung của Deplao và cho trang chính của cửa sổ chính (kể cả khi lỡ điều hướng ra web), không
 * gắn cho trang web ở cửa sổ khác hay khung https nhúng.
 */
export function rendererCspHeaders(
  details: CspResponseDetails,
  mainWebContentsId: number | null,
): Record<string, string | string[]> | null {
  const url = String(details.url || '');
  if (/^deplao-plugin:/i.test(url)) return null;
  const mainPage = details.resourceType === 'mainFrame'
    && mainWebContentsId != null
    && details.webContentsId === mainWebContentsId;
  if (!OWN_CONTENT_RE.test(url) && !mainPage) return null;
  return { ...(details.responseHeaders || {}), 'Content-Security-Policy': [RENDERER_CSP] };
}
