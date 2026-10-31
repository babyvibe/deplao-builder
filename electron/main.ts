import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, protocol, net, Notification, safeStorage, powerMonitor } from 'electron';
// Public API v1: ghi nhận mọi IPC handler để API/plugin gọi đúng logic của UI (phải đứng trước các import IPC).
import { ipcHandlerRegistry } from './ipc/handlerRegistry';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';
import { autoUpdater } from 'electron-updater';
import * as cron from 'node-cron';
import DatabaseService from '../src/services/database/DatabaseService';
import { registerLoginIpc } from './ipc/zalo/loginIpc';
import { registerZaloIpc } from './ipc/zalo/zaloIpc';
import { registerDatabaseIpc } from './ipc/database/databaseIpc';
import { registerFileIpc } from './ipc/file/fileIpc';
import { registerCRMIpc } from './ipc/crm/crmIpc';
import { registerWorkflowIpc } from './ipc/workflow/workflowIpc';
import { registerIntegrationIpc } from './ipc/integrations/integrationIpc';
import { registerAIAssistantIpc } from './ipc/ai/aiAssistantIpc';
import { registerUtilIpc } from './ipc/util/utilIpc';
import { registerEmployeeIpc } from './ipc/employee/employeeIpc';
import { registerRelayIpc } from './ipc/network/relayIpc';
import { registerWorkspaceIpc } from './ipc/workspace/workspaceIpc';
import { registerFacebookIpc, reconnectAllFBAccounts } from './ipc/facebook/facebookIpc';
import { registerTelegramIpc } from './ipc/telegram/telegramIpc';
import { registerTelegramUserIpc } from './ipc/telegram/telegramUserIpc';
import { registerProxyIpc } from './ipc/network/proxyIpc';
import { registerErpTaskIpc } from './ipc/erp/erpTaskIpc';
import { registerErpCalendarIpc } from './ipc/erp/erpCalendarIpc';
import { registerErpNoteIpc } from './ipc/erp/erpNoteIpc';
import { registerErpNotificationIpc } from './ipc/erp/erpNotificationIpc';
import { registerErpHrmIpc } from './ipc/erp/erpHrmIpc';
import { registerLockScreenIpc } from './ipc/security/lockScreenIpc';
import { registerLibraryIpc } from './ipc/library/libraryIpc';
import { registerMobileSyncIpc } from './ipc/zalo/mobileSyncIpc';
import { registerApiIpc } from './ipc/api/apiIpc';
import { registerPluginIpc } from './ipc/plugins/pluginIpc';
import { registerCloudflareIpc } from './ipc/cloud/cloudflareIpc';
import ApiPlatform from '../src/services/api/ApiPlatform';
import WorkspaceManager from '../src/utils/app/WorkspaceManager';
import HttpConnectionManager from '../src/services/http/HttpConnectionManager';
import { installBossFileAuthHook, setPreferredBossWorkspace } from '../src/services/http/bossSessionAuth';
import WorkflowEngineService from '../src/services/workflow/WorkflowEngineService';
import WebhookGatewayService from '../src/services/workflow/WebhookGatewayService';
import IntegrationRegistry from '../src/services/integrations/IntegrationRegistry';
import EventBroadcaster from '../src/services/event/EventBroadcaster';
import CRMQueueService from '../src/services/crm/CRMQueueService';
import FileStorageService from '../src/services/file/FileStorageService';
import TrackingService from '../src/services/tracking/TrackingService';
import { SHOW_DEV_TOOLS, IS_DEV_BUILD } from '../src/configs/app/BuildConfig';
import Logger from '../src/utils/Logger';
import { armStartupSettleFallback, settleWhenMainIdle } from '../src/utils/startup/startupSettle';
import { startMainThreadWatchdog } from '../src/utils/startup/mainThreadWatchdog';
import { startRendererStartupProfile } from '../src/utils/startup/startupProfiler';
import { newerInstallToRelaunch, type LaunchInfo } from './app/singleInstanceRelaunch';
import { createAutoLaunch, type AutoLaunch } from '../src/utils/startup/autoLaunch';

// CHANNEL constant — same as src/ui/lib/channels/channelHelper.ts (electron build excludes src/ui/)
const CHANNEL = { ZALO: 'zalo', FACEBOOK: 'facebook', TELEGRAM_BOT: 'telegram_bot', TELEGRAM_USER: 'telegram_user' } as const;

/**
 * Decrypt cookies from DB — mirror of DatabaseService.decryptCookies().
 * startupAllWorkspaces reads raw rows via queryOtherDb, so we must decrypt
 * before passing to loginService.connectUser().
 */
function decryptCookiesForStartup(encrypted: string): string {
  if (!encrypted) return encrypted;
  const trimmed = encrypted.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return encrypted;
  if (/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) return encrypted;

  // Try safeStorage — works for any encrypted format (DPAPI, U2Fsd, etc.)
  // GramJS sessions are NOT encrypted → safeStorage.decryptString throws → return as-is
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (decrypted.startsWith('[') || decrypted.startsWith('{')) {
        JSON.parse(decrypted); // validate
        return decrypted;
      }
      return decrypted;
    }
  } catch {
    // safeStorage failed → likely GramJS session or corrupted data → return as-is
  }
  return encrypted;
}

const isDev = IS_DEV_BUILD;
let isQuitting = false;

// ─── Hardware acceleration ────────────────────────────────────────────────────
// Giữ GPU acceleration BẬT: tắt hardware acceleration khiến CPU render toàn bộ UI,
// dẫn đến renderer unresponsive → màn hình đen sau khi dùng một lúc.
// app.disableHardwareAcceleration(); // ← ĐÃ XÓA: gây freeze/màn đen

// ─── Cached icons ──────────────────────────────────────────────────────────────
let cachedNormalIcon: Electron.NativeImage | null = null;
let cachedDotIcon:    Electron.NativeImage | null = null;
let cachedOverlayDot: Electron.NativeImage | null = null;   // 16×16 red dot overlay cho Windows taskbar
let currentIconIsDot = false;
let dockBounceId: number | null = null;  // macOS: bounce request ID để cancel đúng

/** Cancel dock bounce / taskbar flash trên cả macOS và Windows */
function cancelDockBounce() {
  if (process.platform === 'darwin') {
    // macOS: cancel bounce bằng ID đã lưu
    if (dockBounceId !== null && app.dock) {
      app.dock.cancelBounce(dockBounceId);
      dockBounceId = null;
    }
  } else {
    mainWindow?.flashFrame(false);
  }
}

function resolveIconPath(relativePath: string): string {
  const fromDir = path.join(__dirname, '../../', relativePath);
  const unpackedPath = fromDir.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  return fromDir;
}

/** Load icon: ưu tiên _128.png (128x128), fallback .png gốc rồi resize */
function loadIcon(baseName: string): Electron.NativeImage {
  const png128 = resolveIconPath(`resources/icons/${baseName}_128.png`);
  if (fs.existsSync(png128)) {
    const img = nativeImage.createFromPath(png128);
    if (!img.isEmpty()) return img;
  }
  const pngOrig = resolveIconPath(`resources/icons/${baseName}.png`);
  if (fs.existsSync(pngOrig)) {
    const raw = nativeImage.createFromPath(pngOrig);
    if (!raw.isEmpty()) return raw.resize({ width: 128, height: 128 });
  }
  return nativeImage.createEmpty();
}

function loadIcons() {
  cachedNormalIcon = loadIcon('icon');
  cachedDotIcon    = loadIcon('icon_dot');
  // 16×16 red dot cho Windows taskbar overlay
  const overlayPath = resolveIconPath('resources/icons/overlay_dot.png');
  if (fs.existsSync(overlayPath)) {
    cachedOverlayDot = nativeImage.createFromPath(overlayPath);
    if (cachedOverlayDot.isEmpty()) cachedOverlayDot = null;
  }
}


// ─── Vô hiệu hóa remote debugging ngay khi load (trước app.whenReady) ────────
if (!isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('--inspect',     '0');
  app.commandLine.appendSwitch('--inspect-brk', '0');
}

// ─── Force Vietnamese locale → input[type="date"] hiển thị dd/mm/yyyy ────────
app.commandLine.appendSwitch('lang', 'vi-VN');
app.commandLine.appendSwitch('accept-lang', 'vi-VN,vi;q=0.9');

// Đặt tên app (hiện trên taskbar, tray, macOS dock)
app.setName('Deplao');

// Windows: đặt AppUserModelId để taskbar/notification hiển thị đúng icon & tên
// Dev: AUMID unique mỗi lần chạy → Windows tạo icon cache mới → hiện đúng icon
// Production: AUMID cố định (khớp appId electron-builder, exe đã embed icon qua afterPack)
if (process.platform === 'win32') {
  app.setAppUserModelId(isDev ? `com.Deplao.dev.${Date.now()}` : 'com.Deplao.app');
}

