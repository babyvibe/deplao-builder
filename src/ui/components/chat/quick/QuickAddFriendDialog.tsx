/**
 * Quick add friend. Zalo: search by phone number → send a friend request. Telegram: add a contact by
 * phone number or @username. Afterwards a "Nhắn tin" (Message) button opens the 1-1 conversation.
 */
import React, { useState } from 'react';
import type { AccountInfo } from '@/store/accounts/accountStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import {
  Badge, Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Textarea,
} from '@/components/ui';
import { SearchIcon } from '@/components/common/icons';
import { accountChannel, accountLabel, type OpenQuickConversation } from './quickActions';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const DEFAULT_GREETING = tr('Xin chào! Mình muốn kết bạn với bạn.');

interface FoundUser {
  id: string;
  name: string;
  avatar: string;
  /** Zalo: 1 = already a friend. */
  isFriend?: boolean;
  requested?: boolean;
  sub?: string;
}

function PersonCard({ user, children }: { user: FoundUser; children?: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
      {user.avatar && !failed
        ? <img src={toLocalMediaUrl(user.avatar)} alt="" onError={() => setFailed(true)} className="h-11 w-11 shrink-0 rounded-full object-cover" />
        : <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-foreground/80">{(user.name || '?').charAt(0).toUpperCase()}</span>}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
        {user.sub && <p className="truncate text-xs text-muted-foreground">{user.sub}</p>}
      </div>
      {children}
    </div>
  );
}

export default function QuickAddFriendDialog({ account, onClose, onOpenConversation, onAdded }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
  /** Contact added (Telegram) / request sent (Zalo): the contacts list that is open reloads. */
  onAdded?: () => void;
}) {
  const channel = accountChannel(account);
  const isZalo = channel === 'zalo';
  const [query, setQuery] = useState('');
  const [nickname, setNickname] = useState('');
  const [greeting, setGreeting] = useState(DEFAULT_GREETING);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);
  const [done, setDone] = useState('');

  const reset = (value: string) => { setQuery(value); setFound(null); setError(''); setDone(''); };

  const searchZalo = async () => {
    const phone = query.replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9) { setError(tr('Nhập số điện thoại Zalo')); return; }
    setBusy(true); setError(''); setFound(null); setDone('');
    try {
      const auth = buildZaloAuth(account, account.zalo_id);
      const res: any = await ipc.zalo?.findUser({ auth, phone });
      const user = res?.response;
      if (!user?.uid) { setError(tr('Không tìm thấy tài khoản Zalo với số này (hoặc họ tắt tìm theo số)')); return; }
      let isFriend = false;
      try {
        const info: any = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
        isFriend = info?.response?.changed_profiles?.[user.uid]?.isFr === 1;
      } catch { /* friend status is optional */ }
      setFound({ id: String(user.uid), name: user.display_name || user.zalo_name || phone, avatar: user.avatar || '', isFriend, sub: phone });
    } catch (err: any) {
      setError(err?.message || tr('Không tìm được'));
    } finally {
      setBusy(false);
    }
  };

  const sendZaloRequest = async () => {
    if (!found) return;
    setBusy(true); setError('');
    try {
      const res: any = await ipc.zalo?.sendFriendRequest({ auth: buildZaloAuth(account, account.zalo_id), userId: found.id, msg: greeting.trim() || DEFAULT_GREETING });
      if (res && res.success === false) { setError(res.error || tr('Gửi lời mời thất bại')); return; }
      setFound({ ...found, requested: true });
      setDone(tr('Đã gửi lời mời kết bạn tới {{name}}', { name: found.name }));
      onAdded?.();
    } catch (err: any) {
      setError(err?.message || tr('Gửi lời mời thất bại'));
    } finally {
      setBusy(false);
    }
  };

  const addTelegram = async () => {
    const value = query.trim();
    const byUsername = value.startsWith('@') || /[a-zA-Z_]/.test(value);
    if (!value) { setError(tr('Nhập số điện thoại hoặc @tên người dùng')); return; }
    setBusy(true); setError(''); setFound(null); setDone('');
    try {
      const res = await ipc.telegramUser?.addContact({
        accountId: account.zalo_id,
        ...(byUsername ? { username: value.replace(/^@/, '') } : { phone: value }),
        firstName: nickname.trim() || undefined,
      });
      if (!res?.success || !res.userId) { setError(res?.error || tr('Không thêm được liên hệ')); return; }
      setFound({ id: res.userId, name: res.displayName || value, avatar: '', sub: res.username ? `@${res.username}` : (res.phone ? `+${res.phone.replace(/^\+/, '')}` : '') });
      setDone(tr('Đã thêm {{v1}} vào danh bạ Telegram', { v1: res.displayName || value }));
      onAdded?.();
    } catch (err: any) {
      setError(err?.message || tr('Không thêm được liên hệ'));
    } finally {
      setBusy(false);
    }
  };

  const openChat = () => {
    if (!found) return;
    onOpenConversation(account.zalo_id, found.id, 0, { display_name: found.name, avatar_url: found.avatar, channel });
    onClose();
  };

  const primary = isZalo
    ? (found && !found.isFriend && !found.requested
      ? <Button onClick={() => void sendZaloRequest()} loading={busy}>{tr('Gửi lời mời kết bạn')}</Button>
      : found ? <Button onClick={openChat}>{tr('Nhắn tin')}</Button>
        : <Button onClick={() => void searchZalo()} loading={busy} disabled={!query.trim()}>{tr('Tìm')}</Button>)
    : (found
      ? <Button onClick={openChat}>{tr('Nhắn tin')}</Button>
      : <Button onClick={() => void addTelegram()} loading={busy} disabled={!query.trim()}>{tr('Thêm liên hệ')}</Button>);

  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }} size="sm">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{isZalo ? tr('Thêm bạn Zalo') : tr('Thêm liên hệ Telegram')}</DialogTitle>
          <DialogDescription>{trx('Bằng tài khoản {{v1}}', { v1: accountLabel(account) })}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="quick-friend-query" className="text-xs font-medium text-muted-foreground">
            {isZalo ? tr('Số điện thoại') : tr('Số điện thoại hoặc @tên người dùng')}
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input id="quick-friend-query" autoFocus value={query} onChange={e => reset(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !found) void (isZalo ? searchZalo() : addTelegram()); }}
              placeholder={isZalo ? '0912 345 678' : tr('0912 345 678 hoặc @ten_nguoi_dung')} className="pl-8" inputMode={isZalo ? 'tel' : 'text'} />
          </div>
        </div>

        {!isZalo && !found && (
          <div className="space-y-1.5">
            <label htmlFor="quick-friend-name" className="text-xs font-medium text-muted-foreground">{tr('Tên lưu trong danh bạ (không bắt buộc)')}</label>
            <Input id="quick-friend-name" value={nickname} onChange={e => setNickname(e.target.value)} placeholder={tr('Ví dụ: Chị Lan - khách sỉ')} />
          </div>
        )}

        {found && (
          <PersonCard user={found}>
            {isZalo && (found.isFriend
              ? <Badge size="sm" variant="success" dot>{tr('Bạn bè')}</Badge>
              : found.requested ? <Badge size="sm" variant="info" dot>{tr('Đã gửi lời mời')}</Badge> : null)}
          </PersonCard>
        )}

        {isZalo && found && !found.isFriend && !found.requested && (
          <div className="space-y-1.5">
            <label htmlFor="quick-friend-greeting" className="text-xs font-medium text-muted-foreground">{tr('Lời nhắn kèm lời mời')}</label>
            <Textarea id="quick-friend-greeting" value={greeting} maxLength={150} onChange={e => setGreeting(e.target.value)} className="min-h-[72px]" />
          </div>
        )}

        {done && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">{done}</p>}
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {isZalo && found && !found.isFriend && !found.requested && (
          <Button variant="ghost" onClick={openChat} disabled={busy}>{tr('Nhắn tin')}</Button>
        )}
        <Button variant="outline" onClick={onClose} disabled={busy}>{tr('Đóng')}</Button>
        {primary}
      </DialogFooter>
    </Dialog>
  );
}
