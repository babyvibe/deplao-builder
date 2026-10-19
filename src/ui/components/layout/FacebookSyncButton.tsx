/**
 * Nút + popup "Đồng bộ tin nhắn Facebook" trên thanh trên (giống "Đồng bộ tin nhắn từ điện thoại" của Zalo): chọn tài
 * khoản Facebook + khoảng thời gian → main tải lịch sử mọi hội thoại có hoạt động trong khoảng (qua bridge, từng trang,
 * không giới hạn số tin), chạy nền, tiến độ qua `event:fbHistorySync`. Thay cho "Đồng bộ lại hội thoại Facebook" cũ
 * (chỉ lấy danh sách 50 hội thoại + tin cuối của vài hội thoại gần đây).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { DataAccessor } from '@/lib/data/DataAccessor';
import { reloadAccountContacts } from '@/lib/chat/accountContacts';
import { isFacebook } from '@/lib/channelHelper';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useChatStore } from '@/store/chatStore';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon } from '@/components/common/icons';
import AccountSelectorDropdown, { type AccountOption } from '@/components/common/AccountSelectorDropdown';
import {
  type RangePreset, SyncRangePicker, WEEK_DAYS, describeRange, resolveRange, startOfDaysAgo, toDateInput,
} from '@/components/common/SyncRangePicker';
import {
  FB_HISTORY_SYNC_EVENT, isFbHistorySyncActive, type FbHistorySyncStatus,
} from '../../../shared/facebookHistorySync';

const fmt = (n: number) => (Number(n) || 0).toLocaleString('vi-VN');

/** Lý do đang nghỉ (nhịp người dùng thật — main/FacebookHumanPacer). */
const PAUSE_TEXT: Record<string, string> = {
  break: 'Nghỉ giải lao như người dùng thật',
  long_break: 'Nghỉ dài sau nhiều trang',
  budget: 'Đã tải nhiều trong thời gian ngắn — chờ cho an toàn',
  slowdown: 'Facebook đang chậm — giãn thêm thời gian',
  reading: 'Đang nghỉ như đang đọc tin',
  thread: 'Chuẩn bị mở hội thoại tiếp theo',
  list: 'Đang nghỉ giữa hai trang danh sách',
  pace: 'Đang nghỉ giữa hai trang',
  bridge: 'Chờ kết nối Messenger của bridge',
};

const fmtCountdown = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
};

/** Sau khi đồng bộ: nạp lại danh sách hội thoại + hội thoại đang mở của tài khoản đó. */
async function reloadAfterSync(accountId: string) {
  try { await reloadAccountContacts(accountId); } catch { /* giữ danh sách đang có */ }
  const chat = useChatStore.getState();
  const threadId = chat.activeThreadId;
  if (!threadId || useAccountStore.getState().activeAccountId !== accountId) return;
  try {
    const res = await DataAccessor.getMessages({ zaloId: accountId, threadId, limit: 50, offset: 0 });
    const messages = res?.messages ?? res?.items ?? [];
    const latest = useChatStore.getState();
    if (messages.length && latest.activeThreadId === threadId) latest.setMessages(accountId, threadId, [...messages].reverse());
  } catch { /* lần mở sau sẽ đọc lại */ }
}

function MessengerGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3C7 3 3 6.7 3 11.3c0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.9.3 1.8.4 2.7.4 5 0 9-3.7 9-8.4S17 3 12 3z" />
      <path d="m7.5 13.5 3-3.2 2.2 2.2 3.8-3.5-3 3.2-2.2-2.2z" />
    </svg>
  );
}

