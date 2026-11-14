import { v4 as uuidv4 } from 'uuid';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import type {
  ErpNoteFolder, ErpNote, ErpNoteTag, CreateNoteInput, UpdateNoteInput, ErpNoteVersion,
  ErpNoteShare, NoteSharePermission, NoteShareScope,
} from '../../models/erp';
import ErpNotificationService from './ErpNotificationService';
import { erpPersonName } from './erpPeople';
import { tr } from '../../shared/i18n';

export default class ErpNoteService {
  private static instance: ErpNoteService;
  static getInstance(): ErpNoteService {
    if (!this.instance) this.instance = new ErpNoteService();
    return this.instance;
  }

  private db() { return DatabaseService.getInstance(); }

  // ─── Folders ───────────────────────────────────────────────────────────────

  listFolders(ownerId: string): ErpNoteFolder[] {
    // Bounded by workspace owner; 1000 cap as defensive upper bound.
    return this.db().query<ErpNoteFolder>(
      `SELECT * FROM erp_note_folders WHERE owner_id = ? ORDER BY name ASC LIMIT 1000`, [ownerId]
    );
  }

  createFolder(name: string, ownerId: string, parentId?: number): ErpNoteFolder {
    const now = Date.now();
    const newId = this.db().runInsert(
      `INSERT INTO erp_note_folders (name, parent_id, owner_id, created_at) VALUES (?,?,?,?)`,
      [name, parentId ?? null, ownerId, now]
    );
    return this.db().queryOne<ErpNoteFolder>(
      `SELECT * FROM erp_note_folders WHERE id = ?`, [newId]
    )!;
  }

  renameFolder(id: number, name: string): void {
    this.db().run(`UPDATE erp_note_folders SET name = ? WHERE id = ?`, [name, id]);
  }

  renameFolderForEmployee(id: number, name: string, employeeId: string): void {
    const folder = this.db().queryOne<ErpNoteFolder>(`SELECT * FROM erp_note_folders WHERE id = ?`, [id]);
    if (!folder || folder.owner_id !== employeeId) throw new Error(tr('Bạn không có quyền sửa thư mục này'));
    this.renameFolder(id, name);
  }

  deleteFolder(id: number): void {
    // Move notes to root (null folder)
    this.db().run(`UPDATE erp_notes SET folder_id = NULL WHERE folder_id = ?`, [id]);
    this.db().run(`DELETE FROM erp_note_folders WHERE id = ?`, [id]);
  }

  deleteFolderForEmployee(id: number, employeeId: string): void {
    const folder = this.db().queryOne<ErpNoteFolder>(`SELECT * FROM erp_note_folders WHERE id = ?`, [id]);
    if (!folder || folder.owner_id !== employeeId) throw new Error(tr('Bạn không có quyền xóa thư mục này'));
    this.deleteFolder(id);
  }

  // ─── Notes ─────────────────────────────────────────────────────────────────

