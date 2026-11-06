/**
 * Đăng nhập Zalo bằng mã QR (zca-js loginQR): phân loại cách lượt QR kết thúc + câu báo cho người dùng.
 *
 * "Operation aborted" (ZaloApiLoginQRAborted) không phải lỗi Zalo trả về: zca-js chỉ ném khi chính app gọi
 * actions.abort() — Deplao gọi khi đóng cửa sổ Thêm tài khoản, chuyển tab, quay lại hoặc bấm Làm mới QR.
 */

/** Lượt QR bị app huỷ (đóng cửa sổ / Làm mới). */
export function isQrLoginCancelled(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'ZaloApiLoginQRAborted';
}

/** Câu báo khi đăng nhập QR lỗi; lỗi gốc (tiếng Anh, có thể kèm JSON của Zalo) ghi ở Nhật ký. */
export function qrLoginErrorText(err: unknown): string {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  if (/generate QRCode|login version/i.test(msg)) return 'Không tạo được mã QR. Kiểm tra mạng hoặc proxy.';
  if (/scan result|confirm result|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|proxy/i.test(msg)) {
    return 'Mất kết nối tới Zalo. Kiểm tra mạng hoặc proxy.';
  }
  if (/session|account info|Can't login/i.test(msg)) return 'Zalo đã xác nhận nhưng chưa lấy được phiên. Thử lại.';
  return 'Đăng nhập không thành công. Thử lại.';
}
