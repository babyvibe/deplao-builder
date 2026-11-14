/**
 * Zalo photos that only have a link (the owner's machine has not saved them): ask the owner's machine to download them with the account's session (file:ensureMessageImage, the employee machine hands the request over to the owner's machine)
 * and then switch to the saved copy, so the photos survive when the Zalo link expires. Employee machines have no Zalo cookie,
 * so they can only read photos through the owner's machine (/api/media).
 *
 * The owner's machine only downloads a photo itself when the message arrives. Messages synced from history (the owner's machine was off when they arrived), synced from the phone, or failed downloads
 * have no copy on the machine. Previously employee machines showed the Zalo link directly for those photos, and when the link expired the photo was lost.
 *
 * - Shared queue: at most ENSURE_CONCURRENCY requests at once (opening a conversation with many photos does not flood the owner's machine / CDN).
 * - One attempt per message per session (success / expired / not a photo); temporary errors (lost connection to the owner's machine, network) retry after
 *   ENSURE_RETRY_AFTER_MS. `force` (the user clicks Retry download) asks again right away.
 * - When there is a new path → saved to the store: the message bubble redraws with the saved copy.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chat/chatStore';
import { tr } from '../../../shared/i18n';

export interface EnsureImageResult {
  success: boolean;
  /** Path on the owner's machine (local_paths.main) */
  newLocalPath?: string;
  expired?: boolean;
  /** The owner's machine already has the file, do not download it again */
  cached?: boolean;
  error?: string;
  code?: string;
}

export const ENSURE_CONCURRENCY = 2;
/** Message just received: the owner's machine is downloading the photo itself (at receive time, retry after 20 s); wait this long before asking for a download. */
export const ENSURE_MIN_AGE_MS = 90_000;
/** Temporary error (lost connection to the owner's machine, unstable CDN): wait this long before asking again for the same message. */
export const ENSURE_RETRY_AFTER_MS = 60_000;
/** Conversation just opened: yield to loading messages / drawing the chat frame first. */
export const ENSURE_OPEN_DELAY_MS = 1_500;

/**
 * Errors that do not change when asked again: remembered for the whole session, like a success: the message is not a Zalo photo / has no link (imageRepair), the owner's machine
 * refuses (account not assigned, no chat permission, the owner's machine version is too old and does not have this channel yet: proxyActionPolicy).
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND', 'NOT_ZALO_IMAGE', 'NO_IMAGE_URL', 'ACCOUNT_FORBIDDEN', 'MODULE_FORBIDDEN', 'CHANNEL_FORBIDDEN',
]);

const settled = new Map<string, { result: EnsureImageResult; at: number }>();
const inFlight = new Map<string, Promise<EnsureImageResult>>();
const queue: Array<() => Promise<void>> = [];
let running = 0;

function pump(): void {
  while (running < ENSURE_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function currentMainPath(msg: any): string {
  try {
    const lp = typeof msg?.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg?.local_paths || {});
    return String(lp?.main || lp?.hd || '');
  } catch {
    return '';
  }
}

function remembered(key: string, now: number): EnsureImageResult | null {
  const entry = settled.get(key);
  if (!entry) return null;
  const { result } = entry;
  const permanent = result.success || result.expired || PERMANENT_CODES.has(String(result.code || ''));
  if (permanent || now - entry.at < ENSURE_RETRY_AFTER_MS) return result;
  settled.delete(key);
  return null;
}

/**
 * The photo of message `msg` (Zalo) must exist on the owner's machine. Returns the owner's path (`newLocalPath`) when it already exists / has just been downloaded,
 * `expired` when Zalo no longer keeps the photo. A path different from the one already on the message → updates the store.
 */
export function ensureMessageImage(msg: any, opts: { force?: boolean } = {}): Promise<EnsureImageResult> {
  const zaloId = String(msg?.owner_zalo_id || '');
  const msgId = String(msg?.msg_id || '');
  const threadId = String(msg?.thread_id || '');
  if (!zaloId || !msgId) return Promise.resolve({ success: false, error: tr('Thiếu thông tin tin nhắn') });
  const key = `${zaloId}:${msgId}`;
  if (!opts.force) {
    const done = remembered(key, Date.now());
    if (done) return Promise.resolve(done);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = new Promise<EnsureImageResult>((resolve) => {
    queue.push(async () => {
      let result: EnsureImageResult;
      try {
        result = (await ipc.file?.ensureMessageImage?.({
          zaloId, msgId, threadId: threadId || undefined, force: !!opts.force,
        })) || { success: false, error: tr('Không gọi được tiến trình chính') };
      } catch (err: any) {
        result = { success: false, error: err?.message || String(err) };
      }
      resolve(result);
    });
    pump();
  }).then((result) => {
    inFlight.delete(key);
    settled.set(key, { result, at: Date.now() });
    if (result.success && result.newLocalPath && threadId && result.newLocalPath !== currentMainPath(msg)) {
      useChatStore.getState().updateMessageLocalPath(zaloId, threadId, msgId, { main: result.newLocalPath });
    }
    return result;
  });
  inFlight.set(key, task);
  return task;
}

/**
 * Photo bubble: a photo that only has a Zalo link (`enabled`) → ensureMessageImage after ENSURE_OPEN_DELAY_MS; a message just received waits the full
 * ENSURE_MIN_AGE_MS (the owner's machine downloads it itself when the message arrives). If the message already has a saved copy or the bubble leaves the screen → cancel the timer.
 */
export function useEnsureMessageImage(msg: any, enabled: boolean): void {
  const msgRef = React.useRef(msg);
  msgRef.current = msg;
  const msgId = String(msg?.msg_id || '');
  const receivedAt = Number(msg?.timestamp) || 0;
  React.useEffect(() => {
    if (!enabled || !msgId) return undefined;
    const wait = Math.max(ENSURE_OPEN_DELAY_MS, ENSURE_MIN_AGE_MS - (Date.now() - receivedAt));
    const timer = window.setTimeout(() => { void ensureMessageImage(msgRef.current); }, wait);
    return () => window.clearTimeout(timer);
  }, [enabled, msgId, receivedAt]);
}

/** Test only. */
export function __resetEnsureMessageImage(): void {
  settled.clear();
  inFlight.clear();
  queue.length = 0;
  running = 0;
}
