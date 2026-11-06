/**
 * Thêm / đổi / bỏ proxy của một tài khoản rồi kết nối lại ngay (proxy:applyToAccount, không cần đăng nhập lại). Dùng
 * chung cho dòng "Proxy" ở Cài đặt → Tài khoản và danh sách tài khoản dưới mỗi proxy ở Cài đặt → Proxy.
 */
import { useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';

export type ApplyAccountProxyOutcome = {
  ok: boolean;
  /** false = đã lưu proxy nhưng tài khoản chưa kết nối lại được */
  connected?: boolean;
  error?: string;
};

export function useApplyAccountProxy() {
  const updateAccount = useAccountStore((s) => s.updateAccount);
  const showNotification = useAppStore((s) => s.showNotification);

  return useCallback(async (
    accountId: string,
    proxyId: number | null,
    opts: { force?: boolean; quiet?: boolean } = {},
  ): Promise<ApplyAccountProxyOutcome> => {
    let res: Awaited<ReturnType<NonNullable<typeof ipc.proxy>['applyToAccount']>> | undefined;
    try {
      res = await ipc.proxy?.applyToAccount(accountId, proxyId, opts.force ? { force: true } : undefined);
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    if (!res?.success) {
      const error = res?.error || 'Không đổi được proxy';
      if (!opts.quiet) showNotification(error, 'error');
      return { ok: false, error };
    }

    updateAccount(accountId, { proxy_id: res.proxyId ?? null });
    if (res.changed === false && !opts.force) return { ok: true, connected: true };
    if (res.connected === false) {
      const error = res.reconnectError || 'Chưa kết nối lại được';
      if (!opts.quiet) showNotification(`Đã lưu proxy nhưng chưa kết nối lại được: ${error}`, 'warning');
      return { ok: true, connected: false, error };
    }
    if (!opts.quiet) {
      showNotification(proxyId != null ? 'Đã đổi proxy, tài khoản đã kết nối lại' : 'Đã bỏ proxy, tài khoản đã kết nối lại', 'success');
    }
    return { ok: true, connected: true };
  }, [updateAccount, showNotification]);
}
