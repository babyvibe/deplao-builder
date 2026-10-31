/**
 * Thêm bạn nhanh. Zalo: tìm theo số điện thoại → gửi lời mời kết bạn. Telegram: thêm liên hệ theo
 * số điện thoại hoặc @tên người dùng. Xong có nút "Nhắn tin" mở hội thoại 1-1.
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

const DEFAULT_GREETING = 'Xin chào! Mình muốn kết bạn với bạn.';

interface FoundUser {
  id: string;
  name: string;
  avatar: string;
  /** Zalo: 1 = đã là bạn bè. */
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
  /** Đã thêm liên hệ (Telegram) / gửi lời mời (Zalo) — danh bạ đang mở tải lại. */
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
    if (phone.replace(/\D/g, '').length < 9) { setError('Nhập số điện thoại Zalo'); return; }
    setBusy(true); setError(''); setFound(null); setDone('');
    try {
      const auth = buildZaloAuth(account, account.zalo_id);
      const res: any = await ipc.zalo?.findUser({ auth, phone });
      const user = res?.response;
      if (!user?.uid) { setError('Không tìm thấy tài khoản Zalo với số này (hoặc họ tắt tìm theo số)'); return; }
      let isFriend = false;
      try {
        const info: any = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
        isFriend = info?.response?.changed_profiles?.[user.uid]?.isFr === 1;
      } catch { /* trạng thái bạn bè không bắt buộc */ }
      setFound({ id: String(user.uid), name: user.display_name || user.zalo_name || phone, avatar: user.avatar || '', isFriend, sub: phone });
    } catch (err: any) {
      setError(err?.message || 'Không tìm được');
    } finally {
      setBusy(false);
    }
  };

  const sendZaloRequest = async () => {
    if (!found) return;
    setBusy(true); setError('');
    try {
      const res: any = await ipc.zalo?.sendFriendRequest({ auth: buildZaloAuth(account, account.zalo_id), userId: found.id, msg: greeting.trim() || DEFAULT_GREETING });
      if (res && res.success === false) { setError(res.error || 'Gửi lời mời thất bại'); return; }
      setFound({ ...found, requested: true });
      setDone(`Đã gửi lời mời kết bạn tới ${found.name}`);
      onAdded?.();
    } catch (err: any) {
      setError(err?.message || 'Gửi lời mời thất bại');
    } finally {
      setBusy(false);
    }
  };

  const addTelegram = async () => {
    const value = query.trim();
    const byUsername = value.startsWith('@') || /[a-zA-Z_]/.test(value);
    if (!value) { setError('Nhập số điện thoại hoặc @tên người dùng'); return; }
    setBusy(true); setError(''); setFound(null); setDone('');
    try {
      const res = await ipc.telegramUser?.addContact({
        accountId: account.zalo_id,
        ...(byUsername ? { username: value.replace(/^@/, '') } : { phone: value }),
        firstName: nickname.trim() || undefined,
      });
      if (!res?.success || !res.userId) { setError(res?.error || 'Không thêm được liên hệ'); return; }
      setFound({ id: res.userId, name: res.displayName || value, avatar: '', sub: res.username ? `@${res.username}` : (res.phone ? `+${res.phone.replace(/^\+/, '')}` : '') });
      setDone(`Đã thêm ${res.displayName || value} vào danh bạ Telegram`);
      onAdded?.();
    } catch (err: any) {
      setError(err?.message || 'Không thêm được liên hệ');
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
      ? <Button onClick={() => void sendZaloRequest()} loading={busy}>Gửi lời mời kết bạn</Button>
      : found ? <Button onClick={openChat}>Nhắn tin</Button>
        : <Button onClick={() => void searchZalo()} loading={busy} disabled={!query.trim()}>Tìm</Button>)
    : (found
      ? <Button onClick={openChat}>Nhắn tin</Button>
      : <Button onClick={() => void addTelegram()} loading={busy} disabled={!query.trim()}>Thêm liên hệ</Button>);

  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }} size="sm">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{isZalo ? 'Thêm bạn Zalo' : 'Thêm liên hệ Telegram'}</DialogTitle>
          <DialogDescription>Bằng tài khoản {accountLabel(account)}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="quick-friend-query" className="text-xs font-medium text-muted-foreground">
            {isZalo ? 'Số điện thoại' : 'Số điện thoại hoặc @tên người dùng'}
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input id="quick-friend-query" autoFocus value={query} onChange={e => reset(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !found) void (isZalo ? searchZalo() : addTelegram()); }}
              placeholder={isZalo ? '0912 345 678' : '0912 345 678 hoặc @ten_nguoi_dung'} className="pl-8" inputMode={isZalo ? 'tel' : 'text'} />
          </div>
        </div>

        {!isZalo && !found && (
          <div className="space-y-1.5">
            <label htmlFor="quick-friend-name" className="text-xs font-medium text-muted-foreground">Tên lưu trong danh bạ (không bắt buộc)</label>
            <Input id="quick-friend-name" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Ví dụ: Chị Lan - khách sỉ" />
          </div>
        )}

        {found && (
          <PersonCard user={found}>
            {isZalo && (found.isFriend
              ? <Badge size="sm" variant="success" dot>Bạn bè</Badge>
              : found.requested ? <Badge size="sm" variant="info" dot>Đã gửi lời mời</Badge> : null)}
          </PersonCard>
        )}

        {isZalo && found && !found.isFriend && !found.requested && (
          <div className="space-y-1.5">
            <label htmlFor="quick-friend-greeting" className="text-xs font-medium text-muted-foreground">Lời nhắn kèm lời mời</label>
            <Textarea id="quick-friend-greeting" value={greeting} maxLength={150} onChange={e => setGreeting(e.target.value)} className="min-h-[72px]" />
          </div>
        )}

        {done && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">{done}</p>}
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {isZalo && found && !found.isFriend && !found.requested && (
          <Button variant="ghost" onClick={openChat} disabled={busy}>Nhắn tin</Button>
        )}
        <Button variant="outline" onClick={onClose} disabled={busy}>Đóng</Button>
        {primary}
      </DialogFooter>
    </Dialog>
  );
}
