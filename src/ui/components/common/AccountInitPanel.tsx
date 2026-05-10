/**
 * AccountInitPanel.tsx
 *
 * Floating bottom-right progress panel shown when a new (or previously
 * uninitialized) account first enters the Chat view.
 *
 * Shows 6 tasks with live progress:
 *   🤝 Danh sách bạn bè
 *   🏷️ Nhãn hội thoại
 *   ⚡ Tin nhắn nhanh
 *   👥 Nhóm Zalo  ← has a detailed progress bar from syncZaloGroups
 *   📨 Tin nhắn cũ (requestOldMessages — fire-and-forget)
 *   📋 Tin nhắn nhóm cũ (getGroupChatHistory per group, chained after groups)
 *
 * The panel is non-blocking — the user can keep using the app.
 * It auto-dismisses 4 s after all tasks complete, or can be minimized/closed.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import {
  runAccountInit,
  checkAccountInitNeeds,
  InitTask,
  InitTaskProgress,
  InitTaskStatus,
  InitNeeds,
} from '@/lib/zaloInitUtils';
import {
  runFBAccountInit,
  checkFBAccountInitNeeds,
  FBInitTask,
  FBInitTaskProgress,
  FBInitTaskStatus,
  FBInitNeeds,
} from '@/lib/fbInitUtils';

// ── Task metadata ─────────────────────────────────────────────────────────────

type AnyTaskStatus = InitTaskStatus | FBInitTaskStatus;
type AnyTaskProgress = InitTaskProgress | FBInitTaskProgress;

const TASK_META: Record<string, { label: string; icon: string }> = {
  friends:          { label: 'Danh sách bạn bè',      icon: '🤝' },
  labels:           { label: 'Nhãn hội thoại',        icon: '🏷️' },
  quickMessages:    { label: 'Tin nhắn nhanh',        icon: '⚡' },
  groups:           { label: 'Nhóm Zalo',              icon: '👥' },
  oldMessages:      { label: 'Tin nhắn cũ',           icon: '📨' },
  oldGroupMessages: { label: 'Tin nhắn nhóm cũ',     icon: '📋' },
  // Facebook tasks
  threads:          { label: 'Hội thoại Facebook',    icon: '💬' },
};

const ZALO_TASKS: InitTask[] = ['friends', 'labels', 'quickMessages', 'groups', 'oldMessages', 'oldGroupMessages'];
const FB_TASKS: FBInitTask[] = ['threads'];


type ProgressMap = Record<string, AnyTaskProgress>;

const mkInitialProgress = (tasks: string[]): ProgressMap =>
  Object.fromEntries(tasks.map(t => [t, { task: t, status: 'pending' as AnyTaskStatus }])) as ProgressMap;

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: InitTaskStatus }) {
  if (status === 'pending') return (
    <span className="w-4 h-4 rounded-full border border-gray-600 flex-shrink-0 inline-block" />
  );
  if (status === 'running') return (
    <svg className="animate-spin w-4 h-4 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
  if (status === 'done') return (
    <svg className="w-4 h-4 text-green-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
  if (status === 'error') return (
    <svg className="w-4 h-4 text-red-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
  // skipped
  return (
    <svg className="w-4 h-4 text-gray-600 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  /** Account to initialize */
  accountId: string;
  onClose: () => void;
}

