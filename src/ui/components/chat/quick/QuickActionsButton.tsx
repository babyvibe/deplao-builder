/**
 * Nút "Thao tác nhanh" cạnh ô tìm kiếm hội thoại: tạo nhóm (Zalo / Telegram / Messenger), tham gia nhóm bằng link,
 * thêm bạn (Zalo / Telegram), thêm lịch hẹn + ghi chú nhanh (Quản lý công việc). Tài khoản Telegram có thêm các mục
 * như menu của Telegram: Kênh mới, Danh bạ, Cuộc gọi.
 * Tài khoản thao tác chọn ngay trong menu: thường → tài khoản đang mở; gộp trang → tài khoản đang lọc / đang mở / đầu
 * tiên của trang gộp (quy tắc ở quickActions.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/appStore';
import { useAccountStore, type AccountInfo } from '@/store/accountStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useFeatureVisibilityStore } from '@/store/featureVisibilityStore';
import { useVisibleAccounts } from '@/hooks/useVisibleAccounts';
import { useErpPermissions } from '@/hooks/erp/useErpContext';
import { cn } from '@/lib/cn';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui';
import {
  ArrowLeftIcon, BookIcon, CalendarIcon, CheckIcon, ChevronDownIcon, FileTextIcon, LinkIcon, PhoneIcon, PlusIcon,
  UserPlusIcon, UsersIcon,
} from '@/components/common/icons';
import { CreateGroupModal } from '../GroupModals';
import { QuickAccountAvatar } from './QuickAccountPicker';
import QuickCreateGroupDialog from './QuickCreateGroupDialog';
import QuickJoinLinkDialog from './QuickJoinLinkDialog';
import QuickAddFriendDialog from './QuickAddFriendDialog';
import { QuickEventDialog, QuickNoteDialog } from './QuickErpDialogs';
import TelegramNewGroupDialog from './telegram/TelegramNewGroupDialog';
import TelegramNewChannelDialog from './telegram/TelegramNewChannelDialog';
import TelegramContactsDialog from './telegram/TelegramContactsDialog';
import TelegramCallsDialog from './telegram/TelegramCallsDialog';
import { MegaphoneGlyph } from './telegram/TelegramUi';
import {
  CHANNEL_SHORT_LABEL, accountChannel, accountLabel, defaultQuickAccountId, orderQuickAccounts, quickActionSupport, quickActionVisible,
  type OpenQuickConversation, type QuickActionId, type QuickModeState,
} from './quickActions';

type QuickDialog =
  | { kind: 'createGroup' | 'createChannel' | 'addFriend' | 'contacts' | 'calls'; account: AccountInfo }
  | { kind: 'joinLink'; accountId: string | null }
  | { kind: 'event' | 'note' };

const CREATE_GROUP_LABEL: Record<string, { title: string; hint: string }> = {
  zalo: { title: 'Tạo nhóm Zalo', hint: 'Chọn bạn bè theo nhãn, đặt tên nhóm' },
  telegram_user: { title: 'Nhóm mới', hint: 'Chọn thành viên, đặt tên + ảnh nhóm' },
  facebook: { title: 'Tạo nhóm Messenger', hint: 'Từ 2 người trở lên' },
};

const ADD_FRIEND_LABEL: Record<string, { title: string; hint: string }> = {
  zalo: { title: 'Thêm bạn Zalo', hint: 'Tìm theo số điện thoại, gửi lời mời' },
  telegram_user: { title: 'Thêm liên hệ Telegram', hint: 'Theo số điện thoại hoặc @tên người dùng' },
};

/** Lịch / ghi chú: giống điều kiện hiện mục "Quản lý công việc" ở Sidebar + quyền tạo tương ứng. */
function useQuickErpAccess(): { event: boolean; note: boolean } {
  const erpVisible = useFeatureVisibilityStore(s => s.enabled.erp);
  const erpModule = useEmployeeStore(s => s.hasPermission('erp'));
  const { can } = useErpPermissions();
  const base = erpVisible && erpModule && can('erp.access');
  return { event: base && can('calendar.create_personal'), note: base && can('note.create') };
}

function ActionItem({ icon, title, hint, reason, onSelect }: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  /** Có lý do → mục bị khoá, hiện lý do thay cho gợi ý. */
  reason?: string | null;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem icon={icon} disabled={!!reason} onSelect={onSelect} className="py-2">
      <span className="block truncate text-[13px]">{title}</span>
      {/* Lý do khoá được xuống dòng (không cắt chữ) — người dùng cần đọc đủ */}
      <span className={cn('block text-[11px] leading-4', reason ? 'whitespace-normal text-warning' : 'truncate text-muted-foreground')}>{reason || hint}</span>
    </DropdownMenuItem>
  );
}

