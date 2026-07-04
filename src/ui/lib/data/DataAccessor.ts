/**
 * DataAccessor - Lớp trung gian giữa UI components và data source.
 *
 * - standalone/boss mode: gọi window.electronAPI (IPC) như cũ
 * - employee mode: gọi RestQueryService (REST API qua fetch → Boss)
 *
 * UI components không cần sửa, chỉ cần gọi DataAccessor thay vì ipc.db.xxx trực tiếp.
 * Sống trong renderer process, dùng Zustand store để check mode.
 */

import { useEmployeeStore } from '../../store/employeeStore';
import RestQueryService from '../../../services/http/RestQueryService';

// ── Helper ──────────────────────────────────────────────────────────

function isEmployee(): boolean {
  try {
    return useEmployeeStore.getState().mode === 'employee';
  } catch {
    return false;
  }
}

// ── Cache cho library items (30 phút) ──────────────────────────────
const CACHE_TTL_LIBRARY = 30 * 60 * 1000;
const libraryCache = new Map<string, { data: any; ts: number }>();

function getCachedLibrary(key: string): any | null {
  const entry = libraryCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_LIBRARY) return entry.data;
  libraryCache.delete(key);
  return null;
}
function setCachedLibrary(key: string, data: any): void {
  libraryCache.set(key, { data, ts: Date.now() });
  if (libraryCache.size > 100) { // prune sau 100 entries
    const now = Date.now();
    for (const [k, v] of libraryCache) {
      if (now - v.ts > CACHE_TTL_LIBRARY) libraryCache.delete(k);
    }
  }
}
/** Xoá cache library để force reload (gọi sau upload/delete) */
function invalidateLibraryCache(): void {
  libraryCache.clear();
}
/** Xoá cache library để UI gọi refresh thủ công */
export function refreshLibraryCache(): void {
  libraryCache.clear();
}

