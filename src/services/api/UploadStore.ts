/**
 * UploadStore — file tạm do client API upload (hoặc tải từ URL) để gửi vào chat.
 *
 * Bảo mật:
 *  - Client KHÔNG BAO GIỜ truyền đường dẫn file trên máy; chỉ dùng upload_id.
 *  - upload_id gắn với principal đã upload (key khác không dùng được).
 *  - Tải từ URL: chỉ http/https, chặn IP nội bộ/loopback (SSRF), giới hạn dung lượng + thời gian.
 *  - Hết hạn sau 24 giờ, dọn khi khởi động và mỗi giờ.
 */
import * as fs from 'fs';
import * as path from 'path';
import { guardedOpen, GuardedStream, BlockedAddressError, GuardTimeoutError, isPrivateAddress } from './netGuard';
import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { ApiError } from './types';
import { mediaBaseDir } from './runtime';

export { isPrivateAddress };

export type UploadKind = 'image' | 'video' | 'audio' | 'file';

export interface UploadRecord {
    id: string;
    path: string;
    name: string;
    mime: string;
    size: number;
    kind: UploadKind;
    principal_id: string;
    created_at: number;
    expires_at: number;
}

const TTL_MS = 24 * 3600_000;
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', '3gp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'opus', 'amr'];

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', webm: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function sanitizeFileName(name: string): string {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim();
    const limited = cleaned.length > 150 ? cleaned.slice(cleaned.length - 150) : cleaned;
    return limited || 'file';
}

export function kindFromName(name: string, mime = ''): UploadKind {
    const ext = path.extname(name).slice(1).toLowerCase();
    if (IMAGE_EXT.includes(ext) || mime.startsWith('image/')) return 'image';
    if (VIDEO_EXT.includes(ext) || mime.startsWith('video/')) return 'video';
    if (AUDIO_EXT.includes(ext) || mime.startsWith('audio/')) return 'audio';
    return 'file';
}

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
    return MIME_BY_EXT[path.extname(name).slice(1).toLowerCase()] || fallback;
}

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

/** Tên file trong Content-Disposition (filename*=UTF-8''... ưu tiên hơn filename="..."). */
export function filenameFromDisposition(header: string | undefined): string {
    const v = String(header || '');
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(v);
    if (star) return safeDecode(star[1].trim().replace(/^"|"$/g, ''));
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(v);
    if (plain) return (plain[1] ?? plain[2] ?? '').trim();
    return '';
}

function mapFetchError(err: any): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof BlockedAddressError || err?.code === 'PRIVATE_ADDRESS') {
        return new ApiError(400, 'VALIDATION_ERROR', 'URL trỏ vào mạng nội bộ — bị chặn. Hãy upload file qua POST /media/uploads (hoặc bật api_allow_private_urls).');
    }
    if (err instanceof GuardTimeoutError || err?.code === 'TIMEOUT') return new ApiError(504, 'TIMEOUT', 'Tải URL quá thời gian');
    if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return new ApiError(400, 'VALIDATION_ERROR', 'Không phân giải được tên miền của URL');
    return new ApiError(502, 'UPSTREAM_ERROR', `Tải URL thất bại: ${String(err?.message || err).slice(0, 300)}`);
}

export class UploadStore {
    private records = new Map<string, UploadRecord>();
    private lastCleanup = 0;

    constructor(private readonly baseDirProvider: () => string = () => path.join(mediaBaseDir(), '_api_uploads')) {}

    dir(): string {
        const d = this.baseDirProvider();
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    }

    private newTarget(name: string): { id: string; filePath: string } {
        const id = `upl_${randomUUID().replace(/-/g, '')}`;
        const folder = path.join(this.dir(), id);
        fs.mkdirSync(folder, { recursive: true });
        return { id, filePath: path.join(folder, sanitizeFileName(name)) };
    }

    private remember(rec: UploadRecord): UploadRecord {
        this.records.set(rec.id, rec);
        this.cleanup();
        return rec;
    }

    async saveBuffer(buf: Buffer, name: string, mime: string, principalId: string): Promise<UploadRecord> {
        if (buf.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'File rỗng');
        const safeName = sanitizeFileName(name);
        const { id, filePath } = this.newTarget(safeName);
        await fs.promises.writeFile(filePath, buf);
        const now = Date.now();
        return this.remember({
            id, path: filePath, name: safeName, mime: mime || mimeFromName(safeName), size: buf.length,
            kind: kindFromName(safeName, mime), principal_id: principalId, created_at: now, expires_at: now + TTL_MS,
        });
    }

