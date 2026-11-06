/**
 * Backend Service: app gọi máy chủ deplaoapp.com cho CRM nhóm Zalo (quét thành viên nhóm ẩn, kho nhóm chung).
 *
 * API:
 *   POST https://deplaoapp.com/api/scan/group            → quét thành viên nhóm (GỬI COOKIE ZALO, xem dưới)
 *   POST https://deplaoapp.com/api/shared-groups/submit   → chia sẻ nhóm vào kho chung (công khai cho người dùng khác)
 *   GET  https://deplaoapp.com/api/shared-groups/list     → danh sách kho nhóm chung
 *
 * ─── Quét nhóm ẩn: dữ liệu rời khỏi máy (đọc kỹ trước khi sửa / khi rà soát bảo mật) ────────────────────────────────
 * - GỬI GÌ: phiên đăng nhập Zalo (cookie + IMEI) của tài khoản đang quét + groupId + page_id (= zalo_id). Cookie cho
 *   phép dùng tài khoản Zalo, nên đây là dữ liệu nhạy cảm nhất app từng gửi ra ngoài.
 * - VÌ SAO QUA MÁY CHỦ: cách quét nhóm ẩn thành viên chạy ở máy chủ để giữ kín (app là mã nguồn mở). Máy chủ dùng
 *   cookie gọi Zalo (getLoginInfo → danh sách ID → thông tin thành viên) rồi trả danh sách về; không lưu cookie, không
 *   ghi cookie vào log. Nhật ký máy chủ: endpoint, IP, user agent, page_id, group_id, thời gian, mã kết quả
 *   (repo dep-lao-backend-payment: controllers/scan.controller.ts, services/scan.service.ts, middleware/publicApiLogger.ts).
 * - CHỈ GỬI KHI NGƯỜI DÙNG ĐỒNG Ý (từ 26.11.0, mặc định TẮT): mọi chỗ gọi `scanGroupViaBackend` phải hỏi trước bằng
 *   `ensureHiddenScanConsent()` (components/crm/groups/HiddenScanConsentDialog.tsx); hộp thoại nói rõ gửi gì, vì sao,
 *   rủi ro và quyền không đồng ý. Đồng ý được nhớ theo máy (lib/crm/hiddenScanConsent.ts), tắt ở CRM → Nhóm → Quét
 *   thành viên. `scanGroupViaBackend` tự kiểm tra lại: chưa đồng ý → trả lỗi CONSENT_REQUIRED, KHÔNG gọi mạng.
 * - Chỗ gọi hiện có: CRM → Nhóm → Quét thành viên (handleScanTab), CRM → Thành viên nhóm "Tải thông tin thành viên" và
 *   panel thành viên nhóm trong hội thoại (hooks/chat/useGroupMemberSync.ts), nhập nhóm hàng loạt
 *   (BulkImportGroupsModal, đếm thành viên). Thêm chỗ gọi mới thì phải đi qua ensureHiddenScanConsent.
 * - MÃ HOÁ: body được "mã hoá" AES-128-CBC bằng SECRET_KEY bên dưới, nhưng khoá này nằm trong mã nguồn công khai và
 *   cũng được gửi làm x-api-key → chỉ là làm rối, KHÔNG phải lớp bảo mật; renderer không có module crypto của Node thì
 *   encryptBody rơi về base64 thuần. Bảo vệ thật trên đường truyền là HTTPS.
 * - KHÔNG log cookie / body / danh sách thành viên ở client (console chỉ ghi endpoint, groupId, số lượng).
 */

import { hasHiddenScanConsent } from './hiddenScanConsent';

const BACKEND_URL = 'https://deplaoapp.com';
const SECRET_KEY = 'fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb';

