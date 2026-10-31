/**
 * Báo main hội thoại Telegram đang mở → hàng tải file của tài khoản đó tải ảnh / video / file của hội thoại này trước
 * (services/telegram/media/telegramDownloadQueue.ts). Trước đây hàng tải chạy theo thứ tự xếp hàng: lúc mở app, phần bắt kịp
 * của mọi hội thoại khác xếp trước nên vào hội thoại không xem được video ngay.
 *
 * Chỉ báo khi giá trị đổi (đổi hội thoại / tài khoản). Không phải Telegram hoặc chưa mở hội thoại → bỏ ưu tiên.
 */
import ipc from '@/lib/ipc';
import { isTelegramUser } from '@/lib/channels/channelHelper';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';

export interface TelegramDownloadFocus {
  accountId: string | null;
  threadId: string | null;
}

export function telegramDownloadFocusOf(
  accountId: string | null | undefined,
  channel: string | undefined,
  threadId: string | null | undefined,
): TelegramDownloadFocus {
  return accountId && threadId && isTelegramUser(channel)
    ? { accountId, threadId }
    : { accountId: null, threadId: null };
}

function currentFocus(): TelegramDownloadFocus {
  const { activeAccountId, accounts } = useAccountStore.getState();
  const channel = accounts.find(account => account.zalo_id === activeAccountId)?.channel;
  return telegramDownloadFocusOf(activeAccountId, channel, useChatStore.getState().activeThreadId);
}

const defaultSend = (focus: TelegramDownloadFocus) => ipc.telegramUser?.setDownloadFocus?.(focus);

export function installTelegramDownloadFocus(
  send: (focus: TelegramDownloadFocus) => unknown = defaultSend,
): () => void {
  let last: string | null = null;
  const update = () => {
    const focus = currentFocus();
    const key = `${focus.accountId ?? ''}\u0000${focus.threadId ?? ''}`;
    if (key === last) return;
    last = key;
    try {
      Promise.resolve(send(focus)).catch(() => {});
    } catch {
      // Chỉ là gợi ý thứ tự tải — không bao giờ làm hỏng việc đổi hội thoại
    }
  };
  const unsubscribeChat = useChatStore.subscribe(update);
  const unsubscribeAccount = useAccountStore.subscribe(update);
  update();
  return () => {
    unsubscribeChat();
    unsubscribeAccount();
  };
}