    /** Ghi thẳng request body (raw upload) xuống đĩa, không giữ cả file trong RAM. */
    saveStream(req: IncomingMessage, name: string, mime: string, maxBytes: number, principalId: string): Promise<UploadRecord> {
        const safeName = sanitizeFileName(name);
        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > maxBytes) {
            req.resume();
            return Promise.reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', `File tối đa ${Math.round(maxBytes / 1024 / 1024)} MB`));
        }
        const { id, filePath } = this.newTarget(safeName);
        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(filePath);
            let size = 0;
            let failed = false;
            const fail = (err: any) => {
                if (failed) return;
                failed = true;
                out.destroy();
                fs.promises.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
                reject(err);
            };
            req.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                    req.unpipe(out);
                    req.resume();
                    fail(new ApiError(413, 'PAYLOAD_TOO_LARGE', `File tối đa ${Math.round(maxBytes / 1024 / 1024)} MB`));
                }
            });
            req.on('error', fail);
            out.on('error', fail);
            out.on('finish', () => {
                if (failed) return;
                if (size === 0) return fail(new ApiError(400, 'VALIDATION_ERROR', 'File rỗng'));
                const now = Date.now();
                resolve(this.remember({
                    id, path: filePath, name: safeName, mime: mime || mimeFromName(safeName), size,
                    kind: kindFromName(safeName, mime), principal_id: principalId, created_at: now, expires_at: now + TTL_MS,
                }));
            });
            req.pipe(out);
        });
    }

    /**
     * Tải file từ URL (http/https) về kho tạm, ghi thẳng xuống đĩa.
     * Mạng nội bộ bị chặn ngay lúc kết nối (cả khi URL công khai redirect vào 127.0.0.1/LAN),
     * trừ khi `allowPrivate` (request từ chính máy hoặc người dùng bật api_allow_private_urls).
     */
    async saveFromUrl(rawUrl: string, principalId: string, maxBytes: number, opts: { allowPrivate?: boolean; timeoutMs?: number } = {}): Promise<UploadRecord> {
        let url: URL;
        try { url = new URL(rawUrl); } catch { throw new ApiError(400, 'VALIDATION_ERROR', 'URL không hợp lệ'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Chỉ nhận URL http/https');
        }
        let r: GuardedStream;
        try {
            r = await guardedOpen(url.toString(), {
                allowPrivate: !!opts.allowPrivate,
                timeoutMs: opts.timeoutMs || 60_000,
                maxRedirects: 5,
                headers: { 'User-Agent': 'Deplao-API/1', Accept: '*/*' },
            });
        } catch (err) {
            throw mapFetchError(err);
        }
        try {
            if (r.status < 200 || r.status >= 300) {
                r.stream.resume();
                throw new ApiError(502, 'UPSTREAM_ERROR', `Tải URL thất bại: HTTP ${r.status}`);
            }
            const mime = String(r.headers['content-type'] || '').split(';')[0].trim();
            const fromHeader = filenameFromDisposition(r.headers['content-disposition'] as string | undefined);
            const fromPath = safeDecode(path.basename(new URL(r.url).pathname || '')) || 'file';
            const base = fromHeader || fromPath;
            const name = path.extname(base) ? base : `${base}${extForMime(mime)}`;
            return await this.saveStream(r.stream, name, mime, maxBytes, principalId);
        } catch (err) {
            throw mapFetchError(err);
        } finally {
            r.finish();
        }
    }

    get(id: string, principalId: string): UploadRecord {
        const rec = this.records.get(id);
        if (!rec || rec.expires_at < Date.now() || !fs.existsSync(rec.path)) {
            throw new ApiError(404, 'NOT_FOUND', `upload_id ${id} không tồn tại hoặc đã hết hạn`);
        }
        if (rec.principal_id !== principalId) {
            throw new ApiError(403, 'FORBIDDEN_SCOPE', 'upload_id thuộc về key khác');
        }
        return rec;
    }

    delete(id: string, principalId: string): boolean {
        const rec = this.records.get(id);
        if (!rec || rec.principal_id !== principalId) return false;
        this.records.delete(id);
        fs.promises.rm(path.dirname(rec.path), { recursive: true, force: true }).catch(() => {});
        return true;
    }

    cleanup(force = false): void {
        const now = Date.now();
        if (!force && now - this.lastCleanup < 3600_000) return;
        this.lastCleanup = now;
        for (const [id, rec] of this.records) {
            if (rec.expires_at < now) {
                this.records.delete(id);
                fs.promises.rm(path.dirname(rec.path), { recursive: true, force: true }).catch(() => {});
            }
        }
        // File mồ côi từ phiên trước (index chỉ ở RAM).
        try {
            const dir = this.baseDirProvider();
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir)) {
                if (this.records.has(entry)) continue;
                const full = path.join(dir, entry);
                try {
                    const st = fs.statSync(full);
                    if (now - st.mtimeMs > TTL_MS) fs.rmSync(full, { recursive: true, force: true });
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }
}

function extForMime(mime: string): string {
    for (const [ext, m] of Object.entries(MIME_BY_EXT)) if (m === mime) return `.${ext}`;
    return '';
}

/** Tách phần file đầu tiên của multipart/form-data (đủ cho n8n, Make, curl -F). */
export function parseMultipartFile(buf: Buffer, contentType: string): { name: string; mime: string; data: Buffer; fields: Record<string, string> } | null {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!m) return null;
    const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
    const fields: Record<string, string> = {};
    let file: { name: string; mime: string; data: Buffer } | null = null;
    let pos = buf.indexOf(boundary);
    while (pos >= 0) {
        const start = pos + boundary.length;
        if (buf.slice(start, start + 2).toString() === '--') break;
        const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), start);
        if (headerEnd < 0) break;
        const headers = buf.slice(start, headerEnd).toString('utf8');
        const next = buf.indexOf(boundary, headerEnd + 4);
        if (next < 0) break;
        let body = buf.slice(headerEnd + 4, next);
        if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
        const dispLine = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] || '';
        // Neo sau đầu dòng hoặc dấu ";" để "filename=" không bị nhận nhầm thành "name=".
        const fieldName = /(?:^|;)\s*name="([^"]*)"/i.exec(dispLine)?.[1];
        const fileName = /(?:^|;)\s*filename\*?="?([^";]*)"?/i.exec(dispLine)?.[1];
        const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
        if (fieldName !== undefined) {
            if (fileName !== undefined && !file) {
                let decoded = fileName;
                if (/^utf-8''/i.test(decoded)) {
                    try { decoded = decodeURIComponent(decoded.replace(/^utf-8''/i, '')); } catch { /* giữ nguyên */ }
                }
                file = { name: decoded || 'file', mime: typeMatch ? typeMatch[1].trim() : '', data: body };
            } else if (fileName === undefined) {
                fields[fieldName] = body.toString('utf8');
            }
        }
        pos = next;
    }
    return file ? { ...file, fields } : null;
}
