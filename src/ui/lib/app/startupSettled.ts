/**
 * Tells main (app:uiSettled) when the UI has finished loading at app start: the conversation list of the open account is ready (or
 * no account is selected), then waits for the browser to be idle. Main only starts heavy background work (catch-up sync / reloading old
 * Telegram messages…) after this point: see src/utils/startup/startupSettle.ts. Max 20 s (e.g. the app opened on another page, with no list).
 */
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';

const MAX_WAIT_MS = 20_000;
let started = false;

type IdleCallback = (cb: () => void, opts?: { timeout: number }) => number;

export function reportUiSettledWhenReady(): void {
  if (started) return;
  started = true;
  let done = false;
  const unsubscribes: Array<() => void> = [];
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (maxTimer) clearTimeout(maxTimer);
    const send = () => {
      try { ipc.app?.uiSettled?.(); } catch { /* old preload does not have this channel yet */ }
    };
    const requestIdle = (window as unknown as { requestIdleCallback?: IdleCallback }).requestIdleCallback;
    if (requestIdle) requestIdle(send, { timeout: 3_000 });
    else setTimeout(send, 500);
  };

  const check = () => {
    if (done) return;
    const { accounts, activeAccountId } = useAccountStore.getState();
    if (!accounts.length) return; // account list not loaded yet
    if (!activeAccountId) {
      finish();
      return;
    }
    const { contacts, conversationsLoading } = useChatStore.getState();
    if (Array.isArray(contacts[activeAccountId]) && !conversationsLoading[activeAccountId]) finish();
  };

  unsubscribes.push(useAccountStore.subscribe(check));
  unsubscribes.push(useChatStore.subscribe(check));
  maxTimer = setTimeout(finish, MAX_WAIT_MS);
  check();
}
