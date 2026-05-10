import React, { useEffect, useState, useCallback } from 'react';
import type { CRMContact, CRMNote } from '@/store/crmStore';
import type { LabelData } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ZaloLabelSelector from '../tags/ZaloLabelSelector';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import LocalLabelSelector from '@/components/common/LocalLabelSelector';
import type { LocalLabelItem } from '@/components/common/LocalLabelSelector';
import NoteList from '../notes/NoteList';
import PhoneDisplay from '@/components/common/PhoneDisplay';
import type { PinnedNote } from '@/components/chat/PinnedMessages';

interface CRMContactDetailPanelProps {
  contact: CRMContact;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  onClose: () => void;
  onMessage: (contact: CRMContact) => void;
}

type DetailTab = 'info' | 'history';

export default function CRMContactDetailPanel({ contact, allLabels, localLabels, localLabelThreadMap, onClose, onMessage }: CRMContactDetailPanelProps) {
  const { activeAccountId } = useAccountStore();
  const { showNotification, setLabels } = useAppStore();
  const [detailTab, setDetailTab] = useState<DetailTab>('info');
  const [notes, setNotes] = useState<CRMNote[]>([]);
  const [zaloNotes, setZaloNotes] = useState<PinnedNote[]>([]);
  const [noteTab, setNoteTab] = useState<'local' | 'zalo'>('local');
  const [sendLog, setSendLog] = useState<any[]>([]);

  const isGroup = contact.contact_type === 'group';

  // Derive current labels for this contact (groups use 'g' prefix in Zalo conversations)
  const getLabelThreadId = (cId: string, isGroup: boolean) => isGroup ? `g${cId}` : cId;
  const getContactLabelIds = () => {
    const isGroup = contact.contact_type === 'group';
    const prefixed = getLabelThreadId(contact.contact_id, isGroup);
    return allLabels.filter(l =>
      l.conversations?.includes(contact.contact_id) || l.conversations?.includes(prefixed)
    ).map(l => l.id);
  };

  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>(getContactLabelIds);
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);

  // ─── Local labels for this contact ──────────────────────────────────────
  const threadLocalLabelIds = localLabelThreadMap?.[contact.contact_id] || [];
  const [localLabelToggling, setLocalLabelToggling] = useState<number | null>(null);

  const handleToggleLocalLabel = useCallback(async (labelId: number) => {
    if (!activeAccountId || localLabelToggling !== null) return;
    const label = localLabels?.find(l => l.id === labelId);
    if (!label) return;
    const exists = threadLocalLabelIds.includes(labelId);
    setLocalLabelToggling(labelId);
    try {
      const threadType = contact.contact_type === 'group' ? 1 : 0;
      if (exists) {
        await ipc.db?.removeLocalLabelFromThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id, threadType, labelText: label.name || '', labelColor: label.color || '', labelEmoji: label.emoji || '' });
      } else {
        await ipc.db?.assignLocalLabelToThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id, threadType, labelText: label.name || '', labelColor: label.color || '', labelEmoji: label.emoji || '' });
      }
      showNotification(exists ? `Đã gỡ nhãn "${label.name}"` : `Đã gắn nhãn "${label.name}"`, 'success');
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
    } catch {
      showNotification('Không thể cập nhật nhãn', 'error');
    } finally {
      setLocalLabelToggling(null);
    }
  }, [activeAccountId, contact.contact_id, contact.contact_type, localLabelToggling, threadLocalLabelIds, localLabels, showNotification]);

  /** Called from LocalLabelSelector — diff to find which label was toggled */
  const handleLocalLabelChange = useCallback((newIds: number[]) => {
    const added = newIds.find(id => !threadLocalLabelIds.includes(id));
    const removed = threadLocalLabelIds.find(id => !newIds.includes(id));
    const toggleId = added ?? removed;
    if (toggleId != null) handleToggleLocalLabel(toggleId);
  }, [threadLocalLabelIds, handleToggleLocalLabel]);

  // Re-sync when contact or allLabels change
  useEffect(() => {
    setSelectedLabelIds(getContactLabelIds());
    setLabelsDirty(false);
  }, [contact.contact_id, allLabels]);

  useEffect(() => {
    if (detailTab === 'info' && activeAccountId) {
      loadNotes();
      if (isGroup) loadZaloNotes();
    }
    if (detailTab === 'history' && activeAccountId) loadHistory();
  }, [detailTab, contact.contact_id]);

  const loadNotes = async () => {
    if (!activeAccountId) return;
    const res = await ipc.crm?.getNotes({ zaloId: activeAccountId, contactId: contact.contact_id });
    if (res?.success) setNotes(res.notes);
  };

  const loadZaloNotes = async () => {
    if (!activeAccountId) return;
    try {
      const res = await ipc.db?.getPinnedMessages({ zaloId: activeAccountId, threadId: contact.contact_id });
      const notePins: PinnedNote[] = (res?.pins ?? [])
        .filter((p: any) => p.msg_type === 'note')
        .map((p: any) => {
          try {
            const c = JSON.parse(p.content ?? '{}');
            return {
              topicId: c.topicId ?? p.msg_id.replace('note_', ''),
              title: c.title ?? p.preview_text ?? p.msg_id,
              creatorId: c.creatorId ?? p.sender_id ?? '',
              creatorName: p.sender_name ?? '',
              createTime: c.createTime ?? p.timestamp ?? 0,
              editTime: c.editTime ?? p.pinned_at ?? 0,
            } as PinnedNote;
          } catch { return null; }
        })
        .filter(Boolean) as PinnedNote[];
      setZaloNotes(notePins);
    } catch { setZaloNotes([]); }
  };

  const loadHistory = async () => {
    if (!activeAccountId) return;
    const res = await ipc.crm?.getSendLog({ zaloId: activeAccountId, opts: { contactId: contact.contact_id, limit: 50 } });
    if (res?.success) setSendLog(res.logs);
  };

  const handleSaveLabels = async () => {
    if (!activeAccountId) return;
    setSavingLabels(true);
    try {
      const acc = useAccountStore.getState().getActiveAccount();
      if (!acc) throw new Error('No account');
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };

      // Fetch fresh labels to avoid version mismatch
      const freshRes = await ipc.zalo?.getLabels({ auth });
      const freshLabels: LabelData[] = freshRes?.response?.labelData || allLabels;
      const version: number = freshRes?.response?.version || 0;

      const contactId = contact.contact_id;
      const isGroup = contact.contact_type === 'group';
      const labelThreadId = getLabelThreadId(contactId, isGroup);

      // Build updated label list: add/remove contactId from each label's conversations
      const updated = freshLabels.map(label => {
        const shouldHave = selectedLabelIds.includes(label.id);
        // Check both plain ID and g-prefixed ID for groups
        const has = label.conversations?.includes(labelThreadId) || label.conversations?.includes(contactId);
        if (shouldHave && !has) {
          return { ...label, conversations: [...(label.conversations || []), labelThreadId] };
        } else if (!shouldHave && has) {
          return { ...label, conversations: label.conversations.filter((id: string) => id !== labelThreadId && id !== contactId) };
        }
        return label;
      });

      const res = await ipc.zalo?.updateLabels({ auth, labelData: updated, version });
      if (res?.success) {
        const finalLabels: LabelData[] = res.response?.labelData || updated;
        setLabels(activeAccountId, finalLabels);
        setLabelsDirty(false);
        showNotification('Đã cập nhật nhãn', 'success');
        // Note: Workflow events are now emitted by backend (zaloIpc.ts) to avoid duplicates
      } else {
        throw new Error(res?.error || 'Không thể cập nhật nhãn');
      }
    } catch (err: any) {
      showNotification('Lỗi: ' + (err?.message || 'Không rõ'), 'error');
    }
    setSavingLabels(false);
  };

  const handleSaveNote = async (content: string, id?: number) => {
    if (!activeAccountId) return;
    await ipc.crm?.saveNote({ zaloId: activeAccountId, note: { id, contact_id: contact.contact_id, content } });
    await loadNotes();
  };

  const handleDeleteNote = async (noteId: number) => {
    if (!activeAccountId) return;
    await ipc.crm?.deleteNote({ zaloId: activeAccountId, noteId });
    setNotes(prev => prev.filter(n => n.id !== noteId));
  };

  const name = contact.alias || contact.display_name || contact.contact_id;
  const fmt = (ts: number) => ts ? new Date(ts).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';

  const currentContactLabels = allLabels.filter(l => {
    const isGroup = contact.contact_type === 'group';
    const prefixed = getLabelThreadId(contact.contact_id, isGroup);
    return l.conversations?.includes(contact.contact_id) || l.conversations?.includes(prefixed);
  });

  return (
    <div className="w-80 flex-shrink-0 flex flex-col bg-gray-850 border-l border-gray-700 h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <span className="text-sm font-semibold text-white flex-1 truncate">{name}</span>
        <button onClick={() => onMessage(contact)}
          title="Nhắn tin"
          className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>

      {/* Avatar + basic info */}
      <div className="flex flex-col items-center gap-2 px-4 py-4 border-b border-gray-700">
        {contact.avatar
          ? <img src={contact.avatar} alt="" className="w-16 h-16 rounded-full object-cover" />
          : <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-2xl font-bold">
              {(name || 'U').charAt(0).toUpperCase()}
            </div>}
        <div className="text-center">
          <p className="text-white font-semibold text-sm">{name}</p>
          {contact.alias && contact.alias !== contact.display_name &&
            <p className="text-xs text-gray-400">({contact.display_name})</p>}
          {contact.phone && <p className="text-xs text-gray-500 mt-0.5"><PhoneDisplay phone={contact.phone} className="text-xs text-gray-500" /></p>}
          <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${contact.is_friend ? 'bg-green-500/20 text-green-400' : 'bg-gray-600/50 text-gray-400'}`}>
            {contact.is_friend ? '✓ Bạn bè' : 'Chưa kết bạn'}
          </span>
          {/* Gender & Birthday */}
          <div className="flex items-center gap-2 mt-1.5">
            {contact.gender === 0 && <span className="text-[11px] text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">♂ Nam</span>}
            {contact.gender === 1 && <span className="text-[11px] text-pink-400 bg-pink-400/10 px-1.5 py-0.5 rounded">♀ Nữ</span>}
            {contact.birthday && <span className="text-[11px] text-gray-400 bg-gray-600/30 px-1.5 py-0.5 rounded">🎂 {contact.birthday}</span>}
          </div>
        </div>
        {/* Current labels pills (Zalo + Local) */}
        {(currentContactLabels.length > 0 || threadLocalLabelIds.length > 0) && (
          <div className="flex flex-wrap gap-1 justify-center">
            {currentContactLabels.map(l => <ZaloLabelBadge key={l.id} label={l} size="xs" />)}
            {threadLocalLabelIds.map(lid => {
              const ll = localLabels?.find(l => l.id === lid);
              if (!ll) return null;
              return (
                <span key={`ll-${lid}`}
                  className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full leading-none"
                  style={{ backgroundColor: ll.color || '#3b82f6', color: ll.text_color || '#fff' }}>
                  {ll.emoji && <span className="text-[9px]">{ll.emoji}</span>}
                  <span>{ll.name}</span>
                </span>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-gray-500">ID: {contact.contact_id}</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 text-xs">
        {(['info','history'] as DetailTab[]).map(t => (
          <button key={t} onClick={() => setDetailTab(t)}
            className={`flex-1 py-2.5 font-medium transition-colors ${detailTab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400 hover:text-gray-200'}`}>
            {t === 'info' ? 'Nhãn/Ghi chú' : 'Lịch sử gửi tin'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3">

        {detailTab === 'info' && (
          <div className="space-y-3">
            {/* Local labels */}
            {localLabels && localLabels.length > 0 && (
              <>
                <p className="text-xs text-gray-400 font-medium">Nhãn Local</p>
                <LocalLabelSelector
                  labels={localLabels}
                  selectedIds={threadLocalLabelIds}
                  onChange={handleLocalLabelChange}
                  togglingId={localLabelToggling}
                  placeholder="Chọn Nhãn Local..."
                  emptyText="Chưa có Nhãn Local nào"
                />
              </>
            )}

            {/* Zalo labels */}
            <p className="text-xs text-gray-400 font-medium">Nhãn Zalo</p>
            {allLabels.length === 0 ? (
              <p className="text-xs text-gray-500">Chưa tải nhãn. Hãy đồng bộ nhãn từ header.</p>
            ) : (
              <ZaloLabelSelector
                allLabels={allLabels}
                selectedIds={selectedLabelIds}
                singleSelect
                onChange={(ids) => { setSelectedLabelIds(ids); setLabelsDirty(true); }}
              />
            )}
            {labelsDirty && (
              <button onClick={handleSaveLabels} disabled={savingLabels}
                className="w-full py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:opacity-50">
                {savingLabels ? 'Đang lưu...' : 'Lưu nhãn'}
              </button>
            )}

            <p className="text-xs text-gray-400 font-medium">Ghi chú</p>

            {/* Tab switcher — chỉ hiện với nhóm */}
            {isGroup && (
              <div className="flex rounded-lg overflow-hidden border border-gray-600 text-[11px] mb-1">
                <button
                  onClick={() => setNoteTab('local')}
                  className={`flex-1 py-1 font-medium transition-colors ${noteTab === 'local' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  Nội bộ
                </button>
                <button
                  onClick={() => setNoteTab('zalo')}
                  className={`flex-1 py-1 font-medium transition-colors ${noteTab === 'zalo' ? 'bg-yellow-500/80 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                  Zalo ({zaloNotes.length})
                </button>
              </div>
            )}

            {/* Local notes — users & groups */}
            {(!isGroup || noteTab === 'local') && (
              <NoteList notes={notes} onSave={handleSaveNote} onDelete={handleDeleteNote} />
            )}

            {/* Zalo group notes — read-only, logic cũ */}
            {isGroup && noteTab === 'zalo' && (
              <div className="space-y-2">
                {zaloNotes.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">Chưa có ghi chú Zalo nào</p>
                )}
                {zaloNotes.map(note => (
                  <div key={note.topicId} className="bg-yellow-500/5 border border-yellow-700/30 rounded-lg p-2.5">
                    <p className="text-xs text-gray-200 whitespace-pre-wrap">{note.title}</p>
                    <div className="flex items-center justify-between mt-1.5">
                      {note.creatorName && (
                        <span className="text-[11px] text-gray-500">{note.creatorName}</span>
                      )}
                      <span className="text-[11px] text-gray-500 ml-auto">
                        {note.editTime ? new Date(note.editTime).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {detailTab === 'history' && (
          <div className="space-y-2">
            {sendLog.length === 0 && <p className="text-xs text-gray-500 text-center py-4">Chưa có lịch sử gửi</p>}
            {sendLog.map(log => (
              <div key={log.id} className={`p-2.5 rounded-lg border text-xs ${log.status === 'sent' ? 'bg-green-500/5 border-green-700/30' : 'bg-red-500/5 border-red-700/30'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-medium ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                    {log.status === 'sent' ? '✓ Đã gửi' : '✕ Thất bại'}
                  </span>
                  <span className="text-gray-500">{fmt(log.sent_at)}</span>
                </div>
                <p className="text-gray-300 line-clamp-2">{log.message}</p>
                {log.error && <p className="text-red-400 text-[11px] mt-1">{log.error}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
