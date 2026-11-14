/**
 * A CRM campaign stops automatically after consecutive errors (set per campaign, Zalo + Telegram; off by default). When the account is
 * blocked, hits the send limit or loses its session, every contact fails. Before, the campaign kept going through the whole list and marked
 * thousands of contacts as failed (campaigns sending to scanned group members, which are all strangers, are the most likely to hit limits).
 *
 * Counted per contact (CRMQueueService.trackFailureStreak): a send error / phone number not found on Zalo → +1; a successful send (including a partial failure
 * of a Mixed campaign) → 0; a recipient "phone:…" on a channel that does not look up phone numbers (does not call the platform) changes nothing.
 * Reaching N → the campaign moves to Paused, saving the reason and the last error (shown on the campaign screen). Pressing Resume counts again from 0. Reaching the
 * daily limit is NOT an error: the campaign waits until the next day as before, without stopping.
 *
 * Two options (only meaningful when N > 0):
 *  - "Chỉ tính người lạ" (count strangers only) (Zalo): Zalo blocks spam by messages to strangers, while messaging friends / groups is still allowed. So friends and groups
 *    succeeding or failing do not change the streak (otherwise a friend whose send succeeds in between would restart the count, and it would never stop).
 *  - "Mai gửi tiếp" (resume tomorrow): Zalo lifts the block after one day. It stops automatically until the start time of the next day, then sends again
 *    (CRMQueueService.scheduleAutoResume). Press Resume to send right away.
 */

/** Selectable threshold (consecutive failed contacts); 0 = never stop automatically. */
import { tr } from '../i18n';

export const CAMPAIGN_STOP_AFTER_FAILURES_CHOICES: readonly number[] = [0, 3, 5, 10, 20];
export const MAX_CAMPAIGN_STOP_AFTER_FAILURES = 100;

/** Storable value: integer 0..100 (unknown / negative → 0 = never stop). */
export function normalizeStopAfterFailures(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_CAMPAIGN_STOP_AFTER_FAILURES);
}

/** On / off flag stored in the DB (0 / 1): true, 1, '1' → 1. */
export function campaignFlag(value: unknown): 0 | 1 {
  return value === true || Number(value) === 1 ? 1 : 0;
}

/** Whether the consecutive error count is enough to stop automatically yet. */
export function shouldAutoStopCampaign(consecutiveFailures: number, stopAfterFailures: unknown): boolean {
  const limit = normalizeStopAfterFailures(stopAfterFailures);
  return limit > 0 && consecutiveFailures >= limit;
}

function startTimeOf(dailyStartTime?: string | null): [number, number] {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(dailyStartTime || '').trim());
  const hours = match ? Number(match[1]) : 8;
  const minutes = match ? Number(match[2]) : 0;
  return hours <= 23 && minutes <= 59 ? [hours, minutes] : [8, 0];
}

/** "Mai gửi tiếp" (resume tomorrow): the next day (machine time) at the campaign's start time (default 08:00). */
export function campaignAutoResumeAt(stoppedAt: number, dailyStartTime?: string | null): number {
  const [hours, minutes] = startTimeOf(dailyStartTime);
  const day = new Date(stoppedAt);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, hours, minutes, 0, 0).getTime();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "08:00 · 05/11" (machine time). */
export function formatAutoResumeAt(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())} · ${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`;
}

const MAX_ERROR_TEXT = 160;

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** "5 liên hệ lỗi liên tiếp" (5 contacts failed in a row) / "5 người lạ lỗi liên tiếp" (5 strangers failed in a row). */
function failuresText(failures: number, strangersOnly?: unknown): string {
  return tr('{{failures}} {{v1}} lỗi liên tiếp', { failures, v1: strangersOnly ? tr('người lạ') : tr('liên hệ') });
}

/** Reason stored with the campaign and shown on the campaign screen: "5 liên hệ lỗi liên tiếp (lỗi cuối: …)" (5 contacts failed in a row, last error: …). */
export function campaignAutoStopReason(failures: number, lastError?: string, opts: { strangersOnly?: boolean } = {}): string {
  const error = oneLine(lastError);
  const shortError = error.length > MAX_ERROR_TEXT ? `${error.slice(0, MAX_ERROR_TEXT - 1)}…` : error;
  return `${failuresText(failures, opts.strangersOnly)}${shortError ? tr(' (lỗi cuối: {{shortError}})', { shortError }) : ''}`;
}

/** Setting label on the campaign screen: "Tự dừng khi 5 người lạ lỗi liên tiếp, mai gửi tiếp" (stop after 5 strangers fail in a row, resume tomorrow) / "Không tự dừng khi lỗi" (don't stop on errors). */
export function stopAfterFailuresLabel(value: unknown, opts: { strangersOnly?: unknown; resumeNextDay?: unknown } = {}): string {
  const limit = normalizeStopAfterFailures(value);
  if (limit <= 0) return tr('Không tự dừng khi lỗi');
  const who = campaignFlag(opts.strangersOnly) ? tr('người lạ ') : '';
  return tr('Tự dừng khi {{limit}} {{who}}lỗi liên tiếp{{v1}}', { limit, who, v1: campaignFlag(opts.resumeNextDay) ? tr(', mai gửi tiếp') : '' });
}

/** Notice when the campaign stops automatically: in-app toast (`toast`) / OS popup (`title` + `body`). */
export function campaignAutoStopNotice(input: {
  name?: unknown; accountName?: unknown; failures?: unknown; strangersOnly?: unknown; resumeAt?: unknown;
}): { title: string; body: string; toast: string } {
  const name = oneLine(input.name);
  const account = oneLine(input.accountName);
  const failures = Math.max(1, Math.round(Number(input.failures) || 0));
  const resumeAt = Number(input.resumeAt) || 0;
  const campaign = name ? tr('Chiến dịch "{{name}}"', { name }) : tr('Chiến dịch');
  const what = failuresText(failures, input.strangersOnly);
  const resume = resumeAt > 0 ? formatAutoResumeAt(resumeAt) : '';
  return {
    title: tr('⏸ {{campaign}} đã tự dừng', { campaign }),
    body: `${account ? `${account}: ` : ''}${what}. ${resume ? tr('Tự gửi tiếp lúc {{resume}}.', { resume }) : tr('Kiểm tra tài khoản rồi bấm Tiếp tục.')}`,
    // The "Cảnh báo" (Warning) style toast already has its own icon
    toast: tr('{{campaign}}{{v1}} đã tự dừng: {{what}}{{v2}}', { campaign, v1: account ? ` (${account})` : '', what, v2: resume ? tr(', gửi tiếp lúc {{resume}}', { resume }) : '' }),
  };
}
