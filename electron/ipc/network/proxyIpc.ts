import { ipcMain } from 'electron';
import DatabaseService from '../../../src/services/database/DatabaseService';
import Logger from '../../../src/utils/Logger';
import { createProxyAgent } from '../../../src/utils/connection/ProxyHelper';

export function registerProxyIpc() {
    // ─── Lấy danh sách proxies ─────────────────────────────────────────────────
    ipcMain.handle('proxy:list', async () => {
        try {
            const proxies = DatabaseService.getInstance().getProxies();
            return { success: true, proxies };
        } catch (err: any) {
            Logger.error(`[proxyIpc] list error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Tạo proxy mới ─────────────────────────────────────────────────────────
    ipcMain.handle('proxy:save', async (_event, { proxy }) => {
        try {
            if (!proxy?.host || !proxy?.port) {
                return { success: false, error: 'Host và Port không được để trống' };
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

    // ─── Cập nhật proxy ────────────────────────────────────────────────────────
    ipcMain.handle('proxy:update', async (_event, { id, proxy }) => {
        try {
            if (!id) return { success: false, error: 'Thiếu id proxy' };
            DatabaseService.getInstance().updateProxy(Number(id), proxy);
            const updated = DatabaseService.getInstance().getProxyById(Number(id));
            return { success: true, proxy: updated };
        } catch (err: any) {
            Logger.error(`[proxyIpc] update error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Xóa proxy ──────────────────────────────────────────────────────���──────
    ipcMain.handle('proxy:delete', async (_event, { id }) => {
        try {
            if (!id) return { success: false, error: 'Thiếu id proxy' };
            DatabaseService.getInstance().deleteProxy(Number(id));
            return { success: true };
        } catch (err: any) {
            Logger.error(`[proxyIpc] delete error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Gắn/gỡ proxy cho tài khoản ────────────────────────────────────────────
    ipcMain.handle('proxy:setAccount', async (_event, { zaloId, proxyId }) => {
        try {
            if (!zaloId) return { success: false, error: 'Thiếu zaloId' };
            DatabaseService.getInstance().setAccountProxy(zaloId, proxyId ?? null);
            return { success: true };
        } catch (err: any) {
            Logger.error(`[proxyIpc] setAccount error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Lấy proxy của 1 tài khoản ─────────────────────────────────────────────
    ipcMain.handle('proxy:getForAccount', async (_event, { zaloId }) => {
        try {
            if (!zaloId) return { success: false, error: 'Thiếu zaloId' };
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
                return { success: false, error: 'Host và Port không được để trống' };
            }
            const agent = createProxyAgent({
                id: 0,
                name: proxy.name || '',
                type: proxy.type || 'http',
                host: proxy.host.trim(),
                port: Number(proxy.port),
                username: proxy.username || '',
                password: proxy.password || '',
            });
            if (!agent) {
                return { success: false, error: 'Không thể tạo proxy agent' };
            }

            // Test bằng cách kết nối đến URL qua proxy (HEAD request)
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

            // Thử lần lượt các URL
            let lastError = '';
            for (const url of URLS) {
                const result = await testReq(url);
                if (result.ok) {
                    return { success: true, ms: result.ms, status: result.status };
                }
                lastError = `HTTP ${result.status || 'timeout'}`;
            }
            return { success: false, error: `Proxy không phản hồi (${lastError}). Kiểm tra lại host/port/credentials.` };
        } catch (err: any) {
            Logger.error(`[proxyIpc] test error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