// ─── Register custom protocol BEFORE app ready (required by Electron) ─────────
// local-media://abs-path  →  serve file from absolute path on disk
// Usage in renderer: local-media:///D:/path/to/file.jpg
//
// deplao://openChat?accountId=xxx&threadId=yyy&threadType=0&channel=zalo
//   → deep link: mở app + active đúng hội thoại
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'deplao',
    privileges: {
      secure: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: false,
    },
  },
  {
    // UI plugin: mỗi plugin một origin riêng deplao-plugin://<id> (không bypass CSP).
    scheme: 'deplao-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

// ─── Suppress Chromium DevTools "Autofill.enable" / "Autofill.setAddresses" errors ──
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');
app.commandLine.appendSwitch('disable-features', 'Autofill');

// ─── Single Instance Lock ──────────────────────────────────────────────────────
// Bản vừa bấm mở gửi kèm phiên bản + đường dẫn chạy: bản cũ còn chạy ngầm (đã ẩn xuống khay) thấy bản mới hơn thì tự
// thoát và mở bản mới (singleInstanceRelaunch.ts). Trước đây cài bản mới xong bấm mở không thấy gì tới khi tắt bản cũ.
const launchInfo: LaunchInfo = {
  version: app.getVersion(),
  packaged: app.isPackaged,
  // AppImage: process.execPath nằm trong thư mục mount tạm của chính file .AppImage
  execPath: process.env.APPIMAGE || process.execPath,
};
const gotLock = app.requestSingleInstanceLock(launchInfo as unknown as Record<string, unknown>);
if (!gotLock) {
  // Đã có instance đang chạy → focus instance đó rồi thoát
  // ⚡ FIX: app.quit() là async - code phía dưới vẫn chạy tiếp nếu không exit ngay.
  // Nếu không exit, instance thứ 2 vẫn đăng ký protocols, IPC handlers, tạo tray icon,
  // chạy ngầm không cửa sổ → process treo trong Task Manager.
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let inAppBrowserWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let rendererReportedReady = false;

// ─── Tự mở cùng máy (src/utils/startup/autoLaunch.ts) ─────────────────────────────────
// Tạo khi cần: userData chỉ đúng sau app.setName('Deplao').
let autoLaunchInstance: AutoLaunch | null = null;
function getAutoLaunch(): AutoLaunch {
  autoLaunchInstance ??= createAutoLaunch({
    platform: process.platform,
    packaged: app.isPackaged,
    // AppImage: process.execPath nằm trong thư mục mount tạm của file .AppImage
    launchPath: process.env.APPIMAGE || process.execPath,
    homeDir: app.getPath('home'),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    loginItems: {
      set: (settings) => app.setLoginItemSettings(settings as any),
      get: (options) => app.getLoginItemSettings(options as any),
    },
    configPath: path.join(app.getPath('userData'), 'deplao-config.json'),
  });
  return autoLaunchInstance;
}
/** Hệ điều hành vừa tự mở app lúc đăng nhập + người dùng chọn chạy ngầm: cửa sổ đầu tiên không hiện */
let startHiddenAtLogin = false;
let onRendererReportedReady: (() => void) | null = null;

// In development the renderer is served by Vite. Windows can suspend the
// localhost socket while the laptop is asleep, leaving the main process alive
// but the renderer with a blank page and ERR_NETWORK_IO_SUSPENDED. Keep this
// recovery isolated to dev: packaged builds load local files and must retain
// their current UI state on resume.
let devRendererReloadTimer: ReturnType<typeof setTimeout> | null = null;
let devRendererReloadAttempts = 0;
let devRendererSuspended = false;
let devRendererSystemSuspended = false;
const DEV_RENDERER_MAX_RELOAD_ATTEMPTS = 4;

function loadDevRenderer(reason: string, delayMs = 0): void {
  if (!isDev || devRendererReloadTimer || !mainWindow || mainWindow.isDestroyed()) return;
  if (devRendererReloadAttempts >= DEV_RENDERER_MAX_RELOAD_ATTEMPTS) {
    console.error(`[main] Dev renderer recovery stopped after ${devRendererReloadAttempts} attempts (${reason})`);
    return;
  }

  devRendererReloadTimer = setTimeout(() => {
    devRendererReloadTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    devRendererReloadAttempts++;
    console.warn(`[main] Reloading Vite renderer after ${reason} (attempt ${devRendererReloadAttempts}/${DEV_RENDERER_MAX_RELOAD_ATTEMPTS})`);
    void mainWindow.loadURL('http://localhost:27799').catch((err: any) => {
      console.warn(`[main] Vite renderer reload failed: ${err?.message || err}`);
    });
  }, delayMs);
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Deplao',
    // Windows: frameless → custom title bar
    // macOS: hiddenInset → ẩn title bar, giữ traffic light buttons
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    backgroundColor: '#131518',
    icon: cachedNormalIcon && !cachedNormalIcon.isEmpty()
      ? cachedNormalIcon
      : (process.platform === 'win32'
        ? resolveIconPath('resources/icons/icon.ico')
        : resolveIconPath('resources/icons/icon.png')),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });
  // Hồ sơ CPU giao diện lúc mở app — chỉ khi được yêu cầu (file cờ diagnostics/profile-next-startup, xem utils/startup/startupProfiler)
  startRendererStartupProfile(mainWindow.webContents);

  // Load Vite dev server or built files
  if (isDev) {
    mainWindow.loadURL('http://localhost:27799');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // DevTools: chỉ mở trong dev build
  if (SHOW_DEV_TOOLS) {
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      const blocked =
        input.key === 'F12' ||
        (input.control && input.shift && ['I', 'J', 'C', 'K'].includes(input.key.toUpperCase()));
      if (blocked) _event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
    mainWindow.webContents.on('context-menu', (e) => e.preventDefault());
  }

  let initialWindowShown = false;
  mainWindow.once('ready-to-show', () => {
    initialWindowShown = true;
    if (cachedNormalIcon && !cachedNormalIcon.isEmpty()) {
      mainWindow?.setIcon(cachedNormalIcon);
    }
    // Tự mở cùng máy: chạy ngầm ở khay, báo một lần (bấm khay hoặc mở Deplao lần nữa để hiện cửa sổ)
    if (startHiddenAtLogin) {
      startHiddenAtLogin = false;
      showTrayNotification('Deplao đã mở cùng máy', 'Đang chạy ngầm để nhận tin nhắn. Bấm biểu tượng Deplao ở khay để mở.');
      return;
    }
    mainWindow?.show();
  });

  // Vite can take longer than Chromium's normal paint deadline after a cold
  // start. Do not show an unpainted Chromium surface forever: the old fallback
  // only called show(), which is exactly the blank blue screen users saw after
  // Electron's network service restarted.
  setTimeout(() => {
    if (!initialWindowShown && mainWindow && !mainWindow.isDestroyed()) {
      console.warn('[main] Renderer did not emit ready-to-show in time; recovering renderer');
      mainWindow.show();
      if (isDev) {
        loadDevRenderer('ready-to-show timeout', 250);
      } else {
        mainWindow.webContents.reload();
      }
    }
  }, 8_000).unref();

  // A successful full page load means Vite is reachable again. Reset the
  // bounded retry budget so a later laptop suspend can recover independently.
  mainWindow.webContents.on('will-frame-navigate', (details: any) => {
    try {
      if (details.isMainFrame) return;
      const current = String(details.frame?.url || '');
      const target = String(details.url || '');
      const { shouldBlockPluginFrameNavigation } = require('../src/services/plugins/PluginProtocol');
      if (shouldBlockPluginFrameNavigation(current, target)) details.preventDefault();
    } catch {}
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!isDev) return;
    devRendererReloadAttempts = 0;
    devRendererSuspended = false;
  });

  // ── Renderer crash recovery ────────────────────────────────────────────
  // Khi renderer process bị crash hoặc bị kill bởi OS (OOM) → màn trắng,
  // nút X bị chặn bởi close handler → user phải mở Task Manager.
  // Fix: tự reload lại renderer, nếu vẫn crash → quit hoàn toàn.
  let crashCount = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] Renderer process gone: ${details.reason} (exitCode=${details.exitCode})`);
    crashCount++;
    if (crashCount <= 2 && mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[main] Attempting renderer reload (attempt ${crashCount})...`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (isDev) {
            mainWindow.loadURL('http://localhost:27799');
          } else {
            mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
          }
        }
      }, 1500);
    } else {
      console.error(`[main] Renderer crashed ${crashCount} times - quitting app`);
      isQuitting = true;
      app.quit();
    }
  });

  // Window bị treo (unresponsive) → thông báo và reload
  mainWindow.on('unresponsive', () => {
    console.warn('[main] Window unresponsive - reloading renderer');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // Load HTML thất bại (file bị thiếu, Vite dev server chưa bật, ...)
  // → window tồn tại nhưng trắng, ready-to-show vẫn fire → user thấy trắng
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] did-fail-load: ${errorCode} ${errorDescription} - ${validatedURL}`);
    if (!isDev) return;

    if (String(errorDescription).includes('ERR_NETWORK_IO_SUSPENDED')) {
      // Do not keep issuing localhost requests while Windows has suspended the
      // network stack. powerMonitor.resume will reload once Node/Vite can run.
      devRendererSuspended = true;
      console.warn('[main] Vite renderer request suspended; waiting for system resume');
      // The failed request may be reported just after the OS has emitted
      // `resume`; in that ordering there will be no second resume event.
      if (!devRendererSystemSuspended) {
        loadDevRenderer('late suspended Vite request', 1500);
      }
      return;
    }

    // Vite may still be starting (or has just resumed). Debounced, bounded
    // retries avoid the previous unbounded loadURL loop and blank window.
    loadDevRenderer(`load failure ${errorDescription}`, 1500);
  });

  // Production: console.* của renderer đã bị tắt (terser drop_console + obfuscator) → chỉ còn lỗi do Chromium
  // tự báo (uncaught exception, unhandled rejection, CSP…). Đưa warn/error đó vào Nhật ký (prefix [renderer]).
  // Dev không cần (DevTools + Logger renderer đã gửi qua 'log:append' → tránh ghi trùng).
  if (!isDev) {
    mainWindow.webContents.on('console-message', (details: any) => {
      try {
        const level = details?.level;
        if (level !== 'error' && level !== 'warning') return;
        if (details?.frame?.parent) return; // iframe plugin → bỏ qua
        const message = String(details?.message ?? '');
        if (!message || message.startsWith('Failed to load resource')) return; // ảnh/CDN hỏng: quá ồn
        // source 'console': Logger bỏ chuỗi trích dẫn (có thể chứa dữ liệu), cắt ngắn, thêm prefix [console]
        Logger.appendFromRenderer(level === 'error' ? 'error' : 'warn', message, 'console');
      } catch { /* frame đã dispose */ }
    });
  }

  // CSP: chặn inline scripts bên ngoài trong production
  if (!isDev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            // img-src và media-src phải có https: để load ảnh/video từ CDN Zalo
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: local-media: blob: https: http:; media-src 'self' local-media: blob: https: http:; connect-src 'self' https: http: wss:; font-src 'self' data: https:; frame-src 'self' https:;",
          ],
        },
      });
    });
  }

  // Nhân viên: <img>/<video> trỏ thẳng tới file của Boss (/api/media, /api/library). Boss bắt buộc Authorization mà
  // thẻ không gửi được → gắn token phiên nhân viên ở đây — chỉ cho Boss đã đăng ký, chỉ khung chính cửa sổ này.
  // ⚠️ Electron chỉ giữ MỘT listener mỗi sự kiện webRequest của một session: đây là onBeforeSendHeaders DUY NHẤT của
  // session cửa sổ chính (trình duyệt nội bộ dùng chung session, bị loại theo webContentsId) — cần thêm thì gộp vào hook.
  installBossFileAuthHook(mainWindow.webContents.session, () => {
    try { return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null; } catch { return null; }
  });
  setPreferredBossWorkspace(() => {
    try { return WorkspaceManager.getInstance().getActiveWorkspaceId(); } catch { return undefined; }
  });
  HttpConnectionManager.getInstance().seedBossSessions();

  // Nút X của OS frame (không dùng vì frame=false) - vẫn handle để an toàn
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      showTrayNotification();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Broadcast window focus/blur/hide to renderer for accurate unread tracking
  mainWindow.on('focus', () => {
    // macOS: cancel dock bounce via stored ID; Windows/Linux: cancel flashFrame
    cancelDockBounce();
    mainWindow?.webContents.send('app:windowFocus', true);
  });
  mainWindow.on('blur', () => mainWindow?.webContents.send('app:windowFocus', false));
  mainWindow.on('minimize', () => mainWindow?.webContents.send('app:windowFocus', false));
  mainWindow.on('restore', () => {
    cancelDockBounce();
    mainWindow?.webContents.send('app:windowFocus', true);
  });
  mainWindow.on('hide', () => mainWindow?.webContents.send('app:windowFocus', false));
  mainWindow.on('show', () => {
    cancelDockBounce();
    mainWindow?.webContents.send('app:windowFocus', true);
    // Re-apply overlay sau khi show lại
    if (process.platform === 'win32' && currentIconIsDot && cachedOverlayDot && !cachedOverlayDot.isEmpty()) {
      mainWindow?.setOverlayIcon(cachedOverlayDot, 'Tin chưa đọc');
    }
  });

  // Set EventBroadcaster window reference
  EventBroadcaster.setWindow(mainWindow);

  // Set HttpConnectionManager window reference for status push events
  HttpConnectionManager.getInstance().setMainWindow(mainWindow);

  // Khi có instance thứ 2 cố mở → focus instance hiện tại
  // Trên Windows: deep link từ trình duyệt → argv chứa URL cần parse
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // Bản mới hơn vừa được cài và bấm mở trong lúc bản này chạy ngầm → thoát, mở bản mới (kèm deep link nếu có)
    const newer = newerInstallToRelaunch(launchInfo, additionalData);
    if (newer) {
      Logger.log(`[main] Bản ${newer.version} vừa được mở (đang chạy ${launchInfo.version}) → thoát để mở bản mới`);
      const deepLink = argv.find((arg: string) => arg.startsWith('deplao://'));
      app.relaunch({ execPath: newer.execPath, args: deepLink ? [deepLink] : [] });
      isQuitting = true;
      app.quit();
      // Dọn dẹp khi thoát bị kẹt: app.exit vẫn mở bản mới (process.exit thì không)
      setTimeout(() => app.exit(0), 8000).unref();
      return;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }

    // Parse deep link URL từ command line (Windows protocol handler)
    const deepLinkUrl = argv.find((arg: string) => arg.startsWith('deplao://'));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    }
  });

  // macOS: open-url event khi click deep link
  app.on('open-url', (_event, url) => {
    if (url.startsWith('deplao://')) {
      handleDeepLink(url);
    }
  });

  return mainWindow;
}

function createTray() {
  let icon = cachedNormalIcon && !cachedNormalIcon.isEmpty()
    ? cachedNormalIcon
    : nativeImage.createFromPath(resolveIconPath(
        process.platform === 'win32' ? 'resources/icons/icon.ico' : 'resources/icons/icon.png'
      ));

  // macOS menu bar: tray icon phải nhỏ (~18×18 points). Icon 128px sẽ hiện rất to.
  // Resize xuống 18×18 để hiển thị đúng kích thước trên menu bar macOS.
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mở Deplao',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Thoát hoàn toàn',
      click: () => {
        isQuitting = true;
        app.quit();
        setTimeout(() => {
          console.warn('[main] Force-exit after 5s timeout (tray)');
          process.exit(0);
        }, 5000).unref();
      },
    },
  ]);

  tray.setToolTip('Deplao');
  tray.setContextMenu(contextMenu);

  // Double-click tray → mở app
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  // Single click tray → toggle
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

/** Hiển thị thông báo system tray khi ẩn ứng dụng xuống tray */
function showTrayNotification(
  title = 'Deplao đang chạy ngầm',
  body = 'Ứng dụng vẫn đang hoạt động và nhận tin nhắn bình thường. Nhấn vào biểu tượng tray để mở lại.',
) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title,
    body,
    silent: false,
  });
  notif.show();
  // Tự đóng sau 5 giây
  setTimeout(() => notif.close(), 5000);
}

// Window control IPC handlers
function registerWindowControls() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  // Nút X trên custom title bar → ẩn xuống tray (không thoát hoàn toàn)
  ipcMain.on('window:close', () => {
    mainWindow?.hide();
    showTrayNotification();
  });

  // Nút thoát hoàn toàn từ tray menu hoặc renderer
  ipcMain.on('window:quit', () => {
    isQuitting = true;
    app.quit();
    // Force-exit: DB close() đã chạy trong before-quit (sync, ~1ms).
    // 5s đủ cho socket disconnect + service stop. Nếu vẫn kẹt → force kill.
    setTimeout(() => {
      console.warn('[main] Force-exit after 5s timeout — background service may be stuck');
      process.exit(0);
    }, 5000).unref();
  });

  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

  // ─── Nhật ký (Logger) → renderer ─────────────────────────────────
  // Hook console toàn cục để cả console.* thẳng (không qua Logger) cũng vào buffer
  Logger.installConsoleHook();
  // Forward mỗi log mới sang tab Nhật ký (throttle-free, buffer đã giới hạn 2000 dòng)
  Logger.onEntry((entry) => {
    try { mainWindow?.webContents.send('log:entry', entry); } catch { /* window đã đóng */ }
  });
  ipcMain.handle('log:getBuffer', () => Logger.getBuffer());
  ipcMain.handle('log:clear', () => { Logger.clearBuffer(); return true; });
  // Renderer → Nhật ký: console renderer bị strip ở production, nên Logger renderer gửi warn/error/notice
  // qua kênh này. appendFromRenderer tự kiểm tra kiểu, che token/cookie, giới hạn 20 dòng/s + gộp dòng trùng 2 s.
  ipcMain.on('log:append', (_event, payload: { level?: unknown; msg?: unknown } | undefined) => {
    Logger.appendFromRenderer(payload?.level, payload?.msg);
  });

  // Open external link in browser
  ipcMain.on('shell:openExternal', (_event, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const resolved = FileStorageService.resolveAbsolutePath(filePath);
      if (!resolved || !fs.existsSync(resolved)) {
        return { success: false, error: 'Không tìm thấy tệp đính kèm' };
      }
      const error = await shell.openPath(resolved);
      return error ? { success: false, error } : { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Không thể mở tệp' };
    }
  });

  ipcMain.handle('shell:openInApp', async (_event, url: string) => {
    try {
      if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Chỉ hỗ trợ liên kết web http/https' };
      }

      if (!inAppBrowserWindow || inAppBrowserWindow.isDestroyed()) {
        inAppBrowserWindow = new BrowserWindow({
          width: 1180,
          height: 820,
          minWidth: 860,
          minHeight: 620,
          title: 'Trình duyệt nội bộ',
          autoHideMenuBar: true,
          parent: mainWindow ?? undefined,
          backgroundColor: '#131518',
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
          },
        });
        inAppBrowserWindow.on('closed', () => {
          inAppBrowserWindow = null;
        });
      }

      await inAppBrowserWindow.loadURL(url);
      if (inAppBrowserWindow.isMinimized()) inAppBrowserWindow.restore();
      inAppBrowserWindow.show();
      inAppBrowserWindow.focus();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Không thể mở liên kết trong app' };
    }
  });

  // ── Quyền quản trị (Windows) ─────────────────────────────────────
  // App chạy bằng "Run as administrator" thì Windows (UIPI) chặn kéo-thả file từ File Explorer vào app — mọi kênh đều
  // không kéo được ảnh / file. Giao diện hỏi một lần lúc mở app để cảnh báo; `net session` chỉ chạy được khi có quyền.
  let elevatedCheck: Promise<boolean> | null = null;
  ipcMain.handle('app:isElevated', () => {
    if (process.platform !== 'win32') return false;
    elevatedCheck ??= new Promise<boolean>((resolve) => {
      require('child_process').execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, (err: unknown) => resolve(!err));
    }).then((elevated) => {
      if (elevated) {
        Logger.warn('[Kéo thả] Deplao đang chạy bằng quyền quản trị (Run as administrator) — Windows chặn kéo-thả file '
          + 'từ File Explorer vào app. Mở lại Deplao bình thường để kéo-thả được.');
      }
      return elevated;
    });
    return elevatedCheck;
  });

  // ── Tự mở cùng máy (Cài đặt → Thông báo → Khởi động cùng máy), lưu theo máy ──────────────
  ipcMain.handle('app:getAutoLaunch', () => getAutoLaunch().status());
  ipcMain.handle('app:setAutoLaunch', (_event, patch: { enabled?: boolean; hidden?: boolean }) => {
    try {
      return { success: true, ...getAutoLaunch().update(patch || {}) };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error), ...getAutoLaunch().status() };
    }
  });

  // ── Badge / taskbar unread count ─────────────────────────────────
  ipcMain.on('app:setBadge', (_event, count: number) => {
    if (!mainWindow) return;
    if (process.platform === 'darwin') {
      app.setBadgeCount(count > 0 ? count : 0);
    } else if (process.platform === 'win32') {
      if (count > 0) {
        if (!currentIconIsDot) {
          currentIconIsDot = true;
          // Overlay dot trên taskbar (Windows native API - không bị icon cache)
          if (cachedOverlayDot && !cachedOverlayDot.isEmpty()) {
            mainWindow.setOverlayIcon(cachedOverlayDot, `${count} tin chưa đọc`);
          }
          // Tray icon dùng icon_dot (tray không bị cache)
          if (cachedDotIcon && !cachedDotIcon.isEmpty()) {
            tray?.setImage(cachedDotIcon);
          }
        }
        tray?.setToolTip(`Deplao - ${count} tin chưa đọc`);
      } else {
        if (currentIconIsDot) {
          currentIconIsDot = false;
          mainWindow.setOverlayIcon(null, '');
          if (cachedNormalIcon && !cachedNormalIcon.isEmpty()) {
            tray?.setImage(cachedNormalIcon);
          }
        }
        tray?.setToolTip('Deplao');
      }
    } else {
      try { app.setBadgeCount(count > 0 ? count : 0); } catch {}
    }
  });

  ipcMain.removeAllListeners('app:badgeImage');

  // ── Flash taskbar icon (blink notification) ──────────────────────
  ipcMain.on('app:flashFrame', (_event, { active }: { active: boolean }) => {
    if (!mainWindow) return;
    if (process.platform === 'darwin') {
      // macOS: dùng dock.bounce('informational') → bounce 1 lần nhẹ nhàng
      // Lưu bounceId để cancelDockBounce() có thể cancel khi focus lại
      if (active && app.dock) {
        dockBounceId = app.dock.bounce('informational');
      } else if (!active) {
        cancelDockBounce();
      }
    } else {
      mainWindow.flashFrame(active);
    }
  });

  // ── Notification click → focus window + mở thread ───────────────
  ipcMain.on('app:openThread', (_event, { zaloId, threadId, threadType }: { zaloId: string; threadId: string; threadType: number }) => {
    if (!mainWindow) return;

    // Restore + focus: Windows không always reliable với focus() khi minimized
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    // Bỏ alwaysOnTop sau 200ms - chỉ cần để "kick" window lên foreground
    setTimeout(() => { try { mainWindow?.setAlwaysOnTop(false); } catch {} }, 200);

    // Delay nhẹ để đảm bảo renderer sẵn sàng nhận IPC
    setTimeout(() => {
      try {
        mainWindow?.webContents.send('app:openThread', { zaloId, threadId, threadType });
      } catch {}
    }, 80);
  });
}

/**
 * Xử lý deep link URL từ custom protocol deplao://
 *
 * Định dạng:
 *   deplao://openChat?accountId=xxx&threadId=yyy&threadType=0&channel=zalo
 *
 * Hỗ trợ thêm action mới bằng cách mở rộng switch(action) bên dưới.
 */
function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    const action = parsed.hostname || parsed.pathname.replace(/^\//, '').split('?')[0];
    const params = Object.fromEntries(parsed.searchParams.entries());

    console.log(`[handleDeepLink] action="${action}" params=`, params);

    switch (action) {
      case 'openChat': {
        const accountId = params.accountId || params.zaloId || '';
        const threadId = params.threadId || '';
        const threadType = parseInt(params.threadType || '0', 10);
        const channel = params.channel || CHANNEL.ZALO;

        if (!accountId || !threadId) {
          console.warn('[handleDeepLink] Missing accountId or threadId');
          return;
        }

        // Gọi lại logic giống notification click → focus + gửi IPC
        if (!mainWindow) return;

        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        setTimeout(() => { try { mainWindow?.setAlwaysOnTop(false); } catch {} }, 200);

        setTimeout(() => {
          try {
            mainWindow?.webContents.send('app:openThread', {
              zaloId: accountId,
              threadId,
              threadType,
            });
          } catch {}
        }, 80);
        break;
      }

      default:
        console.warn(`[handleDeepLink] Unknown action: "${action}"`);
    }
  } catch (err: any) {
    console.error('[handleDeepLink] Failed to parse URL:', url, err.message);
  }
}

/**
 * Auto-reconnect tất cả Telegram accounts khi app khởi động.
 * Tương tự reconnectAllFBAccounts nhưng cho Telegram Bot + User.
 */
async function reconnectAllTelegramAccounts(): Promise<void> {
  try {
    const db = DatabaseService.getInstance();
    if (!db) return;

    const accounts = db.getAccounts();
    const telegramAccounts = accounts.filter((a: any) => {
      const ch = a.channel || 'zalo';
      return (ch === 'telegram_bot' || ch === 'telegram_user') && a.is_active;
    });

    if (telegramAccounts.length === 0) return;

    console.log(`[main] Auto-reconnecting ${telegramAccounts.length} Telegram account(s)...`);

    for (const acc of telegramAccounts) {
      const channel = acc.channel || 'zalo';
      try {
        if (channel === 'telegram_bot') {
          const { startBot } = require('../src/services/telegram/bot/TelegramBotChannelService');
          startBot({
            accountId: acc.zalo_id,
            botToken: acc.cookies || '',
            botUsername: (acc as any).username || '',
            botFirstName: acc.full_name || '',
          });
          console.log(`[main] Telegram Bot ${acc.zalo_id} polling started`);
        } else if (channel === 'telegram_user') {
          const stringSession = acc.cookies || '';
          if (!stringSession) {
            console.warn(`[main] Telegram User ${acc.zalo_id} has no session - skipping`);
            continue;
          }
          // Kiểm tra session hợp lệ (GramJS session là base64 decode thành JSON)
          // Nếu session bắt đầu bằng "U2Fsd" = encrypted blob chưa decrypt được → skip
          if (stringSession.trimStart().startsWith('U2Fsd')) {
            console.warn(`[main] Telegram User ${acc.zalo_id} session is encrypted blob (decrypt failed) - needs re-login`);
            continue;
          }
          const { startListener } = require('../src/services/telegram/TelegramUserListener');
          const result = await startListener({
            accountId: acc.zalo_id,
            phoneNumber: acc.phone || '',
            stringSession,
          });
          if (result?.success) {
            console.log(`[main] Telegram User ${acc.zalo_id} listener started`);
          } else {
            console.warn(`[main] Telegram User ${acc.zalo_id} failed: ${result?.error}`);
          }
        }
      } catch (err: any) {
        console.warn(`[main] Failed to reconnect Telegram ${acc.zalo_id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error('[main] reconnectAllTelegramAccounts error:', err.message);
  }
}

