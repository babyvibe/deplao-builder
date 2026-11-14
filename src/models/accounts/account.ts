/** Unified account - Zalo + Facebook + Telegram */
export interface Account {
    id?: number;
    zalo_id: string;
    full_name: string;
    avatar_url: string;
    phone?: string;
    /** Telegram bot/user username (no phone number) */
    username?: string;
    /** 1 = Business account (paid), 0 = personal */
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
    /** Zalo: ID of the "My Documents" conversation (loginInfo.send2me_id), not zalo_id */
    send2me_id?: string;
}
