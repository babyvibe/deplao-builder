/**
 * guidesIntegration.ts — hướng dẫn Sự kiện, Webhook và công thức tích hợp (n8n, Make,
 * Apps Script, Worker). Ghép vào GUIDES trong guides.ts. Sửa ở đây, không sửa docs/api/*.md.
 */
import type { Guide } from './guides';

const EVENTS = `
## Sự kiện realtime

Có 4 cách nhận sự kiện, chọn theo nơi chạy code của bạn:

| Cách | Phù hợp | Ghi chú |
|---|---|---|
| Socket.IO namespace \`/v1\` | App, worker giữ kết nối lâu | Nhanh nhất, có cả \`conversation.typing\` |
| SSE \`GET /api/v1/events/stream\` | Script, server không cài được socket.io | Chạy tốt qua tunnel |
| Polling \`GET /api/v1/events?since=\` | Cron, serverless, Google Apps Script | Không cần giữ kết nối |
| Webhook | Server có URL công khai | Deplao chủ động POST, tự thử lại (xem hướng dẫn "Webhook") |

Key cần scope \`events:subscribe\` (webhook cần \`webhooks:manage\`).

### Cấu trúc một sự kiện

\`\`\`json
{
  "id": "evt_6b1f0c2d9a4e4c1b8f3a2d10",
  "seq": 1532,
  "type": "message.received",
  "ts": 1760412345678,
  "account_id": "0501234567",
  "channel": "zalo",
  "data": {
    "message": { "msg_id": "7712345678901", "thread_id": "8765432109876", "thread_type": "user", "text": "Shop ơi còn size M không?", "is_self": false },
    "conversation": { "thread_id": "8765432109876", "display_name": "Lan Nguyễn" }
  }
}
\`\`\`

- \`seq\` tăng dần và là "con trỏ" để nhận tiếp phần bị lỡ. Hãy lưu \`seq\` cuối cùng đã xử lý.
- \`data.message\` có cùng dạng với \`GET .../messages\`, nên một hàm xử lý dùng được cho cả hai.
- \`conversation.typing\` không được lưu (\`seq = 0\`) và chỉ có trên Socket.IO và SSE.
- Danh mục đầy đủ kèm mô tả: \`GET /api/v1/events/types\` (không cần key).

### Quy tắc

- Key chỉ nhận sự kiện của tài khoản được cấp. Sự kiện toàn hệ thống (\`payment.received\`, \`plugin.*\`, \`ping\`) chỉ gửi cho key không giới hạn tài khoản.
- Lọc loại: \`message.received\` (đúng tên), \`message.*\` (cả nhóm), \`*\` (tất cả).
- Deplao chỉ ghi sự kiện khi có nơi nhận: key có scope sự kiện/webhook, kết nối đang mở hoặc webhook đang bật. Sự kiện xảy ra trước khi bạn tạo key đầu tiên sẽ không có.
- Tin cũ hơn 5 phút (đồng bộ lịch sử, tải tin cũ) không phát \`message.received\`.
- Sự kiện được giữ 7 ngày hoặc 50.000 bản ghi gần nhất (đổi trong Công cụ → Ứng dụng, API & Webhook → API → Nâng cao).
- Giao **ít nhất một lần**: khi kết nối lại có thể nhận trùng. Khử trùng bằng \`id\` hoặc \`seq\`.

### Socket.IO (Node.js)

\`\`\`js
// npm i socket.io-client@4
import { io } from 'socket.io-client';
import fs from 'node:fs';

let lastSeq = Number(fs.existsSync('seq.txt') ? fs.readFileSync('seq.txt', 'utf8') : 0);
const socket = io('http://127.0.0.1:9900/v1', {
  auth: { apiKey: process.env.DEPLAO_KEY },
  transports: ['websocket'],
});

socket.on('hello', ({ seq_now }) => {
  // Lần đầu bắt đầu từ hiện tại; các lần sau nhận cả phần bị lỡ lúc mất kết nối.
  socket.emit('subscribe', { types: ['message.*'], since: lastSeq || seq_now }, (ack) => console.log('subscribed', ack));
});

socket.on('event', (ev) => {
  if (ev.type === 'message.received') {
    console.log(ev.data.conversation.display_name, ':', ev.data.message.text);
  }
  if (ev.seq) {
    lastSeq = ev.seq;
    fs.writeFileSync('seq.txt', String(lastSeq));
  }
});

socket.on('connect_error', (err) => console.error('Không kết nối được:', err.message));
\`\`\`

- Lỗi kết nối trả qua \`connect_error\`: \`UNAUTHORIZED\` (sai key), \`FORBIDDEN_SCOPE\` (thiếu \`events:subscribe\`), \`FORBIDDEN_IP\`, \`API_DISABLED\`.
- \`subscribe\` nhận \`{ types, account_ids, since }\`. Gọi lại \`subscribe\` để đổi bộ lọc; \`unsubscribe\` để dừng.
- Qua tunnel: \`io('https://<domain>/v1', ...)\` (path mặc định \`/socket.io\`).

### SSE

\`\`\`bash
curl -N -H "Authorization: Bearer dpk_xxx" "http://127.0.0.1:9900/api/v1/events/stream?types=message.*&since=1500"
\`\`\`

\`\`\`text
id: 1532
event: message.received
data: {"id":"evt_...","seq":1532,"type":"message.received",...}
\`\`\`

- Kết nối lại với header \`Last-Event-ID: <seq>\` hoặc \`?since=<seq>\` để nhận phần bị lỡ.
- Cứ 15 giây có dòng \`: ping\` để giữ kết nối qua proxy và tunnel.
- \`EventSource\` của trình duyệt không gửi được header \`Authorization\`. Trong trình duyệt hãy dùng Socket.IO.

Python:

\`\`\`python
import json, requests

r = requests.get(
    "http://127.0.0.1:9900/api/v1/events/stream",
    params={"types": "message.received"},
    headers={"Authorization": "Bearer dpk_xxx"},
    stream=True, timeout=(5, 60),
)
for line in r.iter_lines(decode_unicode=True):
    if line and line.startswith("data: "):
        ev = json.loads(line[6:])
        print(ev["seq"], ev["data"]["message"]["text"])
\`\`\`

### Polling

\`\`\`bash
curl -H "Authorization: Bearer dpk_xxx" "http://127.0.0.1:9900/api/v1/events?since=0&types=message.received&limit=100"
\`\`\`

\`\`\`json
{ "success": true, "data": [ { "seq": 1532, "type": "message.received" } ], "pagination": { "limit": 100, "has_more": false, "next_since": 1532 }, "request_id": "..." }
\`\`\`

Gọi lại với \`since = pagination.next_since\`. Khi \`has_more = true\` gọi tiếp ngay, khi \`false\` đợi vài giây.
`;

