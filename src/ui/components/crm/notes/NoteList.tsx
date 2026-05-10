import React, { useState } from 'react';
import type { CRMNote } from '@/store/crmStore';

interface NoteListProps {
  notes: CRMNote[];
  onSave: (content: string, id?: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export default function NoteList({ notes, onSave, onDelete }: NoteListProps) {
  const [newText, setNewText] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newText.trim()) return;
    setSaving(true);
    await onSave(newText.trim());
    setNewText('');
    setSaving(false);
  };

  const handleEdit = async (note: CRMNote) => {
    if (!editText.trim()) return;
    setSaving(true);
    await onSave(editText.trim(), note.id);
    setEditId(null);
    setSaving(false);
  };

  const fmt = (ts: number) => ts ? new Date(ts).toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

  return (
    <div className="space-y-2">
      {/* Add note */}
      <div className="flex gap-2">
        <textarea value={newText} onChange={e => setNewText(e.target.value)}
          placeholder="Thêm ghi chú..."
          rows={2}
          className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none" />
        <button onClick={handleAdd} disabled={saving || !newText.trim()}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs disabled:opacity-40 self-end">
          Lưu
        </button>
      </div>

      {/* List */}
      {notes.map(note => (
        <div key={note.id} className="bg-gray-700/50 border border-gray-600 rounded-lg p-2.5 group">
          {editId === note.id ? (
            <div className="space-y-1.5">
              <textarea value={editText} onChange={e => setEditText(e.target.value)}
                rows={3} autoFocus
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 resize-none" />
              <div className="flex gap-1.5">
                <button onClick={() => setEditId(null)} className="flex-1 py-1 rounded bg-gray-600 text-xs text-gray-300 hover:bg-gray-500">Hủy</button>
                <button onClick={() => handleEdit(note)} disabled={saving} className="flex-1 py-1 rounded bg-blue-600 text-xs text-white hover:bg-blue-700 disabled:opacity-50">Lưu</button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-200 whitespace-pre-wrap">{note.content}</p>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] text-gray-500">{fmt(note.updated_at)}</span>
                <div className="opacity-0 group-hover:opacity-100 flex gap-2 transition-opacity">
                  <button onClick={() => { setEditId(note.id); setEditText(note.content); }}
                    className="text-[11px] text-blue-400 hover:text-blue-300">Sửa</button>
                  <button onClick={() => onDelete(note.id)}
                    className="text-[11px] text-red-400 hover:text-red-300">Xóa</button>
                </div>
              </div>
            </>
          )}
        </div>
      ))}

      {notes.length === 0 && <p className="text-xs text-gray-500 text-center py-2">Chưa có ghi chú nào</p>}
    </div>
  );
}

