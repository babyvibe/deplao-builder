/**
 * Drag and drop of files / images into the chat (the message area + the shared composer).
 *
 * It used to read only `dataTransfer.files`: dragging an image from a web page / app that only gives a link (no file data) did nothing silently.
 * Now it also reads the image link (`<img src>` in text/html, text/uri-list, text/plain), then downloads the image through main
 * (file:readImageAsBase64, no CORS problem; checks it really is an image from the first few bytes) into a File so it takes the normal image send path.
 * The drag data MUST be read right inside the drop event (the browser locks it afterwards): readDropPayload does that.
 */
import ipc from '@/lib/ipc';

export interface DropPayload {
  files: File[];
  /** Image link (http(s) / data:image) when the drag has no file attached */
  imageUrls: string[];
  /** The data types of the drag, written to the log for diagnosis */
  types: string[];
}

const MAX_DROPPED_URLS = 10;
const IMAGE_EXT = /\.(jpe?g|jfif|png|gif|webp|bmp)$/i;

/** Images: by MIME type; Windows sometimes leaves the MIME type empty (.jfif, .webp...) → by file extension. */
export function isImageFile(file: { type?: string; name?: string }): boolean {
  return (file.type || '').startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name || ''));
}

const decodeHtmlEntities = (value: string) => value
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const isUsableImageUrl = (url: string) => /^https?:\/\//i.test(url) || /^data:image\//i.test(url);

/**
 * Image links from the drag data: prefer `<img src>` in the HTML (the real image, even when it sits inside a link to another page),
 * then text/uri-list (skipping # comment lines), then text/plain if it is just one link. Keeps only http(s) / data:image, removes duplicates.
 */
export function extractImageUrls(source: { html?: string; uriList?: string; text?: string }): string[] {
  const urls: string[] = [];
  const add = (raw: string | undefined) => {
    const url = (raw || '').trim();
    if (url && isUsableImageUrl(url) && !urls.includes(url)) urls.push(url);
  };
  for (const match of (source.html || '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    add(decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  if (urls.length === 0) {
    for (const line of (source.uriList || '').split(/\r?\n/)) {
      if (!line.trim().startsWith('#')) add(line);
    }
  }
  if (urls.length === 0) {
    const text = (source.text || '').trim();
    if (text && !/\s/.test(text)) add(text);
  }
  return urls.slice(0, MAX_DROPPED_URLS);
}

/** Image MIME type from the first few bytes (JPEG, PNG, GIF, WEBP, BMP); not an image → null. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
  if (bytes.length >= 2 && at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  return null;
}

const EXT_OF: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** File name from the link (the last part of the path); if none, "anh-keo-tha-N". */
function fileNameFor(url: string, index: number, mime: string): string {
  const ext = EXT_OF[mime] || 'jpg';
  if (!/^https?:/i.test(url)) return `anh-keo-tha-${index + 1}.${ext}`;
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const base = last.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    return `${base || `anh-keo-tha-${index + 1}`}.${ext}`;
  } catch {
    return `anh-keo-tha-${index + 1}.${ext}`;
  }
}

/** Reads the data of one drop: call it right inside onDrop (the drag data is locked after the event). */
export function readDropPayload(dataTransfer: DataTransfer | null | undefined): DropPayload {
  if (!dataTransfer) return { files: [], imageUrls: [], types: [] };
  const types = Array.from(dataTransfer.types || []);
  let files = Array.from(dataTransfer.files || []);
  if (files.length === 0 && dataTransfer.items) {
    files = Array.from(dataTransfer.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
  }
  const read = (type: string) => { try { return dataTransfer.getData(type); } catch { return ''; } };
  const imageUrls = files.length > 0
    ? []
    : extractImageUrls({ html: read('text/html'), uriList: read('text/uri-list'), text: read('text/plain') });
  return { files, imageUrls, types };
}

/** Downloads the dropped image links into Files (skips links that fail to download / are not images). */
export async function fetchDroppedImages(urls: string[]): Promise<File[]> {
  const files: File[] = [];
  for (const [index, url] of urls.slice(0, MAX_DROPPED_URLS).entries()) {
    try {
      let base64 = '';
      if (/^data:image\//i.test(url)) {
        base64 = url.slice(url.indexOf(',') + 1);
      } else {
        const res: any = await ipc.file?.readImageAsBase64?.({ remoteUrl: url });
        if (!res?.success || !res.base64) continue;
        base64 = res.base64;
      }
      const bytes = base64ToBytes(base64);
      const mime = sniffImageMime(bytes);
      if (!mime) continue;
      files.push(new File([bytes], fileNameFor(url, index, mime), { type: mime }));
    } catch {
      // broken link / network error → skip that link
    }
  }
  return files;
}
