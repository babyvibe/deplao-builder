# Deplao T123 — web quản lý kết nối đa kênh

Đây là fork Deplao dành cho nhóm P-123: một web trên VPS để đăng nhập tài khoản
Zalo/Facebook/Telegram, quản lý kết nối, API key, webhook và hàng đợi tin.
P-123 dùng URL + API key; developer không phải cài Deplao trên từng máy.

```text
Operator → https://channels.example.com → Deplao trên VPS → các nền tảng
P-123    → https://channels.example.com/api/v1 → hàng đợi gửi của Deplao
P-123    ← webhook có chữ ký ← Deplao
```

Chỉ có hai repo độc lập: `deplao-builder-t123` và `P-123`.
Thư mục cha `product` không phải repo. Không triển khai CGW/node-agent/forwarder riêng.

## 1. Chức năng của bản này

Giữ tài khoản/kết nối, chat kiểm tra, media phục vụ chat, API/key, webhook có retry,
nhật ký và delivery queue. Web mở mặc định ở chat; Cài đặt mở trang quản lý kênh
với bốn tab: API & key, Webhook, Tài khoản, Proxy kênh.

Profile `DEPLAO_CHANNELS_ONLY=1` là mặc định backend; bản build web luôn dùng
profile này. CRM/marketing, ERP, workflow tự động, POS/tích hợp nghiệp vụ, AI
assistant và plugin runtime không được khởi động như trước. Các nhóm API nghiệp
vụ tương ứng không được đăng ký; các trang nghiệp vụ không được mở qua điều hướng.

Một phần source/dependency dùng chung của upstream vẫn còn để giữ tương thích
chat/account. Đây là giảm phần chạy và tải trang, chưa phải xóa sạch mọi module
upstream hoặc chuyển Electron thành Node thuần. Không bật lại profile đầy đủ khi
chạy web. Workflow HTTP cũ không cần cho tích hợp P-123 qua webhook.

## 2. Chạy thử trên máy local trước

Không cần domain, HTTPS, Nginx hay systemd để test local.
Cài Node.js 22.12+ và npm; chạy trong folder `deplao-builder-t123`.
Máy vẫn cần chạy được Electron (Windows/macOS hoặc Linux có display).

Cài dependency lần đầu:

```bash
npm ci
npm run rebuild:native
```

**Windows PowerShell:**

```powershell
$env:DEPLAO_WEB_PASSWORD = 'mat-khau-test-local-123'
$env:DEPLAO_WEB_PORT = '27800'
$env:DEPLAO_WEB_SECURE = '0'
Remove-Item Env:DEPLAO_WEB_ORIGIN -ErrorAction SilentlyContinue
npm run web
```

**Linux/macOS (Bash):**

```bash
export DEPLAO_WEB_PASSWORD='mat-khau-test-local-123'
export DEPLAO_WEB_PORT=27800
export DEPLAO_WEB_SECURE=0
unset DEPLAO_WEB_ORIGIN
npm run web
```

`npm run web` build backend + giao diện rồi chạy server. Mở đúng:

```text
Web:          http://127.0.0.1:27800/
Hàng đợi:     http://127.0.0.1:27800/operations
API base URL: http://127.0.0.1:27800/api/v1
```

Dùng `127.0.0.1`, không thay bằng `localhost` vì server kiểm tra Host.
Đăng nhập bằng mật khẩu vừa đặt. Giữ terminal mở, Ctrl+C để dừng.
Lần sau source chưa đổi, chạy `npm run start:web` trong terminal có các biến
môi trường trên. Nếu sửa source, chạy lại `npm run web`.
Chỉ tạo file .env chưa đủ: các lệnh npm hiện không tự nạp file này.

Facebook E2EE cần build thêm bridge bằng `npm run build:bridge-e2ee`.
Linux không có display cần Xvfb; xem cách chạy ở mục VPS.

### Test cùng P-123 trên một máy

Chạy backend P-123 ở port 8000 theo cách của repo đó, rồi cấu hình:

```env
DEPLAO_BASE_URL=http://127.0.0.1:27800/api/v1
DEPLAO_API_KEY=dpk_key_tao_trong_web_deplao
DEPLAO_DURABLE_DELIVERY=true
DEPLAO_ZALO_ACCOUNT_ID=account_test
DEPLAO_WEBHOOK_SECRET=secret_cua_webhook
```