export default function FacebookSyncButton() {
  const { showNotification, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, mergedInboxMode: s.mergedInboxMode,
    mergedInboxAccounts: s.mergedInboxAccounts, mergedInboxFilterAccount: s.mergedInboxFilterAccount,
  })));
  const { activeAccountId, accounts } = useAccountStore(useShallow(s => ({ activeAccountId: s.activeAccountId, accounts: s.accounts })));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, FbHistorySyncStatus>>({});
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>('week');
  const [customFrom, setCustomFrom] = useState(() => toDateInput(startOfDaysAgo(WEEK_DAYS)));
  const [customTo, setCustomTo] = useState(() => toDateInput(new Date()));
  // Mỗi lượt tải phải xác nhận lại đã đọc cảnh báo rủi ro checkpoint (mở popup / bắt đầu xong → bỏ chọn)
  const [riskAccepted, setRiskAccepted] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => { if (open) setRiskAccepted(false); }, [open]);
  // Đếm ngược thời gian nghỉ trên popup
  const [nowTick, setNowTick] = useState(() => Date.now());

  const fbAccounts = useMemo(() => {
    const list = accounts.filter(a => isFacebook(a.channel));
    if (!mergedInboxMode) return list;
    const inMerged = new Set(mergedInboxAccounts);
    return inMerged.size ? list.filter(a => inMerged.has(a.zalo_id)) : list;
  }, [accounts, mergedInboxMode, mergedInboxAccounts]);

  const targetId = useMemo(() => {
    const ids = fbAccounts.map(a => a.zalo_id);
    const has = (id?: string | null): id is string => !!id && ids.includes(id);
    if (has(pickedId)) return pickedId;
    const running = ids.find(id => isFbHistorySyncActive(statuses[id]));
    if (running) return running;
    if (mergedInboxMode && has(mergedInboxFilterAccount)) return mergedInboxFilterAccount;
    if (has(activeAccountId)) return activeAccountId;
    return mergedInboxMode ? ids[0] ?? null : null;
  }, [fbAccounts, pickedId, statuses, mergedInboxMode, mergedInboxFilterAccount, activeAccountId]);

  const account = accounts.find(a => a.zalo_id === targetId);
  const status = targetId ? statuses[targetId] : undefined;
  const running = isFbHistorySyncActive(status);
  const pausedMs = running && status?.pausedUntil ? status.pausedUntil - nowTick : 0;
  useEffect(() => {
    if (!open || !running || !status?.pausedUntil) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    setNowTick(Date.now());
    return () => window.clearInterval(timer);
  }, [open, running, status?.pausedUntil]);
  const runningAccount = fbAccounts.find(a => isFbHistorySyncActive(statuses[a.zalo_id]));

  useEffect(() => {
    if (!ipc.on) return;
    return ipc.on(FB_HISTORY_SYNC_EVENT, (data: FbHistorySyncStatus) => {
      if (!data?.accountId) return;
      setStatuses(prev => ({ ...prev, [data.accountId]: data }));
      if (data.stage === 'completed' || data.stage === 'cancelled') {
        void reloadAfterSync(data.accountId);
        if (!openRef.current && data.stage === 'completed') showNotification(data.message || 'Đã đồng bộ tin nhắn Facebook', 'success');
      } else if (data.stage === 'failed' && !openRef.current) {
        showNotification(data.error || 'Đồng bộ tin nhắn Facebook thất bại', 'error');
      }
    });
  }, [showNotification]);

  useEffect(() => {
    if (!open || !targetId || !ipc.fb?.getHistorySyncStatus) return;
    let cancelled = false;
    ipc.fb.getHistorySyncStatus({ accountId: targetId })
      .then(res => {
        if (!cancelled && res?.status) setStatuses(prev => (prev[targetId] ? prev : { ...prev, [targetId]: res.status as FbHistorySyncStatus }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, targetId]);

  const accountOptions = useMemo<AccountOption[]>(() => fbAccounts.map(a => ({
    id: a.zalo_id,
    name: a.full_name || a.display_name || a.zalo_id,
    phone: a.phone,
    avatarUrl: a.avatar_url,
  })), [fbAccounts]);

  const handleStart = useCallback(async () => {
    if (!targetId || busy || !riskAccepted || !ipc.fb?.startHistorySync) return;
    const { range, error } = resolveRange(rangePreset, customFrom, customTo);
    if (!range) {
      showNotification(error || 'Khoảng thời gian không hợp lệ', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await ipc.fb.startHistorySync({ accountId: targetId, fromTs: range.fromTs, toTs: range.toTs });
      if (res?.status) setStatuses(prev => ({ ...prev, [targetId]: res.status as FbHistorySyncStatus }));
      if (!res?.success && !res?.status) showNotification(res?.error || 'Không thể bắt đầu đồng bộ', 'error');
      else setRiskAccepted(false);
    } catch (e: any) {
      showNotification('Lỗi: ' + (e?.message || 'Không thể bắt đầu đồng bộ'), 'error');
    } finally {
      setBusy(false);
    }
  }, [targetId, busy, riskAccepted, rangePreset, customFrom, customTo, showNotification]);

  const handleCancel = useCallback(async () => {
    if (!targetId || !ipc.fb?.cancelHistorySync) return;
    const res = await ipc.fb.cancelHistorySync({ accountId: targetId }).catch(() => null);
    if (res?.status) setStatuses(prev => ({ ...prev, [targetId]: res.status as FbHistorySyncStatus }));
  }, [targetId]);

  // Luôn mount (không lỡ sự kiện); chỉ hiện nút khi có tài khoản Facebook để đồng bộ.
  if (!targetId || !isFacebook(account?.channel)) return null;
  const showAccountPicker = accountOptions.length > 1;
  const finished = status && (status.stage === 'completed' || status.stage === 'failed' || status.stage === 'cancelled');
  const progress = status && status.threadsTotal > 0 ? Math.min(100, Math.round((status.threadsDone / status.threadsTotal) * 100)) : 0;
  const rangeInvalid = !resolveRange(rangePreset, customFrom, customTo).range;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`relative w-9 h-9 flex items-center justify-center transition-colors ${open || runningAccount ? 'text-blue-400 bg-muted' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title={runningAccount
          ? `Đang đồng bộ tin nhắn Facebook (${runningAccount.full_name || runningAccount.zalo_id}): ${statuses[runningAccount.zalo_id]?.message || ''}`
          : 'Đồng bộ tin nhắn Facebook'}
        aria-label="Đồng bộ tin nhắn Facebook"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        {runningAccount && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10000]"
          onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4">
            <div className="px-6 pt-6 pb-4 flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-500/15 flex items-center justify-center flex-shrink-0 text-blue-400">
                <MessengerGlyph className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h3 className="text-foreground font-semibold text-base leading-snug">Đồng bộ tin nhắn Facebook</h3>
                {showAccountPicker ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-muted-foreground mb-1">Tài khoản Facebook cần đồng bộ</p>
                    <AccountSelectorDropdown options={accountOptions} activeId={targetId} onSelect={setPickedId} fullWidth />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs mt-0.5 truncate">{account?.full_name || targetId}</p>
                )}
                {status?.range && status.stage !== 'idle' && (
                  <p className="text-subtle-foreground text-[11px] mt-1 truncate">Khoảng thời gian: {describeRange(status.range)}</p>
                )}
              </div>
            </div>

            <div className="px-6 pb-5 space-y-4">
              {!status || status.stage === 'idle' ? (
                <div className="text-sm text-foreground/80 space-y-2 leading-relaxed">
                  <p>Tải tin nhắn Messenger trong khoảng thời gian bạn chọn cho mọi hội thoại có hoạt động trong khoảng đó — tải lần lượt từng trang tới hết khoảng, không giới hạn số tin.</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1 text-[13px]">
                    <li>Tin đã có được bỏ qua; tin mẫu của Trang trước đây hiện rỗng được sửa lại.</li>
                    <li>Hội thoại mã hoá đầu cuối không tải được tin cũ (Facebook không cho thiết bị mới đọc), chỉ có tin nhận khi Deplao đang chạy.</li>
                    <li>Tải nhiều có thể mất vài giờ — ẩn popup, đồng bộ vẫn chạy nền.</li>
                  </ul>
                </div>
              ) : (
                <>
                  <div className={`rounded-xl px-3.5 py-2.5 text-sm ${
                    status.stage === 'failed' ? 'bg-red-500/10 text-red-300 border border-red-500/30'
                      : status.stage === 'completed' ? 'bg-green-500/10 text-green-300 border border-green-500/30'
                        : status.stage === 'cancelled' ? 'bg-yellow-500/10 text-yellow-300 border border-yellow-500/30'
                          : 'bg-background/60 text-foreground/80 border border-border'}`}
                  >
                    <div className="flex items-center gap-2">
                      {running && <Spinner size={3} />}
                      <span className="min-w-0 break-words">{status.error || status.message}</span>
                    </div>
                    {running && status.currentThreadName && (
                      <p className="mt-1 text-[11px] text-muted-foreground truncate">Đang tải: {status.currentThreadName}</p>
                    )}
                    {pausedMs > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        ⏸ {PAUSE_TEXT[status.pauseReason || 'pace'] || PAUSE_TEXT.pace} · còn {fmtCountdown(pausedMs)}
                      </p>
                    )}
                  </div>

                  {running && (
                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                      {status.stage === 'listing' || status.threadsTotal === 0
                        ? <div className="h-full w-1/3 bg-blue-500/70 animate-pulse" />
                        : <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-card border border-border px-3 py-2">
                      <div className="text-subtle-foreground">Tin mới</div>
                      <div className="text-foreground font-semibold text-sm">{fmt(status.messagesSaved)}</div>
                    </div>
                    <div className="rounded-lg bg-card border border-border px-3 py-2">
                      <div className="text-subtle-foreground">Hội thoại</div>
                      <div className="text-foreground font-semibold text-sm">
                        {fmt(status.threadsDone)}
                        <span className="text-subtle-foreground font-normal">/{fmt(status.threadsTotal)}</span>
                      </div>
                    </div>
                    {finished && (status.skippedE2EE > 0 || status.failedThreads > 0 || status.messagesReceived > status.messagesSaved) && (
                      <div className="col-span-2 text-subtle-foreground leading-relaxed">
                        {status.messagesReceived > status.messagesSaved && `${fmt(status.messagesReceived - status.messagesSaved)} tin đã có trong máy. `}
                        {status.skippedE2EE > 0 && `${fmt(status.skippedE2EE)} hội thoại mã hoá đầu cuối không tải được tin cũ. `}
                        {status.failedThreads > 0 && `${fmt(status.failedThreads)} hội thoại Facebook chưa trả lời — đồng bộ lại để thử tiếp.`}
                      </div>
                    )}
                  </div>
                </>
              )}

              {!running && (
                <div className={status && status.stage !== 'idle' ? 'pt-3 border-t border-border/60' : ''}>
                  <SyncRangePicker
                    preset={rangePreset}
                    from={customFrom}
                    to={customTo}
                    onPreset={setRangePreset}
                    onFrom={setCustomFrom}
                    onTo={setCustomTo}
                    allHint="Toàn bộ lịch sử của mọi hội thoại — lâu nhất và gửi nhiều yêu cầu nhất (rủi ro checkpoint cao nhất); chỉ chọn khi thật sự cần."
                  />
                </div>
              )}

              {!running && (
                <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 flex gap-2.5 items-start">
                  <span className="text-orange-400 mt-0.5"><AlertIcon className="w-4 h-4" /></span>
                  <div className="min-w-0">
                    <p className="text-orange-500 text-xs font-semibold mb-0.5">Không cần tin nhắn cũ thì đừng tải</p>
                    <p className="text-orange-400 text-[11px] leading-relaxed">
                      Tin nhắn mới vẫn tự về khi Deplao đang chạy — không cần đồng bộ. Tải lịch sử gửi nhiều yêu cầu tới Facebook:
                      Deplao đã giãn nhịp như người dùng thật (nghỉ ngẫu nhiên giữa các trang, nghỉ giải lao sau mỗi 30–50 trang,
                      tối đa khoảng 240 trang / giờ, tự dừng khi Facebook có dấu hiệu hạn chế) nhưng{' '}
                      <strong className="text-orange-300">vẫn có rủi ro bị checkpoint</strong> (Facebook yêu cầu xác minh hoặc
                      tạm khoá tài khoản). Chọn khoảng thời gian ngắn nhất đủ dùng.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={riskAccepted}
                        onChange={e => setRiskAccepted(e.target.checked)}
                        className="accent-orange-500 w-4 h-4"
                      />
                      Tôi hiểu rủi ro và vẫn muốn tải
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border/60">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-foreground/80 hover:text-foreground hover:bg-muted transition-colors"
                title={running ? 'Đồng bộ vẫn tiếp tục chạy nền' : undefined}
              >
                {running ? 'Ẩn' : 'Đóng'}
              </button>
              {running ? (
                <button onClick={handleCancel} className="px-5 py-2 rounded-xl text-sm font-semibold transition-colors bg-red-600 hover:bg-red-700 text-white">
                  Huỷ đồng bộ
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={busy || rangeInvalid || !riskAccepted}
                  title={!riskAccepted ? 'Đọc cảnh báo và chọn "Tôi hiểu rủi ro" trước khi tải' : undefined}
                  className="px-5 py-2 rounded-xl text-sm font-semibold transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 flex items-center gap-2"
                >
                  {busy && <Spinner size={3} />}
                  {status && status.stage !== 'idle' ? 'Đồng bộ lại' : 'Bắt đầu đồng bộ'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
