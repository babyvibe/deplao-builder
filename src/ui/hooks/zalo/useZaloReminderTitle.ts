import { useEffect, useState } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { isCutReminderTitle, reminderCardTitle, type ZaloReminderCardInfo } from '../../../shared/zalo/zaloReminderCard';

/** Pause between two lookups: an old chat full of reminder cards must not fire a burst of Zalo requests. */
const LOOKUP_GAP_MS = 400;
/**
 * A failed lookup (account reconnecting, network, main not ready) is tried again when the card shows up after this
 * pause, instead of keeping the cut title until the app reloads.
 */
export const REMINDER_RETRY_AFTER_MS = 2 * 60_000;

/** Session memory per card ("account|message"): whole titles found, and when a lookup last failed. */
const found = new Map<string, string>();
const failedAt = new Map<string, number>();
const pending = new Map<string, Promise<string>>();
let chain: Promise<unknown> = Promise.resolve();

/** True while a failed card waits before the next try. */
export function reminderLookupCoolingDown(lastFailure: number | undefined, now: number): boolean {
  return lastFailure !== undefined && now - lastFailure < REMINDER_RETRY_AFTER_MS;
}

/** One lookup per card at a time, cards one after another. */
function lookupOnce(key: string, run: () => Promise<string>): Promise<string> {
  const existing = pending.get(key);
  if (existing) return existing;
  const task = chain
    .then(run, run)
    .then(
      (title) => {
        if (title) {
          found.set(key, title);
          failedAt.delete(key);
        } else {
          failedAt.set(key, Date.now());
        }
        return title;
      },
      () => {
        failedAt.set(key, Date.now());
        return '';
      },
    )
    .finally(() => pending.delete(key));
  chain = task.then(() => new Promise((resolve) => setTimeout(resolve, LOOKUP_GAP_MS)));
  pending.set(key, task);
  return task;
}

interface ReminderMessageRef {
  owner_zalo_id?: string;
  msg_id?: string;
  thread_id?: string;
}

/**
 * Title of a Zalo reminder card. When Zalo cut it ("... - ...") and the card has a board topic id, main looks up the
 * whole title (zalo:resolveReminderTitle, which also saves it in the message) and the card re-renders with it. Until
 * then the card shows the cut title without its dots.
 */
export function useZaloReminderTitle(msg: ReminderMessageRef | null | undefined, card: ZaloReminderCardInfo | null): string {
  const shown = card ? reminderCardTitle(card) : '';
  const accountId = String(msg?.owner_zalo_id || '');
  const msgId = String(msg?.msg_id || '');
  const threadId = String(msg?.thread_id || '');
  const key = `${accountId}|${msgId}`;
  const needsLookup = !!card && !card.fullTitle && !!card.topicId && isCutReminderTitle(card.title) && !!accountId && !!msgId;
  const [fullTitle, setFullTitle] = useState(() => found.get(key) || '');

  useEffect(() => {
    setFullTitle(found.get(key) || '');
    if (!needsLookup || found.has(key) || reminderLookupCoolingDown(failedAt.get(key), Date.now())) return undefined;
    let alive = true;
    lookupOnce(key, async () => {
      const account = useAccountStore.getState().accounts.find((acc) => acc.zalo_id === accountId);
      if (!account) return '';
      const res = await ipc.zalo?.resolveReminderTitle?.({ auth: buildZaloAuth(account, accountId), msgId, threadId });
      return res?.success && res.response?.full ? String(res.response.title || '').trim() : '';
    }).then((title) => {
      if (alive && title) setFullTitle(title);
    });
    return () => {
      alive = false;
    };
  }, [key, needsLookup, accountId, msgId, threadId]);

  return fullTitle || shown;
}

/** Test only: forget the session memory. */
export function __resetZaloReminderTitleState(): void {
  found.clear();
  failedAt.clear();
  pending.clear();
  chain = Promise.resolve();
}
