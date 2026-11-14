/**
 * http.ts: HTTP helpers for API v1: read a body with a size limit, write JSON safely.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { ApiError } from '../types';
import { tr } from '../../../shared/i18n';

export const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, Idempotency-Key, X-Filename',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining',
    'Access-Control-Max-Age': '600',
};

/**
 * JSON.stringify handles BigInt (Telegram/Zalo ids), skips Buffer, and handles circular references (the repeated node is dropped).
 * Only treated as a cycle when the object is an ANCESTOR of itself on the branch being written. The same object appearing
 * in several places (e.g. a `tags` array shared by all routes of a group) is still written in full at every place.
 */
export function safeStringify(value: any): string {
    const ancestors: object[] = [];
    return JSON.stringify(value, function (this: any, key: string, v: any) {
        if (typeof v === 'bigint') return v.toString();
        // Original value before toJSON (Buffer.toJSON has changed to { type, data }).
        if (Buffer.isBuffer(this?.[key])) return undefined;
        if (v && typeof v === 'object') {
            // `this` is the object holding v: remove the nodes already written from the ancestor chain.
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(v)) return undefined;
            ancestors.push(v);
        }
        return v;
    });
}

export function sendJson(res: ServerResponse, status: number, payload: any, headers: Record<string, string> = {}): void {
    if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
    }
    const body = safeStringify(payload);
    res.writeHead(status, {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
    });
    res.end(body);
}

/** Read the body into a Buffer, abort the request when the limit is exceeded. */
export function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > maxBytes) {
            reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', tr('Body tối đa {{v1}} MB', { v1: Math.round(maxBytes / 1024 / 1024) })));
            req.resume();
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        req.on('data', (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > maxBytes) {
                done = true;
                reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', tr('Body tối đa {{v1}} MB', { v1: Math.round(maxBytes / 1024 / 1024) })));
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', err => {
            if (done) return;
            done = true;
            reject(err);
        });
    });
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<any> {
    const buf = await readBodyBuffer(req, maxBytes);
    if (buf.length === 0) return undefined;
    const text = buf.toString('utf8');
    try {
        return JSON.parse(text);
    } catch {
        throw new ApiError(400, 'INVALID_JSON', tr('Body không phải JSON hợp lệ'));
    }
}

export function parseQuery(search: string): Record<string, string> {
    const out: Record<string, string> = {};
    const params = new URLSearchParams(search);
    for (const [k, v] of params) {
        if (k in out) out[k] = `${out[k]},${v}`;
        else out[k] = v;
    }
    return out;
}
