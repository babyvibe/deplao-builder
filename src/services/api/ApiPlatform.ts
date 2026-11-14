/**
 * ApiPlatform: the connection point between the Public API v1 and the app.
 *
 *  - The router is created LAZILY on the first /api/v1 request (people who do not use the API pay nothing).
 *  - HttpRelayService calls `handles(url)` / `handle(req, res)` for /api/v1 and /docs, and
 *    `attachSocket(io)` when the server runs (Socket.IO namespace /v1).
 *  - main.ts calls `configure({ handlers })` with the shared IPC registry and `startEvents()`.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { ApiRouter, systemPrincipal } from './ApiRouter';
import { IpcInvoker, HandlerSource, unwrapIpcResult } from './IpcInvoker';
import { AccountDirectory } from './AccountDirectory';
import { RequestLog } from './http/RequestLog';
import { BruteForceGuard, RateLimiter } from './http/RateLimiter';
import { UploadStore } from './UploadStore';
import { authenticateToken } from './auth/ApiAuth';
import ApiKeyService from './auth/ApiKeyService';
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

    /** Test: create a new instance. */
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

    /** Extra routes (plugins): register before the router is created or hot-loaded. */
    addRouteProvider(provider: ExtraProvider): void {
        this.extraProviders.push(provider);
        if (this.router) {
            this.router.register(provider());
            this.openApiCache = null;
        }
    }

    /** Owner "plugin:<id>" / "employee:<id>" → principal (for the webhooks of plugins / employees). */
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

    // ─── Events ─────────────────────────────────────────────────────────

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
                    return () => { /* no EventBroadcaster (test) */ };
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

    /** Called once at startup (after the IPC registration). Cheap: only registers hooks + light timers. */
    startEvents(): void {
        try {
            this.getHub().hook();
            this.getWebhooks().start();
        } catch (err: any) {
            logger().error?.(`[ApiPlatform] startEvents: ${err?.message || err}`);
        }
    }

    /** After a workspace change: EventBroadcaster.clearBeforeSendHooks() removed the hooks → register them again. */
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

    /** Cheap check (does not create the router). */
    handles(url: string): boolean {
        const pathname = String(url || '').split('?')[0];
        return pathname === '/api/v1' || pathname.startsWith('/api/v1/') || pathname === '/docs' || pathname.startsWith('/docs/');
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        await this.getRouter().handle(req, res);
    }

    /** Run one API operation inside the process (plugins, tests). */
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

    /** When an account changes (added / removed / connected) → refresh the directory right away. */
    invalidateAccounts(): void {
        this.accounts?.invalidate();
    }

    flush(): void {
        this.log.flush();
    }
}

export default ApiPlatform;
