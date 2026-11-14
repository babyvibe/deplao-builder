import { ipcMain } from 'electron';
import DatabaseService from '../../../src/services/database/DatabaseService';
import EventBroadcaster from '../../../src/services/event/EventBroadcaster';
import LoginService from '../../../src/services/login/LoginService';
import { applyAccountProxy, type AccountProxyDeps } from '../../../src/services/login/accountProxy';
import { inUiRemoteScope } from '../../../src/services/database/dbScope';
import { isUndecryptedCredential } from '../../../src/shared/accounts/storedCredential';
import Logger from '../../../src/utils/Logger';
import { createProxyAgent } from '../../../src/utils/connection/ProxyHelper';
import type { ProxyConfig } from '../../../src/models';
import { reconnectFacebookAccount } from '../facebook/facebookIpc';
import { tr } from '../../../src/shared/i18n';

/** Test the Internet connection through the proxy (HEAD requests to a few large pages): used by the "Thử kết nối" (Test connection) button and before changing the proxy. */
async function testProxyConnection(proxy: ProxyConfig): Promise<{ ok: boolean; ms?: number; status?: number; error?: string }> {
    const agent = createProxyAgent(proxy);
    if (!agent) return { ok: false, error: tr('Không thể tạo proxy agent') };

    const https = require('https');
    const URLS = ['https://www.google.com', 'https://httpbin.org/get'];

    const testReq = (url: string): Promise<{ ok: boolean; status: number; ms: number }> =>
        new Promise((resolve) => {
            const start = Date.now();
            const parsedUrl = new URL(url);
            const req = https.request(
                {
                    hostname: parsedUrl.hostname,
                    path: parsedUrl.pathname,
                    method: 'HEAD',
                    agent,
                    timeout: 10000,
                },
                (res: any) => {
                    resolve({ ok: true, status: res.statusCode, ms: Date.now() - start });
                    res.resume();
                }
            );
            req.on('error', () => resolve({ ok: false, status: 0, ms: Date.now() - start }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - start }); });
            req.end();
        });

    // Try the URLs one by one
    let lastError = '';
    for (const url of URLS) {
        const result = await testReq(url);
        if (result.ok) return { ok: true, ms: result.ms, status: result.status };
        lastError = `HTTP ${result.status || 'timeout'}`;
    }
    return { ok: false, error: tr('Proxy không phản hồi ({{lastError}}). Kiểm tra lại host/port/credentials.', { lastError }) };
}

/** Reconnect a Zalo account using the saved session with the newly chosen proxy (null = connect directly). */
async function reconnectZaloAccount(loginService: LoginService, zaloId: string, proxyId: number | null): Promise<void> {
    const db = DatabaseService.getInstance();
    const acc: any = db.getAccounts().find((a: any) => a.zalo_id === zaloId);
    if (!acc?.cookies || isUndecryptedCredential(acc.cookies)) {
        throw new Error(tr('Phiên đăng nhập không dùng được trên máy này, cần đăng nhập lại tài khoản'));
    }
    // Disconnect the old session (it still goes through the old proxy), then sign in again with the saved cookies via the new proxy
    await loginService.disconnectUser(zaloId);
    const ok = await loginService.connectUser({ imei: acc.imei, cookies: acc.cookies, userAgent: acc.user_agent, proxyId })
        .catch((err: any) => { throw new Error(err?.message || tr('Không kết nối lại được')); });
    if (!ok) {
        db.setListenerActive(zaloId, false);
        EventBroadcaster.broadcastListenerDead(zaloId, 'connect_failed');
        throw new Error(proxyId ? tr('Không đăng nhập được Zalo qua proxy này') : tr('Không kết nối lại được Zalo'));
    }
    db.setListenerActive(zaloId, true);
}

