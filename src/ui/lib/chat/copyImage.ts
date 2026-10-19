/**
 * copyImage.ts - "Copy hình ảnh": put an image on the clipboard directly (no viewer / browser).
 *
 * Reads the bytes in the main process (local file first, then the remote URL - no CORS),
 * falls back to fetching the displayed URL (employee mode: Boss media URL), converts to PNG
 * (the only image type the Clipboard API accepts) and writes it.
 */
import ipc from '@/lib/ipc';

export interface CopyImageSource {
  /** Local file (absolute or storage-relative). */
  localPath?: string;
  /** Remote http(s) URL (Zalo / Facebook CDN). */
  remoteUrl?: string;
  /** URL the app is displaying (local-media://, Boss /api/media/…), last resort. */
  fallbackSrc?: string;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas không khả dụng');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(png => (png ? resolve(png) : reject(new Error('Không chuyển được ảnh sang PNG'))), 'image/png');
  });
}

export async function copyImageToClipboard(source: CopyImageSource): Promise<void> {
  let blob: Blob | null = null;
  // JPEG XL (old Zalo downloads) cannot be decoded by Chromium → use the remote JPG instead
  const localPath = source.localPath && !/\.jxl$/i.test(source.localPath) ? source.localPath : undefined;
  const remoteUrl = source.remoteUrl && /^https?:\/\//i.test(source.remoteUrl) ? source.remoteUrl : undefined;
  if (localPath || remoteUrl) {
    try {
      const result = await ipc.file?.readImageAsBase64({ localPath, remoteUrl });
      if (result?.success && result.base64) blob = base64ToBlob(result.base64, result.mimeType || 'image/jpeg');
    } catch { /* fall back to the displayed URL */ }
  }
  if (!blob && source.fallbackSrc) {
    const response = await fetch(source.fallbackSrc);
    if (response.ok) blob = await response.blob();
  }
  if (!blob) throw new Error('Không tải được ảnh');
  const png = blob.type === 'image/png' ? blob : await toPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