const WEBHOOKS = `
## Webhook

Deplao POST sự kiện tới URL của bạn ngay khi có. Bạn không cần giữ kết nối; Deplao tự thử lại khi server của bạn lỗi.

### Đăng ký

\`\`\`bash
curl -X POST http://127.0.0.1:9900/api/v1/webhooks -H "Authorization: Bearer dpk_xxx" -H "Content-Type: application/json" -d '{"name":"CRM sync","url":"https://crm.example.com/deplao","events":["message.received","payment.received"]}'
\`\`\`

Kết quả có \`secret\` dạng \`whsec_...\`, **chỉ hiện một lần**. Lưu lại để kiểm tra chữ ký. Gửi thử: \`POST /api/v1/webhooks/{id}/test\`.

### Deplao gửi gì

\`\`\`http
POST /deplao HTTP/1.1
Host: crm.example.com
Content-Type: application/json
User-Agent: Deplao-Webhook/1
X-Deplao-Event: message.received
X-Deplao-Delivery: dlv_3c9e5a0f6d2b4e7a9c1d8f20
X-Deplao-Timestamp: 1760412345
X-Deplao-Signature: v1=5d0c7f...e1

{"id":"evt_...","seq":1532,"type":"message.received","ts":1760412345678,"account_id":"0501234567","channel":"zalo","data":{...}}
\`\`\`

- Thành công là HTTP 2xx trong 10 giây. Hãy trả 200 ngay rồi xử lý sau (đưa vào hàng đợi).
- Redirect (3xx) không được đi theo và bị tính là lỗi. Hãy đăng ký URL cuối cùng.
- Thử lại sau 30 giây, 2 phút, 10 phút, 1 giờ, 6 giờ (tổng 6 lần), sau đó chuyển \`failed\`. Gửi lại tay: \`POST /api/v1/webhook-deliveries/{id}/retry\`.
- 100 lần lỗi liên tiếp thì webhook tự tắt. Bật lại bằng \`PATCH /api/v1/webhooks/{id}\` với \`{"active": true}\`.
- Có thể nhận trùng và sai thứ tự khi có thử lại. Khử trùng bằng header \`X-Deplao-Delivery\` hoặc \`id\`, sắp xếp bằng \`seq\`.
- Webhook dùng quyền của key tạo ra nó: chỉ nhận sự kiện của tài khoản key được cấp; key bị thu hồi thì ngừng gửi.
- URL nội bộ (\`localhost\`, \`192.168.x\`, \`10.x\`) chỉ được dùng khi tạo webhook từ chính máy chạy Deplao (không qua tunnel), hoặc khi bật \`api_allow_private_urls\`.

### Kiểm tra chữ ký

Chữ ký là \`v1=\` + hex(HMAC-SHA256(secret, timestamp + "." + body gốc)). Luôn dùng **body gốc** (chưa parse JSON), so sánh an toàn thời gian, và từ chối timestamp lệch quá 5 phút.

Node.js (Express):

\`\`\`js
import express from 'express';
import crypto from 'node:crypto';

const SECRET = process.env.DEPLAO_WEBHOOK_SECRET;
const app = express();

app.post('/deplao', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('X-Deplao-Timestamp') || '0';
  const sig = req.get('X-Deplao-Signature') || '';
  const expected = 'v1=' + crypto.createHmac('sha256', SECRET).update(ts + '.' + req.body.toString('utf8')).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!fresh || !valid) return res.status(401).end();

  res.status(200).end(); // trả lời ngay
  const event = JSON.parse(req.body.toString('utf8'));
  console.log(event.type, event.seq); // xử lý sau, ví dụ đưa vào hàng đợi
});

app.listen(3000);
\`\`\`

Python (Flask):

\`\`\`python
import hashlib, hmac, os, time
from flask import Flask, abort, request

SECRET = os.environ["DEPLAO_WEBHOOK_SECRET"].encode()
app = Flask(__name__)

@app.post("/deplao")
def deplao():
    ts = request.headers.get("X-Deplao-Timestamp", "0")
    sig = request.headers.get("X-Deplao-Signature", "")
    body = request.get_data()  # bytes gốc
    expected = "v1=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    if abs(time.time() - int(ts)) > 300 or not hmac.compare_digest(sig, expected):
        abort(401)
    event = request.get_json()
    print(event["type"], event["seq"])
    return "", 200
\`\`\`

PHP:

\`\`\`php
<?php
$secret = getenv('DEPLAO_WEBHOOK_SECRET');
$body = file_get_contents('php://input');
$ts = $_SERVER['HTTP_X_DEPLAO_TIMESTAMP'] ?? '0';
$sig = $_SERVER['HTTP_X_DEPLAO_SIGNATURE'] ?? '';
$expected = 'v1=' . hash_hmac('sha256', $ts . '.' . $body, $secret);
if (abs(time() - (int)$ts) > 300 || !hash_equals($expected, $sig)) {
    http_response_code(401);
    exit;
}
$event = json_decode($body, true);
http_response_code(200);
// xử lý $event['type'], $event['data']
\`\`\`

Cloudflare Worker (Web Crypto):

\`\`\`js
export default {
  async fetch(request, env) {
    const body = await request.text();
    const ts = request.headers.get('X-Deplao-Timestamp') || '0';
    const hex = (request.headers.get('X-Deplao-Signature') || '').replace('v1=', '');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.DEPLAO_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
    const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(ts + '.' + body));
    if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return new Response('bad signature', { status: 401 });
    const event = JSON.parse(body);
    // ghi vào Queue / KV / D1 rồi xử lý sau
    return new Response('ok');
  },
};
\`\`\`
`;

