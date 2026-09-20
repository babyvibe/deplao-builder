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
