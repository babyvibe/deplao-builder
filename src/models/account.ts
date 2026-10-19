/** Tài khoản unified - Zalo + Facebook + Telegram */
export interface Account {
    id?: number;
    zalo_id: string;
    full_name: string;
    avatar_url: string;
    phone?: string;
    /** Telegram bot/user username (không có phone) */
    username?: string;
    /** 1 = tài khoản Business (trả phí), 0 = cá nhân */
    is_business?: number;
    imei: string;
    user_agent: string;
    cookies: string;
    is_active: number;
    created_at: string;
    last_seen?: string;
    listener_active?: number;
    channel?: string;
    proxy_id?: number | null;
    /** Zalo: ID hội thoại "My Documents" (loginInfo.send2me_id) — không phải zalo_id */
    send2me_id?: string;
}
