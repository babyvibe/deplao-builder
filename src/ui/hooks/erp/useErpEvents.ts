import { useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';

/**
 * Mount once at app root (inside ErpPage or App) to listen to ERP realtime events
 * from the main process and sync with Zustand stores.
 */
export function useErpEvents() {
  const taskStore = useErpTaskStore();
  const calendarStore = useErpCalendarStore();
  const noteStore = useErpNoteStore();
  const notifStore = useErpNotificationStore();
  const empStore = useErpEmployeeStore();

  useEffect(() => {
    if (!ipc.on) return;
    const unsubs: (() => void)[] = [];

    unsubs.push(ipc.on('erp:event:projectCreated', (d: any) => taskStore._onProjectCreated(d.project)));
    unsubs.push(ipc.on('erp:event:projectUpdated', (d: any) => taskStore._onProjectUpdated(d.project)));
    unsubs.push(ipc.on('erp:event:projectDeleted', (d: any) => taskStore._onProjectDeleted(d.projectId)));
    unsubs.push(ipc.on('erp:event:taskCreated',  (d: any) => {
      taskStore._onTaskCreated(d.task);
      taskStore.loadInbox('all');
    }));
    unsubs.push(ipc.on('erp:event:taskUpdated',  (d: any) => {
      taskStore._onTaskUpdated(d.taskId, d.patch, d.task);
      taskStore.loadInbox('all');
    }));
    unsubs.push(ipc.on('erp:event:taskDeleted',  (d: any) => {
      taskStore._onTaskDeleted(d.taskId);
      taskStore.loadInbox('all');
    }));
    unsubs.push(ipc.on('erp:event:commentAdded', (d: any) => {
      if (d?.taskId) taskStore._onTaskUpdated(d.taskId, { comment_count: d.task?.comment_count ?? undefined }, d.task);
      taskStore.loadInbox('all');
    }));
    unsubs.push(ipc.on('erp:event:calendarEventCreated', (d: any) => calendarStore._onEventCreated(d.event)));
    unsubs.push(ipc.on('erp:event:calendarEventUpdated', (d: any) => calendarStore._onEventUpdated(d.eventId, d.event)));
    unsubs.push(ipc.on('erp:event:calendarEventDeleted', (d: any) => calendarStore._onEventDeleted(d.eventId)));
    unsubs.push(ipc.on('erp:event:noteCreated', (d: any) => noteStore._onNoteCreated(d.note)));
    unsubs.push(ipc.on('erp:event:noteUpdated', (d: any) => noteStore._onNoteUpdated(d.note)));
    unsubs.push(ipc.on('erp:event:noteDeleted', (d: any) => noteStore._onNoteDeleted(d.noteId)));
    unsubs.push(ipc.on('erp:event:noteShared', () => noteStore.refreshVisible()));
    unsubs.push(ipc.on('erp:event:notification', (d: any) => notifStore._onNewNotification(d.notification)));
    unsubs.push(ipc.on('erp:event:reminder', (d: any) => {
      document.dispatchEvent(new CustomEvent('erp:reminder', { detail: d }));
    }));

    // Phase 2
    unsubs.push(ipc.on('erp:event:leaveCreated',   (d: any) => empStore._onLeaveChanged(d.leave)));
    unsubs.push(ipc.on('erp:event:leaveDecided',   (d: any) => empStore._onLeaveChanged(d.leave)));
    unsubs.push(ipc.on('erp:event:attendanceUpdated', (d: any) => empStore._onAttendanceUpdated(d.attendance)));
    unsubs.push(ipc.on('erp:event:employeeProfileUpdated', (d: any) => empStore._onProfileUpdated(d.profile)));
    unsubs.push(ipc.on('erp:event:departmentUpdated', () => empStore.loadDepartments()));

    return () => unsubs.forEach(u => u?.());
  }, []);
}

