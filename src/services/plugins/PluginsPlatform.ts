/**
 * PluginsPlatform — nối module plugin vào app:
 *   PluginManager (vòng đời) ↔ PluginApiBridge (deplao.*) ↔ ApiPlatform (router v1, sự kiện)
 *   ↔ PluginNodeRegistry (workflow) ↔ PluginScheduler (cron) ↔ renderer (contribution, sự kiện UI).
 *
 * Không làm gì cho tới khi init(); start() chỉ khởi động plugin đã bật, không tạo bảng nếu chưa dùng.
 */
import ApiPlatform from '../api/ApiPlatform';
import { unwrapIpcResult } from '../api/IpcInvoker';
import type { Principal } from '../api/types';
import type { ApiEvent } from '../api/events/EventHub';
import { apiTablesExist } from '../api/dbSchema';
import { isWorkspaceAvailable, appMode, appVersion } from '../api/runtime';
import PluginManager, { PluginRecord, RuntimeContext } from './PluginManager';
import { PluginApiBridge, OperationInfo } from './PluginApiBridge';
import PluginNodeRegistry, { NODE_TIMEOUT_MS } from './PluginNodeRegistry';
import { PluginScheduler } from './PluginScheduler';
import { pluginRoutes } from './PluginRoutes';
import { ForkFn, PluginSandbox, TIMEOUTS } from './PluginSandbox';
import { RemotePluginClient } from './RemotePluginClient';
import { PLUGIN_SCHEME } from './PluginProtocol';

export interface UiContribution {
    pluginId: string;
    pluginName: string;
    id: string;
    title: string;
    icon?: string;
    url: string;
    origin: string;
    width?: number;
    target?: 'ui' | 'backend';
    /** Quyền đã duyệt (renderer kiểm tra deplao.ui.*). */
    permissions: string[];
}

export interface UiContributions {
    pages: UiContribution[];
    chatPanels: UiContribution[];
    composerButtons: UiContribution[];
}

/** URL iframe + origin dùng để kiểm tra postMessage. */
export function uiUrl(rec: PluginRecord, hashPath = '/'): { url: string; origin: string } {
    const entry = rec.manifest.ui?.entry || '';
    const hash = `#${hashPath.startsWith('/') ? hashPath : `/${hashPath}`}`;
    if (/^https?:/i.test(entry)) {
        const u = new URL(entry);
        return { url: `${u.toString().split('#')[0]}${hash}`, origin: u.origin };
    }
    return { url: `${PLUGIN_SCHEME}://${rec.id}/${entry}${hash}`, origin: `${PLUGIN_SCHEME}://${rec.id}` };
}

function logger(): any {
    try { return require('../../utils/Logger').default; } catch { return console; }
}

class PluginsPlatform {
    private static instance: PluginsPlatform | null = null;
    readonly manager: PluginManager;
    readonly scheduler: PluginScheduler;
    readonly bridge: PluginApiBridge;
    private notify: ((channel: string, payload: any) => void) | null = null;
    private fork: ForkFn | undefined;
    private uiSubs = new Map<string, () => void>();
    private opsCache: { size: number; map: Map<string, OperationInfo> } | null = null;
    private initialized = false;

    static getInstance(): PluginsPlatform {
        if (!PluginsPlatform.instance) PluginsPlatform.instance = new PluginsPlatform();
        return PluginsPlatform.instance;
    }

    constructor(manager: PluginManager = PluginManager.getInstance()) {
        this.manager = manager;
        this.scheduler = new PluginScheduler({
            runtimeFor: id => this.manager.runtimeFor(id),
            log: (id, level, msg) => this.manager.logs.append(id, level, msg),
            paused: () => {
                try { return require('../cloudflare/restoreGate').automationsPausedAfterRestore(); } catch { return false; }
            },
        });
        const platform = () => ApiPlatform.getInstance();
        this.bridge = new PluginApiBridge({
            manager: this.manager,
            invoke: (target, input) => platform().invoke(target, input),
            operations: () => this.operations(),
            hub: () => platform().getHub(),
            invokeIpc: async (channel, payload, principal) => unwrapIpcResult(await platform().getInvoker().invoke(channel, [payload], principal, { requestId: 'plugin' })),
            // cloudflare:workers:* — cùng IpcInvoker (hàng đợi, timeout, ngữ cảnh API) + giấy uỷ quyền; kết quả trả nguyên.
            invokeDelegated: (channel, payload, principal, grant, timeoutMs) =>
                platform().getInvoker().invoke(channel, [payload], principal, { requestId: 'plugin', timeoutMs, pluginGrant: grant }),
            uploads: () => platform().uploads,
            appVersion: () => appVersion(),
        });
    }

