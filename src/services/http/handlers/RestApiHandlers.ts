/**
 * RestApiHandlers - REST API handlers cho HttpRelayService.
 *
 * Các hàm này được HttpRelayService gọi khi employee request:
 *   /api/query/*    → READ (GET)
 *   /api/command/*  → WRITE (POST, PUT, PATCH, DELETE)
 *   /api/boot       → INITIAL DATA
 *   /api/media/*    → FILE SERVING (trong mediaHandler.ts)
 *   /api/search/*   → SEARCH
 *
 * Tất cả handler đều nhận (employee, params) và trả về JSON-serializable object.
 */

import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';
import EmployeeService from '../../employee/EmployeeService';

// ── Types ───────────────────────────────────────────────────────────

interface RegisteredEmployee {
  employee_id: string;
  display_name: string;
  avatar_url: string;
  username: string;
  token: string;
  assigned_accounts: string[];
}

interface JsonResponse {
  success: boolean;
  data?: any;
  error?: string;
  pagination?: { page: number; limit: number; total: number; hasMore: boolean };
}

// ── Helper ──────────────────────────────────────────────────────────

function db(): DatabaseService {
  return DatabaseService.getInstance();
}

function success(data: any, pagination?: JsonResponse['pagination']): JsonResponse {
  const res: JsonResponse = { success: true };
  if (data !== undefined) res.data = data;
  if (pagination) res.pagination = pagination;
  return res;
}

function error(msg: string, code?: string): JsonResponse {
  return { success: false, error: msg };
}

// ── Handlers ────────────────────────────────────────────────────────

