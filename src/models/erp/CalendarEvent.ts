export type ErpEventType = 'meeting' | 'appointment' | 'reminder' | 'task' | 'leave';
export type ErpAttendeeStatus = 'invited' | 'accepted' | 'declined' | 'tentative';
export type ErpReminderChannel = 'toast' | 'desktop' | 'zalo';

export interface ErpCalendarEvent {
  id: string;
  title: string;
  description?: string;
  type: ErpEventType;
  start_at: number;
  end_at?: number;
  all_day: number;
  location?: string;
  color?: string;
  organizer_id?: string;
  linked_task_id?: string;
  linked_contact_id?: string;
  recurring_rule?: string;
  created_at: number;
  updated_at: number;
  // Virtual
  attendees?: ErpEventAttendee[];
  reminders?: ErpEventReminder[];
}

export interface ErpEventAttendee {
  event_id: string;
  employee_id: string;
  status: ErpAttendeeStatus;
}

export interface ErpEventReminder {
  id: number;
  event_id: string;
  minutes_before: number;
  channel: ErpReminderChannel;
  triggered: number;
}

export interface CreateCalendarEventInput {
  title: string;
  description?: string;
  type?: ErpEventType;
  start_at: number;
  end_at?: number;
  all_day?: number;
  location?: string;
  color?: string;
  reminders?: Array<{ minutes_before: number; channel: ErpReminderChannel }>;
  attendees?: string[];
  linked_task_id?: string;
  linked_contact_id?: string;
}

export interface ConflictResult {
  employee_id: string;
  conflicting_event_id: string;
  conflicting_event_title: string;
}

