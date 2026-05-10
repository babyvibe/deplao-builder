import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import type { ErpNote, ErpNoteVersion } from '../../../../models/erp';
import { EmployeeAvatar } from '../shared/ErpBadges';
import { ConfirmDialog } from '../shared/ErpDialogs';

interface Props {
  note: ErpNote;
  onClose: () => void;
  onRestored?: (note: ErpNote) => void;
}

export default function NoteVersionHistory({ note, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<ErpNoteVersion[]>([]);
  const [active, setActive] = useState<ErpNoteVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoreTarget, setRestoreTarget] = useState<ErpNoteVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await ipc.erp?.noteVersions({ noteId: note.id });
      if (res?.success) {
        const list = (res.versions ?? []) as ErpNoteVersion[];
        setVersions(list);
        if (list.length) setActive(list[0]);
      }
      setLoading(false);
    })();
  }, [note.id]);

  const doRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await ipc.erp?.noteRestoreVersion({ noteId: note.id, versionId: restoreTarget.id });
      if (res?.success && res.note) onRestored?.(res.note);
      setRestoreTarget(null);
      onClose();
    } finally { setRestoring(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-700 rounded-2xl w-[800px] h-[560px] flex flex-col shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/60">
          <div>
            <h3 className="text-base font-semibold text-white">Lịch sử phiên bản</h3>
            <p className="text-xs text-gray-500 truncate max-w-[600px]">"{note.title}"</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Version list */}
          <div className="w-60 border-r border-gray-700/60 overflow-y-auto bg-gray-900/40">
            {loading && <p className="text-xs text-gray-500 p-3">Đang tải...</p>}
            {!loading && versions.length === 0 && (
              <p className="text-xs text-gray-500 p-3 text-center">Chưa có phiên bản nào.</p>
            )}
            {versions.map(v => {
              const isActive = active?.id === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => setActive(v)}
                  className={`w-full text-left px-3 py-2.5 border-b border-gray-700/40 transition-colors ${
                    isActive ? 'bg-blue-600/15 border-l-2 border-l-blue-500' : 'hover:bg-gray-700/30'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <EmployeeAvatar employeeId={v.editor_id} size={18} />
                    <span className="text-[11px] text-gray-300 truncate">{v.editor_id}</span>
                  </div>
                  <p className="text-[10px] text-gray-500">
                    {new Date(v.created_at).toLocaleString('vi-VN')}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Preview */}
          <div className="flex-1 flex flex-col min-w-0">
            {active ? (
              <>
                <div className="px-5 py-2 border-b border-gray-700/40 flex items-center justify-between flex-shrink-0">
                  <p className="text-xs text-gray-400">
                    {new Date(active.created_at).toLocaleString('vi-VN')} · {active.content_snapshot.length} ký tự
                  </p>
                  <button
                    onClick={() => setRestoreTarget(active)}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg"
                  >
                    ↩ Khôi phục phiên bản này
                  </button>
                </div>
                <pre className="flex-1 overflow-auto px-5 py-4 text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                  {active.content_snapshot}
                </pre>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
                Chọn phiên bản ở cột trái để xem
              </div>
            )}
          </div>
        </div>
      </div>

      {restoreTarget && (
        <ConfirmDialog
          message={`Khôi phục note về phiên bản lúc ${new Date(restoreTarget.created_at).toLocaleString('vi-VN')}? Nội dung hiện tại sẽ được snapshot trước khi ghi đè.`}
          confirmLabel={restoring ? 'Đang khôi phục...' : 'Khôi phục'}
          danger={false}
          onConfirm={doRestore}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}

