/**
 * Nút "Thao tác nhanh" cạnh ô tìm kiếm hội thoại — quy tắc thuần (có test ở
 * src/__tests__/chat/quickActions.test.ts): kênh nào làm được thao tác nào, tài khoản mặc định theo
 * chế độ thường / gộp trang, chọn tài khoản phù hợp với link nhóm vừa dán.
 */
import type { GroupLinkTarget } from '../../../../shared/crm/groupLinks';
import { groupLinkAccountChannels } from '../../../../shared/crm/groupLinks';

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
  facebook: 'Facebook',
};

const UNSUPPORTED: Record<QuickActionId, Record<string, string>> = {
  createGroup: {
    telegram_bot: 'Bot Telegram không tạo được nhóm',
  },
  createChannel: {
    zalo: 'Zalo không có kênh',
    facebook: 'Messenger không có kênh',
    telegram_bot: 'Bot Telegram không tạo được kênh',
  },
  joinLink: {
    facebook: 'Facebook chưa hỗ trợ tham gia nhóm bằng link',
    telegram_bot: 'Bot không tự tham gia nhóm — hãy thêm bot vào nhóm từ Telegram',
  },
  addFriend: {
    facebook: 'Facebook không cho kết bạn từ ứng dụng',
    telegram_bot: 'Bot Telegram không thêm bạn được',
  },
  contacts: {
    zalo: 'Danh bạ Zalo xem ở mục Bạn bè',
    facebook: 'Messenger không có danh bạ',
    telegram_bot: 'Bot Telegram không có danh bạ',
  },
  calls: {
    zalo: 'Chưa hỗ trợ cuộc gọi Zalo',
    facebook: 'Chưa hỗ trợ cuộc gọi Messenger',
    telegram_bot: 'Bot Telegram không gọi được',
  },
};

/**
 * Kênh nào làm được thao tác nào. Chế độ nhân viên không bị giới hạn thêm: thao tác Telegram / Facebook của nhân viên
 * chạy trên máy Boss qua proxy (employeeChannelRoutes), Zalo qua registry như mọi thao tác Zalo khác.
 */
export function quickActionSupport(action: QuickActionId, channel: string): QuickActionSupport {
  const reason = UNSUPPORTED[action][channel];
  return reason ? { supported: false, reason } : { supported: true };
}

/** Thao tác chỉ một kênh có (Kênh mới, Danh bạ, Cuộc gọi của Telegram): kênh khác không hiện mục này thay vì hiện khoá. */
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
 * Tài khoản mặc định: gộp trang → tài khoản đang lọc, rồi tài khoản đang mở (nếu thuộc trang gộp), rồi tài khoản
 * đầu tiên của trang gộp; chế độ thường → tài khoản đang mở.
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

/** Danh sách chọn tài khoản: gộp trang → tài khoản của trang gộp trước (đúng thứ tự gộp); thường → tài khoản đang mở trước. */
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

/** Link vừa dán → tài khoản dùng để tham gia: giữ tài khoản đang chọn nếu cùng kênh, không thì tài khoản đầu tiên cùng kênh. */
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

/** Mở hội thoại vừa tạo / tham gia / thêm (đổi tài khoản nếu cần — ConversationList lo phần đó). */
export type OpenQuickConversation = (
  accountId: string,
  threadId: string,
  threadType: 0 | 1,
  info?: { display_name?: string; avatar_url?: string; channel?: string },
) => void;

/** Tìm không dấu: "Đức" ~ "duc". */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}
