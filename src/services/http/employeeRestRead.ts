/**
 * employeeRestRead.ts — phần thuần của đường ĐỌC REST nhân viên phía Boss (HttpRelayService.handleRestApi +
 * RestApiHandlers). Không import DB / electron → test được trực tiếp.
 *
 *  - parseRestQueryParams: query string → params (giá trị JSON `[...]`/`{...}` tự parse, TRỪ ô chữ người dùng gõ)
 *  - RestReadCache: cache đọc ngắn hạn, hết hạn ngay khi DB đổi (mốc thay đổi), chỉ lưu kết quả thành công
 *  - toConversationItem / toMessageItem: dòng DB đầy đủ như nhánh IPC (+ các trường chuẩn hoá cũ cho bản cũ)
 *  - labelsVisibleToAccounts / ownedByAccounts / workflowVisibleToAccounts: chỉ dữ liệu của tài khoản được giao
 *  - workflowRowToDto / maskProxyRow: hình dạng giống IPC, không lộ bí mật
 */

import { normalizeChannel } from '../../configs/channels/channelConfig';

// ── Query params ───────────────────────────────────────────────────────────────

/**
 * Tham số là chữ người dùng gõ (tìm kiếm, số điện thoại…): giữ nguyên chuỗi. Trước đây "[1,2]" / "{a}" trong ô tìm
 * bị parse thành mảng / object rồi handler tìm sai.
 */
export const RAW_TEXT_QUERY_PARAMS: ReadonlySet<string> = new Set(['search', 'q', 'query', 'keyword', 'phone']);

/** `?a=1&ids=["x"]` → `{ a: '1', ids: ['x'] }`. Giá trị trông như JSON object/array được parse (RestQueryService gửi mảng/object dạng JSON). */
export function parseRestQueryParams(queryString: string): Record<string, any> {
  const params: Record<string, any> = {};
  const search = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
  for (const [key, value] of search) {
    if (!RAW_TEXT_QUERY_PARAMS.has(key)
      && ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']')))) {
      try { params[key] = JSON.parse(value); continue; } catch { /* không phải JSON → giữ chuỗi */ }
    }
    params[key] = value;
  }
  return params;
}

// ── Cache đọc (Boss) ───────────────────────────────────────────────────────────

/** Khoá cache: method + đường dẫn + tham số (bỏ khoá nội bộ `_…`, sắp xếp) + nhân viên. */
export function restCacheKey(method: string, pathname: string, employeeId: string, params?: Record<string, any> | null): string {
  const query = params
    ? Object.keys(params).filter(k => !k.startsWith('_')).sort().map(k => `${k}=${JSON.stringify(params[k])}`).join('&')
    : '';
  return `${method}:${pathname}?${query}:${employeeId}`;
}

interface RestCacheEntry { data: any; ts: number; token: string }

/**
 * Cache kết quả đọc REST trong vài giây (nhân viên gọi lại nhãn / ghim / cờ sau MỖI tin nhắn — chặn main thread).
 * Một entry chỉ dùng được khi CÙNG mốc thay đổi DB (`token`, xem HttpRelayService.restCacheToken) VÀ còn trong TTL:
 * event realtime luôn phát SAU khi ghi DB, nên lần tải lại ngay sau event không bao giờ nhận giá trị trước thay đổi.
 * Không có mốc (null) → không cache. Chỉ lưu kết quả thành công (`success !== false`).
 */
export class RestReadCache {
  private readonly entries = new Map<string, RestCacheEntry>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: string, token: string | null, now = Date.now()): any | undefined {
    if (!token) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.token !== token || now - entry.ts >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, token: string | null, data: any, now = Date.now()): void {
    if (!token || data === undefined || data === null || (typeof data === 'object' && data.success === false)) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { data, ts: now, token });
    if (this.entries.size > 50) this.prune(now);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.ts >= this.ttlMs) this.entries.delete(key);
    }
    // Vẫn quá nhiều (nhiều nhân viên × tham số trong cùng TTL): bỏ entry cũ nhất (Map giữ thứ tự chèn)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

// ── Hình dạng dòng (giống nhánh IPC) ───────────────────────────────────────────

/**
 * Hội thoại: TOÀN BỘ cột như IPC getContactsFiltered (channel, is_in_others, mute_until, is_forum, telegram_*…) —
 * trước đây chỉ một danh sách cột cố định nên chế độ nhân viên thiếu kênh / chủ đề Telegram / cờ. Các trường chuẩn hoá
 * cũ giữ nguyên giá trị để nhân viên bản cũ đọc như trước.
 */
