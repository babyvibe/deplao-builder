/**
 * zaloInitUtils.ts
 *
 * Account first-run initialization — syncs 6 data types when a
 * new (or previously-unseen) account first accesses the Chat view.
 *
 * ┌─ runAccountInit ──────────────────────────────────────────────────────────┐
 * │  checks localStorage guard → checkAccountInitNeeds (fast DB reads)       │
 * │  → runs tasks concurrently:                                              │
 * │      friends          (getFriends API → saveFriends DB)                  │
 * │      labels           (getLabels API  → appStore.setLabels)              │
 * │      quickMessages    (getQuickMessageList API → bulkReplaceLocalQM DB)  │
 * │      oldMessages      (requestOldMessages — fire-and-forget via listener)│
 * │      groups → oldGroupMessages (chained: groups sync first,              │
 * │                                 then getGroupChatHistory per group)      │
 * │  → marks account as initialized in localStorage                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { syncZaloGroups, SyncGroupsProgress } from './zaloGroupUtils';
import { syncZaloLabelsToLocalDB } from './labelUtils';
import { extractUserProfile } from '../../utils/profileUtils';

// ── Public types ──────────────────────────────────────────────────────────────

export type InitTask = 'friends' | 'labels' | 'quickMessages' | 'groups' | 'oldMessages' | 'oldGroupMessages';
export type InitTaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface InitTaskProgress {
  task: InitTask;
  status: InitTaskStatus;
  /** Items processed so far */
  current?: number;
  /** Total items for this task */
  total?: number;
  /** Short human-readable detail */
  detail?: string;
  /** Live group-sync progress object (groups task only, while running) */
  groupProgress?: SyncGroupsProgress;
}

export interface InitNeeds {
  friends: boolean;
  labels: boolean;
  quickMessages: boolean;
  groups: boolean;
  oldMessages: boolean;
  oldGroupMessages: boolean;
  any: boolean;
}

export interface AccountInitOptions {
  activeAccountId: string;
  auth: { cookies: any; imei: string; userAgent: string };
  /** Called whenever a task's progress changes */
  onProgress: (task: InitTask, update: InitTaskProgress) => void;
  /** Pass a ref so the caller can abort (groups phase 2 only) */
  groupStopRef?: { current: boolean };
}

// ── LocalStorage persistence ──────────────────────────────────────────────────

/**
 * Bump this number whenever:
 *  - A new sync task is added (e.g. stickers, settings…)
 *  - An existing task's logic changes in a way that requires a re-sync
 *
 * All accounts whose stored version < SYNC_VERSION will re-run init.
 * First release of this feature → version 1 → every existing account is "unsynced".
 */
const SYNC_VERSION = 15;

/** After init is "done", re-verify local DB data at most once every 24 h. */
const LOCAL_DATA_CHECK_TTL = 24 * 60 * 60 * 1000;

interface InitRecord {
  version: number;
  completedAt: number;
  /** Timestamp of the last successful local-data verification pass. */
  localDataVerifiedAt?: number;
}

const INIT_KEY = (zaloId: string) => {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId || 'default';
  return `zalo_account_init_${wsId}_${zaloId}`;
};

export function isAccountInitDone(zaloId: string): boolean {
  try {
    const raw = localStorage.getItem(INIT_KEY(zaloId));
    if (!raw) return false;
    const parsed: InitRecord = JSON.parse(raw);
    return parsed?.version >= SYNC_VERSION;
  } catch {
    return false;
  }
}

export function markAccountInitDone(zaloId: string): void {
  try {
    // Write a clean record — intentionally DO NOT spread the existing record.
    // Spreading would silently carry over any old `localDataVerifiedAt` value,
    // which would make Stage 2 skip the DB check on the next startup even if
    // the database was wiped or the storage path was changed.
    localStorage.setItem(INIT_KEY(zaloId), JSON.stringify({
      version: SYNC_VERSION,
      completedAt: Date.now(),
    } satisfies InitRecord));
  } catch {}
}

