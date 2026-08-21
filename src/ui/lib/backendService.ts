/**
 * Backend Service — Giao tiếp với Backend Server (Premium features)
 *
 * Backend xử lý: quét nhóm ẩn, kiểm tra premium, thanh toán QR, chia sẻ nhóm.
 * App chỉ gọi API, không chứa logic business.
 *
 * API endpoints:
 *   POST https://deplaoapp.com/api/scan/premium-status  → kiểm tra premium
 *   POST https://deplaoapp.com/api/scan/group            → quét thành viên nhóm
 *   POST https://deplaoapp.com/api/payment/create-qr     → tạo QR thanh toán
 *   POST https://deplaoapp.com/api/payment/check-status  → kiểm tra trạng thái TT
 *   POST https://deplaoapp.com/api/shared-groups/submit   → chia sẻ nhóm
 *   GET  https://deplaoapp.com/api/shared-groups/list     → danh sách nhóm chung
 */

const BACKEND_URL = 'https://deplaoapp.com';
const SECRET_KEY = 'fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb';

interface PremiumStatus {
  isPremium: boolean;
  expiresAt: string | null; // ISO date string
}

interface ScanGroupResult {
  success: boolean;
  groupId: string;
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
 * Mã hóa body bằng AES-128-CBC trước khi gửi lên backend.
 * Dùng crypto module của Node.js (có sẵn trong Electron main/preload).
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
  console.log(`[backendService] calling ${url}`, body);

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

