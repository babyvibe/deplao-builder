/**
 * guidesPlugins.ts — hướng dẫn viết plugin (hiện ở /docs, xuất ra docs/api/*.md).
 * Nội dung bám đúng code: manifest.ts, PluginApiBridge.ts, plugin-worker.ts, webSdk.ts.
 */
import type { Guide } from './guides';

const START = `
## Ứng dụng (plugin): bắt đầu trong 10 phút

> Trong giao diện Deplao, plugin hiển thị là **Ứng dụng** (Công cụ → Ứng dụng, API & Webhook). Tài liệu và mã nguồn giữ chữ *plugin*: file \`deplao-plugin.json\`, gói \`@deplao/plugin-sdk\`, lệnh \`deplao-plugin\`, endpoint \`/api/v1/plugins\`.

Plugin là ứng dụng bất kỳ chạy ngay trong Deplao — công cụ nội bộ, kết nối hệ thống riêng, nghiệp vụ theo ngành… — với giao diện và công nghệ web tuỳ bạn chọn. Plugin có thể thêm trang riêng, panel trong màn chat, nút trong ô soạn tin, node workflow, route API, lịch chạy. Mọi thứ plugin làm với dữ liệu đều đi qua \`deplao.*\` — cùng API v1, cùng kiểm tra quyền như app ngoài.

### 1. Tạo plugin

\`\`\`bash
node packages/plugin-cli/bin/deplao-plugin.js create my-shop --runtime web --id vn.acme.myshop --name "My Shop"
\`\`\`

| Runtime | Khi nào dùng |
|---|---|
| \`web\` | Chỉ giao diện (trang, panel): mọi logic chạy trong iframe |
| \`local\` | Có logic nền: node workflow, route, lịch chạy, xử lý sự kiện (chạy trong tiến trình riêng trên máy) |
| \`remote\` | Logic nằm trên server của bạn; Deplao gọi qua HTTPS có chữ ký |

### 2. Chạy thử ngay trong app

**Công cụ → Ứng dụng, API & Webhook** (thanh điều hướng) → nút **Phát triển ứng dụng** → **Thêm thư mục đang phát triển** → chọn thư mục → duyệt quyền. Plugin hiện thành một ô trong danh sách **Ứng dụng đã cài**; bấm **Mở** để vào trang của plugin, bấm vào ô để xem chi tiết, cài đặt, nhật ký. Sửa file trong \`backend/\` thì plugin tự tải lại; sửa UI thì bấm nút tải lại trên đầu trang plugin.

### 3. Gọi Deplao từ UI

\`\`\`html
<script src="/__deplao/sdk.js"></script>
<script src="app.js" defer></script>
\`\`\`

\`\`\`js
deplao.ready(async () => {
  const accounts = await deplao.accounts.listAccounts();
  const convs = await deplao.chat.listConversations({ accountId: accounts[0].id, limit: 10 });
  await deplao.chat.sendMessage({ accountId: accounts[0].id, threadId: convs[0].thread_id, text: 'Xin chào' });
  deplao.events.on('message.received', (ev) => console.log(ev.data.message.text));
});
\`\`\`

- Tên hàm = \`operationId\` của endpoint (xem danh sách endpoint ở trang này). Tham số phẳng: path + query (GET/DELETE) hoặc body (POST/PUT/PATCH).
- Script inline bị CSP chặn: đặt code trong file \`.js\` riêng.
- Giao diện tự do: CSS thuần, Tailwind, React, Vue, Svelte… build ra file tĩnh trong thư mục UI (script/CSS/font từ CDN bị CSP chặn — đóng gói kèm plugin).
- Hợp theme sáng/tối của Deplao (tuỳ chọn): đọc \`deplao.ui.theme()\` / \`deplao.ui.onTheme()\`, hoặc dùng biến CSS \`--dp-bg\`, \`--dp-surface\`, \`--dp-text\`, \`--dp-text-muted\`, \`--dp-accent\`, \`--dp-border\`… SDK gắn sẵn lên trang.

### 4. Đóng gói và cài

\`\`\`bash
node packages/plugin-cli/bin/deplao-plugin.js validate my-shop
node packages/plugin-cli/bin/deplao-plugin.js pack my-shop
\`\`\`

**Công cụ → Ứng dụng, API & Webhook** → **Cài ứng dụng** (chọn file .zip). Cập nhật = cài file zip có \`version\` lớn hơn; quyền mới phải được duyệt lại.

Plugin mẫu: \`examples/plugins/hello-world\` (web), \`spa-booking\` (local, gần đủ điểm mở rộng), \`order-sync-remote\` (remote).
`;