/**
 * Stamp localDataVerifiedAt without changing version/completedAt.
 * Called after a data-check pass that found all data present (no sync needed).
 */
function _markLocalDataVerified(zaloId: string): void {
  try {
    const raw = localStorage.getItem(INIT_KEY(zaloId));
    if (!raw) return;
    const record: InitRecord = JSON.parse(raw);
    record.localDataVerifiedAt = Date.now();
    localStorage.setItem(INIT_KEY(zaloId), JSON.stringify(record));
  } catch {}
}

function _wasLocalDataRecentlyVerified(zaloId: string): boolean {
  try {
    const raw = localStorage.getItem(INIT_KEY(zaloId));
    if (!raw) return false;
    const record: InitRecord = JSON.parse(raw);
    if (!record.localDataVerifiedAt) return false;
    return (Date.now() - record.localDataVerifiedAt) < LOCAL_DATA_CHECK_TTL;
  } catch { return false; }
}

// ── Needs check ───────────────────────────────────────────────────────────────

/**
 * Determines which sync tasks need to run for the given account.
 *
 * Three-stage logic:
 *
 *  Stage 1 — Never initialised (or outdated SYNC_VERSION):
 *    → force ALL 4 tasks to run.
 *
 *  Stage 2 — Already initialised AND local data was verified within the last 24 h:
 *    → nothing to do (fast path, no DB queries).
 *
 *  Stage 3 — Already initialised BUT local data has NOT been verified recently:
 *    → query the local DB for each persistent task (friends, quickMessages, groups).
 *    → if a table is empty, mark that task as needed so it re-syncs.
 *    → labels are NOT checked here because they live in appStore memory and are
 *      refreshed automatically during the normal Zalo connection flow.
 *
 * After Stage 3 resolves with "no needs", `localDataVerifiedAt` is stamped so
 * the check is skipped for the next 24 h.
 */
export async function checkAccountInitNeeds(zaloId: string): Promise<InitNeeds> {
  // ── Stage 1: never done / outdated version ────────────────────────────────
  if (!isAccountInitDone(zaloId)) {
    return { friends: true, labels: true, quickMessages: true, groups: true, oldMessages: true, oldGroupMessages: true, any: true };
  }

  // ── Stage 2: done + recently verified ────────────────────────────────────
  if (_wasLocalDataRecentlyVerified(zaloId)) {
    return { friends: false, labels: false, quickMessages: false, groups: false, oldMessages: false, oldGroupMessages: false, any: false };
  }

  // ── Stage 3: done but stale — check actual local DB data ─────────────────
  const [friendsRes, qmRes, contactsRes, localLabelsRes] = await Promise.allSettled([
    ipc.db?.getFriends({ zaloId }),
    ipc.db?.getLocalQuickMessages({ zaloId }),
    ipc.db?.getContacts(zaloId),
    ipc.db?.getLocalLabels({ zaloId }),   // local_labels table (user-created labels)
  ]);

  const friendCount = friendsRes.status === 'fulfilled'
    ? (friendsRes.value?.friends?.length ?? 0)
    : 0;

  const qmCount = qmRes.status === 'fulfilled'
    ? (qmRes.value?.items?.length ?? 0)
    : 0;

  const allContacts: any[] = contactsRes.status === 'fulfilled'
    ? (contactsRes.value?.contacts ?? contactsRes.value ?? [])
    : [];
  const groupCount = allContacts.filter((c: any) => c.contact_type === 'group').length;

  const localLabelCount = localLabelsRes.status === 'fulfilled'
    ? (localLabelsRes.value?.labels?.length ?? 0)
    : 0;

  const needs = {
    friends:       friendCount === 0,
    labels:        localLabelCount === 0,  // local_labels DB (includes global labels visible to this account)
    quickMessages: qmCount === 0,
    groups:        groupCount === 0,
    oldMessages:       false,  // Session-based — only runs on first init (Stage 1)
    oldGroupMessages:  false,  // Session-based — only runs on first init (Stage 1)
  };

  const any = needs.friends || needs.labels || needs.quickMessages || needs.groups || needs.oldMessages || needs.oldGroupMessages;

  // If everything is present, stamp the verification timestamp now
  // so we skip this Stage-3 pass for the next 24 h.
  if (!any) _markLocalDataVerified(zaloId);

  return { ...needs, any };
}

