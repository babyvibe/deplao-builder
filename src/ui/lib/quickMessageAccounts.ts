/**
 * Multi-account planning for Settings → Tin nhắn nhanh → Local.
 *
 * A local LABEL is one row whose comma-separated `page_ids` lists its accounts, so "apply to
 * several accounts" is a single row: editing it re-writes `page_ids` (a deselected account
 * loses the label) and deleting it removes it from every account.
 *
 * A local QUICK MESSAGE is one row PER ACCOUNT (`UNIQUE(owner_zalo_id, keyword)`), so the
 * settings screen gives it the same "one item, several accounts" editing by treating the rows
 * of several accounts with the same keyword AND the same content (text + media) as one shared
 * quick message:
 *  - create → one row per selected account;
 *  - edit   → update the selected accounts that share it, create it for newly selected ones,
 *             remove it from sharing accounts that were deselected (like `page_ids`);
 *  - a selected account that already uses the keyword with OTHER content is a conflict: the
 *    dialog asks once whether to overwrite it or skip that account.
 * Accounts that are not selected and do not share the item are never touched.
 *
 * Pure (no React / IPC) — covered by src/__tests__/quickMessageAccounts.test.ts.
 */

export interface QMMediaFile { path: string; type: string }

export interface QMRow {
  id: number;
  owner_zalo_id: string;
  keyword: string;
  message?: { title?: string | null } | null;
  _localMedia?: QMMediaFile[] | null;
  /** Zalo-style media of items synced from Zalo (display only). */
  media?: any;
  is_active?: number;
  sort_order?: number;
}

export type QMConflictMode = 'overwrite' | 'skip';

