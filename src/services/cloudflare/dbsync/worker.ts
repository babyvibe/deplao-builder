/**
 * worker: background thread (worker_threads) of the DB sync: all heavy SQLite work runs here, on its own connection.
 * After `tsc -p tsconfig.electron.json` this file sits next to the other dbsync modules (worker.js). main creates it with
 * `new Worker(path.join(__dirname, 'worker.js'))` (see DbOpsClient.ts).
 *
 * Only imports modules from the dbsync folder + Node + better-sqlite3 (the .node path is passed in via workerData.nativeBinding),
 * so it still runs when the dbsync folder is unpacked from app.asar.
 */
import { parentPort, workerData } from 'worker_threads';
import { createOpsHandler } from './ops';
import { betterSqliteOpener } from './sqlConn';

const port = parentPort;
if (port) {
    const nativeBinding: string | null = workerData && typeof workerData.nativeBinding === 'string' ? workerData.nativeBinding : null;
    const handler = createOpsHandler(betterSqliteOpener(nativeBinding), ev => port.postMessage({ event: ev }));
    port.on('message', (msg: any) => {
        if (!msg || typeof msg.id !== 'number') return;
        handler.handle(String(msg.op), msg.args || {}).then(
            result => port.postMessage({ id: msg.id, ok: true, result }),
            (err: any) => port.postMessage({
                id: msg.id,
                ok: false,
                error: { message: String(err?.message || err), code: err?.code ? String(err.code) : null },
            }),
        );
    });
    port.on('close', () => handler.closeAll());
}
