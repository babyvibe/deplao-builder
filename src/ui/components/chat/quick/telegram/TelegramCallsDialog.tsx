/**
 * "Cuộc gọi" Telegram: nhật ký cuộc gọi của tài khoản (messages.Search + InputMessagesFilterPhoneCalls), tab Gọi nhỡ,
 * bấm để mở hội thoại. Deplao chưa nghe / gọi được (Telegram không công bố giao thức thoại tgcalls) — ghi rõ ở đầu.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountInfo } from '@/store/accountStore';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tabs, TabsList, TabsTrigger,
} from '@/components/ui';
import { RefreshIcon } from '@/components/common/icons';
import {
  describeTelegramCall, isUnansweredTelegramCall, type TelegramCallHistoryItem,
} from '../../../../../shared/telegramQuickModel';
import { accountLabel, type OpenQuickConversation } from '../quickActions';
import { Notice, TelegramAvatar } from './TelegramUi';

const PAGE = 50;
const pad2 = (value: number) => String(value).padStart(2, '0');

export function formatCallTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (ts >= startToday) return time;
  if (ts >= startToday - 86400000) return `Hôm qua ${time}`;
  if (d.getFullYear() === today.getFullYear()) return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${time}`;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Mũi tên hướng cuộc gọi: ↗ gọi đi, ↙ gọi đến. */
function DirectionIcon({ out, className }: { out: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {out ? <><path d="M7 17 17 7" /><path d="M8 7h9v9" /></> : <><path d="M17 7 7 17" /><path d="M16 17H7V8" /></>}
    </svg>
  );
}

export function PhoneGlyph({ video, className }: { video?: boolean; className?: string }) {
  return video ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export default function TelegramCallsDialog({ account, onClose, onOpenConversation }: {
  account: AccountInfo;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const accountId = account.zalo_id;
  const [tab, setTab] = useState<'all' | 'missed'>('all');
  const [items, setItems] = useState<TelegramCallHistoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (append: boolean, offsetId: number) => {
    const current = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const res = await ipc.telegramUser?.getCallHistory({ accountId, missed: tab === 'missed', offsetId, limit: PAGE });
      if (current !== seq.current) return;
      if (!res?.success) {
        setError(res?.error || 'Không tải được lịch sử cuộc gọi');
        if (!append) setItems([]);
        return;
      }
      setItems(prev => (append ? [...(prev || []), ...(res.items || [])] : res.items || []));
      setNextOffset(res.nextOffsetId || 0);
      setHasMore(!!res.hasMore);
    } catch (err: any) {
      if (current === seq.current) setError(err?.message || 'Không tải được lịch sử cuộc gọi');
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [accountId, tab]);

  useEffect(() => {
    setItems(null);
    void load(false, 0);
  }, [load]);

  const open = (item: TelegramCallHistoryItem) => {
    onOpenConversation(accountId, item.userId, 0, { display_name: item.name, avatar_url: item.avatar, channel: 'telegram_user' });
    onClose();
  };
  const now = Date.now();

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>Cuộc gọi</DialogTitle>
          <DialogDescription>Telegram · {accountLabel(account)}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-2.5">
        <Notice>
          Deplao chưa nghe / gọi được cuộc gọi Telegram — hãy nghe máy trên điện thoại hoặc Telegram Desktop. Khi có cuộc gọi
          đến, Deplao báo ngay để bạn từ chối hoặc mở hội thoại; cuộc gọi cũng hiện trong khung chat.
        </Notice>
        <div className="flex items-center justify-between gap-2">
          <Tabs value={tab} onValueChange={value => setTab(value as 'all' | 'missed')} variant="pills">
            <TabsList>
              <TabsTrigger value="all">Tất cả</TabsTrigger>
              <TabsTrigger value="missed">Gọi nhỡ</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button size="icon" variant="ghost" onClick={() => void load(false, 0)} title="Tải lại" aria-label="Tải lại lịch sử cuộc gọi">
            <RefreshIcon className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="max-h-[22rem] min-h-[12rem] overflow-y-auto rounded-xl border border-border p-1">
          {items === null ? (
            <p className="px-3 py-10 text-center text-xs text-muted-foreground">Đang tải lịch sử cuộc gọi…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-10 text-center text-xs text-muted-foreground">{tab === 'missed' ? 'Không có cuộc gọi nhỡ' : 'Chưa có cuộc gọi nào'}</p>
          ) : (
            <ul>
              {items.map(item => {
                const call = describeTelegramCall(item);
                const unanswered = isUnansweredTelegramCall(call.kind);
                return (
                  <li key={item.msgId}>
                    <button type="button" onClick={() => open(item)}
                      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60">
                      <TelegramAvatar id={item.userId} name={item.name} src={item.avatar} size={38} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-[13px] font-medium', call.kind === 'missed' ? 'text-destructive' : 'text-foreground')}>{item.name}</span>
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <DirectionIcon out={item.out} className={cn('h-3 w-3 shrink-0', unanswered ? 'text-destructive' : 'text-success')} />
                          <span className="truncate">{call.label}{call.detail ? ` · ${call.detail}` : ''}</span>
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="text-[11px] text-subtle-foreground">{formatCallTime(item.date, now)}</span>
                        <PhoneGlyph video={item.video} className="h-3.5 w-3.5 text-muted-foreground" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {items && items.length > 0 && hasMore && (
            <div className="p-2 text-center">
              <Button size="sm" variant="ghost" loading={loading} onClick={() => void load(true, nextOffset)}>Xem thêm</Button>
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Đóng</Button>
      </DialogFooter>
    </Dialog>
  );
}
