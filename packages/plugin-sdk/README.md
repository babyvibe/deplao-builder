# @deplao/plugin-sdk

SDK cho plugin Deplao.

- **UI plugin (iframe):** không cần cài gì. Thêm `<script src="/__deplao/sdk.js"></script>` vào trang của plugin; Deplao phục vụ đúng phiên bản khớp với app. File `web.js` ở đây là bản sao cho bundler hoặc UI chạy trên server ngoài (plugin remote).
- **Giao diện:** tự do — HTML/CSS/JS thuần, Tailwind, React, Vue, Svelte… (build ra file tĩnh trong thư mục UI của plugin), CSS hoàn toàn của bạn. Muốn hợp theme sáng/tối của Deplao thì đọc `deplao.ui.theme()` / `onTheme()` hoặc dùng các biến CSS `--dp-*` mà SDK gắn sẵn lên trang (tuỳ chọn).
- **Backend (runtime `local`):** nhận `ctx.deplao` trong `activate`, `nodes`, `routes`, `handlers`, `commands`. Kiểu xem `index.d.ts` (`PluginBackend`, `BackendContext`).

```js
/** @type {import('@deplao/plugin-sdk').PluginBackend} */
module.exports = {
  async activate({ deplao, settings }) {
    deplao.events.on('message.received', (ev) => console.log(ev.data.message.text));
  },
  nodes: {
    'shop.hello': async (cfg, run, { deplao }) => {
      await deplao.chat.sendMessage({ accountId: run.pageId, threadId: cfg.threadId, text: 'Xin chào!' });
      return { ok: true };
    },
  },
};
```

## Quy tắc

- Tên hàm API = `operationId` trong `/api/v1/openapi.json` (xem `/docs`). Nhóm (`chat`, `crm`…) chỉ để dễ đọc.
- Mọi lời gọi đi qua API v1 với principal `plugin:<id>`: chỉ làm được trong phạm vi quyền đã duyệt khi cài, chỉ trên tài khoản được cấp.
- Hàm riêng của plugin: `storage`, `settings`, `log`, `events`, `workflow.trigger`, `media.upload`, `system.info`, `backend.call` (UI), `http.fetch` (backend, cần quyền `network`; trả `text` hoặc `base64`, ép bằng `init.responseType`), `cloudflare` (backend, cần quyền `cloudflare:workers`).
- Hàm API trả file (`downloadMessageMedia`, `downloadLibraryItem`, `downloadLibraryThumb`) trả `{ name, mime, size, base64 }` (tối đa 25 MB, cần quyền `media:read`). Ghi âm Zalo chưa có trên máy thì Deplao tự tải bằng phiên của tài khoản.

## Triển khai lên Cloudflare (`deplao.cloudflare`)

Ứng dụng có quyền `cloudflare:workers` (runtime `local`) tạo được Worker và cơ sở dữ liệu D1 trên tài khoản Cloudflare mà người dùng đã kết nối trong Deplao (Cài đặt → Internet & Đám mây). Token Cloudflare không bao giờ đưa cho ứng dụng: Deplao kiểm quyền và gọi Cloudflare thay.

- Tên Worker / D1 phải **đúng bằng tiền tố** của ứng dụng (phần cuối id: `io.github.acme.fintrack` → `fintrack`) hoặc **bắt đầu bằng `<tiền tố>-`** (`fintrack-dev`); tên khác → lỗi `CF_NAME_FORBIDDEN`.
- `bundleDir` / thư mục migration là đường dẫn tương đối trong thư mục ứng dụng đã cài; gói theo dạng `bundle.json` + `worker/` + `assets/` (tuỳ chọn). Tổng ≤ 50 MB, ≤ 5000 file asset, mỗi file ≤ 25 MiB.
- Token thiếu quyền → `CF_PERMISSION` (message nêu quyền cần thêm: Workers Scripts · Edit, D1 · Edit); chưa kết nối → `CF_NOT_CONNECTED`; Cloudflare báo lỗi → `CF_API`.
- Mỗi lời gọi tốn request trong ngân sách 100 request / 5 phút dùng chung của Deplao. Triển khai có thể mất vài phút: chạy ở nền và ghi tiến độ bằng `storage`, đừng để UI chờ `backend.call`.

```js
const crypto = require('crypto');

async function getOrCreateSecret(deplao) {        // cần thêm quyền storage
  let secret = await deplao.storage.get('integrationSecret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    await deplao.storage.set('integrationSecret', secret);
  }
  return secret;
}

/** @type {import('@deplao/plugin-sdk').PluginBackend} */
module.exports = {
  commands: {
    async deploy(_params, { deplao }) {
      const st = await deplao.cloudflare.status();
      if (!st.connected) return { error: 'Hãy kết nối Cloudflare trong Deplao trước' };
      if (st.missing.length) return { error: `Token thiếu quyền: ${st.missing.join(', ')}` };

      await deplao.cloudflare.d1.ensure(st.prefix);                                   // vd "fintrack"
      await deplao.cloudflare.d1.migrate(st.prefix, 'vendor/fintrack/migrations');
      const res = await deplao.cloudflare.workers.deployBundle({
        name: st.prefix,
        bundleDir: 'vendor/fintrack',
        bindings: { d1: { DB: st.prefix }, ai: 'AI', vars: { APP_ENV: 'production' } },
        secrets: { DEPLAO_INTEGRATION_SECRET: await getOrCreateSecret(deplao) },
      });
      return { url: res.url };
    },
  },
};
```

Đồng bộ `web.js` sau khi sửa SDK trong app: `node scripts/sync-plugin-sdk.js`.
