/**
 * BulkMarkRepliedModal — "Đánh dấu đã trả lời hàng loạt" (menu ⋮), như "Tự động đánh dấu đã đọc": chọn khoảng thời gian
 * tin cuối, xem trước số hội thoại CHƯA TRẢ LỜI (1:1, tin cuối của khách), rồi đánh dấu đã trả lời mà không gửi tin.
 *
 * Chỉ trong app (Zalo / Facebook / Telegram không có trạng thái "đã trả lời"); lưu ở DB (Boss) nên máy nhân viên cũng
 * thấy. Khách nhắn tiếp sau đó → hội thoại tự thành "chưa trả lời" lại (shared/replyState: reply_marked_at).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChatIcon, CheckCircleIcon, CloseIcon } from '@/components/common/icons';
import DateInputVN from '@/components/common/DateInputVN';
import { Spinner } from '@/components/common/PageLoading';
import DataAccessor from '@/lib/data/DataAccessor';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import {
  AUTO_READ_PRESETS, AutoReadPreset, isValidAutoReadRange, resolveAutoReadRange,
} from '@/lib/chat/autoMarkRead';

interface Props {
  /** Tài khoản trong phạm vi (tài khoản đang xem, hoặc các tài khoản Gộp trang của kênh đang lọc). */
  accountIds: string[];
  /** "Shop A", "3 tài khoản"… */
  scopeLabel: string;
  onClose: () => void;
}

interface UnrepliedConversation {
  accountId: string;
  threadId: string;
  channel: string;
  name: string;
}

/** Số hội thoại mỗi lần gửi lệnh (danh sách id trong một câu lệnh / một yêu cầu REST). */
const MARK_CHUNK = 200;
const CHANNEL_NAME: Record<string, string> = { zalo: 'Zalo', facebook: 'Facebook', telegram_user: 'Telegram', telegram_bot: 'Telegram Bot' };

