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
    /** 1 = Facebook Messenger message request (accept / delete bar in the chat) */
    fb_request?: number;
    /** Zalo auto-deletes new messages after N ms (ZL-05, 0 = off) */
    zalo_auto_delete_ttl?: number;
    /** 1 = conversation is hidden on Zalo (ZL-03) */
    zalo_hidden?: number;
    gender?: number | null;
    birthday?: string | null;
    /** Last time the name/avatar was bulk-refreshed from the API (unix ms); 0/NULL = never */
    info_refreshed_at?: number;
    channel?: string;
}

/** One profile obtained from `zalo:refreshContactsInfo` (only the fields used for display). */
export interface ContactInfoProfile {
    contactId: string;
    displayName: string;
    avatarUrl: string;
}

/** Result of `zalo:refreshContactsInfo`: bulk refresh of contact names/avatars by UID. */
export interface ContactsInfoRefreshResult {
    /** Number of contacts rows whose name/avatar were updated in the DB */
    updated: number;
    /** UIDs whose profile could not be fetched (the API did not return it, batch failed, or not asked yet when stopped early) */
    failed: string[];
    /** Number of UIDs successfully asked from the API (including UIDs without a profile) */
    checked: number;
    /** Profiles received, so the renderer can update the store in place */
    profiles: ContactInfoProfile[];
    /** Reason for stopping early (session expired / rate limit / repeated error), if any */
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

/** Link shared in the conversation */
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
