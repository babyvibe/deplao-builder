/**
 * Tells main which Facebook chat is on screen (fb:setViewingChat). Encrypted Messenger chats only exchange typing while
 * the account is "available" on their WhatsApp layer: main keeps it available while an encrypted chat is shown and drops
 * it a minute after the chat leaves the screen (another conversation or page, window in the background).
 */
import { useEffect } from 'react';
import ipc from '@/lib/ipc';
import { isChatPaneVisible } from '@/lib/chat/read/liveReadSync';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';

interface ViewingReport {
  accountId: string;
  threadId: string | null;
}

function currentViewing(): ViewingReport | null {
  const accounts = useAccountStore.getState();
  const accountId = accounts.activeAccountId || '';
  const channel = accounts.accounts.find(a => a.zalo_id === accountId)?.channel;
  if (!accountId || channel !== 'facebook') return null;
  const shown = typeof document !== 'undefined' && document.visibilityState !== 'hidden' && document.hasFocus() && isChatPaneVisible();
  return { accountId, threadId: shown ? (useChatStore.getState().activeThreadId || null) : null };
}

export function useFacebookViewingChat(): void {
  useEffect(() => {
    let reported: ViewingReport | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = (report: ViewingReport) => {
      void ipc.fb?.setViewingChat?.(report)?.catch(() => {});
    };
    const flush = () => {
      timer = null;
      const next = currentViewing();
      const previous = reported;
      // Another account / channel took the screen: the previous Facebook account shows nothing any more
      if (previous?.threadId && (!next || next.accountId !== previous.accountId)) {
        send({ accountId: previous.accountId, threadId: null });
      }
      if (next && (!previous || next.accountId !== previous.accountId || next.threadId !== previous.threadId)) send(next);
      reported = next;
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    };

    const unsubChat = useChatStore.subscribe((state, prev) => {
      if (state.activeThreadId !== prev.activeThreadId) schedule();
    });
    const unsubAccount = useAccountStore.subscribe((state, prev) => {
      if (state.activeAccountId !== prev.activeAccountId) schedule();
    });
    const unsubApp = useAppStore.subscribe((state, prev) => {
      if (state.view !== prev.view || state.mobileShowChat !== prev.mobileShowChat) schedule();
    });
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      unsubChat();
      unsubAccount();
      unsubApp();
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', schedule);
      document.removeEventListener('visibilitychange', schedule);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