Tạo webhook trong Deplao tới
`http://127.0.0.1:8000/integrations/deplao/events`, event `message.received`.
Nếu webhook báo chặn địa chỉ nội bộ, kiểm tra tùy chọn cho phép URL private
trong API → Nâng cao. Khởi động lại P-123 sau khi đặt secret.
Nếu P-123 chạy trong Docker/WSL/máy khác, dùng địa chỉ mà tiến trình Deplao
thực sự truy cập được; không mặc định coi hai localhost là cùng máy.

Kiểm tra lần lượt: mở web → đăng nhập account test → bật API/tạo key →
gửi tin từ một tài khoản khác → thấy tin trong P-123 → thấy phản hồi và delivery.
Không dùng chính account bot gửi cho mình để test inbound.

## 3. Chạy trên VPS bằng port

Clone/push **repo `deplao-builder-t123`** vào `/opt/deplao-builder-t123`.
P-123 có thể chạy trên VPS khác hoặc máy developer.

Cần Node.js 22.12+, npm, môi trường Linux chạy được Electron, Xvfb nếu không có
display, user `deplao` không phải root và home ghi được. Native module SQLite
phải được build cho đúng Electron. Facebook E2EE còn cần Go/bridge của fork;
giữ thư mục `src/bridge-e2ee` và build bridge nếu sử dụng kênh đó.

Dưới user chạy ứng dụng:

```bash
cd /opt/deplao-builder-t123
npm ci
npm run rebuild:native
npm run build:electron
npm run build:web
# Nếu dùng Facebook E2EE:
npm run build:bridge-e2ee
cp .env.example .env
chmod 600 .env
```

### Cấu hình máy chủ và chạy lâu dài

Điền `.env` (không commit secret):

```env
NODE_ENV=production
DEPLAO_WEB=1
DEPLAO_CHANNELS_ONLY=1
DEPLAO_WEB_PASSWORD=thay-bang-mat-khau-ngau-nhien-dai
DEPLAO_WEB_PORT=27800
DEPLAO_WEB_ORIGIN=https://channels.example.com
DEPLAO_WEB_SECURE=1
```

Mật khẩu web là quyền operator/chủ máy. API key của P-123 là credential riêng.
Các operator cùng truy cập một workspace; đây chưa phải mô hình SaaS có tài
khoản/tenant độc lập cho từng người.

`npm run start:web` không tự đọc .env. File systemd bên dưới đọc .env qua
EnvironmentFile. Khi chạy thử thủ công, export các biến tương ứng trước;
chạy HTTP loopback thì bỏ DEPLAO_WEB_ORIGIN và dùng DEPLAO_WEB_SECURE=0.

Có thể chạy thủ công giống local. Trên Linux không có display, sau khi build
và export các biến môi trường:

```bash
xvfb-run -a npm run start:web
```

Nếu muốn tự chạy lại sau reboot, dùng [service mẫu](deploy/deplao-web.service)
(tùy chọn), sửa user/đường dẫn cho đúng:

```bash
sudo cp deploy/deplao-web.service /etc/systemd/system/deplao-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now deplao-web
sudo systemctl status deplao-web
journalctl -u deplao-web -f
```

Service sử dụng `xvfb-run`. Không chạy desktop thứ hai trên cùng profile.
Không dùng `--no-sandbox` để thay cho việc cấu hình user/runtime đúng.

## 4. HTTPS/domain do bạn cấu hình

Ứng dụng chỉ cung cấp HTTP tại `http://127.0.0.1:27800`.
Bạn dùng hệ thống proxy/tunnel sẵn có để trỏ domain tới port này; **không bắt buộc
Nginx**. Khi dùng domain HTTPS, đặt DEPLAO_WEB_ORIGIN đúng domain và
DEPLAO_WEB_SECURE=1 rồi khởi động lại ứng dụng.

Proxy cần giữ kết nối SSE lâu dài, tắt buffering cho luồng sự kiện và cho phép
request upload tối đa 64 MB nếu sử dụng media.

Origin phải khớp chính xác domain HTTPS, gồm port nếu không chuẩn. Host upstream
phải là 127.0.0.1:27800 để qua kiểm tra chống DNS rebinding. Proxy chạy trong
container cần đường mạng tới host; localhost trong container không phải VPS host.
**Giới hạn hiện tại:** server chỉ bind `127.0.0.1`, chưa có biến cấu hình
bind `0.0.0.0`. Không thể mở ngay `http://IP-VPS:27800` từ máy khác.
Proxy/tunnel cần truy cập được loopback của máy chạy Deplao.
API IP whitelist nhìn thấy IP proxy;
nếu cần chặn client IP, thực hiện ở proxy.

