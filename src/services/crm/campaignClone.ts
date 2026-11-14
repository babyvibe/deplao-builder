/**
 * Nhân bản chiến dịch into one or more chat accounts ("Tài khoản nhận bản sao"): one draft copy per account, in the order given.
 * Run by the crm:cloneCampaign IPC handler on Boss / standalone (employees reach it through the relay, which checks that every
 * target account is assigned to them). Targets must be active accounts of the campaign's channel; what a copy for another account
 * keeps is decided in DatabaseService.cloneCRMCampaignInto (shared/crm/campaignCopy).
 */
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import { getCapability, normalizeChannel } from '../../configs/channels/channelConfig';
import { validateCampaignForChannel } from './CRMChannelCapabilityService';
import type { CampaignCloneCopy, CampaignCloneParams, CampaignCloneResponse } from '../../shared/crm/campaignCopy';
import { tr } from '../../shared/i18n';

/** Target accounts in the order picked, without duplicates; none given = the owner. */
export function campaignCloneTargets(ownerZaloId: string, targetZaloIds?: unknown): string[] {
  const picked = Array.isArray(targetZaloIds)
    ? [...new Set(targetZaloIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : [];
  return picked.length > 0 ? picked : [ownerZaloId];
}

export function cloneCampaignToAccounts(request: CampaignCloneParams): CampaignCloneResponse {
  const db = DatabaseService.getInstance();
  const source = db.getCRMCampaign(request?.campaignId);
  if (!source || source.owner_zalo_id !== request.zaloId) return { success: false, error: tr('Không tìm thấy chiến dịch') };
  const sourceDecision = validateCampaignForChannel(request.zaloId, source);
  if (!sourceDecision.allowed) return { success: false, error: sourceDecision.reason };

  const subset = Array.isArray(request.contactIds) ? request.contactIds.map(String).filter(Boolean) : undefined;
  // A copy for another account keeps phone recipients only on a channel that looks phone numbers up when sending
  const canLookUpPhone = getCapability(sourceDecision.channel).supportsCRMPhoneImport;
  const accountChannels = new Map(db.getAccounts().map((account) => [String(account.zalo_id), normalizeChannel(account.channel)]));

  const failed: Array<{ zaloId: string; error: string }> = [];
  const allowed: string[] = [];
  for (const target of campaignCloneTargets(request.zaloId, request.targetZaloIds)) {
    if (target !== request.zaloId) {
      const channel = accountChannels.get(target);
      if (!channel) { failed.push({ zaloId: target, error: tr('Không tìm thấy tài khoản') }); continue; }
      // Same channel = same campaign capability and the same allowed campaign types as the owner (checked above)
      if (channel !== sourceDecision.channel) { failed.push({ zaloId: target, error: tr('Chỉ nhân bản được sang tài khoản cùng kênh') }); continue; }
    }
    allowed.push(target);
  }

  // One call: the source recipients are read once for every account (100 accounts × a big list used to mean 100 full reads)
  const results = allowed.length > 0
    ? db.cloneCRMCampaignIntoAccounts(request.campaignId, allowed, {
        includeContacts: !!request.includeContacts, newName: request.newName, contactIds: subset, canLookUpPhone,
      })
    : [];
  const copies: CampaignCloneCopy[] = [];
  allowed.forEach((target, index) => {
    const copy = results[index];
    if (!copy) { failed.push({ zaloId: target, error: tr('Không thể nhân bản chiến dịch') }); return; }
    copies.push({ zaloId: target, ...copy });
    EventBroadcaster.emit('crm:campaignChanged', { action: 'clone', ownerZaloId: target, campaignId: copy.id });
  });

  if (copies.length === 0) return { success: false, error: failed[0]?.error || tr('Không thể nhân bản chiến dịch'), failed };
  db.save();
  const primary = copies.find((copy) => copy.zaloId === request.zaloId) ?? copies[0];
  return { success: true, id: primary.id, copies, failed };
}
