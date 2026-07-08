/**
 * zaloAliasUtils.ts
 *
 * Shared utility for fetching alias lists with correct pagination.
 * Zalo API (zca-js) giới hạn count = 200/page, cần tăng page dần đến khi hết.
 */

import ipc from '@/lib/ipc';

const ALIAS_PAGE_SIZE = 200;
const MAX_PAGES = 50; // safety: tối đa 50 trang (10,000 items)

export interface AliasItem {
  userId: string;
  alias: string;
}

/**
 * Fetch tất cả aliases bằng pagination:
 * - count = 200 / page
 * - page bắt đầu từ 1, tăng dần
 * - dừng khi API trả về items rỗng
 * - có safety MAX_PAGES để tránh loop vô hạn
 */
export async function fetchAllAliases(auth: any): Promise<AliasItem[]> {
  let page = 1;
  let allItems: AliasItem[] = [];

  while (page <= MAX_PAGES) {
    const res = await ipc.zalo?.getAliasList({ auth, count: ALIAS_PAGE_SIZE, page });
    if (!res?.success) break;

    const items: AliasItem[] = res?.response?.items || [];
    if (items.length === 0) break;

    allItems = allItems.concat(items);
    page++;
  }

  return allItems;
}
