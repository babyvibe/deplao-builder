/**
 * Template variables of a CRM campaign ({name}, {userId}, {gender}, {phone}) and how they are resolved for one
 * recipient. Shared by the queue (`services/crm/CRMQueueService`) and the campaign screen preview, so the preview
 * shows the same shape the recipient gets.
 *
 * `{phone}` priority: the number that came with the recipient list (a file / "Theo SĐT" row), then
 * the CRM contact record, then whatever the Zalo profile lookup already returned during this send. The last step
 * never calls the API on its own — the queue only uses a profile it had to load anyway (name resolution).
 */

import { tr } from '../i18n';

export interface CampaignVars {
  /** Display name, or the contact id when no name is known. */
  name: string;
  userId: string;
  gender: string;
  phone: string;
}

/** Every variable the campaign editor offers as a chip (one place so the chips and the help stay in sync). */
export const CAMPAIGN_TEMPLATE_VARS = ['{name}', '{userId}', '{gender}', '{phone}'] as const;

/** Zalo stores 0 = male, 1 = female (contacts.gender); anything else is unknown. */
export function genderText(gender: number | null | undefined): string {
  if (gender === 0) return tr('Nam');
  if (gender === 1) return tr('Nữ');
  return '';
}

/** Zalo user info gender ('male' | 'female' | 0/1) for the gender fallback of a profile already loaded. */
export function genderTextFromProfile(gender: unknown): string {
  if (typeof gender === 'number') return genderText(gender);
  const value = String(gender ?? '').toLowerCase();
  if (value === 'male' || value === 'nam') return tr('Nam');
  if (value === 'female' || value === 'nữ' || value === 'nu') return tr('Nữ');
  return '';
}

export interface CampaignPhoneSources {
  /** Phone that came with the recipient row (imported file, "Theo SĐT" target). Highest priority. */
  filePhone?: string | null;
  /** Phone stored on the CRM contact record. */
  crmPhone?: string | null;
  /** Phone returned by a getUserInfo call the send already made (never calls the API by itself). */
  profilePhone?: string | null;
}

/** Phone for `{phone}`, empty when no source has one. */
export function resolveCampaignPhone(sources: CampaignPhoneSources): string {
  const candidates = [sources.filePhone, sources.crmPhone, sources.profilePhone];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return '';
}

/** Phone of a campaign recipient row: its `phone` column, or the `phone:<number>` placeholder id. */
export function recipientPhone(contactId: string | null | undefined, phone: string | null | undefined): string {
  const stored = String(phone ?? '').trim();
  if (stored) return stored;
  const id = String(contactId ?? '');
  return id.startsWith('phone:') ? id.slice(6).trim() : '';
}

/** Replace `{name}` / `{userId}` / `{gender}` / `{phone}` in one template. */
export function substituteCampaignVars(template: string, vars: CampaignVars): string {
  return (template || '')
    .replace(/\{name\}/g, vars.name || '')
    .replace(/\{userId\}/g, vars.userId || '')
    .replace(/\{gender\}/g, vars.gender || '')
    .replace(/\{phone\}/g, vars.phone || '');
}

/** Placeholder values for the campaign screen preview. */
export const CAMPAIGN_PREVIEW_VARS: CampaignVars = {
  name: tr('Nguyễn Văn A'),
  userId: '0987654321',
  gender: tr('Nam'),
  phone: '0987654321',
};
