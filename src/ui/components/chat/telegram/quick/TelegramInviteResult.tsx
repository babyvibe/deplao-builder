/**
 * Người chưa thêm được vào nhóm / kênh (messages.InvitedUsers.missing_invitees). Như Telegram: người chặn vì quyền
 * riêng tư → gửi link mời bằng tin nhắn riêng; cần Telegram Premium → ghi rõ, không gửi được.
 */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { Badge, Button } from '@/components/ui';
import { CheckIcon, SendIcon } from '@/components/common/icons';
import type { TelegramMissingInvitee } from '../../../../../shared/telegram/telegramQuickModel';
import { TelegramAvatar } from './TelegramUi';

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

/** Ai nhận được link mời qua tin nhắn riêng. */
export function canSendInviteLink(person: TelegramMissingInvitee): boolean {
  return !person.premiumRequiredForPm && !person.error;
}

function reasonOf(person: TelegramMissingInvitee): string {
  if (person.error) return person.error;
  if (person.premiumWouldAllowInvite) return 'Cần Telegram Premium để thêm';
  if (person.premiumRequiredForPm) return 'Chỉ nhận tin nhắn từ tài khoản Premium';
  return 'Cài đặt riêng tư không cho thêm';
}

export default function TelegramInviteResult({ accountId, chatId, chatTitle, isChannel, people, names }: {
  accountId: string;
  chatId: string;
  chatTitle: string;
  isChannel: boolean;
  people: TelegramMissingInvitee[];
  /** Tên đã biết ở renderer (người vừa chọn) — main chỉ biết tên trong cache. */
  names?: Record<string, { name: string; avatar: string }>;
}) {
  const [states, setStates] = useState<Record<string, SendState>>({});
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const eligible = people.filter(canSendInviteLink);
  const pending = eligible.filter(person => states[person.userId] !== 'sent');
  const sending = Object.values(states).includes('sending');

  const sendAll = async () => {
    setError('');
    let inviteLink = link;
    if (!inviteLink) {
      const res = await ipc.telegramUser?.exportChatInvite({ accountId, chatId });
      if (!res?.success || !res.link) {
        setError(res?.error || 'Không lấy được link mời');
        return;
      }
      inviteLink = res.link;
      setLink(inviteLink);
    }
    const text = `Mời bạn tham gia ${isChannel ? 'kênh' : 'nhóm'} "${chatTitle}" trên Telegram: ${inviteLink}`;
    for (const person of pending) {
      setStates(prev => ({ ...prev, [person.userId]: 'sending' }));
      try {
        const res = await ipc.telegramUser?.sendMessage({ accountId, chatId: person.userId, text });
        setStates(prev => ({ ...prev, [person.userId]: res?.success ? 'sent' : 'failed' }));
      } catch {
        setStates(prev => ({ ...prev, [person.userId]: 'failed' }));
      }
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          {people.length} người chưa {isChannel ? 'được mời vào kênh' : 'được thêm vào nhóm'}
        </p>
        {eligible.length > 0 && (
          <Button size="sm" variant={pending.length ? 'primary' : 'outline'} onClick={() => void sendAll()} loading={sending}
            disabled={pending.length === 0 || sending} leftIcon={pending.length ? <SendIcon className="h-3.5 w-3.5" /> : <CheckIcon className="h-3.5 w-3.5" />}>
            {pending.length ? `Gửi link mời (${pending.length})` : 'Đã gửi link mời'}
          </Button>
        )}
      </div>
      <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border">
        {people.map(person => {
          const known = names?.[person.userId];
          const name = known?.name || person.name;
          const state = states[person.userId] || 'idle';
          return (
            <li key={person.userId} className="flex items-center gap-3 px-3 py-2">
              <TelegramAvatar id={person.userId} name={name} src={known?.avatar} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">{name}</span>
                <span className={cn('block truncate text-[11px]', person.error ? 'text-destructive' : 'text-muted-foreground')}>{reasonOf(person)}</span>
              </span>
              {state === 'sent' && <Badge size="sm" variant="success" dot>Đã gửi link</Badge>}
              {state === 'failed' && <Badge size="sm" variant="destructive">Gửi lỗi</Badge>}
              {state === 'sending' && <span className="text-[11px] text-muted-foreground">Đang gửi…</span>}
            </li>
          );
        })}
      </ul>
      {eligible.length > 0 && !error && (
        <p className="text-[11px] leading-4 text-subtle-foreground">
          Telegram không cho thêm thẳng những người này. Gửi link mời bằng tin nhắn riêng để họ tự bấm tham gia.
        </p>
      )}
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