const REFERENCE = `
## Ứng dụng (plugin): tham chiếu

### Manifest (\`deplao-plugin.json\`)

| Trường | Bắt buộc | Quy tắc |
|---|---|---|
| \`id\` | có | reverse-DNS chữ thường (\`vn.acme.spa\`); phần cuối (\`spa\`) là tiền tố node, không trùng node có sẵn (\`zalo\`, \`fb\`, \`trigger\`…) |
| \`name\`, \`version\` | có | \`version\` theo semver; cập nhật chỉ khi lớn hơn bản đã cài |
| \`apiVersion\` | có | \`1\` |
| \`runtime\` | có | \`web\`, \`local\` (cần \`backend.entry\`), \`remote\` (cần \`remote.baseUrl\` https) |
| \`permissions\` | có | scope API (xem "Xác thực & quyền") + quyền plugin bên dưới. Không được xin \`admin\`, \`plugins:manage\`, \`employees:manage\`, \`settings:write\` |
| \`ui.entry\` | khi có UI | file \`.html\` trong plugin; remote: URL cùng origin với \`remote.baseUrl\` |
| \`ui.connectSrc\` | không | origin https UI được fetch trực tiếp (cần quyền \`network\`) |
| \`minDeplaoVersion\` | không | semver |
| \`contributes\` | không | các điểm mở rộng bên dưới |

### Quyền riêng của plugin

| Quyền | Cho phép |
|---|---|
| \`storage\` | \`deplao.storage\` (tối đa 1 MB/giá trị, 20 MB/plugin) và thư mục dữ liệu riêng |
| \`ui:pages\` | trang ở thanh điều hướng |
| \`ui:chat-panel\` | panel bên phải màn chat, biết hội thoại đang mở |
| \`ui:composer\` | nút trong ô soạn tin, \`deplao.ui.insertComposerText\` |
| \`workflow:nodes\` | node và trigger workflow, \`deplao.workflow.trigger\` |
| \`events:emit\` | \`deplao.events.emit\` (tên khai báo trong \`contributes.events\`) |
| \`network\` | \`deplao.http.fetch\` ở backend, \`ui.connectSrc\` |
| \`schedules\` | \`contributes.schedules\` (cron) |

### Điểm mở rộng (\`contributes\`)

| Điểm | Khai báo | Ghi chú |
|---|---|---|
| \`pages\` | \`{ id, title, path }\` | \`path\` là hash route trong \`ui.entry\` |
| \`chatPanels\` | \`{ id, title, path, width }\` | nhận \`deplao.ui.context()\` và \`onContext\` |
| \`composerButtons\` | \`{ id, title, icon, target: 'ui' \\| 'backend' }\` | backend: \`commands[id](context)\` trả \`{ insertText }\` hoặc \`{ toast }\` |
| \`settings.schema\` | JSON Schema (string, number, integer, boolean, enum; \`x-secret\`, \`x-multiline\`) | form tự sinh ở trang Ứng dụng, API & Webhook (bấm ô ứng dụng → Cài đặt); secret được mã hoá |
| \`workflowNodes\` | \`{ type: '<tiền tố>.<tên>', label, configSchema, outputs }\` | backend \`nodes[type](cfg, run, ctx)\`; \`x-widget: account\\|thread\\|label\`, \`x-template\` |
| \`triggers\` | \`{ type: '<tiền tố>.trigger.<tên>', label, configSchema }\` | bắn bằng \`deplao.workflow.trigger(type, payload)\`; trường payload dùng như \`{{ $trigger.<field> }}\` |
| \`routes\` | \`{ method, path, scope }\` | \`/api/v1/plugins/<id><path>\`; người gọi cần \`scope\`; body ≤ 1 MB |
| \`schedules\` | \`{ id, cron, handler }\` | gọi \`handlers[handler]\`; lượt trước chưa xong thì bỏ lượt sau |
| \`events\` | \`['booking.created']\` | phát thành \`plugin.<id>.booking.created\` |

### SDK \`deplao.*\`

| Nhóm | Hàm |
|---|---|
| API v1 | \`deplao.<nhóm>.<operationId>(params)\`, \`deplao.call(operationId, params)\`, \`deplao.api.request(method, path, { query, body })\` |
| \`storage\` | \`get\`, \`set\`, \`delete\`, \`list(prefix)\`; backend: \`dataDir()\` |
| \`settings\` | \`get()\`, \`onChange(cb)\` |
| \`events\` | \`on(type, handler)\` (cần \`events:subscribe\`), \`emit(name, data)\` |
| \`workflow\` | \`trigger(type, payload)\` |
| \`media\` | \`upload(file)\` → \`upload_id\` dùng trong \`attachments\` khi gửi tin (≤ 25 MB) |
| \`log\` | \`debug/info/warn/error\` → nhật ký plugin (trang Ứng dụng, API & Webhook → bấm ô ứng dụng → Nhật ký) |
| \`system\` | \`info()\` |
| \`ui\` (chỉ UI) | \`context\`, \`onContext\`, \`theme\`, \`openConversation\`, \`insertComposerText\`, \`toast\`, \`navigate(pageId)\`, \`openExternal(url)\`, \`onCommand\` |
| \`backend\` (chỉ UI) | \`call(name, params)\` → \`commands[name]\` trong backend của chính plugin |
| \`http\` (chỉ backend) | \`fetch(url, init)\` — cần \`network\`, chặn mạng nội bộ, ≤ 5 MB |

Lỗi trả về là \`Error\` có \`code\` (cùng mã lỗi API: \`FORBIDDEN_SCOPE\`, \`FORBIDDEN_ACCOUNT\`, \`VALIDATION_ERROR\`…) và \`status\`.

### Backend (runtime \`local\`)

\`\`\`js
module.exports = {
  async activate({ deplao, settings, pluginId, dataDir }) {},
  async deactivate() {},                        // tối đa 5 giây
  async onUpgrade(prevVersion) {},
  async onSettingsChanged(settings) {},
  nodes: { 'shop.lookup': async (cfg, run, ctx) => ({ found: true }) },   // 60 giây
  routes: { 'GET /orders/:code': async (req, ctx) => ({ status: 200, body: {} }) },   // 30 giây
  handlers: { remind: async (ctx) => {} },     // lịch chạy, 120 giây
  commands: { book: async (params, ctx) => ({}) },   // UI backend.call, nút soạn tin
};
\`\`\`

- Chạy trong tiến trình riêng (utilityProcess, 256 MB heap), chỉ nhận vài biến môi trường; \`require('electron')\` và \`process.exit\` bị chặn; \`console.*\` vào nhật ký plugin.
- Crash thì tự khởi động lại sau 2 s, 10 s, 60 s; lần thứ 4 plugin bị tắt (\`Tắt do lỗi\`). Không trả lời ping 3 lần liên tiếp thì bị khởi động lại.
- Plugin vẫn là code Node chạy trên máy: Deplao chỉ cấp dữ liệu theo quyền đã duyệt, nhưng không cô lập hệ thống file hay mạng của tiến trình. Chỉ cài plugin từ nguồn tin cậy.

### Runtime \`remote\`

- Deplao gọi \`POST {remote.baseUrl}/rpc\` với body \`{ id, method, params }\` và header \`X-Deplao-Plugin\`, \`X-Deplao-Timestamp\`, \`X-Deplao-Signature: v1=HMAC-SHA256(secret, timestamp + "." + body)\`. Trả về \`{ result }\` hoặc \`{ error: { code, message } }\`.
- \`method\`: \`activate\`, \`deactivate\`, \`ping\`, \`node.execute\`, \`route.handle\`, \`schedule.run\`, \`composer.command\`, \`settings.changed\`.
- Khi cài, Deplao tạo **secret** và **API key** (gắn plugin, thu hồi khi gỡ) và hiện một lần. Server dùng key để gọi API v1, đăng ký webhook nhận sự kiện.
- \`baseUrl\` phải là https (http chỉ cho \`127.0.0.1\` khi phát triển).

### An toàn

- UI plugin chạy ở origin riêng \`deplao-plugin://<id>\` trong iframe sandbox (không popup, không điều hướng trang app, không đọc được DOM, store hay IPC của app); CSP chặn script ngoài và kết nối ra ngoài trừ \`ui.connectSrc\`.
- Mọi lời gọi dữ liệu đi qua API v1 với principal \`plugin:<id>\`: đúng scope, đúng tài khoản được cấp lúc cài, ghi nhật ký request như API key.
- Gói zip được kiểm tra: tối đa 50 MB, giải nén tối đa 200 MB, không đường dẫn tuyệt đối hay \`..\`, không symlink, CRC khớp.
- Kênh quản trị plugin (\`plugins:*\`) không gọi được qua API hay từ plugin.
`;

export const PLUGIN_GUIDES: Guide[] = [
    { id: 'plugins', title: 'Ứng dụng (plugin): bắt đầu', markdown: START.trim() },
    { id: 'plugin-reference', title: 'Ứng dụng (plugin): tham chiếu', markdown: REFERENCE.trim() },
];
