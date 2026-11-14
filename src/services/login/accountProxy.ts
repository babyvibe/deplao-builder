/**
 * Changes the proxy of a Zalo / Facebook account without logging in again (issue #73): tests the new proxy, saves
 * accounts.proxy_id, then reconnects the account with the saved session so the proxy takes effect right away.
 *
 * - New proxy does not respond → nothing changes (the account keeps running as before).
 * - Saved but the reconnect fails → the new choice is kept, reports `connected: false` + the reason so the user can pick another proxy.
 * - `force`: reconnect even if the proxy did not change (when the proxy info was just edited, or the proxy in use was just deleted).
 *
 * The calls to Zalo / Facebook / the DB are passed in through `deps` (proxyIpc) so they can be tested.
 */
import { supportsAccountProxy } from '../../shared/accounts/accountProxy';
import type { ProxyConfig } from '../../models';
import { tr } from '../../shared/i18n';

export interface AccountProxyAccount {
  zalo_id: string;
  channel?: string | null;
  proxy_id?: number | null;
}

export interface AccountProxyDeps {
  getAccount(accountId: string): AccountProxyAccount | null;
  getProxy(proxyId: number): ProxyConfig | null;
  saveAccountProxy(accountId: string, proxyId: number | null): void;
  testProxy(proxy: ProxyConfig): Promise<{ ok: boolean; error?: string }>;
  /** Reconnects the account with the proxy just saved; throws an error when it cannot connect. */
  reconnect(account: { zalo_id: string; channel: string }, proxyId: number | null): Promise<void>;
}

export interface ApplyAccountProxyResult {
  success: boolean;
  /** proxy_id stored after this command */
  proxyId?: number | null;
  changed?: boolean;
  /** true = reconnected with the new proxy; false = saved, but the reconnect could not be done yet (see reconnectError) */
  connected?: boolean;
  reconnectError?: string;
  error?: string;
}

/** Only one proxy change per account at a time (double click, or changing it on two pages at once). */
const inFlight = new Set<string>();

export async function applyAccountProxy(
  deps: AccountProxyDeps,
  accountId: string,
  proxyId: number | null,
  opts: { force?: boolean } = {},
): Promise<ApplyAccountProxyResult> {
  if (!accountId) return { success: false, error: tr('Thiếu tài khoản') };
  const account = deps.getAccount(accountId);
  if (!account) return { success: false, error: tr('Không tìm thấy tài khoản') };
  const channel = account.channel || 'zalo';
  if (!supportsAccountProxy(channel)) return { success: false, error: tr('Kênh này chưa dùng được proxy') };

  const current = account.proxy_id ?? null;
  if (current === proxyId && !opts.force) return { success: true, proxyId, changed: false };

  let proxy: ProxyConfig | null = null;
  if (proxyId != null) {
    proxy = deps.getProxy(proxyId);
    if (!proxy) return { success: false, error: tr('Proxy không còn tồn tại') };
  }

  if (inFlight.has(accountId)) return { success: false, error: tr('Đang đổi proxy cho tài khoản này, chờ chút') };
  inFlight.add(accountId);
  try {
    if (proxy) {
      const test = await deps.testProxy(proxy);
      if (!test.ok) return { success: false, error: test.error || tr('Proxy không phản hồi') };
    }
    deps.saveAccountProxy(accountId, proxyId);
    const changed = current !== proxyId;
    try {
      await deps.reconnect({ zalo_id: account.zalo_id, channel }, proxyId);
      return { success: true, proxyId, changed, connected: true };
    } catch (err: any) {
      return { success: true, proxyId, changed, connected: false, reconnectError: err?.message || String(err) };
    }
  } finally {
    inFlight.delete(accountId);
  }
}
