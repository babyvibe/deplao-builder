/**
 * Mount một lần (TopBar, cạnh chuông thông báo): tải lịch sắp tới của mình cho tab "Lịch sắp tới"
 * (store/erp/erpUpcomingStore) và tải lại khi lịch đổi (event realtime), 5 phút một lần, khi nhân viên kết nối lại Boss.
 * Nhắc trước / đúng giờ vẫn do mốc nhắc của từng lịch (main) — hook này không báo gì.
 */
import { useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { useErpUpcomingStore } from '@/store/erp/erpUpcomingStore';

const RELOAD_EVERY_MS = 5 * 60_000;
const RELOAD_DEBOUNCE_MS = 500;
const CALENDAR_EVENTS = ['erp:event:calendarEventCreated', 'erp:event:calendarEventUpdated', 'erp:event:calendarEventDeleted'];

export function useUpcomingEvents(enabled: boolean, myId: string): void {
  useEffect(() => {
    if (!enabled || !myId) return undefined;
    void useErpUpcomingStore.getState().load();
    let debounce: number | null = null;
    const reload = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void useErpUpcomingStore.getState().load();
      }, RELOAD_DEBOUNCE_MS);
    };
    const unsubs = CALENDAR_EVENTS.map(channel => ipc.on?.(channel, reload));
    const interval = window.setInterval(() => { void useErpUpcomingStore.getState().load(); }, RELOAD_EVERY_MS);
    return () => {
      if (debounce) window.clearTimeout(debounce);
      window.clearInterval(interval);
      unsubs.forEach(unsub => unsub?.());
    };
  }, [enabled, myId]);

  // Nhân viên: mất kết nối Boss rồi nối lại → lịch đổi trong lúc đó không có event, tải lại
  useEmployeeResync(() => {
    if (enabled) void useErpUpcomingStore.getState().load();
  });
}
