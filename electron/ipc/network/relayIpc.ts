import { ipcMain } from 'electron';
import HttpRelayService from '../../../src/services/http/HttpRelayService';
import DatabaseService from '../../../src/services/database/DatabaseService';
import WorkspaceManager from '../../../src/utils/app/WorkspaceManager';
import { probeBossAddress } from '../../../src/services/tunnel/BossAddressProbe';
import Logger from '../../../src/utils/Logger';
import os from 'os';

/** Lấy địa chỉ IPv4 local (không loopback) */
function getLocalIp(): string {
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            const ifaces = nets[name];
            if (!ifaces) continue;
            for (const iface of ifaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    } catch {}
    return '127.0.0.1';
}

export function registerRelayIpc(): void {
    const relay = () => HttpRelayService.getInstance();

    ipcMain.handle('relay:startServer', async (_e, { port }: { port?: number } = {}) => {
        try {
            const res = await relay().start(port);
            if (res.success) {
                return { ...res, host: getLocalIp() };
            }
            return res;
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:stopServer', async () => {
        try {
            return relay().stop();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:getServerStatus', async () => {
        try {
            return { success: true, ...relay().getStatus() };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:kickEmployee', async (_e, { employeeId }: { employeeId: string }) => {
        try {
            relay().kickEmployee(employeeId);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:startTunnel', async () => {
        try {
            return await relay().startTunnel();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:stopTunnel', async () => {
        try {
            return await relay().stopTunnel();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // Đổi cấu hình khi tunnel đang chạy (make-before-break): nhân viên đang nối được báo địa chỉ mới trước khi tunnel cũ tắt.
    ipcMain.handle('relay:restartTunnel', async () => {
        try {
            return await relay().restartTunnel();
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:getTunnelStatus', async () => {
        try {
            return { success: true, ...relay().getTunnelStatus() };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Nhân viên: thăm dò địa chỉ Boss (DNS + GET /api/health, không gửi token) ────
    ipcMain.handle('relay:probeBossAddress', async (_e, params: { url?: string; workspaceId?: string } = {}) => {
        try {
            let url = typeof params?.url === 'string' ? params.url.trim() : '';
            if (!url) {
                const wm = WorkspaceManager.getInstance();
                const ws = params?.workspaceId ? wm.getWorkspaceById(params.workspaceId) : wm.getActiveWorkspace();
                url = ws?.type === 'remote' ? String(ws.bossUrl || '') : '';
            }
            if (!url) return { success: false, error: 'Chưa có địa chỉ BOSS' };
            const result = await probeBossAddress(url);
            return { success: true, ...result };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // ─── Tunnel provider config (cloudflare | ngrok static domain | Cloudflare có tài khoản) ──────────────
    // Token ngrok / Cloudflare lưu mã hoá (secretBox) và không trả về renderer — chỉ báo đã đặt hay chưa.
    ipcMain.handle('relay:getTunnelConfig', async () => {
        try {
            const db = DatabaseService.getInstance();
            return {
                success: true,
                provider: db.getSetting('relay_tunnel_provider') || 'cloudflare',
                ngrokTokenSet: !!db.getSetting('relay_ngrok_authtoken'),
                domain: db.getSetting('relay_ngrok_domain') || '',
                cfTokenSet: !!db.getSetting('relay_cf_tunnel_token'),
                cfPublicUrl: db.getSetting('relay_cf_public_url') || '',
                autoStart: db.getSetting('relay_tunnel_autostart') === '1',
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('relay:setTunnelConfig', async (_e, cfg: { provider?: string; authtoken?: string; domain?: string; cfToken?: string; cfPublicUrl?: string; autoStart?: boolean } = {}) => {
        try {
            const db = DatabaseService.getInstance();
            const { encryptSecret } = require('../../../src/services/api/auth/secretBox');
            if (cfg.provider !== undefined) {
                if (!['cloudflare', 'ngrok', 'cloudflare_named'].includes(cfg.provider)) return { success: false, error: 'Provider không hợp lệ' };
                db.setSetting('relay_tunnel_provider', cfg.provider);
            }
            if (typeof cfg.authtoken === 'string' && cfg.authtoken.trim()) {
                db.setSetting('relay_ngrok_authtoken', encryptSecret(cfg.authtoken.trim()));
            }
            if (typeof cfg.domain === 'string') {
                // Domain tĩnh ngrok: chỉ hostname (bỏ https:// và / cuối nếu dán cả URL)
                db.setSetting('relay_ngrok_domain', cfg.domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
            }
            if (typeof cfg.cfToken === 'string' && cfg.cfToken.trim()) {
                db.setSetting('relay_cf_tunnel_token', encryptSecret(cfg.cfToken.trim()));
            }
            if (typeof cfg.cfPublicUrl === 'string') db.setSetting('relay_cf_public_url', cfg.cfPublicUrl.trim().replace(/\/+$/, ''));
            if (typeof cfg.autoStart === 'boolean') db.setSetting('relay_tunnel_autostart', cfg.autoStart ? '1' : '0');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    Logger.log('[relayIpc] Registered 11 relay IPC channels');
}
