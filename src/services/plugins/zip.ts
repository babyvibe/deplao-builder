/**
 * zip.ts: reads / extracts / creates ZIP files for plugin packages, no extra dependency.
 *
 * Safe when extracting files sent by others:
 *  - limits on zip size, total extracted size, number of entries, size of each entry
 *    (inflate with maxOutputLength → a zip bomb that lies about its size is also blocked);
 *  - rejects absolute paths, "..", the ":" character (Windows ADS), Windows device names,
 *    symlinks, encrypted entries, ZIP64, unusual compression methods, duplicate names (case-insensitive);
 *  - checks the CRC32 and that the write target stays inside the extraction folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { tr } from '../../shared/i18n';

export interface ZipLimits {
    maxZipBytes: number;
    maxTotalBytes: number;
    maxEntries: number;
    maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
    maxZipBytes: 50 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxEntries: 5000,
    maxEntryBytes: 100 * 1024 * 1024,
};

export class ZipError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ZipError';
    }
}

export interface ZipEntry {
    /** Normalized name: uses "/", no "..", folders end with "/". */
    name: string;
    isDirectory: boolean;
    method: number;
    compressedSize: number;
    size: number;
    crc32: number;
    localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Buffer): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** Normalizes the entry name; throws ZipError if it is not safe. */
export function normalizeEntryName(raw: string): string {
    const name = String(raw || '').replace(/\\/g, '/');
    if (!name || name.includes('\0')) throw new ZipError(tr('Tên file trong zip không hợp lệ'));
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(tr('Đường dẫn tuyệt đối trong zip: {{raw}}', { raw }));
    const isDir = name.endsWith('/');
    const parts: string[] = [];
    for (const seg of name.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') throw new ZipError(tr('Đường dẫn "..": {{raw}}', { raw }));
        if (seg.includes(':')) throw new ZipError(tr('Ký tự ":" trong tên file: {{raw}}', { raw }));
        if (WINDOWS_RESERVED.test(seg) || /[. ]$/.test(seg)) throw new ZipError(tr('Tên file không dùng được trên Windows: {{raw}}', { raw }));
        parts.push(seg);
    }
    if (!parts.length) throw new ZipError(tr('Tên file trong zip không hợp lệ'));
    return parts.join('/') + (isDir ? '/' : '');
}

function findEocd(buf: Buffer): number {
    const min = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

export function readZipEntries(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
    if (buf.length < 22) throw new ZipError(tr('File không phải zip'));
    const eocd = findEocd(buf);
    if (eocd < 0) throw new ZipError(tr('File không phải zip (thiếu end of central directory)'));
    const total = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError(tr('ZIP64 không được hỗ trợ (gói ứng dụng quá lớn)'));
    if (total > limits.maxEntries) throw new ZipError(tr('Zip có quá nhiều file ({{total}} > {{maxEntries}})', { total, maxEntries: limits.maxEntries }));
    if (cdOffset + cdSize > buf.length) throw new ZipError(tr('Zip bị hỏng (central directory)'));

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError(tr('Zip bị hỏng (entry)'));
        const madeBy = buf.readUInt16LE(p + 4);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const compressedSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const extAttr = buf.readUInt32LE(p + 38);
        const localHeaderOffset = buf.readUInt32LE(p + 42);
        const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
        p += 46 + nameLen + extraLen + commentLen;

        if (flags & 0x1) throw new ZipError(tr('File bị mã hoá trong zip: {{rawName}}', { rawName }));
        if (method !== 0 && method !== 8) throw new ZipError(tr('Kiểu nén không hỗ trợ ({{method}}): {{rawName}}', { method, rawName }));
        if ((madeBy >> 8) === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) throw new ZipError(tr('Symlink trong zip bị từ chối: {{rawName}}', { rawName }));
        if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) throw new ZipError(tr('ZIP64 không được hỗ trợ'));

        const name = normalizeEntryName(rawName);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new ZipError(tr('Tên file trùng trong zip: {{name}}', { name }));
        seen.add(key);
        const isDirectory = name.endsWith('/');
        if (size > limits.maxEntryBytes) throw new ZipError(tr('File quá lớn trong zip: {{name}}', { name }));
        totalSize += size;
        if (totalSize > limits.maxTotalBytes) throw new ZipError(tr('Giải nén vượt {{v1}} MB', { v1: Math.round(limits.maxTotalBytes / 1024 / 1024) }));
        entries.push({ name, isDirectory, method, compressedSize, size, crc32: crc, localHeaderOffset });
    }
    return entries;
}

export function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
    const off = entry.localHeaderOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOC) throw new ZipError(tr('Zip bị hỏng (local header): {{name}}', { name: entry.name }));
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipError(tr('Zip bị hỏng (dữ liệu): {{name}}', { name: entry.name }));
    const data = buf.subarray(start, end);
    let out: Buffer;
    if (entry.method === 0) {
        out = Buffer.from(data);
    } else {
        try {
            out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
        } catch {
            throw new ZipError(tr('Không giải nén được (dữ liệu hỏng hoặc khai sai kích thước): {{name}}', { name: entry.name }));
        }
    }
    if (out.length !== entry.size) throw new ZipError(tr('Sai kích thước sau giải nén: {{name}}', { name: entry.name }));
    if (crc32(out) !== entry.crc32) throw new ZipError(`Sai CRC: ${entry.name}`);
    return out;
}

/** Extracts into destDir (created if missing). Returns the file count and total bytes. */
export function extractZip(zipPath: string, destDir: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { files: number; bytes: number } {
    const st = fs.statSync(zipPath);
    if (st.size > limits.maxZipBytes) throw new ZipError(tr('File zip vượt {{v1}} MB', { v1: Math.round(limits.maxZipBytes / 1024 / 1024) }));
    const buf = fs.readFileSync(zipPath);
    const entries = readZipEntries(buf, limits);
    fs.mkdirSync(destDir, { recursive: true });
    const root = fs.realpathSync(destDir);
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
        const target = path.resolve(root, ...entry.name.split('/').filter(Boolean));
        if (target !== root && !target.startsWith(root + path.sep)) throw new ZipError(tr('Đường dẫn ra ngoài thư mục: {{name}}', { name: entry.name }));
        if (entry.isDirectory) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        const data = readEntryData(buf, entry);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { flag: 'wx' });
        files++;
        bytes += data.length;
    }
    return { files, bytes };
}

/** Creates a zip (deflate) in memory, used for packaging plugins and for tests. */
export function createZip(files: Array<{ name: string; data: Buffer | string }>, opts: { compress?: boolean } = {}): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
        const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
        const isDir = f.name.endsWith('/');
        const deflated = !isDir && opts.compress !== false ? zlib.deflateRawSync(raw) : null;
        const useDeflate = !!deflated && deflated.length < raw.length;
        const body = useDeflate ? deflated! : raw;
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOC, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(useDeflate ? 8 : 0, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(SIG_CEN, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(useDeflate ? 8 : 0, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(isDir ? 0x10 : 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
