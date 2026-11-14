/**
 * guides.ts: Vietnamese guides embedded in the OpenAPI (`x-guides`), shown at /docs
 * and exported to docs/api/*.md by scripts/build-api-docs.js. Edit here, do not edit the .md file.
 */

import { INTEGRATION_GUIDES } from './guidesIntegration';
import { PLUGIN_GUIDES } from './guidesPlugins';
import { tr } from '../../../shared/i18n';

export interface Guide {
    id: string;
    title: string;
    markdown: string;
}

export const OVERVIEW_MARKDOWN = [
    tr('API mở của Deplao cho app, plugin, worker và nền tảng ngoài (n8n, Make, Zapier, server riêng).'),
    tr('Mọi thao tác đi qua **cùng logic với giao diện app** (cùng handler IPC), nên kết quả gửi tin, gán nhãn, chạy workflow giống hệt khi bấm trên app.'),
    '',
    tr('- Base URL trên máy: `http://127.0.0.1:9900/api/v1`'),
    tr('- Từ xa: `https://<địa-chỉ-của-bạn>/api/v1` (cấu hình ở Cài đặt → Internet & Cloud, dịch vụ "Nhân viên và API")'),
    tr('- Xác thực: `Authorization: Bearer dpk_...` hoặc `X-Api-Key: dpk_...`'),
    tr('- Tài liệu máy đọc được: `/api/v1/openapi.json` (import vào Postman, Insomnia, sinh SDK)'),
].join('\n');

export const TAG_DESCRIPTIONS: Record<string, string> = {
    'Hệ thống': tr('Kiểm tra sống, thông tin key, thông tin máy chủ.'),
    'Tài khoản': tr('Tài khoản Zalo, Facebook, Telegram trên máy: danh sách, trạng thái, kết nối, proxy.'),
    'Chat': tr('Hội thoại và tin nhắn mọi kênh: đọc, tìm, gửi, thu hồi, reaction, ghim, đã đọc.'),
    'Nhãn & tin nhanh': tr('Nhãn hội thoại (local), tin nhắn nhanh, sticker.'),
    'Media': tr('Upload file để gửi, tải file đính kèm, thư viện media.'),
    'Nhóm': tr('Nhóm chat: thông tin, thành viên, đổi tên, link mời.'),
    'Danh bạ': tr('Bạn bè, lời mời kết bạn, tra cứu người dùng.'),
    'CRM': tr('Khách hàng, tag CRM, ghi chú, chiến dịch gửi tin.'),
    'Workflow': tr('Workflow tự động hoá: đọc, sửa, bật/tắt, chạy, sự kiện trigger.api.'),
    'Tích hợp': tr('Kết nối POS, vận chuyển, thanh toán: gọi action của adapter.'),
    'ERP': tr('Công việc, dự án, lịch, ghi chú, chấm công, nghỉ phép, thông báo.'),
    'AI': tr('Trợ lý AI: chat, gợi ý trả lời, thống kê sử dụng.'),
    'Báo cáo': tr('Báo cáo tổng quan, lượng tin, giờ cao điểm, chiến dịch, workflow.'),
    'Nhân viên': tr('Quản lý nhân viên, quyền module, phân tài khoản.'),
    'Cài đặt': tr('Đọc/ghi cài đặt trong danh sách cho phép.'),
    'Sự kiện': tr('Nhận sự kiện realtime: Socket.IO, SSE, polling.'),
    'Webhook': tr('Đăng ký webhook outbound có chữ ký HMAC.'),
    'Plugin': tr('Route do plugin đăng ký và thông tin plugin.'),
};

const QUICKSTART = tr('\n## Bắt đầu nhanh (5 phút)\n\n1. Mở Deplao → **Công cụ → Ứng dụng, API & Webhook → API** → bật **API server** (cổng mặc định 9900).\n2. Bấm **Tạo API key**, đặt tên, chọn preset scope (ví dụ "Chat bot"), chọn tài khoản được phép. Copy key `dpk_...` — key chỉ hiện **một lần**.\n3. Thử key:\n\n```bash\ncurl -H "Authorization: Bearer dpk_xxx" http://127.0.0.1:9900/api/v1/me\n```\n\n4. Lấy danh sách tài khoản và hội thoại:\n\n```bash\ncurl -H "Authorization: Bearer dpk_xxx" http://127.0.0.1:9900/api/v1/accounts\ncurl -H "Authorization: Bearer dpk_xxx" "http://127.0.0.1:9900/api/v1/accounts/0501234567/conversations?limit=20"\n```\n\n5. Gửi một tin nhắn:\n\n```bash\ncurl -X POST -H "Authorization: Bearer dpk_xxx" -H "Content-Type: application/json" \\\n  -d \'{"text":"Xin chào từ API"}\' \\\n  http://127.0.0.1:9900/api/v1/accounts/0501234567/conversations/8899001122/messages\n```\n\nTin được gửi bằng đúng luồng của app: hiện trong khung chat, lưu DB, kích hoạt workflow và sự kiện như khi bạn tự gửi.\n\n### SDK\n- TypeScript: `npx openapi-typescript http://127.0.0.1:9900/api/v1/openapi.json -o deplao-api.d.ts` rồi dùng `openapi-fetch`.\n- Python: `openapi-python-client generate --url http://127.0.0.1:9900/api/v1/openapi.json`.\n- Postman/Insomnia: Import → Link → dán URL openapi.json.\n');