## 5. Operator sử dụng web

1. Mở domain, nhập mật khẩu web.
2. Thêm tài khoản qua nút thêm account; hoàn tất QR/phone/token tùy kênh.
3. Vào Cài đặt hoặc Công cụ → API/Webhook; bật quyền gọi API.
4. Tạo key cho mỗi backend/developer với quyền account đọc, chat đọc/gửi,
   sự kiện/webhook cần dùng; chỉ cấp account test đã thống nhất.
5. Tạo webhook `message.received`, chọn account, URL backend P-123.
6. Copy webhook secret một lần sang backend, gửi test để kiểm tra kết nối.
7. Xem lịch sử webhook tại tab Webhook; xem hàng đợi gửi tại `/operations`
   hoặc nút “Hàng đợi kênh” trên thanh đầu trang.

Cookie web là HttpOnly, SameSite=Strict; production dùng Secure. API Bearer không
được thay bằng cookie web. Không đưa API key vào frontend của P-123.

Một số luồng đăng nhập/challenge cần cửa sổ native trên VPS. Các thao tác mở
Explorer/chọn thư mục hệ điều hành chưa được chuyển hết sang browser. Phải kiểm
tra tài khoản thật trước production; automated tests không chứng minh khả năng
đăng nhập mọi nền tảng.

## 6. P-123 kết nối

Trong .env của repo P-123:

```env
DEPLAO_BASE_URL=https://channels.example.com/api/v1
DEPLAO_API_KEY=dpk_key_duoc_operator_cap
DEPLAO_DURABLE_DELIVERY=true
DEPLAO_ZALO_ACCOUNT_ID=account-zalo-test
DEPLAO_FB_ACCOUNT_ID=
DEPLAO_TELEGRAM_ACCOUNT_ID=
DEPLAO_WEBHOOK_SECRET=secret-cua-subscription
DEPLAO_INBOX_PATH=./data/deplao-inbox.db
```

Production: `DEMO_MODE=false`, AUTH_SECRET riêng. Bỏ biến CGW_* cũ.
URL nhận webhook: `https://<backend>/integrations/deplao/events`.
Nếu Deplao chạy trên VPS còn P-123 chạy local, backend cần URL truy cập được từ
VPS qua tunnel/VPN; VPS không thể gọi localhost của máy developer.
Nếu cả hai cùng máy local, dùng địa chỉ HTTP ở mục 2.

Mỗi developer dùng account riêng, hoặc chỉ một backend xử lý một account tại
một thời điểm. Nhiều subscription cùng tự trả lời một account sẽ gây trùng trả lời.
Tắt workflow HTTP cũ gọi /internal/ingest khi chuyển sang webhook native.

P-123 kiểm chữ ký HMAC + timestamp, lưu inbox SQLite trước khi trả 200 rồi xử lý
nền. Tin trả lời ngay dùng account của webhook. Tin chủ động có thể truyền
account_id, nếu thiếu dùng account mặc định theo kênh.

Adapter nghiệp vụ hiện nhận text Zalo/Messenger/Telegram. Ảnh, postback, OA và
định danh cư dân cho kênh mới cần kiểm tra/mở rộng riêng; không coi có driver là
mọi nghiệp vụ đã hỗ trợ.

## 7. Hợp đồng API và trạng thái gửi

Header: `Authorization: Bearer dpk_...`. API đầy đủ được sinh tại `/docs`.

- `GET /api/v1/accounts`: account được cấp và trạng thái kết nối.
- `POST /api/v1/deliveries`: ghi lệnh gửi bền vững.
- `GET /api/v1/deliveries`: 100 delivery gần nhất thuộc key.
- `GET /api/v1/deliveries/<outbound_id>`: tra trạng thái một tin.

Body gửi:

```json
{
  "outbound_id": "out-test-001",
  "account_id": "account-test",
  "conversation_id": "user-or-group-id",
  "text": "Tin thử",
  "thread_type": "user"
}
```

Nhóm dùng thread_type=group. Giữ nguyên outbound_id khi retry HTTP:
cùng ID/payload trả bản ghi cũ, khác payload trả 409.
Đọc kết quả trong envelope `{success, data, request_id}`.

