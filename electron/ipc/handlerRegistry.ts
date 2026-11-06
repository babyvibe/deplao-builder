/**
 * handlerRegistry — ghi nhận MỌI IPC handler (ipcMain.handle) vào một Map để
 * Public API v1 và plugin gọi đúng handler mà UI đang dùng (một logic duy nhất).
 *
 * Cài đặt bằng cách import file này TRƯỚC mọi register*Ipc() trong electron/main.ts.
 * Wrapper chỉ thêm `Map.set/delete` và đo phần chạy đồng bộ của handler (timeIpc — chỉ ghi Nhật ký khi ≥ 1 s),
 * không đổi kết quả / lỗi của handler. Map giữ handler gốc (Public API / plugin gọi thẳng).
 *
 * Lưu ý bảo mật: registry này KHÔNG dùng cho /api/proxy/action của nhân viên —
 * proxy cũ vẫn dùng registry riêng trong zaloIpc.ts (chỉ kênh zalo:*), để không mở
 * rộng bề mặt mà nhân viên gọi được.
 *
 * Lệnh từ giao diện chạy trong phạm vi workspace đang mở (dbScope.runInUiScope): giao diện đang mở workspace nhân viên
 * (remote) → CSDL / media / chế độ của workspace đó. Public API / plugin gọi thẳng handler trong Map (không qua đây)
 * nên luôn phục vụ workspace local đang chạy. Boss gọi handler hộ nhân viên (HttpRelayService: proxy / lệnh REST, qua
 * ipcMain._invokeHandlers với event = null) cũng vậy: không phải lệnh của giao diện.
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
        // Đo phần chạy đồng bộ của handler (≥ 1 s → Nhật ký "[Hiệu năng] IPC …") — tìm thủ phạm khi app "Not Responding".
        // Phạm vi workspace đang mở chỉ cho lệnh có event của Electron (từ giao diện). event = null: Boss chạy hộ nhân viên →
        // workspace local đang chạy. Trước đây máy vừa là Boss vừa mở workspace nhân viên thì lệnh của nhân viên (lưu nhãn,
        // ghi chú, tải ảnh…) đọc / ghi CSDL đệm của workspace nhân viên thay vì CSDL của Boss.
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
