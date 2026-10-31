/**
 * ChannelActions — luồng thao tác chat theo kênh, MIRROR đúng cách UI đang làm
 * (src/ui/components/chat/window/, src/ui/lib/chat/forward/forwardSend.ts, MessageInput.tsx, src/ui/lib/channels/adapters/*).
 *
 * Chỉ gọi kênh IPC qua ctx.call — không gọi service/DB trực tiếp. Khi UI đổi luồng,
 * cập nhật file này theo (test chatAdapters.test.ts khoá tên kênh + tham số).
 */
import { AccountInfo, ApiContext, ApiError } from '../types';

export type ThreadType = 'user' | 'group';

export const CHANNELS = {
    ZALO: 'zalo',
    FACEBOOK: 'facebook',
    TELEGRAM_USER: 'telegram_user',
    TELEGRAM_BOT: 'telegram_bot',
} as const;

export function threadTypeNum(t: ThreadType | number | undefined | null): 0 | 1 {
    if (t === 'group' || t === 1) return 1;
    return 0;
}

export function threadTypeName(n: any): ThreadType {
    return Number(n) === 1 ? 'group' : 'user';
}

/**
 * Zalo IPC cần `auth` đúng như UI truyền (buildZaloAuth): cookies + imei + userAgent + accountId.
 * Lấy qua ctx.zaloAuth (cookies chỉ ở trong process). Không dùng auth rỗng: một số handler
 * (vd. zalo:getLabels) không có fallback theo accountId và có thể chọn nhầm tài khoản.
 */
export function zaloAuth(ctx: ApiContext, accountId: string): Promise<Record<string, string>> {
    return ctx.zaloAuth(accountId);
}

/**
 * Chặn trước khi vào IPC: tài khoản phải online. Với Zalo, zaloIpc có fallback
 * "dùng connection duy nhất" khi không khớp tài khoản → bắt buộc kiểm tra ở đây để
 * không gửi nhầm từ tài khoản khác.
 */
export function requireOnline(acc: AccountInfo): void {
    if (!acc.online) {
        throw new ApiError(409, 'ACCOUNT_OFFLINE', `Tài khoản ${acc.id} (${acc.channel}) chưa kết nối`);
    }
}

export function unsupported(acc: AccountInfo, action: string): never {
    throw new ApiError(422, 'CHANNEL_UNSUPPORTED', `Kênh ${acc.channel} không hỗ trợ ${action}`);
}

/** Bản sao buildQuotePayload (MessageInput.tsx) — quote Zalo cần object gốc của tin. */
export function buildQuotePayload(msg: any): string | null {
    if (!msg) return null;
    let content = msg.content || '';
    if (content && typeof content === 'string' && content.trim().startsWith('{')) {
        try { content = JSON.parse(content); } catch { /* giữ chuỗi */ }
    }
    return JSON.stringify({
        content,
        msgType: msg.msg_type || 'webchat',
        propertyExt: msg.property_ext ?? undefined,
        uidFrom: msg.sender_id || '',
        msgId: String(msg.msg_id || ''),
        cliMsgId: String(msg.cli_msg_id || msg.msg_id || ''),
        ts: String(msg.timestamp || Date.now()),
        ttl: 0,
    });
}

export interface Mention {
    user_id: string;
    offset: number;
    length: number;
}

function toUidMentions(mentions?: Mention[]): Array<{ uid: string; pos: number; len: number }> | undefined {
    if (!mentions || mentions.length === 0) return undefined;
    return mentions.map(m => ({ uid: String(m.user_id), pos: Number(m.offset) || 0, len: Number(m.length) || 0 }));
}

/** Lấy msgId từ kết quả gửi (mirror extractMsgIdFromResponse của UI). */
export function extractSentId(res: any): { msg_id: string | null; cli_msg_id: string | null } {
    const r = res?.response ?? res;
    const msgId = r?.message?.msgId ?? r?.msgId ?? r?.messageId ?? res?.messageId ?? res?.msgId
        ?? (Array.isArray(r?.attachment) ? r.attachment[0]?.msgId : undefined) ?? null;
    const cli = r?.message?.cliMsgId ?? r?.cliMsgId ?? null;
    return { msg_id: msgId !== null && msgId !== undefined ? String(msgId) : null, cli_msg_id: cli !== null && cli !== undefined ? String(cli) : null };
}

