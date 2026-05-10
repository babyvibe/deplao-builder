export type ErpProjectStatus = 'active' | 'archived';

export interface ErpProject {
  id: string;
  name: string;
  description?: string;
  color: string;
  owner_employee_id?: string;
  department_id?: number;
  status: ErpProjectStatus;
  created_at: number;
  updated_at: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  color?: string;
  department_id?: number;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  color?: string;
  status?: ErpProjectStatus;
  department_id?: number;
}

