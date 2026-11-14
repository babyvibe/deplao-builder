/**
 * Convert a `ChatContent` row (a SQLite file inside the mobile backup) into the exact message shape
 * that zca-js emits (UserMessage / GroupMessage), so it is saved through the same path as realtime messages.
 *
 * Follows Zalo PC 26.9 (`convertCrossV2ToCrossV1` + `crossMsgToNormalMsg`):
 *   - The numeric MsgType of mobile → the string msgType of web (table below), dropping the types Zalo PC drops.
 *   - Every "plain" ID (sender, mention, quote.ownerId, contact card) must be converted to a "noise" ID
 *     (web ID, 19 digits) - a message whose sender cannot be identified is skipped, same as Zalo PC.
 */
import { BinNetData, BinNetMention, BinNetProperty, BinNetQuote, parseBinNet } from './binNet';

/** The `je` table of Zalo PC: mobile MsgType → web msgType. */
export const MOBILE_MSG_TYPES: Record<number, string> = {
    0: 'webchat',
    2: 'chat.doodle',
    3: 'chat.photo',
    4: 'chat.photo',
    6: 'chat.voice',
    10: 'chat.sticker',
    12: 'chat.recommended',
    15: 'chat.list.action',
    18: 'chat.location.new',
    19: 'chat.video.msg',
    20: 'webchat',
    22: 'share.file',
    23: 'chat.gif',
    24: 'chat.webcontent',
    25: 'chat.video.live.msg',
    26: 'group.poll',
    31: 'chat.photo',
    33: 'chat.delete',
    36: 'chat.undo',
    53: 'chat.webcontent.v2',
};

/** MsgType that Zalo PC drops directly in the SQL statement. */
export const EXCLUDED_MOBILE_MSG_TYPES = [20, 21, 25, 26, 29, 32, 34, 35, 45, 51, 52];

/** chat.delete is an admin control that deletes messages, not a visible message → not imported. */
const SKIPPED_WEB_TYPES = new Set(['chat.delete']);

const MOBILE_TYPE_OA = 15;
const MOBILE_TYPE_STICKER = 10;

const CHAT_CONTENT_WHERE =
    `WHERE MsgStatus > 0 AND CliMsgId NOT NULL AND MsgType NOT IN (${EXCLUDED_MOBILE_MSG_TYPES.join(',')}) `;
const CHAT_CONTENT_COLUMNS = 'SELECT SenderId, CliMsgId, GlbMsgId, MsgType, TimeStamp, TTL, MsgContent, BinNet FROM ChatContent ';

export const CHAT_CONTENT_QUERY = CHAT_CONTENT_COLUMNS + CHAT_CONTENT_WHERE + 'ORDER BY TimeStamp ASC';