export default function AccountInitPanel({ accountId, onClose }: Props) {
  const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
  const channel = acc?.channel || 'zalo';
  const isFB = channel === 'facebook';
  const taskList = isFB ? FB_TASKS : ZALO_TASKS;

  const [progress, setProgress] = useState<ProgressMap>(() => mkInitialProgress(taskList as string[]));
  const [needs, setNeeds]       = useState<(InitNeeds | FBInitNeeds) | null>(null);
  const [allDone, setAllDone]   = useState(false);
  const [minimized, setMinimized] = useState(false);

  const abortRef     = useRef({ current: false });
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningAccountRef = useRef<string | null>(null);

  const updateProgress = useCallback((task: string, update: AnyTaskProgress) => {
    setProgress(prev => ({ ...prev, [task]: update }));
  }, []);

  useEffect(() => {
    if (runningAccountRef.current === accountId) return;
    runningAccountRef.current = accountId;

    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
    if (!acc) { onClose(); return; }
    abortRef.current = { current: false };

    if (isFB) {
      // Facebook init flow
      checkFBAccountInitNeeds(accountId).then(initNeeds => {
        if (!initNeeds.any) { onClose(); return; }
        setNeeds(initNeeds);

        runFBAccountInit({
          activeAccountId: accountId,
          onProgress: updateProgress,
        }).then(() => {
          setAllDone(true);
          autoCloseRef.current = setTimeout(onClose, 4000);
        });
      });
    } else {
      // Zalo init flow
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      checkAccountInitNeeds(accountId).then(initNeeds => {
        if (!initNeeds.any) { onClose(); return; }
        setNeeds(initNeeds);

        runAccountInit({
          activeAccountId: accountId,
          auth,
          onProgress: updateProgress as any,
          groupStopRef: abortRef.current,
        }).then(() => {
          setAllDone(true);
          autoCloseRef.current = setTimeout(onClose, 4000);
        });
      });
    }

    return () => {
      abortRef.current.current = true;
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
      // Reset để accountId mới có thể chạy khi unmount thật sự
      // Strict Mode cleanup → re-mount cùng accountId vẫn bị chặn vì check === accountId chạy trước reset
      runningAccountRef.current = null;
    };
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived stats ───────────────────────────────────────────────────────────
  const tasksNeeded  = needs ? (taskList as string[]).filter(t => (needs as any)[t]) : [];
  const tasksDone    = tasksNeeded.filter(t => progress[t]?.status === 'done' || progress[t]?.status === 'error');
  const overallPct   = tasksNeeded.length > 0 ? Math.round((tasksDone.length / tasksNeeded.length) * 100) : 0;

  // ── Minimized badge ─────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-[150] flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-full px-4 py-2 shadow-2xl hover:bg-gray-750 transition-all"
        title="Mở lại bảng tiến độ"
      >
        {allDone
          ? <svg className="w-4 h-4 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          : <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5" /></svg>
        }
        <span className="text-xs text-white font-medium">
          {allDone ? 'Khởi tạo xong' : `Đang khởi tạo... ${overallPct}%`}
        </span>
        <span className="text-gray-500 text-[10px]">▲</span>
      </button>
    );
  }

  // ── Full panel ──────────────────────────────────────────────────────────────
  return (
    <div className="fixed bottom-4 right-4 z-[150] w-[330px] bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden select-none">

      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700 bg-gray-800/95">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {allDone
            ? <svg className="w-4 h-4 text-green-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            : <svg className="animate-spin w-4 h-4 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5" /></svg>
          }
          <span className="text-sm font-semibold text-white truncate">
            {allDone ? '✅ Khởi tạo hoàn tất' : 'Đang khởi tạo tài khoản'}
          </span>
        </div>
        {/* Minimize */}
        <button onClick={() => setMinimized(true)} title="Thu nhỏ"
          className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {/* Stop groups + close */}
        <button onClick={() => { abortRef.current.current = true; onClose(); }} title="Dừng và đóng"
          className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* ── Overall progress bar ── */}
      {!allDone && tasksNeeded.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-gray-500">Tiến độ tổng</span>
            <span className="text-[11px] text-blue-400 font-semibold">{overallPct}%</span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${overallPct}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Task list ── */}
      <div className="px-4 py-3 space-y-3">
        {(taskList as string[]).map(task => {
          const p    = progress[task];
          if (!p) return null;
          const meta = TASK_META[task];
          const isSkipped = p.status === 'skipped';
          const showGroupsBar =
            task === 'groups' &&
            p.status === 'running' &&
            p.groupProgress?.phase === 'members' &&
            (p.total ?? 0) > 0;

          // Progress bar for oldGroupMessages (iterating groups)
          const showOldGroupBar =
            task === 'oldGroupMessages' &&
            p.status === 'running' &&
            (p.total ?? 0) > 0;

          return (
            <div key={task} className={isSkipped ? 'opacity-30' : ''}>
              <div className="flex items-center gap-2">
                <StatusIcon status={p.status} />
                <span className="text-base leading-none flex-shrink-0">{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white leading-tight">{meta.label}</p>
                  {p.detail && (
                    <p className="text-[11px] text-gray-500 truncate leading-tight mt-0.5">{p.detail}</p>
                  )}
                </div>
                {!isSkipped && p.current !== undefined && p.total !== undefined && p.total > 0 && (
                  <span className="text-[10px] text-gray-600 flex-shrink-0 tabular-nums">
                    {p.current}/{p.total}
                  </span>
                )}
              </div>

              {/* Groups: detailed member-enrichment progress bar */}
              {showGroupsBar && (
                <div className="mt-1.5 ml-6 mr-1">
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-400/60 rounded-full transition-all duration-200"
                      style={{ width: `${Math.round(((p.current ?? 0) / (p.total ?? 1)) * 100)}%` }}
                    />
                  </div>
                  {p.groupProgress && (
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-[10px] text-gray-600">
                        {p.groupProgress.phase === 'members'
                          ? `Thành viên: ${p.groupProgress.current}/${p.groupProgress.total}`
                          : `Nhóm: ${p.groupProgress.current}/${p.groupProgress.total}`}
                      </span>
                      {p.groupProgress.phase === 'members' && (p.groupProgress.groupTotal ?? 0) > 0 && (
                        <span className="text-[10px] text-gray-600 tabular-nums">
                          Nhóm {p.groupProgress.groupCurrent}/{p.groupProgress.groupTotal}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Old group messages: per-group progress bar */}
              {showOldGroupBar && (
                <div className="mt-1.5 ml-6 mr-1">
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-400/60 rounded-full transition-all duration-200"
                      style={{ width: `${Math.round(((p.current ?? 0) / (p.total ?? 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 pb-3">
        <p className="text-[10px] text-gray-600 leading-relaxed">
          {allDone
            ? 'Hoàn tất — panel tự đóng sau vài giây.'
            : 'Bạn có thể tiếp tục dùng ứng dụng trong khi khởi tạo.'}
        </p>
      </div>
    </div>
  );
}
