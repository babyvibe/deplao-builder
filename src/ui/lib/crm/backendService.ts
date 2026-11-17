/**
 * Backend Service: the app calls the deplaoapp.com server for the Zalo group CRM (hidden group member scan, the shared group library).
 *
 * API:
 *   POST https://deplaoapp.com/api/scan/group            → scans group members (SENDS THE ZALO COOKIE, see below)
 *   POST https://deplaoapp.com/api/shared-groups/submit   → shares a group into the shared library (public to other users)
 *   GET  https://deplaoapp.com/api/shared-groups/list     → the shared group library list
 *
 * ─── Hidden group scan: data leaves the machine (read carefully before changing it / when reviewing security) ────────────────────────────────
 * - WHAT IS SENT: the Zalo login session (cookie + IMEI) of the account being scanned + groupId + page_id (= zalo_id). The cookie lets
 *   anyone use the Zalo account, so this is the most sensitive data the app has ever sent out.
 * - WHY VIA THE SERVER: the hidden member scan runs on the server to keep it private (the app is open source). The server uses the
 *   cookie to call Zalo (getLoginInfo → list of IDs → member info), then returns the list; it does not store the cookie, and does not
 *   write the cookie to the log. Server log: endpoint, IP, user agent, page_id, group_id, time, result code
 *   (repo dep-lao-backend-payment: controllers/scan.controller.ts, services/scan.service.ts, middleware/publicApiLogger.ts).
 * - SENT ONLY WITH THE USER'S CONSENT (from 26.11.0, OFF by default): every call to `scanGroupViaBackend` must ask first with
 *   `ensureHiddenScanConsent()` (components/crm/groups/HiddenScanConsentDialog.tsx); the dialog states clearly what is sent, why,
 *   the risks, and the right to refuse. Consent is remembered per machine (lib/crm/hiddenScanConsent.ts) and is turned off at CRM → "Nhóm" → "Quét thành viên".
 *   `scanGroupViaBackend` checks again itself: no consent → returns a CONSENT_REQUIRED error and makes NO network call.
 * - Current call sites: CRM → "Nhóm" → "Quét thành viên" (handleScanTab), CRM → "Thành viên nhóm" → "Tải thông tin thành viên" and the
 *   group member panel in the conversation (hooks/chat/useGroupMemberSync.ts), bulk group import
 *   (BulkImportGroupsModal, counts members). A new call site must go through ensureHiddenScanConsent.
 * - ENCRYPTION: the body is "encrypted" with AES-128-CBC using the SECRET_KEY below, but that key is in the public source code and
 *   is also sent as x-api-key → it is only obfuscation, NOT a security layer; if the renderer has no Node crypto module,
 *   encryptBody falls back to plain base64. The real protection on the wire is HTTPS.
 * - Do NOT log the cookie / body / member list on the client (the console only writes the endpoint, groupId, and counts).
 */

import { hasHiddenScanConsent } from './hiddenScanConsent';
import { tr } from '../../../shared/i18n';

const BACKEND_URL = 'https://deplaoapp.com';
const SECRET_KEY = 'fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb';

interface ScanGroupResult {
  success: boolean;
  groupId: string;
  /** CONSENT_REQUIRED: the user has not agreed to send the Zalo login session to the server → nothing is sent. */
  code?: 'CONSENT_REQUIRED' | 'NO_SESSION';
  totalMembers: number;
  members: Array<{
    userId: string;
    displayName: string;
    zaloName: string;
    avatar: string;
    accountStatus: number;
    type: number;
    lastUpdateTime: number;
    globalId: string;
    id: string;
  }>;
  error?: string;
}

/** AES-128-CBC wire format, shared with the existing backend. */
async function encryptBody(body: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const toBase64 = (data: Uint8Array) => {
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  try {
    const rawKey = Uint8Array.from(SECRET_KEY.match(/.{2}/g)!.slice(0, 16), hex => parseInt(hex, 16));
    const key = await globalThis.crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
    const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, bytes);
    return toBase64(new Uint8Array(encrypted));
  } catch (err) {
    console.warn('[backendService] encryptBody failed, sending plain text:', err);
    return toBase64(bytes);
  }
}

/**
 * Calls the backend API.
 */
async function callBackend<T>(endpoint: string, body: object): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  // Do not log the body: it contains the Zalo cookie
  console.log(`[backendService] calling ${url}`);

  let encryptedBody: string;
  try {
    encryptedBody = await encryptBody(body);
  } catch (err) {
    console.error('[backendService] encryptBody error:', err);
    throw err;
  }

  const payload = {
    page_id: (body as any).page_id || '',
    body: encryptedBody,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SECRET_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  // Do not log the returned data: the member list is personal data
  console.log(`[backendService] ${endpoint} → HTTP ${res.status}`);
  return data as T;
}

// ─── API Methods ────────────────────────────────────────────────────────────

/**
 * Scans group members through the backend: SENDS THE ZALO COOKIE + IMEI to deplaoapp.com (see the top of the file).
 * Only runs when the user has agreed (`hasHiddenScanConsent()`); the caller must ask first with `ensureHiddenScanConsent()`.
 * Does not check the plan or the expiry date (the server is free for every account).
 */
