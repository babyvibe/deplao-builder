import React, { useEffect, useState, useRef } from 'react';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import { ConfirmDialog, ErpModalCard, ErpOverlay, PromptDialog } from '../shared/ErpDialogs';
import { MarkdownRenderer } from '../shared/ErpBadges';
import NoteShareModal from './NoteShareModal';
import NoteVersionHistory from './NoteVersionHistory';
import ipc from '@/lib/ipc';

export default function NotesPage() {
  const { folders, notes, activeNoteId, loadFolders, loadNotes, createNote, updateNote, deleteNote, setActiveNote } = useErpNoteStore();
  const [activeFolderId, setActiveFolderId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorTitle, setEditorTitle] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showNewFolderPrompt, setShowNewFolderPrompt] = useState(false);
  const [folderForm, setFolderForm] = useState({ name: '', parent_id: '' as string });
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<number | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    loadFolders();
    loadNotes({});
  }, []);

  useEffect(() => {
    loadNotes({ folderId: activeFolderId, search: search || undefined });
  }, [activeFolderId, search]);

  const activeNote = notes.find(n => n.id === activeNoteId);

  const folderTree = buildFolderTree(folders);

  useEffect(() => {
    if (activeNote) {
      setEditorContent(activeNote.content);
      setEditorTitle(activeNote.title);
    }
  }, [activeNoteId]);

  const scheduleAutoSave = (field: 'title' | 'content', value: string) => {
    if (!activeNoteId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateNote(activeNoteId, { [field]: value });
    }, 1000);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Folder tree */}
      <div className="w-44 border-r border-gray-700/60 flex flex-col bg-gray-900/50 flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-700/40">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Thư mục</p>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => setActiveFolderId(undefined)}
            className={`w-full text-left px-3 py-2 text-xs transition-colors ${activeFolderId === undefined ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-300'}`}
          >
            📝 Tất cả note
          </button>
          {folderTree.map(folder => (
            <FolderNode
              key={folder.id}
              folder={folder}
              activeFolderId={activeFolderId}
              onSelect={setActiveFolderId}
              onRename={(id, name) => setRenameFolderTarget({ id, name })}
              onDelete={(id) => setFolderDeleteTarget(id)}
            />
          ))}
          <button
            onClick={() => { setFolderForm({ name: '', parent_id: activeFolderId ? String(activeFolderId) : '' }); setShowNewFolderPrompt(true); }}
            className="w-full text-left px-3 py-2 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-700/30"
          >
            + Thư mục
          </button>
        </div>
      </div>

      {/* Note list */}
      <div className="w-56 border-r border-gray-700/60 flex flex-col bg-gray-800/30 flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-700/40 space-y-1.5">
          <input
            placeholder="Tìm note..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-700/60 border border-gray-600/60 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={async () => {
              const note = await createNote({ title: 'Note mới', content: '', folder_id: activeFolderId });
              if (note) setActiveNote(note.id);
            }}
            className="w-full py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg"
          >
            + Note mới
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {notes.map(note => (
            <button
              key={note.id}
              onClick={() => setActiveNote(note.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-gray-700/30 transition-colors group ${
                activeNoteId === note.id ? 'bg-blue-600/15 border-l-2 border-l-blue-500' : 'hover:bg-gray-700/30'
              }`}
            >
              <p className="text-xs font-medium text-gray-200 truncate">{note.pinned ? '📌 ' : ''}{note.title}</p>
              <p className="text-[10px] text-gray-500 mt-0.5 truncate">{note.content.slice(0, 50)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">
                {new Date(note.updated_at).toLocaleDateString('vi-VN')}
              </p>
            </button>
          ))}
          {notes.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-gray-600">
              <span className="text-2xl mb-1">📝</span>
              <p className="text-xs">Chưa có note nào</p>
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeNote ? (
          <>
            <div className="px-6 py-3 border-b border-gray-700/60 flex items-center gap-3 flex-shrink-0">
              <input
                value={editorTitle}
                onChange={e => { setEditorTitle(e.target.value); scheduleAutoSave('title', e.target.value); }}
                className="flex-1 bg-transparent text-lg font-bold text-white focus:outline-none placeholder-gray-500"
                placeholder="Tiêu đề..."
              />
              <button
                onClick={() => setPreview(p => !p)}
                className={`text-xs px-2 py-1 rounded ${preview ? 'bg-blue-600/30 text-blue-300' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'}`}
                title={preview ? 'Chuyển sang chỉnh sửa' : 'Xem preview markdown'}
              >
                {preview ? '✏️ Sửa' : '👁 Preview'}
              </button>
              <button
                onClick={() => setShowShare(true)}
                className="text-gray-500 hover:text-blue-400 text-xs px-2 py-1 rounded hover:bg-gray-700/50"
                title="Chia sẻ"
              >
                🔗 Chia sẻ
              </button>
              <button
                onClick={() => setShowHistory(true)}
                className="text-gray-500 hover:text-purple-400 text-xs px-2 py-1 rounded hover:bg-gray-700/50"
                title="Lịch sử phiên bản"
              >
                🕒 Lịch sử
              </button>
              <button
                onClick={() => setDeleteNoteTarget(activeNote.id)}
                className="text-gray-600 hover:text-red-400 text-xs p-1 rounded"
                title="Xoá note"
              >
                Xóa
              </button>
            </div>
            {preview ? (
              <div className="flex-1 overflow-auto px-6 py-4">
                <MarkdownRenderer source={editorContent} />
              </div>
            ) : (
              <textarea
                value={editorContent}
                onChange={e => { setEditorContent(e.target.value); scheduleAutoSave('content', e.target.value); }}
                placeholder="Nhập nội dung note (Markdown)..."
                className="flex-1 resize-none bg-transparent text-sm text-gray-300 px-6 py-4 focus:outline-none leading-relaxed font-mono placeholder-gray-600"
              />
            )}
            <div className="px-6 py-1.5 border-t border-gray-700/40 flex-shrink-0">
              <p className="text-[10px] text-gray-600">
                {editorContent.length} ký tự · Cập nhật {new Date(activeNote.updated_at).toLocaleString('vi-VN')} · Tự lưu
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
            <span className="text-4xl mb-3">📓</span>
            <p className="text-sm">Chọn một note để xem / chỉnh sửa</p>
            <p className="text-xs mt-1">hoặc tạo note mới từ danh sách bên trái</p>
          </div>
        )}
      </div>
      {/* Dialogs */}
      {showNewFolderPrompt && (
        <ErpOverlay onClose={() => setShowNewFolderPrompt(false)}>
          <ErpModalCard className="w-80 p-5">
            <p className="text-sm font-semibold text-white mb-3">Tạo thư mục</p>
            <div className="space-y-3">
              <input
                value={folderForm.name}
                onChange={e => setFolderForm(v => ({ ...v, name: e.target.value }))}
                placeholder="Nhập tên thư mục..."
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <select
                value={folderForm.parent_id}
                onChange={e => setFolderForm(v => ({ ...v, parent_id: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200"
              >
                <option value="">Thư mục gốc</option>
                {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowNewFolderPrompt(false)} className="px-4 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors">Huỷ</button>
              <button
                onClick={async () => {
                  await ipc.erp?.noteCreateFolder({ name: folderForm.name.trim(), parent_id: folderForm.parent_id ? Number(folderForm.parent_id) : undefined });
                  await loadFolders();
                  setShowNewFolderPrompt(false);
                }}
                disabled={!folderForm.name.trim()}
                className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                Tạo
              </button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}
      {renameFolderTarget && (
        <PromptDialog
          title="Đổi tên thư mục"
          defaultValue={renameFolderTarget.name}
          placeholder="Tên thư mục mới..."
          onConfirm={async (name) => {
            await ipc.erp?.noteRenameFolder?.({ id: renameFolderTarget.id, name });
            await loadFolders();
            setRenameFolderTarget(null);
          }}
          onCancel={() => setRenameFolderTarget(null)}
        />
      )}
      {folderDeleteTarget !== null && (
        <ConfirmDialog
          message="Xóa thư mục này? Các note sẽ được chuyển về thư mục gốc."
          onConfirm={async () => {
            await ipc.erp?.noteDeleteFolder?.({ id: folderDeleteTarget });
            if (activeFolderId === folderDeleteTarget) setActiveFolderId(undefined);
            await loadFolders();
            await loadNotes({ folderId: activeFolderId, search: search || undefined });
            setFolderDeleteTarget(null);
          }}
          onCancel={() => setFolderDeleteTarget(null)}
        />
      )}
      {deleteNoteTarget && (
        <ConfirmDialog
          message="Xoá note này? Hành động không thể hoàn tác."
          onConfirm={async () => { await deleteNote(deleteNoteTarget); setDeleteNoteTarget(null); }}
          onCancel={() => setDeleteNoteTarget(null)}
        />
      )}
      {showShare && activeNote && (
        <NoteShareModal
          note={activeNote}
          onClose={() => setShowShare(false)}
        />
      )}
      {showHistory && activeNote && (
        <NoteVersionHistory
          note={activeNote}
          onClose={() => setShowHistory(false)}
          onRestored={(n) => { setEditorContent(n.content); setEditorTitle(n.title); loadNotes({ folderId: activeFolderId, search: search || undefined }); }}
        />
      )}
    </div>
  );
}

function buildFolderTree(folders: any[], parentId?: number, trail = new Set<number>()) {
  return folders
    .filter(folder => folder && typeof folder.id === 'number' && Number.isFinite(folder.id))
    .filter(folder => (folder.parent_id ?? undefined) === parentId)
    .filter((folder, index, arr) => arr.findIndex(item => item.id === folder.id) === index)
    .map(folder => {
      if (trail.has(folder.id)) {
        return { ...folder, children: [] };
      }
      const nextTrail = new Set(trail);
      nextTrail.add(folder.id);
      return { ...folder, children: buildFolderTree(folders, folder.id, nextTrail) };
    });
}

function FolderNode({ folder, activeFolderId, onSelect, onRename, onDelete, level = 0 }: any) {
  return (
    <div>
      <div
        className={`group flex items-center gap-2 px-2 py-1 text-xs ${activeFolderId === folder.id ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-300'}`}
        style={{ paddingLeft: 12 + level * 14 }}
      >
        <button
          type="button"
          onClick={() => onSelect(folder.id)}
          className="flex-1 text-left truncate py-1.5 min-w-0"
          title={folder.name}
        >
          📁 {folder.name}
        </button>
        <div className="flex items-center gap-1 flex-shrink-0 pl-1 border-l border-transparent group-hover:border-gray-700/60">
          <button type="button" onClick={(e) => {
            e.stopPropagation();
            onRename(folder.id, folder.name);
          }} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-[11px] text-blue-400 hover:text-blue-300 hover:bg-gray-700/70" title="Đổi tên thư mục">✏️</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(folder.id); }} className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-[11px] text-red-400 hover:text-red-300 hover:bg-gray-700/70" title="Xóa thư mục">🗑</button>
        </div>
      </div>
      {folder.children?.map((child: any) => (
        <FolderNode key={child.id} folder={child} activeFolderId={activeFolderId} onSelect={onSelect} onRename={onRename} onDelete={onDelete} level={level + 1} />
      ))}
    </div>
  );
}