// ── Individual sync tasks ─────────────────────────────────────────────────────

async function _syncFriends(
  activeAccountId: string,
  auth: any,
  onProgress: (u: InitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'friends', status: 'running', detail: 'Đang tải danh sách bạn bè...' });
  try {
    const res = await ipc.zalo?.getFriends(auth);
    const data = res?.response;
    let list: any[] = [];
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') list = Object.values(data);

    if (list.length > 0) {
      const normalized = list
        .map((f: any) => ({
          userId: f.userId || f.uid || '',
          displayName: f.displayName || f.zaloName || f.display_name || '',
          avatar: f.avatar || '',
          phoneNumber: f.phoneNumber || f.phone || '',
        }))
        .filter((f) => f.userId);
      await ipc.db?.saveFriends({ zaloId: activeAccountId, friends: normalized });

      // ── Step 2: Load aliases to update friend display names ──────────────
      onProgress({
        task: 'friends', status: 'running',
        current: normalized.length, total: normalized.length,
        detail: 'Đang cập nhật biệt danh bạn bè...',
      });
      let aliasCount = 0;
      try {
        const aliasRes = await ipc.zalo?.getAliasList({ auth, count: 5000 });
        const aliasItems: { userId: string; alias: string }[] = aliasRes?.response?.items || [];
        for (const item of aliasItems) {
          if (item.alias && item.userId) {
            useChatStore.getState().updateContact(activeAccountId, {
              contact_id: item.userId,
              alias: item.alias,
            });
            ipc.db?.setContactAlias({ zaloId: activeAccountId, contactId: item.userId, alias: item.alias }).catch(() => {});
            aliasCount++;
          }
        }
      } catch {
        // Alias loading is non-fatal — continue to Step 3
      }

      // ── Step 3: Batch fetch gender/birthday via getUserInfo ──────────────
      onProgress({
        task: 'friends', status: 'running',
        detail: 'Đang tải giới tính & sinh nhật bạn bè...',
      });
      let profileCount = 0;
      const BATCH_SIZE = 40;
      try {
        for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
          const batch = normalized.slice(i, i + BATCH_SIZE);
          const userIds = batch.map(f => f.userId);
          try {
            const uRes = await ipc.zalo?.getUserInfo({ auth, userId: userIds });
            if (uRes?.success && uRes.response) {
              const profiles: Record<string, any> = uRes.response.changed_profiles ?? {};
              const saves: Promise<any>[] = [];
              for (const uid of userIds) {
                const rawProfile = profiles[uid] ?? profiles[`${uid}_0`] ?? null;
                if (!rawProfile) continue;
                const { displayName, avatar, phone, gender, birthday } = extractUserProfile(rawProfile);
                if (gender !== null || birthday) {
                  saves.push(
                    ipc.db?.updateContactProfile({
                      zaloId: activeAccountId,
                      contactId: uid,
                      displayName, avatarUrl: avatar, phone,
                      gender, birthday,
                    }) ?? Promise.resolve()
                  );
                  profileCount++;
                }
              }
              if (saves.length > 0) await Promise.all(saves);
            }
          } catch (err) {
            console.warn('[zaloInitUtils] getUserInfo batch error:', err);
          }
          onProgress({
            task: 'friends', status: 'running',
            current: Math.min(i + BATCH_SIZE, normalized.length),
            total: normalized.length,
            detail: `Đang tải hồ sơ ${Math.min(i + BATCH_SIZE, normalized.length)}/${normalized.length}...`,
          });
          // Small delay between batches to avoid rate limiting
          if (i + BATCH_SIZE < normalized.length) {
            await new Promise(r => setTimeout(r, 200));
          }
        }
      } catch (err) {
        console.warn('[zaloInitUtils] getUserInfo profile fetch error:', err);
      }

      // ── Done ────────────────────────────────────────────────────────────
      const details: string[] = [`${normalized.length} bạn bè`];
      if (aliasCount > 0) details.push(`${aliasCount} biệt danh`);
      if (profileCount > 0) details.push(`${profileCount} hồ sơ`);
      onProgress({
        task: 'friends', status: 'done',
        total: normalized.length, current: normalized.length,
        detail: details.join(', '),
      });
    } else {
      onProgress({ task: 'friends', status: 'done', detail: 'Không có bạn bè' });
    }
  } catch (err: any) {
    onProgress({ task: 'friends', status: 'error', detail: err?.message || 'Lỗi tải bạn bè' });
  }
}