export async function scanGroupViaBackend(params: {
  pageId: string;
  cookie: string;
  imei: string;
  groupId: string;
}): Promise<ScanGroupResult> {
  // Last line of defence: without consent the cookie is not sent, even if the caller forgot to ask
  if (!hasHiddenScanConsent()) {
    return {
      success: false, code: 'CONSENT_REQUIRED', groupId: params.groupId, totalMembers: 0, members: [],
      error: tr('Chưa đồng ý quét qua máy chủ Deplao (CRM → Nhóm → Quét thành viên)'),
    };
  }
  if (!params.cookie || !params.imei) {
    return {
      success: false, code: 'NO_SESSION', groupId: params.groupId, totalMembers: 0, members: [],
      error: tr('Máy này không có phiên đăng nhập Zalo của tài khoản (máy nhân viên không quét được nhóm ẩn)'),
    };
  }
  console.log(`[backendService] scan group ${params.groupId} (người dùng đã đồng ý gửi phiên đăng nhập)`);
  try {
    const res = await callBackend<ScanGroupResult>('/api/scan/group', {
      page_id: params.pageId,
      cookie: params.cookie,
      imei: params.imei,
      groupId: params.groupId,
    });
    return res;
  } catch (err: any) {
    console.error('[backendService] scanGroupViaBackend error:', err?.message || err);
    return { success: false, groupId: params.groupId, totalMembers: 0, members: [], error: err.message || tr('Lỗi kết nối backend') };
  }
}

// ─── Shared Groups Types ────────────────────────────────────────────────────

export interface SharedGroupCategory {
  id: number;
  name: string;
  icon: string;
  count?: number;
}

export const DEFAULT_CATEGORIES: SharedGroupCategory[] = [
  { id: 1, name: 'Kinh doanh', icon: '💼' },
  { id: 2, name: tr('Bất động sản'), icon: '🏠' },
  { id: 3, name: tr('Giáo dục'), icon: '📚' },
  { id: 4, name: tr('Công nghệ'), icon: '💻' },
  { id: 5, name: tr('Sức khỏe'), icon: '🏥' },
  { id: 6, name: tr('Du lịch'), icon: '✈️' },
  { id: 7, name: tr('Ẩm thực'), icon: '🍜' },
  { id: 8, name: tr('Thời trang'), icon: '👗' },
  { id: 9, name: tr('Mỹ phẩm'), icon: '💄' },
  { id: 10, name: tr('Thực phẩm chức năng'), icon: '💊' },
  { id: 11, name: tr('Mẹ và bé'), icon: '👶' },
  { id: 12, name: tr('Nội thất'), icon: '🛋️' },
  { id: 13, name: tr('Ô tô - Xe máy'), icon: '🚗' },
  { id: 14, name: tr('Điện tử'), icon: '📱' },
  { id: 15, name: tr('Thể thao'), icon: '⚽' },
  { id: 16, name: tr('Thú cưng'), icon: '🐾' },
  { id: 17, name: tr('Nhà hàng - Khách sạn'), icon: '🏨' },
  { id: 99, name: tr('Khác'), icon: '📁' },
];

export interface SharedGroupItem {
  shareId: string;
  groupId: string;
  groupName: string;
  groupAvatar: string;
  groupLink: string;           // Zalo group link (https://zalo.me/g/...)
  memberCount: number;
  category: SharedGroupCategory;
  note?: string;               // Note when sharing
  submittedBy: string;         // Display name
  submittedByUid?: string;     // UID Zalo
  submittedByAvatar?: string;  // Avatar
  approvedAt?: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface SharedGroupsListResponse {
  success: boolean;
  items: SharedGroupItem[];
  pagination: { page: number; limit: number; total: number };
  categories: SharedGroupCategory[];
}

// ─── Shared Groups API ──────────────────────────────────────────────────────

/**
 * Shares a group to the system (waits for admin approval).
 */
export async function submitSharedGroup(params: {
  pageId: string;
  groupId: string;
  groupName: string;
  groupAvatar: string;
  groupLink: string;
  memberCount: number;
  categoryId: number;
  note?: string;
}): Promise<{ success: boolean; shareId: string; status: string; message: string }> {
  const url = `${BACKEND_URL}/api/shared-groups/submit`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SECRET_KEY,
    },
    body: JSON.stringify({
      page_id: params.pageId,
      group_id: params.groupId,
      group_name: params.groupName,
      group_avatar: params.groupAvatar,
      group_link: params.groupLink,
      member_count: params.memberCount,
      category_id: params.categoryId,
      note: params.note || '',
    }),
  });
  const data = await res.json();
  return {
    success: data.success,
    shareId: data.share_id,
    status: data.status,
    message: data.message,
  };
}

/**
 * Gets the shared group list (already approved by an admin).
 */
export async function getSharedGroups(params: {
  pageId: string;
  categoryId?: number;
  page?: number;
  limit?: number;
}): Promise<SharedGroupsListResponse> {
  const query = new URLSearchParams({
    page_id: params.pageId,
    ...(params.categoryId ? { category_id: String(params.categoryId) } : {}),
    ...(params.page ? { page: String(params.page) } : {}),
    ...(params.limit ? { limit: String(params.limit) } : {}),
  }).toString();
  const res = await fetch(`${BACKEND_URL}/api/shared-groups/list?${query}`, {
    headers: { 'x-api-key': SECRET_KEY },
  });
  const data = await res.json();

  // Map BE response (snake_case) → FE (camelCase)
  return {
    success: data.success,
    items: (data.items || []).map((item: any) => ({
      shareId: item.share_id,
      groupId: item.group_id,
      groupName: item.group_name,
      groupAvatar: item.group_avatar,
      groupLink: item.group_link || `https://zalo.me/g/${item.group_id}`,
      memberCount: item.member_count,
      category: item.category,
      note: item.note,
      submittedBy: item.submitted_by,
      submittedByUid: item.submitted_by_uid,
      submittedByAvatar: item.submitted_by_avatar,
      approvedAt: item.approved_at,
      status: item.status,
    })),
    pagination: data.pagination,
    categories: data.categories,
  } as SharedGroupsListResponse;
}