// ─── Gửi ─────────────────────────────────────────────────────────────────────

export interface SendTextInput {
    threadId: string;
    threadType: ThreadType;
    text: string;
    quoteRow?: any;
    mentions?: Mention[];
}

export async function sendText(ctx: ApiContext, acc: AccountInfo, input: SendTextInput): Promise<any> {
    requireOnline(acc);
    const quote = input.quoteRow ? buildQuotePayload(input.quoteRow) : null;
    switch (acc.channel) {
        case CHANNELS.ZALO:
            return ctx.call('zalo:sendMessage', {
                auth: await zaloAuth(ctx, acc.id),
                threadId: input.threadId,
                type: threadTypeNum(input.threadType),
                message: input.text,
                ...(quote ? { quote } : {}),
                ...(input.mentions?.length ? { mentions: toUidMentions(input.mentions) } : {}),
            });
        case CHANNELS.FACEBOOK: {
            const replyToMessageId = input.quoteRow ? String(input.quoteRow.msg_id) : undefined;
            return ctx.call('fb:sendMessage', {
                accountId: acc.id,
                threadId: input.threadId,
                body: input.text,
                options: {
                    typeChat: input.threadType === 'group' ? null : 'user',
                    ...(replyToMessageId ? { replyToMessageId } : {}),
                },
            });
        }
        case CHANNELS.TELEGRAM_USER:
            return ctx.call('telegramUser:sendMessage', {
                accountId: acc.id,
                chatId: input.threadId,
                text: input.text,
                mentions: toUidMentions(input.mentions),
                replyToMsgId: input.quoteRow ? String(input.quoteRow.msg_id).replace(/^tg_/, '') : undefined,
            });
        case CHANNELS.TELEGRAM_BOT:
            return ctx.call('telegram:sendMessage', {
                accountId: acc.id,
                chatId: input.threadId,
                text: input.text,
                mentions: toUidMentions(input.mentions),
            });
        default:
            return unsupported(acc, 'gửi tin nhắn');
    }
}

export type FileKind = 'image' | 'video' | 'audio' | 'file';

export interface SendFileInput {
    threadId: string;
    threadType: ThreadType;
    /** Đường dẫn tuyệt đối do server tạo (upload/thư viện) — không bao giờ nhận path từ client. */
    filePath: string;
    kind: FileKind;
    caption?: string;
    quoteRow?: any;
}

export async function sendFile(ctx: ApiContext, acc: AccountInfo, input: SendFileInput): Promise<any> {
    requireOnline(acc);
    const type = threadTypeNum(input.threadType);
    const quote = input.quoteRow ? buildQuotePayload(input.quoteRow) : null;
    switch (acc.channel) {
        case CHANNELS.ZALO: {
            const auth = await zaloAuth(ctx, acc.id);
            if (input.kind === 'image') {
                return ctx.call('zalo:sendImage', {
                    auth, filePath: input.filePath, threadId: input.threadId, type, message: input.caption || '',
                    ...(quote ? { quote } : {}),
                }, { timeoutMs: 180_000 });
            }
            if (input.kind === 'video') {
                return sendZaloVideo(ctx, acc, input, quote);
            }
            const res = await ctx.call('zalo:sendFile', {
                auth, filePath: input.filePath, threadId: input.threadId, type,
                ...(quote ? { quote } : {}),
            }, { timeoutMs: 300_000 });
            if (input.caption) {
                await ctx.call('zalo:sendMessage', { auth, threadId: input.threadId, type, message: input.caption });
            }
            return res;
        }
        case CHANNELS.FACEBOOK:
            return ctx.call('fb:sendAttachment', {
                accountId: acc.id,
                threadId: input.threadId,
                filePath: input.filePath,
                body: input.caption || '',
                typeChat: input.threadType === 'group' ? null : 'user',
                fileType: input.kind,
                ...(input.quoteRow ? { replyToMessageId: String(input.quoteRow.msg_id) } : {}),
            }, { timeoutMs: 300_000 });
        case CHANNELS.TELEGRAM_USER:
            return ctx.call('telegramUser:sendFile', {
                accountId: acc.id,
                chatId: input.threadId,
                filePath: input.filePath,
                caption: input.caption || '',
                fileType: input.kind,
                replyToMsgId: input.quoteRow ? String(input.quoteRow.msg_id).replace(/^tg_/, '') : undefined,
            }, { timeoutMs: 300_000 });
        case CHANNELS.TELEGRAM_BOT:
            if (input.kind === 'image') {
                return ctx.call('telegram:sendPhoto', { accountId: acc.id, chatId: input.threadId, photoPath: input.filePath, caption: input.caption || '' }, { timeoutMs: 180_000 });
            }
            if (input.kind === 'video') {
                return ctx.call('telegram:sendVideo', { accountId: acc.id, chatId: input.threadId, videoPath: input.filePath, caption: input.caption || '' }, { timeoutMs: 300_000 });
            }
            return ctx.call('telegram:sendDocument', { accountId: acc.id, chatId: input.threadId, filePath: input.filePath, caption: input.caption || '' }, { timeoutMs: 300_000 });
        default:
            return unsupported(acc, 'gửi file');
    }
}

