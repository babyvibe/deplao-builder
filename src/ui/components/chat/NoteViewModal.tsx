import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { CloudIcon, HardDriveIcon } from '@/components/common/icons';
import { CHANNEL, isZalo } from '@/lib/channelHelper';
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
  const { getActiveAccount, accounts, activeAccountId } = useAccountStore();
  const zaloId = activeAccountIdProp || activeAccountId || '';
  const activeAccount = accounts.find(account => account.zalo_id === zaloId);
  // Zalo group notes have no Telegram equivalent. On a standalone Telegram
  // group, open the internal note tab directly and do not expose Zalo actions.
  const showZaloTab = !!isGroupProp && isZalo(activeAccount?.channel);
  const [activeTab, setActiveTab] = React.useState<'zalo' | 'local'>(showZaloTab ? 'zalo' : 'local');

  React.useEffect(() => {
    if (!showZaloTab && activeTab !== 'local') setActiveTab('local');
  }, [showZaloTab, activeTab]);

  // ── Local notes state ──
  const [localNotes, setLocalNotes] = React.useState<any[]>([]);
  const [localNoteLoading, setLocalNoteLoading] = React.useState(false);
  const [newNoteText, setNewNoteText] = React.useState('');
  const [editNoteId, setEditNoteId] = React.useState<number | null>(null);
  const [editNoteText, setEditNoteText] = React.useState('');
  const [savingLocal, setSavingLocal] = React.useState(false);

  // Load local notes when tab = 'local'
  React.useEffect(() => {
    if (activeTab !== 'local' || !zaloId || !groupId) return;
    setLocalNoteLoading(true);
    // DataAccessor: chế độ nhân viên đọc ghi chú từ Boss (IPC crm:getNotes trả stub rỗng); lỗi giữ danh sách cũ
    DataAccessor.getCRMNotes({ zaloId, contactId: groupId })
      .then((res: any) => { if (!isReadFailure(res)) setLocalNotes(res?.notes || []); })
      .catch(() => {})
      .finally(() => setLocalNoteLoading(false));
  }, [activeTab, zaloId, groupId]);

  const handleAddLocalNote = async () => {
    if (!newNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      // Ghi qua DataAccessor (nhân viên: REST → Boss, một lần — IPC cũ proxy hai lần → Boss tạo 2 ghi chú)
      const res: any = await DataAccessor.saveCRMNote({ zaloId, note: { contact_id: groupId, content: newNoteText.trim() } });
      if (res?.success) {
        setNewNoteText('');
        const reload = await DataAccessor.getCRMNotes({ zaloId, contactId: groupId });
        if (!isReadFailure(reload)) setLocalNotes(reload?.notes || []);
        showNotification('Đã thêm ghi chú', 'success');
      } else {
        showNotification('Không lưu được ghi chú: ' + (res?.error || ''), 'error');
      }
    } catch {} finally { setSavingLocal(false); }
  };

  const handleEditLocalNote = async (note: any) => {
    if (!editNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      const res: any = await DataAccessor.saveCRMNote({ zaloId, note: { id: note.id, contact_id: groupId, content: editNoteText.trim() } });
      if (res?.success === false) {
        showNotification('Không cập nhật được ghi chú: ' + (res.error || ''), 'error');
        return;
      }
      setEditNoteId(null);
      const reload = await DataAccessor.getCRMNotes({ zaloId, contactId: groupId });
      if (!isReadFailure(reload)) setLocalNotes(reload?.notes || []);
      showNotification('Đã cập nhật ghi chú', 'success');
    } catch {} finally { setSavingLocal(false); }
  };

  const handleDeleteLocalNote = async (noteId: number) => {
    if (!zaloId) return;
    const res: any = await DataAccessor.deleteCRMNote({ zaloId, noteId });
    if (res?.success === false) {
      showNotification('Không xóa được ghi chú: ' + (res.error || ''), 'error');
      return;
    }
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
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <span className="font-semibold text-foreground text-base">Ghi chú</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Tabs: only show if group has Zalo notes */}
        {showZaloTab && (
          <div className="flex border-b border-border flex-shrink-0 px-4 pt-2 gap-1">
            <button onClick={() => setActiveTab('zalo')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === CHANNEL.ZALO ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
              <CloudIcon className="w-4 h-4 inline" /> Zalo
            </button>
            <button onClick={() => setActiveTab('local')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === 'local' ? 'bg-green-600 text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}><HardDriveIcon className="w-4 h-4 inline" /> Local
            </button>
          </div>
        )}

        {/* ── Zalo tab ── */}
        {activeTab === CHANNEL.ZALO && (
          <>
            {mode === 'view' ? (
              <>
                <div className="px-5 py-5 min-h-[120px] overflow-y-auto">
                  {(creatorName || createTime) && (
                    <p className="text-xs text-muted-foreground text-center mb-4">
                      {creatorName ? `Tạo bởi ${creatorName}` : 'Ghi chú'}
                      {createTime ? ` - ${formatNoteTime(createTime)}` : ''}
                    </p>
                  )}
                  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{title || <span className="text-muted-foreground italic">Không có nội dung</span>}</p>
                </div>
                <div className="flex items-center gap-3 px-5 pb-5 pt-2 border-t border-border/50 flex-shrink-0">
                  <button onClick={() => { navigator.clipboard.writeText(title).catch(() => {}); showNotification('Đã sao chép', 'success'); }}
                    className="w-10 h-10 rounded-xl bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" title="Sao chép">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                  <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-muted hover:bg-accent text-sm text-foreground font-medium transition-colors">Đóng</button>
                  <button onClick={() => setMode('edit')} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm text-white font-semibold transition-colors">Chỉnh sửa</button>
                </div>
              </>
            ) : (
              <>
                <div className="px-5 py-4 space-y-4 overflow-y-auto">
                  <div>
                    <label className="text-xs text-muted-foreground font-medium block mb-1.5">Nội dung ghi chú</label>
                    <textarea autoFocus value={title} onChange={e => { setTitle(e.target.value); setError(''); }}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave(); }}
                      placeholder="Nhập nội dung ghi chú..." rows={4}
                      className="w-full bg-muted border border-input focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none resize-none transition-colors" />
                    {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
                  </div>
                  <div className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-xl">
                    <div>
                      <p className="text-sm text-foreground font-medium">Ghim ghi chú</p>
                      <p className="text-xs text-muted-foreground">Hiển thị ở đầu hội thoại</p>
                    </div>
                    <button type="button" onClick={() => setPinAct(v => !v)}
                      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${pinAct ? 'bg-blue-500' : 'bg-accent'}`}>
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${pinAct ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                </div>
                <div className="flex gap-3 px-5 pb-5 pt-1 flex-shrink-0">
                  <button onClick={() => isEdit ? setMode('view') : onClose()} className="flex-1 py-2.5 rounded-xl bg-muted hover:bg-accent text-sm text-foreground/80 transition-colors">Huỷ</button>
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
                <p className="text-xs text-muted-foreground text-center py-4">Chưa có ghi chú local nào</p>
              ) : localNotes.map((note: any) => (
                <div key={note.id} className="bg-muted/50 border border-input/50 rounded-xl p-3 group">
                  {editNoteId === note.id ? (
                    <div className="space-y-2">
                      <textarea autoFocus value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={3}
                        className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500 resize-none" />
                      <div className="flex gap-2">
                        <button onClick={() => setEditNoteId(null)} className="flex-1 py-1.5 rounded-lg bg-accent text-xs text-foreground/80 hover:bg-accent transition-colors">Huỷ</button>
                        <button onClick={() => handleEditLocalNote(note)} disabled={savingLocal} className="flex-1 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">Lưu</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{note.content}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[11px] text-muted-foreground">{formatNoteTime(note.updated_at)}</span>
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
            <div className="px-4 pb-4 pt-2 border-t border-border/50 flex-shrink-0 space-y-2">
              <textarea value={newNoteText} onChange={e => setNewNoteText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddLocalNote(); }}
                placeholder="Thêm ghi chú local... (Ctrl+Enter để lưu)" rows={2}
                className="w-full bg-muted border border-input focus:border-green-500 rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none resize-none transition-colors" />
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
