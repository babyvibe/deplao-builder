/**
 * Upcoming events on the title bar: early reminders (ErpCalendarService → 'erp:event:reminder' with minutesBefore > 0, App.tsx
 * listens) make the bell ring + show "15 phút nữa tới lịch hẹn" next to the bell (TopBar). The reminder notification sits in the bell like a regular
 * notification (created by main). Opening the bell = seen → stops ringing; the text stays until the reminder notification is read (NotificationCenter), until
 * the appointment time (the on-time popup replaces it), or until the event has started.
 */
import { create } from 'zustand';

export interface UpcomingErpReminder {
  eventId: string;
  title: string;
  startAt: number;
}

interface ErpReminderAttentionState {
  /** Sorted by appointment time (nearest first). */
  items: UpcomingErpReminder[];
  ringing: boolean;
  raise: (item: UpcomingErpReminder) => void;
  /** Bell opened: stop ringing. */
  acknowledge: () => void;
  /** Mark as read / delete the reminder notifications of these events; not passed = all ("Đọc hết" (Read all), "Xoá hết" (Delete all)). */
  dismiss: (eventIds?: string[]) => void;
  /** Remove events whose time has come. */
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
