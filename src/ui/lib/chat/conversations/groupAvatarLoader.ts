/**
 * Group photos in the conversation list: only loaded for the groups CURRENTLY SHOWN (ConversationGroupAvatar reports when a row enters the
 * visible area, so loading follows the scroll).
 *
 * Previously every account change (and after every incoming message, 1 s) the list scanned ALL the groups of the account: it read the members
 * from the DB and called the API for each group missing a photo, with one store update per group → the whole list re-rendered hundreds of times
 * → stutter, especially for accounts with many groups. Now:
 *  - a queue per group (DB at most 3 at a time; Zalo batches ≤10 groups per getGroupInfo call; Telegram 500 ms apart);
 *  - results are batched, written to the store ~once per 120 ms (one re-render for the whole batch);
 *  - remembered by `${account}:${group}` for the whole session: switching between accounts does not reload; a group that still has no photo
 *    (already tried) is only retried after 10 minutes and only when it is shown on screen again.
 * The composite photo data (members) lives in appStore.groupInfoCache, kept across account changes.
 */
import { useAppStore, type CachedGroupInfo } from '@/store/app/appStore';
import { useChatStore, type ContactItem } from '@/store/chat/chatStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { syncZaloGroups, type MemberPlaceholder } from '@/lib/zalo/zaloGroupUtils';

export const GROUP_AVATAR_RETRY_MS = 10 * 60_000;
const DB_CONCURRENCY = 3;
const FLUSH_MS = 120;
const ZALO_BATCH = 10;
const ZALO_BATCH_WAIT_MS = 250;
const TELEGRAM_GAP_MS = 500;

type LoadState = 'queued' | 'loading' | 'done';
interface LoadStatus { state: LoadState; at: number }

const status = new Map<string, LoadStatus>();
const dbQueue: Array<{ accountId: string; groupId: string }> = [];
let dbActive = 0;
const pendingInfos = new Map<string, { accountId: string; groupId: string; info: CachedGroupInfo }>();
const pendingContacts = new Map<string, { accountId: string; contact: Partial<ContactItem> & { contact_id: string } }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const zaloPending = new Map<string, string[]>();
let zaloTimer: ReturnType<typeof setTimeout> | null = null;
let zaloRunning = false;
const telegramQueue: Array<{ accountId: string; groupId: string }> = [];
let telegramRunning = false;

const keyOf = (accountId: string, groupId: string) => `${accountId}:${groupId}`;

/** Members usable for the composite photo (real ids). */
export function validGroupMembers(info: CachedGroupInfo | null | undefined) {
  return (info?.members || []).filter(member => member.userId && member.userId !== 'undefined');
}

/** Row already has enough to draw the photo: the group photo, or ≥ 2 members with photos for the composite photo. */
export function groupAvatarSatisfied(avatarUrl: string | null | undefined, info: CachedGroupInfo | null | undefined): boolean {
  if (avatarUrl) return true;
  return validGroupMembers(info).filter(member => member.avatar).length >= 2;
}

/** Group name is still the id (the real name could not be fetched). */
export function groupNameMissing(contact: Pick<ContactItem, 'contact_id' | 'display_name'> | null | undefined): boolean {
  const name = String(contact?.display_name || '');
  return !name || name === contact?.contact_id || /^\d+$/.test(name);
}

/** memVerList "uid_version" / memberIds / currentMems of Zalo getGroupInfo → list of uids. */
export function parseZaloMemberIds(gi: any): string[] {
  const parseMemVerList = (list: string[]): string[] => list.map(entry => {
    if (typeof entry !== 'string') return String(entry || '');
    const lastUnder = entry.lastIndexOf('_');
    if (lastUnder <= 0) return entry;
    const possibleVer = entry.substring(lastUnder + 1);
    if (/^\d+$/.test(possibleVer) && possibleVer.length < entry.substring(0, lastUnder).length) return entry.substring(0, lastUnder);
    return entry;
  });
  const raw: string[] = gi?.memberIds?.length > 0 ? gi.memberIds.map(String)
    : gi?.currentMems?.length > 0 ? gi.currentMems.map((member: any) => String(member?.id || ''))
      : parseMemVerList(gi?.memVerList || []);
  return [...new Set(raw.map(id => String(id).replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id)))];
}

