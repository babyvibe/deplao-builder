/**
 * handlerRegistry: records EVERY IPC handler (ipcMain.handle) in one Map so
 * Public API v1 and plugins call the same handler the UI uses (a single logic).
 *
 * Installed by importing this file BEFORE any register*Ipc() in electron/main.ts.
 * The wrapper only adds `Map.set/delete` and measures the synchronous part of a handler (timeIpc: writes to the Log only when ≥ 1 s),
 * without changing the handler's result / errors. The Map keeps the original handler (Public API / plugins call it directly).
 *
 * Security note: this registry is NOT used for the employee /api/proxy/action -
 * the old proxy still uses its own registry in zaloIpc.ts (zalo:* channels only), so it does not
 * widen the surface employees can call.
 *
 * UI commands run in the scope of the open workspace (dbScope.runInUiScope): when the UI has an employee (remote) workspace open →
 * that workspace's DB / media / mode. Public API / plugins call handlers in the Map directly (not through here),
 * so they always serve the running local workspace. Boss calling a handler on behalf of an employee (HttpRelayService: proxy / REST commands, via
 * ipcMain._invokeHandlers with event = null) is the same: not a UI command.
 */
import { ipcMain } from 'electron';
import { timeIpc } from '../../src/utils/startup/mainThreadWatchdog';
import { runInUiScope } from '../../src/services/database/dbScope';

export type RegisteredIpcHandler = (event: any, ...args: any[]) => any;

export const ipcHandlerRegistry = new Map<string, RegisteredIpcHandler>();

let installed = false;

export function installIpcHandlerRegistry(): void {
    if (installed) return;
    installed = true;
    const main = ipcMain as any;
    if (!main || typeof main.handle !== 'function') return;
    const originalHandle = main.handle.bind(ipcMain);
    const originalRemove = typeof main.removeHandler === 'function' ? main.removeHandler.bind(ipcMain) : null;

    main.handle = (channel: string, listener: RegisteredIpcHandler) => {
        // Measures the synchronous part of the handler (≥ 1 s → Log "[Hiệu năng] IPC …") - to find the culprit when the app shows "Not Responding".
        // The open-workspace scope only applies to commands that carry an Electron event (from the UI). event = null: Boss running on behalf of an employee →
        // the running local workspace. Before, when a machine was both Boss and had an employee workspace open, the employee's commands (save label,
        // save note, download image…) read / wrote the cached DB of the employee workspace instead of Boss's DB.
        const result = originalHandle(channel, (event: any, ...args: any[]) => {
            const run = () => timeIpc(channel, () => listener(event, ...args));
            return event ? runInUiScope(run) : run();
        });
        ipcHandlerRegistry.set(channel, listener);
        return result;
    };

    if (originalRemove) {
        main.removeHandler = (channel: string) => {
            ipcHandlerRegistry.delete(channel);
            return originalRemove(channel);
        };
    }
}

installIpcHandlerRegistry();
