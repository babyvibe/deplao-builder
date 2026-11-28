/**
 * Images sent as a file (a Telegram document, a Zalo / Facebook file attachment): the file card opens them in the app's photo
 * viewer, like Telegram, instead of the computer's default app (the card's ↗ button still does that).
 */
import type { MediaViewerImage } from '../../../components/chat/media/MediaViewer';

/** Formats Chromium can show; HEIC, TIFF, JPEG XL… stay with the computer's app. */
const VIEWABLE_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const VIEWABLE_IMAGE_MIME = /^image\/(jpe?g|pjpeg|png|gif|webp|bmp|avif)$/i;

/** An image type wins over the name ("x.jpg" sent as image/heic); a generic type (octet-stream) falls back to the extension. */
export function isViewableImageFile(mimeType: string, ext: string): boolean {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime.startsWith('image/')) return VIEWABLE_IMAGE_MIME.test(mime);
  return VIEWABLE_IMAGE_EXT.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

export interface ImageFileSource {
  msg: any;
  /** Display URL of the downloaded copy (local-media://, or the Boss media URL in employee mode). */
  localUrl: string;
  /** Path of the downloaded copy, as stored in local_paths. */
  localPath: string;
  /** Link of the file on the channel (Zalo / Facebook CDN), if any. */
  remoteUrl: string;
  fileName: string;
  mimeType: string;
  ext: string;
}

/**
 * Viewer item for an image file, or null when it should open with the computer's app (not an image Chromium can show, or
 * nothing to show yet). msgId / threadId / timestamp let the viewer page through the other photos of the conversation.
 */
export function imageFileViewerItem(source: ImageFileSource): MediaViewerImage | null {
  if (!isViewableImageFile(source.mimeType, source.ext)) return null;
  const src = source.localUrl || source.remoteUrl;
  if (!src) return null;
  const msg = source.msg || {};
  return {
    src,
    displaySrc: source.localUrl || undefined,
    fallbackSrc: source.localUrl && source.remoteUrl ? source.remoteUrl : undefined,
    localPath: source.localPath || undefined,
    defaultName: source.fileName || undefined,
    msgId: msg.msg_id ? String(msg.msg_id) : undefined,
    threadId: msg.thread_id ? String(msg.thread_id) : undefined,
    timestamp: Number(msg.timestamp) || undefined,
  };
}
