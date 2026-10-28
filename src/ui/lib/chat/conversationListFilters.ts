/**
 * Bộ lọc danh sách hội thoại: tab Tất cả / Chưa đọc / Nhãn + menu ⋮ (Khác (lưu trữ), Chưa trả lời, khoảng ngày, kênh).
 *
 * "Tất cả" = danh sách đầy đủ: chỉ sáng khi không có bộ lọc nào, bấm vào thì bỏ hết. Trước đây tab chỉ đổi `filter`:
 * lọc khoảng ngày / kênh vẫn giữ trong khi tab "Tất cả" vẫn sáng — bấm "Tất cả" như không có tác dụng. Mọi bộ lọc của
 * menu ⋮ đang bật đều hiện thành nhãn có ✕ dưới thanh tab (lọc kênh trước đây không hiện gì).
 */

export type ConversationListTab = 'all' | 'unread' | 'unreplied' | 'others' | 'label';

export interface ConversationListFilterState {
  filter: ConversationListTab;
  dateRange: { fromTs: number; toTs: number } | null;
  /** 'all' = mọi kênh. */
  channel: string;
  /** Đang xem hội thoại ẩn (đã gõ đúng mã PIN). */
  hiddenView: boolean;
}

export type ConversationMenuFilter = 'others' | 'unreplied' | 'dateRange' | 'channel';

/** Danh sách đang bị lọc → tab "Tất cả" không sáng. */
export function isConversationListFiltered(state: ConversationListFilterState): boolean {
  return state.filter !== 'all' || !!state.dateRange || (state.channel || 'all') !== 'all' || state.hiddenView;
}

/** Bộ lọc của menu ⋮ đang bật, theo thứ tự trong menu — mỗi cái một nhãn có ✕. */
export function activeMenuFilters(state: ConversationListFilterState): ConversationMenuFilter[] {
  const active: ConversationMenuFilter[] = [];
  if (state.filter === 'others') active.push('others');
  if (state.filter === 'unreplied') active.push('unreplied');
  if (state.dateRange) active.push('dateRange');
  if ((state.channel || 'all') !== 'all') active.push('channel');
  return active;
}

/** Bấm một mục bật / tắt của menu ⋮ (Khác, Chưa trả lời): bấm lại khi đang bật = về danh sách chính. */
export function toggleMenuFilter(current: ConversationListTab, item: 'others' | 'unreplied'): ConversationListTab {
  return current === item ? 'all' : item;
}

/**
 * Số hội thoại trong "Khác (lưu trữ)" theo cờ trong DB (cả các trang chưa tải), trừ hội thoại ẩn đang khoá — khớp số
 * hiện ở nhãn khi mở thư mục. Trước đây chỉ đếm hội thoại đã tải (menu 172, nhãn 183).
 */
export function othersFolderCount(
  accountIds: readonly string[],
  others: Readonly<Record<string, ReadonlySet<string> | undefined>>,
  isHiddenLocked: (accountId: string, contactId: string) => boolean,
): number {
  let total = 0;
  for (const accountId of new Set(accountIds)) {
    if (!accountId) continue;
    for (const contactId of others[accountId] || []) {
      if (!isHiddenLocked(accountId, contactId)) total += 1;
    }
  }
  return total;
}
