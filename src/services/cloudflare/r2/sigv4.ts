/**
 * sigv4: signs AWS Signature Version 4 (the Authorization header and presigned URLs) for R2 (S3 API).
 * Written in-house, no AWS SDK. Matches the test vectors in the AWS docs (src/__tests__/cloudflare/sigv4.test.ts).
 *
 * Conventions:
 *  - `path` is ALREADY in canonical encoding (canonical URI) and is used exactly as is, both for the URL sent and for the signing string
 *    (S3 encodes each segment ONCE, keeping '/': use uriEncodePath()).
 *  - Signed headers = host + x-amz-date (+ x-amz-security-token) + every header passed in (lowercase names).
 *  - The query string sent should be exactly the `canonicalQuery` returned, so that the URL and the signature match.
 */
import { createHash, createHmac } from 'crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** sha256(''): empty payload (GET/HEAD/DELETE). */
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
    /** Canonical URI (already encoded), e.g. '/bucket/a%20b.jpg'. */
    path: string;
    query?: SigV4Query;
    /** Headers to sign (host is added automatically, no need to pass it). */
    headers?: Record<string, string | number | undefined | null>;
    /** sha256 hex of the body, or 'UNSIGNED-PAYLOAD'. */
    payloadHash: string;
    region: string;
    service: string;
    /** Date or a string 'YYYYMMDDTHHMMSSZ'. */
    date: Date | string;
}

export interface SignedRequest {
    /** Headers to send with the request (authorization, x-amz-date and the signed headers; NOT host: fetch sets it itself). */
    headers: Record<string, string>;
    authorization: string;
    signature: string;
    signedHeaders: string;
    amzDate: string;
    /** Normalized query: used as the query of the URL sent. */
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
    /** Extra headers signed besides host (whoever uses the URL must send exactly these headers). */
    headers?: Record<string, string>;
    /** Default 'UNSIGNED-PAYLOAD'. */
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
 * URI-encode per SigV4 (RFC 3986): keeps A-Z a-z 0-9 - _ . ~, everything else becomes %XX (uppercase, per UTF-8 byte).
 * encodeSlash=false keeps '/' as is.
 */
export function uriEncode(input: string, encodeSlash = true): string {
    const encoded = encodeURIComponent(input).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

/** S3 key → canonical path: each segment encoded once, '/' kept. */
export function uriEncodePath(p: string): string {
    return p.split('/').map(seg => uriEncode(seg)).join('/');
}

/** Canonical query: encodes keys + values, sorts by key then value (byte order), drops undefined / null values. */
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

/** Signs the request with the Authorization header. */
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

/** Presigned URL (the signature is in the query, X-Amz-Expires in seconds). */
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