export function toConversationItem(c: any): any {
  return {
    ...c,
    contact_id: c?.contact_id,
    owner_zalo_id: c?.owner_zalo_id || '',
    display_name: c?.display_name || '',
    avatar_url: c?.avatar_url || '',
    last_message: c?.last_message || '',
    last_message_time: c?.last_message_time || 0,
    last_message_type: c?.last_message_type || 'text',
    unread_count: c?.unread_count || 0,
    is_group: c?.is_group ? 1 : 0,
    is_muted: c?.is_muted ? 1 : 0,
    is_pinned: false, // client tự kiểm tra (ghim local)
    is_friend: c?.is_friend ? 1 : 0,
    contact_type: c?.contact_type || 0,
    alias: c?.alias || '',
    phone: c?.phone || '',
    gender: c?.gender ?? null,
    birthday: c?.birthday ?? null,
  };
}

/**
 * Tin nhắn: TOÀN BỘ cột như IPC db:getMessages (thread_type, status, channel, reply_to_id, is_edited, edit_history,
 * inline_buttons, media_expired…) + các trường chuẩn hoá cũ.
 */
export function toMessageItem(m: any): any {
  return {
    ...m,
    msg_id: m?.msg_id,
    cli_msg_id: m?.cli_msg_id,
    thread_id: m?.thread_id,
    owner_zalo_id: m?.owner_zalo_id,
    msg_type: m?.msg_type,
    content: m?.content,
    timestamp: m?.timestamp,
    is_sent: m?.is_sent ? 1 : 0,
    is_recalled: m?.is_recalled ? 1 : 0,
    is_self: m?.is_self ? 1 : 0,
    sender_id: m?.sender_id || '',
    sender_name: m?.sender_name || '',
    reactions: m?.reactions || null,
    attachments: m?.attachments || null,
    local_paths: m?.local_paths || null,
    handled_by_employee: m?.handled_by_employee || null,
    quote_data: m?.quote_data || null,
    topic_id: m?.topic_id || null,
  };
}

// ── Lọc theo tài khoản được giao ───────────────────────────────────────────────

function idList(value: unknown): string[] {
  return String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Nhãn Local khi KHÔNG truyền tài khoản (Cài đặt → Nhãn): nhãn chung (page_ids rỗng) + nhãn gắn với ít nhất một tài
 * khoản được giao. Trước đây Boss trả nhãn của tài khoản được giao ĐẦU TIÊN → nhãn riêng của tài khoản thứ hai biến mất.
 */
export function labelsVisibleToAccounts<T extends { page_ids?: unknown }>(labels: T[], accountIds: readonly string[]): T[] {
  const allowed = new Set(accountIds.map(String));
  return (labels || []).filter((label) => {
    const pages = idList(label?.page_ids);
    return pages.length === 0 || pages.some(id => allowed.has(id));
  });
}

/** Dòng có chủ là tài khoản được giao (dòng không có chủ = dùng chung → giữ). */
export function ownedByAccounts<T extends Record<string, any>>(rows: T[], accountIds: readonly string[], key = 'owner_zalo_id'): T[] {
  const allowed = new Set(accountIds.map(String));
  return (rows || []).filter((row) => {
    const owner = String(row?.[key] ?? '');
    return !owner || allowed.has(owner);
  });
}

/** Dòng bảng workflows → hình dạng `Workflow` của IPC workflow:list (pageIds mảng, nodes/edges đã parse, enabled boolean). */
export function workflowRowToDto(r: any): any {
  const pageIdsRaw = String(r?.page_ids || r?.page_id || '');
  const pageIds = idList(pageIdsRaw);
  const parse = (raw: unknown) => {
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(String(raw || '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return {
    id: r?.id,
    name: r?.name,
    description: r?.description || '',
    enabled: r?.enabled === 1 || r?.enabled === true,
    channel: normalizeChannel(r?.channel ? String(r.channel) : undefined),
    pageId: pageIds[0] || '',
    pageIds,
    nodes: parse(r?.nodes_json ?? r?.nodes),
    edges: parse(r?.edges_json ?? r?.edges),
    createdAt: r?.created_at ?? r?.createdAt,
    updatedAt: r?.updated_at ?? r?.updatedAt,
  };
}

/** Như workflowIpc (nhân viên): workflow chung (không gắn trang) hoặc gắn ít nhất một tài khoản được giao. */
export function workflowVisibleToAccounts(wf: { pageIds?: string[] }, accountIds: readonly string[]): boolean {
  const pages = wf?.pageIds || [];
  if (pages.length === 0) return true;
  const allowed = new Set(accountIds.map(String));
  return pages.some(id => allowed.has(String(id)));
}

/** Proxy: không bao giờ gửi mật khẩu cho máy nhân viên. */
export function maskProxyRow<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  return { ...row, password: row.password ? '***' : '' };
}