const AUTHENTICATION = tr('\n## Xác thực & quyền\n\n### API key\n- Định dạng `dpk_` + 43 ký tự. Gửi qua `Authorization: Bearer dpk_...` hoặc `X-Api-Key: dpk_...`.\n- Deplao chỉ lưu SHA-256 của key. Mất key → thu hồi và tạo key mới.\n- Mỗi key có: **scope**, **tài khoản được phép** (bỏ trống = tất cả), **IP được phép** (IP hoặc CIDR, tuỳ chọn), **hạn dùng** (tuỳ chọn), **giới hạn tốc độ** (mặc định 0 = không giới hạn, bạn tự đặt nếu muốn), **vai trò ERP** (mặc định manager).\n\n### Scope\nXem danh sách đầy đủ ở `GET /api/v1/scopes`. Thiếu scope → `403 FORBIDDEN_SCOPE`. `admin` = mọi scope.\n\n| Preset | Dùng cho |\n| --- | --- |\n| Chỉ đọc | Báo cáo, đồng bộ dữ liệu sang hệ thống khác |\n| Chat bot | Bot trả lời tự động, nhận event, gửi tin/file |\n| Đồng bộ CRM | Đồng bộ khách hàng, tag, ghi chú |\n| Toàn quyền | Công cụ quản trị nội bộ — hạn chế dùng |\n\n### Tài khoản được phép\nKey bị giới hạn tài khoản sẽ nhận `403 FORBIDDEN_ACCOUNT` khi gọi tài khoản khác; danh sách `GET /accounts` chỉ trả tài khoản được phép; event và webhook cũng được lọc theo tài khoản.\n\n### Nhân viên\nToken đăng nhập của nhân viên (employee mode) cũng gọi được API v1. Quyền module của nhân viên được quy đổi thành scope (chat → chat:read/send/manage, crm → crm:*, ...), tài khoản = tài khoản được giao. Nhân viên không bị giới hạn tốc độ.\n\n### ERP\nCác route ERP chạy qua cùng kiểm tra quyền ERP của app. Key dùng vai trò ERP đã đặt (owner/admin/manager/member/guest); thiếu quyền → `403 FORBIDDEN_ERP`.\n\n### Chống dò key\nKhi bật "Chống dò key" (mặc định bật), một IP gửi từ 20 key sai trong 1 phút bị tạm chặn 10 phút (`429 AUTH_BLOCKED`). Request có key hợp lệ không bị ảnh hưởng.\n');