/** Mirror MessageInput.tsx: getVideoMeta → uploadVideoThumb → uploadVideoFile → sendVideo. */
async function sendZaloVideo(ctx: ApiContext, acc: AccountInfo, input: SendFileInput, quote: string | null): Promise<any> {
    const auth = await zaloAuth(ctx, acc.id);
    const type = threadTypeNum(input.threadType);
    let meta: any = {};
    try { meta = await ctx.call('file:getVideoMeta', { filePath: input.filePath }, { timeoutMs: 60_000 }); } catch { meta = {}; }
    let thumbUrl = '';
    if (meta?.thumbPath) {
        try {
            const up = await ctx.call('zalo:uploadVideoThumb', { auth, thumbPath: meta.thumbPath, threadId: input.threadId, type }, { timeoutMs: 120_000 });
            const r = up?.response;
            thumbUrl = r?.normalUrl || r?.hdUrl || r?.url || r?.thumbUrl || r?.fileUrl || r?.href || '';
        } catch { thumbUrl = ''; }
    }
    const upVideo = await ctx.call('zalo:uploadVideoFile', { auth, videoPath: input.filePath, threadId: input.threadId, type }, { timeoutMs: 600_000 });
    const videoUrl: string = upVideo?.response?.fileUrl || '';
    if (!videoUrl) throw new ApiError(502, 'UPSTREAM_ERROR', 'Upload video lên Zalo thất bại');
    const duration = Number(meta?.duration) || 0;
    const res = await ctx.call('zalo:sendVideo', {
        auth,
        options: {
            videoUrl,
            thumbnailUrl: thumbUrl || videoUrl,
            duration: duration ? duration * 1000 : undefined,
            width: Number(meta?.width) || undefined,
            height: Number(meta?.height) || undefined,
        },
        threadId: input.threadId,
        type,
        ...(quote ? { quote } : {}),
    }, { timeoutMs: 120_000 });
    if (input.caption) {
        await ctx.call('zalo:sendMessage', { auth, threadId: input.threadId, type, message: input.caption });
    }
    return res;
}

export async function sendSticker(ctx: ApiContext, acc: AccountInfo, threadId: string, threadType: ThreadType, stickerId: string | number): Promise<any> {
    requireOnline(acc);
    if (acc.channel === CHANNELS.ZALO) {
        return ctx.call('zalo:sendSticker', { auth: await zaloAuth(ctx, acc.id), stickerId, threadId, type: threadTypeNum(threadType) });
    }
    if (acc.channel === CHANNELS.TELEGRAM_USER) {
        return ctx.call('telegramUser:sendSticker', { accountId: acc.id, chatId: threadId, stickerId: String(stickerId) });
    }
    return unsupported(acc, 'gửi sticker');
}

export async function sendLink(ctx: ApiContext, acc: AccountInfo, threadId: string, threadType: ThreadType, url: string, text?: string): Promise<any> {
    requireOnline(acc);
    if (acc.channel === CHANNELS.ZALO) {
        return ctx.call('zalo:sendLink', { auth: await zaloAuth(ctx, acc.id), url, threadId, type: threadTypeNum(threadType), message: text || '' });
    }
    // Kênh khác: link là tin nhắn văn bản.
    return sendText(ctx, acc, { threadId, threadType, text: text ? `${text}\n${url}` : url });
}

// ─── Thao tác trên tin đã có ────────────────────────────────────────────────

