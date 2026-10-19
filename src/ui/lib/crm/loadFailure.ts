/**
 * CRM — xử lý lần đọc lỗi ở các màn CRM phụ (Dashboard, chọn người nhận chiến dịch, thêm liên hệ, tìm kiếm, nhóm).
 *
 * Chế độ nhân viên: DataAccessor trả `success: false` khi đọc lỗi (mất kết nối BOSS…) — xem `isReadFailure`.
 * Quy tắc:
 *  - lỗi KHÔNG thay dữ liệu đang hiện bằng rỗng (giữ bản tốt gần nhất), trừ khi bản đó thuộc tài khoản / nhóm khác;
 *  - lỗi không được dẫn tới tập người nhận rỗng / thiếu, hay thao tác ghi dựa trên dữ liệu đọc thiếu.
 * Hàm thuần: người gọi tự tính cờ `failed` bằng `isReadFailure(res)` — test không cần React / store / REST.
 */

/** Việc cần làm với dữ liệu đang hiện sau một lần đọc. */
export type ReadOutcome = 'replace' | 'keep' | 'clear';

/**
 * Sau một lần đọc dữ liệu của `owner` (tài khoản, hoặc `tàiKhoản:nhóm`) khi dữ liệu đang hiện thuộc `shownOwner`:
 *  - đọc thành công → `replace`;
 *  - lỗi, dữ liệu đang hiện của đúng `owner` → `keep` (giữ bản tốt gần nhất, báo "Không tải được — Thử lại");
 *  - lỗi, dữ liệu đang hiện của chủ khác (vừa đổi tài khoản / nhóm) hoặc chưa tải lần nào → `clear`: không bao giờ
 *    hiện hay thao tác trên dữ liệu của tài khoản khác.
 */
export function readOutcome(failed: boolean, shownOwner: string | null, owner: string): ReadOutcome {
  if (!failed) return 'replace';
  return shownOwner != null && shownOwner === owner ? 'keep' : 'clear';
}

// ── Nhóm & thành viên nhóm (GroupMembersTab) ─────────────────────────────────

/** Số dòng thành viên theo nhóm (mọi dòng của bảng thành viên nhóm, như trước). */
export function countMembersByGroup(rows: Array<{ group_id?: string | null }> | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const groupId = row?.group_id;
    if (groupId) counts[groupId] = (counts[groupId] || 0) + 1;
  }
  return counts;
}

export interface GroupListRow {
  contact_id: string;
  display_name: string;
  avatar_url: string;
  last_message_time: number;
  memberCount: number;
}

/**
 * Danh sách nhóm (contact_type = 'group') từ danh sách hội thoại. `counts` = null khi đọc số thành viên lỗi → giữ số
 * đã biết của cùng nhóm trong `previous` (cùng tài khoản) thay vì 0 ("Chưa có thành viên" giả).
 */
export function buildGroupRows(
  contacts: any[] | null | undefined,
  counts: Record<string, number> | null,
  previous: GroupListRow[] = [],
): GroupListRow[] {
  const known = new Map(previous.map(g => [g.contact_id, g.memberCount]));
  return (contacts || [])
    .filter((c: any) => c?.contact_type === 'group')
    .map((c: any) => ({
      contact_id: c.contact_id,
      display_name: c.display_name || c.contact_id,
      avatar_url: c.avatar_url || '',
      last_message_time: c.last_message_time || 0,
      memberCount: counts ? (counts[c.contact_id] ?? 0) : (known.get(c.contact_id) ?? 0),
    }));
}

/** SĐT theo contact_id từ danh sách hội thoại. */
export function phonesByContact(contacts: any[] | null | undefined): Record<string, string> {
  const phones: Record<string, string> = {};
  for (const c of contacts || []) {
    if (c?.contact_id && c.phone) phones[c.contact_id] = c.phone;
  }
  return phones;
}

