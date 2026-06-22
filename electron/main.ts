import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, protocol, net, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import * as cron from 'node-cron';
import DatabaseService from '../src/services/database/DatabaseService';
import { registerLoginIpc } from './ipc/loginIpc';
import { registerZaloIpc } from './ipc/zaloIpc';
import { registerDatabaseIpc } from './ipc/databaseIpc';
import { registerFileIpc } from './ipc/fileIpc';
import { registerCRMIpc } from './ipc/crmIpc';
import { registerWorkflowIpc } from './ipc/workflowIpc';
import { registerIntegrationIpc } from './ipc/integrationIpc';
import { registerAIAssistantIpc } from './ipc/aiAssistantIpc';
import { registerUtilIpc } from './ipc/utilIpc';
import { registerEmployeeIpc } from './ipc/employeeIpc';
import { registerRelayIpc } from './ipc/relayIpc';
import { registerSyncIpc } from './ipc/syncIpc';
import { registerWorkspaceIpc } from './ipc/workspaceIpc';
import { registerFacebookIpc, reconnectAllFBAccounts } from './ipc/facebookIpc';
import { registerProxyIpc } from './ipc/proxyIpc';
import { registerErpTaskIpc } from './ipc/erpTaskIpc';
import { registerErpCalendarIpc } from './ipc/erpCalendarIpc';
import { registerErpNoteIpc } from './ipc/erpNoteIpc';
import { registerErpNotificationIpc } from './ipc/erpNotificationIpc';
import { registerErpHrmIpc } from './ipc/erpHrmIpc';
import { registerLockScreenIpc } from './ipc/lockScreenIpc';
import WorkspaceManager from '../src/utils/WorkspaceManager';
import HttpConnectionManager from '../src/services/http/HttpConnectionManager';
import WorkflowEngineService from '../src/services/workflow/WorkflowEngineService';
import IntegrationRegistry from '../src/services/integrations/IntegrationRegistry';
import EventBroadcaster from '../src/services/event/EventBroadcaster';
import CRMQueueService from '../src/services/crm/CRMQueueService';
import FileStorageService from '../src/services/file/FileStorageService';
import TrackingService from '../src/services/tracking/TrackingService';
import { SHOW_DEV_TOOLS, IS_DEV_BUILD } from '../src/configs/BuildConfig';

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
]);

// ─── Suppress Chromium DevTools "Autofill.enable" / "Autofill.setAddresses" errors ──
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication');
app.commandLine.appendSwitch('disable-features', 'Autofill');

