/**
 * Decrypt a Zalo mobile message backup file (`*.db.crypt`, ZDB4.0 format - db_format = 1).
 *
 * Flow (same as `decompressAndDecryptDb_V2` in Zalo PC, checked against the reverse-engineered
 * db-cross-v4 and the docs-decrypt-db-zalo notes):
 *   1. RSA PKCS#1 v1.5 decrypts `encrypted_key` → a hex key. The AES key = the first 32 UPPERCASE HEX characters,
 *      taken as raw ASCII bytes (not hex-decoded).
 *   2. AES-256-CBC, IV = 0, each 64KB block is decrypted independently (IV reset per block).
 *   3. Plaintext: "ZDB4.0" | ... | u32 BE file count @14 | [u32 BE nameLen][name][u32 BE size]... | XZ stream
 *   4. Decompress XZ (LZMA2) → the contents of the files in table order. Each file is 1 SQLite file:
 *      `<uid>.db` (1-1 chat) or `group_<gid>.db` (group), main table `ChatContent`.
 *
 * The file tail has an unencrypted TLV footer → after decryption it becomes junk after the XZ stream, so the exact
 * end of the XZ stream (footer "YZ") must be found before it is passed to the decompressor.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { XzReadableStream } from 'xz-decompress';
import { tr } from '../../../shared/i18n';

export const ZDB_MAGIC = Buffer.from('ZDB4.0', 'ascii');
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
export const ZDB_CHUNK_SIZE = 0x10000;
const ZDB_COUNT_OFFSET = 14;
const MAX_ENTRIES = 200000;
const MAX_NAME_LEN = 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}$/;

// ─── RSA / AES key ──────────────────────────────────────────────────────────

export interface SyncKeyPair {
    /** SPKI DER base64: sent to the server in pull_mobile_msg. */
    publicKey: string;
    /** PKCS#1 PEM: kept to decrypt `encrypted_key`. */
    privateKey: string;
}

/** Generate a key pair like Zalo PC: RSA 2048, public SPKI/DER (base64), private PKCS#1/PEM. */
export function generateSyncKeyPair(): SyncKeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { publicKey: (publicKey as unknown as Buffer).toString('base64'), privateKey: String(privateKey) };
}

function b64urlToBigInt(value: string): bigint {
    return BigInt('0x' + Buffer.from(value, 'base64url').toString('hex'));
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
    }
    return result;
}

/**
 * Pure BigInt RSA PKCS#1 v1.5 (CRT): a fallback for when the runtime blocks RSA_PKCS1_PADDING for
 * privateDecrypt (CVE-2023-46809). It has no padding oracle, so it is not exposed to the Marvin attack.
 */
export function rsaDecryptPkcs1Manual(privateKeyPem: string, cipher: Buffer): Buffer {
    const jwk = crypto.createPrivateKey(privateKeyPem).export({ format: 'jwk' }) as any;
    const n = b64urlToBigInt(jwk.n);
    const p = b64urlToBigInt(jwk.p);
    const q = b64urlToBigInt(jwk.q);
    const dp = b64urlToBigInt(jwk.dp);
    const dq = b64urlToBigInt(jwk.dq);
    const qi = b64urlToBigInt(jwk.qi);
    const c = BigInt('0x' + cipher.toString('hex'));
    const m1 = modPow(c, dp, p);
    const m2 = modPow(c, dq, q);
    const h = (qi * (((m1 - m2) % p) + p)) % p;
    const m = m2 + h * q;

    const k = Math.ceil(n.toString(16).length / 2);
    const em = Buffer.from(m.toString(16).padStart(k * 2, '0'), 'hex');
    if (em[0] !== 0x00 || em[1] !== 0x02) throw new Error(tr('RSA: padding PKCS#1 không hợp lệ'));
    const sep = em.indexOf(0x00, 2);
    if (sep < 10) throw new Error(tr('RSA: padding PKCS#1 không hợp lệ'));
    return em.subarray(sep + 1);
}

export function rsaDecryptPkcs1(privateKeyPem: string, cipher: Buffer): Buffer {
    try {
        return crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, cipher);
    } catch (err: any) {
        const code = String(err?.code || '');
        const msg = String(err?.message || '');
        if (code.includes('INVALID_ARG') || /RSA_PKCS1_PADDING|security-revert|not supported/i.test(msg)) {
            return rsaDecryptPkcs1Manual(privateKeyPem, cipher);
        }
        throw err;
    }
}