| Trạng thái | Ý nghĩa và hành động |
|---|---|
| PENDING | Đã lưu, chờ account online/đủ điều kiện gửi |
| SENDING | Đang gọi nền tảng |
| SENT | API nền tảng chấp nhận; không có nghĩa người nhận đã đọc |
| FAILED | Gửi bị từ chối; xem lỗi, sửa cấu hình rồi retry trên web |
| UNKNOWN | Có thể đã gửi nhưng thiếu kết quả; đối chiếu hội thoại trước, không tự retry |

Deplao restart vẫn giữ PENDING; SENDING dang dở chuyển UNKNOWN.
P-123 thăm dò để đồng bộ lịch sử chat PENDING thành SENT/FAILED.
Key bị thu hồi/mất quyền account không tiếp tục gửi lệnh đã xếp hàng.

## 8. Lỗi thường gặp, bảo trì

| Hiện tượng | Kiểm tra |
|---|---|
| Web 403 | Host proxy và DEPLAO_WEB_ORIGIN |
| Web đăng nhập lặp | HTTPS/Secure cookie, domain, service restart |
| API 401/403 | Key, scope, account được cấp, bật API |
| PENDING tăng | Account online chưa, key còn quyền không |
| Webhook thất bại | URL P-123, secret, logs P-123; retry tại tab Webhook |
| Deplao không lên | journalctl, Xvfb/display, thư viện Electron, ABI SQLite |
| Inbox P-123 FAILED/UNKNOWN | Log nghiệp vụ và database inbox; đối chiếu trước khi replay |

Webhook Deplao retry theo lịch, quá số lần chuyển failed; không giữ retry vô hạn.
P-123 tắt không làm chết Deplao. Deplao tắt không làm chết nghiệp vụ P-123, nhưng
kênh mất kết nối; không đảm bảo nhận được mọi tin phát sinh khi connector offline.

Backup profile/workspace của user deplao khi service đã dừng, gồm DB/secret/phiên
đăng nhập; backup data P-123 riêng. Không chỉ sao lưu source, không xóa DB để sửa lỗi.
Sau update: build lại, restart service, kiểm tra account/webhook và thử gửi/nhận.

## 9. Kiểm tra code

```bash
npm run build:electron
npm run build:web
npm run test:web
npm run test:delivery
```

Test delivery chạy bằng Node của Electron để khớp ABI better-sqlite3.
Nghiệm thu thật cần đăng nhập account, tin vào/ra, backend P-123 tắt/bật,
restart Deplao và thu hồi API key. Các test tự động dùng dữ liệu giả.

## 10. CI/CD cập nhật VPS

Repo có workflow CI chạy test/build khi mở PR hoặc push `main`, và workflow CD
chạy sau push `main` hoặc khi bấm chạy thủ công. CD cập nhật đúng commit đã được
kiểm tra, rebuild SQLite native module, build web/Electron, restart service rồi
health-check. Không cần Docker hay Nginx cho pipeline này.

Trên VPS clone repo tại `/opt/deplao-builder-t123`, cài Node/npm, Electron,
Xvfb, git và cài service trước lần deploy đầu tiên. User deploy cần được phép
chạy `sudo systemctl restart deplao-web` không nhập mật khẩu.

Tạo GitHub Environment tên `production`, giới hạn branch `main`, rồi thêm secrets:

```text
VPS_HOST          # hostname/IP VPS
VPS_USER          # user deploy, không dùng root
VPS_PORT          # thường là 22
VPS_SSH_KEY       # private key riêng cho CI/CD
VPS_KNOWN_HOSTS  # host key đã kiểm tra thủ công
```

`.env`, profile đăng nhập, SQLite và media nằm ngoài Git nên không bị ghi đè.
Workflow dùng concurrency để không có hai bản production deploy cùng lúc.
Không đưa API key, mật khẩu web, private key hoặc `.env` vào log Actions.

Rollback thủ công trên VPS:

```bash
sudo -u deplao /opt/deplao-builder-t123/deploy/rollback-vps.sh \
  /opt/deplao-builder-t123/.deploy-backups/<timestamp>.commit
```

Đây là tài liệu vận hành duy nhất của fork. Tài liệu nằm trong mã nguồn
bridge/vendor là tài liệu kỹ thuật đi kèm phụ thuộc, không phải quy trình deploy
khác. Giữ LICENSE và thông báo bản quyền của upstream.
