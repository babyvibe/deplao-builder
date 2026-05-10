/**
 * TunnelService — wraps localtunnel to expose the webhook HTTP server to the internet.
 * This allows external services (Casso, SePay, ...) to send webhooks to the Electron app.
 *
 * Usage:
 *   const url = await TunnelService.start(9888);   // returns https://xxxx.loca.lt
 *   TunnelService.stop();
 */

import Logger from '../utils/Logger';

// Dynamic import to avoid issues if localtunnel is not installed
let localtunnel: any = null;
try {
  localtunnel = require('localtunnel');
} catch {
  Logger.warn('[TunnelService] localtunnel package not found');
}

interface TunnelInstance {
  url: string;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

let activeTunnel: TunnelInstance | null = null;
let activeUrl: string | null = null;
let onChangeCallbacks: ((url: string | null) => void)[] = [];

export const TunnelService = {
  /** Start a tunnel pointing to the local webhook port. Returns the public URL. */
  async start(port: number): Promise<string> {
    if (activeTunnel) {
      await this.stop();
    }

    if (!localtunnel) {
      throw new Error('Chưa cài gói localtunnel. Chạy: npm install localtunnel');
    }

    Logger.log(`[TunnelService] Starting tunnel on port ${port}...`);

    const tunnel: TunnelInstance = await localtunnel({ port });
    activeTunnel = tunnel;
    activeUrl = tunnel.url;

    Logger.log(`[TunnelService] Tunnel active: ${activeUrl}`);
    this._notifyChange(activeUrl);

    tunnel.on('close', () => {
      Logger.log('[TunnelService] Tunnel closed');
      activeTunnel = null;
      activeUrl = null;
      this._notifyChange(null);
    });

    tunnel.on('error', (err: Error) => {
      Logger.error(`[TunnelService] Tunnel error: ${err.message}`);
      activeTunnel = null;
      activeUrl = null;
      this._notifyChange(null);
    });

    return activeUrl!;
  },

  /** Stop the active tunnel */
  async stop(): Promise<void> {
    if (activeTunnel) {
      try { activeTunnel.close(); } catch { /* ignore */ }
      activeTunnel = null;
      activeUrl = null;
      this._notifyChange(null);
      Logger.log('[TunnelService] Tunnel stopped');
    }
  },

  /** Get current tunnel URL (null if not active) */
  getUrl(): string | null {
    return activeUrl;
  },

  /** Check if tunnel is currently active */
  isActive(): boolean {
    return !!activeUrl;
  },

  /** Register a callback for tunnel URL changes */
  onChange(cb: (url: string | null) => void): void {
    onChangeCallbacks.push(cb);
  },

  _notifyChange(url: string | null): void {
    for (const cb of onChangeCallbacks) {
      try { cb(url); } catch { /* ignore */ }
    }
  },
};

export default TunnelService;

