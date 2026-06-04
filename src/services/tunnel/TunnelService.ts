/**
 * TunnelService — wraps cloudflared Quick Tunnel to expose the relay HTTP server to the internet.
 * Uses trycloudflare.com — no Cloudflare account required.
 *
 * Advantages over loca.lt (localtunnel):
 *  - No response size limits (loca.lt chokes on large JSON payloads)
 *  - No interstitial HTML bypass page
 *  - Much higher bandwidth & concurrent connection support
 *  - More stable long-lived connections (important for SSE streams)
 *
 * Usage:
 *   const url = await TunnelService.start(9900);   // returns https://xxxx.trycloudflare.com
 *   TunnelService.stop();
 */

import path from 'path';
import Logger from '../../utils/Logger';

let Tunnel: any = null;
let bin: string | null = null;
let install: ((to: string) => Promise<string>) | null = null;

try {
  const cf = require('cloudflared');
  Tunnel = cf.Tunnel;
  bin = cf.bin;
  install = cf.install;

  // Fix binary path when running inside Electron asar archive.
  // asarUnpack extracts the binary to app.asar.unpacked/, but __dirname
  // still resolves to the asar path. Rewrite bin to point to unpacked location.
  if (bin && bin.includes('app.asar')) {
    bin = bin.replace('app.asar', 'app.asar.unpacked');
    Logger.log(`[TunnelService] Rewrote bin path for asar: ${bin}`);
  }
} catch {
  Logger.warn('[TunnelService] cloudflared package not found');
}

let activeTunnel: any = null;
let activeUrl: string | null = null;
let onChangeCallbacks: ((url: string | null) => void)[] = [];

export const TunnelService = {
  /** Start a Cloudflare Quick Tunnel pointing to the local relay port. Returns the public URL. */
  async start(port: number): Promise<string> {
    if (activeTunnel) {
      await this.stop();
    }

    if (!Tunnel || !bin || !install) {
      throw new Error('Chưa cài gói cloudflared. Chạy: npm install cloudflared');
    }

    // Auto-install the cloudflared binary on first run
    const fs = require('fs');
    if (!fs.existsSync(bin)) {
      Logger.log('[TunnelService] Installing cloudflared binary (first time)...');
      await install(bin);
      Logger.log('[TunnelService] cloudflared binary installed');
    }

    Logger.log(`[TunnelService] Starting Cloudflare Quick Tunnel on port ${port}...`);

    return new Promise((resolve, reject) => {
      const tunnel = Tunnel.quick(`http://localhost:${port}`);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { tunnel.stop(); } catch {}
          reject(new Error('Cloudflare tunnel timeout — kiểm tra kết nối mạng'));
        }
      }, 30_000);

      tunnel.on('url', (url: string) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          activeTunnel = tunnel;
          activeUrl = url;
          Logger.log(`[TunnelService] Tunnel active: ${url}`);
          TunnelService._notifyChange(url);
          resolve(url);
        }
      });

      tunnel.on('error', (err: Error) => {
        Logger.error(`[TunnelService] Tunnel error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        } else {
          activeTunnel = null;
          activeUrl = null;
          TunnelService._notifyChange(null);
        }
      });

      tunnel.on('exit', (code: number | null) => {
        if (activeTunnel === tunnel) {
          Logger.log(`[TunnelService] Tunnel exited (code ${code})`);
          activeTunnel = null;
          activeUrl = null;
          TunnelService._notifyChange(null);
        }
      });
    });
  },

  /** Stop the active tunnel */
  async stop(): Promise<void> {
    if (activeTunnel) {
      try { activeTunnel.stop(); } catch { /* ignore */ }
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
