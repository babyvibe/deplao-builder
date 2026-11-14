import { useCallback } from 'react';
import { useAccountStore, AccountInfo } from '../../store/accounts/accountStore';
import { useAppStore } from '../../store/app/appStore';
import ipc, { buildZaloAuth } from '../../lib/ipc';
import { tr } from '../../../shared/i18n';

/**
 * Hook for managing Zalo accounts: connect, disconnect, reload
 */
export function useAccounts() {
  const { accounts, activeAccountId, setAccounts, addAccount, removeAccount, updateAccountStatus, updateListenerActive, setActiveAccount, getActiveAccount } =
    useAccountStore();
  const { showNotification } = useAppStore();

  /** Reload the accounts list from the DB */
  const reloadAccounts = useCallback(async () => {
    try {
      const res = await ipc.login?.getAccounts();
      if (res?.accounts) setAccounts(res.accounts);
    } catch (err: any) {
      showNotification(tr('Không thể tải danh sách tài khoản'), 'error');
    }
  }, [setAccounts, showNotification]);

  /** Connect one account (using its cookies) */
  const connectAccount = useCallback(
    async (acc: AccountInfo) => {
      showNotification(tr('Đang kết nối {{v1}}...', { v1: acc.full_name || acc.zalo_id }), 'info');
      try {
        const auth = buildZaloAuth(acc);
        const res = await ipc.login?.connectAccount(auth);
        if (res?.success) {
          updateAccountStatus(acc.zalo_id, true, true);
          updateListenerActive(acc.zalo_id, true);
          showNotification(tr('{{v1}} đã kết nối!', { v1: acc.full_name || acc.zalo_id }), 'success');
          return true;
        } else {
          updateListenerActive(acc.zalo_id, false);
          showNotification(res?.error || tr('Kết nối thất bại. Vui lòng đăng nhập lại'), 'error');
          return false;
        }
      } catch (err: any) {
        updateListenerActive(acc.zalo_id, false);
        showNotification(err.message || tr('Kết nối thất bại. Vui lòng đăng nhập lại'), 'error');
        return false;
      }
    },
    [updateAccountStatus, updateListenerActive, showNotification]
  );

  /** Disconnect one account */
  const disconnectAccount = useCallback(
    async (zaloId: string) => {
      try {
        await ipc.login?.disconnectAccount(zaloId);
        updateAccountStatus(zaloId, false, false);
        showNotification(tr('Đã ngắt kết nối'), 'info');
      } catch (err: any) {
        showNotification(err.message, 'error');
      }
    },
    [updateAccountStatus, showNotification]
  );

  /** Delete one account completely */
  const deleteAccount = useCallback(
    async (zaloId: string) => {
      const confirmed = window.confirm(tr('Bạn có chắc muốn xóa tài khoản này?'));
      if (!confirmed) return;
      try {
        const res = await ipc.login?.removeAccount(zaloId);
        if (res?.success) {
          removeAccount(zaloId);
          showNotification(tr('Đã xóa tài khoản'), 'success');
        }
      } catch (err: any) {
        showNotification(err.message, 'error');
      }
    },
    [removeAccount, showNotification]
  );

  /** Get the auth object for the active account */
  const getActiveAuth = useCallback(() => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return buildZaloAuth(acc);
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

