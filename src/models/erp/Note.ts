export type NoteShareScope = 'private' | 'workspace' | 'custom';
export type NoteSharePermission = 'read' | 'edit';

export interface ErpNoteFolder {
  id: number;
  name: string;
  parent_id?: number;
  owner_id: string;
  created_at: number;
}

export interface ErpNote {
  id: string;
  folder_id?: number;
  title: string;
  content: string;
  author_id: string;
  pinned: number;
  share_scope: NoteShareScope;
  created_at: number;
  updated_at: number;
  // Virtual
  tags?: ErpNoteTag[];
}

export interface ErpNoteTag {
  id: number;
  name: string;
  color?: string;
}

export interface ErpNoteVersion {
  id: number;
  note_id: string;
  content_snapshot: string;
  editor_id: string;
  created_at: number;
}

export interface ErpNoteShare {
  note_id: string;
  employee_id: string;
  permission: NoteSharePermission;
}

export interface CreateNoteInput {
  title: string;
  content?: string;
  folder_id?: number;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  folder_id?: number;
  pinned?: number;
  share_scope?: NoteShareScope;
}

