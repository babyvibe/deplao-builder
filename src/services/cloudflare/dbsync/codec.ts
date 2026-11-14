/**
 * codec: encodes SQLite values as JSON (one JSONL line of a change segment) and back, keeping the exact storage class.
 *
 * Source rows are read in BigInt mode (SqlConn.prepare(…, { bigInts: true })), so:
 *   INTEGER  → bigint  → a plain JSON number (within ±2^53) or {"$big": "…"}
 *   REAL     → number  → a plain JSON number when it has a fraction; {"$r": n} when whole (1.0), so it is still REAL after applying; ±Inf → {"$inf": ±1}
 *   TEXT     → string
 *   BLOB     → {"$b64": "…"}
 *   NULL     → null
 * When applying: a whole JSON number → bind as BigInt (stored as INTEGER), a fractional number / $r → bind as double (stored as REAL).
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export type EncodedValue =
    | null
    | number
    | string
    | { $b64: string }
    | { $big: string }
    | { $r: number }
    | { $inf: 1 | -1 };

export type BindValue = null | number | bigint | string | Buffer;

export function encodeValue(v: unknown): EncodedValue {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : { $big: v.toString() };
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return null; // SQLite stores NaN as NULL
        if (!Number.isFinite(v)) return { $inf: v > 0 ? 1 : -1 };
        return Number.isInteger(v) ? { $r: v } : v;
    }
    if (typeof v === 'string') return v;
    if (v instanceof Uint8Array) return { $b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    if (typeof v === 'boolean') return v ? 1 : 0;
    return String(v);
}

export function decodeValue(v: unknown): BindValue {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.$b64 === 'string') return Buffer.from(o.$b64, 'base64');
        if (typeof o.$big === 'string') return BigInt(o.$big);
        if (typeof o.$r === 'number') return o.$r;
        if (o.$inf === 1) return Infinity;
        if (o.$inf === -1) return -Infinity;
    }
    throw new Error('Giá trị không hợp lệ trong đoạn thay đổi');
}

/** A row read in BigInt mode → object {column: encoded value}, in the exact column list order. */
export function encodeRow(row: Record<string, unknown>, columns: string[]): Record<string, EncodedValue> {
    const out: Record<string, EncodedValue> = {};
    for (const c of columns) out[c] = encodeValue(row[c]);
    return out;
}

/** rowid/id as a JS number when it is safe (most cases): used for the header, the _cloud_dirty marks… */
export function safeInt(v: unknown): number {
    if (typeof v === 'bigint') {
        if (v > MAX_SAFE || v < MIN_SAFE) throw new Error('Số nguyên vượt giới hạn an toàn');
        return Number(v);
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('Không phải số');
    return n;
}
