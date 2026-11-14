/**
 * The user's own upcoming events (next 7 days) for the "Lịch sắp tới" (Upcoming events) tab of the notification bell (loaded by hooks/erp/useUpcomingEvents).
 * Separate from erpCalendarStore (the Calendar page loads the week / month being viewed).
 * Employees: the events are on the owner's machine (REST, DataAccessor). Read error → keep the list currently shown.
 */
import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import type { ErpCalendarEvent } from '../../../models/erp';
import { upcomingRange } from '@/lib/erp/upcomingEvents';
import { tr } from '../../../shared/i18n';

interface ErpUpcomingState {
  events: ErpCalendarEvent[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useErpUpcomingStore = create<ErpUpcomingState>((set) => ({
  events: [],
  loaded: false,
  loading: false,
  error: null,
  load: () => {
    if (inFlight) return inFlight;
    set({ loading: true });
    inFlight = (async () => {
      try {
        const { from, to } = upcomingRange(Date.now());
        const res: any = await DataAccessor.erpCalendarEvents({ from, to });
        const events = res?.events ?? res?.data?.events;
        if (res?.success !== false && Array.isArray(events)) set({ events, loaded: true, loading: false, error: null });
        else set({ loading: false, error: res?.error || tr('Không tải được lịch') });
      } catch (err: any) {
        set({ loading: false, error: err?.message || tr('Không tải được lịch') });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
