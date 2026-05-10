import * as http from 'http';
import { app, safeStorage } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../../utils/Logger';
import DatabaseService from '../DatabaseService';
import EventBroadcaster from '../EventBroadcaster';
import { IntegrationAdapter, IntegrationConfig } from './IntegrationAdapter';
import { KiotVietAdapter } from './adapters/KiotVietAdapter';
import { CassoAdapter } from './adapters/CassoAdapter';
import { SePayAdapter } from './adapters/SePayAdapter';
import { GHNAdapter } from './adapters/GHNAdapter';
import { GHTKAdapter } from './adapters/GHTKAdapter';
import { HaravanAdapter } from './adapters/HaravanAdapter';
import { SapoAdapter } from './adapters/SapoAdapter';
import { IPosAdapter } from './adapters/IPosAdapter';
import { NhanhAdapter } from './adapters/NhanhAdapter';
import { PancakeAdapter } from './adapters/PancakeAdapter';

/** Map of active adapter instances (integrationId → adapter) */
const adapterInstances = new Map<string, IntegrationAdapter>();

/** Webhook HTTP server */
let webhookServer: http.Server | null = null;
let webhookPort = 9888;

// ─── Factory ─────────────────────────────────────────────────────────────────

function createAdapter(config: IntegrationConfig): IntegrationAdapter {
  switch (config.type) {
    case 'kiotviet': return new KiotVietAdapter(config);
    case 'casso':    return new CassoAdapter(config);
    case 'sepay':    return new SePayAdapter(config);
    case 'ghn':      return new GHNAdapter(config);
    case 'ghtk':     return new GHTKAdapter(config);
    case 'haravan':  return new HaravanAdapter(config);
    case 'sapo':     return new SapoAdapter(config);
    case 'ipos':     return new IPosAdapter(config);
    case 'nhanh':    return new NhanhAdapter(config);
    case 'pancake':  return new PancakeAdapter(config);
    default:
      throw new Error(`Loại integration không hỗ trợ: ${config.type}`);
  }
}

// ─── Credential encryption/decryption ────────────────────────────────────────

function encryptCredentials(creds: Record<string, string>): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) return JSON.stringify(creds);
    const encrypted = safeStorage.encryptString(JSON.stringify(creds));
    return encrypted.toString('base64');
  } catch {
    return JSON.stringify(creds);
  }
}