async function _syncLabels(
  activeAccountId: string,
  auth: any,
  onProgress: (u: InitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'labels', status: 'running', detail: 'Đang tải nhãn...' });
  try {
    // ── Step 1: Zalo API labels → appStore memory ──────────────────────────
    let zaloLabelData: any[] = [];
    let zaloLabelCount = 0;
    try {
      const res = await ipc.zalo?.getLabels({ auth });
      zaloLabelData = res?.response?.labelData ?? [];
      const version: number = res?.response?.version ?? 0;
      if (zaloLabelData.length > 0) {
        const store = useAppStore.getState();
        store.setLabels(activeAccountId, zaloLabelData);
        store.setLabelsVersion?.(activeAccountId, version);
        zaloLabelCount = zaloLabelData.length;
      }
    } catch { /* non-fatal — continue to local clone step */ }

    // ── Step 1b: Zalo API labels → local_labels DB (merge mode) ───────────
    let zaloToLocalCount = 0;
    if (zaloLabelCount > 0) {
      try {
        zaloToLocalCount = await syncZaloLabelsToLocalDB({
          zaloLabels: zaloLabelData,
          activeZaloId: activeAccountId,
          mode: 'merge',
        });
      } catch { /* non-fatal */ }
    }

    const details: string[] = [];
    if (zaloLabelCount > 0) details.push(`${zaloLabelCount} nhãn Zalo`);
    if (zaloToLocalCount > 0) details.push(`${zaloToLocalCount} nhãn → local DB`);

    onProgress({
      task: 'labels', status: 'done',
      total: zaloLabelCount,
      current: zaloLabelCount,
      detail: details.length > 0 ? details.join(', ') : 'Không có nhãn',
    });
  } catch (err: any) {
    onProgress({ task: 'labels', status: 'error', detail: err?.message || 'Lỗi tải nhãn' });
  }
}

async function _syncQuickMessages(
  activeAccountId: string,
  auth: any,
  onProgress: (u: InitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'quickMessages', status: 'running', detail: 'Đang tải tin nhắn nhanh...' });
  try {
    const res = await ipc.zalo?.getQuickMessageList({ auth });
    const items: any[] = res?.response?.items ?? [];

    if (items.length > 0) {
      // ── Zalo API has data → save to local DB ────────────────────────────
      const mapped = items.map((i: any) => ({
        keyword: i.keyword || '',
        title: i.message?.title || '',
        media: i.media || undefined,
      }));
      await ipc.db?.bulkReplaceLocalQuickMessages({ zaloId: activeAccountId, items: mapped });
      onProgress({
        task: 'quickMessages', status: 'done',
        total: items.length, current: items.length,
        detail: `${items.length} tin nhắn nhanh`,
      });
    } else {
      // ── Zalo API returned 0 → try to clone from another account ─────────
      const allRes = await ipc.db?.getAllLocalQuickMessages();
      const others: any[] = (allRes?.items || []).filter(
        (item: any) => item.owner_zalo_id && item.owner_zalo_id !== activeAccountId,
      );

      if (others.length > 0) {
        // Pick the account with the most QMs as the source
        const countByAccount: Record<string, number> = {};
        for (const item of others) {
          countByAccount[item.owner_zalo_id] = (countByAccount[item.owner_zalo_id] || 0) + 1;
        }
        const [sourceId, cnt] = Object.entries(countByAccount).sort((a, b) => b[1] - a[1])[0];
        await ipc.db?.cloneLocalQuickMessages({ sourceZaloId: sourceId, targetZaloId: activeAccountId });
        onProgress({
          task: 'quickMessages', status: 'done',
          total: cnt, current: cnt,
          detail: `Đã sao chép ${cnt} tin nhắn nhanh`,
        });
      } else {
        onProgress({ task: 'quickMessages', status: 'done', detail: 'Không có tin nhắn nhanh' });
      }
    }
  } catch (err: any) {
    onProgress({ task: 'quickMessages', status: 'error', detail: err?.message || 'Lỗi tải tin nhắn nhanh' });
  }
}