    private operations(): Map<string, OperationInfo> {
        const list = ApiPlatform.getInstance().getRouter().list();
        if (this.opsCache && this.opsCache.size === list.length) return this.opsCache.map;
        const map = new Map<string, OperationInfo>();
        for (const r of list) {
            const keys = r.def.path.split('/').filter(seg => seg.startsWith(':') || seg === '*').map(seg => (seg === '*' ? '*' : seg.slice(1)));
            map.set(r.operationId, { method: r.def.method, keys });
        }
        this.opsCache = { size: list.length, map };
        return map;
    }

    init(opts: { notifyRenderer?: (channel: string, payload: any) => void; fork?: ForkFn } = {}): void {
        if (opts.notifyRenderer) this.notify = opts.notifyRenderer;
        if (opts.fork) this.fork = opts.fork;
        if (this.initialized) return;
        this.initialized = true;

        this.manager.configure({
            createRuntime: (ctx: RuntimeContext) => {
                const rt = ctx.record.runtime;
                if (rt === 'local') return new PluginSandbox(ctx, { fork: this.fork });
                if (rt === 'remote') return new RemotePluginClient(ctx);
                return null;
            },
            onActivated: rec => {
                PluginNodeRegistry.getInstance().register(rec);
                this.scheduler.register(rec);
            },
            onDeactivated: rec => {
                PluginNodeRegistry.getInstance().unregister(rec.id);
                this.scheduler.unregister(rec.id);
                this.bridge.cleanup(rec.id);
                this.dropUiSubs(rec.id);
            },
            onChanged: () => this.notify?.('plugins:changed', { at: Date.now() }),
            logError: msg => logger().warn?.(msg),
        });
        this.manager.setRequestHandler((id, method, params, origin) => this.bridge.handle(id, method, params, origin));

        PluginNodeRegistry.getInstance().setExecutor(async (pluginId, type, cfg, run) => {
            const runtime = this.manager.runtimeFor(pluginId);
            if (!runtime) throw new Error(`[PLUGIN_NODE_MISSING] Ứng dụng ${pluginId} đang tắt`);
            return runtime.call('node.execute', { type, cfg, run }, NODE_TIMEOUT_MS);
        });

        const api = ApiPlatform.getInstance();
        api.addRouteProvider(() => pluginRoutes(this.manager));
        api.addPrincipalResolver(owner => (owner.startsWith('plugin:') ? this.manager.principalFor(owner.slice(7)) : undefined));
    }

    /** Có nên chạy plugin trên máy này/workspace này không. */
    private canRun(): boolean {
        if (!isWorkspaceAvailable()) return false;
        if (appMode() === 'employee') return false;
        return apiTablesExist();
    }

    async start(): Promise<void> {
        if (!this.canRun()) return;
        try {
            await this.manager.startEnabled();
        } catch (err: any) {
            logger().error?.(`[Plugins] start: ${err?.message || err}`);
        }
    }

    async stop(): Promise<void> {
        await this.manager.stopAll();
        this.scheduler.stopAll();
        for (const off of this.uiSubs.values()) { try { off(); } catch { /* ignore */ } }
        this.uiSubs.clear();
    }

    /** Đổi workspace: dừng plugin của workspace cũ, khởi động plugin của workspace mới. */
    async onWorkspaceChanged(): Promise<void> {
        await this.stop();
        await this.start();
        this.notify?.('plugins:changed', { at: Date.now() });
    }

