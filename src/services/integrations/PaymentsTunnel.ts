/**
 * PaymentsTunnel — địa chỉ Internet của cổng nhận webhook thanh toán / tích hợp (IntegrationRegistry, mặc định 9888:
 * Casso, SePay, phần mềm bán hàng…). Một luồng logic cho:
 *   - ipcMain 'tunnel:start' / 'tunnel:stop' / 'tunnel:status' (electron/ipc/integrations/integrationIpc.ts — chỉ gọi vào đây);
 *   - module tunnel (src/services/cloudflare/tunnel) khi bật / tắt dịch vụ 'payments' ở
 *     Cài đặt → Internet & Đám mây → Địa chỉ Internet (chế độ Địa chỉ tạm / ngrok / Cloudflare thủ công).
 *
 * Chế độ 'cloudflare_auto': địa chỉ là dịch vụ 'payments' của tunnel cố định dùng chung (src/services/cloudflare/tunnel,
 * nạp lười — lỗi nạp → null = chạy như cũ). Chế độ khác: Cloudflare Quick Tunnel riêng cho cổng (TunnelService, địa chỉ
 * tạm) — ngrok / Cloudflare thủ công chỉ áp dụng cho relay. Mọi thay đổi địa chỉ báo renderer qua 'tunnel:changed'.
 * Kết quả giữ đúng dạng của IPC cũ: start → { success, url?, error? }, stop → { success, error? }, status → { active, url }.
 */
import { BrowserWindow } from 'electron';
import IntegrationRegistry from './IntegrationRegistry';
import TunnelService from '../tunnel/TunnelService';
import Logger from '../../utils/Logger';

type CloudTunnelApi = typeof import('../cloudflare/tunnel');

function cloudTunnelIfAuto(): CloudTunnelApi | null {
    try {
        const mod: CloudTunnelApi = require('../cloudflare/tunnel');
        return mod.isCloudTunnelAuto() ? mod : null;
    } catch {
        return null;
    }
}

/** Địa chỉ gốc đang dùng được (renderer tự nối /webhook/<loại> như với tunnelUrl cũ). */
function cloudPaymentsUrl(cloud: CloudTunnelApi): string | null {
    const address = cloud.cloudTunnel.addressOf('payments');
    return address.state === 'active' && address.url ? address.url : null;
}

function sendTunnelChanged(port: number, url: string | null): void {
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('tunnel:changed', { port, url });
    });
}

let cloudPaymentsWatchOff: (() => void) | null = null;
let lastCloudPaymentsUrl: string | null = null;

/** Địa chỉ thanh toán đổi (tiến trình lên/xuống, bật/tắt ở màn Internet & Đám mây) → 'tunnel:changed' như tunnel cũ. */
function watchCloudPayments(cloud: CloudTunnelApi): void {
    if (cloudPaymentsWatchOff) return;
    lastCloudPaymentsUrl = cloudPaymentsUrl(cloud);
    cloudPaymentsWatchOff = cloud.onCloudTunnelChange(() => {
        if (!cloud.isCloudTunnelAuto()) return;
        const url = cloudPaymentsUrl(cloud);
        if (url === lastCloudPaymentsUrl) return;
        lastCloudPaymentsUrl = url;
        sendTunnelChanged(IntegrationRegistry.getWebhookPort(), url);
    });
}

/** Bật địa chỉ nhận webhook thanh toán (như 'tunnel:start'). */
export async function startPaymentsTunnel(): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
        const port = IntegrationRegistry.getWebhookPort();
        const cloud = cloudTunnelIfAuto();
        if (cloud) {
            // Bật dịch vụ 'payments' trên tunnel dùng chung (chỉ đổi ingress, không chạy lại cloudflared)
            await cloud.cloudTunnel.setServiceEnabled('payments', true);
            watchCloudPayments(cloud);
            const cloudUrl = cloudPaymentsUrl(cloud);
            // Đã có địa chỉ cố định → tunnel cũ của cổng này (Quick Tunnel…) không còn dùng
            if (cloudUrl && TunnelService.getState(port)) void TunnelService.stop(port).catch(() => {});
            lastCloudPaymentsUrl = cloudUrl;
            sendTunnelChanged(port, cloudUrl);
            if (cloudUrl) return { success: true, url: cloudUrl };
            return { success: false, error: cloud.cloudTunnel.addressOf('payments').error || 'Địa chỉ Cloudflare chưa kết nối xong — đang tự thử lại' };
        }
        const url = await TunnelService.start(port, 'Webhook Gateway');
        // Notify all renderer windows of the tunnel URL change
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tunnel:changed', { port, url }));
        // Tunnel chết / tự chạy lại (Quick Tunnel → URL mới) → báo renderer. Listener theo phiên: tự xoá khi tắt/bật lại.
        TunnelService.onChange(port, (nextUrl) => {
            BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) w.webContents.send('tunnel:changed', { port, url: nextUrl });
            });
        });
        return { success: true, url };
    } catch (e: any) {
        Logger.error(`[TunnelIpc] start: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/** Tắt địa chỉ nhận webhook thanh toán (như 'tunnel:stop'). */
export async function stopPaymentsTunnel(): Promise<{ success: boolean; error?: string }> {
    try {
        const port = IntegrationRegistry.getWebhookPort();
        const cloud = cloudTunnelIfAuto();
        if (cloud) {
            await cloud.cloudTunnel.setServiceEnabled('payments', false);
            watchCloudPayments(cloud);
            lastCloudPaymentsUrl = null;
        }
        await TunnelService.stop(port);
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tunnel:changed', { port, url: null }));
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Địa chỉ gốc để đăng ký webhook lên phần mềm bán hàng (posWebhookRegistration.ts): Cloudflare tự động = địa chỉ cố định;
 * chế độ khác = Quick Tunnel của cổng — địa chỉ tạm, đổi mỗi lần khởi động lại (phải đăng ký lại).
 */
export function paymentsWebhookAddress(): { url: string | null; temporary: boolean } {
    const cloud = cloudTunnelIfAuto();
    if (cloud) {
        watchCloudPayments(cloud);
        return { url: cloudPaymentsUrl(cloud), temporary: false };
    }
    const port = IntegrationRegistry.getWebhookPort();
    return { url: TunnelService.isActive(port) ? TunnelService.getUrl(port) : null, temporary: true };
}

/** Địa chỉ nhận webhook thanh toán đang dùng được (như 'tunnel:status'). */
export function paymentsTunnelStatus(): { active: boolean; url: string | null } {
    const port = IntegrationRegistry.getWebhookPort();
    const cloud = cloudTunnelIfAuto();
    if (cloud) {
        watchCloudPayments(cloud);
        const url = cloudPaymentsUrl(cloud);
        return { active: !!url, url };
    }
    return {
        active: TunnelService.isActive(port),
        url: TunnelService.getUrl(port),
    };
}
