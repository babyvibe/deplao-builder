/**
 * Sửa một lần mốc thời gian tin Telegram (cá nhân / bot) đã gửi từ Deplao trước bản 26.10.3: các tin này đóng dấu bằng
 * giờ máy (có mili-giây — giờ server Telegram chỉ có giây), nên máy chạy nhanh vài giây thì khách trả lời ngay bị xếp
 * TRƯỚC tin mình (máy chủ dự án nhanh 6,4 s: "nhớ update vào repo…" 16:53:00.646 đứng sau 2 tin khách 16:52:58 / :59).
 *
 * Không gọi Telegram: id tin Telegram tăng dần theo thứ tự gửi trong một hội thoại, nên giờ thật của tin nằm giữa giờ
 * server của tin kề trước và kề sau theo id → kẹp mốc cũ vào khoảng đó (chỉ đổi khi sai thứ tự; cùng giây thì giao diện
 * xếp theo id). Xét 30 ngày gần nhất, chạy sau khi app ổn định, chia từng ngày (nhường luồng chính giữa các phần), đánh
 * dấu xong theo tài khoản trong app_settings.
 */
import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';
import { whenStartupSettled } from '../../../utils/startup/startupSettle';

const DAY_MS = 24 * 60 * 60_000;
const REPAIR_DAYS = 30;
/** Tin kề trước / sau xét trong khoảng này quanh mốc cũ (độ lệch đồng hồ máy thường vài giây — vài phút là dư). */
const NEIGHBOR_WINDOW_MS = 10 * 60_000;
/** id thật của Telegram ngắn; id dự phòng `String(Date.now())` (13 chữ số) không theo thứ tự gửi → bỏ qua. */
const REAL_ID = /^\d{1,11}$/;
const FLAG_PREFIX = 'tg_sent_ts_repair_v1_';
const START_DELAY_MS = 30_000;

/** Kẹp mốc tin gửi vào [giờ tin server kề trước, giờ tin server kề sau] (theo id); không có tin kề thì giữ nguyên phía đó. */
export function repairedSentTimestamp(stored: number, prevServerTs: number | null, nextServerTs: number | null): number {
  let ts = stored;
  if (nextServerTs !== null && ts > nextServerTs) ts = nextServerTs;
  if (prevServerTs !== null && ts < prevServerTs) ts = prevServerTs;
  return ts;
}

interface SentRow { id: number; thread_id: string; msg_id: string; timestamp: number }

/** Phần DatabaseService dùng ở đây (test truyền DB SQLite riêng). */
export type RepairDb = Pick<DatabaseService, 'query' | 'queryOne' | 'run'>;

const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve));

/** Sửa các tin đã gửi của một tài khoản Telegram; trả số tin đã đổi mốc. */
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
      // Tin có giờ server (tròn giây, id thật) kề sau / kề trước theo id
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

/** Mọi tài khoản Telegram chưa sửa (mỗi tài khoản một lần). */
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

/** Lên lịch sửa sau khi app ổn định (không tranh CPU / DB lúc mở app). */
export function scheduleTelegramSentTimestampRepair(): void {
  whenStartupSettled(() => {
    setTimeout(() => {
      repairTelegramSentTimestamps().catch(err => Logger.warn(`[Telegram] Sửa mốc thời gian tin đã gửi lỗi: ${err?.message || err}`));
    }, START_DELAY_MS);
  });
}
