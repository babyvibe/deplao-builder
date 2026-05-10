export type ErpNotificationType =
  | 'task_assigned'
  | 'task_mentioned'
  | 'task_due_soon'
  | 'task_overdue'
  | 'event_reminder'
  | 'event_invited'
  | 'leave_request_new'
  | 'leave_request_decided'
  | 'note_shared';

export interface ErpNotification {
  id: number;
  recipient_id: string;
  type: ErpNotificationType;
  title: string;
  body: string;
  link?: string;
  payload?: Record<string, any>;
  read: number;
  created_at: number;
}