/**
 * Periodic health check for Telegram bots.
 * Checks if registered bots are still polling; reconnects if not.
 * Runs every 60 seconds.
 */
function startTelegramBotHealthCheck(): void {
  setInterval(() => {
    try {
      const { isBotPolling, isBotPollingConflict, tryReconnectBot, getActiveBots } = require('../src/services/telegram/bot/TelegramBotChannelService');
      const activeBots = getActiveBots();
      for (const bot of activeBots) {
        if (!isBotPolling(bot.accountId)) {
          if (isBotPollingConflict(bot.accountId)) continue;
          console.log(`[main] Telegram Bot ${bot.accountId} not polling — attempting reconnect`);
          tryReconnectBot(bot.accountId);
        }
      }
    } catch {}
  }, 60_000);
}

/**
 * Ordered startup: scan all workspaces, start relays + connect Zalo for local workspaces FIRST,
 * THEN connect remote/employee workspaces. Ensures Boss is ready before employees connect.
 */
async function startupAllWorkspaces(): Promise<void> {
  const wsMgr = WorkspaceManager.getInstance();
  const db = DatabaseService.getInstance();
  const allWorkspaces = wsMgr.listWorkspaces();
  const localWorkspaces = allWorkspaces.filter(w => w.type === 'local');
  const remoteWorkspaces = allWorkspaces.filter(w => w.type === 'remote' && w.autoConnect);

  // ── Phase 1: Start relay servers for ALL local workspaces with relayAutoStart ──
  for (const ws of localWorkspaces) {
    if (!ws.relayAutoStart) continue;
    try {
      const HttpRelayService = (await import('../src/services/http/HttpRelayService')).default;
      const relay = HttpRelayService.getInstance();
      const port = ws.relayPort || 9900;
      const res = await relay.start(port); // start() is idempotent - skips if already running
      if (res?.success) {
        console.log(`[startupAllWorkspaces] Relay started on port ${res.port} for workspace "${ws.name}"`);
      }
    } catch (err: any) {
      console.error(`[startupAllWorkspaces] Relay start failed for "${ws.name}":`, err.message);
    }
  }

  // ── Phase 2: Auto-connect Zalo accounts for ALL local workspaces ──
  const LoginService = (await import('../src/services/login/LoginService')).default;
  const loginService = new LoginService();
  const connectedZaloIds = new Set<string>();

  for (const ws of localWorkspaces) {
    try {
      const dbPath = wsMgr.resolveDbPath(ws.dbPath || 'deplao-tool.db');
      if (!dbPath || !require('fs').existsSync(dbPath)) continue;

      // Read accounts from this workspace's DB (without switching active DB)
      const accounts = db.queryOtherDb<any[]>(dbPath, (otherDb) => {
        const rows = otherDb.prepare("SELECT * FROM accounts WHERE is_active = 1 AND (channel = 'zalo' OR channel IS NULL)").all();
        return rows;
      });

      for (const acc of accounts) {
        if (connectedZaloIds.has(acc.zalo_id)) continue; // already connected
        try {
          const decryptedCookies = decryptCookiesForStartup(acc.cookies || '');
          console.log(`[startupAllWorkspaces] ${acc.zalo_id}: raw prefix="${(acc.cookies || '').substring(0, 20)}" → decrypted prefix="${decryptedCookies.substring(0, 40)}" len=${decryptedCookies.length}`);
          const connected = await loginService.connectUser({
            cookies: decryptedCookies,
            imei: acc.imei || '',
            userAgent: acc.user_agent || acc.userAgent || '',
          });
          if (!connected) {
            console.warn(`[startupAllWorkspaces] Zalo ${acc.zalo_id} did not connect from workspace "${ws.name}"; its saved session may need to be signed in again.`);
            continue;
          }
          connectedZaloIds.add(acc.zalo_id);
          console.log(`[startupAllWorkspaces] Connected Zalo ${acc.zalo_id} from workspace "${ws.name}"`);
        } catch (err: any) {
          console.warn(`[startupAllWorkspaces] Failed to connect ${acc.zalo_id} from "${ws.name}":`, err.message);
        }
      }
    } catch (err: any) {
      console.warn(`[startupAllWorkspaces] Failed to load accounts from "${ws.name}":`, err.message);
    }
  }

  // ── Phase 3: Connect remote/employee workspaces (Boss must be ready first) ──
  if (remoteWorkspaces.length > 0) {
    console.log(`[startupAllWorkspaces] Connecting ${remoteWorkspaces.length} remote workspace(s)...`);
    await HttpConnectionManager.getInstance().connectAutoWorkspaces();
  }
  HttpConnectionManager.getInstance().startHealthCheck(60_000);
}

