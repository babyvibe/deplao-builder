/**
 * Parser cột `ChatContent.BinNet` trong file đồng bộ tin nhắn từ Zalo mobile.
 *
 * BinNet là một `tlv::TlvBox` (thư viện Jhuster/TLV, bản Zalo chỉnh thành multimap):
 *   lặp [u32 BE type][u32 BE length][value]
 * - Cho phép 1 type xuất hiện nhiều lần (mảng attachs / mentions).
 * - Int = 4 byte BE, Int64 = 8 byte BE, chuỗi = nguyên byte UTF-8 (không cần NUL).
 *
 * Bảng key lấy từ `db-cross-v4-native.node` của Zalo PC 26.9.10 (parse_bin_net / ParseAttachChatMsg).
 */

export interface BinNetProperty {
    size?: number;
    subType?: number;
    type?: number;
    ext?: string;
    color?: number;
}

export interface BinNetAttach {
    type?: string;
    catId?: number;
    id?: number;
    extInfo?: string;
    childNumber?: number;
    action?: string;
    params?: string;
    title?: string;
    href?: string;
    thumb?: string;
    description?: string;
    remains?: string;
    zinstantData?: string;
    zinstantMsg?: string;
}

export interface BinNetQuote {
    ownerId?: number;
    cliMsgId?: string;
    globalMsgId?: string;
    cliMsgType?: number;
    ts?: number;
    ttl?: number;
    msg?: string;
    attach?: string;
    fromD?: string;
    quoteStatus?: string;
}

export interface BinNetMention {
    type?: number;
    uid?: number;
    pos?: number;
    len?: number;
}

export interface BinNetReference {
    type?: number;
    data?: string;
}

export interface BinNetData {
    property?: BinNetProperty;
    attachs?: BinNetAttach[];
    quote?: BinNetQuote;
    mentions?: BinNetMention[];
    reference?: BinNetReference;
}

const KEY_PROPERTY = 0x05;
const KEY_ATTACH = 0x06;
const KEY_QUOTE = 0x07;
const KEY_MENTION = 0x08;
const KEY_REFERENCE = 0x0b;

type TlvMap = Map<number, Buffer[]>;

/** Tách TLV box. Trả null nếu buffer không đúng định dạng. */
export function parseTlvBox(buf: Buffer): TlvMap | null {
    const map: TlvMap = new Map();
    let off = 0;
    while (off < buf.length) {
        if (off + 8 > buf.length) return null;
        const type = buf.readInt32BE(off);
        const len = buf.readInt32BE(off + 4);
        off += 8;
        if (len < 0 || off + len > buf.length) return null;
        const value = buf.subarray(off, off + len);
        off += len;
        const list = map.get(type);
        if (list) list.push(value);
        else map.set(type, [value]);
    }
    return map;
}

function first(map: TlvMap, key: number): Buffer | undefined {
    const list = map.get(key);
    return list && list.length > 0 ? list[0] : undefined;
}

function readInt(map: TlvMap, key: number): number | undefined {
    const v = first(map, key);
    if (!v || v.length === 0) return undefined;
    if (v.length >= 4) return v.readInt32BE(0);
    let x = 0;
    for (const b of v) x = (x << 8) | b;
    return x;
}

/** Int64 → chuỗi thập phân (msgId/cliMsgId có thể vượt Number.MAX_SAFE_INTEGER). */
function readInt64String(map: TlvMap, key: number): string | undefined {
    const v = first(map, key);
    if (!v || v.length === 0) return undefined;
    if (v.length >= 8) return v.readBigInt64BE(0).toString();
    if (v.length >= 4) return String(v.readInt32BE(0));
    return undefined;
}

function readInt64Number(map: TlvMap, key: number): number | undefined {
    const s = readInt64String(map, key);
    return s === undefined ? undefined : Number(s);
}

function readString(map: TlvMap, key: number): string | undefined {
    const v = first(map, key);
    if (!v) return undefined;
    let end = v.length;
    while (end > 0 && v[end - 1] === 0) end--;
    return v.toString('utf8', 0, end);
}

function compact<T extends object>(obj: T): T | undefined {
    for (const k of Object.keys(obj)) {
        if ((obj as any)[k] === undefined) delete (obj as any)[k];
    }
    return Object.keys(obj).length > 0 ? obj : undefined;
}