/** The AES key actually used for ZDB4.0: the ASCII of the first 32 uppercase hex characters. */
export function deriveAesKey(keyHex: string): Buffer {
    const upper = keyHex.toUpperCase();
    if (upper.length < 32) throw new Error(tr('Khoá giải mã quá ngắn'));
    return Buffer.from(upper.slice(0, 32), 'ascii');
}

/** Decrypt the `encrypted_key` of the syncmsg_info event (db_format = 1 → the key comes out as hex). */
export function decryptBackupKey(privateKeyPem: string, encryptedKeyB64: string): { keyHex: string; aesKey: Buffer } {
    const raw = rsaDecryptPkcs1(privateKeyPem, Buffer.from(encryptedKeyB64, 'base64'));
    const keyHex = raw.toString('hex');
    return { keyHex, aesKey: deriveAesKey(keyHex) };
}

// ─── CRC32 (checks the XZ footer) ──────────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Find where the XZ stream ends inside `tail` (a piece of plaintext that starts at `tailOffset`).
 * XZ footer = CRC32(4, LE) | Backward Size(4) | Stream Flags(2) | "YZ"; the CRC32 is computed over the 6 bytes in the middle.
 */
export function findXzStreamEnd(tail: Buffer, tailOffset: number, xzStart: number, streamFlags: Buffer): number {
    for (let i = tail.length - 2; i >= 10; i--) {
        if (tail[i] !== 0x59 || tail[i + 1] !== 0x5a) continue; // "YZ"
        const footerStart = i - 10;
        if (tail[i - 2] !== streamFlags[0] || tail[i - 1] !== streamFlags[1]) continue;
        const end = tailOffset + i + 2;
        if ((end - xzStart) % 4 !== 0) continue;
        const stored = tail.readUInt32LE(footerStart);
        if (crc32(tail.subarray(footerStart + 4, footerStart + 10)) !== stored) continue;
        return end;
    }
    return -1;
}

// ─── Decrypt + decompress ──────────────────────────────────────────────────────

export interface ZdbEntry {
    name: string;
    size: number;
}

export interface ExtractedFile {
    name: string;
    path: string;
    size: number;
}

export interface ExtractProgress {
    processedBytes: number;
    totalBytes: number;
    filesDone: number;
    filesTotal: number;
}

export interface ExtractOptions {
    cryptPath: string;
    outDir: string;
    aesKey: Buffer;
    onProgress?: (p: ExtractProgress) => void;
    shouldAbort?: () => boolean;
}

export interface ExtractResult {
    entries: ZdbEntry[];
    files: ExtractedFile[];
    skippedEntries: string[];
}

class AbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

/** Read + decrypt individual 64KB blocks at any position (each block is independent, IV = 0). */
class ChunkReader {
    readonly chunkCount: number;
    private readonly zeroIv = Buffer.alloc(16);

    constructor(
        private readonly fh: fs.promises.FileHandle,
        private readonly start: number,
        readonly encryptedLength: number,
        private readonly key: Buffer,
    ) {
        this.chunkCount = Math.ceil(encryptedLength / ZDB_CHUNK_SIZE);
    }

    async plainChunk(index: number): Promise<Buffer> {
        const offset = index * ZDB_CHUNK_SIZE;
        const length = Math.min(ZDB_CHUNK_SIZE, this.encryptedLength - offset);
        const cipherText = Buffer.alloc(length);
        const { bytesRead } = await this.fh.read(cipherText, 0, length, this.start + offset);
        if (bytesRead !== length) throw new Error(tr('Đọc file sao lưu thiếu dữ liệu'));
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, this.zeroIv);
        decipher.setAutoPadding(false);
        return Buffer.concat([decipher.update(cipherText), decipher.final()]);
    }
}

/** Try the layouts seen so far: the ciphertext starts at byte 0 or after a 4-byte prefix. */
async function openChunkReader(fh: fs.promises.FileHandle, fileSize: number, key: Buffer): Promise<ChunkReader> {
    for (const start of [0, 4]) {
        const encryptedLength = Math.floor((fileSize - start) / 16) * 16;
        if (encryptedLength < 16) continue;
        const reader = new ChunkReader(fh, start, encryptedLength, key);
        const first = await reader.plainChunk(0);
        if (first.subarray(0, ZDB_MAGIC.length).equals(ZDB_MAGIC)) return reader;
    }
    throw new Error(tr('Sai khoá giải mã hoặc file không phải ZDB4.0 (không thấy magic "ZDB4.0")'));
}

