/**
 * Trạng thái một liên hệ của chiến dịch Hỗn hợp (nhiều hành động: tin nhắn / kết bạn / mời vào nhóm).
 *
 * Trước đây liên hệ luôn thành "Đã gửi" khi có từ 2 hành động — kể cả khi MỌI hành động lỗi; lỗi chỉ thấy ở tab Lịch
 * sử. Giờ: tất cả lỗi → "Lỗi"; một phần lỗi → vẫn "Đã gửi" (đã có hành động tới khách, tính vào giới hạn / ngày như
 * trước) nhưng cột `error` ghi hành động nào lỗi → màn chiến dịch hiện "Lỗi một phần". Không thêm trạng thái mới nên
 * mọi bộ đếm sent / failed giữ nguyên ý nghĩa.
 * Ghi: CRMQueueService. Đọc: ui/lib/crm/campaignView. Test: src/__tests__/campaignOutcome.test.ts.
 */

export type MixedCampaignAction = 'message' | 'friend_request' | 'invite_to_groups';

export interface MixedActionOutcome {
  action: MixedCampaignAction | string;
  ok: boolean;
  error?: string;
}

export const MIXED_ACTION_LABEL: Record<MixedCampaignAction, string> = {
  message: 'Tin nhắn',
  friend_request: 'Kết bạn',
  invite_to_groups: 'Mời vào nhóm',
};

export const PARTIAL_FAILURE_PREFIX = 'Lỗi một phần';

function describeFailure(outcome: MixedActionOutcome): string {
  const label = MIXED_ACTION_LABEL[outcome.action as MixedCampaignAction] || outcome.action;
  return outcome.error ? `${label}: ${outcome.error}` : label;
}

/** Trạng thái + lỗi ghi vào crm_campaign_contacts sau khi chạy các hành động của một liên hệ. */
export function summarizeMixedOutcome(outcomes: readonly MixedActionOutcome[]): { status: 'sent' | 'failed'; error?: string } {
  const failures = outcomes.filter(outcome => !outcome.ok);
  if (failures.length === 0) return { status: 'sent' };
  const detail = failures.map(describeFailure).join('; ');
  if (failures.length === outcomes.length) return { status: 'failed', error: detail };
  return { status: 'sent', error: `${PARTIAL_FAILURE_PREFIX} — ${detail}` };
}

/** Liên hệ "Đã gửi" nhưng có hành động lỗi: các nhánh gửi khác không bao giờ ghi lỗi cho dòng "sent". */
export function partialFailureOf(contact: { status?: string | null; error?: string | null }): string | null {
  return contact.status === 'sent' && contact.error && contact.error.trim() ? contact.error : null;
}
