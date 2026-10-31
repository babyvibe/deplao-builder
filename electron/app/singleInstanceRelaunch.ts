/**
 * Cài bản mới khi bản cũ còn chạy ngầm (nút X chỉ ẩn Deplao xuống khay): bấm mở bản mới thì khoá một-instance đưa về
 * bản cũ và bản mới thoát ngay, người dùng thấy "cài lại không chạy" (Ubuntu: cài .deb / tải AppImage mới; macOS: kéo đè
 * Deplao.app). Bản mới gửi kèm phiên bản + đường dẫn chạy qua requestSingleInstanceLock; bản cũ thấy bản mới hơn thì tự
 * thoát và mở bản mới. Cùng bản hoặc bản cũ hơn: chỉ hiện cửa sổ như trước. Windows: trình cài tự đóng app trước.
 */
export interface LaunchInfo {
  version: string;
  /** Bản đóng gói (không phải npm run dev) */
  packaged: boolean;
  /** Đường dẫn để mở lại: AppImage là file .AppImage, không phải thư mục mount tạm của nó */
  execPath: string;
}

/** So phiên bản dạng 26.10.3 theo từng số (26.10.10 > 26.10.9). */
export function compareAppVersions(a: string, b: string): number {
  const parts = (value: string) => String(value || '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Bản vừa bấm mở mới hơn bản đang chạy → trả nơi mở lại; không thì null (chỉ hiện cửa sổ). */
export function newerInstallToRelaunch(running: LaunchInfo, incoming: unknown): LaunchInfo | null {
  const info = (incoming && typeof incoming === 'object' ? incoming : null) as Partial<LaunchInfo> | null;
  if (!info || typeof info.version !== 'string' || typeof info.execPath !== 'string' || !info.execPath) return null;
  // npm run dev dùng chung thư mục dữ liệu với bản cài: không bao giờ tự thoát / mở lại vì nó
  if (!running.packaged || info.packaged !== true) return null;
  if (compareAppVersions(info.version, running.version) <= 0) return null;
  return { version: info.version, packaged: true, execPath: info.execPath };
}
