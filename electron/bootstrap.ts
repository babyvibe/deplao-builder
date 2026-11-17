import { loadEnvFile } from './loadEnv';

loadEnvFile();

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

if (process.env.DEPLAO_WEB === '1' && (process.env.DEPLAO_WEB_PASSWORD || '').length < 12) {
  console.error('DEPLAO_WEB_PASSWORD cần ít nhất 12 ký tự để bật giao diện web.');
  process.exit(1);
}

// Set the app name BEFORE anything else: Electron locks the data folder (userData = %APPDATA%/Deplao) the first time code asks for it
// The dev build runs straight from the bootstrap file, so its default name is "Electron" → if code asks for userData before main.ts
// sets the name, the app opens an empty new DB in %APPDATA%/Electron (incident 22/10/2026). main.ts sets it again anyway (harmless).
require('electron').app.setName('Deplao');

// UI language (src/services/i18n/localeStore.ts): loaded before main.ts, so module-level tr() calls in the main
// process are translated. It must stay after setName (userData path).
try {
  require('../src/services/i18n/localeStore').initMainI18n();
  require('./ipc/i18n/i18nIpc').registerI18nBootIpc();
} catch (err: any) {
  console.warn('[bootstrap] i18n:', err?.message || err);
}

// Telegram: the new API layer schema for GramJS (the npm build is still on layer 198 → new-feature messages show as "chưa hỗ trợ", i.e. unsupported),
// must run before any require('telegram'), see src/services/telegram/api/telegramApiLayer.ts.
try {
  const layer = require('../src/services/telegram/api/telegramApiLayer').installTelegramApiLayer();
  if (!layer.installed) console.warn(`[bootstrap] Telegram API layer ${layer.layer}: ${layer.reason}`);
} catch (err: any) {
  console.warn('[bootstrap] Telegram API layer:', err?.message || err);
}

// On-demand diagnostics (flag file <userData>/diagnostics/profile-next-startup): CPU profile of the first 120 s of the main process,
// including loading main.ts and waiting for app ready; it starts before require('./main').
try {
  require('../src/utils/startup/startupProfiler').startMainStartupProfile();
} catch (err: any) {
  console.warn('[bootstrap] startup profiler:', err?.message || err);
}

require('./main');