/**
 * Gộp SĐT vào danh sách thành viên. `phones` = null khi đọc danh bạ lỗi → giữ SĐT đang hiện của cùng thành viên
 * (`previous`, cùng nhóm) thay vì xoá trắng.
 */
export function withMemberPhones<T extends { member_id: string }>(
  rows: T[],
  phones: Record<string, string> | null,
  previous: Array<{ member_id: string; phone?: string }> = [],
): Array<T & { phone: string }> {
  if (phones) return rows.map(m => ({ ...m, phone: phones[m.member_id] || '' }));
  const known = new Map(previous.map(m => [m.member_id, m.phone || '']));
  return rows.map(m => ({ ...m, phone: known.get(m.member_id) || '' }));
}

// ── Chọn người nhận chiến dịch (TargetSelector) ──────────────────────────────

export type TargetSelectMode = 'manual' | 'by_label' | 'friends_only' | 'groups_only' | 'by_phone' | 'by_uid' | 'by_group';

export interface TargetLoadFlags {
  /** Lần tải danh sách liên hệ CRM gần nhất lỗi (danh sách đang hiện trống hoặc cũ). */
  contactsFailed: boolean;
  /** Bảng gán Nhãn Local đang dùng (bản tự tải) lỗi. */
  localLabelMapFailed: boolean;
  /** Đang lọc theo ít nhất một Nhãn Local. */
  filteringByLocalLabel: boolean;
}

/**
 * Lý do khoá nút xác nhận người nhận (null = cho phép). Lần tải lỗi có thể làm tập người nhận rỗng / thiếu mà người
 * dùng không nhận ra → khoá cho tới khi tải lại được.
 *  - Theo UID: người nhận lấy nguyên từ ô nhập, không phụ thuộc danh sách liên hệ → không khoá.
 *  - Theo SĐT: khớp SĐT ↔ UID và chống trùng dựa vào danh sách liên hệ → khoá khi danh sách lỗi.
 *  - Theo thành viên nhóm: danh sách nhóm lấy từ danh sách liên hệ → khoá khi danh sách lỗi.
 */
export function targetConfirmBlockReason(mode: TargetSelectMode, flags: TargetLoadFlags): string | null {
  if (mode === 'by_uid') return null;
  if (flags.contactsFailed) return 'Không tải được danh sách liên hệ';
  if (mode === 'by_label' && flags.filteringByLocalLabel && flags.localLabelMapFailed) return 'Không tải được Nhãn Local';
  return null;
}

export interface GroupMembersRead {
  groupId: string;
  /** Đọc lỗi (`isReadFailure` hoặc ném lỗi). */
  failed: boolean;
  members?: any[] | null;
}

export interface GroupTargets {
  members: any[];
  /** Nhóm đọc lỗi — khác rỗng thì KHÔNG được thêm `members` (tập thiếu) vào chiến dịch. */
  failedGroupIds: string[];
}

/**
 * Người nhận từ thành viên các nhóm đã chọn: UID dạng số, chưa có trong chiến dịch (như trước), kèm các nhóm đọc lỗi.
 * Trước đây nhóm đọc lỗi bị bỏ qua lặng lẽ → chiến dịch nhận tập người nhận thiếu / rỗng.
 */
export function collectGroupTargets(reads: GroupMembersRead[], existingIds: Set<string>): GroupTargets {
  const members: any[] = [];
  const failedGroupIds: string[] = [];
  for (const read of reads) {
    if (read.failed) {
      failedGroupIds.push(read.groupId);
      continue;
    }
    for (const m of read.members || []) {
      const id = String(m?.member_id || m?.memberId || '').trim();
      if (!id || !/^\d+$/.test(id)) continue;
      const uid = m.member_id || m.memberId || '';
      if (uid && !existingIds.has(uid)) {
        members.push({
          contact_id: uid,
          display_name: m.display_name || m.displayName || uid,
          avatar: m.avatar || '',
          source: 'group',
          groupId: read.groupId,
        });
      }
    }
  }
  return { members, failedGroupIds };
}
