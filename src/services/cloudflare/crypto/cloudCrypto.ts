/**
 * cloudCrypto: on-machine encryption for the DB backup uploaded to R2, format "DPLC1".
 *
 * 64-byte header:
 *   0  5  magic 'DPLC1'            25 1  scrypt r (8)
 *   5  1  version (1)              26 1  scrypt p (1)
 *   6  1  header length (64)       27 1  (reserved, 0)
 *   7  1  flags (0)                28 4  chunkSize (uint32 BE, 1 MiB)
 *   8  16 salt                     32 8  nonce prefix (random, used for every block of the file)
 *   24 1  log2(N) scrypt (15)      40 16 key-check = HMAC-SHA256(key, 'DPLC1/key-check')[0..16]
 *                                  56 8  (reserved, 0)
 * After the header come the AES-256-GCM blocks: nonce 12B (= 8B nonce prefix + 4B block number BE) ‖ ciphertext ‖ tag 16B.
 * Every block except the last holds exactly chunkSize plain bytes; the last block holds 0..chunkSize bytes (an empty file = one empty block).
 * AAD of a block = the 64B header ‖ block number (uint32 BE) ‖ final flag (1 byte) → editing the header, swapping or dropping blocks, or truncating
 * at a block boundary is detected (the real last block is encrypted with final=1).
 * Key = scrypt(passphrase NFC, salt, N=2^15, r=8, p=1, 32 bytes). key-check tells you right away from the header if the password is wrong.
 *
 * The file is processed as a stream (2 blocks in RAM), written to a temp file then renamed → never leaves a half-written file or unverified plaintext.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { CloudCrypto, CloudError } from '../contracts';
import { tr } from '../../../shared/i18n';

export const DPLC1_MAGIC = Buffer.from('DPLC1', 'ascii');
export const DPLC1_VERSION = 1;
export const DPLC1_HEADER_BYTES = 64;
export const DPLC1_CHUNK_SIZE = 1024 * 1024;
export const DPLC1_NONCE_BYTES = 12;
export const DPLC1_TAG_BYTES = 16;
/** The first bytes of the file are enough for all the checks at the start of the file (header + first block). verifyPassphrase only needs the 64-byte header. */
export const DPLC1_HEAD_BYTES = DPLC1_HEADER_BYTES + DPLC1_NONCE_BYTES + DPLC1_CHUNK_SIZE + DPLC1_TAG_BYTES;

const KEY_CHECK_LABEL = 'DPLC1/key-check';
const DEFAULT_LOG2N = 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

export interface CloudCryptoOptions {
    /** scrypt parameters used when ENCRYPTING (decryption always reads them from the header). Default 15 / 8 / 1. */
    log2N?: number;
    r?: number;
    p?: number;
    /** Block size when encrypting (default 1 MiB). */
    chunkSize?: number;
    /** Number of keys cached in RAM (default 16). */
    maxCachedKeys?: number;
}

interface KdfParams { log2N: number; r: number; p: number }

interface ParsedHeader extends KdfParams {
    raw: Buffer;
    salt: Buffer;
    chunkSize: number;
    noncePrefix: Buffer;
    keyCheck: Buffer;
}

function formatError(msg = tr('Không phải file sao lưu Deplao (DPLC1) hoặc file đã hỏng')): CloudError {
    return new CloudError('CRYPTO_FORMAT', msg);
}

function corruptError(msg = tr('Dữ liệu sao lưu bị hỏng, bị sửa hoặc bị cắt cụt')): CloudError {
    return new CloudError('CRYPTO_CORRUPT', msg);
}

function badPassphrase(): CloudError {
    return new CloudError('BAD_PASSPHRASE', tr('Sai mật khẩu sao lưu'));
}

function normalizePassphrase(passphrase: string): string {
    if (typeof passphrase !== 'string' || passphrase.length === 0) throw new CloudError('BAD_PASSPHRASE', tr('Chưa nhập mật khẩu sao lưu'));
    // Vietnamese: the input method may produce precomposed or combined forms → normalize to NFC so every machine derives the same key.
    return passphrase.normalize('NFC');
}

function keyCheckOf(key: Buffer): Buffer {
    return createHmac('sha256', key).update(KEY_CHECK_LABEL, 'utf8').digest().subarray(0, 16);
}

function buildHeader(salt: Buffer, params: KdfParams, chunkSize: number, noncePrefix: Buffer, keyCheck: Buffer): Buffer {
    const h = Buffer.alloc(DPLC1_HEADER_BYTES, 0);
    DPLC1_MAGIC.copy(h, 0);
    h[5] = DPLC1_VERSION;
    h[6] = DPLC1_HEADER_BYTES;
    h[7] = 0;
    salt.copy(h, 8);
    h[24] = params.log2N;
    h[25] = params.r;
    h[26] = params.p;
    h.writeUInt32BE(chunkSize, 28);
    noncePrefix.copy(h, 32);
    keyCheck.copy(h, 40);
    return h;
}

