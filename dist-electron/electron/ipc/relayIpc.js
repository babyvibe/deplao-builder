"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRelayIpc = registerRelayIpc;
const electron_1 = require("electron");
const HttpRelayService_1 = __importDefault(require("../../src/services/HttpRelayService"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
function registerRelayIpc() {
    const relay = () => HttpRelayService_1.default.getInstance();
    electron_1.ipcMain.handle('relay:startServer', async (_e, { port } = {}) => {
        try {
            return await relay().start(port);
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('relay:stopServer', async () => {
        try {
            return relay().stop();
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('relay:getServerStatus', async () => {
        try {
            return { success: true, ...relay().getStatus() };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('relay:kickEmployee', async (_e, { employeeId }) => {
        try {
            relay().kickEmployee(employeeId);
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    Logger_1.default.log('[relayIpc] Registered 4 relay IPC channels');
}
//# sourceMappingURL=relayIpc.js.map