/**
 * In-app new message notification: a card at the top right, under the title bar (store/chat/inAppNotifyStore, rules in
 * lib/chat/notifications/inAppNotify). Picture + name of the account (page) that received the message, conversation name, the message up to 2 lines. Click the card to open the conversation, ✕ to dismiss
 * quickly, hover to keep it. If the conversation is opened another way, its card dismisses itself.
 */
import React, { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { inAppToastBody, type InAppToast } from '@/lib/chat/notifications/inAppNotify';
import { useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { CloseIcon } from '@/components/common/icons';
import { ChannelBadgeOverlay, FacebookIcon, TelegramIcon, ZaloIcon, MESSENGER_GRADIENT } from '../avatars/ChannelBadge';
import { getChannelLabel, resolveAccountChannel, type Channel } from '../../../../configs/channels/channelConfig';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { tr } from '../../../../shared/i18n';

export interface InAppToastAccount {
  name: string;
  avatar: string;
  channel: Channel;
}

function toastAccount(account: AccountInfo | undefined, accountId: string): InAppToastAccount {
  return {
    name: account?.full_name || account?.display_name || accountId,
    avatar: account?.avatar_url || '',
    channel: account ? resolveAccountChannel(account) : 'zalo',
  };
}

function AccountAvatar({ account }: { account: InAppToastAccount }) {
  const [failed, setFailed] = React.useState(false);
  const src = account.avatar && !failed ? toLocalMediaUrl(account.avatar) : '';
  return (
    <span className="relative mt-0.5 h-9 w-9 flex-shrink-0">
      {src ? (
        <img src={src} alt="" className="h-9 w-9 rounded-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${isFacebook(account.channel) ? '' : isTelegram(account.channel) ? 'bg-sky-500' : 'bg-blue-600'}`}
          style={isFacebook(account.channel) ? { background: MESSENGER_GRADIENT } : undefined}>
          {isFacebook(account.channel) ? <FacebookIcon size={16} /> : isTelegram(account.channel) ? <TelegramIcon size={16} /> : <ZaloIcon size={16} />}
        </span>
      )}
      <ChannelBadgeOverlay channel={account.channel} size="xs" />
    </span>
  );
}

export function InAppToastCard({ toast, account, onOpen, onDismiss, onHover }: {
  toast: InAppToast;
  account: InAppToastAccount;
  onOpen: () => void;
  onDismiss: () => void;
  onHover: (hovering: boolean) => void;
}) {
  const body = inAppToastBody(toast);
  return (
    <div
      className={`pointer-events-auto relative ${toast.leavingAt !== undefined ? 'in-app-toast-out' : 'in-app-toast-in'}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        title={tr('Mở hội thoại')}
        className="flex w-full items-start gap-2.5 rounded-2xl border border-border bg-card/95 p-3 pr-8 text-left shadow-xl backdrop-blur transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AccountAvatar account={account} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[13px] font-semibold leading-5 text-foreground">
            <span className="truncate">{account.name}</span>
            <span className="flex-shrink-0 font-normal text-muted-foreground">· {getChannelLabel(account.channel)}</span>
            {toast.count > 1 && (
              <span className="ml-auto flex-shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary" title={tr('{{count}} tin mới', { count: toast.count })}>
                {toast.count}
              </span>
            )}
          </span>
          <span className="mt-0.5 line-clamp-2 break-words text-xs leading-[18px] text-muted-foreground">
            <span className="font-medium text-foreground/90">{body.conversation}</span>{body.rest ? `: ${body.rest}` : ''}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title={tr('Đóng')}
        aria-label={tr('Đóng thông báo')}
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function InAppMessageToasts({ belowFriendRequest = false }: { belowFriendRequest?: boolean }) {
  const toasts = useInAppNotifyStore((s) => s.toasts);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const containerRef = useRef<HTMLDivElement>(null);

  // The conversation is opened another way (list, OS notification…) → its card is no longer needed
  useEffect(() => {
    if (activeAccountId && activeThreadId) useInAppNotifyStore.getState().dismissConversation(activeAccountId, activeThreadId);
  }, [activeAccountId, activeThreadId]);

  // When the hovered card is removed (✕, a new card pushed out), the browser does not report "mouse left", so re-check so the remaining cards
  // still hide themselves
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el || !el.matches(':hover')) useInAppNotifyStore.getState().setHovering(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [toasts.length]);

  if (!toasts.length) return null;
  const store = useInAppNotifyStore.getState();
  return (
    <div
      ref={containerRef}
      aria-live="polite"
      className={`pointer-events-none fixed right-3 z-[9990] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2 ${belowFriendRequest ? 'top-[16.5rem]' : 'top-11'}`}
    >
      {toasts.map((toast) => {
        const account = accounts.find((a) => a.zalo_id === toast.accountId || a.facebook_id === toast.accountId);
        return (
          <InAppToastCard
            key={toast.id}
            toast={toast}
            account={toastAccount(account, toast.accountId)}
            onHover={store.setHovering}
            onDismiss={() => store.dismiss(toast.key)}
            onOpen={() => {
              store.dismissConversation(toast.accountId, toast.threadId);
              store.setHovering(false);
              // Same path as clicking an OS notification: switch account, open the conversation, mark as read (useZaloEvents)
              ipc.app?.openThread({ zaloId: toast.accountId, threadId: toast.threadId, threadType: toast.threadType });
            }}
          />
        );
      })}
    </div>
  );
}
