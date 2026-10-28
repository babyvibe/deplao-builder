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
import { clampMediaPageLimit, normalizeMediaCursor } from '../../database/mediaMessagesQuery';
import { getCRMChannelDecision } from '../../crm/CRMChannelCapabilityService';
import {
  labelsVisibleToAccounts, maskProxyRow, ownedByAccounts, toConversationItem, toMessageItem,
  workflowRowToDto, workflowVisibleToAccounts,
} from '../employeeRestRead';

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

/**
 * zaloIds of a multi-account analytics report (JSON array or "a,b"). Every one of them must be
 * assigned to the employee — as for proxy actions — or the whole request is refused.
 */
function assignedAnalyticsAccounts(employee: RegisteredEmployee, raw: any): { ids: string[] } | { error: string } {
  const list: any[] = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ids = Array.from(new Set(list.map(id => String(id ?? '').trim()).filter(Boolean)));
  if (ids.length === 0) return { error: 'Missing zaloIds' };
  const assigned = new Set(employee.assigned_accounts || []);
  if (ids.some(id => !assigned.has(id))) return { error: 'Không có quyền truy cập tài khoản này' };
  return { ids };
}

/** Tài khoản được giao của nhân viên (chuỗi). */
function assignedIds(employee: RegisteredEmployee): string[] {
  return (employee.assigned_accounts || []).map(String);
}

/** limit trong [1, max], mặc định `fallback` (tham số REST luôn là chuỗi). */
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1), max);
}

/**
 * Dữ liệu khởi động của MỘT tài khoản (/api/boot → byAccount): trang hội thoại đầu, nhãn + gắn nhãn, tin nhắn nhanh,
 * ghim, cờ (tắt tiếng / Khác / lưu trữ), cài đặt thông báo. Mỗi phần lỗi riêng → rỗng, không làm hỏng cả boot.
 */
function bootAccountData(zaloId: string): Record<string, any> {
  const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn() ?? fallback; } catch { return fallback; } };
  const conversations = safe(() => (db().query<any>(
    `SELECT * FROM contacts WHERE owner_zalo_id = ? ORDER BY last_message_time DESC LIMIT 50`, [zaloId],
  ) || []).map(toConversationItem), [] as any[]);
  const totalConversations = safe(() => Number((db().query<any>(
    `SELECT COUNT(*) as cnt FROM contacts WHERE owner_zalo_id = ?`, [zaloId],
  ))[0]?.cnt) || 0, 0);
  const notifSettings = safe(() => {
    const raw = db().getSetting(`notifSettings_${zaloId}`);
    return raw ? JSON.parse(raw) : null;
  }, null as any);
  return {
    conversations,
    totalConversations,
    labels: safe(() => db().getLocalLabels(zaloId), [] as any[]),
    labelThreads: safe(() => db().getLocalLabelThreads(zaloId), [] as any[]),
    quickMessages: safe(() => db().getLocalQuickMessages(zaloId), [] as any[]),
    pinnedConversations: safe(() => db().getLocalPinnedConversations(zaloId), [] as string[]),
    flags: safe(() => db().getContactsWithFlags(zaloId), [] as any[]),
    notifSettings,
  };
}

// ── Handlers ────────────────────────────────────────────────────────

