import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import type {
  ErpDepartment, ErpPosition, ErpEmployeeProfile,
  ErpAttendance, ErpLeaveRequest,
} from '../../../models/erp';
import { isErpModuleOff, withErpDeniedNotice } from './erpStoreHelpers';

type AttendanceFilter = { employeeId?: string; from?: string; to?: string; all?: boolean };

/** Dòng chấm công thuộc bảng đang hiện (cùng người / mọi người, trong khoảng ngày). */
function attendanceMatches(filter: AttendanceFilter | null, a: ErpAttendance): boolean {
  if (!filter) return false;
  const employeeId = (a as any).employee_id;
  if (!filter.all && filter.employeeId !== employeeId) return false;
  if (filter.from && a.date < filter.from) return false;
  if (filter.to && a.date > filter.to) return false;
  return true;
}

// Nhân sự / chấm công / nghỉ phép nằm trên DB Boss: mọi lệnh qua DataAccessor (nhân viên → REST, Boss lấy người làm
// từ token). Trước đây check-in, đơn nghỉ phép, duyệt đơn… ở máy nhân viên đi IPC cục bộ → Boss không bao giờ thấy.
// Đọc lỗi → giữ dữ liệu đang hiện; ghi lỗi → không đổi state, bị từ chối quyền → hộp thoại quyền ERP.

interface ErpEmployeeState {
  departments: ErpDepartment[];
  positions: ErpPosition[];
  profiles: ErpEmployeeProfile[];
  myLeaves: ErpLeaveRequest[];
  pendingLeaves: ErpLeaveRequest[];
  /** Đã tải đơn chờ duyệt (người có quyền duyệt mở trang nghỉ phép / báo cáo) → event nghỉ phép thì tải lại. */
  pendingLeavesLoaded: boolean;
  todayAttendance: ErpAttendance | null;
  attendanceList: ErpAttendance[];
  /** Bộ lọc của bảng chấm công đang hiện — event chấm công khớp bộ lọc thì thêm dòng (vd quản lý thấy check-in mới). */
  attendanceFilter: AttendanceFilter | null;
  seat: { limit: number; used: number; remaining: number } | null;

  loadDepartments: () => Promise<void>;
  loadPositions: () => Promise<void>;
  loadProfiles: (departmentId?: number | null) => Promise<void>;
  loadMyLeaves: () => Promise<void>;
  loadPendingLeaves: () => Promise<void>;
  loadTodayAttendance: () => Promise<void>;
  loadAttendance: (filter: AttendanceFilter) => Promise<void>;
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

  /** Kết quả lưu (Boss / handler từ chối → success:false + error) — người gọi báo lỗi thay vì đóng form. */
  upsertProfile: (employeeId: string, patch: any) => Promise<{ success: boolean; error?: string }>;

  _onLeaveChanged: (leave: ErpLeaveRequest) => void;
  _onAttendanceUpdated: (a: ErpAttendance) => void;
  _onProfileUpdated: (p: ErpEmployeeProfile) => void;
  /** erp:event:employeeProfileDeleted — bỏ hồ sơ khỏi danh sách (Boss xoá ở máy khác). */
  _onProfileDeleted: (employeeId: string) => void;
}

