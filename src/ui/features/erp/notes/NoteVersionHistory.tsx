import React, { useEffect, useState } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { withErpDeniedNotice } from '@/store/erp/erpStoreHelpers';
import type { ErpNote, ErpNoteVersion } from '../../../../models/erp';
import { EmployeeAvatar } from '../shared/ErpBadges';
import { ConfirmDialog } from '../shared/ErpDialogs';
import PageLoading from '@/components/common/PageLoading';

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
      const res: any = await DataAccessor.erpNoteVersions(note.id);
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
      const res: any = withErpDeniedNotice(await DataAccessor.erpRestoreNoteVersion(restoreTarget.id, note.id));
      if (res?.success && res.note) onRestored?.(res.note);
      setRestoreTarget(null);
      onClose();
    } finally { setRestoring(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-[800px] h-[560px] flex flex-col shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
          <div>
            <h3 className="text-base font-semibold text-foreground">Lịch sử phiên bản</h3>
            <p className="text-xs text-muted-foreground truncate max-w-[600px]">"{note.title}"</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg">×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Version list */}
          <div className="w-60 border-r border-border/60 overflow-y-auto bg-background/40">
            {loading && <PageLoading variant="inline" size="sm" />}
            {!loading && versions.length === 0 && (
              <p className="text-xs text-muted-foreground p-3 text-center">Chưa có phiên bản nào.</p>
            )}
            {versions.map(v => {
              const isActive = active?.id === v.id;
              return (
                <button
                  key={v.id}
                  onClick={() => setActive(v)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/40 transition-colors ${
                    isActive ? 'bg-blue-600/15 border-l-2 border-l-blue-500' : 'hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <EmployeeAvatar employeeId={v.editor_id} size={18} />
                    <span className="text-[11px] text-foreground/80 truncate">{v.editor_id}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
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
                <div className="px-5 py-2 border-b border-border/40 flex items-center justify-between flex-shrink-0">
                  <p className="text-xs text-muted-foreground">
                    {new Date(active.created_at).toLocaleString('vi-VN')} · {active.content_snapshot.length} ký tự
                  </p>
                  <button
                    onClick={() => setRestoreTarget(active)}
                    className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg"
                  >
                    ↩ Khôi phục phiên bản này
                  </button>
                </div>
                <pre className="flex-1 overflow-auto px-5 py-4 text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed">
                  {active.content_snapshot}
                </pre>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
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

