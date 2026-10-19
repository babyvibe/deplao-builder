/**
 * sigv4 — ký AWS Signature Version 4 (header Authorization và URL ký sẵn) cho R2 (S3 API).
 * Tự viết, không dùng AWS SDK. Khớp test vector trong tài liệu AWS (src/__tests__/cloudflare/sigv4.test.ts).
 *
 * Quy ước:
 *  - `path` là đường dẫn ĐÃ mã hoá chuẩn (canonical URI) và được dùng y nguyên cho cả URL gửi đi lẫn chuỗi ký
 *    (S3 mã hoá MỘT lần từng đoạn, giữ '/': dùng uriEncodePath()).
 *  - Header được ký = host + x-amz-date (+ x-amz-security-token) + mọi header truyền vào (tên viết thường).
 *  - Chuỗi query gửi đi nên dùng đúng `canonicalQuery` trả về để URL và chữ ký khớp nhau.
 */
import { createHash, createHmac } from 'crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** sha256('') — payload rỗng (GET/HEAD/DELETE). */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

export type SigV4QueryValue = string | number | boolean | undefined | null;
export type SigV4Query = Record<string, SigV4QueryValue> | Array<[string, string]>;

export interface SigV4Request {
    method: string;
    host: string;
    /** Canonical URI (đã mã hoá), vd '/bucket/a%20b.jpg'. */
    path: string;
    query?: SigV4Query;
    /** Header cần ký (host tự thêm, không cần truyền). */
    headers?: Record<string, string | number | undefined | null>;
    /** sha256 hex của body, hoặc 'UNSIGNED-PAYLOAD'. */
    payloadHash: string;
    region: string;
    service: string;
    /** Date hoặc chuỗi 'YYYYMMDDTHHMMSSZ'. */
    date: Date | string;
}

export interface SignedRequest {
    /** Header phải gửi kèm (gồm authorization, x-amz-date và các header đã ký; KHÔNG gồm host — fetch tự đặt). */
    headers: Record<string, string>;
    authorization: string;
    signature: string;
    signedHeaders: string;
    amzDate: string;
    /** Query đã chuẩn hoá — dùng làm query của URL gửi đi. */
    canonicalQuery: string;
    canonicalRequest: string;
    stringToSign: string;
}

export interface PresignRequest {
    method: string;
    host: string;
    path: string;
    query?: Record<string, SigV4QueryValue>;
    region: string;
    service: string;
    date: Date | string;
    expiresSec: number;
    /** Header ký thêm ngoài host (người dùng URL phải gửi đúng các header này). */
    headers?: Record<string, string>;
    /** Mặc định 'UNSIGNED-PAYLOAD'. */
    payloadHash?: string;
    protocol?: 'https' | 'http';
}

export function sha256Hex(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
    return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** 'YYYYMMDDTHHMMSSZ' (UTC). */
export function toAmzDate(date: Date | string): string {
    if (typeof date === 'string') {
        if (/^\d{8}T\d{6}Z$/.test(date)) return date;
        date = new Date(date);
    }
    if (Number.isNaN(date.getTime())) throw new Error('SigV4: ngày ký không hợp lệ');
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * URI-encode theo SigV4 (RFC 3986): giữ A-Z a-z 0-9 - _ . ~, còn lại %XX (chữ hoa, theo byte UTF-8).
 * encodeSlash=false giữ nguyên '/'.
 */
export function uriEncode(input: string, encodeSlash = true): string {
    const encoded = encodeURIComponent(input).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

/** Khoá S3 → đường dẫn chuẩn: mã hoá từng đoạn một lần, giữ '/'. */
export function uriEncodePath(p: string): string {
    return p.split('/').map(seg => uriEncode(seg)).join('/');
}

/** Query chuẩn: mã hoá khoá + giá trị, sắp theo khoá rồi giá trị (thứ tự byte), bỏ giá trị undefined/null. */
export function canonicalQueryString(query?: SigV4Query): string {
    if (!query) return '';
    const entries: Array<[string, SigV4QueryValue]> = Array.isArray(query) ? query : Object.entries(query);
    const pairs: Array<[string, string]> = [];
    for (const [k, v] of entries) {
        if (v === undefined || v === null) continue;
        pairs.push([uriEncode(String(k)), uriEncode(String(v))]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) {
        const key = name.trim().toLowerCase();
        const v = String(value).trim().replace(/\s+/g, ' ');
        map.set(key, map.has(key) ? `${map.get(key)},${v}` : v);
    }
    const names = Array.from(map.keys()).sort();
    return {
        canonical: names.map(n => `${n}:${map.get(n)}\n`).join(''),
        signed: names.join(';'),
    };
}

export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

function lowerHeaders(headers?: Record<string, string | number | undefined | null>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
        if (v === undefined || v === null) continue;
        out[k.toLowerCase()] = String(v);
    }
    return out;
}

/** Ký request bằng header Authorization. */
export function signRequest(req: SigV4Request, creds: SigV4Credentials): SignedRequest {
    const amzDate = toAmzDate(req.date);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;

    const headers = lowerHeaders(req.headers);
    delete headers.host;
    delete headers.authorization;
    headers['x-amz-date'] = amzDate;
    if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

    const { canonical, signed } = canonicalHeaders({ ...headers, host: req.host });
    const canonicalQuery = canonicalQueryString(req.query);
    const canonicalRequest = [
        req.method.toUpperCase(),
        req.path || '/',
        canonicalQuery,
        canonical,
        signed,
        req.payloadHash,
    ].join('\n');
    const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(creds.secretAccessKey, dateStamp, req.region, req.service))
        .update(stringToSign, 'utf8')
        .digest('hex');
    const authorization = `${SIGV4_ALGORITHM} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;

    return {
        headers: { ...headers, authorization },
        authorization,
        signature,
        signedHeaders: signed,
        amzDate,
        canonicalQuery,
        canonicalRequest,
        stringToSign,
    };
}

/** URL ký sẵn (chữ ký nằm trong query, X-Amz-Expires giây). */
export function presignUrl(req: PresignRequest, creds: SigV4Credentials): string {
    const amzDate = toAmzDate(req.date);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;

    const headers = lowerHeaders(req.headers);
    delete headers.host;
    const { canonical, signed } = canonicalHeaders({ ...headers, host: req.host });

    const query: Record<string, SigV4QueryValue> = {
        ...(req.query || {}),
        'X-Amz-Algorithm': SIGV4_ALGORITHM,
        'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(Math.floor(req.expiresSec)),
        'X-Amz-SignedHeaders': signed,
    };
    if (creds.sessionToken) query['X-Amz-Security-Token'] = creds.sessionToken;
    const canonicalQuery = canonicalQueryString(query);

    const canonicalRequest = [
        req.method.toUpperCase(),
        req.path || '/',
        canonicalQuery,
        canonical,
        signed,
        req.payloadHash || UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(creds.secretAccessKey, dateStamp, req.region, req.service))
        .update(stringToSign, 'utf8')
        .digest('hex');

    return `${req.protocol || 'https'}://${req.host}${req.path || '/'}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