/** Mirror ChatWindow.handleUndo: thu hồi trên kênh rồi đánh dấu trong DB. */
export async function recall(ctx: ApiContext, acc: AccountInfo, row: any): Promise<void> {
    requireOnline(acc);
    const threadId = String(row.thread_id);
    switch (acc.channel) {
        case CHANNELS.ZALO: {
            const isSent = !!row.is_sent;
            const message = JSON.stringify({
                data: {
                    msgId: row.msg_id,
                    cliMsgId: row.cli_msg_id || row.msg_id,
                    ...(!isSent && row.sender_id ? { uidFrom: row.sender_id } : {}),
                },
                threadId,
                type: row.thread_type,
            });
            await ctx.call('zalo:undoMessage', { auth: await zaloAuth(ctx, acc.id), message });
            break;
        }
        case CHANNELS.FACEBOOK:
            await ctx.call('fb:unsendMessage', { accountId: acc.id, messageId: String(row.msg_id) });
            break;
        case CHANNELS.TELEGRAM_USER:
            await ctx.call('telegramUser:deleteMessages', { accountId: acc.id, chatId: threadId, messageIds: [String(row.msg_id).replace(/^tg_/, '')] });
            break;
        case CHANNELS.TELEGRAM_BOT:
            await ctx.call('telegram:deleteMessage', { accountId: acc.id, chatId: threadId, messageId: String(row.msg_id).replace(/^tg_/, '') });
            break;
        default:
            unsupported(acc, 'thu hồi tin nhắn');
    }
    await ctx.call('db:markMessageRecalled', { zaloId: acc.id, msgId: String(row.msg_id), threadId });
}

/** Mirror ChatWindow reaction: Zalo dùng mã reactionType; 'NONE' = gỡ. */
export async function react(ctx: ApiContext, acc: AccountInfo, row: any, emoji: string | null): Promise<void> {
    requireOnline(acc);
    const threadId = String(row.thread_id);
    switch (acc.channel) {
        case CHANNELS.ZALO: {
            const message = JSON.stringify({
                data: { msgId: row.msg_id, cliMsgId: row.cli_msg_id || row.msg_id },
                threadId,
                type: row.thread_type,
            });
            await ctx.call('zalo:addReaction', { auth: await zaloAuth(ctx, acc.id), reactionType: emoji ? zaloReactionKey(emoji) : 'NONE', message });
            return;
        }
        case CHANNELS.FACEBOOK:
            await ctx.call('fb:addReaction', { accountId: acc.id, messageId: String(row.msg_id), emoji: emoji || '', action: emoji ? 'add' : 'remove' });
            return;
        case CHANNELS.TELEGRAM_USER:
            await ctx.call('telegramUser:sendReaction', { accountId: acc.id, chatId: threadId, messageId: String(row.msg_id).replace(/^tg_/, ''), emoji: emoji || undefined });
            return;
        case CHANNELS.TELEGRAM_BOT:
            if (!emoji) unsupported(acc, 'gỡ reaction');
            await ctx.call('telegram:addReaction', { accountId: acc.id, chatId: threadId, messageId: String(row.msg_id).replace(/^tg_/, ''), emoji });
            return;
        default:
            unsupported(acc, 'reaction');
    }
}

/** Bản sao EMOJI_TO_REACTION (src/ui/lib/chat/messages/emojiUtils.ts) — mã reaction Zalo theo emoji. */
export const EMOJI_TO_REACTION: Record<string, string> = {
    '❤️': 'HEART', '👍': 'LIKE', '😄': 'HAHA', '😮': 'WOW', '😢': 'CRY', '😡': 'ANGRY',
    '😘': 'KISS', '😂': 'TEARS_OF_JOY', '💩': 'SHIT', '🌹': 'ROSE', '💔': 'BROKEN_HEART',
    '👎': 'DISLIKE', '😍': 'LOVE', '👌': 'OK', '✌️': 'PEACE', '🙏': 'PRAY',
    '😉': 'WINK', '😕': 'CONFUSED', '😁': 'BIG_SMILE', '👊': 'PUNCH', '👋': 'BYE',
    '🫶': 'LOVE_YOU', '😭': 'VERY_SAD', '😎': 'COOL', '🎂': 'BIRTHDAY',
};

export function zaloReactionKey(emoji: string): string {
    const v = String(emoji || '').trim();
    if (/^[A-Z_]+$/.test(v)) return v;
    return EMOJI_TO_REACTION[v] || 'HEART';
}

