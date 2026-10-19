/**
 * zip.ts — đọc / giải nén / tạo ZIP cho gói plugin, không thêm dependency.
 *
 * An toàn khi giải nén file do người khác gửi:
 *  - giới hạn dung lượng zip, tổng dung lượng giải nén, số entry, dung lượng mỗi entry
 *    (inflate có maxOutputLength → zip bomb khai man kích thước cũng bị chặn);
 *  - từ chối đường dẫn tuyệt đối, "..", ký tự ":" (ADS Windows), tên thiết bị Windows,
 *    symlink, entry mã hoá, ZIP64, phương thức nén lạ, tên trùng (không phân biệt hoa thường);
 *  - kiểm tra CRC32 và đích ghi nằm trong thư mục giải nén.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

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
    /** Tên đã chuẩn hoá: dùng "/", không có "..", thư mục kết thúc bằng "/". */
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

/** Chuẩn hoá tên entry; ném ZipError nếu không an toàn. */
export function normalizeEntryName(raw: string): string {
    const name = String(raw || '').replace(/\\/g, '/');
    if (!name || name.includes('\0')) throw new ZipError('Tên file trong zip không hợp lệ');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(`Đường dẫn tuyệt đối trong zip: ${raw}`);
    const isDir = name.endsWith('/');
    const parts: string[] = [];
    for (const seg of name.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') throw new ZipError(`Đường dẫn "..": ${raw}`);
        if (seg.includes(':')) throw new ZipError(`Ký tự ":" trong tên file: ${raw}`);
        if (WINDOWS_RESERVED.test(seg) || /[. ]$/.test(seg)) throw new ZipError(`Tên file không dùng được trên Windows: ${raw}`);
        parts.push(seg);
    }
    if (!parts.length) throw new ZipError('Tên file trong zip không hợp lệ');
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
    if (buf.length < 22) throw new ZipError('File không phải zip');
    const eocd = findEocd(buf);
    if (eocd < 0) throw new ZipError('File không phải zip (thiếu end of central directory)');
    const total = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64 không được hỗ trợ (gói ứng dụng quá lớn)');
    if (total > limits.maxEntries) throw new ZipError(`Zip có quá nhiều file (${total} > ${limits.maxEntries})`);
    if (cdOffset + cdSize > buf.length) throw new ZipError('Zip bị hỏng (central directory)');

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError('Zip bị hỏng (entry)');
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

        if (flags & 0x1) throw new ZipError(`File bị mã hoá trong zip: ${rawName}`);
        if (method !== 0 && method !== 8) throw new ZipError(`Kiểu nén không hỗ trợ (${method}): ${rawName}`);
        if ((madeBy >> 8) === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) throw new ZipError(`Symlink trong zip bị từ chối: ${rawName}`);
        if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) throw new ZipError('ZIP64 không được hỗ trợ');

        const name = normalizeEntryName(rawName);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new ZipError(`Tên file trùng trong zip: ${name}`);
        seen.add(key);
        const isDirectory = name.endsWith('/');
        if (size > limits.maxEntryBytes) throw new ZipError(`File quá lớn trong zip: ${name}`);
        totalSize += size;
        if (totalSize > limits.maxTotalBytes) throw new ZipError(`Giải nén vượt ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`);
        entries.push({ name, isDirectory, method, compressedSize, size, crc32: crc, localHeaderOffset });
    }
    return entries;
}

export function readEntryData(buf: Buffer, entry: ZipEntry): Buffer {
    const off = entry.localHeaderOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOC) throw new ZipError(`Zip bị hỏng (local header): ${entry.name}`);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipError(`Zip bị hỏng (dữ liệu): ${entry.name}`);
    const data = buf.subarray(start, end);
    let out: Buffer;
    if (entry.method === 0) {
        out = Buffer.from(data);
    } else {
        try {
            out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
        } catch {
            throw new ZipError(`Không giải nén được (dữ liệu hỏng hoặc khai sai kích thước): ${entry.name}`);
        }
    }
    if (out.length !== entry.size) throw new ZipError(`Sai kích thước sau giải nén: ${entry.name}`);
    if (crc32(out) !== entry.crc32) throw new ZipError(`Sai CRC: ${entry.name}`);
    return out;
}

/** Giải nén vào destDir (tạo nếu chưa có). Trả số file và tổng byte. */
export function extractZip(zipPath: string, destDir: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { files: number; bytes: number } {
    const st = fs.statSync(zipPath);
    if (st.size > limits.maxZipBytes) throw new ZipError(`File zip vượt ${Math.round(limits.maxZipBytes / 1024 / 1024)} MB`);
    const buf = fs.readFileSync(zipPath);
    const entries = readZipEntries(buf, limits);
    fs.mkdirSync(destDir, { recursive: true });
    const root = fs.realpathSync(destDir);
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
        const target = path.resolve(root, ...entry.name.split('/').filter(Boolean));
        if (target !== root && !target.startsWith(root + path.sep)) throw new ZipError(`Đường dẫn ra ngoài thư mục: ${entry.name}`);
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

/** Tạo zip (deflate) trong bộ nhớ — dùng cho đóng gói plugin và test. */
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
