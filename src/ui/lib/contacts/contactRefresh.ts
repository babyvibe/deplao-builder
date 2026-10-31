/**
 * contactRefresh.ts — tự động làm mới tên/avatar liên hệ Zalo theo UID.
 *
 * Avatar CDN của Zalo hết hạn sau một thời gian (ảnh trả 403); nhiều liên hệ chưa kết bạn chỉ có UID
 * làm tên. Hai đường vào:
 *   1. `refreshStaleContacts(accountId, contacts)` — khi CRM tải xong một trang liên hệ: chọn liên hệ
 *      thiếu tên / thiếu avatar / avatar đã báo lỗi / quá 7 ngày chưa làm mới, gọi
 *      `zalo:refreshContactsInfo` (main process gọi getUserInfo theo lô 50, ghi DB theo UID) rồi vá
 *      CRM store + chat store tại chỗ. Mỗi trang mới (UID mới) là một lượt mới; cùng UID không hỏi lại
 *      trong 6 giờ (DB cũng đóng dấu `info_refreshed_at` cho mọi UID đã hỏi).
 *   2. `reportBrokenAvatar(accountId, contactId)` — từ `<img onError>`: avatar 403/hỏng được gom lại
 *      (debounce) rồi làm mới theo lô, không phụ thuộc mốc 7 ngày.
 *
 * Fire-and-forget: không chặn render, không setState trong lúc render, lỗi chỉ ghi log.
 * Bỏ qua ở chế độ nhân viên (không có phiên Zalo cục bộ) và với tài khoản không phải Zalo.
 *
 * TODO(facebook/telegram): `fb:refreshContactAvatar` tải lại cả thread list qua GraphQL cho mỗi
 * contact, `telegramUser:refreshContactAvatar` tải file avatar từng người (dễ dính flood-wait) —
 * chưa có đường làm mới hàng loạt đủ rẻ cho hai kênh này; cần API batch riêng trước khi bật.
 */
import ipc, { buildZaloAuth } from '../ipc';
import { isZalo } from '../channels/channelHelper';
import type { ContactInfoProfile } from '../../../models/chat/contact';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { useCRMStore } from '@/store/crm/crmStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';

/** Quá 7 ngày chưa làm mới → coi là cũ. */
export const CONTACT_INFO_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Cùng một UID không hỏi lại trong 6 giờ (kể cả khi API không trả profile hay avatar mới vẫn hỏng). */
export const CONTACT_REFRESH_RETRY_MS = 6 * 60 * 60 * 1000;
/** Tối đa 500 UID mỗi lượt (= 10 lô getUserInfo). */
export const CONTACT_REFRESH_MAX_PER_RUN = 500;

/** Nhịp gọi — test có thể hạ về 0 qua `configureContactRefresh`. */
const timing = {
  /** Hai lượt của cùng tài khoản cách nhau tối thiểu (gộp khi lật trang nhanh). */
  minGapMs: 1500,
  /** Gom các avatar báo lỗi trong khoảng này rồi mới gọi một lượt. */
  brokenDebounceMs: 800,
};
export function configureContactRefresh(opts: Partial<typeof timing>): void {
  Object.assign(timing, opts);
}

/** Hình dạng tối thiểu bộ lọc cần — khớp cả CRMContact (`avatar`) lẫn ContactItem (`avatar_url`). */
export interface RefreshableContact {
  contact_id: string;
  display_name?: string;
  avatar?: string;
  avatar_url?: string;
  contact_type?: string;
  channel?: string;
  info_refreshed_at?: number | null;
}

export interface StaleSelection {
  /** Đã khử trùng, xếp theo ưu tiên: thiếu tên → thiếu/hỏng avatar → cũ nhất trước */
  contacts: RefreshableContact[];
  nameMissing: number;
  avatarMissing: number;
  expired: number;
}