export const useErpEmployeeStore = create<ErpEmployeeState>((set, get) => ({
  departments: [],
  positions: [],
  profiles: [],
  myLeaves: [],
  pendingLeaves: [],
  pendingLeavesLoaded: false,
  todayAttendance: null,
  attendanceList: [],
  attendanceFilter: null,
  seat: null,

  loadDepartments: async () => {
    const res: any = await DataAccessor.erpDepartments();
    if (res?.success && Array.isArray(res.departments)) set({ departments: res.departments });
  },
  loadPositions: async () => {
    const res: any = await DataAccessor.erpPositions();
    if (res?.success && Array.isArray(res.positions)) set({ positions: res.positions });
  },
  loadProfiles: async (departmentId) => {
    const res: any = await DataAccessor.erpProfiles(departmentId);
    if (res?.success && Array.isArray(res.profiles)) set({ profiles: res.profiles });
  },
  loadMyLeaves: async () => {
    const res: any = await DataAccessor.erpMyLeaves();
    if (res?.success && Array.isArray(res.leaves)) set({ myLeaves: res.leaves });
  },
  loadPendingLeaves: async () => {
    const res: any = await DataAccessor.erpPendingLeaves();
    if (res?.success && Array.isArray(res.leaves)) set({ pendingLeaves: res.leaves, pendingLeavesLoaded: true });
  },
  loadTodayAttendance: async () => {
    if (isErpModuleOff()) return;
    const res: any = await DataAccessor.erpAttendanceToday();
    if (res?.success) set({ todayAttendance: res.attendance ?? null });
  },
  loadAttendance: async (filter) => {
    set({ attendanceFilter: filter });
    const res: any = await DataAccessor.erpAttendanceList(filter);
    if (res?.success && Array.isArray(res.list)) set({ attendanceList: res.list });
  },
  loadSeat: async () => {
    const res: any = await DataAccessor.erpSeatStatus();
    if (res?.success && res.seat) set({ seat: res.seat });
  },
  loadProfile: async (employeeId) => {
    const res: any = await DataAccessor.erpProfile(employeeId);
    if (res?.success && res.profile) {
      set(s => ({
        profiles: upsert(s.profiles, res.profile, (p: any) => p.employee_id === employeeId),
      }));
      return res.profile;
    }
    return undefined;
  },

  createDepartment: async (input) => {
    withErpDeniedNotice(await DataAccessor.erpCreateDepartment(input));
    await get().loadDepartments();
  },
  updateDepartment: async (id, patch) => {
    withErpDeniedNotice(await DataAccessor.erpUpdateDepartment(id, patch));
    await get().loadDepartments();
  },
  deleteDepartment: async (id) => {
    withErpDeniedNotice(await DataAccessor.erpDeleteDepartment(id));
    await get().loadDepartments();
  },
  createPosition: async (input) => {
    withErpDeniedNotice(await DataAccessor.erpCreatePosition(input));
    await get().loadPositions();
  },
  updatePosition: async (id, patch) => {
    withErpDeniedNotice(await DataAccessor.erpUpdatePosition(id, patch));
    await get().loadPositions();
  },
  deletePosition: async (id) => {
    withErpDeniedNotice(await DataAccessor.erpDeletePosition(id));
    await get().loadPositions();
  },

  checkIn: async (note) => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpCheckIn(note));
    if (res?.success && res.attendance) set({ todayAttendance: res.attendance });
  },
  checkOut: async (note) => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpCheckOut(note));
    if (res?.success && res.attendance) set({ todayAttendance: res.attendance });
  },

  createLeave: async (input) => {
    withErpDeniedNotice(await DataAccessor.erpCreateLeave(input));
    await get().loadMyLeaves();
  },
  decideLeave: async (id, status, note) => {
    withErpDeniedNotice(await DataAccessor.erpDecideLeave(id, status, note));
    await get().loadPendingLeaves();
    await get().loadMyLeaves();
  },
  cancelLeave: async (id) => {
    withErpDeniedNotice(await DataAccessor.erpCancelLeave(id));
    await get().loadMyLeaves();
  },

  upsertProfile: async (employeeId, patch) => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpUpdateProfile(employeeId, patch));
    if (res?.success && res.profile) {
      set(s => ({
        profiles: upsert(s.profiles, res.profile, (p: any) => p.employee_id === employeeId),
      }));
    }
    return { success: !!res?.success, error: res?.error };
  },

  _onLeaveChanged: (leave) => set(s => ({
    myLeaves: s.myLeaves.map(l => l.id === leave.id ? leave : l),
    pendingLeaves: s.pendingLeaves.filter(l => l.id !== leave.id),
  })),
  // Chấm công của chính mình hôm nay + bảng chấm công đang hiện: dòng đã có thì thay, dòng mới khớp bộ lọc của bảng thì
  // thêm (quản lý xem "mọi người" thấy check-in mới ngay). Event tới mọi nhân viên — bảng "của tôi" không thêm người khác.
  _onAttendanceUpdated: (a) => set(s => {
    if (!a) return s;
    const sameDay = (x: ErpAttendance | null | undefined) => !!x && (x as any).employee_id === (a as any).employee_id && x.date === a.date;
    const today = sameDay(s.todayAttendance) ? a : s.todayAttendance;
    const inList = s.attendanceList.some(sameDay);
    const add = !inList && attendanceMatches(s.attendanceFilter, a);
    if (today === s.todayAttendance && !inList && !add) return s;
    return {
      todayAttendance: today,
      attendanceList: inList ? s.attendanceList.map(x => sameDay(x) ? a : x) : add ? [a, ...s.attendanceList] : s.attendanceList,
    };
  }),
  _onProfileUpdated: (p) => set(s => ({
    profiles: upsert(s.profiles, p, (x: any) => x.employee_id === p.employee_id),
  })),
  _onProfileDeleted: (employeeId) => set(s =>
    employeeId && s.profiles.some((x: any) => x.employee_id === employeeId)
      ? { profiles: s.profiles.filter((x: any) => x.employee_id !== employeeId) }
      : s
  ),
}));

function upsert<T>(arr: T[], item: T, match: (x: T) => boolean): T[] {
  const idx = arr.findIndex(match);
  if (idx >= 0) { const out = [...arr]; out[idx] = item; return out; }
  return [...arr, item];
}

