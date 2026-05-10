import { create } from 'zustand';
import ipc from '@/lib/ipc';
import type {
  ErpDepartment, ErpPosition, ErpEmployeeProfile,
  ErpAttendance, ErpLeaveRequest,
} from '../../../models/erp';

interface ErpEmployeeState {
  departments: ErpDepartment[];
  positions: ErpPosition[];
  profiles: ErpEmployeeProfile[];
  myLeaves: ErpLeaveRequest[];
  pendingLeaves: ErpLeaveRequest[];
  todayAttendance: ErpAttendance | null;
  attendanceList: ErpAttendance[];
  seat: { limit: number; used: number; remaining: number } | null;

  loadDepartments: () => Promise<void>;
  loadPositions: () => Promise<void>;
  loadProfiles: (departmentId?: number | null) => Promise<void>;
  loadMyLeaves: () => Promise<void>;
  loadPendingLeaves: () => Promise<void>;
  loadTodayAttendance: () => Promise<void>;
  loadAttendance: (filter: { employeeId?: string; from?: string; to?: string }) => Promise<void>;
  loadSeat: () => Promise<void>;
  loadProfile: (employeeId: string) => Promise<ErpEmployeeProfile | undefined>;

  createDepartment: (input: any) => Promise<void>;
  updateDepartment: (id: number, patch: any) => Promise<void>;
  deleteDepartment: (id: number) => Promise<void>;
  createPosition: (input: any) => Promise<void>;
  updatePosition: (id: number, patch: any) => Promise<void>;
  deletePosition: (id: number) => Promise<void>;

  checkIn: (note?: string) => Promise<void>;
  checkOut: (note?: string) => Promise<void>;

  createLeave: (input: any) => Promise<void>;
  decideLeave: (id: number, status: 'approved' | 'rejected', note?: string) => Promise<void>;
  cancelLeave: (id: number) => Promise<void>;

  upsertProfile: (employeeId: string, patch: any) => Promise<void>;

  _onLeaveChanged: (leave: ErpLeaveRequest) => void;
  _onAttendanceUpdated: (a: ErpAttendance) => void;
  _onProfileUpdated: (p: ErpEmployeeProfile) => void;
}

export const useErpEmployeeStore = create<ErpEmployeeState>((set, get) => ({
  departments: [],
  positions: [],
  profiles: [],
  myLeaves: [],
  pendingLeaves: [],
  todayAttendance: null,
  attendanceList: [],
  seat: null,

  loadDepartments: async () => {
    const res = await ipc.erp?.departmentList?.();
    if (res?.success) set({ departments: res.departments });
  },
  loadPositions: async () => {
    const res = await ipc.erp?.positionList?.();
    if (res?.success) set({ positions: res.positions });
  },
  loadProfiles: async (departmentId) => {
    const res = await ipc.erp?.employeeListByDepartment?.({ departmentId });
    if (res?.success) set({ profiles: res.profiles });
  },
  loadMyLeaves: async () => {
    const res = await ipc.erp?.leaveListMy?.();
    if (res?.success) set({ myLeaves: res.leaves });
  },
  loadPendingLeaves: async () => {
    const res = await ipc.erp?.leaveListPending?.();
    if (res?.success) set({ pendingLeaves: res.leaves });
  },
  loadTodayAttendance: async () => {
    const res = await ipc.erp?.attendanceToday?.();
    if (res?.success) set({ todayAttendance: res.attendance ?? null });
  },
  loadAttendance: async (filter) => {
    const res = await ipc.erp?.attendanceList?.(filter);
    if (res?.success) set({ attendanceList: res.list });
  },
  loadSeat: async () => {
    const res = await ipc.erp?.licenseSeatStatus?.();
    if (res?.success) set({ seat: res.seat });
  },
  loadProfile: async (employeeId) => {
    const res = await ipc.erp?.employeeGetProfile?.({ employeeId });
    if (res?.success && res.profile) {
      set(s => ({
        profiles: upsert(s.profiles, res.profile, (p: any) => p.employee_id === employeeId),
      }));
      return res.profile;
    }
    return undefined;
  },

  createDepartment: async (input) => {
    await ipc.erp?.departmentCreate?.(input);
    await get().loadDepartments();
  },
  updateDepartment: async (id, patch) => {
    await ipc.erp?.departmentUpdate?.({ id, patch });
    await get().loadDepartments();
  },
  deleteDepartment: async (id) => {
    await ipc.erp?.departmentDelete?.({ id });
    await get().loadDepartments();
  },
  createPosition: async (input) => {
    await ipc.erp?.positionCreate?.(input);
    await get().loadPositions();
  },
  updatePosition: async (id, patch) => {
    await ipc.erp?.positionUpdate?.({ id, patch });
    await get().loadPositions();
  },
  deletePosition: async (id) => {
    await ipc.erp?.positionDelete?.({ id });
    await get().loadPositions();
  },

  checkIn: async (note) => {
    const res = await ipc.erp?.attendanceCheckIn?.({ note });
    if (res?.success) set({ todayAttendance: res.attendance });
  },
  checkOut: async (note) => {
    const res = await ipc.erp?.attendanceCheckOut?.({ note });
    if (res?.success) set({ todayAttendance: res.attendance });
  },

  createLeave: async (input) => {
    await ipc.erp?.leaveCreate?.({ input });
    await get().loadMyLeaves();
  },
  decideLeave: async (id, status, note) => {
    await ipc.erp?.leaveDecide?.({ id, status, note });
    await get().loadPendingLeaves();
    await get().loadMyLeaves();
  },
  cancelLeave: async (id) => {
    await ipc.erp?.leaveCancel?.({ id });
    await get().loadMyLeaves();
  },

  upsertProfile: async (employeeId, patch) => {
    const res = await ipc.erp?.employeeUpdateProfile?.({ employeeId, patch });
    if (res?.success && res.profile) {
      set(s => ({
        profiles: upsert(s.profiles, res.profile, (p: any) => p.employee_id === employeeId),
      }));
    }
  },

  _onLeaveChanged: (leave) => set(s => ({
    myLeaves: s.myLeaves.map(l => l.id === leave.id ? leave : l),
    pendingLeaves: s.pendingLeaves.filter(l => l.id !== leave.id),
  })),
  _onAttendanceUpdated: (a) => set(s =>
    s.todayAttendance && (s.todayAttendance as any).employee_id === a.employee_id && s.todayAttendance.date === a.date
      ? { todayAttendance: a }
      : s
  ),
  _onProfileUpdated: (p) => set(s => ({
    profiles: upsert(s.profiles, p, (x: any) => x.employee_id === p.employee_id),
  })),
}));

function upsert<T>(arr: T[], item: T, match: (x: T) => boolean): T[] {
  const idx = arr.findIndex(match);
  if (idx >= 0) { const out = [...arr]; out[idx] = item; return out; }
  return [...arr, item];
}