/** File name of a Windows or POSIX path. */
export function mediaFileName(filePath: string): string {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function zaloMediaKeys(media: any): string[] {
  const items: any[] = media && Array.isArray(media.items) ? media.items : [];
  return items.map(i => String(i?.photoId ?? i?.normalUrl ?? i?.hdUrl ?? i?.rawUrl ?? i?.thumbUrl ?? ''));
}

/**
 * Content signature (text + media). Rows of two accounts with the same keyword and the same
 * signature hold the same quick message. Local files are compared by type + file name, not
 * by full path: in employee mode each account's copy is uploaded into that account's own
 * media folder on the boss machine. Zalo-style media only counts when there is no local file
 * (a row stores one or the other).
 */
export function qmContentSignature(
  title: string | null | undefined,
  localMedia?: QMMediaFile[] | null,
  zaloMedia?: any,
): string {
  const files = (localMedia || []).map(f => `${f.type}:${mediaFileName(f.path)}`);
  return JSON.stringify([String(title ?? '').trim(), files, files.length ? [] : zaloMediaKeys(zaloMedia)]);
}

export function qmRowSignature(row: QMRow): string {
  return qmContentSignature(row.message?.title, row._localMedia, row.media);
}

/** Same for every account's copy of one shared quick message (keyword + content). */
export function qmShareKey(row: QMRow): string {
  return JSON.stringify([row.keyword, qmRowSignature(row)]);
}

/** Rows grouped by shared quick message (same keyword + content, one row per account). */
export function groupSharedCopies<T extends QMRow>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of items) {
    const key = qmShareKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Every account's copy of `item` (same keyword + same content), `item` included. */
export function findSharedCopies<T extends QMRow>(items: T[], item: T): T[] {
  const key = qmShareKey(item);
  const copies = items.filter(r => r.keyword === item.keyword && qmShareKey(r) === key);
  return copies.some(r => r.id === item.id) ? copies : [item, ...copies];
}

/** owner → row using exactly `keyword` (the DB key UNIQUE(owner_zalo_id, keyword) is case-sensitive). */
export function rowsByOwnerForKeyword<T extends QMRow>(items: T[], keyword: string): Map<string, T> {
  const rows = new Map<string, T>();
  if (!keyword) return rows;
  for (const r of items) {
    if (r.keyword === keyword && !rows.has(r.owner_zalo_id)) rows.set(r.owner_zalo_id, r);
  }
  return rows;
}

export type QMActionKind = 'create' | 'update' | 'rename' | 'overwrite' | 'remove';

export interface QMAccountAction {
  zaloId: string;
  kind: QMActionKind;
  /** Upsert keyword + content on this account (every kind except 'remove'). */
  upsert: boolean;
  /** Row the upsert updates in place; absent → the upsert inserts a new row. */
  targetRowId?: number;
  /** Row deleted after the upsert: the old-keyword row on rename, or the row of a deselected account. */
  deleteRowId?: number;
  /** Rename into a new row: non-default is_active / sort_order of the old row, to restore on the new one. */
  carry?: { isActive: number; sortOrder: number };
  /** Media of the account's current copy — existing files keep pointing at the account's own copies. */
  ownMedia?: QMMediaFile[];
}

export interface QMSaveInput<T extends QMRow> {
  /** Current rows of every account. */
  items: T[];
  /** Keyword being saved (trimmed). */
  keyword: string;
  /** qmContentSignature() of the text + media being saved. */
  signature: string;
  /** Accounts chosen in the dialog. */
  selected: string[];
  /** Edit mode: keyword of the opened item and the accounts that shared it when the dialog opened. */
  original?: { keyword: string; members: string[] } | null;
  conflictMode: QMConflictMode;
}

export interface QMSavePlan<T extends QMRow> {
  actions: QMAccountAction[];
  /** Rows of selected accounts that already use the keyword with other content. */
  conflicts: T[];
  /** Accounts left untouched because of conflictMode 'skip'. */
  skipped: string[];
}

function carryState(row: QMRow): QMAccountAction['carry'] {
  const isActive = row.is_active ?? 1;
  const sortOrder = row.sort_order ?? 0;
  return isActive !== 1 || sortOrder !== 0 ? { isActive, sortOrder } : undefined;
}

function mediaOf(row?: QMRow): QMMediaFile[] | undefined {
  return row?._localMedia?.length ? row._localMedia : undefined;
}

/** What saving the dialog does on each account (see the module comment for the rules). */
export function planQuickMessageSave<T extends QMRow>(input: QMSaveInput<T>): QMSavePlan<T> {
  const { items, keyword, signature, original, conflictMode } = input;
  const selected = Array.from(new Set(input.selected.filter(Boolean)));
  const selectedSet = new Set(selected);
  const members = new Set(original?.members ?? []);
  const renamed = !!original && original.keyword !== keyword;
  const withKeyword = rowsByOwnerForKeyword(items, keyword);
  const withOldKeyword = original ? rowsByOwnerForKeyword(items, original.keyword) : new Map<string, T>();

  const actions: QMAccountAction[] = [];
  const conflicts: T[] = [];
  const skipped: string[] = [];

  for (const zaloId of selected) {
    const own = members.has(zaloId) ? withOldKeyword.get(zaloId) : undefined;
    const target = withKeyword.get(zaloId);

    if (own && (!renamed || !target)) {
      // This account's copy: edited in place, or moved to a keyword the account does not use yet.
      actions.push(renamed
        ? { zaloId, kind: 'rename', upsert: true, deleteRowId: own.id, carry: carryState(own), ownMedia: mediaOf(own) }
        : { zaloId, kind: 'update', upsert: true, targetRowId: own.id, ownMedia: mediaOf(own) });
      continue;
    }
    if (!target) {
      actions.push({ zaloId, kind: 'create', upsert: true });
      continue;
    }
    if (qmRowSignature(target) === signature) {
      // The account already has exactly this content under the keyword: refresh it, nothing to ask.
      actions.push({
        zaloId, kind: own ? 'rename' : 'update', upsert: true,
        targetRowId: target.id, deleteRowId: own?.id, ownMedia: mediaOf(own ?? target),
      });
      continue;
    }
    conflicts.push(target);
    if (conflictMode === 'skip') {
      skipped.push(zaloId);
      continue;
    }
    actions.push({ zaloId, kind: 'overwrite', upsert: true, targetRowId: target.id, deleteRowId: own?.id, ownMedia: mediaOf(own) });
  }

  for (const zaloId of members) {
    if (selectedSet.has(zaloId)) continue;
    const own = withOldKeyword.get(zaloId);
    if (own) actions.push({ zaloId, kind: 'remove', upsert: false, deleteRowId: own.id });
  }

  return { actions, conflicts, skipped };
}

/**
 * An existing media file of the opened item → the account's own copy with the same type and
 * file name, if it has one (keeps per-account copies per account in employee mode).
 */
export function pickOwnMediaCopy<F extends QMMediaFile>(file: F, ownMedia?: QMMediaFile[] | null): F {
  const name = mediaFileName(file.path);
  const own = (ownMedia || []).find(f => f.type === file.type && mediaFileName(f.path) === name);
  return own && own.path !== file.path ? { ...file, path: own.path } : file;
}

/** "A, B, C và 2 tài khoản khác" */
export function formatAccountNames(ids: string[], nameOf: (zaloId: string) => string, max = 3): string {
  const names = ids.map(nameOf);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} và ${names.length - max} tài khoản khác`;
}

export interface QMResultSummaryInput {
  keyword: string;
  saved?: string[];
  removed?: string[];
  skipped?: string[];
  failed?: Array<{ zaloId: string; error?: string }>;
  /** 'delete' words removals as "đã xóa" (row delete) instead of "đã gỡ" (account deselected). */
  mode?: 'save' | 'delete';
}

/** One notification for a multi-account save / delete. */
export function summarizeQuickMessageResult(
  input: QMResultSummaryInput,
  nameOf: (zaloId: string) => string,
): { message: string; type: 'success' | 'warning' | 'error' } {
  const kw = `/${input.keyword}`;
  const saved = input.saved ?? [];
  const removed = input.removed ?? [];
  const skipped = input.skipped ?? [];
  const failed = input.failed ?? [];
  const who = (ids: string[]) => (ids.length === 1 ? nameOf(ids[0]) : `${ids.length} tài khoản`);

  const parts: string[] = [];
  if (saved.length) parts.push(`đã lưu ${kw} cho ${who(saved)}`);
  if (removed.length) {
    parts.push(input.mode === 'delete'
      ? `đã xóa ${kw} ${removed.length === 1 ? 'ở' : 'khỏi'} ${who(removed)}`
      : `đã gỡ ${kw} khỏi ${who(removed)}`);
  }
  if (skipped.length) parts.push(`bỏ qua ${who(skipped)} đã có ${kw}`);
  if (failed.length) {
    const details = failed.slice(0, 3).map(f => `${nameOf(f.zaloId)} (${f.error || 'lỗi không xác định'})`).join(', ');
    parts.push(`lỗi ${failed.length} tài khoản: ${details}${failed.length > 3 ? ', …' : ''}`);
  }

  const done = saved.length + removed.length;
  const type = failed.length ? (done ? 'warning' : 'error') : (done ? 'success' : 'warning');
  const text = parts.length ? parts.join(' · ') : 'không có thay đổi';
  return { message: text.charAt(0).toUpperCase() + text.slice(1), type };
}
