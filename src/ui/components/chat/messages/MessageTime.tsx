/**
 * Sent time shown in a message, shared by all message types for consistency.
 *  - BubbleTime: small time line at the bottom of a bubble / caption / card (file, link, contact card…).
 *  - MediaTimeBadge: time floating at the bottom right of images/album/video/sticker WITHOUT a caption
 *    (placed in a `relative` element).
 *  - TextWithInlineTime: text + time at the bottom right, on the last text line if there is room (as in Telegram).
 * Own messages: a status tick next to the time (✓ sent, ✓✓ received, ✓✓ in accent color = seen), from the MessageStatusContext that
 * ChatWindow provides for each message (lib/chat/messages/messageStatus.ts). Hover over the time: full date and time (as in Telegram).
 */
import React from 'react';
import { outgoingStatusLabel, type OutgoingStatus } from '@/lib/chat/messages/messageStatus';
import { ZALO_TTL_EXPIRED_LABEL, isZaloTtlExpired, zaloAutoDeleteLabel, zaloTtlExpiresAt } from '../../../../shared/zalo/zaloAutoDelete';
import { tr, appLocale } from '../../../../shared/i18n';

/** Status of MY sent message being drawn (ChatWindow provides it per message); null = no tick drawn (received messages / channel does not support it). */
export const MessageStatusContext = React.createContext<OutgoingStatus | null>(null);

/** Zalo self-delete timer for the message being drawn (ms, ZL-05); 0 = none. Deplao does not delete messages by TTL, it only shows the clock. */
export const MessageTtlContext = React.createContext<number>(0);

/**
 * The message row draws the send time itself, on the last line of the frame (Telegram reaction chips): the content's own time
 * (photo badge, caption, file / card time line) is not drawn, so it does not show twice.
 */
export const MessageTimeElsewhereContext = React.createContext<boolean>(false);

const MAX_TIMER_MS = 2_147_000_000;

