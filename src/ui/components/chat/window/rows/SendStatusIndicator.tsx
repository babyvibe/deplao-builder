/**
 * Trạng thái gửi tin của nhân viên (chờ gửi / đang gửi / đã gửi / lỗi): tin chữ lỗi có nút "Gửi lại" qua hàng đợi.
 */
import { useChatStore } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { getAdapter } from '@/lib/channels/adapters/registry';
import type { MessageRowContext, RowLocals } from './rowContext';

type SendStatusIndicatorProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg'>;

export function SendStatusIndicator({ ctx, msg }: SendStatusIndicatorProps) {
  const { activeAccountId, activeThreadId, removeMessage } = ctx;
  return (
    <div className="flex items-center gap-1 mt-0.5 px-1">
      {msg.send_status === 'pending' && (
        <span title="Đang chờ gửi">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground opacity-60">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </span>
      )}
      {msg.send_status === 'sending' && (
        <span title="Đang gửi...">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 animate-spin">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        </span>
      )}
      {msg.send_status === 'sent' && (
        <span title="Đã gửi">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
      )}
      {(msg.send_status === 'failed' || msg.send_status === 'timeout') && (
        <div className="flex items-center gap-1">
          <span title={msg.send_status === 'timeout' ? 'Gửi timeout (60s)' : 'Gửi thất bại'}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400">
              <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </span>
          {msg.media_type === 'text' || msg.media_type === 'link' || !msg.media_type ? (
            <button
              onClick={() => {
                // Retry text: xóa msg cũ, gửi lại
                removeMessage(activeAccountId!, activeThreadId, msg.msg_id);
                const retryTempId = `retry_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
                const channel = (msg.channel || CHANNEL.ZALO) as any;
                useChatStore.getState().addMessage(activeAccountId!, activeThreadId, {
                  msg_id: retryTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
                  thread_type: msg.thread_type, sender_id: activeAccountId!, content: msg.content,
                  msg_type: msg.msg_type, timestamp: Date.now(), is_sent: 1, status: 'sending',
                  send_status: 'pending', temp_id: retryTempId, media_type: 'text',
                  ...(msg.quote_data ? { quote_data: msg.quote_data } : {}),
                });
                import('@/lib/chat/send/MessageQueue').then(({ messageQueue }) => {
                  const auth = (() => {
                    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
                    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent, accountId: activeAccountId } : null;
                  })();
                  if (!auth) return;
                  messageQueue.enqueue({
                    tempId: retryTempId, zaloId: activeAccountId!, threadId: activeThreadId,
                    threadType: msg.thread_type, channel,
                    sendFn: async () => {
                      try {
                        const adapter = getAdapter(channel);
                        const result = await adapter.sendMessage({
                          accountId: activeAccountId!,
                          threadId: activeThreadId,
                          body: msg.content,
                          threadType: msg.thread_type,
                          auth,
                        });
                        return { success: result.success, msgId: result.messageId, error: result.error };
                      } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
                    },
                  });
                });
              }}
              className="text-[10px] text-red-400 hover:text-red-300 underline"
            >Gửi lại</button>
          ) : (
            <span className="text-[10px] text-subtle-foreground italic">Không thể gửi lại media</span>
          )}
        </div>
      )}
    </div>
  );
}