/**
 * Mirror ChatWindow + sendSeenHelper.ts: đánh dấu đã đọc trong DB rồi báo "đã xem"
 * cho tin cuối cùng (Zalo) hoặc gọi kênh tương ứng (FB/TG).
 */
export async function markRead(ctx: ApiContext, acc: AccountInfo, threadId: string, threadType: ThreadType, lastRow: any | null): Promise<void> {
    await ctx.call('db:markAsRead', { zaloId: acc.id, contactId: threadId });
    if (!acc.online) return;
    try {
        switch (acc.channel) {
            case CHANNELS.ZALO: {
                if (!lastRow) return;
                const messages = [{
                    msgId: lastRow.msg_id || '',
                    cliMsgId: lastRow.cli_msg_id || lastRow.msg_id || '',
                    uidFrom: lastRow.sender_id || '',
                    idTo: threadId,
                    msgType: lastRow.msg_type || 'text',
                    st: lastRow.status === 'sent' ? 1 : 0,
                    at: 0,
                    cmd: 0,
                    ts: lastRow.timestamp || Date.now(),
                }];
                await ctx.call('zalo:sendSeenEvent', { auth: await zaloAuth(ctx, acc.id), messages, type: threadTypeNum(threadType) });
                return;
            }
            case CHANNELS.FACEBOOK:
                await ctx.call('fb:markAsRead', { accountId: acc.id, threadId });
                return;
            case CHANNELS.TELEGRAM_USER:
                await ctx.call('telegramUser:readChatHistory', { accountId: acc.id, chatId: threadId });
                return;
            default:
                return;
        }
    } catch {
        // Báo "đã xem" lên kênh là phụ: DB đã đánh dấu, không làm hỏng request.
    }
}

export async function typing(ctx: ApiContext, acc: AccountInfo, threadId: string, threadType: ThreadType): Promise<void> {
    requireOnline(acc);
    switch (acc.channel) {
        case CHANNELS.ZALO:
            await ctx.call('zalo:sendTyping', { auth: await zaloAuth(ctx, acc.id), threadId, type: threadTypeNum(threadType) });
            return;
        case CHANNELS.FACEBOOK:
            await ctx.call('fb:sendTyping', { accountId: acc.id, threadId, isTyping: true, isGroup: threadType === 'group' });
            return;
        case CHANNELS.TELEGRAM_USER:
            await ctx.call('telegramUser:sendTyping', { accountId: acc.id, chatId: threadId });
            return;
        default:
            unsupported(acc, 'hiệu ứng đang gõ');
    }
}

export interface ForwardTarget {
    thread_id: string;
    thread_type: ThreadType;
}

export type ForwardKind = 'text' | 'image' | 'video' | 'file' | 'unsupported';

const ZALO_IMAGE_TYPES = ['photo', 'image', 'chat.photo', 'chat.doodle', 'chat.gif', 'gif'];
const ZALO_VIDEO_TYPES = ['video', 'chat.video.msg', 'chat.video'];
const ZALO_FILE_TYPES = ['file', 'share.file'];
const BLOCKED_TYPES = ['chat.ecard', 'group.poll', 'chat.poll', 'chat.todo', 'chat.list.action', 'chat.webcontent',
    'chat.webcontent.v2', 'chat.undo', 'recalled', 'system', 'chat.sticker', 'sticker', 'chat.voice', 'voice',
    'chat.recommended', 'chat.recommend', 'chat.location.new'];

/**
 * Phân loại tin cho API forward — tập con của getForwardPlan (src/ui/lib/chat/forward/forwardSupport.ts).
 * Loại UI làm được nhưng API chưa (sticker, danh thiếp, link thẻ, tin thoại, rtf) → 'unsupported'.
 */
export function forwardKind(row: any): ForwardKind {
    if (!row || row.is_recalled === 1 || row.status === 'recalled') return 'unsupported';
    const t = String(row.msg_type || '');
    if (BLOCKED_TYPES.includes(t)) return 'unsupported';
    if (ZALO_IMAGE_TYPES.includes(t)) return 'image';
    if (ZALO_VIDEO_TYPES.includes(t)) return 'video';
    if (ZALO_FILE_TYPES.includes(t)) return 'file';
    try {
        const obj = typeof row.content === 'string' && row.content.trim().startsWith('{') ? JSON.parse(row.content) : null;
        if (obj && obj.action === 'rtf') return 'unsupported';
    } catch { /* văn bản thường */ }
    return messageText(row) ? 'text' : 'unsupported';
}

