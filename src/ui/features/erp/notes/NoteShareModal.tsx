import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import type { ErpNote, NoteShareScope, NoteSharePermission } from '../../../../models/erp';
import { EmployeeAvatar } from '../shared/ErpBadges';

interface Props {
  note: ErpNote;
  onClose: () => void;
  onSaved?: () => void;
}

interface Row { employeeId: string; permission: NoteSharePermission }

export default function NoteShareModal({ note, onClose, onSaved }: Props) {
  const profiles = useErpEmployeeStore(s => s.profiles);
  const loadProfiles = useErpEmployeeStore(s => s.loadProfiles);

  const [scope, setScope] = useState<NoteShareScope>(note.share_scope ?? 'private');
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profiles.length) loadProfiles();
    (async () => {
      const res = await ipc.erp?.noteListShares({ noteId: note.id });
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
      await ipc.erp?.noteShare({
        noteId: note.id,
        scope,
        shares: scope === 'custom' ? rows : [],
      });
      onSaved?.();
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-5 w-[520px] max-h-[80vh] flex flex-col shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-white">Chia sẻ note</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">×</button>
        </div>
        <p className="text-xs text-gray-500 mb-3 truncate">"{note.title}"</p>

        {/* Scope picker */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {(['private', 'workspace', 'custom'] as NoteShareScope[]).map(s => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`py-2 rounded-lg text-xs border transition-colors ${
                scope === s
                  ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                  : 'border-gray-600 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {s === 'private' ? '🔒 Riêng tư' : s === 'workspace' ? '🌐 Toàn workspace' : '👥 Tuỳ chọn'}
            </button>
          ))}
        </div>

        {/* Custom list */}
        {scope === 'custom' && (
          <div className="flex-1 flex flex-col min-h-0 border border-gray-700 rounded-lg overflow-hidden">
            <div className="p-2 border-b border-gray-700 bg-gray-900/40">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Tìm nhân viên để thêm..."
                className="w-full bg-gray-700/60 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
              />
              {search && candidates.length > 0 && (
                <div className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                  {candidates.map((p: any) => (
                    <button
                      key={p.employee_id}
                      onClick={() => { add(p.employee_id); setSearch(''); }}
                      className="w-full flex items-center gap-2 px-2 py-1 hover:bg-gray-700 rounded text-left"
                    >
                      <EmployeeAvatar employeeId={p.employee_id} size={20} />
                      <span className="text-xs text-gray-200 truncate">{p.full_name ?? p.display_name ?? p.employee_id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && <p className="text-xs text-gray-500 p-3">Đang tải...</p>}
              {!loading && rows.length === 0 && (
                <p className="text-xs text-gray-500 p-3 text-center">Chưa chia sẻ với ai. Gõ tên để thêm.</p>
              )}
              {rows.map(r => (
                <div key={r.employeeId} className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/40 last:border-b-0">
                  <EmployeeAvatar employeeId={r.employeeId} size={24} showName />
                  <span className="flex-1" />
                  <select
                    value={r.permission}
                    onChange={e => setPerm(r.employeeId, e.target.value as NoteSharePermission)}
                    className="bg-gray-700 border border-gray-600 rounded text-xs text-gray-200 px-2 py-1"
                  >
                    <option value="read">Xem</option>
                    <option value="edit">Sửa</option>
                  </select>
                  <button onClick={() => remove(r.employeeId)} className="text-gray-500 hover:text-red-400 text-sm">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {scope !== 'custom' && (
          <p className="text-xs text-gray-500 italic p-2">
            {scope === 'private'
              ? 'Chỉ bạn thấy note này.'
              : 'Tất cả thành viên workspace có thể xem (chỉ người tạo được sửa).'}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg">
            Huỷ
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg">
            {saving ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}

