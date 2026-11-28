/**
 * useMessagesSyncedReload: employee machine. A bulk sync finished on the Boss for an account (Zalo "Đồng bộ từ điện thoại", "Đồng bộ tin
 * nhắn Facebook", Telegram sync): its messages were written straight into the Boss DB without one event per message, so the employee only
 * saw them after F5 / restarting the app. The Boss relays `event:messagesSynced` (shared/chat/messagesSynced) to the employees assigned to
 * the account; this reloads its conversation list, flags and open conversation (lib/chat/realtime/messagesSyncedReload).
 *
 * Events of one account close together (catch-up replay after a reconnect, a sync right after another) → one reload, never two at once.
 * Boss / standalone: registers nothing (the sync buttons there reload from their own progress events).
 */
import { useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { createResyncScheduler, type ResyncScheduler } from '@/hooks/accounts/useEmployeeResync';
import { reloadAfterMessagesSynced } from '@/lib/chat/realtime/messagesSyncedReload';
import type { MessagesSyncedEvent } from '../../../shared/chat/messagesSynced';

/** Events of the same account within this window → one reload. */
export const MESSAGES_SYNCED_RELOAD_DEBOUNCE_MS = 1_000;

type Subscribe = (channel: string, callback: (data: any) => void) => (() => void) | void;

/** Plain part of the hook (no React): one debounced reload per account. Returns the unsubscribe function. */
export function subscribeMessagesSynced(
  on: Subscribe,
  reload: (accountId: string) => void | Promise<unknown>,
  debounceMs: number = MESSAGES_SYNCED_RELOAD_DEBOUNCE_MS,
): () => void {
  const schedulers = new Map<string, ResyncScheduler>();
  const unsubscribe = on('event:messagesSynced', (data: Partial<MessagesSyncedEvent> | null) => {
    const accountId = String(data?.zaloId || '');
    if (!accountId) return;
    let scheduler = schedulers.get(accountId);
    if (!scheduler) {
      scheduler = createResyncScheduler(() => reload(accountId), debounceMs);
      schedulers.set(accountId, scheduler);
    }
    scheduler.request();
  });
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe();
    for (const scheduler of schedulers.values()) scheduler.cancel();
    schedulers.clear();
  };
}

export function useMessagesSyncedReload(): void {
  // Boolean selector: re-renders only when the mode changes
  const isEmployee = useEmployeeStore((s) => s.mode === 'employee');

  useEffect(() => {
    const on = ipc.on;
    if (!isEmployee || !on) return undefined;
    return subscribeMessagesSynced((channel, callback) => on(channel, callback), reloadAfterMessagesSynced);
  }, [isEmployee]);
}

export default useMessagesSyncedReload;
