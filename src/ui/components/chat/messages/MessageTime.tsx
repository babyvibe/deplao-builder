/**
 * Giờ gửi hiển thị trong tin nhắn — dùng chung cho mọi loại tin để đồng nhất.
 *  - BubbleTime: dòng giờ nhỏ ở cuối bong bóng / caption / thẻ (file, link, danh thiếp…).
 *  - MediaTimeBadge: giờ nổi góc dưới phải trên ảnh/album/video/sticker KHÔNG có caption
 *    (đặt trong một phần tử `relative`).
 *  - TextWithInlineTime: chữ + giờ ở góc dưới phải, chung dòng chữ cuối nếu đủ chỗ (như Telegram).
 * Tin mình gửi: dấu trạng thái cạnh giờ (✓ đã gửi, ✓✓ đã nhận, ✓✓ màu nhấn = đã xem) theo MessageStatusContext mà
 * ChatWindow cấp cho từng tin (lib/chat/messages/messageStatus.ts). Rê chuột vào giờ: ngày giờ đầy đủ (như Telegram).
 */
import React from 'react';
import { outgoingStatusLabel, type OutgoingStatus } from '@/lib/chat/messages/messageStatus';
import { ZALO_TTL_EXPIRED_LABEL, isZaloTtlExpired, zaloAutoDeleteLabel, zaloTtlExpiresAt } from '../../../../shared/zalo/zaloAutoDelete';

/** Trạng thái tin MÌNH gửi đang vẽ (ChatWindow cấp theo từng tin); null = không vẽ dấu (tin nhận / kênh không hỗ trợ). */
export const MessageStatusContext = React.createContext<OutgoingStatus | null>(null);

/** Thời gian tự xoá Zalo gắn cho tin đang vẽ (ms, ZL-05); 0 = không. Deplao không xoá tin theo TTL — chỉ hiện đồng hồ. */
export const MessageTtlContext = React.createContext<number>(0);

const MAX_TIMER_MS = 2_147_000_000;

/** Tin đã quá hạn tự xoá trên Zalo chưa (giờ gửi + ttl); tự đổi khi tới hạn lúc đang mở hội thoại. */
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
 * Đồng hồ nhỏ cạnh giờ gửi khi tin có hẹn tự xoá trên Zalo; quá hạn → đồng hồ gạch chéo "Đã tự xoá trên Zalo"
 * (Deplao vẫn giữ nội dung — FR-ZL05.6). `sentAt` = giờ gửi (ms).
 */
export function TtlMark({ ttl, sentAt, className = '' }: { ttl?: number | null; sentAt?: number | string | null; className?: string }) {
  const value = Number(ttl) || 0;
  const expired = useZaloTtlExpired(sentAt, value);
  if (value <= 0) return null;
  const label = expired
    ? `${ZALO_TTL_EXPIRED_LABEL} (sau ${zaloAutoDeleteLabel(value)}) — Deplao vẫn giữ tin này trên máy`
    : `Zalo tự xoá tin này sau ${zaloAutoDeleteLabel(value)} — Deplao vẫn giữ trên máy này`;
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

/** "(đã tự xoá trên Zalo)" sau chữ của tin đã quá hạn tự xoá, như "(đã chỉnh sửa)". */
export function TtlExpiredNote({ ttl, sentAt }: { ttl?: number | null; sentAt?: number | string | null }) {
  const expired = useZaloTtlExpired(sentAt, ttl);
  if (!expired) return null;
  return (
    <span className="ml-1 text-[10px] opacity-60 select-none font-normal"
      title="Zalo đã xoá tin này trên điện thoại và Zalo PC theo hẹn tự xoá; Deplao vẫn giữ trên máy này">
      ({ZALO_TTL_EXPIRED_LABEL.charAt(0).toLowerCase() + ZALO_TTL_EXPIRED_LABEL.slice(1)})
    </span>
  );
}

/** Chỗ chừa cuối dòng chữ cho giờ gửi nổi ở góc (thêm chỗ cho dấu ✓ và đồng hồ tự xoá). */
export function inlineTimeSpacerClass(hasStatus: boolean, ttl?: number | null): string {
  const timer = (Number(ttl) || 0) > 0;
  if (hasStatus) return timer ? 'w-[4rem]' : 'w-[3.25rem]';
  return timer ? 'w-12' : 'w-9';
}

export function formatBubbleTime(timestamp?: number | string | null): string {
  const n = Number(timestamp);
  if (!n || !Number.isFinite(n)) return '';
  return new Date(n).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

/** Ngày giờ đầy đủ cho tooltip khi rê chuột vào giờ gửi (vd "Thứ Ba, 20 tháng 10, 2026 lúc 11:11:27"). */
export function formatFullDateTime(timestamp?: number | string | null): string {
  const n = Number(timestamp);
  if (!n || !Number.isFinite(n)) return '';
  return new Date(n).toLocaleString('vi-VN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * Dấu trạng thái tin gửi: đồng hồ (đang gửi), ! đỏ (lỗi), ✓ (đã gửi), ✓✓ (đã nhận), ✓✓ màu nhấn (đã xem).
 * `mono`: trên nền ảnh (huy hiệu giờ) — giữ màu chữ của huy hiệu, không đổi màu "đã xem".
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
  const t = formatBubbleTime(timestamp);
  if (!t) return null;
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
 * Chữ (caption) + giờ gửi ở góc dưới phải, chung dòng chữ cuối nếu đủ chỗ (như Telegram; cùng kiểu tin chữ trong
 * ChatWindow): khoảng trống cuối dòng giữ chỗ, giờ nổi ở góc. `children` phải là nội dung inline (TextWithMentions).
 */
export function TextWithInlineTime({ timestamp, children, className = '' }: {
  timestamp?: number | string | null; children: React.ReactNode; className?: string;
}) {
  const status = React.useContext(MessageStatusContext);
  const ttl = React.useContext(MessageTtlContext);
  const t = formatBubbleTime(timestamp);
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
  const t = formatBubbleTime(timestamp);
  if (!t) return null;
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
