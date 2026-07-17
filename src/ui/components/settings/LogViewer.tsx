import React, { useEffect, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';

type LogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug';
interface LogEntry { ts: number; level: LogLevel; msg: string; }

const LEVEL_STYLE: Record<LogLevel, string> = {
  error: 'text-red-400',
  warn:  'text-yellow-400',
  info:  'text-blue-400',
  debug: 'text-purple-400',
  log:   'text-gray-300',
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: 'LỖI', warn: 'CẢNH BÁO', info: 'INFO', debug: 'DEBUG', log: 'LOG',
};

const MAX_RENDER = 2000; // khớp buffer main

export default function LogViewer() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | LogLevel>('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Nạp buffer sẵn có + lắng nghe log mới
  useEffect(() => {
    ipc.logs?.getBuffer().then((buf: LogEntry[]) => setEntries(buf || [])).catch(() => {});
    const unsub = ipc.on?.('log:entry', (entry: LogEntry) => {
      setEntries(prev => {
        const next = [...prev, entry];
        return next.length > MAX_RENDER ? next.slice(next.length - MAX_RENDER) : next;
      });
    });
    return () => { unsub?.(); };
  }, []);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [entries, autoScroll]);

  const visible = entries.filter(e => {
    if (filter !== 'all' && e.level !== filter) return false;
    if (search.trim() && !e.msg.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const fmt = (ts: number) => new Date(ts).toLocaleTimeString('vi-VN', { hour12: false }) +
    '.' + String(ts % 1000).padStart(3, '0');

  const handleClear = async () => {
    await ipc.logs?.clear().catch(() => {});
    setEntries([]);
  };

  const handleCopy = () => {
    const text = visible.map(e => `[${fmt(e.ts)}] [${LEVEL_LABEL[e.level]}] ${e.msg}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const handleExport = () => {
    const text = visible.map(e => `[${new Date(e.ts).toISOString()}] [${LEVEL_LABEL[e.level]}] ${e.msg}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deplao-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const FILTERS: ('all' | LogLevel)[] = ['all', 'error', 'warn', 'info', 'log', 'debug'];

  return (
    // Chiều cao cố định theo viewport để vùng list cuộn độc lập (parent Settings đã overflow-y-auto)
    <div className="flex flex-col h-[calc(100vh-120px)]">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Nhật ký hệ thống</h2>
        <p className="text-xs text-gray-400 mb-3">Theo dõi mọi hoạt động (gửi tin, thêm liên hệ, lỗi…) theo thời gian thực.</p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-2 flex-wrap flex-shrink-0">
        <div className="flex gap-1">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                filter === f ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}>
              {f === 'all' ? 'Tất cả' : LEVEL_LABEL[f]}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tìm trong log..."
          className="flex-1 min-w-[120px] bg-gray-700 border border-gray-600 rounded-lg px-3 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
        <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="accent-blue-500" />
          Tự cuộn
        </label>
        <button onClick={handleCopy} className="text-xs px-2.5 py-1 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600">Copy</button>
        <button onClick={handleExport} className="text-xs px-2.5 py-1 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600">Xuất file</button>
        <button onClick={handleClear} className="text-xs px-2.5 py-1 rounded-lg bg-red-600/80 text-white hover:bg-red-600">Xóa</button>
      </div>

      <div className="text-[11px] text-gray-500 mb-1 flex-shrink-0">{visible.length} / {entries.length} dòng</div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto bg-gray-900 rounded-lg border border-gray-700 p-2 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <p className="text-gray-500 text-center py-8">Chưa có log nào phù hợp</p>
        ) : visible.map((e, i) => (
          <div key={i} className="flex gap-2 py-0.5 hover:bg-gray-800/50 rounded px-1">
            <span className="text-gray-500 flex-shrink-0">{fmt(e.ts)}</span>
            <span className={`flex-shrink-0 w-16 ${LEVEL_STYLE[e.level]}`}>{LEVEL_LABEL[e.level]}</span>
            <span className={`whitespace-pre-wrap break-all ${LEVEL_STYLE[e.level]}`}>{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
