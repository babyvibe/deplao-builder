/**
 * Trạng thái tin MÌNH gửi — dấu cạnh giờ như Telegram: ✓ đã gửi, ✓✓ đã nhận (xám), ✓✓ đã xem (màu nhấn).
 * Mốc của hội thoại (contacts.peer_delivered_ts / peer_read_ts / peer_read_max_id + event:receipt — main
 * services/receipts/peerReceipts.ts): tin có thời điểm ≤ mốc = đã nhận / đã xem; Telegram so theo id tin.
 *
 * Kênh hỗ trợ: Telegram cá nhân (đã gửi / đã xem — Telegram không có "đã nhận"), Zalo và Facebook (đủ 3 trạng thái).
 * Kênh không có (Telegram Bot…) → không hiện dấu.
 */

export type OutgoingStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

export interface PeerReceipt {
  deliveredTs?: number | null;
  readTs?: number | null;
  readMaxId?: number | null;
}

export interface ReceiptSupport {
  delivered: boolean;
  /** Telegram: đã xem so theo id tin (read_outbox_max_id), không theo thời điểm */
  readById: boolean;
}

export function receiptSupport(channel: string | null | undefined): ReceiptSupport | null {
  const ch = String(channel || 'zalo');
  if (ch === 'telegram_user') return { delivered: false, readById: true };
  if (ch === 'zalo' || ch === 'facebook') return { delivered: true, readById: false };
  return null;
}

/** Gộp mốc đã lưu (hàng hội thoại) với mốc vừa nhận realtime — lấy giá trị lớn hơn. */
export function mergePeerReceipts(...receipts: Array<PeerReceipt | null | undefined>): Required<{ [K in keyof PeerReceipt]: number }> {
  const out = { deliveredTs: 0, readTs: 0, readMaxId: 0 };
  for (const receipt of receipts) {
    if (!receipt) continue;
    out.deliveredTs = Math.max(out.deliveredTs, Number(receipt.deliveredTs) || 0);
    out.readTs = Math.max(out.readTs, Number(receipt.readTs) || 0);
    out.readMaxId = Math.max(out.readMaxId, Number(receipt.readMaxId) || 0);
  }
  return out;
}

/** Tin không phải người dùng gõ (thông báo hệ thống, bản tin OA / mẫu của Trang): không cho biết ai đã xem gì. */
const AUTOMATED_MSG_TYPES = new Set(['system', 'chat.webcontent', 'chat.webcontent.v2', 'fb.template']);

/**
 * Mốc "đã xem" suy ra: người khác nhắn SAU tin mình gửi thì chắc chắn đã xem các tin trước đó (như Telegram). Zalo không
 * phải lúc nào cũng báo "đã xem" (người nhận tắt trạng thái đã xem, trả lời từ thông báo…) → tin trước câu trả lời vẫn
 * ✓✓ xám. Chỉ kênh so theo thời điểm (Zalo, Facebook); Telegram có mốc đọc chính xác theo id.
 */
export function inferredPeerReadTs(
  messages: ReadonlyArray<{ is_sent?: number | boolean | null; timestamp?: number | string | null; msg_type?: string | null }> | null | undefined,
  channel: string | null | undefined,
): number {
  const support = receiptSupport(channel);
  if (!support || support.readById) return 0;
  let latest = 0;
  for (const message of messages || []) {
    if (!message || message.is_sent === 1 || message.is_sent === true) continue;
    if (AUTOMATED_MSG_TYPES.has(String(message.msg_type || ''))) continue;
    const ts = Number(message.timestamp) || 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}

interface StatusMsg {
  msg_id: string | number;
  is_sent?: number | boolean | null;
  timestamp?: number | string | null;
  status?: string | null;
  send_status?: string | null;
}

/** Trạng thái để vẽ dấu; null = không phải tin mình gửi hoặc kênh không hỗ trợ. */
export function outgoingMessageStatus(msg: StatusMsg, channel: string | null | undefined, receipt: PeerReceipt | null | undefined): OutgoingStatus | null {
  if (!msg || !(msg.is_sent === 1 || msg.is_sent === true)) return null;
  const support = receiptSupport(channel);
  if (!support) return null;
  const id = String(msg.msg_id ?? '');
  const sendStatus = String(msg.send_status || '');
  if (sendStatus === 'failed' || sendStatus === 'timeout') return 'failed';
  if (id.startsWith('temp_') || id.startsWith('retry_') || sendStatus === 'pending' || sendStatus === 'sending') return 'sending';

  const mark = mergePeerReceipts(receipt);
  if (support.readById) {
    // Chỉ theo mốc id: status 'read' cũ của tin gửi Telegram có thể sai (bản cũ đánh dấu ngược chiều đã đọc)
    const numericId = Number(id);
    return Number.isFinite(numericId) && numericId > 0 && numericId <= mark.readMaxId ? 'read' : 'sent';
  }
  const ts = Number(msg.timestamp) || 0;
  if (ts > 0 && ts <= mark.readTs) return 'read';
  if (support.delivered && ts > 0 && ts <= mark.deliveredTs) return 'delivered';
  return 'sent';
}

/** Chữ cho tooltip / trình đọc màn hình. */
export function outgoingStatusLabel(status: OutgoingStatus): string {
  switch (status) {
    case 'sending': return 'Đang gửi';
    case 'failed': return 'Gửi lỗi';
    case 'sent': return 'Đã gửi';
    case 'delivered': return 'Đã nhận';
    case 'read': return 'Đã xem';
  }
}
