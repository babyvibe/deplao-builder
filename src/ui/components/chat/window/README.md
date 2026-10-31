# Khung chat (`src/ui/components/chat/window`)

Khung chat của hội thoại đang mở: danh sách tin, thanh ghim, mời kết bạn, nút về tin mới nhất, chọn nhiều tin,
"đang nhập" / "đã xem" và các popup. `App.tsx` dùng thẳng `window/ChatWindow.tsx`. Các phần khác của màn chat (danh sách
hội thoại, ô soạn tin, panel thông tin…) xem `../README.md`.

## Cấu trúc

| Thư mục / file | Nội dung |
| --- | --- |
| `ChatWindow.tsx` | Ghép phần: gọi các hook theo thứ tự, dựng dữ liệu cho hàng tin (`rowCtx`), bố cục khung |
| `hooks/` | Logic, mỗi việc một hook (xem bảng dưới) |
| `rows/` | Một hàng tin: `MessageRow.tsx` (bố cục bong bóng) + từng phần của hàng |
| `parts/` | Phần giao diện nhỏ của khung (nút cuộn, thanh chọn nhiều tin, đang nhập, đã xem, popup) |
| `channels/` | Phần riêng từng kênh (Telegram, Zalo, Facebook) |

Logic thuần dùng chung nằm ở `src/ui/lib/chat/`: `messages/messageGrouping.ts` (album, chuỗi sticker, bình chọn trùng,
loại tin), `forward/forwardSend.ts` (chuyển tiếp / Lưu vào My Documents).

### hooks/

| Hook | Việc |
| --- | --- |
| `useOpenThread` | Phần store của hội thoại đang mở (luôn có selector) |
| `useMessageListState` | Ref / state dùng chung của danh sách tin (khung cuộn, cờ sẵn sàng, phân trang) |
| `useThreadLifecycle` | Đổi hội thoại: đặt lại trạng thái, cổng "sẵn sàng", cuộn xuống đáy lần đầu |
| `useOlderMessages` | Tải tin cũ khi cuộn gần đỉnh (DB, hết thì hỏi server của kênh) |
| `useScrollFollow` | Bám đáy, theo dõi vị trí cuộn, giữ chỗ đang xem khi chèn tin cũ |
| `useJumpToMessage` | Nhảy tới tin (ghim, trích dẫn, tìm kiếm, tin đánh dấu), về tin mới nhất |
| `useMessageGrouping` | Memo gom tin để vẽ |
| `useSenderDirectory` | Tra người gửi, tên người được trích dẫn, quyền quản trị nhóm |
| `useGroupMembers` | Thành viên nhóm + người gửi chưa biết tên / ảnh |
| `useMessageActions` | Thu hồi, xoá, cảm xúc, chuyển tiếp, ghim, đánh dấu |
| `useMessageSelection` | Chọn nhiều tin (bấm, kéo qua, ESC) |
| `useChatWindowDialogs` | Trạng thái menu / popup / hộp thoại |
| `useMediaViewers`, `useFileDrop`, `useTypingTicker`, `useRowDisplayState`, `useThreadMediaMaintenance` | Trình xem media, kéo thả file, "đang nhập", trạng thái hàng, ảnh hỏng / nạp sẵn media |

## Quy tắc khi sửa

- **Thứ tự gọi hook trong `ChatWindow.tsx` là thứ tự chạy effect.** Layout effect phải giữ: đặt lại khi đổi hội thoại
  (`useThreadLifecycle`) rồi thanh ghim, rồi khôi phục vị trí cuộn khi chèn tin cũ (cả hai trong `useScrollFollow`).
  `useOlderMessages` gọi trước `useScrollFollow` (cần `maybeLoadOlder`).
- Hook đọc store luôn dùng selector (không `useChatStore()` trống): khung chat vẽ lại cả danh sách tin.
- Hàng tin không tự subscribe store: mọi thứ hàng cần đi qua `MessageRowContext` (`rows/rowContext.ts`). Hàng cần thêm
  dữ liệu: thêm tên vào nhóm tương ứng trong `rowContext.ts` rồi thêm vào `rowCtx` ở `ChatWindow.tsx`.
- `renderMessageRow`, `renderSystemNoticeRow`, `renderRecalledRow` là **hàm vẽ**, không phải component: giữ nguyên key và
  cây phần tử của hàng như trước khi tách (tin đổi loại, vd. bị thu hồi, vẫn dùng lại phần tử ngoài cùng của hàng). Phần
  bên trong hàng (trích dẫn, video, chữ, cảm xúc…) là component bình thường.
- Giá trị tính cho một hàng truyền xuống các phần bằng `Pick<RowLocals, ...>` (`rows/rowContext.ts`).

## Thêm kênh chat mới

1. `src/configs/channels/channelConfig.ts`: khả năng của kênh (cảm xúc, chuyển tiếp, ghim…).
2. `src/ui/lib/channels/adapters/`: adapter gửi tin, thu hồi, cảm xúc… rồi đăng ký trong `registry.ts`.
3. `channels/<kênh>/chatWindow.ts`: một `ChatWindowChannel` (`channels/types.ts`), chỉ khai báo những gì kênh làm khác
   khung chat chung, rồi đăng ký trong `channels/index.ts`:
   - `fetchOlderFromServer`: DB hết tin cũ thì xin server một trang (lỗi tạm thời ném ra để hiện "Lỗi - Thử lại")
   - `ensureMessage`: tin không có trong DB khi nhảy tới (tin ghim, trích dẫn)
   - `fetchGroupMembers` / `membersNeedRefresh`: thành viên nhóm từ server
   - `resolveUnknownSenders`: tên + ảnh người gửi chưa biết

   Kênh không đăng ký: khung chat chỉ đọc DB.
4. Việc riêng khi mở hội thoại (nếu có): hook trong `channels/<kênh>/`, gọi trong `useChannelThreadSync`
   (`channels/index.ts`). Hook luôn được gọi và tự bỏ qua khi không phải kênh của mình.
5. Loại tin riêng của kênh: cờ trong `rows/messageKind.ts` + nhánh vẽ ở `SharedMessageContent` / `rows/MessageRow.tsx`.
6. Test: thêm trường hợp vào `src/__tests__/chat/chatWindowChannels.test.ts`.

## Kiểm tra

```bash
npx tsc --noEmit
npx jest src/__tests__/chat/chatWindowChannels.test.ts src/__tests__/chat/messages/chatWindowGrouping.test.ts --maxWorkers=2
```
