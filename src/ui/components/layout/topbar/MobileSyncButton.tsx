import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc, { MobileSyncStage, MobileSyncStatus } from '@/lib/ipc';
import { DataAccessor } from '@/lib/data/DataAccessor';
import { useAppStore } from '@/store/app/appStore';
import { useShallow } from 'zustand/react/shallow';
import { AccountInfo, useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { Spinner } from '@/components/common/PageLoading';
import { SmartphoneIcon } from '@/components/common/icons';
import AccountSelectorDropdown, { AccountOption } from '@/components/common/accounts/AccountSelectorDropdown';
import { isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { markFeatureSeen, useFeatureSeen } from '@/lib/app/settingsSeenTabs';
import {
  type RangePreset, SyncRangePicker, WEEK_DAYS, describeRange, resolveRange, startOfDaysAgo, toDateInput,
} from '@/components/common/inputs/SyncRangePicker';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const ACTIVE_STAGES: MobileSyncStage[] = [
  'requesting', 'waiting_confirm', 'waiting_backup', 'mobile_idle',
  'downloading', 'decrypting', 'resolving_ids', 'importing',
];

const STEPS: Array<{ label: string; stages: MobileSyncStage[] }> = [
  { label: tr('Xác nhận trên điện thoại'), stages: ['requesting', 'waiting_confirm'] },
  { label: tr('Điện thoại chuẩn bị dữ liệu'), stages: ['waiting_backup', 'mobile_idle'] },
  { label: tr('Tải dữ liệu về máy'), stages: ['downloading'] },
  { label: tr('Giải mã'), stages: ['decrypting'] },
  { label: tr('Ghép tin nhắn vào hội thoại'), stages: ['resolving_ids', 'importing'] },
];

const PROGRESS_STAGES: MobileSyncStage[] = ['downloading', 'decrypting', 'importing'];

const isActive = (status?: MobileSyncStatus | null) => !!status && ACTIVE_STAGES.includes(status.stage);
const stepIndexOf = (stage?: MobileSyncStage) => STEPS.findIndex(step => stage && step.stages.includes(stage));
const isZaloAccount = (acc?: AccountInfo) => !!acc && !isFacebook(acc.channel) && !isTelegram(acc.channel);

/** Reload the conversation list + the open conversation after the import finishes. */
async function reloadConversations(zaloId: string) {
  const conversations = await DataAccessor.getConversations(zaloId, 500, 0);
  if (conversations?.items) useChatStore.getState().setContacts(zaloId, conversations.items);

  const chatState = useChatStore.getState();
  const threadId = chatState.activeThreadId;
  if (!threadId || useAccountStore.getState().activeAccountId !== zaloId) return;
  const res = await DataAccessor.getMessages({ zaloId, threadId, limit: 50, offset: 0 });
  const messages = res?.messages ?? res?.items ?? [];
  const latest = useChatStore.getState();
  if (latest.activeThreadId === threadId && useAccountStore.getState().activeAccountId === zaloId) {
    latest.setMessages(zaloId, threadId, [...messages].reverse());
  }
}

export default function MobileSyncButton() {
  const { showNotification, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, mergedInboxMode: s.mergedInboxMode,
    mergedInboxAccounts: s.mergedInboxAccounts, mergedInboxFilterAccount: s.mergedInboxFilterAccount,
  })));
  const { activeAccountId, accounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, MobileSyncStatus>>({});
  const [busy, setBusy] = useState(false);
  /** Merged inbox mode: the accounts the user picks in the modal. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  /** Sync time range: defaults to the last 1 week. */
  const [rangePreset, setRangePreset] = useState<RangePreset>('week');
  const [customFrom, setCustomFrom] = useState(() => toDateInput(startOfDaysAgo(WEEK_DAYS)));
  const [customTo, setCustomTo] = useState(() => toDateInput(new Date()));
  // The last step that was running before the error / cancel, so the right step is marked on the stepper.
  const lastStepRef = useRef<Record<string, number>>({});
  const openRef = useRef(open);
  openRef.current = open;
  // New feature: red dot on the button until the user opens the modal for the first time.
  const featureSeen = useFeatureSeen('mobileSync');
  useEffect(() => {
    if (open) markFeatureSeen('mobileSync');
  }, [open]);

  // Merged inbox: there is no single clearly open account → let the user pick among the merged Zalo accounts.
  const mergedZaloAccounts = useMemo(() => {
    if (!mergedInboxMode) return [];
    const inMerged = new Set(mergedInboxAccounts);
    return accounts.filter(a => isZaloAccount(a) && (inMerged.size === 0 || inMerged.has(a.zalo_id)));
  }, [mergedInboxMode, mergedInboxAccounts, accounts]);

  const targetId = useMemo(() => {
    if (!mergedInboxMode) return activeAccountId;
    const ids = mergedZaloAccounts.map(a => a.zalo_id);
    const has = (id?: string | null): id is string => !!id && ids.includes(id);
    if (has(pickedId)) return pickedId;
    // Priority: the account that is mid-sync, then the account being filtered, then the account with an open conversation.
    const runningId = ids.find(id => isActive(statuses[id]));
    if (runningId) return runningId;
    if (has(mergedInboxFilterAccount)) return mergedInboxFilterAccount;
    if (has(activeAccountId)) return activeAccountId;
    return ids[0] ?? null;
  }, [mergedInboxMode, mergedZaloAccounts, pickedId, statuses, mergedInboxFilterAccount, activeAccountId]);

  const accountOptions = useMemo<AccountOption[]>(() => mergedZaloAccounts.map(a => ({
    id: a.zalo_id,
    name: a.full_name || a.display_name || a.zalo_id,
    phone: a.phone,
    avatarUrl: a.avatar_url,
  })), [mergedZaloAccounts]);

  const status = targetId ? statuses[targetId] : undefined;
  const account = accounts.find(a => a.zalo_id === targetId);
  // Topbar button: merged inbox → lit up when ANY merged account is syncing.
  const runningAccount = mergedInboxMode
    ? mergedZaloAccounts.find(a => isActive(statuses[a.zalo_id]))
    : (isActive(status) ? account : undefined);

  useEffect(() => {
    if (!ipc.on) return;
    return ipc.on('event:mobileSync', (data: MobileSyncStatus) => {
      if (!data?.zaloId) return;
      const stepIdx = stepIndexOf(data.stage);
      if (stepIdx >= 0) lastStepRef.current[data.zaloId] = stepIdx;
      setStatuses(prev => ({ ...prev, [data.zaloId]: data }));

      if (data.stage === 'completed') {
        void reloadConversations(data.zaloId).catch(() => {});
        if (!openRef.current) showNotification(data.message || tr('Đã đồng bộ tin nhắn từ điện thoại'), 'success');
      } else if (data.stage === 'failed' && !openRef.current) {
        showNotification(data.error || tr('Đồng bộ tin nhắn từ điện thoại thất bại'), 'error');
      }
    });
  }, [showNotification]);

  // Opening the modal / switching account → fetch the latest session state (if any) of the selected account.
  useEffect(() => {
    if (!open || !targetId || !ipc.mobileSync) return;
    let cancelled = false;
    ipc.mobileSync.getStatus(targetId)
      .then(res => {
        if (cancelled || !res?.status) return;
        setStatuses(prev => (prev[targetId] ? prev : { ...prev, [targetId]: res.status as MobileSyncStatus }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, targetId]);

  const handleStart = useCallback(async () => {
    if (!targetId || !ipc.mobileSync || busy) return;
    const { range, error } = resolveRange(rangePreset, customFrom, customTo);
    if (!range) {
      showNotification(error || tr('Khoảng thời gian không hợp lệ'), 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await ipc.mobileSync.start(targetId, range);
      if (res?.status) setStatuses(prev => ({ ...prev, [targetId]: res.status as MobileSyncStatus }));
      if (!res?.success && !res?.status) showNotification(res?.error || tr('Không thể bắt đầu đồng bộ'), 'error');
    } catch (e: any) {
      showNotification(tr('Lỗi: {{v1}}', { v1: (e?.message || tr('Không thể bắt đầu đồng bộ')) }), 'error');
    } finally {
      setBusy(false);
    }
  }, [targetId, busy, rangePreset, customFrom, customTo, showNotification]);

  const handleCancel = useCallback(async () => {
    if (!targetId || !ipc.mobileSync) return;
    const res = await ipc.mobileSync.cancel(targetId).catch(() => null);
    if (res?.status) setStatuses(prev => ({ ...prev, [targetId]: res.status as MobileSyncStatus }));
  }, [targetId]);

  // Always mounted so no event is missed while on another account; the button only shows when there is a Zalo account to sync.
  if (!targetId || !isZaloAccount(account)) return null;
  const running = isActive(status);
  const showAccountPicker = mergedInboxMode && accountOptions.length > 1;

  const currentStep = status
    ? (status.stage === 'completed' ? STEPS.length : (stepIndexOf(status.stage) >= 0 ? stepIndexOf(status.stage) : lastStepRef.current[targetId] ?? 0))
    : -1;
  const stopped = status?.stage === 'failed' || status?.stage === 'cancelled';
  const showProgress = !!status && PROGRESS_STAGES.includes(status.stage);
  const stats = status?.stats;
  const rangeInvalid = !resolveRange(rangePreset, customFrom, customTo).range;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`group relative w-9 h-9 flex items-center justify-center transition-colors ${open || runningAccount ? 'text-blue-400 bg-muted' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title={runningAccount
          ? tr('Đang đồng bộ từ điện thoại{{v1}}: {{v2}}', { v1: mergedInboxMode ? ` (${runningAccount.full_name || runningAccount.zalo_id})` : '', v2: statuses[runningAccount.zalo_id]?.message || '' })
          : tr('Đồng bộ tin nhắn từ điện thoại')}
        aria-label={tr('Đồng bộ tin nhắn từ điện thoại')}
      >
        <span className="relative inline-flex">
          <SmartphoneIcon className="w-3.5 h-3.5" />
          {/* Download badge at the bottom right ("tải tin nhắn từ điện thoại về" (download messages from phone)): background in the icon color, arrow + border in the
              button background → looks cut out of the icon (idle: bg-card; hover / open / syncing: bg-muted) */}
          <span className={`absolute -right-[5px] -bottom-[3px] w-2.5 h-2.5 rounded-full bg-current ring-[1.5px] flex items-center justify-center pointer-events-none ${open || runningAccount ? 'ring-muted' : 'ring-card group-hover:ring-muted'}`}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              className={`w-[7px] h-[7px] ${open || runningAccount ? 'text-muted' : 'text-card group-hover:text-muted'}`}>
              <path d="M6 2.2v6.1M3.4 5.8 6 8.4l2.6-2.6" />
            </svg>
          </span>
        </span>
        {runningAccount
          ? <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          : !featureSeen && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive pointer-events-none" />}
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10000]"
          onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4">
            {/* Header */}
            <div className="px-6 pt-6 pb-4 flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-500/15 flex items-center justify-center flex-shrink-0 text-blue-400">
                <SmartphoneIcon className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h3 className="text-foreground font-semibold text-base leading-snug">{tr('Đồng bộ tin nhắn từ điện thoại')}</h3>
                {showAccountPicker ? (
                  <div className="mt-2">
                    <p className="text-[11px] text-muted-foreground mb-1">{tr('Tài khoản Zalo cần đồng bộ')}</p>
                    <AccountSelectorDropdown
                      options={accountOptions}
                      activeId={targetId}
                      onSelect={setPickedId}
                      fullWidth
                    />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs mt-0.5 truncate">{account?.full_name || targetId}</p>
                )}
                {status?.range && status.stage !== 'idle' && (
                  <p className="text-subtle-foreground text-[11px] mt-1 truncate">{trx('Khoảng thời gian: {{v1}}', { v1: describeRange(status.range) })}</p>
                )}
              </div>
            </div>

            <div className="px-6 pb-5 space-y-4">
              {!status || (status.stage === 'idle') ? (
                <div className="text-sm text-foreground/80 space-y-2 leading-relaxed">
                  <p>{tr('Lấy tin nhắn trên Zalo điện thoại trong khoảng thời gian bạn chọn và ghép vào đúng các hội thoại trên Deplao.')}</p>
                  <ol className="list-decimal list-inside text-muted-foreground space-y-1">
                    <li>{trx('Bấm <0>Bắt đầu đồng bộ</0>.', { 0: <span className="text-foreground" /> })}</li>
                    <li>{trx('Mở Zalo trên điện thoại, chọn <0>Đồng ý</0> ở yêu cầu đồng bộ tin nhắn (thiết bị “{{v1}}”).', { 0: <span className="text-foreground" />, v1: status?.pcName || 'Web' })}</li>
                    <li>{tr('Giữ Zalo mở trên điện thoại tới khi tải xong. Tin đã có sẽ được bỏ qua nên có thể đồng bộ lại nhiều lần.')}</li>
                  </ol>
                </div>
              ) : (
                <>
                  <ul className="space-y-2">
                    {STEPS.map((step, idx) => {
                      const done = idx < currentStep;
                      const active = idx === currentStep && running;
                      const failedHere = stopped && idx === currentStep;
                      return (
                        <li key={step.label} className="flex items-center gap-3 text-sm">
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${
                            done ? 'bg-green-500/20 text-green-400'
                              : failedHere ? 'bg-red-500/20 text-red-400'
                                : active ? 'bg-blue-500/20 text-blue-400'
                                  : 'bg-muted text-subtle-foreground'}`}
                          >
                            {done ? '✓' : failedHere ? '✕' : active ? <Spinner size={2.5} /> : idx + 1}
                          </span>
                          <span className={done ? 'text-foreground/80' : active ? 'text-foreground' : failedHere ? 'text-red-300' : 'text-subtle-foreground'}>
                            {step.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  <div className={`rounded-xl px-3.5 py-2.5 text-sm font-semibold text-center ${
                    status.stage === 'failed' ? 'bg-red-500/10 text-red-300 border border-red-500/30'
                      : status.stage === 'completed' ? 'bg-green-500/10 text-green-300 border border-green-500/30'
                        : status.stage === 'mobile_idle' ? 'bg-yellow-500/10 text-yellow-300 border border-yellow-500/30'
                          : 'bg-background/60 text-foreground/80 border border-border'}`}
                  >
                    {status.error || status.message}
                  </div>

                  {showProgress && (
                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${status.progress || 0}%` }} />
                    </div>
                  )}

                  {stats && (status.stage === 'completed' || stopped) && (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-card border border-border px-3 py-2">
                        <div className="text-subtle-foreground">{tr('Tin nhắn mới')}</div>
                        <div className="text-foreground font-semibold text-sm">{stats.messagesImported.toLocaleString(appLocale())}</div>
                      </div>
                      <div className="rounded-lg bg-card border border-border px-3 py-2">
                        <div className="text-subtle-foreground">{tr('Hội thoại')}</div>
                        <div className="text-foreground font-semibold text-sm">
                          {stats.conversationsResolved.toLocaleString(appLocale())}
                          <span className="text-subtle-foreground font-normal">/{stats.conversations.toLocaleString(appLocale())}</span>
                        </div>
                      </div>
                      {(stats.messagesSkipped > 0 || stats.conversationsUnresolved > 0) && (
                        <div className="col-span-2 text-subtle-foreground leading-relaxed">
                          {trx('Bỏ qua {{v1}} tin đã có hoặc không hỗ trợ', { v1: stats.messagesSkipped.toLocaleString(appLocale()) })}
                          {stats.conversationsUnresolved > 0 && tr(', {{conversationsUnresolved}} hội thoại không còn truy cập được (đã xoá/rời nhóm)', { conversationsUnresolved: stats.conversationsUnresolved })}.
                        </div>
                      )}
                      {(stats.messagesOutOfRange ?? 0) > 0 && (
                        <div className="col-span-2 text-subtle-foreground leading-relaxed">
                          {trx('{{v1}} tin ngoài khoảng thời gian đã chọn không được tải.', { v1: (stats.messagesOutOfRange ?? 0).toLocaleString(appLocale()) })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Pick the time range before syncing / re-syncing */}
              {!running && (
                <div className={status && status.stage !== 'idle' ? 'pt-3 border-t border-border/60' : ''}>
                  <SyncRangePicker
                    preset={rangePreset}
                    from={customFrom}
                    to={customTo}
                    onPreset={setRangePreset}
                    onFrom={setCustomFrom}
                    onTo={setCustomTo}
                    allHint={tr('Toàn bộ lịch sử trên điện thoại — có thể mất nhiều thời gian với tài khoản nhiều tin nhắn.')}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border/60">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-foreground/80 hover:text-foreground hover:bg-muted transition-colors"
                title={running ? tr('Đồng bộ vẫn tiếp tục chạy nền') : undefined}
              >
                {running ? tr('Ẩn') : tr('Đóng')}
              </button>
              {running ? (
                <button
                  onClick={handleCancel}
                  className="px-5 py-2 rounded-xl text-sm font-semibold transition-colors bg-red-600 hover:bg-red-700 text-white"
                >
                  {tr('Huỷ đồng bộ')}
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={busy || rangeInvalid}
                  className="px-5 py-2 rounded-xl text-sm font-semibold transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 flex items-center gap-2"
                >
                  {busy && <Spinner size={3} />}
                  {status && status.stage !== 'idle' ? tr('Đồng bộ lại') : tr('Bắt đầu đồng bộ')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
