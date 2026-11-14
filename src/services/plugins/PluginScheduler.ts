/**
 * PluginScheduler: contributes.schedules (node-cron) call handlers[handler]() of the plugin backend.
 * If the previous run has not finished, the next run is skipped (no overlap); the run time is written to the plugin log.
 */
import type { PluginRecord, PluginRuntimeHandle } from './PluginManager';
import { TIMEOUTS } from './PluginSandbox';

export interface SchedulerDeps {
    runtimeFor(id: string): PluginRuntimeHandle | null;
    log(id: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
    /** Defaults to node-cron; tests pass a fake one. */
    cron?: { schedule(expr: string, fn: () => void): { stop(): void }; validate(expr: string): boolean };
    /** true = all schedules paused (the DB was just restored, waiting for the user to confirm the old machine is turned off). */
    paused?: () => boolean;
}

export class PluginScheduler {
    private tasks = new Map<string, Array<{ stop(): void }>>();
    private running = new Set<string>();

    constructor(private readonly deps: SchedulerDeps) {}

    private cron() {
        return this.deps.cron || require('node-cron');
    }

    register(rec: PluginRecord): void {
        this.unregister(rec.id);
        const schedules = rec.manifest.contributes?.schedules || [];
        if (!schedules.length || !rec.granted_permissions.includes('schedules')) return;
        const cron = this.cron();
        const list: Array<{ stop(): void }> = [];
        for (const sc of schedules) {
            if (!cron.validate(sc.cron)) {
                this.deps.log(rec.id, 'error', `Lịch "${sc.id}": biểu thức cron không hợp lệ "${sc.cron}"`);
                continue;
            }
            const key = `${rec.id}:${sc.id}`;
            list.push(cron.schedule(sc.cron, () => { void this.run(rec.id, sc.id, sc.handler, key); }));
        }
        this.tasks.set(rec.id, list);
    }

    async run(pluginId: string, scheduleId: string, handler: string, key = `${pluginId}:${scheduleId}`): Promise<void> {
        if (this.running.has(key)) {
            this.deps.log(pluginId, 'warn', `Lịch "${scheduleId}": lượt trước chưa xong, bỏ lượt này`);
            return;
        }
        if (this.deps.paused?.()) {
            this.deps.log(pluginId, 'warn', `Lịch "${scheduleId}": tạm dừng sau khi khôi phục dữ liệu, bỏ lượt này`);
            return;
        }
        const runtime = this.deps.runtimeFor(pluginId);
        if (!runtime) return;
        this.running.add(key);
        const started = Date.now();
        try {
            await runtime.call('schedule.run', { id: scheduleId, handler }, TIMEOUTS.schedule);
            this.deps.log(pluginId, 'debug', `Lịch "${scheduleId}" xong sau ${Date.now() - started} ms`);
        } catch (err: any) {
            this.deps.log(pluginId, 'error', `Lịch "${scheduleId}" lỗi: ${err?.message || err}`);
        } finally {
            this.running.delete(key);
        }
    }

    unregister(pluginId: string): void {
        for (const t of this.tasks.get(pluginId) || []) {
            try { t.stop(); } catch { /* ignore */ }
        }
        this.tasks.delete(pluginId);
    }

    stopAll(): void {
        for (const id of Array.from(this.tasks.keys())) this.unregister(id);
    }
}
