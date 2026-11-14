/**
 * TelegramReadReceipts: the "Đã xem" (Seen) row at the bottom of the right-click menu of a Telegram message I sent (like Telegram Desktop):
 *  - group: "✓✓ 10 đã xem" (10 seen) + 3 avatars; hover / click → list of viewers with their times
 *  - private chat: "✓✓ Đã xem hôm nay lúc 10:13" (seen today at 10:13) (if the other person has not hidden their last-seen time)
 * A very large group / message older than 7 days / error → nothing is shown (as in Telegram). The result is kept for 30 s so reopening the menu does not call again.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { formatReadTime } from '@/lib/chat/read/readReceipts';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface ReadReceiptPerson { name: string; avatar?: string }

interface ReadResult {
  success: boolean;
  kind?: 'group' | 'private';
  participants?: Array<{ userId: string; date: number; name: string }>;
  readAt?: number;
  reason?: string;
  error?: string;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; result: ReadResult }>();

function DoubleCheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2 12.5l4.5 4.5L15 8" />
      <path d="M10.5 15.5l1.5 1.5L22 7" />
    </svg>
  );
}

function PersonAvatar({ name, avatar, size }: { name: string; avatar?: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (avatar && !failed) {
    return <img src={avatar} alt="" style={style} className="rounded-full object-cover shrink-0 ring-2 ring-popover" onError={() => setFailed(true)} />;
  }
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  return (
    <span style={{ ...style, fontSize: Math.round(size * 0.42) }}
      className="rounded-full shrink-0 ring-2 ring-popover bg-primary/80 text-primary-foreground font-semibold flex items-center justify-center">
      {initial}
    </span>
  );
}

export default function TelegramReadReceipts({ accountId, msg, resolvePerson }: {
  accountId: string;
  msg: any;
  /** Name / avatar from the contacts and group members of the open group (null = unknown). */
  resolvePerson: (userId: string) => ReadReceiptPerson | null;
}) {
  const key = `${accountId}:${msg.thread_id}:${msg.msg_id}`;
  const [result, setResult] = useState<ReadResult | null>(() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.result : null;
  });
  const [listOpen, setListOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ side: 'right' | 'left'; align: 'top' | 'bottom' }>({ side: 'right', align: 'top' });

  useEffect(() => {
    if (result) return;
    let alive = true;
    const call = ipc.telegramUser?.getMessageReadParticipants;
    if (!call) { setResult({ success: false, reason: 'error' }); return; }
    call({ accountId, chatId: String(msg.thread_id), messageId: String(msg.msg_id) })
      .then((res) => {
        const value: ReadResult = res || { success: false, reason: 'error' };
        cache.set(key, { at: Date.now(), result: value });
        if (alive) setResult(value);
      })
      .catch((err: any) => { if (alive) setResult({ success: false, reason: 'error', error: err?.message }); });
    return () => { alive = false; };
  }, [key, result, accountId, msg.thread_id, msg.msg_id]);

  // Open the list toward the side with room (right / left of the menu, above / below the row)
  useLayoutEffect(() => {
    if (!listOpen || !rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    setPlacement({
      side: rect.right + 296 > window.innerWidth ? 'left' : 'right',
      align: rect.top + 360 > window.innerHeight ? 'bottom' : 'top',
    });
  }, [listOpen]);

  const rowBase = 'w-full flex items-center gap-3 px-4 py-2.5 text-left border-t border-border';

  if (!result) {
    return (
      <div className={`${rowBase} text-muted-foreground`}>
        <DoubleCheckIcon className="w-4 h-4 shrink-0" />
        <span className="text-[13px]">{tr('Đang tải người đã xem…')}</span>
      </div>
    );
  }

  if (!result.success) {
    // Very large group / message older than 7 days / error: Telegram has no data → no row shown
    if (result.reason !== 'not_read' && result.reason !== 'privacy') return null;
    return (
      <div className={`${rowBase} text-muted-foreground`} title={result.error || ''}>
        <DoubleCheckIcon className="w-4 h-4 shrink-0" />
        <span className="text-[13px]">{result.reason === 'not_read' ? tr('Chưa xem') : tr('Đã ẩn thời gian xem')}</span>
      </div>
    );
  }

  if (result.kind === 'private') {
    return (
      <div className={`${rowBase} text-foreground`}>
        <DoubleCheckIcon className="w-4 h-4 shrink-0 text-primary" />
        <span className="text-[13px]">{result.readAt ? tr('Đã xem {{v1}}', { v1: formatReadTime(result.readAt) }) : tr('Đã xem')}</span>
      </div>
    );
  }

  const readers = (result.participants || []).map((p) => {
    const known = resolvePerson(p.userId);
    const name = known?.name || p.name || p.userId;
    return { ...p, name, avatar: known?.avatar || '' };
  });

  if (readers.length === 0) {
    return (
      <div className={`${rowBase} text-muted-foreground`}>
        <DoubleCheckIcon className="w-4 h-4 shrink-0" />
        <span className="text-[13px]">{tr('Chưa ai xem')}</span>
      </div>
    );
  }

  return (
    <div ref={rowRef} className="relative" onMouseEnter={() => setListOpen(true)} onMouseLeave={() => setListOpen(false)}>
      <button type="button" onClick={() => setListOpen((v) => !v)}
        className={`${rowBase} hover:bg-muted transition-colors text-foreground`}>
        <DoubleCheckIcon className="w-4 h-4 shrink-0 text-primary" />
        <span className="flex-1 text-[13px]">{trx('{{count}} đã xem', { count: readers.length })}</span>
        <span className="flex -space-x-1.5">
          {readers.slice(0, 3).map((r) => <PersonAvatar key={r.userId} name={r.name} avatar={r.avatar} size={20} />)}
        </span>
      </button>
      {listOpen && (
        <div
          className={`absolute w-72 max-h-[360px] overflow-y-auto bg-popover border border-border rounded-xl shadow-2xl py-1 ${
            placement.side === 'right' ? 'left-full ml-1' : 'right-full mr-1'} ${placement.align === 'top' ? 'top-0' : 'bottom-0'}`}>
          {readers.map((r) => (
            <div key={r.userId} className="flex items-center gap-3 px-3 py-2">
              <PersonAvatar name={r.name} avatar={r.avatar} size={32} />
              <div className="min-w-0">
                <p className="text-[13px] text-foreground truncate">{r.name}</p>
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <DoubleCheckIcon className="w-3 h-3 shrink-0" />
                  {formatReadTime(r.date) || tr('đã xem')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
