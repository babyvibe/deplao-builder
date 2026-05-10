import { create } from 'zustand';
import type { Channel } from '@/../configs/channelConfig';

export interface AccountInfo {
  display_name: string | undefined;
  zalo_id: string;
  full_name: string;
  avatar_url: string;
  phone?: string;
  /** 1 = tài khoản Zalo Business (trả phí), 0 = tài khoản cá nhân */
  is_business?: number;
  imei: string;
  user_agent: string;
  cookies: string;
  is_active: number;
  created_at: string;
  isOnline?: boolean;
  isConnected?: boolean;
  listenerActive?: boolean;
  /** Kênh chat: 'zalo' | 'facebook'. Default 'zalo' cho backward compat */
  channel?: Channel;
  /** Real Facebook UID (only for FB accounts) */
  facebook_id?: string;
}

interface AccountStore {
  accounts: AccountInfo[];
  activeAccountId: string | null;
  setAccounts: (accounts: AccountInfo[]) => void;
  addAccount: (account: AccountInfo) => void;
  removeAccount: (zaloId: string) => void;
  updateAccountStatus: (zaloId: string, isOnline: boolean, isConnected: boolean) => void;
  updateListenerActive: (zaloId: string, active: boolean) => void;
  updateAccount: (zaloId: string, fields: Partial<AccountInfo>) => void;
  setActiveAccount: (zaloId: string | null) => void;
  getActiveAccount: () => AccountInfo | undefined;
  reorderAccounts: (fromIndex: number, toIndex: number) => void;
  /** Get all accounts filtered by channel */
  getAccountsByChannel: (channel: Channel | 'all') => AccountInfo[];
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  accounts: [],
  activeAccountId: null,

  setAccounts: (accounts) => {
    // Avoid no-op updates that cause infinite render loops
    const current = get().accounts;
    if (current === accounts) return;
    if (current.length === 0 && accounts.length === 0) return;
    // Deep-ish compare: skip if same zalo_ids in same order AND key fields match
    if (
      current.length === accounts.length &&
      current.every((a, i) => {
        const b = accounts[i];
        return a.zalo_id === b?.zalo_id
          && a.full_name === b?.full_name
          && a.avatar_url === b?.avatar_url
          && a.phone === b?.phone
          && a.is_active === b?.is_active
          && a.isOnline === b?.isOnline
          && a.isConnected === b?.isConnected
          && a.listenerActive === b?.listenerActive
          && a.channel === b?.channel;
      })
    ) {
      return;
    }
    set({ accounts });
  },

  addAccount: (account) =>
    set((state) => ({
      accounts: state.accounts.some((a) => a.zalo_id === account.zalo_id)
        ? state.accounts.map((a) => (a.zalo_id === account.zalo_id ? { ...a, ...account } : a))
        : [...state.accounts, account],
    })),

  removeAccount: (zaloId) =>
    set((state) => ({
      accounts: state.accounts.filter((a) => a.zalo_id !== zaloId),
      activeAccountId: state.activeAccountId === zaloId ? null : state.activeAccountId,
    })),

  updateAccountStatus: (zaloId, isOnline, isConnected) =>
    set((state) => ({
      accounts: state.accounts.map((a) =>
        a.zalo_id === zaloId ? { ...a, isOnline, isConnected } : a
      ),
    })),

  updateListenerActive: (zaloId, active) =>
    set((state) => ({
      accounts: state.accounts.map((a) =>
        a.zalo_id === zaloId ? { ...a, listenerActive: active } : a
      ),
    })),

  updateAccount: (zaloId, fields) =>
    set((state) => ({
      accounts: state.accounts.map((a) =>
        a.zalo_id === zaloId ? { ...a, ...fields } : a
      ),
    })),

  setActiveAccount: (zaloId) => set({ activeAccountId: zaloId }),

  getActiveAccount: () => {
    const { accounts, activeAccountId } = get();
    return accounts.find((a) => a.zalo_id === activeAccountId);
  },

  reorderAccounts: (fromIndex, toIndex) =>
    set((state) => {
      const arr = [...state.accounts];
      const [moved] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, moved);
      return { accounts: arr };
    }),

  getAccountsByChannel: (channel) => {
    const { accounts } = get();
    if (channel === 'all') return accounts;
    return accounts.filter((a) => (a.channel || 'zalo') === channel);
  },
}));
