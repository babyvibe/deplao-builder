/**
 * "Nhóm mới" Telegram, theo đúng luồng của Telegram: 1) chọn thành viên (bỏ qua được — nhóm chưa có ai vẫn tạo được),
 * 2) ảnh + tên + tự xoá tin nhắn → messages.CreateChat (nhóm thường). Người không thêm được vì quyền riêng tư → gửi
 * link mời cho họ ở bước kết quả.
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
    // Ảnh vừa chọn hiện ngay ở danh sách (main lưu bản thu nhỏ, lần tải lại sau dùng bản đó)
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
        setError(res?.error || 'Không tạo được nhóm');
        return;
      }
      const missing = res.missingInvitees || [];
      const notify = useAppStore.getState().showNotification;
      if (missing.length === 0 && !res.photoError) {
        notify(`Đã tạo nhóm "${res.title || title}"`, 'success');
        openGroup(res.chatId, res.title || title);
        return;
      }
      setResult({ chatId: res.chatId, title: res.title || title, missing, photoError: res.photoError });
      setStep('result');
    } catch (err: any) {
      setError(err?.message || 'Không tạo được nhóm');
    } finally {
      setCreating(false);
    }
  };

  const names = Object.fromEntries(members.map(member => [member.id, { name: member.name, avatar: member.avatar }]));

  return (
    <Dialog open onOpenChange={next => { if (!next && !creating) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{step === 'members' ? 'Thêm thành viên' : step === 'info' ? 'Nhóm mới' : 'Đã tạo nhóm'}</DialogTitle>
          <DialogDescription>
            <span className="inline-flex items-center gap-2">
              {step !== 'result' && <StepDots step={step === 'members' ? 1 : 2} total={2} />}
              <span>Nhóm Telegram · {accountLabel(account)}</span>
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
              Có thể bỏ qua để tạo nhóm chỉ có bạn, mời người sau. Nhóm thường tối đa 200 thành viên — Telegram tự nâng cấp
              thành siêu nhóm khi cần.
            </p>
          </>
        )}

        {step === 'info' && (
          <>
            <div className="flex items-center gap-4">
              <TelegramPhotoField value={photo} onChange={setPhoto} disabled={creating} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <FieldLabel htmlFor="tg-group-name" hint={`${name.trim().length}/128`}>Tên nhóm</FieldLabel>
                <Input id="tg-group-name" autoFocus value={name} maxLength={128} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void create(); }} placeholder="Ví dụ: Khách sỉ Hoa Lan" />
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="tg-group-ttl">Tự xoá tin nhắn</FieldLabel>
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
                  ? 'Chưa chọn thành viên — nhóm chỉ có bạn'
                  : `${members.length} thành viên: ${members.slice(0, 3).map(member => member.name).join(', ')}${members.length > 3 ? '…' : ''}`}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setStep('members')} disabled={creating}>Sửa</Button>
            </div>
          </>
        )}

        {step === 'result' && result && (
          <>
            <div className="flex items-center gap-3">
              <TelegramAvatar id={result.chatId} name={result.title} src={photo} size={44} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{result.title}</p>
                <p className="text-xs text-muted-foreground">Nhóm đã sẵn sàng</p>
              </div>
            </div>
            {result.photoError && <Notice tone="warning">Chưa đặt được ảnh nhóm: {result.photoError}</Notice>}
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
            <Button variant="outline" onClick={onClose}>Huỷ</Button>
            <Button onClick={() => setStep('info')}>{members.length ? `Tiếp (${members.length})` : 'Tiếp'}</Button>
          </>
        )}
        {step === 'info' && (
          <>
            <Button variant="ghost" onClick={() => setStep('members')} disabled={creating} leftIcon={<ArrowLeftIcon className="h-4 w-4" />}>Quay lại</Button>
            <Button onClick={() => void create()} loading={creating} disabled={!name.trim()}>Tạo nhóm</Button>
          </>
        )}
        {step === 'result' && result && (
          <>
            <Button variant="outline" onClick={onClose}>Đóng</Button>
            <Button onClick={() => openGroup(result.chatId, result.title)}>Mở nhóm</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
