/**
 * DataAccessor: the middle layer between UI components and the data source.
 *
 * - standalone / boss mode: calls window.electronAPI (IPC) as before
 * - employee mode: calls RestQueryService (REST API via fetch → Boss)
 *
 * UI components need no changes; they only call DataAccessor instead of ipc.db.xxx directly.
 * It lives in the renderer process and uses the Zustand store to check the mode.
 */

import { useEmployeeStore } from '../../store/employee/employeeStore';
import RestQueryService from '../../../services/http/RestQueryService';
import type { ErpZaloNotifySettings, ErpZaloNotifyStatus } from '../../../shared/erp/erpZaloNotify';
import type { CampaignEngagementResponse } from '../../../shared/analytics/messageEngagement';
import type { CampaignCloneParams, CampaignCloneResponse } from '../../../shared/crm/campaignCopy';
import { tr } from '../../../shared/i18n';

// ── Helper ──────────────────────────────────────────────────────────

function isEmployee(): boolean {
  try {
    return useEmployeeStore.getState().mode === 'employee';
  } catch {
    return false;
  }
}

// ── Cache for library items (30 minutes) ──────────────────────────────
const CACHE_TTL_LIBRARY = 30 * 60 * 1000;
const libraryCache = new Map<string, { data: any; ts: number }>();

function getCachedLibrary(key: string): any | null {
  const entry = libraryCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_LIBRARY) return entry.data;
  libraryCache.delete(key);
  return null;
}
/** Only successful results are cached: a network error must not turn into an "thư viện trống" (empty library) for 30 minutes. */
function setCachedLibrary(key: string, data: any): void {
  if (!data || data.success === false) return;
  libraryCache.set(key, { data, ts: Date.now() });
  if (libraryCache.size > 100) { // prune sau 100 entries
    const now = Date.now();
    for (const [k, v] of libraryCache) {
      if (now - v.ts > CACHE_TTL_LIBRARY) libraryCache.delete(k);
    }
  }
}
/** Clears the library cache to force a reload (called after upload/delete) */
function invalidateLibraryCache(): void {
  libraryCache.clear();
}
/** Clears the library cache so the UI can refresh manually */
export function refreshLibraryCache(): void {
  libraryCache.clear();
}

function rest(): RestQueryService {
  return RestQueryService.getInstance();
}

/**
 * Employee mode (analytics): keep a REST failure visible as `success: false` — Reports then warns
 * about that account instead of rendering `undefined` as an empty report.
 */
function restReport(res: { success?: boolean; data?: any; error?: string } | null | undefined, fallback?: any) {
  return { success: !!res && res.success !== false, data: res?.data ?? fallback, error: res?.error };
}

// ── Error contract of read commands (employee mode) ─────────────────────────
//
// Every failed REST read returns `{ success: false, error, code, ...empty parts }`: the empty parts keep EXACTLY the shape they have
// on success (empty arrays, `null`...) so callers that only read the arrays do not crash, but it NEVER reports
// `success: true` on an error. Callers must keep the old data when `isReadFailure(res)` is true (not replace it with empty,
// no caching, no "đã tải" (loaded) stamp). Messages (getMessages/getMessagesAround/getFileMessages) still return
// `messages`/`items` are arrays as before, plus `success`/`error` with the same shape as the IPC branch
// (`{ success, messages }`). The IPC branch (owner / standalone) stays as it is.

type RestRes = { success?: boolean; data?: any; error?: string; code?: string; pagination?: any } | null | undefined;

const READ_FAILED_MESSAGE = tr('Không tải được dữ liệu từ BOSS');

/**
 * The list in a REST response: `data` is an array or `data.items`, always returns an array. The `any` type, as `res.data?.items` was before: matches the IPC branch type, so the caller's inferred type does not change.
 */
