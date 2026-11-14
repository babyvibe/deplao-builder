/**
 * Spacing between recipients when ONE send node sends to many conversations (selecting several conversations, or the "Danh sách hội thoại động" (dynamic conversation list)
 * from "Chọn đối tượng nhận tin" (select recipients)).
 *
 * Before this, the node sent non-stop: AccountSendQueue only spaced out BETWEEN node RUNS, so bulk sends to Zalo /
 * Facebook fired hundreds of messages within seconds (Zalo may flag spam, Facebook may ask for verification / checkpoint).
 * Like the CRM campaign that spaces out each contact: wait a random time within a range that has a minimum. The "Giãn cách gửi tối thiểu / tối đa" (min / max send gap) of the node
 * can only make it slower, never faster than the minimum. One recipient (auto-reply) keeps its old behavior. Pure function. Test: src/__tests__/recipientPacing.test.ts.
 */

/** Default range (seconds) between two recipients; also the minimum when the node sets a lower gap. */
export const BULK_RECIPIENT_GAP_SECONDS = { min: 5, max: 10 } as const;

/** [min, max] milliseconds to wait after each recipient of a bulk send node. */
export function recipientGapRangeMs(cfg: { sendDelayMinSeconds?: unknown; sendDelayMaxSeconds?: unknown }): [number, number] {
  const cfgMin = Math.max(0, Number(cfg.sendDelayMinSeconds) || 0);
  const cfgMax = Math.max(cfgMin, Number(cfg.sendDelayMaxSeconds) || 0);
  // The node's whole range is below the minimum (new nodes default to 1-3 seconds) → use the default range
  if (cfgMax < BULK_RECIPIENT_GAP_SECONDS.min) {
    return [BULK_RECIPIENT_GAP_SECONDS.min * 1000, BULK_RECIPIENT_GAP_SECONDS.max * 1000];
  }
  const min = Math.max(BULK_RECIPIENT_GAP_SECONDS.min, cfgMin);
  return [min * 1000, Math.max(min, cfgMax) * 1000];
}
