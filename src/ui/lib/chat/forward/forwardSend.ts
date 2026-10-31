/**
 * Chuyển tiếp tin (khung chat, "Lưu vào My Documents"): gửi lại từng tin nguồn sang hội thoại đích theo đúng loại:
 * album ảnh Zalo gộp 1 lần, video / tin thoại / danh thiếp / link / sticker Zalo gửi lại đúng loại, media khác gửi từ file
 * trên máy (tải về nếu chưa có), Telegram / Facebook còn chuyển tiếp gốc. Tách từ ChatWindow (không đổi hành vi).
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { getLocalMediaPath } from '@/lib/media/mediaResolver';
import { CHANNEL, isFacebook, isNonZalo, isTelegram as isTelegramCh, isZalo } from '@/lib/channels/channelHelper';
import type { Channel } from '@/../configs/channels/channelConfig';
import {
  getForwardCaption, getForwardPlan, getZaloCardInfo, getZaloLinkInfo, getZaloRichText,
  getZaloStickerId, getZaloVideoInfo, getZaloVoiceUrl, type ForwardKind,
} from '@/lib/chat/forward/forwardSupport';

type ForwardTarget = { threadId: string; threadType: number };

/**
 * File local đã tải của tin, đúng key theo loại (video có cả `thumb` — không được lấy nhầm ảnh bìa làm video).
 * Bỏ qua file `.jxl` cũ (Chromium / Zalo không dùng được).
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
    if (!accountId) throw new Error('Không tìm thấy tài khoản gửi');
    const result = await getAdapter(channel as Channel).sendMessage({
      accountId,
      threadId: target.threadId,
      body: text,
      threadType: target.threadType,
    });
    ensureForwardSuccess(result, 'Không gửi được tin nhắn');
    return;
  }

  const result = await ipc.zalo?.sendMessage({
    auth,
    message: text,
    threadId: target.threadId,
    type: target.threadType,
  });
  ensureForwardSuccess(result, 'Không gửi được tin nhắn Zalo');
}

/** Đích Zalo (mặc định khi không rõ kênh) */
const isZaloForwardTarget = (channel?: string) => !isFacebook(channel) && !isTelegramCh(channel);

const FORWARD_DOWNLOAD_KINDS: Partial<Record<ForwardKind, 'image' | 'gif' | 'file' | 'voice' | 'video'>> = {
  image: 'image', gif: 'gif', file: 'file', voice: 'voice', video: 'video',
};

/**
 * File local để gửi lại media. Chưa tải (tin đồng bộ từ điện thoại, tin cũ…) → main process tải về theo link CDN
 * trong content (chỉ tin Zalo), cập nhật local_paths để bubble hiện "đã có trên máy".
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
 * Gom các tin cùng album (liền nhau trong danh sách chuyển tiếp) thành 1 nhóm, theo thứ tự ảnh trong album.
 * `albums`: msg_id ảnh đầu → toàn bộ tin của album (groupedFirstMsgs).
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
/** Lỗi ZaloService.sendImages khi kiểm tra file, trước khi upload (giữ khớp câu chữ bên đó). */
const FORWARD_ALBUM_PRECHECK_ERROR_RE = /Không tìm thấy một trong các tệp ảnh|không phải ảnh JPG, PNG hoặc WebP|Không đọc được kích thước ảnh/;

/**
 * File local của album nếu gửi gộp được: đích là Zalo, mọi tin là ảnh và có (hoặc tải về được) file JPG/PNG/WebP
 * (định dạng sendImages chấp nhận). Ngược lại null → gửi từng tin.
 */
async function prepareForwardAlbum(unit: any[], channel?: string): Promise<string[] | null> {
  if (unit.length < 2 || !isZaloForwardTarget(channel)) return null;
  if (!unit.every(m => getForwardPlan(m).kind === 'image')) return null;
  const paths: string[] = [];
  for (const m of unit) {
    const filePath = await ensureForwardLocalPath(m, 'image');
    if (!FORWARD_ALBUM_FILE_RE.test(filePath)) return null;
    paths.push(filePath);
  }
  return paths;
}

