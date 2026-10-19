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
- Hàm riêng của plugin: `storage`, `settings`, `log`, `events`, `workflow.trigger`, `media.upload`, `system.info`, `backend.call` (UI), `http.fetch` (backend, cần quyền `network`).

Đồng bộ `web.js` sau khi sửa SDK trong app: `node scripts/sync-plugin-sdk.js`.
