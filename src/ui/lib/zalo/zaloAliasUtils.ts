/**
 * zaloAliasUtils.ts
 *
 * Shared utility for fetching alias lists with correct pagination.
 * The Zalo API (zca-js) limits count = 200/page, so the page number must keep increasing until there are no more results.
 */

import ipc from '@/lib/ipc';

const ALIAS_PAGE_SIZE = 200;
const MAX_PAGES = 50; // safety: at most 50 pages (10,000 items)

export interface AliasItem {
  userId: string;
  alias: string;
}

/**
 * Fetch all aliases with pagination:
 * - count = 200 / page
 * - page starts at 1 and increases
 * - stops when the API returns empty items
 * - has a MAX_PAGES safety limit to avoid an infinite loop
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