export function registerProxyIpc() {
    const loginService = new LoginService();

    const accountProxyDeps = (): AccountProxyDeps => {
        const db = DatabaseService.getInstance();
        return {
            getAccount: (accountId) => db.queryOne<any>(
                'SELECT zalo_id, channel, proxy_id FROM accounts WHERE zalo_id = ? AND is_active = 1',
                [accountId],
            ) || null,
            getProxy: (proxyId) => db.getProxyById(proxyId),
            saveAccountProxy: (accountId, proxyId) => db.setAccountProxy(accountId, proxyId),
            testProxy: (proxy) => testProxyConnection(proxy),
            reconnect: (account, proxyId) => account.channel === 'facebook'
                ? reconnectFacebookAccount(account.zalo_id)
                : reconnectZaloAccount(loginService, account.zalo_id, proxyId),
        };
    };

    // ─── Get the list of proxies ─────────────────────────────────────────────────
    ipcMain.handle('proxy:list', async () => {
        try {
            const proxies = DatabaseService.getInstance().getProxies();
            return { success: true, proxies };
        } catch (err: any) {
            Logger.error(`[proxyIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Create a new proxy ─────────────────────────────────────────────────────────
    ipcMain.handle('proxy:save', async (_event, { proxy }) => {
        try {
            if (!proxy?.host || !proxy?.port) {
                return { success: false, error: tr('Host và Port không được để trống') };
            }
            const id = DatabaseService.getInstance().saveProxy({
                name: proxy.name || `${proxy.host}:${proxy.port}`,
                type: proxy.type || 'http',
                host: proxy.host.trim(),
                port: Number(proxy.port),
                username: proxy.username || '',
                password: proxy.password || '',
            });
            const saved = DatabaseService.getInstance().getProxyById(id);
            return { success: true, id, proxy: saved };
        } catch (err: any) {
            Logger.error(`[proxyIpc] save error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Update a proxy ────────────────────────────────────────────────────────
    ipcMain.handle('proxy:update', async (_event, { id, proxy }) => {
        try {
            if (!id) return { success: false, error: tr('Thiếu id proxy') };
            DatabaseService.getInstance().updateProxy(Number(id), proxy);
            const updated = DatabaseService.getInstance().getProxyById(Number(id));
            return { success: true, proxy: updated };
        } catch (err: any) {
            Logger.error(`[proxyIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Delete a proxy ──────────────────────────────────────────────────────────────
    ipcMain.handle('proxy:delete', async (_event, { id }) => {
        try {
            if (!id) return { success: false, error: tr('Thiếu id proxy') };
            DatabaseService.getInstance().deleteProxy(Number(id));
            return { success: true };
        } catch (err: any) {
            Logger.error(`[proxyIpc] delete error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Assign / remove a proxy for an account (save only, applied at the next connection) ───────────
    ipcMain.handle('proxy:setAccount', async (_event, { zaloId, proxyId }) => {
        try {
            if (!zaloId) return { success: false, error: tr('Thiếu zaloId') };
            DatabaseService.getInstance().setAccountProxy(zaloId, proxyId ?? null);
            return { success: true };
        } catch (err: any) {
            Logger.error(`[proxyIpc] setAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Add / change / remove an account's proxy and reconnect right away (no need to sign in again) ──
    ipcMain.handle('proxy:applyToAccount', async (_event, { accountId, proxyId, force }) => {
        try {
            if (inUiRemoteScope()) {
                return { success: false, error: tr('Proxy do máy chủ quản lý, máy nhân viên không đổi được') };
            }
            const id = proxyId == null || proxyId === '' ? null : Number(proxyId);
            if (id !== null && (!Number.isInteger(id) || id <= 0)) return { success: false, error: tr('Proxy không hợp lệ') };
            const result = await applyAccountProxy(accountProxyDeps(), String(accountId || ''), id, { force: !!force });
            if (result.success && result.changed !== false) {
                Logger.log(`[proxyIpc] applyToAccount ${accountId}: proxy=${id ?? 'none'} connected=${result.connected}${result.reconnectError ? ` (${result.reconnectError})` : ''}`);
            }
            return result;
        } catch (err: any) {
            Logger.error(`[proxyIpc] applyToAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Get the proxy of 1 account ─────────────────────────────────────────────
    ipcMain.handle('proxy:getForAccount', async (_event, { zaloId }) => {
        try {
            if (!zaloId) return { success: false, error: tr('Thiếu zaloId') };
            const proxy = DatabaseService.getInstance().getAccountProxy(zaloId);
            return { success: true, proxy };
        } catch (err: any) {
            Logger.error(`[proxyIpc] getForAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Test proxy connection ──────────────────────────────────────────────────
    ipcMain.handle('proxy:test', async (_event, { proxy }) => {
        try {
            if (!proxy?.host || !proxy?.port) {
                return { success: false, error: tr('Host và Port không được để trống') };
            }
            const result = await testProxyConnection({
                id: 0,
                name: proxy.name || '',
                type: proxy.type || 'http',
                host: proxy.host.trim(),
                port: Number(proxy.port),
                username: proxy.username || '',
                password: proxy.password || '',
            });
            return result.ok
                ? { success: true, ms: result.ms, status: result.status }
                : { success: false, error: result.error };
        } catch (err: any) {
            Logger.error(`[proxyIpc] test error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}
