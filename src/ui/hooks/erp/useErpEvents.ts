import { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { useEmployeeStore } from '@/store/employee/employeeStore';

/** Gom các event công việc liền nhau thành MỘT lần tải lại hộp việc (event công việc tới mọi nhân viên). */
const INBOX_RELOAD_DEBOUNCE_MS = 400;

/**
 * Mount once (ErpPage): nghe event realtime ERP và đồng bộ store. Boss nhận emit của chính mình (kể cả thay đổi nhân
 * viên làm qua REST — Boss chạy cùng service nên event phát đúng một lần); nhân viên nhận bản relay Socket.IO theo
 * người nhận (relayAudience), kể cả tiếng vọng thay đổi của chính mình → mọi handler idempotent.
 * Đọc store qua getState() — không subscribe cả store (trước đây ErpPage render lại mỗi khi BẤT KỲ store ERP nào đổi).
 */
export function useErpEvents() {
  // Danh tính dữ liệu (không phải danh tính xem thử): Boss = 'boss' (IPC), nhân viên = employee_id (token REST)
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
    // Lịch / ghi chú giới hạn người xem (visibleEmployeeIds không rỗng) mà mình không nằm trong đó: UI Boss nhận MỌI emit
    // cục bộ (nhân viên chỉ nhận bản relay của mình) — không hiện lịch / note riêng của người khác rồi mất khi tải lại.
    const notForMe = (d: any) => Array.isArray(d?.visibleEmployeeIds) && d.visibleEmployeeIds.length > 0
      && !d.visibleEmployeeIds.includes(myIdRef.current);

    let inboxTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadInbox = () => {
      if (inboxTimer) clearTimeout(inboxTimer);
      inboxTimer = setTimeout(() => { inboxTimer = null; void tasks().loadInbox('all'); }, INBOX_RELOAD_DEBOUNCE_MS);
    };

    const unsubs: (() => void)[] = [];

    // Payload thiếu trường (Boss bản khác / event lỗi) → bỏ qua thay vì ném lỗi trong listener
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
    // Chia sẻ / phạm vi đổi (không mang nội dung): tải lại danh sách theo quyền — người vừa mất quyền bỏ note khỏi danh sách
    unsubs.push(ipc.on('erp:event:noteShared', () => { void notes().refreshVisible(); }));
    // Chỉ thông báo của mình: UI Boss nhận MỌI emit cục bộ (cả thông báo gửi nhân viên) — trước đây cộng vào hộp thư Boss
    unsubs.push(ipc.on('erp:event:notification', (d: any) => {
      const n = d?.notification;
      if (n && (n.recipient_id === undefined || String(n.recipient_id) === myIdRef.current)) notifications()._onNewNotification(n);
    }));
    // 'erp:event:reminder' (tới giờ nhắc lịch): App.tsx nghe ở mọi trang và hiện popup như nhắc hẹn Zalo

    // Nghỉ phép: cập nhật đơn đang hiện; người duyệt đang mở danh sách chờ duyệt thì tải lại (đơn mới của người mình
    // quản lý — Boss lọc theo quản lý trực tiếp)
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

  // Nhân viên: kết nối lại / catch-up reset → tải lại phần ERP đã mở (event lỡ trong lúc mất kết nối không phát lại)
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