// ── Main init runner ──────────────────────────────────────────────────────────

/**
 * Tải tin nhắn cũ toàn phiên đăng nhập qua listener.requestOldMessages
 * (fire-and-forget — messages arrive async via old_messages event)
 */
async function _syncOldMessages(
  activeAccountId: string,
  onProgress: (u: InitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'oldMessages', status: 'running', detail: 'Đang yêu cầu tin nhắn cũ...' });
  try {
    const res = await ipc.login?.requestOldMessages(activeAccountId);
    if (res?.success) {
      onProgress({ task: 'oldMessages', status: 'done', detail: 'Đang tải tin nhắn cũ… (nền)' });
    } else {
      onProgress({ task: 'oldMessages', status: 'error', detail: res?.error || 'Lỗi tải tin nhắn cũ' });
    }
  } catch (err: any) {
    onProgress({ task: 'oldMessages', status: 'error', detail: err?.message || 'Lỗi tải tin nhắn cũ' });
  }
}

/**
 * Tải tin nhắn nhóm cũ qua getGroupChatHistory cho tất cả nhóm.
 * Lấy danh sách nhóm từ DB contacts, sau đó gọi API cho từng nhóm.
 */
async function _syncOldGroupMessages(
  activeAccountId: string,
  auth: any,
  onProgress: (u: InitTaskProgress) => void,
): Promise<void> {
  onProgress({ task: 'oldGroupMessages', status: 'running', detail: 'Đang lấy danh sách nhóm...' });
  try {
    // Lấy danh sách nhóm từ DB contacts
    const contactsRes = await ipc.db?.getContacts(activeAccountId);
    const allContacts: any[] = contactsRes?.contacts ?? contactsRes ?? [];
    const groups = allContacts.filter((c: any) => c.contact_type === 'group');

    if (groups.length === 0) {
      onProgress({ task: 'oldGroupMessages', status: 'done', detail: 'Không có nhóm' });
      return;
    }

    let successCount = 0;
    let errorCount = 0;
    const total = groups.length;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const groupId = group.contact_id;
      const groupName = group.display_name || groupId;
      onProgress({
        task: 'oldGroupMessages', status: 'running',
        current: i, total,
        detail: `Tải tin nhắn: ${groupName} (${i + 1}/${total})`,
      });

      try {
        const res = await ipc.zalo?.getGroupChatHistory({ auth, groupId });
        if (res?.success) {
          const msgCount = res?.response?.groupMsgsCount ?? 0;
          successCount++;
          if (msgCount > 0) {
            // Small delay between groups to avoid rate limiting
            await new Promise(r => setTimeout(r, 300));
          }
        } else {
          errorCount++;
        }
      } catch {
        errorCount++;
      }
    }

    const detail = errorCount > 0
      ? `${successCount}/${total} nhóm thành công, ${errorCount} lỗi`
      : `${successCount}/${total} nhóm`;
    onProgress({ task: 'oldGroupMessages', status: 'done', current: total, total, detail });
  } catch (err: any) {
    onProgress({ task: 'oldGroupMessages', status: 'error', detail: err?.message || 'Lỗi tải tin nhắn nhóm' });
  }
}

