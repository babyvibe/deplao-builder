# Màn chat (`src/ui/components/chat`)

Mỗi thư mục là một vùng / tính năng của màn chat. Phần riêng một kênh nằm trong thư mục của kênh đó
(`telegram/`, `zalo/`, `facebook/`). Logic không phải React của màn chat ở `src/ui/lib/chat/` (cùng cách chia).

| Thư mục | Nội dung |
| --- | --- |
| `conversations/` | Cột trái: danh sách hội thoại (`ConversationList`), tìm kiếm, tin đánh dấu, nhãn, đánh dấu đã đọc / đã trả lời hàng loạt |
| `header/` | Thanh trên của khung chat (`ChatHeader`) |
| `window/` | Khung tin nhắn của hội thoại đang mở (có README riêng: hooks, hàng tin, phần riêng từng kênh) |
| `messages/` | Phần vẽ tin dùng chung (khung chat, nhắn tin nhanh, bình luận bài kênh): bong bóng, giờ gửi, tin ghim, menu chuột phải, chuyển tiếp; `reactions/` cảm xúc |
| `composer/` | Ô soạn tin (`MessageInput`), tin nhắn nhanh, thư viện, thẻ ngân hàng, gán trợ lý AI |
| `info/` | Cột phải: thông tin hội thoại, thao tác, ảnh / file / link |
| `groups/` | Nhóm: thông tin + quản lý nhóm, bảng tin, các hộp thoại nhóm, ghi chú nhóm |
| `media/` | Trình xem ảnh / video, ảnh bìa video, tiến độ tải |
| `polls/` | Bình chọn (tạo, bong bóng, xem kết quả) |
| `reminders/` | Nhắc hẹn (tạo, popup khi đến giờ) |
| `quick/` | Thao tác nhanh (nút "+", nhắn tin nhanh, kết bạn, tạo nhóm, tham gia bằng link, lịch hẹn / ghi chú nhanh) |
| `telegram/` | Riêng Telegram: `forum/` chủ đề, `posts/` bài kênh + bình luận, `messages/` phần tin, `stickers/` sticker / GIF, `quick/` nhóm / kênh mới, danh bạ, cuộc gọi; WebView bot |
| `zalo/` | Riêng Zalo: `catalog/` danh mục sản phẩm, `presence/` trạng thái truy cập, `hidden/` hội thoại ẩn, `messages/` thẻ OA / media hết hạn; tự xoá tin |
| `facebook/` | Riêng Facebook: thẻ tin mẫu của Page |

Thêm tính năng: đặt file vào thư mục của vùng / tính năng đó; chỉ một kênh dùng thì vào thư mục của kênh.
Thêm kênh chat mới: xem `window/README.md` (mục "Thêm kênh chat mới").
