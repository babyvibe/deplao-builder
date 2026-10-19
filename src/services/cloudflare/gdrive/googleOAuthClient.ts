/**
 * Client OAuth "Desktop app" CHUNG của Deplao cho Google Drive — dùng khi người dùng không nhập client riêng.
 *
 * Cách điền (người bảo trì):
 *  1. console.cloud.google.com → tạo project (vd "Deplao") → APIs & Services → Library → bật "Google Drive API".
 *  2. OAuth consent screen (Google Auth Platform): User type = External. Data access: thêm đúng MỘT quyền
 *     https://www.googleapis.com/auth/drive.file (quyền không nhạy cảm — app chỉ thấy file do chính nó tạo, không cần
 *     Google thẩm định bảo mật). Audience → Publishing status phải là "In production": để "Testing" thì refresh token
 *     hết hạn sau 7 ngày và chỉ tài khoản trong danh sách test user đăng nhập được.
 *  3. Credentials → Create credentials → OAuth client ID → Application type "Desktop app".
 *  4. Chép Client ID + Client secret vào hai giá trị dưới (thay chuỗi rỗng sau `||`). Biến môi trường
 *     DEPLAO_GOOGLE_CLIENT_ID / DEPLAO_GOOGLE_CLIENT_SECRET chỉ có tác dụng khi chạy dev — bản cài trên máy người dùng
 *     không có biến này nên phải điền thẳng vào đây.
 *
 * Client secret của client "Desktop app" KHÔNG phải bí mật (Google ghi rõ app cài trên máy không giữ được bí mật; an
 * toàn nhờ PKCE + chuyển hướng loopback 127.0.0.1) — giống rclone / gcloud nhúng sẵn client của họ trong bản phát hành.
 * Hạn mức Drive API (đơn vị / ngày) của project này chia cho MỌI người dùng Deplao dùng client chung.
 *
 * Để trống = bản app không có client chung → người dùng phải nhập client OAuth riêng (mục Nâng cao) mới đăng nhập được.
 */
export const BUILTIN_GOOGLE_CLIENT: { clientId: string; clientSecret: string } = {
    clientId: process.env.DEPLAO_GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.DEPLAO_GOOGLE_CLIENT_SECRET || '',
};
