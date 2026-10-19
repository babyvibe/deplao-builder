/**
 * Chuẩn hoá chữ để tìm kiếm không phân biệt hoa / thường và dấu tiếng Việt: "Đào Vũ" → "dao vu".
 * SQLite LIKE chỉ bỏ qua hoa / thường với ký tự ASCII ("Đ" ≠ "đ") — DatabaseService đăng ký hàm này thành hàm SQL
 * `deplao_fold` để lọc trong DB.
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

/** Thoát ký tự đặc biệt của LIKE (dùng kèm `ESCAPE '\'`). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
