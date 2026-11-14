/**
 * Status of one contact in a Mixed campaign (several actions: message / friend request / group invite).
 *
 * Before, a contact always became "Đã gửi" (Sent) when it had 2 or more actions, even when ALL actions failed. The error was only visible in the History
 * tab. Now: all failed → "Lỗi" (Error); partly failed → still "Đã gửi" (Sent), since an action reached the customer and it counts toward the limit / day as
 * before, but the `error` column records which action failed → the campaign screen shows "Lỗi một phần" (Partial error). No new status is added, so
 * every sent / failed counter keeps its meaning.
 * Written by: CRMQueueService. Read by: ui/lib/crm/campaignView. Test: src/__tests__/crm/campaignOutcome.test.ts.
 */

import { tr } from '../i18n';

export type MixedCampaignAction = 'message' | 'friend_request' | 'invite_to_groups';

export interface MixedActionOutcome {
  action: MixedCampaignAction | string;
  ok: boolean;
  error?: string;
}

export const MIXED_ACTION_LABEL: Record<MixedCampaignAction, string> = {
  message: tr('Tin nhắn'),
  friend_request: tr('Kết bạn'),
  invite_to_groups: tr('Mời vào nhóm'),
};

export const PARTIAL_FAILURE_PREFIX = tr('Lỗi một phần');

function describeFailure(outcome: MixedActionOutcome): string {
  const label = MIXED_ACTION_LABEL[outcome.action as MixedCampaignAction] || outcome.action;
  return outcome.error ? `${label}: ${outcome.error}` : label;
}

/** Status + error written to crm_campaign_contacts after running the actions of one contact. */
export function summarizeMixedOutcome(outcomes: readonly MixedActionOutcome[]): { status: 'sent' | 'failed'; error?: string } {
  const failures = outcomes.filter(outcome => !outcome.ok);
  if (failures.length === 0) return { status: 'sent' };
  const detail = failures.map(describeFailure).join('; ');
  if (failures.length === outcomes.length) return { status: 'failed', error: detail };
  return { status: 'sent', error: `${PARTIAL_FAILURE_PREFIX} — ${detail}` };
}

/** A contact "Đã gửi" (Sent) but with a failed action: the other send branches never write an error on the "sent" row. */
export function partialFailureOf(contact: { status?: string | null; error?: string | null }): string | null {
  return contact.status === 'sent' && contact.error && contact.error.trim() ? contact.error : null;
}
