/**
 * TunnelService - wraps cloudflared Quick Tunnel to expose local HTTP servers to the internet.
 * Uses trycloudflare.com - no Cloudflare account required.
 *
 * Supports MULTIPLE concurrent tunnels keyed by port number.
 * Each tunnel gets its own public URL (e.g. https://xxxx.trycloudflare.com).
 *
 * Advantages over loca.lt (localtunnel):
 *  - No response size limits (loca.lt chokes on large JSON payloads)
 *  - No interstitial HTML bypass page
 *  - Much higher bandwidth & concurrent connection support
 *  - More stable long-lived connections (important for SSE streams)
 *
 * Usage:
 *   const url1 = await TunnelService.start(9888, 'Webhook Gateway');
 *   const url2 = await TunnelService.start(9900, 'Employee Relay');
 *   TunnelService.stop(9888);            // stop one
 *   TunnelService.stopAll();             // stop all
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
  // cf.bin uses __dirname which resolves inside app.asar. We must use cf.use()
  // to update the module-scope bin variable that Tunnel.quick() reads via
  // import_constants.bin - a local assignment wouldn't propagate.
  if (bin && bin.includes('app.asar') && typeof cf.use === 'function') {
    bin = bin.replace('app.asar', 'app.asar.unpacked');
    cf.use(bin);  // ← writes into constants.js module-scope
    Logger.log(`[TunnelService] Rewrote bin path for asar: ${bin}`);
  }
} catch {
  Logger.warn('[TunnelService] cloudflared package not found');
}

// ngrok provider (optional). Cấp static domain cố định — dùng cho relay nhân viên.
let ngrok: any = null;
try {
  ngrok = require('@ngrok/ngrok');
} catch {
  Logger.warn('[TunnelService] @ngrok/ngrok package not found');
}

export type TunnelProvider = 'cloudflare' | 'ngrok';

export interface TunnelOptions {
  provider?: TunnelProvider;
  authtoken?: string;
  domain?: string;
}

// ─── Multi-tunnel store ──────────────────────────────────────────────────────

interface TunnelEntry {
  tunnel: any;          // cloudflared Tunnel hoặc ngrok listener
  provider: TunnelProvider;
  url: string | null;
  label: string;
  onChangeCbs: Set<(url: string | null) => void>;
}

const tunnels = new Map<number, TunnelEntry>();

// ─── Service ─────────────────────────────────────────────────────────────────

export const TunnelService = {
  /**
   * Start a tunnel pointing to a local port.
   * Provider mặc định là 'cloudflare' (Quick Tunnel, URL random). Truyền
   * opts.provider='ngrok' + authtoken/domain để có URL cố định.
   * Multiple tunnels can run concurrently (keyed by port).
   * Returns the public URL.
   */
  async start(port: number, label?: string, opts?: TunnelOptions): Promise<string> {
    // If a tunnel already exists for this port, stop it first before restarting
    if (tunnels.has(port)) {
      await this.stop(port);
    }

    if (opts?.provider === 'ngrok') {
      return this._startNgrok(port, label, opts);
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

    Logger.log(`[TunnelService] Starting Cloudflare Quick Tunnel on port ${port}${label ? ` (${label})` : ''}...`);

    return new Promise((resolve, reject) => {
      const tunnel = Tunnel.quick(`http://localhost:${port}`);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { tunnel.stop(); } catch {}
          reject(new Error(`Cloudflare tunnel timeout (port ${port}) - kiểm tra kết nối mạng`));
        }
      }, 30_000);

      tunnel.on('url', (url: string) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);

          const entry: TunnelEntry = {
            tunnel,
            provider: 'cloudflare',
            url,
            label: label || `Port ${port}`,
            onChangeCbs: new Set(),
          };
          tunnels.set(port, entry);

          Logger.log(`[TunnelService] ✅ Tunnel active [${port}]: ${url}${label ? ` (${label})` : ''}`);
          TunnelService._notifyChange(port, url);
          resolve(url);
        }
      });

      tunnel.on('error', (err: Error) => {
        Logger.error(`[TunnelService] Tunnel error [${port}]: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        } else {
          const entry = tunnels.get(port);
          if (entry && entry.tunnel === tunnel) {
            tunnels.delete(port);
            TunnelService._notifyChange(port, null);
          }
        }
      });

      tunnel.on('exit', (code: number | null) => {
        const entry = tunnels.get(port);
        if (entry && entry.tunnel === tunnel) {
          Logger.log(`[TunnelService] Tunnel exited (code ${code}) [${port}]`);
          tunnels.delete(port);
          TunnelService._notifyChange(port, null);
        }
      });
    });
  },

  /**
   * Start an ngrok tunnel với static domain cố định.
   * Yêu cầu authtoken (bắt buộc) và domain (tùy chọn — không có domain thì
   * ngrok cấp URL random như cloudflare, chỉ khác provider).
   */
  async _startNgrok(port: number, label?: string, opts?: TunnelOptions): Promise<string> {
    if (!ngrok) {
      throw new Error('Chưa cài gói @ngrok/ngrok. Chạy: npm install @ngrok/ngrok');
    }
    if (!opts?.authtoken) {
      throw new Error('Thiếu ngrok authtoken. Nhập trong Cài đặt → Tunnel.');
    }

    Logger.log(`[TunnelService] Starting ngrok tunnel on port ${port}${opts.domain ? ` (${opts.domain})` : ''}...`);

    const listener = await ngrok.forward({
      addr: port,
      authtoken: opts.authtoken,
      ...(opts.domain ? { domain: opts.domain } : {}),
    });
    const url = listener.url();

    const entry: TunnelEntry = {
      tunnel: listener,
      provider: 'ngrok',
      url,
      label: label || `Port ${port}`,
      onChangeCbs: tunnels.get(port)?.onChangeCbs ?? new Set(),
    };
    tunnels.set(port, entry);

    Logger.log(`[TunnelService] ✅ Tunnel active [${port}]: ${url} (ngrok${label ? ` - ${label}` : ''})`);
    TunnelService._notifyChange(port, url);
    return url;
  },

  /**
   * Stop a specific tunnel by port.
   * Usage: TunnelService.stop(9888)
   */
  async stop(port: number): Promise<void> {
    const entry = tunnels.get(port);
    if (entry) {
      try {
        if (entry.provider === 'ngrok') {
          await entry.tunnel?.close();   // ngrok listener
        } else {
          entry.tunnel?.stop();          // cloudflared
        }
      } catch { /* ignore */ }
      tunnels.delete(port);
      TunnelService._notifyChange(port, null);
      Logger.log(`[TunnelService] Stopped tunnel [${port}]${entry.label ? ` (${entry.label})` : ''}`);
    }
  },

  /**
   * Stop all active tunnels.
   */
  async stopAll(): Promise<void> {
    const ports = Array.from(tunnels.keys());
    for (const port of ports) {
      await this.stop(port);
    }
    Logger.log(`[TunnelService] All tunnels stopped (${ports.length} total)`);
  },

  /**
   * Get the public URL for a specific tunnel (null if not active).
   */
  getUrl(port: number): string | null {
    return tunnels.get(port)?.url ?? null;
  },

  /**
   * Check if a specific tunnel is currently active.
   */
  isActive(port: number): boolean {
    return tunnels.has(port) && !!tunnels.get(port)?.url;
  },

  /**
   * Get all active tunnels with their URLs and labels.
   * Returns a record keyed by port number.
   */
  getAllTunnels(): Record<number, { url: string; label: string }> {
    const result: Record<number, { url: string; label: string }> = {};
    for (const [port, entry] of tunnels) {
      if (entry.url) {
        result[port] = { url: entry.url, label: entry.label };
      }
    }
    return result;
  },

  /**
   * Register a callback for URL changes of a specific tunnel.
   * Called with the new URL (or null if tunnel went down).
   */
  onChange(port: number, cb: (url: string | null) => void): void {
    let entry = tunnels.get(port);
    if (!entry) {
      // Create a placeholder entry so we don't lose the callback
      // when the tunnel hasn't started yet. It will be replaced on start().
      entry = { tunnel: null as any, provider: 'cloudflare', url: null, label: `Port ${port}`, onChangeCbs: new Set() };
      tunnels.set(port, entry);
    }
    entry.onChangeCbs.add(cb);
  },

  _notifyChange(port: number, url: string | null): void {
    const entry = tunnels.get(port);
    if (!entry) return;
    for (const cb of entry.onChangeCbs) {
      try { cb(url); } catch { /* ignore */ }
    }
  },
};

export default TunnelService;
