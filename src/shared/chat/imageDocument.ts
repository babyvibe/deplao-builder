/**
 * A document (msg_type 'file') whose file is an ordinary picture: e.g. a screenshot that Telegram sent "as a file" (no compression),
 * which Telegram Desktop does for pasted images. Deplao draws it like a photo in the chat (renderer isMediaType), so it belongs with
 * the photos: the "Ảnh/Video" panel and the photo viewer list it, the "File" panel does not (DB: mediaMessagesQuery builds the same
 * rule in SQL). SVG stays a file: icons / documents, an <img> of them breaks.
 */
import { isTelegramMetaAttachment } from '../telegram/telegramAttachmentTypes';

/** MIME types (prefixes) of a picture document. */
export const IMAGE_DOCUMENT_MIME_PREFIXES: readonly string[] = Object.freeze([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
]);
/** File name endings of a picture document (when the MIME type says nothing). */
export const IMAGE_DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.ico',
]);
/** MIME types of an SVG document (always a file). */
export const SVG_DOCUMENT_MIMES: readonly string[] = Object.freeze(['image/svg+xml', 'image/svg']);

type DocumentFields = { mime_type?: unknown; file_name?: unknown };

/** Attachments as an array (JSON text or array); anything else → []. */
export function attachmentList(attachments: unknown): unknown[] {
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments !== 'string' || !attachments) return [];
  try {
    const parsed = JSON.parse(attachments);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The document of a message: the first attachment that is not Telegram presentation info (forward header, @mention, album, post card). */
export function documentAttachment(attachments: unknown): DocumentFields | null {
  for (const attachment of attachmentList(attachments)) {
    if (attachment && typeof attachment === 'object' && !isTelegramMetaAttachment(attachment)) return attachment as DocumentFields;
  }
  return null;
}

export function isSvgDocumentAttachment(attachment: DocumentFields | null | undefined): boolean {
  if (!attachment) return false;
  const mime = String(attachment.mime_type || '').toLowerCase();
  return String(attachment.file_name || '').toLowerCase().endsWith('.svg') || SVG_DOCUMENT_MIMES.includes(mime);
}

export function isImageDocumentAttachment(attachment: DocumentFields | null | undefined): boolean {
  if (!attachment || isSvgDocumentAttachment(attachment)) return false;
  const mime = String(attachment.mime_type || '').toLowerCase();
  const name = String(attachment.file_name || '').toLowerCase();
  return IMAGE_DOCUMENT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
    || IMAGE_DOCUMENT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** A msg_type 'file' row whose document is a picture (attachments: JSON text or array). */
export function isImageDocumentMessage(msgType: unknown, attachments: unknown): boolean {
  return msgType === 'file' && isImageDocumentAttachment(documentAttachment(attachments));
}
