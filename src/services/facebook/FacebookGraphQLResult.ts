/**
 * FacebookGraphQLResult.ts
 * Phase 7: Validate Facebook GraphQL/mutation responses.
 *
 * Facebook often returns HTTP 200 with error payloads:
 * - { error: {...} }
 * - { errors: [{message: "..."}] }
 * - { data: null } (mutation failed)
 * - Empty or malformed payload
 *
 * This helper detects all these cases and throws typed errors.
 */

import Logger from '../../utils/Logger';
import { metricInc } from './FacebookMetrics';

export class FacebookOperationError extends Error {
  public operation: string;
  public code: string;

  constructor(operation: string, code: string, message: string) {
    super(message);
    this.name = 'FacebookOperationError';
    this.operation = operation;
    this.code = code;
  }
}

/**
 * Strip Facebook's anti-JSON prefix (for(;;);)
 */
function stripAntiJSONPrefix(text: string): string {
  return text.replace(/^for\s*\(;;\);/, '').trim();
}

/**
 * Parse a Facebook response body (handles anti-JSON prefix).
 */
export function parseFacebookResponse(body: string): any {
  const cleaned = stripAntiJSONPrefix(body);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Assert that a Facebook mutation was successful.
 * Throws FacebookOperationError if the response indicates failure.
 *
 * @param operation  Name of the operation (for error messages)
 * @param payload    Parsed response payload
 * @param expected   Optional validator: return true if payload looks like success
 */
export function assertFacebookMutationSuccess(
  operation: string,
  payload: any,
  expected?: (payload: any) => boolean,
): void {
  if (payload === null || payload === undefined) {
    throw new FacebookOperationError(operation, 'empty_response', `${operation}: empty response`);
  }

  // Check for error/error subfield
  if (payload.error) {
    const errMsg = payload.error.message || payload.error.description || JSON.stringify(payload.error).slice(0, 200);
    metricInc('fb_graphql_semantic_failure', undefined, { operation, code: 'api_error' });
    Logger.warn(`[FBGraphQL] ${operation} error: ${errMsg}`);
    throw new FacebookOperationError(operation, 'api_error', `${operation}: ${errMsg}`);
  }

  // Check for errors array (GraphQL standard)
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const errMsg = payload.errors[0].message || JSON.stringify(payload.errors[0]).slice(0, 200);
    metricInc('fb_graphql_semantic_failure', undefined, { operation, code: 'graphql_errors' });
    Logger.warn(`[FBGraphQL] ${operation} errors: ${errMsg}`);
    throw new FacebookOperationError(operation, 'graphql_errors', `${operation}: ${errMsg}`);
  }

  // Check for data: null (mutation failed silently)
  if (payload.data === null && !expected) {
    metricInc('fb_graphql_semantic_failure', undefined, { operation, code: 'null_data' });
    throw new FacebookOperationError(operation, 'null_data', `${operation}: data is null`);
  }

  // Run custom validator if provided
  if (expected && !expected(payload)) {
    throw new FacebookOperationError(operation, 'validation_failed', `${operation}: response validation failed`);
  }
}

// ─── Mutation node confirmation (fbchat-v2 2.3.2) ────────────────────────────

const FAILURE_STRINGS = new Set(['', '0', 'error', 'failed', 'failure', 'false']);
const NON_CONFIRMING_FIELDS = new Set(['__typename', 'client_mutation_id', 'error', 'error_message']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Port of fbchat-v2 `_is_nonempty`. */
function isNonEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return value !== 0;
}

/** Port of fbchat-v2 `_is_success_value`. */
function isSuccessValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return !FAILURE_STRINGS.has(value.trim().toLowerCase());
  return value !== 0;
}

/**
 * Port of fbchat-v2 2.3.2 `_is_confirmed_node`: a mutation root confirms the
 * operation only if it is a non-empty object whose `success`/`status` fields
 * (when present) are truthy, whose `error`/`error_message` fields are empty,
 * and which carries some other non-empty field. HTTP 200 with
 * `{ data: { root: { client_mutation_id: "1" } } }` is not a confirmation.
 */
export function isConfirmedMutationNode(value: unknown): boolean {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
  for (const field of ['success', 'status']) {
    if (field in value && !isSuccessValue(value[field])) return false;
  }
  for (const field of ['error', 'error_message']) {
    if (field in value && isNonEmptyValue(value[field])) return false;
  }
  return Object.entries(value).some(([field, fieldValue]) => !NON_CONFIRMING_FIELDS.has(field) && isNonEmptyValue(fieldValue));
}

/**
 * Port of fbchat-v2 2.3.2 `_is_nonempty_mutation_node` (Notes): like
 * isConfirmedMutationNode, but nested `success`/`status` objects must confirm
 * recursively.
 */
export function isNonEmptyMutationNode(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return false;
    for (const field of ['success', 'status']) {
      if (field in value && !isNonEmptyMutationNode(value[field])) return false;
    }
    for (const field of ['error', 'error_message']) {
      if (field in value && isNonEmptyMutationNode(value[field])) return false;
    }
    return Object.entries(value).some(([field, fieldValue]) => !NON_CONFIRMING_FIELDS.has(field) && isNonEmptyMutationNode(fieldValue));
  }
  if (typeof value === 'string') return !FAILURE_STRINGS.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  return value !== 0;
}

/**
 * True when some `data` root whose name matches `rootMatches` (persisted-doc
 * revisions rename roots, so the mutation family is matched) is a confirmed
 * mutation node.
 */
export function hasConfirmedMutationRoot(payload: any, rootMatches: (rootName: string) => boolean): boolean {
  const data = payload?.data;
  if (!isPlainObject(data)) return false;
  return Object.entries(data).some(([rootName, node]) => rootMatches(rootName) && isConfirmedMutationNode(node));
}