const RECIPES = `
## Công thức tích hợp

### n8n

- **Gọi API:** node *HTTP Request* → Authentication *Generic Credential Type* → *Header Auth*, Name \`Authorization\`, Value \`Bearer dpk_xxx\`. URL dạng \`https://<domain>/api/v1/...\`.
- **Nhận sự kiện:** node *Webhook* (POST), bật Options → *Raw Body*. Copy Production URL rồi đăng ký bằng \`POST /api/v1/webhooks\`. Kiểm tra chữ ký bằng node *Crypto* (HMAC, SHA256, hex) trên chuỗi \`<X-Deplao-Timestamp>.<body gốc>\`.
- **Ví dụ:** đơn hàng mới (Webhook từ web bán hàng) → *HTTP Request* \`POST /api/v1/accounts/{account_id}/conversations/{thread_id}/messages\` với body \`{"text": "Cảm ơn bạn đã đặt đơn #{{$json.order_id}}"}\`.

### Make (Integromat)

- **Gọi API:** module *HTTP → Make a request*, header \`Authorization: Bearer dpk_xxx\`, Body type *Raw*, Content type *JSON (application/json)*.
- **Nhận sự kiện:** *Webhooks → Custom webhook*, copy địa chỉ rồi đăng ký webhook Deplao với \`events\` cần thiết. Nếu kịch bản không tự kiểm tra chữ ký được, hãy giữ bí mật địa chỉ webhook (Make sinh địa chỉ ngẫu nhiên dài) và chỉ dùng HTTPS.

### Google Apps Script / Google Sheets

Apps Script không đọc được header của request gửi đến (không kiểm tra được chữ ký) và trả 302 cho POST, nên **không dùng webhook**. Hãy dùng polling với trình kích hoạt theo thời gian (Triggers → Time-driven → mỗi phút):

\`\`\`js
const BASE = 'https://<domain>/api/v1';

function pollDeplao() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DEPLAO_KEY');
  const since = Number(props.getProperty('since') || 0);
  const res = UrlFetchApp.fetch(BASE + '/events?types=message.received&limit=200&since=' + since, {
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());
  if (!body.success) throw new Error(body.error.code + ': ' + body.error.message);
  const sheet = SpreadsheetApp.getActive().getSheetByName('Tin nhắn');
  body.data.forEach(function (ev) {
    const conv = ev.data.conversation || {};
    const msg = ev.data.message || {};
    sheet.appendRow([new Date(ev.ts), ev.account_id, conv.display_name, msg.text]);
  });
  props.setProperty('since', String(body.pagination.next_since));
}
\`\`\`

### Worker hoặc server riêng (gọi API)

\`\`\`js
const res = await fetch('https://<domain>/api/v1/accounts/0501234567/conversations/8765432109876/messages', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.DEPLAO_KEY,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-1001-shipped', // gửi lại cùng key → không tạo tin trùng
  },
  body: JSON.stringify({ text: 'Đơn hàng #1001 đã giao cho shipper', thread_type: 'user' }),
});
const out = await res.json();
if (!out.success) console.error(out.error.code, out.error.message);
\`\`\`

- \`Idempotency-Key\` được nhớ 24 giờ (cho tới khi app khởi động lại). Gửi lại cùng key trả nguyên kết quả lần đầu.
- Nhóm chat: \`"thread_type": "group"\`.

### Sinh SDK và công cụ

\`\`\`bash
npx @openapitools/openapi-generator-cli generate -i http://127.0.0.1:9900/api/v1/openapi.json -g typescript-fetch -o deplao-sdk
\`\`\`

- Postman, Insomnia, Bruno: Import → URL \`http://127.0.0.1:9900/api/v1/openapi.json\`.
- \`openapi.json\` mặc định xem được không cần key. Nếu đã tắt "Tài liệu công khai", thêm header \`Authorization\` khi import từ xa.
`;

export const INTEGRATION_GUIDES: Guide[] = [
    { id: 'events', title: 'Sự kiện realtime', markdown: EVENTS.trim() },
    { id: 'webhooks', title: 'Webhook', markdown: WEBHOOKS.trim() },
    { id: 'recipes', title: 'Công thức: n8n, Make, Apps Script, Worker', markdown: RECIPES.trim() },
];
