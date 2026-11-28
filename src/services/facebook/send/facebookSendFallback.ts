/**
 * Which way a Facebook 1:1 message goes when the first way is refused (pure part, used by FacebookService / FacebookSendService).
 *
 * A Messenger 1:1 chat is end-to-end encrypted (bridge) or normal (web send), and Messenger can upgrade a normal chat to encrypted
 * at any time without telling anyone. Deplao sends the way it knows for the chat. When Messenger clearly refuses the message (it
 * answered with an error, so nothing was delivered) it tries the other way once and remembers the way that went through.
 * A timeout, a lost connection or an unclear answer is never sent the other way: the message may have been delivered.
 */
import type { FBSendOptions } from '../FacebookTypes';

/**
 * The encrypted send was answered by Messenger's server with an error code (whatsmeow ErrServerReturnedError, e.g. "server
 * returned error 405"): the server did not accept the message (mautrix-meta treats this error as certain).
 */
export function isE2EEServerRejection(error: unknown): boolean {
  return /\bserver returned error \d+/i.test(String(error ?? ''));
}

/** The normal send was answered by Facebook with an error (`rejected`): no message was created. */
export function isNormalSendRejection(result: { success?: boolean; rejected?: boolean } | null | undefined): boolean {
  return !!result && result.success !== true && result.rejected === true;
}

/** Only text (and a reply): the encrypted send can carry it. Attachments / stickers of the normal send cannot be resent as they are. */
export function isTextOnlySend(opts?: FBSendOptions | null): boolean {
  return !opts?.stickerId && !opts?.typeAttachment && opts?.attachmentId === undefined && !opts?.attachmentIds?.length;
}

/** Facebook's answer to a normal send that refused it: Facebook replied with an error, or the request was refused (HTTP 4xx). */
export function isFacebookRefusal(answer: { error?: unknown; errorSummary?: unknown; errorDescription?: unknown } | null | undefined, httpStatus?: number): boolean {
  if (typeof httpStatus === 'number') return httpStatus >= 400 && httpStatus < 500;
  return !!answer && !!(answer.error || answer.errorSummary || answer.errorDescription);
}
