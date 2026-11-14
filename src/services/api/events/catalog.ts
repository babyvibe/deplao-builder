/**
 * Catalog of the public events of API v1 (Socket.IO, SSE, polling, webhook, plugin).
 */

import { tr } from '../../../shared/i18n';

export interface EventTypeInfo {
    type: string;
    description: string;
    /** Not saved to the DB, no webhook (realtime only). */
    ephemeral?: boolean;
    /** Events not tied to an account (only keys not limited to accounts receive them). */
    global?: boolean;
}

export const EVENT_TYPES: EventTypeInfo[] = [
    { type: 'message.received', description: tr('Tin nhắn mới từ khách/nhóm (mọi kênh). data.message giống GET message, data.conversation tóm tắt hội thoại.') },
    { type: 'message.sent', description: tr('Tin do tài khoản gửi đi (từ app, điện thoại, API, workflow).') },
    { type: 'message.recalled', description: tr('Tin bị thu hồi. data: msg_id, thread_id.') },
    { type: 'message.deleted', description: tr('Tin bị xoá. data: msg_ids, thread_id.') },
    { type: 'message.reaction', description: tr('Có reaction trên tin. data: msg_id, thread_id, user_id, emoji.') },
    { type: 'message.seen', description: tr('Khách đã xem tin. data: thread_id, msg_id, user_ids.') },
    { type: 'conversation.typing', description: tr('Đang gõ (chỉ Socket.IO/SSE, không lưu, không webhook).'), ephemeral: true },
    { type: 'conversation.label.assigned', description: tr('Gán nhãn cho hội thoại. data: thread_id, label_id.') },
    { type: 'conversation.label.removed', description: tr('Gỡ nhãn khỏi hội thoại. data: thread_id, label_id.') },
    { type: 'friend.request.received', description: tr('Có lời mời kết bạn. data: user (id, name, avatar), message.') },
    { type: 'friend.request.sent', description: tr('Đã gửi lời mời kết bạn.') },
    { type: 'friend.request.removed', description: tr('Lời mời bị huỷ/từ chối.') },
    { type: 'friend.accepted', description: tr('Hai bên đã thành bạn bè. data: user_id.') },
    { type: 'group.event', description: tr('Sự kiện nhóm (vào/rời/đổi admin...). data: group_id, event_type, raw.') },
    { type: 'group.updated', description: tr('Nhóm đổi tên/ảnh. data: group_id, name, avatar_url.') },
    { type: 'poll.vote', description: tr('Có người bình chọn.') },
    { type: 'account.connected', description: tr('Tài khoản kết nối.') },
    { type: 'account.disconnected', description: tr('Tài khoản mất kết nối. data: reason.') },
    { type: 'account.listener_dead', description: tr('Kênh nhận tin của tài khoản bị chết, cần kết nối lại. data: reason.') },
    { type: 'crm.note.saved', description: tr('Ghi chú CRM được tạo/sửa.') },
    { type: 'crm.note.deleted', description: tr('Ghi chú CRM bị xoá.') },
    { type: 'campaign.changed', description: tr('Chiến dịch thay đổi (lưu, đổi trạng thái, thêm người nhận).') },
    { type: 'payment.received', description: tr('Nhận thanh toán từ tích hợp Casso/SePay.'), global: true },
    { type: 'plugin.event', description: tr('Sự kiện do plugin phát (type thật có dạng plugin.<pluginId>.<tên>).'), global: true },
    { type: 'ping', description: tr('Sự kiện thử khi bấm "Test" webhook.'), global: true },
];

export function eventInfo(type: string): EventTypeInfo | undefined {
    if (type.startsWith('plugin.')) return EVENT_TYPES.find(e => e.type === 'plugin.event');
    return EVENT_TYPES.find(e => e.type === type);
}

/** "*" or "message.*" or the exact name. */
export function typeMatches(patterns: string[] | null | undefined, type: string): boolean {
    if (!patterns || patterns.length === 0) return true;
    return patterns.some(p => {
        if (p === '*' || p === type) return true;
        if (p.endsWith('.*')) return type.startsWith(p.slice(0, -1));
        return false;
    });
}
