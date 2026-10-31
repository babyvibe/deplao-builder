import React, { useEffect, useState, useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAppStore } from '@/store/app/appStore';
import { AlertIcon, CheckIcon, ClipboardListIcon, CloseIcon, InboxIcon, SendIcon, SkipForwardIcon } from '@/components/common/icons';


interface Props {
  workflowId: string;
}

/** Format a value for display - truncate long strings, beautify JSON */
function formatValue(v: any, maxLen = 300): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') {
    if (v.length > maxLen) return v.substring(0, maxLen) + '...';
    return v;
  }
  if (typeof v === 'object') {
    try {
      const str = JSON.stringify(v, null, 2);
      if (str.length > maxLen * 2) return str.substring(0, maxLen * 2) + '\n...(truncated)';
      return str;
    } catch { return String(v); }
  }
  return String(v);
}

/** Collapsible inline node result with input/output details */
function NodeResultDetail({ nr, isLight }: { nr: any; isLight: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const nodeIcon = (s: string) => s === 'success' ? <CheckIcon className="w-3.5 h-3.5 inline text-green-500" /> : s === 'error' ? <CloseIcon className="w-3.5 h-3.5 inline text-red-500" /> : <SkipForwardIcon className="w-3.5 h-3.5 inline text-muted-foreground" />;

  const hasInput = nr.input && Object.keys(nr.input).length > 0 && nr.input._skipped !== true;
  const hasOutput = nr.output && Object.keys(nr.output).length > 0 && nr.output._skipped !== true;
  const hasError = nr.error || nr.output?._errorType;
  const bg = isLight ? 'bg-gray-100' : 'bg-card';

  return (
    <div className="mb-1">
      {/* Header row */}
      <button
        className="flex items-center gap-1.5 w-full text-left hover:opacity-80"
        onClick={() => setShowDetails(!showDetails)}
      >
        <span>{nodeIcon(nr.status)}</span>
        <span className={isLight ? 'text-gray-700' : 'text-foreground/80'}>{nr.label || nr.nodeType}</span>
        {nr.iteration ? <span className="text-muted-foreground">(lượt {nr.iteration})</span> : null}
        <span className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>{nr.durationMs}ms</span>
        {hasError && <span className="text-red-500 text-[10px] truncate max-w-[200px]">{nr.error || nr.output?._errorMessage}</span>}
        {(hasInput || hasOutput || hasError) && (
          <span className={`ml-auto text-[10px] ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {showDetails ? '▲' : '▼'} chi tiết
          </span>
        )}
      </button>

      {/* Expanded details */}
      {showDetails && (
        <div className={`ml-5 mt-0.5 p-2 rounded text-[10px] font-mono leading-relaxed ${bg}`}>
          {/* Error details */}
          {nr.output?._errorType && (
            <div className="mb-2 border-l-2 border-red-500 pl-2">
              <div className="text-red-500 font-semibold mb-0.5"><CloseIcon className="w-3 h-3 inline text-red-500" /> LỖI: {nr.output._errorType}</div>
              {nr.output._httpStatus && <div className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>HTTP {nr.output._httpStatus} {nr.output._httpStatusText}</div>}
              {nr.output._errorCode && <div className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>Code: {nr.output._errorCode}</div>}
              {nr.output._errorMessage && <div className="text-red-400">{nr.output._errorMessage}</div>}
              {nr.output._responseData && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-orange-500">Response body</summary>
                  <pre className="mt-0.5 whitespace-pre-wrap break-word max-h-32 overflow-y-auto">{formatValue(nr.output._responseData)}</pre>
                </details>
              )}
              {nr.output._requestSummary && <div className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>Request: {nr.output._requestSummary}</div>}
              {nr.output._stackTrace && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">Stack trace</summary>
                  <pre className="mt-0.5 whitespace-pre-wrap text-[9px] text-muted-foreground">{nr.output._stackTrace}</pre>
                </details>
              )}
            </div>
          )}

          {/* Input (rendered config) */}
          {hasInput && (
            <details className="mb-1">
              <summary className="cursor-pointer text-blue-500"><InboxIcon className="w-4 h-4 inline" /> Đầu vào (input)</summary>
              <pre className="mt-0.5 whitespace-pre-wrap break-word max-h-40 overflow-y-auto">{formatValue(nr.input)}</pre>
            </details>
          )}

          {/* Output (response data) */}
          {hasOutput && (
            <details>
              <summary className="cursor-pointer text-green-500"><SendIcon className="w-4 h-4 inline" /> Đầu ra (output)</summary>
              <pre className="mt-0.5 whitespace-pre-wrap break-word max-h-40 overflow-y-auto">{formatValue(nr.output)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
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
      // DataAccessor: chế độ nhân viên đọc lịch sử chạy trên Boss (IPC đọc DB cục bộ của máy nhân viên → trống)
      const res = await DataAccessor.getWorkflowRunLogs(workflowId, 30);
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

  const statusIcon = (s: string) => s === 'success' ? <CheckIcon className="w-3.5 h-3.5 inline text-green-500" /> : s === 'error' ? <CloseIcon className="w-3.5 h-3.5 inline text-red-500" /> : <AlertIcon className="w-3.5 h-3.5 inline text-yellow-500" />;

  if (!workflowId) return null;

  return (
    <div className={`border-t flex flex-col overflow-hidden transition-all duration-200 ${
      isLight ? 'border-gray-200 bg-gray-50' : 'border-border bg-background'
    } ${isCollapsed ? 'h-9' : 'h-48'}`}>
      {/* Header - always visible */}
      <div 
        className={`px-3 py-1.5 flex items-center justify-between cursor-pointer ${
          isLight 
            ? 'border-b border-gray-200 hover:bg-gray-100' 
            : 'border-b border-border hover:bg-card'
        }`}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className={`transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}`}>
            {isCollapsed ? '▲' : '▼'}
          </span>
          <span className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-foreground/80'}`}><ClipboardListIcon className="w-4 h-4 inline" /> Lịch sử chạy
          </span>
          {logs.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              isLight ? 'bg-gray-200 text-muted-foreground' : 'bg-muted text-muted-foreground'
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
                  ? 'text-muted-foreground hover:text-gray-700' 
                  : 'text-muted-foreground hover:text-foreground/80'
              }`}
            >
              {loading ? '...' : '↻ Refresh'}
            </button>
          )}
          <span className={`text-[10px] ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {isCollapsed ? 'Click để mở rộng' : 'Click để thu nhỏ'}
          </span>
        </div>
      </div>
      
      {/* Content - only visible when expanded */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto text-[11px]">
          {logs.length === 0 && (
            <p className={`text-center py-4 ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
              Chưa có lần chạy nào
            </p>
          )}
          {logs.map(log => (
            <div key={log.id} className={`border-b ${isLight ? 'border-gray-200' : 'border-border'}`}>
              <button
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                  isLight ? 'hover:bg-gray-100' : 'hover:bg-card'
                }`}
                onClick={() => toggleExpand(log.id)}
              >
                <span>{statusIcon(log.status)}</span>
                <span className={isLight ? 'text-gray-700' : 'text-foreground/80'}>
                  {new Date(log.started_at || log.startedAt).toLocaleTimeString('vi-VN')}
                </span>
                <span className={`font-medium ${log.status === 'success' ? 'text-green-500' : log.status === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>
                  {log.status}
                </span>
                <span className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>
                  {((log.finished_at || log.finishedAt) - (log.started_at || log.startedAt))}ms
                </span>
                <span className={`ml-auto ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
                  {log.triggered_by || log.triggeredBy}
                </span>
                <span className={isLight ? 'text-muted-foreground' : 'text-muted-foreground'}>
                  {expanded.has(log.id) ? '▴' : '▾'}
                </span>
              </button>
              {expanded.has(log.id) && (
                <div className="px-6 pb-2 space-y-0.5">
                  {log.errorMessage && (
                    <p className="text-red-500 text-[11px] mb-1"><AlertIcon className="w-3 h-3 inline" /> {log.errorMessage}</p>
                  )}
                  {/* Node trong "Lặp qua danh sách" có một dòng mỗi lượt → key theo vị trí */}
                  {(log.nodeResults || []).map((nr: any, i: number) => (
                    <NodeResultDetail key={`${nr.nodeId}-${i}`} nr={nr} isLight={isLight} />
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