export const handlers = {
  // ═══════════════════════════════════════════════════════════════
  // BOOT API — toàn bộ data cần thiết cho employee mới connect
  // ═══════════════════════════════════════════════════════════════

  getBoot(employee: RegisteredEmployee, _params: any): JsonResponse {
    const zaloIds = employee.assigned_accounts || [];
    if (zaloIds.length === 0) return success({
      conversations: [], totalConversations: 0, accounts: [],
      labels: [], quickMessages: [], pinnedConversations: [],
      settings: {}, drafts: [],
    });

    const mainZaloId = zaloIds[0];

    // Conversations — 50 đầu (SQL LIMIT, không load all)
    const conversations = (db().query<any>(
      `SELECT * FROM contacts WHERE owner_zalo_id = ? ORDER BY last_message_time DESC LIMIT 50`,
      [mainZaloId]
    ) || []).map((c: any) => ({
      contact_id: c.contact_id,
      owner_zalo_id: c.owner_zalo_id || '',
      display_name: c.display_name || '',
      avatar_url: c.avatar_url || '',
      last_message: c.last_message || '',
      last_message_time: c.last_message_time || 0,
      unread_count: c.unread_count || 0,
      is_group: c.is_group ? 1 : 0,
      is_muted: c.is_muted ? 1 : 0,
      contact_type: c.contact_type || 0,
      phone: c.phone || '',
      gender: c.gender ?? null,
      birthday: c.birthday ?? null,
      alias: c.alias || '',
      is_friend: c.is_friend ? 1 : 0,
    }));
    const totalConversations = (db().query<any>(
      `SELECT COUNT(*) as cnt FROM contacts WHERE owner_zalo_id = ?`,
      [mainZaloId]
    ))[0]?.cnt || 0;

    // Labels
    let labels: any[] = [];
    try { labels = db().getLocalLabels(mainZaloId) || []; } catch {}

    // Quick messages
    let quickMessages: any[] = [];
    try { quickMessages = db().getLocalQuickMessages(mainZaloId) || []; } catch {}

    // Pinned conversations
    let pinnedConversations: string[] = [];
    try { pinnedConversations = db().getLocalPinnedConversations(mainZaloId) || []; } catch {}

    // Drafts
    let drafts: any[] = [];
    try {
      drafts = (db().getDrafts(mainZaloId) || []).map((d: any) => ({
        thread_id: d.threadId,
        content: d.content,
        updated_at: d.updatedAt,
      }));
    } catch {}

    // Accounts info (safe columns only)
    const accountsData = zaloIds.map(zaloId => {
      try {
        const rows = db().query<any>('SELECT zalo_id, full_name, avatar_url, phone, is_active, listener_active FROM accounts WHERE zalo_id=?', [zaloId]);
        return rows[0] || { zalo_id: zaloId, full_name: '', avatar_url: '', phone: '', is_active: 1, listener_active: 0 };
      } catch { return { zalo_id: zaloId, full_name: '', avatar_url: '', phone: '', is_active: 1, listener_active: 0 }; }
    });

    return success({
      conversations,
      totalConversations,
      accounts: accountsData,
      labels,
      quickMessages,
      pinnedConversations,
      drafts,
      serverTime: Date.now(),
    });
  },

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  getConversations(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const offset = parseInt(params.offset) || 0;
    const search = params.search || '';

    // Build query với SQL LIMIT/OFFSET — không load all
    let whereClause = 'owner_zalo_id = ?';
    const queryParams: any[] = [zaloId];
    const countParams: any[] = [zaloId];

    if (search) {
      const q = `%${search}%`;
      whereClause += ` AND (display_name LIKE ? OR phone LIKE ? OR contact_id LIKE ?)`;
      queryParams.push(q, q, q);
      countParams.push(q, q, q);
    }

    const total = (db().query<any>(
      `SELECT COUNT(*) as cnt FROM contacts WHERE ${whereClause}`, countParams
    ))[0]?.cnt || 0;

    const page = db().query<any>(
      `SELECT * FROM contacts WHERE ${whereClause} ORDER BY last_message_time DESC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    ) || [];

    const items = page.map((c: any) => ({
      contact_id: c.contact_id,
      owner_zalo_id: c.owner_zalo_id || '',
      display_name: c.display_name || '',
      avatar_url: c.avatar_url || '',
      last_message: c.last_message || '',
      last_message_time: c.last_message_time || 0,
      last_message_type: c.last_message_type || 'text',
      unread_count: c.unread_count || 0,
      is_group: c.is_group ? 1 : 0,
      is_muted: c.is_muted ? 1 : 0,
      is_pinned: false, // client-side sẽ check
      is_friend: c.is_friend ? 1 : 0,
      contact_type: c.contact_type || 0,
      alias: c.alias || '',
      phone: c.phone || '',
      gender: c.gender ?? null,
      birthday: c.birthday ?? null,
    }));

    return success({ items, total }, {
      page: Math.floor(offset / limit) + 1,
      limit,
      total,
      hasMore: offset + limit < total,
    });
  },

  getConversationsUpdates(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const sinceTs = parseInt(params.sinceTs) || 0;
    const limit = Math.min(parseInt(params.limit) || 200, 500);

    const items = (db().query<any>(
      `SELECT * FROM contacts WHERE owner_zalo_id = ? AND last_message_time > ? ORDER BY last_message_time DESC LIMIT ?`,
      [zaloId, sinceTs, limit]
    ) || []).map((c: any) => ({
      contact_id: c.contact_id,
      owner_zalo_id: c.owner_zalo_id || '',
      display_name: c.display_name || '',
      avatar_url: c.avatar_url || '',
      last_message: c.last_message || '',
      last_message_time: c.last_message_time || 0,
      unread_count: c.unread_count || 0,
      is_group: c.is_group ? 1 : 0,
      is_muted: c.is_muted ? 1 : 0,
    }));

    return success({ items, total: items.length });
  },

  getConversationById(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.contactId) return error('Missing zaloId or contactId');

    const contact = (db().query<any>(
      `SELECT * FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? LIMIT 1`,
      [zaloId, params.contactId]
    ))[0] || null;
    return success(contact);
  },

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════════════════

  getMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing zaloId or threadId');

    const limit = Math.min(parseInt(params.limit) || 50, 100);
    const offset = parseInt(params.offset) || 0;
    const before = params.before ? parseInt(params.before) : undefined;

    // Nếu có before → cursor-based, nếu không → offset-based
    const messages = db().getMessages(zaloId, params.threadId, limit, before ? 0 : offset, before);
    const hasMore = messages.length >= limit;

    console.log(`[RestApi] getMessages: zaloId=${zaloId} threadId=${params.threadId} limit=${limit} → ${messages.length} msgs`);

    const items = messages.map((m: any) => ({
      msg_id: m.msg_id,
      cli_msg_id: m.cli_msg_id,
      thread_id: m.thread_id,
      owner_zalo_id: m.owner_zalo_id,
      msg_type: m.msg_type,
      content: m.content,
      timestamp: m.timestamp,
      is_sent: m.is_sent ? 1 : 0,
      is_recalled: m.is_recalled ? 1 : 0,
      is_self: m.is_self ? 1 : 0,
      sender_id: m.sender_id || '',
      sender_name: m.sender_name || '',
      reactions: m.reactions || null,
      attachments: m.attachments || null,
      local_paths: m.local_paths || null,
      handled_by_employee: m.handled_by_employee || null,
      quote_data: m.quote_data || null,
    }));

    return success({ items, total: items.length }, {
      page: 1,
      limit,
      total: items.length,
      hasMore,
    });
  },

  getMessagesAround(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId || !params.msgId) return error('Missing params');

    // Lấy timestamp từ msgId, load 20 messages xung quanh
    const timestamp = parseInt(params.msgId) || Date.now();
    const limit = Math.min(parseInt(params.limit) || 20, 50);

    const around = db().getMessagesAround(zaloId, params.threadId, timestamp, limit);
    return success({ items: around || [] });
  },

  getFileMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing zaloId or threadId');

    const limit = Math.min(parseInt(params.limit) || 50, 100);
    const offset = parseInt(params.offset) || 0;

    const messages = db().getFileMessages(zaloId, params.threadId, limit, offset);
    return success({ items: messages || [] }, {
      page: Math.floor(offset / limit) + 1,
      limit,
      total: messages?.length || 0,
      hasMore: (messages?.length || 0) >= limit,
    });
  },

  getMediaMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const offset = parseInt(params.offset) || 0;

    const messages = params.threadId
        ? db().getMediaMessages(zaloId, params.threadId, limit, offset)
        : db().getAllLocalMediaMessages(zaloId);

    return success({ items: messages || [] }, {
      page: Math.floor(offset / limit) + 1,
      limit,
      total: messages?.length || 0,
      hasMore: (messages?.length || 0) >= limit,
    });
  },

  getMessageById(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.msgId) return error('Missing zaloId or msgId');

    const msg = db().getMessageById(zaloId, params.msgId);
    return success(msg || null);
  },

  // ═══════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════

  searchMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.q) return error('Missing zaloId or query');

    const query = String(params.q).trim();
    if (!query) return success({ items: [], total: 0 });

    const limit = Math.min(parseInt(params.limit) || 50, 100);
    const messages = db().searchMessages(zaloId, query);

    const items = (messages || []).slice(0, limit).map((m: any) => ({
      msg_id: m.msg_id,
      thread_id: m.thread_id,
      thread_name: m.thread_name || m.thread_id || '',
      snippet: extractSnippet(m.content, query),
      timestamp: m.timestamp,
    }));

    return success({ items, total: items.length });
  },

  // ═══════════════════════════════════════════════════════════════
  // FRIENDS
  // ═══════════════════════════════════════════════════════════════

  getFriends(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const friends = db().getFriends(zaloId) || [];
    const lastFetched = db().getFriendsLastFetched(zaloId) || 0;
    return success({ items: friends, lastFetched });
  },

  getFriendCheck(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.userId) return error('Missing zaloId or userId');
    try {
      const row = db().queryOne<any>(
        `SELECT user_id FROM friends WHERE owner_zalo_id = ? AND user_id = ?`,
        [zaloId, params.userId]
      );
      return success({ isFriend: !!row });
    } catch {
      return success({ isFriend: false });
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // FRIEND REQUESTS
  // ═══════════════════════════════════════════════════════════════

  getFriendRequests(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const direction = params.direction === 'sent' ? 'sent' : 'received';
    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const offset = parseInt(params.offset) || 0;

    const all = db().getFriendRequests(zaloId, direction) || [];
    const total = all.length;
    const items = all.slice(offset, offset + limit);
    return success({ items, total });
  },

  // ═══════════════════════════════════════════════════════════════
  // GROUPS
  // ═══════════════════════════════════════════════════════════════

  getGroupMembers(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.groupId) return error('Missing zaloId or groupId');

    const members = db().getGroupMembers(zaloId, params.groupId) || [];
    return success({ items: members });
  },

  getAllGroupMembers(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const rows = db().getAllGroupMembers(zaloId) || [];
    return success({ items: rows });
  },

  // ═══════════════════════════════════════════════════════════════
  // CRM NOTES
  // ═══════════════════════════════════════════════════════════════

  getCRMNotes(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.contactId) return error('Missing zaloId or contactId');

    const notes = db().getCRMNotes(zaloId, params.contactId) || [];
    return success({ items: notes });
  },

  // ═══════════════════════════════════════════════════════════════
  // CRM CAMPAIGNS
  // ═══════════════════════════════════════════════════════════════

  getCRMCampaigns(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const campaigns = db().getCRMCampaigns(zaloId) || [];
    return success({ items: campaigns });
  },

  // ═══════════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════════

  getLabels(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    const labels = db().getLocalLabels(zaloId) || [];
    return success({ items: labels });
  },

  getLabelThreads(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const threads = db().getLocalLabelThreads(zaloId) || [];
    return success({ items: threads });
  },

  // ═══════════════════════════════════════════════════════════════
  // QUICK MESSAGES
  // ═══════════════════════════════════════════════════════════════

  getQuickMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const items = db().getLocalQuickMessages(zaloId) || [];
    return success({ items });
  },

  // ═══════════════════════════════════════════════════════════════
  // DRAFTS
  // ═══════════════════════════════════════════════════════════════

  getDrafts(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const draftsData = (db().getDrafts(zaloId) || []).map((d: any) => ({
      threadId: d.threadId,
      content: d.content,
      updatedAt: d.updatedAt,
    }));
    return success({ items: draftsData });
  },

  // ═══════════════════════════════════════════════════════════════
  // LINKS
  // ═══════════════════════════════════════════════════════════════

  getLinks(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing zaloId or threadId');

    const limit = Math.min(parseInt(params.limit) || 50, 100);
    const offset = parseInt(params.offset) || 0;

    const links = db().getLinks(zaloId, params.threadId, limit, offset) || [];
    return success({ items: links });
  },

  // ═══════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════

  getSetting(employee: RegisteredEmployee, params: any): JsonResponse {
    if (!params.key) return error('Missing key');
    const value = db().getSetting(params.key);
    return success({ key: params.key, value });
  },

  // ═══════════════════════════════════════════════════════════════
  // PINNED CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  getPinnedConversations(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const threadIds = db().getLocalPinnedConversations(zaloId) || [];
    return success({ items: threadIds });
  },

  // ═══════════════════════════════════════════════════════════════
  // PINNED MESSAGES
  // ═══════════════════════════════════════════════════════════════

  getPinnedMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing zaloId or threadId');
    const pins = db().getPinnedMessages(zaloId, params.threadId) || [];
    return success({ items: pins });
  },

  // ═══════════════════════════════════════════════════════════════
  // STICKERS
  // ═══════════════════════════════════════════════════════════════

  getStickerPacksHandler(employee: RegisteredEmployee, _params: any): JsonResponse {
    const packs = db().getStickerPacks() || [];
    return success({ items: packs });
  },

  getRecentStickersHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const limit = Math.min(parseInt(params.limit) || 30, 100);
    const stickers = db().getRecentStickers(limit) || [];
    return success({ items: stickers });
  },

  getStickersByIdsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const ids: number[] = params.stickerIds || params.ids || [];
    if (ids.length === 0) return success({ items: [] });
    const stickers = db().getStickersByIds(ids) || [];
    return success({ items: stickers });
  },

  // ═══════════════════════════════════════════════════════════════
  // CRM TAGS
  // ═══════════════════════════════════════════════════════════════

  getCRMTagsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    // CRM tags are stored in crm_tags table — query by owner_zalo_id
    const tags = db().query<any>(
      `SELECT * FROM crm_tags WHERE owner_zalo_id = ? ORDER BY name ASC`, [zaloId]
    ) || [];
    return success({ items: tags });
  },

  // ═══════════════════════════════════════════════════════════════
  // BANK CARDS
  // ═══════════════════════════════════════════════════════════════

  getBankCardsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const cards = db().getBankCards(zaloId) || [];
    return success({ items: cards });
  },

  // ═══════════════════════════════════════════════════════════════
  // PROXIES
  // ═══════════════════════════════════════════════════════════════

  getProxies(employee: RegisteredEmployee, _params: any): JsonResponse {
    const proxies = db().getProxies() || [];
    return success({ items: proxies });
  },

  getProxyById(employee: RegisteredEmployee, params: any): JsonResponse {
    const id = parseInt(params.id) || 0;
    if (!id) return error('Missing proxy id');
    const proxy = db().getProxyById(id);
    return success(proxy || null);
  },

  // ═══════════════════════════════════════════════════════════════
  // FRIENDS — last fetched
  // ═══════════════════════════════════════════════════════════════

  getFriendsLastFetchedHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const lastFetched = db().getFriendsLastFetched(zaloId) || 0;
    return success({ lastFetched });
  },

  // ═══════════════════════════════════════════════════════════════
  // STICKERS — extended
  // ═══════════════════════════════════════════════════════════════

  getStickerByIdHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const id = parseInt(params.stickerId) || 0;
    if (!id) return error('Missing stickerId');
    const sticker = db().getStickerById(id);
    return success(sticker || null);
  },

  getStickersByPackIdHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const catId = parseInt(params.catId) || 0;
    if (!catId) return error('Missing catId');
    const stickers = db().getStickersByPackId(catId) || [];
    return success({ items: stickers });
  },

  getKeywordStickersHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    if (!params.keyword) return error('Missing keyword');
    const stickerIds = db().getKeywordStickers(params.keyword);
    return success({ stickerIds: stickerIds || [] });
  },

  getCachedPackSummariesHandler(employee: RegisteredEmployee, _params: any): JsonResponse {
    const packs = db().getAllCachedPackSummaries() || [];
    return success({ items: packs });
  },

  // ═══════════════════════════════════════════════════════════════
  // CRM — extended
  // ═══════════════════════════════════════════════════════════════

  getCRMContactsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const opts = params.opts || {};
    const result = db().getCRMContacts(zaloId, opts) || { contacts: [], total: 0 };
    return success({ items: result.contacts || result, total: result.total || 0 });
  },

  getContactStatsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const stats = db().getContactStats(zaloId);
    return success(stats);
  },

  getCampaignContactsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const id = parseInt(params.campaignId) || 0;
    if (!id) return error('Missing campaignId');
    const contacts = db().getCampaignContacts(id) || [];
    return success({ items: contacts });
  },

  getSendLogHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const logs = db().getSendLog(zaloId, params.opts || {}) || [];
    return success({ items: logs });
  },

  getQueueStatusHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    // CRMQueueService quản lý queue status — query trực tiếp từ app_settings
    const queueData = db().getSetting(`queue_status_${zaloId}`);
    const status = queueData ? JSON.parse(queueData) : { running: false, tokens: 60 };
    return success(status);
  },

  getCampaignStatsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const limit = parseInt(params.limit) || 10;
    const stats = db().getTopCampaignStats(zaloId, limit) || [];
    return success({ items: stats });
  },

  getActivityStatsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const stats = db().getActivityStats(zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now());
    return success(stats);
  },

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES — extended
  // ═══════════════════════════════════════════════════════════════

  getUnreadCountHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const count = db().getTotalUnread(zaloId);
    return success({ total: count || 0 });
  },

  getMessagesByTypeHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId || !params.msgType) return error('Missing params');
    const limit = parseInt(params.limit) || 100;
    const msgs = db().getMessagesByType(zaloId, params.threadId, params.msgType, limit) || [];
    return success({ items: msgs });
  },

  // ═══════════════════════════════════════════════════════════════
  // QUICK MESSAGES — extended
  // ═══════════════════════════════════════════════════════════════

  getAllQuickMessagesHandler(employee: RegisteredEmployee, _params: any): JsonResponse {
    const items = db().getAllLocalQuickMessages() || [];
    return success({ items });
  },

  // ═══════════════════════════════════════════════════════════════
  // LABELS — extended
  // ═══════════════════════════════════════════════════════════════

  getThreadLabelsHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing params');
    const labels = db().getThreadLocalLabels(zaloId, params.threadId) || [];
    return success({ items: labels });
  },

  // ═══════════════════════════════════════════════════════════════
  // DRAFTS — extended
  // ═══════════════════════════════════════════════════════════════

  getSingleDraftHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.threadId) return error('Missing params');
    const draft = db().getDraft(zaloId, params.threadId);
    return success(draft || null);
  },

  // ═══════════════════════════════════════════════════════════════
  // DASHBOARD / ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  getDashboardOverview(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const overview = db().getDashboardOverview(zaloId);
    return success(overview);
  },

  getMessageVolume(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getMessageVolume(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now(),
      params.granularity || 'day', params.threadType !== undefined ? parseInt(params.threadType) : undefined
    );
    return success(data);
  },

  getPeakHours(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getPeakHoursHeatmap(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now(),
      params.threadType !== undefined ? parseInt(params.threadType) : undefined
    );
    return success(data);
  },

  getContactSegmentation(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getContactSegmentation(zaloId);
    return success(data);
  },

  getCampaignComparison(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getCampaignComparison(zaloId);
    return success(data);
  },

  getFriendRequestAnalytics(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getFriendRequestAnalytics(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
    );
    return success(data);
  },

  getContactGrowth(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getContactGrowth(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
    );
    return success(data);
  },

  getWorkflowAnalytics(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getWorkflowAnalytics(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
    );
    return success(data);
  },

  getAIAnalytics(employee: RegisteredEmployee, params: any): JsonResponse {
    const data = db().getAIAnalytics(
      parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
    );
    return success(data);
  },

  getResponseTime(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getResponseTimeStats(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now(),
      params.threadType !== undefined ? parseInt(params.threadType) : undefined
    );
    return success(data);
  },

  getLabelUsage(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    const data = db().getLabelUsageAnalytics(
      zaloId, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
    );
    return success(data);
  },

  // ═══════════════════════════════════════════════════════════════
  // WORKFLOWS
  // ═══════════════════════════════════════════════════════════════

  getWorkflows(employee: RegisteredEmployee, _params: any): JsonResponse {
    const workflows = db().getWorkflows() || [];
    return success({ items: workflows });
  },

  getWorkflowById(employee: RegisteredEmployee, params: any): JsonResponse {
    if (!params.id) return error('Missing workflow id');
    const wf = db().getWorkflowById(params.id);
    return success(wf || null);
  },

  getWorkflowRunLogs(employee: RegisteredEmployee, params: any): JsonResponse {
    const workflowId = params.workflowId || params.id;
    if (!workflowId) return error('Missing workflow id');
    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const logs = db().getWorkflowRunLogs(workflowId, limit) || [];
    return success({ items: logs });
  },

  getRecentRunLogs(employee: RegisteredEmployee, params: any): JsonResponse {
    const limit = Math.min(parseInt(params.limit) || 50, 200);
    const logs = db().query<any>(
      `SELECT * FROM workflow_run_logs ORDER BY created_at DESC LIMIT ?`, [limit]
    ) || [];
    return success({ items: logs });
  },

  // ═══════════════════════════════════════════════════════════════
  // INTEGRATIONS
  // ═══════════════════════════════════════════════════════════════

  getIntegrations(employee: RegisteredEmployee, _params: any): JsonResponse {
    const integrations = db().query<any>('SELECT * FROM integrations ORDER BY name ASC') || [];
    return success({ items: integrations });
  },

  // ═══════════════════════════════════════════════════════════════
  // AI ASSISTANTS
  // ═══════════════════════════════════════════════════════════════

  getAiAssistants(_employee: RegisteredEmployee, _params: any): JsonResponse {
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const assistants = AIAssistantService.getInstance().listAssistants();
    const masked = assistants.map((a: any) => ({ ...a, apiKey: a.apiKey ? '***' : '' }));
    return success({ items: masked });
  },

  getAiAssistant(_employee: RegisteredEmployee, params: any): JsonResponse {
    const id = params.id || '';
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const assistant = AIAssistantService.getInstance().getAssistant(id);
    if (!assistant) return error('Không tìm thấy trợ lý AI');
    return success({ ...assistant, apiKey: assistant.apiKey ? '***' : '' });
  },

  getAiAssistantFiles(_employee: RegisteredEmployee, params: any): JsonResponse {
    const assistantId = params.assistantId || params.id || '';
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const files = AIAssistantService.getInstance().getFiles(assistantId) || [];
    return success({ items: files });
  },

  getAiUsageStats(_employee: RegisteredEmployee, params: any): JsonResponse {
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const stats = AIAssistantService.getInstance().getUsageStats({
      assistantId: params.assistantId,
      days: parseInt(params.days) || 30,
    }) || [];
    return success({ items: stats });
  },

  getAiUsageLogs(_employee: RegisteredEmployee, params: any): JsonResponse {
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const logs = AIAssistantService.getInstance().getUsageLogs({
      assistantId: params.assistantId,
      limit: parseInt(params.limit) || 50,
    }) || [];
    return success({ items: logs });
  },

  getAiDefaultAssistant(_employee: RegisteredEmployee, _params: any): JsonResponse {
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const assistant = AIAssistantService.getInstance().getDefaultAssistant();
    if (!assistant) return success(null);
    return success({ ...assistant, apiKey: assistant.apiKey ? '***' : '' });
  },

  getAiAccountAssistant(_employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || '';
    const role = params.role || 'suggestion';
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const assistant = AIAssistantService.getInstance().getAssistantForAccount(zaloId, role as any);
    if (!assistant) return success({ assistant: null });
    return success({ assistant: { ...assistant, apiKey: assistant.apiKey ? '***' : '' } });
  },

  getAiAccountAssistants(_employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || '';
    const { AIAssistantService } = require('../../ai/AIAssistantService');
    const result = AIAssistantService.getInstance().getAccountAssistants(zaloId);
    return success(result);
  },
};

// ── Helper: trích snippet từ content JSON ─────────────────────────

function extractSnippet(contentRaw: any, query: string): string {
  try {
    const content = typeof contentRaw === 'string' ? JSON.parse(contentRaw) : contentRaw;
    const text = content?.text || content?.title || content?.caption || '';
    if (!text) return '';

    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text.slice(0, 100);
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 40);
    return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  } catch {
    return String(contentRaw || '').slice(0, 100);
  }
}
