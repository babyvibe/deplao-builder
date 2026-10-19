/**
 * mediaMessagesQuery.ts - SQL for the photos/videos of one conversation (db:getMediaMessages).
 *
 * - Offset pages (panel "Ảnh/Video", Public API): `ORDER BY timestamp DESC LIMIT ? OFFSET ?` - unchanged.
 * - Cursor pages (image viewer gallery "Bộ sưu tập"): keyset pages on (timestamp, msg_id), like the chat.
 *   SQLite answers them with a range seek on idx_messages_thread_cursor
 *   (owner_zalo_id, thread_id, timestamp DESC, msg_id DESC): no temp B-tree, cost proportional to the page
 *   instead of to OFFSET. Checked with EXPLAIN QUERY PLAN on the real schema without sqlite_stat1
 *   (never run ANALYZE on this DB - it flips other plans).
 *
 * Pure module (no DB handle) so it can be unit-tested without the native better-sqlite3 binding.
 */

/** Columns returned for media rows. */
export const MEDIA_MESSAGE_COLUMNS = 'msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel';

/** WHERE predicate that selects photo/video messages (Zalo content/local files + Facebook attachments). */
export const MEDIA_MESSAGE_FILTER = `(
                 (
                   msg_type NOT IN ('share.file', 'share.link', 'file', 'chat.recommended', 'chat.recommend',
                                    'webchat', 'text', 'group.poll', 'chat.sticker',
                                    'system.msg', 'notify.unread', 'chat.voice.msg', 'chat.gif')
                   AND (
                     msg_type IN ('photo', 'image', 'chat.photo', 'chat.video.msg')
                     OR (local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
                         AND msg_type NOT IN ('share.file','share.link','file'))
                     OR content LIKE '%"rawUrl"%'
                   )
                 )
                 OR (channel = 'facebook' AND msg_type IN ('image', 'photo', 'video', 'sticker', 'animated_image')
                     AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )`;

/**
 * Keyset cursor. `before*` = rows strictly older than (beforeTs, beforeMsgId); `after*` = strictly newer than
 * (afterTs, afterMsgId). Without the msgId the bound is inclusive on the timestamp (callers dedupe), like the
 * `before` of db:getMessages. Both may be given (rows in between).
 */
export interface MediaCursor {
  beforeTs?: number;
  beforeMsgId?: string;
  afterTs?: number;
  afterMsgId?: string;
}

/** Largest cursor page (IPC / REST input is not a safe boundary). */
export const MEDIA_CURSOR_MAX_LIMIT = 200;

function cursorTs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cursorMsgId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s.slice(0, 256) : undefined;
}

/**
 * Reads cursor params from an IPC / REST payload (numbers or query-string values). Returns null when the
 * request has no usable cursor - callers then keep the offset behaviour, so unknown/old callers are unaffected.
 */
export function normalizeMediaCursor(raw: unknown): MediaCursor | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const beforeTs = cursorTs(src.beforeTs);
  const afterTs = cursorTs(src.afterTs);
  if (beforeTs === undefined && afterTs === undefined) return null;
  const cursor: MediaCursor = {};
  if (beforeTs !== undefined) {
    cursor.beforeTs = beforeTs;
    const id = cursorMsgId(src.beforeMsgId);
    if (id) cursor.beforeMsgId = id;
  }
  if (afterTs !== undefined) {
    cursor.afterTs = afterTs;
    const id = cursorMsgId(src.afterMsgId);
    if (id) cursor.afterMsgId = id;
  }
  return cursor;
}

/** Page size for cursor pages: 1..MEDIA_CURSOR_MAX_LIMIT. */
export function clampMediaPageLimit(limit: unknown, fallback = 50): number {
  const n = Math.floor(Number(limit));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1), MEDIA_CURSOR_MAX_LIMIT);
}

/**
 * Cursor page query. With a `before` bound it scans newest → oldest from the cursor; with only an `after` bound
 * it scans oldest → newest (`ascending: true` - the caller reverses, so results are always newest-first like the
 * offset pages).
 */
export function buildMediaCursorQuery(
  ownerZaloId: string,
  threadId: string,
  cursor: MediaCursor,
  limit: number,
): { sql: string; params: Array<string | number>; ascending: boolean } {
  const bounds: string[] = [];
  const params: Array<string | number> = [ownerZaloId, threadId];
  if (cursor.beforeTs !== undefined) {
    if (cursor.beforeMsgId) {
      bounds.push('(timestamp, msg_id) < (?, ?)');
      params.push(cursor.beforeTs, cursor.beforeMsgId);
    } else {
      bounds.push('timestamp <= ?');
      params.push(cursor.beforeTs);
    }
  }
  if (cursor.afterTs !== undefined) {
    if (cursor.afterMsgId) {
      bounds.push('(timestamp, msg_id) > (?, ?)');
      params.push(cursor.afterTs, cursor.afterMsgId);
    } else {
      bounds.push('timestamp >= ?');
      params.push(cursor.afterTs);
    }
  }
  const ascending = cursor.beforeTs === undefined;
  params.push(limit);
  const sql = `SELECT ${MEDIA_MESSAGE_COLUMNS}
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?${bounds.map(b => `\n               AND ${b}`).join('')}
               AND ${MEDIA_MESSAGE_FILTER}
             ORDER BY ${ascending ? 'timestamp ASC, msg_id ASC' : 'timestamp DESC, msg_id DESC'}
             LIMIT ?`;
  return { sql, params, ascending };
}
