import DatabaseService from '../DatabaseService';
import EventBroadcaster from '../EventBroadcaster';
import Logger from '../../utils/Logger';
import type {
  ErpDepartment, CreateDepartmentInput, ErpPosition,
  ErpEmployeeProfile, UpdateProfileInput,
  ErpAttendance,
  ErpLeaveRequest, ErpLeaveStatus, CreateLeaveInput,
} from '../../models/erp/Hrm';
import ErpNotificationService from './ErpNotificationService';

/**
 * ErpEmployeeService — Phase 2 HRM.
 * Manages departments, positions, employee profiles, attendance & leave.
 */
export default class ErpEmployeeService {
  private static instance: ErpEmployeeService;
  static getInstance(): ErpEmployeeService {
    if (!this.instance) this.instance = new ErpEmployeeService();
    return this.instance;
  }

  private db() { return DatabaseService.getInstance(); }

  // ─── Departments ─────────────────────────────────────────────────────────
  listDepartments(): ErpDepartment[] {
    const rows = this.db().query<ErpDepartment>(
      `SELECT d.*, (SELECT COUNT(*) FROM erp_employee_profiles p WHERE p.department_id = d.id) AS employeeCount
       FROM erp_departments d ORDER BY d.name ASC`
    );
    return rows;
  }

