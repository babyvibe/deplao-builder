/**
 * employeeTokenPolicy.ts: pure rules for the employee login token (a JWT signed by Boss).
 * Does not touch the DB / Electron: EmployeeService reads the employee state from the DB, then asks the functions here.
 * Test: src/__tests__/employee/employeeTokenPolicy.test.ts.
 *
 * A token is valid when (after checking the HS256 signature + the 7-day expiry):
 *   1. it has an employee_id; the employee still exists and is enabled (is_active);
 *   2. it was issued AFTER the employee's "hợp lệ từ" (valid from) mark (validAfterMs). The mark moves up on every kick / lock / delete / password change
 *      → old tokens stop working at once, no need to wait for expiry. Issued at the same ms as the mark = revoked.
 * Issue time = the `ts` claim (ms, tokens from this version) → `iat`×1000 (old tokens, accurate to the second only).
 *
 * The signing key (`employee_jwt_secret`) was once exposed to employees through the settings API (closed) → changed once per DB, marked
 * by `employee_jwt_secret_version` (planJwtSecretInit).
 */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

export const JWT_SECRET_SETTING_KEY = 'employee_jwt_secret';
/** Key version: < 2 (or not set) = the key may have been exposed → changed once. */
export const JWT_SECRET_VERSION_SETTING_KEY = 'employee_jwt_secret_version';
export const JWT_SECRET_VERSION = 2;

export const EMPLOYEE_JWT_ALGORITHM = 'HS256' as const;
export const EMPLOYEE_JWT_EXPIRES_IN = '7d' as const;

/** app_settings: the "token hợp lệ từ" (token valid from) mark (ms) of each employee: no extra column needed in the employees table. */
const TOKEN_VALID_AFTER_KEY_PREFIX = 'employee_tokens_valid_after_';
/** app_settings: the largest `ts` issued to the employee, so that a later revoke also covers tokens issued while the clock was running fast. */
const TOKEN_LAST_ISSUED_KEY_PREFIX = 'employee_tokens_last_issued_';

export function tokenValidAfterKey(employeeId: string): string {
  return `${TOKEN_VALID_AFTER_KEY_PREFIX}${employeeId}`;
}

export function tokenLastIssuedKey(employeeId: string): string {
  return `${TOKEN_LAST_ISSUED_KEY_PREFIX}${employeeId}`;
}

/**
 * expired     - older than 7 days
 * revoked     - issued before the revoke mark (kick / password change / locked then unlocked…)
 * inactive    - the employee is locked or deleted
 * invalid     - bad signature (e.g. after the signing key changed), wrong algorithm, missing claim
 * unavailable - the employee state could not be read (a DB error on the Boss side), not caused by the token
 */
export type EmployeeTokenRejectReason = 'expired' | 'revoked' | 'inactive' | 'invalid' | 'unavailable';

/** Result of EmployeeService.validateToken (kept in the old shape, plus `reason` when invalid). */
export interface EmployeeTokenValidation {
  valid: boolean;
  employee_id?: string;
  username?: string;
  role?: string;
  reason?: EmployeeTokenRejectReason;
}

/** Employee state used to check a token (EmployeeService reads it from the DB, cached for a few seconds). */
export interface EmployeeTokenState {
  exists: boolean;
  active: boolean;
  /** ms: tokens issued at / before this mark are revoked. 0 = never revoked. */
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

/** The ms mark stored in app_settings → a number (empty / broken → 0 = none). */
export function parseValidAfter(raw: string | null | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Issue time (ms): the `ts` claim → `iat`×1000 (old tokens) → null. */
export function tokenIssuedAtMs(claims: unknown): number | null {
  if (!claims || typeof claims !== 'object') return null;
  const record = claims as Record<string, unknown>;
  const ts = positiveNumber(record.ts);
  if (ts !== null) return ts;
  const iat = positiveNumber(record.iat);
  return iat !== null ? iat * 1000 : null;
}

/**
 * Checks the claims AFTER the signature + expiry have been verified. `state` = null when the DB could not be read → 'unavailable'
 * (Socket.IO reports a Boss-side error so the client retries, instead of forcing a new login).
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
 * New mark on revoke: now, but never moves backwards, always goes past the old mark and is not below the largest `ts` issued:
 * a token issued while the Boss clock ran fast (and was then set back), or issued with `ts = old mark + 1`, is still revoked.
 */
export function nextRevocationMark(currentMark: number, now: number, lastIssuedMs = 0): number {
  return Math.max(now, (currentMark > 0 ? currentMark : 0) + 1, lastIssuedMs > 0 ? lastIssuedMs : 0);
}

/** `ts` claim for a new token: now, but always AFTER the current revoke mark (logging in again right after a kick is still valid). */
export function tokenIssueTimestamp(currentMark: number, now: number): number {
  return Math.max(now, (currentMark > 0 ? currentMark : 0) + 1);
}

/** Sign an employee token (HS256, 7-day expiry) with `ts` = the issue time (ms). */
export function signEmployeeToken(secret: string, claims: EmployeeTokenClaims, issuedAtMs: number): string {
  return jwt.sign(
    { employee_id: claims.employee_id, username: claims.username, role: claims.role, ts: issuedAtMs },
    secret,
    { algorithm: EMPLOYEE_JWT_ALGORITHM, expiresIn: EMPLOYEE_JWT_EXPIRES_IN },
  );
}

/** Check the signature + expiry: accepts ONLY HS256 (a token may not choose its own algorithm). */
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
 * Initialises the signing key for one DB:
 * - create - no key yet (fresh install / new DB) → create the key + write the version;
 * - rotate - a key exists but its version < JWT_SECRET_VERSION (the old key may have been exposed) → change the key ONCE, every employee
 *   logs in again;
 * - keep   - already changed (the version is written to the same DB as the key → each DB changes only once, however many times it is pinned).
 */
export function planJwtSecretInit(
  existingSecret: string | null | undefined,
  versionRaw: string | null | undefined,
): 'create' | 'rotate' | 'keep' {
  if (!existingSecret) return 'create';
  const version = Number(versionRaw);
  return Number.isFinite(version) && version >= JWT_SECRET_VERSION ? 'keep' : 'rotate';
}

/** New signing key: 48 random bytes (base64url, 64 characters). */
export function generateJwtSecret(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Socket.IO middleware messages sent to the client when it rejects a token. All match isAuthRejectionMessage (employeeConnection.ts,
 * including old client builds) → the client stops and shows "phiên đăng nhập hết hạn" (login session expired); 'unavailable' alone is a Boss-side error → the client retries.
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
