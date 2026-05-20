"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationRegistry = void 0;
const http = __importStar(require("http"));
const electron_1 = require("electron");
const uuid_1 = require("uuid");
const Logger_1 = __importDefault(require("../../utils/Logger"));
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const EventBroadcaster_1 = __importDefault(require("../EventBroadcaster"));
const KiotVietAdapter_1 = require("./adapters/KiotVietAdapter");
const CassoAdapter_1 = require("./adapters/CassoAdapter");
const SePayAdapter_1 = require("./adapters/SePayAdapter");
const GHNAdapter_1 = require("./adapters/GHNAdapter");
const GHTKAdapter_1 = require("./adapters/GHTKAdapter");
const HaravanAdapter_1 = require("./adapters/HaravanAdapter");
const SapoAdapter_1 = require("./adapters/SapoAdapter");
const IPosAdapter_1 = require("./adapters/IPosAdapter");
const NhanhAdapter_1 = require("./adapters/NhanhAdapter");
const PancakeAdapter_1 = require("./adapters/PancakeAdapter");
/** Map of active adapter instances (integrationId → adapter) */
const adapterInstances = new Map();
/** Webhook HTTP server */
let webhookServer = null;
let webhookPort = 9888;
// ─── Factory ─────────────────────────────────────────────────────────────────
function createAdapter(config) {
    switch (config.type) {
        case 'kiotviet': return new KiotVietAdapter_1.KiotVietAdapter(config);
        case 'casso': return new CassoAdapter_1.CassoAdapter(config);
        case 'sepay': return new SePayAdapter_1.SePayAdapter(config);
        case 'ghn': return new GHNAdapter_1.GHNAdapter(config);
        case 'ghtk': return new GHTKAdapter_1.GHTKAdapter(config);
        case 'haravan': return new HaravanAdapter_1.HaravanAdapter(config);
        case 'sapo': return new SapoAdapter_1.SapoAdapter(config);
        case 'ipos': return new IPosAdapter_1.IPosAdapter(config);
        case 'nhanh': return new NhanhAdapter_1.NhanhAdapter(config);
        case 'pancake': return new PancakeAdapter_1.PancakeAdapter(config);
        default:
            throw new Error(`Loại integration không hỗ trợ: ${config.type}`);
    }
}
// ─── Credential encryption/decryption ────────────────────────────────────────
function encryptCredentials(creds) {
    try {
        if (!electron_1.safeStorage.isEncryptionAvailable())
            return JSON.stringify(creds);
        const encrypted = electron_1.safeStorage.encryptString(JSON.stringify(creds));
        return encrypted.toString('base64');
    }
    catch {
        return JSON.stringify(creds);
    }
}
function decryptCredentials(raw) {
    try {
        // Try safeStorage first
        if (electron_1.safeStorage.isEncryptionAvailable()) {
            try {
                const buf = Buffer.from(raw, 'base64');
                return JSON.parse(electron_1.safeStorage.decryptString(buf));
            }
            catch { /* fall through to JSON parse */ }
        }
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
// ─── Database helpers ─────────────────────────────────────────────────────────
function dbListAll() {
    const rows = DatabaseService_1.default.getInstance().getIntegrations();
    return rows.map(rowToConfig);
}
function rowToConfig(row) {
    return {
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: row.enabled === 1,
        credentials: decryptCredentials(row.credentials_encrypted || '{}'),
        settings: tryParse(row.settings, {}),
        connectedAt: row.connected_at || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function tryParse(s, fallback) {
    try {
        return JSON.parse(s);
    }
    catch {
        return fallback;
    }
}
function isMaskedSecret(v) {
    if (typeof v !== 'string')
        return false;
    const trimmed = v.trim();
    return trimmed === '••••' || trimmed === 'â€¢â€¢â€¢â€¢';
}
// ─── Integration Registry ─────────────────────────────────────────────────────
exports.IntegrationRegistry = {
    /** Initialize: load all enabled integrations & start webhook server */
    initialize() {
        this.loadAdapters();
        this.startWebhookServer();
        Logger_1.default.log(`[IntegrationRegistry] Initialized — ${adapterInstances.size} adapters loaded`);
    },
    loadAdapters() {
        adapterInstances.clear();
        const configs = dbListAll();
        for (const cfg of configs) {
            if (!cfg.enabled)
                continue;
            try {
                const adapter = createAdapter(cfg);
                adapterInstances.set(cfg.id, adapter);
            }
            catch (e) {
                Logger_1.default.warn(`[IntegrationRegistry] Cannot load adapter ${cfg.id} (${cfg.type}): ${e.message}`);
            }
        }
    },
    /** List all integration configs (credentials stripped) */
    listConfigs() {
        return dbListAll().map(({ credentials: _creds, ...rest }) => rest);
    },
    /** Get single config (with credentials masked for security) */
    getConfig(id) {
        const rows = DatabaseService_1.default.getInstance().getIntegrations();
        const row = rows.find((r) => r.id === id);
        if (!row)
            return null;
        const cfg = rowToConfig(row);
        // Mask credential values: keep keys but replace values with '••••'
        const masked = {};
        for (const k of Object.keys(cfg.credentials)) {
            masked[k] = cfg.credentials[k] ? '••••' : '';
        }
        return { ...cfg, credentials: masked };
    },
    /** Get config with real decrypted credentials (only for service-side use) */
    getConfigWithCredentials(id) {
        const rows = DatabaseService_1.default.getInstance().getIntegrations();
        const row = rows.find((r) => r.id === id);
        if (!row)
            return null;
        return rowToConfig(row);
    },
    /** Save (create or update) an integration config */
    saveConfig(config) {
        const now = Date.now();
        const id = config.id || (0, uuid_1.v4)();
        const existing = config.id ? this.getConfigWithCredentials(config.id) : null;
        const mergedCredentials = { ...(existing?.credentials || {}) };
        // Merge credentials safely: blank/masked values keep old credential
        for (const [k, rawVal] of Object.entries(config.credentials || {})) {
            const val = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
            if (val === '' || val === undefined || val === null || isMaskedSecret(val))
                continue;
            mergedCredentials[k] = String(rawVal);
        }
        const encryptedCreds = encryptCredentials(mergedCredentials);
        DatabaseService_1.default.getInstance().upsertIntegration({
            id,
            type: config.type || existing?.type || '',
            name: config.name || existing?.name || '',
            enabled: config.enabled !== false ? 1 : 0,
            credentials_encrypted: encryptedCreds,
            settings: JSON.stringify(config.settings || existing?.settings || {}),
            connected_at: config.connectedAt || existing?.connectedAt || null,
            created_at: config.createdAt || existing?.createdAt || now,
            updated_at: now,
        });
        DatabaseService_1.default.getInstance().save();
        // Reload adapter
        const fullConfig = this.getConfigWithCredentials(id);
        if (fullConfig?.enabled) {
            try {
                const adapter = createAdapter(fullConfig);
                adapterInstances.set(id, adapter);
            }
            catch {
                adapterInstances.delete(id);
            }
        }
        else {
            adapterInstances.delete(id);
        }
        return id;
    },
    /** Delete integration */
    deleteConfig(id) {
        DatabaseService_1.default.getInstance().deleteIntegration(id);
        DatabaseService_1.default.getInstance().save();
        adapterInstances.delete(id);
    },
    /** Toggle enabled state */
    toggleEnabled(id, enabled) {
        DatabaseService_1.default.getInstance().toggleIntegration(id, enabled);
        DatabaseService_1.default.getInstance().save();
        const cfg = this.getConfigWithCredentials(id);
        if (!cfg)
            return;
        if (enabled) {
            try {
                const adapter = createAdapter(cfg);
                adapterInstances.set(id, adapter);
            }
            catch {
                adapterInstances.delete(id);
            }
        }
        else {
            adapterInstances.delete(id);
        }
    },
    /** Test connection for a given integration id */
    async testConnection(id) {
        const cfg = this.getConfigWithCredentials(id);
        if (!cfg)
            return { success: false, message: 'Integration không tồn tại' };
        try {
            const adapter = createAdapter(cfg);
            const result = await adapter.testConnection();
            if (result.success) {
                // Update connected_at timestamp
                DatabaseService_1.default.getInstance().markIntegrationConnected(id, Date.now());
                DatabaseService_1.default.getInstance().save();
                // Reload adapter instance
                adapterInstances.set(id, adapter);
            }
            return result;
        }
        catch (e) {
            return { success: false, message: e.message };
        }
    },
    /** Execute action on a specific integration */
    async executeAction(id, action, params) {
        const adapter = adapterInstances.get(id);
        if (!adapter) {
            // Try creating on the fly
            const cfg = this.getConfigWithCredentials(id);
            if (!cfg)
                throw new Error(`Integration ${id} không tồn tại`);
            const fresh = createAdapter(cfg);
            adapterInstances.set(id, fresh);
            return fresh.executeAction(action, params);
        }
        return adapter.executeAction(action, params);
    },
    /** Execute action by type (uses first enabled adapter of that type) */
    async executeActionByType(type, action, params) {
        for (const [id, adapter] of adapterInstances) {
            if (adapter.type === type && adapter.isEnabled()) {
                return adapter.executeAction(action, params);
            }
        }
        throw new Error(`Không có integration ${type} nào đang kết nối`);
    },
    getWebhookPort() {
        return webhookPort;
    },
    /** Start embedded HTTP server to receive webhooks */
    startWebhookServer(port) {
        if (webhookServer)
            return;
        webhookPort = port || 9888;
        webhookServer = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
                return;
            }
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const url = req.url || '/';
                    const signature = req.headers['x-signature'] || req.headers['x-webhook-signature'] || '';
                    const payload = body ? JSON.parse(body) : {};
                    Logger_1.default.log(`[WebhookServer] POST ${url} — signature: ${signature ? 'yes' : 'no'}`);
                    // Route by path: /webhook/{integrationId} or /webhook/{type}
                    const parts = url.split('/').filter(Boolean);
                    // parts[0] = 'webhook', parts[1] = integrationId or type
                    const route = parts[1] || '';
                    // Find matching integration
                    const allConfigs = dbListAll();
                    const matchById = allConfigs.find(c => c.id === route);
                    const matchByType = allConfigs.find(c => c.type === route && c.enabled);
                    const config = matchById || matchByType;
                    if (config) {
                        // Emit payment event for workflow triggers
                        if (config.type === 'casso' || config.type === 'sepay') {
                            const transactions = payload?.data || (Array.isArray(payload) ? payload : [payload]);
                            for (const tx of transactions) {
                                EventBroadcaster_1.default.emit('integration:payment', {
                                    integrationId: config.id,
                                    integrationType: config.type,
                                    transaction: tx,
                                    raw: payload,
                                });
                            }
                        }
                        // Emit general webhook event
                        EventBroadcaster_1.default.emit('integration:webhook', {
                            integrationId: config.id,
                            integrationType: config.type,
                            url,
                            payload,
                            signature,
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    }
                    else {
                        Logger_1.default.warn(`[WebhookServer] Unknown route: ${route}`);
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Route '${route}' not found` }));
                    }
                }
                catch (e) {
                    Logger_1.default.error(`[WebhookServer] Error: ${e.message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
        });
        webhookServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                Logger_1.default.warn(`[WebhookServer] Port ${webhookPort} in use — trying ${webhookPort + 1}`);
                webhookPort += 1;
                webhookServer?.close();
                webhookServer = null;
                this.startWebhookServer(webhookPort);
            }
            else {
                Logger_1.default.error(`[WebhookServer] Error: ${err.message}`);
            }
        });
        webhookServer.listen(webhookPort, '127.0.0.1', () => {
            Logger_1.default.log(`[WebhookServer] Listening on http://127.0.0.1:${webhookPort}`);
        });
    },
    stopWebhookServer() {
        webhookServer?.close();
        webhookServer = null;
    },
};
exports.default = exports.IntegrationRegistry;
//# sourceMappingURL=IntegrationRegistry.js.map