function rest(): RestQueryService {
  return RestQueryService.getInstance();
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
  }) {
    if (isEmployee()) {
      const query: any = {
        zaloId: params.zaloId,
        threadId: params.threadId,
        limit: params.limit || 50,
      };
      if (params.before !== undefined) query.before = params.before;
      if (params.offset !== undefined) query.offset = params.offset;
      const res = await rest().get('/api/query/messages', query);
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      return { messages: [], items: [], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getMessages({
      zaloId: params.zaloId,
      threadId: params.threadId,
      limit: params.limit || 50,
      offset: params.offset || 0,
      before: params.before,
    });
  }

  static async getMessagesAround(params: {
    zaloId: string;
    threadId: string;
    msgId: string;
    limit?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/around', params);
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { items };
      }
      return { items: [] };
    }
    return window.electronAPI.db.getMessagesAround({
      zaloId: params.zaloId,
      threadId: params.threadId,
      timestamp: Number(params.msgId),
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
        return { messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      return { messages: [], items: [], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getFileMessages(params);
  }

  static async getMediaMessages(params: {
    zaloId: string;
    threadId?: string;
    limit?: number;
    offset?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/media', params);
      if (res.success && res.data) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        return { messages: items, items, pagination: res.pagination || { hasMore: false } };
      }
      return { messages: [], items: [], pagination: { hasMore: false } };
    }
    return window.electronAPI.db.getMediaMessages(params);
  }

  static async searchMessages(params: { zaloId: string; query: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/search/messages', params);
      return { success: true, messages: res.data?.items || [] };
    }
    return window.electronAPI.db.searchMessages({
      zaloId: params.zaloId,
      query: params.query,
    });
  }

  static async getMessageById(params: { zaloId: string; msgId: string }) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/messages/${params.msgId}`, params);
      return { success: true, message: res.data };
    }
    return window.electronAPI.db.getMessageById(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONVERSATIONS (Contacts)
  // ═════════════════════════════════════════════════════════════════

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
      return { success: true, items: [], total: 0, hasMore: false };
    }
    const ipcRes = await window.electronAPI.db.getContacts(zaloId);
    const contactList = ipcRes?.contacts ?? ipcRes ?? [];
    return { success: true, items: contactList, total: contactList.length || 0, hasMore: false };
    }

  static async searchConversations(zaloId: string, query: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations', { zaloId, search: query, limit: 50 });
      return { success: true, items: res.data?.items || [] };
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
      return res.data;
    }
    const allRes = await window.electronAPI.db.getContacts(zaloId); const all = allRes?.contacts ?? allRes ?? [];
    return (all || []).find((c: any) => c.contact_id === contactId) || null;
  }

  static async setContactFlags(params: {
    zaloId: string;
    contactId: string;
    flags: { is_muted?: number; mute_until?: number; is_in_others?: number };
  }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/conversations/${params.contactId}/flags`, params);
    }
    return window.electronAPI.db.setContactFlags(params);
  }

  static async setContactAlias(params: { zaloId: string; contactId: string; alias: string }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/conversations/${params.contactId}/alias`, params);
    }
    return window.electronAPI.db.setContactAlias(params);
  }

  static async deleteConversation(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/conversations/${params.contactId}?zaloId=${params.zaloId}`);
    }
    return window.electronAPI.db.deleteConversation(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIENDS
  // ═════════════════════════════════════════════════════════════════

  static async getFriends(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friends', params);
      return { success: true, friends: res.data?.items || [], lastFetched: Date.now() };
    }
    return window.electronAPI.db.getFriends(params);
  }

  static async addFriend(params: { zaloId: string; friend: any }) {
    if (isEmployee()) {
      return rest().post('/api/command/friends', params);
    }
    return window.electronAPI.db.addFriend(params);
  }

  static async removeFriend(params: { zaloId: string; userId: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/friends/${params.userId}?zaloId=${params.zaloId}`);
    }
    return window.electronAPI.db.removeFriend(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIEND REQUESTS
  // ═════════════════════════════════════════════════════════════════

  static async getFriendRequests(params: { zaloId: string; direction: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friend-requests', params);
      return { success: true, requests: res.data?.items || [], lastFetched: Date.now() };
    }
    return window.electronAPI.db.getFriendRequests(params as any);
  }

  static async upsertFriendRequest(params: { zaloId: string; request: any; direction: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/friend-requests', params);
    }
    return window.electronAPI.db.upsertFriendRequest(params as any);
  }

  static async removeFriendRequest(params: { zaloId: string; userId: string; direction: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/friend-requests/${params.userId}?zaloId=${params.zaloId}&direction=${params.direction}`);
    }
    return window.electronAPI.db.removeFriendRequest(params as any);
  }

  // ═════════════════════════════════════════════════════════════════
  // GROUPS
  // ═════════════════════════════════════════════════════════════════

  static async getGroupMembers(params: { zaloId: string; groupId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/groups/members', params);
      return { success: true, members: res.data?.items || [] };
    }
    return window.electronAPI.db.getGroupMembers(params);
  }

  static async saveGroupMembers(params: { zaloId: string; groupId: string; members: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/groups/members', params);
    }
    return window.electronAPI.db.saveGroupMembers(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM NOTES
  // ═════════════════════════════════════════════════════════════════

  static async getCRMNotes(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/notes', params);
      return { success: true, notes: res.data?.items || [] };
    }
    return window.electronAPI.crm.getNotes(params);
  }

  static async saveCRMNote(params: { zaloId: string; note: any }) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/crm/notes', params);
      return { success: true, id: res.data?.id };
    }
    return window.electronAPI.crm.saveNote(params);
  }

  static async deleteCRMNote(params: { zaloId: string; noteId: number }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/crm/notes/${params.noteId}?zaloId=${params.zaloId}`);
    }
    return window.electronAPI.crm.deleteNote(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM CAMPAIGNS
  // ═════════════════════════════════════════════════════════════════

  static async getCRMCampaigns(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns', params);
      return { success: true, campaigns: res.data?.items || [] };
    }
    return window.electronAPI.crm.getCampaigns(params);
  }

  static async saveCRMCampaign(params: { zaloId: string; campaign: any }) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/crm/campaigns', params);
      return { success: true, id: res.data?.id };
    }
    return window.electronAPI.crm.saveCampaign(params);
  }

  static async deleteCRMCampaign(params: { zaloId: string; campaignId: number }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/crm/campaigns/${params.campaignId}?zaloId=${params.zaloId}`);
    }
    return window.electronAPI.crm.deleteCampaign(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LABELS
  // ═════════════════════════════════════════════════════════════════

  static async getLocalLabels(params: { zaloId?: string } = {}) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/labels', params);
      return { success: true, labels: res.data?.items || [] };
    }
    return window.electronAPI.db.getLocalLabels(params);
  }

  static async upsertLocalLabel(params: { label: any }) {
    if (isEmployee()) {
      return rest().post('/api/command/labels', params);
    }
    return window.electronAPI.db.upsertLocalLabel(params);
  }

  static async deleteLocalLabel(params: { id: number }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/labels/${params.id}`);
    }
    return window.electronAPI.db.deleteLocalLabel(params);
  }

  static async getLocalLabelThreads(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/label-threads', params);
      return { success: true, threads: res.data?.items || [] };
    }
    return window.electronAPI.db.getLocalLabelThreads(params);
  }

  static async assignLocalLabelToThread(params: { zaloId: string; labelId: number; threadId: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/label-threads', params);
    }
    return window.electronAPI.db.assignLocalLabelToThread(params as any);
  }

  static async removeLocalLabelFromThread(params: { zaloId: string; labelId: number; threadId: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/label-threads?zaloId=${params.zaloId}&labelId=${params.labelId}&threadId=${params.threadId}`);
    }
    return (window.electronAPI.db as any).removeLocalLabelFromThread(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // QUICK MESSAGES
  // ═════════════════════════════════════════════════════════════════

  static async getLocalQuickMessages(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/quick-messages', params);
      return { success: true, items: res.data?.items || [] };
    }
    return window.electronAPI.db.getLocalQuickMessages(params);
  }

  static async upsertLocalQuickMessage(params: { zaloId: string; item: any }) {
    if (isEmployee()) {
      return rest().post('/api/command/quick-messages', params);
    }
    return window.electronAPI.db.upsertLocalQuickMessage(params);
  }

  static async deleteLocalQuickMessage(params: { zaloId: string; id: number }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/quick-messages/${params.id}?zaloId=${params.zaloId}`);
    }
    return window.electronAPI.db.deleteLocalQuickMessage(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // DRAFTS
  // ═════════════════════════════════════════════════════════════════

  static async getDrafts(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/drafts', params);
      return { success: true, drafts: res.data?.items || [] };
    }
    return window.electronAPI.db.getDrafts(params);
  }

  static async upsertDraft(params: { zaloId: string; threadId: string; content: string }) {
    if (isEmployee()) {
      return rest().put(`/api/command/drafts/${params.threadId}`, params);
    }
    return window.electronAPI.db.upsertDraft(params);
  }

  static async deleteDraft(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/drafts/${params.threadId}?zaloId=${params.zaloId}`);
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
    // Boss/standalone: dùng IPC
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
      return { success: true, threadIds: res.data?.items || [] };
    }
    return window.electronAPI.db.getLocalPinnedConversations(params);
  }

  static async setLocalPinnedConversation(params: { zaloId: string; threadId: string; isPinned: boolean }) {
    if (isEmployee()) {
      return rest().post('/api/command/pinned-conversations', params);
    }
    return window.electronAPI.db.setLocalPinnedConversation(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LINKS
  // ═════════════════════════════════════════════════════════════════

  static async getLinks(params: { zaloId: string; threadId: string; limit?: number; offset?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/links', params);
      return { success: true, links: res.data?.items || [] };
    }
    return window.electronAPI.db.getLinks(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // NOTIFICATION SETTINGS
  // ═════════════════════════════════════════════════════════════════

  static async getNotifSettings(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/settings/notif', { zaloId });
      return { success: true, settings: res.data };
    }
    return (window.electronAPI.db as any).getNotifSettings(zaloId);
  }

  static async setNotifSettings(zaloId: string, settings: any) {
    if (isEmployee()) {
      return rest().post('/api/command/settings/notif', { zaloId, settings });
    }
    return (window.electronAPI.db as any).setNotifSettings(zaloId, settings);
  }

  // ═════════════════════════════════════════════════════════════════
  // DASHBOARD / ANALYTICS (11 methods)
  // ═════════════════════════════════════════════════════════════════

  static async getDashboardOverview(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/dashboard', { zaloId });
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.dashboardOverview({ zaloId });
  }

  static async getMessageVolume(params: {
    zaloId: string; sinceTs: number; untilTs: number;
    granularity: 'hour' | 'day'; threadType?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/message-volume', params);
      return { success: true, data: res.data || [] };
    }
    return window.electronAPI.analytics.messageVolume(params);
  }

  static async getPeakHours(params: {
    zaloId: string; sinceTs: number; untilTs: number; threadType?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/peak-hours', params);
      return { success: true, data: res.data || [] };
    }
    return window.electronAPI.analytics.peakHours(params);
  }

  static async getContactSegmentation(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/segmentation', { zaloId });
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.contactSegmentation({ zaloId });
  }

  static async getCampaignComparison(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/campaign-comparison', { zaloId });
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.campaignComparison({ zaloId });
  }

  static async getFriendRequestAnalytics(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/friend-requests', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.friendRequests(params);
  }

  static async getContactGrowth(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/contact-growth', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.contactGrowth(params);
  }

  static async getWorkflowAnalytics(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/workflows', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.workflowAnalytics(params);
  }

  static async getAIAnalytics(params: { sinceTs: number; untilTs: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/ai', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.aiAnalytics(params);
  }

  static async getResponseTime(params: {
    zaloId: string; sinceTs: number; untilTs: number; threadType?: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/response-time', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.responseTime(params);
  }

  static async getLabelUsage(params: {
    zaloId: string; sinceTs: number; untilTs: number;
  }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/analytics/label-usage', params);
      return { success: true, data: res.data };
    }
    return window.electronAPI.analytics.labelUsage(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONTACT FLAGS / NOTIFICATION SETTINGS (store.appStore)
  // ═════════════════════════════════════════════════════════════════

  static async getContactsWithFlags(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/conversations/flags', { zaloId });
      return { success: true, rows: res.data?.items || [] };
    }
    return window.electronAPI.db.getContactsWithFlags({ zaloId });
  }

  static async getStickers(params: { stickerIds?: number[] }) {
    if (isEmployee()) {
      if (params.stickerIds?.length) {
        const res = await rest().post('/api/query/stickers/by-ids', params);
        return { success: true, stickers: res.data?.items || [] };
      }
      return { success: true, stickers: [] };
    }
    return (window.electronAPI.db as any).getStickersByIds?.(params);
  }

  static async getStickerPacks() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs');
      return { success: true, packs: res.data?.items || [] };
    }
    return window.electronAPI.db.getStickerPacks();
  }

  static async getRecentStickers(limit = 30) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/recent', { limit });
      return { success: true, stickers: res.data?.items || [] };
    }
    return window.electronAPI.db.getRecentStickers({ limit });
  }

  static async saveStickers(params: { stickers: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/stickers/save', params);
    }
    return window.electronAPI.db.saveStickers(params);
  }

  static async saveStickerPacks(params: { packs: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/sticker-packs/save', params);
    }
    return window.electronAPI.db.saveStickerPacks(params);
  }

  static async getStickerById(stickerId: number) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/by-id', { stickerId });
      return { success: true, sticker: res.data };
    }
    return window.electronAPI.db.getStickerById({ stickerId });
  }

  static async getStickersByPackId(catId: number) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs', { catId });
      return { success: true, stickers: res.data?.items || [] };
    }
    return window.electronAPI.db.getStickersByPackId({ catId });
  }

  static async addRecentSticker(stickerId: number) {
    if (isEmployee()) {
      return rest().post('/api/command/stickers/recent', { stickerId });
    }
    return window.electronAPI.db.addRecentSticker({ stickerId });
  }

  static async saveKeywordStickers(params: { keyword: string; stickerIds: number[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/stickers/keyword', params);
    }
    return window.electronAPI.db.saveKeywordStickers(params);
  }

  static async getKeywordStickers(keyword: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/stickers/keyword', { keyword });
      return { success: true, stickerIds: res.data?.stickerIds || [] };
    }
    return window.electronAPI.db.getKeywordStickers({ keyword });
  }

  static async getAllCachedPackSummaries() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/sticker-packs/summaries');
      return { success: true, packs: res.data?.items || [] };
    }
    return window.electronAPI.db.getAllCachedPackSummaries();
  }

  // ═════════════════════════════════════════════════════════════════
  // MESSAGES — remaining operations
  // ═════════════════════════════════════════════════════════════════

  static async getUnreadCount(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/unread', { zaloId });
      return res.data;
    }
    return window.electronAPI.db.getUnreadCount(zaloId);
  }

  static async markAsRead(params: { zaloId: string; contactId: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/messages/mark-read', params);
    }
    return window.electronAPI.db.markAsRead(params);
  }

  static async markMessageRecalled(params: { zaloId: string; msgId: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/messages/mark-recalled', params);
    }
    return window.electronAPI.db.markMessageRecalled(params);
  }

  static async deleteMessages(params: { zaloId: string; msgIds: string[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/messages/delete', params);
    }
    return window.electronAPI.db.deleteMessages(params);
  }

  static async getMessagesByType(params: { zaloId: string; threadId: string; msgType: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/messages/by-type', params);
      return { success: true, messages: res.data?.items || [] };
    }
    return window.electronAPI.db.getMessagesByType(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CRM — remaining operations
  // ═════════════════════════════════════════════════════════════════

  static async getCRMContacts(params: { zaloId: string; opts?: any }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/contacts', params);
      return { success: true, contacts: res.data?.items || [], total: res.data?.total || res.pagination?.total || 0 };
    }
    return window.electronAPI.crm.getContacts(params);
  }

  static async getContactStats(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/contacts/stats', params);
      return res.data;
    }
    return window.electronAPI.crm.getContactStats(params);
  }

  static async cloneCampaign(params: { zaloId: string; campaignId: number; includeContacts: boolean; newName?: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/crm/campaigns/clone', params);
    }
    return window.electronAPI.crm.cloneCampaign(params);
  }

  static async updateCampaignStatus(params: { campaignId: number; status: string }) {
    if (isEmployee()) {
      return rest().patch('/api/command/crm/campaigns/status', params);
    }
    return window.electronAPI.crm.updateCampaignStatus(params);
  }

  static async addCampaignContacts(params: { zaloId: string; campaignId: number; contacts: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/crm/campaigns/contacts', params);
    }
    return window.electronAPI.crm.addCampaignContacts(params);
  }

  static async getCampaignContacts(params: { campaignId: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/contacts', params);
      return { success: true, contacts: res.data?.items || [] };
    }
    return window.electronAPI.crm.getCampaignContacts(params);
  }

  static async getSendLog(params: { zaloId: string; opts?: any }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/send-log', params);
      return { success: true, logs: res.data?.items || [] };
    }
    return window.electronAPI.crm.getSendLog(params);
  }

  static async getQueueStatus(params: { zaloId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/queue-status', params);
      return { success: true, status: res.data };
    }
    return window.electronAPI.crm.getQueueStatus(params);
  }

  static async getCampaignStats(params: { zaloId: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/campaigns/stats', params);
      return { success: true, stats: res.data?.items || [] };
    }
    return window.electronAPI.crm.getCampaignStats(params);
  }

  static async getActivityStats(params: { zaloId: string; sinceTs: number; untilTs?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/crm/activity-stats', params);
      return res.data;
    }
    return window.electronAPI.crm.getActivityStats(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // FRIENDS + GROUPS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async saveFriends(params: { zaloId: string; friends: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/friends/batch', params);
    }
    return window.electronAPI.db.saveFriends(params);
  }

  static async isFriend(params: { zaloId: string; userId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/friends/check', params);
      return { success: true, isFriend: res.data?.isFriend || false };
    }
    return window.electronAPI.db.isFriend(params);
  }

  static async getAllGroupMembers(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/groups/all', { zaloId });
      return { success: true, rows: res.data?.items || [] };
    }
    return window.electronAPI.db.getAllGroupMembers({ zaloId });
  }

  static async upsertGroupMember(params: { zaloId: string; groupId: string; member: any }) {
    if (isEmployee()) {
      return rest().post('/api/command/groups/members/upsert', params);
    }
    return window.electronAPI.db.upsertGroupMember(params);
  }

  static async removeGroupMember(params: { zaloId: string; groupId: string; memberId: string }) {
    if (isEmployee()) {
      return rest().delete(`/api/command/groups/members/${params.memberId}?zaloId=${params.zaloId}&groupId=${params.groupId}`);
    }
    return window.electronAPI.db.removeGroupMember(params);
  }

  static async saveLink(params: { zaloId: string; threadId: string; msgId: string; url: string; title: string; domain: string; thumbUrl: string; timestamp: number }) {
    if (isEmployee()) {
      return rest().post('/api/command/links', params);
    }
    return window.electronAPI.db.saveLink(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // QUICK MESSAGES — remaining batch ops
  // ═════════════════════════════════════════════════════════════════

  static async bulkReplaceLocalQuickMessages(params: { zaloId: string; items: any[] }) {
    if (isEmployee()) {
      return rest().post('/api/command/quick-messages/bulk-replace', params);
    }
    return window.electronAPI.db.bulkReplaceLocalQuickMessages(params);
  }

  static async cloneLocalQuickMessages(params: { sourceZaloId: string; targetZaloId: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/quick-messages/clone', params);
    }
    return window.electronAPI.db.cloneLocalQuickMessages(params);
  }

  static async getAllLocalQuickMessages() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/quick-messages/all');
      return { success: true, items: res.data?.items || [] };
    }
    return window.electronAPI.db.getAllLocalQuickMessages();
  }

  static async setLocalQMActive(params: { id: number; isActive: number }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/quick-messages/${params.id}/active`, params);
    }
    return window.electronAPI.db.setLocalQMActive(params);
  }

  static async setLocalQMOrder(params: { id: number; order: number }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/quick-messages/${params.id}/order`, params);
    }
    return window.electronAPI.db.setLocalQMOrder(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LABELS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async cloneLocalLabels(params: { sourceZaloId: string; targetZaloId: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/labels/clone', params);
    }
    return window.electronAPI.db.cloneLocalLabels(params);
  }

  static async getThreadLocalLabels(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/label-threads/thread', params);
      return { success: true, labels: res.data?.items || [] };
    }
    return window.electronAPI.db.getThreadLocalLabels(params);
  }

  static async setLocalLabelActive(params: { id: number; isActive: number }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/labels/${params.id}/active`, params);
    }
    return window.electronAPI.db.setLocalLabelActive(params);
  }

  static async setLocalLabelOrder(params: { id: number; order: number }) {
    if (isEmployee()) {
      return rest().patch(`/api/command/labels/${params.id}/order`, params);
    }
    return window.electronAPI.db.setLocalLabelOrder(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // DRAFTS — remaining
  // ═════════════════════════════════════════════════════════════════

  static async getDraft(params: { zaloId: string; threadId: string }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/drafts/single', params);
      return { success: true, draft: res.data || null };
    }
    return window.electronAPI.db.getDraft(params);
  }

  static async deleteOldDrafts(params?: { days?: number }) {
    if (isEmployee()) {
      return rest().post('/api/command/drafts/cleanup', params || {});
    }
    return window.electronAPI.db.deleteOldDrafts(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // CONTACT — remaining profile ops
  // ═════════════════════════════════════════════════════════════════

  static async updateContactProfile(params: {
    zaloId: string; contactId: string; displayName: string; avatarUrl: string;
    phone?: string; contactType?: string; gender?: number | null; birthday?: string | null;
  }) {
    if (isEmployee()) {
      return rest().post('/api/command/conversations/update-profile', params);
    }
    return window.electronAPI.db.updateContactProfile(params);
  }

  static async updateAccountPhone(params: { zaloId: string; phone: string }) {
    if (isEmployee()) {
      return rest().patch('/api/command/accounts/phone', params);
    }
    return window.electronAPI.db.updateAccountPhone(params);
  }

  static async updateReaction(params: { zaloId: string; msgId: string; userId: string; emoji: string }) {
    if (isEmployee()) {
      return rest().post('/api/command/messages/reaction', params);
    }
    return window.electronAPI.db.updateReaction(params);
  }

  static async updateLocalPaths(params: { zaloId: string; msgId: string; localPaths: Record<string, string> }) {
    if (isEmployee()) {
      return rest().post('/api/command/messages/local-paths', params);
    }
    return window.electronAPI.db.updateLocalPaths(params);
  }

  // ═════════════════════════════════════════════════════════════════
  // LIBRARY (Media Library)
  // ═════════════════════════════════════════════════════════════════

  static async getLibraryItems(params: {
    zaloId: string; type?: string; search?: string;
    folderId?: number | null; page?: number; limit?: number;
  }) {
    if (isEmployee()) {
      const cacheKey = 'items:' + params.zaloId + ':' + (params.type || '') + ':' + (params.folderId ?? '') + ':' + (params.search || '') + ':' + (params.page || 1);
      const cached = getCachedLibrary(cacheKey);
      if (cached) return cached;
      const res = await rest().get('/api/library/items', params);
      const result = { success: true, items: Array.isArray(res.data) ? res.data : (res.data?.items || []), total: res.pagination?.total || 0 };
      setCachedLibrary(cacheKey, result);
      return result;
    }
    try { return await window.electronAPI.library.getItems(params); }
    catch { return { success: false, items: [], total: 0 }; }
  }

  static async getLibraryFolders(params: { zaloId: string; type?: string }) {
    if (isEmployee()) {
      const cacheKey = 'folders:' + params.zaloId + ':' + (params.type || '');
      const cached = getCachedLibrary(cacheKey);
      if (cached) return cached;
      const res = await rest().get('/api/library/folders', params);
      const result = { success: true, items: res.data?.items || [] };
      setCachedLibrary(cacheKey, result);
      return result;
    }
    try { return await window.electronAPI.library.getFolders(params); }
    catch { return { success: false, items: [] }; }
  }

  static async uploadToLibrary(params: {
    zaloId: string; fileName: string; mimeType: string; base64: string;
  }) {
    invalidateLibraryCache();
    if (isEmployee()) { return rest().post('/api/library/upload/json', params); }
    try { return await window.electronAPI.library.upload(params); }
    catch { return { success: false }; }
  }

  static async deleteLibraryItem(uuid: string) {
    invalidateLibraryCache();
    if (isEmployee()) { return rest().delete('/api/library/item/' + uuid); }
    try { return await window.electronAPI.library.deleteItem(uuid); }
    catch { return { success: false }; }
  }

  static async createLibraryFolder(params: {
    zaloId: string; name: string; parentId?: number | null; color?: string; type?: string;
  }) {
    if (isEmployee()) { return rest().post('/api/library/folders', params); }
    try { return await window.electronAPI.library.createFolder(params); }
    catch { return { success: false }; }
  }

  static async renameLibraryFolder(id: number, name: string) {
    if (isEmployee()) { return rest().patch('/api/library/folders/' + id, { name }); }
    try { return await window.electronAPI.library.renameFolder?.(id, name); }
    catch { return { success: false }; }
  }

  static async deleteLibraryFolder(id: number) {
    if (isEmployee()) { return rest().delete('/api/library/folders/' + id); }
    try { return await window.electronAPI.library.deleteFolder(id); }
    catch { return { success: false }; }
  }

  static async updateLibraryItem(uuid: string, params: {
    name?: string; tags?: string; folderId?: number | null;
    isFavorite?: number; altText?: string;
  }) {
    if (isEmployee()) { return rest().patch('/api/library/item/' + uuid, params); }
    try { return await window.electronAPI.library.updateItem?.(uuid, params); }
    catch { return { success: false }; }
  }

  // ═════════════════════════════════════════════════════════════════
  // WORKFLOWS
  // ═════════════════════════════════════════════════════════════════

  static async getWorkflows() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/workflows');
      return { success: true, workflows: res.data?.items || [] };
    }
    return window.electronAPI.workflow.list();
  }

  static async saveWorkflow(workflow: any) {
    if (isEmployee()) { return rest().post('/api/command/workflows', { workflow }); }
    return window.electronAPI.workflow.save(workflow);
  }

  static async deleteWorkflow(id: string) {
    if (isEmployee()) { return rest().delete('/api/command/workflows/' + id); }
    return window.electronAPI.workflow.delete(id);
  }

  static async toggleWorkflow(id: string, enabled: boolean) {
    if (isEmployee()) { return rest().patch('/api/command/workflows/' + id + '/toggle', { enabled }); }
    return window.electronAPI.workflow.toggle(id, enabled);
  }

  // ═════════════════════════════════════════════════════════════════
  // INTEGRATIONS
  // ═════════════════════════════════════════════════════════════════

  static async getIntegrations() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/integrations');
      return { success: true, integrations: res.data?.items || [], webhookPort: res.data?.webhookPort || 0 };
    }
    return window.electronAPI.integration.list();
  }

  static async saveIntegration(integration: any) {
    if (isEmployee()) { return rest().post('/api/command/integrations', { integration }); }
    return window.electronAPI.integration.save(integration);
  }

  static async deleteIntegration(id: string) {
    if (isEmployee()) { return rest().delete('/api/command/integrations/' + id); }
    return window.electronAPI.integration.delete(id);
  }

  static async toggleIntegration(id: string, enabled: boolean) {
    if (isEmployee()) { return rest().patch('/api/command/integrations/' + id + '/toggle', { enabled }); }
    return window.electronAPI.integration.toggle(id, enabled);
  }

  // ═════════════════════════════════════════════════════════════════
  // AI ASSISTANTS
  // ═════════════════════════════════════════════════════════════════

  static async getAssistants() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/assistants');
      return { success: true, assistants: res.data?.items || [] };
    }
    return window.electronAPI.ai?.listAssistants();
  }

  static async getAssistant(id: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/ai/assistants/${id}`);
      return { success: true, assistant: res.data || null };
    }
    return window.electronAPI.ai?.getAssistant(id);
  }

  static async getAssistantFiles(assistantId: string) {
    if (isEmployee()) {
      const res = await rest().get(`/api/query/ai/assistants/${assistantId}/files`);
      return { success: true, files: res.data?.items || [] };
    }
    return window.electronAPI.ai?.getFiles(assistantId);
  }

  static async getUsageStats(params: { assistantId?: string; days?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/usage-stats', params);
      return { success: true, stats: res.data?.items || [] };
    }
    return window.electronAPI.ai?.getUsageStats(params);
  }

  static async getUsageLogs(params: { assistantId?: string; limit?: number }) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/usage-logs', params);
      return { success: true, logs: res.data?.items || [] };
    }
    return window.electronAPI.ai?.getUsageLogs(params);
  }

  static async saveAssistant(assistant: any) {
    if (isEmployee()) {
      const res = await rest().post('/api/command/ai/assistants', { assistant });
      if (!res?.success) return { success: false, error: res?.error || 'Lưu thất bại' };
      return { success: true, id: (res as any).data?.id || (res as any).data?.data?.id };
    }
    return window.electronAPI.ai?.saveAssistant(assistant);
  }

  static async deleteAssistant(id: string) {
    if (isEmployee()) {
      return rest().delete(`/api/command/ai/assistants/${id}`);
    }
    return window.electronAPI.ai?.deleteAssistant(id);
  }

  static async getDefaultAssistant() {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/default');
      return { success: true, assistant: res.data || null };
    }
    return window.electronAPI.ai?.getDefault();
  }

  static async getAccountAssistant(zaloId: string, role: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/account-assistant', { zaloId, role });
      return { success: true, assistant: res.data?.assistant || null };
    }
    return window.electronAPI.ai?.getAccountAssistant(zaloId, role);
  }

  static async getAccountAssistants(zaloId: string) {
    if (isEmployee()) {
      const res = await rest().get('/api/query/ai/account-assistants', { zaloId });
      return { success: true, ...res.data, assistants: res.data?.items };
    }
    return window.electronAPI.ai?.getAccountAssistants(zaloId);
  }

}


export default DataAccessor;
