/**
 * common.ts: shared schemas and normalizing functions for the v1 routes.
 *
 * Output data conventions: snake_case, following the DB columns; JSON columns (attachments, reactions,
 * quote_data) are parsed into objects ahead of time; file paths on the machine are NEVER returned.
 */
import { s } from '../schema';
import { messageText, threadTypeName } from '../channels/ChannelActions';
import { ApiContext, ApiError, Pagination, paged } from '../types';
import { isLocalRequest } from '../http/ip';
import { getApiSettingBool } from '../settings';
import { tr } from '../../../shared/i18n';

export const accountParams = s.object({
    accountId: s.id().describe(tr('ID tài khoản (accounts.zalo_id). Facebook dùng Facebook ID, Telegram dùng ID tài khoản Telegram.')),
});

export const threadParams = s.object({
    accountId: s.id().describe(tr('ID tài khoản')),
    threadId: s.id().describe(tr('ID hội thoại (user id hoặc group id của kênh)')),
});

export const messageParams = s.object({
    accountId: s.id().describe(tr('ID tài khoản')),
    threadId: s.id().describe(tr('ID hội thoại')),
    msgId: s.id().describe(tr('ID tin nhắn (msg_id)')),
});

export const pageShape = {
    limit: s.int().min(1).max(200).default(50).describe(tr('Số bản ghi tối đa (1–200)')),
    offset: s.int().min(0).default(0).describe(tr('Bỏ qua N bản ghi đầu')),
};

export const threadTypeSchema = s.enum(['user', 'group'] as const).describe(tr('user = chat 1-1, group = nhóm'));

export function parseJson<T>(raw: any, fallback: T): T {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw !== 'string') return raw as T;
    try { return JSON.parse(raw); } catch { return fallback; }
}

function hasLocalMedia(raw: any): boolean {
    const lp = parseJson<Record<string, any>>(raw, {});
    return !!lp && typeof lp === 'object' && Object.values(lp).some(v => typeof v === 'string' && v.length > 0);
}

/** Normalize one row of the messages table (all channels). */
export function mapMessage(row: any): any {
    if (!row) return null;
    return {
        msg_id: String(row.msg_id ?? ''),
        cli_msg_id: row.cli_msg_id ? String(row.cli_msg_id) : null,
        account_id: String(row.owner_zalo_id ?? ''),
        channel: row.channel || 'zalo',
        thread_id: String(row.thread_id ?? ''),
        thread_type: threadTypeName(row.thread_type),
        sender_id: String(row.sender_id ?? ''),
        sender_name: row.sender_name ?? null,
        is_self: !!row.is_sent,
        msg_type: row.msg_type || 'text',
        content: row.content ?? '',
        text: messageText(row),
        timestamp: Number(row.timestamp) || 0,
        status: row.status || null,
        is_recalled: !!row.is_recalled,
        is_edited: !!row.is_edited,
        topic_id: row.topic_id ?? null,
        reply_to_id: row.reply_to_id ?? null,
        attachments: parseJson<any[]>(row.attachments, []),
        quote: parseJson<any>(row.quote_data, null),
        reactions: parseJson<Record<string, any>>(row.reactions, {}),
        has_local_media: hasLocalMedia(row.local_paths),
        handled_by_employee: row.handled_by_employee ?? null,
    };
}

/** Normalize one row of the contacts table into a conversation. */
export function mapConversation(row: any): any {
    if (!row) return null;
    return {
        thread_id: String(row.contact_id ?? ''),
        account_id: String(row.owner_zalo_id ?? ''),
        channel: row.channel || 'zalo',
        type: row.contact_type === 'group' ? 'group' : 'user',
        display_name: row.display_name || '',
        alias: row.alias || '',
        avatar_url: row.avatar_url || '',
        phone: row.phone || '',
        is_friend: !!row.is_friend,
        unread_count: Number(row.unread_count) || 0,
        last_message: row.last_message || '',
        last_message_time: Number(row.last_message_time) || 0,
        is_muted: !!row.is_muted || Number(row.mute_until) > Date.now(),
        mute_until: Number(row.mute_until) || 0,
        is_in_others: !!row.is_in_others,
        has_mention: !!row.has_mention,
    };
}

export function offsetPage<T>(items: T[], limit: number, offset: number, total?: number) {
    const pagination: Pagination = {
        limit,
        offset,
        has_more: total !== undefined ? offset + items.length < total : items.length >= limit,
        next_offset: (total !== undefined ? offset + items.length < total : items.length >= limit) ? offset + items.length : null,
    };
    if (total !== undefined) pagination.total = total;
    return paged(items, pagination);
}

/**
 * May it point to the private network (file URL, webhook)? Only when the request is made from the machine itself
 * (not through the tunnel), from the app, or when the user has enabled api_allow_private_urls.
 */
export function allowPrivateTargets(ctx: ApiContext): boolean {
    if (getApiSettingBool('api_allow_private_urls')) return true;
    if (ctx.principal.kind === 'system') return true;
    return !!ctx.raw && isLocalRequest(ctx.raw.req);
}

export function notFound(what: string): never {
    throw new ApiError(404, 'NOT_FOUND', tr('Không tìm thấy {{what}}', { what }));
}

/** Remove sensitive fields from an object (one level deep). */
export function stripSecrets<T extends Record<string, any>>(obj: T, keys: string[]): T {
    if (!obj || typeof obj !== 'object') return obj;
    const out: any = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const k of keys) delete out[k];
    return out;
}

export const SECRET_FIELDS = [
    'cookies', 'imei', 'user_agent', 'userAgent', 'cookie_encrypted', 'session_data', 'session', 'password',
    'password_hash', 'api_key_encrypted', 'credentials_encrypted', 'credentials', 'secret', 'token', 'authtoken',
    '_localPath', '_thumbLocalPath', 'file_path', 'thumb_path', 'local_paths',
];

/** Recursively remove sensitive fields (used for data returned directly from a handler). */
export function scrub(value: any, depth = 0): any {
    if (depth > 6 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
    if (typeof value !== 'object') return value;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (SECRET_FIELDS.includes(k)) continue;
        out[k] = scrub(v, depth + 1);
    }
    return out;
}
