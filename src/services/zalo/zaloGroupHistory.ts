/**
 * Zalo group history from the cloud message service (`getCloudMessage`), which Zalo Web uses since Zalo
 * removed `/api/group/history` (zca-js `getGroupChatHistory` still calls the removed endpoint and gets 404).
 *
 * One request returns at most one page of 50 messages. An older page needs the previous page's `lastMsgId`
 * and `isOld` (whether the next page lives in the old-message storage).
 */
import type { GetCloudMessageOptions, GetCloudMessageResponse, GroupMessage } from 'zca-js';

export const ZALO_CLOUD_PAGE_SIZE = 50;
/** Pause between pages, like someone scrolling up: back-to-back requests get rate limited. */
export const ZALO_CLOUD_PAGE_GAP_MS = 400;
/** zca-js error code: the server has nothing more to load for this cursor. */
const STOP_PAGING = -69;

export interface ZaloGroupHistoryCursor {
    lastMsgId: string;
    isOld: number;
}

export interface ZaloGroupHistoryResult {
    groupMsgs: GroupMessage[];
    hasMore: boolean;
    /** Where the next (older) page starts; null when there is nothing older. */
    cursor: ZaloGroupHistoryCursor | null;
}

export type ZaloCloudPageFetch = (
    groupId: string,
    lastMsgId?: string,
    options?: GetCloudMessageOptions,
) => Promise<GetCloudMessageResponse>;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Load at least `count` messages (whole pages, so up to 49 more), newest first, older than `from` when given.
 * Messages are never dropped from a fetched page: the returned cursor continues right after the last one.
 * An error on the first page is thrown; a later error ends the load with what was fetched so far.
 */
export async function loadZaloGroupHistory(
    fetchPage: ZaloCloudPageFetch,
    groupId: string,
    count: number,
    from?: ZaloGroupHistoryCursor | null,
    sleep: (ms: number) => Promise<void> = wait,
): Promise<ZaloGroupHistoryResult> {
    const want = Math.max(1, Math.floor(Number(count)) || ZALO_CLOUD_PAGE_SIZE);
    const groupMsgs: GroupMessage[] = [];
    const seen = new Set<string>();
    let cursor: ZaloGroupHistoryCursor | null = from?.lastMsgId ? { lastMsgId: String(from.lastMsgId), isOld: Number(from.isOld) || 0 } : null;
    let hasMore = true;

    for (let page = 0; hasMore && groupMsgs.length < want; page++) {
        if (page > 0) await sleep(ZALO_CLOUD_PAGE_GAP_MS);
        let res: GetCloudMessageResponse;
        try {
            res = cursor ? await fetchPage(groupId, cursor.lastMsgId, { isOld: cursor.isOld }) : await fetchPage(groupId);
        } catch (err: any) {
            if (Number(err?.code) === STOP_PAGING) {
                hasMore = false;
                break;
            }
            if (page === 0) throw err;
            break; // keep what was fetched, the cursor still points at the failed page
        }

        const msgs = Array.isArray(res?.groupMsgs) ? res.groupMsgs : [];
        for (const msg of msgs) {
            const id = String((msg as any)?.data?.msgId ?? '');
            if (id) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            groupMsgs.push(msg);
        }

        const next = String(res?.lastMsgId ?? '');
        const stuck = !next || next === '0' || next === cursor?.lastMsgId;
        const filteredOut = msgs.length === 0 && Number(res?.isFiltered) === 1;
        hasMore = Number(res?.hasMore) === 1 && !stuck && !filteredOut;
        if (!stuck) cursor = { lastMsgId: next, isOld: Number(res?.isOld) || 0 };
    }

    return { groupMsgs, hasMore, cursor: hasMore ? cursor : null };
}

/** `next_cursor` text of the public API ↔ cursor. */
export function formatZaloHistoryCursor(cursor: ZaloGroupHistoryCursor | null | undefined): string | null {
    return cursor?.lastMsgId ? `${cursor.lastMsgId}:${Number(cursor.isOld) ? 1 : 0}` : null;
}

export function parseZaloHistoryCursor(text: unknown): ZaloGroupHistoryCursor | null {
    const match = /^(\d+):([01])$/.exec(String(text ?? '').trim());
    return match ? { lastMsgId: match[1], isOld: Number(match[2]) } : null;
}