/** Merges the new member list into the existing cache entry (keeps the settings / admin info / known group name). */
export function mergeGroupMembers(
  existing: CachedGroupInfo | undefined,
  groupId: string,
  fallbackName: string,
  rows: Array<{ member_id: string; display_name?: string; avatar?: string; role?: number }>,
  extra: Partial<CachedGroupInfo> = {},
): CachedGroupInfo {
  const members = rows.map(row => ({
    userId: String(row.member_id),
    displayName: row.display_name || String(row.member_id),
    avatar: row.avatar || '',
    role: Number(row.role || 0),
  }));
  return {
    ...(existing || { creatorId: '', adminIds: [], settings: undefined }),
    groupId,
    name: extra.name || existing?.name || fallbackName || groupId,
    avatar: extra.avatar ?? existing?.avatar ?? '',
    memberCount: Math.max(Number(extra.memberCount || 0), Number(existing?.memberCount || 0), members.length),
    members,
    ...(extra.creatorId !== undefined ? { creatorId: extra.creatorId } : {}),
    ...(extra.adminIds !== undefined ? { adminIds: extra.adminIds } : {}),
    ...(extra.settings !== undefined ? { settings: extra.settings } : {}),
    fetchedAt: Date.now(),
  } as CachedGroupInfo;
}

function findContact(accountId: string, groupId: string): ContactItem | undefined {
  return (useChatStore.getState().contacts[accountId] || []).find(contact => contact.contact_id === groupId);
}

function cachedInfo(accountId: string, groupId: string): CachedGroupInfo | undefined {
  return (useAppStore.getState().groupInfoCache[accountId] || {})[groupId];
}

/** Writes the pending results into the store once (one list re-render for the whole batch). */
export function flushGroupAvatarUpdates(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pendingInfos.size > 0) {
    const updates = [...pendingInfos.values()];
    pendingInfos.clear();
    useAppStore.setState(state => {
      const next = { ...state.groupInfoCache };
      for (const { accountId, groupId, info } of updates) {
        next[accountId] = { ...(next[accountId] || {}), [groupId]: info };
      }
      return { groupInfoCache: next };
    });
  }
  if (pendingContacts.size > 0) {
    const updates = [...pendingContacts.values()];
    pendingContacts.clear();
    const { updateContact } = useChatStore.getState();
    // The same task → React merges them into one re-render
    for (const { accountId, contact } of updates) updateContact(accountId, contact);
  }
}

function scheduleFlush(): void {
  if (!flushTimer) flushTimer = setTimeout(flushGroupAvatarUpdates, FLUSH_MS);
}

function queueInfo(accountId: string, groupId: string, info: CachedGroupInfo): void {
  pendingInfos.set(keyOf(accountId, groupId), { accountId, groupId, info });
  scheduleFlush();
}

function queueContact(accountId: string, contact: Partial<ContactItem> & { contact_id: string }): void {
  const key = keyOf(accountId, contact.contact_id);
  const prev = pendingContacts.get(key);
  pendingContacts.set(key, { accountId, contact: { ...(prev?.contact || {}), ...contact } });
  scheduleFlush();
}

function finish(accountId: string, groupId: string): void {
  status.set(keyOf(accountId, groupId), { state: 'done', at: Date.now() });
}

/**
 * Group rows just shown on screen with no photo yet: queued for loading (DB first, then API if missing). Skipped if already loading or
 * tried within the last 10 minutes: switching between accounts does not reload.
 */
