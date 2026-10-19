/**
 * WebhookGatewayService - dedicated HTTP server for external webhooks.
 * Listens on port 9889 and routes incoming requests to registered handlers.
 *
 * Currently handles:
 *  - Workflow webhooks:  POST /api/workflow/webhook/{token}
 *
 * Design: kept separate from IntegrationRegistry's webhook server (port 9888)
 * to avoid regression. Can be merged into a unified gateway later.
 *
 * Usage:
 *   WebhookGatewayService.getInstance().start();
 *   WebhookGatewayService.getInstance().startTunnel();
 *   // → https://xxxx.trycloudflare.com/api/workflow/webhook/{token}
 */

import * as http from 'http';
import Logger from '../../utils/Logger';
import TunnelService from '../tunnel/TunnelService';

/**
 * Cloudflare tự động (cloud-settings tunnel.mode = 'cloudflare_auto'): địa chỉ webhook workflow là dịch vụ 'workflow'
 * của tunnel cố định dùng chung; server cổng 9889 vẫn chạy như cũ. Nạp lười — chế độ khác / lỗi nạp → null = như cũ.
 */
type CloudTunnelApi = typeof import('../cloudflare/tunnel');

function cloudTunnelIfAuto(): CloudTunnelApi | null {
  try {
    const mod: CloudTunnelApi = require('../cloudflare/tunnel');
    return mod.isCloudTunnelAuto() ? mod : null;
  } catch {
    return null;
  }
}

// Lazy import to avoid circular dependency at module load time
let WorkflowEngineService: any = null;
function getWorkflowEngine(): any {
  if (!WorkflowEngineService) {
    WorkflowEngineService = require('../workflow/WorkflowEngineService').default;
  }
  return WorkflowEngineService.getInstance();
}

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, parsed: {
  pathname: string;
  body: any;
  rawBody: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  method: string;
  remoteIp: string;
}) => void;

class WebhookGatewayService {
  private static instance: WebhookGatewayService;
  private server: http.Server | null = null;
  private port = 9889;
  private running = false;
  private tunnelActive = false;
  private tunnelUrl: string | null = null;

  /** Registered exact-path route handlers */
  private routes = new Map<string, RouteHandler>();

  /** Prefix-based route handlers - first match wins */
  private prefixRoutes: Array<{ prefix: string; handler: RouteHandler }> = [];

  public static getInstance(): WebhookGatewayService {
    if (!WebhookGatewayService.instance) {
      WebhookGatewayService.instance = new WebhookGatewayService();
    }
    return WebhookGatewayService.instance;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  public async start(port?: number): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.running) {
      return { success: true, port: this.port };
    }

    this.port = port || this.port;

