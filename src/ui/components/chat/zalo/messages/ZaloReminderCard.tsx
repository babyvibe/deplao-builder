import React from 'react';
import { useZaloReminderTitle } from '@/hooks/zalo/useZaloReminderTitle';
import { tr, trc } from '../../../../../shared/i18n';
import type { ZaloReminderCardInfo } from '../../../../../shared/zalo/zaloReminderCard';

/** Weekday on the small calendar tile: short labels, a full weekday name does not fit the tile in other languages. */
function tileWeekday(date: Date): string {
  const days = [
    trc('ô lịch', 'CHỦ NHẬT'), trc('ô lịch', 'THỨ HAI'), trc('ô lịch', 'THỨ BA'), trc('ô lịch', 'THỨ TƯ'),
    trc('ô lịch', 'THỨ NĂM'), trc('ô lịch', 'THỨ SÁU'), trc('ô lịch', 'THỨ BẢY'),
  ];
  return days[date.getDay()];
}

/** Month on the small calendar tile (short form for the same reason). */
function tileMonth(date: Date): string {
  const months = [
    trc('ô lịch', 'THÁNG 1'), trc('ô lịch', 'THÁNG 2'), trc('ô lịch', 'THÁNG 3'), trc('ô lịch', 'THÁNG 4'),
    trc('ô lịch', 'THÁNG 5'), trc('ô lịch', 'THÁNG 6'), trc('ô lịch', 'THÁNG 7'), trc('ô lịch', 'THÁNG 8'),
    trc('ô lịch', 'THÁNG 9'), trc('ô lịch', 'THÁNG 10'), trc('ô lịch', 'THÁNG 11'), trc('ô lịch', 'THÁNG 12'),
  ];
  return months[date.getMonth()];
}

/** "Thứ Tư, 25 tháng 11 lúc 10:28" (same words as Zalo's own date line). */
function reminderDateText(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const weekDays = [tr('Chủ Nhật'), tr('Thứ Hai'), tr('Thứ Ba'), tr('Thứ Tư'), tr('Thứ Năm'), tr('Thứ Sáu'), tr('Thứ Bảy')];
  const months = [
    tr('tháng 1'), tr('tháng 2'), tr('tháng 3'), tr('tháng 4'), tr('tháng 5'), tr('tháng 6'),
    tr('tháng 7'), tr('tháng 8'), tr('tháng 9'), tr('tháng 10'), tr('tháng 11'), tr('tháng 12'),
  ];
  return tr('{{v1}}, {{v2}} {{v3}} lúc {{v4}}:{{v5}}', {
    v1: weekDays[date.getDay()], v2: date.getDate(), v3: months[date.getMonth()], v4: pad(date.getHours()), v5: pad(date.getMinutes()),
  });
}

/**
 * Zalo reminder card (chat.ecard with action.open.reminder): calendar tile, title, time, repeat. The title is shown in
 * full and wraps: Zalo sends long titles cut ("... - ..."), the whole one is looked up once (useZaloReminderTitle). The
 * one-line system notice under the card keeps its ellipsis.
 */
export function ZaloReminderCard({ msg, card }: { msg: any; card: ZaloReminderCardInfo }) {
  const title = useZaloReminderTitle(msg, card);
  const date = card.startTime > 0 ? new Date(card.startTime) : null;
  const repeatText = card.repeat === 1 ? tr('Nhắc theo ngày')
    : card.repeat === 2 ? tr('Nhắc theo tuần')
      : card.repeat === 3 ? tr('Nhắc theo tháng') : '';

  return (
    <div className="flex justify-center w-full my-1">
      <div className="bg-bubble-in rounded-2xl overflow-hidden max-w-[300px] w-full shadow-sm">
        <div className="flex gap-3 p-4">
          {date && (
            <div className="flex-shrink-0 w-14 rounded-xl overflow-hidden border border-input bg-muted flex flex-col items-center">
              <div className="w-full bg-blue-600 py-0.5 text-center text-white text-[11px] font-bold tracking-wide">
                {tileWeekday(date)}
              </div>
              <div className="flex-1 flex flex-col items-center justify-center py-1">
                <span className="text-foreground text-2xl font-bold leading-none">{date.getDate()}</span>
                <span className="text-muted-foreground text-[11px] mt-0.5">{tileMonth(date)}</span>
              </div>
            </div>
          )}
          <div className="flex-1 min-w-0">
            {/* pre-line: titles pasted with a tab or double spaces read as one space, line breaks stay */}
            <p className="text-foreground font-semibold text-sm whitespace-pre-line break-words">{card.emoji} {title}</p>
            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{date ? reminderDateText(date) : card.description}</span>
            </div>
            {repeatText && (
              <div className="flex items-center gap-1 mt-0.5 text-xs text-orange-400">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0">
                  <path d="M17 1l4 4-4 4" />
                  <path d="M3 11V9a4 4 0 014-4h14" />
                  <path d="M7 23l-4-4 4-4" />
                  <path d="M21 13v2a4 4 0 01-4 4H3" />
                </svg>
                <span>{repeatText}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ZaloReminderCard;
