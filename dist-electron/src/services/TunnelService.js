"use strict";
/**
 * TunnelService — wraps localtunnel to expose the webhook HTTP server to the internet.
 * This allows external services (Casso, SePay, ...) to send webhooks to the Electron app.
 *
 * Usage:
 *   const url = await TunnelService.start(9888);   // returns https://xxxx.loca.lt
 *   TunnelService.stop();
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TunnelService = void 0;
const Logger_1 = __importDefault(require("../utils/Logger"));
// Dynamic import to avoid issues if localtunnel is not installed
let localtunnel = null;
try {
    localtunnel = require('localtunnel');
}
catch {
    Logger_1.default.warn('[TunnelService] localtunnel package not found');
}
let activeTunnel = null;
let activeUrl = null;
let onChangeCallbacks = [];
exports.TunnelService = {
    /** Start a tunnel pointing to the local webhook port. Returns the public URL. */
    async start(port) {
        if (activeTunnel) {
            await this.stop();
        }
        if (!localtunnel) {
            throw new Error('Chưa cài gói localtunnel. Chạy: npm install localtunnel');
        }
        Logger_1.default.log(`[TunnelService] Starting tunnel on port ${port}...`);
        const tunnel = await localtunnel({ port });
        activeTunnel = tunnel;
        activeUrl = tunnel.url;
        Logger_1.default.log(`[TunnelService] Tunnel active: ${activeUrl}`);
        this._notifyChange(activeUrl);
        tunnel.on('close', () => {
            Logger_1.default.log('[TunnelService] Tunnel closed');
            activeTunnel = null;
            activeUrl = null;
            this._notifyChange(null);
        });
        tunnel.on('error', (err) => {
            Logger_1.default.error(`[TunnelService] Tunnel error: ${err.message}`);
            activeTunnel = null;
            activeUrl = null;
            this._notifyChange(null);
        });
        return activeUrl;
    },
    /** Stop the active tunnel */
    async stop() {
        if (activeTunnel) {
            try {
                activeTunnel.close();
            }
            catch { /* ignore */ }
            activeTunnel = null;
            activeUrl = null;
            this._notifyChange(null);
            Logger_1.default.log('[TunnelService] Tunnel stopped');
        }
    },
    /** Get current tunnel URL (null if not active) */
    getUrl() {
        return activeUrl;
    },
    /** Check if tunnel is currently active */
    isActive() {
        return !!activeUrl;
    },
    /** Register a callback for tunnel URL changes */
    onChange(cb) {
        onChangeCallbacks.push(cb);
    },
    _notifyChange(url) {
        for (const cb of onChangeCallbacks) {
            try {
                cb(url);
            }
            catch { /* ignore */ }
        }
    },
};
exports.default = exports.TunnelService;
//# sourceMappingURL=TunnelService.js.map