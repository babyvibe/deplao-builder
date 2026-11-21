/**
 * Forwards messages (chat window, "Lưu vào My Documents"): re-sends each source message to the target conversation by type:
 * a Zalo photo album is sent in one batch, Zalo videos / voice messages / contact cards / links / stickers are re-sent as the same type, other media is sent from the local file
 * on the machine (downloaded first if missing), Telegram / Facebook still use native forwarding. Split out of ChatWindow (behaviour unchanged).
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';
import * as channelIpc from '@/lib/channels/channelIpc';
import { useChatStore } from '@/store/chat/chatStore';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { getLocalMediaPath } from '@/lib/media/mediaResolver';
import { CHANNEL, isFacebook, isNonZalo, isTelegram as isTelegramCh, isZalo } from '@/lib/channels/channelHelper';
import type { Channel } from '@/../configs/channels/channelConfig';
import {
  getForwardCaption, getForwardPlan, getZaloCardInfo, getZaloLinkInfo, getZaloRichText,
  getZaloStickerId, getZaloVideoInfo, getZaloVoiceUrl, type ForwardKind,
} from '@/lib/chat/forward/forwardSupport';
import { tr } from '../../../../shared/i18n';

type ForwardTarget = { threadId: string; threadType: number };

/**
 * The message's downloaded local file, using the key for its type (a video also has `thumb`; never take the cover image as the video).
 * Skips old `.jxl` files (Chromium / Zalo cannot use them).
 */
function getForwardLocalPath(msg: any, kind?: ForwardKind): string {
  const resolved = getLocalMediaPath(msg);
  if (resolved) return resolved;
  try {
    const raw = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    if (!raw || typeof raw !== 'object') return '';
    const pick = (...keys: string[]): string =>
      keys.map(key => raw[key]).find(value => typeof value === 'string' && value && !/\.jxl$/i.test(value)) || '';
    if (kind === 'video') return pick('file', 'video');
    if (kind === 'voice') return pick('file', 'voice');
    if (kind === 'image' || kind === 'gif') return pick('main', 'hd', 'file');
    if (kind === 'file') return pick('file', 'main');
    return pick('file', 'video', 'voice', 'main', 'hd')
      || (Object.values(raw).find(value => typeof value === 'string' && value) as string) || '';
  } catch {}
  return '';
}

function ensureForwardSuccess(result: { success?: boolean; error?: string } | undefined, fallback: string): void {
  if (!result?.success) throw new Error(result?.error || fallback);
}

async function sendForwardText(
  auth: any,
  channel: string | undefined,
  accountId: string | undefined,
  target: ForwardTarget,
  text: string,
): Promise<void> {
  if (!text) return;

  if (isFacebook(channel) || isTelegramCh(channel)) {
    if (!accountId) throw new Error(tr('Không tìm thấy tài khoản gửi'));
    const result = await getAdapter(channel as Channel).sendMessage({
      accountId,
      threadId: target.threadId,
      body: text,
      threadType: target.threadType,
    });
    ensureForwardSuccess(result, tr('Không gửi được tin nhắn'));
    return;
  }

  const result = await ipc.zalo?.sendMessage({
    auth,
    message: text,
    threadId: target.threadId,
    type: target.threadType,
  });
  ensureForwardSuccess(result, tr('Không gửi được tin nhắn Zalo'));
}

/** Zalo target (default when the channel is unknown) */
const isZaloForwardTarget = (channel?: string) => !isFacebook(channel) && !isTelegramCh(channel);

const FORWARD_DOWNLOAD_KINDS: Partial<Record<ForwardKind, 'image' | 'gif' | 'file' | 'voice' | 'video'>> = {
  image: 'image', gif: 'gif', file: 'file', voice: 'voice', video: 'video',
};

/**
 * Local file used to re-send media. Not downloaded yet (message synced from the phone, old message...) → the main process downloads it from the CDN link
 * in content (Zalo messages only), then updates local_paths so the bubble shows "đã có trên máy" (already on this machine).
 */
