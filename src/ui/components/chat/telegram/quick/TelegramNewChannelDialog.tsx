/**
 * "Kênh mới" Telegram, theo luồng của Telegram: 1) ảnh + tên + mô tả, 2) loại kênh — công khai (link t.me/tên, kiểm tra
 * trống ngay khi gõ) hoặc riêng tư (chỉ vào bằng link mời), 3) mời người theo dõi (bỏ qua được). Tạo xong: hiện link
 * để chia sẻ, người chưa mời được thì gửi link mời cho họ.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import type { AccountInfo } from '@/store/accounts/accountStore';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Textarea,
} from '@/components/ui';
import { ArrowLeftIcon, CheckIcon, CopyIcon, GlobeIcon, LockIcon } from '@/components/common/icons';
import {
  normalizeTelegramUsernameInput, validateTelegramUsername, type TelegramCreateChannelResult,
} from '../../../../../shared/telegram/telegramQuickModel';
import { accountLabel, type OpenQuickConversation } from '../../quick/quickActions';
import TelegramPeoplePicker, { type SelectedPerson } from './TelegramPeoplePicker';
import TelegramInviteResult from './TelegramInviteResult';
import { FieldLabel, Notice, StepDots, TelegramAvatar, TelegramPhotoField } from './TelegramUi';

type Step = 'info' | 'type' | 'subscribers' | 'result';
type UsernameState = { status: 'idle' | 'checking' | 'available' | 'taken' | 'error'; message: string; checked: string };

const STEP_NUMBER: Record<Exclude<Step, 'result'>, number> = { info: 1, type: 2, subscribers: 3 };

export function CopyLinkRow({ link, label = 'Link', compact }: { link: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      useAppStore.getState().showNotification('Không sao chép được', 'error');
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 py-1.5 pl-3 pr-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wide text-subtle-foreground">{label}</span>
        <span className="block truncate font-mono text-[13px] text-foreground">{link}</span>
      </span>
      {compact ? (
        <Button size="icon" variant={copied ? 'secondary' : 'ghost'} onClick={() => void copy()} className="h-8 w-8"
          title={copied ? 'Đã chép' : 'Sao chép'} aria-label={copied ? 'Đã chép' : `Sao chép ${label.toLowerCase()}`}>
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </Button>
      ) : (
        <Button size="sm" variant={copied ? 'secondary' : 'outline'} onClick={() => void copy()}
          leftIcon={copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}>
          {copied ? 'Đã chép' : 'Sao chép'}
        </Button>
      )}
    </div>
  );
}

function TypeCard({ active, icon, title, description, onSelect, children }: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border transition-colors', active ? 'border-primary bg-primary/5' : 'border-border hover:border-border-strong')}>
      <button type="button" role="radio" aria-checked={active} onClick={onSelect} className="flex w-full items-start gap-3 p-3 text-left">
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
        </span>
        <span aria-hidden className={cn('mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', active ? 'border-primary' : 'border-border-strong')}>
          {active && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
      </button>
      {active && children && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/** Ô "t.me/" + tên, kiểm tra trống sau khi ngừng gõ (channels.CheckUsername). */
