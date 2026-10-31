/**
 * fbInitUtils.ts
 *
 * Facebook account first-run initialization - syncs threads/conversations
 * when a new FB account first enters the Chat view.
 *
 * Much simpler than Zalo init (only 1 task: threads).
 * Messages arrive via real-time MQTT listener, no historical fetch API.
 */

import ipc from '@/lib/ipc';
import { useWorkspaceStore } from '@/store/app/workspaceStore';
import { useChatStore } from '@/store/chat/chatStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';

// ── Public types (compatible with zaloInitUtils) ──────────────────────────────

export type FBInitTask = 'threads';
export type FBInitTaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface FBInitTaskProgress {
  task: FBInitTask;
  status: FBInitTaskStatus;
  current?: number;
  total?: number;
  detail?: string;
  groupProgress?: any;
}

export interface FBInitNeeds {
  threads: boolean;
  any: boolean;
}

export interface FBAccountInitOptions {
  activeAccountId: string;
  onProgress: (task: FBInitTask, update: FBInitTaskProgress) => void;
}

// ── LocalStorage persistence ──────────────────────────────────────────────────

// Re-run inbox synchronization once: older clients replayed E2EE history as
// live traffic and left stale unread badges in the local contact cache.
const FB_SYNC_VERSION = 5;

interface FBInitRecord {
  version: number;
  completedAt: number;
}

const FB_INIT_KEY = (id: string) => {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId || 'default';
  return `fb_account_init_${wsId}_${id}`;
};

export function isFBAccountInitDone(accountId: string): boolean {
  try {
    const raw = localStorage.getItem(FB_INIT_KEY(accountId));
    if (!raw) return false;
    const parsed: FBInitRecord = JSON.parse(raw);
    return parsed?.version >= FB_SYNC_VERSION;
  } catch {
    return false;
  }
}

export function markFBAccountInitDone(accountId: string): void {
  try {
    localStorage.setItem(FB_INIT_KEY(accountId), JSON.stringify({
      version: FB_SYNC_VERSION,
      completedAt: Date.now(),
    } satisfies FBInitRecord));
  } catch {}
}

// ── Needs check ───────────────────────────────────────────────────────────────

export async function checkFBAccountInitNeeds(accountId: string): Promise<FBInitNeeds> {
  // Nhân viên không giữ phiên Facebook (Boss giữ) — đồng bộ hội thoại là việc của Boss. Trước đây máy nhân viên mới
  // (chưa có cờ "đã init" trong localStorage) mở bảng đồng bộ và gọi fb:getThreads không có phiên.
  if (useEmployeeStore.getState().mode === 'employee') return { threads: false, any: false };
  if (!isFBAccountInitDone(accountId)) {
    return { threads: true, any: true };
  }

  // Already done - check if contacts exist in DB
  try {
    const res = await ipc.db?.getContacts(accountId);
    const contacts: any[] = res?.contacts ?? res ?? [];
    if (contacts.length === 0) {
      return { threads: true, any: true };
    }
  } catch {
    return { threads: true, any: true };
  }

  return { threads: false, any: false };
}

// ── Sync task ─────────────────────────────────────────────────────────────────

async function _syncFBThreads(
  accountId: string,
  onProgress: (u: FBInitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'threads', status: 'running', detail: 'Đang tải danh sách hội thoại Facebook...' });
  try {
    const res = await ipc.fb?.getThreads({ accountId, forceRefresh: true });
    if (res?.success) {
      const count = res.threads?.length ?? 0;

      // Reload contacts from DB into chat store
      try {
        const contactsRes = await ipc.db?.getContacts(accountId);
        const contacts = contactsRes?.contacts ?? contactsRes ?? [];
        if (contacts.length > 0) {
          useChatStore.getState().setContacts(accountId, contacts);
        }
      } catch {}

      onProgress({
        task: 'threads', status: 'done',
        total: count, current: count,
        detail: `${count} hội thoại Facebook`,
      });
    } else {
      onProgress({ task: 'threads', status: 'error', detail: res?.error || 'Lỗi tải hội thoại' });
    }
  } catch (err: any) {
    onProgress({ task: 'threads', status: 'error', detail: err?.message || 'Lỗi tải hội thoại' });
  }
}

// ── Main init runner ──────────────────────────────────────────────────────────

export async function runFBAccountInit(opts: FBAccountInitOptions): Promise<void> {
  const { activeAccountId, onProgress } = opts;

  const needs = await checkFBAccountInitNeeds(activeAccountId);

  if (!needs.any) {
    markFBAccountInitDone(activeAccountId);
    return;
  }

  if (needs.threads) {
    await _syncFBThreads(activeAccountId, (u) => onProgress('threads', u));
  }

  markFBAccountInitDone(activeAccountId);
}

