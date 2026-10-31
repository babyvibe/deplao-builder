/**
 * Process entrypoint for Electron.
 *
 * zca-js uses `ws`, which normally tries to load optional native addons. Those
 * addons are not needed for correctness and have caused Windows access
 * violations after Electron upgrades. Set the flags before loading main.ts so
 * every Zalo WebSocket uses ws' maintained JavaScript implementation.
 */
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

// Đặt tên app TRƯỚC mọi thứ: thư mục dữ liệu (userData = %APPDATA%/Deplao) bị Electron chốt ở lần đầu có code hỏi tới
// nó. Bản dev chạy thẳng từ file bootstrap nên tên mặc định là "Electron" → nếu có code hỏi userData trước khi main.ts
// đặt tên, app mở %APPDATA%/Electron với DB trống mới (sự cố 22/10/2026). main.ts vẫn đặt lại (không sao).
require('electron').app.setName('Deplao');

// Telegram: schema API layer mới cho GramJS (bản npm vẫn layer 198 → tin dùng tính năng mới thành "chưa hỗ trợ") —
// phải trước mọi require('telegram'), xem src/services/telegram/api/telegramApiLayer.ts.
try {
  const layer = require('../src/services/telegram/api/telegramApiLayer').installTelegramApiLayer();
  if (!layer.installed) console.warn(`[bootstrap] Telegram API layer ${layer.layer}: ${layer.reason}`);
} catch (err: any) {
  console.warn('[bootstrap] Telegram API layer:', err?.message || err);
}

// Chẩn đoán theo yêu cầu (file cờ <userData>/diagnostics/profile-next-startup): hồ sơ CPU 120 s đầu của main process,
// tính cả lúc nạp main.ts + chờ app ready — bắt đầu trước require('./main').
try {
  require('../src/utils/startup/startupProfiler').startMainStartupProfile();
} catch (err: any) {
  console.warn('[bootstrap] startup profiler:', err?.message || err);
}

require('./main');
