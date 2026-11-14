/**
 * Dialog opened from a link clicked in the app (lib/chat/links/chatLinks), mounted once in App:
 *  - "Tham gia nhóm bằng link" (Join group by link) for a Zalo / Telegram group link not yet joined (preview, then Join, as in Zalo / Telegram);
 *  - asks "Bắt đầu" (Start) with the bot of a t.me/<bot>?start=… link, then sends messages.startBot (like Telegram's Start button);
 *  - "Chia sẻ tới" (Share to) for a t.me/share link (forward dialog in share mode): pick a conversation, the text is prefilled in the compose box;
 *  - the bot's notice box when a callback button is pressed (alert-style answer).
 * Telegram / group links opened via window.open or navigation (e.g. target="_blank" inside a Mini App): main sends them here
 * (app:openChatLink, electron/app/mainWindowLinks) and they open here, the same as clicking a link in a message.
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
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

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

/** Share link: pick a conversation (any account, as with forward) → the text goes into that conversation's compose box, the first conversation opens. */
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

/** Bot alert answer (callback button): a box with an OK button, as in Telegram. */
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
        notify(tr('Không bắt đầu được với {{name}}{{v1}}', { name, v1: res?.error ? `: ${res.error}` : '' }), 'error');
        return;
      }
      closeBotStart();
    } catch (err: any) {
      notify(tr('Không bắt đầu được với {{name}}: {{v1}}', { name, v1: err?.message || err }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) closeBotStart(); }} size="sm" className="max-w-[400px]">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle className="truncate">{trx('Bắt đầu với {{name}}?', { name })}</DialogTitle>
          <DialogDescription>{tr('Bot sẽ nhận lệnh /start từ link này.')}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={closeBotStart} disabled={busy}>{tr('Để sau')}</Button>
        <Button onClick={() => void start()} loading={busy}>{tr('Bắt đầu')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
