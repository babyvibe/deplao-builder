/**
 * Proxy riêng của tài khoản (accounts.proxy_id): chọn lúc đăng nhập, thêm / đổi / bỏ được về sau ở Cài đặt → Tài khoản
 * và Cài đặt → Proxy, tài khoản tự kết nối lại qua proxy mới (issue #73, trước đây phải đăng nhập lại).
 * Chỉ Zalo (zca-js) và Facebook (phiên + MQTT) đi qua proxy; Telegram chưa hỗ trợ.
 */

/** Kênh dùng được proxy riêng; tài khoản cũ không có channel = Zalo. */
export function supportsAccountProxy(channel?: string | null): boolean {
  return !channel || channel === 'zalo' || channel === 'facebook';
}
