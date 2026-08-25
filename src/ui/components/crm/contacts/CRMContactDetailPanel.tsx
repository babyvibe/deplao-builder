import React, { useEffect, useState, useCallback } from 'react';
import type { CRMContact, CRMNote } from '@/store/crmStore';
import type { LabelData } from '@/store/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import DataAccessor from '@/lib/data/DataAccessor';
import PageLoading from '@/components/common/PageLoading';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ZaloLabelSelector from '../tags/ZaloLabelSelector';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import LocalLabelSelector from '@/components/common/LocalLabelSelector';
import type { LocalLabelItem } from '@/components/common/LocalLabelSelector';
import NoteList from '../notes/NoteList';
import PhoneDisplay from '@/components/common/PhoneDisplay';
import type { PinnedNote } from '@/components/chat/PinnedMessages';
import { CHANNEL } from '@/lib/channelHelper';
import { GiftIcon } from '@/components/common/icons';
import type { Channel } from '../../../../configs/channelConfig';

interface CRMContactDetailPanelProps {
  contact: CRMContact;
  channel?: Channel;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  onClose: () => void;
  onMessage: (contact: CRMContact) => void;
}

type DetailTab = 'info' | 'history';

const toBirthdayInputValue = (birthday?: string | null) => {
  const match = String(birthday || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
};

const fromBirthdayInputValue = (dateValue: string) => {
  const match = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
};

export default function CRMContactDetailPanel({ contact, channel = CHANNEL.ZALO, allLabels, localLabels, localLabelThreadMap, onClose, onMessage }: CRMContactDetailPanelProps) {
  const { activeAccountId } = useAccountStore();
  const { showNotification, setLabels } = useAppStore();
  const [detailTab, setDetailTab] = useState<DetailTab>('info');
  const [notes, setNotes] = useState<CRMNote[]>([]);
  const [zaloNotes, setZaloNotes] = useState<PinnedNote[]>([]);
  const [noteTab, setNoteTab] = useState<'local' | 'zalo'>('local');
  const [sendLog, setSendLog] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingDetails, setEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [manualPhone, setManualPhone] = useState(contact.phone || '');
  const [manualGender, setManualGender] = useState<number | null>(contact.gender ?? null);
  const [manualBirthday, setManualBirthday] = useState(toBirthdayInputValue(contact.birthday));

  const isGroup = contact.contact_type === 'group';
  const isZalo = channel === CHANNEL.ZALO;

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
        await DataAccessor.removeLocalLabelFromThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id });
      } else {
        await DataAccessor.assignLocalLabelToThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id });
      }
      showNotification(exists ? `Đã gỡ nhãn "${label.name}"` : `Đã gắn nhãn "${label.name}"`, 'success');
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
    } catch {
      showNotification('Không thể cập nhật nhãn', 'error');
    } finally {
      setLocalLabelToggling(null);
    }
  }, [activeAccountId, contact.contact_id, contact.contact_type, localLabelToggling, threadLocalLabelIds, localLabels, showNotification]);

  /** Called from LocalLabelSelector - diff to find which label was toggled */
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

  // Khi đổi liên hệ hoặc danh sách được nạp lại, đồng bộ form với dữ liệu mới.
  // Không làm việc này trong lúc đang sửa để tránh mất nội dung người dùng vừa nhập.
  useEffect(() => {
    if (editingDetails) return;
    setManualPhone(contact.phone || '');
    setManualGender(contact.gender ?? null);
    setManualBirthday(toBirthdayInputValue(contact.birthday));
  }, [contact.contact_id, contact.phone, contact.gender, contact.birthday, editingDetails]);

  useEffect(() => {
    if (!activeAccountId) return;
    setLoading(true);
    const promises: Promise<any>[] = [];
    if (detailTab === 'info') {
      promises.push(loadNotes());
      if (isZalo && isGroup) promises.push(loadZaloNotes());
    }
    if (detailTab === 'history') promises.push(loadHistory());
    Promise.all(promises).finally(() => setLoading(false));
  }, [detailTab, contact.contact_id, isZalo, isGroup]);

  // Re-fetch notes when remote CRM note changes arrive
  useEffect(() => {
    const handleNoteChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detailTab === 'info' && activeAccountId) {
        loadNotes();
      }
    };
    window.addEventListener('ui:noteChanged', handleNoteChange);
    return () => window.removeEventListener('ui:noteChanged', handleNoteChange);
  }, [detailTab, activeAccountId, contact.contact_id]);

  const loadNotes = async () => {
    if (!activeAccountId) return;
    const res = await DataAccessor.getCRMNotes({ zaloId: activeAccountId, contactId: contact.contact_id });
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
    const res = await DataAccessor.getSendLog({ zaloId: activeAccountId, opts: { contactId: contact.contact_id, limit: 50 } });
    if (res?.success) setSendLog(res.logs);
  };

  const handleSaveLabels = async () => {
    if (!activeAccountId) return;
    setSavingLabels(true);
    try {
      const acc = useAccountStore.getState().getActiveAccount();
      if (!acc) throw new Error('No account');
      const auth = buildZaloAuth(acc, activeAccountId);

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
    await DataAccessor.saveCRMNote({ zaloId: activeAccountId, note: { id, contact_id: contact.contact_id, content } });
    await loadNotes();
  };

  const handleDeleteNote = async (noteId: number) => {
    if (!activeAccountId) return;
    await DataAccessor.deleteCRMNote({ zaloId: activeAccountId, noteId });
    setNotes(prev => prev.filter(n => n.id !== noteId));
  };

  const handleSaveManualDetails = async () => {
    if (!activeAccountId) return;
    const birthday = fromBirthdayInputValue(manualBirthday);
    if (manualBirthday && !birthday) {
      showNotification('Ngày sinh không hợp lệ', 'error');
      return;
    }

    setSavingDetails(true);
    try {
      const res = await DataAccessor.updateContactProfile({
        zaloId: activeAccountId,
        contactId: contact.contact_id,
        displayName: contact.display_name || contact.alias || contact.contact_id,
        avatarUrl: contact.avatar || '',
        phone: manualPhone.trim(),
        contactType: contact.contact_type || 'user',
        gender: manualGender,
        birthday: birthday || null,
        manualDetails: true,
      });
      if (res?.success === false) throw new Error(res.error || 'Không thể lưu thông tin liên hệ');
      setManualBirthday(toBirthdayInputValue(birthday));
      setEditingDetails(false);
      showNotification('Đã cập nhật thông tin liên hệ', 'success');
      window.dispatchEvent(new CustomEvent('crm-contacts-changed', { detail: { zaloId: activeAccountId } }));
    } catch (err: any) {
      showNotification(err?.message || 'Không thể lưu thông tin liên hệ', 'error');
    } finally {
      setSavingDetails(false);
    }
  };

  const cancelEditManualDetails = () => {
    setManualPhone(contact.phone || '');
    setManualGender(contact.gender ?? null);
    setManualBirthday(toBirthdayInputValue(contact.birthday));
    setEditingDetails(false);
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
          {contact.phone && <p className="text-xs text-gray-400 mt-0.5"><PhoneDisplay phone={contact.phone} className="text-xs text-gray-400" /></p>}
          {/* Gender & Birthday */}
          <div className="flex items-center gap-2 mt-1.5">
            {isZalo && <>
            <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${contact.is_friend ? 'bg-green-500/20 text-green-400' : 'bg-gray-600/50 text-gray-400'}`}>
              {contact.is_friend ? '✓ Bạn bè' : 'Chưa kết bạn'}
            </span>
            {contact.gender === 0 && <span className="text-[11px] text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">♂ Nam</span>}
            {contact.gender === 1 && <span className="text-[11px] text-pink-400 bg-pink-400/10 px-1.5 py-0.5 rounded">♀ Nữ</span>}
            {contact.birthday && <span className="text-[11px] text-gray-400 bg-gray-600/30 px-1.5 py-0.5 rounded"><GiftIcon className="w-4 h-4 inline" /> {contact.birthday}</span>}
            </>}
          </div>
        </div>
        {/* Current labels pills (Zalo + Local) */}
        {((isZalo && currentContactLabels.length > 0) || threadLocalLabelIds.length > 0) && (
          <div className="flex flex-wrap gap-1 justify-center">
            {isZalo && currentContactLabels.map(l => <ZaloLabelBadge key={l.id} label={l} size="xs" />)}
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
        <p className="text-[11px] text-gray-400">ID: {contact.contact_id}</p>
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
        {loading ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <PageLoading variant="inline" text="Đang tải thông tin liên hệ..." />
          </div>
        ) : (
          <>
            {detailTab === 'info' && (
              <div className="space-y-3">
                {/* Manual contact fields are shared by every channel. */}
                <section className="rounded-xl border border-gray-600 bg-gray-800 p-3 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-300 font-medium">Thông tin liên hệ</p>
                    {!editingDetails && (
                      <button onClick={() => setEditingDetails(true)} className="text-[11px] text-blue-400 hover:text-blue-300">
                        Sửa
                      </button>
                    )}
                  </div>
                  {editingDetails ? (
                    <div className="space-y-2">
                      <label className="block text-[11px] text-gray-400">
                        Điện thoại
                        <input value={manualPhone} onChange={e => setManualPhone(e.target.value)} type="tel" placeholder="Nhập số điện thoại"
                          className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-2 text-xs text-gray-100 placeholder:text-gray-500 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                      </label>
                      <label className="block text-[11px] text-gray-400">
                        Giới tính
                        <select value={manualGender ?? ''} onChange={e => setManualGender(e.target.value === '' ? null : Number(e.target.value))}
                          style={{ colorScheme: 'dark' }}
                          className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-2 text-xs text-gray-100 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                          <option value="">Chưa xác định</option>
                          <option value="0">Nam</option>
                          <option value="1">Nữ</option>
                        </select>
                      </label>
                      <label className="block text-[11px] text-gray-400">
                        Sinh nhật
                        <input type="date" value={manualBirthday} onChange={e => setManualBirthday(e.target.value)}
                          style={{ colorScheme: 'dark' }}
                          className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-900 px-2.5 py-2 text-xs text-gray-100 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                      </label>
                      <div className="flex justify-end gap-2 pt-1">
                        <button onClick={cancelEditManualDetails} disabled={savingDetails} className="px-2.5 py-1 rounded text-[11px] text-gray-300 hover:bg-gray-700 disabled:opacity-50">Huỷ</button>
                        <button onClick={handleSaveManualDetails} disabled={savingDetails} className="px-2.5 py-1 rounded bg-blue-600 text-[11px] text-white hover:bg-blue-700 disabled:opacity-50">
                          {savingDetails ? 'Đang lưu...' : 'Lưu'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <dl className="space-y-1.5 text-xs">
                      <div className="flex justify-between gap-3"><dt className="text-gray-400">Điện thoại</dt><dd className="text-gray-200 text-right break-all">{contact.phone ? <PhoneDisplay phone={contact.phone} className="text-xs text-gray-200" /> : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-gray-400">Giới tính</dt><dd className="text-gray-200">{contact.gender === 0 ? 'Nam' : contact.gender === 1 ? 'Nữ' : 'Chưa xác định'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-gray-400">Sinh nhật</dt><dd className="text-gray-200">{contact.birthday || '—'}</dd></div>
                    </dl>
                  )}
                </section>

                {/* Local labels */}
                <>
                  <p className="text-xs text-gray-400 font-medium">Nhãn Local</p>
                  <LocalLabelSelector
                    labels={localLabels || []}
                    selectedIds={threadLocalLabelIds}
                    onChange={handleLocalLabelChange}
                    togglingId={localLabelToggling}
                    placeholder="Chọn Nhãn Local..."
                    emptyText="Chưa có Nhãn Local nào"
                  />
                </>

                {/* Zalo labels */}
                {isZalo && <>
                  <p className="text-xs text-gray-400 font-medium">Nhãn Zalo</p>
                  {allLabels.length === 0 ? (
                    <p className="text-xs text-gray-400">Chưa tải nhãn. Hãy đồng bộ nhãn từ header.</p>
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
                </>}

                <p className="text-xs text-gray-400 font-medium">Ghi chú</p>

                {/* Tab switcher - chỉ hiện với nhóm */}
                {isZalo && isGroup && (
                  <div className="flex rounded-lg overflow-hidden border border-gray-600 text-[11px] mb-1">
                    <button
                      onClick={() => setNoteTab('local')}
                      className={`flex-1 py-1 font-medium transition-colors ${noteTab === 'local' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                      Nội bộ
                    </button>
                    <button
                      onClick={() => setNoteTab('zalo')}
                      className={`flex-1 py-1 font-medium transition-colors ${noteTab === CHANNEL.ZALO ? 'bg-yellow-500/80 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                      Zalo ({zaloNotes.length})
                    </button>
                  </div>
                )}

                {/* Local notes - users & groups */}
                {(!isGroup || noteTab === 'local') && (
                  <NoteList notes={notes} onSave={handleSaveNote} onDelete={handleDeleteNote} />
                )}

                {/* Zalo group notes - read-only, logic cũ */}
                {isZalo && isGroup && noteTab === CHANNEL.ZALO && (
                  <div className="space-y-2">
                    {zaloNotes.length === 0 && (
                      <p className="text-xs text-gray-400 text-center py-2">Chưa có ghi chú Zalo nào</p>
                    )}
                    {zaloNotes.map(note => (
                      <div key={note.topicId} className="bg-yellow-500/5 border border-yellow-700/30 rounded-lg p-2.5">
                        <p className="text-xs text-gray-200 whitespace-pre-wrap">{note.title}</p>
                        <div className="flex items-center justify-between mt-1.5">
                          {note.creatorName && (
                            <span className="text-[11px] text-gray-400">{note.creatorName}</span>
                          )}
                          <span className="text-[11px] text-gray-400 ml-auto">
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
                {sendLog.length === 0 && <p className="text-xs text-gray-400 text-center py-4">Chưa có lịch sử gửi</p>}
                {sendLog.map(log => (
                  <div key={log.id} className={`p-2.5 rounded-lg border text-xs ${log.status === 'sent' ? 'bg-green-500/5 border-green-700/30' : 'bg-red-500/5 border-red-700/30'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-medium ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                        {log.status === 'sent' ? '✓ Đã gửi' : '✕ Thất bại'}
                      </span>
                      <span className="text-gray-400">{fmt(log.sent_at)}</span>
                    </div>
                    <p className="text-gray-300 line-clamp-2">{log.message}</p>
                    {log.error && <p className="text-red-400 text-[11px] mt-1">{log.error}</p>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
