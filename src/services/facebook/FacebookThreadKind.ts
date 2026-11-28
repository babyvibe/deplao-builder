/**
 * FacebookThreadKind.ts
 * Phase 4: Route conversations by type — never infer group vs user from numeric ID.
 *
 * Facebook group IDs are ALSO numeric, so "threadId is a number" ≠ "1:1 chat".
 * Use explicit typeChat from caller → DB metadata → structured error.
 */

import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import { tr } from '../../shared/i18n';

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
    error: tr('Không thể xác định loại hội thoại cho thread {{threadId}}. Vui lòng tải lại cuộc trò chuyện hoặc chọn loại chat thủ công.', { threadId }),
  };
}

/**
 * messagix ThreadType of a bridge event (bridge/events.go threadMeta) → kind. 0 = the bridge did not know the thread yet.
 * One-to-one kinds follow table/enums.go IsOneToOne (+ page follow-up); everything that is a chat with members is a group.
 */
const BRIDGE_ONE_TO_ONE_TYPES = new Set([1, 7, 10, 13, 14, 15]);
const BRIDGE_GROUP_TYPES = new Set([2, 8, 11, 16, 18, 19, 21, 22, 23, 24, 25, 26, 150, 151]);

export function bridgeThreadKind(threadType: unknown): FacebookThreadKind {
  const value = Number(threadType);
  if (BRIDGE_ONE_TO_ONE_TYPES.has(value)) return 'user';
  if (BRIDGE_GROUP_TYPES.has(value)) return 'group';
  return 'unknown';
}

/** E2EE chats come through whatsmeow: groups use the `g.us` server, one-to-one chats `msgr`. */
export function e2eeChatKind(chatJid: unknown): FacebookThreadKind {
  const jid = String(chatJid || '');
  if (/@g\.us$/i.test(jid)) return 'group';
  if (/@msgr$/i.test(jid) || /@s\.whatsapp\.net$/i.test(jid)) return 'user';
  return 'unknown';
}