/** Whether the message is past its Zalo self-delete time (sent time + ttl); updates itself when due while the conversation is open. */
export function useZaloTtlExpired(sentAt?: number | string | null, ttl?: number | null): boolean {
  const expiresAt = zaloTtlExpiresAt(sentAt, ttl);
  const [expired, setExpired] = React.useState(() => isZaloTtlExpired(sentAt, ttl));
  React.useEffect(() => {
    const left = expiresAt ? expiresAt - Date.now() : 0;
    setExpired(expiresAt > 0 && left <= 0);
    if (!expiresAt || left <= 0 || left > MAX_TIMER_MS) return;
    const timer = window.setTimeout(() => setExpired(true), left);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}

/**
 * Small clock next to the sent time when the message has a Zalo self-delete timer; once expired → a crossed-out clock with "Đã tự xoá trên Zalo" (Deleted on Zalo)
 * (Deplao still keeps the content, FR-ZL05.6). `sentAt` = sent time (ms).
 */
export function TtlMark({ ttl, sentAt, className = '' }: { ttl?: number | null; sentAt?: number | string | null; className?: string }) {
  const value = Number(ttl) || 0;
  const expired = useZaloTtlExpired(sentAt, value);
  if (value <= 0) return null;
  const label = expired
    ? tr('{{ZALO_TTL_EXPIRED_LABEL}} (sau {{v1}}) — Deplao vẫn giữ tin này trên máy', { ZALO_TTL_EXPIRED_LABEL, v1: zaloAutoDeleteLabel(value) })
    : tr('Zalo tự xoá tin này sau {{v1}} — Deplao vẫn giữ trên máy này', { v1: zaloAutoDeleteLabel(value) });
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-label={label} className={`inline-block flex-shrink-0 ${className}`}
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <title>{label}</title>
      <circle cx="6" cy="6.6" r="4.4" />
      <path d="M6 4.4v2.4l1.4.9M4.6 1.2h2.8" />
      {expired && <path d="M1.4 2.2l9.2 9" />}
    </svg>
  );
}

/** "(đã tự xoá trên Zalo)" (deleted on Zalo) after the text of a message past its self-delete time, like "(đã chỉnh sửa)" (edited). */
export function TtlExpiredNote({ ttl, sentAt }: { ttl?: number | null; sentAt?: number | string | null }) {
  const expired = useZaloTtlExpired(sentAt, ttl);
  if (!expired) return null;
  return (
    <span className="ml-1 text-[10px] opacity-60 select-none font-normal"
      title={tr('Zalo đã xoá tin này trên điện thoại và Zalo PC theo hẹn tự xoá; Deplao vẫn giữ trên máy này')}>
      ({ZALO_TTL_EXPIRED_LABEL.charAt(0).toLowerCase() + ZALO_TTL_EXPIRED_LABEL.slice(1)})
    </span>
  );
}

/** Space reserved at the end of the text line for the time floating in the corner (room for the ✓ tick and the self-delete clock). */
export function inlineTimeSpacerClass(hasStatus: boolean, ttl?: number | null): string {
  const timer = (Number(ttl) || 0) > 0;
  if (hasStatus) return timer ? 'w-[4rem]' : 'w-[3.25rem]';
  return timer ? 'w-12' : 'w-9';
}

export function formatBubbleTime(timestamp?: number | string | null): string {
  const n = Number(timestamp);
  if (!n || !Number.isFinite(n)) return '';
  // 24-hour in every language: the space kept for the time at the end of the last text line (inlineTimeSpacerClass)
  // fits "15:50", a 12-hour "03:50 PM" would overlap the text
  return new Date(n).toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** Full date and time for the tooltip when hovering over the sent time (e.g. "Thứ Ba, 20 tháng 10, 2026 lúc 11:11:27" (Tuesday, 20 October 2026, 11:11:27)). */
export function formatFullDateTime(timestamp?: number | string | null): string {
  const n = Number(timestamp);
  if (!n || !Number.isFinite(n)) return '';
  return new Date(n).toLocaleString(appLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * Status tick on sent messages: clock (sending), red ! (error), ✓ (sent), ✓✓ (received), accent-colored ✓✓ (seen).
 * `mono`: on an image background (the time badge): keeps the badge's text color, does not change the "seen" color.
 */
export function StatusTicks({ status, mono = false, className = '' }: {
  status: OutgoingStatus | null | undefined; mono?: boolean; className?: string;
}) {
  if (!status) return null;
  const label = outgoingStatusLabel(status);
  if (status === 'sending') {
    return (
      <svg viewBox="0 0 12 12" width="11" height="11" aria-label={label} className={`inline-block flex-shrink-0 ${className}`}
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <title>{label}</title>
        <circle cx="6" cy="6" r="4.8" />
        <path d="M6 3.4V6l1.8 1.2" />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg viewBox="0 0 12 12" width="11" height="11" aria-label={label} className={`inline-block flex-shrink-0 text-destructive ${className}`}
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <title>{label}</title>
        <circle cx="6" cy="6" r="4.8" />
        <path d="M6 3.4v3M6 8.4v.1" />
      </svg>
    );
  }
  const double = status === 'delivered' || status === 'read';
  return (
    <svg viewBox="0 0 16 11" width="16" height="11" aria-label={label}
      className={`inline-block flex-shrink-0 ${status === 'read' && !mono ? 'chat-tick-read' : ''} ${className}`}
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <title>{label}</title>
      {double ? (
        <>
          <path d="M1.5 5.8l2.9 2.9 5.6-6.6" />
          <path d="M6.9 8.7l5.6-6.6" />
        </>
      ) : (
        <path d="M3.5 5.8l2.9 2.9 5.6-6.6" />
      )}
    </svg>
  );
}

export function BubbleTime({ timestamp, className = '' }: { timestamp?: number | string | null; className?: string }) {
  const status = React.useContext(MessageStatusContext);
  const ttl = React.useContext(MessageTtlContext);
  const elsewhere = React.useContext(MessageTimeElsewhereContext);
  const t = formatBubbleTime(timestamp);
  if (!t || elsewhere) return null;
  return (
    <div className={`mt-1 flex items-center gap-0.5 text-[11px] leading-none text-subtle-foreground select-none cursor-default ${className}`}
      title={formatFullDateTime(timestamp)}>
      <TtlMark ttl={ttl} sentAt={timestamp} />
      {t}
      <StatusTicks status={status} />
    </div>
  );
}

/**
 * Text (caption) + sent time at the bottom right, on the last text line if there is room (as in Telegram; same style as text messages in
 * ChatWindow): space at the end of the line reserves room, the time floats in the corner. `children` must be inline content (TextWithMentions).
 */
export function TextWithInlineTime({ timestamp, children, className = '' }: {
  timestamp?: number | string | null; children: React.ReactNode; className?: string;
}) {
  const status = React.useContext(MessageStatusContext);
  const ttl = React.useContext(MessageTtlContext);
  const elsewhere = React.useContext(MessageTimeElsewhereContext);
  const t = elsewhere ? '' : formatBubbleTime(timestamp);
  return (
    <div className={`relative ${className}`}>
      {children}
      {t && <span aria-hidden="true" className={`inline-block ${inlineTimeSpacerClass(!!status, ttl)} select-none`} />}
      {t && (
        <span className="absolute -bottom-0.5 right-0 inline-flex items-center gap-0.5 text-[11px] leading-none text-subtle-foreground select-none cursor-default"
          title={formatFullDateTime(timestamp)}>
          <TtlMark ttl={ttl} sentAt={timestamp} />
          {t}
          <StatusTicks status={status} />
        </span>
      )}
    </div>
  );
}

export function MediaTimeBadge({ timestamp, className = '' }: { timestamp?: number | string | null; className?: string }) {
  const status = React.useContext(MessageStatusContext);
  const ttl = React.useContext(MessageTtlContext);
  const elsewhere = React.useContext(MessageTimeElsewhereContext);
  const t = formatBubbleTime(timestamp);
  if (!t || elsewhere) return null;
  return (
    <span
      className={`pointer-events-none absolute bottom-1.5 right-1.5 z-[1] inline-flex items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-[3px] text-[11px] leading-none text-white select-none ${className}`}
    >
      <TtlMark ttl={ttl} sentAt={timestamp} />
      {t}
      <StatusTicks status={status} mono />
    </span>
  );
}
