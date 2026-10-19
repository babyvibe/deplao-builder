/**
 * Kiểu dữ liệu cho tính năng "Đồng bộ tin nhắn từ điện thoại" (Zalo mobile → Deplao).
 * Dựa trên zca-js PR #269 (pullMobile + sync_event) và luồng của Zalo PC 26.9.
 */

/** Các `act` của control event `act_type = "syncmsgmb"` (WS cmd 601). */
export enum SyncEventType {
    USER_CONFIRM = 'user_confirm',
    SYNCMSG_INFO = 'syncmsg_info',
    TRANSFER_ERROR = 'transfer_error',
    UNKNOWN = 'unknown',
}

/**
 * user_action (Zalo PC: isUserConfirm / isUserReject / isMobileRestoring):
 * 0 = từ chối, 1 = đồng ý, 2 = điện thoại đang khôi phục dữ liệu (bận), 3 = đồng ý + khôi phục.
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
    /** UID "plain" (dạng ngắn của mobile) của chính tài khoản. */
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
    /** AES key (base64) được mã hoá RSA PKCS#1 bằng public key mình gửi đi. */
    encrypted_key: string;
    trigger_reason?: number;
    is_full_transfer?: number;
    db_info?: string | SyncDbInfo;
}

/**
 * transfer_error: status 1 = điện thoại đang chuẩn bị bản sao lưu, status 2 = điện thoại không hoạt động
 * (app ở nền / màn hình tắt), error_code != 0 = sao lưu thất bại.
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
    /** RSA public key (SPKI DER, base64) — mobile dùng để mã hoá AES key. */
    public_key: string;
    /** Tên máy hiển thị trên điện thoại, cũng dùng để khớp sự kiện trả về. */
    pc_name: string;
    from_seq_id?: number;
    is_retry?: number;
    min_seq_id?: number;
    temp_key?: string;
}

export interface NoisedIdsResult {
    /** UID web (19 số) theo đúng thứ tự `uids` truyền vào; '' nếu server không trả. */
    fids: string[];
    /** Group ID web theo đúng thứ tự `gids` truyền vào. */
    gids: string[];
}

// ─── Trạng thái phiên đồng bộ gửi về renderer (event:mobileSync) ────────────

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
    /** Tin trong khoảng thời gian đã chọn đọc được từ bản sao lưu. */
    messagesRead: number;
    messagesImported: number;
    messagesSkipped: number;
    /** Tin có trong bản sao lưu nhưng ngoài khoảng thời gian đã chọn — không đọc, không nhập. */
    messagesOutOfRange: number;
    durationMs: number;
}

/** Khoảng thời gian cần đồng bộ (TimeStamp ms). null = không giới hạn phía đó. */
export interface MobileSyncRange {
    fromTs: number | null;
    toTs: number | null;
}

export interface MobileSyncStatus {
    zaloId: string;
    stage: MobileSyncStage;
    /** 0-100 cho stage hiện tại (download / giải mã / import). */
    progress: number;
    message: string;
    pcName?: string;
    range?: MobileSyncRange;
    error?: string;
    stats?: MobileSyncStats;
    startedAt?: number;
    updatedAt: number;
}
