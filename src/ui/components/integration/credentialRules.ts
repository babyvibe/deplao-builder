/**
 * credentialRules.ts - checks the "Thông tin xác thực" (Credentials) section when a new integration is connected (IntegrationDetailPage).
 *
 *  - A field not marked `optional` is required.
 *  - A platform with several login methods declares `credentialAlternatives` (Haravan: Access Token OR API Key + Password
 *    of a private app): the fields in those are marked optional, and at least one group must be fully filled in.
 *  - Updating a saved connection: an empty field keeps the old value → no field is required.
 */

import { tr } from '../../../shared/i18n';

export interface CredentialFieldRule { key: string; label: string; optional?: boolean }
export interface CredentialAlternative { label: string; keys: string[] }

/** Message for the missing field, or null when complete. */
export function missingCredentialMessage(
  fields: readonly CredentialFieldRule[],
  alternatives: readonly CredentialAlternative[] | undefined,
  credentials: Record<string, string | undefined>,
  isUpdate: boolean,
): string | null {
  if (isUpdate) return null;
  const filled = (key: string) => !!String(credentials[key] ?? '').trim();
  for (const field of fields) {
    if (!field.optional && !filled(field.key)) return tr('Vui lòng nhập {{label}}', { label: field.label });
  }
  if (alternatives?.length && !alternatives.some(group => group.keys.every(filled))) {
    return tr('Vui lòng nhập {{v1}}', { v1: alternatives.map(group => group.label).join(tr(' hoặc ')) });
  }
  return null;
}
