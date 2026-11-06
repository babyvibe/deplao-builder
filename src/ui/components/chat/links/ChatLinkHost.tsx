/**
 * Hộp mở từ link bấm trong app (lib/chat/links/chatLinks), đặt 1 lần ở App:
 *  - "Tham gia nhóm bằng link" có sẵn link nhóm Zalo / Telegram chưa tham gia (xem trước rồi Tham gia, như Zalo / Telegram);
 *  - hỏi "Bắt đầu" với bot của link t.me/<bot>?start=… rồi mới gửi messages.startBot (như nút Bắt đầu của Telegram);
 *  - "Chia sẻ tới" của link t.me/share (hộp chuyển tiếp ở chế độ chia sẻ): chọn hội thoại, chữ điền sẵn ô soạn tin;
 *  - hộp thông báo của bot khi bấm nút callback (câu trả lời dạng alert).
 * Link Telegram / nhóm Zalo đi qua window.open hoặc điều hướng (vd target="_blank" trong Mini App): main gửi về
 * (app:openChatLink, electron/app/mainWindowLinks) và mở ở đây như bấm link trong tin.
 */
import React from 'react';
import { Button, Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import ipc from '@/lib/ipc';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useVisibleAccounts } from '@/hooks/accounts/useVisibleAccounts';
import { openConversation } from '@/lib/chat/conversations/openConversation';
import {
  closeBotAlert, closeBotStart, closeGroupJoinDialog, closeShareDialog, openChatLink, prefillComposer, useBotAlertRequest,
  useBotStartRequest, useGroupJoinRequest, useShareRequest, type BotAlertRequest, type BotStartRequest, type ShareRequest,
} from '@/lib/chat/links/chatLinks';
import QuickJoinLinkDialog from '../quick/QuickJoinLinkDialog';
import ForwardMessageModal from '../messages/ForwardMessageModal';
import { accountChannel, orderQuickAccounts, quickActionSupport } from '../quick/quickActions';

export function ChatLinkHost() {
  const join = useGroupJoinRequest();
  const botStart = useBotStartRequest();
  const share = useShareRequest();
  const botAlert = useBotAlertRequest();
  React.useEffect(() => ipc.on?.('app:openChatLink', (url: unknown) => { openChatLink(String(url || '')); }), []);
  return (
    <>
      {join && <ChatLinkJoin key={join.key} link={join.link} accountId={join.accountId} />}
      {botStart && <BotStartDialog key={botStart.key} request={botStart} />}
      {share && <ShareDialog key={share.key} request={share} />}
      {botAlert && <BotAlertDialog key={botAlert.key} request={botAlert} />}
    </>
  );
}

/** Link chia sẻ: chọn hội thoại (mọi tài khoản như chuyển tiếp) → điền chữ vào ô soạn tin từng hội thoại, mở hội thoại đầu. */
function ShareDialog({ request }: { request: ShareRequest }) {
  return (
    <ForwardMessageModal
      mode="share"
      messages={[]}
      initialText={request.text}
      onClose={closeShareDialog}
      onForward={(_messages, targets, text) => {
        closeShareDialog();
        const value = text.trim();
        if (!targets.length || !value) return;
        for (const target of targets) prefillComposer(target.accountId, target.threadId, value);
        const first = targets[0];
        openConversation({ accountId: first.accountId, threadId: first.threadId, threadType: first.threadType === 1 ? 1 : 0 });
      }}
    />
  );
}

/** Câu trả lời dạng alert của bot (nút callback): hộp có nút OK, như Telegram. */
function BotAlertDialog({ request }: { request: BotAlertRequest }) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) closeBotAlert(); }} size="sm" className="max-w-[400px]">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle className="truncate">{request.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">{request.message}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogFooter>
        <Button onClick={closeBotAlert}>OK</Button>
      </DialogFooter>
    </Dialog>
  );
}

function ChatLinkJoin({ link, accountId }: { link: string; accountId: string }) {
  const accounts = useVisibleAccounts();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const entries = React.useMemo(() => orderQuickAccounts(accounts, {
    activeAccountId, mergedInboxMode: false, mergedInboxAccounts: [], mergedInboxFilterAccount: null,
  }), [accounts, activeAccountId]);
  const disabledReason = React.useCallback((account: AccountInfo) => {
    const support = quickActionSupport('joinLink', accountChannel(account));
    return 'reason' in support ? support.reason : null;
  }, []);
  return (
    <QuickJoinLinkDialog
      entries={entries}
      initialAccountId={accountId}
      initialLink={link}
      disabledReason={disabledReason}
      onClose={closeGroupJoinDialog}
      onOpenConversation={(id, threadId, threadType, info) => openConversation({ accountId: id, threadId, threadType, ...(info ? { info } : {}) })}
    />
  );
}

function BotStartDialog({ request }: { request: BotStartRequest }) {
  const [busy, setBusy] = React.useState(false);
  const notify = useAppStore((s) => s.showNotification);
  const name = request.botName || 'bot';

  const start = async () => {
    setBusy(true);
    try {
      const res = await ipc.telegramUser?.startBot?.({ accountId: request.accountId, botId: request.botId, startParam: request.startParam });
      if (!res?.success) {
        notify(`Không bắt đầu được với ${name}${res?.error ? `: ${res.error}` : ''}`, 'error');
        return;
      }
      closeBotStart();
    } catch (err: any) {
      notify(`Không bắt đầu được với ${name}: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) closeBotStart(); }} size="sm" className="max-w-[400px]">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle className="truncate">Bắt đầu với {name}?</DialogTitle>
          <DialogDescription>Bot sẽ nhận lệnh /start từ link này.</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={closeBotStart} disabled={busy}>Để sau</Button>
        <Button onClick={() => void start()} loading={busy}>Bắt đầu</Button>
      </DialogFooter>
    </Dialog>
  );
}
