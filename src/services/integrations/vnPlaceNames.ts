/**
 * vnPlaceNames.ts: compares Vietnamese administrative names written by different systems
 * ("Thành phố Hồ Chí Minh" / "TP. Hồ Chí Minh" / "Hồ Chí Minh", "Q. Ba Đình" / "Quận Ba Đình").
 * Used to find a POS's own location id from the names picked in Deplao (KiotViet "Khu vực" list).
 * Pure: covered by src/__tests__/integrations/vnPlaceNames.test.ts.
 */

/** Accents removed, lower case, punctuation → spaces, single spaces. */
export function foldVietnamese(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[.,;:()_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short forms → full administrative words (after folding): "tp" → "thanh pho", "q" → "quan"… */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/^tp /, 'thanh pho '],
  [/^tx /, 'thi xa '],
  [/^tt /, 'thi tran '],
  [/^q /, 'quan '],
  [/^h /, 'huyen '],
  [/^p /, 'phuong '],
  [/^x /, 'xa '],
];

const TYPE_WORDS = /^(thanh pho|tinh|quan|huyen|thi xa|thi tran|phuong|xa|dac khu) /;

/** Folded name with the administrative type spelled out: "Q. Ba Đình" → "quan ba dinh". */
export function foldPlaceWithType(value: unknown): string {
  let s = foldVietnamese(value);
  for (const [re, full] of ABBREVIATIONS) s = s.replace(re, full);
  return s;
}

/** Folded name without the administrative type: "Thành phố Hồ Chí Minh" → "ho chi minh", "Quận 1" → "1". */
export function foldPlaceBare(value: unknown): string {
  return foldPlaceWithType(value).replace(TYPE_WORDS, '').trim();
}

/**
 * Finds the "Province - Area" entry (KiotViet "Hà Nội - Quận Ba Đình") for a province + area picked in Deplao.
 * The area must match with its type ("Quận 1" ≠ "Phường 1"); an area written without its type only counts when exactly one
 * entry of that province matches. No sure match → null (better to send no area than a wrong one).
 */
export function matchProvinceArea<T extends { name?: unknown }>(entries: T[], province: unknown, area: unknown): T | null {
  const wantProvince = foldPlaceBare(province);
  const wantFull = foldPlaceWithType(area);
  const wantBare = foldPlaceBare(area);
  if (!wantProvince || !wantBare) return null;
  const bareMatches: T[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name ?? '');
    const cut = name.indexOf(' - ');
    if (cut < 0) continue;
    if (foldPlaceBare(name.slice(0, cut)) !== wantProvince) continue;
    const entryArea = name.slice(cut + 3);
    if (foldPlaceWithType(entryArea) === wantFull) return entry;
    if (foldPlaceBare(entryArea) === wantBare) bareMatches.push(entry);
  }
  return bareMatches.length === 1 ? bareMatches[0] : null;
}
