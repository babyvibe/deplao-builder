import React, { useEffect, useState, useCallback } from 'react';
import type { CRMContact, CRMNote } from '@/store/crm/crmStore';
import type { LabelData } from '@/store/app/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import PageLoading from '@/components/common/PageLoading';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import ZaloLabelSelector from '../tags/ZaloLabelSelector';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import LocalLabelSelector from '@/components/common/inputs/LocalLabelSelector';
import type { LocalLabelItem } from '@/components/common/inputs/LocalLabelSelector';
import NoteList from '../notes/NoteList';
import PhoneDisplay from '@/components/common/inputs/PhoneDisplay';
import type { PinnedNote } from '@/components/chat/messages/PinnedMessages';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { GiftIcon } from '@/components/common/icons';
import type { Channel } from '../../../../configs/channels/channelConfig';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

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
      const res: any = exists
        ? await DataAccessor.removeLocalLabelFromThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id })
        : await DataAccessor.assignLocalLabelToThread({ zaloId: activeAccountId, labelId, threadId: contact.contact_id });
      // Employee: Boss refuses / the connection drops and returns success:false (does not throw) → show an error instead of "Đã gắn nhãn" (Labelled)
      if (res?.success === false) throw new Error(res.error || 'write failed');
      showNotification(exists ? tr('Đã gỡ nhãn "{{name}}"', { name: label.name }) : tr('Đã gắn nhãn "{{name}}"', { name: label.name }), 'success');
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
    } catch {
      showNotification(tr('Không thể cập nhật nhãn'), 'error');
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

  // When the contact changes or the list is loaded again, sync the form with the new data.
  // Do not do this while editing, to avoid losing what the user has just typed.
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

  // Re-fetch notes when remote CRM note changes arrive (Boss / another employee, relay crm:noteChanged; skip notes
  // of another account or of another contact when the payload says so)
  useEffect(() => {
    const handleNoteChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.ownerZaloId && detail.ownerZaloId !== activeAccountId) return;
      const noteContact = detail?.note?.contact_id ?? detail?.note?.contactId;
      if (noteContact && String(noteContact) !== String(contact.contact_id)) return;
      if (detailTab === 'info' && activeAccountId) {
        loadNotes();
      }
    };
    window.addEventListener('ui:noteChanged', handleNoteChange);
    return () => window.removeEventListener('ui:noteChanged', handleNoteChange);
  }, [detailTab, activeAccountId, contact.contact_id]);

  // Employee mode: BOSS connection restored → reload the notes (changes made while the connection was down have no event)
  useEmployeeResync(() => (detailTab === 'info' && activeAccountId ? loadNotes() : undefined));

  const loadNotes = async () => {
    if (!activeAccountId) return;
    const res = await DataAccessor.getCRMNotes({ zaloId: activeAccountId, contactId: contact.contact_id });
    if (res?.success) setNotes(res.notes);
  };

  const loadZaloNotes = async () => {
    if (!activeAccountId) return;
    try {
      const res = await DataAccessor.getPinnedMessages({ zaloId: activeAccountId, threadId: contact.contact_id });
      if (isReadFailure(res)) return; // read error (employee lost connection to Boss): keep the group notes on screen
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
        showNotification(tr('Đã cập nhật nhãn'), 'success');
        // Note: Workflow events are now emitted by backend (zaloIpc.ts) to avoid duplicates
      } else {
        throw new Error(res?.error || tr('Không thể cập nhật nhãn'));
      }
    } catch (err: any) {
      showNotification(tr('Lỗi: {{v1}}', { v1: (err?.message || tr('Không rõ')) }), 'error');
    }
    setSavingLabels(false);
  };

  const handleSaveNote = async (content: string, id?: number) => {
    if (!activeAccountId) return false;
    const res = await DataAccessor.saveCRMNote({ zaloId: activeAccountId, note: { id, contact_id: contact.contact_id, content } });
    if (isReadFailure(res)) {
      // Save error (employee: lost connection to BOSS): show the error + keep the text being typed (NoteList), so notes are never silently lost
      showNotification(tr('Không lưu được ghi chú: {{v1}}', { v1: readFailureMessage(res) }), 'error');
      return false;
    }
    await loadNotes();
    return true;
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
      showNotification(tr('Ngày sinh không hợp lệ'), 'error');
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
      if (res?.success === false) throw new Error(res.error || tr('Không thể lưu thông tin liên hệ'));
      setManualBirthday(toBirthdayInputValue(birthday));
      setEditingDetails(false);
      showNotification(tr('Đã cập nhật thông tin liên hệ'), 'success');
      window.dispatchEvent(new CustomEvent('crm-contacts-changed', { detail: { zaloId: activeAccountId } }));
    } catch (err: any) {
      showNotification(err?.message || tr('Không thể lưu thông tin liên hệ'), 'error');
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
  const fmt = (ts: number) => ts ? new Date(ts).toLocaleString(appLocale(), { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';

  const currentContactLabels = allLabels.filter(l => {
    const isGroup = contact.contact_type === 'group';
    const prefixed = getLabelThreadId(contact.contact_id, isGroup);
    return l.conversations?.includes(contact.contact_id) || l.conversations?.includes(prefixed);
  });

  return (
    <div className="w-80 flex-shrink-0 flex flex-col bg-card border-l border-border h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 truncate">{name}</span>
        <button onClick={() => onMessage(contact)}
          title={tr('Nhắn tin')}
          className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
      </div>

      {/* Avatar + basic info */}
      <div className="flex flex-col items-center gap-2 px-4 py-4 border-b border-border">
        {contact.avatar
          ? <img src={contact.avatar} alt="" className="w-16 h-16 rounded-full object-cover" />
          : <PeerInitials id={contact.contact_id} name={name} fallback="U" className="w-16 h-16 text-xl" />}
        <div className="text-center">
          <p className="text-foreground font-semibold text-sm">{name}</p>
          {contact.alias && contact.alias !== contact.display_name &&
            <p className="text-xs text-muted-foreground">({contact.display_name})</p>}
          {contact.phone && <p className="text-xs text-muted-foreground mt-0.5"><PhoneDisplay phone={contact.phone} className="text-xs text-muted-foreground" /></p>}
          {/* Gender & Birthday */}
          <div className="flex items-center gap-2 mt-1.5">
            {isZalo && <>
            <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${contact.is_friend ? 'bg-green-500/20 text-green-400' : 'bg-accent/50 text-muted-foreground'}`}>
              {contact.is_friend ? tr('✓ Bạn bè') : tr('Chưa kết bạn')}
            </span>
            {contact.gender === 0 && <span className="text-[11px] text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">{tr('♂ Nam')}</span>}
            {contact.gender === 1 && <span className="text-[11px] text-pink-400 bg-pink-400/10 px-1.5 py-0.5 rounded">{tr('♀ Nữ')}</span>}
            {contact.birthday && <span className="text-[11px] text-muted-foreground bg-accent/30 px-1.5 py-0.5 rounded"><GiftIcon className="w-4 h-4 inline" /> {contact.birthday}</span>}
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
        <p className="text-[11px] text-muted-foreground">{trx('ID: {{contact_id}}', { contact_id: contact.contact_id })}</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border text-xs">
        {(['info','history'] as DetailTab[]).map(t => (
          <button key={t} onClick={() => setDetailTab(t)}
            className={`flex-1 py-2.5 font-medium transition-colors ${detailTab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-muted-foreground hover:text-foreground'}`}>
            {t === 'info' ? tr('Nhãn/Ghi chú') : tr('Lịch sử gửi tin')}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center h-full min-h-[200px]">
            <PageLoading variant="inline" text={tr('Đang tải thông tin liên hệ...')} />
          </div>
        ) : (
          <>
            {detailTab === 'info' && (
              <div className="space-y-3">
                {/* Manual contact fields are shared by every channel. */}
                <section className="rounded-xl border border-input bg-card p-3 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-foreground/80 font-medium">{tr('Thông tin liên hệ')}</p>
                    {!editingDetails && (
                      <button onClick={() => setEditingDetails(true)} className="text-[11px] text-blue-400 hover:text-blue-300">
                        {tr('Sửa')}
                      </button>
                    )}
                  </div>
                  {editingDetails ? (
                    <div className="space-y-2">
                      <label className="block text-[11px] text-muted-foreground">
                        {tr('Điện thoại')}
                        <input value={manualPhone} onChange={e => setManualPhone(e.target.value)} type="tel" placeholder={tr('Nhập số điện thoại')}
                          className="mt-1 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-xs text-foreground placeholder:text-subtle-foreground outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                      </label>
                      <label className="block text-[11px] text-muted-foreground">
                        {tr('Giới tính')}
                        <select value={manualGender ?? ''} onChange={e => setManualGender(e.target.value === '' ? null : Number(e.target.value))}
                          style={{ colorScheme: 'dark' }}
                          className="mt-1 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                          <option value="">{tr('Chưa xác định')}</option>
                          <option value="0">{tr('Nam')}</option>
                          <option value="1">{tr('Nữ')}</option>
                        </select>
                      </label>
                      <label className="block text-[11px] text-muted-foreground">
                        {tr('Sinh nhật')}
                        <input type="date" value={manualBirthday} onChange={e => setManualBirthday(e.target.value)}
                          style={{ colorScheme: 'dark' }}
                          className="mt-1 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                      </label>
                      <div className="flex justify-end gap-2 pt-1">
                        <button onClick={cancelEditManualDetails} disabled={savingDetails} className="px-2.5 py-1 rounded text-[11px] text-foreground/80 hover:bg-muted disabled:opacity-50">{tr('Huỷ')}</button>
                        <button onClick={handleSaveManualDetails} disabled={savingDetails} className="px-2.5 py-1 rounded bg-blue-600 text-[11px] text-white hover:bg-blue-700 disabled:opacity-50">
                          {savingDetails ? tr('Đang lưu...') : tr('Lưu')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <dl className="space-y-1.5 text-xs">
                      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{tr('Điện thoại')}</dt><dd className="text-foreground text-right break-all">{contact.phone ? <PhoneDisplay phone={contact.phone} className="text-xs text-foreground" /> : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{tr('Giới tính')}</dt><dd className="text-foreground">{contact.gender === 0 ? tr('Nam') : contact.gender === 1 ? tr('Nữ') : tr('Chưa xác định')}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{tr('Sinh nhật')}</dt><dd className="text-foreground">{contact.birthday || '—'}</dd></div>
                    </dl>
                  )}
                </section>

                {/* Local labels */}
                <>
                  <p className="text-xs text-muted-foreground font-medium">{tr('Nhãn Local')}</p>
                  <LocalLabelSelector
                    labels={localLabels || []}
                    selectedIds={threadLocalLabelIds}
                    onChange={handleLocalLabelChange}
                    togglingId={localLabelToggling}
                    placeholder={tr('Chọn Nhãn Local...')}
                    emptyText={tr('Chưa có Nhãn Local nào')}
                  />
                </>

                {/* Zalo labels */}
                {isZalo && <>
                  <p className="text-xs text-muted-foreground font-medium">{tr('Nhãn Zalo')}</p>
                  {allLabels.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{tr('Chưa tải nhãn. Hãy đồng bộ nhãn từ header.')}</p>
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
                      {savingLabels ? tr('Đang lưu...') : tr('Lưu nhãn')}
                    </button>
                  )}
                </>}

                <p className="text-xs text-muted-foreground font-medium">{tr('Ghi chú')}</p>

                {/* Tab switcher: only shown for groups */}
                {isZalo && isGroup && (
                  <div className="flex rounded-lg overflow-hidden border border-input text-[11px] mb-1">
                    <button
                      onClick={() => setNoteTab('local')}
                      className={`flex-1 py-1 font-medium transition-colors ${noteTab === 'local' ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                      {tr('Nội bộ')}
                    </button>
                    <button
                      onClick={() => setNoteTab('zalo')}
                      className={`flex-1 py-1 font-medium transition-colors ${noteTab === CHANNEL.ZALO ? 'bg-yellow-500/80 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                      {trx('Zalo ({{count}})', { count: zaloNotes.length })}
                    </button>
                  </div>
                )}

                {/* Local notes - users & groups */}
                {(!isGroup || noteTab === 'local') && (
                  <NoteList notes={notes} onSave={handleSaveNote} onDelete={handleDeleteNote} />
                )}

                {/* Zalo group notes: read-only, old logic */}
                {isZalo && isGroup && noteTab === CHANNEL.ZALO && (
                  <div className="space-y-2">
                    {zaloNotes.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-2">{tr('Chưa có ghi chú Zalo nào')}</p>
                    )}
                    {zaloNotes.map(note => (
                      <div key={note.topicId} className="bg-yellow-500/5 border border-yellow-700/30 rounded-lg p-2.5">
                        <p className="text-xs text-foreground whitespace-pre-wrap">{note.title}</p>
                        <div className="flex items-center justify-between mt-1.5">
                          {note.creatorName && (
                            <span className="text-[11px] text-muted-foreground">{note.creatorName}</span>
                          )}
                          <span className="text-[11px] text-muted-foreground ml-auto">
                            {note.editTime ? new Date(note.editTime).toLocaleString(appLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
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
                {sendLog.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">{tr('Chưa có lịch sử gửi')}</p>}
                {sendLog.map(log => (
                  <div key={log.id} className={`p-2.5 rounded-lg border text-xs ${log.status === 'sent' ? 'bg-green-500/5 border-green-700/30' : 'bg-red-500/5 border-red-700/30'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-medium ${log.status === 'sent' ? 'text-green-400' : 'text-red-400'}`}>
                        {log.status === 'sent' ? tr('✓ Đã gửi') : tr('✕ Thất bại')}
                      </span>
                      <span className="text-muted-foreground">{fmt(log.sent_at)}</span>
                    </div>
                    <p className="text-foreground/80 line-clamp-2">{log.message}</p>
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