export function requestGroupAvatar(accountId: string, groupId: string): void {
  if (!accountId || !groupId) return;
  const key = keyOf(accountId, groupId);
  const current = status.get(key);
  if (current && (current.state !== 'done' || Date.now() - current.at < GROUP_AVATAR_RETRY_MS)) return;
  if (groupAvatarSatisfied(findContact(accountId, groupId)?.avatar_url, cachedInfo(accountId, groupId))) return;
  status.set(key, { state: 'queued', at: Date.now() });
  dbQueue.push({ accountId, groupId });
  pumpDb();
}

function pumpDb(): void {
  while (dbActive < DB_CONCURRENCY && dbQueue.length > 0) {
    const item = dbQueue.shift()!;
    dbActive++;
    void loadFromDb(item.accountId, item.groupId).finally(() => {
      dbActive--;
      pumpDb();
    });
  }
}

function accountChannelOf(accountId: string): string {
  return useAccountStore.getState().accounts.find(account => account.zalo_id === accountId)?.channel || 'zalo';
}

async function loadFromDb(accountId: string, groupId: string): Promise<void> {
  status.set(keyOf(accountId, groupId), { state: 'loading', at: Date.now() });
  const contact = findContact(accountId, groupId);
  try {
    const res: any = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
    const rows: any[] = (res?.members || []).filter((row: any) => row?.member_id && /^\d+$/.test(String(row.member_id).trim()));
    if (rows.length > 0) {
      queueInfo(accountId, groupId, mergeGroupMembers(cachedInfo(accountId, groupId), groupId, contact?.display_name || groupId, rows));
    }
    // Group photos only come from the API (Boss machine); employees use the Boss's DB data
    if (contact?.avatar_url || useEmployeeStore.getState().mode === 'employee') return finish(accountId, groupId);
    const channel = accountChannelOf(accountId);
    if (channel === 'telegram_user') {
      telegramQueue.push({ accountId, groupId });
      void pumpTelegram();
      return;
    }
    // Zalo: ask for group photos once (batches ≤10 groups per call): a group with its own photo that the DB has not saved yet will show the right photo
    if (channel === 'zalo') {
      const list = zaloPending.get(accountId) || [];
      if (!list.includes(groupId)) list.push(groupId);
      zaloPending.set(accountId, list);
      if (!zaloTimer) zaloTimer = setTimeout(() => { zaloTimer = null; void pumpZalo(); }, ZALO_BATCH_WAIT_MS);
      return;
    }
    finish(accountId, groupId);
  } catch (err) {
    console.warn(`[groupAvatarLoader] DB ${groupId}:`, err);
    finish(accountId, groupId);
  }
}

