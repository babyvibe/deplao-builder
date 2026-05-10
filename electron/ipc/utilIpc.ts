import { ipcMain, net } from 'electron';

/**
 * Utility IPC handlers — fetch URLs from main process (no CORS restrictions)
 */
export function registerUtilIpc(): void {
  /**
   * Fetch a URL and return base64-encoded content + content type.
   * Used for loading Zalo CDN resources (bank card images, etc.) that
   * can't be fetched from the renderer due to CORS/auth restrictions.
   */
  ipcMain.handle('util:fetchUrl', async (_event, args: { url: string }): Promise<{
    success: boolean;
    data?: string;
    contentType?: string;
    statusCode?: number;
    error?: string;
  }> => {
    const { url } = args;
    if (!url) return { success: false, error: 'No URL provided' };

    try {
      const response = await net.fetch(url, {
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
    } catch (err: any) {
      return { success: false, error: err.message || 'Fetch failed' };
    }
  });
}

