/**
 * Facebook media of a message that is not on disk yet, or whose link died (Facebook CDN links carry an `oe=` expiry,
 * a few days to weeks): download the message's files; a dead link is refreshed by fetching the message again from
 * Messenger (one bridge history page that ends at the message) and the fresh links are stored before downloading.
 * Encrypted media goes through the bridge (directPath + mediaKey). One repair at a time per account, and a message is
 * refreshed at most once per 10 minutes.
 */
import path from 'path';
import fs from 'fs';
import type { FacebookE2EEBridge } from './e2ee/FacebookE2EEBridge';
import DatabaseService from '../database/DatabaseService';
import FileStorageService from '../file/FileStorageService';
import EventBroadcaster from '../event/EventBroadcaster';
import { isExpiredFacebookUrl } from './FacebookProfileResolver';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

export interface MediaRepairContext {
  accountId: string;
  /** Facebook id of the account (messages.owner_zalo_id, media folder). */
  ownerId(): string;
  bridge(): FacebookE2EEBridge | null;
  /** Bridge download of encrypted attachments (FacebookService.downloadE2EEAttachments). */
  downloadEncrypted(attachments: any[], messageId: string, threadId: string): Promise<{ saved: number; gone: number; failed: number } | void>;
}

export interface MediaRepairResult {
  success: boolean;
  localPaths?: Record<string, string>;
  /** The links were fetched again from Messenger. */
  refreshed?: boolean;
  /** Messenger no longer serves the file (messages.media_expired = 1): the bubble shows "expired" instead of retrying. */
  expired?: boolean;
  error?: string;
}

const DOWNLOADABLE = new Set(['image', 'photo', 'gif', 'sticker', 'video', 'audio', 'voice', 'file']);
const REFRESH_COOLDOWN_MS = 10 * 60_000;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

type StoredRow = { msg_id: string; thread_id: string; timestamp: number; attachments?: string; local_paths?: string };

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Key of attachment i in local_paths (`main` is also accepted for the first one). */
function localPathOf(paths: Record<string, string>, index: number): string {
  return paths[`att_${index}`] || (index === 0 ? paths.main || '' : '');
}

function fileExists(p: string): boolean {
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

/** Attachment entries that are media files (not cards, mentions or polls). */
export function downloadableIndexes(attachments: any[]): number[] {
  const out: number[] = [];
  attachments.forEach((a, i) => {
    const type = String(a?.type || '');
    if (DOWNLOADABLE.has(type) && (a?.url || a?.directPath)) out.push(i);
  });
  return out;
}

/**
 * Fresh links for a message from a bridge history page: by attachmentFbid when both sides have it, else by position
 * among the media attachments. Returns the merged attachments, or null when the message is not on the page.
 */
export function mergeFreshLinks(stored: any[], fresh: any[] | undefined): any[] | null {
  if (!Array.isArray(fresh)) return null;
  const freshMedia = fresh.filter(a => a && DOWNLOADABLE.has(String(a.type || '')) && a.url);
  if (!freshMedia.length) return null;
  // Id matches first; the others take the remaining fresh files in order
  const byId = stored.map(a => (a?.attachmentFbid
    ? freshMedia.findIndex(f => String(f.attachmentFbid || '') === String(a.attachmentFbid))
    : -1));
  const claimed = new Set(byId.filter(i => i >= 0));
  let cursor = 0;
  return stored.map((a, idx) => {
    const type = String(a?.type || '');
    if (!DOWNLOADABLE.has(type) || a?.directPath) return a;
    let pick = byId[idx];
    if (pick < 0) {
      while (cursor < freshMedia.length && claimed.has(cursor)) cursor += 1;
      if (cursor < freshMedia.length) {
        pick = cursor;
        claimed.add(cursor);
        cursor += 1;
      }
    }
    const match = pick >= 0 ? freshMedia[pick] : undefined;
    if (!match?.url) return a;
    return {
      ...a,
      url: match.url,
      ...(match.previewUrl ? { previewUrl: match.previewUrl } : {}),
      ...(match.attachmentFbid ? { attachmentFbid: String(match.attachmentFbid) } : {}),
    };
  });
}

async function downloadOne(ownerId: string, messageId: string, att: any): Promise<string> {
  const url = String(att.url || '');
  if (!url) return '';
  const ext = (() => { try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return ''; } })();
  const filename = `fb_${String(messageId).slice(-8)}_${Date.now()}${ext || ''}`;
  const type = String(att.type || '');
  if (type === 'image' || type === 'photo' || type === 'sticker' || (type === 'gif' && IMAGE_EXT.has(ext))) {
    return FileStorageService.downloadImage(ownerId, url, filename, undefined, undefined, 'https://www.facebook.com/');
  }
  if (type === 'video' || type === 'gif') {
    // A video entry whose link is a picture is only the poster frame.
    if (IMAGE_EXT.has(ext)) return '';
    return FileStorageService.downloadVideo(ownerId, url, filename, undefined, undefined);
  }
  return FileStorageService.downloadFile(ownerId, url, filename, undefined, undefined);
}

export class FacebookMediaRepair {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly refreshedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<MediaRepairResult>>();

  constructor(private readonly ctx: MediaRepairContext) {}

