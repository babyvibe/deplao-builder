import React, { useEffect, useMemo, useState } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAppStore } from '@/store/app/appStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { withErpDeniedNotice } from '@/store/erp/erpStoreHelpers';
import type { ErpNote, NoteShareScope, NoteSharePermission } from '../../../../models/erp';
import { EmployeeAvatar } from '../shared/ErpBadges';
import PageLoading from '@/components/common/PageLoading';
import { GlobeIcon, LockIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


interface Props {
  note: ErpNote;
  onClose: () => void;
  onSaved?: () => void;
}

interface Row { employeeId: string; permission: NoteSharePermission }

export default function NoteShareModal({ note, onClose, onSaved }: Props) {
  const profiles = useErpEmployeeStore(s => s.profiles);
  const loadProfiles = useErpEmployeeStore(s => s.loadProfiles);
  const showNotification = useAppStore(s => s.showNotification);

  const [scope, setScope] = useState<NoteShareScope>(note.share_scope ?? 'private');
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profiles.length) loadProfiles();
    (async () => {
      const res: any = await DataAccessor.erpNoteShares(note.id);
      if (res?.success) {
        setRows((res.shares ?? []).map((s: any) => ({
          employeeId: s.employee_id, permission: s.permission,
        })));
      }
      setLoading(false);
    })();
  }, [note.id]);

  const selectedIds = useMemo(() => new Set(rows.map(r => r.employeeId)), [rows]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles
      .filter((p: any) => !selectedIds.has(p.employee_id))
      .filter((p: any) => !q || (p.full_name ?? p.display_name ?? p.employee_id).toLowerCase().includes(q))
      .slice(0, 20);
  }, [profiles, search, selectedIds]);

  const add = (id: string) => setRows(r => [...r, { employeeId: id, permission: 'read' }]);
  const remove = (id: string) => setRows(r => r.filter(x => x.employeeId !== id));
  const setPerm = (id: string, p: NoteSharePermission) =>
    setRows(r => r.map(x => x.employeeId === id ? { ...x, permission: p } : x));

  const save = async () => {
    setSaving(true);
    try {
      // Employee: share the note up to the owner (REST): the recipient gets a notification, and the note appears in their list
      const res: any = withErpDeniedNotice(await DataAccessor.erpShareNote(note.id, scope, scope === 'custom' ? rows : []));
      if (res && res.success === false) {
        showNotification(res.error || tr('Không lưu được chia sẻ'), 'error');
        return;
      }
      onSaved?.();
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl p-5 w-[520px] max-h-[80vh] flex flex-col shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-foreground">{tr('Chia sẻ note')}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg">×</button>
        </div>
        <p className="text-xs text-muted-foreground mb-3 truncate">"{note.title}"</p>

        {/* Scope picker */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {(['private', 'workspace', 'custom'] as NoteShareScope[]).map(s => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`py-2 rounded-lg text-xs border transition-colors ${
                scope === s
                  ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                  : 'border-input text-muted-foreground hover:bg-muted'
              }`}
            >
              {s === 'private' ? <>{trx('<0/> Riêng tư', { 0: <LockIcon className="w-4 h-4 inline" /> })}</> : s === 'workspace' ? <>{trx('<0/> Toàn workspace', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</> : <>{trx('<0/> Tuỳ chọn', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</>}
            </button>
          ))}
        </div>

        {/* Custom list */}
        {scope === 'custom' && (
          <div className="flex-1 flex flex-col min-h-0 border border-border rounded-lg overflow-hidden">
            <div className="p-2 border-b border-border bg-card">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={tr('Tìm nhân viên để thêm...')}
                className="w-full bg-muted/60 border border-input rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-blue-500"
              />
              {search && candidates.length > 0 && (
                <div className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                  {candidates.map((p: any) => (
                    <button
                      key={p.employee_id}
                      onClick={() => { add(p.employee_id); setSearch(''); }}
                      className="w-full flex items-center gap-2 px-2 py-1 hover:bg-muted rounded text-left"
                    >
                      <EmployeeAvatar employeeId={p.employee_id} size={20} />
                      <span className="text-xs text-foreground truncate">{p.full_name ?? p.display_name ?? p.employee_id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && <PageLoading variant="inline" size="sm" />}
              {!loading && rows.length === 0 && (
                <p className="text-xs text-muted-foreground p-3 text-center">{tr('Chưa chia sẻ với ai. Gõ tên để thêm.')}</p>
              )}
              {rows.map(r => (
                <div key={r.employeeId} className="flex items-center gap-2 px-3 py-2 border-b border-border/40 last:border-b-0">
                  <EmployeeAvatar employeeId={r.employeeId} size={24} showName />
                  <span className="flex-1" />
                  <select
                    value={r.permission}
                    onChange={e => setPerm(r.employeeId, e.target.value as NoteSharePermission)}
                    className="bg-muted border border-input rounded text-xs text-foreground px-2 py-1"
                  >
                    <option value="read">{tr('Xem')}</option>
                    <option value="edit">{tr('Sửa')}</option>
                  </select>
                  <button onClick={() => remove(r.employeeId)} className="text-muted-foreground hover:text-red-400 text-sm">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {scope !== 'custom' && (
          <p className="text-xs text-muted-foreground italic p-2">
            {scope === 'private'
              ? tr('Chỉ bạn thấy note này.')
              : tr('Tất cả thành viên workspace có thể xem (chỉ người tạo được sửa).')}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg">
            {tr('Huỷ')}
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg">
            {saving ? tr('Đang lưu...') : tr('Lưu')}
          </button>
        </div>
      </div>
    </div>
  );
}

