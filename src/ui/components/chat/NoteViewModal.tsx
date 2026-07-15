import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { CloudIcon, HardDriveIcon } from '@/components/common/icons';
import type { PinnedNote } from './PinnedMessages';

// ─── NoteViewModal ────────────────────────────────────────────────────────────
export function NoteViewModal({ topicId, initialTitle, groupId, onClose, onNotePinned, creatorName, createTime, isGroup: isGroupProp, activeAccountId: activeAccountIdProp }: {
  topicId?: string;
  initialTitle: string;
  groupId: string;
  onClose: () => void;
  onNotePinned?: (note: PinnedNote) => void;
  creatorName?: string;
  createTime?: number;
  isGroup?: boolean;
  activeAccountId?: string;
}) {
  // Tab: 'zalo' only available for group conversations
  const showZaloTab = !!isGroupProp;
  const [activeTab, setActiveTab] = React.useState<'zalo' | 'local'>(showZaloTab ? 'zalo' : 'local');

  // ── Local notes state ──
  const [localNotes, setLocalNotes] = React.useState<any[]>([]);
  const [localNoteLoading, setLocalNoteLoading] = React.useState(false);
  const [newNoteText, setNewNoteText] = React.useState('');
  const [editNoteId, setEditNoteId] = React.useState<number | null>(null);
  const [editNoteText, setEditNoteText] = React.useState('');
  const [savingLocal, setSavingLocal] = React.useState(false);
  const zaloId = activeAccountIdProp || useAccountStore.getState().activeAccountId || '';

  // Load local notes when tab = 'local'
  React.useEffect(() => {
    if (activeTab !== 'local' || !zaloId || !groupId) return;
    setLocalNoteLoading(true);
    ipc.crm?.getNotes({ zaloId, contactId: groupId })
      .then((res: any) => setLocalNotes(res?.notes || []))
      .catch(() => {})
      .finally(() => setLocalNoteLoading(false));
  }, [activeTab, zaloId, groupId]);

  const handleAddLocalNote = async () => {
    if (!newNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      const res = await ipc.crm?.saveNote({ zaloId, note: { contact_id: groupId, content: newNoteText.trim() } });
      if (res?.success) {
        setNewNoteText('');
        const reload = await ipc.crm?.getNotes({ zaloId, contactId: groupId });
        setLocalNotes(reload?.notes || []);
        showNotification('Đã thêm ghi chú', 'success');
      }
    } catch {} finally { setSavingLocal(false); }
  };

  const handleEditLocalNote = async (note: any) => {
    if (!editNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      await ipc.crm?.saveNote({ zaloId, note: { id: note.id, contact_id: groupId, content: editNoteText.trim() } });
      setEditNoteId(null);
      const reload = await ipc.crm?.getNotes({ zaloId, contactId: groupId });
      setLocalNotes(reload?.notes || []);
      showNotification('Đã cập nhật ghi chú', 'success');
    } catch {} finally { setSavingLocal(false); }
  };

  const handleDeleteLocalNote = async (noteId: number) => {
    if (!zaloId) return;
    await ipc.crm?.deleteNote({ zaloId, noteId });
    setLocalNotes(prev => prev.filter((n: any) => n.id !== noteId));
    showNotification('Đã xóa ghi chú', 'success');
  };

  // 'view' mode when opening an existing note, 'edit' mode when creating or editing
  const [mode, setMode] = React.useState<'view' | 'edit'>(topicId ? 'view' : 'edit');
  const [title, setTitle] = React.useState(initialTitle);
  const [pinAct, setPinAct] = React.useState(!!topicId);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const { showNotification } = useAppStore();
  const { getActiveAccount } = useAccountStore();
  const isEdit = !!topicId;

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc, activeAccountIdProp);
  };

  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) { setError('Tiêu đề không được để trống'); return; }
    const auth = getAuth();
    if (!auth) return;
    setSaving(true);
    setError('');
    try {
      let res: any;
      if (isEdit && topicId) {
        res = await ipc.zalo?.editNote({ auth, groupId, topicId, title: trimmed, pinAct });
      } else {
        res = await ipc.zalo?.createNote({ auth, groupId, title: trimmed, pinAct });
      }
      if (res?.success === false) {
        setError(res.error || 'Thao tác thất bại');
        return;
      }
      if (pinAct && onNotePinned) {
        const noteId = res?.response?.id || res?.response?.topicId || topicId || String(Date.now());
        onNotePinned({
          topicId: String(noteId),
          title: trimmed,
          creatorId: '',
          createTime: Date.now(),
          editTime: Date.now(),
        });
      }
      showNotification(isEdit ? 'Đã cập nhật ghi chú' : 'Đã tạo ghi chú', 'success');
      onClose();
    } catch (e: any) {
      setError(e.message || 'Lỗi không xác định');
    } finally {
      setSaving(false);
    }
  };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // ── Format create time ──
  const formatNoteTime = (ts?: number): string => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return isToday ? `${hm} Hôm nay` : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` ${hm}`;
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <span className="font-semibold text-white text-base">Ghi chú</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-700">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Tabs: only show if group has Zalo notes */}
        {showZaloTab && (
          <div className="flex border-b border-gray-700 flex-shrink-0 px-4 pt-2 gap-1">
            <button onClick={() => setActiveTab('zalo')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'}`}>
              <CloudIcon className="w-4 h-4 inline" /> Zalo
            </button>
            <button onClick={() => setActiveTab('local')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === 'local' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'}`}><HardDriveIcon className="w-4 h-4 inline" /> Local
            </button>
          </div>
        )}

        {/* ── Zalo tab ── */}
        {activeTab === 'zalo' && (
          <>
            {mode === 'view' ? (
              <>
                <div className="px-5 py-5 min-h-[120px] overflow-y-auto">
                  {(creatorName || createTime) && (
                    <p className="text-xs text-gray-400 text-center mb-4">
                      {creatorName ? `Tạo bởi ${creatorName}` : 'Ghi chú'}
                      {createTime ? ` - ${formatNoteTime(createTime)}` : ''}
                    </p>
                  )}
                  <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">{title || <span className="text-gray-400 italic">Không có nội dung</span>}</p>
                </div>
                <div className="flex items-center gap-3 px-5 pb-5 pt-2 border-t border-gray-700/50 flex-shrink-0">
                  <button onClick={() => { navigator.clipboard.writeText(title).catch(() => {}); showNotification('Đã sao chép', 'success'); }}
                    className="w-10 h-10 rounded-xl bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors flex-shrink-0" title="Sao chép">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                  <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-200 font-medium transition-colors">Đóng</button>
                  <button onClick={() => setMode('edit')} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm text-white font-semibold transition-colors">Chỉnh sửa</button>
                </div>
              </>
            ) : (
              <>
                <div className="px-5 py-4 space-y-4 overflow-y-auto">
                  <div>
                    <label className="text-xs text-gray-400 font-medium block mb-1.5">Nội dung ghi chú</label>
                    <textarea autoFocus value={title} onChange={e => { setTitle(e.target.value); setError(''); }}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave(); }}
                      placeholder="Nhập nội dung ghi chú..." rows={4}
                      className="w-full bg-gray-700 border border-gray-600 focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors" />
                    {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
                  </div>
                  <div className="flex items-center justify-between py-2 px-3 bg-gray-700/50 rounded-xl">
                    <div>
                      <p className="text-sm text-gray-200 font-medium">Ghim ghi chú</p>
                      <p className="text-xs text-gray-400">Hiển thị ở đầu hội thoại</p>
                    </div>
                    <button type="button" onClick={() => setPinAct(v => !v)}
                      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${pinAct ? 'bg-blue-500' : 'bg-gray-600'}`}>
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${pinAct ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                </div>
                <div className="flex gap-3 px-5 pb-5 pt-1 flex-shrink-0">
                  <button onClick={() => isEdit ? setMode('view') : onClose()} className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition-colors">Huỷ</button>
                  <button onClick={handleSave} disabled={saving || !title.trim()}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2">
                    {saving && <Spinner size={4} />}
                    {isEdit ? 'Lưu thay đổi' : 'Tạo ghi chú'}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* ── Local tab ── */}
        {activeTab === 'local' && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {localNoteLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Spinner size={5} className="text-green-400" />
                </div>
              ) : localNotes.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">Chưa có ghi chú local nào</p>
              ) : localNotes.map((note: any) => (
                <div key={note.id} className="bg-gray-700/50 border border-gray-600/50 rounded-xl p-3 group">
                  {editNoteId === note.id ? (
                    <div className="space-y-2">
                      <textarea autoFocus value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={3}
                        className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none" />
                      <div className="flex gap-2">
                        <button onClick={() => setEditNoteId(null)} className="flex-1 py-1.5 rounded-lg bg-gray-600 text-xs text-gray-300 hover:bg-gray-500 transition-colors">Huỷ</button>
                        <button onClick={() => handleEditLocalNote(note)} disabled={savingLocal} className="flex-1 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">Lưu</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{note.content}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[11px] text-gray-400">{formatNoteTime(note.updated_at)}</span>
                        <div className="opacity-0 group-hover:opacity-100 flex gap-3 transition-opacity">
                          <button onClick={() => { setEditNoteId(note.id); setEditNoteText(note.content); }} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">Sửa</button>
                          <button onClick={() => handleDeleteLocalNote(note.id)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Xóa</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="px-4 pb-4 pt-2 border-t border-gray-700/50 flex-shrink-0 space-y-2">
              <textarea value={newNoteText} onChange={e => setNewNoteText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddLocalNote(); }}
                placeholder="Thêm ghi chú local... (Ctrl+Enter để lưu)" rows={2}
                className="w-full bg-gray-700 border border-gray-600 focus:border-green-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors" />
              <button onClick={handleAddLocalNote} disabled={savingLocal || !newNoteText.trim()}
                className="w-full py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors">
                Lưu ghi chú
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
