/**
 * Quản lý nhóm / kênh Telegram (màn "Quản lý" của thông tin hội thoại): mô tả, loại (công khai t.me/tên ↔ riêng tư),
 * link mời chính (sao chép, tạo link mới), ký tên bài đăng + nhóm thảo luận (kênh), tự xoá tin nhắn, xoá nhóm / kênh.
 * Quyền đọc từ thông tin đầy đủ (getChatSettings) — mục không đủ quyền thì ẩn hoặc chỉ xem.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { Button, Select, Switch, Textarea } from '@/components/ui';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { GlobeIcon, LockIcon, RefreshIcon } from '@/components/common/icons';
import { TELEGRAM_TTL_OPTIONS, type TelegramChatSettings as Settings } from '../../../../../shared/telegramQuickModel';
import { CopyLinkRow, UsernameInput, useUsernameCheck } from './TelegramNewChannelDialog';
import { Notice } from './TelegramUi';

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2 border-t border-border px-4 py-3 first:border-t-0', className)}>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </section>
  );
}

const TTL_LABEL = (seconds: number) => TELEGRAM_TTL_OPTIONS.find(option => option.value === seconds)?.label
  || (seconds ? `Sau ${Math.round(seconds / 86400)} ngày` : 'Tắt');

export default function TelegramChatSettings({ accountId, chatId, onDeleted }: {
  accountId: string;
  chatId: string;
  /** Nhóm / kênh vừa bị xoá → đóng màn quản lý. */
  onDeleted: () => void;
}) {
  const notify = useAppStore(s => s.showNotification);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [editingAbout, setEditingAbout] = useState(false);
  const [about, setAbout] = useState('');
  const [publicMode, setPublicMode] = useState(false);
  const [username, setUsername] = useState('');
  const [groups, setGroups] = useState<Array<{ id: string; title: string; membersCount: number; basicGroup: boolean }> | null>(null);
  const [pickingGroup, setPickingGroup] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await ipc.telegramUser?.getChatSettings({ accountId, chatId });
      if (res?.success && res.settings) {
        setSettings(res.settings);
        setAbout(res.settings.about);
        setPublicMode(!!res.settings.username);
        setUsername(res.settings.username);
      } else {
        setLoadError(res?.error || 'Không tải được thông tin');
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Không tải được thông tin');
    } finally {
      setLoading(false);
    }
  }, [accountId, chatId]);

  useEffect(() => { void load(); }, [load]);

  const usernameChanged = !!settings && publicMode && username !== settings.username;
  const usernameState = useUsernameCheck(accountId, chatId, username, usernameChanged);

  if (loading && !settings) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">Đang tải thông tin…</p>;
  }
  if (!settings) {
    return (
      <div className="space-y-2 px-4 py-6 text-center">
        <p className="text-xs text-destructive">{loadError}</p>
        <Button size="sm" variant="outline" onClick={() => void load()} leftIcon={<RefreshIcon className="h-3.5 w-3.5" />}>Thử lại</Button>
      </div>
    );
  }

  const isChannel = settings.peerType === 'channel';
  const noun = isChannel ? 'kênh' : 'nhóm';
  const channelLike = settings.peerType !== 'basic_group';

  const run = async (key: string, task: () => Promise<{ success: boolean; error?: string } | undefined>, okText?: string) => {
    setBusy(key);
    try {
      const res = await task();
      if (!res?.success) {
        notify(res?.error || 'Không thực hiện được', 'error');
        return false;
      }
      if (okText) notify(okText, 'success');
      return true;
    } catch (err: any) {
      notify(err?.message || 'Không thực hiện được', 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const saveAbout = async () => {
    const ok = await run('about', () => ipc.telegramUser!.editChatAbout({ accountId, chatId, about }), 'Đã lưu mô tả');
    if (ok) {
      setSettings({ ...settings, about: about.trim() });
      setEditingAbout(false);
    }
  };

  const saveUsername = async (next: string) => {
    setBusy('username');
    try {
      const res = await ipc.telegramUser?.setChatUsername({ accountId, chatId, username: next });
      if (!res?.success) {
        notify(res?.error || 'Không đổi được link', 'error');
        return;
      }
      setSettings({ ...settings, username: res.username || '', inviteLink: res.username ? settings.inviteLink : (res.link || settings.inviteLink) });
      setUsername(res.username || '');
      setPublicMode(!!res.username);
      notify(res.username ? `Link công khai: t.me/${res.username}` : `Đã chuyển ${noun} sang riêng tư`, 'success');
    } finally {
      setBusy('');
    }
  };

  const choosePrivate = async () => {
    if (!settings.username) {
      setPublicMode(false);
      return;
    }
    const ok = await showConfirm({
      title: `Chuyển ${noun} sang riêng tư?`,
      message: `Link t.me/${settings.username} sẽ ngừng hoạt động; chỉ tham gia được bằng link mời.`,
      confirmText: 'Chuyển sang riêng tư',
    });
    if (ok) await saveUsername('');
  };

  const revokeLink = async () => {
    const ok = await showConfirm({
      title: 'Tạo link mời mới?',
      message: 'Link mời hiện tại sẽ ngừng hoạt động. Người đã tham gia không bị ảnh hưởng.',
      confirmText: 'Tạo link mới',
    });
    if (!ok) return;
    setBusy('revoke');
    try {
      const res = await ipc.telegramUser?.revokeInviteLink({ accountId, chatId });
      if (res?.success && res.link) {
        setSettings({ ...settings, inviteLink: res.link });
        notify('Đã tạo link mời mới', 'success');
      } else {
        notify(res?.error || 'Không tạo được link mới', 'error');
      }
    } finally {
      setBusy('');
    }
  };

  const getLink = async () => {
    setBusy('link');
    try {
      const res = await ipc.telegramUser?.exportChatInvite({ accountId, chatId });
      if (res?.success && res.link) setSettings({ ...settings, inviteLink: res.link });
      else notify(res?.error || 'Không lấy được link mời', 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleSignatures = async (enabled: boolean) => {
    const ok = await run('signatures', () => ipc.telegramUser!.toggleSignatures({ accountId, chatId, enabled }));
    if (ok) setSettings({ ...settings, signatures: enabled });
  };

  const setTtl = async (period: number) => {
    const ok = await run('ttl', () => ipc.telegramUser!.setHistoryTtl({ accountId, chatId, period }),
      period ? `Tin nhắn mới sẽ tự xoá ${TTL_LABEL(period).toLowerCase()}` : 'Đã tắt tự xoá tin nhắn');
    if (ok) setSettings({ ...settings, ttlPeriod: period });
  };

  const openGroupPicker = async () => {
    setPickingGroup(true);
    if (groups) return;
    const res = await ipc.telegramUser?.getDiscussionGroups({ accountId });
    if (res?.success) setGroups(res.groups || []);
    else {
      notify(res?.error || 'Không tải được danh sách nhóm', 'error');
      setPickingGroup(false);
    }
  };

  const linkGroup = async (group: { id: string; title: string } | null, showHistory = false) => {
    setBusy('discussion');
    try {
      const res = await ipc.telegramUser?.setDiscussionGroup({ accountId, chatId, groupId: group?.id || null, showHistory });
      if (res?.success) {
        setSettings({ ...settings, linkedChat: group ? { id: group.id, title: group.title } : null });
        setPickingGroup(false);
        notify(group ? `Bình luận bài đăng sẽ vào nhóm "${group.title}"` : 'Đã gỡ nhóm thảo luận', 'success');
        return;
      }
      if (res?.needsHistory && group) {
        const ok = await showConfirm({
          title: 'Bật hiện lịch sử cho thành viên mới?',
          message: `Nhóm "${group.title}" đang ẩn tin cũ với thành viên mới. Nhóm thảo luận của kênh cần hiện lịch sử — Deplao sẽ bật rồi gắn nhóm.`,
          confirmText: 'Bật và gắn nhóm',
        });
        if (ok) await linkGroup(group, true);
        return;
      }
      notify(res?.error || 'Không gắn được nhóm thảo luận', 'error');
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    const ok = await showConfirm({
      title: `Xoá ${noun} cho mọi người?`,
      message: `${isChannel ? 'Kênh' : 'Nhóm'} "${settings.title}" và toàn bộ tin nhắn sẽ bị xoá trên Telegram với tất cả thành viên. Không hoàn tác được.`,
      confirmText: `Xoá ${noun}`,
      variant: 'danger',
    });
    if (!ok) return;
    const done = await run('delete', () => ipc.telegramUser!.deleteChat({ accountId, chatId }), `Đã xoá ${noun} "${settings.title}"`);
    if (done) {
      const chat = useChatStore.getState();
      chat.removeContact(accountId, chatId);
      if (chat.activeThreadId === chatId) chat.setActiveThread(null);
      onDeleted();
    }
  };

  const publicLink = settings.username ? `https://t.me/${settings.username}` : '';

  return (
    <div className="pb-4">
      <Section title={`Mô tả ${noun}`}>
        {editingAbout ? (
          <div className="space-y-2">
            <Textarea autoFocus value={about} maxLength={255} onChange={e => setAbout(e.target.value)} className="min-h-[80px] text-[13px]" />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-subtle-foreground">{about.length}/255</span>
              <span className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => { setAbout(settings.about); setEditingAbout(false); }} disabled={busy === 'about'}>Huỷ</Button>
                <Button size="sm" onClick={() => void saveAbout()} loading={busy === 'about'}>Lưu</Button>
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <p className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px]', settings.about ? 'text-foreground/90' : 'text-subtle-foreground')}>
              {settings.about || 'Chưa có mô tả'}
            </p>
            {settings.canChangeInfo && <Button size="sm" variant="ghost" onClick={() => setEditingAbout(true)}>Sửa</Button>}
          </div>
        )}
      </Section>

      <Section title={`Loại ${noun}`}>
        {!channelLike ? (
          <p className="text-[12px] leading-5 text-muted-foreground">Nhóm thường: chỉ tham gia bằng link mời. Link công khai t.me/tên cần siêu nhóm hoặc kênh.</p>
        ) : !settings.canSetUsername ? (
          <p className="flex items-center gap-1.5 text-[13px] text-foreground/90">
            {settings.username ? <GlobeIcon className="h-3.5 w-3.5 text-primary" /> : <LockIcon className="h-3.5 w-3.5 text-muted-foreground" />}
            {settings.username ? 'Công khai' : 'Riêng tư'}
            <span className="text-[11px] text-subtle-foreground">· chỉ người tạo đổi được</span>
          </p>
        ) : (
          <div className="space-y-2">
            <div role="radiogroup" className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
              {[
                { key: 'private', label: 'Riêng tư', icon: <LockIcon className="h-3.5 w-3.5" />, active: !publicMode, onClick: () => void choosePrivate() },
                { key: 'public', label: 'Công khai', icon: <GlobeIcon className="h-3.5 w-3.5" />, active: publicMode, onClick: () => setPublicMode(true) },
              ].map(option => (
                <button key={option.key} type="button" role="radio" aria-checked={option.active} onClick={option.onClick} disabled={busy === 'username'}
                  className={cn('flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
                    option.active ? 'bg-popover text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {option.icon}{option.label}
                </button>
              ))}
            </div>
            {publicMode && (
              <>
                <UsernameInput id={`tg-settings-username-${chatId}`} value={username} onChange={setUsername}
                  state={usernameChanged ? usernameState : { status: settings.username ? 'available' : 'idle', message: settings.username ? 'Đang dùng' : '', checked: settings.username }}
                  disabled={busy === 'username'} />
                {usernameChanged && (
                  <Button size="sm" className="w-full" loading={busy === 'username'} disabled={usernameState.status !== 'available'}
                    onClick={() => void saveUsername(usernameState.checked)}>
                    Lưu link công khai
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="Link tham gia">
        {publicLink && <CopyLinkRow link={publicLink} label="Link công khai" compact />}
        {settings.inviteLink ? (
          <>
            <CopyLinkRow link={settings.inviteLink} label="Link mời" compact />
            {settings.canInviteUsers && (
              <Button size="sm" variant="ghost" className="w-full" loading={busy === 'revoke'} onClick={() => void revokeLink()}>
                Tạo link mời mới (huỷ link cũ)
              </Button>
            )}
          </>
        ) : settings.canInviteUsers ? (
          <Button size="sm" variant="outline" className="w-full" loading={busy === 'link'} onClick={() => void getLink()}>Lấy link mời</Button>
        ) : (
          <p className="text-[12px] text-muted-foreground">Chỉ quản trị viên có quyền mời mới xem được link mời.</p>
        )}
      </Section>

      {isChannel && settings.isAdmin && (
        <Section title="Bài đăng & bình luận">
          <Switch checked={settings.signatures} onCheckedChange={value => void toggleSignatures(value)} disabled={busy === 'signatures' || !settings.canChangeInfo}
            label="Ký tên bài đăng" description="Ghi tên quản trị viên đăng dưới mỗi bài" />
          <div className="rounded-lg border border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-foreground">Nhóm thảo luận</span>
                <span className="block text-[11px] leading-4 text-muted-foreground">
                  {settings.linkedChat ? `Bình luận vào: ${settings.linkedChat.title || settings.linkedChat.id}` : 'Chưa có — người theo dõi chưa bình luận được'}
                </span>
              </span>
              {settings.canChangeInfo && (
                settings.linkedChat ? (
                  <Button size="sm" variant="ghost" loading={busy === 'discussion'} onClick={() => void linkGroup(null)}>Gỡ</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void openGroupPicker()} disabled={pickingGroup}>Chọn</Button>
                )
              )}
            </div>
            {pickingGroup && !settings.linkedChat && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
                {groups === null ? (
                  <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">Đang tải nhóm…</p>
                ) : groups.length === 0 ? (
                  <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">Chưa có nhóm nào bạn quản trị để làm nhóm thảo luận</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {groups.map(group => (
                      <li key={group.id}>
                        <button type="button" disabled={group.basicGroup || busy === 'discussion'} onClick={() => void linkGroup(group)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60">
                          <span className="min-w-0">
                            <span className="block truncate text-[12px] text-foreground">{group.title}</span>
                            <span className="block text-[10px] text-muted-foreground">
                              {group.basicGroup ? 'Nhóm thường — nâng cấp siêu nhóm trên Telegram trước' : `${group.membersCount || 0} thành viên`}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-border p-1 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setPickingGroup(false)}>Đóng</Button>
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="Tự xoá tin nhắn">
        {settings.isAdmin || !channelLike ? (
          <Select value={String(settings.ttlPeriod)} disabled={busy === 'ttl'} aria-label="Tự xoá tin nhắn"
            onChange={e => void setTtl(Number(e.target.value))}>
            {!TELEGRAM_TTL_OPTIONS.some(option => option.value === settings.ttlPeriod) && (
              <option value={settings.ttlPeriod}>{TTL_LABEL(settings.ttlPeriod)}</option>
            )}
            {TELEGRAM_TTL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        ) : (
          <p className="text-[13px] text-foreground/90">{TTL_LABEL(settings.ttlPeriod)}</p>
        )}
        <p className="text-[11px] leading-4 text-subtle-foreground">Áp dụng cho tin nhắn gửi sau khi đổi, với mọi thành viên.</p>
      </Section>

      {settings.canDelete && (
        <Section title="Vùng nguy hiểm">
          <Button variant="destructive" size="sm" className="w-full" loading={busy === 'delete'} onClick={() => void remove()}>
            Xoá {noun} cho mọi người
          </Button>
        </Section>
      )}

      {loadError && <div className="px-4"><Notice tone="error">{loadError}</Notice></div>}
    </div>
  );
}
