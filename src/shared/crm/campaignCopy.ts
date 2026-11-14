/**
 * Copying a CRM campaign into ANOTHER chat account of the same channel (Nhân bản chiến dịch → Tài khoản nhận bản sao).
 *
 * Recipient and group IDs belong to the account that collected them. Zalo gives every account its own ID for the same person and
 * the same group (three Zalo accounts on one machine shared none of their 3,300 contact IDs; groups with the same name had a
 * different ID in each account). A Telegram account only reaches users whose access hash it knows, a bot only users who started
 * it. So a copy for another account keeps the content and the send settings, and only the recipients that account can find by
 * itself: a phone number, on a channel that looks phone numbers up when sending (Zalo, CRMQueueService `phone:` rows). The invite
 * groups are cleared: the copy has to pick that account's own groups before it can run.
 */

/** crm:cloneCampaign parameters (IPC, employee REST /api/command/crm/campaigns/clone). */
export interface CampaignCloneParams {
  /** Account that owns the source campaign. */
  zaloId: string;
  campaignId: number;
  includeContacts: boolean;
  newName?: string;
  /** Only these recipients (follow-up campaign from a result filter); empty = all. */
  contactIds?: string[];
  /** Accounts that get a copy; empty / missing = the owner only (older clients, the public API). */
  targetZaloIds?: string[];
}

export interface CampaignCloneCopy {
  zaloId: string;
  id: number;
  /** Recipients copied into this copy. */
  contacts: number;
  /** The invite groups were left out (another account): pick that account's groups before running. */
  inviteGroupsCleared: boolean;
}

export interface CampaignCloneResponse {
  success: boolean;
  /** The owner's copy when it got one, else the first copy (shape of the single-account result). */
  id?: number;
  /** Missing from an older Boss: only `id` (one copy in the owner's account). */
  copies?: CampaignCloneCopy[];
  failed?: Array<{ zaloId: string; error: string }>;
  error?: string;
}

export type CampaignInviteSource = { campaign_type?: string | null; mixed_config?: string | null };

function parseMixedConfig(raw?: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Groups the campaign invites contacts into (mixed_config.group_ids). */
export function campaignInviteGroupIds(campaign: CampaignInviteSource): string[] {
  const ids = parseMixedConfig(campaign.mixed_config).group_ids;
  return Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
}

/** The campaign invites contacts into groups: "Mời nhóm", or "Hỗn hợp" with the "Mời nhóm" action. */
export function campaignInvitesToGroups(campaign: CampaignInviteSource): boolean {
  const type = campaign.campaign_type || 'message';
  if (type === 'invite_to_group') return true;
  if (type !== 'mixed') return false;
  const actions = parseMixedConfig(campaign.mixed_config).actions;
  return Array.isArray(actions) && actions.includes('invite_to_groups');
}

/** The campaign invites into groups but has none picked: it cannot run (every recipient would fail). */
export function campaignMissingInviteGroups(campaign: CampaignInviteSource): boolean {
  return campaignInvitesToGroups(campaign) && campaignInviteGroupIds(campaign).length === 0;
}

/** mixed_config of a copy for another account: the same, without the invite groups. */
export function withoutInviteGroups(mixedConfig?: string | null): string {
  const config = parseMixedConfig(mixedConfig);
  if (!('group_ids' in config)) return mixedConfig || '{}';
  delete config.group_ids;
  return JSON.stringify(config);
}

export type CampaignRecipientRow = {
  contact_id?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  phone?: string | null;
};

export type CopiedRecipient = { contactId: string; displayName: string; avatar: string; phone: string };

/** Fewer digits than this is not a phone number the sending account could look up. */
const MIN_PHONE_DIGITS = 8;

/**
 * A recipient of a copy for ANOTHER account, or null when that account cannot reach it. Only a phone number travels: a
 * `phone:<number>` row (a row already resolved to an ID keeps its number in `phone`), looked up again by the sending account.
 */
export function recipientForOtherAccount(row: CampaignRecipientRow, canLookUpPhone: boolean): CopiedRecipient | null {
  if (!canLookUpPhone) return null;
  const id = String(row.contact_id || '').trim();
  const phone = (String(row.phone || '').trim() || (id.startsWith('phone:') ? id.slice(6) : '')).replace(/\s+/g, '');
  if (phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS) return null;
  return {
    contactId: `phone:${phone}`,
    displayName: String(row.display_name || '').trim() || phone,
    avatar: String(row.avatar || ''),
    phone,
  };
}
