/**
 * Ghi file media (ảnh, video, file, sticker, avatar tải về) bất đồng bộ, không chặn luồng chính.
 *
 * Trước đây dùng fs.writeFileSync: khi ổ đĩa bận (máy thiếu RAM phải ghi trang ra pagefile, app khác đọc ghi nhiều),
 * ghi một video vài chục MB chặn main process cả giây, mọi IPC (mở hội thoại, gửi tin…) và ảnh khác phải chờ.
 *
 * Ghi ra file tạm `.part` rồi đổi tên: local-media không bao giờ phục vụ file đang ghi dở (ghi bất đồng bộ thì
 * protocol handler chạy xen giữa được), MediaScanner bỏ qua đuôi `.part`. Đổi tên lỗi (Windows: file đích đang bị
 * chương trình khác giữ) thì ghi thẳng vào file đích như trước.
 */
import * as fs from 'fs';

export async function writeMediaFile(filePath: string, data: Buffer | Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    await fs.promises.unlink(tmpPath).catch(() => {});
    await fs.promises.writeFile(filePath, data);
  }
}
