import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import type { ErpNotification } from '../../../models/erp';
import { isErpModuleOff, withErpDeniedNotice } from './erpStoreHelpers';

// The inbox belongs to the logged-in user: the owner's machine takes the recipient from the identity (IPC: owner's machine; employee: REST token)
// `recipientId` in the functions below is only kept for old callers and is not sent. Employees read / write via DataAccessor (REST →
// the owner's machine); previously an IPC call on the employee machine → the local inbox was empty and "mark as read" never reached the owner's machine.

interface ErpNotificationState {
  inbox: ErpNotification[];
  unreadCount: number;
  loadInbox: (recipientId?: string) => Promise<void>;
  loadUnreadCount: (recipientId?: string) => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: (recipientId?: string) => Promise<void>;
  deleteNotifications: (ids: number[]) => Promise<void>;
  deleteAllNotifications: (recipientId?: string) => Promise<void>;
  _onNewNotification: (n: ErpNotification) => void;
}

export const useErpNotificationStore = create<ErpNotificationState>((set, get) => ({
  inbox: [],
  unreadCount: 0,

  // Read error (lost connection, owner's machine refused) → keep the list / count currently shown
  loadInbox: async () => {
    if (isErpModuleOff()) return;
    const res: any = await DataAccessor.erpNotifications();
    if (res?.success && Array.isArray(res.notifications)) set({ inbox: res.notifications });
  },

  loadUnreadCount: async () => {
    if (isErpModuleOff()) return;
    const res: any = await DataAccessor.erpUnreadNotificationCount();
    if (res?.success) set({ unreadCount: Number(res.count) || 0 });
  },

  markRead: async (ids) => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpMarkNotificationsRead(ids));
    if (res && res.success === false) return;
    set(s => {
      const newlyRead = s.inbox.filter(n => ids.includes(n.id) && !n.read).length;
      return {
        inbox: s.inbox.map(n => ids.includes(n.id) ? { ...n, read: 1 } : n),
        unreadCount: Math.max(0, s.unreadCount - (newlyRead || ids.length)),
      };
    });
  },

  markAllRead: async () => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpMarkAllNotificationsRead());
    if (res && res.success === false) return;
    set(s => ({ inbox: s.inbox.map(n => ({ ...n, read: 1 })), unreadCount: 0 }));
  },

  deleteNotifications: async (ids) => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpDeleteNotifications(ids));
    if (res && res.success === false) return;
    set(s => ({
      inbox: s.inbox.filter(n => !ids.includes(n.id)),
      unreadCount: s.inbox.reduce((c, n) => c + (!ids.includes(n.id) && !n.read ? 1 : 0), 0),
    }));
  },

  deleteAllNotifications: async () => {
    const res: any = withErpDeniedNotice(await DataAccessor.erpDeleteAllNotifications());
    if (res && res.success === false) return;
    set({ inbox: [], unreadCount: 0 });
  },

  // Idempotent: a replayed catch-up / duplicate event must not be added again or count unread twice
  _onNewNotification: (n) => set(s => {
    if (!n || s.inbox.some(item => item?.id === n.id)) return s;
    return { inbox: [n, ...s.inbox], unreadCount: s.unreadCount + 1 };
  }),
}));

