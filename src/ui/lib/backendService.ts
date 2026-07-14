/**
 * Backend Service — Giao tiếp với Backend Server (Premium features)
 *
 * Backend xử lý: quét nhóm ẩn, kiểm tra premium.
 * App chỉ gọi API, không chứa logic business.
 *
 * API endpoints:
 *   POST https://deplaoapp.com/api/scan/premium-status  → kiểm tra premium
 *   POST https://deplaoapp.com/api/scan/group            → quét thành viên nhóm
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
    headers: { 'Content-Type': 'application/json' },
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
