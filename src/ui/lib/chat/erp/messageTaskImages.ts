/**
 * Images of a message for "Tạo task" (Create task) from a message (lib/chat/erp/messageToErp.taskDraftFromMessages): reads the image of an image message from Zalo /
 * Telegram / Facebook into a data URL (shrunk, longest side ≤ 1600px) to insert into the task content. The task content saves the image itself,
 * so it shows on any machine, and the Zalo link expiring does not matter.
 *
 * Source: the file on the machine (employee machine: the copy on the Boss machine via /api/media), otherwise the original link; a Zalo image that the Boss machine
 * has not saved yet is first saved by the Boss (lib/media/ensureMessageImage). Read through main (file:readImageAsBase64: file on the machine, Boss link
 * with the session token, CDN link): fetching it from the UI hits CORS. At most MAX_TASK_IMAGES images, read in parallel, each step waits
 * ≤ 6 seconds (the create-task popup does not wait too long because of one broken image).
 */
import ipc from '@/lib/ipc';
import { isFacebook, isTelegram, isZalo } from '@/lib/channels/channelHelper';
import { getLocalMediaPath, getRemoteMediaUrl } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { ensureMessageImage } from '@/lib/media/ensureMessageImage';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { toZaloJpgUrl } from '../../../../utils/zalo/zaloImageUrl';

export const MAX_TASK_IMAGES = 10;
const READ_TIMEOUT_MS = 6_000;
const MAX_SIDE = 1600;

const ZALO_PHOTO_TYPES = new Set(['chat.photo', 'photo', 'image']);

export interface MessageImageSource {
  localPath: string;
  remoteUrl: string;
}

function parseJson(value: unknown): any {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Image of an image message (album: one image per message); other messages → null. */
export function messageImageSource(msg: any): MessageImageSource | null {
  const type = String(msg?.msg_type || '').toLowerCase();
  if (isZalo(msg?.channel)) {
    if (!ZALO_PHOTO_TYPES.has(type)) return null;
    const paths = parseJson(msg?.local_paths) || {};
    const local = String(paths.main || paths.hd || '');
    const content = parseJson(msg?.content) || {};
    const params = parseJson(content.params) || {};
    const remote = toZaloJpgUrl(String(params.hd || params.rawUrl || content.href || content.thumb || ''));
    const localPath = /\.jxl$/i.test(local) ? '' : local;
    return localPath || remote ? { localPath, remoteUrl: remote } : null;
  }
  if (isTelegram(msg?.channel) || isFacebook(msg?.channel)) {
    const attachments = (() => {
      const parsed = typeof msg?.attachments === 'string' ? (() => { try { return JSON.parse(msg.attachments); } catch { return []; } })() : msg?.attachments;
      return Array.isArray(parsed) ? parsed : [];
    })();
    const isPhoto = type === 'photo' || type === 'image'
      || attachments.some((item: any) => item?.type === 'photo' || item?.type === 'image');
    if (!isPhoto) return null;
    const localPath = getLocalMediaPath(msg, 'photo') || getLocalMediaPath(msg, 'image');
    const remoteUrl = getRemoteMediaUrl(msg);
    return localPath || remoteUrl ? { localPath, remoteUrl } : null;
  }
  return null;
}

/** Caption of an image message (Zalo: title; Telegram / Facebook: the message text). */
export function messageImageCaption(msg: any): string {
  const content = parseJson(msg?.content);
  if (content) {
    const title = typeof content.title === 'string' ? content.title.trim() : '';
    return title && !/^https?:\/\//i.test(title) ? title : '';
  }
  const text = String(msg?.content || '').trim();
  return /^[🖼🎬🎞🎨📎]/u.test(text) ? '' : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, () => { window.clearTimeout(timer); resolve(null); });
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = src;
  });
}

/** Large image → JPEG, longest side ≤ MAX_SIDE (white background for transparent images); GIF kept as is (animated). */
async function shrinkToDataUrl(base64: string, mimeType: string): Promise<string> {
  const raw = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  if (mimeType === 'image/gif') return raw;
  try {
    const img = await loadImage(raw);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    if (scale === 1 && base64.length < 700_000) return raw;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return raw;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return raw;
  }
}

async function readOne(params: { localPath?: string; remoteUrl?: string }): Promise<string | null> {
  const res = await withTimeout(Promise.resolve(ipc.file?.readImageAsBase64(params)), READ_TIMEOUT_MS);
  if (!res?.success || !res.base64) return null;
  return shrinkToDataUrl(res.base64, res.mimeType || 'image/jpeg');
}

/** Image of one message as a data URL; unreadable → null. */
export async function messageImageDataUrl(msg: any): Promise<string | null> {
  let source = messageImageSource(msg);
  if (!source) return null;
  // A Zalo image on the Boss machine not saved yet (link only): ask the Boss to download it first with the account session
  if (!source.localPath && isZalo(msg?.channel)) {
    const saved = await withTimeout(ensureMessageImage(msg), READ_TIMEOUT_MS);
    if (saved?.success && saved.newLocalPath) source = { ...source, localPath: saved.newLocalPath };
  }
  const employee = useEmployeeStore.getState().mode === 'employee';
  const attempts: Array<{ localPath?: string; remoteUrl?: string }> = [];
  if (source.localPath) {
    // Employee machine: the path belongs to the Boss machine → read the copy on the Boss (main attaches the session token)
    const bossUrl = employee ? toLocalMediaUrl(source.localPath) : '';
    attempts.push(employee ? { remoteUrl: /^https?:\/\//i.test(bossUrl) ? bossUrl : undefined } : { localPath: source.localPath });
  }
  if (/^https?:\/\//i.test(source.remoteUrl)) attempts.push({ remoteUrl: source.remoteUrl });
  for (const params of attempts) {
    if (!params.localPath && !params.remoteUrl) continue;
    const dataUrl = await readOne(params);
    if (dataUrl) return dataUrl;
  }
  return null;
}

/** Images of the messages (in message order), at most the first MAX_TASK_IMAGES image messages; key = msg_id. */
export async function messageImagesForTask(msgs: readonly any[]): Promise<Map<string, string[]>> {
  const photos = msgs.filter(msg => messageImageSource(msg)).slice(0, MAX_TASK_IMAGES);
  const results = await Promise.all(photos.map(msg => messageImageDataUrl(msg).catch(() => null)));
  const out = new Map<string, string[]>();
  photos.forEach((msg, index) => {
    const dataUrl = results[index];
    if (dataUrl) out.set(String(msg.msg_id), [dataUrl]);
  });
  return out;
}
