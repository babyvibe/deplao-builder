import React, { useEffect, useState, useCallback } from 'react';
import ipc from '../../lib/ipc';
import { useAppStore } from '@/store/appStore';

interface Props {
  workflowId: string;
}

export default function RunHistoryPanel({ workflowId }: Props) {
  const [logs, setLogs] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true); // Default collapsed
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';

  const load = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const res = await ipc.workflow?.getLogs(workflowId, 30);
      if (res?.success) setLogs(res.logs);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    load();
    const unsub = window.electronAPI?.on('workflow:executed', (data: any) => {
      if (data?.workflowId === workflowId) load();
    });
    return () => unsub?.();
  }, [workflowId, load]);

  const toggleExpand = (id: string) => {
    setExpanded(p => { const next = new Set(p); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const statusIcon = (s: string) => s === 'success' ? '✅' : s === 'error' ? '❌' : '⚠️';
  const nodeIcon = (s: string) => s === 'success' ? '✅' : s === 'error' ? '❌' : '⏭️';

  if (!workflowId) return null;

  return (
    <div className={`border-t flex flex-col overflow-hidden transition-all duration-200 ${
      isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900'
    } ${isCollapsed ? 'h-9' : 'h-48'}`}>
      {/* Header - always visible */}
      <div 
        className={`px-3 py-1.5 flex items-center justify-between cursor-pointer ${
          isLight 
            ? 'border-b border-gray-200 hover:bg-gray-100' 
            : 'border-b border-gray-700 hover:bg-gray-800'
        }`}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className={`transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}`}>
            {isCollapsed ? '▲' : '▼'}
          </span>
          <span className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
            📋 Lịch sử chạy
          </span>
          {logs.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-400'
            }`}>
              {logs.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isCollapsed && (
            <button 
              onClick={(e) => { e.stopPropagation(); load(); }} 
              disabled={loading} 
              className={`text-xs transition-colors ${
                isLight 
                  ? 'text-gray-500 hover:text-gray-700' 
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {loading ? '...' : '↻ Refresh'}
            </button>
          )}
          <span className={`text-[10px] ${isLight ? 'text-gray-400' : 'text-gray-600'}`}>
            {isCollapsed ? 'Click để mở rộng' : 'Click để thu nhỏ'}
          </span>
        </div>
      </div>
      
      {/* Content - only visible when expanded */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto text-[11px]">
          {logs.length === 0 && (
            <p className={`text-center py-4 ${isLight ? 'text-gray-400' : 'text-gray-600'}`}>
              Chưa có lần chạy nào
            </p>
          )}
          {logs.map(log => (
            <div key={log.id} className={`border-b ${isLight ? 'border-gray-200' : 'border-gray-800'}`}>
              <button
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                  isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-800'
                }`}
                onClick={() => toggleExpand(log.id)}
              >
                <span>{statusIcon(log.status)}</span>
                <span className={isLight ? 'text-gray-700' : 'text-gray-300'}>
                  {new Date(log.started_at || log.startedAt).toLocaleTimeString('vi-VN')}
                </span>
                <span className={`font-medium ${log.status === 'success' ? 'text-green-500' : log.status === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>
                  {log.status}
                </span>
                <span className={isLight ? 'text-gray-400' : 'text-gray-500'}>
                  {((log.finished_at || log.finishedAt) - (log.started_at || log.startedAt))}ms
                </span>
                <span className={`ml-auto ${isLight ? 'text-gray-400' : 'text-gray-600'}`}>
                  {log.triggered_by || log.triggeredBy}
                </span>
                <span className={isLight ? 'text-gray-400' : 'text-gray-600'}>
                  {expanded.has(log.id) ? '▴' : '▾'}
                </span>
              </button>
              {expanded.has(log.id) && (
                <div className="px-6 pb-2 space-y-0.5">
                  {log.errorMessage && (
                    <p className="text-red-500 text-[11px] mb-1">⚠ {log.errorMessage}</p>
                  )}
                  {(log.nodeResults || []).map((nr: any) => (
                    <div key={nr.nodeId} className="flex items-start gap-2">
                      <span>{nodeIcon(nr.status)}</span>
                      <span className={isLight ? 'text-gray-600' : 'text-gray-400'}>{nr.label || nr.nodeType}</span>
                      <span className={isLight ? 'text-gray-400' : 'text-gray-600'}>{nr.durationMs}ms</span>
                      {nr.error && <span className="text-red-500 truncate">{nr.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

