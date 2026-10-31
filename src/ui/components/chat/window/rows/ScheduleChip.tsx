/**
 * Nút "Tạo lịch hẹn" ngay dưới tin chữ có ngày giờ sắp tới, như Zalo: "mai 9h họp", "20 phút nữa", "20/11", "thứ 6 3h
 * chiều"… Bấm → "Thêm vào lịch" điền sẵn ngày giờ đọc từ tin (lib/chat/erp/viDateTime, tính từ lúc tin được gửi); tin chỉ có
 * ngày thì người dùng chọn giờ. Chỉ hiện khi đọc chắc chắn và chưa tới giờ hẹn (upcomingDateTimeInMessage, nhớ theo tin).
 * `children` = chỗ chừa cho giờ gửi của bong bóng: nằm cùng dòng với nút.
 */
import React from 'react';
import { CalendarIcon } from '@/components/common/icons';
import { upcomingDateTimeInMessage } from '@/lib/chat/erp/viDateTime';
import { erpRelativeDay } from '@/lib/erp/erpReminder';

const pad2 = (value: number) => String(value).padStart(2, '0');

/** "09:00 ngày mai"; chỉ có ngày: "ngày mai", "thứ 6, 30/10". */
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
        title={`Tạo lịch hẹn ${when}`}
        className="inline-flex min-w-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground select-none"
      >
        <CalendarIcon className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="truncate">Tạo lịch hẹn <span className="font-normal opacity-70">· {when}</span></span>
      </button>
      {children}
    </div>
  );
}