export function parseDplc1Header(buf: Buffer): ParsedHeader {
    if (!Buffer.isBuffer(buf) || buf.length < DPLC1_HEADER_BYTES) throw formatError();
    if (!buf.subarray(0, 5).equals(DPLC1_MAGIC)) throw formatError();
    if (buf[5] !== DPLC1_VERSION) throw formatError(tr('File sao lưu dùng định dạng DPLC1 phiên bản {{v1}} — hãy cập nhật Deplao', { v1: buf[5] }));
    if (buf[6] !== DPLC1_HEADER_BYTES) throw formatError();
    const log2N = buf[24];
    const r = buf[25];
    const p = buf[26];
    const chunkSize = buf.readUInt32BE(28);
    // Parameter limits: an unknown file must not make the machine allocate too much RAM.
    if (log2N < 10 || log2N > 20 || r < 1 || r > 32 || p < 1 || p > 16 || 128 * 2 ** log2N * r * p > 256 * 1024 * 1024) throw formatError();
    if (chunkSize < 1024 || chunkSize > 64 * 1024 * 1024) throw formatError();
    const raw = Buffer.from(buf.subarray(0, DPLC1_HEADER_BYTES));
    return {
        raw,
        salt: raw.subarray(8, 24),
        log2N,
        r,
        p,
        chunkSize,
        noncePrefix: raw.subarray(32, 40),
        keyCheck: raw.subarray(40, 56),
    };
}

function aad(header: Buffer, index: number, final: boolean): Buffer {
    const tail = Buffer.alloc(5);
    tail.writeUInt32BE(index >>> 0, 0);
    tail[4] = final ? 1 : 0;
    return Buffer.concat([header, tail]);
}

function sealBlock(key: Buffer, header: Buffer, noncePrefix: Buffer, index: number, plain: Buffer, final: boolean): Buffer {
    if (index > 0xffffffff) throw new CloudError('CRYPTO_TOO_LARGE', tr('File quá lớn để mã hoá'));
    const nonce = Buffer.alloc(DPLC1_NONCE_BYTES);
    noncePrefix.copy(nonce, 0);
    nonce.writeUInt32BE(index >>> 0, 8);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: DPLC1_TAG_BYTES });
    cipher.setAAD(aad(header, index, final));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function openBlock(key: Buffer, h: ParsedHeader, index: number, block: Buffer, final: boolean): Buffer {
    if (block.length < DPLC1_NONCE_BYTES + DPLC1_TAG_BYTES) throw corruptError(tr('Dữ liệu sao lưu bị cắt cụt'));
    if (block.length > DPLC1_NONCE_BYTES + h.chunkSize + DPLC1_TAG_BYTES) throw corruptError();
    const nonce = block.subarray(0, DPLC1_NONCE_BYTES);
    if (!nonce.subarray(0, 8).equals(h.noncePrefix) || nonce.readUInt32BE(8) !== (index >>> 0)) throw corruptError();
    const tag = block.subarray(block.length - DPLC1_TAG_BYTES);
    const ct = block.subarray(DPLC1_NONCE_BYTES, block.length - DPLC1_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: DPLC1_TAG_BYTES });
    decipher.setAAD(aad(h.raw, index, final));
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
        throw corruptError();
    }
}

/** Read until `size` bytes are collected or the file ends. */
async function readFull(fh: fs.promises.FileHandle, size: number): Promise<Buffer> {
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, null);
        if (bytesRead === 0) break;
        off += bytesRead;
    }
    return off === size ? buf : buf.subarray(0, off);
}

async function writeAll(fh: fs.promises.FileHandle, buf: Buffer): Promise<void> {
    let off = 0;
    while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
        if (bytesWritten <= 0) throw new Error('write returned 0 bytes');
        off += bytesWritten;
    }
}

async function renameReplace(from: string, to: string): Promise<void> {
    for (let i = 0; ; i++) {
        try {
            await fs.promises.rename(from, to);
            return;
        } catch (err: any) {
            if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
            await new Promise(r => setTimeout(r, 100 * (i + 1)));
        }
    }
}

function tmpPathFor(dst: string): string {
    return `${dst}.tmp-${randomBytes(4).toString('hex')}`;
}

