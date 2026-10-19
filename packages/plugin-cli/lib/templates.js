'use strict';
/** Mẫu khởi tạo plugin cho `deplao-plugin create`. */

function manifest({ id, name, runtime }) {
  const short = id.split('.').pop();
  const m = {
    id,
    name,
    version: '0.1.0',
    apiVersion: 1,
    runtime,
    description: 'Mô tả ngắn plugin làm gì cho khách hàng.',
    author: '',
    permissions: ['accounts:read', 'chat:read', 'ui:pages'],
    ui: { entry: 'ui/index.html' },
    contributes: {
      pages: [{ id: 'home', title: name, path: '/' }],
    },
  };
  if (runtime === 'local') {
    m.permissions.push('storage', 'workflow:nodes');
    m.backend = { entry: 'backend/index.js' };
    m.contributes.workflowNodes = [{
      type: `${short}.hello`,
      label: 'Chào khách',
      configSchema: { properties: { name: { type: 'string', title: 'Tên khách', 'x-template': true, default: '{{ $trigger.fromName }}' } } },
      outputs: [{ name: 'text' }],
    }];
  }
  if (runtime === 'remote') {
    delete m.ui;
    delete m.contributes.pages;
    m.permissions = ['accounts:read', 'chat:read', 'workflow:nodes'];
    m.remote = { baseUrl: 'http://127.0.0.1:4300' };
    m.contributes.workflowNodes = [{ type: `${short}.hello`, label: 'Chào khách (server)', outputs: [{ name: 'text' }] }];
  }
  return JSON.stringify(m, null, 2) + '\n';
}

const INDEX_HTML = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="style.css" />
  <script src="/__deplao/sdk.js"></script>
  <script src="app.js" defer></script>
</head>
<body>
  <main>
    <h1 id="title">Plugin của bạn</h1>
    <ul id="accounts"></ul>
  </main>
</body>
</html>
`;

const APP_JS = `/* global deplao */
deplao.ready(async () => {
  const accounts = await deplao.accounts.listAccounts();
  const ul = document.getElementById('accounts');
  accounts.forEach((a) => {
    const li = document.createElement('li');
    li.textContent = (a.display_name || a.id) + ' — ' + a.channel;
    ul.appendChild(li);
  });
});
`;

const STYLE_CSS = `body { margin: 0; padding: 20px; font-family: var(--dp-font, system-ui); background: var(--dp-bg); color: var(--dp-text); }
h1 { font-size: 18px; }
li { color: var(--dp-text-muted); }
`;

function backend(id) {
  const short = id.split('.').pop();
  return `'use strict';
module.exports = {
  async activate({ deplao, settings }) {
    console.log('Plugin đã bật', settings);
  },
  async deactivate() {},
  nodes: {
    '${short}.hello': async (cfg) => ({ text: 'Xin chào ' + (cfg.name || 'bạn') }),
  },
  routes: {},
  handlers: {},
  commands: {},
};
`;
}

function readme(name, runtime) {
  return `# ${name}

Plugin Deplao (runtime \`${runtime}\`).

- Phát triển: Deplao → **Công cụ → Ứng dụng, API & Webhook** (thanh điều hướng) → nút **Phát triển ứng dụng** → **Thêm thư mục đang phát triển**.
- Kiểm tra: \`node packages/plugin-cli/bin/deplao-plugin.js validate .\`
- Đóng gói: \`node packages/plugin-cli/bin/deplao-plugin.js pack .\`
`;
}

module.exports = { manifest, INDEX_HTML, APP_JS, STYLE_CSS, backend, readme };
