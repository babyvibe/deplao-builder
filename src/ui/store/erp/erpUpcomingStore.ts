/**
 * Lịch sắp tới của mình (7 ngày tới) cho tab "Lịch sắp tới" của chuông thông báo (tải: hooks/erp/useUpcomingEvents).
 * Tách khỏi erpCalendarStore (trang Lịch tải theo tuần / tháng đang xem).
 * Nhân viên: lịch trên Boss (REST, DataAccessor). Lỗi đọc → giữ danh sách đang có.
 */
import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import type { ErpCalendarEvent } from '../../../models/erp';
import { upcomingRange } from '@/lib/erp/upcomingEvents';

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
        else set({ loading: false, error: res?.error || 'Không tải được lịch' });
      } catch (err: any) {
        set({ loading: false, error: err?.message || 'Không tải được lịch' });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
