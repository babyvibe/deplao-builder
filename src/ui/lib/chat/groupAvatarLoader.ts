/**
 * Ảnh nhóm trong danh sách hội thoại — chỉ tải cho NHÓM ĐANG HIỆN (ConversationGroupAvatar báo khi hàng vào vùng
 * nhìn thấy, cuộn tới đâu tải tới đó).
 *
 * Trước đây mỗi lần đổi tài khoản (và sau mọi tin nhắn đến, 1 s) danh sách quét TOÀN BỘ nhóm của tài khoản: đọc thành
 * viên từ DB rồi gọi API cho từng nhóm thiếu ảnh, mỗi nhóm một lần cập nhật store → cả danh sách dựng lại hàng trăm lần
 * → giật, nhất là tài khoản nhiều nhóm. Giờ:
 *  - hàng đợi theo nhóm (DB đồng thời tối đa 3; Zalo gom ≤10 nhóm / lần getGroupInfo; Telegram cách nhau 500 ms);
 *  - kết quả gom lại, ghi store ~1 lần / 120 ms (một lần dựng lại cho cả loạt);
 *  - nhớ theo `${tài khoản}:${nhóm}` trong suốt phiên — đổi qua lại giữa các tài khoản không tải lại; nhóm chưa có ảnh
 *    (đã thử) chỉ thử lại sau 10 phút và chỉ khi lại hiện trên màn hình.
 * Dữ liệu ảnh ghép (thành viên) nằm ở appStore.groupInfoCache — giữ nguyên qua các lần đổi tài khoản.
 */
import { useAppStore, type CachedGroupInfo } from '@/store/appStore';
import { useChatStore, type ContactItem } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useEmployeeStore } from '@/store/employeeStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { syncZaloGroups, type MemberPlaceholder } from '@/lib/zaloGroupUtils';

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

/** Thành viên dùng được cho ảnh ghép (id thật). */
export function validGroupMembers(info: CachedGroupInfo | null | undefined) {
  return (info?.members || []).filter(member => member.userId && member.userId !== 'undefined');
}

/** Hàng đã có đủ để vẽ ảnh: ảnh nhóm, hoặc ≥ 2 thành viên có ảnh cho ảnh ghép. */
export function groupAvatarSatisfied(avatarUrl: string | null | undefined, info: CachedGroupInfo | null | undefined): boolean {
  if (avatarUrl) return true;
  return validGroupMembers(info).filter(member => member.avatar).length >= 2;
}

/** Tên nhóm còn là id (chưa lấy được tên thật). */
export function groupNameMissing(contact: Pick<ContactItem, 'contact_id' | 'display_name'> | null | undefined): boolean {
  const name = String(contact?.display_name || '');
  return !name || name === contact?.contact_id || /^\d+$/.test(name);
}

/** memVerList "uid_version" / memberIds / currentMems của getGroupInfo Zalo → danh sách uid. */
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

/** Gộp danh sách thành viên mới vào bản cache đang có (giữ cài đặt / quản trị / tên nhóm đã biết). */
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

/** Ghi các kết quả đang chờ vào store một lần (một lần dựng lại danh sách cho cả loạt). */
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
    // Cùng một tác vụ → React gộp thành một lần dựng lại
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
 * Hàng nhóm vừa hiện trên màn hình mà chưa có ảnh: xếp hàng tải (DB trước, thiếu thì API). Bỏ qua nếu đang tải hoặc
 * vừa thử trong 10 phút — đổi qua lại giữa các tài khoản không tải lại.
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
    // Ảnh nhóm chỉ có qua API (máy Boss); nhân viên dùng dữ liệu DB của Boss
    if (contact?.avatar_url || useEmployeeStore.getState().mode === 'employee') return finish(accountId, groupId);
    const channel = accountChannelOf(accountId);
    if (channel === 'telegram_user') {
      telegramQueue.push({ accountId, groupId });
      void pumpTelegram();
      return;
    }
    // Zalo: hỏi ảnh nhóm một lần (gom ≤10 nhóm / lần) — nhóm có ảnh riêng mà DB chưa lưu sẽ hiện đúng ảnh
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
    // Nhóm không đặt ảnh, DB đã đủ ảnh thành viên cho ảnh ghép → xong
    if (groupAvatarSatisfied('', pendingInfos.get(keyOf(accountId, groupId))?.info || cachedInfo(accountId, groupId))) {
      finish(accountId, groupId);
      continue;
    }

    // Thiếu ảnh thành viên → bổ sung tên + ảnh thành viên (như trước, nhưng chỉ nhóm đang hiện)
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

/** Test: trạng thái hàng đợi. */
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
