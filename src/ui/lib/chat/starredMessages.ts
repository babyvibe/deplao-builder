/**
 * starredMessages.ts - "Tin đánh dấu" (starred messages, like Zalo).
 *
 * Pure helpers shared by the message context menu, the panel and the store (unit-tested in
 * src/__tests__/starredMessages.test.ts + starredMessagesAccounts.test.ts). Stars are local to Deplao
 * (table `starred_messages`, every channel); each star keeps a snapshot of the message
 * so the panel can still show it after the message row is deleted from the app.
 */
import { isFileType, isMediaType, isStickerType, isVideoType, isVoiceType, isLocationType } from './messageTypeUtils';
import { parseContent } from './messageParser';

/** Snapshot stored with a star (sender / conversation resolved by the renderer at star time). */
export interface StarredSnapshot {
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  isSent?: boolean;
  msgType?: string;
  content?: string;
  attachments?: string;
  localPaths?: string;
  timestamp?: number;
  threadName?: string;
  threadAvatar?: string;
  threadType?: number;
  channel?: string;
}

/** Row returned by DB / REST: the star + LEFT JOINed live message / names (null when gone). */
export interface StarredMessageRow {
  owner_zalo_id: string;
  thread_id: string;
  msg_id: string;
  starred_at: number;
  snapshot?: string | null;
  sender_id?: string | null;
  content?: string | null;
  msg_type?: string | null;
  timestamp?: number | null;
  attachments?: string | null;
  local_paths?: string | null;
  thread_type?: number | null;
  channel?: string | null;
  is_sent?: number | null;
  is_recalled?: number | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  thread_name?: string | null;
  thread_alias?: string | null;
  thread_avatar?: string | null;
  thread_contact_type?: string | null;
  thread_channel?: string | null;
}

export interface StarredItem {
  key: string;
  ownerId: string;
  threadId: string;
  msgId: string;
  starredAt: number;
  timestamp: number;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  isSent: boolean;
  threadName: string;
  threadAvatar: string;
  threadType: number;
  channel: string;
  msgType: string;
  content: string;
  attachments: string;
  localPaths: string;
  isRecalled: boolean;
  /** The message row no longer exists in the app (shown from the snapshot). */
  missing: boolean;
}

export const starKey = (threadId: string, msgId: string): string => `${threadId}|${msgId}`;

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const stringifyField = (value: unknown): string => (typeof value === 'string' ? value : value ? JSON.stringify(value) : '');

/** Snapshot of a chat message (+ names the renderer already knows). */
export function buildStarredSnapshot(msg: any, extra: {
  senderName?: string; senderAvatar?: string; threadName?: string; threadAvatar?: string; channel?: string;
} = {}): StarredSnapshot {
  return {
    senderId: str(msg?.sender_id),
    senderName: extra.senderName || '',
    senderAvatar: extra.senderAvatar || '',
    isSent: Number(msg?.is_sent) === 1,
    msgType: str(msg?.msg_type),
    content: str(msg?.content).slice(0, 8000),
    attachments: stringifyField(msg?.attachments).slice(0, 8000),
    localPaths: stringifyField(msg?.local_paths).slice(0, 2000),
    timestamp: Number(msg?.timestamp) || 0,
    threadName: extra.threadName || '',
    threadAvatar: extra.threadAvatar || '',
    threadType: Number(msg?.thread_type) || 0,
    channel: extra.channel || str(msg?.channel),
  };
}