    activeRecord(id: string): PluginRecord | null {
        if (!this.manager.isActive(id)) return null;
        return this.manager.activeRecords().find(r => r.id === id) || null;
    }

    contributions(): UiContributions {
        const out: UiContributions = { pages: [], chatPanels: [], composerButtons: [] };
        for (const rec of this.manager.activeRecords()) {
            const c = rec.manifest.contributes || {};
            const has = (p: string) => rec.granted_permissions.includes(p);
            if (rec.manifest.ui && has('ui:pages')) {
                for (const p of c.pages || []) out.pages.push({ pluginId: rec.id, pluginName: rec.name, id: p.id, title: p.title, icon: p.icon, permissions: rec.granted_permissions, ...uiUrl(rec, p.path) });
            }
            if (rec.manifest.ui && has('ui:chat-panel')) {
                for (const p of c.chatPanels || []) out.chatPanels.push({ pluginId: rec.id, pluginName: rec.name, id: p.id, title: p.title, width: p.width, permissions: rec.granted_permissions, ...uiUrl(rec, p.path) });
            }
            if (has('ui:composer')) {
                for (const b of c.composerButtons || []) {
                    const ui = rec.manifest.ui ? uiUrl(rec, b.path || '/') : { url: '', origin: '' };
                    out.composerButtons.push({ pluginId: rec.id, pluginName: rec.name, id: b.id, title: b.title, icon: b.icon, target: b.target, permissions: rec.granted_permissions, ...ui });
                }
            }
        }
        return out;
    }

    /** UI plugin (iframe) đăng ký sự kiện realtime; `send` đẩy về renderer. */
    subscribeUi(senderKey: string, pluginId: string, types: string[] | null, send: (ev: ApiEvent) => void): void {
        const key = `${senderKey}|${pluginId}`;
        this.uiSubs.get(key)?.();
        this.uiSubs.delete(key);
        if (!types || !types.length) return;
        const principal: Principal | null = this.manager.principalFor(pluginId);
        if (!principal) throw Object.assign(new Error(`Plugin ${pluginId} chưa bật`), { code: 'CONFLICT' });
        if (!principal.scopes.has('events:subscribe')) throw Object.assign(new Error('Plugin cần scope events:subscribe'), { code: 'FORBIDDEN_SCOPE' });
        const off = ApiPlatform.getInstance().getHub().subscribe({
            principal,
            types: types.slice(0, 50),
            handler: ev => {
                if (ev.type.startsWith(`plugin.${pluginId}.`)) return;
                send(ev);
            },
        });
        this.uiSubs.set(key, off);
    }

    unsubscribeUi(senderKey: string, pluginId?: string): void {
        for (const [key, off] of this.uiSubs) {
            if (!key.startsWith(`${senderKey}|`)) continue;
            if (pluginId && key !== `${senderKey}|${pluginId}`) continue;
            try { off(); } catch { /* ignore */ }
            this.uiSubs.delete(key);
        }
    }

    private dropUiSubs(pluginId: string): void {
        for (const [key, off] of this.uiSubs) {
            if (!key.endsWith(`|${pluginId}`)) continue;
            try { off(); } catch { /* ignore */ }
            this.uiSubs.delete(key);
        }
    }

    /** Nút trong ô soạn tin (target backend). */
    async composerCommand(pluginId: string, buttonId: string, context: any): Promise<any> {
        const rec = this.activeRecord(pluginId);
        const btn = rec?.manifest.contributes?.composerButtons?.find(b => b.id === buttonId);
        if (!rec || !btn || btn.target !== 'backend' || !rec.granted_permissions.includes('ui:composer')) {
            throw Object.assign(new Error('Nút không tồn tại hoặc ứng dụng đang tắt'), { code: 'NOT_FOUND' });
        }
        const runtime = this.manager.runtimeFor(pluginId);
        if (!runtime) throw Object.assign(new Error('Ứng dụng không có phần chạy nền'), { code: 'CONFLICT' });
        return runtime.call('composer.command', { id: buttonId, context }, TIMEOUTS.command);
    }
}

export default PluginsPlatform;
export { PluginsPlatform };
