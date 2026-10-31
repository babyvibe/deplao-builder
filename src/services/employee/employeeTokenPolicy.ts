/**
 * employeeTokenPolicy.ts — quy tắc thuần cho token đăng nhập của nhân viên (JWT do Boss ký).
 * Không đụng DB / Electron: EmployeeService đọc trạng thái nhân viên từ DB rồi hỏi các hàm ở đây.
 * Test: src/__tests__/employee/employeeTokenPolicy.test.ts.
 *
 * Token hợp lệ khi (sau khi kiểm chữ ký HS256 + hạn 7 ngày):
 *   1. có employee_id; nhân viên còn tồn tại và đang bật (is_active);
 *   2. phát hành SAU mốc "hợp lệ từ" (validAfterMs) của nhân viên. Mốc dời lên mỗi lần kick / khoá / xoá / đổi mật khẩu
 *      → token cũ hết hiệu lực ngay, không phải chờ hết hạn. Phát hành cùng ms với mốc = đã thu hồi.
 * Thời điểm phát hành = claim `ts` (ms, token từ bản này) → `iat`×1000 (token cũ, chỉ chính xác tới giây).
 *
 * Khoá ký (`employee_jwt_secret`) từng lộ cho nhân viên qua API cài đặt (đã đóng) → đổi một lần cho mỗi DB, đánh dấu
 * bằng `employee_jwt_secret_version` (planJwtSecretInit).
 */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

export const JWT_SECRET_SETTING_KEY = 'employee_jwt_secret';
/** Phiên bản khoá ký: < 2 (hoặc chưa có) = khoá có thể đã lộ → đổi khoá một lần. */
export const JWT_SECRET_VERSION_SETTING_KEY = 'employee_jwt_secret_version';
export const JWT_SECRET_VERSION = 2;

export const EMPLOYEE_JWT_ALGORITHM = 'HS256' as const;
export const EMPLOYEE_JWT_EXPIRES_IN = '7d' as const;

/** app_settings: mốc "token hợp lệ từ" (ms) của từng nhân viên — không cần thêm cột vào bảng employees. */
const TOKEN_VALID_AFTER_KEY_PREFIX = 'employee_tokens_valid_after_';
/** app_settings: `ts` lớn nhất đã cấp cho nhân viên — để lần thu hồi sau phủ được cả token cấp lúc đồng hồ chạy nhanh. */
const TOKEN_LAST_ISSUED_KEY_PREFIX = 'employee_tokens_last_issued_';

export function tokenValidAfterKey(employeeId: string): string {
  return `${TOKEN_VALID_AFTER_KEY_PREFIX}${employeeId}`;
}

export function tokenLastIssuedKey(employeeId: string): string {
  return `${TOKEN_LAST_ISSUED_KEY_PREFIX}${employeeId}`;
}

/**
 * expired     — quá hạn 7 ngày
 * revoked     — phát hành trước mốc thu hồi (kick / đổi mật khẩu / bị khoá rồi mở lại…)
 * inactive    — nhân viên bị khoá hoặc đã xoá
 * invalid     — sai chữ ký (vd sau khi đổi khoá ký), sai thuật toán, thiếu claim
 * unavailable — không đọc được trạng thái nhân viên (lỗi DB phía Boss) — không phải lỗi của token
 */
export type EmployeeTokenRejectReason = 'expired' | 'revoked' | 'inactive' | 'invalid' | 'unavailable';

/** Kết quả EmployeeService.validateToken (giữ dạng cũ, thêm `reason` khi không hợp lệ). */
export interface EmployeeTokenValidation {
  valid: boolean;
  employee_id?: string;
  username?: string;
  role?: string;
  reason?: EmployeeTokenRejectReason;
}

/** Trạng thái của nhân viên dùng để xét token (EmployeeService đọc từ DB, cache vài giây). */
export interface EmployeeTokenState {
  exists: boolean;
  active: boolean;
  /** ms — token phát hành tại / trước mốc này đã bị thu hồi. 0 = chưa thu hồi lần nào. */
  validAfterMs: number;
}

export type EmployeeTokenDecision =
  | { valid: true; employeeId: string }
  | { valid: false; reason: EmployeeTokenRejectReason };

