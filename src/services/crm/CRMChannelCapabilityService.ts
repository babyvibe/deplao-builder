import DatabaseService from '../database/DatabaseService';
import { getCapability, normalizeChannel, type Channel } from '../../configs/channelConfig';

/** CRM actions are checked here by both IPC and CRM queue.  UI uses the same
 * ChannelCapability config, while this service prevents bypassing it. */
export type CRMChannelAction = 'campaign' | 'campaign_message' | 'campaign_media' | 'history' | 'groups';

export interface CRMChannelDecision {
  allowed: boolean;
  channel: Channel;
  reason?: string;
}

export function getCRMChannelDecision(accountId: string, action: CRMChannelAction): CRMChannelDecision {
  const account = DatabaseService.getInstance().getAccounts().find(a => a.zalo_id === accountId);
  const channel = normalizeChannel(account?.channel);
  const capability = getCapability(channel);

  const allowed = action === 'campaign' || action === 'campaign_message'
    ? capability.supportsCampaigns
    : action === 'campaign_media'
      ? capability.supportsCampaigns && capability.supportsImage
      : action === 'history'
        ? capability.supportsCRMHistory
        : capability.supportsCRMGroups;

  return allowed
    ? { allowed: true, channel }
    : { allowed: false, channel, reason: `${capability.label} không hỗ trợ tính năng CRM này` };
}

/** Telegram deliberately supports message campaigns only.  Do not silently
 * downgrade Zalo-only campaign types such as friend request or group invite. */
export function validateCampaignForChannel(accountId: string, campaign: any): CRMChannelDecision {
  const decision = getCRMChannelDecision(accountId, 'campaign');
  if (!decision.allowed) return decision;
  if ((decision.channel === 'telegram_user' || decision.channel === 'telegram_bot')
    && (campaign?.campaign_type || 'message') !== 'message') {
    return { allowed: false, channel: decision.channel, reason: 'Telegram chỉ hỗ trợ chiến dịch gửi tin nhắn trong CRM' };
  }
  return decision;
}
