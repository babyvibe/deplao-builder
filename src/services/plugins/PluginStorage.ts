/**
 * PluginStorage — KV riêng của từng plugin (bảng plugin_storage), thư mục dữ liệu riêng,
 * và nhật ký plugin (bảng plugin_logs, ghi theo lô, giữ 5.000 dòng mỗi plugin).
 */
import * as fs from 'fs';
import * as path from 'path';
import { apiDb, apiTablesExist } from '../api/dbSchema';
import { ApiError } from '../api/types';

export const STORAGE_LIMITS = {
    keyMax: 200,
    valueMaxBytes: 1024 * 1024,
    totalMaxBytes: 20 * 1024 * 1024,
    listMax: 1000,
};

export class PluginStorage {
    constructor(private readonly dataRoot: () => string) {}

    private checkKey(key: string): string {
        const k = String(key ?? '');
        if (!k || k.length > STORAGE_LIMITS.keyMax) throw new ApiError(400, 'VALIDATION_ERROR', `key phải có 1–${STORAGE_LIMITS.keyMax} ký tự`);
        return k;
    }

    get(pluginId: string, key: string): any {
        const row = apiDb().queryOne<{ value_json: string }>('SELECT value_json FROM plugin_storage WHERE plugin_id = ? AND key = ?', [pluginId, this.checkKey(key)]);
        if (!row) return null;
        try { return JSON.parse(row.value_json); } catch { return null; }
    }

    set(pluginId: string, key: string, value: any): void {
        const k = this.checkKey(key);
        if (value === undefined) throw new ApiError(400, 'VALIDATION_ERROR', 'value không được undefined (dùng delete)');
        let json: string;
        try { json = JSON.stringify(value); } catch { throw new ApiError(400, 'VALIDATION_ERROR', 'value phải chuyển được sang JSON'); }
        const bytes = Buffer.byteLength(json);
        if (bytes > STORAGE_LIMITS.valueMaxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Mỗi giá trị tối đa 1 MB');
        const db = apiDb();
        const used = db.queryOne<{ n: number }>('SELECT COALESCE(SUM(LENGTH(value_json)), 0) AS n FROM plugin_storage WHERE plugin_id = ? AND key != ?', [pluginId, k]);
        if (Number(used?.n || 0) + bytes > STORAGE_LIMITS.totalMaxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Plugin đã dùng hết 20 MB lưu trữ');
        db.run(
            `INSERT INTO plugin_storage (plugin_id, key, value_json, updated_at) VALUES (?,?,?,?)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
            [pluginId, k, json, Date.now()],
        );
    }

    delete(pluginId: string, key: string): boolean {
        return apiDb().runChanges('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?', [pluginId, this.checkKey(key)]) > 0;
    }

    list(pluginId: string, prefix = '', limit = 100): Array<{ key: string; value: any; updated_at: number }> {
        const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), STORAGE_LIMITS.listMax);
        const p = String(prefix || '');
        const escaped = p.replace(/[\\%_]/g, ch => `\\${ch}`);
        const rows = apiDb().query<{ key: string; value_json: string; updated_at: number }>(
            `SELECT key, value_json, updated_at FROM plugin_storage WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?`,
            [pluginId, `${escaped}%`, lim],
        );
        return rows.map(r => {
            let value: any = null;
            try { value = JSON.parse(r.value_json); } catch { /* giữ null */ }
            return { key: r.key, value, updated_at: r.updated_at };
        });
    }

    clear(pluginId: string): number {
        if (!apiTablesExist()) return 0;
        return apiDb().runChanges('DELETE FROM plugin_storage WHERE plugin_id = ?', [pluginId]);
    }

    /** Thư mục file riêng của plugin (tạo nếu chưa có). */
    dataDir(pluginId: string): string {
        const dir = path.join(this.dataRoot(), pluginId);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    removeDataDir(pluginId: string): void {
        const dir = path.join(this.dataRoot(), pluginId);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export class PluginLogStore {
    private buffer: Array<{ plugin_id: string; level: string; message: string; created_at: number }> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private sinceprune = 0;
    static readonly KEEP_PER_PLUGIN = 5000;

    constructor(private readonly onLine?: (pluginId: string, level: PluginLogLevel, message: string) => void) {}

    append(pluginId: string, level: PluginLogLevel, message: string): void {
        const msg = String(message ?? '').slice(0, 4000);
        this.buffer.push({ plugin_id: pluginId, level, message: msg, created_at: Date.now() });
        try { this.onLine?.(pluginId, level, msg); } catch { /* ignore */ }
        if (this.buffer.length >= 200) this.flush();
        else if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), 1000);
            if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
        }
    }

    flush(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (!this.buffer.length) return;
        const rows = this.buffer.splice(0);
        try {
            const db = apiDb();
            db.transaction(() => {
                for (const r of rows) {
                    db.run('INSERT INTO plugin_logs (plugin_id, level, message, created_at) VALUES (?,?,?,?)', [r.plugin_id, r.level, r.message, r.created_at]);
                }
            });
            this.sinceprune += rows.length;
            if (this.sinceprune >= 1000) {
                this.sinceprune = 0;
                this.prune();
            }
        } catch { /* nhật ký không được làm hỏng plugin */ }
    }

    prune(): void {
        try {
            const db = apiDb();
            const ids = db.query<{ plugin_id: string }>('SELECT DISTINCT plugin_id FROM plugin_logs');
            for (const { plugin_id } of ids) {
                const cut = db.queryOne<{ id: number }>('SELECT id FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?', [plugin_id, PluginLogStore.KEEP_PER_PLUGIN]);
                if (cut) db.run('DELETE FROM plugin_logs WHERE plugin_id = ? AND id <= ?', [plugin_id, cut.id]);
            }
        } catch { /* ignore */ }
    }

    list(pluginId: string, limit = 500): Array<{ id: number; level: string; message: string; created_at: number }> {
        this.flush();
        if (!apiTablesExist()) return [];
        const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 500)), 2000);
        return apiDb().query<{ id: number; level: string; message: string; created_at: number }>(
            'SELECT id, level, message, created_at FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?',
            [pluginId, lim],
        );
    }

    clear(pluginId: string): void {
        this.buffer = this.buffer.filter(r => r.plugin_id !== pluginId);
        if (!apiTablesExist()) return;
        apiDb().run('DELETE FROM plugin_logs WHERE plugin_id = ?', [pluginId]);
    }
}
