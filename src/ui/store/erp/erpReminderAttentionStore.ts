/**
 * Lịch sắp tới trên thanh tiêu đề: nhắc trước (ErpCalendarService → 'erp:event:reminder' với minutesBefore > 0, App.tsx
 * nghe) làm chuông rung + hiện "15 phút nữa tới lịch hẹn" cạnh chuông (TopBar). Thông báo nhắc nằm trong chuông như thông
 * báo thường (main tạo). Mở chuông = đã thấy → thôi rung, chữ còn tới khi đọc thông báo nhắc (NotificationCenter), tới
 * giờ hẹn (popup đúng giờ thay thế) hoặc lịch đã bắt đầu.
 */
import { create } from 'zustand';

export interface UpcomingErpReminder {
  eventId: string;
  title: string;
  startAt: number;
}

interface ErpReminderAttentionState {
  /** Sắp theo giờ hẹn (gần nhất trước). */
  items: UpcomingErpReminder[];
  ringing: boolean;
  raise: (item: UpcomingErpReminder) => void;
  /** Đã mở chuông: thôi rung. */
  acknowledge: () => void;
  /** Đã đọc / xoá thông báo nhắc của các lịch này; không truyền = tất cả ("Đọc hết", "Xoá hết"). */
  dismiss: (eventIds?: string[]) => void;
  /** Bỏ lịch đã tới giờ. */
  prune: (now?: number) => void;
}

const keep = (state: ErpReminderAttentionState, items: UpcomingErpReminder[]) => (
  items.length === state.items.length ? state : { items, ringing: state.ringing && items.length > 0 }
);

export const useErpReminderAttention = create<ErpReminderAttentionState>(set => ({
  items: [],
  ringing: false,
  raise: item => set(state => ({
    items: [...state.items.filter(existing => existing.eventId !== item.eventId), item].sort((a, b) => a.startAt - b.startAt),
    ringing: true,
  })),
  acknowledge: () => set(state => (state.ringing ? { ringing: false } : state)),
  dismiss: eventIds => set(state => keep(state, eventIds ? state.items.filter(item => !eventIds.includes(item.eventId)) : [])),
  prune: (now = Date.now()) => set(state => keep(state, state.items.filter(item => item.startAt > now))),
}));