export default function QuickActionsButton({ activeThread, onOpenConversation }: {
  /** Hội thoại đang mở — cho phép gắn lịch hẹn với hội thoại. */
  activeThread?: { id: string; name: string } | null;
  onOpenConversation: OpenQuickConversation;
}) {
  const accounts = useVisibleAccounts();
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const { mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount } = useAppStore(useShallow(s => ({
    mergedInboxMode: s.mergedInboxMode,
    mergedInboxAccounts: s.mergedInboxAccounts,
    mergedInboxFilterAccount: s.mergedInboxFilterAccount,
  })));
  const erp = useQuickErpAccess();

  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<'main' | 'accounts'>('main');
  const [dialog, setDialog] = useState<QuickDialog | null>(null);
  // Tài khoản người dùng tự chọn — chỉ giữ khi ngữ cảnh (tài khoản mặc định) chưa đổi.
  const [choice, setChoice] = useState<{ base: string | null; id: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const mode = useMemo<QuickModeState>(() => ({
    activeAccountId, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount,
  }), [activeAccountId, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount]);
  const entries = useMemo(() => orderQuickAccounts(accounts, mode), [accounts, mode]);
  const defaultId = useMemo(() => defaultQuickAccountId(accounts, mode), [accounts, mode]);
  const selectedId = choice && choice.base === defaultId && accounts.some(a => a.zalo_id === choice.id) ? choice.id : defaultId;
  const selected = accounts.find(a => a.zalo_id === selectedId) || null;
  const channel = accountChannel(selected);

  const supportReason = useCallback((action: QuickActionId, account: AccountInfo | null): string | null => {
    if (!account) return 'Chưa có tài khoản';
    const support = quickActionSupport(action, accountChannel(account));
    return 'reason' in support ? support.reason : null;
  }, []);
  const joinDisabledReason = useCallback((account: AccountInfo) => supportReason('joinLink', account), [supportReason]);
  const canJoinAny = accounts.some(account => !supportReason('joinLink', account));

  // Đổi màn (tài khoản ↔ thao tác): mục vừa bấm biến mất → đưa focus về mục đầu để phím ↑/↓ vẫn chạy.
  const viewChanged = useRef(false);
  useEffect(() => {
    if (!viewChanged.current) return;
    viewChanged.current = false;
    bodyRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [view]);
  const switchView = (next: 'main' | 'accounts') => { viewChanged.current = true; setView(next); };

  const open = (next: QuickDialog) => setDialog(next);
  const close = () => setDialog(null);

  if (accounts.length === 0 && !erp.event && !erp.note) return null;

  const createReason = supportReason('createGroup', selected);
  const createLabel = CREATE_GROUP_LABEL[channel] || { title: 'Tạo nhóm', hint: '' };
  const friendReason = supportReason('addFriend', selected);
  const friendLabel = ADD_FRIEND_LABEL[channel] || { title: 'Thêm bạn', hint: '' };
  const hasMergedSection = entries.some(entry => entry.inMerged);

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={next => { setMenuOpen(next); if (!next) setView('main'); }}
        align="end"
        className="w-72 p-1.5"
        trigger={(
          <button type="button" title="Tạo nhóm / kênh, tham gia nhóm, thêm bạn, danh bạ, cuộc gọi, lịch hẹn, ghi chú" aria-label="Thao tác nhanh"
            className={cn(
              'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              menuOpen && 'bg-muted text-foreground',
            )}>
            <PlusIcon className="h-[18px] w-[18px]" />
          </button>
        )}
      >
        <div ref={bodyRef}>
          {view === 'accounts' ? (
            <>
              <DropdownMenuItem icon={<ArrowLeftIcon />} onClick={e => { e.preventDefault(); switchView('main'); }}>
                <span className="text-[13px] font-medium">Chọn tài khoản thao tác</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="max-h-72 overflow-y-auto">
                {entries.map((entry, index) => {
                  const account = entry.account;
                  const active = account.zalo_id === selectedId;
                  const showMergedHeader = hasMergedSection && index === 0 && entry.inMerged;
                  const showOthersHeader = hasMergedSection && !entry.inMerged && (index === 0 || entries[index - 1].inMerged);
                  return (
                    <React.Fragment key={account.zalo_id}>
                      {showMergedHeader && <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-wide">Trang gộp</DropdownMenuLabel>}
                      {showOthersHeader && <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-wide">Tài khoản khác</DropdownMenuLabel>}
                      <DropdownMenuItem
                        aria-current={active || undefined}
                        className={cn(active && 'bg-selected')}
                        onClick={e => {
                          e.preventDefault();
                          setChoice({ base: defaultId, id: account.zalo_id });
                          switchView('main');
                        }}>
                        <span className="flex items-center gap-2.5">
                          <QuickAccountAvatar account={account} size={26} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px]">{accountLabel(account)}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {CHANNEL_SHORT_LABEL[accountChannel(account)] || accountChannel(account)}
                              {entry.isActive && ' · đang mở'}
                            </span>
                          </span>
                          {active && <CheckIcon className="h-4 w-4 shrink-0 text-primary" />}
                        </span>
                      </DropdownMenuItem>
                    </React.Fragment>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {selected && (
                <>
                  <DropdownMenuLabel className="pb-1 pt-1 text-[10px] uppercase tracking-wide">Thao tác bằng tài khoản</DropdownMenuLabel>
                  {accounts.length > 1 ? (
                    <DropdownMenuItem className="py-1.5" onClick={e => { e.preventDefault(); switchView('accounts'); }}>
                      <span className="flex items-center gap-2.5">
                        <QuickAccountAvatar account={selected} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{accountLabel(selected)}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {CHANNEL_SHORT_LABEL[channel] || channel}
                            {selected.zalo_id === activeAccountId ? ' · đang mở' : ''}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-primary">
                          Đổi<ChevronDownIcon className="h-3.5 w-3.5 -rotate-90" />
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ) : (
                    <div className="flex items-center gap-2.5 px-2 py-1.5">
                      <QuickAccountAvatar account={selected} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{accountLabel(selected)}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{CHANNEL_SHORT_LABEL[channel] || channel}</span>
                      </span>
                    </div>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}

              {accounts.length > 0 && (
                <>
                  <ActionItem icon={<UsersIcon />} title={createLabel.title} hint={createLabel.hint} reason={createReason}
                    onSelect={() => { if (selected) open({ kind: 'createGroup', account: selected }); }} />
                  {selected && quickActionVisible('createChannel', channel) && (
                    <ActionItem icon={<MegaphoneGlyph />} title="Kênh mới" hint="Phát tin tới nhiều người theo dõi"
                      reason={supportReason('createChannel', selected)}
                      onSelect={() => open({ kind: 'createChannel', account: selected })} />
                  )}
                  <ActionItem icon={<LinkIcon />} title="Tham gia nhóm bằng link" hint="Dán link Zalo / Telegram, tự chọn tài khoản"
                    reason={canJoinAny ? null : 'Cần tài khoản Zalo hoặc Telegram'}
                    onSelect={() => open({ kind: 'joinLink', accountId: selected && !supportReason('joinLink', selected) ? selected.zalo_id : null })} />
                  <ActionItem icon={<UserPlusIcon />} title={friendLabel.title} hint={friendLabel.hint} reason={friendReason}
                    onSelect={() => { if (selected) open({ kind: 'addFriend', account: selected }); }} />
                  {selected && (quickActionVisible('contacts', channel) || quickActionVisible('calls', channel)) && (
                    <>
                      <DropdownMenuSeparator />
                      {quickActionVisible('contacts', channel) && (
                        <ActionItem icon={<BookIcon />} title="Danh bạ" hint="Liên hệ Telegram · trạng thái, nhắn tin"
                          reason={supportReason('contacts', selected)} onSelect={() => open({ kind: 'contacts', account: selected })} />
                      )}
                      {quickActionVisible('calls', channel) && (
                        <ActionItem icon={<PhoneIcon />} title="Cuộc gọi" hint="Lịch sử cuộc gọi, gọi nhỡ"
                          reason={supportReason('calls', selected)} onSelect={() => open({ kind: 'calls', account: selected })} />
                      )}
                    </>
                  )}
                </>
              )}

              {(erp.event || erp.note) && (
                <>
                  {accounts.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="pb-1 pt-1 text-[10px] uppercase tracking-wide">Công việc của tôi</DropdownMenuLabel>
                  {erp.event && (
                    <ActionItem icon={<CalendarIcon />} title="Thêm lịch hẹn"
                      hint={activeThread ? 'Có thể gắn với hội thoại đang mở' : 'Hẹn gọi lại, gặp khách… có nhắc trước'}
                      onSelect={() => open({ kind: 'event' })} />
                  )}
                  {erp.note && (
                    <ActionItem icon={<FileTextIcon />} title="Ghi chú nhanh" hint="Lưu vào Ghi chú trong Quản lý công việc"
                      onSelect={() => open({ kind: 'note' })} />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </DropdownMenu>

      {dialog?.kind === 'createGroup' && (accountChannel(dialog.account) === 'zalo' ? (
        <CreateGroupModal
          accountId={dialog.account.zalo_id}
          onClose={close}
          onCreated={(groupId, name) => {
            if (groupId) onOpenConversation(dialog.account.zalo_id, groupId, 1, { display_name: name, channel: 'zalo' });
          }}
        />
      ) : accountChannel(dialog.account) === 'telegram_user' ? (
        <TelegramNewGroupDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      ) : (
        <QuickCreateGroupDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      ))}
      {dialog?.kind === 'createChannel' && (
        <TelegramNewChannelDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      )}
      {dialog?.kind === 'contacts' && (
        <TelegramContactsDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      )}
      {dialog?.kind === 'calls' && (
        <TelegramCallsDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      )}
      {dialog?.kind === 'joinLink' && (
        <QuickJoinLinkDialog entries={entries} initialAccountId={dialog.accountId} disabledReason={joinDisabledReason}
          onClose={close} onOpenConversation={onOpenConversation} />
      )}
      {dialog?.kind === 'addFriend' && (
        <QuickAddFriendDialog account={dialog.account} onClose={close} onOpenConversation={onOpenConversation} />
      )}
      {dialog?.kind === 'event' && <QuickEventDialog activeThread={activeThread} onClose={close} />}
      {dialog?.kind === 'note' && <QuickNoteDialog onClose={close} />}
    </>
  );
}
