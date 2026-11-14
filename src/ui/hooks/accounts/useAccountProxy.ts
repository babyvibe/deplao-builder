/**
 * Add / change / remove a proxy for one account, then reconnect right away (proxy:applyToAccount, no re-login needed). Shared by
 * the "Proxy" line in Settings → Accounts and the account list under each proxy in Settings → Proxy.
 */
import { useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { tr } from '../../../shared/i18n';

export type ApplyAccountProxyOutcome = {
  ok: boolean;
  /** false = proxy saved, but the account could not reconnect */
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
      const error = res?.error || tr('Không đổi được proxy');
      if (!opts.quiet) showNotification(error, 'error');
      return { ok: false, error };
    }

    updateAccount(accountId, { proxy_id: res.proxyId ?? null });
    if (res.changed === false && !opts.force) return { ok: true, connected: true };
    if (res.connected === false) {
      const error = res.reconnectError || tr('Chưa kết nối lại được');
      if (!opts.quiet) showNotification(tr('Đã lưu proxy nhưng chưa kết nối lại được: {{error}}', { error }), 'warning');
      return { ok: true, connected: false, error };
    }
    if (!opts.quiet) {
      showNotification(proxyId != null ? tr('Đã đổi proxy, tài khoản đã kết nối lại') : tr('Đã bỏ proxy, tài khoản đã kết nối lại'), 'success');
    }
    return { ok: true, connected: true };
  }, [updateAccount, showNotification]);
}
