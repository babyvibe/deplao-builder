/**
 * Types for the "Đồng bộ tin nhắn từ điện thoại" (sync messages from phone) feature (Zalo mobile → Deplao).
 * Based on zca-js PR #269 (pullMobile + sync_event) and the Zalo PC 26.9 flow.
 */

/** The `act` values of the control event `act_type = "syncmsgmb"` (WS cmd 601). */
export enum SyncEventType {
    USER_CONFIRM = 'user_confirm',
    SYNCMSG_INFO = 'syncmsg_info',
    TRANSFER_ERROR = 'transfer_error',
    UNKNOWN = 'unknown',
}

/**
 * user_action (Zalo PC: isUserConfirm / isUserReject / isMobileRestoring):
 * 0 = rejected, 1 = confirmed, 2 = the phone is restoring data (busy), 3 = confirmed + restore.
 */
export interface TSyncEventUserConfirm {
    user_action: number;
    public_key: string;
    pc_name: string;
}

export interface SyncDbInfo {
    backup_db?: { msg_total?: number; msg_thread?: number };
    origin_db?: { msg_total?: number; msg_thread?: number };
    db_format?: number;
}

export interface TSyncEventSyncMsgInfo {
    /** The "plain" UID (short form used by mobile) of the account itself. */
    uid: number | string;
    url: string;
    time?: number;
    device_type?: number;
    device_name?: string;
    client_version?: number;
    file_name: string;
    checksum_code?: string;
    checksum?: string;
    file_size?: number;
    client_time?: number;
    from_seq_id?: number;
    public_key: string;
    /** AES key (base64) encrypted with RSA PKCS#1 using the public key we sent. */
    encrypted_key: string;
    trigger_reason?: number;
    is_full_transfer?: number;
    db_info?: string | SyncDbInfo;
}

/**
 * transfer_error: status 1 = the phone is preparing the backup, status 2 = the phone is inactive
 * (app in background / screen off), error_code != 0 = backup failed.
 */
export interface TSyncEventTransferError {
    public_key?: string;
    pc_name?: string;
    can_retry?: number;
    error_msg?: string;
    error_code?: number;
    status?: number;
}

export type SyncEvent =
    | { type: SyncEventType.USER_CONFIRM; act: string; act_type: string; data: TSyncEventUserConfirm }
    | { type: SyncEventType.SYNCMSG_INFO; act: string; act_type: string; data: TSyncEventSyncMsgInfo }
    | { type: SyncEventType.TRANSFER_ERROR; act: string; act_type: string; data: TSyncEventTransferError }
    | { type: SyncEventType.UNKNOWN; act: string; act_type: string; data: any };

export function initializeSyncEvent(data: any, act: string, actType: string): SyncEvent {
    switch (act) {
        case SyncEventType.USER_CONFIRM:
            return { type: SyncEventType.USER_CONFIRM, act, act_type: actType, data };
        case SyncEventType.SYNCMSG_INFO:
            return { type: SyncEventType.SYNCMSG_INFO, act, act_type: actType, data };
        case SyncEventType.TRANSFER_ERROR:
            return { type: SyncEventType.TRANSFER_ERROR, act, act_type: actType, data };
        default:
            return { type: SyncEventType.UNKNOWN, act, act_type: actType, data };
    }
}

export interface PullMobileParams {
    /** RSA public key (SPKI DER, base64): the mobile uses it to encrypt the AES key. */
    public_key: string;
    /** Device name shown on the phone, also used to match the returned events. */
    pc_name: string;
    from_seq_id?: number;
    is_retry?: number;
    min_seq_id?: number;
    temp_key?: string;
}

export interface NoisedIdsResult {
    /** Web UIDs (19 digits) in the same order as the `uids` passed in; '' if the server does not return one. */
    fids: string[];
    /** Web group IDs in the same order as the `gids` passed in. */
    gids: string[];
}

// ─── Sync session status sent to the renderer (event:mobileSync) ────────────

export type MobileSyncStage =
    | 'idle'
    | 'requesting'
    | 'waiting_confirm'
    | 'waiting_backup'
    | 'mobile_idle'
    | 'downloading'
    | 'decrypting'
    | 'resolving_ids'
    | 'importing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface MobileSyncStats {
    conversations: number;
    conversationsResolved: number;
    conversationsUnresolved: number;
    /** Messages in the chosen time range that were read from the backup. */
    messagesRead: number;
    messagesImported: number;
    messagesSkipped: number;
    /** Messages in the backup but outside the chosen time range: not read, not imported. */
    messagesOutOfRange: number;
    durationMs: number;
}

/** Time range to sync (TimeStamp ms). null = no limit on that side. */
export interface MobileSyncRange {
    fromTs: number | null;
    toTs: number | null;
}

export interface MobileSyncStatus {
    zaloId: string;
    stage: MobileSyncStage;
    /** 0-100 for the current stage (download / decrypt / import). */
    progress: number;
    message: string;
    pcName?: string;
    range?: MobileSyncRange;
    error?: string;
    stats?: MobileSyncStats;
    startedAt?: number;
    updatedAt: number;
}
