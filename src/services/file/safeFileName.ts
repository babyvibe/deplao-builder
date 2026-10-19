/**
 * safeFileName.ts — tên file từ bên ngoài (header X-Filename của nhân viên, tên do nơi khác truyền vào) → tên an toàn
 * để path.join vào thư mục lưu. Trước đây upload media của nhân viên ghép thẳng X-Filename vào đường dẫn:
 * "..\..\Start Menu\Programs\Startup\x.bat" ghi được file ra ngoài thư mục media của Boss.
 * (API công khai có biến thể riêng: sanitizeFileName trong services/api/UploadStore.ts.)
 */
import * as path from 'path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
export const MAX_SAFE_FILENAME_LENGTH = 150;

export interface SafeFileNameOptions {
  /** Giải mã %xx trước (client mã hoá X-Filename bằng encodeURIComponent). Mặc định true. */
  decodeUri?: boolean;
}

/**
 * Chỉ lấy phần tên (bỏ mọi thư mục, cả `/` lẫn `\`), bỏ ký tự cấm / điều khiển, bỏ dấu chấm / khoảng trắng ở đầu-cuối
 * (Windows không cho "file."), tránh tên thiết bị Windows (CON, NUL…), giới hạn độ dài (giữ đuôi file).
 * Tên hợp lệ sẵn (img_123.jpg, "Ảnh căn hộ.jpg") giữ nguyên.
 */
export function toSafeFileName(raw: unknown, fallback = 'file', options: SafeFileNameOptions = {}): string {
  let name = String(raw ?? '');
  if (options.decodeUri !== false && /%[0-9a-f]{2}/i.test(name)) {
    try { name = decodeURIComponent(name); } catch { /* giữ nguyên */ }
  }
  name = name.split(/[\\/]+/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  if (name.length > MAX_SAFE_FILENAME_LENGTH) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_SAFE_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}
