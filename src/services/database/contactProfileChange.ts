/**
 * contactProfileChange.ts — hồ sơ liên hệ có THẬT SỰ đổi sau một lần ghi không (phần thuần, có test).
 *
 * Boss gọi db:updateContactProfile cho gần như mọi tin nhắn đến (tên / ảnh người gửi) và mỗi lần kết nối lại Zalo lưu
 * lại bí danh của cả danh bạ. Phát db:contactProfileUpdated / db:contactAliasChanged cho mỗi lần ghi = một event relay
 * tới nhân viên cho mỗi tin nhắn. So bản ghi trước / sau (đúng ngữ nghĩa CASE … ELSE giữ giá trị cũ của câu UPDATE).
 */

/** Cột hồ sơ UI hiển thị (danh sách hội thoại, thông tin liên hệ). */
export const CONTACT_PROFILE_COLUMNS = ['display_name', 'avatar_url', 'phone', 'gender', 'birthday', 'contact_type'] as const;

type Row = Record<string, unknown> | null | undefined;

function norm(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

/** Bản ghi sau khác bản ghi trước ở một cột hồ sơ (chưa có → có cũng tính là đổi). Không có bản ghi sau → false. */
export function contactProfileChanged(before: Row, after: Row): boolean {
  if (!after) return false;
  if (!before) return true;
  return CONTACT_PROFILE_COLUMNS.some((column) => norm(before[column]) !== norm(after[column]));
}

/** Bí danh mới khác bí danh đang lưu. Liên hệ chưa có trong DB → false (câu UPDATE không ghi gì). */
export function contactAliasChanged(before: Row, alias: unknown): boolean {
  if (!before) return false;
  return String(before.alias ?? '') !== String(alias ?? '');
}