export default function BulkMarkRepliedModal({ accountIds, scopeLabel, onClose }: Props) {
  const [preset, setPreset] = useState<AutoReadPreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [includeOthers, setIncludeOthers] = useState(true);
  const [matches, setMatches] = useState<UnrepliedConversation[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [phase, setPhase] = useState<'options' | 'running' | 'done'>('options');
  const [done, setDone] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const scanRef = useRef(0);

  const range = useMemo(() => resolveAutoReadRange(preset, { from: customFrom, to: customTo }), [preset, customFrom, customTo]);
  const rangeValid = isValidAutoReadRange(range);
  const accountsKey = accountIds.join(',');

  // Xem trước: hội thoại chưa trả lời khớp lựa chọn (đọc DB — nhân viên đọc DB Boss)
  useEffect(() => {
    if (phase !== 'options') return;
    if (!rangeValid || accountIds.length === 0) { setMatches([]); return; }
    const scanId = ++scanRef.current;
    setScanning(true);
    const timer = setTimeout(() => {
      void (async () => {
        const accounts = useAccountStore.getState().accounts;
        const list: UnrepliedConversation[] = [];
        for (const accountId of accountIds) {
          const res = await DataAccessor.getContactsFiltered({
            zaloId: accountId,
            unrepliedOnly: true,
            ...(includeOthers ? {} : { excludeOthers: true }),
            ...(range.from !== undefined ? { fromTs: range.from } : {}),
            ...(range.to !== undefined ? { toTs: range.to } : {}),
          }).catch(() => ({ success: false, contacts: [] as any[] }));
          const channel = accounts.find(a => a.zalo_id === accountId)?.channel || 'zalo';
          for (const row of res?.contacts || []) {
            if (!row?.contact_id) continue;
            list.push({ accountId, threadId: String(row.contact_id), channel, name: row.alias || row.display_name || String(row.contact_id) });
          }
        }
        if (scanId === scanRef.current) setMatches(list);
      })().finally(() => { if (scanId === scanRef.current) setScanning(false); });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, range.from, range.to, rangeValid, includeOthers, phase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && phase !== 'running') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, phase]);

  const run = async () => {
    if (!matches?.length) return;
    setPhase('running');
    setDone(0);
    setErrors([]);
    const byAccount = new Map<string, string[]>();
    for (const item of matches) byAccount.set(item.accountId, [...(byAccount.get(item.accountId) || []), item.threadId]);
    let count = 0;
    const failures: string[] = [];
    for (const [accountId, threadIds] of byAccount) {
      for (let i = 0; i < threadIds.length; i += MARK_CHUNK) {
        const chunk = threadIds.slice(i, i + MARK_CHUNK);
        const res = await DataAccessor.markConversationsReplied({ zaloId: accountId, contactIds: chunk, replied: true })
          .catch((err: any) => ({ success: false, items: [] as any[], error: err?.message || String(err) }));
        if (res.success) {
          useChatStore.getState().applyReplyStates(accountId, res.items);
          count += res.items.length;
        } else {
          failures.push(res.error || 'Không cập nhật được');
        }
        setDone(count);
      }
    }
    setErrors(failures);
    setPhase('done');
  };

  const byChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of matches || []) counts.set(item.channel, (counts.get(item.channel) || 0) + 1);
    return [...counts.entries()];
  }, [matches]);
  const total = matches?.length || 0;
  const percent = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget && phase !== 'running') onClose(); }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm pointer-events-none" />
      <div className="relative w-[480px] max-w-[96vw] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <span className="w-9 h-9 rounded-xl bg-blue-500/15 text-blue-500 flex items-center justify-center flex-shrink-0">
            <ChatIcon className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-foreground">Đánh dấu đã trả lời hàng loạt</p>
            <p className="text-xs text-muted-foreground truncate">Phạm vi: {scopeLabel}</p>
          </div>
          <button type="button" onClick={onClose} disabled={phase === 'running'} title="Đóng (Esc)"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {phase === 'running' ? (
          <div className="px-5 py-5">
            <div className="flex items-center justify-between text-sm mb-1.5">
              <span className="text-foreground font-medium">Đang đánh dấu {done}/{total}</span>
              <span className="text-muted-foreground tabular-nums">{percent}%</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : phase === 'done' ? (
          <div className="px-5 py-5 space-y-3">
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-full bg-green-500/15 text-green-500 flex items-center justify-center flex-shrink-0">
                <CheckCircleIcon className="w-5 h-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Đã đánh dấu đã trả lời {done} hội thoại</p>
                <p className="text-xs text-muted-foreground mt-0.5">Khách nhắn tiếp thì hội thoại tự chuyển lại "Chưa trả lời".</p>
              </div>
            </div>
            {errors.length > 0 && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 max-h-28 overflow-y-auto">
                {errors.slice(0, 6).map((error, i) => <p key={i} className="text-[11.5px] text-foreground/80 truncate" title={error}>{error}</p>)}
              </div>
            )}
          </div>
        ) : (
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

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={includeOthers} onChange={e => setIncludeOthers(e.target.checked)} className="mt-0.5 accent-blue-500 w-4 h-4" />
              <span className="text-sm text-foreground">Gồm cả hội thoại trong "Khác (lưu trữ)"</span>
            </label>

            <p className="text-xs text-muted-foreground">
              Chỉ hội thoại 1:1 mà tin cuối là của khách. Chỉ đánh dấu trong app, không gửi tin — Zalo / Facebook / Telegram không có trạng thái "đã trả lời".
            </p>

            <div className="rounded-xl border border-border bg-muted/40 px-3 py-2.5 min-h-[52px] flex items-center">
              {scanning || matches === null ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={4} /> Đang tìm hội thoại chưa trả lời…</span>
              ) : matches.length === 0 ? (
                <span className="text-sm text-muted-foreground">Không có hội thoại chưa trả lời nào phù hợp.</span>
              ) : (
                <div className="min-w-0">
                  <p className="text-sm text-foreground">Tìm thấy <b>{matches.length}</b> hội thoại chưa trả lời</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {byChannel.map(([channel, count]) => `${CHANNEL_NAME[channel] || channel}: ${count}`).join(' · ')}
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
          {phase === 'done' ? (
            <>
              <button type="button" onClick={() => { setPhase('options'); setMatches(null); }} className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-foreground/80 hover:bg-muted transition-colors">Chạy lại</button>
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white-important transition-colors">Đóng</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={phase === 'running'} className="h-9 px-4 rounded-xl text-sm font-medium border border-border text-foreground/80 hover:bg-muted transition-colors disabled:opacity-50">Huỷ</button>
              <button type="button" onClick={() => { void run(); }} disabled={phase === 'running' || !matches?.length || scanning || !rangeValid}
                className="h-9 px-4 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white-important transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Đánh dấu đã trả lời{matches?.length ? ` (${matches.length})` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