// ─── Cloudflare (địa chỉ cố định, R2 media, đồng bộ DB) — tuỳ chọn, mặc định tắt ─────────────────
// Module được require muộn: lỗi nạp / init của một module không làm hỏng khởi động app.
type CloudLifecycleModule = { init(): Promise<void>; shutdown(): Promise<void> };
let cloudModulesStarted = false;
let cloudShutdownState: 'idle' | 'running' | 'done' = 'idle';

/** Cloudflare chỉ chạy trên máy chủ (không phải máy nhân viên). */
function cloudAllowedHere(): boolean {
  try {
    return require('../src/utils/app/AppModeManager').default.getInstance().getMode() !== 'employee';
  } catch {
    return true;
  }
}

function loadCloudModules(): Array<{ name: string; mod: CloudLifecycleModule }> {
  const loaders: Array<[string, () => CloudLifecycleModule]> = [
    ['tunnel', () => (require('../src/services/cloudflare/tunnel') as typeof import('../src/services/cloudflare/tunnel')).cloudTunnel],
    ['media', () => (require('../src/services/cloudflare/media') as typeof import('../src/services/cloudflare/media')).cloudMedia],
    ['db', () => (require('../src/services/cloudflare/dbsync') as typeof import('../src/services/cloudflare/dbsync')).cloudDb],
    // Bộ đếm mức sử dụng kho (R2 / Google Drive): ghi xuống đĩa khi thoát (bình thường ghi gộp ~15 s)
    ['usage', () => {
      const { cloudflare } = require('../src/services/cloudflare/CloudflareService') as typeof import('../src/services/cloudflare/CloudflareService');
      return { init: async () => undefined, shutdown: async () => { cloudflare.usage.flush(); } };
    }],
  ];
  const out: Array<{ name: string; mod: CloudLifecycleModule }> = [];
  for (const [name, load] of loaders) {
    try {
      const mod = load();
      if (mod) out.push({ name, mod });
    } catch (err: any) {
      console.error(`[main] Cloudflare ${name}: không nạp được module:`, err?.message || err);
    }
  }
  return out;
}

