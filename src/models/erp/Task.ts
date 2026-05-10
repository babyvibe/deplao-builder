export type ErpTaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'cancelled';
export type ErpTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ErpTask {
  id: string;
  project_id?: string;
  parent_task_id?: string;
  title: string;
  description?: string;
  status: ErpTaskStatus;
  priority: ErpTaskPriority;
  reporter_id?: string;
  start_date?: number;
  due_date?: number;
  completed_at?: number;
  estimated_hours?: number;
  actual_hours: number;
  recurring_rule?: string;
  linked_contact_id?: string;
  linked_zalo_msg_id?: string;
  sort_order: number;
  archived: number;
  created_at: number;
  updated_at: number;
  // Virtual / joined
  assignees?: string[];       // array of employee_id
  watchers?: string[];
  checklist_total?: number;
  checklist_done?: number;
  comment_count?: number;
}

export interface ErpTaskDetail extends ErpTask {
  checklist: ErpChecklistItem[];
  comments: ErpComment[];
  attachments: ErpAttachment[];
  activity: ErpActivityLog[];
  watchers: string[];
  dependencies?: ErpTaskDependency[];
}


export type ErpDependencyType = 'FS' | 'SS' | 'FF' | 'SF';
export interface ErpTaskDependency {
  task_id: string;
  depends_on_task_id: string;
  type: ErpDependencyType;
  created_at: number;
}

export interface ErpChecklistItem {
  id: number;
  task_id: string;
  content: string;
  done: number;
  sort_order: number;
  created_at: number;
}

export interface ErpComment {
  id: number;
  task_id: string;
  author_id: string;
  content: string;
  mentions?: string[];
  parent_comment_id?: number;
  created_at: number;
  updated_at: number;
}

export interface ErpAttachment {
  id: number;
  task_id: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  size: number;
  uploaded_by: string;
  uploaded_at: number;
}

export interface TaskAttachmentInput {
  file_name: string;
  file_path: string;
  mime_type?: string;
  size?: number;
}

export interface ErpActivityLog {
  id: number;
  task_id: string;
  actor_id: string;
  action: 'created' | 'status_changed' | 'assigned' | 'commented' | 'attached' | 'updated';
  payload?: Record<string, any>;
  created_at: number;
}

export interface CreateTaskInput {
  project_id?: string;
  parent_task_id?: string;
  title: string;
  description?: string;
  status?: ErpTaskStatus;
  priority?: ErpTaskPriority;
  assignees?: string[];
  due_date?: number;
  start_date?: number;
  estimated_hours?: number;
  linked_contact_id?: string;
  linked_zalo_msg_id?: string;
  watchers?: string[];
  attachments?: TaskAttachmentInput[];
}

export interface UpdateTaskInput {
  project_id?: string | null;
  title?: string;
  description?: string;
  status?: ErpTaskStatus;
  priority?: ErpTaskPriority;
  due_date?: number | null;
  start_date?: number | null;
  estimated_hours?: number | null;
  actual_hours?: number | null;
  linked_contact_id?: string | null;
  sort_order?: number;
  assignees?: string[];
  watchers?: string[];
  attachments?: TaskAttachmentInput[];
}

export type TaskInboxFilter = 'today' | 'week' | 'overdue' | 'upcoming' | 'all';

