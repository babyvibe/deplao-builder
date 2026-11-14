/**
 * dbReadWorker: background SQLite read thread for DatabaseService (readOps.ts). After `tsc -p tsconfig.electron.json` it sits next to
 * readOps.js; main creates it with `new Worker(.../dbReadWorker.js, { workerData: { nativeBinding } })` (DbReadClient.ts).
 *
 * Imports only Node + better-sqlite3 (the .node path is passed via workerData.nativeBinding), so it runs even when the folder
 * is unpacked from app.asar.
 */
import { parentPort, workerData } from 'worker_threads';
import { IDLE_CLOSE_MS, ReadConn, createReadOps } from './readOps';

const port = parentPort;
if (port) {
    const nativeBinding: string | null = workerData && typeof workerData.nativeBinding === 'string' ? workerData.nativeBinding : null;
    const open = (dbPath: string): ReadConn => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require('better-sqlite3');
        const options: Record<string, unknown> = { readonly: true, fileMustExist: true, timeout: 5000 };
        if (nativeBinding) options.nativeBinding = nativeBinding;
        const db = new Database(dbPath, options);
        return {
            all: (sql, params) => db.prepare(sql).all(...params),
            get: (sql, params) => db.prepare(sql).get(...params),
            close: () => { try { db.close(); } catch { /* closed */ } },
        };
    };
    const ops = createReadOps(open);
    const sweep = setInterval(() => ops.sweep(), IDLE_CLOSE_MS);
    (sweep as any).unref?.();
    port.on('message', (msg: any) => {
        if (!msg || typeof msg.id !== 'number') return;
        if (msg.op === 'closeAll') {
            ops.closeAll();
            // Main waits synchronously (Atomics.wait) before closing / replacing the DB file
            if (msg.flag instanceof SharedArrayBuffer) {
                const flag = new Int32Array(msg.flag);
                Atomics.store(flag, 0, 1);
                Atomics.notify(flag, 0);
            }
            port.postMessage({ id: msg.id, ok: true, result: true });
            return;
        }
        try {
            port.postMessage({ id: msg.id, ok: true, result: ops.run(msg) });
        } catch (err: any) {
            port.postMessage({ id: msg.id, ok: false, error: { message: String(err?.message || err), code: err?.code ? String(err.code) : null } });
        }
    });
    port.on('close', () => ops.closeAll());
}
