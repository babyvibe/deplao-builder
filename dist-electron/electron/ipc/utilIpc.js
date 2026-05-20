"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUtilIpc = registerUtilIpc;
const electron_1 = require("electron");
/**
 * Utility IPC handlers — fetch URLs from main process (no CORS restrictions)
 */
function registerUtilIpc() {
    /**
     * Fetch a URL and return base64-encoded content + content type.
     * Used for loading Zalo CDN resources (bank card images, etc.) that
     * can't be fetched from the renderer due to CORS/auth restrictions.
     */
    electron_1.ipcMain.handle('util:fetchUrl', async (_event, args) => {
        const { url } = args;
        if (!url)
            return { success: false, error: 'No URL provided' };
        try {
            const response = await electron_1.net.fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            });
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const contentType = response.headers.get('content-type') || '';
            return {
                success: response.ok,
                data: base64,
                contentType,
                statusCode: response.status,
            };
        }
        catch (err) {
            return { success: false, error: err.message || 'Fetch failed' };
        }
    });
}
//# sourceMappingURL=utilIpc.js.map