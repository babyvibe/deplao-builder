// ERP HRM (Phase 2) model types

export interface ErpDepartment {
  id: number;
  name: string;
  parent_id?: number | null;
  manager_employee_id?: string;
  description?: string;
  created_at: number;
  updated_at: number;
  // Virtual
  children?: ErpDepartment[];
  employeeCount?: number;
}

export interface CreateDepartmentInput {
  name: string;
  parent_id?: number | null;
  manager_employee_id?: string;
  description?: string;
}

export interface ErpPosition {
  id: number;
  name: string;
  level: number;
  department_id?: number | null;
  created_at: number;
}

export interface ErpEmployeeProfile {
  employee_id: string;
  username?: string;
  display_name?: string;
  full_name?: string;
  avatar_url?: string;
  employee_role?: 'boss' | 'employee' | string;
  is_active?: number;
  department_id?: number | null;
  position_id?: number | null;
  manager_employee_id?: string;
  dob?: number | null;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  joined_at?: number | null;
  erp_role: string; // 'owner' | 'admin' | 'manager' | 'member' | 'guest'
  extra_json?: string;
  updated_at: number;
}

export interface UpdateProfileInput {
  department_id?: number | null;
  position_id?: number | null;
  manager_employee_id?: string;
  dob?: number | null;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  joined_at?: number | null;
  erp_role?: string;
  extra_json?: string;
}

export interface ErpAttendance {
  id: number;
  employee_id: string;
  date: string; // 'YYYY-MM-DD'
  check_in_at?: number | null;
  check_out_at?: number | null;
  note?: string;
  source?: string;
  updated_at: number;
}

export type ErpLeaveType = 'annual' | 'sick' | 'unpaid' | 'other';
export type ErpLeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ErpLeaveRequest {
  id: number;
  requester_id: string;
  leave_type: ErpLeaveType;
  start_date: string;
  end_date: string;
  days: number;
  reason?: string;
  status: ErpLeaveStatus;
  approver_id?: string;
  decided_at?: number | null;
  decision_note?: string;
  created_at: number;
  updated_at: number;
}

export interface CreateLeaveInput {
  leave_type?: ErpLeaveType;
  start_date: string;
  end_date: string;
  days?: number;
  reason?: string;
}

