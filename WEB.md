# Chạy Deplao trong trình duyệt

Chế độ web dùng lại giao diện React và logic nghiệp vụ của Deplao. Trình duyệt gọi
backend qua HTTP và nhận sự kiện thời gian thực qua SSE. Máy chủ vẫn chạy Electron
ngầm với một cửa sổ trống, ẩn để tương thích các service hiện tại; không chạy thêm
một bản giao diện desktop. Đây chưa phải backend Node độc lập hay bản SaaS.

## Cài đặt và chạy

Dùng Node.js 22.12 trở lên và môi trường có thể chạy Electron. Linux cần các thư viện
hệ thống và display mà Electron yêu cầu. Giữ backend chạy trong lúc sử dụng web.

```sh
npm ci
npm run rebuild:native
export DEPLAO_WEB_PASSWORD='thay-bang-mat-khau-rieng-it-nhat-12-ky-tu'
npm run web
```

Với PowerShell, thay lệnh `export` bằng:

```powershell
$env:DEPLAO_WEB_PASSWORD = 'thay-bang-mat-khau-rieng-it-nhat-12-ky-tu'
npm run web
```

Mở **http://127.0.0.1:27800** và nhập mật khẩu đã đặt. Dùng đúng địa chỉ `127.0.0.1`;
gateway kiểm tra Host và Origin nên `localhost` không phải địa chỉ thay thế.
`DEPLAO_WEB_PORT` đổi cổng mặc định. Không ghi mật khẩu vào source code.

Khi chạy sau reverse proxy HTTPS, đặt `DEPLAO_WEB_ORIGIN` đúng bằng origin public,
ví dụ `https://deplao.example.com`, và đặt `DEPLAO_WEB_SECURE=1` để cookie chỉ đi
qua HTTPS. Proxy phải giữ `Host: 127.0.0.1:27800`; không chuyển tiếp Host public
vào gateway vì gateway cố ý kiểm tra Host để chống DNS rebinding.

`npm run web` biên dịch backend và giao diện trước khi chạy. Những lần tiếp theo,
nếu source chưa đổi, chỉ cần đặt mật khẩu và chạy `npm run start:web`. Dừng backend
bằng Ctrl+C. Chế độ desktop vẫn dùng `npm run dev` như trước.

Nếu dùng E2EE Facebook, build bridge bằng `npm run build:bridge-e2ee` theo hướng dẫn
cài đặt sẵn có của dự án trước khi khởi động.

## Hành vi và giới hạn

- Gateway chỉ lắng nghe `127.0.0.1`. Chưa có cấu hình domain, HTTPS, reverse proxy
  hay truy cập LAN/Internet; không mở cổng này ra Internet bằng tunnel hiện có.
- Đây là giao diện cho chủ máy với quyền tương đương desktop, dùng cùng thư mục
  dữ liệu và workspace. Các tab cùng đăng nhập chia sẻ workspace đang mở; chưa có
  workspace riêng theo phiên web. Không chạy song song desktop và backend web trên
  cùng profile. Người dùng vẫn có thể sử dụng các workspace nhân viên hiện có,
  nhưng mật khẩu gateway không phải tài khoản nhân viên hay cơ chế phân quyền SaaS.
- Cookie đăng nhập HttpOnly, SameSite=Strict, hết hạn sau 12 giờ. Đăng xuất ở thanh
  trên thu hồi phiên và đóng SSE của phiên đó. Khởi động lại backend thu hồi mọi
  phiên. Gateway giới hạn thử mật khẩu, kích thước request và số kết nối.
- Khi SSE kết nối lại, trang tải lại snapshot hiện tại. Lệnh ghi dữ liệu không tự
  thử lại để tránh gửi trùng tin nhắn. Nếu kết nối lỗi ngay lúc mở trang, tải lại
  trang sau khi backend hoạt động.
- Hộp chọn file dùng trình duyệt và tải file lên backend, tối đa 40 MB mỗi file.
  Media cục bộ được phục vụ qua HTTP có xác thực và hỗ trợ byte range cho video;
  đường dẫn và symlink ra ngoài các thư mục media/avatar/upload/temp được chặn.
  File được lưu trên backend, không tự truy cập ổ đĩa máy khách.
- Lưu file về máy khách dùng download của trình duyệt. Nguồn file cần đã có trên
  backend; nếu chỉ còn URL từ xa, tải media trong cuộc trò chuyện trước.
- Các thao tác cần giao diện hệ điều hành như chọn thư mục lưu trữ, mở Explorer,
  chụp màn hình desktop, cài plugin bằng hộp thoại và xác nhận quản lý Workers chưa
  được chuyển sang web. Backend từ chối những lệnh đó; các luồng đăng nhập bên thứ
  ba cần cửa sổ native vẫn phụ thuộc môi trường máy chủ. Plugin dùng giao thức
  `deplao-plugin://` chưa chạy bên trong trình duyệt.
- Media thiếu trên đĩa cần được đồng bộ/tải lại trước; gateway không thay thế cơ
  chế phục hồi R2 trong protocol Electron.

## Kiểm tra

```sh
npm run test:web
node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit
npm run build:web
npm run build:renderer
npm run build:electron
```

Các test web kiểm tra đăng nhập, thu hồi phiên, Origin/Host, RPC, sự kiện SSE,
traversal/symlink và byte range. Build web xuất vào `dist-web`, tách khỏi `dist`
của desktop. `electron/preload.ts` và browser transport cùng dùng
`src/shared/platform/createClientApi.ts` để giữ nguyên ánh xạ API.