async function ensureForwardLocalPath(msg: any, kind: ForwardKind): Promise<string> {
  const existing = getForwardLocalPath(msg, kind);
  if (existing) return existing;
  const downloadKind = FORWARD_DOWNLOAD_KINDS[kind];
  if (!downloadKind || !isZalo(msg.channel) || !msg.owner_zalo_id || !msg.msg_id) return '';
  const res = await ipc.file?.downloadMessageMedia?.({
    zaloId: String(msg.owner_zalo_id),
    msgId: String(msg.msg_id),
    threadId: msg.thread_id ? String(msg.thread_id) : undefined,
    kind: downloadKind,
  }).catch(() => null);
  if (!res?.success || !res.localPath) {
    if (res?.error) console.warn(`[Forward] Không tải được ${downloadKind} của tin ${msg.msg_id}:`, res.error);
    return '';
  }
  if (res.localPaths && msg.thread_id) {
    useChatStore.getState().updateMessageLocalPath(String(msg.owner_zalo_id), String(msg.thread_id), String(msg.msg_id), res.localPaths);
  }
  return res.localPath;
}

/**
 * Groups the messages of the same album (adjacent in the forward list) into one group, in the photo order of the album.
 * `albums`: msg_id of the first photo → all messages of the album (groupedFirstMsgs).
 */
export function groupForwardAlbums(messages: any[], albums: Record<string, any[]>): any[][] {
  const albumOf = new Map<string, any[]>();
  for (const album of Object.values(albums)) {
    for (const m of album) albumOf.set(m.msg_id, album);
  }
  const units: any[][] = [];
  for (const m of messages) {
    const album = albumOf.get(m.msg_id);
    const last = units[units.length - 1];
    if (album && last && albumOf.get(last[0].msg_id) === album) last.push(m);
    else units.push([m]);
  }
  return units.map((unit) => {
    const album = albumOf.get(unit[0].msg_id);
    if (!album || unit.length < 2) return unit;
    const order = new Map(album.map((m, i) => [m.msg_id, i]));
    return [...unit].sort((a, b) => (order.get(a.msg_id) ?? 0) - (order.get(b.msg_id) ?? 0));
  });
}

const FORWARD_ALBUM_FILE_RE = /\.(jpe?g|png|webp)$/i;
/** ZaloService.sendImages error when checking the file before upload (kept in line with the wording over there). */
const FORWARD_ALBUM_PRECHECK_ERROR_RE = /Không tìm thấy một trong các tệp ảnh|không phải ảnh JPG, PNG hoặc WebP|Không đọc được kích thước ảnh/;
/** Telegram groups at most 10 media per album; longer lists must be split. */
const TELEGRAM_FORWARD_ALBUM_MAX = 10;

const isTelegramForwardTarget = (channel?: string) => isTelegramCh(channel);

/**
 * Merge adjacent photo-only units into one album unit (Telegram): forwarding 5 separately picked photos used to
 * send 5 messages — the recipient gets one album instead. Units that are not plain photos (text, video, file…)
 * keep their position and break the batch, so the order of the source list is preserved.
 */
export function mergeForwardPhotoUnits(units: any[][], channel?: string): any[][] {
  if (!isTelegramForwardTarget(channel)) return units;
  const isPhotoUnit = (unit: any[]) => unit.length > 0 && unit.every(m => getForwardPlan(m).kind === 'image');
  const merged: any[][] = [];
  let batch: any[] = [];
  const flush = () => {
    if (batch.length > 0) merged.push(batch);
    batch = [];
  };
  for (const unit of units) {
    if (!isPhotoUnit(unit)) {
      flush();
      merged.push(unit);
      continue;
    }
    for (const msg of unit) {
      if (batch.length >= TELEGRAM_FORWARD_ALBUM_MAX) flush();
      batch.push(msg);
    }
  }
  flush();
  return merged;
}

