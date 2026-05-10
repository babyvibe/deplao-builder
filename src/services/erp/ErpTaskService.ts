import { v4 as uuidv4 } from 'uuid';
import DatabaseService from '../DatabaseService';
import EventBroadcaster from '../EventBroadcaster';
import FileStorageService from '../FileStorageService';
import Logger from '../../utils/Logger';
import type {
  ErpProject, CreateProjectInput, UpdateProjectInput,
  ErpTask, ErpTaskDetail, CreateTaskInput, UpdateTaskInput,
  ErpTaskPriority, ErpTaskStatus, ErpChecklistItem, ErpComment, TaskInboxFilter, TaskAttachmentInput,
} from '../../models/erp';
import ErpNotificationService from './ErpNotificationService';

export default class ErpTaskService {
  private static instance: ErpTaskService;
  static getInstance(): ErpTaskService {
    if (!this.instance) this.instance = new ErpTaskService();
    return this.instance;
  }

  private db() { return DatabaseService.getInstance(); }

  // ─── Projects ──────────────────────────────────────────────────────────────

  listProjects(filter?: { archived?: boolean }): ErpProject[] {
    const status = filter?.archived ? 'archived' : 'active';
    return this.db().query<ErpProject>(
      `SELECT * FROM erp_projects WHERE status = ? ORDER BY created_at ASC`,
      [status]
    );
  }

  getProject(id: string): ErpProject | undefined {
    return this.db().queryOne<ErpProject>(`SELECT * FROM erp_projects WHERE id = ?`, [id]);
  }

