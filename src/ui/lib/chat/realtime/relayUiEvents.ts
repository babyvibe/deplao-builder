/**
 * relayUiEvents.ts: window events that useZaloEvents re-emits from realtime events (Boss emit / relay to employees), shared
 * by the screens that listen to them (pure part, test: relaySyncContract.test.ts).
 *
 *  - 'ui:threadLabelsChanged' : db:localLabelThreadChanged { action: assign|remove|bulkAssign, ownerZaloId, labelId(s),
 *    threadId | threadIds }
 *  - 'local-pin-changed'      : { zaloId, threadId?, isPinned? } (Ctrl+P only has zaloId; the relay has everything)
 *  - 'library:changed'        : the media library changed on another machine / reconnected (cache cleared, an open screen reloads)
 */

export const THREAD_LABELS_CHANGED_EVENT = 'ui:threadLabelsChanged';
export const LOCAL_PIN_CHANGED_EVENT = 'local-pin-changed';
export const LIBRARY_CHANGED_EVENT = 'library:changed';

/** Account id in the payload (the Boss IPC sends ownerZaloId, a few REST commands send zaloId). */
export function relayEventAccount(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const record = detail as Record<string, unknown>;
  const id = record.ownerZaloId ?? record.zaloId;
  return id === undefined || id === null ? '' : String(id);
}

/**
 * Whether a label assign / remove event touches the open conversation (accountId, threadId). Missing info (unknown account /
 * conversation) → treated as touching it (an extra reload is better than showing an old label).
 */
export function threadLabelsEventTouches(detail: unknown, accountId: string | null | undefined, threadId: string | null | undefined): boolean {
  if (!accountId || !threadId) return false;
  const owner = relayEventAccount(detail);
  if (owner && owner !== String(accountId)) return false;
  const record = (detail && typeof detail === 'object' ? detail : {}) as Record<string, unknown>;
  if (record.threadId !== undefined && record.threadId !== null && record.threadId !== '') {
    return String(record.threadId) === String(threadId);
  }
  if (Array.isArray(record.threadIds)) {
    return record.threadIds.some((id) => String(id) === String(threadId));
  }
  return true;
}