interface ScanGroupResult {
  success: boolean;
  groupId: string;
  /** CONSENT_REQUIRED: người dùng chưa đồng ý gửi phiên đăng nhập Zalo lên máy chủ → không gửi gì. */
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

/**
 * "Mã hoá" body bằng AES-128-CBC trước khi gửi lên backend (khoá công khai, xem đầu file: chỉ làm rối, HTTPS mới là
 * lớp bảo vệ). Dùng crypto module của Node.js (có sẵn trong Electron main/preload).
 */
async function encryptBody(body: object): Promise<string> {
  try {
    // Trong Electron renderer, crypto có thể không khả dụng qua dynamic import
    // Fallback: gửi plain text (backend sẽ xử lý cả 2 format khi dev)
    const crypto = window.require ? window.require('crypto') : await import('crypto');
    // SECRET_KEY là hex string → chuyển sang Buffer (16 bytes cho AES-128)
    const key = Buffer.from(SECRET_KEY, 'hex').slice(0, 16);
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(body), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  } catch (err) {
    console.warn('[backendService] encryptBody failed, sending plain text:', err);
    // Fallback: gửi plain text base64
    return btoa(JSON.stringify(body));
  }
}

/**
 * Gọi API backend.
 */
async function callBackend<T>(endpoint: string, body: object): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  // Không log body: có cookie Zalo
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
  // Không log dữ liệu trả về: danh sách thành viên là dữ liệu cá nhân
  console.log(`[backendService] ${endpoint} → HTTP ${res.status}`);
  return data as T;
}

// ─── API Methods ────────────────────────────────────────────────────────────

/**
 * Quét thành viên nhóm qua backend: GỬI COOKIE + IMEI ZALO lên deplaoapp.com (xem đầu file).
 * Chỉ chạy khi người dùng đã đồng ý (`hasHiddenScanConsent()`); chỗ gọi phải hỏi trước bằng `ensureHiddenScanConsent()`.
 * Không kiểm tra gói hoặc ngày hết hạn (máy chủ mở miễn phí cho mọi tài khoản).
 */
export async function scanGroupViaBackend(params: {
  pageId: string;
  cookie: string;
  imei: string;
  groupId: string;
}): Promise<ScanGroupResult> {
  // Lớp chặn cuối: chưa đồng ý thì không gửi cookie, kể cả khi chỗ gọi quên hỏi
  if (!hasHiddenScanConsent()) {
    return {
      success: false, code: 'CONSENT_REQUIRED', groupId: params.groupId, totalMembers: 0, members: [],
      error: 'Chưa đồng ý quét qua máy chủ Deplao (CRM → Nhóm → Quét thành viên)',
    };
  }
  if (!params.cookie || !params.imei) {
    return {
      success: false, code: 'NO_SESSION', groupId: params.groupId, totalMembers: 0, members: [],
      error: 'Máy này không có phiên đăng nhập Zalo của tài khoản (máy nhân viên không quét được nhóm ẩn)',
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
    return { success: false, groupId: params.groupId, totalMembers: 0, members: [], error: err.message || 'Lỗi kết nối backend' };
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
  { id: 2, name: 'Bất động sản', icon: '🏠' },
  { id: 3, name: 'Giáo dục', icon: '📚' },
  { id: 4, name: 'Công nghệ', icon: '💻' },
  { id: 5, name: 'Sức khỏe', icon: '🏥' },
  { id: 6, name: 'Du lịch', icon: '✈️' },
  { id: 7, name: 'Ẩm thực', icon: '🍜' },
  { id: 8, name: 'Thời trang', icon: '👗' },
  { id: 9, name: 'Mỹ phẩm', icon: '💄' },
  { id: 10, name: 'Thực phẩm chức năng', icon: '💊' },
  { id: 11, name: 'Mẹ và bé', icon: '👶' },
  { id: 12, name: 'Nội thất', icon: '🛋️' },
  { id: 13, name: 'Ô tô - Xe máy', icon: '🚗' },
  { id: 14, name: 'Điện tử', icon: '📱' },
  { id: 15, name: 'Thể thao', icon: '⚽' },
  { id: 16, name: 'Thú cưng', icon: '🐾' },
  { id: 17, name: 'Nhà hàng - Khách sạn', icon: '🏨' },
  { id: 99, name: 'Khác', icon: '📁' },
];

export interface SharedGroupItem {
  shareId: string;
  groupId: string;
  groupName: string;
  groupAvatar: string;
  groupLink: string;           // Link nhóm Zalo (https://zalo.me/g/...)
  memberCount: number;
  category: SharedGroupCategory;
  note?: string;               // Ghi chú khi chia sẻ
  submittedBy: string;         // Tên hiển thị
  submittedByUid?: string;     // UID Zalo
  submittedByAvatar?: string;  // Ảnh đại diện
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
 * Chia sẻ nhóm lên hệ thống (chờ admin duyệt).
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
 * Lấy danh sách nhóm chung (đã được admin duyệt).
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
