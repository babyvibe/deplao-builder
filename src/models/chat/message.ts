/** Tin nhắn unified - Zalo + Facebook */
export interface Message {
    id?: number;
    msg_id: string;
    cli_msg_id?: string;
    owner_zalo_id: string;
    thread_id: string;
    thread_type: number;
    sender_id: string;
    content: string;
    msg_type: string;
    timestamp: number;
    is_sent: number;
    attachments?: string;
    local_paths?: string;
    status: string;
    quote_data?: string;
    handled_by_employee?: string | null;
    channel?: string;
    reactions?: string;
    is_recalled?: number;
    recalled_content?: string | null;
    /** Original message type retained after a recall, used to restore media previews. */
    recalled_msg_type?: string | null;
    deleted_by?: string | null;
    /** ID of the message being replied to (Facebook/others) */
    reply_to_id?: string | null;
    topic_id?: string | null;
}

/** Draft tin nhắn đang soạn dở */
export interface MessageDraft {
    id?: number;
    owner_zalo_id: string;
    thread_id: string;
    content: string;
    updated_at: number;
}