export function parseZdbHeader(head: Buffer): { entries: ZdbEntry[]; tocEnd: number } | 'need-more' {
    if (head.length < ZDB_COUNT_OFFSET + 4) return 'need-more';
    if (!head.subarray(0, ZDB_MAGIC.length).equals(ZDB_MAGIC)) throw new Error(tr('Không phải định dạng ZDB4.0'));
    const count = head.readUInt32BE(ZDB_COUNT_OFFSET);
    if (count > MAX_ENTRIES) throw new Error(tr('Bảng file ZDB4.0 không hợp lệ ({{count}} mục)', { count }));
    let off = ZDB_COUNT_OFFSET + 4;
    const entries: ZdbEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (off + 4 > head.length) return 'need-more';
        const nameLen = head.readUInt32BE(off);
        if (nameLen === 0 || nameLen > MAX_NAME_LEN) throw new Error(tr('Tên file trong ZDB4.0 không hợp lệ'));
        if (off + 4 + nameLen + 4 > head.length) return 'need-more';
        let name = head.toString('utf8', off + 4, off + 4 + nameLen);
        name = name.replace(/\0+$/, '');
        const size = head.readUInt32BE(off + 4 + nameLen);
        entries.push({ name, size });
        off += 4 + nameLen + 4;
    }
    return { entries, tocEnd: off };
}

export function isSafeEntryName(name: string): boolean {
    return SAFE_NAME_RE.test(name) && !name.includes('..') && path.basename(name) === name;
}

/**
 * Decrypt + decompress a `.db.crypt` file into `outDir`. Only files with safe names are written;
 * data of entries with unknown names is still read through (to keep the positions right) but then discarded.
 */