  createDepartment(input: CreateDepartmentInput): ErpDepartment {
    const now = Date.now();
    const id = this.db().runInsert(
      `INSERT INTO erp_departments (name, parent_id, manager_employee_id, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [input.name, input.parent_id ?? null, input.manager_employee_id ?? '', input.description ?? '', now, now]
    );
    const dept = this.db().queryOne<ErpDepartment>(`SELECT * FROM erp_departments WHERE id = ?`, [id])!;
    EventBroadcaster.emit('erp:event:departmentUpdated', { department: dept });
    return dept;
  }

  updateDepartment(id: number, patch: Partial<CreateDepartmentInput>): ErpDepartment {
    const now = Date.now();
    const fields: string[] = [];
    const vals: any[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); vals.push(patch.name); }
    if (patch.parent_id !== undefined) { fields.push('parent_id = ?'); vals.push(patch.parent_id); }
    if (patch.manager_employee_id !== undefined) { fields.push('manager_employee_id = ?'); vals.push(patch.manager_employee_id); }
    if (patch.description !== undefined) { fields.push('description = ?'); vals.push(patch.description); }
    if (fields.length) {
      fields.push('updated_at = ?'); vals.push(now); vals.push(id);
      this.db().run(`UPDATE erp_departments SET ${fields.join(', ')} WHERE id = ?`, vals);
    }
    const dept = this.db().queryOne<ErpDepartment>(`SELECT * FROM erp_departments WHERE id = ?`, [id])!;
    EventBroadcaster.emit('erp:event:departmentUpdated', { department: dept });
    return dept;
  }

  deleteDepartment(id: number): void {
    const count = this.db().queryOne<any>(
      `SELECT COUNT(*) AS c FROM erp_employee_profiles WHERE department_id = ?`, [id]
    )?.c ?? 0;
    if (count > 0) throw new Error(`Không thể xoá: phòng ban còn ${count} nhân sự`);
    this.db().transaction(() => {
      this.db().run(`UPDATE erp_departments SET parent_id = NULL WHERE parent_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_departments WHERE id = ?`, [id]);
    });
    EventBroadcaster.emit('erp:event:departmentUpdated', { departmentId: id, deleted: true });
  }

  // ─── Positions ────────────────────────────────────────────────────────────
  listPositions(): ErpPosition[] {
    return this.db().query<ErpPosition>(`SELECT * FROM erp_positions ORDER BY level DESC, name ASC`);
  }

  createPosition(input: { name: string; level?: number; department_id?: number | null }): ErpPosition {
    const now = Date.now();
    const id = this.db().runInsert(
      `INSERT INTO erp_positions (name, level, department_id, created_at) VALUES (?,?,?,?)`,
      [input.name, input.level ?? 0, input.department_id ?? null, now]
    );
    return this.db().queryOne<ErpPosition>(`SELECT * FROM erp_positions WHERE id = ?`, [id])!;
  }

  updatePosition(id: number, patch: Partial<{ name: string; level: number; department_id: number | null }>): ErpPosition {
    const fields: string[] = []; const vals: any[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); vals.push(patch.name); }
    if (patch.level !== undefined) { fields.push('level = ?'); vals.push(patch.level); }
    if (patch.department_id !== undefined) { fields.push('department_id = ?'); vals.push(patch.department_id); }
    if (fields.length) {
      vals.push(id);
      this.db().run(`UPDATE erp_positions SET ${fields.join(', ')} WHERE id = ?`, vals);
    }
    return this.db().queryOne<ErpPosition>(`SELECT * FROM erp_positions WHERE id = ?`, [id])!;
  }

  deletePosition(id: number): void {
    this.db().run(`UPDATE erp_employee_profiles SET position_id = NULL WHERE position_id = ?`, [id]);
    this.db().run(`DELETE FROM erp_positions WHERE id = ?`, [id]);
  }

  // ─── Employee profiles ───────────────────────────────────────────────────
  getProfile(employeeId: string): ErpEmployeeProfile | undefined {
    return this.db().queryOne<ErpEmployeeProfile>(
      `SELECT
         p.*,
         e.username,
         e.display_name,
         e.display_name AS full_name,
         e.avatar_url,
         e.role AS employee_role,
         e.is_active
       FROM erp_employee_profiles p
       LEFT JOIN employees e ON e.employee_id = p.employee_id
       WHERE p.employee_id = ?`, [employeeId]
    );
  }

  listProfilesByDepartment(departmentId?: number | null): ErpEmployeeProfile[] {
    const baseSql = `SELECT
       p.*,
       e.username,
       e.display_name,
       e.display_name AS full_name,
       e.avatar_url,
       e.role AS employee_role,
       e.is_active
     FROM erp_employee_profiles p
     LEFT JOIN employees e ON e.employee_id = p.employee_id`;
    if (departmentId === undefined) {
      return this.db().query<ErpEmployeeProfile>(`${baseSql} ORDER BY p.updated_at DESC`);
    }
    if (departmentId === null) {
      return this.db().query<ErpEmployeeProfile>(`${baseSql} WHERE p.department_id IS NULL ORDER BY p.updated_at DESC`);
    }
    return this.db().query<ErpEmployeeProfile>(
      `${baseSql} WHERE p.department_id = ? ORDER BY p.updated_at DESC`,
      [departmentId]
    );
  }

  /**
   * Upsert (insert-or-update) profile. Validates:
   *  - no circular manager chain
   */
  upsertProfile(employeeId: string, patch: UpdateProfileInput): ErpEmployeeProfile {
    const existing = this.getProfile(employeeId);
    if (patch.manager_employee_id) this._assertNoManagerCycle(employeeId, patch.manager_employee_id);

    const now = Date.now();
    if (!existing) {
      this.db().run(
        `INSERT INTO erp_employee_profiles
          (employee_id, department_id, position_id, manager_employee_id, dob, gender, phone, email, address,
           joined_at, erp_role, extra_json, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          employeeId,
          patch.department_id ?? null, patch.position_id ?? null, patch.manager_employee_id ?? '',
          patch.dob ?? null, patch.gender ?? '', patch.phone ?? '', patch.email ?? '',
          patch.address ?? '', patch.joined_at ?? null, patch.erp_role ?? 'member', patch.extra_json ?? '{}', now,
        ]
      );
    } else {
      const fields: string[] = []; const vals: any[] = [];
      const keys: (keyof UpdateProfileInput)[] = [
        'department_id', 'position_id', 'manager_employee_id', 'dob', 'gender',
        'phone', 'email', 'address', 'joined_at', 'erp_role', 'extra_json',
      ];
      for (const k of keys) if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]); }
      if (fields.length) {
        fields.push('updated_at = ?'); vals.push(now); vals.push(employeeId);
        this.db().run(`UPDATE erp_employee_profiles SET ${fields.join(', ')} WHERE employee_id = ?`, vals);
      }
    }
    const profile = this.getProfile(employeeId)!;
    EventBroadcaster.emit('erp:event:employeeProfileUpdated', { profile });
    return profile;
  }

  /** Hard-delete an employee profile (keeps underlying Zalo employee account intact). */
  deleteProfile(employeeId: string): void {
    this.db().run(`DELETE FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]);
    EventBroadcaster.emit('erp:event:employeeProfileDeleted', { employeeId });
  }

  private _assertNoManagerCycle(employeeId: string, managerId: string): void {
    if (!managerId || managerId === employeeId) {
      if (managerId === employeeId) throw new Error('Không thể tự quản lý chính mình');
      return;
    }
    const visited = new Set<string>([employeeId]);
    let cur: string | undefined = managerId;
    let depth = 0;
    while (cur && depth < 50) {
      if (visited.has(cur)) throw new Error('Phát hiện vòng lặp quản lý');
      visited.add(cur);
      const row = this.db().queryOne<{ manager_employee_id: string }>(
        `SELECT manager_employee_id FROM erp_employee_profiles WHERE employee_id = ?`, [cur]
      );
      cur = row?.manager_employee_id || undefined;
      depth++;
    }
  }

  // ─── Attendance ──────────────────────────────────────────────────────────
  private _todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  checkIn(employeeId: string, note?: string): ErpAttendance {
    const date = this._todayStr();
    const now = Date.now();
    this.db().run(
      `INSERT INTO erp_attendance (employee_id, date, check_in_at, note, source, updated_at)
       VALUES (?,?,?,?, 'manual', ?)
       ON CONFLICT(employee_id, date) DO UPDATE SET
         check_in_at = COALESCE(erp_attendance.check_in_at, excluded.check_in_at),
         note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE erp_attendance.note END,
         updated_at = excluded.updated_at`,
      [employeeId, date, now, note ?? '', now]
    );
    const row = this.db().queryOne<ErpAttendance>(
      `SELECT * FROM erp_attendance WHERE employee_id = ? AND date = ?`, [employeeId, date]
    )!;
    EventBroadcaster.emit('erp:event:attendanceUpdated', { attendance: row });
    return row;
  }

  checkOut(employeeId: string, note?: string): ErpAttendance {
    const date = this._todayStr();
    const now = Date.now();
    const existing = this.db().queryOne<ErpAttendance>(
      `SELECT * FROM erp_attendance WHERE employee_id = ? AND date = ?`, [employeeId, date]
    );
    if (!existing) throw new Error('Chưa check-in hôm nay');
    this.db().run(
      `UPDATE erp_attendance SET check_out_at = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END, updated_at = ?
       WHERE employee_id = ? AND date = ?`,
      [now, note ?? '', note ?? '', now, employeeId, date]
    );
    const row = this.db().queryOne<ErpAttendance>(
      `SELECT * FROM erp_attendance WHERE employee_id = ? AND date = ?`, [employeeId, date]
    )!;
    EventBroadcaster.emit('erp:event:attendanceUpdated', { attendance: row });
    return row;
  }

  listAttendance(filter: { employeeId?: string; from?: string; to?: string }): ErpAttendance[] {
    let sql = `SELECT * FROM erp_attendance WHERE 1=1`;
    const params: any[] = [];
    if (filter.employeeId) { sql += ' AND employee_id = ?'; params.push(filter.employeeId); }
    if (filter.from) { sql += ' AND date >= ?'; params.push(filter.from); }
    if (filter.to) { sql += ' AND date <= ?'; params.push(filter.to); }
    sql += ' ORDER BY date DESC, employee_id';
    return this.db().query<ErpAttendance>(sql, params);
  }

  getTodayAttendance(employeeId: string): ErpAttendance | undefined {
    return this.db().queryOne<ErpAttendance>(
      `SELECT * FROM erp_attendance WHERE employee_id = ? AND date = ?`,
      [employeeId, this._todayStr()]
    );
  }

  // ─── Leave requests ──────────────────────────────────────────────────────
  createLeave(input: CreateLeaveInput, requesterId: string): ErpLeaveRequest {
    const now = Date.now();
    const days = input.days ?? this._daysBetween(input.start_date, input.end_date);
    const id = this.db().runInsert(
      `INSERT INTO erp_leave_requests
        (requester_id, leave_type, start_date, end_date, days, reason, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
      [requesterId, input.leave_type ?? 'annual', input.start_date, input.end_date, days, input.reason ?? '', now, now]
    );
    const leave = this.db().queryOne<ErpLeaveRequest>(`SELECT * FROM erp_leave_requests WHERE id = ?`, [id])!;

    // Notify manager (if set)
    const profile = this.getProfile(requesterId);
    const managerId = profile?.manager_employee_id;
    if (managerId) {
      try {
        ErpNotificationService.getInstance().notify(
          managerId, 'leave_request_new',
          `Yêu cầu nghỉ phép mới`,
          `${requesterId} xin nghỉ ${days} ngày (${input.start_date} → ${input.end_date})`,
          `erp://leave/${id}`,
          { leaveId: id, channels: ['toast', 'zalo'] }
        );
      } catch (err: any) { Logger.warn(`[ErpEmployeeService] notify manager: ${err.message}`); }
    }

    EventBroadcaster.emit('erp:event:leaveCreated', { leave });
    return leave;
  }

  private _daysBetween(start: string, end: string): number {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 1;
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }

  listMyLeaves(requesterId: string): ErpLeaveRequest[] {
    return this.db().query<ErpLeaveRequest>(
      `SELECT * FROM erp_leave_requests WHERE requester_id = ? ORDER BY created_at DESC`, [requesterId]
    );
  }

  listPendingForManager(managerId: string): ErpLeaveRequest[] {
    return this.db().query<ErpLeaveRequest>(
      `SELECT l.* FROM erp_leave_requests l
       LEFT JOIN erp_employee_profiles p ON p.employee_id = l.requester_id
       WHERE l.status = 'pending' AND (p.manager_employee_id = ? OR ? = 'boss')
       ORDER BY l.created_at DESC`,
      [managerId, managerId]
    );
  }

  decideLeave(id: number, status: ErpLeaveStatus, approverId: string, note?: string): ErpLeaveRequest {
    if (!['approved', 'rejected'].includes(status)) throw new Error('Trạng thái không hợp lệ');
    const now = Date.now();
    this.db().run(
      `UPDATE erp_leave_requests SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [status, approverId, now, note ?? '', now, id]
    );
    const leave = this.db().queryOne<ErpLeaveRequest>(`SELECT * FROM erp_leave_requests WHERE id = ?`, [id]);
    if (!leave) throw new Error('Không tìm thấy yêu cầu nghỉ');
    try {
      ErpNotificationService.getInstance().notify(
        leave.requester_id, 'leave_request_decided',
        `Yêu cầu nghỉ đã được ${status === 'approved' ? 'duyệt' : 'từ chối'}`,
        note ?? '',
        `erp://leave/${id}`,
        { leaveId: id, status, channels: ['toast', 'zalo'] }
      );
    } catch (err: any) { Logger.warn(`[ErpEmployeeService] notify requester: ${err.message}`); }
    EventBroadcaster.emit('erp:event:leaveDecided', { leave });
    return leave;
  }

  cancelLeave(id: number, requesterId: string): void {
    const row = this.db().queryOne<ErpLeaveRequest>(`SELECT * FROM erp_leave_requests WHERE id = ?`, [id]);
    if (!row) throw new Error('Không tìm thấy');
    if (row.requester_id !== requesterId) throw new Error('Không có quyền huỷ đơn này');
    if (row.status !== 'pending') throw new Error('Đơn đã được xử lý, không thể huỷ');
    const now = Date.now();
    this.db().run(`UPDATE erp_leave_requests SET status='cancelled', updated_at=? WHERE id=?`, [now, id]);
    EventBroadcaster.emit('erp:event:leaveDecided', {
      leave: { ...row, status: 'cancelled', updated_at: now },
    });
  }
}

