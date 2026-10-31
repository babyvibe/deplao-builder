/**
 * "Danh bạ" Telegram (contacts.GetContacts): tìm, xem trạng thái truy cập, nhắn tin, xoá khỏi danh bạ, thêm liên hệ.
 * Sắp như Telegram: đang trực tuyến trước rồi theo lần truy cập gần nhất.
 */
import React, { useMemo, useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import type { AccountInfo } from '@/store/accounts/accountStore';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import {
  Badge, Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@/components/ui';
import { MessageIcon, RefreshIcon, SearchIcon, TrashIcon, UserPlusIcon } from '@/components/common/icons';
import { foldText, accountLabel, type OpenQuickConversation } from '../../quick/quickActions';
import QuickAddFriendDialog from '../../quick/QuickAddFriendDialog';
import { invalidateTelegramContacts, presenceLine, useTelegramContacts } from './telegramPeople';
import { Notice, TelegramAvatar } from './TelegramUi';

export default function TelegramContactsDialog({ account, onClose, onOpenConversation }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const accountId = account.zalo_id;
  const contacts = useTelegramContacts(accountId);
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const now = Date.now();

  const needle = foldText(query.trim().replace(/^@/, ''));
  const list = useMemo(() => {
    const all = contacts.contacts || [];
    return needle ? all.filter(contact => foldText(`${contact.name} ${contact.username} ${contact.phone} ${contact.id}`).includes(needle)) : all;
  }, [contacts.contacts, needle]);
  const onlineCount = useMemo(
    () => (contacts.contacts || []).filter(contact => presenceLine(contact.presence, now).online).length,
    [contacts.contacts, now],
  );

  const openChat = (id: string, name: string, avatar: string) => {
    onOpenConversation(accountId, id, 0, { display_name: name, avatar_url: avatar, channel: 'telegram_user' });
    onClose();
  };

  const remove = async (id: string, name: string) => {
    setDeleting(id);
    try {
      const res = await ipc.telegramUser?.deleteContacts({ accountId, userIds: [id] });
      if (!res?.success) {
        useAppStore.getState().showNotification(res?.error || 'Không xoá được liên hệ', 'error');
        return;
      }
      contacts.removeLocal([id]);
      useAppStore.getState().showNotification(`Đã xoá ${name} khỏi danh bạ Telegram`, 'success');
    } finally {
      setDeleting(null);
      setConfirmId(null);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={next => { if (!next) onClose(); }} size="md">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>Danh bạ Telegram</DialogTitle>
            <DialogDescription>
              {accountLabel(account)}
              {contacts.contacts ? ` · ${contacts.contacts.length} liên hệ${onlineCount ? ` · ${onlineCount} đang trực tuyến` : ''}` : ''}
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
              <Input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm theo tên, @tên, số điện thoại…"
                aria-label="Tìm liên hệ" className="h-9 pl-8 text-[13px]" />
            </div>
            <Button size="icon" variant="outline" onClick={() => void contacts.reload()} title="Tải lại" aria-label="Tải lại danh bạ">
              <RefreshIcon className={cn('h-4 w-4', contacts.loading && 'animate-spin')} />
            </Button>
            <Button size="sm" onClick={() => setAdding(true)} leftIcon={<UserPlusIcon className="h-4 w-4" />}>Thêm</Button>
          </div>

          {contacts.error && <Notice tone="error">{contacts.error}</Notice>}

          <div className="max-h-[22rem] min-h-[12rem] overflow-y-auto rounded-xl border border-border p-1">
            {contacts.loading && !contacts.contacts ? (
              <p className="px-3 py-10 text-center text-xs text-muted-foreground">Đang tải danh bạ…</p>
            ) : list.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-muted-foreground">
                {needle ? 'Không có ai khớp' : 'Danh bạ Telegram trống — bấm "Thêm" để thêm liên hệ'}
              </p>
            ) : (
              <ul>
                {list.slice(0, 500).map(contact => {
                  const presence = presenceLine(contact.presence, now);
                  const confirming = confirmId === contact.id;
                  return (
                    <li key={contact.id} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-muted/60">
                      <span className="relative shrink-0">
                        <TelegramAvatar id={contact.id} name={contact.name} src={contact.avatar} size={38} />
                        {presence.online && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-success ring-2 ring-popover" aria-label="Đang trực tuyến" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-foreground">{contact.name}</span>
                          {contact.mutual && <Badge size="sm" variant="primary">Lưu nhau</Badge>}
                          {contact.bot && <Badge size="sm">Bot</Badge>}
                        </span>
                        <span className={cn('block truncate text-[11px]', presence.online ? 'text-primary' : 'text-muted-foreground')}>
                          {[presence.text, contact.username ? `@${contact.username}` : '', contact.phone ? `+${contact.phone}` : ''].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {confirming ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">Xoá khỏi danh bạ?</span>
                          <Button size="sm" variant="destructive" loading={deleting === contact.id} onClick={() => void remove(contact.id, contact.name)}>Xoá</Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)} disabled={deleting === contact.id}>Huỷ</Button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                          <Button size="sm" variant="ghost" onClick={() => openChat(contact.id, contact.name, contact.avatar)}
                            leftIcon={<MessageIcon className="h-3.5 w-3.5" />}>Nhắn tin</Button>
                          <button type="button" onClick={() => setConfirmId(contact.id)} title="Xoá khỏi danh bạ" aria-label={`Xoá ${contact.name} khỏi danh bạ`}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="text-[11px] leading-4 text-subtle-foreground">
            Xoá khỏi danh bạ không xoá hội thoại. "Lưu nhau" = hai bên đã lưu số của nhau.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Đóng</Button>
        </DialogFooter>
      </Dialog>

      {adding && (
        <QuickAddFriendDialog
          account={account}
          onClose={() => setAdding(false)}
          onOpenConversation={(...args) => { onOpenConversation(...args); onClose(); }}
          onAdded={() => { invalidateTelegramContacts(accountId); void contacts.reload(); }}
        />
      )}
    </>
  );
}
