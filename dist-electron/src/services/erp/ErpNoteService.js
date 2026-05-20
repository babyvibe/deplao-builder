"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const uuid_1 = require("uuid");
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const EventBroadcaster_1 = __importDefault(require("../EventBroadcaster"));
const Logger_1 = __importDefault(require("../../utils/Logger"));
const ErpNotificationService_1 = __importDefault(require("./ErpNotificationService"));
class ErpNoteService {
    static getInstance() {
        if (!this.instance)
            this.instance = new ErpNoteService();
        return this.instance;
    }
    db() { return DatabaseService_1.default.getInstance(); }
    // ─── Folders ───────────────────────────────────────────────────────────────
    listFolders(ownerId) {
        // Bounded by workspace owner; 1000 cap as defensive upper bound.
        return this.db().query(`SELECT * FROM erp_note_folders WHERE owner_id = ? ORDER BY name ASC LIMIT 1000`, [ownerId]);
    }
    createFolder(name, ownerId, parentId) {
        const now = Date.now();
        const newId = this.db().runInsert(`INSERT INTO erp_note_folders (name, parent_id, owner_id, created_at) VALUES (?,?,?,?)`, [name, parentId ?? null, ownerId, now]);
        return this.db().queryOne(`SELECT * FROM erp_note_folders WHERE id = ?`, [newId]);
    }
    renameFolder(id, name) {
        this.db().run(`UPDATE erp_note_folders SET name = ? WHERE id = ?`, [name, id]);
    }
    renameFolderForEmployee(id, name, employeeId) {
        const folder = this.db().queryOne(`SELECT * FROM erp_note_folders WHERE id = ?`, [id]);
        if (!folder || folder.owner_id !== employeeId)
            throw new Error('Bạn không có quyền sửa thư mục này');
        this.renameFolder(id, name);
    }
    deleteFolder(id) {
        // Move notes to root (null folder)
        this.db().run(`UPDATE erp_notes SET folder_id = NULL WHERE folder_id = ?`, [id]);
        this.db().run(`DELETE FROM erp_note_folders WHERE id = ?`, [id]);
    }
    deleteFolderForEmployee(id, employeeId) {
        const folder = this.db().queryOne(`SELECT * FROM erp_note_folders WHERE id = ?`, [id]);
        if (!folder || folder.owner_id !== employeeId)
            throw new Error('Bạn không có quyền xóa thư mục này');
        this.deleteFolder(id);
    }
    // ─── Notes ─────────────────────────────────────────────────────────────────
    listNotes(filter) {
        let sql = `SELECT n.* FROM erp_notes n WHERE 1=1`;
        const params = [];
        if (filter.folderId !== undefined) {
            sql += ' AND n.folder_id = ?';
            params.push(filter.folderId);
        }
        if (filter.authorId) {
            sql += ' AND n.author_id = ?';
            params.push(filter.authorId);
        }
        if (filter.search) {
            sql += ' AND (n.title LIKE ? OR n.content LIKE ?)';
            const s = `%${filter.search}%`;
            params.push(s, s);
        }
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
        const notes = this.db().query(sql, params);
        if (!notes.length)
            return notes;
        // Batch-load tags for every returned note in ONE query (avoids N+1 issue
        // flagged in audit m13 when rendering long note lists).
        const ids = notes.map(n => n.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db().query(`SELECT m.note_id AS note_id, t.id, t.name, t.color
       FROM erp_note_tag_map m
       JOIN erp_note_tags t ON t.id = m.tag_id
       WHERE m.note_id IN (${placeholders})`, ids);
        const byNote = new Map();
        for (const r of rows) {
            const arr = byNote.get(r.note_id) ?? [];
            arr.push({ id: r.id, name: r.name, color: r.color });
            byNote.set(r.note_id, arr);
        }
        return notes.map(n => ({ ...n, tags: byNote.get(n.id) ?? [] }));
    }
    listNotesForEmployee(employeeId, filter) {
        return this.listNotes({
            ...filter,
            authorId: filter.authorId,
            limit: filter.limit,
            offset: filter.offset,
        }).filter(note => this.getNotePermission(note.id, employeeId) !== null);
    }
    getNote(id) {
        const note = this.db().queryOne(`SELECT * FROM erp_notes WHERE id = ?`, [id]);
        if (!note)
            return undefined;
        return { ...note, tags: this._getNoteTags(id) };
    }
    getNoteForEmployee(id, employeeId) {
        const note = this.getNote(id);
        if (!note)
            return undefined;
        return this.getNotePermission(id, employeeId) ? note : undefined;
    }
    createNote(input, authorId) {
        const id = (0, uuid_1.v4)();
        const now = Date.now();
        this.db().run(`INSERT INTO erp_notes (id, folder_id, title, content, author_id, pinned, share_scope, created_at, updated_at)
       VALUES (?,?,?,?,?,0,'private',?,?)`, [id, input.folder_id ?? null, input.title, input.content ?? '', authorId, now, now]);
        const note = this.getNote(id);
        EventBroadcaster_1.default.emit('erp:event:noteCreated', { note, visibleEmployeeIds: this.getVisibleEmployeeIdsForNote(note) });
        return note;
    }
    updateNote(id, patch, editorId) {
        const now = Date.now();
        const existing = this.db().queryOne(`SELECT * FROM erp_notes WHERE id = ?`, [id]);
        if (!existing)
            throw new Error('Note not found');
        this.db().transaction(() => {
            // Snapshot version if last update was > 5 minutes ago
            if (patch.content !== undefined && (now - existing.updated_at) > 5 * 60000) {
                this.db().run(`INSERT INTO erp_note_versions (note_id, content_snapshot, editor_id, created_at) VALUES (?,?,?,?)`, [id, existing.content, editorId, now]);
            }
            const fields = [];
            const vals = [];
            if (patch.title !== undefined) {
                fields.push('title = ?');
                vals.push(patch.title);
            }
            if (patch.content !== undefined) {
                fields.push('content = ?');
                vals.push(patch.content);
            }
            if (patch.folder_id !== undefined) {
                fields.push('folder_id = ?');
                vals.push(patch.folder_id);
            }
            if (patch.pinned !== undefined) {
                fields.push('pinned = ?');
                vals.push(patch.pinned);
            }
            if (patch.share_scope !== undefined) {
                fields.push('share_scope = ?');
                vals.push(patch.share_scope);
            }
            if (fields.length) {
                fields.push('updated_at = ?');
                vals.push(now);
                vals.push(id);
                this.db().run(`UPDATE erp_notes SET ${fields.join(', ')} WHERE id = ?`, vals);
            }
        });
        const note = this.getNote(id);
        EventBroadcaster_1.default.emit('erp:event:noteUpdated', { noteId: id, note, editorId, visibleEmployeeIds: this.getVisibleEmployeeIdsForNote(note) });
        return note;
    }
    updateNoteForEmployee(id, patch, editorId) {
        const permission = this.getNotePermission(id, editorId);
        if (!permission || (permission !== 'owner' && permission !== 'edit')) {
            throw new Error('Bạn không có quyền sửa note này');
        }
        return this.updateNote(id, patch, editorId);
    }
    pinNoteForEmployee(id, pinned, employeeId) {
        return this.updateNoteForEmployee(id, { pinned: pinned ? 1 : 0 }, employeeId);
    }
    deleteNote(id) {
        const note = this.getNote(id);
        const visibleEmployeeIds = note ? this.getVisibleEmployeeIdsForNote(note) : [];
        this.db().transaction(() => {
            this.db().run(`DELETE FROM erp_note_tag_map WHERE note_id = ?`, [id]);
            this.db().run(`DELETE FROM erp_note_versions WHERE note_id = ?`, [id]);
            this.db().run(`DELETE FROM erp_note_shares WHERE note_id = ?`, [id]);
            this.db().run(`DELETE FROM erp_notes WHERE id = ?`, [id]);
        });
        EventBroadcaster_1.default.emit('erp:event:noteDeleted', { noteId: id, visibleEmployeeIds });
    }
    deleteNoteForEmployee(id, actorId) {
        const permission = this.getNotePermission(id, actorId);
        if (permission !== 'owner')
            throw new Error('Bạn không có quyền xóa note này');
        this.deleteNote(id);
    }
    // ─── Sharing (Phase 2) ─────────────────────────────────────────────────────
    listShares(noteId) {
        return this.db().query(`SELECT * FROM erp_note_shares WHERE note_id = ?`, [noteId]);
    }
    listSharesForEmployee(noteId, employeeId) {
        return this.getNotePermission(noteId, employeeId) ? this.listShares(noteId) : [];
    }
    shareNote(noteId, shares, scope, actorId) {
        const now = Date.now();
        const note = this.db().queryOne(`SELECT * FROM erp_notes WHERE id = ?`, [noteId]);
        if (!note)
            throw new Error('Không tìm thấy ghi chú');
        if (note.author_id !== actorId)
            throw new Error('Chỉ người tạo mới có thể chia sẻ note');
        this.db().transaction(() => {
            this.db().run(`DELETE FROM erp_note_shares WHERE note_id = ?`, [noteId]);
            for (const s of shares) {
                if (!s.employeeId)
                    continue;
                this.db().run(`INSERT OR REPLACE INTO erp_note_shares (note_id, employee_id, permission) VALUES (?,?,?)`, [noteId, s.employeeId, s.permission]);
            }
            this.db().run(`UPDATE erp_notes SET share_scope = ?, updated_at = ? WHERE id = ?`, [scope, now, noteId]);
        });
        // Notify recipients
        for (const s of shares) {
            if (s.employeeId && s.employeeId !== actorId) {
                try {
                    ErpNotificationService_1.default.getInstance().notify(s.employeeId, 'note_shared', `Ghi chú được chia sẻ: ${note.title}`, `Bởi ${actorId} — quyền: ${s.permission}`, `erp://note/${noteId}`, { noteId, permission: s.permission, channels: ['toast'] });
                }
                catch (err) {
                    Logger_1.default.warn(`[ErpNoteService] share notify: ${err.message}`);
                }
            }
        }
        EventBroadcaster_1.default.emit('erp:event:noteShared', {
            noteId,
            scope,
            shares,
            authorId: actorId,
            visibleEmployeeIds: this.getVisibleEmployeeIdsForNote({ ...note, share_scope: scope }),
        });
    }
    /** Returns permission ('read'|'edit'|'owner'|null) the caller has on note. */
    getNotePermission(noteId, employeeId) {
        const note = this.db().queryOne(`SELECT * FROM erp_notes WHERE id = ?`, [noteId]);
        if (!note)
            return null;
        if (note.author_id === employeeId)
            return 'owner';
        if (note.share_scope === 'workspace')
            return 'read';
        const share = this.db().queryOne(`SELECT * FROM erp_note_shares WHERE note_id = ? AND employee_id = ?`, [noteId, employeeId]);
        return share?.permission ?? null;
    }
    // ─── Tags ──────────────────────────────────────────────────────────────────
    listTags() {
        return this.db().query(`SELECT * FROM erp_note_tags ORDER BY name ASC LIMIT 500`);
    }
    createTag(name, color) {
        this.db().run(`INSERT OR IGNORE INTO erp_note_tags (name, color) VALUES (?,?)`, [name, color ?? '#6b7280']);
        // name is UNIQUE → single row
        return this.db().queryOne(`SELECT * FROM erp_note_tags WHERE name = ?`, [name]);
    }
    addTagToNote(noteId, tagId) {
        this.db().run(`INSERT OR IGNORE INTO erp_note_tag_map (note_id, tag_id) VALUES (?,?)`, [noteId, tagId]);
    }
    removeTagFromNote(noteId, tagId) {
        this.db().run(`DELETE FROM erp_note_tag_map WHERE note_id = ? AND tag_id = ?`, [noteId, tagId]);
    }
    // ─── Versions ─────────────────────────────────────────────────────────────
    listVersions(noteId) {
        return this.db().query(`SELECT * FROM erp_note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 20`, [noteId]);
    }
    listVersionsForEmployee(noteId, employeeId) {
        const permission = this.getNotePermission(noteId, employeeId);
        if (!permission || permission === 'read')
            return [];
        return this.listVersions(noteId);
    }
    restoreVersion(versionId, editorId) {
        const version = this.db().queryOne(`SELECT * FROM erp_note_versions WHERE id = ?`, [versionId]);
        if (!version)
            throw new Error('Version not found');
        return this.updateNote(version.note_id, { content: version.content_snapshot }, editorId);
    }
    restoreVersionForEmployee(versionId, editorId) {
        const version = this.db().queryOne(`SELECT * FROM erp_note_versions WHERE id = ?`, [versionId]);
        if (!version)
            throw new Error('Version not found');
        const permission = this.getNotePermission(version.note_id, editorId);
        if (!permission || (permission !== 'owner' && permission !== 'edit')) {
            throw new Error('Bạn không có quyền khôi phục phiên bản của note này');
        }
        return this.restoreVersion(versionId, editorId);
    }
    // ─── Private ───────────────────────────────────────────────────────────────
    _getNoteTags(noteId) {
        return this.db().query(`
      SELECT t.* FROM erp_note_tags t
      JOIN erp_note_tag_map m ON m.tag_id = t.id
      WHERE m.note_id = ?
    `, [noteId]);
    }
    getVisibleEmployeeIdsForNote(note) {
        if (note.share_scope === 'workspace')
            return [];
        const shares = this.listShares(note.id);
        return Array.from(new Set([note.author_id, ...shares.map(share => share.employee_id).filter(Boolean)]));
    }
}
exports.default = ErpNoteService;
//# sourceMappingURL=ErpNoteService.js.map