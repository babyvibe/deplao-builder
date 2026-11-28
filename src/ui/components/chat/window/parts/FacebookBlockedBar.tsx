/**
 * Messenger does not let the account reply (contacts.fb_cannot_reply): "blocked" = the account blocked the person's
 * messages on Messenger (or from Deplao), with an Unblock button; any other reason only says why replies fail.
 */
import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import { ipc } from '@/lib/ipc';
import { tr } from '../../../../../shared/i18n';

export default function FacebookBlockedBar({ accountId, threadId, reason }: {
  accountId: string;
  threadId: string;
  reason: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const showNotification = useAppStore(s => s.showNotification);
  const blocked = reason === 'blocked';

  const unblock = async () => {
    setBusy(true);
    try {
      const res = await ipc.fb?.unblockUser({ accountId, userId: threadId });
      if (!res?.success) {
        showNotification(res?.error || tr('Không bỏ chặn được trên Messenger'), 'error');
        return;
      }
      useChatStore.getState().updateContact(accountId, { contact_id: threadId, fb_cannot_reply: '' } as any);
      showNotification(tr('Đã bỏ chặn'), 'success');
    } catch (err: any) {
      showNotification(err?.message || tr('Không bỏ chặn được trên Messenger'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-card/80 border-b border-border/60 flex-shrink-0" data-fb-blocked="1">
      <div className="w-7 h-7 rounded-full bg-red-500/15 flex items-center justify-center flex-shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
          <circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground/80">
          {blocked ? tr('Bạn đã chặn tin nhắn của người này trên Messenger') : tr('Messenger không cho trả lời cuộc trò chuyện này')}
        </p>
        <p className="text-xs text-muted-foreground truncate">
          {blocked ? tr('Bỏ chặn để nhắn tin lại') : tr('Tin gửi từ Deplao sẽ không tới người nhận')}
        </p>
      </div>
      {blocked && (
        <button
          onClick={unblock}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
        >
          {busy ? <Spinner size={3} /> : tr('Bỏ chặn')}
        </button>
      )}
    </div>
  );
}
