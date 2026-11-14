/**
 * Incoming Telegram call alert (event:telegramCall from main): a card in the top-right corner with "Từ chối" (Decline, phone.DiscardCall) and
 * "Mở chat" (Open chat). Deplao cannot answer calls yet (no tgcalls voice engine), so this is stated clearly for users to answer on their phone.
 * Mounted once in App (every screen).
 */
import React, { useEffect, useState } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { Button } from '@/components/ui';
import { CloseIcon, MessageIcon } from '@/components/common/icons';
import { accountLabel } from '../../quick/quickActions';
import { TelegramAvatar } from './TelegramUi';
import { PhoneGlyph } from './TelegramCallsDialog';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface RingingCall {
  zaloId: string;
  callId: string;
  accessHash: string;
  userId: string;
  name: string;
  avatar: string;
  video: boolean;
}

/** Open a conversation from any screen (like a reminder notification): switch account, select the conversation, load messages, go back to the chat screen. */
function openChatAnywhere(accountId: string, threadId: string, name: string, avatar: string): void {
  const chat = useChatStore.getState();
  if (!(chat.contacts[accountId] || []).some(contact => contact.contact_id === threadId)) {
    chat.updateContact(accountId, { contact_id: threadId, display_name: name, avatar_url: avatar, contact_type: 'user', channel: 'telegram_user' } as any);
  }
  useAccountStore.getState().setActiveAccount(accountId);
  chat.setActiveThread(threadId, 0);
  chat.clearUnread(accountId, threadId);
  DataAccessor.markAsRead({ zaloId: accountId, contactId: threadId }).catch(() => {});
  DataAccessor.getMessages({ zaloId: accountId, threadId, limit: 50, offset: 0 }).then((res: any) => {
    const messages = res?.messages || [];
    if (messages.length > 0) useChatStore.getState().setMessages(accountId, threadId, [...messages].reverse());
  }).catch(() => {});
  useAppStore.getState().setView('chat');
}

function CallCard({ call, onDone }: { call: RingingCall; onDone: () => void }) {
  const account = useAccountStore(s => s.accounts.find(item => item.zalo_id === call.zaloId));
  const [declining, setDeclining] = useState(false);
  const decline = async () => {
    setDeclining(true);
    try {
      const res = await ipc.telegramUser?.declineCall({ accountId: call.zaloId, callId: call.callId, accessHash: call.accessHash, video: call.video });
      if (!res?.success) useAppStore.getState().showNotification(res?.error || tr('Không từ chối được cuộc gọi'), 'error');
    } finally {
      setDeclining(false);
      onDone();
    }
  };
  return (
    <div role="alertdialog" aria-label={tr('Cuộc gọi Telegram từ {{name}}', { name: call.name })}
      className="pointer-events-auto w-80 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      style={{ animation: 'popupIn 160ms ease-out' }}>
      <div className="flex items-center gap-2 bg-primary/10 px-4 py-2 text-xs font-medium text-primary">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <PhoneGlyph video={call.video} className="h-3.5 w-3.5" />
        <span className="flex-1">{call.video ? tr('Cuộc gọi video Telegram đến') : tr('Cuộc gọi Telegram đến')}</span>
        <button type="button" onClick={onDone} aria-label={tr('Ẩn')} className="rounded p-0.5 text-primary/70 hover:text-primary">
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <TelegramAvatar id={call.userId} name={call.name} src={call.avatar} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{call.name}</p>
          <p className="truncate text-xs text-muted-foreground">{trx('Gọi tới {{v1}}', { v1: accountLabel(account) || tr('tài khoản Telegram') })}</p>
        </div>
      </div>
      <p className="px-4 text-[11px] leading-4 text-subtle-foreground">{tr('Nghe máy trên điện thoại hoặc Telegram Desktop — Deplao chưa nghe được cuộc gọi.')}</p>
      <div className="flex gap-2 px-4 pb-4 pt-3">
        <Button variant="destructive" size="sm" className="flex-1" loading={declining} onClick={() => void decline()}
          leftIcon={<PhoneGlyph className="h-3.5 w-3.5 rotate-[135deg]" />}>
          {tr('Từ chối')}
        </Button>
        <Button variant="outline" size="sm" className="flex-1" disabled={declining}
          onClick={() => { openChatAnywhere(call.zaloId, call.userId, call.name, call.avatar); onDone(); }}
          leftIcon={<MessageIcon className="h-3.5 w-3.5" />}>
          {tr('Mở chat')}
        </Button>
      </div>
    </div>
  );
}

export default function TelegramIncomingCall() {
  const [calls, setCalls] = useState<RingingCall[]>([]);

  useEffect(() => {
    const unsubscribe = ipc.on?.('event:telegramCall', (data: any) => {
      if (!data?.callId || !data?.zaloId) return;
      if (data.state === 'ringing') {
        setCalls(prev => (prev.some(call => call.callId === data.callId) ? prev : [...prev, {
          zaloId: String(data.zaloId), callId: String(data.callId), accessHash: String(data.accessHash || ''),
          userId: String(data.userId || ''), name: String(data.name || data.userId || 'Telegram'), avatar: String(data.avatar || ''),
          video: !!data.video,
        }]));
      } else if (data.state === 'ended') {
        setCalls(prev => {
          const ended = prev.find(call => call.callId === data.callId);
          if (ended && data.reason === 'missed') {
            useAppStore.getState().showNotification(tr('Cuộc gọi nhỡ Telegram từ {{name}}', { name: ended.name }), 'info');
          }
          return prev.filter(call => call.callId !== data.callId);
        });
      }
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  if (calls.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[95] flex flex-col gap-3">
      {calls.map(call => (
        <CallCard key={call.callId} call={call} onDone={() => setCalls(prev => prev.filter(item => item.callId !== call.callId))} />
      ))}
    </div>
  );
}
