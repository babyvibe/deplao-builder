/**
 * FacebookThreadKind.ts
 * Phase 4: Route conversations by type — never infer group vs user from numeric ID.
 *
 * Facebook group IDs are ALSO numeric, so "threadId is a number" ≠ "1:1 chat".
 * Use explicit typeChat from caller → DB metadata → structured error.
 */

import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';

export type FacebookThreadKind = 'user' | 'group' | 'unknown';

/**
 * Resolve thread kind with clear precedence:
 * 1. Explicit caller-supplied typeChat (own-property check preserves tri-state)
 * 2. DB metadata from fb_threads.type (authoritative when recent/valid)
 * 3. Unknown — return error, do NOT guess
 *
 * @param threadId     Numeric thread ID
 * @param typeChat     Explicit type from caller: 'user' | null | undefined
 * @param accountId    Facebook account ID (for DB lookup)
 * @returns Resolved kind or error
 */
export async function resolveThreadKind(
  threadId: string,
  typeChat: 'user' | null | undefined,
  accountId: string,
): Promise<{ kind: FacebookThreadKind; error?: string }> {
  // 1. Explicit caller-supplied value (preserves tri-state)
  if (typeChat === 'user') {
    return { kind: 'user' };
  }
  if (typeChat === null) {
    return { kind: 'group' };
  }

  // 2. DB metadata lookup
  try {
    const db = DatabaseService.getInstance();
    const fbThread = db.queryOne?.(
      `SELECT type FROM fb_threads WHERE id = ? AND account_id = ?`,
      [threadId, accountId]
    ) as { type?: string } | undefined;

    if (fbThread?.type === 'user') return { kind: 'user' };
    if (fbThread?.type === 'group') return { kind: 'group' };
  } catch (err: any) {
    Logger.warn(`[resolveThreadKind] DB lookup failed: ${err.message}`);
  }

  // 3. Unknown — caller must handle explicitly
  return {
    kind: 'unknown',
    error: `Không thể xác định loại hội thoại cho thread ${threadId}. ` +
      `Vui lòng tải lại cuộc trò chuyện hoặc chọn loại chat thủ công.`,
  };
}
