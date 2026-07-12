/**
 * videoUtils.ts - Video thumbnail extraction utility
 * Dùng chung cho MessageInput và các component khác.
 */

/**
 * Dùng HTMLVideoElement + Canvas để capture frame video làm thumbnail.
 * Trả về base64 JPEG data URL, hoặc '' nếu thất bại.
 */
export async function extractVideoThumbViaCanvas(videoPath: string, seekSec = 1): Promise<string> {
  // Helper: capture frame từ video element tại currentTime
  const captureFrame = (vid: HTMLVideoElement): string => {
    const canvas = document.createElement('canvas');
    const maxW = 480;
    const vw = vid.videoWidth || 480;
    const vh = vid.videoHeight || 270;
    const ratio = maxW / vw;
    canvas.width = maxW;
    canvas.height = Math.round(vh * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
    // Kiểm tra frame có phải toàn đen không (sample 20x20 pixel ở giữa)
    try {
      const cx = Math.floor(canvas.width / 2) - 10;
      const cy = Math.floor(canvas.height / 2) - 10;
      const id = ctx.getImageData(cx, cy, 20, 20);
      const allBlack = Array.from(id.data).every((v, i) => i % 4 === 3 || v < 15);
      if (allBlack) return '__BLACK__';
    } catch { /* ignore */ }
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const loadAndSeek = (src: string, t: number): Promise<string> =>
    new Promise((resolve) => {
      const vid = document.createElement('video');
      vid.muted = true;
      vid.preload = 'metadata';
      vid.src = src;
      let resolved = false;
      const done = (val: string) => { if (!resolved) { resolved = true; vid.src = ''; resolve(val); } };
      vid.onerror = () => done('');
      vid.onloadedmetadata = () => {
        // Clamp seek time to [0, duration-0.1]
        vid.currentTime = Math.max(0, Math.min(t, (vid.duration || 1) - 0.1));
      };
      vid.onseeked = () => { done(captureFrame(vid)); };
      // Timeout 8s
      setTimeout(() => done(''), 8000);
      vid.load();
    });

  const fileUrl = videoPath.startsWith('file://')
    ? videoPath
    : `file:///${videoPath.replace(/\\/g, '/')}`;

  // Thử seek tại seekSec trước
  let result = await loadAndSeek(fileUrl, seekSec);
  // Nếu frame đen và seekSec > 0, thử lại tại 0s
  if ((result === '__BLACK__' || result === '') && seekSec > 0) {
    result = await loadAndSeek(fileUrl, 0);
  }
  return result === '__BLACK__' ? '' : (result || '');
}
