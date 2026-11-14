/**
 * Spacing between two contacts of a CRM campaign.
 *
 * CRMQueueService never sends two contacts closer together than `CAMPAIGN_MIN_CONTACT_DELAY_SECONDS` (anti-spam).
 * The create / edit campaign screen and the detail screen use the same constant. Before, the "Tùy chỉnh khoảng" (custom range) field let you pick from 5 seconds,
 * while the queue still waited 30 seconds.
 */
export const CAMPAIGN_MIN_CONTACT_DELAY_SECONDS = 30;

/** The [min, max] seconds range the queue actually uses: min ≥ the minimum, max ≥ min. */
export function effectiveContactDelayRange(minSeconds: number, maxSeconds: number): [number, number] {
  const min = Math.max(CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, Number(minSeconds) || 0);
  const max = Math.max(min, Number(maxSeconds) || 0);
  return [min, max];
}