function decryptCredentials(raw: string): Record<string, string> {
  try {
    // Try safeStorage first
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const buf = Buffer.from(raw, 'base64');
        return JSON.parse(safeStorage.decryptString(buf));
      } catch { /* fall through to JSON parse */ }
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Database helpers ─────────────────────────────────────────────────────────

function dbListAll(): IntegrationConfig[] {
  const rows = DatabaseService.getInstance().getIntegrations();
  return rows.map(rowToConfig);
}

function rowToConfig(row: any): IntegrationConfig {
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

function tryParse(s: string, fallback: any): any {
  try { return JSON.parse(s); } catch { return fallback; }
}

function isMaskedSecret(v: any): boolean {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed === '••••' || trimmed === 'â€¢â€¢â€¢â€¢';
}

// ─── Integration Registry ─────────────────────────────────────────────────────

export const IntegrationRegistry = {

  /** Initialize: load all enabled integrations & start webhook server */
  initialize(): void {
    this.loadAdapters();
    this.startWebhookServer();
    Logger.log(`[IntegrationRegistry] Initialized — ${adapterInstances.size} adapters loaded`);
  },

  loadAdapters(): void {
    adapterInstances.clear();
    const configs = dbListAll();
    for (const cfg of configs) {
      if (!cfg.enabled) continue;
      try {
        const adapter = createAdapter(cfg);
        adapterInstances.set(cfg.id, adapter);
      } catch (e: any) {
        Logger.warn(`[IntegrationRegistry] Cannot load adapter ${cfg.id} (${cfg.type}): ${e.message}`);
      }
    }
  },

  /** List all integration configs (credentials stripped) */
  listConfigs(): Omit<IntegrationConfig, 'credentials'>[] {
    return dbListAll().map(({ credentials: _creds, ...rest }) => rest);
  },

  /** Get single config (with credentials masked for security) */
  getConfig(id: string): IntegrationConfig | null {
    const rows = DatabaseService.getInstance().getIntegrations();
    const row = rows.find((r: any) => r.id === id);
    if (!row) return null;
    const cfg = rowToConfig(row);
    // Mask credential values: keep keys but replace values with '••••'
    const masked: Record<string, string> = {};
    for (const k of Object.keys(cfg.credentials)) {
      masked[k] = cfg.credentials[k] ? '••••' : '';
    }
    return { ...cfg, credentials: masked };
  },

  /** Get config with real decrypted credentials (only for service-side use) */
  getConfigWithCredentials(id: string): IntegrationConfig | null {
    const rows = DatabaseService.getInstance().getIntegrations();
    const row = rows.find((r: any) => r.id === id);
    if (!row) return null;
    return rowToConfig(row);
  },

  /** Save (create or update) an integration config */
  saveConfig(config: Partial<IntegrationConfig> & { credentials: Record<string, string> }): string {
    const now = Date.now();
    const id = config.id || uuidv4();
    const existing = config.id ? this.getConfigWithCredentials(config.id) : null;
    const mergedCredentials: Record<string, string> = { ...(existing?.credentials || {}) };

    // Merge credentials safely: blank/masked values keep old credential
    for (const [k, rawVal] of Object.entries(config.credentials || {})) {
      const val = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
      if (val === '' || val === undefined || val === null || isMaskedSecret(val)) continue;
      mergedCredentials[k] = String(rawVal);
    }

    const encryptedCreds = encryptCredentials(mergedCredentials);
    DatabaseService.getInstance().upsertIntegration({
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
    DatabaseService.getInstance().save();

    // Reload adapter
    const fullConfig = this.getConfigWithCredentials(id);
    if (fullConfig?.enabled) {
      try {
        const adapter = createAdapter(fullConfig);
        adapterInstances.set(id, adapter);
      } catch { adapterInstances.delete(id); }
    } else {
      adapterInstances.delete(id);
    }

    return id;
  },

  /** Delete integration */
  deleteConfig(id: string): void {
    DatabaseService.getInstance().deleteIntegration(id);
    DatabaseService.getInstance().save();
    adapterInstances.delete(id);
  },

  /** Toggle enabled state */
  toggleEnabled(id: string, enabled: boolean): void {
    DatabaseService.getInstance().toggleIntegration(id, enabled);
    DatabaseService.getInstance().save();
    const cfg = this.getConfigWithCredentials(id);
    if (!cfg) return;
    if (enabled) {
      try {
        const adapter = createAdapter(cfg);
        adapterInstances.set(id, adapter);
      } catch { adapterInstances.delete(id); }
    } else {
      adapterInstances.delete(id);
    }
  },

  /** Test connection for a given integration id */
  async testConnection(id: string): Promise<{ success: boolean; message: string }> {
    const cfg = this.getConfigWithCredentials(id);
    if (!cfg) return { success: false, message: 'Integration không tồn tại' };
    try {
      const adapter = createAdapter(cfg);
      const result = await adapter.testConnection();
      if (result.success) {
        // Update connected_at timestamp
        DatabaseService.getInstance().markIntegrationConnected(id, Date.now());
        DatabaseService.getInstance().save();
        // Reload adapter instance
        adapterInstances.set(id, adapter);
      }
      return result;
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  },

  /** Execute action on a specific integration */
  async executeAction(id: string, action: string, params: Record<string, any>): Promise<any> {
    const adapter = adapterInstances.get(id);
    if (!adapter) {
      // Try creating on the fly
      const cfg = this.getConfigWithCredentials(id);
      if (!cfg) throw new Error(`Integration ${id} không tồn tại`);
      const fresh = createAdapter(cfg);
      adapterInstances.set(id, fresh);
      return fresh.executeAction(action, params);
    }
    return adapter.executeAction(action, params);
  },

  /** Execute action by type (uses first enabled adapter of that type) */
  async executeActionByType(type: string, action: string, params: Record<string, any>): Promise<any> {
    for (const [id, adapter] of adapterInstances) {
      if (adapter.type === type && adapter.isEnabled()) {
        return adapter.executeAction(action, params);
      }
    }
    throw new Error(`Không có integration ${type} nào đang kết nối`);
  },

  getWebhookPort(): number {
    return webhookPort;
  },

  /** Start embedded HTTP server to receive webhooks */
  startWebhookServer(port?: number): void {
    if (webhookServer) return;
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
          const signature = req.headers['x-signature'] as string || req.headers['x-webhook-signature'] as string || '';
          const payload = body ? JSON.parse(body) : {};

          Logger.log(`[WebhookServer] POST ${url} — signature: ${signature ? 'yes' : 'no'}`);

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
              const transactions: any[] = payload?.data || (Array.isArray(payload) ? payload : [payload]);
              for (const tx of transactions) {
                EventBroadcaster.emit('integration:payment', {
                  integrationId: config.id,
                  integrationType: config.type,
                  transaction: tx,
                  raw: payload,
                });
              }
            }

            // Emit general webhook event
            EventBroadcaster.emit('integration:webhook', {
              integrationId: config.id,
              integrationType: config.type,
              url,
              payload,
              signature,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            Logger.warn(`[WebhookServer] Unknown route: ${route}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Route '${route}' not found` }));
          }
        } catch (e: any) {
          Logger.error(`[WebhookServer] Error: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });

    webhookServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        Logger.warn(`[WebhookServer] Port ${webhookPort} in use — trying ${webhookPort + 1}`);
        webhookPort += 1;
        webhookServer?.close();
        webhookServer = null;
        this.startWebhookServer(webhookPort);
      } else {
        Logger.error(`[WebhookServer] Error: ${err.message}`);
      }
    });

    webhookServer.listen(webhookPort, '127.0.0.1', () => {
      Logger.log(`[WebhookServer] Listening on http://127.0.0.1:${webhookPort}`);
    });
  },

  stopWebhookServer(): void {
    webhookServer?.close();
    webhookServer = null;
  },
};

export default IntegrationRegistry;


