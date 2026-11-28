/**
 * GIF tab of the Zalo sticker panel: GIFs come from Giphy through Zalo's sticker service (zca-js
 * getGiphyGifTrending / searchGiphyGif). Sending downloads the GIF and uploads it like a GIF file,
 * so the receiver gets a normal Zalo GIF message.
 */
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tr } from '../../shared/i18n';

/** Only download from Giphy / Zalo hosts: the URL comes from the renderer (or an employee through the relay). */
const GIF_HOST_RE = /(^|\.)(giphy\.com|zdn\.vn|zadn\.vn|zalo\.me|zaloapp\.com)$/i;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MAX_TRIES = 4;

export function isZaloGifUrl(url: unknown): boolean {
    try {
        const parsed = new URL(String(url));
        return parsed.protocol === 'https:' && GIF_HOST_RE.test(parsed.hostname);
    } catch {
        return false;
    }
}

export function isGifData(buf: Buffer): boolean {
    return buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF';
}

/**
 * Download the first candidate URL that really is a GIF (Giphy renditions can be WebP / MP4) into a temp file.
 * The caller deletes the file after sending.
 */
export async function downloadZaloGif(candidates: unknown): Promise<string> {
    const urls = (Array.isArray(candidates) ? candidates : [candidates])
        .map(u => String(u || '').trim())
        .filter((u, i, all) => u && all.indexOf(u) === i)
        .filter(isZaloGifUrl)
        .slice(0, MAX_TRIES);
    if (!urls.length) throw new Error(tr('Đường dẫn GIF không hợp lệ'));

    let lastError = '';
    for (const url of urls) {
        try {
            const res = await axios.get<ArrayBuffer>(url, {
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: MAX_GIF_BYTES,
                maxRedirects: 3,
            });
            const finalUrl = (res.request as any)?.res?.responseUrl;
            if (finalUrl && !isZaloGifUrl(finalUrl)) throw new Error(`redirected to ${new URL(finalUrl).host}`);
            const buf = Buffer.from(res.data);
            if (!isGifData(buf)) throw new Error('not a GIF file');
            const dir = path.join(os.tmpdir(), 'deplao-gif');
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, `gif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.gif`);
            await fs.promises.writeFile(file, buf);
            return file;
        } catch (err: any) {
            lastError = err?.message || String(err);
        }
    }
    throw new Error(tr('Không tải được GIF: {{message}}', { message: lastError }));
}
