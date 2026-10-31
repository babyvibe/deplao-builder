import { create } from 'zustand';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import type { CreateCalendarEventInput, ErpCalendarEvent } from '../../../models/erp';
import { withErpDeniedNotice } from './erpStoreHelpers';

function isEmployee(): boolean {
  try { return useEmployeeStore.getState().mode === 'employee'; } catch { return false; }
}

/** Sự kiện trong phản hồi: IPC `{ success, event }`, REST (nhân viên) `{ success, data: { event } }`. */
function eventOf(res: any): ErpCalendarEvent | null {
  return res?.event ?? res?.data?.event ?? null;
}

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

  // Nhân viên: lịch nằm trên DB Boss (REST qua DataAccessor) — IPC ở máy nhân viên đọc / ghi DB cục bộ (trống, không
  // tới Boss, không phát erp:event cho người khác). Lỗi đọc → giữ lịch đang hiện.
  loadEvents: async (from, to, organizerId) => {
    set({ loading: true, currentRange: { from, to } });
    const res: any = isEmployee()
      ? await DataAccessor.erpCalendarEvents({ from, to, organizerId })
      : await ipc.erp?.calendarListEvents({ from, to, organizerId });
    const events = res?.events ?? res?.data?.events;
    if (res?.success && Array.isArray(events)) set({ events, loading: false, error: null });
    else set({ error: res?.error || 'Không tải được lịch', loading: false });
  },

  // Lệnh ghi bị từ chối quyền (Boss kiểm tra quyền ERP của nhân viên) → hộp thoại quyền ERP như ipc.erp
  createEvent: async (input) => {
    const res: any = withErpDeniedNotice(isEmployee()
      ? await DataAccessor.erpCalendarCreate(input)
      : await ipc.erp?.calendarCreate({ input }));
    const event = res?.success ? eventOf(res) : null;
    if (event) {
      set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) }));
      return event;
    }
    return null;
  },

  updateEvent: async (id, patch) => {
    const res: any = withErpDeniedNotice(isEmployee()
      ? await DataAccessor.erpCalendarUpdate(id, patch)
      : await ipc.erp?.calendarUpdate({ id, patch }));
    const event = res?.success ? eventOf(res) : null;
    if (event) {
      set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) }));
    }
  },

  deleteEvent: async (id) => {
    const res: any = withErpDeniedNotice(isEmployee()
      ? await DataAccessor.erpCalendarDelete(id)
      : await ipc.erp?.calendarDelete({ id }));
    if (res && res.success === false) return; // Boss từ chối / mất kết nối: giữ sự kiện
    set(s => ({ events: s.events.filter(e => e.id !== id) }));
  },

  _onEventCreated: (event) => set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) })),
  _onEventUpdated: (eventId, event) => {
    if (event) {
      set(s => ({ events: reconcileEventForRange(s.events, event, s.currentRange) }));
      return;
    }
    // Reload single event - simple re-fetch pattern
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

