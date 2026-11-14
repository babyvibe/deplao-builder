/**
 * Normalize text for search, case-insensitive and ignoring Vietnamese diacritics: "Đào Vũ" → "dao vu".
 * SQLite LIKE only ignores case for ASCII characters ("Đ" ≠ "đ"). DatabaseService registers this function as the SQL function
 * `deplao_fold` to filter in the DB.
 */
export function foldSearchText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/** Escape the special characters of LIKE (used with `ESCAPE '\'`). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