const CONVENTIONS = tr('\n## Quy ước chung\n\n### Envelope\nThành công:\n```json\n{ "success": true, "data": { }, "pagination": { "limit": 50, "has_more": true, "next_before": 1760000000000 }, "request_id": "..." }\n```\nLỗi:\n```json\n{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Tham số body không hợp lệ", "details": [{ "path": "body.text", "message": "Tối đa 10000 ký tự" }] }, "request_id": "..." }\n```\nMỗi response có header `X-Request-Id` — gửi kèm khi báo lỗi.\n\n### Mã lỗi\n| HTTP | code | Ý nghĩa |\n| --- | --- | --- |\n| 400 | VALIDATION_ERROR, INVALID_JSON | Tham số sai |\n| 401 | UNAUTHORIZED | Thiếu/sai/thu hồi/hết hạn key |\n| 403 | FORBIDDEN_SCOPE, FORBIDDEN_ACCOUNT, FORBIDDEN_IP, FORBIDDEN_ERP | Không đủ quyền |\n| 404 | NOT_FOUND | Không có endpoint hoặc dữ liệu |\n| 409 | ACCOUNT_OFFLINE, CONFLICT | Tài khoản chưa kết nối / xung đột |\n| 413 | PAYLOAD_TOO_LARGE | Body/file quá lớn |\n| 422 | CHANNEL_UNSUPPORTED | Kênh không hỗ trợ thao tác |\n| 429 | RATE_LIMITED, AUTH_BLOCKED | Vượt giới hạn bạn đặt / IP bị tạm chặn |\n| 502 | UPSTREAM_ERROR | Zalo/Facebook/Telegram trả lỗi |\n| 503 | API_DISABLED, WORKSPACE_UNAVAILABLE | API tắt / máy đang mở workspace nhân viên |\n| 504 | TIMEOUT | Xử lý quá lâu |\n\n### Phân trang\n- Danh sách thường: `?limit=50&offset=0`, đọc `pagination.next_offset`.\n- Tin nhắn: mới → cũ, `?limit=50&before=<epoch ms>`; trang sau dùng `pagination.next_before`. Tin cùng mốc thời gian có thể lặp ở ranh giới → khử trùng theo `msg_id`.\n\n### Dữ liệu\n- Thời gian: epoch **mili giây**.\n- Tên trường: `snake_case` theo cột DB. Cột JSON (attachments, reactions, quote) đã được parse.\n- Không trả cookie, session, mật khẩu, đường dẫn file trên máy.\n- ID tài khoản = `accounts.zalo_id` (Facebook: Facebook ID; Telegram: ID tài khoản Telegram).\n\n### Idempotency\nVới POST, gửi header `Idempotency-Key: <chuỗi duy nhất>`. Gọi lại cùng key trong 24 giờ trả nguyên kết quả cũ (header `Idempotent-Replayed: true`) thay vì gửi tin lần hai. Lỗi tạm thời (409, 429, 5xx) không được lưu để bạn retry.\n\n### Giới hạn\n- Body JSON tối đa 10 MB, file upload tối đa 100 MB (đổi trong Cài đặt).\n- Mặc định **không giới hạn tốc độ**. Bạn có thể đặt giới hạn cho từng key hoặc mặc định toàn cục.\n- Lời gọi được xếp hàng tối đa N việc đồng thời (mặc định 4) để app không bị giật; request không bị từ chối vì hàng đợi.\n- Gửi tin đi qua cùng hàng đợi gửi theo tài khoản như app để tài khoản Zalo không bị khoá do gửi dồn.\n');

const SENDING = tr('\n## Gửi tin nhắn & file\n\n`POST /api/v1/accounts/{accountId}/conversations/{threadId}/messages`\n\n| Trường | Kiểu | Ghi chú |\n| --- | --- | --- |\n| text | string | Văn bản (≤ 10000 ký tự) |\n| attachments | array | Tối đa 10 file, mỗi file một trong: upload_id, library_uuid, url |\n| sticker_id | string/number | Zalo, Telegram |\n| link | {url, text} | Zalo gửi thẻ link; kênh khác gửi văn bản |\n| quote_msg_id | string | Trả lời tin |\n| mentions | [{user_id, offset, length}] | Tag thành viên (Zalo, Telegram) |\n| thread_type | user/group | Bỏ trống = tự tra |\n\nThứ tự gửi: file → sticker → link → văn bản. Response liệt kê từng tin đã gửi kèm `msg_id` nếu kênh trả về.\n\n### Upload file trước\n```bash\n# Raw body (khuyên dùng cho file lớn — ghi thẳng xuống đĩa)\ncurl -X POST -H "Authorization: Bearer dpk_xxx" -H "X-Filename: bao-gia.pdf" \\\n  --data-binary @bao-gia.pdf http://127.0.0.1:9900/api/v1/media/uploads\n\n# multipart/form-data\ncurl -X POST -H "Authorization: Bearer dpk_xxx" -F "file=@anh.jpg" http://127.0.0.1:9900/api/v1/media/uploads\n```\nKết quả có `upload_id` (hết hạn sau 24 giờ, chỉ key đã upload dùng được).\n\n### Gửi kèm file\n```json\n{ "text": "Báo giá gửi anh", "attachments": [{ "upload_id": "upl_..." }] }\n```\n- `url`: Deplao tự tải file từ link công khai (chặn link vào mạng nội bộ).\n- `library_uuid`: file trong Thư viện media của tài khoản.\n- Video Zalo được gửi như video xem được ngay (không phải file).\n\n### Lưu ý theo kênh\n| Thao tác | Zalo | Facebook | Telegram |\n| --- | --- | --- | --- |\n| Văn bản, ảnh, file | ✓ | ✓ | ✓ |\n| Video | ✓ (video thật) | ✓ | ✓ |\n| Sticker | ✓ | — | ✓ |\n| Sửa tin | — | ✓ | ✓ |\n| Thu hồi | ✓ | ✓ | ✓ (xoá) |\n| Reaction | ✓ (emoji hoặc mã HEART, LIKE…) | ✓ | ✓ |\n| Chuyển tiếp | văn bản, ảnh, video, file | + forward gốc | + forward gốc |\n');

