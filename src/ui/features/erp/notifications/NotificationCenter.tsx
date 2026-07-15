import React, { useEffect, useState } from 'react';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import { useUpdateStore } from '@/store/updateStore';
import { DownloadIcon, MonitorIcon, RefreshIcon, SparklesIcon } from '@/components/common/icons';


interface Props { onClose?: () => void; }

export default function NotificationCenter({ onClose }: Props) {
  const eid = useCurrentEmployeeId();
  const erpPerms = useErpPermissions();
  const { inbox, loadInbox, markRead, markAllRead, deleteNotifications, deleteAllNotifications } = useErpNotificationStore();
  const { status, updateInfo, progress, platform, setShowPopup, openUpdatePopup } = useUpdateStore();
  const isMac = platform === 'darwin';
  const hasUpdate = !!updateInfo && status === 'available';

  useEffect(() => {
    if (erpPerms.can('erp.access')) loadInbox(eid);
  }, [eid]);

  const groups = groupByDay(inbox);
  const hasErpNotifs = erpPerms.can('erp.access') && inbox.length > 0;
  const isEmpty = !hasUpdate && !hasErpNotifs;

  const updateStatusLabel = () => {
    switch (status) {
      case 'downloaded': return { text: 'Đã tải xong – sẵn sàng cài đặt', color: 'text-green-400' };
      case 'downloading': return { text: progress ? `Đang tải… ${progress.percent.toFixed(0)}%` : 'Đang tải…', color: 'text-blue-300' };
      case 'error':      return { text: 'Tải thất bại – nhấn để thử lại', color: 'text-red-400' };
      default:           return { text: 'Bản cập nhật mới sẵn sàng', color: 'text-yellow-300' };
    }
  };

  const handleUpdateAction = () => {
    openUpdatePopup();
  };

  return (
    <div className="w-80 max-h-[520px] bg-gray-800 border border-gray-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="text-sm font-semibold text-white">Thông báo</span>
        <div className="flex items-center gap-2">
          {hasErpNotifs && (
            <>
              <button
                onClick={() => markAllRead(eid)}
                className="text-[11px] text-gray-400 hover:text-white"
                title="Đánh dấu tất cả đã đọc"
              >Đọc hết</button>
              <button
                onClick={() => deleteAllNotifications(eid)}
                className="text-[11px] text-gray-400 hover:text-red-400"
                title="Xoá tất cả thông báo"
              >Xoá hết</button>
            </>
          )}
          {onClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xs" title="Đóng">✕</button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── App update item ── */}
        {hasUpdate && updateInfo && (
          <div className="border-b border-gray-700 bg-blue-950/40 p-3">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 w-8 h-8 flex-shrink-0 rounded-full bg-orange-500/20 flex items-center justify-center text-base"><SparklesIcon className="w-4 h-4" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold text-white">Phiên bản {updateInfo.version}</span>
                </div>
                <div className={`text-[11px] mt-0.5 ${updateStatusLabel().color}`}>
                  {updateStatusLabel().text}
                </div>
                <div className="mt-2">
                  <button
                    onClick={handleUpdateAction}
                    className="w-full py-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-semibold transition-colors"
                  >
                    <DownloadIcon className="w-4 h-4 inline" /> Xem cập nhật
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── ERP notifications ── */}
        {erpPerms.can('erp.access') && (
          <>
            {groups.length === 0 && !hasUpdate && (
              <div className="p-6 text-center text-gray-400 text-xs">Chưa có thông báo</div>
            )}
            {groups.length === 0 && hasUpdate && (
              <div className="p-3 text-center text-gray-400 text-[11px]">Không có thông báo ERP</div>
            )}
            {groups.map(g => (
              <div key={g.label}>
                <div className="sticky top-0 px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-800/95">
                  {g.label}
                </div>
                {g.items.map(n => (
                  <button
                    key={n.id}
                    onClick={() => !n.read && markRead([n.id])}
                    className={`w-full text-left px-3 py-2 border-b border-gray-700/40 hover:bg-gray-700/60 flex items-start gap-2 group ${n.read ? 'opacity-60' : ''}`}
                  >
                    {!n.read && <span className="mt-1 w-1.5 h-1.5 bg-blue-400 rounded-full flex-shrink-0" />}
                    {n.read && <span className="mt-1 w-1.5 h-1.5 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-200 font-medium truncate">{n.title}</div>
                      {n.body && <div className="text-[11px] text-gray-400 truncate">{n.body}</div>}
                      <div className="text-[10px] text-gray-400 mt-0.5">{formatTime(n.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {!n.read && (
                        <button
                          onClick={(e) => { e.stopPropagation(); markRead([n.id]); }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-blue-500/20 text-gray-400 hover:text-blue-400 transition-all"
                          title="Đánh dấu đã đọc"
                        >
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteNotifications([n.id]); }}
                        className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-all"
                        title="Xoá thông báo này"
                      >
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}

        {!erpPerms.can('erp.access') && isEmpty && (
          <div className="p-6 text-center text-gray-400 text-xs">Chưa có thông báo</div>
        )}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Vừa xong';
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} giờ trước`;
  const today = new Date(); today.setHours(0,0,0,0);
  const dDay = new Date(d); dDay.setHours(0,0,0,0);
  if (dDay.getTime() === today.getTime()) return `Hôm nay ${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (dDay.getTime() === yest.getTime()) return `Hôm qua ${d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
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
    else label = d.toLocaleDateString('vi-VN');
    let grp = out.find(g => g.label === label);
    if (!grp) { grp = { label, items: [] }; out.push(grp); }
    grp.items.push(n);
  }
  return out;
}
