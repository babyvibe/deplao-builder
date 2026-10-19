/**
 * Báo cuộc gọi Telegram đến (event:telegramCall từ main): thẻ ở góc trên phải với "Từ chối" (phone.DiscardCall) và
 * "Mở chat". Deplao chưa nghe máy được (không có bộ thoại tgcalls) — ghi rõ để người dùng nghe trên điện thoại.
 * Gắn một lần ở App (mọi màn hình).
 */
import React, { useEffect, useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { Button } from '@/components/ui';
import { CloseIcon, MessageIcon } from '@/components/common/icons';
import { accountLabel } from '../quickActions';
import { TelegramAvatar } from './TelegramUi';
import { PhoneGlyph } from './TelegramCallsDialog';

interface RingingCall {
  zaloId: string;
  callId: string;
  accessHash: string;
  userId: string;
  name: string;
  avatar: string;
  video: boolean;
}

/** Mở hội thoại từ bất kỳ màn hình nào (như thông báo nhắc hẹn): đổi tài khoản, chọn hội thoại, tải tin, về màn chat. */
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
      if (!res?.success) useAppStore.getState().showNotification(res?.error || 'Không từ chối được cuộc gọi', 'error');
    } finally {
      setDeclining(false);
      onDone();
    }
  };
  return (
    <div role="alertdialog" aria-label={`Cuộc gọi Telegram từ ${call.name}`}
      className="pointer-events-auto w-80 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      style={{ animation: 'popupIn 160ms ease-out' }}>
      <div className="flex items-center gap-2 bg-primary/10 px-4 py-2 text-xs font-medium text-primary">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <PhoneGlyph video={call.video} className="h-3.5 w-3.5" />
        <span className="flex-1">{call.video ? 'Cuộc gọi video Telegram đến' : 'Cuộc gọi Telegram đến'}</span>
        <button type="button" onClick={onDone} aria-label="Ẩn" className="rounded p-0.5 text-primary/70 hover:text-primary">
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <TelegramAvatar id={call.userId} name={call.name} src={call.avatar} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{call.name}</p>
          <p className="truncate text-xs text-muted-foreground">Gọi tới {accountLabel(account) || 'tài khoản Telegram'}</p>
        </div>
      </div>
      <p className="px-4 text-[11px] leading-4 text-subtle-foreground">Nghe máy trên điện thoại hoặc Telegram Desktop — Deplao chưa nghe được cuộc gọi.</p>
      <div className="flex gap-2 px-4 pb-4 pt-3">
        <Button variant="destructive" size="sm" className="flex-1" loading={declining} onClick={() => void decline()}
          leftIcon={<PhoneGlyph className="h-3.5 w-3.5 rotate-[135deg]" />}>
          Từ chối
        </Button>
        <Button variant="outline" size="sm" className="flex-1" disabled={declining}
          onClick={() => { openChatAnywhere(call.zaloId, call.userId, call.name, call.avatar); onDone(); }}
          leftIcon={<MessageIcon className="h-3.5 w-3.5" />}>
          Mở chat
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
            useAppStore.getState().showNotification(`Cuộc gọi nhỡ Telegram từ ${ended.name}`, 'info');
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
