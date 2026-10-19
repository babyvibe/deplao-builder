/**
 * Tạo nhóm Telegram / Messenger từ thao tác nhanh (Zalo dùng CreateGroupModal có sẵn).
 * Thành viên chọn từ các hội thoại 1-1 của tài khoản.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import type { AccountInfo } from '@/store/accountStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/localMedia';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@/components/ui';
import { CheckIcon, CloseIcon, SearchIcon } from '@/components/common/icons';
import { accountChannel, accountLabel, foldText, type OpenQuickConversation } from './quickActions';

const NO_CONTACTS: any[] = [];

interface MemberOption { id: string; name: string; avatar: string; sub: string; time: number }

function MemberAvatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <img src={toLocalMediaUrl(src)} alt="" onError={() => setFailed(true)} className="h-8 w-8 shrink-0 rounded-full object-cover" />
  ) : (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-foreground/80">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

export default function QuickCreateGroupDialog({ account, onClose, onOpenConversation }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const channel = accountChannel(account);
  const isFacebook = channel === 'facebook';
  const minMembers = isFacebook ? 2 : 0;
  const storeContacts = useChatStore(s => s.contacts[account.zalo_id] || NO_CONTACTS);
  const [loadedContacts, setLoadedContacts] = useState<any[] | null>(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Hộp thư chỉ nạp hội thoại của tài khoản đang xem → tài khoản khác đọc từ DB.
  useEffect(() => {
    if (storeContacts.length > 0) return undefined;
    let cancelled = false;
    DataAccessor.getConversations(account.zalo_id, 500)
      .then((res: any) => { if (!cancelled) setLoadedContacts(Array.isArray(res?.items) ? res.items : []); })
      .catch(() => { if (!cancelled) setLoadedContacts([]); });
    return () => { cancelled = true; };
  }, [account.zalo_id, storeContacts.length]);

  const options = useMemo<MemberOption[]>(() => {
    const source: any[] = storeContacts.length > 0 ? storeContacts : (loadedContacts || []);
    return source
      .filter(c => c?.contact_id && c.contact_type !== 'group' && String(c.contact_id) !== account.zalo_id)
      .map(c => ({
        id: String(c.contact_id),
        name: c.alias || c.display_name || String(c.contact_id),
        avatar: c.avatar_url || '',
        // Chỉ hiện số điện thoại — id Telegram / Facebook không giúp nhận ra người (vẫn tìm được theo id)
        sub: c.phone || '',
        time: Number(c.last_message_time || 0),
      }))
      .sort((a, b) => b.time - a.time);
  }, [storeContacts, loadedContacts, account.zalo_id]);

  const visible = useMemo(() => {
    const needle = foldText(query.trim());
    const list = needle ? options.filter(o => foldText(`${o.name} ${o.id} ${o.sub}`).includes(needle)) : options;
    return list.slice(0, 300);
  }, [options, query]);

  const byId = useMemo(() => new Map(options.map(o => [o.id, o])), [options]);
  const toggle = (id: string) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const loading = storeContacts.length === 0 && loadedContacts === null;
  const nameMissing = !isFacebook && !name.trim();
  const tooFew = selected.length < minMembers;
  const canCreate = !creating && !nameMissing && !tooFew;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError('');
    try {
      const title = name.trim();
      const res: any = isFacebook
        ? await ipc.fb?.createGroup({ accountId: account.zalo_id, participants: selected, name: title })
        : await ipc.telegramUser?.createGroup({ accountId: account.zalo_id, title, userIds: selected });
      if (!res?.success) {
        setError(res?.error || 'Không tạo được nhóm');
        return;
      }
      const threadId = String((isFacebook ? res.threadId : res.chatId) || '');
      const notes: string[] = [`Đã tạo nhóm "${title || 'mới'}"`];
      if (!isFacebook && Number(res.missing) > 0) notes.push(`${res.missing} người không thêm được do cài đặt riêng tư`);
      if (isFacebook && res.renameError) notes.push('chưa đặt được tên — đổi tên trong thông tin nhóm');
      useAppStore.getState().showNotification(notes.join(' · '), notes.length > 1 ? 'warning' : 'success');
      if (threadId) onOpenConversation(account.zalo_id, threadId, 1, { display_name: title, channel });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Không tạo được nhóm');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !creating) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{isFacebook ? 'Tạo nhóm Messenger' : 'Tạo nhóm Telegram'}</DialogTitle>
          <DialogDescription>Bằng tài khoản {accountLabel(account)}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="quick-group-name">
            Tên nhóm{isFacebook ? ' (không bắt buộc)' : ''}
          </label>
          <Input id="quick-group-name" autoFocus value={name} maxLength={128} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create(); }}
            placeholder={isFacebook ? 'Nhóm Messenger mới' : 'Ví dụ: Khách hàng VIP'} />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Thành viên</span>
            <span className="text-[11px] text-subtle-foreground">
              {selected.length > 0 ? `Đã chọn ${selected.length}` : isFacebook ? 'Chọn ít nhất 2 người' : 'Có thể để trống'}
            </span>
          </div>
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.map(id => {
                const option = byId.get(id);
                return (
                  <span key={id} className="inline-flex max-w-[12rem] items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-primary">
                    <span className="truncate">{option?.name || id}</span>
                    <button type="button" onClick={() => toggle(id)} aria-label={`Bỏ ${option?.name || id}`}
                      className="rounded-full p-0.5 hover:bg-primary/15"><CloseIcon className="h-3 w-3" /></button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm theo tên, số điện thoại…" className="h-8 pl-8 text-[13px]" />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            {loading ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">Đang tải danh sách…</p>
            ) : visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {options.length === 0 ? 'Tài khoản chưa có hội thoại 1-1 nào' : 'Không có ai khớp'}
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {visible.map(option => {
                  const checked = selected.includes(option.id);
                  return (
                    <li key={option.id}>
                      <button type="button" onClick={() => toggle(option.id)} aria-pressed={checked}
                        className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors', checked ? 'bg-selected' : 'hover:bg-muted/60')}>
                        <MemberAvatar src={option.avatar} name={option.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-foreground">{option.name}</span>
                          {option.sub && <span className="block truncate font-mono text-[11px] text-subtle-foreground">{option.sub}</span>}
                        </span>
                        <span className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
                        )}>
                          {checked && <CheckIcon className="h-3 w-3" />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="text-[11px] leading-4 text-subtle-foreground">
            {isFacebook
              ? 'Nhóm Messenger cần từ 3 người trở lên (gồm bạn).'
              : 'Không chọn ai: tạo siêu nhóm trống để mời sau. Người chặn được thêm vào nhóm sẽ bị bỏ qua.'}
          </p>
        </div>
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={creating}>Huỷ</Button>
        <Button onClick={() => void create()} loading={creating} disabled={!canCreate}>Tạo nhóm</Button>
      </DialogFooter>
    </Dialog>
  );
}