/**
 * Local files of the album when it can be sent as one batch: the target is Zalo / Telegram, every message is a photo, and each has
 * (or can download) a JPG/PNG/WebP file (formats both album APIs accept). Otherwise null → send each message separately.
 */
async function prepareForwardAlbum(unit: any[], channel?: string): Promise<string[] | null> {
  if (unit.length < 2) return null;
  if (!isZaloForwardTarget(channel) && !isTelegramForwardTarget(channel)) return null;
  if (!unit.every(m => getForwardPlan(m).kind === 'image')) return null;
  const paths: string[] = [];
  for (const m of unit) {
    const filePath = await ensureForwardLocalPath(m, 'image');
    if (!FORWARD_ALBUM_FILE_RE.test(filePath)) return null;
    paths.push(filePath);
  }
  return paths;
}

/** Sends the album in one batch (Zalo sendImages / Telegram album), the captions are sent afterwards as in sendOneForward. */
async function sendForwardAlbum(
  auth: any, unit: any[], filePaths: string[], target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<void> {
  if (isTelegramForwardTarget(channel)) {
    if (!accountId) throw new Error(tr('Không tìm thấy tài khoản gửi'));
    // Telegram shows ONE caption per album → the first caption rides on the album, the rest stay separate messages
    const captions = unit.map(msg => getForwardCaption(msg, 'image'));
    const captionIndex = captions.findIndex(Boolean);
    const result = await channelIpc.sendAttachments(channel as Channel, {
      accountId,
      threadId: target.threadId,
      threadType: target.threadType,
      filePaths,
      fileType: 'image',
      body: captionIndex >= 0 ? captions[captionIndex] : undefined,
    });
    ensureForwardSuccess(result, tr('Không chuyển tiếp được album ảnh Telegram'));
    for (let index = 0; index < unit.length; index++) {
      if (index === captionIndex || !captions[index]) continue;
      await sendForwardText(auth, channel, accountId, target, captions[index]);
    }
    return;
  }

  const result = await ipc.zalo?.sendImages({ auth, filePaths, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, tr('Không gửi được album ảnh Zalo'));
  for (const msg of unit) {
    const caption = getForwardCaption(msg, 'image');
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
  }
}

function getForwardVideoThumbPath(msg: any): string {
  try {
    const raw = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    return typeof raw?.thumb === 'string' ? raw.thumb : '';
  } catch {
    return '';
  }
}

/**
 * A video going to Zalo must be sent with sendVideo: sendFile produces a .mp4 file message that cannot be played right away.
 * A Zalo video that still has its CDN link → reuse the link + the original cover image, no re-upload (zca-js sendVideo is the same API as
 * the "forward" msgType 5, the way Zalo forwards videos). Expired link / send error / video from another channel → upload the downloaded file.
 * Returns false if there is neither a link nor a file (so native forward is tried).
 */
async function sendZaloVideoForward(auth: any, msg: any, localPath: string, target: ForwardTarget): Promise<boolean> {
  const info = getZaloVideoInfo(msg);
  if (info) {
    let expired = !!msg.media_expired;
    if (!expired && msg.owner_zalo_id && msg.msg_id) {
      const check = await ipc.file?.checkMediaExpired({
        zaloId: String(msg.owner_zalo_id), msgId: String(msg.msg_id), urls: [info.videoUrl],
      }).catch(() => null);
      expired = !!check?.expired;
    }
    if (!expired) {
      const result = await ipc.zalo?.sendVideo({
        auth,
        options: { videoUrl: info.videoUrl, thumbnailUrl: info.thumbUrl || info.videoUrl, duration: info.duration, width: info.width, height: info.height },
        threadId: target.threadId,
        type: target.threadType,
      });
      if (result?.success) return true;
      // sendVideo failed = nothing was sent yet (error at the HEAD link step or at the single forward request) → upload the file if there is one
      if (!localPath) ensureForwardSuccess(result, tr('Không gửi được video Zalo'));
      console.warn('[Forward] Gửi video bằng link CDN lỗi → upload file đã tải về:', result?.error);
    } else if (!localPath) {
      // Native forward at this point only produces a video the recipient cannot play
      throw new Error(tr('Video đã hết hạn trên Zalo và chưa tải về máy'));
    }
  }
  if (!localPath) return false;

  const meta = await ipc.file?.getVideoMeta?.({ filePath: localPath }).catch(() => null);
  const thumbPath: string = meta?.thumbPath || getForwardVideoThumbPath(msg);
  let thumbUrl = '';
  if (thumbPath) {
    const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId: target.threadId, type: target.threadType }).catch(() => null);
    const resp = uploadRes?.response;
    thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
  }
  const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath: localPath, threadId: target.threadId, type: target.threadType });
  const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
  if (!videoUrl) throw new Error(uploadVideoRes?.error || tr('Tải video lên Zalo thất bại'));
  const result = await ipc.zalo?.sendVideo({
    auth,
    options: {
      videoUrl,
      thumbnailUrl: thumbUrl || videoUrl,
      duration: meta?.duration ? meta.duration * 1000 : info?.duration,
      width: meta?.width || info?.width,
      height: meta?.height || info?.height,
    },
    threadId: target.threadId,
    type: target.threadType,
  });
  ensureForwardSuccess(result, tr('Không gửi được video Zalo'));
  return true;
}

