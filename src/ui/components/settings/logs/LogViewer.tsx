import React, { useEffect, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import { Button, Input } from '@/components/ui';
import { SegmentedControl, SettingsPage } from '../settingsUi';

type LogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug';
interface LogEntry { ts: number; level: LogLevel; msg: string; }

const LEVEL_STYLE: Record<LogLevel, string> = {
  error: 'text-destructive',
  warn:  'text-warning',
  info:  'text-info',
  debug: 'text-subtle-foreground',
  log:   'text-foreground/80',
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: 'LỖI', warn: 'CẢNH BÁO', info: 'INFO', debug: 'DEBUG', log: 'LOG',
};

// Nút lọc: chữ thường cho dễ đọc (nhãn in hoa ở trên chỉ dùng trong dòng log)
const FILTER_LABEL: Record<'all' | LogLevel, string> = {
  all: 'Tất cả', error: 'Lỗi', warn: 'Cảnh báo', info: 'Info', log: 'Log', debug: 'Debug',
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
    // Trang cao đúng khung: vùng log tự cuộn, thanh công cụ đứng yên
    <SettingsPage
      title="Nhật ký"
      description="Hoạt động của app theo thời gian thực (gửi tin, kết nối, lỗi…). Gửi kèm khi báo lỗi."
      width="full"
      fill
    >
      <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-2">
        <SegmentedControl
          label="Lọc theo mức"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map(f => ({ value: f, label: FILTER_LABEL[f] }))}
        />
        <Input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tìm trong nhật ký..." aria-label="Tìm trong nhật ký"
          className="h-8 min-w-[160px] flex-1 text-xs" />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="accent-primary" />
          Tự cuộn
        </label>
        <Button variant="outline" size="sm" onClick={handleCopy}>Sao chép</Button>
        <Button variant="outline" size="sm" onClick={handleExport}>Xuất file</Button>
        <Button variant="ghost" size="sm" onClick={handleClear} className="text-destructive hover:bg-destructive/10 hover:text-destructive">Xoá</Button>
      </div>

      <div className="mb-1 flex-shrink-0 text-[11px] text-subtle-foreground">{visible.length} / {entries.length} dòng</div>

      {/* Log list */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-card p-2 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <p className="py-8 text-center font-sans text-xs text-subtle-foreground">Chưa có dòng nào phù hợp</p>
        ) : visible.map((e, i) => (
          <div key={i} className="flex gap-2 rounded px-1 py-0.5 hover:bg-muted">
            <span className="flex-shrink-0 text-subtle-foreground">{fmt(e.ts)}</span>
            <span className={`w-16 flex-shrink-0 ${LEVEL_STYLE[e.level]}`}>{LEVEL_LABEL[e.level]}</span>
            <span className={`whitespace-pre-wrap break-all ${LEVEL_STYLE[e.level]}`}>{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </SettingsPage>
  );
}