  console.log(`[backendService] sending payload to ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SECRET_KEY,
    },
    body: JSON.stringify(payload),
  });

  console.log(`[backendService] response status: ${res.status}`);
  const data = await res.json();
  console.log(`[backendService] response data:`, data);
  return data as T;
}

// ─── API Methods ────────────────────────────────────────────────────────────

/**
 * Lấy trạng thái Premium của page.
 * FE gọi lúc mở tab "Quét thành viên" (lần đầu) hoặc ấn "Cập nhật"
 */
export async function getPremiumStatus(pageId: string): Promise<PremiumStatus> {
  try {
    const res = await callBackend<any>('/api/scan/premium-status', { page_id: pageId });
    return {
      isPremium: res?.is_premium ?? false,
      expiresAt: res?.premium_expires_at ?? null,
    };
  } catch (err) {
    console.error('[backendService] getPremiumStatus error:', err);
    return { isPremium: false, expiresAt: null };
  }
}

// ─── Affiliate API ─────────────────────────────────────────────────────────

export interface ValidateAffCodeResult {
  valid: boolean;
  name?: string;
  error?: string;
}

/**
 * Validate mã affiliate.
 * GET /api/affiliate/validate/:code
 */
export async function validateAffCode(code: string): Promise<ValidateAffCodeResult> {
  if (!code?.trim()) return { valid: false, error: 'Vui lòng nhập mã' };
  try {
    const url = `${BACKEND_URL}/api/affiliate/validate/${encodeURIComponent(code.trim())}`;
    const res = await fetch(url, {
      headers: { 'x-api-key': SECRET_KEY },
    });
    const data = await res.json();
    return {
      valid: data.valid ?? false,
      name: data.name,
      error: data.error,
    };
  } catch (err: any) {
    console.error('[backendService] validateAffCode error:', err);
    return { valid: false, error: 'Lỗi kết nối' };
  }
}

/**
 * Quét thành viên nhóm qua backend.
 * FE gọi khi user ấn "Quét" (sau khi đã check premium từ localStorage).
 */
export async function scanGroupViaBackend(params: {
  pageId: string;
  cookie: string;
  imei: string;
  groupId: string;
}): Promise<ScanGroupResult> {
  try {
    const res = await callBackend<ScanGroupResult>('/api/scan/group', {
      page_id: params.pageId,
      cookie: params.cookie,
      imei: params.imei,
      groupId: params.groupId,
    });
    return res;
  } catch (err: any) {
    console.error('[backendService] scanGroupViaBackend error:', err);
    return { success: false, groupId: params.groupId, totalMembers: 0, members: [], error: err.message || 'Lỗi kết nối backend' };
  }
}

// ─── Payment Types ──────────────────────────────────────────────────────────

export type PlanCode = '6months' | '1year';

export interface PlanInfo {
  code: PlanCode;
  name: string;
  durationDays: number;
  price: number;
}

export const PLANS: PlanInfo[] = [
  { code: '6months', name: '6 tháng', durationDays: 180, price: 360000 },
  { code: '1year', name: '1 năm', durationDays: 365, price: 499000 },
];

export interface CreateQrResponse {
  success: boolean;
  paymentId: string;
  amount: number;
  originalAmount?: number;
  discount?: number;
  qrCodeUrl: string;
  qrCodeBase64?: string;
  bankInfo: { bankName: string; accountNumber: string; accountName: string };
  transferContent: string;
  expiresAt: string;
  breakdown: Array<{ pageId: string; plan: PlanCode; amount: number; originalPrice?: number; discount?: number }>;
  error?: string;
}

export interface CheckPaymentResponse {
  success: boolean;
  status: 'pending' | 'completed' | 'expired' | 'failed';
  message: string;
  updatedAccounts?: Array<{ pageId: string; premiumExpiresAt: string }>;
}

// ─── Payment API ────────────────────────────────────────────────────────────

/**
 * Tạo QR code thanh toán.
 * BE tính số tiền từ plans table — FE KHÔNG gửi amount.
 */
export async function createPaymentQr(params: {
  pageIds: string[];
  plan: PlanCode;
  pageId: string;
  affCode?: string;
}): Promise<CreateQrResponse> {
  const pageIdsArray = Array.isArray(params.pageIds) ? params.pageIds : [params.pageIds];
  const body: Record<string, any> = {
    page_ids: pageIdsArray,
    plan: params.plan,
    page_id: params.pageId,
  };
  if (params.affCode) body.aff_code = params.affCode;
  console.log('[createPaymentQr] body:', JSON.stringify(body, null, 2));

  // Gửi raw JSON (không encrypt) — BE payment endpoint không cần encrypt
  const url = `${BACKEND_URL}/api/payment/create-qr`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SECRET_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[createPaymentQr] response:', data);

  // Map BE response (snake_case) → FE (camelCase)
  return {
    success: data.success,
    paymentId: data.payment_id,
    amount: data.amount,
    originalAmount: data.original_amount,
    discount: data.discount,
    qrCodeUrl: data.qr_code_url,
    qrCodeBase64: data.qr_code_base64,
    bankInfo: data.bank_info ? {
      bankName: data.bank_info.bank_name,
      accountNumber: data.bank_info.account_number,
      accountName: data.bank_info.account_name,
    } : undefined,
    transferContent: data.transfer_content,
    expiresAt: data.expires_at,
    breakdown: (data.breakdown || []).map((b: any) => ({
      pageId: b.page_id,
      plan: b.plan,
      amount: b.amount,
      originalPrice: b.original_price,
      discount: b.discount,
    })),
    error: data.error,
  } as CreateQrResponse;
}

/**
 * Kiểm tra trạng thái thanh toán.
 * FE poll mỗi 15s trong 2 phút.
 * KHÔNG tự confirm — chỉ SePay webhook mới trigger confirm trên BE.
 */
export async function checkPaymentStatus(paymentId: string, pageId: string): Promise<CheckPaymentResponse> {
  const url = `${BACKEND_URL}/api/payment/check-status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SECRET_KEY,
    },
    body: JSON.stringify({ payment_id: paymentId, page_id: pageId }),
  });
  const data = await res.json();

  // Map BE response (snake_case) → FE (camelCase)
  return {
    success: data.success,
    status: data.status,
    message: data.message,
    updatedAccounts: (data.updated_accounts || []).map((a: any) => ({
      pageId: a.page_id,
      premiumExpiresAt: a.premium_expires_at,
    })),
  } as CheckPaymentResponse;
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
