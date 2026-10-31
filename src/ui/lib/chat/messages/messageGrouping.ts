/**
 * Gom tin để hiển thị trong khung chat (thuần, không React): album ảnh (Zalo groupLayoutId / Telegram grouped_id /
 * ảnh Facebook liền nhau trong 30 giây), bình chọn trùng (nhiều lần vote cùng pollId → 1 bong bóng), chuỗi sticker
 * cùng người gửi trong 30 phút, chỉ mục msg_id → vị trí, loại tin đã parse sẵn cho từng hàng.
 */
import { isCardType, isEcardType, isFileType, isMediaType, isRtfMsg, isStickerType, isVideoType, isVoiceType } from '@/lib/chat/messages/messageTypeUtils';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { parseContent } from '@/lib/chat/messages/messageParser';
import { isZinstantMsgType } from '../../../../shared/zalo/zaloZinstant';

/** Trích xuất groupLayoutId từ tin nhắn ảnh gửi theo nhóm (is_group_layout=1) */
export function getGroupLayoutId(msg: any): string | null {
  if (!isMediaType(msg.msg_type, msg.content, msg.attachments)) return null;
  if (isTelegram(msg.channel)) {
    // Telegram's grouped_id is authoritative for a mixed media album.
    // A post can contain photos and videos in the same album, therefore a
    // video must not be split into a separate bubble merely because it
    // needs a different tile renderer.
    const mediaType = String(msg.msg_type || '').toLowerCase();
    const isAlbumMedia = mediaType === 'photo' || mediaType === 'image'
      || mediaType === 'chat.photo' || mediaType === 'video'
      || mediaType === 'chat.video.msg' || mediaType === 'gif';
    if (!isAlbumMedia) return null;
    try {
      const attachments = typeof msg.attachments === 'string'
        ? JSON.parse(msg.attachments || '[]')
        : (msg.attachments || []);
      const grouped = (Array.isArray(attachments) ? attachments : [attachments]).find((item: any) =>
        (item?.type === 'telegram_grouped_media' || item?.type === 'telegram_post') && item?.grouped_id
      );
      if (grouped?.grouped_id) return `tg:${String(grouped.grouped_id)}`;
    } catch {}
  }
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    if (params.is_group_layout && params.group_layout_id) return String(params.group_layout_id);
  } catch {
  }
  return null;
}

export interface MediaAlbums {
  /** msg_id ảnh đầu → mọi tin của album (theo thứ tự trong album) */
  groupedFirstMsgs: Record<string, any[]>;
  /** Tin không phải ảnh đầu của album (không vẽ hàng riêng) */
  groupedSkipIds: Set<string>;
}

/** Album ảnh: cùng groupLayoutId (Zalo / Telegram) + ảnh Facebook cùng người gửi trong 30 giây. */
export function groupMediaAlbums(msgs: any[]): MediaAlbums {
  const byLayout: Record<string, any[]> = {};
  msgs.forEach((msg) => {
    const layoutId = getGroupLayoutId(msg);
    if (!layoutId) return;
    const key = `${msg.sender_id}_${layoutId}`;
    if (!byLayout[key]) byLayout[key] = [];
    byLayout[key].push(msg);
  });

  // ── Facebook: gom ảnh từ cùng người gửi trong 30 giây ────────────────
  const FB_GROUP_WINDOW_MS = 30000;
  let fbCurrentGroup: any[] = [];
  const fbGroups: any[][] = [];

  const commitFbGroup = () => {
    if (fbCurrentGroup.length >= 2) fbGroups.push([...fbCurrentGroup]);
    fbCurrentGroup = [];
  };

  for (const msg of msgs) {
    // Bỏ qua nếu đã nằm trong group Zalo layout
    const existingLayoutId = getGroupLayoutId(msg);
    if (existingLayoutId) { commitFbGroup(); continue; }
    // Chỉ gom media message Facebook
    const isFbMedia = isFacebook(msg.channel) && isMediaType(msg.msg_type, msg.content, msg.attachments);
    if (!isFbMedia) { commitFbGroup(); continue; }

    if (fbCurrentGroup.length === 0) {
      fbCurrentGroup = [msg];
    } else {
      const last = fbCurrentGroup[fbCurrentGroup.length - 1];
      const sameSender = msg.sender_id === last.sender_id;
      const withinWindow = Math.abs(msg.timestamp - last.timestamp) <= FB_GROUP_WINDOW_MS;
      if (sameSender && withinWindow) {
        fbCurrentGroup.push(msg);
      } else {
        commitFbGroup();
        fbCurrentGroup = [msg];
      }
    }
  }
  commitFbGroup();

  // ── Build output: Zalo layout groups + Facebook time groups ──────────
  const groupedFirstMsgs: Record<string, any[]> = {};
  const groupedSkipIds = new Set<string>();

  // Zalo layout groups (existing logic)
  for (const group of Object.values(byLayout)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      try {
        const pa = JSON.parse(a.content || '{}');
        const ppa = typeof pa.params === 'string' ? JSON.parse(pa.params) : (pa.params || {});
        const pb = JSON.parse(b.content || '{}');
        const ppb = typeof pb.params === 'string' ? JSON.parse(pb.params) : (pb.params || {});
        return (ppa.id_in_group || 0) - (ppb.id_in_group || 0);
      } catch { return 0; }
    });
    groupedFirstMsgs[sorted[0].msg_id] = sorted;
    for (let i = 1; i < sorted.length; i++) groupedSkipIds.add(sorted[i].msg_id);
  }

  // Facebook time-based groups (messages đã có thứ tự sẵn)
  for (const group of fbGroups) {
    groupedFirstMsgs[group[0].msg_id] = group;
    for (let i = 1; i < group.length; i++) groupedSkipIds.add(group[i].msg_id);
  }

  return { groupedFirstMsgs, groupedSkipIds };
}

