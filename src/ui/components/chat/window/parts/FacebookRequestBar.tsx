/**
 * Messenger message request (contacts.fb_request = 1): the conversation is in Messenger's "Tin nhắn chờ" and in
 * Deplao's "Khác". Accept moves it to the inbox (both sides); Delete removes it from Messenger and Deplao.
 */
import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import DataAccessor from '@/lib/data/DataAccessor';
import { ipc } from '@/lib/ipc';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { tr } from '../../../../../shared/i18n';

export default function FacebookRequestBar({ accountId, threadId, onDone }: {
  accountId: string;
  threadId: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = React.useState<'accept' | 'delete' | null>(null);
  const showNotification = useAppStore(s => s.showNotification);

  const accept = async () => {
    setBusy('accept');
    try {
      const res = await ipc.fb?.acceptMessageRequest({ accountId, threadId });
      if (!res?.success) {
        showNotification(res?.error || tr('Không chấp nhận được tin nhắn chờ'), 'error');
        return;
      }
      useChatStore.getState().updateContact(accountId, { contact_id: threadId, fb_request: 0, is_in_others: 0 } as any);
      useAppStore.getState().removeFromOthers(accountId, threadId);
      showNotification(tr('Đã chấp nhận, cuộc trò chuyện đã vào hộp thư chính'), 'success');
      onDone?.();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await showConfirm({
      title: tr('Xóa tin nhắn chờ này?'),
      message: tr('Cuộc trò chuyện sẽ bị xóa khỏi Messenger và Deplao. Người gửi không nhận được thông báo.'),
      confirmText: tr('Xóa'),
      variant: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      const res = await ipc.fb?.deleteThread({ accountId, threadId });
      if (!res?.success) {
        showNotification(res?.error || tr('Không xóa được cuộc trò chuyện trên Messenger'), 'error');
        return;
      }
      await DataAccessor.deleteConversation({ zaloId: accountId, contactId: threadId });
      const chat = useChatStore.getState();
      chat.removeContact(accountId, threadId);
      if (chat.activeThreadId === threadId) chat.setActiveThread(null);
      showNotification(tr('Đã xóa tin nhắn chờ'), 'success');
      onDone?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-card/80 border-b border-border/60 flex-shrink-0" data-fb-request="1">
      <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground/80">{tr('Tin nhắn chờ trên Messenger')}</p>
        <p className="text-xs text-muted-foreground truncate">{tr('Trả lời hoặc chấp nhận để đưa vào hộp thư chính')}</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={remove}
          disabled={!!busy}
          className="px-3 py-1.5 bg-muted hover:bg-accent text-foreground/80 hover:text-foreground text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {busy === 'delete' ? <Spinner size={3} /> : tr('Xóa')}
        </button>
        <button
          onClick={accept}
          disabled={!!busy}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {busy === 'accept' ? <Spinner size={3} /> : tr('Chấp nhận')}
        </button>
      </div>
    </div>
  );
}
