/**
 * Groups messages for display in the chat window (pure, no React): photo albums (Zalo groupLayoutId / Telegram grouped_id /
 * Facebook photos next to each other within 30 seconds), duplicate polls (many votes with the same pollId → 1 bubble), runs of stickers
 * from the same sender within 30 minutes, an index of msg_id → position, and the message type parsed in advance for each row.
 */
import { isCardType, isEcardType, isFileType, isMediaType, isRtfMsg, isStickerType, isVideoType, isVoiceType } from '@/lib/chat/messages/messageTypeUtils';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { parseContent } from '@/lib/chat/messages/messageParser';
import { isZinstantMsgType } from '../../../../shared/zalo/zaloZinstant';
import { fbPollUpdateFromAttachments } from '../../../../shared/facebook/facebookSpecialMessages';

/** Extracts the groupLayoutId from a photo message sent as a group (is_group_layout=1) */
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
  /** msg_id of the first photo → every message of the album (in album order) */
  groupedFirstMsgs: Record<string, any[]>;
  /** A message that is not the album's first photo (does not draw its own row) */
  groupedSkipIds: Set<string>;
}

/** Photo album: same groupLayoutId (Zalo / Telegram) + Facebook photos from the same sender within 30 seconds. */
export function groupMediaAlbums(msgs: any[]): MediaAlbums {
  const byLayout: Record<string, any[]> = {};
  msgs.forEach((msg) => {
    const layoutId = getGroupLayoutId(msg);
    if (!layoutId) return;
    const key = `${msg.sender_id}_${layoutId}`;
    if (!byLayout[key]) byLayout[key] = [];
    byLayout[key].push(msg);
  });

  // ── Facebook: group photos from the same sender within 30 seconds ────────────────
  const FB_GROUP_WINDOW_MS = 30000;
  let fbCurrentGroup: any[] = [];
  const fbGroups: any[][] = [];

  const commitFbGroup = () => {
    if (fbCurrentGroup.length >= 2) fbGroups.push([...fbCurrentGroup]);
    fbCurrentGroup = [];
  };

  for (const msg of msgs) {
    // Skip if already in a Zalo layout group
    const existingLayoutId = getGroupLayoutId(msg);
    if (existingLayoutId) { commitFbGroup(); continue; }
    // Only group Facebook media messages
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

  // Facebook time-based groups (messages are already in order)
  for (const group of fbGroups) {
    groupedFirstMsgs[group[0].msg_id] = group;
    for (let i = 1; i < group.length; i++) groupedSkipIds.add(group[i].msg_id);
  }

  return { groupedFirstMsgs, groupedSkipIds };
}

/** Polls: many vote events with the same pollId → only one bubble is shown (the newest). */
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

/**
 * Messenger poll updates: the newest vote line of each poll shows the poll card again under it, like Messenger shows the
 * updated poll below its update lines. Returns vote line msg_id → msg_id of the poll card.
 */
export function facebookPollCardRows(msgs: any[]): Map<string, string> {
  const newest = new Map<string, { rowId: string; ts: number }>();
  for (const msg of msgs) {
    if (msg?.msg_type !== 'system') continue;
    const ref = fbPollUpdateFromAttachments(msg.attachments);
    if (!ref) continue;
    const ts = Number(msg.timestamp) || 0;
    const prev = newest.get(ref.poll_msg_id);
    if (!prev || ts >= prev.ts) newest.set(ref.poll_msg_id, { rowId: String(msg.msg_id), ts });
  }
  const rows = new Map<string, string>();
  for (const [pollMsgId, row] of newest) rows.set(row.rowId, pollMsgId);
  return rows;
}

export interface StickerRuns {
  groupedStickerFirstMsgs: Record<string, any[]>;
  groupedStickerSkipIds: Set<string>;
}

/** Stickers next to each other from the same sender within 30 minutes → 1 row. */
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
    // A recalled message / system message breaks the sticker group
    if (msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled' || msg.msg_type === 'system') {
      commitGroup(); continue;
    }
    if (msg.msg_type !== 'chat.sticker') { commitGroup(); continue; }
    // This is a sticker
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

/** msg_id → FIRST position in the list (like find / findIndex). */
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

/** Message type + text content parsed for each message (JSON.parse once per message, not on every render). */
export function buildMsgTypeCache(msgs: any[], groupedFirstMsgs: Record<string, any[]>): Map<string, MsgTypeInfo> {
  const cache = new Map<string, MsgTypeInfo>();

  msgs.forEach((msg) => {
    const mt = msg.msg_type || '';
    const mc = msg.content || '';

    // Use the existing helper functions
    const isCard = isCardType(mt, mc);
    const isEcard = isEcardType(mt);
    const isSticker = isStickerType(mt);
    const isRtf = isRtfMsg(mt, mc);
    const isPoll = mt === 'group.poll' || mt === 'telegram.poll' || mt === 'fb.poll' || (mt === 'poll' && isTelegram(msg.channel));
    // Telegram bot: GIF (animation, mp4) plays like a video; `voice` is a voice recording
    const isVideo = isVideoType(mt) || mt === 'gif';
    const isVoice = isVoiceType(mt);
    const isGroupMedia = !isPoll && !isVoice && !!groupedFirstMsgs[msg.msg_id];
    // Official Account news / notifications (zinstant): their own card, not guessed as a photo / file
    const isZinstant = isZinstantMsgType(mt, mc);
    const isMedia = !isCard && !isEcard && !isSticker && !isGroupMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isMediaType(mt, mc, msg.attachments);
    const isFile = !isCard && !isEcard && !isSticker && !isMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isFileType(mt, mc, msg.attachments);

    // Parse the content once
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