/** Bình chọn: nhiều sự kiện vote cùng pollId → chỉ hiện 1 bong bóng (mới nhất). */
export function pollDuplicateIds(msgs: any[]): Set<string> {
  const skip = new Set<string>();
  const latest = new Map<string, { msgId: string; ts: number }>();
  msgs.forEach(msg => {
    if (msg.msg_type !== 'group.poll') return;
    try {
      const c = JSON.parse(msg.content || '{}');
      const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
      const pollId = String(params.pollId || '');
      if (!pollId) return;
      const prev = latest.get(pollId);
      if (!prev || msg.timestamp >= prev.ts) {
        if (prev) skip.add(prev.msgId);
        latest.set(pollId, { msgId: msg.msg_id, ts: msg.timestamp });
      } else {
        skip.add(msg.msg_id);
      }
    } catch {}
  });
  return skip;
}

export interface StickerRuns {
  groupedStickerFirstMsgs: Record<string, any[]>;
  groupedStickerSkipIds: Set<string>;
}

/** Sticker liền nhau cùng người gửi trong 30 phút → 1 hàng. */
export function groupStickerRuns(msgs: any[], groupedSkipIds: Set<string>, pollSkipIds: Set<string>): StickerRuns {
  const STICKER_GROUP_WINDOW_MS = 30 * 60 * 1000;
  const firstMsgs: Record<string, any[]> = {};
  const skipIds = new Set<string>();
  let currentGroup: any[] = [];

  const commitGroup = () => {
    if (currentGroup.length >= 2) {
      firstMsgs[currentGroup[0].msg_id] = [...currentGroup];
      for (let j = 1; j < currentGroup.length; j++) skipIds.add(currentGroup[j].msg_id);
    }
    currentGroup = [];
  };

  for (const msg of msgs) {
    if (groupedSkipIds.has(msg.msg_id)) continue;
    if (pollSkipIds.has(msg.msg_id)) continue;
    // Thu hồi / hệ thống phá vỡ nhóm sticker
    if (msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled' || msg.msg_type === 'system') {
      commitGroup(); continue;
    }
    if (msg.msg_type !== 'chat.sticker') { commitGroup(); continue; }
    // Đây là sticker
    if (currentGroup.length === 0) {
      currentGroup = [msg];
    } else {
      const last = currentGroup[currentGroup.length - 1];
      const sameSender = msg.sender_id === last.sender_id;
      const withinWindow = Math.abs(msg.timestamp - last.timestamp) <= STICKER_GROUP_WINDOW_MS;
      if (sameSender && withinWindow) {
        currentGroup.push(msg);
      } else {
        commitGroup();
        currentGroup = [msg];
      }
    }
  }
  commitGroup();
  return { groupedStickerFirstMsgs: firstMsgs, groupedStickerSkipIds: skipIds };
}

/** msg_id → vị trí ĐẦU TIÊN trong danh sách (như find / findIndex). */
export function indexMessagesById(msgs: any[]): Map<unknown, number> {
  const index = new Map<unknown, number>();
  msgs.forEach((m, i) => { if (!index.has(m.msg_id)) index.set(m.msg_id, i); });
  return index;
}

export interface MsgTypeInfo {
  isCard: boolean;
  isEcard: boolean;
  isSticker: boolean;
  isRtf: boolean;
  isPoll: boolean;
  isVideo: boolean;
  isVoice: boolean;
  isGroupMedia: boolean;
  isMedia: boolean;
  isFile: boolean;
  isZinstant: boolean;
  content: string;
}

/** Loại tin + nội dung chữ đã parse cho từng tin (JSON.parse 1 lần / tin, không mỗi lần render). */
export function buildMsgTypeCache(msgs: any[], groupedFirstMsgs: Record<string, any[]>): Map<string, MsgTypeInfo> {
  const cache = new Map<string, MsgTypeInfo>();

  msgs.forEach((msg) => {
    const mt = msg.msg_type || '';
    const mc = msg.content || '';

    // Sử dụng các helper functions có sẵn
    const isCard = isCardType(mt, mc);
    const isEcard = isEcardType(mt);
    const isSticker = isStickerType(mt);
    const isRtf = isRtfMsg(mt, mc);
    const isPoll = mt === 'group.poll' || mt === 'telegram.poll' || (mt === 'poll' && isTelegram(msg.channel));
    // Bot Telegram: GIF (animation, mp4) phát như video; `voice` là tin ghi âm
    const isVideo = isVideoType(mt) || mt === 'gif';
    const isVoice = isVoiceType(mt);
    const isGroupMedia = !isPoll && !isVoice && !!groupedFirstMsgs[msg.msg_id];
    // Bản tin / thông báo của Official Account (zinstant) — thẻ riêng, không đoán thành ảnh / file
    const isZinstant = isZinstantMsgType(mt, mc);
    const isMedia = !isCard && !isEcard && !isSticker && !isGroupMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isMediaType(mt, mc, msg.attachments);
    const isFile = !isCard && !isEcard && !isSticker && !isMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isFileType(mt, mc, msg.attachments);

    // Parse content 1 lần
    const content = (isMedia || isFile || isCard || isEcard || isSticker || isGroupMedia || isRtf || isPoll || isVideo || isVoice || isZinstant)
      ? ''
      : parseContent(mc, mt, msg.channel);

    cache.set(msg.msg_id, {
      isCard, isEcard, isSticker, isRtf, isPoll, isVideo, isVoice,
      isGroupMedia, isMedia, isFile, isZinstant, content
    });
  });

  return cache;
}