    try {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // Register built-in routes
      this.registerPrefixRoute('/api/workflow/webhook/', (req, res, parsed) => {
        this.handleWorkflowWebhook(req, res, parsed);
      });

      return new Promise((resolve) => {
        this.server!.listen(this.port, '127.0.0.1', () => {
          this.running = true;
          Logger.log(`[WebhookGateway] ✅ Server listening on http://127.0.0.1:${this.port}`);
          resolve({ success: true, port: this.port });
        });
        this.server!.on('error', (err: any) => {
          Logger.error(`[WebhookGateway] ❌ Server error: ${err.message}`);
          resolve({ success: false, error: err.message });
        });
      });
    } catch (err: any) {
      Logger.error(`[WebhookGateway] Start error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  public stop(): void {
    try {
      if (this.server) {
        this.server.close();
        this.server = null;
      }
      if (this.tunnelActive) {
        TunnelService.stop(this.port).catch(() => {});
        this.tunnelActive = false;
        this.tunnelUrl = null;
      }
      this.running = false;
      this.routes.clear();
      this.prefixRoutes = [];
      Logger.log('[WebhookGateway] Server stopped');
    } catch (err: any) {
      Logger.error(`[WebhookGateway] Stop error: ${err.message}`);
    }
  }

  // ─── Tunnel ──────────────────────────────────────────────────────

  public async startTunnel(): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
    if (!this.running) {
      return { success: false, error: 'Gateway server chưa được bật' };
    }
    const cloud = cloudTunnelIfAuto();
    if (cloud) return this.startCloudTunnel(cloud);
    try {
      const url = await TunnelService.start(this.port, 'Webhook Gateway');
      this.tunnelActive = true;
      this.tunnelUrl = url;
      Logger.log(`[WebhookGateway] 🌐 Tunnel active: ${url}`);

      TunnelService.onChange(this.port, (newUrl) => {
        this.tunnelUrl = newUrl;
        this.tunnelActive = !!newUrl;
      });

      return { success: true, tunnelUrl: url };
    } catch (err: any) {
      Logger.error(`[WebhookGateway] Tunnel start error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Cloudflare tự động: bật dịch vụ 'workflow' (đổi ingress của tunnel dùng chung, không chạy lại cloudflared). */
  private async startCloudTunnel(cloud: CloudTunnelApi): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
    try {
      await cloud.cloudTunnel.setServiceEnabled('workflow', true);
      const address = cloud.cloudTunnel.addressOf('workflow');
      const url = address.state === 'active' ? address.url : null;
      if (!url) return { success: false, error: address.error || 'Địa chỉ Cloudflare chưa kết nối xong — đang tự thử lại' };
      // Đã có địa chỉ cố định → tunnel cũ của cổng này (Quick Tunnel…) không còn dùng
      if (this.tunnelActive || TunnelService.getState(this.port)) {
        void TunnelService.stop(this.port).catch(() => {});
        this.tunnelActive = false;
        this.tunnelUrl = null;
      }
      Logger.log(`[WebhookGateway] 🌐 Cloudflare tự động: ${url}`);
      return { success: true, tunnelUrl: url };
    } catch (err: any) {
      Logger.error(`[WebhookGateway] Cloudflare tunnel error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  public async stopTunnel(): Promise<{ success: boolean; error?: string }> {
    const cloud = cloudTunnelIfAuto();
    if (cloud) {
      try {
        await cloud.cloudTunnel.setServiceEnabled('workflow', false);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
    await TunnelService.stop(this.port);
    this.tunnelActive = false;
    this.tunnelUrl = null;
    return { success: true };
  }

  public getStatus(): { running: boolean; port: number; tunnelActive: boolean; tunnelUrl: string | null } {
    const cloud = cloudTunnelIfAuto();
    if (cloud) {
      // Địa chỉ gốc của dịch vụ 'workflow' (nơi dùng tự nối /api/workflow/webhook/<token>)
      const address = cloud.cloudTunnel.addressOf('workflow');
      const url = address.state === 'active' ? address.url : null;
      return { running: this.running, port: this.port, tunnelActive: !!url, tunnelUrl: url };
    }
    return {
      running: this.running,
      port: this.port,
      tunnelActive: this.tunnelActive,
      tunnelUrl: this.tunnelUrl,
    };
  }

  // ─── Route Registration ──────────────────────────────────────────

  /** Register an exact-path route handler */
  public registerRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
    Logger.log(`[WebhookGateway] Registered route: ${path}`);
  }

  /** Unregister an exact-path route */
  public unregisterRoute(path: string): void {
    this.routes.delete(path);
    Logger.log(`[WebhookGateway] Unregistered route: ${path}`);
  }

  /** Register a prefix-based route handler (e.g. /api/workflow/webhook/) */
  public registerPrefixRoute(prefix: string, handler: RouteHandler): void {
    this.prefixRoutes.push({ prefix, handler });
    Logger.log(`[WebhookGateway] Registered prefix route: ${prefix}`);
  }

  // ─── HTTP Router ─────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Signature');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const queryStr = url.includes('?') ? url.split('?')[1] : '';
    const query: Record<string, string> = {};
    if (queryStr) {
      for (const part of queryStr.split('&')) {
        const [k, v] = part.split('=').map(decodeURIComponent);
        if (k) query[k] = v || '';
      }
    }

    // Collect headers as plain object
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v || '');
    }

    const remoteIp = req.socket?.remoteAddress || '';

    // Parse body
    let bodyRaw = '';
    req.on('data', (chunk: Buffer) => { bodyRaw += chunk.toString(); });
    req.on('end', () => {
      let body: any = {};
      try {
        body = bodyRaw ? JSON.parse(bodyRaw) : {};
      } catch {
        body = { raw: bodyRaw };
      }

      const parsed = {
        pathname,
        body,
        rawBody: bodyRaw,
        query,
        headers,
        method: req.method || 'GET',
        remoteIp,
      };

      // 1. Try exact match
      const exactHandler = this.routes.get(pathname);
      if (exactHandler) {
        exactHandler(req, res, parsed);
        return;
      }

      // 2. Try prefix match
      for (const { prefix, handler } of this.prefixRoutes) {
        if (pathname.startsWith(prefix)) {
          handler(req, res, parsed);
          return;
        }
      }

      // 3. Health check
      if (pathname === '/api/health' || pathname === '/') {
        this.json(res, 200, { status: 'ok', service: 'webhook-gateway', port: this.port });
        return;
      }

      // 4. Not found
      Logger.warn(`[WebhookGateway] Route not found: ${req.method} ${pathname}`);
      this.json(res, 404, { success: false, error: 'Route not found' });
    });
  }

  // ─── Workflow Webhook Handler ────────────────────────────────────

  private handleWorkflowWebhook(req: http.IncomingMessage, res: http.ServerResponse, parsed: {
    pathname: string;
    body: any;
    rawBody: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    method: string;
    remoteIp: string;
  }): void {
    // Extract token from path: /api/workflow/webhook/{token}
    const parts = parsed.pathname.split('/').filter(Boolean);
    // parts = ['api', 'workflow', 'webhook', '{token}']
    const token = parts[3] || '';

    if (!token) {
      this.json(res, 400, { success: false, error: 'Missing webhook token' });
      return;
    }

    // Delegate to WorkflowEngine
    const engine = getWorkflowEngine();
    engine.handleWebhook(token, {
      method: parsed.method,
      body: parsed.body,
      headers: parsed.headers,
      query: parsed.query,
      rawBody: parsed.rawBody,
      remoteIp: parsed.remoteIp,
    }).then((result: { status: number; body: any }) => {
      this.json(res, result.status, result.body);
    }).catch((err: any) => {
      Logger.error(`[WebhookGateway] Workflow webhook error: ${err.message}`);
      this.json(res, 500, { success: false, error: 'Internal error' });
    });
  }

  // ─── Utility ─────────────────────────────────────────────────────

  private json(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  public getWebhookUrl(): string | null {
    const tunnelUrl = this.getStatus().tunnelUrl;
    return tunnelUrl ? `${tunnelUrl}/api/workflow/webhook` : null;
  }
}

export default WebhookGatewayService;
