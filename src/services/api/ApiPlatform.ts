/**
 * ApiPlatform — điểm nối Public API v1 vào app.
 *
 *  - Router khởi tạo LAZY ở request /api/v1 đầu tiên (người không dùng API không tốn gì).
 *  - HttpRelayService gọi `handles(url)` / `handle(req, res)` cho /api/v1 và /docs, và
 *    `attachSocket(io)` khi server chạy (namespace Socket.IO /v1).
 *  - main.ts gọi `configure({ handlers })` với registry IPC chung và `startEvents()`.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { ApiRouter, systemPrincipal } from './ApiRouter';
import { IpcInvoker, HandlerSource, unwrapIpcResult } from './IpcInvoker';
import { AccountDirectory } from './AccountDirectory';
import { RequestLog } from './RequestLog';
import { BruteForceGuard, RateLimiter } from './RateLimiter';
import { UploadStore } from './UploadStore';
import { authenticateToken } from './ApiAuth';
import ApiKeyService from './ApiKeyService';
import { buildRoutes } from './routes';
import { eventRoutes } from './routes/events';
import { buildOpenApi } from './openapi/build';
import { renderDocsPage } from './openapi/docsPage';
import { appVersion, isWorkspaceAvailable } from './runtime';
import { getApiSettingBool } from './settings';
import { EventHub } from './events/EventHub';
import { WebhookOutboundService } from './events/WebhookOutboundService';
import { SocketGateway } from './events/SocketGateway';
import type { Principal, RouteDef } from './types';

type ExtraProvider = () => RouteDef[];
type OnBeforeSend = (channel: string, cb: (data: any) => void) => () => void;
type PrincipalResolver = (ownerKey: string) => Principal | null | undefined;

function logger(): any {
    try { return require('../../utils/Logger').default; } catch { return console; }
}

class ApiPlatform {
    private static instance: ApiPlatform | null = null;

    readonly uploads = new UploadStore();
    readonly log = new RequestLog();
    readonly rateLimiter = new RateLimiter();
    readonly guard = new BruteForceGuard();

    private handlers: HandlerSource | null = null;
    private router: ApiRouter | null = null;
    private invoker: IpcInvoker | null = null;
    private accounts: AccountDirectory | null = null;
    private openApiCache: any = null;
    private extraProviders: ExtraProvider[] = [];
    private serverUrls: () => string[] = () => [];
    private hub: EventHub | null = null;
    private webhooks: WebhookOutboundService | null = null;
    private socketGateway: SocketGateway | null = null;
    private onBeforeSend: OnBeforeSend | null = null;
    private principalResolvers: PrincipalResolver[] = [];

    static getInstance(): ApiPlatform {
        if (!ApiPlatform.instance) ApiPlatform.instance = new ApiPlatform();
        return ApiPlatform.instance;
    }

    /** Test: tạo instance mới. */
    static resetForTests(): void {
        ApiPlatform.instance?.webhooks?.stop();
        ApiPlatform.instance = null;
    }

    configure(opts: { handlers?: Map<string, any> | HandlerSource; serverUrls?: () => string[]; onBeforeSend?: OnBeforeSend }): void {
        if (opts.handlers) {
            const h = opts.handlers as any;
            this.handlers = typeof h.get === 'function' ? { get: (ch: string) => h.get(ch) } : h;
        }
        if (opts.serverUrls) this.serverUrls = opts.serverUrls;
        if (opts.onBeforeSend) this.onBeforeSend = opts.onBeforeSend;
    }

    /** Route bổ sung (plugin) — đăng ký trước khi router khởi tạo hoặc nạp nóng. */
    addRouteProvider(provider: ExtraProvider): void {
        this.extraProviders.push(provider);
        if (this.router) {
            this.router.register(provider());
            this.openApiCache = null;
        }
    }

    /** Owner "plugin:<id>" / "employee:<id>" → principal (cho webhook của plugin/nhân viên). */
    addPrincipalResolver(resolver: PrincipalResolver): void {
        this.principalResolvers.push(resolver);
    }

    private handlerSource(): HandlerSource {
        if (this.handlers) return this.handlers;
        try {
            const reg = require('../../../electron/ipc/handlerRegistry').ipcHandlerRegistry as Map<string, any>;
            this.handlers = { get: (ch: string) => reg.get(ch) };
        } catch {
            this.handlers = { get: () => undefined };
        }
        return this.handlers;
    }

    getInvoker(): IpcInvoker {
        if (!this.invoker) this.invoker = new IpcInvoker(this.handlerSource());
        return this.invoker;
    }

    getAccounts(): AccountDirectory {
        if (!this.accounts) {
            const invoker = this.getInvoker();
            this.accounts = new AccountDirectory(() => invoker.invoke('login:getAccounts', [], systemPrincipal(), { requestId: 'accounts' }));
        }
        return this.accounts;
    }

    // ─── Sự kiện ─────────────────────────────────────────────────────────

    private systemCall(channel: string, payload: any): Promise<any> {
        return this.getInvoker()
            .invoke(channel, [payload], systemPrincipal(), { requestId: 'events' })
            .then(res => unwrapIpcResult(res));
    }

    principalForOwner(ownerKey: string): Principal | null {
        if (!ownerKey) return null;
        for (const r of this.principalResolvers) {
            const p = r(ownerKey);
            if (p !== undefined) return p;
        }
        if (ownerKey.includes(':')) return null;
        try {
            const keys = ApiKeyService.getInstance();
            const rec = keys.get(ownerKey);
            if (!rec || rec.revoked_at || (rec.expires_at && rec.expires_at <= Date.now())) return null;
            return keys.toPrincipal(rec);
        } catch {
            return null;
        }
    }

    getHub(): EventHub {
        if (this.hub) return this.hub;
        const accounts = this.getAccounts();
        this.hub = new EventHub({
            helpers: {
                loadMessage: async (accountId, msgId, threadId) => (await this.systemCall('db:getMessageById', { zaloId: accountId, msgId, threadId }))?.message || null,
                loadContact: async (accountId, threadId) => (await this.systemCall('db:getContactById', { zaloId: accountId, contactId: threadId }))?.contact || null,
                accountChannel: async accountId => (await accounts.get(accountId).catch(() => null))?.channel || 'zalo',
                now: () => Date.now(),
            },
            onBeforeSend: (channel, cb) => {
                if (this.onBeforeSend) return this.onBeforeSend(channel, cb);
                try {
                    const EventBroadcaster = require('../event/EventBroadcaster').default;
                    return EventBroadcaster.onBeforeSend(channel, cb);
                } catch {
                    return () => { /* không có EventBroadcaster (test) */ };
                }
            },
            logError: msg => logger().warn?.(msg),
        });
        return this.hub;
    }

    getWebhooks(): WebhookOutboundService {
        if (!this.webhooks) {
            this.webhooks = new WebhookOutboundService(this.getHub(), {
                principalForKey: ownerKey => this.principalForOwner(ownerKey),
                logError: msg => logger().warn?.(msg),
            });
        }
        return this.webhooks;
    }

    /** Gọi một lần lúc khởi động (sau khi đăng ký IPC). Rẻ: chỉ đăng ký hook + timer nhẹ. */
    startEvents(): void {
        try {
            this.getHub().hook();
            this.getWebhooks().start();
        } catch (err: any) {
            logger().error?.(`[ApiPlatform] startEvents: ${err?.message || err}`);
        }
    }

    /** Sau khi đổi workspace: EventBroadcaster.clearBeforeSendHooks() đã xoá hook → đăng ký lại. */
    rehookEvents(): void {
        try {
            this.hub?.hook();
            this.hub?.invalidateConsumers();
            this.accounts?.invalidate();
        } catch (err: any) {
            logger().error?.(`[ApiPlatform] rehookEvents: ${err?.message || err}`);
        }
    }

    attachSocket(io: any): void {
        try {
            if (!this.socketGateway) {
                this.socketGateway = new SocketGateway({
                    hub: this.getHub(),
                    authenticate: authenticateToken,
                    logError: msg => logger().warn?.(msg),
                });
            }
            this.socketGateway.attach(io);
        } catch (err: any) {
            logger().error?.(`[ApiPlatform] attachSocket: ${err?.message || err}`);
        }
    }

    detachSocket(): void {
        this.socketGateway?.detach();
    }

    // ─── Router ──────────────────────────────────────────────────────────

    getRouter(): ApiRouter {
        if (this.router) return this.router;
        const router = new ApiRouter({
            invoker: this.getInvoker(),
            accounts: this.getAccounts(),
            log: this.log,
            rateLimiter: this.rateLimiter,
            guard: this.guard,
            authenticate: authenticateToken,
            isWorkspaceAvailable,
            docsHtml: () => renderDocsPage(),
            openApi: () => this.openApi(),
            onError: (err, routeLabel) => {
                logger().error?.(`[ApiPlatform] ${routeLabel}: ${err?.stack || err?.message || err}`);
            },
        });
        const hub = this.getHub();
        const webhooks = this.getWebhooks();
        router.register(buildRoutes({
            uploads: this.uploads,
            extra: [() => eventRoutes({ hub, webhooks }), ...this.extraProviders],
        }));
        this.router = router;
        this.uploads.cleanup(true);
        return router;
    }

    openApi(): any {
        if (!this.openApiCache) {
            this.openApiCache = buildOpenApi(this.getRouter().list(), {
                version: appVersion(),
                servers: this.serverUrls(),
            });
        }
        return this.openApiCache;
    }

    invalidateOpenApi(): void {
        this.openApiCache = null;
    }

    /** Kiểm tra rẻ (không khởi tạo router). */
    handles(url: string): boolean {
        const pathname = String(url || '').split('?')[0];
        return pathname === '/api/v1' || pathname.startsWith('/api/v1/') || pathname === '/docs' || pathname.startsWith('/docs/');
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        await this.getRouter().handle(req, res);
    }

    /** Gọi một thao tác API trong process (plugin, test). */
    invoke(target: string, input: Parameters<ApiRouter['invoke']>[1]) {
        return this.getRouter().invoke(target, input);
    }

    status(): any {
        const enabled = getApiSettingBool('api_enabled');
        return {
            enabled,
            initialized: !!this.router,
            routes: this.router ? this.router.list().length : 0,
            ipc: this.invoker ? this.invoker.stats() : { active: 0, queued: 0, limit: 0 },
            metrics: this.log.metrics(),
            blocked_ips: this.guard.blockedIps(),
            events: {
                capturing: this.hub ? this.hub.isCapturing() : false,
                listeners: this.hub ? this.hub.listenerCount() : 0,
                sockets: this.socketGateway ? this.socketGateway.connectedCount() : 0,
            },
        };
    }

    /** Khi tài khoản đổi (thêm/xoá/kết nối) → làm mới danh bạ ngay. */
    invalidateAccounts(): void {
        this.accounts?.invalidate();
    }

    flush(): void {
        this.log.flush();
    }
}

export default ApiPlatform;
