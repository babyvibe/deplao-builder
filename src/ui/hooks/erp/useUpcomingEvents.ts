/**
 * Mounted once (TopBar, next to the notification bell): loads my upcoming calendar for the "Lịch sắp tới" (Upcoming) tab
 * (store/erp/erpUpcomingStore) and reloads when the calendar changes (realtime event), every 5 minutes, and when the employee reconnects to the Boss.
 * Reminders just before / on time are still handled by each event's reminder times (main); this hook reports nothing.
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

  // Employee: the Boss connection dropped and came back → calendar changes during that time have no event, so reload
  useEmployeeResync(() => {
    if (enabled) void useErpUpcomingStore.getState().load();
  });
}
