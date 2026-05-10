import { create } from 'zustand';
import ipc from '@/lib/ipc';
import type { CreateCalendarEventInput, ErpCalendarEvent } from '../../../models/erp';

interface ErpCalendarState {
  events: ErpCalendarEvent[];
  loading: boolean;
  error: string | null;
  currentRange: { from: number; to: number } | null;

  loadEvents: (from: number, to: number, organizerId?: string) => Promise<void>;
  createEvent: (input: CreateCalendarEventInput) => Promise<ErpCalendarEvent | null>;
  updateEvent: (id: string, patch: Partial<CreateCalendarEventInput>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  _onEventCreated: (event: ErpCalendarEvent) => void;
  _onEventUpdated: (eventId: string, event?: ErpCalendarEvent | null) => void;
  _onEventDeleted: (eventId: string) => void;
}

export const useErpCalendarStore = create<ErpCalendarState>((set, get) => ({
  events: [],
  loading: false,
  error: null,
  currentRange: null,

  loadEvents: async (from, to, organizerId) => {
    set({ loading: true, currentRange: { from, to } });
    const res = await ipc.erp?.calendarListEvents({ from, to, organizerId });
    if (res?.success) set({ events: res.events, loading: false });
    else set({ error: res?.error, loading: false });
  },

  createEvent: async (input) => {
    const res = await ipc.erp?.calendarCreate({ input });
    if (res?.success && res.event) {
      set(s => ({ events: reconcileEventForRange(s.events, res.event, s.currentRange) }));
      return res.event;
    }
    return null;
  },

  updateEvent: async (id, patch) => {
    const res = await ipc.erp?.calendarUpdate({ id, patch });
    if (res?.success && res.event) {
      set(s => ({ events: reconcileEventForRange(s.events, res.event, s.currentRange) }));
    }
  },

  deleteEvent: async (id) => {
    await ipc.erp?.calendarDelete({ id });
    set(s => ({ events: s.events.filter(e => e.id !== id) }));
  },

  _onEventCreated: (event) => set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) })),
  _onEventUpdated: (eventId, event) => {
    if (event) {
      set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) }));
      return;
    }
    // Reload single event — simple re-fetch pattern
    const { currentRange } = get();
    if (currentRange) get().loadEvents(currentRange.from, currentRange.to);
  },
  _onEventDeleted: (eventId) => set(s => ({ events: s.events.filter(e => e.id !== eventId) })),
}));

function upsertEvent(events: ErpCalendarEvent[], event: ErpCalendarEvent): ErpCalendarEvent[] {
  const idx = events.findIndex(item => item.id === event.id);
  if (idx >= 0) {
    const next = [...events];
    next[idx] = event;
    return next;
  }
  return [...events, event].sort((a, b) => a.start_at - b.start_at);
}

function eventOverlapsRange(event: ErpCalendarEvent, range: { from: number; to: number } | null): boolean {
  if (!range) return true;
  const endAt = event.end_at ?? event.start_at;
  return event.start_at < range.to && endAt >= range.from;
}

function reconcileEventForRange(
  events: ErpCalendarEvent[],
  event: ErpCalendarEvent,
  range: { from: number; to: number } | null,
): ErpCalendarEvent[] {
  if (!eventOverlapsRange(event, range)) {
    return events.filter(item => item.id !== event.id);
  }
  return upsertEvent(events, event);
}