/**
 * Voice message to Zalo: sendVoice (sendFile produces a .m4a file message). Reuses the original m4a link like a video (zca-js sendVoice
 * is the "forward" msgType 3 API); expired link / send error → upload the file again. Returns false if there is neither a link nor a file.
 */
async function sendZaloVoiceForward(auth: any, msg: any, target: ForwardTarget): Promise<boolean> {
  const voiceUrl = isZalo(msg.channel) ? getZaloVoiceUrl(msg) : '';
  if (voiceUrl && !msg.media_expired) {
    const check = msg.owner_zalo_id && msg.msg_id
      ? await ipc.file?.checkMediaExpired({ zaloId: String(msg.owner_zalo_id), msgId: String(msg.msg_id), urls: [voiceUrl] }).catch(() => null)
      : null;
    if (!check?.expired) {
      const result = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl }, threadId: target.threadId, type: target.threadType });
      if (result?.success) return true;
      // sendVoice failed = nothing was sent yet (error at the HEAD link step or the single forward request) → upload the file again
      console.warn('[Forward] Gửi tin thoại bằng link gốc lỗi → tải file lên lại:', result?.error);
    }
  }
  const localPath = await ensureForwardLocalPath(msg, 'voice');
  if (!localPath) return false;
  const uploadRes = await ipc.zalo?.uploadVoiceFile?.({ auth, voicePath: localPath, threadId: target.threadId, type: target.threadType });
  const resp = uploadRes?.response;
  const uploadedUrl: string = resp?.fileUrl || resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.href || '';
  if (!uploadedUrl) throw new Error(uploadRes?.error || tr('Tải tin thoại lên Zalo thất bại'));
  const result = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl: uploadedUrl }, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, tr('Không gửi được tin thoại Zalo'));
  return true;
}

/**
 * Re-sends a Zalo text / card message as its own type (see forwardSupport.ts). Returns false if the message type must be sent
 * as media (handled in sendOneForward).
 */