const REMOTE = tr('\n## Truy cập từ xa & bảo mật\n\nAPI chạy trên cổng relay (mặc định 9900). Để server/worker bên ngoài gọi được, cấu hình địa chỉ Internet ở **Cài đặt → Internet & Cloud** (dịch vụ "Nhân viên và API"), chọn một cách tạo địa chỉ:\n\n1. **Cloudflare tự động (khuyên dùng)**: kết nối tài khoản Cloudflare của bạn ở đầu trang → chọn tên miền + "Tên máy" → Áp dụng. Deplao tự tạo tunnel và địa chỉ cố định trên tên miền của bạn; địa chỉ hiện ở bảng dịch vụ, gọi API tại `https://<địa-chỉ>/api/v1`.\n2. **ngrok**: dashboard.ngrok.com → Your Authtoken → dán vào ô Authtoken; mục Domains → lấy domain tĩnh miễn phí → dán vào ô Domain tĩnh; bật "Nhân viên và API". URL cố định: `https://<domain>/api/v1`.\n3. **Cloudflare thủ công** (đã tự cấu hình tunnel): one.dash.cloudflare.com → Networks → Tunnels → tạo tunnel (Cloudflared), sao chép token dán vào ô Tunnel token; thêm Public Hostname trỏ tới `http://localhost:9900`; nhập địa chỉ công khai rồi bật "Nhân viên và API". Token được lưu mã hoá.\n4. **Địa chỉ tạm**: không cần tài khoản, nhưng URL đổi mỗi lần khởi động lại — chỉ nên dùng thử.\n\n### Khuyến nghị khi mở ra Internet\n- Tạo key riêng cho từng hệ thống, scope tối thiểu, giới hạn tài khoản.\n- Đặt **IP được phép** nếu server gọi có IP cố định (IP thật được lấy từ header tunnel).\n- Webhook nhận ở phía bạn phải dùng https và kiểm tra chữ ký.\n- Trang `/docs` và `/api/v1/openapi.json` mặc định ai cũng xem được (chỉ mô tả endpoint, không có dữ liệu). Muốn bắt buộc key khi xem từ xa: tắt "Tài liệu công khai" ở tab Nâng cao.\n- Bật IP restriction / basic auth trên dashboard ngrok hoặc Cloudflare Access cho môi trường production.\n- **Lưu ý:** các endpoint file của chế độ nhân viên (`/api/media/*`, `/api/library/file|thumb/*`) bắt buộc phiên đăng nhập nhân viên (token của app nhân viên, chỉ trả file của tài khoản được giao) và không nhận API key. Hệ thống bên ngoài tải file qua API v1 (vd `GET /api/v1/library/items/{uuid}/file`) bằng key có scope phù hợp.\n\n### Công tắc khẩn cấp\n- Công cụ → Ứng dụng, API & Webhook → API → tắt **API** (trả 503 ngay, không ghi log/event).\n- **Thu hồi tất cả key** một chạm.\n');

export const GUIDES: Guide[] = [
    { id: 'quickstart', title: tr('Bắt đầu nhanh'), markdown: QUICKSTART.trim() },
    { id: 'authentication', title: tr('Xác thực & quyền'), markdown: AUTHENTICATION.trim() },
    { id: 'conventions', title: tr('Quy ước chung'), markdown: CONVENTIONS.trim() },
    { id: 'sending', title: tr('Gửi tin nhắn & file'), markdown: SENDING.trim() },
    { id: 'remote-access', title: tr('Truy cập từ xa & bảo mật'), markdown: REMOTE.trim() },
    ...INTEGRATION_GUIDES,
    ...PLUGIN_GUIDES,
];

/** Other modules (events, webhooks, plugins) add their own guides. */
export function registerGuide(guide: Guide): void {
    const idx = GUIDES.findIndex(g => g.id === guide.id);
    if (idx >= 0) GUIDES[idx] = guide;
    else GUIDES.push(guide);
}
