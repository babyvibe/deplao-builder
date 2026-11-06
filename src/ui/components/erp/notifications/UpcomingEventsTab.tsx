/**
 * Tab "Lịch sắp tới" của chuông thông báo: lịch Quản lý công việc của mình từ giờ tới hết 7 ngày tới (đang diễn ra ở
 * đầu), theo ngày. Mỗi dòng ghi mốc "Nhắc trước" của chính lịch đó (báo trước / đúng giờ do mốc này — sửa ở trang Lịch).
 * Bấm lịch: mở hội thoại gắn với lịch (nhảy tới tin), không có thì mở trang Lịch.
 */
import React, { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chat/chatStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useErpUpcomingStore } from '@/store/erp/erpUpcomingStore';
import { hasLinkedConversation, openLinkedConversation } from '@/lib/erp/erpLinkedConversation';
import { ERP_EVENT_EMOJI } from '@/lib/erp/erpReminder';
import {
  groupUpcomingByDay, myUpcomingEvents, upcomingReminderText, upcomingStatus, upcomingTimeText, type UpcomingTone,
} from '@/lib/erp/upcomingEvents';
import type { ErpCalendarEvent } from '../../../../models/erp';

const TONE_CLASS: Record<UpcomingTone, string> = {
  live: 'text-green-500',
  soon: 'text-amber-500',
  later: 'text-muted-foreground',
};

export function openErpCalendarPage(): void {
  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'erp' } }));
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('nav:erp', { detail: { subView: 'calendar' } })), 80);
}

/** Tên hội thoại gắn với lịch (danh bạ đã tải). */
function linkedConversationName(event: ErpCalendarEvent): string {
  if (!hasLinkedConversation(event)) return '';
  const contacts = useChatStore.getState().contacts[String(event.linked_account_id)] || [];
  const contact = contacts.find(c => c.contact_id === String(event.linked_contact_id));
  return String(contact?.alias || contact?.display_name || '');
}

/** Số lịch còn lại trong hôm nay (đếm trên tab). */
export function useUpcomingTodayCount(): number {
  const events = useErpUpcomingStore(s => s.events);
  const myId = useEmployeeStore(s => (s.mode === 'employee' ? String(s.currentEmployee?.employee_id || '') : 'boss'));
  const now = Date.now();
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  return myUpcomingEvents(events, myId, now).filter(event => Number(event.start_at) <= endToday.getTime()).length;
}

export default function UpcomingEventsTab({ onClose }: { onClose?: () => void }) {
  const events = useErpUpcomingStore(s => s.events);
  const loaded = useErpUpcomingStore(s => s.loaded);
  const loading = useErpUpcomingStore(s => s.loading);
  const error = useErpUpcomingStore(s => s.error);
  const myId = useEmployeeStore(s => (s.mode === 'employee' ? String(s.currentEmployee?.employee_id || '') : 'boss'));
  // Đếm ngược "còn 25 phút" tự cập nhật khi bảng đang mở
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { void useErpUpcomingStore.getState().load(); }, []);

  const mine = myUpcomingEvents(events, myId, now);
  const groups = groupUpcomingByDay(mine, now);

  const openEvent = (event: ErpCalendarEvent) => {
    if (hasLinkedConversation(event)) openLinkedConversation(event);
    else openErpCalendarPage();
    onClose?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded && loading && <div className="p-6 text-center text-xs text-muted-foreground">Đang tải lịch…</div>}
        {!loaded && !loading && error && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Không tải được lịch.{' '}
            <button type="button" onClick={() => void useErpUpcomingStore.getState().load()} className="text-primary hover:underline">Thử lại</button>
          </div>
        )}
        {loaded && groups.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">Không có lịch trong 7 ngày tới</div>
        )}
        {groups.map(group => (
          <div key={group.label}>
            <div className="sticky top-0 bg-card/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">{group.label}</div>
            {group.items.map(event => {
              const status = upcomingStatus(event, now);
              const conversation = linkedConversationName(event);
              const details = [upcomingTimeText(event), event.location].filter(Boolean).join(' · ');
              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => openEvent(event)}
                  title={hasLinkedConversation(event) ? 'Mở hội thoại gắn với lịch' : 'Mở trang Lịch'}
                  className="flex w-full items-start gap-2.5 border-b border-border/40 px-3 py-2 text-left hover:bg-muted/60"
                >
                  <span className="mt-0.5 text-sm leading-none" aria-hidden>{ERP_EVENT_EMOJI[event.type] || '📅'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{event.title}</span>
                      {status.text && <span className={`shrink-0 text-[10px] font-semibold ${TONE_CLASS[status.tone]}`}>{status.text}</span>}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{details}</div>
                    {conversation && <div className="truncate text-[11px] text-muted-foreground">💬 {conversation}</div>}
                    <div className="truncate text-[10px] text-subtle-foreground">⏰ {upcomingReminderText(event)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-right">
        <button type="button" onClick={() => { openErpCalendarPage(); onClose?.(); }} className="text-[11px] font-medium text-primary hover:underline">
          Mở Lịch
        </button>
      </div>
    </div>
  );
}