/** Khởi động module Cloudflare (tự bật lại tunnel / hàng đợi R2 / đồng bộ DB nếu đã bật). Không ném. */
async function startCloudModules(): Promise<void> {
  if (cloudModulesStarted || !cloudAllowedHere()) return;
  cloudModulesStarted = true;
  for (const { name, mod } of loadCloudModules()) {
    try {
      await mod.init();
    } catch (err: any) {
      console.error(`[main] Cloudflare ${name} init error:`, err?.message || err);
    }
  }
}

/** Dừng module Cloudflare khi thoát (không xoá gì trên Cloudflare), chờ tối đa timeoutMs. */
async function shutdownCloudModules(timeoutMs: number): Promise<void> {
  const tasks = loadCloudModules().map(({ name, mod }) => Promise.resolve()
    .then(() => mod.shutdown())
    .catch((err: any) => console.warn(`[main] Cloudflare ${name} shutdown error:`, err?.message || err)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const result = await Promise.race([Promise.all(tasks).then(() => 'done' as const), timeout]);
  clearTimeout(timer);
  if (result === 'timeout') console.warn(`[main] Cloudflare shutdown quá ${timeoutMs} ms — thoát tiếp`);
}

/**
 * local-media://: file không có trên máy → hỏi module R2 media (null khi R2 tắt / không có trên R2). Không ném.
 * Chờ ngắn (4 s) khi giao diện còn link CDN của kênh để hiện thay — ảnh ra ngay, R2 vẫn tải tiếp ở nền cho lần sau;
 * chờ dài (45 s) khi giao diện báo R2 là nguồn duy nhất (link CDN đã hết hạn / không có: `?cw=long`).
 */
const CLOUD_MEDIA_WAIT_SHORT_MS = 4_000;
const CLOUD_MEDIA_WAIT_LONG_MS = 45_000;
async function resolveMissingMediaFromCloud(absPath: string, waitMs: number): Promise<string | null> {
  if (!cloudAllowedHere()) return null;
  try {
    const { cloudMedia } = require('../src/services/cloudflare/media') as typeof import('../src/services/cloudflare/media');
    const resolved = await cloudMedia.resolveMissingMediaFile(absPath, { waitMs });
    return resolved && fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * before-quit: hoãn thoát tối đa ~3 s để module Cloudflare dừng gọn (cloudflared, hàng đợi R2, đồng bộ DB) khi DB
 * còn mở, rồi app.quit() lại — lần before-quit thứ hai chạy phần dọn dẹp như cũ. true = đã hoãn.
 */
function deferQuitForCloudShutdown(event: { preventDefault(): void }): boolean {
  if (!cloudModulesStarted || cloudShutdownState === 'done') return false;
  event.preventDefault();
  if (cloudShutdownState === 'running') return true;
  cloudShutdownState = 'running';
  shutdownCloudModules(3000).finally(() => {
    cloudShutdownState = 'done';
    app.quit();
  });
  return true;
}

app.whenReady().then(async () => {
  // Luồng chính bị chặn ≥ 1 s (SQLite đồng bộ, vòng lặp dài…) → Nhật ký "[Hiệu năng] …" — tìm nguyên nhân "Not Responding".
  startMainThreadWatchdog();
  // A resume wakes the Electron main process and background sync services, but
  // Chromium's requests to Vite can remain suspended. The blank screen in dev
  // is therefore a renderer recovery problem, not a stopped message listener.
  powerMonitor.on('suspend', () => {
    if (isDev) {
      devRendererSystemSuspended = true;
      console.log('[main] System suspend detected; monitoring Vite renderer on resume');
    }
  });
  // Telegram User MTProto connections cannot notice a sleep by themselves:
  // GramJS finds the dead socket only at its next ping and then backs off.
  // Probe them on wake, in production as well as dev.
  const notifyTelegramUserResume = (reason: 'resume' | 'unlock-screen') => {
    try {
      const { handleSystemResume } = require('../src/services/telegram/TelegramUserListener');
      handleSystemResume(reason);
    } catch (err: any) {
      console.warn(`[main] Telegram resume handling failed: ${err?.message || err}`);
    }
  };
  powerMonitor.on('unlock-screen', () => notifyTelegramUserResume('unlock-screen'));
  powerMonitor.on('resume', () => {
    notifyTelegramUserResume('resume');
    if (!isDev) return;
    devRendererSystemSuspended = false;
    if (!devRendererSuspended) {
      console.log('[main] System resume detected; Vite renderer was healthy, no reload needed');
      return;
    }
    devRendererReloadAttempts = 0;
    // Let Vite's Node process and Windows loopback socket resume first.
    console.log('[main] System resume detected; checking Vite renderer in 1500ms');
    loadDevRenderer(devRendererSuspended ? 'system resume after suspended request' : 'system resume', 1500);
  });

  // ── Register local-media:// protocol handler ───────────────────────────
  // Supports Range requests for video/audio streaming (seeking, partial load)
  protocol.handle('local-media', async (request) => {
    try {
      // local-media trả ACAO * và bypass CSP: chỉ trang của chính app được đọc. Plugin, trình duyệt
      // nội bộ, Mini App… (Origin khác app) bị chặn để không đọc được file bất kỳ trên máy.
      if (require('../src/services/plugins/PluginProtocol').isBlockedMediaRequest(request.headers, (request as any).referrer, 'http://localhost:27799')) {
        return new Response('Forbidden', { status: 403 });
      }
      const requestUrl = new URL(request.url);
      let filePath = decodeURIComponent(requestUrl.pathname);
      // Gợi ý của giao diện khi file phải lấy từ R2: 'long' = không còn nguồn nào khác (CDN của kênh hết hạn / không có).
      const cloudWaitMs = requestUrl.searchParams.get('cw') === 'long' ? CLOUD_MEDIA_WAIT_LONG_MS : CLOUD_MEDIA_WAIT_SHORT_MS;
      // Windows: strip leading slash → "D:/..." or "media/..."
      if (process.platform === 'win32' && filePath.startsWith('/')) {
        filePath = filePath.slice(1);
      }

      const configFolder = path.dirname(FileStorageService.getBaseDir());
      // console.log(`[local-media] Request: url=${request.url} → filePath=${filePath} configFolder=${configFolder}`);

      if (!path.isAbsolute(filePath)) {
        // Relative path: "media/zaloId/date/img.jpg" → configFolder/media/zaloId/...
        filePath = path.join(configFolder, filePath);
        // console.log(`[local-media] Resolved relative → ${filePath}`);
      } else if (!fs.existsSync(filePath)) {
        // Absolute path but file not found (old drive/folder after move).
        const normalized = filePath.replace(/\\/g, '/');
        const mediaIdx = normalized.lastIndexOf('/media/');
        if (mediaIdx >= 0) {
          const relativePart = normalized.slice(mediaIdx + 1); // "media/zaloId/..."
          filePath = path.join(configFolder, relativePart);
        }
      }

      if (!fs.existsSync(filePath)) {
        // Fallback: file might be missing extension (DB migration bug)
        // Try common extensions: .jpg, .png, .webp, .mp4, .ogg, .mp3
        const exts = ['.jpg', '.png', '.webp', '.mp4', '.ogg', '.mp3'];
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        for (const ext of exts) {
          const candidate = path.join(dir, base + ext);
          if (fs.existsSync(candidate)) {
            // console.log(`[local-media] Found with extension: ${candidate}`);
            filePath = candidate;
            break;
          }
        }
      }

      if (!fs.existsSync(filePath)) {
        // Fallback: check old Telegram media location (userData/telegram_media/)
        const basename = path.basename(filePath);
        const oldTelegramPath = path.join(app.getPath('userData'), 'telegram_media', basename);
        if (fs.existsSync(oldTelegramPath)) {
          filePath = oldTelegramPath;
        }
      }

      if (!fs.existsSync(filePath)) {
        // R2 media (tuỳ chọn, mặc định tắt): file đã được dọn khỏi máy / máy mới khôi phục → tải lại từ R2.
        const fromCloud = await resolveMissingMediaFromCloud(path.resolve(filePath), cloudWaitMs);
        if (fromCloud) filePath = fromCloud;
      }

      if (!fs.existsSync(filePath)) {
        // A stale DB reference is expected after media cleanup or moving the
        // storage folder. Return 404 for the renderer fallback without flooding
        // the Electron log once per visible avatar/message.
        // console.warn(`[local-media] NOT FOUND: ${filePath} (original request: ${request.url})`);
        return new Response('Not Found', { status: 404 });
      }

      // console.log(`[local-media] Serving: ${filePath}`);

      const absPath = path.resolve(filePath);
      const stat = fs.statSync(absPath);
      const fileSize = stat.size;
      const ext = path.extname(absPath).toLowerCase();

      // ── Debug: check file header for MP4 validity ──
      if (ext === '.mp4' || ext === '.webm' || ext === '.mov') {
        try {
          const headerBuf = Buffer.alloc(32);
          const fd = fs.openSync(absPath, 'r');
          fs.readSync(fd, headerBuf, 0, 32, 0);
          fs.closeSync(fd);
          // Check MP4 ftyp box: bytes 4-7 should be 'ftyp'
          const boxSize = headerBuf.readUInt32BE(0);
          const boxType = headerBuf.toString('ascii', 4, 8);
          const brand = headerBuf.toString('ascii', 8, 12);
          // console.log(`[local-media] File header: size=${fileSize} bytes, box=${boxType}, brand=${brand}, boxSize=${boxSize}`);
          // Check for HEVC brand
          if (brand.includes('hvc1') || brand.includes('hev1')) {
            console.warn(`[local-media] WARNING: HEVC/H.265 codec detected (brand=${brand}) - may not play in Chromium!`);
          }

          // Scan for moov atom position (critical for <video> playback)
          // moov should be before mdat for faststart, otherwise <video> can't read metadata
          try {
            const scanBuf = Buffer.alloc(Math.min(fileSize, 64 * 1024)); // scan first 64KB
            const fdScan = fs.openSync(absPath, 'r');
            fs.readSync(fdScan, scanBuf, 0, scanBuf.length, 0);
            fs.closeSync(fdScan);
            let moovOffset = -1;
            let mdatOffset = -1;
            let offset = 0;
            while (offset < scanBuf.length - 8) {
              const boxSize = scanBuf.readUInt32BE(offset);
              const boxType = scanBuf.toString('ascii', offset + 4, offset + 8);
              if (boxType === 'moov') { moovOffset = offset; break; }
              if (boxType === 'mdat') { mdatOffset = offset; }
              if (boxSize < 8) break; // invalid box
              offset += boxSize;
            }
            if (moovOffset >= 0) {
              // console.log(`[local-media] moov atom found at offset ${moovOffset} (faststart OK)`);
            } else {
              console.warn(`[local-media] WARNING: moov atom NOT found in first 64KB! File is NOT faststart.`);
              console.warn(`[local-media] <video> will fail to read metadata. Need to transcode with: ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4`);
            }
            if (mdatOffset >= 0) {
              // console.log(`[local-media] mdat atom found at offset ${mdatOffset}`);
            }
          } catch (e2: any) {
            console.warn(`[local-media] Could not scan for moov: ${e2.message}`);
          }
        } catch (e: any) {
          console.warn(`[local-media] Could not read header: ${e.message}`);
        }
      }
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      // ── Range request support (needed for <video> seeking/streaming) ──
      const rangeHeader = request.headers.get('range');
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      };

      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Stream file bất đồng bộ. Trước đây readFileSync CẢ file trên main process cho mỗi request — với video
      // là mỗi request Range (trình phát gửi nhiều request) — nên mở hội thoại nhiều ảnh / video chặn main
      // process: IPC (tin nhắn, tin ghim…) và các ảnh khác phải xếp hàng chờ.
      const fileBody = (range?: { start: number; end: number }) =>
        Readable.toWeb(fs.createReadStream(absPath, range)) as unknown as ReadableStream;

      if (rangeHeader) {
        // Parse "bytes=start-end" or "bytes=start-"
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = Math.min(match[2] ? parseInt(match[2], 10) : fileSize - 1, fileSize - 1);
          if (start > end) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}`, ...corsHeaders },
            });
          }
          const chunkSize = end - start + 1;

          // console.log(`[local-media] Range request: bytes=${start}-${end}/${fileSize} (chunk=${chunkSize})`);

          return new Response(fileBody({ start, end }), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              ...corsHeaders,
            },
          });
        }
      }

      // ── Full file response (no Range header) ──
      return new Response(fileBody(), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          ...corsHeaders,
        },
      });
    } catch (err: any) {
      console.error('[local-media] Protocol handler error:', err.message);
      return new Response('Internal Error', { status: 500 });
    }
  });

  // Initialize workspace manager (must be BEFORE database init)
  WorkspaceManager.getInstance().initialize();

  // Initialize database
  await DatabaseService.getInstance().initialize();

  // ── Migrate absolute local_paths → relative ──────────────────────────────
  // Defer this compatibility work until the renderer has had time to paint.
  // DatabaseService records completion, so it never scans the message table on
  // every app launch again.
  let startupPathMigrationScheduled = false;
  const runStartupPathMigration = () => {
    if (startupPathMigrationScheduled) return;
    startupPathMigrationScheduled = true;
    setTimeout(() => {
      try {
        const migrated = DatabaseService.getInstance().migrateAllAbsolutePathsToRelative();
        if (migrated > 0) {
          console.log(`[main] Startup migration: converted ${migrated} message(s) to relative paths`);
        }
      } catch (e: any) {
        console.warn(`[main] Startup path migration failed: ${e.message}`);
      }
    }, 30_000).unref();
  };

  // ── Anti-debug: kiểm tra debugger attach (chỉ production/staging) ──────────
  if (!isDev) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const inspector = require('inspector') as typeof import('inspector');
    if (inspector.url()) {
      app.quit();
      process.exit(1);
    }
    setInterval(() => {
      if (inspector.url()) {
        app.quit();
      }
    }, 30_000);
  }


  loadIcons();

  // ── Register deplao:// as default protocol client ─────────────────────
  // Cho phép OS mở app khi click link deplao:// trong trình duyệt
  //
  // ⚠️ Production: app đã đóng gói → setAsDefaultProtocolClient hoạt động đúng.
  // ⚠️ Development: KHÔNG gọi setAsDefaultProtocolClient - dùng manual reg script
  //    (xem hướng dẫn trong agents/references/deep-link-feature.md)
  if (app.isPackaged) {
    if (!app.isDefaultProtocolClient('deplao')) {
      app.setAsDefaultProtocolClient('deplao');
    }
  }

  // Hệ điều hành tự mở lúc đăng nhập: chạy ngầm nếu người dùng chọn vậy
  try { startHiddenAtLogin = getAutoLaunch().startHidden(process.argv); } catch { startHiddenAtLogin = false; }
  createWindow();
  createTray();
  registerWindowControls();
  // Tự mở cùng máy: bật mặc định (cả máy cập nhật từ bản cũ), giữ đúng đường dẫn chạy hiện tại
  try {
    const autoLaunch = getAutoLaunch().syncAtStartup();
    Logger.log(`[main] Tự mở cùng máy: ${!autoLaunch.supported ? 'không áp dụng (bản dev)' : autoLaunch.enabled ? 'bật' : 'tắt'}`
      + `${autoLaunch.blocked ? ' (hệ điều hành đang chặn)' : ''}`);
  } catch (err: any) {
    Logger.warn(`[main] Tự mở cùng máy lỗi: ${err?.message || err}`);
  }

  // `ready-to-show` is a Chromium paint signal, not proof that React has
  // mounted. Start network recovery only after the renderer itself reports a
  // committed frame, otherwise a slow cold Vite load competes with Telegram,
  // Zalo and Facebook recovery on the main process.
  ipcMain.on('app:rendererReady', (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    rendererReportedReady = true;
    console.log('[main] Renderer app mounted');
    onRendererReportedReady?.();
  });
  // Giao diện đã tải xong danh sách hội thoại → khi luồng chính rảnh mới chạy việc nền nặng (đồng bộ bù tin cũ
  // Telegram…) — xem src/utils/startup/startupSettle.ts. Chạy ngay lúc mở app làm app giật.
  ipcMain.on('app:uiSettled', (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    console.log('[main] Renderer UI settled');
    settleWhenMainIdle('renderer UI loaded');
  });

  // ── Handle deep link từ initial launch (first instance) ──────────
  // Khi click deplao:// link lần đầu:
  //   - Production đúng: URL nằm ở process.argv[1] hoặc sau dấu `--`
  //   - Dev / sai config: Electron nhận URL ở argv[1] thay vì main script path
  const initialDeepLink = process.argv.find((arg) => arg.startsWith('deplao://'));
  if (initialDeepLink) {
    setTimeout(() => handleDeepLink(initialDeepLink), 3000);
  }

  // Register all IPC handlers
  registerLoginIpc(mainWindow);
  registerZaloIpc();
  registerDatabaseIpc();
  registerFileIpc();
  registerCRMIpc();
  registerWorkflowIpc();
  registerIntegrationIpc();
  registerAIAssistantIpc();
  registerUtilIpc();
  registerEmployeeIpc();
  registerRelayIpc();
  registerWorkspaceIpc(mainWindow);
  registerFacebookIpc();
  registerTelegramIpc();
  registerTelegramUserIpc();
  registerProxyIpc();
  registerErpTaskIpc();
  registerErpCalendarIpc();
  registerErpNoteIpc();
  registerErpNotificationIpc();
  registerErpHrmIpc();
  registerLockScreenIpc();
  registerLibraryIpc();
  registerMobileSyncIpc();
  registerCloudflareIpc();
  registerApiIpc();
  ApiPlatform.getInstance().configure({
    handlers: ipcHandlerRegistry,
    onBeforeSend: (channel, cb) => EventBroadcaster.onBeforeSend(channel, cb),
    serverUrls: () => {
      try {
        const HttpRelayService = require('../src/services/http/HttpRelayService').default;
        const st = HttpRelayService.getInstance().getStatus();
        const urls = [`http://127.0.0.1:${st.port}/api`];
        if (st.tunnelUrl) urls.unshift(`${String(st.tunnelUrl).replace(/\/+$/, '')}/api`);
        return urls;
      } catch {
        return [];
      }
    },
  });
  // Sự kiện cho API/plugin: chỉ đăng ký hook; không ghi gì khi chưa ai dùng API.
  ApiPlatform.getInstance().startEvents();
  // Plugin: IPC + protocol deplao-plugin://; plugin đã bật khởi động sau khi cửa sổ hiện.
  registerPluginIpc();
  try {
    const PluginsPlatform = require('../src/services/plugins/PluginsPlatform').default;
    const { forkElectron } = require('../src/services/plugins/PluginSandbox');
    const { handlePluginRequest } = require('../src/services/plugins/PluginProtocol');
    PluginsPlatform.getInstance().init({
      fork: forkElectron,
      notifyRenderer: (channel: string, payload: any) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); } catch {}
      },
    });
    protocol.handle('deplao-plugin', (request) => handlePluginRequest(request as any, {
      activeRecord: (id: string) => PluginsPlatform.getInstance().activeRecord(id),
      devOrigin: 'http://localhost:27799',
    }));
    setTimeout(() => {
      PluginsPlatform.getInstance().start().catch((err: any) => console.error('[main] plugins start:', err?.message || err));
    }, 4500);
  } catch (err: any) {
    console.error('[main] plugins init error:', err?.message || err);
  }
  // Show the renderer before starting network listeners. At startup this account
  // can have a large Telegram recovery queue and a Zalo WebSocket login; doing
  // both while Chromium is still loading leaves the window hidden and makes the
  // app appear stuck even though the main process is busy.
  let connectorStartupStarted = false;
  const startConnectorServices = () => {
    if (connectorStartupStarted) return;
    connectorStartupStarted = true;
    console.log('[main] Renderer visible; starting channel connectors');
    // Renderer không báo giao diện đã tải xong (app:uiSettled) → vẫn bắt đầu việc nền sau 60 giây
    armStartupSettleFallback(60_000);

    reconnectAllFBAccounts().catch(err => {
      console.error('[main] reconnectAllFBAccounts error:', err.message);
    });
    reconnectAllTelegramAccounts().catch(err => {
      console.error('[main] reconnectAllTelegramAccounts error:', err.message);
    });
    // Một lần: tin Telegram đã gửi trước 26.10.3 mang giờ máy → xếp lại theo tin kề trên Telegram (sau khi app ổn định).
    // Máy nhân viên chỉ giữ bản sao DB của Boss → không sửa.
    try {
      if (require('../src/utils/app/AppModeManager').default.getInstance().getMode() !== 'employee') {
        require('../src/services/telegram/messages/telegramSentTimestampRepair').scheduleTelegramSentTimestampRepair();
      }
    } catch (err: any) {
      console.error('[main] telegram sent timestamp repair schedule error:', err?.message || err);
    }
    startTelegramBotHealthCheck();
    // Ordered startup: relay + Zalo for local workspaces, then remote workspaces.
    setTimeout(() => startupAllWorkspaces().catch(err => {
      console.error('[main] startupAllWorkspaces error:', err.message);
    }), 500);
    // Cloudflare (tuỳ chọn, mặc định tắt): sau khi DB + relay đã khởi động; không chặn khởi động.
    setTimeout(() => { void startCloudModules(); }, 5000);
  };
  onRendererReportedReady = () => {
    startConnectorServices();
    runStartupPathMigration();
  };
  if (rendererReportedReady) onRendererReportedReady();
  // Keep a late fallback for a broken renderer, but give the renderer enough
  // time to recover first. Starting all listeners at 8 seconds kept a blank
  // window busy with recovery work and obscured the actual renderer failure.
  setTimeout(() => {
    if (!connectorStartupStarted) {
      console.warn('[main] Connector startup fallback: renderer did not report ready');
      startConnectorServices();
      runStartupPathMigration();
    }
  }, 30_000).unref();
  // Resume any active CRM campaigns after restart
  setTimeout(() => CRMQueueService.getInstance().resumeActiveCampaigns(), 3000);
  // Initialize ERP Calendar reminders scheduler
  setTimeout(() => {
    try {
      const ErpCalendarService = require('../src/services/erp/ErpCalendarService').default;
      ErpCalendarService.getInstance().initSchedulers();
    } catch (err: any) { console.error('[main] ErpCalendar scheduler init error:', err.message); }
  }, 3500);
  // Initialize ERP Notification cron (due-soon + overdue)
  setTimeout(() => {
    try {
      const ErpNotificationService = require('../src/services/erp/ErpNotificationService').default;
      ErpNotificationService.getInstance().startSchedulers();
    } catch (err: any) { console.error('[main] ErpNotification scheduler init error:', err.message); }
  }, 3700);
  // Initialize Workflow Engine after a short delay to ensure DB is ready
  setTimeout(() => WorkflowEngineService.getInstance().initialize(), 2000);
  // Initialize Integration Registry. integration:payment → trigger.payment do WorkflowEngineService tự đăng ký
  // (rehookEvents) — thêm hook ở đây sẽ chạy mỗi workflow thanh toán hai lần.
  setTimeout(() => IntegrationRegistry.initialize(), 2500);
  // Public API v1: tự bật API server nếu người dùng bật "Tự bật khi mở app" (mặc định tắt).
  setTimeout(async () => {
    try {
      const { getApiSettingBool } = require('../src/services/api/settings');
      if (!getApiSettingBool('api_server_autostart')) return;
      const AppModeManager = require('../src/utils/app/AppModeManager').default;
      if (AppModeManager.getInstance().getMode() === 'employee') return;
      const HttpRelayService = (await import('../src/services/http/HttpRelayService')).default;
      const relay = HttpRelayService.getInstance();
      if (relay.getStatus().running) return;
      const res = await relay.start();
      console.log('[main] API server autostart:', res?.success ? `port ${res.port}` : res?.error);
    } catch (err: any) {
      console.error('[main] API server autostart error:', err?.message || err);
    }
  }, 3600);

  // Initialize Webhook Gateway (port 9889)
  setTimeout(() => {
    WebhookGatewayService.getInstance().start().then(result => {
      if (result.success) {
        console.log('[main] WebhookGateway started on port ' + result.port);
      }
    });
  }, 3000);

  // Initialize Tracking Service (chỉ chạy trong production build)
  setTimeout(() => {
    try {
      TrackingService.getInstance().start();
    } catch (err: any) {
      console.error('[main] TrackingService init error:', err.message);
    }
  }, 5000);

  // ─── Media cleanup scheduler (tự động xoá media cũ) ─────────────────────
  // Chạy mỗi ngày lúc 3:00 sáng, kiểm tra tất cả tài khoản có cấu hình auto-delete
  const mediaCleanupJob = cron.schedule('0 3 * * *', async () => {
    console.log('[MediaCleanup] Running daily scheduled cleanup...');
    try {
      const DatabaseService = require('../src/services/database/DatabaseService').default;
      const FileStorageService = require('../src/services/file/FileStorageService').default;
      const db = DatabaseService.getInstance();
      const accounts = db.getAccounts();

      for (const acc of accounts) {
        const config = db.getMediaAutoDeleteConfig(acc.zalo_id);
        if (config?.enabled && config.days > 0) {
          const deleted = FileStorageService.cleanupOldMedia(acc.zalo_id, config.days);
          if (deleted > 0) {
            console.log(`[MediaCleanup] Cleaned ${deleted} dirs for ${acc.zalo_id}`);
          }
        }
      }
      console.log('[MediaCleanup] Daily cleanup completed');
    } catch (err: any) {
      console.error('[MediaCleanup] Error:', err.message);
    }
  });
  console.log('[MediaCleanup] Scheduler initialized - runs daily at 3:00 AM');

  // Check for updates — đợi renderer sẵn sàng rồi mới check
  if (!isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // Đợi renderer load xong rồi mới check update (tránh race condition)
    // IPC: renderer báo đã sẵn sàng nhận update events
    ipcMain.once('update:renderer-ready', () => {
      console.log('[AutoUpdate] Renderer ready — checking for updates');
      autoUpdater.checkForUpdates();
    });
    // Fallback: nếu renderer không báo sau 10s, tự check
    setTimeout(() => {
      autoUpdater.checkForUpdates();
    }, 10_000);
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('update:progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update:downloaded', {
        version: info.version,
      });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update:not-available');
    });

    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdate] Error:', err.message);
      mainWindow?.webContents.send('update:error', {
        message: err.message,
        platform: process.platform,
      });
    });
  }

  // IPC từ renderer: trigger check for update
  ipcMain.on('update:check', () => {
    if (!isDev) autoUpdater.checkForUpdates();
  });

  // IPC từ renderer: trigger download (user confirmed)
  ipcMain.on('update:download', () => {
    if (!isDev) autoUpdater.downloadUpdate();
  });

  // IPC từ renderer: install và restart
  ipcMain.on('update:install', () => {
    if (!isDev) autoUpdater.quitAndInstall(false, true);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    setTimeout(() => {
      console.warn('[main] Force-exit after 5s timeout (window-all-closed)');
      process.exit(0);
    }, 5000).unref();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});