function tsBound(value: unknown): number {
    const n = Math.floor(Number(value) || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** SQL condition for the range [fromTs, toTs] (ms); '' if unlimited. Values are forced to integers → no SQL injection. */
function rangeCondition(fromTs: number, toTs: number): string {
    const parts: string[] = [];
    const from = tsBound(fromTs);
    const to = tsBound(toTs);
    if (from) parts.push(`TimeStamp >= ${from}`);
    if (to) parts.push(`TimeStamp <= ${to}`);
    return parts.join(' AND ');
}

/** Only take messages whose TimeStamp is in [fromTs, toTs]; messages outside the range are not read / parsed. */
export function chatContentQueryRange(fromTs: number, toTs: number): string {
    const cond = rangeCondition(fromTs, toTs);
    return CHAT_CONTENT_COLUMNS + CHAT_CONTENT_WHERE + (cond ? `AND ${cond} ` : '') + 'ORDER BY TimeStamp ASC';
}

/** Number of messages outside the range in one conversation (reported as "bỏ qua N tin ngoài khoảng thời gian đã chọn" (skipped N messages outside the chosen time range)). */
export function chatContentOutOfRangeCount(fromTs: number, toTs: number): string | null {
    const cond = rangeCondition(fromTs, toTs);
    if (!cond) return null;
    return `SELECT SUM(CASE WHEN ${cond} THEN 0 ELSE 1 END) AS outside FROM ChatContent ${CHAT_CONTENT_WHERE}`;
}

export interface MobileThreadRef {
    plainId: string;
    isGroup: boolean;
}

/** `<uid>.db` → 1-1 chat, `group_<gid>.db` → group (the ID must be a number with no leading zero). */
export function parseThreadFileName(fileName: string): MobileThreadRef | null {
    const m = /^(group_)?(\d+)\.db$/.exec(fileName);
    if (!m) return null;
    const plainId = m[2];
    if (String(Number.parseInt(plainId, 10)) !== plainId) return null;
    return { plainId, isGroup: !!m[1] };
}

export interface PlainMessage {
    fromPlain: string;
    globalMsgId: string;
    cliMsgId: string;
    msgType: string;
    mobileType: number;
    text: string;
    ts: number;
    ttl: number;
    attach?: any;
    quote?: BinNetQuote;
    mentions?: BinNetMention[];
    property?: BinNetProperty;
}

function str(v: unknown): string {
    if (v === null || v === undefined) return '';
    return typeof v === 'bigint' ? v.toString() : String(v);
}

function num(v: unknown): number {
    if (typeof v === 'bigint') return Number(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** Read 1 ChatContent row (INTEGER values can be bigint when safeIntegers is on). */
export function rowToPlainMessage(row: any): PlainMessage | null {
    const mobileType = num(row.MsgType);
    const msgType = MOBILE_MSG_TYPES[mobileType];
    if (!msgType || SKIPPED_WEB_TYPES.has(msgType)) return null;

    const binNet: BinNetData | null = parseBinNet(row.BinNet);
    if (!binNet) return null; // Broken BinNet → Zalo PC also drops this message

    let attach: any;
    if (binNet.attachs && binNet.attachs.length > 0) {
        if (mobileType === MOBILE_TYPE_OA) {
            attach = binNet.attachs;
        } else {
            attach = { ...binNet.attachs[0] };
            if (mobileType !== MOBILE_TYPE_STICKER) delete attach.catId;
        }
    }

    const globalMsgId = str(row.GlbMsgId);
    return {
        fromPlain: str(row.SenderId),
        globalMsgId: globalMsgId === '0' ? '' : globalMsgId,
        cliMsgId: str(row.CliMsgId),
        msgType,
        mobileType,
        text: typeof row.MsgContent === 'string' ? row.MsgContent : str(row.MsgContent),
        ts: num(row.TimeStamp),
        ttl: num(row.TTL),
        attach,
        quote: binNet.quote,
        mentions: binNet.mentions,
        property: binNet.property,
    };
}

function isContactCard(attach: any): boolean {
    return !!attach && !Array.isArray(attach)
        && (attach.action === 'recommened.user' || attach.action === 'recommened.vip')
        && /^\d+$/.test(String(attach.params || ''));
}

/** Collect the plain UIDs that must be converted to noise for one message (sender, mention, quote, contact card). */
export function collectPlainUserIds(m: PlainMessage, out: Set<string>): void {
    if (m.fromPlain) out.add(m.fromPlain);
    for (const mention of m.mentions || []) {
        if (mention.uid !== undefined && mention.uid !== -1 && mention.uid !== 0) out.add(String(mention.uid));
    }
    if (m.quote?.ownerId) out.add(String(m.quote.ownerId));
    if (isContactCard(m.attach)) out.add(String(m.attach.params));
}

// ─── Build the content for each type (same as crossMsgToNormalMsg) ─────────────────

/** The `d()` function of Zalo PC: an object (wrongly parsed) → the default value. */
function plain(v: unknown, fallback: any = ''): any {
    if (v !== null && typeof v === 'object' && Object.keys(v as object).length > 0) return fallback;
    return v || fallback;
}

function attachContent(attach: any, fields: string[]): any {
    const content: any = { ...(attach || {}) };
    content.childnumber = num(content.childNumber ?? content.childnumber ?? 0);
    delete content.childNumber;
    for (const field of fields) content[field] = plain(content[field]);
    return content;
}

/** Returns `undefined` if the message is invalid (e.g. zinstant missing pcItem - Zalo PC also drops it). */
function buildContent(m: PlainMessage, resolveUser: (plainId: string) => string | undefined): any {
    const a = m.attach;
    switch (m.msgType) {
        case 'webchat':
            if (a && !Array.isArray(a) && a.action === 'rtf') {
                const rich = { ...a };
                if (!rich.title) rich.title = m.text;
                return rich;
            }
            return m.text;
        case 'chat.photo':
        case 'chat.gif':
            return attachContent(a, ['action', 'description', 'title', 'type']);
        case 'chat.sticker':
            return { ...(a || {}) };
        case 'chat.voice':
            return attachContent(a, ['action', 'description', 'params', 'thumb', 'title', 'type']);
        case 'chat.video.msg':
            return attachContent(a, ['action', 'description', 'type']);
        case 'chat.location.new':
            return attachContent(a, ['action', 'href', 'thumb', 'type']);
        case 'chat.doodle':
            return attachContent(a, ['action', 'description', 'thumb', 'title']);
        case 'share.file':
            return attachContent(a, ['action', 'description', 'thumb', 'type']);
        case 'chat.recommended': {
            const content: any = { ...(a || {}) };
            delete content.childNumber;
            content.description = plain(content.description);
            content.thumb = plain(content.thumb);
            if (isContactCard(a)) content.params = resolveUser(String(a.params)) || content.params;
            return content;
        }
        case 'chat.undo':
            return '';
        case 'chat.list.action':
            return a;
        case 'chat.webcontent':
            if (!a || Array.isArray(a) || !String(a.params || '').includes('pcItem')) return undefined;
            return { ...attachContent(a, ['action', 'description', 'title', 'href', 'thumb']), params: plain(a.params) };
        case 'chat.webcontent.v2':
            return {
                zinstant_msg: plain(a?.zinstantMsg),
                zinstant_data: plain(a?.zinstantData),
                action: plain(a?.action),
            };
        default:
            return a ?? m.text;
    }
}

export interface ConvertContext {
    /** Web UID of the account itself (zca-js ctx.uid). */
    ownNoiseId: string;
    /** Plain UID of the account itself (syncmsg_info.uid). */
    ownPlainId: string;
    thread: MobileThreadRef & { noiseId: string };
    /** plain uid → noise uid (undefined if the server does not return it). */
    resolveUser: (plainId: string) => string | undefined;
}

/** Message with the same shape as zca-js UserMessage/GroupMessage (after the constructor). */
export interface ImportedZaloMessage {
    type: 0 | 1;
    threadId: string;
    isSelf: boolean;
    isRecalled: boolean;
    data: Record<string, any>;
}

export function toZaloMessage(m: PlainMessage, ctx: ConvertContext): ImportedZaloMessage | null {
    const resolve = (plainId: string) => (plainId && plainId === ctx.ownPlainId ? ctx.ownNoiseId : ctx.resolveUser(plainId));
    const uidFrom = resolve(m.fromPlain);
    if (!uidFrom) return null;
    // Compare by web ID so it still works when the event lacks the plain uid of the account itself.
    const isSelf = uidFrom === ctx.ownNoiseId;
    if (!m.cliMsgId && !m.globalMsgId) return null;

    const content = buildContent(m, resolve);
    if (content === undefined) return null;

    const threadId = ctx.thread.noiseId;
    const idTo = ctx.thread.isGroup || isSelf ? threadId : ctx.ownNoiseId;

    const mentions = (m.mentions || [])
        .map(mention => {
            const uid = mention.uid === -1 ? '-1' : resolve(String(mention.uid ?? ''));
            return uid ? { uid, pos: mention.pos ?? 0, len: mention.len ?? 0, type: mention.type ?? 0 } : null;
        })
        .filter(Boolean);

    let quote: Record<string, any> | undefined;
    if (m.quote && m.quote.globalMsgId && m.quote.globalMsgId !== '0') {
        const ownerPlain = m.quote.ownerId !== undefined ? String(m.quote.ownerId) : '';
        quote = {
            ownerId: (ownerPlain && resolve(ownerPlain)) || '',
            cliMsgId: m.quote.cliMsgId ?? '',
            globalMsgId: m.quote.globalMsgId,
            cliMsgType: m.quote.cliMsgType ?? 0,
            ts: m.quote.ts ?? 0,
            msg: m.quote.msg ?? '',
            attach: m.quote.attach ?? '',
            fromD: m.quote.fromD ?? '',
            ttl: m.quote.ttl ?? 0,
        };
    }

    return {
        type: ctx.thread.isGroup ? 1 : 0,
        threadId,
        isSelf,
        isRecalled: m.msgType === 'chat.undo',
        data: {
            // Message with no global id yet (rare) → a fixed id based on cliMsgId, so re-syncing does not duplicate it.
            msgId: m.globalMsgId || `mb_${m.cliMsgId}`,
            cliMsgId: m.cliMsgId,
            msgType: m.msgType,
            uidFrom,
            idTo,
            dName: '',
            ts: String(m.ts),
            content,
            notify: '1',
            ttl: m.ttl,
            quote,
            mentions: mentions.length > 0 ? mentions : undefined,
            propertyExt: m.property,
        },
    };
}