// ─── Trạng thái trong phiên ──────────────────────────────────────────────────
/** accountId → contactId → thời điểm đã gửi đi (không hỏi lại trong 6 giờ). */
const attemptedByAccount = new Map<string, Map<string, number>>();
/** accountId → UID có avatar đã báo lỗi (403/hỏng), chờ làm mới. */
const brokenByAccount = new Map<string, Set<string>>();
const brokenTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runningAccounts = new Set<string>();
/** Danh sách mới nhất được yêu cầu trong lúc một lượt đang chạy → chạy tiếp khi xong. */
const queuedByAccount = new Map<string, RefreshableContact[]>();
const lastRunByAccount = new Map<string, number>();
const gapTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isContactNameMissing(c: RefreshableContact): boolean {
  const name = String(c.display_name || '').trim();
  return !name || name === String(c.contact_id) || /^-?\d+$/.test(name);
}

export function isContactAvatarMissing(c: RefreshableContact): boolean {
  return !String(c.avatar || c.avatar_url || '').trim();
}

export function isContactInfoExpired(c: RefreshableContact, now: number = Date.now()): boolean {
  const ts = Number(c.info_refreshed_at || 0);
  return !ts || now - ts > CONTACT_INFO_STALE_MS;
}

function isGroupContact(c: RefreshableContact): boolean {
  const t = String(c.contact_type ?? '');
  return t === 'group' || t === '1';
}

/**
 * Lọc liên hệ cần làm mới: thiếu tên (rỗng / bằng UID / toàn số), thiếu avatar hoặc avatar đã báo lỗi
 * (`brokenIds`), hoặc quá 7 ngày (chưa có `info_refreshed_at` cũng tính là cũ). Chỉ user Zalo: bỏ nhóm
 * và kênh khác. Khử trùng.
 */
export function selectStaleContacts(
  contacts: RefreshableContact[],
  now: number = Date.now(),
  brokenIds?: Set<string>,
): StaleSelection {
  const seen = new Set<string>();
  const nameMissing: RefreshableContact[] = [];
  const avatarMissing: RefreshableContact[] = [];
  const expired: RefreshableContact[] = [];
  for (const c of contacts || []) {
    const id = String(c?.contact_id || '').trim();
    if (!id || id === 'undefined' || seen.has(id)) continue;
    if (isGroupContact(c) || !isZalo(c.channel)) continue;
    seen.add(id);
    if (isContactNameMissing(c)) nameMissing.push(c);
    else if (isContactAvatarMissing(c) || brokenIds?.has(id)) avatarMissing.push(c);
    else if (isContactInfoExpired(c, now)) expired.push(c);
  }
  expired.sort((a, b) => Number(a.info_refreshed_at || 0) - Number(b.info_refreshed_at || 0));
  return {
    contacts: [...nameMissing, ...avatarMissing, ...expired],
    nameMissing: nameMissing.length,
    avatarMissing: avatarMissing.length,
    expired: expired.length,
  };
}

function wasAttemptedRecently(accountId: string, contactId: string, now: number): boolean {
  const ts = attemptedByAccount.get(accountId)?.get(contactId);
  return !!ts && now - ts < CONTACT_REFRESH_RETRY_MS;
}

function markAttempted(accountId: string, ids: string[], now: number): void {
  let map = attemptedByAccount.get(accountId);
  if (!map) {
    map = new Map();
    attemptedByAccount.set(accountId, map);
  }
  for (const id of ids) map.set(id, now);
}

/** Lần gọi không chạy được (VD: tài khoản chưa kết nối) → trả lại để lần tải sau thử lại. */
function unmarkAttempted(accountId: string, ids: string[]): void {
  const map = attemptedByAccount.get(accountId);
  for (const id of ids) map?.delete(id);
}

function canUseAccount(accountId: string): { ok: boolean; account?: any } {
  if (useEmployeeStore.getState().mode === 'employee') return { ok: false };
  const account = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
  if (!account || !isZalo(account.channel)) return { ok: false };
  return { ok: true, account };
}

/**
 * Cập nhật tên/avatar vào CRM store + chat store tại chỗ — một setState mỗi store, chỉ sửa dòng đã có
 * (không thêm liên hệ mới vào danh sách hội thoại), trả về state cũ nếu không có gì đổi.
 * `checkedIds`: mọi UID đã hỏi (DB đã đóng dấu) → đóng dấu `info_refreshed_at` trong CRM store luôn.
 */
