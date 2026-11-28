/**
 * "Thao tác nhanh" (Quick actions) button next to the conversation search box: pure rules (tested in
 * src/__tests__/chat/quickActions.test.ts): which actions each channel can do, the default account for normal / merged inbox mode,
 * and picking the account that fits the group link just pasted.
 */
import type { GroupLinkTarget } from '../../../../shared/crm/groupLinks';
import { groupLinkAccountChannels } from '../../../../shared/crm/groupLinks';
import { tr } from '../../../../shared/i18n';

export type QuickActionId = 'createGroup' | 'createChannel' | 'joinLink' | 'addFriend' | 'contacts' | 'calls';

export interface QuickAccountLike {
  zalo_id: string;
  channel?: string | null;
  full_name?: string;
  display_name?: string;
  avatar_url?: string;
}

export interface QuickModeState {
  activeAccountId: string | null;
  mergedInboxMode: boolean;
  mergedInboxAccounts: string[];
  mergedInboxFilterAccount: string | null;
}

export type QuickActionSupport = { supported: true } | { supported: false; reason: string };

export function accountChannel(account: Pick<QuickAccountLike, 'channel'> | null | undefined): string {
  return account?.channel || 'zalo';
}

export const CHANNEL_SHORT_LABEL: Record<string, string> = {
  zalo: 'Zalo',
  telegram_user: 'Telegram',
  telegram_bot: 'Bot Telegram',
  facebook: 'Facebook Messenger',
};

const UNSUPPORTED: Record<QuickActionId, Record<string, string>> = {
  createGroup: {
    telegram_bot: tr('Bot Telegram không tạo được nhóm'),
  },
  createChannel: {
    zalo: tr('Zalo không có kênh'),
    facebook: tr('Messenger không có kênh'),
    telegram_bot: tr('Bot Telegram không tạo được kênh'),
  },
  joinLink: {
    facebook: tr('Facebook chưa hỗ trợ tham gia nhóm bằng link'),
    telegram_bot: tr('Bot không tự tham gia nhóm — hãy thêm bot vào nhóm từ Telegram'),
  },
  addFriend: {
    facebook: tr('Facebook không cho kết bạn từ ứng dụng'),
    telegram_bot: tr('Bot Telegram không thêm bạn được'),
  },
  contacts: {
    zalo: tr('Danh bạ Zalo xem ở mục Bạn bè'),
    facebook: tr('Messenger không có danh bạ'),
    telegram_bot: tr('Bot Telegram không có danh bạ'),
  },
  calls: {
    zalo: tr('Chưa hỗ trợ cuộc gọi Zalo'),
    facebook: tr('Chưa hỗ trợ cuộc gọi Messenger'),
    telegram_bot: tr('Bot Telegram không gọi được'),
  },
};

/**
 * Which actions each channel can do. Employee mode adds no further limits: an employee's Telegram / Facebook actions
 * run on the Boss machine through the proxy (employeeChannelRoutes), Zalo goes through the registry like any other Zalo action.
 */
export function quickActionSupport(action: QuickActionId, channel: string): QuickActionSupport {
  const reason = UNSUPPORTED[action][channel];
  return reason ? { supported: false, reason } : { supported: true };
}

/** Actions only one channel has (New channel, Contacts, Calls on Telegram): other channels hide the item instead of showing it locked. */
const CHANNEL_ONLY: Partial<Record<QuickActionId, readonly string[]>> = {
  createChannel: ['telegram_user'],
  contacts: ['telegram_user'],
  calls: ['telegram_user'],
};

export function quickActionVisible(action: QuickActionId, channel: string): boolean {
  const only = CHANNEL_ONLY[action];
  return !only || only.includes(channel);
}

/**
 * Default account: merged inbox → the account being filtered, then the open account (if it belongs to the merged inbox), then the
 * first account of the merged inbox; normal mode → the open account.
 */
export function defaultQuickAccountId(accounts: readonly QuickAccountLike[], state: QuickModeState): string | null {
  const known = new Set(accounts.map(account => account.zalo_id));
  if (state.mergedInboxMode && state.mergedInboxAccounts.length > 0) {
    const merged = new Set(state.mergedInboxAccounts);
    const candidates = [state.mergedInboxFilterAccount, state.activeAccountId, ...state.mergedInboxAccounts];
    for (const id of candidates) {
      if (id && merged.has(id) && known.has(id)) return id;
    }
  }
  if (state.activeAccountId && known.has(state.activeAccountId)) return state.activeAccountId;
  return accounts[0]?.zalo_id ?? null;
}

export interface QuickAccountEntry<T extends QuickAccountLike> {
  account: T;
  inMerged: boolean;
  isActive: boolean;
}

/** Account picker list: merged inbox → the merged inbox's account first (in merge order); normal → the open account first. */
export function orderQuickAccounts<T extends QuickAccountLike>(accounts: readonly T[], state: QuickModeState): QuickAccountEntry<T>[] {
  const mergedOrder = new Map(state.mergedInboxAccounts.map((id, index) => [id, index]));
  const entries = accounts.map((account, index) => ({
    account,
    index,
    inMerged: state.mergedInboxMode && mergedOrder.has(account.zalo_id),
    isActive: account.zalo_id === state.activeAccountId,
  }));
  entries.sort((a, b) => {
    if (a.inMerged !== b.inMerged) return a.inMerged ? -1 : 1;
    if (a.inMerged && b.inMerged) return (mergedOrder.get(a.account.zalo_id) ?? 0) - (mergedOrder.get(b.account.zalo_id) ?? 0);
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.index - b.index;
  });
  return entries.map(({ account, inMerged, isActive }) => ({ account, inMerged, isActive }));
}

/** Link just pasted → the account used to join: keep the selected account if it is on the same channel, otherwise the first account on the same channel. */
export function pickAccountForLink<T extends QuickAccountLike>(
  target: GroupLinkTarget | null,
  accounts: readonly T[],
  preferredId: string | null,
): T | null {
  const channels = groupLinkAccountChannels(target);
  if (channels.length === 0) return null;
  const preferred = accounts.find(account => account.zalo_id === preferredId);
  if (preferred && channels.includes(accountChannel(preferred))) return preferred;
  return accounts.find(account => channels.includes(accountChannel(account))) || null;
}

export function accountLabel(account: QuickAccountLike | null | undefined): string {
  if (!account) return '';
  return account.full_name || account.display_name || account.zalo_id;
}

/** Open the conversation just created / joined / added (switches account if needed; ConversationList handles that part). */
export type OpenQuickConversation = (
  accountId: string,
  threadId: string,
  threadType: 0 | 1,
  info?: { display_name?: string; avatar_url?: string; channel?: string },
) => void;

/** Accent-insensitive search: "Đức" ~ "duc". */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}
