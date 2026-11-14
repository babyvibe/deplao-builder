import { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { useEmployeeStore } from '@/store/employee/employeeStore';

/** Groups consecutive task events into ONE reload of the task inbox (task events go to every employee). */
const INBOX_RELOAD_DEBOUNCE_MS = 400;

/**
 * Mounted once (ErpPage): listens for realtime ERP events and syncs the store. The Boss receives its own emits (including changes made by employees
 * via REST: the Boss runs the same service, so each event fires exactly once); employees receive the Socket.IO relay copy per recipient
 * (relayAudience), including the echo of their own changes → every handler is idempotent.
 * Reads the store via getState() without subscribing to the whole store (previously ErpPage re-rendered whenever ANY ERP store changed).
 */
export function useErpEvents() {
  // Data identity (not the viewing identity): Boss = 'boss' (IPC), employee = employee_id (REST token)
  const isEmployee = useEmployeeStore(s => s.mode === 'employee');
  const employeeId = useEmployeeStore(s => s.currentEmployee?.employee_id || '');
  const myIdRef = useRef('boss');
  myIdRef.current = isEmployee ? employeeId : 'boss';

  useEffect(() => {
    if (!ipc.on) return;
    const tasks = () => useErpTaskStore.getState();
    const calendar = () => useErpCalendarStore.getState();
    const notes = () => useErpNoteStore.getState();
    const notifications = () => useErpNotificationStore.getState();
    const hrm = () => useErpEmployeeStore.getState();
    // Calendar / notes with restricted viewers (visibleEmployeeIds not empty) that I am not part of: the Boss UI receives ALL emits
    // locally (an employee only receives their own relay copy): do not show someone else's calendar / notes, which would disappear after a reload.
    const notForMe = (d: any) => Array.isArray(d?.visibleEmployeeIds) && d.visibleEmployeeIds.length > 0
      && !d.visibleEmployeeIds.includes(myIdRef.current);

    let inboxTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadInbox = () => {
      if (inboxTimer) clearTimeout(inboxTimer);
      inboxTimer = setTimeout(() => { inboxTimer = null; void tasks().loadInbox('all'); }, INBOX_RELOAD_DEBOUNCE_MS);
    };

    const unsubs: (() => void)[] = [];

    // Payload missing fields (other Boss version / broken event) → skip it instead of throwing inside the listener
    unsubs.push(ipc.on('erp:event:projectCreated', (d: any) => { if (d?.project) tasks()._onProjectCreated(d.project); }));
    unsubs.push(ipc.on('erp:event:projectUpdated', (d: any) => { if (d?.project) tasks()._onProjectUpdated(d.project); }));
    unsubs.push(ipc.on('erp:event:projectDeleted', (d: any) => { if (d?.projectId) tasks()._onProjectDeleted(d.projectId); }));
    unsubs.push(ipc.on('erp:event:taskCreated',  (d: any) => {
      if (d?.task) tasks()._onTaskCreated(d.task);
      reloadInbox();
    }));
    unsubs.push(ipc.on('erp:event:taskUpdated',  (d: any) => {
      if (d?.taskId) tasks()._onTaskUpdated(d.taskId, d.patch, d.task);
      reloadInbox();
    }));
    unsubs.push(ipc.on('erp:event:taskDeleted',  (d: any) => {
      if (d?.taskId) tasks()._onTaskDeleted(d.taskId);
      reloadInbox();
    }));
    unsubs.push(ipc.on('erp:event:commentAdded', (d: any) => {
      if (d?.taskId) tasks()._onTaskUpdated(d.taskId, { comment_count: d.task?.comment_count ?? undefined }, d.task);
      reloadInbox();
    }));
    unsubs.push(ipc.on('erp:event:calendarEventCreated', (d: any) => {
      if (d?.event && !notForMe(d)) calendar()._onEventCreated(d.event);
    }));
    unsubs.push(ipc.on('erp:event:calendarEventUpdated', (d: any) => {
      if (!d?.eventId) return;
      if (notForMe(d)) calendar()._onEventDeleted(d.eventId);
      else calendar()._onEventUpdated(d.eventId, d.event);
    }));
    unsubs.push(ipc.on('erp:event:calendarEventDeleted', (d: any) => { if (d?.eventId) calendar()._onEventDeleted(d.eventId); }));
    unsubs.push(ipc.on('erp:event:noteCreated', (d: any) => { if (d?.note && !notForMe(d)) notes()._onNoteCreated(d.note); }));
    unsubs.push(ipc.on('erp:event:noteUpdated', (d: any) => {
      if (!d?.note) return;
      if (notForMe(d)) notes()._onNoteDeleted(d.note.id);
      else notes()._onNoteUpdated(d.note);
    }));
    unsubs.push(ipc.on('erp:event:noteDeleted', (d: any) => { if (d?.noteId) notes()._onNoteDeleted(d.noteId); }));
    // Sharing / scope changed (no content carried): reload the list according to permissions: someone who just lost access drops the note from the list
    unsubs.push(ipc.on('erp:event:noteShared', () => { void notes().refreshVisible(); }));
    // Only my own notifications: the Boss UI receives ALL local emits (including notifications sent to employees); previously they were added to the Boss's inbox
    unsubs.push(ipc.on('erp:event:notification', (d: any) => {
      const n = d?.notification;
      if (n && (n.recipient_id === undefined || String(n.recipient_id) === myIdRef.current)) notifications()._onNewNotification(n);
    }));
    // 'erp:event:reminder' (reminder time reached): App.tsx listens on every page and shows a popup like a Zalo appointment reminder

    // Leave: update the request on screen; if the approver has the pending list open, reload it (new requests from people I
    // manage: the Boss filters by direct manager)
    const onLeave = (d: any) => {
      if (!d?.leave) return;
      hrm()._onLeaveChanged(d.leave);
      if (hrm().pendingLeavesLoaded) void hrm().loadPendingLeaves();
    };
    unsubs.push(ipc.on('erp:event:leaveCreated', onLeave));
    unsubs.push(ipc.on('erp:event:leaveDecided', onLeave));
    unsubs.push(ipc.on('erp:event:attendanceUpdated', (d: any) => { if (d?.attendance) hrm()._onAttendanceUpdated(d.attendance); }));
    unsubs.push(ipc.on('erp:event:employeeProfileUpdated', (d: any) => { if (d?.profile) hrm()._onProfileUpdated(d.profile); }));
    unsubs.push(ipc.on('erp:event:employeeProfileDeleted', (d: any) => { if (d?.employeeId) hrm()._onProfileDeleted(String(d.employeeId)); }));
    unsubs.push(ipc.on('erp:event:departmentUpdated', () => { void hrm().loadDepartments(); }));

    return () => {
      if (inboxTimer) clearTimeout(inboxTimer);
      unsubs.forEach(u => u?.());
    };
  }, []);

  // Employee: reconnect / catch-up reset → reload the ERP parts that are open (events missed while disconnected are not replayed)
  useEmployeeResync(() => {
    const t = useErpTaskStore.getState();
    const c = useErpCalendarStore.getState();
    const e = useErpEmployeeStore.getState();
    return Promise.all([
      t.projects.length ? t.loadProjects() : undefined,
      Object.keys(t.tasks).length ? t.loadTasks(t.lastFilter) : undefined,
      t.loadInbox('all'),
      c.currentRange ? c.loadEvents(c.currentRange.from, c.currentRange.to) : undefined,
      useErpNoteStore.getState().refreshVisible(),
      e.loadTodayAttendance(),
      e.loadMyLeaves(),
      e.pendingLeavesLoaded ? e.loadPendingLeaves() : undefined,
      useErpNotificationStore.getState().loadUnreadCount(),
    ]);
  });
}