export const handlers = {
  // ═══════════════════════════════════════════════════════════════
  // BOOT API — toàn bộ data cần thiết cho employee mới connect
  // ═══════════════════════════════════════════════════════════════

  getBoot(employee: RegisteredEmployee, _params: any): JsonResponse {
    const zaloIds = assignedIds(employee);
    if (zaloIds.length === 0) return success({
      conversations: [], totalConversations: 0, accounts: [],
      labels: [], quickMessages: [], pinnedConversations: [],
      settings: {}, drafts: [], byAccount: {},
    });

    // Dữ liệu khởi động của MỌI tài khoản được giao (trước đây chỉ tài khoản đầu tiên — nhân viên nhiều tài khoản
    // thiếu dữ liệu tài khoản thứ hai). Các trường cấp trên (conversations, labels…) giữ = tài khoản đầu cho bản cũ.
    const byAccount: Record<string, Record<string, any>> = {};
    for (const zaloId of zaloIds) byAccount[zaloId] = bootAccountData(zaloId);

    const mainZaloId = zaloIds[0];
    const main = byAccount[mainZaloId];
    const conversations = main.conversations;
    const totalConversations = main.totalConversations;
    const labels: any[] = main.labels;
    const quickMessages: any[] = main.quickMessages;
    const pinnedConversations: string[] = main.pinnedConversations;

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
      let acc: any;
      try {
        const rows = db().query<any>('SELECT zalo_id, full_name, avatar_url, phone, is_active, listener_active FROM accounts WHERE zalo_id=?', [zaloId]);
        acc = rows[0] || { zalo_id: zaloId, full_name: '', avatar_url: '', phone: '', is_active: 1, listener_active: 0 };
      } catch { acc = { zalo_id: zaloId, full_name: '', avatar_url: '', phone: '', is_active: 1, listener_active: 0 }; }
      // Zalo My Documents (hội thoại có sẵn của Zalo)
      let send2meId = '';
      try { send2meId = db().getMyDocumentsId(zaloId) || ''; } catch {}
      return { ...acc, send2me_id: send2meId };
    });

    return success({
      conversations,
      totalConversations,
      accounts: accountsData,
      labels,
      quickMessages,
      pinnedConversations,
      drafts,
      byAccount,
      serverTime: Date.now(),
    });
  },

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  getConversations(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');

    // Trần 500 như nhánh IPC (DataAccessor.getConversations): CRM / nhóm xin 500–999 — trước đây nhân viên chỉ nhận 200
    const limit = clampLimit(params.limit, 50, 500);
    const offset = Math.max(parseInt(params.offset) || 0, 0);
    const search = params.search !== undefined && params.search !== null ? String(params.search) : '';

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
    // ids=a,b,c: chỉ các hội thoại này (hội thoại ghim nằm ở trang sau — ConversationList tải bù), tối đa 200
    if (params.ids !== undefined && params.ids !== null && params.ids !== '') {
      const ids = [...new Set((Array.isArray(params.ids) ? params.ids : String(params.ids).split(','))
        .map((id: any) => String(id).trim()).filter(Boolean))].slice(0, 200);
      if (ids.length === 0) return success({ items: [], total: 0 }, { page: 1, limit, total: 0, hasMore: false });
      const marks = ids.map(() => '?').join(', ');
      whereClause += ` AND contact_id IN (${marks})`;
      queryParams.push(...ids);
      countParams.push(...ids);
    }

    const total = (db().query<any>(
      `SELECT COUNT(*) as cnt FROM contacts WHERE ${whereClause}`, countParams
    ))[0]?.cnt || 0;

    // is_replied (đã / chưa trả lời theo tin thật mới nhất) như nhánh IPC getContactsFiltered
    const page = db().query<any>(
      `SELECT contacts.*, ${db().replyStateColumnSql()} AS is_replied FROM contacts WHERE ${whereClause} ORDER BY last_message_time DESC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    ) || [];

    // Dòng đầy đủ như IPC (channel, is_in_others, is_forum, telegram_*…) — xem toConversationItem
    const items = page.map(toConversationItem);

    return success({ items, total }, {
      page: Math.floor(offset / limit) + 1,
      limit,
      total,
      hasMore: offset + limit < total,
    });
  },

  /**
   * Như IPC db:getContactsFiltered — bộ lọc của danh sách hội thoại (kênh, tìm, Chưa đọc, Khác, Chưa trả lời, khoảng
   * ngày) chạy DatabaseService.getContactsFiltered trên DB Boss cho tài khoản được giao (checkEmployeeAccess đã kiểm
   * `zaloId`). Không có limit → mọi hội thoại khớp, như nhánh IPC.
   */
  getConversationsFiltered(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    const flag = (value: unknown) => value === true || value === 'true' || value === '1' || value === 1;
    const positive = (value: unknown) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const rows = db().getContactsFiltered(String(zaloId), {
      channel: params.channel ? String(params.channel) : undefined,
      search: params.search ? String(params.search) : undefined,
      unreadOnly: flag(params.unreadOnly),
      othersOnly: flag(params.othersOnly),
      excludeOthers: flag(params.excludeOthers),
      unrepliedOnly: flag(params.unrepliedOnly),
      fromTs: positive(params.fromTs),
      toTs: positive(params.toTs),
      limit: positive(params.limit),
      offset: positive(params.offset),
    }) || [];
    return success({ items: rows.map(toConversationItem) });
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

    // Trần 200 như IPC db:getMessages (ChatHeader xin 200 — trước đây nhân viên chỉ nhận 100)
    const limit = clampLimit(params.limit, 50, 200);
    const offset = Math.max(parseInt(params.offset) || 0, 0);
    const before = params.before ? parseInt(params.before) : undefined;

    // Nếu có before → cursor-based, nếu không → offset-based
    const topicId = params.topicId ? String(params.topicId) : undefined;
    const messages = db().getMessages(zaloId, params.threadId, limit, before ? 0 : offset, before, topicId);
    const hasMore = messages.length >= limit;

    console.log(`[RestApi] getMessages: zaloId=${zaloId} threadId=${params.threadId} limit=${limit} → ${messages.length} msgs`);

    // Dòng đầy đủ như IPC (channel, reply_to_id, status, is_edited…) — trước đây thiếu → trích dẫn / album / sửa tin
    // hiển thị khác chủ (xem toMessageItem)
    const items = messages.map(toMessageItem);

    return success({ items, total: items.length }, {
      page: 1,
      limit,
      total: items.length,
      hasMore,
    });
  },

  getMessagesAround(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    const rawTs = params.timestamp ?? params.msgId; // DataAccessor gửi cả hai (msgId = timestamp, tên cũ)
    if (!zaloId || !params.threadId || !rawTs) return error('Missing params');

    // Tin quanh mốc timestamp — mặc định 50, trần 200 như IPC (trước đây 20 / trần 50: "nhảy tới tin" thiếu ngữ cảnh)
    const timestamp = parseInt(rawTs) || Date.now();
    const limit = clampLimit(params.limit, 50, 200);

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
    // beforeTs/afterTs (+ beforeMsgId/afterMsgId): keyset page for the image viewer gallery (newest-first).
    // `cursor: true` in the reply tells the employee app the cursor was applied (older Boss builds ignore it).
    const cursor = params.threadId ? normalizeMediaCursor(params) : null;

    const messages = !params.threadId
        ? db().getAllLocalMediaMessages(zaloId)
        : cursor
            ? db().getMediaMessages(zaloId, params.threadId, clampMediaPageLimit(params.limit), 0, cursor)
            : db().getMediaMessages(zaloId, params.threadId, limit, offset);

    return success(cursor ? { items: messages || [], cursor: true } : { items: messages || [] }, {
      page: Math.floor(offset / limit) + 1,
      limit,
      total: messages?.length || 0,
      hasMore: (messages?.length || 0) >= limit,
    });
  },

  getMessageById(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.msgId) return error('Missing zaloId or msgId');

    const msg = db().getMessageById(zaloId, params.msgId, params.threadId);
    return success(msg || null);
  },

  // ═══════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════

  searchMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    // DataAccessor gửi `query` (cùng tên tham số IPC db:searchMessages); bản cũ gửi `q`. Trước đây chỉ đọc `q` →
    // tìm tin của nhân viên luôn lỗi "Missing zaloId or query".
    const raw = params.query ?? params.q;
    if (!zaloId || raw === undefined || raw === null) return error('Missing zaloId or query');

    const query = String(raw).trim();
    if (!query) return success({ items: [], total: 0 });

    // Như IPC: tối đa 100 dòng của DB (người gọi lọc theo hội thoại rồi mới cắt)
    const limit = clampLimit(params.limit, 100, 100);
    const messages = db().searchMessages(zaloId, query);

    // Dòng tin đầy đủ như IPC (`content` để lọc / hiển thị, `timestamp` để nhảy tới tin) + thread_name/snippet cũ
    const items = (messages || []).slice(0, limit).map((m: any) => ({
      ...m,
      thread_name: m.thread_name || m.thread_id || '',
      snippet: extractSnippet(m.content, query),
    }));

    return success({ items, total: items.length });
  },

  /**
   * Ô chọn liên hệ (workflow, AI workflow): tìm không dấu + lọc loại + phân trang — như IPC db:searchContactsForPicker
   * (trước đây nhân viên nhận stub rỗng). Bắt buộc zaloId (không đoán tài khoản đầu tiên).
   */
  searchContactsForPicker(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId ? String(params.zaloId) : '';
    if (!zaloId) return error('Missing zaloId');
    const ids = Array.isArray(params.ids)
      ? params.ids.map(String)
      : (params.ids ? String(params.ids).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined);
    const result = db().searchContactsForPicker(zaloId, {
      search: params.search !== undefined && params.search !== null ? String(params.search) : undefined,
      type: params.type === 'user' || params.type === 'group' ? params.type : 'all',
      limit: params.limit !== undefined ? Number(params.limit) : undefined,
      offset: params.offset !== undefined ? Number(params.offset) : undefined,
      ids,
    });
    return success(result || { items: [], total: 0, counts: { all: 0, user: 0, group: 0 } });
  },

  /** Liên hệ theo số điện thoại (gợi ý danh thiếp khi gõ số) — như IPC db:searchContactByPhone; null = không có. */
  searchContactByPhone(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId ? String(params.zaloId) : '';
    const phone = String(params.phone ?? '').trim();
    if (!zaloId || !phone) return error('Missing zaloId or phone');
    return success(db().searchContactByPhone(zaloId, phone) || null);
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
      // Cùng quy tắc IPC db:isFriend: bảng friends, rồi cờ contacts.is_friend (danh sách bạn chưa đồng bộ)
      return success({ isFriend: !!db().checkIsFriend(String(zaloId), String(params.userId)) });
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
    const all = db().getFriendRequests(zaloId, direction) || [];
    const total = all.length;
    // Như IPC: trả ĐỦ danh sách (trước đây cắt 50 → nhân viên thấy tối đa 50 lời mời, số đếm sai); chỉ cắt trang khi
    // người gọi truyền limit
    const paged = params.limit !== undefined && params.limit !== '';
    const offset = Math.max(parseInt(params.offset) || 0, 0);
    const items = paged ? all.slice(offset, offset + clampLimit(params.limit, 50, 500)) : all;
    const lastFetched = db().getFriendRequestsLastFetched(zaloId, direction) || 0;
    return success({ items, total, lastFetched });
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

  /** Như IPC db:getGroupMembersPage: một trang thành viên + tổng, tìm theo `query`. */
  getGroupMembersPage(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId || !params.groupId) return error('Missing zaloId or groupId');

    const page = db().getGroupMembersPage(zaloId, params.groupId, {
      query: params.query || '',
      limit: params.limit !== undefined && params.limit !== '' ? Number(params.limit) : undefined,
      offset: params.offset !== undefined && params.offset !== '' ? Number(params.offset) : undefined,
      ownerRole: params.ownerRole !== undefined && params.ownerRole !== '' ? Number(params.ownerRole) : undefined,
      namedOnly: params.namedOnly === true || params.namedOnly === 'true' || params.namedOnly === '1',
    });
    return success({ items: page.members, total: page.total });
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

    // Như IPC crm:getCampaigns: kênh không hỗ trợ chiến dịch → danh sách rỗng
    if (!getCRMChannelDecision(String(zaloId), 'campaign').allowed) return success({ items: [] });
    const campaigns = db().getCRMCampaigns(zaloId) || [];
    return success({ items: campaigns });
  },

  // ═══════════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════════

  getLabels(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId ? String(params.zaloId) : '';
    if (zaloId) return success({ items: db().getLocalLabels(zaloId) || [] });
    // Không truyền tài khoản (Cài đặt → Nhãn, workflow): nhãn chung + nhãn của MỌI tài khoản được giao — nhánh IPC trả
    // mọi nhãn của máy; trước đây Boss trả nhãn của tài khoản được giao ĐẦU TIÊN (thiếu nhãn tài khoản thứ hai)
    return success({ items: labelsVisibleToAccounts(db().getLocalLabels() || [], assignedIds(employee)) });
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
  // TỰ ĐỘNG ĐÁNH DẤU ĐÃ ĐỌC
  // ═══════════════════════════════════════════════════════════════

  getUnreadConversations(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = String(params.zaloId || employee.assigned_accounts[0] || '');
    if (!zaloId || !(employee.assigned_accounts || []).map(String).includes(zaloId)) return error('Không có quyền truy cập tài khoản này');
    const number = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : Number(value));
    const items = db().getUnreadConversations(zaloId, {
      from: number(params.from),
      to: number(params.to),
      includeOthers: params.includeOthers === true || params.includeOthers === 'true',
      channel: params.channel ? String(params.channel) : undefined,
    });
    return success({ items });
  },

  // ═══════════════════════════════════════════════════════════════
  // STARRED MESSAGES ("Tin đánh dấu")
  // ═══════════════════════════════════════════════════════════════

  getStarredMessages(employee: RegisteredEmployee, params: any): JsonResponse {
    const assigned = new Set((employee.assigned_accounts || []).map(String));
    const requested: string[] = Array.isArray(params.zaloIds) && params.zaloIds.length
      ? params.zaloIds.map(String)
      : [String(params.zaloId || employee.assigned_accounts[0] || '')];
    const zaloIds = requested.filter(id => id && assigned.has(id));
    if (!zaloIds.length) return error('Không có quyền truy cập tài khoản này');
    if (params.mode === 'keys') return success({ items: db().getStarredMessageKeys(zaloIds[0]) });
    const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
    const rows = db().getStarredMessages(zaloIds, limit + 1, Math.max(0, Number(params.offset) || 0));
    return success({ items: rows.slice(0, limit), hasMore: rows.length > limit });
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

  // Mật khẩu proxy không bao giờ rời máy Boss (trước đây trả nguyên dòng cho mọi nhân viên)
  getProxies(employee: RegisteredEmployee, _params: any): JsonResponse {
    const proxies = (db().getProxies() || []).map(maskProxyRow);
    return success({ items: proxies });
  },

  getProxyById(employee: RegisteredEmployee, params: any): JsonResponse {
    const id = parseInt(params.id) || 0;
    if (!id) return error('Missing proxy id');
    const proxy = db().getProxyById(id);
    return success(proxy ? maskProxyRow(proxy) : null);
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
    const stickerIds = db().getKeywordStickers(String(params.keyword));
    // null = từ khoá CHƯA có trong cache (người gọi hỏi API), [] = đã tìm, không có sticker — như IPC. Trước đây null
    // thành [] → gợi ý sticker của nhân viên không bao giờ gọi API cho từ khoá mới.
    return success({ stickerIds: Array.isArray(stickerIds) ? stickerIds : null });
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
    // Chỉ có campaignId (không có tham số tài khoản → checkEmployeeAccess không chặn được): chiến dịch phải thuộc
    // tài khoản được giao. Không phân biệt "không có" với "không được giao".
    const campaign = db().getCRMCampaign(id);
    if (!campaign || !assignedIds(employee).includes(String(campaign.owner_zalo_id))) {
      return error('Không tìm thấy chiến dịch');
    }
    const contacts = db().getCampaignContacts(id) || [];
    return success({ items: contacts });
  },

  getSendLogHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    // Như IPC crm:getSendLog: kênh không có lịch sử CRM → rỗng
    if (!getCRMChannelDecision(String(zaloId), 'history').allowed) return success({ items: [] });
    const logs = db().getSendLog(zaloId, params.opts || {}) || [];
    return success({ items: logs });
  },

  getQueueStatusHandler(employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || employee.assigned_accounts[0];
    if (!zaloId) return error('Missing zaloId');
    // Trạng thái hàng đợi sống trong CRMQueueService (như IPC crm:getQueueStatus). Trước đây đọc app_settings
    // `queue_status_<id>` — khoá không ai ghi → nhân viên luôn thấy "đang dừng".
    const CRMQueueService = require('../../crm/CRMQueueService').default;
    return success(CRMQueueService.getInstance().getStatus(String(zaloId)));
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
    // Chỉ tin nhắn nhanh của tài khoản được giao (trước đây trả của MỌI tài khoản trên máy Boss)
    const items = ownedByAccounts(db().getAllLocalQuickMessages() || [], assignedIds(employee));
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

    const overview = db().getDashboardOverview(
      zaloId,
      params.sinceTs !== undefined ? Number(params.sinceTs) : undefined,
      params.untilTs !== undefined ? Number(params.untilTs) : undefined,
      params.threadType !== undefined ? Number(params.threadType) : undefined,
    );
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

  /** Several accounts in one query (Reports multi-select): a workflow shared by them counts once. */
  getWorkflowAnalyticsMulti(employee: RegisteredEmployee, params: any): JsonResponse {
    const accounts = assignedAnalyticsAccounts(employee, params.zaloIds);
    if ('error' in accounts) return error(accounts.error);

    const data = db().getWorkflowAnalytics(
      accounts.ids, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now()
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

  /** Several accounts in one query (Reports multi-select): median / min / max over all their replies. */
  getResponseTimeMulti(employee: RegisteredEmployee, params: any): JsonResponse {
    const accounts = assignedAnalyticsAccounts(employee, params.zaloIds);
    if ('error' in accounts) return error(accounts.error);

    const data = db().getResponseTimeStats(
      accounts.ids, parseInt(params.sinceTs) || 0, parseInt(params.untilTs) || Date.now(),
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

  // Hình dạng `Workflow` như IPC workflow:list (pageIds, nodes/edges đã parse, enabled boolean — trước đây trả dòng thô
  // nodes_json/page_ids) và chỉ workflow chung hoặc gắn tài khoản được giao (cùng quy tắc nhánh nhân viên của workflowIpc)
  getWorkflows(employee: RegisteredEmployee, _params: any): JsonResponse {
    const assigned = assignedIds(employee);
    const workflows = (db().getWorkflows() || []).map(workflowRowToDto).filter(wf => workflowVisibleToAccounts(wf, assigned));
    return success({ items: workflows });
  },

  getWorkflowById(employee: RegisteredEmployee, params: any): JsonResponse {
    if (!params.id) return error('Missing workflow id');
    const row = db().getWorkflowById(params.id);
    const wf = row ? workflowRowToDto(row) : null;
    return success(wf && workflowVisibleToAccounts(wf, assignedIds(employee)) ? wf : null);
  },

  getWorkflowRunLogs(employee: RegisteredEmployee, params: any): JsonResponse {
    const workflowId = params.workflowId || params.id;
    if (!workflowId) return error('Missing workflow id');
    // Nhật ký chạy chứa nội dung tin của trang gắn workflow: chỉ workflow nhân viên được thấy (như getWorkflows)
    const row = db().getWorkflowById(workflowId);
    if (!row || !workflowVisibleToAccounts(workflowRowToDto(row), assignedIds(employee))) return error('Không tìm thấy workflow');
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
    // Như IPC integration:list: cấu hình KHÔNG kèm thông tin xác thực + cổng webhook. Trước đây trả dòng thô
    // (credentials_encrypted — JSON thường khi máy không có safeStorage; settings là chuỗi; enabled là số).
    const { IntegrationRegistry } = require('../../integrations/IntegrationRegistry');
    return success({ items: IntegrationRegistry.listConfigs(), webhookPort: IntegrationRegistry.getWebhookPort() });
  },

  // ═══════════════════════════════════════════════════════════════
  // AI ASSISTANTS
  // ═══════════════════════════════════════════════════════════════

  getAiAssistants(_employee: RegisteredEmployee, _params: any): JsonResponse {
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const assistants = AIAssistantService.getInstance().listAssistants();
    const masked = assistants.map((a: any) => ({ ...a, apiKey: a.apiKey ? '***' : '' }));
    return success({ items: masked });
  },

  getAiAssistant(_employee: RegisteredEmployee, params: any): JsonResponse {
    const id = params.id || '';
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const assistant = AIAssistantService.getInstance().getAssistant(id);
    if (!assistant) return error('Không tìm thấy trợ lý AI');
    return success({ ...assistant, apiKey: assistant.apiKey ? '***' : '' });
  },

  getAiAssistantFiles(_employee: RegisteredEmployee, params: any): JsonResponse {
    const assistantId = params.assistantId || params.id || '';
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const files = AIAssistantService.getInstance().getFiles(assistantId) || [];
    return success({ items: files });
  },

  getAiUsageStats(_employee: RegisteredEmployee, params: any): JsonResponse {
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const stats = AIAssistantService.getInstance().getUsageStats({
      assistantId: params.assistantId,
      days: parseInt(params.days) || 30,
    }) || [];
    return success({ items: stats });
  },

  getAiUsageLogs(_employee: RegisteredEmployee, params: any): JsonResponse {
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const logs = AIAssistantService.getInstance().getUsageLogs({
      assistantId: params.assistantId,
      limit: parseInt(params.limit) || 50,
    }) || [];
    return success({ items: logs });
  },

  getAiDefaultAssistant(_employee: RegisteredEmployee, _params: any): JsonResponse {
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const assistant = AIAssistantService.getInstance().getDefaultAssistant();
    if (!assistant) return success(null);
    return success({ ...assistant, apiKey: assistant.apiKey ? '***' : '' });
  },

  getAiAccountAssistant(_employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || '';
    const role = params.role || 'suggestion';
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const assistant = AIAssistantService.getInstance().getAssistantForAccount(zaloId, role as any);
    if (!assistant) return success({ assistant: null });
    return success({ assistant: { ...assistant, apiKey: assistant.apiKey ? '***' : '' } });
  },

  getAiAccountAssistants(_employee: RegisteredEmployee, params: any): JsonResponse {
    const zaloId = params.zaloId || '';
    const AIAssistantService = require('../../ai/AIAssistantService').default;
    const result = AIAssistantService.getInstance().getAccountAssistants(zaloId);
    return success(result);
  },

  // ERP: route /api/query/erp/* + /api/command/erp/* chạy handler IPC erp:* (ErpRestRoutes + HttpRelayService.executeErpRest)
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