export function applyRefreshedProfiles(accountId: string, profiles: ContactInfoProfile[], checkedIds: string[] = []): void {
  const byId = new Map((profiles || []).map(p => [String(p.contactId), p]));
  const checked = new Set(checkedIds.map(String));
  if (byId.size === 0 && checked.size === 0) return;
  const now = Date.now();

  const broken = brokenByAccount.get(accountId);
  if (broken) {
    for (const p of profiles || []) if (p.avatarUrl) broken.delete(String(p.contactId));
  }

  useCRMStore.setState(state => {
    let changed = false;
    const contacts = state.contacts.map(c => {
      const id = String(c.contact_id);
      const p = byId.get(id);
      if (!p && !checked.has(id)) return c;
      changed = true;
      return {
        ...c,
        display_name: p?.displayName || c.display_name,
        avatar: p?.avatarUrl || c.avatar,
        info_refreshed_at: now,
      };
    });
    return changed ? { contacts } : state;
  });

  if (byId.size === 0) return;
  useChatStore.setState(state => {
    const list = state.contacts[accountId];
    if (!list || list.length === 0) return state;
    let changed = false;
    const next = list.map(c => {
      const p = byId.get(String(c.contact_id));
      if (!p) return c;
      const display_name = p.displayName || c.display_name;
      const avatar_url = p.avatarUrl || c.avatar_url;
      if (display_name === c.display_name && avatar_url === c.avatar_url) return c;
      changed = true;
      return { ...c, display_name, avatar_url };
    });
    return changed ? { contacts: { ...state.contacts, [accountId]: next } } : state;
  });
}

/** Gọi IPC cho đúng danh sách UID (đã lọc), vá store. Không throw. */
async function runRefresh(accountId: string, account: any, userIds: string[], reason: string): Promise<void> {
  if (userIds.length === 0) return;
  const now = Date.now();
  runningAccounts.add(accountId);
  lastRunByAccount.set(accountId, now);
  markAttempted(accountId, userIds, now);
  console.log(`[contactRefresh] ${accountId}: làm mới ${userIds.length} liên hệ (${reason})`);
  try {
    const res = await ipc.zalo?.refreshContactsInfo({ auth: buildZaloAuth(account, accountId), userIds });
    if (!res?.success || !res.response) {
      console.warn(`[contactRefresh] ${accountId}: IPC thất bại: ${res?.error || 'không rõ'}`);
      unmarkAttempted(accountId, userIds);
      return;
    }
    const r = res.response;
    console.log(`[contactRefresh] ${accountId}: ${r.updated} dòng DB cập nhật, ${r.profiles.length} profile, ${r.checked}/${userIds.length} UID đã hỏi, ${r.failed.length} lỗi${r.error ? ` (${r.error})` : ''}`);
    applyRefreshedProfiles(accountId, r.profiles, userIds.slice(0, r.checked || userIds.length));
    if (r.error) unmarkAttempted(accountId, userIds.slice(r.checked || 0));
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi`, err?.message || err);
    unmarkAttempted(accountId, userIds);
  } finally {
    runningAccounts.delete(accountId);
    const queued = queuedByAccount.get(accountId);
    if (queued) {
      queuedByAccount.delete(accountId);
      void refreshStaleContacts(accountId, queued);
    } else if (brokenByAccount.get(accountId)?.size) {
      scheduleBrokenRefresh(accountId);
    }
  }
}

/**
 * Chọn liên hệ cũ trong `contacts` (một trang CRM), gọi IPC làm mới hàng loạt rồi cập nhật store.
 * Không bao giờ throw. Mỗi trang là một lượt; UID đã hỏi trong 6 giờ không hỏi lại. Nếu đang có lượt
 * chạy thì danh sách mới nhất được xếp hàng và chạy tiếp ngay khi xong; hai lượt cách nhau ≥ 1.5 giây.
 */
export async function refreshStaleContacts(accountId: string, contacts: RefreshableContact[]): Promise<void> {
  if (!accountId || !Array.isArray(contacts) || contacts.length === 0) return;
  try {
    const { ok, account } = canUseAccount(accountId);
    if (!ok) return;

    const now = Date.now();
    const selection = selectStaleContacts(contacts, now, brokenByAccount.get(accountId));
    const pending = selection.contacts.filter(c => !wasAttemptedRecently(accountId, String(c.contact_id), now));
    if (pending.length === 0) return;

    if (runningAccounts.has(accountId)) {
      queuedByAccount.set(accountId, contacts);
      return;
    }
    const sinceLast = now - (lastRunByAccount.get(accountId) || 0);
    if (sinceLast < timing.minGapMs) {
      const prev = gapTimers.get(accountId);
      if (prev) clearTimeout(prev);
      gapTimers.set(accountId, setTimeout(() => {
        gapTimers.delete(accountId);
        void refreshStaleContacts(accountId, contacts);
      }, timing.minGapMs - sinceLast));
      return;
    }

    const userIds = pending.slice(0, CONTACT_REFRESH_MAX_PER_RUN).map(c => String(c.contact_id));
    await runRefresh(
      accountId, account, userIds,
      `thiếu tên ${selection.nameMissing}, thiếu/hỏng avatar ${selection.avatarMissing}, quá hạn ${selection.expired}, chọn ${userIds.length}/${pending.length}`,
    );
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi`, err?.message || err);
  }
}