// ─── Single Instance Lock ──────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Đã có instance đang chạy → focus instance đó rồi thoát
  // ⚡ FIX: app.quit() là async — code phía dưới vẫn chạy tiếp nếu không exit ngay.
  // Nếu không exit, instance thứ 2 vẫn đăng ký protocols, IPC handlers, tạo tray icon,
  // chạy ngầm không cửa sổ → process treo trong Task Manager.
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let inAppBrowserWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

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
    backgroundColor: '#1a1a2e',
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

  mainWindow.once('ready-to-show', () => {
    if (cachedNormalIcon && !cachedNormalIcon.isEmpty()) {
      mainWindow?.setIcon(cachedNormalIcon);
    }
    mainWindow?.show();
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
      console.error(`[main] Renderer crashed ${crashCount} times — quitting app`);
      isQuitting = true;
      app.quit();
    }
  });

  // Window bị treo (unresponsive) → thông báo và reload
  mainWindow.on('unresponsive', () => {
    console.warn('[main] Window unresponsive — reloading renderer');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // Load HTML thất bại (file bị thiếu, Vite dev server chưa bật, ...)
  // → window tồn tại nhưng trắng, ready-to-show vẫn fire → user thấy trắng
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] did-fail-load: ${errorCode} ${errorDescription} — ${validatedURL}`);
    // Retry sau 2s (Vite dev server có thể chưa sẵn sàng)
    if (isDev) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL('http://localhost:27799');
        }
      }, 2000);
    }
  });

  // CSP: chặn inline scripts bên ngoài trong production
  if (!isDev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            // img-src và media-src phải có https: để load ảnh/video từ CDN Zalo
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: local-media: blob: https:; media-src 'self' local-media: blob: https:; connect-src 'self' https: wss:; font-src 'self' data: https:; frame-src 'self' https:;",
          ],
        },
      });
    });
  }

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
  app.on('second-instance', (_event, argv) => {
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
        // Force-exit sau 3s phòng trường hợp background service giữ event loop
        setTimeout(() => process.exit(0), 3000).unref();
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
function showTrayNotification() {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: 'Deplao đang chạy ngầm',
    body: 'Ứng dụng vẫn đang hoạt động và nhận tin nhắn bình thường. Nhấn vào biểu tượng tray để mở lại.',
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
    // Force-exit sau 3s phòng trường hợp background service giữ event loop
    setTimeout(() => process.exit(0), 3000).unref();
  });

  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

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
          backgroundColor: '#111827',
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

  // ── Badge / taskbar unread count ─────────────────────────────────
  ipcMain.on('app:setBadge', (_event, count: number) => {
    if (!mainWindow) return;
    if (process.platform === 'darwin') {
      app.setBadgeCount(count > 0 ? count : 0);
    } else if (process.platform === 'win32') {
      if (count > 0) {
        if (!currentIconIsDot) {
          currentIconIsDot = true;
          // Overlay dot trên taskbar (Windows native API — không bị icon cache)
          if (cachedOverlayDot && !cachedOverlayDot.isEmpty()) {
            mainWindow.setOverlayIcon(cachedOverlayDot, `${count} tin chưa đọc`);
          }
          // Tray icon dùng icon_dot (tray không bị cache)
          if (cachedDotIcon && !cachedDotIcon.isEmpty()) {
            tray?.setImage(cachedDotIcon);
          }
        }
        tray?.setToolTip(`Deplao — ${count} tin chưa đọc`);
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
    // Bỏ alwaysOnTop sau 200ms — chỉ cần để "kick" window lên foreground
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
        const channel = params.channel || 'zalo';

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
      const res = await relay.start(port); // start() is idempotent — skips if already running
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
        const rows = otherDb.prepare('SELECT * FROM accounts WHERE is_active = 1').all();
        return rows;
      });

      for (const acc of accounts) {
        if (connectedZaloIds.has(acc.zalo_id)) continue; // already connected
        try {
          await loginService.connectUser({
            cookies: acc.cookies || '',
            imei: acc.imei || '',
            userAgent: acc.user_agent || acc.userAgent || '',
          });
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

app.whenReady().then(async () => {
  // ── Register local-media:// protocol handler ───────────────────────────
  protocol.handle('local-media', (request) => {
    let filePath = decodeURIComponent(new URL(request.url).pathname);
    // Windows: strip leading slash → "D:/..." or "media/..."
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }

    const configFolder = path.dirname(FileStorageService.getBaseDir());

    if (!path.isAbsolute(filePath)) {
      // Relative path: "media/zaloId/date/img.jpg" → configFolder/media/zaloId/...
      filePath = path.join(configFolder, filePath);
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
      return new Response('Not Found', { status: 404 });
    }

    const absPath = path.resolve(filePath);
    const ext = path.extname(absPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    const data = fs.readFileSync(absPath);
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  // Initialize workspace manager (must be BEFORE database init)
  WorkspaceManager.getInstance().initialize();

  // Initialize database
  await DatabaseService.getInstance().initialize();

  // ── Migrate absolute local_paths → relative (runs once in background) ─────
  setTimeout(() => {
    try {
      const migrated = DatabaseService.getInstance().migrateAllAbsolutePathsToRelative();
      if (migrated > 0) {
        DatabaseService.getInstance().forceFlush();
        console.log(`[main] Startup migration: converted ${migrated} message(s) to relative paths`);
      }
    } catch (e: any) {
      console.warn(`[main] Startup path migration failed: ${e.message}`);
    }
  }, 2000);

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
  // ⚠️ Development: KHÔNG gọi setAsDefaultProtocolClient — dùng manual reg script
  //    (xem hướng dẫn trong agents/references/deep-link-feature.md)
  if (app.isPackaged) {
    if (!app.isDefaultProtocolClient('deplao')) {
      app.setAsDefaultProtocolClient('deplao');
    }
  }

  createWindow();
  createTray();
  registerWindowControls();

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
  registerSyncIpc();
  registerWorkspaceIpc(mainWindow);
  registerFacebookIpc();
  registerProxyIpc();
  registerErpTaskIpc();
  registerErpCalendarIpc();
  registerErpNoteIpc();
  registerErpNotificationIpc();
  registerErpHrmIpc();
  registerLockScreenIpc();
  // Auto-reconnect Facebook accounts — start ngay, không đợi 4s
  reconnectAllFBAccounts().catch(err => {
    console.error('[main] reconnectAllFBAccounts error:', err.message);
  });
  // Ordered startup: relay + Zalo for all local workspaces FIRST, then remote workspaces
  setTimeout(() => startupAllWorkspaces().catch(err => {
    console.error('[main] startupAllWorkspaces error:', err.message);
  }), 3000);
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
  // Initialize Integration Registry
  setTimeout(() => {
    IntegrationRegistry.initialize();
    // Bridge integration:payment events → workflow trigger.payment
    EventBroadcaster.onBeforeSend('integration:payment', (data: any) => {
      WorkflowEngineService.getInstance()['triggerWorkflows']('trigger.payment', data);
    });
  }, 2500);

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
  console.log('[MediaCleanup] Scheduler initialized — runs daily at 3:00 AM');

  // Check for updates
  if (!isDev) {
    autoUpdater.autoDownload = true;          // tự tải nền — phù hợp app chạy 24/7
    autoUpdater.autoInstallOnAppQuit = true; // tự cài khi quit nếu đã tải xong

    // Check lần đầu khi khởi động và mỗi 4 giờ
    autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);

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
      // Không crash app nếu update server down
      console.error('[AutoUpdate] Error:', err.message);
      // Gửi lỗi về renderer để UI hiển thị thay vì treo vô hạn
      mainWindow?.webContents.send('update:error', {
        message: err.message,
        platform: process.platform,
      });
    });
  }

  // IPC từ renderer: trigger download
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
    // Force-exit sau 3s phòng trường hợp background service giữ event loop
    setTimeout(() => process.exit(0), 3000).unref();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});

app.on('before-quit', () => {
  isQuitting = true;

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
    // Flush DB ra disk trước khi thoát
    DatabaseService.getInstance().forceFlush();
  } catch {}

  try {
    // Disconnect all workspace socket connections
    HttpConnectionManager.getInstance().disconnectAll();
  } catch {}
});

// ─── Global error handlers ──────────────────────────────────────────────────
// Không có handlers → unhandled error trong main process = treo im lặng,
// app chạy ngầm mà renderer đã chết → user thấy trắng / không hiển thị gì.
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error);
  // Không crash app — log rồi tiếp tục
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});