function restItems(res: RestRes): any {
  const data = res?.data;
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

/** The common part of a failed read result: spread into an object together with the empty parts of the same shape. */
function restFail(res: RestRes): { success: false; error: string; code?: string } {
  return { success: false, error: res?.error || READ_FAILED_MESSAGE, code: res?.code };
}

const WRITE_FAILED_MESSAGE = tr('Không ghi được dữ liệu lên BOSS');

/**
 * Result of a REST write command (employee) → the same shape as the IPC branch: `{ success, error?, code?, …result fields }`.
 * Boss returns `{ success, id }` / `{ success, count }` (IPC handler) or `{ success, data: { id } }`; RestQueryService wraps it
 * in `res.data`, so before, the caller's `res.id` / `res.count` (as in the IPC branch) was always undefined. `data` is kept too,
 * so old callers can still read `res.data?.id`. An error (network, Boss refused) → `success: false` + a message, never "thành công" (success).
 */
export function restWriteResult(res: RestRes): any {
  if (!res || !res.success) return { success: false, error: res?.error || WRITE_FAILED_MESSAGE, code: res?.code };
  const data = res.data;
  const fields = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return { ...fields, success: true, data };
}

/**
 * A read that reports an error (`success === false`) → the caller keeps the data it has, it is not replaced with empty.
 * Employee mode: REST error / connection lost. Owner / standalone: IPC only returns `false` when the DB fails.
 */
export function isReadFailure(res: unknown): boolean {
  return !!res && typeof res === 'object' && (res as { success?: unknown }).success === false;
}

/** Error message of a read result (empty when there is no error). */
export function readFailureMessage(res: unknown): string {
  if (!isReadFailure(res)) return '';
  const error = (res as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : READ_FAILED_MESSAGE;
}

/**
 * Map keyed by account (pins, "Nhãn Local" (Local labels)...): only writes `zaloId` when the read succeeded; on error it returns the old object unchanged
 * (keeps that account's old data, React skips the render).
 */
export function mergeAccountOnSuccess<T>(
  prev: Record<string, T>, zaloId: string, res: unknown, value: () => T,
): Record<string, T> {
  return isReadFailure(res) ? prev : { ...prev, [zaloId]: value() };
}

/** First page (offset 0) or the next page (infinite scroll) of the conversation list. */
export type ConversationPage = 'first' | 'more';

/**
 * Paging of the conversation list. `failures` = number of consecutive failed loads, `failedPage` = which page the last failure was on
 * (so "Thử lại" (Retry) repeats exactly that request).
 */
export interface ConversationPaging {
  nextOffset: number;
  hasMore: boolean;
  exhausted: boolean;
  failures: number;
  failedPage: ConversationPage | null;
}

/**
 * Paging state after one page load. Success → the offset moves on (first page: reset from 0), `hasMore` follows
 * the server, the error is cleared. Error (or no result) → KEEPS the offset + `hasMore` (can still retry), only the
 * error count goes up: the list only stops for good when the server says there is nothing more (`hasMore: false`).
 */
export function nextConversationPaging(
  prev: ConversationPaging,
  res: { success?: boolean; items?: unknown; hasMore?: boolean } | null | undefined,
  page: ConversationPage,
): ConversationPaging {
  if (!res || isReadFailure(res)) return { ...prev, failures: prev.failures + 1, failedPage: page };
  const count = Array.isArray(res.items) ? res.items.length : 0;
  const hasMore = !!res.hasMore;
  return {
    nextOffset: (page === 'first' ? 0 : prev.nextOffset) + count,
    hasMore,
    exhausted: !hasMore,
    failures: 0,
    failedPage: null,
  };
}

/**
 * Wait time before automatic retry number `failures` (1, 2, …): 2 s, 4 s, 8 s, 16 s, 30 s; after `maxAuto` tries
 * `null` = stop retrying automatically (still retried on scroll / when "Thử lại" (Retry) is pressed / when reconnected).
 */
export function retryDelayMs(failures: number, opts: { baseMs?: number; maxMs?: number; maxAuto?: number } = {}): number | null {
  const { baseMs = 2000, maxMs = 30_000, maxAuto = 5 } = opts;
  if (!Number.isFinite(failures) || failures < 1 || failures > maxAuto) return null;
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

// ── DataAccessor ─────────────────────────────────────────────────────

export class DataAccessor {
  // ═════════════════════════════════════════════════════════════════
  // MESSAGES
  // ═════════════════════════════════════════════════════════════════

  static async getMessages(params: {
    zaloId: string;
    threadId: string;
    limit?: number;
    before?: number;
    offset?: number;
    topicId?: string;
  }) {
    if (isEmployee()) {
      const query: any = {
        zaloId: params.zaloId,
        threadId: params.threadId,
        limit: params.limit || 50,
      };
      if (params.before !== undefined) query.before = params.before;
      if (params.offset !== undefined) query.offset = params.offset;
      if (params.topicId !== undefined) query.topicId = params.topicId;
      const res = await rest().get('/api/query/messages', query);
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { success: true, messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      // Error: still an empty array (old callers do not crash) but `success: false`: "tải tin cũ" (load older messages) must show
      // "Thử lại" (Retry) instead of concluding there are no more messages.
      if (!res.success) return { ...restFail(res), messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
      return { success: true, messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getMessages({
      zaloId: params.zaloId,
      threadId: params.threadId,
      limit: params.limit || 50,
      offset: params.offset || 0,
      before: params.before,
      topicId: params.topicId,
    });
  }

  static async getMessagesAround(params: {
    zaloId: string;
    threadId: string;
    timestamp?: number;
    /** @deprecated Pass timestamp. Kept for older callers/employee REST compatibility. */
    msgId?: string;
    limit?: number;
  }) {
    const timestamp = Number(params.timestamp ?? params.msgId);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return { messages: [], items: [] };
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/around', {
        ...params,
        msgId: String(timestamp),
      });
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { success: true, messages: items, items };
      }
      if (!res.success) return { ...restFail(res), messages: [] as any[], items: [] as any[] };
      return { success: true, messages: [] as any[], items: [] as any[] };
    }
    return window.electronAPI.db.getMessagesAround({
      zaloId: params.zaloId,
      threadId: params.threadId,
      timestamp,
      limit: params.limit,
    });
  }

  static async getFileMessages(params: {
    zaloId: string;
    threadId: string;
    limit?: number;
    offset?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/file', params);
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { success: true, messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      if (!res.success) return { ...restFail(res), messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
      return { success: true, messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getFileMessages(params);
  }

  /**
   * Photos / videos of the conversation, new → old.
   * - `limit`/`offset`: page by offset (the Photos / Videos panel).
   * - `beforeTs`+`beforeMsgId` / `afterTs`+`afterMsgId`: keyset page by (timestamp, msg_id) for the image viewer's gallery
   *   (the result is still new → old, offset is ignored).
   * Employee mode: an old Boss ignores the cursor and returns the newest page → returns `cursorUnsupported: true`, with no rows
   * (to avoid holes in the gallery); the caller falls back to the offset page itself.
   */
  static async getMediaMessages(params: {
    zaloId: string;
    threadId?: string;
    limit?: number;
    offset?: number;
    beforeTs?: number;
    beforeMsgId?: string;
    afterTs?: number;
    afterMsgId?: string;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/media', params);
      if (res.success && res.data) {
        const wantsCursor = params.beforeTs != null || params.afterTs != null;
        if (wantsCursor && res.data.cursor !== true) {
          return { success: true, messages: [], items: [], pagination: { hasMore: false }, cursorUnsupported: true };
        }
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { success: true, messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      if (!res.success) return { ...restFail(res), messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
      return { success: true, messages: [] as any[], items: [] as any[], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getMediaMessages(params);
  }

  static async searchMessages(params: { zaloId: string; query: string }) {
    if (isEmployee()) {
      // `query` = the IPC parameter name (new Boss reads it); `q` for an old Boss (it used to read only `q` → message search always failed)
      const res = await rest().get('/api/search/messages', { ...params, q: params.query });
      if (!res.success) return { ...restFail(res), messages: [] as any[], results: [] as any[] };
      const items = restItems(res);
      // `results` = the key of the IPC branch that callers read (before, only `messages` existed → message search was always empty)
      return { success: true, messages: items, results: items };
    }
    return window.electronAPI.db.searchMessages({
      zaloId: params.zaloId,
      query: params.query,
    });
  }

  static async getMessageById(params: { zaloId: string; msgId: string; threadId?: string }) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/messages/${params.msgId}`, params);
      if (!res.success) return { ...restFail(res), message: null };
      return { success: true, message: res.data };
    }
    return window.electronAPI.db.getMessageById(params);
  }

  /** Batch lookup: gets many messages by IDs in 1 IPC call */
  static async getMessagesByIds(params: { zaloId: string; msgIds: string[] }) {
    if (isEmployee()) {
      // Employee mode: fallback to individual lookups (no batch REST endpoint)
      const results: any[] = [];
      let failed: any = null;
      for (const msgId of params.msgIds) {
        const res: any = await this.getMessageById({ zaloId: params.zaloId, msgId });
        if (isReadFailure(res)) failed = res;
        else if (res?.message) results.push(res.message);
      }
      // If a lookup fails → reports the error but still returns the messages that were found
      if (failed) return { success: false, error: readFailureMessage(failed), code: failed.code as string | undefined, messages: results };
      return { success: true, messages: results };
    }
    return window.electronAPI.db.getMessagesByIds(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONVERSATIONS (Contacts)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Conversations by a list of ids (≤ 200): pinned conversations sit on a later page of the time-paged list.
   * A read error returns `success: false` (not "không có" (none)).
   */
  static async getConversationsByIds(zaloId: string, ids: string[]) {
    const unique = [...new Set(ids.map(String).filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return { success: true, items: [] as any[] };
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations', { zaloId, ids: unique.join(','), limit: unique.length });
      if (!res.success) return { ...restFail(res), items: [] as any[] };
      const items = Array.isArray(res.data) ? res.data : (res.data?.items || []);
      return { success: true, items };
    }
    const ipcRes = await window.electronAPI.db.getContactsFiltered({ zaloId, contactIds: unique, limit: unique.length });
    if (ipcRes?.success === false) return { success: false, error: (ipcRes as any).error || tr('Không đọc được hội thoại'), items: [] as any[] };
    return { success: true, items: ipcRes?.contacts ?? [] };
  }

  /**
   * Filtered conversations of the conversation list (channel / search / "Chưa đọc" (Unread) / "Khác" (Other) / "Chưa trả lời" (Not replied) / date range), the same as the IPC
   * db:getContactsFiltered (`{ success, contacts }`). Employee: Boss filters on Boss's DB. Before, the list called the IPC directly,
   * and the employee machine's DB returned empty, so every filter gave an empty list. A read error returns `success: false` (not "không có" (none)).
   */
  static async getContactsFiltered(params: {
    zaloId: string; channel?: string; search?: string; unreadOnly?: boolean; othersOnly?: boolean; excludeOthers?: boolean;
    unrepliedOnly?: boolean; fromTs?: number; toTs?: number; limit?: number; offset?: number;
  }): Promise<{ success: boolean; contacts: any[]; error?: string; code?: string }> {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations/filtered', params);
      if (!res.success) return { ...restFail(res), contacts: [] as any[] };
      return { success: true, contacts: restItems(res) };
    }
    const ipcRes: any = await window.electronAPI.db.getContactsFiltered(params);
    if (ipcRes?.success === false) return { success: false, error: ipcRes.error || tr('Không đọc được hội thoại'), contacts: [] as any[] };
    return { success: true, contacts: Array.isArray(ipcRes?.contacts) ? ipcRes.contacts : [] };
  }

  static async getConversations(zaloId: string, limit = 50, offset = 0) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations', { zaloId, limit, offset });
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return {
          success: true,
          items,
          total: res.pagination?.total || items.length,
          hasMore: res.pagination?.hasMore || false,
        };
      }
      // An error is not "hết hội thoại" (no more conversations): the caller keeps the list + `hasMore` and retries (see nextConversationPaging)
      if (!res.success) return { ...restFail(res), items: [] as any[], total: 0, hasMore: false };
      return { success: true, items: [] as any[], total: 0, hasMore: false };
    }
    // Keep the initial conversation list bounded. The extra row tells the UI
    // whether to request the next page without serializing all contacts over IPC.
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 500);
    const ipcRes = await window.electronAPI.db.getContactsFiltered({
      zaloId,
      limit: pageSize + 1,
      offset: Math.max(Math.floor(Number(offset) || 0), 0),
    });
    const contactList = ipcRes?.contacts ?? [];
    const hasMore = contactList.length > pageSize;
    return {
      success: true,
      items: hasMore ? contactList.slice(0, pageSize) : contactList,
      total: contactList.length,
      hasMore,
    };
    }

  static async searchConversations(zaloId: string, query: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations', { zaloId, search: query, limit: 50 });
      if (!res.success) return { ...restFail(res), items: [] as any[] };
      return { success: true, items: restItems(res) };
    }
    const allRes = await window.electronAPI.db.getContacts(zaloId); const all = allRes?.contacts ?? allRes ?? [];
    const q = query.toLowerCase();
    const filtered = (all || []).filter((c: any) =>
      (c.display_name || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.contact_id || '').includes(q)
    );
    return { success: true, items: filtered };
  }

  static async getConversationById(zaloId: string, contactId: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/conversations/${contactId}`, { zaloId });
      return res.success ? (res.data ?? null) : null; // same as IPC: a conversation row or null
    }
    const allRes = await window.electronAPI.db.getContacts(zaloId); const all = allRes?.contacts ?? allRes ?? [];
    return (all || []).find((c: any) => c.contact_id === contactId) || null;
  }

  static async setContactFlags(params: {
    zaloId: string;
    contactId: string;
    flags: { is_muted?: number; mute_until?: number; is_in_others?: number; has_mention?: number };
  }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/conversations/${encodeURIComponent(params.contactId)}/flags`, params));
    }
    return window.electronAPI.db.setContactFlags(params);
  }

  static async setContactAlias(params: { zaloId: string; contactId: string; alias: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/conversations/${encodeURIComponent(params.contactId)}/alias`, params));
    }
    return window.electronAPI.db.setContactAlias(params);
  }

  static async deleteConversation(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/conversations/${encodeURIComponent(params.contactId)}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.db.deleteConversation(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIENDS
  // ═════════════════════════════════════════════════════════════════

  static async getFriends(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friends', params);
      // Error: does not stamp `lastFetched`: an empty list caused by an error is not treated as "vừa tải xong" (just loaded)
      if (!res.success) return { ...restFail(res), friends: [] as any[], lastFetched: undefined as number | undefined };
      // lastFetched = when Boss loaded the list from Zalo (as IPC; 0 = never); before, it was Date.now() → the old list
      // was never refreshed in the background (GroupModals)
      return { success: true, friends: restItems(res), lastFetched: Number(res.data?.lastFetched) || 0 };
    }
    return window.electronAPI.db.getFriends(params);
  }

  static async addFriend(params: { zaloId: string; friend: any }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/friends', params));
    }
    return window.electronAPI.db.addFriend(params);
  }

  static async removeFriend(params: { zaloId: string; userId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/friends/${encodeURIComponent(params.userId)}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.db.removeFriend(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIEND REQUESTS
  // ═════════════════════════════════════════════════════════════════

  static async getFriendRequests(params: { zaloId: string; direction: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friend-requests', params);
      if (!res.success) return { ...restFail(res), requests: [] as any[], lastFetched: undefined as number | undefined };
      return { success: true, requests: restItems(res), lastFetched: Number(res.data?.lastFetched) || 0 };
    }
    return window.electronAPI.db.getFriendRequests(params as any);
  }

  static async upsertFriendRequest(params: { zaloId: string; request: any; direction: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/friend-requests', params));
    }
    return window.electronAPI.db.upsertFriendRequest(params as any);
  }

  static async removeFriendRequest(params: { zaloId: string; userId: string; direction: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/friend-requests/${encodeURIComponent(params.userId)}?zaloId=${encodeURIComponent(params.zaloId)}&direction=${encodeURIComponent(params.direction)}`));
    }
    return window.electronAPI.db.removeFriendRequest(params as any);
  }

  // ═════════════════════════════════════════════════════════════════
  // GROUPS
  // ═════════════════════════════════════════════════════════════════

  static async getGroupMembers(params: { zaloId: string; groupId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/groups/members', params);
      if (!res.success) return { ...restFail(res), members: [] as any[] };
      return { success: true, members: restItems(res) };
    }
    return window.electronAPI.db.getGroupMembers(params);
  }

  /** A page of group members + the total (the "Thành viên" (Members) panel): searches by name / @username / id in the DB, ignoring diacritics. */
  static async getGroupMembersPage(params: { zaloId: string; groupId: string; query?: string; limit?: number; offset?: number; ownerRole?: number; namedOnly?: boolean }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/groups/members/page', params);
      if (!res.success) return { ...restFail(res), members: [] as any[], total: 0 };
      return { success: true, members: restItems(res), total: Number(res.data?.total) || 0 };
    }
    return window.electronAPI.db.getGroupMembersPage(params);
  }

  static async saveGroupMembers(params: { zaloId: string; groupId: string; members: any[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/groups/members', params));
    }
    return window.electronAPI.db.saveGroupMembers(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM NOTES
  // ═════════════════════════════════════════════════════════════════

  static async getCRMNotes(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/notes', params);
      if (!res.success) return { ...restFail(res), notes: [] as any[] };
      return { success: true, notes: restItems(res) };
    }
    return window.electronAPI.crm.getNotes(params);
  }

  static async saveCRMNote(params: { zaloId: string; note: any }) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/crm/notes', params);
      // Before, it always reported success → the note was lost without the user knowing
      if (!res.success) return { ...restFail(res), id: undefined as number | undefined };
      return { success: true, id: res.data?.id };
    }
    return window.electronAPI.crm.saveNote(params);
  }

  static async deleteCRMNote(params: { zaloId: string; noteId: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/crm/notes/${params.noteId}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.crm.deleteNote(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM CAMPAIGNS
  // ═════════════════════════════════════════════════════════════════

  static async getCRMCampaigns(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns', params);
      if (!res.success) return { ...restFail(res), campaigns: [] as any[] };
      return { success: true, campaigns: restItems(res) };
    }
    return window.electronAPI.crm.getCampaigns(params);
  }

  static async saveCRMCampaign(params: { zaloId: string; campaign: any }) {
    if (isEmployee()) {
      // Photos in the message template are files on the employee's machine → uploaded to Boss first (the send queue runs on Boss). Before,
      // REST saved the employee machine's path as is → Boss could not find the photo when sending the campaign.
      const prepared = await DataAccessor.uploadCampaignImages(params.campaign, params.zaloId);
      if (prepared.success === false) return { success: false, error: prepared.error, id: undefined as number | undefined };
      const res = restWriteResult(await rest().post('/api/command/crm/campaigns', { ...params, campaign: prepared.campaign }));
      return { success: !!res.success, id: res.id as number | undefined, error: res.error, code: res.code };
    }
    return window.electronAPI.crm.saveCampaign(params);
  }

  /**
   * Employee: the photos of the campaign message template (template_message.blocks[].images) → Boss paths. A photo that cannot be read on
   * this machine (already a Boss path when an old campaign was edited) is kept as it is; a photo that can be read but fails to upload → reports an error.
   */
  private static async uploadCampaignImages(campaign: any, zaloId: string): Promise<{ success: true; campaign: any } | { success: false; error: string }> {
    const raw = campaign?.template_message;
    if (!raw) return { success: true, campaign };
    let parsed: any;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { success: true, campaign }; }
    if (!Array.isArray(parsed?.blocks)) return { success: true, campaign };
    let changed = false;
    for (const block of parsed.blocks) {
      if (!Array.isArray(block?.images) || block.images.length === 0) continue;
      const next: string[] = [];
      for (const imagePath of block.images) {
        const up = await DataAccessor.uploadMediaFile(imagePath, zaloId);
        if (up.success && up.bossPath) {
          next.push(up.bossPath);
          changed = true;
        } else if (up.code === 'LOCAL_FILE_UNREADABLE') {
          next.push(imagePath); // not on this machine → already a Boss file
        } else {
          return { success: false, error: tr('Không tải được ảnh chiến dịch lên Boss: {{v1}}', { v1: up.error || imagePath }) };
        }
      }
      block.images = next;
    }
    if (!changed) return { success: true, campaign };
    return { success: true, campaign: { ...campaign, template_message: typeof raw === 'string' ? JSON.stringify(parsed) : parsed } };
  }

  static async deleteCRMCampaign(params: { zaloId: string; campaignId: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/crm/campaigns/${params.campaignId}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.crm.deleteCampaign(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LABELS
  // ═════════════════════════════════════════════════════════════════

  static async getLocalLabels(params: { zaloId?: string } = {}) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/labels', params);
      if (!res.success) return { ...restFail(res), labels: [] as any[] };
      return { success: true, labels: restItems(res) };
    }
    return window.electronAPI.db.getLocalLabels(params);
  }

  static async upsertLocalLabel(params: { label: any }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/labels', params));
    }
    return window.electronAPI.db.upsertLocalLabel(params);
  }

  static async deleteLocalLabel(params: { id: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/labels/${params.id}`));
    }
    return window.electronAPI.db.deleteLocalLabel(params);
  }

  static async getLocalLabelThreads(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/label-threads', params);
      if (!res.success) return { ...restFail(res), threads: [] as any[] };
      return { success: true, threads: restItems(res) };
    }
    return window.electronAPI.db.getLocalLabelThreads(params);
  }

  static async assignLocalLabelToThread(params: { zaloId: string; labelId: number; threadId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/label-threads', params));
    }
    return window.electronAPI.db.assignLocalLabelToThread(params as any);
  }

  /** Assigns many labels to many threads in one go: uses a transaction, much faster than thousands of single calls */
  static async bulkAssignLocalLabelToThread(params: { zaloId: string; labelIds: number[]; threadIds: string[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/label-threads/bulk', params));
    }
    return (window.electronAPI.db as any).bulkAssignLocalLabelToThread(params);
  }

  static async removeLocalLabelFromThread(params: { zaloId: string; labelId: number; threadId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/label-threads?zaloId=${encodeURIComponent(params.zaloId)}&labelId=${encodeURIComponent(String(params.labelId))}&threadId=${encodeURIComponent(params.threadId)}`));
    }
    return (window.electronAPI.db as any).removeLocalLabelFromThread(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // QUICK MESSAGES
  // ═════════════════════════════════════════════════════════════════

  static async getLocalQuickMessages(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/quick-messages', params);
      if (!res.success) return { ...restFail(res), items: [] as any[] };
      return { success: true, items: restItems(res) };
    }
    return window.electronAPI.db.getLocalQuickMessages(params);
  }

  static async upsertLocalQuickMessage(params: { zaloId: string; item: any }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/quick-messages', params));
    }
    return window.electronAPI.db.upsertLocalQuickMessage(params);
  }

  static async deleteLocalQuickMessage(params: { zaloId: string; id: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/quick-messages/${params.id}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.db.deleteLocalQuickMessage(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // DRAFTS
  // ═════════════════════════════════════════════════════════════════

  static async getDrafts(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/drafts', params);
      if (!res.success) return { ...restFail(res), drafts: [] as any[] };
      return { success: true, drafts: restItems(res) };
    }
    return window.electronAPI.db.getDrafts(params);
  }

  static async upsertDraft(params: { zaloId: string; threadId: string; content: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().put(`/api/command/drafts/${encodeURIComponent(params.threadId)}`, params));
    }
    return window.electronAPI.db.upsertDraft(params);
  }

  static async deleteDraft(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/drafts/${encodeURIComponent(params.threadId)}?zaloId=${encodeURIComponent(params.zaloId)}`));
    }
    return window.electronAPI.db.deleteDraft(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // SETTINGS
  // ═════════════════════════════════════════════════════════════════

  static async getSetting(key: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/settings/${key}`);
      return res.data?.value || null;
    }
    // Boss / standalone: uses IPC
    try {
      return await (window.electronAPI as any).db?.getSetting?.(key);
    } catch {
      try {
        return await (window.electronAPI as any).db?.queryOne?.(
          `SELECT value FROM app_settings WHERE key=?`, [key]
        );
      } catch { return null; }
    }
  }

  static async setSetting(key: string, value: string) {
    if (isEmployee()) {
      return rest().put(`/api/command/settings/${key}`, { value });
    }
    try {
      await (window.electronAPI as any).db?.setSetting?.(key, value);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // PINNED CONVERSATIONS
  // ═════════════════════════════════════════════════════════════════

  static async getLocalPinnedConversations(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/pinned-conversations', params);
      // Error → the caller keeps the current pin set (before, it was replaced with an empty set)
      if (!res.success) return { ...restFail(res), threadIds: [] as string[] };
      return { success: true, threadIds: restItems(res) };
    }
    return window.electronAPI.db.getLocalPinnedConversations(params);
  }

  static async setLocalPinnedConversation(params: { zaloId: string; threadId: string; isPinned: boolean }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/pinned-conversations', params));
    }
    return window.electronAPI.db.setLocalPinnedConversation(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // AUTO MARK AS READ
  // ═════════════════════════════════════════════════════════════════

  static async getUnreadConversations(params: { zaloId: string; from?: number; to?: number; includeOthers?: boolean; channel?: string }): Promise<{ success: boolean; conversations: any[]; error?: string; code?: string }> {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations/unread', params);
      if (!res.success) return { ...restFail(res), conversations: [] };
      return { success: true, conversations: restItems(res) };
    }
    return window.electronAPI.db.getUnreadConversations(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // STARRED MESSAGES ("Tin đánh dấu")
  // ═════════════════════════════════════════════════════════════════

  static async getStarredMessageKeys(params: { zaloId: string }): Promise<{ success: boolean; keys: Array<{ thread_id: string; msg_id: string }>; error?: string; code?: string }> {
    if (isEmployee()) {
      const res = await rest().get('/api/query/starred-messages', { zaloId: params.zaloId, mode: 'keys' });
      if (!res.success) return { ...restFail(res), keys: [] };
      return { success: true, keys: restItems(res) };
    }
    return window.electronAPI.db.getStarredMessageKeys(params);
  }

  static async getStarredMessages(params: { zaloIds: string[]; limit?: number; offset?: number }): Promise<{ success: boolean; items: any[]; hasMore: boolean; error?: string; code?: string }> {
    if (isEmployee()) {
      const res = await rest().get('/api/query/starred-messages', { zaloIds: params.zaloIds, limit: params.limit, offset: params.offset });
      if (!res.success) return { ...restFail(res), items: [], hasMore: false };
      return { success: true, items: restItems(res), hasMore: !!res.data?.hasMore };
    }
    return window.electronAPI.db.getStarredMessages(params);
  }

  static async setMessageStarred(params: { zaloId: string; threadId: string; msgId: string; starred: boolean; snapshot?: any }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/starred-messages', params));
    }
    return window.electronAPI.db.setMessageStarred(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LINKS
  // ═════════════════════════════════════════════════════════════════

  static async getLinks(params: { zaloId: string; threadId: string; limit?: number; offset?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/links', params);
      if (!res.success) return { ...restFail(res), links: [] as any[] };
      return { success: true, links: restItems(res) };
    }
    return window.electronAPI.db.getLinks(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // PINNED MESSAGES · BANK CARDS · CONTACT SEARCH
  // (IPC reads in employee mode only return an empty stub → these screens are empty for employees; read through Boss)
  // ═════════════════════════════════════════════════════════════════

  /** Pinned messages + the group note of the conversation: `{ success, pins }`, as IPC db:getPinnedMessages. */
  static async getPinnedMessages(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/pinned-messages', params);
      if (!res.success) return { ...restFail(res), pins: [] as any[] };
      return { success: true, pins: restItems(res) };
    }
    return window.electronAPI.db.getPinnedMessages(params);
  }

  /** Bank cards of the account: `{ success, cards }`, as IPC db:getBankCards. */
  static async getBankCards(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/bank-cards', params);
      if (!res.success) return { ...restFail(res), cards: [] as any[] };
      return { success: true, cards: restItems(res) };
    }
    return window.electronAPI.db.getBankCards(params);
  }

  /** Contact picker (workflow): search ignoring diacritics + type filter + paging: `{ success, items, total, counts }`, as IPC. */
  static async searchContactsForPicker(params: {
    zaloId: string; search?: string; type?: 'user' | 'group' | 'all'; limit?: number; offset?: number; ids?: string[];
  }): Promise<{
    success: boolean; error?: string; code?: string;
    items: Array<{ id: string; name: string; originalName?: string; avatar?: string; phone?: string; type: 'user' | 'group'; isFriend: boolean; lastActivity: number }>;
    total: number;
    counts: { all: number; user: number; group: number };
  }> {
    if (isEmployee()) {
      const res = await rest().get('/api/search/contacts', params);
      const emptyCounts = { all: 0, user: 0, group: 0 };
      if (!res.success) return { ...restFail(res), items: [], total: 0, counts: emptyCounts };
      return { success: true, items: restItems(res), total: Number(res.data?.total) || 0, counts: res.data?.counts || emptyCounts };
    }
    return window.electronAPI.db.searchContactsForPicker(params);
  }

  /** Contact by phone number (contact card suggestion): `{ success, contact }`, null = none. */
  static async searchContactByPhone(params: { zaloId: string; phone: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/search/contact-by-phone', params);
      if (!res.success) return { ...restFail(res), contact: null as any };
      return { success: true, contact: (res.data || null) as any };
    }
    return window.electronAPI.db.searchContactByPhone(params);
  }

  // Per-account notification settings: saved on each machine (lib/notifications/notifSettingsOverrides), not through the DB / REST.

  // ═════════════════════════════════════════════════════════════════
  // DASHBOARD / ANALYTICS (11 methods + 2 multi-account variants)
  // ═════════════════════════════════════════════════════════════════

  static async getDashboardOverview(params: { zaloId: string; sinceTs?: number; untilTs?: number; threadType?: number }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/dashboard', params));
    }
    return window.electronAPI.analytics.dashboardOverview(params);
  }

  static async getMessageVolume(params: {
    zaloId: string; sinceTs: number; untilTs: number;
    granularity: 'hour' | 'day'; threadType?: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/message-volume', params), []);
    }
    return window.electronAPI.analytics.messageVolume(params);
  }

  static async getPeakHours(params: {
    zaloId: string; sinceTs: number; untilTs: number; threadType?: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/peak-hours', params), []);
    }
    return window.electronAPI.analytics.peakHours(params);
  }

  static async getContactSegmentation(zaloId: string) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/segmentation', { zaloId }));
    }
    return window.electronAPI.analytics.contactSegmentation({ zaloId });
  }

  /** Sent 1:1 messages in the range: recipient → received / seen / replied (shared/analytics/messageEngagement). */
  static async getOutreachStats(params: { zaloId: string; sinceTs: number; untilTs: number; granularity?: 'hour' | 'day' }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/outreach', params));
    }
    return window.electronAPI.analytics.outreach(params);
  }

  static async getCampaignComparison(zaloId: string) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/campaign-comparison', { zaloId }));
    }
    return window.electronAPI.analytics.campaignComparison({ zaloId });
  }

  static async getFriendRequestAnalytics(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/friend-requests', params));
    }
    return window.electronAPI.analytics.friendRequests(params);
  }

  static async getContactGrowth(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/contact-growth', params));
    }
    return window.electronAPI.analytics.contactGrowth(params);
  }

  static async getWorkflowAnalytics(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/workflows', params));
    }
    return window.electronAPI.analytics.workflowAnalytics(params);
  }

  /**
   * Workflow report of several accounts in ONE query. Not mergeable per account: runs are not
   * attributed to an account and a workflow attached to several of them (page_ids) would be counted
   * once per account. One account → the single-account call (also served by an older Boss).
   */
  static async getWorkflowAnalyticsForAccounts(params: {
    zaloIds: string[]; sinceTs: number; untilTs: number;
  }) {
    const { zaloIds, sinceTs, untilTs } = params;
    if (zaloIds.length === 1) return DataAccessor.getWorkflowAnalytics({ zaloId: zaloIds[0], sinceTs, untilTs });
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/workflows-multi', { zaloIds, sinceTs, untilTs }));
    }
    return window.electronAPI.analytics.workflowAnalytics({ zaloIds, sinceTs, untilTs });
  }

  static async getAIAnalytics(params: { sinceTs: number; untilTs: number }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/ai', params));
    }
    return window.electronAPI.analytics.aiAnalytics(params);
  }

  static async getResponseTime(params: {
    zaloId: string; sinceTs: number; untilTs: number; threadType?: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/response-time', params));
    }
    return window.electronAPI.analytics.responseTime(params);
  }

  /**
   * Response-time report of several accounts in ONE query: the median (and min / max, the
   * by-hour averages) of all their replies cannot be derived from per-account results.
   * One account → the single-account call (also served by an older Boss).
   */
  static async getResponseTimeForAccounts(params: {
    zaloIds: string[]; sinceTs: number; untilTs: number; threadType?: number;
  }) {
    const { zaloIds, sinceTs, untilTs, threadType } = params;
    if (zaloIds.length === 1) return DataAccessor.getResponseTime({ zaloId: zaloIds[0], sinceTs, untilTs, threadType });
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/response-time-multi', { zaloIds, sinceTs, untilTs, threadType }));
    }
    return window.electronAPI.analytics.responseTime({ zaloIds, sinceTs, untilTs, threadType });
  }

  static async getLabelUsage(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      return restReport(await rest().get('/api/query/analytics/label-usage', params));
    }
    return window.electronAPI.analytics.labelUsage(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONTACT FLAGS / NOTIFICATION SETTINGS (store.appStore)
  // ═════════════════════════════════════════════════════════════════

  static async getContactsWithFlags(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations/flags', { zaloId });
      // Error → loadFlags keeps the old flags (before, the flags were emptied: the "Khác" (Other) folder was empty and muted conversations were unmuted)
      if (!res.success) return { ...restFail(res), rows: [] as any[] };
      return { success: true, rows: restItems(res) };
    }
    return window.electronAPI.db.getContactsWithFlags({ zaloId });
  }

  static async getStickers(params: { stickerIds?: number[] }) {
    if (isEmployee()) {
      if (params.stickerIds?.length) {
        const res = await rest().post('/api/query/stickers/by-ids', params);
        if (!res.success) return { ...restFail(res), stickers: [] as any[] };
        return { success: true, stickers: restItems(res) };
      }
      return { success: true, stickers: [] };
    }
    return (window.electronAPI.db as any).getStickersByIds?.(params);
  }

  static async getStickerPacks() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs');
      if (!res.success) return { ...restFail(res), packs: [] as any[] };
      return { success: true, packs: restItems(res) };
    }
    return window.electronAPI.db.getStickerPacks();
  }

  static async getRecentStickers(limit = 30) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/recent', { limit });
      if (!res.success) return { ...restFail(res), stickers: [] as any[] };
      return { success: true, stickers: restItems(res) };
    }
    return window.electronAPI.db.getRecentStickers({ limit });
  }

  static async saveStickers(params: { stickers: any[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/stickers/save', params));
    }
    return window.electronAPI.db.saveStickers(params);
  }

  static async saveStickerPacks(params: { packs: any[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/sticker-packs/save', params));
    }
    return window.electronAPI.db.saveStickerPacks(params);
  }

  static async getStickerById(stickerId: number) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/by-id', { stickerId });
      if (!res.success) return { ...restFail(res), sticker: null };
      return { success: true, sticker: res.data };
    }
    return window.electronAPI.db.getStickerById({ stickerId });
  }

  static async getStickersByPackId(catId: number) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs', { catId });
      if (!res.success) return { ...restFail(res), stickers: [] as any[] };
      return { success: true, stickers: restItems(res) };
    }
    return window.electronAPI.db.getStickersByPackId({ catId });
  }

  static async addRecentSticker(stickerId: number) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/stickers/recent', { stickerId }));
    }
    return window.electronAPI.db.addRecentSticker({ stickerId });
  }

  static async saveKeywordStickers(params: { keyword: string; stickerIds: number[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/stickers/keyword', params));
    }
    return window.electronAPI.db.saveKeywordStickers(params);
  }

  static async getKeywordStickers(keyword: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/keyword', { keyword });
      // Error ≠ "đã tìm, không có kết quả" (searched, no results) ([]): `null` like the IPC branch on error → the caller searches again
      if (!res.success) return { ...restFail(res), stickerIds: null as number[] | null };
      // null = the keyword is not in Boss's cache yet (the caller asks the API), [] = searched, nothing found, as IPC
      const ids = res.data?.stickerIds;
      return { success: true, stickerIds: (Array.isArray(ids) ? ids : null) as number[] | null };
    }
    return window.electronAPI.db.getKeywordStickers({ keyword });
  }

  static async getAllCachedPackSummaries() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs/summaries');
      if (!res.success) return { ...restFail(res), packs: [] as any[] };
      return { success: true, packs: restItems(res) };
    }
    return window.electronAPI.db.getAllCachedPackSummaries();
  }

  // ═════════════════════════════════════════════════════════════════
  // MESSAGES — remaining operations
  // ═════════════════════════════════════════════════════════════════

  static async getUnreadCount(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/unread', { zaloId });
      // Same shape as IPC `{ success, total }` (before, it returned the bare `res.data`)
      if (!res.success) return { ...restFail(res), total: 0 };
      return { success: true, total: Number(res.data?.total) || 0 };
    }
    return window.electronAPI.db.getUnreadCount(zaloId);
  }

  /**
   * Marks as replied / unmarks (no message is sent): in bulk or for one conversation; returns the new state (is_replied,
   * reply_marked_at) of each conversation. Employee: a REST command to Boss (Boss emits db:replyStateChanged to the machines).
   */
  static async markConversationsReplied(params: { zaloId: string; contactIds: string[]; replied?: boolean }): Promise<{
    success: boolean; items: Array<{ contact_id: string; is_replied: number | null; reply_marked_at: number }>; error?: string;
  }> {
    if (isEmployee()) {
      const res: any = restWriteResult(await rest().post('/api/command/conversations/replied', params));
      return { success: !!res.success, items: Array.isArray(res.items) ? res.items : [], ...(res.error ? { error: res.error } : {}) };
    }
    const res: any = await window.electronAPI.db.markConversationsReplied(params);
    return {
      success: res?.success !== false,
      items: Array.isArray(res?.items) ? res.items : [],
      ...(res?.error ? { error: res.error } : {}),
    };
  }

  static async markAsRead(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/messages/mark-read', params));
    }
    return window.electronAPI.db.markAsRead(params);
  }

  /** threadId (optional): Boss emits event:undo with the conversation → the Boss UI / other employees update the right row. */
  static async markMessageRecalled(params: { zaloId: string; msgId: string; threadId?: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/messages/mark-recalled', params));
    }
    return window.electronAPI.db.markMessageRecalled(params);
  }

  /** threadId: a Telegram msg_id is only unique within 1 conversation; if it is missing, Boss does not delete the Telegram message. */
  static async deleteMessages(params: { zaloId: string; msgIds: string[]; threadId?: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/messages/delete', params));
    }
    return window.electronAPI.db.deleteMessages(params);
  }

  static async getMessagesByType(params: { zaloId: string; threadId: string; msgType: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/by-type', params);
      if (!res.success) return { ...restFail(res), messages: [] as any[] };
      return { success: true, messages: restItems(res) };
    }
    return window.electronAPI.db.getMessagesByType(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM — remaining operations
  // ═════════════════════════════════════════════════════════════════

  static async getCRMContacts(params: { zaloId: string; opts?: any }) {
    if (isEmployee()) {
      // Filter by Zalo label: the list of the label's conversations is sent along and may exceed the URL length limit → sent in the body (POST)
      const res = params.opts?.filters?.zaloLabelConversations?.length
        ? await rest().post('/api/query/crm/contacts', params)
        : await rest().get('/api/query/crm/contacts', params);
      if (!res.success) return { ...restFail(res), contacts: [] as any[], total: 0 };
      return { success: true, contacts: restItems(res), total: res.data?.total || res.pagination?.total || 0 };
    }
    return window.electronAPI.crm.getContacts(params);
  }

  static async getContactStats(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/contacts/stats', params);
      if (!res.success) return restFail(res);
      // Same shape as the IPC branch `{ success: true, ...stats }` (before, it returned `res.data` without `success` →
      // CRMDashboard never showed the figures in employee mode)
      return { success: true, ...res.data };
    }
    return window.electronAPI.crm.getContactStats(params);
  }

  /** targetZaloIds: accounts that get a copy (missing = the owner); employees: each one must be assigned to them (Boss checks). */
  static async cloneCampaign(params: CampaignCloneParams): Promise<CampaignCloneResponse> {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/crm/campaigns/clone', params));
    }
    return window.electronAPI.crm.cloneCampaign(params);
  }

  static async updateCampaignStatus(params: { campaignId: number; status: string }): Promise<{ success: boolean; error?: string }> {
    if (isEmployee()) {
      return restWriteResult(await rest().patch('/api/command/crm/campaigns/status', params));
    }
    return window.electronAPI.crm.updateCampaignStatus(params);
  }

  static async addCampaignContacts(params: { zaloId: string; campaignId: number; contacts: any[] }) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/crm/campaigns/contacts', params);
      return { success: res.success, error: res.error };
    }
    return window.electronAPI.crm.addCampaignContacts(params);
  }

  static async getCampaignContacts(params: { campaignId: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/contacts', params);
      if (!res.success) return { ...restFail(res), contacts: [] as any[] };
      return { success: true, contacts: restItems(res) };
    }
    return window.electronAPI.crm.getCampaignContacts(params);
  }

  /** Campaign effect: contacts sent to → received / seen / replied. Same shape as IPC `{ success, ...report }`. */
  static async getCampaignEngagement(params: { campaignId: number }): Promise<CampaignEngagementResponse> {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/engagement', params);
      if (!res.success || !res.data) return restFail(res);
      return { success: true, ...res.data };
    }
    return window.electronAPI.crm.getCampaignEngagement(params);
  }

  static async deleteCampaignContacts(params: { campaignId: number; contactIds: string[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/crm/campaigns/contacts/delete', params));
    }
    return window.electronAPI.crm.deleteCampaignContacts(params);
  }

  static async deleteAllCampaignContacts(params: { campaignId: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/crm/campaigns/contacts/delete-all', params));
    }
    return window.electronAPI.crm.deleteAllCampaignContacts(params);
  }

  static async getSendLog(params: { zaloId: string; opts?: any }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/send-log', params);
      if (!res.success) return { ...restFail(res), logs: [] as any[] };
      return { success: true, logs: restItems(res) };
    }
    return window.electronAPI.crm.getSendLog(params);
  }

  static async getQueueStatus(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/queue-status', params);
      if (!res.success) return { ...restFail(res), status: null };
      return { success: true, status: res.data };
    }
    return window.electronAPI.crm.getQueueStatus(params);
  }

  static async getCampaignStats(params: { zaloId: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/stats', params);
      if (!res.success) return { ...restFail(res), stats: [] as any[] };
      return { success: true, stats: restItems(res) };
    }
    return window.electronAPI.crm.getCampaignStats(params);
  }

  static async getActivityStats(params: { zaloId: string; sinceTs: number; untilTs?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/activity-stats', params);
      if (!res.success) return restFail(res);
      return { success: true, ...res.data }; // same shape as the IPC branch `{ success: true, ...stats }`
    }
    return window.electronAPI.crm.getActivityStats(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIENDS + GROUPS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async saveFriends(params: { zaloId: string; friends: any[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/friends/batch', params));
    }
    return window.electronAPI.db.saveFriends(params);
  }

  static async isFriend(params: { zaloId: string; userId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friends/check', params);
      if (!res.success) return { ...restFail(res), isFriend: false };
      return { success: true, isFriend: res.data?.isFriend || false };
    }
    return window.electronAPI.db.isFriend(params);
  }

  static async getAllGroupMembers(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/groups/all', { zaloId });
      if (!res.success) return { ...restFail(res), rows: [] as any[] };
      return { success: true, rows: restItems(res) };
    }
    return window.electronAPI.db.getAllGroupMembers({ zaloId });
  }

  static async upsertGroupMember(params: { zaloId: string; groupId: string; member: any }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/groups/members/upsert', params));
    }
    return window.electronAPI.db.upsertGroupMember(params);
  }

  static async removeGroupMember(params: { zaloId: string; groupId: string; memberId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/groups/members/${encodeURIComponent(params.memberId)}?zaloId=${encodeURIComponent(params.zaloId)}&groupId=${encodeURIComponent(params.groupId)}`));
    }
    return window.electronAPI.db.removeGroupMember(params);
  }

  static async saveLink(params: { zaloId: string; threadId: string; msgId: string; url: string; title: string; domain: string; thumbUrl: string; timestamp: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/links', params));
    }
    return window.electronAPI.db.saveLink(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // QUICK MESSAGES — remaining batch ops
  // ═════════════════════════════════════════════════════════════════

  static async bulkReplaceLocalQuickMessages(params: { zaloId: string; items: any[] }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/quick-messages/bulk-replace', params));
    }
    return window.electronAPI.db.bulkReplaceLocalQuickMessages(params);
  }

  static async cloneLocalQuickMessages(params: { sourceZaloId: string; targetZaloId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/quick-messages/clone', params));
    }
    return window.electronAPI.db.cloneLocalQuickMessages(params);
  }

  static async getAllLocalQuickMessages() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/quick-messages/all');
      if (!res.success) return { ...restFail(res), items: [] as any[] };
      return { success: true, items: restItems(res) };
    }
    return window.electronAPI.db.getAllLocalQuickMessages();
  }

  static async setLocalQMActive(params: { id: number; isActive: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/quick-messages/${params.id}/active`, params));
    }
    return window.electronAPI.db.setLocalQMActive(params);
  }

  static async setLocalQMOrder(params: { id: number; order: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/quick-messages/${params.id}/order`, params));
    }
    return window.electronAPI.db.setLocalQMOrder(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LABELS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async cloneLocalLabels(params: { sourceZaloId: string; targetZaloId: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/labels/clone', params));
    }
    return window.electronAPI.db.cloneLocalLabels(params);
  }

  static async getThreadLocalLabels(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/label-threads/thread', params);
      if (!res.success) return { ...restFail(res), labels: [] as any[] };
      return { success: true, labels: restItems(res) };
    }
    return window.electronAPI.db.getThreadLocalLabels(params);
  }

  static async setLocalLabelActive(params: { id: number; isActive: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/labels/${params.id}/active`, params));
    }
    return window.electronAPI.db.setLocalLabelActive(params);
  }

  static async setLocalLabelOrder(params: { id: number; order: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/labels/${params.id}/order`, params));
    }
    return window.electronAPI.db.setLocalLabelOrder(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // DRAFTS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async getDraft(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/drafts/single', params);
      if (!res.success) return { ...restFail(res), draft: null };
      return { success: true, draft: res.data || null };
    }
    return window.electronAPI.db.getDraft(params);
  }

  static async deleteOldDrafts(params?: { days?: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/drafts/cleanup', params || {}));
    }
    return window.electronAPI.db.deleteOldDrafts(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONTACT — remaining profile ops
  // ═════════════════════════════════════════════════════════════════

  static async updateContactProfile(params: {
    zaloId: string; contactId: string; displayName: string; avatarUrl: string;
    phone?: string; contactType?: string; gender?: number | null; birthday?: string | null;
    isBot?: number | null; manualDetails?: boolean;
  }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/conversations/update-profile', params));
    }
    return window.electronAPI.db.updateContactProfile(params);
  }

  static async updateAccountPhone(params: { zaloId: string; phone: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch('/api/command/accounts/phone', params));
    }
    return window.electronAPI.db.updateAccountPhone(params);
  }

  /** threadId: only edits the message of that exact conversation (msg_id can repeat across conversations) */
  static async updateReaction(params: { zaloId: string; msgId: string; userId: string; emoji: string; threadId?: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/messages/reaction', params));
    }
    return window.electronAPI.db.updateReaction(params);
  }

  static async updateLocalPaths(params: { zaloId: string; msgId: string; localPaths: Record<string, string> }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/messages/local-paths', params));
    }
    return window.electronAPI.db.updateLocalPaths(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LIBRARY (Media Library)
  // ═════════════════════════════════════════════════════════════════

  static async getLibraryItems(params: {
    zaloId: string; type?: string; search?: string;
    folderId?: number | null; page?: number; limit?: number; ownerZaloIds?: string[];
  }) {
    if (isEmployee()) {
      const ownersKey = (params.ownerZaloIds || []).slice().sort().join(',');
      const cacheKey = 'items:' + params.zaloId + ':' + ownersKey + ':' + (params.type || '') + ':' + (params.folderId ?? '') + ':' + (params.search || '') + ':' + (params.page || 1);
      const cached = getCachedLibrary(cacheKey);
      if (cached) return cached;
      const res = await rest().get('/api/library/items', params);
      // Errors are not cached (before, an error meant an "thư viện trống" (empty library) for 30 minutes): the next open asks BOSS again
      if (!res.success) return { ...restFail(res), items: [] as any[], total: 0 };
      const result = { success: true, items: restItems(res), total: res.pagination?.total || 0 };
      setCachedLibrary(cacheKey, result);
      return result;
    }
    try { return await window.electronAPI.library.getItems(params); }
    catch { return { success: false, items: [], total: 0 }; }
  }

  static async getLibraryFolders(params: { zaloId: string; type?: string; ownerZaloIds?: string[] }) {
    if (isEmployee()) {
      const cacheKey = 'folders:' + params.zaloId + ':' + (params.ownerZaloIds || []).slice().sort().join(',') + ':' + (params.type || '');
      const cached = getCachedLibrary(cacheKey);
      if (cached) return cached;
      const res = await rest().get('/api/library/folders', params);
      if (!res.success) return { ...restFail(res), items: [] as any[] };
      const result = { success: true, items: restItems(res) };
      setCachedLibrary(cacheKey, result);
      return result;
    }
    try { return await window.electronAPI.library.getFolders(params); }
    catch { return { success: false, items: [] }; }
  }

  static async uploadToLibrary(params: {
    zaloId: string; fileName: string; mimeType: string; base64: string; folderId?: number | null;
  }) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().post('/api/library/upload/json', params)); }
    try { return await window.electronAPI.library.upload(params); }
    catch { return { success: false }; }
  }

  static async deleteLibraryItem(uuid: string) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().delete('/api/library/item/' + uuid)); }
    try { return await window.electronAPI.library.deleteItem(uuid); }
    catch { return { success: false }; }
  }

  /**
   * Upload a local file to boss media storage. Returns boss path.
   * - Boss mode: file already local, return as-is
   * - Employee mode: read file as base64, upload to boss via REST
   */
  static async uploadMediaFile(filePath: string, zaloId?: string): Promise<{ success: boolean; bossPath?: string; error?: string; code?: string }> {
    if (!filePath) return { success: false, error: 'No file path' };

    // Boss mode: file is already on boss machine
    if (!isEmployee()) {
      return { success: true, bossPath: filePath };
    }

    // Employee mode: upload to boss
    try {
      // Read file as base64 via IPC
      const readResult = await (window as any).electronAPI?.file?.readImageAsBase64?.({ localPath: filePath });
      if (!readResult?.success || !readResult?.base64) {
        // its own code: the caller tells apart "not on this machine" (e.g. already a Boss path) from an upload error
        return { success: false, error: 'Cannot read file', code: 'LOCAL_FILE_UNREADABLE' };
      }

      // Convert base64 to Uint8Array
      const binaryStr = atob(readResult.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      // Extract filename from path
      const filename = filePath.replace(/^.*[/\\]/, '') || 'file.jpg';

      // Upload to boss
      const result = await rest().postBinary('/api/media/upload', bytes, {
        'X-Filename': encodeURIComponent(filename),
        ...(zaloId ? { 'X-Zalo-Id': zaloId } : {}),
      });

      if (result?.success && result.data?.bossPath) {
        return { success: true, bossPath: result.data.bossPath };
      }
      return { success: false, error: result?.error || 'Upload failed', code: result?.code };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // Folder / item writes: clear the library cache (30 minutes) like upload / delete item: before, renaming, adding / deleting folders,
  // or marking favourites, reopening still showed old data until "Làm mới" (Refresh) was pressed.
  static async createLibraryFolder(params: {
    zaloId: string; name: string; parentId?: number | null; color?: string; type?: string;
  }) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().post('/api/library/folders', params)); }
    try { return await window.electronAPI.library.createFolder(params); }
    catch { return { success: false }; }
  }

  static async renameLibraryFolder(id: number, name: string) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().patch('/api/library/folders/' + id, { name })); }
    try { return await window.electronAPI.library.renameFolder?.(id, name); }
    catch { return { success: false }; }
  }

  static async deleteLibraryFolder(id: number) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().delete('/api/library/folders/' + id)); }
    try { return await window.electronAPI.library.deleteFolder(id); }
    catch { return { success: false }; }
  }

  static async updateLibraryItem(uuid: string, params: {
    name?: string; tags?: string; folderId?: number | null;
    isFavorite?: number; altText?: string;
  }) {
    invalidateLibraryCache();
    if (isEmployee()) { return restWriteResult(await rest().patch('/api/library/item/' + uuid, params)); }
    try { return await window.electronAPI.library.updateItem?.(uuid, params); }
    catch { return { success: false }; }
  }

  // ═════════════════════════════════════════════════════════════════
  // WORKFLOWS
  // ═════════════════════════════════════════════════════════════════

  static async getWorkflows() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/workflows');
      if (!res.success) return { ...restFail(res), workflows: [] as any[] };
      return { success: true, workflows: restItems(res) };
    }
    return window.electronAPI.workflow.list();
  }

  /** One workflow to open in the editor: `{ success, workflow }`, as IPC workflow:get (employee: the IPC returns "Không khả dụng" (Not available)). */
  static async getWorkflow(id: string): Promise<{ success: boolean; workflow?: any; error?: string; code?: string }> {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/workflows/${id}`);
      if (!res.success) return { ...restFail(res), workflow: null };
      if (!res.data) return { success: false, error: tr('Không tìm thấy workflow'), workflow: null };
      return { success: true, workflow: res.data };
    }
    return window.electronAPI.workflow.get(id);
  }

  /** Run history of a workflow: `{ success, logs }`, as IPC workflow:getLogs (employee: the IPC reads the local DB → empty). */
  static async getWorkflowRunLogs(id: string, limit = 30) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/workflows/${id}/run-logs`, { limit });
      if (!res.success) return { ...restFail(res), logs: [] as any[] };
      return { success: true, logs: restItems(res) };
    }
    return window.electronAPI.workflow.getLogs(id, limit);
  }

  static async saveWorkflow(workflow: any) {
    if (isEmployee()) { return restWriteResult(await rest().post('/api/command/workflows', { workflow })); }
    return window.electronAPI.workflow.save(workflow);
  }

  static async deleteWorkflow(id: string) {
    if (isEmployee()) { return restWriteResult(await rest().delete('/api/command/workflows/' + id)); }
    return window.electronAPI.workflow.delete(id);
  }

  static async toggleWorkflow(id: string, enabled: boolean) {
    if (isEmployee()) { return restWriteResult(await rest().patch('/api/command/workflows/' + id + '/toggle', { enabled })); }
    return window.electronAPI.workflow.toggle(id, enabled);
  }

  // ═════════════════════════════════════════════════════════════════
  // INTEGRATIONS
  // ═════════════════════════════════════════════════════════════════

  static async getIntegrations() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/integrations');
      if (!res.success) return { ...restFail(res), integrations: [] as any[], webhookPort: 0 };
      return { success: true, integrations: restItems(res), webhookPort: res.data?.webhookPort || 0 };
    }
    return window.electronAPI.integration.list();
  }

  static async saveIntegration(integration: any) {
    if (isEmployee()) { return restWriteResult(await rest().post('/api/command/integrations', { integration })); }
    return window.electronAPI.integration.save(integration);
  }

  static async deleteIntegration(id: string) {
    if (isEmployee()) { return restWriteResult(await rest().delete('/api/command/integrations/' + id)); }
    return window.electronAPI.integration.delete(id);
  }

  static async toggleIntegration(id: string, enabled: boolean) {
    if (isEmployee()) { return restWriteResult(await rest().patch('/api/command/integrations/' + id + '/toggle', { enabled })); }
    return window.electronAPI.integration.toggle(id, enabled);
  }

  // ═════════════════════════════════════════════════════════════════
  // AI ASSISTANTS
  // ═════════════════════════════════════════════════════════════════

  static async getAssistants() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/assistants');
      if (!res.success) return { ...restFail(res), assistants: [] as any[] };
      return { success: true, assistants: restItems(res) };
    }
    return window.electronAPI.ai?.listAssistants();
  }

  static async getAssistant(id: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/ai/assistants/${id}`);
      if (!res.success) return { ...restFail(res), assistant: null };
      return { success: true, assistant: res.data || null };
    }
    return window.electronAPI.ai?.getAssistant(id);
  }

  static async getAssistantFiles(assistantId: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/ai/assistants/${assistantId}/files`);
      if (!res.success) return { ...restFail(res), files: [] as any[] };
      return { success: true, files: restItems(res) };
    }
    return window.electronAPI.ai?.getFiles(assistantId);
  }

  static async getUsageStats(params: { assistantId?: string; days?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/usage-stats', params);
      if (!res.success) return { ...restFail(res), stats: [] as any[] };
      return { success: true, stats: restItems(res) };
    }
    return window.electronAPI.ai?.getUsageStats(params);
  }

  static async getUsageLogs(params: { assistantId?: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/usage-logs', params);
      if (!res.success) return { ...restFail(res), logs: [] as any[] };
      return { success: true, logs: restItems(res) };
    }
    return window.electronAPI.ai?.getUsageLogs(params);
  }

  static async saveAssistant(assistant: any) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/ai/assistants', { assistant });
      if (!res?.success) return { success: false, error: res?.error || tr('Lưu thất bại') };
      return { success: true, id: (res as any).data?.id || (res as any).data?.data?.id };
    }
    return window.electronAPI.ai?.saveAssistant(assistant);
  }

  static async deleteAssistant(id: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/ai/assistants/${id}`));
    }
    return window.electronAPI.ai?.deleteAssistant(id);
  }

  static async getDefaultAssistant() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/default');
      if (!res.success) return { ...restFail(res), assistant: null };
      return { success: true, assistant: res.data || null };
    }
    return window.electronAPI.ai?.getDefault();
  }

  static async getAccountAssistant(zaloId: string, role: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/account-assistant', { zaloId, role });
      if (!res.success) return { ...restFail(res), assistant: null };
      return { success: true, assistant: res.data?.assistant || null };
    }
    return window.electronAPI.ai?.getAccountAssistant(zaloId, role);
  }

  static async getAccountAssistants(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/account-assistants', { zaloId });
      if (!res.success) return { ...restFail(res), assistants: undefined };
      return { success: true, ...res.data, assistants: res.data?.items };
    }
    return window.electronAPI.ai?.getAccountAssistants(zaloId);
  }

  // ═════════════════════════════════════════════════════════════════
  // ERP: projects, tasks, calendar, notes, HR (departments, positions, profiles, attendance, leave), notifications
  // ═════════════════════════════════════════════════════════════════
  //
  // Employee: REST → Boss runs the EXACT erp:* IPC handler with the employee's ERP identity (ErpRestRoutes): the ERP data
  // lives in Boss's DB (the erp:* IPC on the employee machine reads / writes the local DB: Boss and other employees cannot see it, there is no
  // realtime). The actor is taken by Boss from the token: the employee id is not sent, so nobody can act "on behalf of" someone. Results have the same shape as the IPC branch
  // (`{ success, projects }`, `{ success, task }`...): a read error → `success: false` + empty parts (the caller keeps the old data,
  // isReadFailure); a write error → `success: false` + error / code (`permission_denied` = Boss refused the ERP permission).

  // ── Projects / tasks ──

  static async erpProjects(params?: { archived?: boolean }) {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/projects', params), { projects: [] as any[] });
    }
    return window.electronAPI.erp?.projectList(params);
  }

  static async erpCreateProject(params: { name: string; description?: string; color?: string; department_id?: string }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/projects', params));
    }
    return window.electronAPI.erp?.projectCreate(params);
  }

  static async erpTasks(filter?: Record<string, any>) {
    if (isEmployee()) {
      // A query cannot send null: parentTaskId null (root tasks only) → "null" (Boss converts it back to null)
      const query = filter && filter.parentTaskId === null ? { ...filter, parentTaskId: 'null' } : filter;
      return erpRead(await rest().get('/api/query/erp/tasks', query), { tasks: [] as any[] });
    }
    return window.electronAPI.erp?.taskList(filter);
  }

  static async erpTaskDetail(id: string) {
    if (isEmployee()) {
      return erpRead(await rest().get(`/api/query/erp/tasks/${encodeURIComponent(id)}`), { task: null as any });
    }
    return window.electronAPI.erp?.taskGet({ id });
  }

  static async erpMyInbox(filter?: string) {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/tasks/inbox', { filter }), { tasks: [] as any[] });
    }
    return window.electronAPI.erp?.taskListMyInbox({ filter });
  }

  static async erpCreateTask(input: any) {
    if (isEmployee()) {
      const prepared = await DataAccessor.uploadErpTaskAttachments(input);
      if (prepared.success === false) return { success: false, error: prepared.error };
      return restWriteResult(await rest().post('/api/command/erp/tasks', { input: prepared.value }));
    }
    return window.electronAPI.erp?.taskCreate({ input });
  }

  static async erpUpdateTask(id: string, patch: any) {
    if (isEmployee()) {
      const prepared = await DataAccessor.uploadErpTaskAttachments(patch);
      if (prepared.success === false) return { success: false, error: prepared.error };
      return restWriteResult(await rest().patch(`/api/command/erp/tasks/${encodeURIComponent(id)}`, { patch: prepared.value }));
    }
    return window.electronAPI.erp?.taskUpdate({ id, patch });
  }

  /**
   * Employee: the task attachments just picked on this machine (absolute paths) → uploaded to Boss's media first, then the
   * Boss path is sent. Boss only accepts files that are already on the task or inside Boss's media. Saved files (relative paths
   * on Boss) are kept as they are; a file that cannot be read on this machine (already a Boss file) is kept as it is so Boss can check it.
   */
  private static async uploadErpTaskAttachments(holder: any): Promise<{ success: true; value: any } | { success: false; error: string }> {
    const attachments = holder && typeof holder === 'object' && Array.isArray(holder.attachments) ? holder.attachments : null;
    if (!attachments || attachments.length === 0) return { success: true, value: holder };
    const next: any[] = [];
    let changed = false;
    for (const item of attachments) {
      const localPath = typeof item?.file_path === 'string' ? item.file_path : '';
      if (!localPath || !isAbsoluteLocalPath(localPath)) { next.push(item); continue; }
      const up = await DataAccessor.uploadMediaFile(localPath);
      if (up.success && up.bossPath) {
        next.push({ ...item, file_path: up.bossPath });
        changed = true;
      } else if (up.code === 'LOCAL_FILE_UNREADABLE') {
        next.push(item);
      } else {
        return { success: false, error: tr('Không tải được tệp đính kèm lên Boss: {{v1}}', { v1: up.error || item?.file_name || localPath }) };
      }
    }
    return { success: true, value: changed ? { ...holder, attachments: next } : holder };
  }

  static async erpUpdateTaskStatus(id: string, status: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/tasks/${encodeURIComponent(id)}/status`, { status }));
    }
    return window.electronAPI.erp?.taskUpdateStatus({ id, status });
  }

  static async erpDeleteTask(id: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/tasks/${encodeURIComponent(id)}`));
    }
    return window.electronAPI.erp?.taskDelete({ id });
  }

  static async erpAssignTask(id: string, employeeIds: string[]) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/tasks/assign', { id, employeeIds }));
    }
    return window.electronAPI.erp?.taskAssign({ id, employeeIds });
  }

  static async erpAddWatcher(taskId: string, employeeId?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/tasks/watcher', { taskId, employeeId, action: 'add' }));
    }
    return window.electronAPI.erp?.taskAddWatcher?.({ taskId, employeeId });
  }

  static async erpRemoveWatcher(taskId: string, employeeId?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/tasks/watcher', { taskId, employeeId, action: 'remove' }));
    }
    return window.electronAPI.erp?.taskRemoveWatcher?.({ taskId, employeeId });
  }

  static async erpAddComment(taskId: string, content: string, mentions?: string[]) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/tasks/comment', { taskId, content, mentions }));
    }
    return window.electronAPI.erp?.taskAddComment?.({ taskId, content, mentions });
  }

  static async erpTaskChecklistToggle(id: number, done: boolean) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/tasks/checklist/${id}/toggle`, { done }));
    }
    return window.electronAPI.erp?.taskToggleChecklist?.({ id, done });
  }

  // ── Calendar (Boss only returns the events the employee organises / is invited to) ──

  static async erpCalendarEvents(params: { from: number; to: number; organizerId?: string }) {
    if (isEmployee()) {
      // The viewer is the logged-in employee (Boss takes it from the token); organizerId is not sent (before, Boss trusted this parameter)
      return erpRead(await rest().get('/api/query/erp/calendar/events', { from: params.from, to: params.to }), { events: [] as any[] });
    }
    return window.electronAPI.erp?.calendarListEvents(params);
  }

  static async erpCalendarCreate(input: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/calendar', { input }));
    }
    return window.electronAPI.erp?.calendarCreate({ input });
  }

  static async erpCalendarUpdate(id: string, patch: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/calendar/${encodeURIComponent(id)}`, { patch }));
    }
    return window.electronAPI.erp?.calendarUpdate({ id, patch });
  }

  static async erpCalendarDelete(id: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/calendar/${encodeURIComponent(id)}`));
    }
    return window.electronAPI.erp?.calendarDelete({ id });
  }

  // ── Notes (Boss filters by author / sharing / workspace scope) ──

  static async erpNoteFolders() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/note-folders'), { folders: [] as any[] });
    }
    return window.electronAPI.erp?.noteListFolders({});
  }

  static async erpCreateNoteFolder(params: { name: string; parent_id?: number }) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/note-folders', params));
    }
    return window.electronAPI.erp?.noteCreateFolder(params);
  }

  static async erpRenameNoteFolder(id: number, name: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/note-folders/${id}`, { name }));
    }
    return window.electronAPI.erp?.noteRenameFolder({ id, name });
  }

  static async erpDeleteNoteFolder(id: number) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/note-folders/${id}`));
    }
    return window.electronAPI.erp?.noteDeleteFolder({ id });
  }

  static async erpNotes(filter?: { folderId?: number; tagId?: number; search?: string; authorId?: string; limit?: number; offset?: number }) {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/notes', filter), { notes: [] as any[] });
    }
    return window.electronAPI.erp?.noteList(filter ?? {});
  }

  static async erpNoteTags() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/note-tags'), { tags: [] as any[] });
    }
    return window.electronAPI.erp?.noteListTags();
  }

  static async erpCreateNote(input: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notes', { input }));
    }
    return window.electronAPI.erp?.noteCreate({ input });
  }

  static async erpUpdateNote(id: string, patch: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/notes/${encodeURIComponent(id)}`, { patch }));
    }
    return window.electronAPI.erp?.noteUpdate({ id, patch });
  }

  static async erpDeleteNote(id: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/notes/${encodeURIComponent(id)}`));
    }
    return window.electronAPI.erp?.noteDelete({ id });
  }

  static async erpNoteVersions(noteId: string) {
    if (isEmployee()) {
      return erpRead(await rest().get(`/api/query/erp/notes/${encodeURIComponent(noteId)}/versions`), { versions: [] as any[] });
    }
    return window.electronAPI.erp?.noteVersions({ noteId });
  }

  static async erpRestoreNoteVersion(versionId: number, noteId?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post(`/api/command/erp/note-versions/${versionId}/restore`, {}));
    }
    return window.electronAPI.erp?.noteRestoreVersion({ noteId, versionId });
  }

  static async erpNoteShares(noteId: string) {
    if (isEmployee()) {
      return erpRead(await rest().get(`/api/query/erp/notes/${encodeURIComponent(noteId)}/shares`), { shares: [] as any[] });
    }
    return window.electronAPI.erp?.noteListShares({ noteId });
  }

  static async erpShareNote(noteId: string, scope: string, shares: Array<{ employeeId: string; permission: string }>) {
    if (isEmployee()) {
      return restWriteResult(await rest().post(`/api/command/erp/notes/${encodeURIComponent(noteId)}/share`, { scope, shares }));
    }
    return window.electronAPI.erp?.noteShare({ noteId, scope, shares });
  }

  // ── HR: departments / positions / profiles ──

  static async erpDepartments() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/departments'), { departments: [] as any[] });
    }
    return window.electronAPI.erp?.departmentList?.();
  }

  static async erpCreateDepartment(input: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/departments', input));
    }
    return window.electronAPI.erp?.departmentCreate?.(input);
  }

  static async erpUpdateDepartment(id: number, patch: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/departments/${id}`, { patch }));
    }
    return window.electronAPI.erp?.departmentUpdate?.({ id, patch });
  }

  static async erpDeleteDepartment(id: number) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/departments/${id}`));
    }
    return window.electronAPI.erp?.departmentDelete?.({ id });
  }

  static async erpPositions() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/positions'), { positions: [] as any[] });
    }
    return window.electronAPI.erp?.positionList?.();
  }

  static async erpCreatePosition(input: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/positions', input));
    }
    return window.electronAPI.erp?.positionCreate?.(input);
  }

  static async erpUpdatePosition(id: number, patch: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/positions/${id}`, { patch }));
    }
    return window.electronAPI.erp?.positionUpdate?.({ id, patch });
  }

  static async erpDeletePosition(id: number) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/positions/${id}`));
    }
    return window.electronAPI.erp?.positionDelete?.({ id });
  }

  static async erpProfiles(departmentId?: number | null) {
    if (isEmployee()) {
      // undefined = all profiles; null = no department yet (a query cannot send null → "null")
      const query = departmentId === undefined ? undefined : { departmentId: departmentId === null ? 'null' : departmentId };
      return erpRead(await rest().get('/api/query/erp/profiles', query), { profiles: [] as any[] });
    }
    return window.electronAPI.erp?.employeeListByDepartment?.({ departmentId });
  }

  static async erpProfile(employeeId: string) {
    if (isEmployee()) {
      return erpRead(await rest().get(`/api/query/erp/profiles/${encodeURIComponent(employeeId)}`), { profile: null as any });
    }
    return window.electronAPI.erp?.employeeGetProfile?.({ employeeId });
  }

  static async erpUpdateProfile(employeeId: string, patch: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().patch(`/api/command/erp/profiles/${encodeURIComponent(employeeId)}`, { patch }));
    }
    return window.electronAPI.erp?.employeeUpdateProfile?.({ employeeId, patch });
  }

  static async erpDeleteProfile(employeeId: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().delete(`/api/command/erp/profiles/${encodeURIComponent(employeeId)}`));
    }
    return window.electronAPI.erp?.employeeDeleteProfile?.({ employeeId });
  }

  static async erpSeatStatus() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/license/seat'), { seat: null as any });
    }
    return window.electronAPI.erp?.licenseSeatStatus?.();
  }

  // ── Attendance (check-in / check-out always belong to the logged-in employee) ──

  static async erpAttendanceToday() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/attendance/today'), { attendance: null as any });
    }
    return window.electronAPI.erp?.attendanceToday?.();
  }

  static async erpAttendanceList(filter: { employeeId?: string; from?: string; to?: string; all?: boolean }) {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/attendance', filter), { list: [] as any[] });
    }
    return window.electronAPI.erp?.attendanceList?.(filter);
  }

  static async erpCheckIn(note?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/attendance/check-in', { note }));
    }
    return window.electronAPI.erp?.attendanceCheckIn?.({ note });
  }

  static async erpCheckOut(note?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/attendance/check-out', { note }));
    }
    return window.electronAPI.erp?.attendanceCheckOut?.({ note });
  }

  // ── Leave (approval: the direct manager of the person asking for leave) ──

  static async erpMyLeaves() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/leaves/my'), { leaves: [] as any[] });
    }
    return window.electronAPI.erp?.leaveListMy?.();
  }

  static async erpPendingLeaves() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/leaves/pending'), { leaves: [] as any[] });
    }
    return window.electronAPI.erp?.leaveListPending?.();
  }

  static async erpCreateLeave(input: any) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/leaves', { input }));
    }
    return window.electronAPI.erp?.leaveCreate?.({ input });
  }

  static async erpDecideLeave(id: number, status: 'approved' | 'rejected', note?: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post(`/api/command/erp/leaves/${id}/decide`, { status, note }));
    }
    return window.electronAPI.erp?.leaveDecide?.({ id, status, note });
  }

  static async erpCancelLeave(id: number) {
    if (isEmployee()) {
      return restWriteResult(await rest().post(`/api/command/erp/leaves/${id}/cancel`, {}));
    }
    return window.electronAPI.erp?.leaveCancel?.({ id });
  }

  // ── Notifications (Boss only returns / edits the notifications of the logged-in employee) ──

  static async erpNotifications(opts?: { unreadOnly?: boolean; limit?: number; offset?: number }) {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/notifications', opts), { notifications: [] as any[] });
    }
    return window.electronAPI.erp?.notifyListInbox(opts ?? {});
  }

  static async erpUnreadNotificationCount() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/notifications/unread-count'), { count: 0 });
    }
    return window.electronAPI.erp?.notifyUnreadCount({});
  }

  static async erpMarkNotificationsRead(ids: number[]) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notifications/read', { ids }));
    }
    return window.electronAPI.erp?.notifyMarkRead({ ids });
  }

  static async erpMarkAllNotificationsRead() {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notifications/read-all', {}));
    }
    return window.electronAPI.erp?.notifyMarkAllRead({});
  }

  static async erpDeleteNotifications(ids: number[]) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notifications/delete', { ids }));
    }
    return window.electronAPI.erp?.notifyDelete({ ids });
  }

  static async erpDeleteAllNotifications() {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notifications/delete-all', {}));
    }
    return window.electronAPI.erp?.notifyDeleteAll({});
  }

  // ── Notifications via Zalo (settings of Task management, owner / admin) ──

  static async erpZaloNotifyStatus() {
    if (isEmployee()) {
      return erpRead(await rest().get('/api/query/erp/notifications/zalo'), { zalo: null as ErpZaloNotifyStatus | null });
    }
    return window.electronAPI.erp?.notifyZaloStatus?.({});
  }

  /** Only the fields that are sent. Employee: the sending account `zaloId` (Boss checks the account assigned to them). */
  static async erpSetZaloNotifySettings(patch: Partial<ErpZaloNotifySettings>) {
    if (isEmployee()) {
      const { accountId, ...others } = patch;
      return restWriteResult(await rest().post('/api/command/erp/notifications/zalo', {
        ...others,
        ...(accountId !== undefined ? { zaloId: accountId } : {}),
      }));
    }
    return window.electronAPI.erp?.notifySetZaloSettings?.({ settings: patch });
  }

  /** Test send: waits for its turn in the account's send queue + looks up the phone number + sends (can take up to about 1 minute). */
  static async erpTestZaloNotify(employeeId: string) {
    if (isEmployee()) {
      return restWriteResult(await rest().post('/api/command/erp/notifications/zalo/test', { employeeId }, 100_000));
    }
    return window.electronAPI.erp?.notifyTestZalo?.({ employeeId });
  }

}

// ── ERP (employee) ───────────────────────────────────────────────────

/**
 * ERP read over REST: Boss returns the IPC envelope `{ success, ...fields }` (RestQueryService wraps it in `data`; an old Boss returns
 * `{ data: { ...fields } }`, both work the same) → the exact IPC branch shape. An error (network, 403, Boss error) → `success: false`
 * + error / code + the empty `empty` parts with the same shape (the caller keeps the data it has, not replaced with empty).
 */
function erpRead<T extends Record<string, unknown>>(res: RestRes, empty: T): T & { success: boolean; error?: string; code?: string } {
  if (!res || !res.success) return { ...empty, ...restFail(res) };
  const data = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {};
  return { ...empty, ...data, success: true };
}

/** Absolute path on this machine (Windows `C:\\…` / UNC, macOS / Linux `/…`): the file the user just picked. */
function isAbsoluteLocalPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}


export default DataAccessor;
