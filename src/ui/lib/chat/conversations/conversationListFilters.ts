/**
 * Conversation list filters: the All / Unread / Labels tabs + the ⋮ menu (Other (archived), Not replied, date range, channel).
 *
 * "Tất cả" (All) = the full list: lit only when no filter is on, clicking it clears them all. Previously the tab only changed `filter`:
 * the date / channel filters stayed while the "Tất cả" tab still looked lit, so clicking "Tất cả" seemed to do nothing. Every filter of the
 * ⋮ menu that is on now shows as a label with ✕ under the tab bar (the channel filter used to show nothing).
 */

export type ConversationListTab = 'all' | 'unread' | 'unreplied' | 'others' | 'label';

export interface ConversationListFilterState {
  filter: ConversationListTab;
  dateRange: { fromTs: number; toTs: number } | null;
  /** 'all' = every channel. */
  channel: string;
  /** Viewing a hidden conversation (the correct PIN was typed). */
  hiddenView: boolean;
}

export type ConversationMenuFilter = 'others' | 'unreplied' | 'dateRange' | 'channel';

/** The list is filtered → the "Tất cả" (All) tab is not lit. */
export function isConversationListFiltered(state: ConversationListFilterState): boolean {
  return state.filter !== 'all' || !!state.dateRange || (state.channel || 'all') !== 'all' || state.hiddenView;
}

/** The ⋮ menu filters that are on, in menu order: each one a label with ✕. */
export function activeMenuFilters(state: ConversationListFilterState): ConversationMenuFilter[] {
  const active: ConversationMenuFilter[] = [];
  if (state.filter === 'others') active.push('others');
  if (state.filter === 'unreplied') active.push('unreplied');
  if (state.dateRange) active.push('dateRange');
  if ((state.channel || 'all') !== 'all') active.push('channel');
  return active;
}

/** Clicking an on / off item of the ⋮ menu (Other, Not replied): clicking it again while on = back to the main list. */
export function toggleMenuFilter(current: ConversationListTab, item: 'others' | 'unreplied'): ConversationListTab {
  return current === item ? 'all' : item;
}

/**
 * Number of conversations in "Khác (lưu trữ)" (Other, archived) by the DB flag (including pages not loaded yet), minus the locked hidden conversations: matches the number
 * shown on the label when the folder is opened. Previously it only counted the conversations already loaded (menu 172, label 183).
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
