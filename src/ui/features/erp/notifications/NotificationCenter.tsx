import React, { useEffect } from 'react';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useCurrentEmployeeId } from '@/hooks/erp/useErpContext';

interface Props { onClose?: () => void; }

export default function NotificationCenter({ onClose }: Props) {
  const eid = useCurrentEmployeeId();
  const { inbox, loadInbox, markRead, markAllRead } = useErpNotificationStore();

  useEffect(() => { loadInbox(eid); }, [eid]);

  const groups = groupByDay(inbox);

  return (
    <div className="w-96 max-h-[500px] bg-gray-800 border border-gray-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="text-sm font-semibold text-white">Thông báo</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => markAllRead(eid)}
            className="text-[11px] text-gray-400 hover:text-white"
            title="Đánh dấu tất cả đã đọc"
          >Đọc hết</button>
          {onClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-white" title="Đóng">✕</button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {inbox.length === 0 && (
          <div className="p-6 text-center text-gray-500 text-xs">Chưa có thông báo</div>
        )}
        {groups.map(g => (
          <div key={g.label}>
            <div className="sticky top-0 px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500 bg-gray-800/95">
              {g.label}
            </div>
            {g.items.map(n => (
              <button
                key={n.id}
                onClick={() => !n.read && markRead([n.id])}
                className={`w-full text-left px-3 py-2 border-b border-gray-700/40 hover:bg-gray-700/60 flex items-start gap-2 ${
                  n.read ? 'opacity-60' : ''
                }`}
              >
                {!n.read && <span className="mt-1 w-1.5 h-1.5 bg-blue-400 rounded-full flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-200 font-medium truncate">{n.title}</div>
                  {n.body && <div className="text-[11px] text-gray-400 truncate">{n.body}</div>}
                  <div className="text-[10px] text-gray-500 mt-0.5">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function groupByDay(items: any[]) {
  const out: { label: string; items: any[] }[] = [];
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  for (const n of items) {
    const d = new Date(n.created_at); d.setHours(0,0,0,0);
    let label: string;
    if (d.getTime() === today.getTime()) label = 'Hôm nay';
    else if (d.getTime() === yest.getTime()) label = 'Hôm qua';
    else label = d.toLocaleDateString();
    let grp = out.find(g => g.label === label);
    if (!grp) { grp = { label, items: [] }; out.push(grp); }
    grp.items.push(n);
  }
  return out;
}

