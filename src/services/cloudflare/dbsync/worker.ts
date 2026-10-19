/**
 * worker — tiến trình nền (worker_threads) của đồng bộ DB: mọi thao tác SQLite nặng chạy ở đây, có connection riêng.
 * Sau `tsc -p tsconfig.electron.json` file này nằm cạnh các module dbsync khác (worker.js) — main tạo bằng
 * `new Worker(path.join(__dirname, 'worker.js'))` (xem DbOpsClient.ts).
 *
 * Chỉ import module trong thư mục dbsync + Node + better-sqlite3 (đường dẫn .node truyền qua workerData.nativeBinding),
 * để chạy được cả khi thư mục dbsync được unpack khỏi app.asar.
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
