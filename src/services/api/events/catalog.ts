/**
 * Danh mục sự kiện công khai của API v1 (Socket.IO, SSE, polling, webhook, plugin).
 */

export interface EventTypeInfo {
    type: string;
    description: string;
    /** Không lưu DB, không gửi webhook (chỉ realtime). */
    ephemeral?: boolean;
    /** Sự kiện không gắn tài khoản (chỉ key không giới hạn tài khoản nhận được). */
    global?: boolean;
}

export const EVENT_TYPES: EventTypeInfo[] = [
    { type: 'message.received', description: 'Tin nhắn mới từ khách/nhóm (mọi kênh). data.message giống GET message, data.conversation tóm tắt hội thoại.' },
    { type: 'message.sent', description: 'Tin do tài khoản gửi đi (từ app, điện thoại, API, workflow).' },
    { type: 'message.recalled', description: 'Tin bị thu hồi. data: msg_id, thread_id.' },
    { type: 'message.deleted', description: 'Tin bị xoá. data: msg_ids, thread_id.' },
    { type: 'message.reaction', description: 'Có reaction trên tin. data: msg_id, thread_id, user_id, emoji.' },
    { type: 'message.seen', description: 'Khách đã xem tin. data: thread_id, msg_id, user_ids.' },
    { type: 'conversation.typing', description: 'Đang gõ (chỉ Socket.IO/SSE, không lưu, không webhook).', ephemeral: true },
    { type: 'conversation.label.assigned', description: 'Gán nhãn cho hội thoại. data: thread_id, label_id.' },
    { type: 'conversation.label.removed', description: 'Gỡ nhãn khỏi hội thoại. data: thread_id, label_id.' },
    { type: 'friend.request.received', description: 'Có lời mời kết bạn. data: user (id, name, avatar), message.' },
    { type: 'friend.request.sent', description: 'Đã gửi lời mời kết bạn.' },
    { type: 'friend.request.removed', description: 'Lời mời bị huỷ/từ chối.' },
    { type: 'friend.accepted', description: 'Hai bên đã thành bạn bè. data: user_id.' },
    { type: 'group.event', description: 'Sự kiện nhóm (vào/rời/đổi admin...). data: group_id, event_type, raw.' },
    { type: 'group.updated', description: 'Nhóm đổi tên/ảnh. data: group_id, name, avatar_url.' },
    { type: 'poll.vote', description: 'Có người bình chọn.' },
    { type: 'account.connected', description: 'Tài khoản kết nối.' },
    { type: 'account.disconnected', description: 'Tài khoản mất kết nối. data: reason.' },
    { type: 'account.listener_dead', description: 'Kênh nhận tin của tài khoản bị chết, cần kết nối lại. data: reason.' },
    { type: 'crm.note.saved', description: 'Ghi chú CRM được tạo/sửa.' },
    { type: 'crm.note.deleted', description: 'Ghi chú CRM bị xoá.' },
    { type: 'campaign.changed', description: 'Chiến dịch thay đổi (lưu, đổi trạng thái, thêm người nhận).' },
    { type: 'payment.received', description: 'Nhận thanh toán từ tích hợp Casso/SePay.', global: true },
    { type: 'plugin.event', description: 'Sự kiện do plugin phát (type thật có dạng plugin.<pluginId>.<tên>).', global: true },
    { type: 'ping', description: 'Sự kiện thử khi bấm "Test" webhook.', global: true },
];

export function eventInfo(type: string): EventTypeInfo | undefined {
    if (type.startsWith('plugin.')) return EVENT_TYPES.find(e => e.type === 'plugin.event');
    return EVENT_TYPES.find(e => e.type === type);
}

/** "*" hoặc "message.*" hoặc tên chính xác. */
export function typeMatches(patterns: string[] | null | undefined, type: string): boolean {
    if (!patterns || patterns.length === 0) return true;
    return patterns.some(p => {
        if (p === '*' || p === type) return true;
        if (p.endsWith('.*')) return type.startsWith(p.slice(0, -1));
        return false;
    });
}