  listNotes(filter: { folderId?: number; tagId?: number; search?: string; authorId?: string; limit?: number; offset?: number }): ErpNote[] {
    let sql = `SELECT n.* FROM erp_notes n WHERE 1=1`;
    const params: any[] = [];
    if (filter.folderId !== undefined) { sql += ' AND n.folder_id = ?'; params.push(filter.folderId); }
    if (filter.authorId) { sql += ' AND n.author_id = ?'; params.push(filter.authorId); }
    if (filter.search) { sql += ' AND (n.title LIKE ? OR n.content LIKE ?)'; const s = `%${filter.search}%`; params.push(s, s); }
    if (filter.tagId !== undefined) {
      sql += ' AND EXISTS (SELECT 1 FROM erp_note_tag_map m WHERE m.note_id = n.id AND m.tag_id = ?)';
      params.push(filter.tagId);
    }
    sql += ' ORDER BY n.pinned DESC, n.updated_at DESC';
    // Pagination (M12 sweep): safe defaults, cap at 500 to avoid OOM on huge workspaces.
    const limit = Math.min(Math.max(1, filter.limit ?? 200), 500);
    const offset = Math.max(0, filter.offset ?? 0);
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const notes = this.db().query<ErpNote>(sql, params);
    if (!notes.length) return notes;

    // Batch-load tags for every returned note in ONE query (avoids N+1 issue
    // flagged in audit m13 when rendering long note lists).
    const ids = notes.map(n => n.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db().query<any>(
      `SELECT m.note_id AS note_id, t.id, t.name, t.color
       FROM erp_note_tag_map m
       JOIN erp_note_tags t ON t.id = m.tag_id
       WHERE m.note_id IN (${placeholders})`,
      ids,
    );
    const byNote = new Map<string, ErpNoteTag[]>();
    for (const r of rows) {
      const arr = byNote.get(r.note_id) ?? [];
      arr.push({ id: r.id, name: r.name, color: r.color });
      byNote.set(r.note_id, arr);
    }
    return notes.map(n => ({ ...n, tags: byNote.get(n.id) ?? [] }));
  }

  listNotesForEmployee(
    employeeId: string,
    filter: { folderId?: number; tagId?: number; search?: string; authorId?: string; limit?: number; offset?: number },
  ): ErpNote[] {
    return this.listNotes({
      ...filter,
      authorId: filter.authorId,
      limit: filter.limit,
      offset: filter.offset,
    }).filter(note => this.getNotePermission(note.id, employeeId) !== null);
  }

  getNote(id: string): ErpNote | undefined {
    const note = this.db().queryOne<ErpNote>(`SELECT * FROM erp_notes WHERE id = ?`, [id]);
    if (!note) return undefined;
    return { ...note, tags: this._getNoteTags(id) };
  }

  getNoteForEmployee(id: string, employeeId: string): ErpNote | undefined {
    const note = this.getNote(id);
    if (!note) return undefined;
    return this.getNotePermission(id, employeeId) ? note : undefined;
  }

  createNote(input: CreateNoteInput, authorId: string): ErpNote {
    const id = uuidv4();
    const now = Date.now();
    this.db().run(
      `INSERT INTO erp_notes (id, folder_id, title, content, author_id, pinned, share_scope, created_at, updated_at)
       VALUES (?,?,?,?,?,0,'private',?,?)`,
      [id, input.folder_id ?? null, input.title, input.content ?? '', authorId, now, now]
    );
    const note = this.getNote(id)!;
    EventBroadcaster.emit('erp:event:noteCreated', { note, visibleEmployeeIds: this.getVisibleEmployeeIdsForNote(note) });
    return note;
  }

  updateNote(id: string, patch: UpdateNoteInput, editorId: string): ErpNote {
    const now = Date.now();
    const existing = this.db().queryOne<ErpNote>(`SELECT * FROM erp_notes WHERE id = ?`, [id]);
    if (!existing) throw new Error('Note not found');

    this.db().transaction(() => {
      // Snapshot version if last update was > 5 minutes ago
      if (patch.content !== undefined && (now - existing.updated_at) > 5 * 60_000) {
        this.db().run(
          `INSERT INTO erp_note_versions (note_id, content_snapshot, editor_id, created_at) VALUES (?,?,?,?)`,
          [id, existing.content, editorId, now]
        );
      }

      const fields: string[] = [];
      const vals: any[] = [];
      if (patch.title !== undefined) { fields.push('title = ?'); vals.push(patch.title); }
      if (patch.content !== undefined) { fields.push('content = ?'); vals.push(patch.content); }
      if (patch.folder_id !== undefined) { fields.push('folder_id = ?'); vals.push(patch.folder_id); }
      if (patch.pinned !== undefined) { fields.push('pinned = ?'); vals.push(patch.pinned); }
      if (patch.share_scope !== undefined) { fields.push('share_scope = ?'); vals.push(patch.share_scope); }
      if (fields.length) {
        fields.push('updated_at = ?'); vals.push(now); vals.push(id);
        this.db().run(`UPDATE erp_notes SET ${fields.join(', ')} WHERE id = ?`, vals);
      }
    });

    const note = this.getNote(id)!;
    EventBroadcaster.emit('erp:event:noteUpdated', { noteId: id, note, editorId, visibleEmployeeIds: this.getVisibleEmployeeIdsForNote(note) });
    if (patch.share_scope !== undefined && patch.share_scope !== existing.share_scope) {
      // Scope changed: people who LOSE the view right (e.g. workspace → private) do not receive noteUpdated (which has the content); they get
      // noteShared (no content), which both the old and new viewers receive, so each machine reloads the list by permission
      this.emitNoteAudienceChanged(existing, note.share_scope, this.listShares(id), editorId, this.getVisibleEmployeeIdsForNote(existing));
    }
    return note;
  }

  updateNoteForEmployee(id: string, patch: UpdateNoteInput, editorId: string): ErpNote {
    const permission = this.getNotePermission(id, editorId);
    if (!permission || (permission !== 'owner' && permission !== 'edit')) {
      throw new Error(tr('Bạn không có quyền sửa note này'));
    }
    if (patch.share_scope !== undefined) {
      // Only the author can change the sharing scope (as with shareNote): before, someone with edit rights on a shared note could open it to the whole workspace
      if (permission !== 'owner') throw new Error(tr('Chỉ người tạo mới có thể đổi phạm vi chia sẻ note'));
      if (!['private', 'workspace', 'custom'].includes(String(patch.share_scope))) throw new Error(tr('share_scope: không hợp lệ'));
    }
    return this.updateNote(id, patch, editorId);
  }

  pinNoteForEmployee(id: string, pinned: boolean, employeeId: string): ErpNote {
    return this.updateNoteForEmployee(id, { pinned: pinned ? 1 : 0 }, employeeId);
  }

  deleteNote(id: string): void {
    const note = this.getNote(id);
    const visibleEmployeeIds = note ? this.getVisibleEmployeeIdsForNote(note) : [];
    this.db().transaction(() => {
      this.db().run(`DELETE FROM erp_note_tag_map WHERE note_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_note_versions WHERE note_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_note_shares WHERE note_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_notes WHERE id = ?`, [id]);
    });
    // scope: a workspace-scope note (empty visibleEmployeeIds = everyone) → the relay sends it to every employee; before, the payload
    // with no scope → only the Boss receives it; employees still see the deleted note
    EventBroadcaster.emit('erp:event:noteDeleted', {
      noteId: id,
      visibleEmployeeIds,
      ...(note ? { scope: note.share_scope, authorId: note.author_id } : {}),
    });
  }

  deleteNoteForEmployee(id: string, actorId: string): void {
    const permission = this.getNotePermission(id, actorId);
    if (permission !== 'owner') throw new Error(tr('Bạn không có quyền xóa note này'));
    this.deleteNote(id);
  }

  // ─── Sharing (Phase 2) ─────────────────────────────────────────────────────

  listShares(noteId: string): ErpNoteShare[] {
    return this.db().query<ErpNoteShare>(
      `SELECT * FROM erp_note_shares WHERE note_id = ?`, [noteId]
    );
  }

  listSharesForEmployee(noteId: string, employeeId: string): ErpNoteShare[] {
    return this.getNotePermission(noteId, employeeId) ? this.listShares(noteId) : [];
  }

  shareNote(
    noteId: string,
    shares: Array<{ employeeId: string; permission: NoteSharePermission }>,
    scope: NoteShareScope,
    actorId: string,
  ): void {
    const now = Date.now();
    const note = this.db().queryOne<ErpNote>(`SELECT * FROM erp_notes WHERE id = ?`, [noteId]);
    if (!note) throw new Error(tr('Không tìm thấy ghi chú'));
    if (note.author_id !== actorId) throw new Error(tr('Chỉ người tạo mới có thể chia sẻ note'));
    // Normalise: the permission is only 'read' / 'edit' (before, the string sent was stored as is: 'owner' for someone given sharing rights
    // could delete the note), deduplicate, drop the author themselves
    const nextShares = new Map<string, NoteSharePermission>();
    for (const s of Array.isArray(shares) ? shares : []) {
      const employeeId = typeof s?.employeeId === 'string' ? s.employeeId.trim() : '';
      if (!employeeId || employeeId === note.author_id) continue;
      nextShares.set(employeeId, s.permission === 'edit' ? 'edit' : 'read');
    }
    const cleanShares = [...nextShares].map(([employeeId, permission]) => ({ employeeId, permission }));
    const previousShares = this.listShares(noteId);
    const previousPermission = new Map<string, string>(previousShares.map(share => [share.employee_id, share.permission] as [string, string]));
    const previousVisible = this.getVisibleEmployeeIdsForNote(note);
    this.db().transaction(() => {
      this.db().run(`DELETE FROM erp_note_shares WHERE note_id = ?`, [noteId]);
      for (const s of cleanShares) {
        this.db().run(
          `INSERT OR REPLACE INTO erp_note_shares (note_id, employee_id, permission) VALUES (?,?,?)`,
          [noteId, s.employeeId, s.permission]
        );
      }
      this.db().run(
        `UPDATE erp_notes SET share_scope = ?, updated_at = ? WHERE id = ?`,
        [scope, now, noteId]
      );
    });
    // Notify NEW recipients (or a permission change); saving the sharing setting does not resend to people who were already shared with
    for (const s of cleanShares) {
      if (s.employeeId === actorId || previousPermission.get(s.employeeId) === s.permission) continue;
      try {
        ErpNotificationService.getInstance().notify(
          s.employeeId, 'note_shared',
          tr('Ghi chú được chia sẻ: {{title}}', { title: note.title }),
          tr('Bởi {{v1}} · {{v2}}', { v1: erpPersonName(actorId), v2: s.permission === 'edit' ? tr('Được sửa') : tr('Chỉ xem') }),
          `erp://note/${noteId}`,
          { noteId, permission: s.permission, channels: ['toast'] }
        );
      } catch (err: any) { Logger.warn(`[ErpNoteService] share notify: ${err.message}`); }
    }
    this.emitNoteAudienceChanged(
      note, scope, cleanShares.map(s => ({ employee_id: s.employeeId, permission: s.permission })), actorId, previousVisible,
    );
  }

  /**
   * erp:event:noteShared (carries no note content): both OLD and NEW viewers receive it to reload the list by permission,
   * people who were just un-shared / a narrowed scope drop the note from their list. `previousScope` = 'workspace' → the relay sends it to every
   * employee (relayAudience). Before, only the current viewers received it → people who lost the permission still saw the note until they reloaded.
   */
  private emitNoteAudienceChanged(
    before: ErpNote,
    scope: NoteShareScope,
    shares: Array<{ employee_id: string; permission?: string }>,
    actorId: string,
    previousVisible: string[],
  ): void {
    const nextVisible = this.getVisibleEmployeeIdsForNote({ ...before, share_scope: scope });
    EventBroadcaster.emit('erp:event:noteShared', {
      noteId: before.id,
      scope,
      previousScope: before.share_scope,
      shares: shares.map(share => ({ employeeId: share.employee_id, permission: share.permission })),
      authorId: before.author_id || actorId,
      visibleEmployeeIds: Array.from(new Set([...previousVisible, ...nextVisible])),
    });
  }

  /** Returns permission ('read'|'edit'|'owner'|null) the caller has on note. */
  getNotePermission(noteId: string, employeeId: string): 'owner' | 'read' | 'edit' | null {
    const note = this.db().queryOne<ErpNote>(`SELECT * FROM erp_notes WHERE id = ?`, [noteId]);
    if (!note) return null;
    if (note.author_id === employeeId) return 'owner';
    if (note.share_scope === 'workspace') return 'read';
    const share = this.db().queryOne<ErpNoteShare>(
      `SELECT * FROM erp_note_shares WHERE note_id = ? AND employee_id = ?`, [noteId, employeeId]
    );
    return share?.permission ?? null;
  }

  // ─── Tags ──────────────────────────────────────────────────────────────────

  listTags(): ErpNoteTag[] {
    return this.db().query<ErpNoteTag>(`SELECT * FROM erp_note_tags ORDER BY name ASC LIMIT 500`);
  }

  createTag(name: string, color?: string): ErpNoteTag {
    this.db().run(`INSERT OR IGNORE INTO erp_note_tags (name, color) VALUES (?,?)`, [name, color ?? '#6b7280']);
    // name is UNIQUE → single row
    return this.db().queryOne<ErpNoteTag>(`SELECT * FROM erp_note_tags WHERE name = ?`, [name])!;
  }

  addTagToNote(noteId: string, tagId: number): void {
    this.db().run(`INSERT OR IGNORE INTO erp_note_tag_map (note_id, tag_id) VALUES (?,?)`, [noteId, tagId]);
  }

  removeTagFromNote(noteId: string, tagId: number): void {
    this.db().run(`DELETE FROM erp_note_tag_map WHERE note_id = ? AND tag_id = ?`, [noteId, tagId]);
  }

  /** Adding / removing tags needs the edit right on the note (author / shared with edit rights); before, it was checked against any note id. */
  addTagToNoteForEmployee(noteId: string, tagId: number, employeeId: string): void {
    this.requireNoteEdit(noteId, employeeId);
    this.addTagToNote(noteId, tagId);
  }

  removeTagFromNoteForEmployee(noteId: string, tagId: number, employeeId: string): void {
    this.requireNoteEdit(noteId, employeeId);
    this.removeTagFromNote(noteId, tagId);
  }

  private requireNoteEdit(noteId: string, employeeId: string): void {
    const permission = this.getNotePermission(noteId, employeeId);
    if (permission !== 'owner' && permission !== 'edit') throw new Error(tr('Bạn không có quyền sửa note này'));
  }

  // ─── Versions ─────────────────────────────────────────────────────────────

  listVersions(noteId: string): ErpNoteVersion[] {
    return this.db().query<ErpNoteVersion>(
      `SELECT * FROM erp_note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 20`, [noteId]
    );
  }

  listVersionsForEmployee(noteId: string, employeeId: string): ErpNoteVersion[] {
    const permission = this.getNotePermission(noteId, employeeId);
    if (!permission || permission === 'read') return [];
    return this.listVersions(noteId);
  }

  restoreVersion(versionId: number, editorId: string): ErpNote {
    const version = this.db().queryOne<ErpNoteVersion>(`SELECT * FROM erp_note_versions WHERE id = ?`, [versionId]);
    if (!version) throw new Error('Version not found');
    return this.updateNote(version.note_id, { content: version.content_snapshot }, editorId);
  }

  restoreVersionForEmployee(versionId: number, editorId: string): ErpNote {
    const version = this.db().queryOne<ErpNoteVersion>(`SELECT * FROM erp_note_versions WHERE id = ?`, [versionId]);
    if (!version) throw new Error('Version not found');
    const permission = this.getNotePermission(version.note_id, editorId);
    if (!permission || (permission !== 'owner' && permission !== 'edit')) {
      throw new Error(tr('Bạn không có quyền khôi phục phiên bản của note này'));
    }
    return this.restoreVersion(versionId, editorId);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _getNoteTags(noteId: string): ErpNoteTag[] {
    return this.db().query<ErpNoteTag>(`
      SELECT t.* FROM erp_note_tags t
      JOIN erp_note_tag_map m ON m.tag_id = t.id
      WHERE m.note_id = ?
    `, [noteId]);
  }

  private getVisibleEmployeeIdsForNote(note: ErpNote): string[] {
    if (note.share_scope === 'workspace') return [];
    const shares = this.listShares(note.id);
    return Array.from(new Set([note.author_id, ...shares.map(share => share.employee_id).filter(Boolean)]));
  }
}

