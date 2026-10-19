/** Contact unified - Zalo + Facebook */
export interface Contact {
    id?: number;
    owner_zalo_id: string;
    contact_id: string;
    display_name: string;
    alias?: string;
    avatar_url: string;
    phone?: string;
    is_friend: number;
    contact_type: string;
    unread_count: number;
    last_message?: string;
    last_message_time?: number;
    is_muted?: number;
    mute_until?: number;
    is_in_others?: number;
    gender?: number | null;
    birthday?: string | null;
    /** Lần cuối tên/avatar được làm mới hàng loạt từ API (unix ms); 0/NULL = chưa bao giờ */
    info_refreshed_at?: number;
    channel?: string;
}

/** Một profile lấy được từ `zalo:refreshContactsInfo` (chỉ các trường dùng để hiển thị). */
export interface ContactInfoProfile {
    contactId: string;
    displayName: string;
    avatarUrl: string;
}

/** Kết quả `zalo:refreshContactsInfo` — làm mới tên/avatar liên hệ hàng loạt theo UID. */
export interface ContactsInfoRefreshResult {
    /** Số dòng contacts đã được cập nhật tên/avatar trong DB */
    updated: number;
    /** UID không lấy được profile (API không trả về, lô lỗi, hoặc chưa kịp hỏi khi dừng sớm) */
    failed: string[];
    /** Số UID đã hỏi API thành công (kể cả UID không có profile) */
    checked: number;
    /** Profile nhận được, để renderer cập nhật store tại chỗ */
    profiles: ContactInfoProfile[];
    /** Lý do dừng sớm (hết phiên / giới hạn tần suất / lỗi lặp lại) nếu có */
    error?: string;
}

/** Friend list */
export interface Friend {
    id?: number;
    owner_zalo_id: string;
    user_id: string;
    display_name: string;
    avatar: string;
    phone: string;
    updated_at: number;
}

/** Member of page/Zalo group */
export interface PageGroupMember {
    id?: number;
    owner_zalo_id: string;
    group_id: string;
    member_id: string;
    display_name: string;
    avatar: string;
    role: number;
    updated_at: number;
}

/** Friend request */
export interface FriendRequest {
    id?: number;
    owner_zalo_id: string;
    user_id: string;
    display_name: string;
    avatar: string;
    phone: string;
    direction: 'sent' | 'received';
    msg: string;
    created_at: number;
    updated_at: number;
}

/** Link được chia sẻ trong hội thoại */
export interface Link {
    id?: number;
    owner_zalo_id: string;
    thread_id: string;
    msg_id: string;
    url: string;
    title: string;
    domain: string;
    thumb_url: string;
    timestamp: number;
}
