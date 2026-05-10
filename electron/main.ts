import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import DatabaseService from '../src/services/DatabaseService';
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
import { registerErpTaskIpc } from './ipc/erpTaskIpc';
import { registerErpCalendarIpc } from './ipc/erpCalendarIpc';
import { registerErpNoteIpc } from './ipc/erpNoteIpc';
import { registerErpNotificationIpc } from './ipc/erpNotificationIpc';
import { registerErpHrmIpc } from './ipc/erpHrmIpc';
import WorkspaceManager from '../src/utils/WorkspaceManager';
import HttpConnectionManager from '../src/services/HttpConnectionManager';
import WorkflowEngineService from '../src/services/WorkflowEngineService';
import IntegrationRegistry from '../src/services/integrations/IntegrationRegistry';
import EventBroadcaster from '../src/services/EventBroadcaster';
import CRMQueueService from '../src/services/CRMQueueService';
import FileStorageService from '../src/services/FileStorageService';
import { SHOW_DEV_TOOLS, IS_DEV_BUILD } from '../src/configs/BuildConfig.generated';

const isDev = IS_DEV_BUILD;
let isQuitting = false;

// ─── Disable GPU process to save ~200-400MB RAM ────────────────────────────────
// Electron spawns a separate GPU process for hardware acceleration.
// For a chat/CRM app, software rendering is sufficient and saves significant RAM.
app.disableHardwareAcceleration();

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
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
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
    mainWindow.loadURL('http://localhost:5173');
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
            mainWindow.loadURL('http://localhost:5173');
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
          mainWindow.loadURL('http://localhost:5713');
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      // Gửi event sang renderer để navigate đến đúng thread
      mainWindow.webContents.send('app:openThread', { zaloId, threadId, threadType });
    }
  });
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
    const normalised = filePath.replace(/\\/g, '/');
    return net.fetch('file://' + (process.platform === 'win32' ? '/' : '') + normalised);
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
  createWindow();
  createTray();
  registerWindowControls();


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
  registerErpTaskIpc();
  registerErpCalendarIpc();
  registerErpNoteIpc();
  registerErpNotificationIpc();
  registerErpHrmIpc();
  // Auto-reconnect Facebook accounts
  setTimeout(() => reconnectAllFBAccounts(), 4000);
  // Auto-connect remote workspaces with autoConnect=true (after delay for DB + initial workspace switch)
  setTimeout(() => HttpConnectionManager.getInstance().connectAutoWorkspaces(), 5000);
  // Auto-start relay server if configured on active local workspace
  setTimeout(() => {
    try {
      const wsMgr = WorkspaceManager.getInstance();
      const activeWs = wsMgr.getActiveWorkspace();
      if (activeWs && activeWs.type === 'local' && activeWs.relayAutoStart) {
        const port = activeWs.relayPort || 9900;
        const HttpRelayService = require('../src/services/HttpRelayService').default;
        HttpRelayService.getInstance().start(port).then((res: any) => {
          if (res?.success) {
            console.log(`[main] Relay server auto-started on port ${res.port}`);
          }
        }).catch((err: any) => {
          console.error('[main] Relay auto-start failed:', err.message);
        });
      }
    } catch (err: any) {
      console.error('[main] Relay auto-start error:', err.message);
    }
  }, 4000);
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
