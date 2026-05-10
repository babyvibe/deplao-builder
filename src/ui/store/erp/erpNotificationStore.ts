import { create } from 'zustand';
import ipc from '@/lib/ipc';
import type { ErpNotification } from '../../../models/erp';

interface ErpNotificationState {
  inbox: ErpNotification[];
  unreadCount: number;
  loadInbox: (recipientId: string) => Promise<void>;
  loadUnreadCount: (recipientId: string) => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: (recipientId: string) => Promise<void>;
  _onNewNotification: (n: ErpNotification) => void;
}

export const useErpNotificationStore = create<ErpNotificationState>((set, get) => ({
  inbox: [],
  unreadCount: 0,

  loadInbox: async (recipientId) => {
    const res = await ipc.erp?.notifyListInbox({ recipientId });
    if (res?.success) set({ inbox: res.notifications });
  },

  loadUnreadCount: async (recipientId) => {
    const res = await ipc.erp?.notifyUnreadCount({ recipientId });
    if (res?.success) set({ unreadCount: res.count });
  },

  markRead: async (ids) => {
    await ipc.erp?.notifyMarkRead({ ids });
    set(s => ({
      inbox: s.inbox.map(n => ids.includes(n.id) ? { ...n, read: 1 } : n),
      unreadCount: Math.max(0, s.unreadCount - ids.length),
    }));
  },

  markAllRead: async (recipientId) => {
    await ipc.erp?.notifyMarkAllRead({ recipientId });
    set(s => ({ inbox: s.inbox.map(n => ({ ...n, read: 1 })), unreadCount: 0 }));
  },

  _onNewNotification: (n) => set(s => ({
    inbox: [n, ...s.inbox],
    unreadCount: s.unreadCount + 1,
  })),
}));