async function pumpTelegram(): Promise<void> {
  if (telegramRunning) return;
  telegramRunning = true;
  try {
    while (telegramQueue.length > 0) {
      const { accountId, groupId } = telegramQueue.shift()!;
      try {
        const res: any = await ipc.telegramUser?.getGroupInfo({ accountId, chatId: groupId });
        if (res?.success && res.info) {
          const entity = res.info.entity || res.info.full || res.info || {};
          const name = entity.title || entity.username || '';
          const avatarUrl = res.info.avatarUrl || '';
          if (name || avatarUrl) {
            queueContact(accountId, { contact_id: groupId, ...(name ? { display_name: name } : {}), ...(avatarUrl ? { avatar_url: avatarUrl } : {}), contact_type: 'group' });
            DataAccessor.updateContactProfile({
              zaloId: accountId, contactId: groupId, displayName: name || groupId, avatarUrl: avatarUrl || '', phone: '', contactType: 'group',
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`[groupAvatarLoader] Telegram ${groupId}:`, err);
      }
      finish(accountId, groupId);
      if (telegramQueue.length > 0) await new Promise(resolve => setTimeout(resolve, TELEGRAM_GAP_MS));
    }
  } finally {
    telegramRunning = false;
  }
}

async function pumpZalo(): Promise<void> {
  if (zaloRunning) return;
  zaloRunning = true;
  try {
    for (;;) {
      const entry = [...zaloPending.entries()].find(([, ids]) => ids.length > 0);
      if (!entry) break;
      const [accountId, ids] = entry;
      const batch = ids.splice(0, ZALO_BATCH);
      if (ids.length === 0) zaloPending.delete(accountId);
      await loadZaloBatch(accountId, batch);
    }
  } finally {
    zaloRunning = false;
  }
}

async function loadZaloBatch(accountId: string, groupIds: string[]): Promise<void> {
  const account = useAccountStore.getState().accounts.find(item => item.zalo_id === accountId);
  if (!account) {
    groupIds.forEach(groupId => finish(accountId, groupId));
    return;
  }
  const auth = buildZaloAuth(account, accountId);
  let gridMap: Record<string, any> = {};
  try {
    const res: any = await ipc.zalo?.getGroupInfo({ auth, groupId: groupIds });
    gridMap = res?.response?.gridInfoMap || res?.response?.changed_groups || {};
  } catch (err) {
    console.warn('[groupAvatarLoader] Zalo getGroupInfo:', err);
  }
  for (const groupId of groupIds) {
    const gi = gridMap[groupId];
    if (!gi) { finish(accountId, groupId); continue; }
    const groupName = gi.name || gi.nameChanged || groupId;
    const groupAvatar = gi.avt || gi.fullAvt || '';
    queueContact(accountId, { contact_id: groupId, display_name: groupName, ...(groupAvatar ? { avatar_url: groupAvatar } : {}), contact_type: 'group' });
    DataAccessor.updateContactProfile({
      zaloId: accountId, contactId: groupId, displayName: groupName, avatarUrl: groupAvatar, phone: '', contactType: 'group',
    }).catch(() => {});
    if (groupAvatar) { finish(accountId, groupId); continue; }
    // Group has no photo set, and the DB already has enough member photos for the composite photo → done
    if (groupAvatarSatisfied('', pendingInfos.get(keyOf(accountId, groupId))?.info || cachedInfo(accountId, groupId))) {
      finish(accountId, groupId);
      continue;
    }

    // Missing member photos → add member names + photos (as before, but only for the group on screen)
    const memberIds = parseZaloMemberIds(gi);
    if (memberIds.length === 0) { finish(accountId, groupId); continue; }
    const creatorId = String(gi.creatorId || gi.creator || '').replace(/_0$/, '');
    const adminIds = (gi.adminIds || gi.subAdmins || []).map((id: string) => String(id).replace(/_0$/, ''));
    const adminSet = new Set([creatorId, ...adminIds]);
    const placeholders: MemberPlaceholder[] = memberIds.map(memberId => ({
      memberId, displayName: '', avatar: '', role: memberId === creatorId ? 2 : adminSet.has(memberId) ? 1 : 0,
    }));
    const reloadFromDb = async () => {
      const dbRes: any = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
      const rows: any[] = (dbRes?.members ?? []).filter((row: any) => /^\d+$/.test(String(row.member_id || '').trim()));
      if (rows.length === 0) return;
      queueInfo(accountId, groupId, mergeGroupMembers(cachedInfo(accountId, groupId), groupId, groupName, rows, {
        name: groupName, avatar: '', memberCount: gi.totalMember || rows.length, creatorId, adminIds, settings: gi.setting || {},
      }));
    };
    await syncZaloGroups({
      activeAccountId: accountId, auth, groupId, memberIds, placeholders,
      onPhase1Done: reloadFromDb,
      onGroupEnriched: reloadFromDb,
    }).catch(err => console.warn(`[groupAvatarLoader] syncZaloGroups ${groupId}:`, err));
    finish(accountId, groupId);
  }
}

/** Test: queue state. */
export const __groupAvatarLoaderTest = {
  status,
  reset(): void {
    status.clear();
    dbQueue.length = 0;
    dbActive = 0;
    pendingInfos.clear();
    pendingContacts.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    zaloPending.clear();
    if (zaloTimer) clearTimeout(zaloTimer);
    zaloTimer = null;
    zaloRunning = false;
    telegramQueue.length = 0;
    telegramRunning = false;
  },
};
