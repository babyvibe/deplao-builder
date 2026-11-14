/**
 * Button "Tạo lịch hẹn" (Create appointment) right below a text message with a date / time coming up, like Zalo: "mai 9h họp", "20 phút nữa", "20/11",
 * "thứ 6 3h chiều"… Click → "Thêm vào lịch" (Add to calendar) pre-fills the date / time read from the message (lib/chat/erp/viDateTime, computed from when the message was sent); a message with only
 * a date: the user picks the time. Shown only when the reading is certain and the appointment time has not passed yet (upcomingDateTimeInMessage, remembered per message).
 * `children` = space reserved for the bubble's send time: on the same line as the button.
 */
import React from 'react';
import { CalendarIcon } from '@/components/common/icons';
import { upcomingDateTimeInMessage } from '@/lib/chat/erp/viDateTime';
import { erpRelativeDay } from '@/lib/erp/erpReminder';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const pad2 = (value: number) => String(value).padStart(2, '0');

/** "09:00 ngày mai" (09:00 tomorrow); date only: "ngày mai" (tomorrow), "thứ 6, 30/10" (Friday, 30/10). */
export function scheduleChipWhen(at: number, hasTime: boolean, now: Date = new Date()): string {
  const day = erpRelativeDay(at, now);
  if (!hasTime) return day;
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${day}`;
}

export default function ScheduleChip({ msgId, timestamp, text, onCreate, children }: {
  msgId: string | number;
  timestamp: number | string;
  text: string;
  onCreate: () => void;
  children?: React.ReactNode;
}) {
  const found = upcomingDateTimeInMessage({ msg_id: msgId, timestamp, text });
  if (!found) return <>{children}</>;
  const when = scheduleChipWhen(found.at, found.hasTime);
  return (
    <div className="mt-1.5 flex items-center">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onCreate(); }}
        onDoubleClick={e => e.stopPropagation()}
        title={tr('Tạo lịch hẹn {{when}}', { when })}
        className="inline-flex min-w-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground select-none"
      >
        <CalendarIcon className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="truncate">{trx('Tạo lịch hẹn <0>· {{when}}</0>', { 0: <span className="font-normal opacity-70" />, when })}</span>
      </button>
      {children}
    </div>
  );
}
