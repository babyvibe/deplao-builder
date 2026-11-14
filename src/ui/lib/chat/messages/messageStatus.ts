/**
 * Status of a message I SENT: the tick beside the time, as in Telegram: ✓ sent, ✓✓ delivered (grey), ✓✓ read (accent colour).
 * The conversation's marks (contacts.peer_delivered_ts / peer_read_ts / peer_read_max_id + event:receipt, main
 * services/receipts/peerReceipts.ts): a message at or before the mark = delivered / read; Telegram compares by message id.
 *
 * Supported channels: personal Telegram (sent / read: Telegram has no "delivered"), Zalo and Facebook (all 3 states).
 * Channels without these (Telegram Bot...) → no tick is shown.
 */

import { tr } from '../../../../shared/i18n';

export type OutgoingStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

export interface PeerReceipt {
  deliveredTs?: number | null;
  readTs?: number | null;
  readMaxId?: number | null;
}

export interface ReceiptSupport {
  delivered: boolean;
  /** Telegram: read is compared by message id (read_outbox_max_id), not by time */
  readById: boolean;
}

export function receiptSupport(channel: string | null | undefined): ReceiptSupport | null {
  const ch = String(channel || 'zalo');
  if (ch === 'telegram_user') return { delivered: false, readById: true };
  if (ch === 'zalo' || ch === 'facebook') return { delivered: true, readById: false };
  return null;
}

/** Merges the saved marks (conversation row) with the marks just received in realtime, keeping the larger value. */
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

/** Messages not typed by a user (system notices, OA news / Page templates): they do not tell who read what. */
const AUTOMATED_MSG_TYPES = new Set(['system', 'chat.webcontent', 'chat.webcontent.v2', 'fb.template']);

/**
 * The "read" mark is inferred: if someone else messages AFTER my message, they have certainly read the earlier ones (as in Telegram). Zalo does not
 * always report "read" (the recipient turned off read status, replied from a notification...) → messages before that reply still show
 * grey ✓✓. Only the channels compared by time (Zalo, Facebook) use this; Telegram has an exact read mark by id.
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

/** Status used to draw the tick; null = not a message I sent, or the channel does not support it. */
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
    // Compare by id mark only: an old 'read' status of a sent Telegram message can be wrong (old versions marked the read direction backwards)
    const numericId = Number(id);
    return Number.isFinite(numericId) && numericId > 0 && numericId <= mark.readMaxId ? 'read' : 'sent';
  }
  const ts = Number(msg.timestamp) || 0;
  if (ts > 0 && ts <= mark.readTs) return 'read';
  if (support.delivered && ts > 0 && ts <= mark.deliveredTs) return 'delivered';
  return 'sent';
}

/** Text for the tooltip / screen reader. */
export function outgoingStatusLabel(status: OutgoingStatus): string {
  switch (status) {
    case 'sending': return tr('Đang gửi');
    case 'failed': return tr('Gửi lỗi');
    case 'sent': return tr('Đã gửi');
    case 'delivered': return tr('Đã nhận');
    case 'read': return tr('Đã xem');
  }
}
