/**
 * One-time fix for the timestamps of Telegram messages (personal / bot) sent from Deplao before version 26.10.3: these messages were stamped with the
 * machine's clock (with milliseconds, while the Telegram server clock only has seconds), so when the machine runs a few seconds fast, a customer's immediate reply gets sorted
 * BEFORE my message (the project server is 6.4 s fast: "nhớ update vào repo…" (remember to update the repo…) at 16:53:00.646 sorted after 2 customer messages at 16:52:58 / :59).
 *
 * Does not call Telegram: Telegram message ids increase in send order within a conversation, so a message's real time lies between the server time of the
 * neighbouring message before it and after it (by id) → clamp the old stamp into that range (changed only when the order is wrong; within the same second the UI
 * sorts by id). Looks at the last 30 days, runs after the app settles, one day at a time (yielding the main thread between parts), and marks each account done in app_settings.
 */
import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';
import { whenStartupSettled } from '../../../utils/startup/startupSettle';

const DAY_MS = 24 * 60 * 60_000;
const REPAIR_DAYS = 30;
/** Neighbouring messages checked within this range around the old stamp (the machine's clock drift is usually a few seconds; a few minutes is plenty). */
const NEIGHBOR_WINDOW_MS = 10 * 60_000;
/** Telegram's real short ids; the fallback id `String(Date.now())` (13 digits) does not follow the send order → skipped. */
const REAL_ID = /^\d{1,11}$/;
const FLAG_PREFIX = 'tg_sent_ts_repair_v1_';
const START_DELAY_MS = 30_000;

/** Clamp a sent message's stamp into [server time of the neighbour before, server time of the neighbour after] (by id); with no neighbour on that side, keep that side as it is. */
export function repairedSentTimestamp(stored: number, prevServerTs: number | null, nextServerTs: number | null): number {
  let ts = stored;
  if (nextServerTs !== null && ts > nextServerTs) ts = nextServerTs;
  if (prevServerTs !== null && ts < prevServerTs) ts = prevServerTs;
  return ts;
}

interface SentRow { id: number; thread_id: string; msg_id: string; timestamp: number }

/** The DatabaseService part used here (tests pass their own SQLite DB). */
export type RepairDb = Pick<DatabaseService, 'query' | 'queryOne' | 'run'>;

const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve));

/** Fix the sent messages of one Telegram account; returns the number of messages whose stamp changed. */
export async function repairTelegramSentTimestampsForAccount(
  accountId: string, now = Date.now(), db: RepairDb = DatabaseService.getInstance(),
): Promise<number> {
  let fixed = 0;
  for (let start = now - REPAIR_DAYS * DAY_MS; start < now; start += DAY_MS) {
    const rows = db.query<SentRow>(
      `SELECT id, thread_id, msg_id, timestamp FROM messages
        WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp < ? AND is_sent = 1 AND timestamp % 1000 != 0`,
      [accountId, start, start + DAY_MS],
    );
    for (const row of rows) {
      const msgId = String(row.msg_id || '');
      if (!REAL_ID.test(msgId)) continue;
      const near = [accountId, row.thread_id, row.timestamp - NEIGHBOR_WINDOW_MS, row.timestamp + NEIGHBOR_WINDOW_MS, Number(msgId)];
      // Messages with a server time (whole seconds, real id) after / before it by id
      const next = db.queryOne<{ ts: number | null }>(
        `SELECT MIN(timestamp) AS ts FROM messages
          WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp BETWEEN ? AND ? AND timestamp % 1000 = 0
            AND LENGTH(msg_id) <= 11 AND CAST(msg_id AS INTEGER) > ?`,
        near,
      );
      const prev = db.queryOne<{ ts: number | null }>(
        `SELECT MAX(timestamp) AS ts FROM messages
          WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp BETWEEN ? AND ? AND timestamp % 1000 = 0
            AND LENGTH(msg_id) <= 11 AND CAST(msg_id AS INTEGER) < ?`,
        near,
      );
      const ts = repairedSentTimestamp(row.timestamp, prev?.ts ?? null, next?.ts ?? null);
      if (ts !== row.timestamp) {
        db.run('UPDATE messages SET timestamp = ? WHERE id = ?', [ts, row.id]);
        fixed++;
      }
    }
    await yieldToMain();
  }
  return fixed;
}

/** Every Telegram account not fixed yet (once per account). */
export async function repairTelegramSentTimestamps(): Promise<void> {
  const db = DatabaseService.getInstance();
  const accounts = db.query<{ zalo_id: string }>(
    `SELECT zalo_id FROM accounts WHERE channel IN ('telegram_user', 'telegram_bot')`,
  );
  for (const { zalo_id: accountId } of accounts) {
    const flag = `${FLAG_PREFIX}${accountId}`;
    if (db.getSetting(flag)) continue;
    try {
      const fixed = await repairTelegramSentTimestampsForAccount(accountId);
      db.setSetting(flag, String(Date.now()));
      if (fixed > 0) Logger.log(`[Telegram] Đã sửa thứ tự ${fixed} tin đã gửi (mốc giờ máy → theo tin kề trên Telegram) — tài khoản ${accountId}`);
    } catch (err: any) {
      Logger.warn(`[Telegram] Sửa mốc thời gian tin đã gửi lỗi (${accountId}): ${err?.message || err}`);
    }
  }
}

/** Schedule the fix after the app settles (does not compete with CPU / DB when the app opens). */
export function scheduleTelegramSentTimestampRepair(): void {
  whenStartupSettled(() => {
    setTimeout(() => {
      repairTelegramSentTimestamps().catch(err => Logger.warn(`[Telegram] Sửa mốc thời gian tin đã gửi lỗi: ${err?.message || err}`));
    }, START_DELAY_MS);
  });
}