export interface EmployeeTokenClaims {
  employee_id: string;
  username: string;
  role: string;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Mốc ms lưu trong app_settings → số (rỗng / hỏng → 0 = chưa có). */
export function parseValidAfter(raw: string | null | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Thời điểm phát hành (ms): claim `ts` → `iat`×1000 (token cũ) → null. */
export function tokenIssuedAtMs(claims: unknown): number | null {
  if (!claims || typeof claims !== 'object') return null;
  const record = claims as Record<string, unknown>;
  const ts = positiveNumber(record.ts);
  if (ts !== null) return ts;
  const iat = positiveNumber(record.iat);
  return iat !== null ? iat * 1000 : null;
}

/**
 * Xét claims ĐÃ kiểm chữ ký + hạn. `state` = null khi không đọc được DB → 'unavailable'
 * (Socket.IO báo lỗi phía Boss để client thử lại, không bắt đăng nhập lại).
 */
export function evaluateEmployeeToken(claims: unknown, state: EmployeeTokenState | null): EmployeeTokenDecision {
  const employeeId = claims && typeof claims === 'object' ? (claims as Record<string, unknown>).employee_id : undefined;
  if (typeof employeeId !== 'string' || !employeeId) return { valid: false, reason: 'invalid' };
  const issuedAt = tokenIssuedAtMs(claims);
  if (issuedAt === null) return { valid: false, reason: 'invalid' };
  if (!state) return { valid: false, reason: 'unavailable' };
  if (!state.exists || !state.active) return { valid: false, reason: 'inactive' };
  if (issuedAt <= state.validAfterMs) return { valid: false, reason: 'revoked' };
  return { valid: true, employeeId };
}

/**
 * Mốc mới khi thu hồi: bây giờ, nhưng không bao giờ lùi, luôn vượt mốc cũ và không thấp hơn `ts` lớn nhất đã cấp —
 * token cấp lúc đồng hồ Boss chạy nhanh (rồi bị chỉnh lùi) hoặc cấp với `ts = mốc cũ + 1` vẫn bị thu hồi.
 */
export function nextRevocationMark(currentMark: number, now: number, lastIssuedMs = 0): number {
  return Math.max(now, (currentMark > 0 ? currentMark : 0) + 1, lastIssuedMs > 0 ? lastIssuedMs : 0);
}

/** Claim `ts` cho token mới: bây giờ, nhưng luôn SAU mốc thu hồi hiện tại (đăng nhập lại ngay sau kick vẫn hợp lệ). */
export function tokenIssueTimestamp(currentMark: number, now: number): number {
  return Math.max(now, (currentMark > 0 ? currentMark : 0) + 1);
}

/** Ký token nhân viên (HS256, hạn 7 ngày) kèm `ts` = thời điểm phát hành (ms). */
export function signEmployeeToken(secret: string, claims: EmployeeTokenClaims, issuedAtMs: number): string {
  return jwt.sign(
    { employee_id: claims.employee_id, username: claims.username, role: claims.role, ts: issuedAtMs },
    secret,
    { algorithm: EMPLOYEE_JWT_ALGORITHM, expiresIn: EMPLOYEE_JWT_EXPIRES_IN },
  );
}

/** Kiểm chữ ký + hạn — CHỈ nhận HS256 (không để token tự chọn thuật toán). */
export function verifyEmployeeJwt(
  token: string,
  secret: string,
): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: 'expired' | 'invalid' } {
  if (!token || !secret) return { ok: false, reason: 'invalid' };
  try {
    const decoded = jwt.verify(token, secret, { algorithms: [EMPLOYEE_JWT_ALGORITHM] });
    if (!decoded || typeof decoded !== 'object') return { ok: false, reason: 'invalid' };
    return { ok: true, claims: decoded as Record<string, unknown> };
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
}

/**
 * Khởi tạo khoá ký cho một DB:
 * - create — chưa có khoá (cài mới / DB mới) → tạo khoá + ghi phiên bản;
 * - rotate — có khoá nhưng phiên bản < JWT_SECRET_VERSION (khoá cũ có thể đã lộ) → đổi khoá MỘT lần, mọi nhân viên
 *   đăng nhập lại;
 * - keep   — đã đổi rồi (ghi phiên bản cùng DB với khoá → mỗi DB chỉ đổi một lần dù pin bao nhiêu lần).
 */
export function planJwtSecretInit(
  existingSecret: string | null | undefined,
  versionRaw: string | null | undefined,
): 'create' | 'rotate' | 'keep' {
  if (!existingSecret) return 'create';
  const version = Number(versionRaw);
  return Number.isFinite(version) && version >= JWT_SECRET_VERSION ? 'keep' : 'rotate';
}

/** Khoá ký mới: 48 byte ngẫu nhiên (base64url, 64 ký tự). */
export function generateJwtSecret(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Thông điệp middleware Socket.IO trả client khi từ chối token. Đều khớp isAuthRejectionMessage (employeeConnection.ts,
 * cả client bản cũ) → client dừng, báo "phiên đăng nhập hết hạn"; riêng 'unavailable' = lỗi phía Boss → client thử lại.
 */
export function socketRejectionMessage(reason: EmployeeTokenRejectReason | undefined): string {
  switch (reason) {
    case 'inactive': return 'Employee not found or inactive';
    case 'revoked': return 'Invalid token (revoked)';
    case 'expired': return 'Invalid token (expired)';
    case 'unavailable': return 'Authentication failed';
    default: return 'Invalid token';
  }
}