function parseSnapshot(raw: unknown): StarredSnapshot {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as StarredSnapshot;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Live message data wins; the snapshot fills what is missing (deleted row, unknown sender…).
 * Exception: the sender of an OWN message. The DB joins the sender as a contact, which for the
 * account itself is its own contact row (Zalo keeps one per account) - its avatar can be an old URL
 * that no longer loads, so the snapshot (account name / avatar when starred) comes first. The panel
 * shows the current account on top of this (resolveStarredSender).
 */
export function toStarredItem(row: StarredMessageRow): StarredItem {
  const snap = parseSnapshot(row.snapshot);
  const live = !!(row.msg_type || row.content || row.timestamp);
  const isSent = row.is_sent !== null && row.is_sent !== undefined ? Number(row.is_sent) === 1 : !!snap.isSent;
  const ownerId = str(row.owner_zalo_id);
  const senderId = str(row.sender_id) || str(snap.senderId);
  const own = isSent || (!!senderId && senderId === ownerId);
  const [liveName, savedName] = [str(row.sender_name), str(snap.senderName)];
  const [liveAvatar, savedAvatar] = [str(row.sender_avatar), str(snap.senderAvatar)];
  return {
    key: `${row.owner_zalo_id}|${starKey(row.thread_id, row.msg_id)}`,
    ownerId,
    threadId: str(row.thread_id),
    msgId: str(row.msg_id),
    starredAt: Number(row.starred_at) || 0,
    timestamp: Number(row.timestamp) || Number(snap.timestamp) || 0,
    senderId,
    senderName: (own ? savedName || liveName : liveName || savedName) || str(row.sender_id) || str(snap.senderId),
    senderAvatar: own ? savedAvatar || liveAvatar : liveAvatar || savedAvatar,
    isSent,
    threadName: str(row.thread_alias) || str(row.thread_name) || str(snap.threadName) || str(row.thread_id),
    threadAvatar: str(row.thread_avatar) || str(snap.threadAvatar),
    threadType: row.thread_type !== null && row.thread_type !== undefined
      ? Number(row.thread_type) || 0
      : (row.thread_contact_type === 'group' ? 1 : Number(snap.threadType) || 0),
    channel: str(row.channel) || str(row.thread_channel) || str(snap.channel) || 'zalo',
    msgType: str(row.msg_type) || str(snap.msgType),
    content: live ? str(row.content) : str(snap.content),
    attachments: live ? str(row.attachments) : str(snap.attachments),
    localPaths: str(row.local_paths) || str(snap.localPaths),
    isRecalled: Number(row.is_recalled) === 1 || str(row.msg_type) === 'recalled',
    missing: !live,
  };
}

// ─── Sender / account (resolved when rendering) ──────────────────────────────

/** Account fields the panel needs (structural subset of accountStore's AccountInfo). */
export interface StarredAccountInfo {
  zalo_id: string;
  full_name?: string;
  display_name?: string;
  avatar_url?: string;
  facebook_id?: string;
}

export interface StarredSender {
  /** Sent by the account that starred it. */
  own: boolean;
  name: string;
  /** Avatar paths / URLs to try in order (deduplicated, no empties); the next one is used when one fails to load. */
  avatars: string[];
}

const uniqueNonEmpty = (values: unknown[]): string[] => [...new Set(values.map(str).filter(Boolean))];

/** Name of an account as the account list shows it. */
export function starredAccountName(account: StarredAccountInfo | null | undefined, fallback = ''): string {
  return str(account?.full_name).trim() || str(account?.display_name).trim() || fallback;
}

/** The message was sent by the account that starred it (Facebook messages carry the Facebook id as sender). */
export function isOwnStarredMessage(
  item: Pick<StarredItem, 'isSent' | 'senderId' | 'ownerId'>,
  account?: StarredAccountInfo | null,
): boolean {
  if (item.isSent) return true;
  const sender = str(item.senderId);
  return !!sender && (sender === str(item.ownerId) || sender === str(account?.facebook_id));
}

/**
 * Sender shown for a starred message. Own messages: the CURRENT account (looked up by the star's owner
 * account) - its name and avatar, then what was saved when starring as fallbacks; this also fixes stars
 * saved before the account changed its avatar. Other senders: the stored / joined name and avatar.
 */
export function resolveStarredSender(item: StarredItem, account?: StarredAccountInfo | null): StarredSender {
  if (isOwnStarredMessage(item, account)) {
    return {
      own: true,
      name: starredAccountName(account) || item.senderName || 'Bạn',
      avatars: uniqueNonEmpty([account?.avatar_url, item.senderAvatar]),
    };
  }
  return { own: false, name: item.senderName, avatars: uniqueNonEmpty([item.senderAvatar]) };
}

/**
 * Accounts whose stars the panel lists: the given ones (active account, or every merged-inbox account),
 * narrowed to the account picked in the merged-inbox filter - like the conversation list. A filter
 * account that is not listed is ignored.
 */
export function starredScopeAccountIds(accountIds: string[], mergedFilterAccount?: string | null): string[] {
  const ids = uniqueNonEmpty(accountIds || []);
  const picked = str(mergedFilterAccount);
  return picked && ids.includes(picked) ? [picked] : ids;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export type StarredPreviewKind = 'text' | 'image' | 'video' | 'file' | 'sticker' | 'voice' | 'location' | 'recalled';

export interface StarredPreview {
  kind: StarredPreviewKind;
  text: string;
  /** Image / video thumbnail URL (local media first, then remote). */
  thumb?: string;
}

function parseObject(value: string): any {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function firstAttachment(attachments: string): any {
  try {
    const list = JSON.parse(attachments || '[]');
    return Array.isArray(list) ? list[0] : null;
  } catch {
    return null;
  }
}

/** Local file of an image / video message (local_paths main → hd → thumb, then attachment.localPath). */
function localMediaPath(item: StarredItem, preferThumb = false): string {
  const paths = parseObject(item.localPaths) || {};
  const ordered = preferThumb
    ? [paths.thumb, paths.thumbnail, paths.main, paths.hd]
    : [paths.main, paths.hd, paths.file, paths.thumb, paths.thumbnail];
  const local = ordered.find((value: unknown) => typeof value === 'string' && value && !/\.jxl$/i.test(value));
  if (local) return local;
  const attachment = firstAttachment(item.attachments);
  return str(attachment?.localPath || attachment?.local_path);
}

function remoteMediaUrl(item: StarredItem, preferThumb = false): string {
  const content = parseObject(item.content);
  if (content) {
    let params = content.params;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
    const url = preferThumb
      ? (content.thumb || params?.thumb || content.href)
      : (params?.hd || params?.rawUrl || content.href || content.thumb);
    if (url) return str(url);
  }
  const attachment = firstAttachment(item.attachments);
  return str(attachment?.thumb || attachment?.thumbnail || attachment?.url || attachment?.href);
}

function fileName(item: StarredItem): string {
  const content = parseObject(item.content);
  const attachment = firstAttachment(item.attachments);
  return str(content?.title || attachment?.file_name || attachment?.fileName || attachment?.name) || 'Tệp đính kèm';
}

/** What the panel shows for a starred message (text, or a thumbnail + label). */
export function buildStarredPreview(item: StarredItem, toMediaUrl: (path: string) => string = path => path): StarredPreview {
  if (item.isRecalled) return { kind: 'recalled', text: 'Tin nhắn đã bị thu hồi' };
  const type = item.msgType;
  if (isStickerType(type)) return { kind: 'sticker', text: '[Sticker]' };
  if (isVoiceType(type)) return { kind: 'voice', text: '[Tin nhắn thoại]' };
  if (isLocationType(type)) return { kind: 'location', text: parseContent(item.content, type) || '📍 [Vị trí]' };
  if (isVideoType(type)) {
    const local = localMediaPath(item, true);
    return { kind: 'video', text: '[Video]', thumb: (local && !/\.(mp4|mov|webm|mkv)$/i.test(local) ? toMediaUrl(local) : '') || remoteMediaUrl(item, true) || undefined };
  }
  if (isMediaType(type, item.content, item.attachments)) {
    const local = localMediaPath(item);
    const thumb = (local ? toMediaUrl(local) : '') || remoteMediaUrl(item);
    // Telegram / Facebook keep the caption as plain text content; Zalo photos store JSON
    const caption = parseObject(item.content) || /^(https?|local-media):\/\//i.test(item.content.trim()) ? '' : item.content.trim();
    return { kind: 'image', text: caption || '[Hình ảnh]', thumb: thumb || undefined };
  }
  if (isFileType(type, item.content, item.attachments)) return { kind: 'file', text: fileName(item) };
  const text = parseContent(item.content, type).trim();
  return { kind: 'text', text: text || '[Tin nhắn]' };
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const pad = (value: number) => String(value).padStart(2, '0');

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayDiff(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Group header like Zalo: "Hôm nay", "Hôm qua", then dd/MM/yyyy. */
export function starredDayLabel(ts: number, now: number = Date.now()): string {
  const diff = dayDiff(ts, now);
  if (diff <= 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  return dateLabel(ts);
}

/** Message time next to the sender: "23:34", "23:34 Hôm qua", "11:51 06/08/2025". */
export function formatStarredMessageTime(ts: number, now: number = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = dayDiff(ts, now);
  if (diff <= 0) return time;
  if (diff === 1) return `${time} Hôm qua`;
  return `${time} ${dateLabel(ts)}`;
}

/** Items (newest star first) grouped by the day they were starred. */
export function groupStarredByDay(items: StarredItem[], now: number = Date.now()): Array<{ label: string; items: StarredItem[] }> {
  const groups: Array<{ label: string; items: StarredItem[] }> = [];
  for (const item of [...items].sort((a, b) => b.starredAt - a.starredAt)) {
    const label = starredDayLabel(item.starredAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