  /** Download (and refresh when needed) the media of one message. Calls for the same message share one run. */
  repair(messageId: string): Promise<MediaRepairResult> {
    const id = String(messageId || '');
    if (!id) return Promise.resolve({ success: false, error: tr('Tin nhắn không hợp lệ') });
    const running = this.inFlight.get(id);
    if (running) return running;
    const run = this.queue.then(() => this.run(id), () => this.run(id));
    const tracked = run.finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, tracked);
    this.queue = tracked.catch(() => undefined);
    return tracked;
  }

  /** messages.media_expired of the message (set when Messenger no longer serves its files, cleared once they download). */
  private setExpired(messageId: string, expired: boolean): void {
    try {
      DatabaseService.getInstance().run(
        `UPDATE messages SET media_expired = ? WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'facebook' AND COALESCE(media_expired, 0) != ?`,
        [expired ? 1 : 0, messageId, this.ctx.ownerId(), expired ? 1 : 0]);
    } catch (err: any) {
      Logger.warn(`[FacebookMediaRepair:${this.ctx.accountId}] media_expired ${messageId}: ${err.message}`);
    }
  }

  private row(messageId: string): StoredRow | undefined {
    return DatabaseService.getInstance().queryOne<StoredRow>(
      `SELECT msg_id, thread_id, timestamp, attachments, local_paths FROM messages
       WHERE msg_id = ? AND owner_zalo_id = ? AND channel = 'facebook' LIMIT 1`,
      [messageId, this.ctx.ownerId()]);
  }

  private async run(messageId: string): Promise<MediaRepairResult> {
    const ownerId = this.ctx.ownerId();
    const row = this.row(messageId);
    if (!row) return { success: false, error: tr('Không tìm thấy tin nhắn') };
    const threadId = String(row.thread_id || '');
    let attachments = parseJson<any[]>(row.attachments, []);
    const known = parseJson<Record<string, string>>(row.local_paths, {});
    const indexes = downloadableIndexes(attachments);
    if (!indexes.length) return { success: false, error: tr('Tin nhắn không có ảnh, video hay tệp') };

    const missing = indexes.filter(i => !fileExists(localPathOf(known, i)));
    if (!missing.length) return { success: true, localPaths: known };

    // Encrypted media: the bridge downloads and decrypts it. Its signed link expires too (Messenger keeps the file for a
    // while): a file Messenger no longer serves is flagged expired, so the bubble stops retrying.
    if (missing.some(i => attachments[i]?.directPath && attachments[i]?.mediaKey)) {
      const outcome = await this.ctx.downloadEncrypted(attachments, messageId, threadId);
      const after = parseJson<Record<string, string>>(this.row(messageId)?.local_paths, {});
      const ok = missing.every(i => fileExists(localPathOf(after, i)));
      if (ok) {
        this.setExpired(messageId, false);
        return { success: true, localPaths: after };
      }
      if (outcome && outcome.gone > 0 && outcome.saved === 0 && outcome.failed === 0) {
        this.setExpired(messageId, true);
        return { success: false, localPaths: after, expired: true, error: tr('Messenger không còn lưu file này') };
      }
      return { success: false, localPaths: after, error: tr('Không tải được tệp mã hóa') };
    }

    const localPaths: Record<string, string> = {};
    const tryDownload = async (list: any[], targets: number[]): Promise<number[]> => {
      const failed: number[] = [];
      for (const i of targets) {
        const att = list[i];
        if (!att?.url || isExpiredFacebookUrl(att.url)) { failed.push(i); continue; }
        try {
          const saved = await downloadOne(ownerId, messageId, att);
          if (saved) localPaths[`att_${i}`] = saved;
          else failed.push(i);
        } catch {
          failed.push(i);
        }
      }
      return failed;
    };

    let failed = await tryDownload(attachments, missing);
    let refreshed = false;
    if (failed.length) {
      const fresh = await this.refreshLinks(row, attachments);
      if (fresh) {
        attachments = fresh;
        refreshed = true;
        DatabaseService.getInstance().updateFBMessageAttachments(this.ctx.accountId, messageId, JSON.stringify(attachments));
        failed = await tryDownload(attachments, failed);
      }
    }

    if (Object.keys(localPaths).length) {
      DatabaseService.getInstance().updateLocalPaths(ownerId, messageId, localPaths);
      EventBroadcaster.emit('event:localPath', { zaloId: ownerId, msgId: messageId, threadId, localPaths });
    }
    if (refreshed) {
      EventBroadcaster.emit('fb:onMessagePatch', {
        fbAccountId: ownerId, threadId, messageId, attachments: JSON.stringify(attachments),
      });
    }
    const merged = { ...known, ...localPaths };
    if (failed.length) {
      return { success: false, localPaths: merged, refreshed, error: tr('Facebook không còn giữ tệp này') };
    }
    return { success: true, localPaths: merged, refreshed };
  }

  /** Fetch the message again (history page ending at it) and merge its fresh links; null when not possible. */
  private async refreshLinks(row: StoredRow, attachments: any[]): Promise<any[] | null> {
    const last = this.refreshedAt.get(row.msg_id) || 0;
    if (Date.now() - last < REFRESH_COOLDOWN_MS) return null;
    const bridge = this.ctx.bridge();
    if (!bridge || !/^mid\./.test(row.msg_id)) return null;
    this.refreshedAt.set(row.msg_id, Date.now());
    if (this.refreshedAt.size > 500) {
      const oldest = this.refreshedAt.keys().next().value;
      if (oldest) this.refreshedAt.delete(oldest);
    }
    try {
      const page = await bridge.fetchMessages({
        threadId: String(row.thread_id),
        beforeTimestampMs: Number(row.timestamp) + 1,
        beforeMessageId: row.msg_id,
      }, 20_000);
      const match = (page?.messages || []).find(m => String(m?.id || '') === row.msg_id);
      const merged = match ? mergeFreshLinks(attachments, match.attachments) : null;
      if (!merged) Logger.log(`[FacebookMediaRepair:${this.ctx.accountId}] message ${row.msg_id} not on the refreshed page`);
      return merged;
    } catch (err: any) {
      Logger.warn(`[FacebookMediaRepair:${this.ctx.accountId}] refresh ${row.msg_id}: ${err?.message || err}`);
      return null;
    }
  }
}
