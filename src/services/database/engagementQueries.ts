/**
 * SQL that reads the received / viewed / replied signals of the messages I SENT (rules: shared/analytics/messageEngagement.ts).
 * Each recipient is looked up at most 2 times on the conversation index messages(owner_zalo_id, thread_id, timestamp), as
 * `ORDER BY timestamp LIMIT 1` so it stops at the first matching message (MIN(...) with the is_sent / msg_type conditions would have to read the whole
 * range of messages after the mark). `thread_id = <column>` is kept as is (no CAST): this is a time-range lookup inside one conversation, not a
 * message-id lookup (see the index trap at messageIdScope / SAME_THREAD_SQL). The plan is locked by
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

/** Time of the first REAL message the recipient sends after the mark (0 = none yet). */
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
 * Contacts the campaigns have already SENT to, plus their signals. Mark = my earliest message around the send time
 * ([sent_at − 5 min, sent_at + 1 min], messages of the campaign); none found → sent_at − 1 min.
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
 * 1:1 recipients of an account in the range [sinceTs, untilTs]: one row per conversation, the mark = the first real message
 * I sent in the range. Skips conversations with myself (Telegram Saved Messages, Zalo My Documents) and groups.
 * `GROUP BY +m.thread_id`: without the `+`, SQLite (node:sqlite 3.51 / better-sqlite3 3.53) picks idx_messages_thread so it does not need a
 * temp sort for GROUP BY = scanning ALL messages of the account (hundreds of thousands of rows); with the `+` it uses
 * idx_messages_owner_type_timestamp for the exact date range and then groups with a temp table.
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
