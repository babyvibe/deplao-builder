/**
 * handlerRegistry — ghi nhận MỌI IPC handler (ipcMain.handle) vào một Map để
 * Public API v1 và plugin gọi đúng handler mà UI đang dùng (một logic duy nhất).
 *
 * Cài đặt bằng cách import file này TRƯỚC mọi register*Ipc() trong electron/main.ts.
 * Wrapper chỉ thêm `Map.set/delete`, không đổi hành vi của ipcMain.
 *
 * Lưu ý bảo mật: registry này KHÔNG dùng cho /api/proxy/action của nhân viên —
 * proxy cũ vẫn dùng registry riêng trong zaloIpc.ts (chỉ kênh zalo:*), để không mở
 * rộng bề mặt mà nhân viên gọi được.
 */
import { ipcMain } from 'electron';

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
        const result = originalHandle(channel, listener);
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
