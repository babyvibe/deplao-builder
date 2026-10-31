/**
 * AutoMarkReadModal - "Tự động đánh dấu đã đọc" (menu ⋮ → Tự động).
 *
 * Choose the time range of the conversations' last message (default: all), preview how many unread
 * conversations match, then run: one by one, mark read in the app (DB) and on the platform when it
 * has an API. The job keeps running in the background when the popup is closed ("Chạy nền").
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircleIcon, CloseIcon } from '@/components/common/icons';
import DateInputVN from '@/components/common/inputs/DateInputVN';
import { Spinner } from '@/components/common/PageLoading';
import { useAutoReadStore, AutoReadConversation } from '@/store/chat/autoReadStore';
import {
  AUTO_READ_PRESETS, AutoReadPreset, isValidAutoReadRange, resolveAutoReadRange,
} from '@/lib/chat/read/autoMarkRead';

interface Props {
  /** Accounts in scope (active account, or the merged inbox accounts of the selected channel). */
  accountIds: string[];
  /** "Shop A", "3 tài khoản"… */
  scopeLabel: string;
  onClose: () => void;
}

export default function AutoMarkReadModal({ accountIds, scopeLabel, onClose }: Props) {
  const { job, find, start, stop, reset } = useAutoReadStore(useShallow(s => ({
    job: s.job, find: s.find, start: s.start, stop: s.stop, reset: s.reset,
  })));
  const [preset, setPreset] = useState<AutoReadPreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [includeOthers, setIncludeOthers] = useState(true);
  const [syncPlatform, setSyncPlatform] = useState(true);
  const [matches, setMatches] = useState<AutoReadConversation[] | null>(null);
  const [scanning, setScanning] = useState(false);
  // Show progress / summary only for a job started from this popup (or still running)
  const [showJob, setShowJob] = useState(job.status === 'running');
  const scanRef = useRef(0);

  const range = useMemo(() => resolveAutoReadRange(preset, { from: customFrom, to: customTo }), [preset, customFrom, customTo]);
  const rangeValid = isValidAutoReadRange(range);
  const accountsKey = accountIds.join(',');

  // Preview: unread conversations matching the options (debounced)
  useEffect(() => {
    if (showJob) return;
    if (!rangeValid || accountIds.length === 0) { setMatches([]); return; }
    const scanId = ++scanRef.current;
    setScanning(true);
    const timer = setTimeout(() => {
      find({ accountIds, range, includeOthers })
        .then(list => { if (scanId === scanRef.current) setMatches(list); })
        .catch(() => { if (scanId === scanRef.current) setMatches([]); })
        .finally(() => { if (scanId === scanRef.current) setScanning(false); });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, range.from, range.to, rangeValid, includeOthers, showJob]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startJob = () => {
    if (!matches?.length) return;
    start(matches, { syncPlatform });
    setShowJob(true);
  };

  const running = job.status === 'running';
  const finished = showJob && (job.status === 'done' || job.status === 'stopped');
  const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const byChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of matches || []) counts.set(item.channel, (counts.get(item.channel) || 0) + 1);
    return [...counts.entries()];
  }, [matches]);
  const channelName: Record<string, string> = { zalo: 'Zalo', facebook: 'Facebook', telegram_user: 'Telegram', telegram_bot: 'Telegram Bot' };

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm pointer-events-none" />
      <div className="relative w-[480px] max-w-[96vw] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <span className="w-9 h-9 rounded-xl bg-blue-500/15 text-blue-500 flex items-center justify-center flex-shrink-0">
            <CheckCircleIcon className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-foreground">Tự động đánh dấu đã đọc</p>
            <p className="text-xs text-muted-foreground truncate">Phạm vi: {scopeLabel}</p>
          </div>
          <button type="button" onClick={onClose} title={running ? 'Đóng - vẫn chạy nền' : 'Đóng (Esc)'}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {showJob && (running || finished) ? (
          /* ── Progress / summary ── */
          <div className="px-5 py-5 space-y-4">
            {running ? (
              <>
                <div>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="text-foreground font-medium">Đang đánh dấu {job.done}/{job.total}</span>
                    <span className="text-muted-foreground tabular-nums">{percent}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground truncate">{job.current ? `Hội thoại: ${job.current}` : 'Đang chuẩn bị…'}</p>
                </div>
              </>
            ) : (
              <div className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-full bg-green-500/15 text-green-500 flex items-center justify-center flex-shrink-0">
                  <CheckCircleIcon className="w-5 h-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {job.status === 'stopped' ? `Đã dừng sau ${job.done}/${job.total} hội thoại` : `Đã đánh dấu đã đọc ${job.done} hội thoại`}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Trong {Math.max(1, Math.round((job.finishedAt - job.startedAt) / 1000))} giây
                  </p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-border px-2 py-2">
                <p className="text-lg font-semibold text-foreground tabular-nums">{job.synced}</p>
                <p className="text-[11px] text-muted-foreground">Đã đồng bộ nền tảng</p>
              </div>
              <div className="rounded-xl border border-border px-2 py-2">
                <p className="text-lg font-semibold text-foreground tabular-nums">{job.appOnly}</p>
                <p className="text-[11px] text-muted-foreground">Chỉ trong app</p>
              </div>
              <div className="rounded-xl border border-border px-2 py-2">
                <p className={`text-lg font-semibold tabular-nums ${job.failed ? 'text-red-500' : 'text-foreground'}`}>{job.failed}</p>
                <p className="text-[11px] text-muted-foreground">Lỗi đồng bộ</p>
              </div>
            </div>
            {job.errors.length > 0 && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 max-h-28 overflow-y-auto">
                {job.errors.slice(0, 8).map((err, i) => (
                  <p key={i} className="text-[11.5px] text-foreground/80 truncate" title={`${err.name}: ${err.error}`}>
                    <b className="font-medium">{err.name}</b>: {err.error}
                  </p>
                ))}
              </div>
            )}
            {running && (
              <p className="text-[11.5px] text-muted-foreground">
                Có thể đóng cửa sổ này - tiến trình vẫn chạy nền (xem tiến độ ở menu ⋮). Lỗi đồng bộ không ảnh hưởng: hội thoại vẫn được đánh dấu đã đọc trong app.
              </p>
            )}
          </div>
        ) : (
          /* ── Options ── */
          <div className="px-5 py-4 space-y-4">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Thời gian tin nhắn cuối</p>
              <div className="flex flex-wrap gap-1.5">
                {AUTO_READ_PRESETS.map(option => (
                  <button key={option.id} type="button" onClick={() => setPreset(option.id)}
                    className={`h-8 px-3 rounded-full text-xs font-medium border transition-colors ${
                      preset === option.id
                        ? 'bg-blue-600 border-blue-600 text-white-important'
                        : 'border-border text-foreground/80 hover:bg-muted'
                    }`}>
                    {option.label}
                  </button>
                ))}
              </div>
              {preset === 'custom' && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted-foreground">
                    Từ ngày
                    <DateInputVN value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)}
                      className="mt-1 w-full h-9 px-2 rounded-lg border border-input bg-background text-sm text-foreground" />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    Đến ngày
                    <DateInputVN value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)}
                      className="mt-1 w-full h-9 px-2 rounded-lg border border-input bg-background text-sm text-foreground" />
                  </label>
                  {!rangeValid && <p className="col-span-2 text-xs text-red-500">"Từ ngày" phải trước "Đến ngày".</p>}
                  {rangeValid && !customFrom && !customTo && <p className="col-span-2 text-xs text-muted-foreground">Để trống cả 2 ngày = tất cả.</p>}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={includeOthers} onChange={e => setIncludeOthers(e.target.checked)} className="mt-0.5 accent-blue-500 w-4 h-4" />
                <span className="text-sm text-foreground">Gồm cả hội thoại trong "Khác (lưu trữ)"</span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={syncPlatform} onChange={e => setSyncPlatform(e.target.checked)} className="mt-0.5 accent-blue-500 w-4 h-4" />
                <span className="text-sm text-foreground">
                  Đồng bộ "đã đọc" lên nền tảng
                  <span className="block text-xs text-muted-foreground">Zalo, Facebook, Telegram. Telegram Bot không có trạng thái đã đọc - chỉ đánh dấu trong app.</span>
                </span>
              </label>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 px-3 py-2.5 min-h-[52px] flex items-center">
              {scanning || matches === null ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={4} /> Đang tìm hội thoại chưa đọc…</span>
              ) : matches.length === 0 ? (
                <span className="text-sm text-muted-foreground">Không có hội thoại chưa đọc nào phù hợp.</span>
              ) : (
                <div className="min-w-0">
                  <p className="text-sm text-foreground">Tìm thấy <b>{matches.length}</b> hội thoại chưa đọc</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {byChannel.map(([channel, count]) => `${channelName[channel] || channel}: ${count}`).join(' · ')}
                    {' · '}
                    {matches.slice(0, 3).map(item => item.name).join(', ')}{matches.length > 3 ? '…' : ''}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          {running ? (
            <>
              <button type="button" onClick={stop} className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-red-500 hover:bg-red-500/10 transition-colors">Dừng</button>
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white-important transition-colors">Chạy nền</button>
            </>
          ) : finished ? (
            <>
              <button type="button" onClick={() => { reset(); setShowJob(false); setMatches(null); }} className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-foreground/80 hover:bg-muted transition-colors">Chạy lại</button>
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white-important transition-colors">Đóng</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-foreground/80 hover:bg-muted transition-colors">Huỷ</button>
              <button type="button" onClick={startJob} disabled={!matches?.length || scanning || !rangeValid}
                className="h-9 px-4 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white-important transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Bắt đầu{matches?.length ? ` (${matches.length})` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