export async function extractZdbBackup(opts: ExtractOptions): Promise<ExtractResult> {
    const { cryptPath, outDir, aesKey, onProgress, shouldAbort } = opts;
    const fh = await fs.promises.open(cryptPath, 'r');
    try {
        const fileSize = (await fh.stat()).size;
        const reader = await openChunkReader(fh, fileSize, aesKey);
        const checkAbort = () => {
            if (shouldAbort?.()) throw new AbortedError();
        };

        // 1. Header + file table (may span several 64KB blocks)
        let head = await reader.plainChunk(0);
        let headChunks = 1;
        let header = parseZdbHeader(head);
        while (header === 'need-more') {
            if (headChunks >= reader.chunkCount) throw new Error(tr('Bảng file ZDB4.0 bị cắt cụt'));
            head = Buffer.concat([head, await reader.plainChunk(headChunks++)]);
            header = parseZdbHeader(head);
        }
        const { entries, tocEnd } = header;

        // 2. Start of the XZ stream (right after the file table; scan a few more bytes to be safe)
        let xzStart = -1;
        const probeEnd = Math.min(head.length - XZ_MAGIC.length, tocEnd + 64);
        for (let i = tocEnd; i <= probeEnd; i++) {
            if (head.subarray(i, i + XZ_MAGIC.length).equals(XZ_MAGIC)) {
                xzStart = i;
                break;
            }
        }
        if (xzStart < 0) throw new Error(tr('Không tìm thấy dữ liệu nén XZ trong bản sao lưu'));
        if (head.length < xzStart + 12) head = Buffer.concat([head, await reader.plainChunk(headChunks++)]);
        const streamFlags = head.subarray(xzStart + 6, xzStart + 8);

        // 3. End of the XZ stream: decrypt the last 1-2 blocks separately, then scan for the footer
        const lastIdx = reader.chunkCount - 1;
        const tailStartIdx = Math.max(0, lastIdx - 1);
        const tailParts: Buffer[] = [];
        for (let i = tailStartIdx; i <= lastIdx; i++) tailParts.push(await reader.plainChunk(i));
        const tail = Buffer.concat(tailParts);
        let xzEnd = findXzStreamEnd(tail, tailStartIdx * ZDB_CHUNK_SIZE, xzStart, streamFlags);
        if (xzEnd < 0) xzEnd = reader.encryptedLength; // footer not found → leave it to the decompressor to handle

        // 4. Stream: decrypt each block → cut exactly [xzStart, xzEnd) → XZ → split into files
        await fs.promises.mkdir(outDir, { recursive: true });
        const firstChunk = Math.floor(xzStart / ZDB_CHUNK_SIZE);
        const lastChunk = Math.floor((xzEnd - 1) / ZDB_CHUNK_SIZE);
        let nextChunk = firstChunk;
        const totalBytes = xzEnd - xzStart;
        let processedBytes = 0;

        const source = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    checkAbort();
                    if (nextChunk > lastChunk) {
                        controller.close();
                        return;
                    }
                    const idx = nextChunk++;
                    const plain = await reader.plainChunk(idx);
                    const base = idx * ZDB_CHUNK_SIZE;
                    const from = Math.max(0, xzStart - base);
                    const to = Math.min(plain.length, xzEnd - base);
                    if (to > from) {
                        controller.enqueue(new Uint8Array(plain.buffer, plain.byteOffset + from, to - from));
                        processedBytes += to - from;
                    }
                } catch (err) {
                    controller.error(err);
                }
            },
        });

        const files: ExtractedFile[] = [];
        const skippedEntries: string[] = [];
        let entryIdx = 0;
        let written = 0;
        let current: fs.promises.FileHandle | null = null;

        const openNext = async () => {
            while (entryIdx < entries.length && entries[entryIdx].size === 0) entryIdx++;
            if (entryIdx >= entries.length) return;
            const entry = entries[entryIdx];
            current = null;
            if (isSafeEntryName(entry.name)) {
                current = await fs.promises.open(path.join(outDir, entry.name), 'w');
            } else {
                skippedEntries.push(entry.name);
            }
        };
        const finishCurrent = async () => {
            const entry = entries[entryIdx];
            if (current) {
                await current.close();
                files.push({ name: entry.name, path: path.join(outDir, entry.name), size: entry.size });
            }
            current = null;
            entryIdx++;
            written = 0;
            onProgress?.({ processedBytes, totalBytes, filesDone: entryIdx, filesTotal: entries.length });
            await openNext();
        };

        await openNext();
        // Read until the stream ends by itself (do not cancel midway: avoids disposing the WASM context twice).
        const xzReader = new XzReadableStream(source).getReader();
        let streamFinished = false;
        try {
            for (;;) {
                let chunk: { done: boolean; value?: Uint8Array };
                try {
                    chunk = await xzReader.read();
                } catch (err) {
                    streamFinished = true; // stream error → xz-decompress has already freed its context
                    // Junk after the XZ stream (when the footer cannot be found) only causes an error AFTER the data is complete.
                    if (entryIdx >= entries.length && !(err instanceof AbortedError)) break;
                    throw err;
                }
                if (chunk.done) {
                    streamFinished = true;
                    break;
                }
                checkAbort();
                const value = chunk.value;
                let off = 0;
                while (off < value.length && entryIdx < entries.length) {
                    const need = entries[entryIdx].size - written;
                    const take = Math.min(need, value.length - off);
                    if (current) await current.write(value, off, take);
                    written += take;
                    off += take;
                    if (written === entries[entryIdx].size) await finishCurrent();
                }
            }
        } finally {
            // Stopped midway (cancelled / file write error) → cancel so xz-decompress releases the global mutex.
            if (!streamFinished) await xzReader.cancel().catch(() => {});
            if (current) await (current as fs.promises.FileHandle).close().catch(() => {});
        }

        if (entryIdx < entries.length) {
            throw new Error(tr('Giải nén không đủ dữ liệu ({{entryIdx}}/{{count}} file)', { entryIdx, count: entries.length }));
        }
        onProgress?.({ processedBytes: totalBytes, totalBytes, filesDone: entries.length, filesTotal: entries.length });
        return { entries, files, skippedEntries };
    } finally {
        await fh.close().catch(() => {});
    }
}

export async function isSqliteFile(filePath: string): Promise<boolean> {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(16);
        const { bytesRead } = await fh.read(buf, 0, 16, 0);
        return bytesRead === 16 && buf.equals(SQLITE_MAGIC);
    } finally {
        await fh.close();
    }
}

/** Match the checksum_code of the event against the downloaded file (md5 or sha256, case-insensitive). */
export async function verifyChecksum(filePath: string, checksum: string | undefined): Promise<boolean | null> {
    const expected = String(checksum || '').trim().toLowerCase();
    if (!expected) return null;
    const algos = expected.length === 32 ? ['md5'] : expected.length === 64 ? ['sha256'] : [];
    if (algos.length === 0) return null;
    for (const algo of algos) {
        const hash = crypto.createHash(algo);
        await new Promise<void>((resolve, reject) => {
            fs.createReadStream(filePath)
                .on('data', chunk => hash.update(chunk))
                .on('end', () => resolve())
                .on('error', reject);
        });
        if (hash.digest('hex') === expected) return true;
    }
    return false;
}