export function useUsernameCheck(accountId: string, chatId: string | null, raw: string, enabled: boolean): UsernameState {
  const [state, setState] = useState<UsernameState>({ status: 'idle', message: '', checked: '' });
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const local = validateTelegramUsername(raw);
    if ('error' in local) {
      setState({ status: raw.trim() ? 'error' : 'idle', message: raw.trim() ? local.error : '', checked: '' });
      return undefined;
    }
    const current = ++seq.current;
    setState({ status: 'checking', message: 'Đang kiểm tra…', checked: '' });
    const timer = window.setTimeout(async () => {
      try {
        const res = await ipc.telegramUser?.checkChatUsername({ accountId, chatId: chatId || undefined, username: local.username });
        if (current !== seq.current) return;
        if (!res?.success) setState({ status: 'error', message: res?.error || 'Không kiểm tra được tên', checked: '' });
        else if (res.available) setState({ status: 'available', message: `t.me/${local.username} dùng được`, checked: local.username });
        else setState({ status: 'taken', message: res.error || 'Tên này đã có người dùng', checked: '' });
      } catch (err: any) {
        if (current === seq.current) setState({ status: 'error', message: err?.message || 'Không kiểm tra được tên', checked: '' });
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [accountId, chatId, raw, enabled]);
  return state;
}

export function UsernameInput({ id, value, onChange, state, disabled }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  state: UsernameState;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className={cn(
        'flex items-center overflow-hidden rounded-lg border bg-muted/50 transition-colors focus-within:border-primary',
        state.status === 'taken' || state.status === 'error' ? 'border-destructive/60' : state.status === 'available' ? 'border-success/60' : 'border-input',
      )}>
        <span className="select-none pl-3 pr-0.5 font-mono text-[13px] text-muted-foreground">t.me/</span>
        <input id={id} value={value} disabled={disabled} maxLength={40} spellCheck={false} autoComplete="off"
          onChange={e => onChange(normalizeTelegramUsernameInput(e.target.value))}
          className="h-9 min-w-0 flex-1 bg-transparent pr-3 font-mono text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
          placeholder="ten_kenh" />
      </div>
      <p className={cn('min-h-[16px] text-[11px]',
        state.status === 'available' ? 'text-success' : state.status === 'taken' || state.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
        {state.message || 'Chữ a–z, số 0–9, dấu gạch dưới; tối thiểu 5 ký tự'}
      </p>
    </div>
  );
}

export default function TelegramNewChannelDialog({ account, onClose, onOpenConversation }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const accountId = account.zalo_id;
  const [step, setStep] = useState<Step>('info');
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [photo, setPhoto] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [username, setUsername] = useState('');
  const [subscribers, setSubscribers] = useState<SelectedPerson[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TelegramCreateChannelResult | null>(null);
  const usernameState = useUsernameCheck(accountId, null, username, isPublic && step === 'type');

  const typeReady = !isPublic || usernameState.status === 'available';

  const openChannel = () => {
    if (!result?.chatId) return;
    onOpenConversation(accountId, result.chatId, 1, {
      display_name: result.title || title.trim(), channel: 'telegram_user', ...(photo && !result.photoError ? { avatar_url: photo } : {}),
    });
    onClose();
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await ipc.telegramUser?.createChannel({
        accountId,
        title: title.trim(),
        about: about.trim(),
        photoPath: photo || undefined,
        username: isPublic ? usernameState.checked || username : undefined,
        userIds: subscribers.map(person => person.id),
      });
      if (!res?.success || !res.chatId) {
        setError(res?.error || 'Không tạo được kênh');
        return;
      }
      useAppStore.getState().showNotification(`Đã tạo kênh "${res.title || title.trim()}"`, 'success');
      setResult(res);
      setStep('result');
    } catch (err: any) {
      setError(err?.message || 'Không tạo được kênh');
    } finally {
      setCreating(false);
    }
  };

  const names = Object.fromEntries(subscribers.map(person => [person.id, { name: person.name, avatar: person.avatar }]));
  const titles: Record<Step, string> = {
    info: 'Kênh mới', type: 'Loại kênh', subscribers: 'Mời người theo dõi', result: 'Kênh đã sẵn sàng',
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !creating) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{titles[step]}</DialogTitle>
          <DialogDescription>
            <span className="inline-flex items-center gap-2">
              {step !== 'result' && <StepDots step={STEP_NUMBER[step]} total={3} />}
              <span>Kênh Telegram · {accountLabel(account)}</span>
            </span>
          </DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>

      <DialogBody className="space-y-3">
        {step === 'info' && (
          <>
            <div className="flex items-center gap-4">
              <TelegramPhotoField value={photo} onChange={setPhoto} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <FieldLabel htmlFor="tg-channel-title" hint={`${title.trim().length}/128`}>Tên kênh</FieldLabel>
                <Input id="tg-channel-title" autoFocus value={title} maxLength={128} onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && title.trim()) setStep('type'); }} placeholder="Ví dụ: Hoa Lan — giá sỉ mỗi ngày" />
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="tg-channel-about" hint={`${about.length}/255`}>Mô tả (không bắt buộc)</FieldLabel>
              <Textarea id="tg-channel-about" value={about} maxLength={255} onChange={e => setAbout(e.target.value)} className="min-h-[72px]"
                placeholder="Kênh nói về gì, đăng gì, khi nào…" />
            </div>
            <p className="text-[11px] leading-4 text-subtle-foreground">
              Kênh dùng để phát tin tới nhiều người: chỉ quản trị viên đăng bài, người theo dõi không thấy nhau.
            </p>
          </>
        )}

        {step === 'type' && (
          <div role="radiogroup" aria-label="Loại kênh" className="space-y-2">
            <TypeCard active={!isPublic} onSelect={() => setIsPublic(false)} icon={<LockIcon className="h-4 w-4" />}
              title="Riêng tư" description="Chỉ tham gia được bằng link mời. Link được tạo ngay khi tạo kênh." />
            <TypeCard active={isPublic} onSelect={() => setIsPublic(true)} icon={<GlobeIcon className="h-4 w-4" />}
              title="Công khai" description="Ai cũng tìm thấy trong ô tìm kiếm Telegram và tham gia bằng link t.me.">
              <UsernameInput id="tg-channel-username" value={username} onChange={setUsername} state={usernameState} />
            </TypeCard>
          </div>
        )}

        {step === 'subscribers' && (
          <>
            <TelegramPeoplePicker accountId={accountId} selected={subscribers} onChange={setSubscribers} />
            <p className="text-[11px] leading-4 text-subtle-foreground">
              Telegram chỉ cho mời tối đa 200 người theo dõi đầu tiên theo cách này; sau đó chia sẻ link kênh.
            </p>
          </>
        )}

        {step === 'result' && result && (
          <>
            <div className="flex items-center gap-3">
              <TelegramAvatar id={result.chatId || ''} name={result.title || title} src={photo} size={44} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{result.title || title}</p>
                <p className="text-xs text-muted-foreground">
                  {result.username ? 'Kênh công khai' : 'Kênh riêng tư'}
                  {result.invited ? ` · đã mời ${result.invited} người` : ''}
                </p>
              </div>
            </div>
            {result.inviteLink && <CopyLinkRow link={result.inviteLink} label={result.username ? 'Link công khai' : 'Link mời'} />}
            {result.usernameError && <Notice tone="warning">Chưa đặt được link công khai: {result.usernameError}. Kênh đang ở chế độ riêng tư — đổi lại trong thông tin kênh.</Notice>}
            {result.photoError && <Notice tone="warning">Chưa đặt được ảnh kênh: {result.photoError}</Notice>}
            {result.inviteError && <Notice tone="warning">Chưa mời được người theo dõi: {result.inviteError}</Notice>}
            {(result.missingInvitees?.length || 0) > 0 && result.chatId && (
              <TelegramInviteResult accountId={accountId} chatId={result.chatId} chatTitle={result.title || title} isChannel
                people={result.missingInvitees || []} names={names} />
            )}
          </>
        )}

        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>

      <DialogFooter>
        {step === 'info' && (
          <>
            <Button variant="outline" onClick={onClose}>Huỷ</Button>
            <Button onClick={() => setStep('type')} disabled={!title.trim()}>Tiếp</Button>
          </>
        )}
        {step === 'type' && (
          <>
            <Button variant="ghost" onClick={() => setStep('info')} leftIcon={<ArrowLeftIcon className="h-4 w-4" />}>Quay lại</Button>
            <Button onClick={() => setStep('subscribers')} disabled={!typeReady}>Tiếp</Button>
          </>
        )}
        {step === 'subscribers' && (
          <>
            <Button variant="ghost" onClick={() => setStep('type')} disabled={creating} leftIcon={<ArrowLeftIcon className="h-4 w-4" />}>Quay lại</Button>
            <Button onClick={() => void create()} loading={creating}>
              {subscribers.length ? `Tạo kênh và mời ${subscribers.length} người` : 'Tạo kênh'}
            </Button>
          </>
        )}
        {step === 'result' && (
          <>
            <Button variant="outline" onClick={onClose}>Đóng</Button>
            <Button onClick={openChannel} disabled={!result?.chatId}>Mở kênh</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