async function sendZaloStructuredForward(
  auth: any, msg: any, kind: ForwardKind, target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<boolean> {
  const toZalo = isZaloForwardTarget(channel);
  switch (kind) {
    case 'rtf': {
      // Formatted text: keep bold / italic / color / font size / lists
      const { text, styles } = getZaloRichText(msg);
      if (!text) throw new Error(tr('Tin nhắn không có nội dung để chuyển tiếp'));
      if (toZalo && styles.length > 0) {
        const result = await ipc.zalo?.sendMessage({ auth, message: text, styles, threadId: target.threadId, type: target.threadType });
        ensureForwardSuccess(result, tr('Không gửi được tin nhắn Zalo'));
      } else {
        await sendForwardText(auth, channel, accountId, target, text);
      }
      return true;
    }
    case 'link': {
      const { url, text } = getZaloLinkInfo(msg);
      const fullText = !text ? url : (url && !text.includes(url) ? `${text}\n${url}` : text);
      if (!fullText) throw new Error(tr('Tin nhắn link không có nội dung'));
      if (toZalo && url) {
        // sendLink: one message with the text (containing the link) + the preview box, same as the original
        const result = await ipc.zalo?.sendLink({ auth, url, message: text || undefined, threadId: target.threadId, type: target.threadType });
        if (result?.success) return true;
        // Link preview cannot be read (parseLink failed, nothing sent yet) → send as text, the link is still clickable
        console.warn('[Forward] sendLink lỗi → gửi dạng chữ:', result?.error);
      }
      await sendForwardText(auth, channel, accountId, target, fullText);
      return true;
    }
    case 'card': {
      const { userId, phone, name } = getZaloCardInfo(msg);
      if (toZalo && userId) {
        const result = await ipc.zalo?.sendCard({
          auth, options: { userId, ...(phone ? { phoneNumber: phone } : {}) }, threadId: target.threadId, type: target.threadType,
        });
        ensureForwardSuccess(result, tr('Không gửi được danh thiếp Zalo'));
        return true;
      }
      // Other channels have no Zalo contact card → send the name + phone number
      const cardText = [name && `👤 ${name}`, phone].filter(Boolean).join('\n');
      if (!cardText) throw new Error(tr('Không đọc được danh thiếp'));
      await sendForwardText(auth, channel, accountId, target, cardText);
      return true;
    }
    case 'sticker': {
      if (!toZalo) throw new Error(tr('Sticker Zalo chỉ chuyển tiếp được sang Zalo'));
      const stickerId = getZaloStickerId(msg);
      if (!stickerId) throw new Error(tr('Không đọc được sticker'));
      const result = await ipc.zalo?.sendSticker({ auth, stickerId, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, tr('Không gửi được sticker Zalo'));
      return true;
    }
    default:
      return false;
  }
}

/**
 * Sends one source message as its own type. The source caption is sent as a separate message when the media has to be resent.
 * Does not use zca-js `forwardMessage` for media: that API only forwards text (empty message → error).
 */
export async function sendOneForward(
  auth: any, msg: any, target: ForwardTarget,
  channel?: string, accountId?: string, sourceAccountId?: string,
): Promise<void> {
  const plan = getForwardPlan(msg);
  const { kind } = plan;
  if (kind === 'unsupported') throw new Error(tr('{{v1}} không chuyển tiếp được', { v1: plan.reason || tr('Loại tin nhắn này') }));
  const caption = getForwardCaption(msg, kind);
  const toZalo = isZaloForwardTarget(channel);

  if (kind === 'text' || kind === 'location') {
    if (!caption) throw new Error(tr('Loại tin nhắn này chưa có nội dung để chuyển tiếp'));
    await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  if (isZalo(msg.channel) && await sendZaloStructuredForward(auth, msg, kind, target, channel, accountId)) return;

  // Video / voice message to Zalo: a message that plays right away, not a file message
  if (kind === 'video' && toZalo && await sendZaloVideoForward(auth, msg, getForwardLocalPath(msg, 'video'), target)) {
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }
  if (kind === 'voice' && toZalo && await sendZaloVoiceForward(auth, msg, target)) return;

  // Other media: re-sent from the local file (downloaded first if missing) so it can move between accounts / channels.
  const localPath = await ensureForwardLocalPath(msg, kind);
  if (localPath) {
    if (!toZalo) {
      if (!accountId) throw new Error(tr('Không tìm thấy tài khoản gửi'));
      const fileType = kind === 'image' ? 'image'
        : kind === 'video' ? (msg.msg_type === 'video_note' ? 'video_note' : 'video')
          : kind === 'voice' ? 'voice'
            : kind === 'sticker' ? 'sticker'
              : kind === 'animation' || kind === 'gif' ? 'animation'
                : 'file';
      const result = await getAdapter(channel as Channel).sendAttachment({
        accountId, threadId: target.threadId, filePath: localPath, threadType: target.threadType, fileType,
      });
      ensureForwardSuccess(result, tr('Không gửi được tệp đính kèm'));
    } else {
      // Photo / GIF (zca-js sends .gif as a GIF message) / other-channel sticker as an image → sendImage; the rest → file
      const asImage = (kind === 'image' || kind === 'gif' || kind === 'animation' || kind === 'sticker')
        && /\.(jpe?g|png|webp|gif)$/i.test(localPath);
      const result = asImage
        ? await ipc.zalo?.sendImage({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType, message: '' })
        : await ipc.zalo?.sendFile({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, tr('Không gửi được tệp đính kèm Zalo'));
    }

    // Do not put the caption into the attachment: send it separately to keep the right order/behaviour
    // shared across channels, and does not drop the text when forwarding several messages.
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  // No local file: Facebook / Telegram still use native forward on the source account itself.
  const canUseNativeForward = !sourceAccountId || sourceAccountId === accountId;
  if (!toZalo && canUseNativeForward && msg.msg_id && accountId) {
    if (isFacebook(channel)) {
      const result = await getAdapter(channel as Channel).forwardMessage({
        accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, threadType: target.threadType,
      });
      ensureForwardSuccess(result, tr('Không chuyển tiếp được tin nhắn Facebook'));
      return;
    }
    const sourceThreadId = msg.thread_id || msg.chat_id;
    if (!sourceThreadId) throw new Error(tr('Tin nhắn Telegram không có hội thoại nguồn'));
    const result = await getAdapter(channel as Channel).forwardMessage({
      accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, sourceThreadId: String(sourceThreadId), threadType: target.threadType,
    });
    ensureForwardSuccess(result, tr('Không chuyển tiếp được tin nhắn Telegram'));
    return;
  }
  throw new Error(isZalo(msg.channel)
    ? tr('Không tải được tệp từ Zalo (link đã hết hạn?) nên không chuyển tiếp được')
    : tr('Tệp chưa được tải về; không thể chuyển tiếp sang tài khoản khác'));
}

export interface ForwardJobTarget { threadId: string; threadType: number; accountId: string }

export interface ForwardJobContext {
  /** msg_id of the first photo → every message of the album (album batch send) */
  albums: Record<string, any[]>;
  accounts: Array<{ zalo_id: string; channel?: string } & Record<string, any>>;
  /** The account currently open (native Telegram / Facebook forwarding only works on the source account itself) */
  sourceAccountId?: string | null;
  notify: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

export interface ForwardJobLabels {
  progress: (done: number, total: number) => string;
  done: string;
}

export const DEFAULT_FORWARD_LABELS: ForwardJobLabels = {
  progress: (done, total) => tr('Đang chuyển tiếp {{done}}/{{total}}...', { done, total }),
  done: tr('Đã chuyển tiếp xong'),
};

/**
 * Sends the messages to each recipient (forward / Save to My Documents): an album in one batch, everything else one message at a time;
 * the text composed with them (if any) is one new message at the end. Runs in the background, does not block the UI.
 */
export function runForwardJob(
  messages: any[],
  targets: ForwardJobTarget[],
  composeText: string,
  ctx: ForwardJobContext,
  labels: ForwardJobLabels = DEFAULT_FORWARD_LABELS,
): void {
  const baseUnits = groupForwardAlbums(messages, ctx.albums);
  // Runs one after another in the background, does not block the UI
  (async () => {
    const total = messages.length * targets.length;
    let counter = 0;
    let failCount = 0;
    let firstFailure = '';
    const companionText = composeText.trim();
    for (const target of targets) {
      let forwardedAny = false;
      // Get auth + channel from target account once per recipient.
      const targetAccount = ctx.accounts.find(a => a.zalo_id === target.accountId);
      if (!targetAccount) {
        failCount += messages.length;
        firstFailure ||= tr('Không tìm thấy tài khoản gửi');
        continue;
      }
      const targetChannel = targetAccount.channel || CHANNEL.ZALO;
      const targetAuth = isNonZalo(targetChannel)
        ? { cookies: '', imei: '', userAgent: '' }
        : buildZaloAuth(targetAccount);
      // Telegram: adjacent photos become ONE album (per target channel, the same list may go to several channels)
      const units = mergeForwardPhotoUnits(baseUnits, targetChannel);

      for (const unit of units) {
        // All-photo album (downloaded first if missing) → sent in one batch so the recipient also sees an album.
        const albumPaths = await prepareForwardAlbum(unit, targetChannel);
        if (albumPaths) {
          let albumDone = true;
          try {
            await sendForwardAlbum(
              targetAuth,
              unit,
              albumPaths,
              { threadId: target.threadId, threadType: target.threadType },
              targetChannel,
              target.accountId,
            );
            forwardedAny = true;
          } catch (e: any) {
            if (FORWARD_ALBUM_PRECHECK_ERROR_RE.test(e?.message || '')) {
              // File check failed before upload → nothing sent yet → send each photo below
              albumDone = false;
              console.warn(`[Forward] Album first=${unit[0].msg_id} → gửi từng ảnh:`, e.message);
            } else {
              // Error while sending: do not resend each photo (part may already have been sent → duplicates)
              failCount += unit.length;
              firstFailure ||= e?.message || tr('Không rõ lỗi');
              console.warn(`[Forward] Failed album first=${unit[0].msg_id} (${unit.length} ảnh) target=${target.threadId}:`, e.message);
            }
          }
          if (albumDone) {
            counter += unit.length;
            if (total > 1) {
              ctx.notify(labels.progress(counter, total), 'info');
            }
            continue;
          }
        }

        for (const msg of unit) {
          counter++;
          try {
            await sendOneForward(
              targetAuth,
              msg,
              { threadId: target.threadId, threadType: target.threadType },
              targetChannel,
              target.accountId,
              ctx.sourceAccountId || undefined,
            );
            forwardedAny = true;
          } catch (e: any) {
            failCount++;
            firstFailure ||= e?.message || tr('Không rõ lỗi');
            console.warn(`[Forward] Failed msg=${msg.msg_id} target=${target.threadId}:`, e.message);
          }
          if (total > 1) {
            ctx.notify(labels.progress(counter, total), 'info');
          }
        }
      }

      // Text the user writes in the popup is always a new message, sent after
      // all the messages forwarded to this recipient. It must not replace
      // the text/caption of the source message.
      if (forwardedAny && companionText) {
        try {
          await sendForwardText(targetAuth, targetChannel, target.accountId, {
            threadId: target.threadId,
            threadType: target.threadType,
          }, companionText);
        } catch (e: any) {
          failCount++;
          firstFailure ||= e?.message || tr('Không rõ lỗi');
          console.warn(`[Forward] Failed companion target=${target.threadId}:`, e.message);
        }
      }
    }
    if (failCount === 0) {
      ctx.notify(labels.done, 'success');
    } else {
      ctx.notify(tr('{{done}} ({{failCount}} lỗi): {{firstFailure}}', { done: labels.done, failCount, firstFailure }), 'error');
    }
  })();
}
