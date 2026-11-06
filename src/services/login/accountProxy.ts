/**
 * Đổi proxy của một tài khoản Zalo / Facebook mà không phải đăng nhập lại (issue #73): thử proxy mới, lưu
 * accounts.proxy_id rồi kết nối lại tài khoản bằng phiên đang lưu để proxy có hiệu lực ngay.
 *
 * - Proxy mới không phản hồi → không đổi gì (tài khoản vẫn chạy như cũ).
 * - Lưu được nhưng kết nối lại lỗi → vẫn giữ lựa chọn mới, báo `connected: false` + lý do để người dùng chọn proxy khác.
 * - `force`: kết nối lại dù proxy không đổi (vừa sửa thông tin proxy, vừa xoá proxy đang dùng).
 *
 * Phần gọi Zalo / Facebook / CSDL truyền vào qua `deps` (proxyIpc) để kiểm thử được.
 */
import { supportsAccountProxy } from '../../shared/accounts/accountProxy';
import type { ProxyConfig } from '../../models';

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
  /** Kết nối lại tài khoản với proxy vừa lưu; ném lỗi khi không kết nối được. */
  reconnect(account: { zalo_id: string; channel: string }, proxyId: number | null): Promise<void>;
}

export interface ApplyAccountProxyResult {
  success: boolean;
  /** proxy_id đang lưu sau lệnh này */
  proxyId?: number | null;
  changed?: boolean;
  /** true = đã kết nối lại với proxy mới; false = lưu được nhưng chưa kết nối lại được (xem reconnectError) */
  connected?: boolean;
  reconnectError?: string;
  error?: string;
}

/** Mỗi tài khoản một lệnh đổi proxy tại một thời điểm (bấm hai lần, đổi ở hai trang cùng lúc). */
const inFlight = new Set<string>();

export async function applyAccountProxy(
  deps: AccountProxyDeps,
  accountId: string,
  proxyId: number | null,
  opts: { force?: boolean } = {},
): Promise<ApplyAccountProxyResult> {
  if (!accountId) return { success: false, error: 'Thiếu tài khoản' };
  const account = deps.getAccount(accountId);
  if (!account) return { success: false, error: 'Không tìm thấy tài khoản' };
  const channel = account.channel || 'zalo';
  if (!supportsAccountProxy(channel)) return { success: false, error: 'Kênh này chưa dùng được proxy' };

  const current = account.proxy_id ?? null;
  if (current === proxyId && !opts.force) return { success: true, proxyId, changed: false };

  let proxy: ProxyConfig | null = null;
  if (proxyId != null) {
    proxy = deps.getProxy(proxyId);
    if (!proxy) return { success: false, error: 'Proxy không còn tồn tại' };
  }

  if (inFlight.has(accountId)) return { success: false, error: 'Đang đổi proxy cho tài khoản này, chờ chút' };
  inFlight.add(accountId);
  try {
    if (proxy) {
      const test = await deps.testProxy(proxy);
      if (!test.ok) return { success: false, error: test.error || 'Proxy không phản hồi' };
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
