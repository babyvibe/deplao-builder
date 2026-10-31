/**
 * defaultLabels.ts - Default labels for non-Zalo accounts (Facebook, Telegram)
 *
 * Single source of truth cho nhãn mặc định khi tạo tài khoản mới.
 * Dùng chung cho: Telegram Bot, Telegram User, Facebook.
 */

import DataAccessor from '../data/DataAccessor';

/** Nhãn mặc định cho tài khoản non-Zalo */
export const DEFAULT_NON_ZALO_LABELS = [
  { name: 'Khách hàng',    color: '#D91B1B', emoji: '' },
  { name: 'Gia đình',      color: '#4BC377', emoji: '' },
  { name: 'Công việc',     color: '#FF6905', emoji: '' },
  { name: 'Bạn bè',        color: '#6F3FCF', emoji: '' },
  { name: 'Trả lời sau',  color: '#c09700', emoji: '' },
  { name: 'Đồng nghiệp',   color: '#0068FF', emoji: '' },
] as const;

/**
 * Tạo nhãn mặc định cho tài khoản non-Zalo mới.
 * Gọi sau khi save account vào DB.
 * Idempotent — nếu nhãn đã tồn tại sẽ update, không tạo trùng.
 */
export async function createDefaultLabels(accountId: string): Promise<number> {
  let created = 0;
  for (let i = 0; i < DEFAULT_NON_ZALO_LABELS.length; i++) {
    const def = DEFAULT_NON_ZALO_LABELS[i];
    try {
      await DataAccessor.upsertLocalLabel({
        label: {
          name: def.name,
          color: def.color,
          textColor: '#FFFFFF',
          emoji: def.emoji,
          pageIds: accountId,
          isActive: 1,
          sortOrder: i,
        },
      });
      created++;
    } catch { /* non-fatal, continue */ }
  }
  return created;
}
