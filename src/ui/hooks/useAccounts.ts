import { useCallback } from 'react';
import { useAccountStore, AccountInfo } from '../store/accountStore';
import { useAppStore } from '../store/appStore';
import ipc from '../lib/ipc';

/**
 * Hook quản lý tài khoản Zalo — bao gồm kết nối, ngắt kết nối, reload
 */
export function useAccounts() {
  const { accounts, activeAccountId, setAccounts, addAccount, removeAccount, updateAccountStatus, updateListenerActive, setActiveAccount, getActiveAccount } =
    useAccountStore();
  const { showNotification } = useAppStore();

  /** Tải lại danh sách accounts từ DB */
  const reloadAccounts = useCallback(async () => {
    try {
      const res = await ipc.login?.getAccounts();
      if (res?.accounts) setAccounts(res.accounts);
    } catch (err: any) {
      showNotification('Không thể tải danh sách tài khoản', 'error');
    }
  }, [setAccounts, showNotification]);

  /** Kết nối một tài khoản (theo cookies) */
  const connectAccount = useCallback(
    async (acc: AccountInfo) => {
      showNotification(`Đang kết nối ${acc.full_name || acc.zalo_id}...`, 'info');
      try {
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        const res = await ipc.login?.connectAccount(auth);
        if (res?.success) {
          updateAccountStatus(acc.zalo_id, true, true);
          updateListenerActive(acc.zalo_id, true);
          showNotification(`${acc.full_name || acc.zalo_id} đã kết nối!`, 'success');
          return true;
        } else {
          updateListenerActive(acc.zalo_id, false);
          showNotification(res?.error || 'Kết nối thất bại. Vui lòng đăng nhập lại', 'error');
          return false;
        }
      } catch (err: any) {
        updateListenerActive(acc.zalo_id, false);
        showNotification(err.message || 'Kết nối thất bại. Vui lòng đăng nhập lại', 'error');
        return false;
      }
    },
    [updateAccountStatus, updateListenerActive, showNotification]
  );

  /** Ngắt kết nối một tài khoản */
  const disconnectAccount = useCallback(
    async (zaloId: string) => {
      try {
        await ipc.login?.disconnectAccount(zaloId);
        updateAccountStatus(zaloId, false, false);
        showNotification('Đã ngắt kết nối', 'info');
      } catch (err: any) {
        showNotification(err.message, 'error');
      }
    },
    [updateAccountStatus, showNotification]
  );

  /** Xóa một tài khoản hoàn toàn */
  const deleteAccount = useCallback(
    async (zaloId: string) => {
      const confirmed = window.confirm('Bạn có chắc muốn xóa tài khoản này?');
      if (!confirmed) return;
      try {
        const res = await ipc.login?.removeAccount(zaloId);
        if (res?.success) {
          removeAccount(zaloId);
          showNotification('Đã xóa tài khoản', 'success');
        }
      } catch (err: any) {
        showNotification(err.message, 'error');
      }
    },
    [removeAccount, showNotification]
  );

  /** Lấy auth object cho account đang active */
  const getActiveAuth = useCallback(() => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  }, [getActiveAccount]);

  return {
    accounts,
    activeAccountId,
    setActiveAccount,
    getActiveAccount,
    getActiveAuth,
    reloadAccounts,
    connectAccount,
    disconnectAccount,
    deleteAccount,
    addAccount,
    updateAccountStatus,
  };
}

