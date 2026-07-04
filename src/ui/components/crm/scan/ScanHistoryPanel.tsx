import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';

interface Props {
  accountId: string;
  tabId?: string;
  tabName?: string;
  onClose: () => void;
  onRestoreInput?: (log: any) => void;
}

export default function ScanHistoryPanel({ accountId, tabId, tabName, onClose, onRestoreInput }: Props) {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const pageSize = 20;

  const loadLogs = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const res = await ipc.fb?.getScanLogs({ accountId, tabId, limit: pageSize, offset: page * pageSize });
      if (res?.success) {
        setLogs(res.logs || []);
        setTotal(res.total || 0);
      }
    } catch {}
    setLoading(false);
  }, [accountId, tabId, page]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const truncate = (str: string, len: number) => str?.length > len ? str.slice(0, len) + '...' : str;

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-850 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-white">📋 {tabId ? `Lịch sử: ${tabName || 'Tab'}` : 'Lịch sử quét'}</h3>
          <span className="text-[11px] text-gray-500">({total} bản ghi)</span>
        </div>
        <button onClick={loadLogs} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="Làm mới">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/>
          </svg>
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Spinner size={6} />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Chưa có lịch sử quét
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {logs.map(log => (
              <div key={log.id}
                onClick={() => setSelectedLog(selectedLog?.id === log.id ? null : log)}
                className={`px-4 py-2.5 cursor-pointer transition-colors hover:bg-gray-800/60 ${selectedLog?.id === log.id ? 'bg-gray-800' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${log.status === 'success' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                    {log.status === 'success' ? '✓' : '✗'}
                  </span>
                  <span className="text-xs font-medium text-gray-300">{log.scanType}</span>
                  <span className="text-[10px] text-gray-500">{formatDate(log.createdAt)}</span>
                  {log.itemsCount > 0 && (
                    <span className="text-[10px] text-blue-400 ml-auto">{log.itemsCount} items</span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-gray-500 truncate">{truncate(log.input, 80)}</div>

                {/* Expand detail */}
                {selectedLog?.id === log.id && (
                  <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-1.5">
                    {log.error && (
                      <div className="text-[11px] text-red-400 bg-red-900/20 rounded px-2 py-1">
                        ❌ {log.error}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400">
                      <div><span className="text-gray-500">DocId:</span> {log.docId || '-'}</div>
                      <div><span className="text-gray-500">Threads:</span> {log.threadCount}</div>
                    </div>
                    {log.requestHeaders && (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-1">📤 Request headers:</div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
                          {log.requestHeaders}
                        </pre>
                      </div>
                    )}
                    {log.responseHeaders && (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-1">📥 Response headers:</div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
                          {log.responseHeaders}
                        </pre>
                      </div>
                    )}
                    {log.requestPayload && log.requestPayload !== '{}' && (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-1">📤 Request payload:</div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
                          {(() => {
                            try {
                              const p = JSON.parse(log.requestPayload);
                              // Che dấu sensitive fields
                              const sanitized = { ...p };
                              if (sanitized.fb_dtsg) sanitized.fb_dtsg = sanitized.fb_dtsg.slice(0, 8) + '...';
                              if (sanitized.cookie) sanitized.cookie = '(hidden)';
                              return JSON.stringify(sanitized, null, 2);
                            } catch { return log.requestPayload; }
                          })()}
                        </pre>
                      </div>
                    )}
                    {log.responsePreview && (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-1">📥 Response preview:</div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[100px] overflow-y-auto whitespace-pre-wrap break-all">
                          {log.responsePreview}
                        </pre>
                      </div>
                    )}
                    {onRestoreInput && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRestoreInput(log); }}
                        className="text-[10px] text-blue-400 hover:text-blue-300 mt-1"
                      >
                        🔄 Khôi phục input
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700 bg-gray-850 flex-shrink-0">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="px-2.5 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30">◀</button>
          <span className="text-xs text-gray-400">{page + 1} / {Math.ceil(total / pageSize)}</span>
          <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * pageSize >= total}
            className="px-2.5 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30">▶</button>
        </div>
      )}
    </div>
  );
}