function localMediaPath(row: any): string {
    try {
        const lp = typeof row.local_paths === 'string' ? JSON.parse(row.local_paths || '{}') : (row.local_paths || {});
        return String(lp?.main || lp?.file || lp?.hd || '');
    } catch {
        return '';
    }
}

/**
 * Chuyển tiếp — mirror sendOneForward (src/ui/lib/chat/forward/forwardSend.ts) ở các nhánh chính:
 *  - văn bản → gửi lại văn bản (zca-js forwardMessage chỉ hỗ trợ text),
 *  - ảnh/video/file → gửi lại từ file local (tải về qua file:downloadMessageMedia nếu chưa có),
 *  - không có file: Facebook/Telegram dùng forward gốc của kênh.
 */
export async function forward(ctx: ApiContext, acc: AccountInfo, row: any, targets: ForwardTarget[]): Promise<any[]> {
    requireOnline(acc);
    const kind = forwardKind(row);
    if (kind === 'unsupported') {
        throw new ApiError(422, 'CHANNEL_UNSUPPORTED', 'Loại tin này chưa chuyển tiếp được qua API (chỉ văn bản, ảnh, video, file)');
    }
    const results: any[] = [];
    if (kind === 'text') {
        const text = messageText(row);
        for (const t of targets) {
            results.push(await sendText(ctx, acc, { threadId: t.thread_id, threadType: t.thread_type, text }));
        }
        return results;
    }
    let filePath = localMediaPath(row);
    if (!filePath && acc.channel === CHANNELS.ZALO) {
        const dl = await ctx.call('file:downloadMessageMedia', {
            zaloId: acc.id, msgId: String(row.msg_id), threadId: String(row.thread_id), kind,
        }, { timeoutMs: 300_000 });
        filePath = String(dl?.localPath || '');
    }
    if (filePath) {
        for (const t of targets) {
            results.push(await sendFile(ctx, acc, { threadId: t.thread_id, threadType: t.thread_type, filePath, kind }));
        }
        return results;
    }
    switch (acc.channel) {
        case CHANNELS.FACEBOOK:
            for (const t of targets) {
                results.push(await ctx.call('fb:forwardMessage', {
                    accountId: acc.id, messageId: String(row.msg_id), targetThreadId: t.thread_id, isGroup: t.thread_type === 'group',
                }));
            }
            return results;
        case CHANNELS.TELEGRAM_USER:
            for (const t of targets) {
                results.push(await ctx.call('telegramUser:forwardMessages', {
                    accountId: acc.id, fromChatId: String(row.thread_id), toChatId: t.thread_id, messageIds: [String(row.msg_id).replace(/^tg_/, '')],
                }));
            }
            return results;
        default:
            throw new ApiError(502, 'UPSTREAM_ERROR', 'Không tải được tệp của tin nhắn (link đã hết hạn?) nên không chuyển tiếp được');
    }
}

export async function editMessage(ctx: ApiContext, acc: AccountInfo, row: any, text: string): Promise<any> {
    requireOnline(acc);
    switch (acc.channel) {
        case CHANNELS.FACEBOOK:
            return ctx.call('fb:editMessage', { accountId: acc.id, messageId: String(row.msg_id), text });
        case CHANNELS.TELEGRAM_USER:
            return ctx.call('telegramUser:editMessage', { accountId: acc.id, chatId: String(row.thread_id), messageId: String(row.msg_id).replace(/^tg_/, ''), text });
        case CHANNELS.TELEGRAM_BOT:
            return ctx.call('telegram:editMessage', { accountId: acc.id, chatId: String(row.thread_id), messageId: String(row.msg_id).replace(/^tg_/, ''), text });
        default:
            return unsupported(acc, 'sửa tin nhắn');
    }
}

/** Text thuần của một tin (content có thể là JSON object với msg/title). */
export function messageText(row: any): string {
    const raw = row?.content;
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return raw;
    try {
        const obj = JSON.parse(trimmed);
        return String(obj?.msg || obj?.title || obj?.description || obj?.text || '');
    } catch {
        return raw;
    }
}