function scheduleBrokenRefresh(accountId: string): void {
  const prev = brokenTimers.get(accountId);
  if (prev) clearTimeout(prev);
  brokenTimers.set(accountId, setTimeout(() => {
    brokenTimers.delete(accountId);
    void flushBrokenAvatars(accountId);
  }, timing.brokenDebounceMs));
}

async function flushBrokenAvatars(accountId: string): Promise<void> {
  try {
    const set = brokenByAccount.get(accountId);
    if (!set || set.size === 0) return;
    const { ok, account } = canUseAccount(accountId);
    if (!ok) { set.clear(); return; }
    if (runningAccounts.has(accountId)) return; // runRefresh sẽ gọi lại scheduleBrokenRefresh khi xong
    const now = Date.now();
    const userIds = [...set].filter(id => !wasAttemptedRecently(accountId, id, now)).slice(0, CONTACT_REFRESH_MAX_PER_RUN);
    // UID đã hỏi trong 6 giờ mà avatar vẫn hỏng: bỏ khỏi hàng chờ, không lặp vô hạn
    for (const id of set) if (!userIds.includes(id)) set.delete(id);
    if (userIds.length === 0) return;
    await runRefresh(accountId, account, userIds, `avatar lỗi ${userIds.length}`);
  } catch (err: any) {
    console.warn(`[contactRefresh] ${accountId}: lỗi avatar`, err?.message || err);
  }
}

/**
 * Gọi từ `<img onError>` khi avatar liên hệ không tải được (403 CDN hết hạn, link hỏng): gom theo
 * tài khoản, sau `brokenDebounceMs` gọi một lượt làm mới cho các UID đó. Mỗi UID tối đa một lần / 6 giờ.
 */
export function reportBrokenAvatar(accountId: string, contactId: string): void {
  const id = String(contactId || '').trim();
  if (!accountId || !id) return;
  if (wasAttemptedRecently(accountId, id, Date.now())) return;
  let set = brokenByAccount.get(accountId);
  if (!set) {
    set = new Set();
    brokenByAccount.set(accountId, set);
  }
  set.add(id);
  scheduleBrokenRefresh(accountId);
}

/** Chỉ dùng trong test: xoá trạng thái trong phiên. */
export function __resetContactRefreshState(): void {
  attemptedByAccount.clear();
  brokenByAccount.clear();
  for (const t of brokenTimers.values()) clearTimeout(t);
  brokenTimers.clear();
  for (const t of gapTimers.values()) clearTimeout(t);
  gapTimers.clear();
  runningAccounts.clear();
  queuedByAccount.clear();
  lastRunByAccount.clear();
}
