/**
 * PluginNodeRegistry — node và trigger workflow do plugin đóng góp (contributes.workflowNodes/triggers).
 *
 * Engine chỉ gọi vào đây cho node mà editor đã gắn `__plugin` (thêm từ palette plugin) hoặc type
 * đang đăng ký → node nội bộ và workflow cũ không đổi hành vi.
 */
import type { ConfigSchema, OutputDef } from './manifest';
import type { PluginRecord } from './PluginManager';

export interface PluginNodeDef {
    pluginId: string;
    pluginName: string;
    kind: 'node' | 'trigger';
    type: string;
    label: string;
    group: string;
    description?: string;
    icon?: string;
    configSchema?: ConfigSchema;
    outputs?: OutputDef[];
}

export interface PluginNodeRun {
    trigger: any;
    variables: Record<string, any>;
    pageId: string;
    workflowId: string;
    workflowName: string;
    nodeId: string;
    nodeLabel: string;
}

export type PluginNodeExecutor = (pluginId: string, type: string, cfg: Record<string, any>, run: PluginNodeRun) => Promise<any>;

export const NODE_TIMEOUT_MS = 60_000;

/** Bỏ khoá nội bộ (__plugin, __kind…) trước khi gửi cấu hình cho plugin. */
export function publicConfig(cfg: Record<string, any> | undefined): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(cfg || {})) {
        if (!k.startsWith('__')) out[k] = v;
    }
    return out;
}

class PluginNodeRegistry {
    private static instance: PluginNodeRegistry | null = null;
    private defs = new Map<string, PluginNodeDef>();
    private executor: PluginNodeExecutor | null = null;

    static getInstance(): PluginNodeRegistry {
        if (!PluginNodeRegistry.instance) PluginNodeRegistry.instance = new PluginNodeRegistry();
        return PluginNodeRegistry.instance;
    }

    static resetForTests(): void {
        PluginNodeRegistry.instance = null;
    }

    setExecutor(fn: PluginNodeExecutor | null): void {
        this.executor = fn;
    }

    register(rec: PluginRecord): void {
        this.unregister(rec.id);
        const c = rec.manifest.contributes || {};
        for (const n of c.workflowNodes || []) {
            this.defs.set(n.type, {
                pluginId: rec.id, pluginName: rec.name, kind: 'node', type: n.type, label: n.label,
                group: n.group || rec.name, description: n.description, icon: n.icon, configSchema: n.configSchema, outputs: n.outputs,
            });
        }
        for (const t of c.triggers || []) {
            this.defs.set(t.type, {
                pluginId: rec.id, pluginName: rec.name, kind: 'trigger', type: t.type, label: t.label,
                group: rec.name, description: t.description, configSchema: t.configSchema, outputs: t.outputs,
            });
        }
    }

    unregister(pluginId: string): void {
        for (const [type, def] of this.defs) {
            if (def.pluginId === pluginId) this.defs.delete(type);
        }
    }

    has(type: string): boolean {
        return this.defs.get(type)?.kind === 'node';
    }

    isTrigger(type: string): boolean {
        return this.defs.get(type)?.kind === 'trigger';
    }

    get(type: string): PluginNodeDef | undefined {
        return this.defs.get(type);
    }

    list(): PluginNodeDef[] {
        return Array.from(this.defs.values());
    }

    async execute(type: string, cfg: Record<string, any>, run: PluginNodeRun): Promise<Record<string, any>> {
        const def = this.defs.get(type);
        if (!def || def.kind !== 'node') {
            throw new Error(`[PLUGIN_NODE_MISSING] Node "${type}" thuộc ứng dụng chưa cài hoặc đang tắt`);
        }
        if (!this.executor) throw new Error('[PLUGIN_NODE_MISSING] Phần chạy ứng dụng chưa sẵn sàng');
        const result = await this.executor(def.pluginId, type, publicConfig(cfg), run);
        if (result && typeof result === 'object' && !Array.isArray(result)) return result;
        return result === undefined ? {} : { result };
    }

    /**
     * Lọc trigger plugin: mọi trường cấu hình không rỗng phải khớp payload
     * (=== hoặc payload chứa chuỗi cấu hình, không phân biệt hoa thường).
     */
    matchesTrigger(cfg: Record<string, any> | undefined, payload: any): boolean {
        for (const [key, want] of Object.entries(publicConfig(cfg))) {
            if (want === undefined || want === null || want === '' || (Array.isArray(want) && want.length === 0)) continue;
            const got = payload?.[key];
            if (Array.isArray(want)) {
                if (!want.map(String).includes(String(got))) return false;
                continue;
            }
            if (typeof want === 'string' && typeof got === 'string') {
                if (got !== want && !got.toLowerCase().includes(want.toLowerCase())) return false;
                continue;
            }
            if (String(got) !== String(want)) return false;
        }
        return true;
    }
}

export default PluginNodeRegistry;
export { PluginNodeRegistry };