export class CloudCryptoImpl implements CloudCrypto {
    private readonly encParams: KdfParams;
    private readonly chunkSize: number;
    private readonly maxCachedKeys: number;
    /** Derived keys, cached under sha256(salt ‖ parameters ‖ password), kept in RAM only. */
    private readonly keyCache = new Map<string, Buffer>();
    private readonly pending = new Map<string, Promise<Buffer>>();
    /** Salt used when encrypting: one salt per password for the lifetime of the process (avoids running scrypt for every file). */
    private readonly encSalts = new Map<string, Buffer>();

    constructor(opts: CloudCryptoOptions = {}) {
        this.encParams = { log2N: opts.log2N ?? DEFAULT_LOG2N, r: opts.r ?? DEFAULT_R, p: opts.p ?? DEFAULT_P };
        this.chunkSize = opts.chunkSize ?? DPLC1_CHUNK_SIZE;
        this.maxCachedKeys = opts.maxCachedKeys ?? 16;
        if (this.chunkSize < 1024 || this.chunkSize > 64 * 1024 * 1024) throw new Error(tr('cloudCrypto: chunkSize ngoài khoảng 1 KiB – 64 MiB'));
    }

    async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
        return this.derive(passphrase, salt, { log2N: DEFAULT_LOG2N, r: DEFAULT_R, p: DEFAULT_P });
    }

    async encryptBuffer(plain: Buffer, passphrase: string): Promise<Buffer> {
        const { header, key, noncePrefix } = await this.newHeader(passphrase);
        const parts: Buffer[] = [header];
        const count = Math.max(1, Math.ceil(plain.length / this.chunkSize));
        for (let i = 0; i < count; i++) {
            const start = i * this.chunkSize;
            const piece = plain.subarray(start, Math.min(plain.length, start + this.chunkSize));
            parts.push(sealBlock(key, header, noncePrefix, i, piece, i === count - 1));
        }
        return Buffer.concat(parts);
    }

    async decryptBuffer(cipher: Buffer, passphrase: string): Promise<Buffer> {
        const h = parseDplc1Header(cipher);
        const key = await this.keyFor(h, passphrase);
        const blockSize = DPLC1_NONCE_BYTES + h.chunkSize + DPLC1_TAG_BYTES;
        if (cipher.length - DPLC1_HEADER_BYTES < DPLC1_NONCE_BYTES + DPLC1_TAG_BYTES) throw corruptError(tr('Dữ liệu sao lưu bị cắt cụt'));
        const out: Buffer[] = [];
        let off = DPLC1_HEADER_BYTES;
        for (let index = 0; off < cipher.length; index++) {
            const remaining = cipher.length - off;
            const len = Math.min(blockSize, remaining);
            out.push(openBlock(key, h, index, cipher.subarray(off, off + len), remaining <= blockSize));
            off += len;
        }
        return Buffer.concat(out);
    }

    /** bytes = number of bytes written to dstPath (ciphertext). */
    async encryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }> {
        const { header, key, noncePrefix } = await this.newHeader(passphrase);
        await fs.promises.mkdir(path.dirname(dstPath), { recursive: true });
        const tmp = tmpPathFor(dstPath);
        const input = await fs.promises.open(srcPath, 'r');
        let output: fs.promises.FileHandle | null = null;
        let written = 0;
        try {
            output = await fs.promises.open(tmp, 'w');
            await writeAll(output, header);
            written += header.length;
            let cur = await readFull(input, this.chunkSize);
            for (let index = 0; ; index++) {
                let next: Buffer | null = null;
                if (cur.length === this.chunkSize) {
                    const n = await readFull(input, this.chunkSize);
                    next = n.length > 0 ? n : null;
                }
                const final = next === null;
                const block = sealBlock(key, header, noncePrefix, index, cur, final);
                await writeAll(output, block);
                written += block.length;
                if (final) break;
                cur = next as Buffer;
            }
            await output.sync();
            await output.close();
            output = null;
            await input.close();
            await renameReplace(tmp, dstPath);
            return { bytes: written };
        } catch (err) {
            if (output) await output.close().catch(() => undefined);
            await input.close().catch(() => undefined);
            await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /** bytes = number of plain bytes written to dstPath. dstPath is only replaced once the WHOLE file has been verified. */
    async decryptFile(srcPath: string, dstPath: string, passphrase: string): Promise<{ bytes: number }> {
        const input = await fs.promises.open(srcPath, 'r');
        let output: fs.promises.FileHandle | null = null;
        let tmp: string | null = null;
        let written = 0;
        try {
            const h = parseDplc1Header(await readFull(input, DPLC1_HEADER_BYTES));
            const key = await this.keyFor(h, passphrase);
            const blockSize = DPLC1_NONCE_BYTES + h.chunkSize + DPLC1_TAG_BYTES;
            await fs.promises.mkdir(path.dirname(dstPath), { recursive: true });
            tmp = tmpPathFor(dstPath);
            output = await fs.promises.open(tmp, 'w');
            let cur = await readFull(input, blockSize);
            if (cur.length < DPLC1_NONCE_BYTES + DPLC1_TAG_BYTES) throw corruptError(tr('Dữ liệu sao lưu bị cắt cụt'));
            for (let index = 0; ; index++) {
                let next: Buffer | null = null;
                if (cur.length === blockSize) {
                    const n = await readFull(input, blockSize);
                    next = n.length > 0 ? n : null;
                }
                const final = next === null;
                const plain = openBlock(key, h, index, cur, final);
                await writeAll(output, plain);
                written += plain.length;
                if (final) break;
                cur = next as Buffer;
            }
            await output.sync();
            await output.close();
            output = null;
            await input.close();
            await renameReplace(tmp, dstPath);
            return { bytes: written };
        } catch (err) {
            if (output) await output.close().catch(() => undefined);
            await input.close().catch(() => undefined);
            if (tmp) await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /** Is the password correct? Only the first 64+ bytes are needed (the header has the key-check). Not a DPLC1 file → false. */
    async verifyPassphrase(cipherHead: Buffer, passphrase: string): Promise<boolean> {
        let h: ParsedHeader;
        try {
            h = parseDplc1Header(cipherHead);
        } catch {
            return false;
        }
        if (typeof passphrase !== 'string' || !passphrase) return false;
        const key = await this.derive(passphrase, h.salt, h);
        return timingSafeEqual(keyCheckOf(key), h.keyCheck);
    }

    // ── internal ──

    private async keyFor(h: ParsedHeader, passphrase: string): Promise<Buffer> {
        const key = await this.derive(passphrase, h.salt, h);
        if (!timingSafeEqual(keyCheckOf(key), h.keyCheck)) throw badPassphrase();
        return key;
    }

    private async newHeader(passphrase: string): Promise<{ header: Buffer; key: Buffer; noncePrefix: Buffer }> {
        const norm = normalizePassphrase(passphrase);
        const saltId = createHash('sha256').update('DPLC1/enc-salt\0', 'utf8').update(norm, 'utf8').digest('hex');
        let salt = this.encSalts.get(saltId);
        if (!salt) {
            salt = randomBytes(16);
            this.encSalts.set(saltId, salt);
            if (this.encSalts.size > this.maxCachedKeys) this.encSalts.delete(this.encSalts.keys().next().value as string);
        }
        const key = await this.derive(norm, salt, this.encParams);
        const noncePrefix = randomBytes(8);
        return { header: buildHeader(salt, this.encParams, this.chunkSize, noncePrefix, keyCheckOf(key)), key, noncePrefix };
    }

    private derive(passphrase: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
        const norm = normalizePassphrase(passphrase);
        if (!Buffer.isBuffer(salt) || salt.length < 8) return Promise.reject(formatError(tr('Salt không hợp lệ')));
        const cacheId = createHash('sha256')
            .update(salt)
            .update(Buffer.from([params.log2N, params.r, params.p]))
            .update(norm, 'utf8')
            .digest('hex');
        const hit = this.keyCache.get(cacheId);
        if (hit) {
            this.keyCache.delete(cacheId);
            this.keyCache.set(cacheId, hit);
            return Promise.resolve(hit);
        }
        const inflight = this.pending.get(cacheId);
        if (inflight) return inflight;
        const N = 2 ** params.log2N;
        // OpenSSL needs ~128·N·r + 128·r·p bytes; Node's default maxmem of 32 MiB is not enough for N=2^15, r=8.
        const maxmem = 128 * N * params.r * (params.p + 1) + 16 * 1024 * 1024;
        const promise = new Promise<Buffer>((resolve, reject) => {
            scrypt(norm, salt, 32, { N, r: params.r, p: params.p, maxmem }, (err, key) => {
                if (err) reject(new CloudError('CRYPTO_KDF', tr('Không sinh được khoá từ mật khẩu: {{message}}', { message: err.message })));
                else resolve(key);
            });
        }).then(key => {
            this.keyCache.set(cacheId, key);
            while (this.keyCache.size > this.maxCachedKeys) this.keyCache.delete(this.keyCache.keys().next().value as string);
            return key;
        }).finally(() => {
            this.pending.delete(cacheId);
        });
        this.pending.set(cacheId, promise);
        return promise;
    }
}

export const cloudCrypto: CloudCrypto = new CloudCryptoImpl();