/** Gửi album bằng 1 lần sendImages (zca-js gán groupLayoutId → người nhận thấy album), caption gửi sau như sendOneForward. */
async function sendForwardAlbum(
  auth: any, unit: any[], filePaths: string[], target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<void> {
  const result = await ipc.zalo?.sendImages({ auth, filePaths, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, 'Không gửi được album ảnh Zalo');
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
 * Video sang Zalo phải gửi bằng sendVideo — sendFile ra tin file .mp4, không xem được ngay.
 * Video Zalo còn link CDN → dùng lại link + ảnh bìa gốc, không upload lại (sendVideo của zca-js chính là API
 * "forward" msgType 5, cách Zalo chuyển tiếp video). Link hết hạn / gửi lỗi / video kênh khác → upload file đã tải về.
 * Trả false nếu không có link lẫn file (để thử native forward).
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
      // sendVideo lỗi = chưa gửi gì (lỗi ở bước HEAD link hoặc ở request forward duy nhất) → upload file nếu có
      if (!localPath) ensureForwardSuccess(result, 'Không gửi được video Zalo');
      console.warn('[Forward] Gửi video bằng link CDN lỗi → upload file đã tải về:', result?.error);
    } else if (!localPath) {
      // Native forward lúc này chỉ ra video không phát được ở người nhận
      throw new Error('Video đã hết hạn trên Zalo và chưa tải về máy');
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
  if (!videoUrl) throw new Error(uploadVideoRes?.error || 'Tải video lên Zalo thất bại');
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
  ensureForwardSuccess(result, 'Không gửi được video Zalo');
  return true;
}

/**
 * Tin thoại sang Zalo: sendVoice (sendFile ra tin file .m4a). Dùng lại link m4a gốc như video (sendVoice của zca-js
 * là API "forward" msgType 3); link hết hạn / gửi lỗi → tải file lên lại. Trả false nếu không có link lẫn file.
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
      // sendVoice lỗi = chưa gửi gì (lỗi ở bước HEAD link hoặc request forward duy nhất) → tải file lên lại
      console.warn('[Forward] Gửi tin thoại bằng link gốc lỗi → tải file lên lại:', result?.error);
    }
  }
  const localPath = await ensureForwardLocalPath(msg, 'voice');
  if (!localPath) return false;
  const uploadRes = await ipc.zalo?.uploadVoiceFile?.({ auth, voicePath: localPath, threadId: target.threadId, type: target.threadType });
  const resp = uploadRes?.response;
  const uploadedUrl: string = resp?.fileUrl || resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.href || '';
  if (!uploadedUrl) throw new Error(uploadRes?.error || 'Tải tin thoại lên Zalo thất bại');
  const result = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl: uploadedUrl }, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, 'Không gửi được tin thoại Zalo');
  return true;
}

/**
 * Gửi lại tin dạng chữ / thẻ của Zalo theo đúng loại (xem forwardSupport.ts). Trả false nếu loại tin cần gửi
 * dạng media (xử lý ở sendOneForward).
 */
async function sendZaloStructuredForward(
  auth: any, msg: any, kind: ForwardKind, target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<boolean> {
  const toZalo = isZaloForwardTarget(channel);
  switch (kind) {
    case 'rtf': {
      // Chữ định dạng: giữ in đậm / nghiêng / màu / cỡ chữ / danh sách
      const { text, styles } = getZaloRichText(msg);
      if (!text) throw new Error('Tin nhắn không có nội dung để chuyển tiếp');
      if (toZalo && styles.length > 0) {
        const result = await ipc.zalo?.sendMessage({ auth, message: text, styles, threadId: target.threadId, type: target.threadType });
        ensureForwardSuccess(result, 'Không gửi được tin nhắn Zalo');
      } else {
        await sendForwardText(auth, channel, accountId, target, text);
      }
      return true;
    }
    case 'link': {
      const { url, text } = getZaloLinkInfo(msg);
      const fullText = !text ? url : (url && !text.includes(url) ? `${text}\n${url}` : text);
      if (!fullText) throw new Error('Tin nhắn link không có nội dung');
      if (toZalo && url) {
        // sendLink: 1 tin gồm chữ (chứa link) + khung xem trước, giống tin gốc
        const result = await ipc.zalo?.sendLink({ auth, url, message: text || undefined, threadId: target.threadId, type: target.threadType });
        if (result?.success) return true;
        // Không đọc được xem trước của link (parseLink lỗi, chưa gửi gì) → gửi dạng chữ, link vẫn bấm được
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
        ensureForwardSuccess(result, 'Không gửi được danh thiếp Zalo');
        return true;
      }
      // Kênh khác không có danh thiếp Zalo → gửi tên + số điện thoại
      const cardText = [name && `👤 ${name}`, phone].filter(Boolean).join('\n');
      if (!cardText) throw new Error('Không đọc được danh thiếp');
      await sendForwardText(auth, channel, accountId, target, cardText);
      return true;
    }
    case 'sticker': {
      if (!toZalo) throw new Error('Sticker Zalo chỉ chuyển tiếp được sang Zalo');
      const stickerId = getZaloStickerId(msg);
      if (!stickerId) throw new Error('Không đọc được sticker');
      const result = await ipc.zalo?.sendSticker({ auth, stickerId, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, 'Không gửi được sticker Zalo');
      return true;
    }
    default:
      return false;
  }
}

/**
 * Gửi một tin nguồn theo đúng loại. Caption nguồn được gửi thành một tin độc lập khi phải resend media.
 * Không dùng `forwardMessage` của zca-js cho media: API đó chỉ chuyển tiếp văn bản (message rỗng → lỗi).
 */
export async function sendOneForward(
  auth: any, msg: any, target: ForwardTarget,
  channel?: string, accountId?: string, sourceAccountId?: string,
): Promise<void> {
  const plan = getForwardPlan(msg);
  const { kind } = plan;
  if (kind === 'unsupported') throw new Error(`${plan.reason || 'Loại tin nhắn này'} không chuyển tiếp được`);
  const caption = getForwardCaption(msg, kind);
  const toZalo = isZaloForwardTarget(channel);

  if (kind === 'text' || kind === 'location') {
    if (!caption) throw new Error('Loại tin nhắn này chưa có nội dung để chuyển tiếp');
    await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  if (isZalo(msg.channel) && await sendZaloStructuredForward(auth, msg, kind, target, channel, accountId)) return;

  // Video / tin thoại sang Zalo: tin xem / nghe được ngay, không phải tin file
  if (kind === 'video' && toZalo && await sendZaloVideoForward(auth, msg, getForwardLocalPath(msg, 'video'), target)) {
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }
  if (kind === 'voice' && toZalo && await sendZaloVoiceForward(auth, msg, target)) return;

  // Media còn lại: gửi lại từ file local (tải về nếu chưa có) để chuyển được giữa các tài khoản / kênh.
  const localPath = await ensureForwardLocalPath(msg, kind);
  if (localPath) {
    if (!toZalo) {
      if (!accountId) throw new Error('Không tìm thấy tài khoản gửi');
      const fileType = kind === 'image' ? 'image'
        : kind === 'video' ? (msg.msg_type === 'video_note' ? 'video_note' : 'video')
          : kind === 'voice' ? 'voice'
            : kind === 'sticker' ? 'sticker'
              : kind === 'animation' || kind === 'gif' ? 'animation'
                : 'file';
      const result = await getAdapter(channel as Channel).sendAttachment({
        accountId, threadId: target.threadId, filePath: localPath, threadType: target.threadType, fileType,
      });
      ensureForwardSuccess(result, 'Không gửi được tệp đính kèm');
    } else {
      // Ảnh / GIF (zca-js gửi .gif thành tin GIF) / sticker kênh khác dạng ảnh → sendImage; còn lại → file
      const asImage = (kind === 'image' || kind === 'gif' || kind === 'animation' || kind === 'sticker')
        && /\.(jpe?g|png|webp|gif)$/i.test(localPath);
      const result = asImage
        ? await ipc.zalo?.sendImage({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType, message: '' })
        : await ipc.zalo?.sendFile({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, 'Không gửi được tệp đính kèm Zalo');
    }

    // Không nhét caption vào attachment: gửi riêng để giữ đúng thứ tự/behaviour
    // chung giữa các kênh, và không làm mất text khi chuyển nhiều message.
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  // Không có file local: Facebook / Telegram còn native forward trên đúng tài khoản nguồn.
  const canUseNativeForward = !sourceAccountId || sourceAccountId === accountId;
  if (!toZalo && canUseNativeForward && msg.msg_id && accountId) {
    if (isFacebook(channel)) {
      const result = await getAdapter(channel as Channel).forwardMessage({
        accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, threadType: target.threadType,
      });
      ensureForwardSuccess(result, 'Không chuyển tiếp được tin nhắn Facebook');
      return;
    }
    const sourceThreadId = msg.thread_id || msg.chat_id;
    if (!sourceThreadId) throw new Error('Tin nhắn Telegram không có hội thoại nguồn');
    const result = await getAdapter(channel as Channel).forwardMessage({
      accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, sourceThreadId: String(sourceThreadId), threadType: target.threadType,
    });
    ensureForwardSuccess(result, 'Không chuyển tiếp được tin nhắn Telegram');
    return;
  }
  throw new Error(isZalo(msg.channel)
    ? 'Không tải được tệp từ Zalo (link đã hết hạn?) nên không chuyển tiếp được'
    : 'Tệp chưa được tải về; không thể chuyển tiếp sang tài khoản khác');
}

export interface ForwardJobTarget { threadId: string; threadType: number; accountId: string }

export interface ForwardJobContext {
  /** msg_id ảnh đầu → mọi tin của album (gửi gộp album) */
  albums: Record<string, any[]>;
  accounts: Array<{ zalo_id: string; channel?: string } & Record<string, any>>;
  /** Tài khoản đang mở (chuyển tiếp gốc Telegram / Facebook chỉ dùng được trên chính tài khoản nguồn) */
  sourceAccountId?: string | null;
  notify: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

export interface ForwardJobLabels {
  progress: (done: number, total: number) => string;
  done: string;
}

export const DEFAULT_FORWARD_LABELS: ForwardJobLabels = {
  progress: (done, total) => `Đang chuyển tiếp ${done}/${total}...`,
  done: 'Đã chuyển tiếp xong',
};

/**
 * Gửi các tin tới từng người nhận (chuyển tiếp / Lưu vào My Documents): album gộp 1 lần, còn lại từng tin;
 * nội dung soạn kèm (nếu có) là 1 tin mới sau cùng. Chạy nền, không block UI.
 */
export function runForwardJob(
  messages: any[],
  targets: ForwardJobTarget[],
  composeText: string,
  ctx: ForwardJobContext,
  labels: ForwardJobLabels = DEFAULT_FORWARD_LABELS,
): void {
  const units = groupForwardAlbums(messages, ctx.albums);
  // Chạy lần lượt ở background, không block UI
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
        firstFailure ||= 'Không tìm thấy tài khoản gửi';
        continue;
      }
      const targetChannel = targetAccount.channel || CHANNEL.ZALO;
      const targetAuth = isNonZalo(targetChannel)
        ? { cookies: '', imei: '', userAgent: '' }
        : buildZaloAuth(targetAccount);

      for (const unit of units) {
        // Album toàn ảnh (tải về nếu chưa có) → gửi gộp 1 lần để người nhận cũng thấy album.
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
              // Lỗi kiểm tra file trước khi upload → chưa gửi gì → gửi từng ảnh bên dưới
              albumDone = false;
              console.warn(`[Forward] Album first=${unit[0].msg_id} → gửi từng ảnh:`, e.message);
            } else {
              // Lỗi lúc gửi: không gửi lại từng ảnh (có thể đã gửi một phần → trùng)
              failCount += unit.length;
              firstFailure ||= e?.message || 'Không rõ lỗi';
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
            firstFailure ||= e?.message || 'Không rõ lỗi';
            console.warn(`[Forward] Failed msg=${msg.msg_id} target=${target.threadId}:`, e.message);
          }
          if (total > 1) {
            ctx.notify(labels.progress(counter, total), 'info');
          }
        }
      }

      // Nội dung người dùng soạn trong popup luôn là một tin mới, sau
      // toàn bộ các tin được forward tới người nhận này. Nó không được
      // phép thay thế text/caption của tin nguồn.
      if (forwardedAny && companionText) {
        try {
          await sendForwardText(targetAuth, targetChannel, target.accountId, {
            threadId: target.threadId,
            threadType: target.threadType,
          }, companionText);
        } catch (e: any) {
          failCount++;
          firstFailure ||= e?.message || 'Không rõ lỗi';
          console.warn(`[Forward] Failed companion target=${target.threadId}:`, e.message);
        }
      }
    }
    if (failCount === 0) {
      ctx.notify(labels.done, 'success');
    } else {
      ctx.notify(`${labels.done} (${failCount} lỗi): ${firstFailure}`, 'error');
    }
  })();
}