function parseProperty(buf: Buffer): BinNetProperty | undefined {
    const box = parseTlvBox(buf);
    if (!box) return undefined;
    return compact<BinNetProperty>({
        size: readInt(box, 0x1e),
        subType: readInt(box, 0x1f),
        type: readInt(box, 0x20),
        ext: readString(box, 0x21),
        color: readInt(box, 0x22),
    });
}

export function parseAttach(buf: Buffer): BinNetAttach | undefined {
    const box = parseTlvBox(buf);
    if (!box) return undefined;
    return compact<BinNetAttach>({
        type: readString(box, 0x28),
        catId: readInt(box, 0x29),
        id: readInt(box, 0x2a),
        extInfo: readString(box, 0x2b),
        childNumber: readInt(box, 0x2c),
        action: readString(box, 0x2d),
        params: readString(box, 0x2e),
        title: readString(box, 0x2f),
        href: readString(box, 0x30),
        thumb: readString(box, 0x31),
        description: readString(box, 0x32),
        remains: readString(box, 0x42),
        zinstantData: readString(box, 0x43),
        zinstantMsg: readString(box, 0x44),
    });
}

function parseQuote(buf: Buffer): BinNetQuote | undefined {
    const box = parseTlvBox(buf);
    if (!box) return undefined;
    return compact<BinNetQuote>({
        ownerId: readInt(box, 0x50),
        cliMsgId: readInt64String(box, 0x51),
        globalMsgId: readInt64String(box, 0x52),
        cliMsgType: readInt(box, 0x53),
        ts: readInt64Number(box, 0x54),
        ttl: readInt64Number(box, 0x55),
        msg: readString(box, 0x56),
        attach: readString(box, 0x57),
        fromD: readString(box, 0x58),
        quoteStatus: readString(box, 0x5a),
    });
}

function parseMention(buf: Buffer): BinNetMention | undefined {
    const box = parseTlvBox(buf);
    if (!box) return undefined;
    return compact<BinNetMention>({
        type: readInt(box, 0x64),
        uid: readInt(box, 0x65),
        pos: readInt(box, 0x66),
        len: readInt(box, 0x67),
    });
}

function parseReference(buf: Buffer): BinNetReference | undefined {
    const box = parseTlvBox(buf);
    if (!box) return undefined;
    return compact<BinNetReference>({
        type: readInt(box, 0xaa),
        data: readString(box, 0xab),
    });
}

/**
 * Parse BinNet. BinNet rỗng/NULL (tin text thường) → `{}`.
 * Trả null khi blob hỏng — giống Zalo PC: bỏ qua tin đó.
 */
export function parseBinNet(input: Buffer | Uint8Array | string | null | undefined): BinNetData | null {
    if (!input || input.length === 0) return {};
    const buf = typeof input === 'string'
        ? Buffer.from(input, 'latin1')
        : Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const box = parseTlvBox(buf);
    if (!box) return null;

    const data: BinNetData = {};
    const property = first(box, KEY_PROPERTY);
    if (property) data.property = parseProperty(property);

    const attachs = (box.get(KEY_ATTACH) || []).map(parseAttach).filter(Boolean) as BinNetAttach[];
    if (attachs.length > 0) data.attachs = attachs;

    const quote = first(box, KEY_QUOTE);
    if (quote) data.quote = parseQuote(quote);

    const mentions = (box.get(KEY_MENTION) || []).map(parseMention).filter(Boolean) as BinNetMention[];
    if (mentions.length > 0) data.mentions = mentions;

    const reference = first(box, KEY_REFERENCE);
    if (reference) data.reference = parseReference(reference);

    return compact(data) || {};
}

// ─── Encoder (dùng cho test tự sinh dữ liệu mẫu) ────────────────────────────

export function encodeTlv(entries: Array<[number, Buffer]>): Buffer {
    const parts: Buffer[] = [];
    for (const [type, value] of entries) {
        const head = Buffer.alloc(8);
        head.writeInt32BE(type, 0);
        head.writeInt32BE(value.length, 4);
        parts.push(head, value);
    }
    return Buffer.concat(parts);
}

export function tlvInt(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n, 0);
    return b;
}

export function tlvInt64(n: number | string | bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(n), 0);
    return b;
}

export function tlvStr(s: string): Buffer {
    return Buffer.from(s, 'utf8');
}
