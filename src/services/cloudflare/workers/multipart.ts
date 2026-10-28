/**
 * multipart.ts — dựng body multipart/form-data thành một Buffer (tải script Worker + tải asset lên Cloudflare).
 * Tự dựng thay vì FormData để test đọc lại được và không phụ thuộc cách undici mã hoá phần file.
 */
import * as crypto from 'crypto';

export interface MultipartPart {
    /** Tên trường (Cloudflare: "metadata", tên module, hoặc hash của asset). */
    name: string;
    /** Có filename → phần file. */
    filename?: string;
    contentType?: string;
    data: Buffer | string;
}

function headerValue(s: string): string {
    return String(s).replace(/[\r\n]+/g, ' ').replace(/"/g, '%22');
}

export function buildMultipart(parts: MultipartPart[], boundary = `----DeplaoBoundary${crypto.randomBytes(12).toString('hex')}`): { body: Buffer; contentType: string } {
    const chunks: Buffer[] = [];
    for (const part of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(part.name)}"`;
        if (part.filename !== undefined) head += `; filename="${headerValue(part.filename)}"`;
        head += '\r\n';
        if (part.contentType) head += `Content-Type: ${headerValue(part.contentType)}\r\n`;
        head += '\r\n';
        chunks.push(Buffer.from(head, 'utf8'));
        chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'));
        chunks.push(Buffer.from('\r\n', 'utf8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