  createProject(input: CreateProjectInput, employeeId: string): ErpProject {
    const id = uuidv4();
    const now = Date.now();
    this.db().run(
      `INSERT INTO erp_projects (id, name, description, color, owner_employee_id, department_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, input.name, input.description ?? '', input.color ?? '#3b82f6', employeeId, input.department_id ?? null, now, now]
    );
    const project = this.getProject(id)!;
    EventBroadcaster.emit('erp:event:projectCreated', { project });
    return project;
  }

  updateProject(id: string, patch: UpdateProjectInput): ErpProject {
    const now = Date.now();
    const fields: string[] = [];
    const vals: any[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); vals.push(patch.name); }
    if (patch.description !== undefined) { fields.push('description = ?'); vals.push(patch.description); }
    if (patch.color !== undefined) { fields.push('color = ?'); vals.push(patch.color); }
    if (patch.status !== undefined) { fields.push('status = ?'); vals.push(patch.status); }
    if (patch.department_id !== undefined) { fields.push('department_id = ?'); vals.push(patch.department_id); }
    if (!fields.length) return this.getProject(id)!;
    fields.push('updated_at = ?'); vals.push(now); vals.push(id);
    this.db().run(`UPDATE erp_projects SET ${fields.join(', ')} WHERE id = ?`, vals);
    const project = this.getProject(id)!;
    EventBroadcaster.emit('erp:event:projectUpdated', { project });
    return project;
  }

  deleteProject(id: string): void {
    this.db().transaction(() => {
      this.db().run(`UPDATE erp_tasks SET archived = 1, updated_at = ? WHERE project_id = ?`, [Date.now(), id]);
      this.db().run(`DELETE FROM erp_projects WHERE id = ?`, [id]);
    });
    EventBroadcaster.emit('erp:event:projectDeleted', { projectId: id });
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  listTasks(filter: {
    projectId?: string;
    assigneeId?: string;
    priority?: ErpTaskPriority;
    status?: ErpTaskStatus;
    dueRange?: [number, number];
    search?: string;
    archived?: boolean;
    parentTaskId?: string | null;
    limit?: number;
    offset?: number;
  } = {}): ErpTask[] {
    let sql = `
      SELECT t.*,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) as assignees_raw,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_watchers WHERE task_id = t.id) as watchers_raw,
        (SELECT COUNT(*) FROM erp_task_checklist WHERE task_id = t.id) as checklist_total,
        (SELECT COUNT(*) FROM erp_task_checklist WHERE task_id = t.id AND done = 1) as checklist_done,
        (SELECT COUNT(*) FROM erp_task_comments WHERE task_id = t.id) as comment_count
      FROM erp_tasks t
      WHERE t.archived = ?
    `;
    const params: any[] = [filter.archived ? 1 : 0];

    if (filter.projectId) { sql += ' AND t.project_id = ?'; params.push(filter.projectId); }
    if (filter.priority) { sql += ' AND t.priority = ?'; params.push(filter.priority); }
    if (filter.status) { sql += ' AND t.status = ?'; params.push(filter.status); }
    if (filter.dueRange) {
      sql += ' AND t.due_date BETWEEN ? AND ?';
      params.push(filter.dueRange[0], filter.dueRange[1]);
    }
    if (filter.search) {
      sql += ' AND t.title LIKE ?';
      params.push(`%${filter.search}%`);
    }
    if (filter.parentTaskId !== undefined) {
      if (filter.parentTaskId === null) {
        sql += ' AND t.parent_task_id IS NULL';
      } else {
        sql += ' AND t.parent_task_id = ?';
        params.push(filter.parentTaskId);
      }
    }
    if (filter.assigneeId) {
      sql += ` AND EXISTS (SELECT 1 FROM erp_task_assignees WHERE task_id = t.id AND employee_id = ?)`;
      params.push(filter.assigneeId);
    }

    sql += ' ORDER BY t.sort_order ASC, t.created_at ASC';
    if (filter.limit && filter.limit > 0) {
      sql += ' LIMIT ?';
      params.push(Math.min(filter.limit, 1000));
      if (filter.offset && filter.offset > 0) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const rows = this.db().query<any>(sql, params);
    return rows.map(row => this._inflateTaskRow(row));
  }

  private _getTaskLite(id: string): ErpTask | undefined {
    const row = this.db().queryOne<any>(`
      SELECT t.*,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) as assignees_raw,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_watchers WHERE task_id = t.id) as watchers_raw,
        (SELECT COUNT(*) FROM erp_task_checklist WHERE task_id = t.id) as checklist_total,
        (SELECT COUNT(*) FROM erp_task_checklist WHERE task_id = t.id AND done = 1) as checklist_done,
        (SELECT COUNT(*) FROM erp_task_comments WHERE task_id = t.id) as comment_count
      FROM erp_tasks t WHERE t.id = ?
    `, [id]);
    if (!row) return undefined;
    return this._inflateTaskRow(row);
  }

  getTaskDetail(id: string): ErpTaskDetail | undefined {
    const task = this.db().queryOne<any>(`
      SELECT t.*,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) as assignees_raw
      FROM erp_tasks t WHERE t.id = ?
    `, [id]);
    if (!task) return undefined;

    const checklist = this.db().query<ErpChecklistItem>(
      `SELECT * FROM erp_task_checklist WHERE task_id = ? ORDER BY sort_order ASC`, [id]
    );
    const comments = this.db().query<ErpComment>(
      `SELECT * FROM erp_task_comments WHERE task_id = ? ORDER BY created_at ASC`, [id]
    ).map(c => ({ ...c, mentions: this._safeJsonArray((c as any).mentions) }));
    const attachments = this.db().query<any>(
      `SELECT * FROM erp_task_attachments WHERE task_id = ? ORDER BY uploaded_at ASC`, [id]
    );
    const activity = this.db().query<any>(
      `SELECT * FROM erp_task_activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT 50`, [id]
    ).map(a => ({ ...a, payload: this._safeJsonObject(a.payload) }));
    const watchers = this.db().query<any>(
      `SELECT employee_id FROM erp_task_watchers WHERE task_id = ?`, [id]
    ).map(r => r.employee_id);
    const dependencies = this.db().query<any>(
      `SELECT * FROM erp_task_dependencies WHERE task_id = ?`, [id]
    );

    return {
      ...task,
      assignees: this._splitEmployeeIds(task.assignees_raw),
      checklist,
      comments,
      attachments,
      activity,
      watchers: Array.from(new Set(watchers.filter(Boolean))),
      dependencies,
    };
  }

  // ─── Watchers (Phase 2) ───────────────────────────────────────────────────

  addWatcher(taskId: string, employeeId: string): void {
    this.db().run(
      `INSERT OR IGNORE INTO erp_task_watchers (task_id, employee_id, added_at) VALUES (?,?,?)`,
      [taskId, employeeId, Date.now()]
    );
    const task = this._getTaskLite(taskId);
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId, patch: { watchers: 'added' }, task });
  }

  removeWatcher(taskId: string, employeeId: string): void {
    this.db().run(`DELETE FROM erp_task_watchers WHERE task_id = ? AND employee_id = ?`, [taskId, employeeId]);
    const task = this._getTaskLite(taskId);
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId, patch: { watchers: 'removed' }, task });
  }

  // ─── Dependencies (Phase 2) ───────────────────────────────────────────────

  addDependency(taskId: string, dependsOnId: string, type: 'FS' | 'SS' | 'FF' | 'SF' = 'FS'): void {
    if (taskId === dependsOnId) throw new Error('Task không thể phụ thuộc chính nó');
    // Acyclic check: BFS from dependsOnId, fail if we reach taskId
    const visited = new Set<string>();
    const queue = [dependsOnId];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === taskId) throw new Error('Phụ thuộc tạo vòng lặp');
      if (visited.has(cur)) continue;
      visited.add(cur);
      const next = this.db().query<any>(
        `SELECT depends_on_task_id FROM erp_task_dependencies WHERE task_id = ?`, [cur]
      );
      for (const r of next) queue.push(r.depends_on_task_id);
    }
    this.db().run(
      `INSERT OR IGNORE INTO erp_task_dependencies (task_id, depends_on_task_id, type, created_at) VALUES (?,?,?,?)`,
      [taskId, dependsOnId, type, Date.now()]
    );
    const task = this._getTaskLite(taskId);
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId, patch: { dependency: 'added' }, task });
  }

  removeDependency(taskId: string, dependsOnId: string): void {
    this.db().run(
      `DELETE FROM erp_task_dependencies WHERE task_id = ? AND depends_on_task_id = ?`, [taskId, dependsOnId]
    );
    const task = this._getTaskLite(taskId);
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId, patch: { dependency: 'removed' }, task });
  }

  /** Throws if task has any incomplete blocker. */
  private _assertDependenciesSatisfied(taskId: string): void {
    const blockers = this.db().query<any>(
      `SELECT d.depends_on_task_id, t.status, t.title
       FROM erp_task_dependencies d
       JOIN erp_tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ? AND t.status NOT IN ('done','cancelled')`,
      [taskId]
    );
    if (blockers.length) {
      const titles = blockers.map(b => b.title).slice(0, 3).join(', ');
      throw new Error(`Task bị chặn bởi: ${titles}${blockers.length > 3 ? '…' : ''}`);
    }
  }

  createTask(input: CreateTaskInput, reporterId: string): ErpTask {
    const id = uuidv4();
    const now = Date.now();

    this.db().transaction(() => {
      this.db().run(
        `INSERT INTO erp_tasks
          (id, project_id, parent_task_id, title, description, status, priority, reporter_id,
           start_date, due_date, estimated_hours, linked_contact_id, linked_zalo_msg_id,
           actual_hours, sort_order, archived, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)`,
        [
          id, input.project_id ?? null, input.parent_task_id ?? null,
          input.title, input.description ?? '', input.status ?? 'todo',
          input.priority ?? 'normal', reporterId,
          input.start_date ?? null, input.due_date ?? null, input.estimated_hours ?? null,
          input.linked_contact_id ?? null, input.linked_zalo_msg_id ?? null,
          now, now,
        ]
      );
      if (input.assignees?.length) {
        this._assignTask(id, input.assignees, now);
      }
      if (input.watchers) {
        this._replaceWatchers(id, input.watchers, now);
      }
      if (input.attachments) {
        this._replaceAttachments(id, input.attachments, reporterId, now);
      }
      this._logActivity(id, reporterId, 'created', { title: input.title });
    });

    const task = this._getTaskLite(id) ?? ({ id } as any);
    EventBroadcaster.emit('erp:event:taskCreated', { task });

    // Notify only explicit assignees (not auto-self-assigned reporter).
    if (input.assignees?.length) {
      for (const empId of input.assignees) {
        if (empId && empId !== reporterId) {
          try {
            ErpNotificationService.getInstance().notify(
              empId, 'task_assigned',
              `Bạn được giao task: ${input.title}`,
              `Được giao bởi ${reporterId}`,
              `erp://task/${id}`,
            );
          } catch (err: any) {
            Logger.warn(`[ErpTaskService] notify assignee ${empId} failed: ${err.message}`);
          }
        }
      }
    }
    return task;
  }

  updateTask(id: string, patch: UpdateTaskInput, actorId: string): ErpTask {
    const now = Date.now();
    const fields: string[] = [];
    const vals: any[] = [];
    const allowed: (keyof UpdateTaskInput)[] = [
      'project_id', 'title', 'description', 'status', 'priority', 'due_date', 'start_date',
      'estimated_hours', 'actual_hours', 'linked_contact_id', 'sort_order',
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) { fields.push(`${key} = ?`); vals.push(patch[key]); }
    }
    const hasRelationPatch = patch.assignees !== undefined || patch.watchers !== undefined || patch.attachments !== undefined;
    if (!fields.length && !hasRelationPatch) {
      const existing = this._getTaskLite(id);
      if (!existing) throw new Error('Task not found');
      return existing;
    }

    if (patch.status === 'done') { fields.push('completed_at = ?'); vals.push(now); }
    else if (patch.status && (patch.status as string) !== 'done') { fields.push('completed_at = NULL'); }

    if (patch.status === 'done') {
      this._assertDependenciesSatisfied(id);
    }

    this.db().transaction(() => {
      if (fields.length) {
        fields.push('updated_at = ?'); vals.push(now); vals.push(id);
        this.db().run(`UPDATE erp_tasks SET ${fields.join(', ')} WHERE id = ?`, vals);
      } else {
        this._touchTask(id);
      }
      if (patch.assignees !== undefined) {
        this.db().run(`DELETE FROM erp_task_assignees WHERE task_id = ?`, [id]);
        this._assignTask(id, patch.assignees, now);
      }
      if (patch.watchers !== undefined) {
        this._replaceWatchers(id, patch.watchers, now);
      }
      if (patch.attachments !== undefined) {
        this._replaceAttachments(id, patch.attachments, actorId, now);
      }
      this._logActivity(id, actorId, patch.status ? 'status_changed' : 'updated', {
        patch: {
          ...patch,
          attachments: patch.attachments?.map(item => item.file_name),
        },
      });
    });

    const task = this._getTaskLite(id) ?? ({ id } as any);

    // If the caller changed `due_date`, keep the linked calendar event in sync.
    // Lazy-require to avoid a circular import cycle at module load time.
    if (patch.due_date !== undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ErpCalendarService = require('./ErpCalendarService').default;
        if (patch.due_date && typeof patch.due_date === 'number') {
          ErpCalendarService.getInstance().syncTaskToCalendar(
            id, task.title ?? '(Task)', patch.due_date, actorId,
          );
        }
      } catch (err: any) {
        Logger.warn(`[ErpTaskService] syncTaskToCalendar skipped: ${err.message}`);
      }
    }

    EventBroadcaster.emit('erp:event:taskUpdated', { taskId: id, patch, actorId, task });
    return task;
  }

  assignTask(id: string, employeeIds: string[], actorId: string): void {
    const now = Date.now();
    this.db().transaction(() => {
      this.db().run(`DELETE FROM erp_task_assignees WHERE task_id = ?`, [id]);
      this._assignTask(id, employeeIds, now);
      this._logActivity(id, actorId, 'assigned', { employeeIds });
    });
    const task = this._getTaskLite(id);
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId: id, patch: { assignees: employeeIds }, actorId, task });
  }

  deleteTask(id: string): void {
    const existingAttachments = this.db().query<any>(`SELECT file_path FROM erp_task_attachments WHERE task_id = ?`, [id]);
    this.db().transaction(() => {
      this.db().run(`DELETE FROM erp_task_assignees WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_checklist WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_comments WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_attachments WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_activity_log WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_watchers WHERE task_id = ?`, [id]);
      this.db().run(`DELETE FROM erp_task_dependencies WHERE task_id = ? OR depends_on_task_id = ?`, [id, id]);
      this.db().run(`DELETE FROM erp_tasks WHERE id = ?`, [id]);
    });
    for (const attachment of existingAttachments) {
      FileStorageService.deleteManagedTaskAttachment(attachment.file_path);
    }
    EventBroadcaster.emit('erp:event:taskDeleted', { taskId: id });
  }

  // ─── Checklist ─────────────────────────────────────────────────────────────

  addChecklist(taskId: string, content: string): ErpChecklistItem {
    const now = Date.now();
    const sortOrderRow = this.db().queryOne<any>(
      `SELECT MAX(sort_order) as m FROM erp_task_checklist WHERE task_id = ?`, [taskId]
    );
    const sortOrder = (sortOrderRow?.m ?? 0) + 1;
    const newId = this.db().runInsert(
      `INSERT INTO erp_task_checklist (task_id, content, done, sort_order, created_at) VALUES (?,?,0,?,?)`,
      [taskId, content, sortOrder, now]
    );
    const item = this.db().queryOne<ErpChecklistItem>(
      `SELECT * FROM erp_task_checklist WHERE id = ?`, [newId]
    )!;
    this._touchTask(taskId);
    return item;
  }

  toggleChecklist(id: number, done: boolean): ErpChecklistItem {
    this.db().run(`UPDATE erp_task_checklist SET done = ? WHERE id = ?`, [done ? 1 : 0, id]);
    return this.db().queryOne<ErpChecklistItem>(`SELECT * FROM erp_task_checklist WHERE id = ?`, [id])!;
  }

  // ─── Comments ──────────────────────────────────────────────────────────────

  addComment(taskId: string, authorId: string, content: string, mentions: string[] = []): ErpComment {
    const now = Date.now();
    const newId = this.db().runInsert(
      `INSERT INTO erp_task_comments (task_id, author_id, content, mentions, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      [taskId, authorId, content, JSON.stringify(mentions), now, now]
    );
    const comment = this.db().queryOne<any>(
      `SELECT * FROM erp_task_comments WHERE id = ?`, [newId]
    )!;
    this._logActivity(taskId, authorId, 'commented', { preview: content.slice(0, 50) });
    this._touchTask(taskId);
    const task = this._getTaskLite(taskId);
    EventBroadcaster.emit('erp:event:commentAdded', { taskId, comment: { ...comment, mentions }, task });
    EventBroadcaster.emit('erp:event:taskUpdated', { taskId, patch: { comment_count: task?.comment_count || 0 }, task });
    return { ...comment, mentions };
  }

  editComment(id: number, content: string): ErpComment {
    const now = Date.now();
    this.db().run(`UPDATE erp_task_comments SET content = ?, updated_at = ? WHERE id = ?`, [content, now, id]);
    const comment = this.db().queryOne<any>(`SELECT * FROM erp_task_comments WHERE id = ?`, [id])!;
    return { ...comment, mentions: this._safeJsonArray(comment.mentions) };
  }

  deleteComment(id: number): void {
    this.db().run(`DELETE FROM erp_task_comments WHERE id = ?`, [id]);
  }

  // ─── My Inbox ──────────────────────────────────────────────────────────────

  getMyInbox(employeeId: string, filter: TaskInboxFilter): ErpTask[] {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const weekEnd    = new Date(todayEnd); weekEnd.setDate(weekEnd.getDate() + 7);

    let condition = '';
    const params: any[] = [employeeId];

    if (filter === 'today') {
      condition = 'AND (t.due_date BETWEEN ? AND ? OR t.due_date IS NULL)';
      params.push(todayStart.getTime(), todayEnd.getTime());
    } else if (filter === 'week') {
      condition = 'AND (t.due_date BETWEEN ? AND ? OR t.due_date IS NULL)';
      params.push(todayStart.getTime(), weekEnd.getTime());
    } else if (filter === 'overdue') {
      condition = `AND t.due_date < ? AND t.status != 'done' AND t.status != 'cancelled'`;
      params.push(now);
    } else if (filter === 'upcoming') {
      condition = 'AND t.due_date > ?';
      params.push(weekEnd.getTime());
    } else if (filter === 'all') {
      // No date filter — show every assigned task that's still active.
      condition = `AND t.status != 'cancelled'`;
    }

    return this.db().query<any>(`
      SELECT t.*,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) as assignees_raw,
        (SELECT GROUP_CONCAT(employee_id) FROM erp_task_watchers WHERE task_id = t.id) as watchers_raw
      FROM erp_tasks t
      JOIN erp_task_assignees a ON a.task_id = t.id AND a.employee_id = ?
      WHERE t.archived = 0 ${condition}
      ORDER BY t.due_date ASC, t.priority DESC
    `, params).map(row => this._inflateTaskRow(row));
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _assignTask(taskId: string, employeeIds: string[], now: number): void {
    for (const empId of employeeIds) {
      if (!empId) continue;
      this.db().run(
        `INSERT OR IGNORE INTO erp_task_assignees (task_id, employee_id, assigned_at) VALUES (?,?,?)`,
        [taskId, empId, now]
      );
    }
  }

  private _replaceWatchers(taskId: string, employeeIds: string[], now: number): void {
    const uniqueIds = Array.from(new Set(employeeIds.filter(Boolean)));
    this.db().run(`DELETE FROM erp_task_watchers WHERE task_id = ?`, [taskId]);
    for (const empId of uniqueIds) {
      this.db().run(
        `INSERT OR IGNORE INTO erp_task_watchers (task_id, employee_id, added_at) VALUES (?,?,?)`,
        [taskId, empId, now],
      );
    }
  }

  private _replaceAttachments(taskId: string, attachments: TaskAttachmentInput[], actorId: string, now: number): void {
    const existingAttachments = this.db().query<any>(`SELECT file_path FROM erp_task_attachments WHERE task_id = ?`, [taskId]);
    const normalized = attachments
      .filter(item => item?.file_name && item?.file_path)
      .map(item => ({
        ...item,
        mime_type: item.mime_type ?? '',
        size: item.size ?? 0,
      }));
    this.db().run(`DELETE FROM erp_task_attachments WHERE task_id = ?`, [taskId]);

    const keptPaths = new Set<string>();
    for (const item of normalized) {
      const stored = FileStorageService.saveTaskAttachment(taskId, item.file_path, item.file_name);
      if (!stored.filePath) continue;
      keptPaths.add(stored.filePath);
      this.db().run(
        `INSERT INTO erp_task_attachments (task_id, file_name, file_path, mime_type, size, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?)`,
        [taskId, stored.fileName, stored.filePath, item.mime_type, item.size || stored.size, actorId, now],
      );
    }

    for (const attachment of existingAttachments) {
      if (!keptPaths.has(attachment.file_path)) {
        FileStorageService.deleteManagedTaskAttachment(attachment.file_path);
      }
    }
  }

  private _logActivity(taskId: string, actorId: string, action: string, payload: object): void {
    this.db().run(
      `INSERT INTO erp_task_activity_log (task_id, actor_id, action, payload, created_at) VALUES (?,?,?,?,?)`,
      [taskId, actorId, action, JSON.stringify(payload), Date.now()]
    );
  }

  private _touchTask(taskId: string): void {
    this.db().run(`UPDATE erp_tasks SET updated_at = ? WHERE id = ?`, [Date.now(), taskId]);
  }

  private _inflateTaskRow(row: any): ErpTask {
    return {
      ...row,
      assignees: this._splitEmployeeIds(row?.assignees_raw),
      watchers: this._splitEmployeeIds(row?.watchers_raw),
    };
  }

  private _splitEmployeeIds(raw: any): string[] {
    if (Array.isArray(raw)) return Array.from(new Set(raw.filter(Boolean)));
    if (typeof raw !== 'string' || !raw.trim()) return [];
    return Array.from(new Set(raw.split(',').map(value => value.trim()).filter(Boolean)));
  }

  private _safeJsonArray(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  private _safeJsonObject(raw: any): Record<string, any> {
    if (raw && typeof raw === 'object') return raw;
    if (!raw) return {};
    try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : {}; } catch { return {}; }
  }
}