/**
 * Runs all 6 sync tasks for the given account.
 * Tasks already satisfied (data exists in DB/store) are marked 'skipped'.
 * Records completion in localStorage so it never runs again for this account.
 *
 *   friends, labels, quickMessages, oldMessages — run concurrently
 *   groups → oldGroupMessages — chained (old group msgs run AFTER groups sync)
 */
export async function runAccountInit(opts: AccountInitOptions): Promise<void> {
  const { activeAccountId, auth, onProgress, groupStopRef } = opts;

  const needs = await checkAccountInitNeeds(activeAccountId);

  if (!needs.any) {
    markAccountInitDone(activeAccountId);
    return;
  }

  // Announce initial status for every task
  const allTasks: InitTask[] = ['friends', 'labels', 'quickMessages', 'groups', 'oldMessages', 'oldGroupMessages'];
  for (const task of allTasks) {
    onProgress(task, {
      task,
      status: (needs as unknown as Record<string, boolean>)[task] ? 'pending' : 'skipped',
    });
  }

  const promises: Promise<void>[] = [];

  if (needs.friends) {
    promises.push(
      _syncFriends(activeAccountId, auth, (u) => onProgress('friends', u)),
    );
  }

  if (needs.labels) {
    promises.push(
      _syncLabels(activeAccountId, auth, (u) => onProgress('labels', u)),
    );
  }

  if (needs.quickMessages) {
    promises.push(
      _syncQuickMessages(activeAccountId, auth, (u) => onProgress('quickMessages', u)),
    );
  }

  // ── Old messages (fire-and-forget via listener) ─────────────────────────
  if (needs.oldMessages) {
    promises.push(
      _syncOldMessages(activeAccountId, (u) => onProgress('oldMessages', u)),
    );
  }

  // ── Groups + Old group messages (chained: old group msgs run AFTER groups) ──
  if (needs.groups || needs.oldGroupMessages) {
    const groupsChain = async () => {
      // Phase 1: Sync groups (if needed)
      if (needs.groups) {
        onProgress('groups', {
          task: 'groups', status: 'running', detail: 'Đang đồng bộ nhóm...',
        });
        try {
          await syncZaloGroups({
            activeAccountId,
            auth,
            stopRef: groupStopRef,
            onProgress: (p: SyncGroupsProgress) => {
              onProgress('groups', {
                task: 'groups',
                status: 'running',
                current: p.phase === 'groups' ? p.current : (p.groupCurrent ?? 0),
                total:   p.phase === 'groups' ? p.total   : (p.groupTotal   ?? 1),
                detail:
                  p.phase === 'groups'
                    ? `Đồng bộ nhóm ${p.current}/${p.total}`
                    : `Tải thành viên${p.currentGroupName ? ': ' + p.currentGroupName : ''}`,
                groupProgress: p,
              });
            },
            onGroupEnriched: async () => {
              // onProgress is already called inside the syncZaloGroups onProgress callback.
            },
          });
          onProgress('groups', { task: 'groups', status: 'done', detail: 'Đã đồng bộ nhóm' });
        } catch (err: any) {
          onProgress('groups', {
            task: 'groups', status: 'error',
            detail: err?.message || 'Lỗi đồng bộ nhóm',
          });
        }
      }

      // Phase 2: Load old group messages (after groups are synced)
      if (needs.oldGroupMessages) {
        await _syncOldGroupMessages(activeAccountId, auth, (u) => onProgress('oldGroupMessages', u));
      }
    };
    promises.push(groupsChain());
  }

  await Promise.allSettled(promises);
  markAccountInitDone(activeAccountId);
  // Stamp verified-at so Stage 2 fast-paths the next 24 h.
  // This prevents the panel from re-appearing every startup when a task
  // (e.g. labels) legitimately found nothing to sync/clone.
  _markLocalDataVerified(activeAccountId);
}

