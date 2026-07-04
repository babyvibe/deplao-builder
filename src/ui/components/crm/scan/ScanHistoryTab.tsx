import React, { useEffect, useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { SCAN_TAB_LABELS } from './ScanSessionTypes';
import { Spinner } from '@/components/common/PageLoading';

interface Props {
  accountId: string;
}

interface TabOption {
  id: string;
  name: string;
}

export default function ScanHistoryTab({ accountId }: Props) {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [tabs, setTabs] = useState<TabOption[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<string>('');
  const pageSize = 20;

  // ─── Load tabs for filter dropdown ─────────────────────────────
  useEffect(() => {
    if (!accountId) return;
    (async () => {
      try {
        const res = await ipc.fb?.scanGetTabs({ accountId, status: 'active', limit: 100 });
        if (res?.success) {
          setTabs((res.tabs || []).map((t: any) => ({ id: t.id, name: t.name })));
        }
      } catch {}
    })();
  }, [accountId]);

  // ─── Load logs ─────────────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const params: any = { accountId, limit: pageSize, offset: page * pageSize };
      if (selectedTabId) params.tabId = selectedTabId;
      const res = await ipc.fb?.getScanLogs(params);
      if (res?.success) {
        setLogs(res.logs || []);
        setTotal(res.total || 0);
      }
    } catch {}
    setLoading(false);
  }, [accountId, page, selectedTabId]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  // ─── Reset page when tab filter changes ────────────────────────
  useEffect(() => { setPage(0); }, [selectedTabId]);

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const truncate = (str: string, len: number) => str?.length > len ? str.slice(0, len) + '...' : str;

  const getScanTypeLabel = (type: string) => {
    const info = (SCAN_TAB_LABELS as any)[type];
    return info ? `${info.icon} ${info.label}` : type;
  };

  const formatPayload = (payload: string) => {
    if (!payload || payload === '{}') return null;
    try {
      const p = JSON.parse(payload);
      const sanitized = { ...p };
      if (sanitized.fb_dtsg) sanitized.fb_dtsg = sanitized.fb_dtsg.slice(0, 8) + '...';
      if (sanitized.cookie) sanitized.cookie = '(hidden)';
      if (sanitized.params?.fb_dtsg) sanitized.params.fb_dtsg = sanitized.params.fb_dtsg.slice(0, 8) + '...';
      return JSON.stringify(sanitized, null, 2);
    } catch { return payload; }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-850 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-white">📋 Lịch sử quét</h3>
          <span className="text-[11px] text-gray-500">({total} bản ghi)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadLogs} className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white" title="Làm mới">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700/50 bg-gray-850/60 flex-shrink-0">
        <label className="text-[11px] text-gray-500 whitespace-nowrap">🔍 Lọc theo tab:</label>
        <select
          value={selectedTabId}
          onChange={(e) => setSelectedTabId(e.target.value)}
          className="bg-gray-700 text-gray-200 text-xs rounded-lg px-3 py-1.5 border border-gray-600/50 focus:outline-none focus:border-blue-500 min-w-[180px]"
        >
          <option value="">📋 Tất cả các tab</option>
          {tabs.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {selectedTabId && (
          <button
            onClick={() => setSelectedTabId('')}
            className="text-[11px] text-gray-500 hover:text-white px-2 py-1 rounded hover:bg-gray-700"
          >
            ✕ Bỏ lọc
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Spinner size={6} />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            {selectedTabId ? 'Tab này chưa có lịch sử quét' : 'Chưa có lịch sử quét'}
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {logs.map(log => (
              <div key={log.id}
                onClick={() => setSelectedLog(selectedLog?.id === log.id ? null : log)}
                className={`px-4 py-3 cursor-pointer transition-colors hover:bg-gray-800/60 ${selectedLog?.id === log.id ? 'bg-gray-800' : ''}`}
              >
                {/* Row 1: Status + Scan type + Time */}
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${log.status === 'success' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                    {log.status === 'success' ? '✓' : '✗'}
                  </span>
                  <span className="text-xs font-semibold text-gray-300">{getScanTypeLabel(log.scanType)}</span>
                  <span className="text-[10px] text-gray-500">{formatDate(log.createdAt)}</span>
                  {log.itemsCount > 0 && (
                    <span className="text-[10px] text-blue-400 ml-auto font-mono">{log.itemsCount} items</span>
                  )}
                </div>

                {/* Row 2: Tab name + Input */}
                <div className="mt-1 flex items-center gap-2 text-[11px]">
                  {log.tabName && (
                    <span className="text-purple-400 bg-purple-900/30 rounded px-1.5 py-0.5 font-medium">
                      📁 {log.tabName}
                    </span>
                  )}
                  {log.input && (
                    <span className="text-gray-500 truncate flex-1" title={log.input}>
                      📥 <span className="text-gray-400">{truncate(log.input, 80)}</span>
                    </span>
                  )}
                </div>

                {/* Expand detail */}
                {selectedLog?.id === log.id && (
                  <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-2">
                    {/* Error */}
                    {log.error && (
                      <div className="text-[11px] text-red-400 bg-red-900/20 rounded px-2 py-1.5 break-words">
                        ❌ {log.error}
                      </div>
                    )}

                    {/* Info grid */}
                    <div className="grid grid-cols-3 gap-2 text-[10px] text-gray-400 bg-gray-850 rounded-lg p-2">
                      <div><span className="text-gray-500">DocId:</span> <span className="text-gray-300 font-mono">{log.docId || '-'}</span></div>
                      <div><span className="text-gray-500">Threads:</span> <span className="text-gray-300">{log.threadCount}</span></div>
                      <div><span className="text-gray-500">Items:</span> <span className="text-blue-400 font-mono">{log.itemsCount}</span></div>
                    </div>
                    {log.requestHeaders && (
                      <div>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <span>📤 Request headers</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(log.requestHeaders || ''); }}
                            className="text-blue-500 hover:text-blue-400"
                          >
                            [Copy]
                          </button>
                        </div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all border border-gray-700/30">
                          {log.requestHeaders}
                        </pre>
                      </div>
                    )}

                    {log.responseHeaders && (
                      <div>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <span>📥 Response headers</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(log.responseHeaders || ''); }}
                            className="text-blue-500 hover:text-blue-400"
                          >
                            [Copy]
                          </button>
                        </div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all border border-gray-700/30">
                          {log.responseHeaders}
                        </pre>
                      </div>
                    )}
                    {/* Request payload */}
                    {formatPayload(log.requestPayload) && (
                      <div>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <span>📤 Request payload</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(formatPayload(log.requestPayload) || ''); }}
                            className="text-blue-500 hover:text-blue-400"
                          >
                            [Copy]
                          </button>
                        </div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all border border-gray-700/30">
                          {formatPayload(log.requestPayload)}
                        </pre>
                      </div>
                    )}

                    {/* Response preview */}
                    {log.responsePreview && (
                      <div>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-1">
                          <span>📥 Response preview</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(log.responsePreview); }}
                            className="text-blue-500 hover:text-blue-400"
                          >
                            [Copy]
                          </button>
                        </div>
                        <pre className="text-[10px] text-gray-400 bg-gray-850 rounded p-2 overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all border border-gray-700/30">
                          {log.responsePreview}
                        </pre>
                      </div>
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
