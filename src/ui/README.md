# Giao diện (`src/ui`, renderer)

Alias `@/` = `src/ui/`. Mỗi lớp chia thư mục theo miền, cùng tên miền ở mọi lớp (`chat/`, `accounts/`, `crm/`, `erp/`,
`employee/`, `plugins/`, `app/`…); phần riêng một kênh nằm trong thư mục kênh (`zalo/`, `telegram/`, `facebook/`).

**Quy tắc:** file mới luôn vào thư mục miền, không thả ra gốc. Gốc chỉ giữ file nền dùng khắp nơi (ghi rõ dưới đây);
gốc một tính năng trong `components/` giữ trang / thành phần chính của tính năng đó.

| Thư mục | Nội dung |
| --- | --- |
| gốc `src/ui/` | Điểm vào: `App.tsx`, `main.tsx`, `index.css` |
| `components/` | Giao diện React theo tính năng (bảng dưới) |
| `store/` | Store Zustand theo miền: `app/` (trạng thái chung, cập nhật app, tính năng hiện, workspace), `accounts/`, `chat/` (hội thoại, tin đánh dấu, tự đọc, thông báo trong app), `crm/`, `employee/` (chế độ nhân viên), `erp/`, `plugins/`, `zalo/` (trạng thái truy cập) |
| `hooks/` | Hook theo miền: `chat/`, `accounts/`, `channels/`, `zalo/`, `erp/`, `layout/` |
| `lib/` | Logic không phải React (bảng dưới). Gốc chỉ có `ipc.ts` (cầu IPC tới main) và `cn.ts` (gộp class Tailwind) |

## components/

| Thư mục | Nội dung |
| --- | --- |
| `chat/` | Màn chat (có README riêng) |
| `erp/` | Quản lý công việc: `tasks/`, `calendar/`, `notes/`, `hrm/` nhân sự, `reports/`, `notifications/` chuông, `settings/` (thông báo qua Zalo), `shared/`; gốc `ErpPage.tsx` |
| `crm/` | CRM: chiến dịch, liên hệ, nhóm, ghi chú, hàng gửi, quét, tìm kiếm, thẻ |
| `workflow/` | Workflow: `editor/` bản đồ + bảng cài đặt node, `nodes/` danh mục + hình node, `ai/` trợ lý thiết kế, `templates/` mẫu |
| `integration/` | Tích hợp POS / thanh toán / vận chuyển; `ai/` trợ lý AI; `pos/` tạo đơn |
| `plugins/` | Ứng dụng (plugin): `hub/` trang Ứng dụng, `runtime/` iframe + cầu JSON-RPC, `contributions/` chỗ plugin gắn vào app |
| `settings/` | Cài đặt: mỗi tab một thư mục (`conversation/`, `notifications/`, `accounts/`, `proxy/`, `security/`, `employees/`, `workspace/`, `cloud/`, `api/`, `introduction/`, `changelog/`, `logs/`) |
| `layout/` | Khung app: `topbar/` thanh trên cùng (đồng bộ, trình mở nhanh), `sidebar/` thanh bên + cột tài khoản |
| `auth/` | `login/` thêm tài khoản (QR, SĐT, bot Telegram), `lock/` khoá app |
| `common/` | Dùng chung: `accounts/`, `avatars/`, `profile/`, `notifications/`, `inputs/`, `cloud/` (địa chỉ công khai); gốc: `icons`, `PageLoading`, `ConfirmDialog` |
| `dashboard/`, `analytics/` | Trang chủ, báo cáo |
| `ui/` | Bộ thành phần giao diện (nút, ô nhập, hộp thoại…), có README riêng |

## lib/

| Thư mục | Nội dung |
| --- | --- |
| `chat/` | Logic màn chat: `messages/`, `conversations/`, `read/`, `send/`, `composer/`, `reactions/`, `forward/`, `media/`, `members/`, `erp/`, `realtime/`, `notifications/`, `telegram/`, `zalo/`, `facebook/` |
| `channels/` | Tiện ích chung mọi kênh (`channelHelper`, `channelIpc`) + `adapters/` adapter từng kênh (gửi tin, thu hồi, cảm xúc…) |
| `data/` | `DataAccessor` (máy chủ: IPC, máy nhân viên: REST) |
| `app/` | Mức app: báo main giao diện đã tải xong (`startupSettled`), lỗi IPC (`apiError`), chấm "mới" của tab (`settingsSeenTabs`) |
| `media/` | Ảnh / video: đường dẫn file cục bộ (`localMedia`), chọn nguồn hiển thị (`mediaResolver`), tải dần, sửa ảnh… |
| `notifications/` | Âm thanh + thông báo hệ điều hành (`NotificationService`), cài đặt thông báo theo máy, số trên biểu tượng |
| `zalo/`, `telegram/`, `facebook/` | Tiện ích riêng kênh (khởi tạo, nhóm, tên gợi nhớ…) |
| `contacts/`, `labels/`, `crm/`, `erp/`, `analytics/` | Theo miền (`contacts/` có cả `phoneUtils`) |