app.on('before-quit', (event) => {
  // Cloudflare: dừng tunnel / hàng đợi R2 / đồng bộ DB trước (≤ ~3 s), rồi quit lại và chạy phần dưới như cũ.
  if (deferQuitForCloudShutdown(event)) return;
  isQuitting = true;

  // Dừng tiến trình plugin (deactivate ≤ 5 s chạy nền; utilityProcess tự đóng khi app thoát).
  try {
    const PluginsPlatform = require('../src/services/plugins/PluginsPlatform').default;
    void PluginsPlatform.getInstance().stop();
  } catch {}

  // ── Cleanup background services giữ event loop ──────────────────────
  // Nếu không dọn, CRM timers / cron / webhook server giữ process sống,
  // app "tắt" rồi nhưng vẫn chạy ngầm trong Task Manager.
  try {
    // Dừng tất cả CRM queue timers
    const crmTimers = CRMQueueService.getInstance() as any;
    if (crmTimers?.timers) {
      for (const [zaloId, timer] of crmTimers.timers) {
        clearInterval(timer);
      }
      crmTimers.timers.clear();
    }
  } catch {}

  try {
    // Dừng tất cả workflow cron jobs
    const wfe = WorkflowEngineService.getInstance() as any;
    if (wfe?.cronJobs) {
      for (const [, job] of wfe.cronJobs) {
        try { job.stop(); } catch {}
      }
      wfe.cronJobs.clear();
    }
  } catch {}

  try {
    // Dừng webhook HTTP server
    IntegrationRegistry.stopWebhookServer();
  } catch {}

  try {
    // Dừng webhook gateway
    WebhookGatewayService.getInstance().stop();
  } catch {}

  try {
    // Close DB completely — releases file handles so NSIS installer can update safely.
    // forceFlush() only does WAL checkpoint; close() also releases locks on .db/.wal/.shm.
    DatabaseService.getInstance().close();
  } catch {}

  try {
    // Disconnect all workspace socket connections
    HttpConnectionManager.getInstance().disconnectAll();
  } catch {}

  try {
    // Stop all Telegram Bot polling and User listeners
    const { stopAllBots } = require('../src/services/telegram/bot/TelegramBotChannelService');
    stopAllBots();
  } catch {}
  try {
    const { stopAllListeners } = require('../src/services/telegram/TelegramUserListener');
    stopAllListeners();
  } catch {}
  try {
    const { stopAllPollers } = require('../src/services/workflow/TelegramBotPollingService');
    stopAllPollers();
  } catch {}
});

// ─── Last-resort: ensure DB is closed before process exits ──────────────────
// Covers edge cases where before-quit didn't fire (e.g. process.kill, NSIS force-quit)
app.on('will-quit', () => {
  try { DatabaseService.getInstance().close(); } catch {}
});

// ─── Global error handlers ──────────────────────────────────────────────────
// Không có handlers → unhandled error trong main process = treo im lặng,
// app chạy ngầm mà renderer đã chết → user thấy trắng / không hiển thị gì.
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error);
  // Không crash app - log rồi tiếp tục
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});
