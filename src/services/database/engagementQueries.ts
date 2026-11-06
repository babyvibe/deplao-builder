/**
 * SQL đọc tín hiệu đã nhận / đã xem / đã phản hồi của tin MÌNH gửi (quy tắc: shared/analytics/messageEngagement.ts).
 * Mỗi người nhận tra tối đa 2 lần trên chỉ mục hội thoại messages(owner_zalo_id, thread_id, timestamp), dạng
 * `ORDER BY timestamp LIMIT 1` để dừng ở tin đầu tiên khớp (MIN(...) kèm điều kiện is_sent / msg_type phải đọc hết đoạn
 * tin sau mốc). `thread_id = <cột>` để nguyên (không CAST): đây là tra theo khoảng thời gian trong một hội thoại, không
 * phải tra mã tin (xem bẫy chỉ mục ở messageIdScope / SAME_THREAD_SQL). Kế hoạch được khoá bằng
 * src/__tests__/database/messageEngagement.test.ts.
 */
import {
  CAMPAIGN_ANCHOR_LOOKAHEAD_MS,
  CAMPAIGN_ANCHOR_LOOKBACK_MS,
  ENGAGEMENT_CLOCK_SKEW_MS,
  ENGAGEMENT_IGNORED_TYPES_SQL,
} from '../../shared/analytics/messageEngagement';

export interface EngagementQueryable {
  query<T = any>(sql: string, params?: any[]): T[];
}

/** Giờ tin THẬT đầu tiên người nhận gửi sau mốc (0 = chưa có). */
function firstReplySql(ownerExpr: string, threadExpr: string, anchorExpr: string): string {
  return `COALESCE((SELECT r.timestamp FROM messages r
        WHERE r.owner_zalo_id = ${ownerExpr} AND r.thread_id = ${threadExpr} AND r.timestamp > ${anchorExpr}
          AND r.is_sent = 0 AND COALESCE(r.msg_type, '') NOT IN ${ENGAGEMENT_IGNORED_TYPES_SQL}
        ORDER BY r.timestamp ASC LIMIT 1), 0)`;
}

export interface CampaignEngagementRow {
  id: number;
  campaign_id: number;
  contact_id: string;
  sent_at: number;
  anchor_ts: number;
  delivered_ts: number;
  read_ts: number;
  reply_ts: number;
}

/**
 * Liên hệ ĐÃ GỬI của các chiến dịch + tín hiệu. Mốc = tin mình gửi sớm nhất quanh lúc gửi
 * ([sent_at − 5 phút, sent_at + 1 phút], tin của chiến dịch), không thấy → sent_at − 1 phút.
 */
export function campaignEngagementRows(db: EngagementQueryable, campaignIds: readonly number[]): CampaignEngagementRow[] {
  const ids = [...new Set(campaignIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.query<CampaignEngagementRow>(
    `WITH base AS (
      SELECT cc.id, cc.campaign_id, cc.owner_zalo_id, cc.contact_id, cc.sent_at,
        COALESCE((SELECT a.timestamp FROM messages a
            WHERE a.owner_zalo_id = cc.owner_zalo_id AND a.thread_id = cc.contact_id
              AND a.timestamp >= cc.sent_at - ? AND a.timestamp <= cc.sent_at + ? AND a.is_sent = 1
            ORDER BY a.timestamp ASC LIMIT 1), cc.sent_at - ?) AS anchor_ts
      FROM crm_campaign_contacts cc
      WHERE cc.campaign_id IN (${placeholders}) AND cc.status = 'sent' AND cc.sent_at > 0
    )
    SELECT b.id, b.campaign_id, b.contact_id, b.sent_at, b.anchor_ts,
      COALESCE(ct.peer_delivered_ts, 0) AS delivered_ts,
      COALESCE(ct.peer_read_ts, 0) AS read_ts,
      ${firstReplySql('b.owner_zalo_id', 'b.contact_id', 'b.anchor_ts')} AS reply_ts
    FROM base b
    LEFT JOIN contacts ct ON ct.owner_zalo_id = b.owner_zalo_id AND ct.contact_id = b.contact_id`,
    [CAMPAIGN_ANCHOR_LOOKBACK_MS, CAMPAIGN_ANCHOR_LOOKAHEAD_MS, ENGAGEMENT_CLOCK_SKEW_MS, ...ids],
  );
}

export interface OutreachRow {
  thread_id: string;
  anchor_ts: number;
  delivered_ts: number;
  read_ts: number;
  reply_ts: number;
}

/**
 * Người nhận tin 1:1 của một tài khoản trong khoảng [sinceTs, untilTs]: mỗi hội thoại một dòng, mốc = tin thật đầu tiên
 * mình gửi trong khoảng. Bỏ hội thoại với chính mình (Telegram Saved Messages, Zalo My Documents) và nhóm.
 * `GROUP BY +m.thread_id`: không có `+`, SQLite (node:sqlite 3.51 / better-sqlite3 3.53) chọn idx_messages_thread để khỏi
 * xếp tạm cho GROUP BY = duyệt MỌI tin của tài khoản (hàng trăm nghìn dòng); có `+` thì đi
 * idx_messages_owner_type_timestamp theo đúng khoảng ngày rồi gom bằng bảng tạm.
 */
export function outreachRows(
  db: EngagementQueryable,
  ownerId: string,
  sinceTs: number,
  untilTs: number,
  excludeThreadIds: readonly string[] = [],
): OutreachRow[] {
  const exclude = [...new Set(excludeThreadIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  const excludeSql = exclude.length ? `AND m.thread_id NOT IN (${exclude.map(() => '?').join(', ')})` : '';
  return db.query<OutreachRow>(
    `WITH sent AS (
      SELECT m.thread_id, MIN(m.timestamp) AS anchor_ts
      FROM messages m
      WHERE m.owner_zalo_id = ? AND m.thread_type = 0 AND m.timestamp >= ? AND m.timestamp <= ?
        AND m.is_sent = 1 AND COALESCE(m.msg_type, '') NOT IN ${ENGAGEMENT_IGNORED_TYPES_SQL} ${excludeSql}
      GROUP BY +m.thread_id
    )
    SELECT s.thread_id, s.anchor_ts,
      COALESCE(c.peer_delivered_ts, 0) AS delivered_ts,
      COALESCE(c.peer_read_ts, 0) AS read_ts,
      ${firstReplySql('?', 's.thread_id', 's.anchor_ts')} AS reply_ts
    FROM sent s
    LEFT JOIN contacts c ON c.owner_zalo_id = ? AND c.contact_id = s.thread_id
    WHERE COALESCE(c.contact_type, '') <> 'group'`,
    [ownerId, sinceTs, untilTs, ...exclude, ownerId, ownerId],
  );
}
