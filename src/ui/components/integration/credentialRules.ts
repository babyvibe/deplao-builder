/**
 * credentialRules.ts — kiểm tra phần "Thông tin xác thực" khi bấm Kết nối một tích hợp mới (IntegrationDetailPage).
 *
 *  - Ô không đánh dấu `optional` là bắt buộc.
 *  - Nền tảng có nhiều cách đăng nhập khai báo `credentialAlternatives` (Haravan: Access Token HOẶC API Key + Password
 *    của ứng dụng riêng): các ô trong đó đánh dấu optional, và phải điền đủ ít nhất một nhóm.
 *  - Cập nhật kết nối đã lưu: ô trống = giữ giá trị cũ → không bắt buộc ô nào.
 */

export interface CredentialFieldRule { key: string; label: string; optional?: boolean }
export interface CredentialAlternative { label: string; keys: string[] }

/** Thông báo cho ô còn thiếu, hoặc null khi đủ. */
export function missingCredentialMessage(
  fields: readonly CredentialFieldRule[],
  alternatives: readonly CredentialAlternative[] | undefined,
  credentials: Record<string, string | undefined>,
  isUpdate: boolean,
): string | null {
  if (isUpdate) return null;
  const filled = (key: string) => !!String(credentials[key] ?? '').trim();
  for (const field of fields) {
    if (!field.optional && !filled(field.key)) return `Vui lòng nhập ${field.label}`;
  }
  if (alternatives?.length && !alternatives.some(group => group.keys.every(filled))) {
    return `Vui lòng nhập ${alternatives.map(group => group.label).join(' hoặc ')}`;
  }
  return null;
}
