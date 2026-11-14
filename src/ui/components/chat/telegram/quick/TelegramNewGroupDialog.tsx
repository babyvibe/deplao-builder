/**
 * Telegram "Nhóm mới" (New group), following Telegram's flow exactly: 1) pick members (can be skipped, a group with no one yet can still be created),
 * 2) photo + name + auto-delete messages → messages.CreateChat (regular group). People who cannot be added due to privacy → send them
 * the invite link on the result step.
 */
import React, { useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import type { AccountInfo } from '@/store/accounts/accountStore';
import ipc from '@/lib/ipc';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select,
} from '@/components/ui';
import { ArrowLeftIcon } from '@/components/common/icons';
import { TELEGRAM_TTL_OPTIONS, type TelegramMissingInvitee } from '../../../../../shared/telegram/telegramQuickModel';
import { accountLabel, type OpenQuickConversation } from '../../quick/quickActions';
import TelegramPeoplePicker, { type SelectedPerson } from './TelegramPeoplePicker';
import TelegramInviteResult from './TelegramInviteResult';
import { FieldLabel, Notice, StepDots, TelegramAvatar, TelegramPhotoField } from './TelegramUi';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

type Step = 'members' | 'info' | 'result';

export default function TelegramNewGroupDialog({ account, onClose, onOpenConversation }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const accountId = account.zalo_id;
  const [step, setStep] = useState<Step>('members');
  const [members, setMembers] = useState<SelectedPerson[]>([]);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState('');
  const [ttl, setTtl] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ chatId: string; title: string; missing: TelegramMissingInvitee[]; photoError?: string } | null>(null);

  const openGroup = (chatId: string, title: string) => {
    // Newly picked photo shows at once in the list (main stores a thumbnail, later reloads use that copy)
    onOpenConversation(accountId, chatId, 1, { display_name: title, channel: 'telegram_user', ...(photo && !result?.photoError ? { avatar_url: photo } : {}) });
    onClose();
  };

  const create = async () => {
    const title = name.trim();
    if (!title || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await ipc.telegramUser?.createGroup({
        accountId, title, userIds: members.map(member => member.id), photoPath: photo || undefined, ttlPeriod: ttl || undefined,
      });
      if (!res?.success || !res.chatId) {
        setError(res?.error || tr('Không tạo được nhóm'));
        return;
      }
      const missing = res.missingInvitees || [];
      const notify = useAppStore.getState().showNotification;
      if (missing.length === 0 && !res.photoError) {
        notify(tr('Đã tạo nhóm "{{v1}}"', { v1: res.title || title }), 'success');
        openGroup(res.chatId, res.title || title);
        return;
      }
      setResult({ chatId: res.chatId, title: res.title || title, missing, photoError: res.photoError });
      setStep('result');
    } catch (err: any) {
      setError(err?.message || tr('Không tạo được nhóm'));
    } finally {
      setCreating(false);
    }
  };

  const names = Object.fromEntries(members.map(member => [member.id, { name: member.name, avatar: member.avatar }]));

  return (
    <Dialog open onOpenChange={next => { if (!next && !creating) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{step === 'members' ? tr('Thêm thành viên') : step === 'info' ? tr('Nhóm mới') : tr('Đã tạo nhóm')}</DialogTitle>
          <DialogDescription>
            <span className="inline-flex items-center gap-2">
              {step !== 'result' && <StepDots step={step === 'members' ? 1 : 2} total={2} />}
              <span>{trx('Nhóm Telegram · {{v1}}', { v1: accountLabel(account) })}</span>
            </span>
          </DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>

      <DialogBody className="space-y-3">
        {step === 'members' && (
          <>
            <TelegramPeoplePicker accountId={accountId} selected={members} onChange={setMembers} />
            <p className="text-[11px] leading-4 text-subtle-foreground">
              {tr('Có thể bỏ qua để tạo nhóm chỉ có bạn, mời người sau. Nhóm thường tối đa 200 thành viên — Telegram tự nâng cấp thành siêu nhóm khi cần.')}
            </p>
          </>
        )}

        {step === 'info' && (
          <>
            <div className="flex items-center gap-4">
              <TelegramPhotoField value={photo} onChange={setPhoto} disabled={creating} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <FieldLabel htmlFor="tg-group-name" hint={`${name.trim().length}/128`}>{tr('Tên nhóm')}</FieldLabel>
                <Input id="tg-group-name" autoFocus value={name} maxLength={128} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void create(); }} placeholder={tr('Ví dụ: Khách sỉ Hoa Lan')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="tg-group-ttl">{tr('Tự xoá tin nhắn')}</FieldLabel>
              <Select id="tg-group-ttl" value={String(ttl)} onChange={e => setTtl(Number(e.target.value))}>
                {TELEGRAM_TTL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
              {members.length > 0 ? (
                <span className="flex -space-x-2">
                  {members.slice(0, 4).map(member => (
                    <TelegramAvatar key={member.id} id={member.id} name={member.name} src={member.avatar} size={26} className="ring-2 ring-popover" />
                  ))}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {members.length === 0
                  ? tr('Chưa chọn thành viên — nhóm chỉ có bạn')
                  : tr('{{count}} thành viên: {{v1}}{{v2}}', { count: members.length, v1: members.slice(0, 3).map(member => member.name).join(', '), v2: members.length > 3 ? '…' : '' })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setStep('members')} disabled={creating}>{tr('Sửa')}</Button>
            </div>
          </>
        )}

        {step === 'result' && result && (
          <>
            <div className="flex items-center gap-3">
              <TelegramAvatar id={result.chatId} name={result.title} src={photo} size={44} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{result.title}</p>
                <p className="text-xs text-muted-foreground">{tr('Nhóm đã sẵn sàng')}</p>
              </div>
            </div>
            {result.photoError && <Notice tone="warning">{trx('Chưa đặt được ảnh nhóm: {{photoError}}', { photoError: result.photoError })}</Notice>}
            {result.missing.length > 0 && (
              <TelegramInviteResult accountId={accountId} chatId={result.chatId} chatTitle={result.title} isChannel={false}
                people={result.missing} names={names} />
            )}
          </>
        )}

        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>

      <DialogFooter>
        {step === 'members' && (
          <>
            <Button variant="outline" onClick={onClose}>{tr('Huỷ')}</Button>
            <Button onClick={() => setStep('info')}>{members.length ? tr('Tiếp ({{count}})', { count: members.length }) : tr('Tiếp')}</Button>
          </>
        )}
        {step === 'info' && (
          <>
            <Button variant="ghost" onClick={() => setStep('members')} disabled={creating} leftIcon={<ArrowLeftIcon className="h-4 w-4" />}>{tr('Quay lại')}</Button>
            <Button onClick={() => void create()} loading={creating} disabled={!name.trim()}>{tr('Tạo nhóm')}</Button>
          </>
        )}
        {step === 'result' && result && (
          <>
            <Button variant="outline" onClick={onClose}>{tr('Đóng')}</Button>
            <Button onClick={() => openGroup(result.chatId, result.title)}>{tr('Mở nhóm')}</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
