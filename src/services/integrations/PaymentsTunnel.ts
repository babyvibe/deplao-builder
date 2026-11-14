/**
 * PaymentsTunnel: the Internet address of the port that receives payment / integration webhooks (IntegrationRegistry, default 9888:
 * Casso, SePay, POS software...). One logical flow for:
 *   - ipcMain 'tunnel:start' / 'tunnel:stop' / 'tunnel:status' (electron/ipc/integrations/integrationIpc.ts: calls only go here);
 *   - the tunnel module (src/services/cloudflare/tunnel) when the 'payments' service is switched on / off in
 *     Settings → Internet & Cloud → Internet address (Temporary address / ngrok / manual Cloudflare modes).
 *
 * Mode 'cloudflare_auto': the address is the 'payments' service of the shared fixed tunnel (src/services/cloudflare/tunnel,
 * lazy-loaded: a load error → null = behaves as before). Other modes: a Cloudflare Quick Tunnel dedicated to the port (TunnelService, temporary
 * address); ngrok / manual Cloudflare only apply to the relay. Every address change is reported to the renderer via 'tunnel:changed'.
 * Results keep the exact shape of the old IPC: start → { success, url?, error? }, stop → { success, error? }, status → { active, url }.
 */
import { BrowserWindow } from 'electron';
import IntegrationRegistry from './IntegrationRegistry';
import TunnelService from '../tunnel/TunnelService';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

type CloudTunnelApi = typeof import('../cloudflare/tunnel');

function cloudTunnelIfAuto(): CloudTunnelApi | null {
    try {
        const mod: CloudTunnelApi = require('../cloudflare/tunnel');
        return mod.isCloudTunnelAuto() ? mod : null;
    } catch {
        return null;
    }
}

/** The base address currently usable (the renderer appends /webhook/<type> itself, as with the old tunnelUrl). */
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

/** The payment address changes (process up/down, on/off in the Internet & Cloud screen) → 'tunnel:changed' like the old tunnel. */
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

/** Turn on the payment webhook receiving address (like 'tunnel:start'). */
export async function startPaymentsTunnel(): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
        const port = IntegrationRegistry.getWebhookPort();
        const cloud = cloudTunnelIfAuto();
        if (cloud) {
            // Enable the 'payments' service on the shared tunnel (only changes the ingress, does not restart cloudflared)
            await cloud.cloudTunnel.setServiceEnabled('payments', true);
            watchCloudPayments(cloud);
            const cloudUrl = cloudPaymentsUrl(cloud);
            // A fixed address exists → this port's old tunnel (Quick Tunnel...) is no longer used
            if (cloudUrl && TunnelService.getState(port)) void TunnelService.stop(port).catch(() => {});
            lastCloudPaymentsUrl = cloudUrl;
            sendTunnelChanged(port, cloudUrl);
            if (cloudUrl) return { success: true, url: cloudUrl };
            return { success: false, error: cloud.cloudTunnel.addressOf('payments').error || tr('Địa chỉ Cloudflare chưa kết nối xong — đang tự thử lại') };
        }
        const url = await TunnelService.start(port, 'Webhook Gateway');
        // Notify all renderer windows of the tunnel URL change
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('tunnel:changed', { port, url }));
        // Tunnel died / restarted by itself (Quick Tunnel → new URL) → notify the renderer. Listener per session: removed automatically when switched off / on again.
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

/** Turn off the payment webhook receiving address (like 'tunnel:stop'). */
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
 * Base address used to register webhooks on the POS software (posWebhookRegistration.ts): Cloudflare automatic = fixed address;
 * other modes = the port's Quick Tunnel: a temporary address that changes on every restart (webhooks must be registered again).
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

/** The payment webhook receiving address currently usable (like 'tunnel:status'). */
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
