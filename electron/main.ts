import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, protocol, net, Notification, safeStorage, powerMonitor } from 'electron';
// Public API v1: record every IPC handler so the API/plugins call the same logic as the UI (must come before the IPC imports).
import { ipcHandlerRegistry } from './ipc/handlerRegistry';
import { startBrowserServer } from './web/BrowserServer';
import { CHANNELS_ONLY } from '../src/shared/channelMode';
import { runInUiScope } from '../src/services/database/dbScope';
import { getBootPayload } from '../src/services/i18n/localeStore';
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
const registerCRMIpc = CHANNELS_ONLY ? () => {} : require('./ipc/crm/crmIpc').registerCRMIpc;
const registerWorkflowIpc = CHANNELS_ONLY ? () => {} : require('./ipc/workflow/workflowIpc').registerWorkflowIpc;
const registerIntegrationIpc = CHANNELS_ONLY ? () => {} : require('./ipc/integrations/integrationIpc').registerIntegrationIpc;
const registerAIAssistantIpc = CHANNELS_ONLY ? () => {} : require('./ipc/ai/aiAssistantIpc').registerAIAssistantIpc;
import { registerUtilIpc } from './ipc/util/utilIpc';
import { registerEmployeeIpc } from './ipc/employee/employeeIpc';
import { registerRelayIpc } from './ipc/network/relayIpc';
import { registerWorkspaceIpc } from './ipc/workspace/workspaceIpc';
import { registerFacebookIpc, reconnectAllFBAccounts } from './ipc/facebook/facebookIpc';
import { registerTelegramIpc } from './ipc/telegram/telegramIpc';
import { registerTelegramUserIpc } from './ipc/telegram/telegramUserIpc';
import { registerProxyIpc } from './ipc/network/proxyIpc';
const registerErpTaskIpc = CHANNELS_ONLY ? () => {} : require('./ipc/erp/erpTaskIpc').registerErpTaskIpc;
const registerErpCalendarIpc = CHANNELS_ONLY ? () => {} : require('./ipc/erp/erpCalendarIpc').registerErpCalendarIpc;
const registerErpNoteIpc = CHANNELS_ONLY ? () => {} : require('./ipc/erp/erpNoteIpc').registerErpNoteIpc;
const registerErpNotificationIpc = CHANNELS_ONLY ? () => {} : require('./ipc/erp/erpNotificationIpc').registerErpNotificationIpc;
const registerErpHrmIpc = CHANNELS_ONLY ? () => {} : require('./ipc/erp/erpHrmIpc').registerErpHrmIpc;
import { registerLockScreenIpc } from './ipc/security/lockScreenIpc';
import { registerLibraryIpc } from './ipc/library/libraryIpc';
import { registerMobileSyncIpc } from './ipc/zalo/mobileSyncIpc';
import { registerApiIpc } from './ipc/api/apiIpc';
const registerPluginIpc = CHANNELS_ONLY ? () => {} : require('./ipc/plugins/pluginIpc').registerPluginIpc;
import { registerI18nIpc } from './ipc/i18n/i18nIpc';
import { registerCloudflareIpc } from './ipc/cloud/cloudflareIpc';
import ApiPlatform from '../src/services/api/ApiPlatform';
import WorkspaceManager from '../src/utils/app/WorkspaceManager';
import HttpConnectionManager from '../src/services/http/HttpConnectionManager';
import { installBossFileAuthHook, setPreferredBossWorkspace } from '../src/services/http/bossSessionAuth';
const WorkflowEngineService = CHANNELS_ONLY ? null : require('../src/services/workflow/WorkflowEngineService').default;
const WebhookGatewayService = CHANNELS_ONLY ? null : require('../src/services/workflow/WebhookGatewayService').default;
const IntegrationRegistry = CHANNELS_ONLY ? null : require('../src/services/integrations/IntegrationRegistry').default;
import EventBroadcaster from '../src/services/event/EventBroadcaster';
const CRMQueueService = CHANNELS_ONLY ? null : require('../src/services/crm/CRMQueueService').default;
import FileStorageService from '../src/services/file/FileStorageService';
const TrackingService = CHANNELS_ONLY ? null : require('../src/services/tracking/TrackingService').default;
import { SHOW_DEV_TOOLS, IS_DEV_BUILD } from '../src/configs/app/BuildConfig';
import Logger from '../src/utils/Logger';
import { armStartupSettleFallback, settleWhenMainIdle } from '../src/utils/startup/startupSettle';
import { startMainThreadWatchdog } from '../src/utils/startup/mainThreadWatchdog';
import { noteSystemPower, startWakeWatch } from '../src/utils/startup/systemIdle';
import { noteWindowHidden, noteWindowShown, startMemoryMonitor } from '../src/utils/startup/memoryMonitor';
import { dbReads } from '../src/services/database/read/DbReadClient';
import { startRendererStartupProfile } from '../src/utils/startup/startupProfiler';
import { newerInstallToRelaunch, type LaunchInfo } from './app/singleInstanceRelaunch';
import { rendererCspHeaders } from './app/rendererCsp';
import { isExternalUrl, isInAppChatLink, mainFrameNavigation } from './app/mainWindowLinks';
import { createAutoLaunch, type AutoLaunch } from '../src/utils/startup/autoLaunch';
import { tr } from '../src/shared/i18n';

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
const WEB_MODE = process.env.DEPLAO_WEB === '1';
let browserServer: Awaited<ReturnType<typeof startBrowserServer>> | undefined;
let isQuitting = false;

// ─── Hardware acceleration ────────────────────────────────────────────────────
// Keep GPU acceleration ON: turning off hardware acceleration makes the CPU render the whole UI,
// which makes the renderer unresponsive → black screen after a while of use.
// app.disableHardwareAcceleration(); // ← REMOVED: caused freeze / black screen

// ─── Cached icons ──────────────────────────────────────────────────────────────
let cachedNormalIcon: Electron.NativeImage | null = null;
let cachedDotIcon:    Electron.NativeImage | null = null;
let cachedOverlayDot: Electron.NativeImage | null = null;   // 16×16 red dot overlay cho Windows taskbar
let currentIconIsDot = false;
let dockBounceId: number | null = null;  // macOS: bounce request ID so it can be cancelled correctly

/** Cancel the dock bounce / taskbar flash on both macOS and Windows */
function cancelDockBounce() {
  if (process.platform === 'darwin') {
    // macOS: cancel the bounce using the saved ID
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

/** Load the icon: prefer _128.png (128x128), fall back to the original .png and resize */
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


// ─── Disable remote debugging as soon as it loads (before app.whenReady) ────────
if (!isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('--inspect',     '0');
  app.commandLine.appendSwitch('--inspect-brk', '0');
}

// ─── Force the Vietnamese locale → input[type="date"] shows dd/mm/yyyy ────────
app.commandLine.appendSwitch('lang', 'vi-VN');
app.commandLine.appendSwitch('accept-lang', 'vi-VN,vi;q=0.9');

// Set the app name (shown on the taskbar, tray, macOS dock)
app.setName('Deplao');

// Windows: set the AppUserModelId so the taskbar / notifications show the right icon & name
// Dev: a unique AUMID every run → Windows creates a new icon cache → the right icon shows
// Production: fixed AUMID (matches the electron-builder appId; the exe has the icon embedded via afterPack)
if (process.platform === 'win32') {
  app.setAppUserModelId(isDev ? `com.Deplao.dev.${Date.now()}` : 'com.Deplao.app');
}

// ─── Register custom protocol BEFORE app ready (required by Electron) ─────────
// local-media://abs-path  →  serve file from absolute path on disk
// Usage in renderer: local-media:///D:/path/to/file.jpg
//
// deplao://openChat?accountId=xxx&threadId=yyy&threadType=0&channel=zalo
//   → deep link: opens the app + activates the right conversation
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
    // Plugin UI: each plugin gets its own origin deplao-plugin://<id> (does not bypass CSP).
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
// The build just launched sends its version + run path: an old build still running in the background (hidden to the tray) that sees a newer build quits itself
// and opens the new build (singleInstanceRelaunch.ts). Before, after installing a new build and clicking open, nothing appeared until the old build was closed.
const launchInfo: LaunchInfo = {
  version: app.getVersion(),
  packaged: app.isPackaged,
  // AppImage: process.execPath is inside the temporary mount folder of the .AppImage file itself
  execPath: process.env.APPIMAGE || process.execPath,
};
const gotLock = app.requestSingleInstanceLock(launchInfo as unknown as Record<string, unknown>);
if (!gotLock) {
  // An instance is already running → focus that instance and quit
  // ⚡ FIX: app.quit() is async - the code below keeps running if it does not exit right away.
  // If it does not exit, the second instance still registers protocols and IPC handlers and creates the tray icon,
  // and runs in the background with no window → the process hangs in Task Manager.
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let inAppBrowserWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let rendererReportedReady = false;

// ─── Launch at login (src/utils/startup/autoLaunch.ts) ─────────────────────────────────
// Create when needed: userData is only correct after app.setName('Deplao').
let autoLaunchInstance: AutoLaunch | null = null;
function getAutoLaunch(): AutoLaunch {
  autoLaunchInstance ??= createAutoLaunch({
    platform: process.platform,
    packaged: app.isPackaged,
    // AppImage: process.execPath is inside the temporary mount folder of the .AppImage file
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
/** The OS launched the app at sign-in and the user chose to run in the background: the first window is not shown */
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
    // macOS: hiddenInset → hides the title bar, keeps the traffic light buttons
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
  if (WEB_MODE) {
    // Existing services target this window for events and workspace state. The browser
    // receives the same events; the placeholder never loads a second React client.
    const originalSend = mainWindow.webContents.send.bind(mainWindow.webContents);
    mainWindow.webContents.send = (channel: string, ...args: any[]) => {
      browserServer?.publish(channel, args);
      originalSend(channel, ...args);
    };
  }
  // CPU profile of the UI at app launch: only when requested (flag file diagnostics/profile-next-startup, see utils/startup/startupProfiler)
  startRendererStartupProfile(mainWindow.webContents);

  // Load Vite dev server or built files
  if (WEB_MODE) {
    void mainWindow.loadURL('about:blank');
  } else if (isDev) {
    mainWindow.loadURL('http://localhost:27799');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // DevTools: only open in the dev build
  if (SHOW_DEV_TOOLS && !WEB_MODE) {
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
    if (WEB_MODE) return;
    if (cachedNormalIcon && !cachedNormalIcon.isEmpty()) {
      mainWindow?.setIcon(cachedNormalIcon);
    }
    // Launch at login: runs in the background in the tray, notifies once (click the tray or open Deplao again to show the window)
    if (startHiddenAtLogin) {
      startHiddenAtLogin = false;
      showTrayNotification(tr('Deplao đã mở cùng máy'), tr('Đang chạy ngầm để nhận tin nhắn. Bấm biểu tượng Deplao ở khay để mở.'));
      return;
    }
    mainWindow?.show();
  });

  // Vite can take longer than Chromium's normal paint deadline after a cold
  // start. Do not show an unpainted Chromium surface forever: the old fallback
  // only called show(), which is exactly the blank blue screen users saw after
  // Electron's network service restarted.
  setTimeout(() => {
    if (!WEB_MODE && !initialWindowShown && mainWindow && !mainWindow.isDestroyed()) {
      console.warn('[main] Renderer did not emit ready-to-show in time; recovering renderer');
      mainWindow.show();
      if (isDev) {
        loadDevRenderer('ready-to-show timeout', 250);
      } else {
        mainWindow.webContents.reload();
      }
    }
  }, 8_000).unref();

  // Links / navigation (app/mainWindowLinks): the preload attaches electronAPI to every page of this window → the main window only stays in the
  // Deplao UI. Web links (link not caught by a click, window.open, target="_blank", middle click, Telegram mini apps) open
  // in the machine's browser to keep the login session; no Electron window is opened.
  const linkOptions = { isDev, devOrigin: 'http://localhost:27799', entryFile: path.join(__dirname, '../../dist/index.html') };
  // Telegram / Zalo group links: the UI opens the conversation / Mini App inside the app (app:openChatLink), not in the browser
  const openLinkOutside = (url: string) => {
    if (isInAppChatLink(url) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:openChatLink', url);
    else if (isExternalUrl(url)) shell.openExternal(url).catch(() => {});
  };
  mainWindow.webContents.on('will-navigate', (details: any) => {
    const url = String(details?.url || '');
    const decision = mainFrameNavigation(url, linkOptions);
    if (decision.allow) return;
    details.preventDefault();
    if (decision.openExternal || isInAppChatLink(url)) openLinkOutside(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openLinkOutside(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-frame-navigate', (details: any) => {
    try {
      if (details.isMainFrame) return;
      const current = String(details.frame?.url || '');
      const target = String(details.url || '');
      const { shouldBlockPluginFrameNavigation } = require('../src/services/plugins/PluginProtocol');
      if (shouldBlockPluginFrameNavigation(current, target)) details.preventDefault();
    } catch {}
  });

  // A successful full page load means Vite is reachable again. Reset the
  // bounded retry budget so a later laptop suspend can recover independently.
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isDev) return;
    devRendererReloadAttempts = 0;
    devRendererSuspended = false;
  });

  // ── Renderer crash recovery ────────────────────────────────────────────
  // When the renderer process crashes or the OS kills it (OOM) → white screen,
  // the X button is blocked by the close handler → the user has to open Task Manager.
  // Fix: automatically reload the renderer; if it still crashes → quit completely.
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

  // Window is hung (unresponsive) → show a notice and reload
  mainWindow.on('unresponsive', () => {
    console.warn('[main] Window unresponsive - reloading renderer');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // Loading the HTML failed (file missing, Vite dev server not running, ...)
  // → the window exists but is blank, ready-to-show still fires → the user sees a blank window
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

  // Production: the renderer's console.* is turned off (terser drop_console + obfuscator) → only errors from Chromium remain
  // report themselves (uncaught exception, unhandled rejection, CSP…). Put those warn/error entries into the Log (prefix [renderer]).
  // Not needed in dev (DevTools + the renderer Logger already sends it via 'log:append' → avoids duplicate writes).
  if (!isDev) {
    mainWindow.webContents.on('console-message', (details: any) => {
      try {
        const level = details?.level;
        if (level !== 'error' && level !== 'warning') return;
        if (details?.frame?.parent) return; // plugin iframe → ignored
        const message = String(details?.message ?? '');
        if (!message || message.startsWith('Failed to load resource')) return; // broken images / CDN: too noisy
        // source 'console': Logger drops quoted strings (they may contain data), truncates them, adds the [console] prefix
        Logger.appendFromRenderer(level === 'error' ? 'error' : 'warn', message, 'console');
      } catch { /* frame already disposed */ }
    });
  }

  const mainContentsId = (): number | null => {
    try { return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null; } catch { return null; }
  };

  // CSP: blocks external inline scripts in production, applies only to Deplao's own content (app/rendererCsp). The internal browser
  // and Telegram mini apps that share the session stay as in the dev build; deplao-plugin:// app pages keep their own CSP.
  // ⚠️ Also only ONE onHeadersReceived listener for this session (see the note below).
  if (!isDev) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = rendererCspHeaders(details, mainContentsId());
      callback(responseHeaders ? { responseHeaders } : {});
    });
  }

  // Employee: <img>/<video> point straight at Boss's files (/api/media, /api/library). Boss requires an Authorization header that
  // tags cannot send → attach the employee session token here: only for registered Boss, only for this window's main frame.
  // ⚠️ Electron keeps only ONE listener per webRequest event of a session: this is the ONLY onBeforeSendHeaders of the
  // main window's session (the internal browser shares the session and is excluded by webContentsId) → to add more, merge them into this hook.
  installBossFileAuthHook(mainWindow.webContents.session, mainContentsId);
  setPreferredBossWorkspace(() => {
    try { return WorkspaceManager.getInstance().getActiveWorkspaceId(); } catch { return undefined; }
  });
  HttpConnectionManager.getInstance().seedBossSessions();

  // The OS frame's X button (not used because frame=false) - still handled for safety
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
  // Hidden / minimized for a long time: release the window's image cache + write RAM to the Log (utils/startup/memoryMonitor.ts)
  mainWindow.on('minimize', () => {
    mainWindow?.webContents.send('app:windowFocus', false);
    if (mainWindow) noteWindowHidden(mainWindow);
  });
  mainWindow.on('restore', () => {
    cancelDockBounce();
    mainWindow?.webContents.send('app:windowFocus', true);
    noteWindowShown();
  });
  mainWindow.on('hide', () => {
    mainWindow?.webContents.send('app:windowFocus', false);
    if (mainWindow) noteWindowHidden(mainWindow);
  });
  mainWindow.on('show', () => {
    cancelDockBounce();
    mainWindow?.webContents.send('app:windowFocus', true);
    noteWindowShown();
    // Re-apply the overlay after showing again
    if (process.platform === 'win32' && currentIconIsDot && cachedOverlayDot && !cachedOverlayDot.isEmpty()) {
      mainWindow?.setOverlayIcon(cachedOverlayDot, tr('Tin chưa đọc'));
    }
  });

  // Set EventBroadcaster window reference
  EventBroadcaster.setWindow(mainWindow);

  // Set HttpConnectionManager window reference for status push events
  HttpConnectionManager.getInstance().setMainWindow(mainWindow);

  // When a second instance tries to open → focus the current instance
  // On Windows: deep link from the browser → argv contains the URL to parse
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // A newer build was just installed and opened while this build runs in the background → quit, open the new build (with the deep link if any)
    const newer = newerInstallToRelaunch(launchInfo, additionalData);
    if (newer) {
      Logger.log(`[main] Bản ${newer.version} vừa được mở (đang chạy ${launchInfo.version}) → thoát để mở bản mới`);
      const deepLink = argv.find((arg: string) => arg.startsWith('deplao://'));
      app.relaunch({ execPath: newer.execPath, args: deepLink ? [deepLink] : [] });
      isQuitting = true;
      app.quit();
      // Cleanup when quitting gets stuck: app.exit still opens the new build (process.exit does not)
      setTimeout(() => app.exit(0), 8000).unref();
      return;
    }
    if (mainWindow && !WEB_MODE) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }

    // Parse the deep link URL from the command line (Windows protocol handler)
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

/** Tray menu. Rebuilt when the UI language changes, so the labels follow tr() (see registerI18nIpc below). */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: tr('Mở Deplao'),
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: tr('Thoát hoàn toàn'),
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
}

function createTray() {
  let icon = cachedNormalIcon && !cachedNormalIcon.isEmpty()
    ? cachedNormalIcon
    : nativeImage.createFromPath(resolveIconPath(
        process.platform === 'win32' ? 'resources/icons/icon.ico' : 'resources/icons/icon.png'
      ));

  // macOS menu bar: the tray icon must be small (~18×18 points). A 128px icon would show up very large.
  // Resize to 18×18 so it displays at the right size in the macOS menu bar.
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  tray.setToolTip('Deplao');
  tray.setContextMenu(buildTrayMenu());

  // Double-click the tray → open the app
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

/** Show a system tray notification when the app is hidden to the tray */
function showTrayNotification(
  title = tr('Deplao đang chạy ngầm'),
  body = tr('Ứng dụng vẫn đang hoạt động và nhận tin nhắn bình thường. Nhấn vào biểu tượng tray để mở lại.'),
) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title,
    body,
    silent: false,
  });
  notif.show();
  // Close automatically after 5 seconds
  setTimeout(() => notif.close(), 5000);
}

// Window control IPC handlers
function registerWindowControls() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  // The X button on the custom title bar → hides to the tray (does not fully quit)
  ipcMain.on('window:close', () => {
    mainWindow?.hide();
    showTrayNotification();
  });

  // Full quit from the tray menu or the renderer
  ipcMain.on('window:quit', () => {
    isQuitting = true;
    app.quit();
    // Force-exit: the DB close() already ran in before-quit (sync, ~1ms).
    // 5s is enough for the socket disconnect + service stop. If it still hangs → force kill.
    setTimeout(() => {
      console.warn('[main] Force-exit after 5s timeout — background service may be stuck');
      process.exit(0);
    }, 5000).unref();
  });

  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

  // ─── Log (Logger) → renderer ─────────────────────────────────
  // Hook the global console so that direct console.* calls (not through Logger) also go into the buffer
  Logger.installConsoleHook();
  // Forward each new log entry to the Log tab (no throttling, the buffer is capped at 2000 lines)
  Logger.onEntry((entry) => {
    try { mainWindow?.webContents.send('log:entry', entry); } catch { /* window already closed */ }
  });
  ipcMain.handle('log:getBuffer', () => Logger.getBuffer());
  ipcMain.handle('log:clear', () => { Logger.clearBuffer(); return true; });
  // Renderer → Log: the renderer console is stripped in production, so the renderer Logger sends warn/error/notice
  // through this channel. appendFromRenderer checks the types itself, masks tokens/cookies, limits to 20 lines/s + merges duplicate lines within 2 s.
  ipcMain.on('log:append', (_event, payload: { level?: unknown; msg?: unknown } | undefined) => {
    Logger.appendFromRenderer(payload?.level, payload?.msg);
  });

  // Open external link in browser
  // Only http, https, mailto (app/mainWindowLinks): links taken from messages, unknown links (file:, ms-msdt:…) can run programs.
  ipcMain.on('shell:openExternal', (_event, url: string) => {
    if (isExternalUrl(url)) shell.openExternal(url).catch(() => {});
  });

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const resolved = FileStorageService.resolveAbsolutePath(filePath);
      if (!resolved || !fs.existsSync(resolved)) {
        return { success: false, error: tr('Không tìm thấy tệp đính kèm') };
      }
      const error = await shell.openPath(resolved);
      return error ? { success: false, error } : { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || tr('Không thể mở tệp') };
    }
  });

  ipcMain.handle('shell:openInApp', async (_event, url: string) => {
    try {
      if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: tr('Chỉ hỗ trợ liên kết web http/https') };
      }

      if (!inAppBrowserWindow || inAppBrowserWindow.isDestroyed()) {
        inAppBrowserWindow = new BrowserWindow({
          width: 1180,
          height: 820,
          minWidth: 860,
          minHeight: 620,
          title: tr('Trình duyệt nội bộ'),
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
      return { success: false, error: error?.message || tr('Không thể mở liên kết trong app') };
    }
  });

  // ── Administrator rights (Windows) ─────────────────────────────────────
  // If the app runs as "Run as administrator", Windows (UIPI) blocks dragging files from File Explorer into the app: all channels
  // cannot drag images / files. The UI asks once when the app opens to warn; `net session` only works when you have the rights.
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

  // ── Launch at login (Settings → Notifications → Start with the OS), saved per machine ──────────────
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
          // Overlay dot on the taskbar (Windows native API - not affected by the icon cache)
          if (cachedOverlayDot && !cachedOverlayDot.isEmpty()) {
            mainWindow.setOverlayIcon(cachedOverlayDot, tr('{{count}} tin chưa đọc', { count }));
          }
          // The tray icon uses icon_dot (the tray is not cached)
          if (cachedDotIcon && !cachedDotIcon.isEmpty()) {
            tray?.setImage(cachedDotIcon);
          }
        }
        tray?.setToolTip(tr('Deplao - {{count}} tin chưa đọc', { count }));
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
      // macOS: uses dock.bounce('informational') → one gentle bounce
      // Store bounceId so cancelDockBounce() can cancel it when the window regains focus
      if (active && app.dock) {
        dockBounceId = app.dock.bounce('informational');
      } else if (!active) {
        cancelDockBounce();
      }
    } else {
      mainWindow.flashFrame(active);
    }
  });

  // ── Notification click → focus window + open thread ───────────────
  ipcMain.on('app:openThread', (_event, { zaloId, threadId, threadType }: { zaloId: string; threadId: string; threadType: number }) => {
    if (!mainWindow) return;
    if (WEB_MODE) {
      mainWindow.webContents.send('app:openThread', { zaloId, threadId, threadType });
      return;
    }

    // Restore + focus: on Windows, focus() is not always reliable when minimized
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    // Remove alwaysOnTop after 200ms - only needed to "kick" the window to the foreground
    setTimeout(() => { try { mainWindow?.setAlwaysOnTop(false); } catch {} }, 200);

    // Short delay to make sure the renderer is ready to receive IPC
    setTimeout(() => {
      try {
        mainWindow?.webContents.send('app:openThread', { zaloId, threadId, threadType });
      } catch {}
    }, 80);
  });
}

/**
 * Handle the deep link URL from the custom protocol deplao://
 *
 * Format:
 *   deplao://openChat?accountId=xxx&threadId=yyy&threadType=0&channel=zalo
 *
 * Add a new action by extending the switch(action) below.
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

        // Call the same logic as the notification click → focus + send IPC
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
 * Auto-reconnect all Telegram accounts when the app starts.
 * Similar to reconnectAllFBAccounts, but for Telegram Bot + User.
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
          // Check that the session is valid (a GramJS session is base64 that decodes to JSON)
          // If the session starts with "U2Fsd" = an encrypted blob that could not be decrypted → skip
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

// ─── Cloudflare (fixed address, R2 media, DB sync): optional, off by default ─────────────────
// The module is required late: a load / init error in one module does not break app startup.
type CloudLifecycleModule = { init(): Promise<void>; shutdown(): Promise<void> };
let cloudModulesStarted = false;
let cloudShutdownState: 'idle' | 'running' | 'done' = 'idle';

/** Cloudflare only runs on the host machine (not on an employee machine). */
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
    // Usage counter for storage (R2 / Google Drive): written to disk on quit (normally written in batches every ~15 s)
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

/** Start the Cloudflare module (re-enables the tunnel / R2 queue / DB sync if they were on). Does not throw. */
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

/** Stop the Cloudflare module on quit (deletes nothing on Cloudflare), waiting at most timeoutMs. */
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
 * local-media://: a file that is not on the machine → asks the R2 media module (null when R2 is off / the file is not on R2). Does not throw.
 * Short wait (4 s) when the UI still has the channel's CDN link to show instead: the image appears at once, and R2 keeps downloading in the background for next time;
 * long wait (45 s) when the UI says R2 is the only source (CDN link expired / missing: `?cw=long`).
 */
const CLOUD_MEDIA_WAIT_SHORT_MS = 4_000;
const CLOUD_MEDIA_WAIT_LONG_MS = 45_000;
async function resolveMissingMediaFromCloud(absPath: string, waitMs: number): Promise<string | null> {
  if (!cloudAllowedHere()) return null;
  try {
    const { cloudMedia } = require('../src/services/cloudflare/media') as typeof import('../src/services/cloudflare/media');
    const resolved = await cloudMedia.resolveMissingMediaFile(absPath, { waitMs });
    if (!resolved) return null;
    return (await fs.promises.stat(resolved).then(() => true, () => false)) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Video diagnostics for video served via local-media: HEVC (Chromium cannot play it), moov not within the first 64 KB (not
 * faststart, so <video> cannot read the info). Once per file per session, read asynchronously in the background. Before, it opened and read
 * 64 KB synchronously on the main process for EVERY Range request of the video player.
 */
const checkedVideoContainers = new Set<string>();
function checkVideoContainerOnce(absPath: string, fileSize: number): void {
  if (checkedVideoContainers.has(absPath)) return;
  if (checkedVideoContainers.size >= 2000) checkedVideoContainers.clear();
  checkedVideoContainers.add(absPath);
  void (async () => {
    const handle = await fs.promises.open(absPath, 'r');
    try {
      const scanBuf = Buffer.alloc(Math.min(fileSize, 64 * 1024));
      const { bytesRead } = await handle.read(scanBuf, 0, scanBuf.length, 0);
      if (bytesRead < 12) return;
      const brand = scanBuf.toString('ascii', 8, 12);
      if (brand.includes('hvc1') || brand.includes('hev1')) {
        console.warn(`[local-media] WARNING: HEVC/H.265 codec detected (brand=${brand}) - may not play in Chromium!`);
      }
      let offset = 0;
      let moovFound = false;
      while (offset < bytesRead - 8) {
        const boxSize = scanBuf.readUInt32BE(offset);
        if (scanBuf.toString('ascii', offset + 4, offset + 8) === 'moov') { moovFound = true; break; }
        if (boxSize < 8) break; // invalid box
        offset += boxSize;
      }
      if (!moovFound) {
        console.warn(`[local-media] WARNING: moov atom NOT found in first 64KB of ${path.basename(absPath)} - file is NOT faststart.`);
      }
    } finally {
      await handle.close().catch(() => {});
    }
  })().catch((err: any) => console.warn(`[local-media] Could not read video header: ${err?.message || err}`));
}

/**
 * before-quit: delays quitting by up to ~3 s so the Cloudflare module can stop cleanly (cloudflared, R2 queue, DB sync) while the DB
 * is still open, then calls app.quit() again: the second before-quit run does the cleanup as before. true = quit was delayed.
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
  // Main thread blocked ≥ 1 s (sync SQLite, long loops…) → Log "[Hiệu năng] …" (performance) to find the cause of "Not Responding".
  startMainThreadWatchdog();
  // RAM per process (main, windows, GPU…) → Log "[Hiệu năng] RAM Deplao …" (performance) every 30 minutes
  startMemoryMonitor(() => app.getAppMetrics());
  // Heavy DB reads (opening a conversation, searching messages, lists of images / files / conversations) run in the read worker, not blocking the main thread
  dbReads.enable({ log: (msg) => Logger.warn(msg) });
  // A resume wakes the Electron main process and background sync services, but
  // Chromium's requests to Vite can remain suspended. The blank screen in dev
  // is therefore a renderer recovery problem, not a stopped message listener.
  // Heavy background work (DB base snapshot, media scan, Telegram message catch-up) waits until the machine wakes / unlocks, and stops when the machine
  // goes to sleep midway: running it right at boot pushes the disk to 100 % and the app freezes (utils/startup/systemIdle.ts).
  // powerMonitor does not report on some machines (Modern Standby): a 30-second tick detects that the machine just woke up
  startWakeWatch();
  powerMonitor.on('suspend', () => {
    noteSystemPower('suspend');
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
  powerMonitor.on('unlock-screen', () => {
    noteSystemPower('unlock');
    notifyTelegramUserResume('unlock-screen');
  });
  powerMonitor.on('resume', () => {
    noteSystemPower('resume');
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
      // local-media returns ACAO * and bypasses CSP: only the app's own pages may read it. Plugins, the internal browser,
      // Telegram Mini apps… (Origin other than the app) are blocked so they cannot read any file on the machine.
      if (require('../src/services/plugins/PluginProtocol').isBlockedMediaRequest(request.headers, (request as any).referrer, 'http://localhost:27799')) {
        return new Response('Forbidden', { status: 403 });
      }
      const requestUrl = new URL(request.url);
      let filePath = decodeURIComponent(requestUrl.pathname);
      // The UI's hint for when the file must come from R2: 'long' = no other source is left (channel CDN expired / missing).
      const cloudWaitMs = requestUrl.searchParams.get('cw') === 'long' ? CLOUD_MEDIA_WAIT_LONG_MS : CLOUD_MEDIA_WAIT_SHORT_MS;
      // Windows: strip leading slash → "D:/..." or "media/..."
      if (process.platform === 'win32' && filePath.startsWith('/')) {
        filePath = filePath.slice(1);
      }

      const configFolder = path.dirname(FileStorageService.getBaseDir());
      // console.log(`[local-media] Request: url=${request.url} → filePath=${filePath} configFolder=${configFolder}`);

      // Asynchronous file checks: existsSync / statSync / reading the start of the video on the main process for each image and each request
      // video Range requests froze the whole app when the disk was busy (machine short on RAM for pagefile writes, other apps reading and writing a lot).
      const statFile = (p: string) => fs.promises.stat(p).then((s) => (s.isFile() ? s : null), () => null);
      let stat: fs.Stats | null;
      if (!path.isAbsolute(filePath)) {
        // Relative path: "media/zaloId/date/img.jpg" → configFolder/media/zaloId/...
        filePath = path.join(configFolder, filePath);
        stat = await statFile(filePath);
      } else {
        stat = await statFile(filePath);
        if (!stat) {
          // Absolute path but file not found (old drive/folder after move).
          const normalized = filePath.replace(/\\/g, '/');
          const mediaIdx = normalized.lastIndexOf('/media/');
          if (mediaIdx >= 0) {
            const relativePart = normalized.slice(mediaIdx + 1); // "media/zaloId/..."
            filePath = path.join(configFolder, relativePart);
            stat = await statFile(filePath);
          }
        }
      }

      if (!stat) {
        // Fallback: file might be missing extension (DB migration bug)
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        for (const candidateExt of ['.jpg', '.png', '.webp', '.mp4', '.ogg', '.mp3']) {
          const candidate = path.join(dir, base + candidateExt);
          const found = await statFile(candidate);
          if (found) { filePath = candidate; stat = found; break; }
        }
      }

      if (!stat) {
        // Fallback: check old Telegram media location (userData/telegram_media/)
        const oldTelegramPath = path.join(app.getPath('userData'), 'telegram_media', path.basename(filePath));
        const found = await statFile(oldTelegramPath);
        if (found) { filePath = oldTelegramPath; stat = found; }
      }

      if (!stat) {
        // R2 media (optional, off by default): files cleaned off the machine / a newly restored machine → download them again from R2.
        const fromCloud = await resolveMissingMediaFromCloud(path.resolve(filePath), cloudWaitMs);
        if (fromCloud) { filePath = fromCloud; stat = await statFile(filePath); }
      }

      if (!stat) {
        // A stale DB reference is expected after media cleanup or moving the
        // storage folder. Return 404 for the renderer fallback without flooding
        // the Electron log once per visible avatar/message.
        return new Response('Not Found', { status: 404 });
      }

      const absPath = path.resolve(filePath);
      const fileSize = stat.size;
      const ext = path.extname(absPath).toLowerCase();

      // Video diagnostics (HEVC, not faststart): once per file, read in the background, the response is not kept
      if (ext === '.mp4' || ext === '.mov') checkVideoContainerOnce(absPath, fileSize);
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

      // Asynchronous file streaming. Before, readFileSync read the WHOLE file on the main process for each request, and with video
      // every Range request (the player sends many requests), so opening a conversation with many images / videos blocked the main
      // process: IPC (messages, pinned messages…) and other images had to queue up and wait.
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

  // ── Anti-debug: check whether a debugger is attached (production / staging only) ──────────
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
  // Let the OS open the app when a deplao:// link is clicked in the browser
  //
  // ⚠️ Production: the app is packaged → setAsDefaultProtocolClient works correctly.
  // ⚠️ Development: do NOT call setAsDefaultProtocolClient - use the manual registration script
  //    (see the guide in agents/references/deep-link-feature.md)
  if (app.isPackaged) {
    if (!app.isDefaultProtocolClient('deplao')) {
      app.setAsDefaultProtocolClient('deplao');
    }
  }

  // The OS launches the app at sign-in: runs in the background if the user chose that
  try { startHiddenAtLogin = getAutoLaunch().startHidden(process.argv); } catch { startHiddenAtLogin = false; }
  createWindow();
  if (!WEB_MODE) createTray();
  registerWindowControls();
  // Launch at login: on by default (machines updated from an old build too), keeps the current run path
  try {
    const autoLaunch = WEB_MODE ? { supported: false, enabled: false, blocked: false } : getAutoLaunch().syncAtStartup();
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
  // Once the UI has loaded the conversation list → heavy background work only starts when the main thread is idle (catch-up sync of old messages
  // Telegram…) - see src/utils/startup/startupSettle.ts. Running it right at app launch makes the app stutter.
  ipcMain.on('app:uiSettled', (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    console.log('[main] Renderer UI settled');
    settleWhenMainIdle('renderer UI loaded');
  });

  // ── Handle the deep link from the initial launch (first instance) ──────────
  // When a deplao:// link is clicked for the first time:
  //   - Production (correct): the URL is in process.argv[1] or after a `--`
  //   - Dev / wrong config: Electron receives the URL in argv[1] instead of the main script path
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
  // Events for the API/plugins: only registers the hook; writes nothing until someone uses the API.
  ApiPlatform.getInstance().startEvents();
  // Plugins: IPC + protocol deplao-plugin://; enabled plugins start after the window is shown.
  registerPluginIpc();
  // UI language: language picker IPC. A change rebuilds the tray menu (its labels are translated).
  registerI18nIpc({ onLanguageChanged: () => { if (tray) tray.setContextMenu(buildTrayMenu()); } });
  if (WEB_MODE) {
    try {
      browserServer = await startBrowserServer({
        password: process.env.DEPLAO_WEB_PASSWORD || '',
        port: Number(process.env.DEPLAO_WEB_PORT || 27800),
        publicOrigin: process.env.DEPLAO_WEB_ORIGIN || '',
        secureCookie: process.env.DEPLAO_WEB_SECURE === '1',
        assets: path.join(__dirname, '../../dist-web'),
        publicApi: (req, res) => ApiPlatform.getInstance().handle(req, res),
        deliveries: () => ApiPlatform.getInstance().operatorDeliveries(),
        retryDelivery: (owner, id) => ApiPlatform.getInstance().retryDelivery(owner, id),
        boot: getBootPayload,
        invoke: async (channel, args) => {
          const handler = ipcHandlerRegistry.get(channel);
          if (!handler) throw new Error(`Không có lệnh ${channel}`);
          return runInUiScope(() => handler({ sender: mainWindow!.webContents, senderFrame: null }, ...args));
        },
        send: (channel, args) => {
          ipcMain.emit(channel, { sender: mainWindow!.webContents }, ...args);
        },
        resolveMedia: file => FileStorageService.resolveAbsolutePath(file),
        mediaRoots: () => [
          FileStorageService.getBaseDir(),
          path.join(path.dirname(FileStorageService.getBaseDir()), 'avatar'),
          path.join(path.dirname(FileStorageService.getBaseDir()), '_uploads'),
          path.join(app.getPath('temp'), 'deplao-clipboard'),
        ],
      });
      console.log(`[web] Mở ${browserServer.url} trong trình duyệt`);
    } catch (error: any) {
      console.error('[web] Không khởi động được:', error.message);
      app.exit(1);
      return;
    }
  }
  if (!CHANNELS_ONLY) try {
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
    // If the renderer does not report that the UI has finished loading (app:uiSettled), start the background work anyway after 60 seconds
    armStartupSettleFallback(60_000);

    reconnectAllFBAccounts().catch(err => {
      console.error('[main] reconnectAllFBAccounts error:', err.message);
    });
    reconnectAllTelegramAccounts().catch(err => {
      console.error('[main] reconnectAllTelegramAccounts error:', err.message);
    });
    // One-time: Telegram messages sent before 26.10.3 carry the machine's clock time → re-sort them by the adjacent message on Telegram (after the app has settled).
    // An employee machine only keeps a copy of Boss's DB → do not modify it.
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
    // Cloudflare (optional, off by default): after the DB + relay have started; does not block startup.
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
  if (!CHANNELS_ONLY) {
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
  // Initialize Integration Registry. integration:payment → trigger.payment is registered automatically by WorkflowEngineService
  // (rehookEvents): adding a hook here would run every payment workflow twice.
  setTimeout(() => IntegrationRegistry.initialize(), 2500);
  }
  // Public API v1: auto-starts the API server if the user turned on "Tự bật khi mở app" (start when the app opens) (off by default).
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

  if (!CHANNELS_ONLY) {
  // Initialize Webhook Gateway (port 9889)
  setTimeout(() => {
    WebhookGatewayService.getInstance().start().then(result => {
      if (result.success) {
        console.log('[main] WebhookGateway started on port ' + result.port);
      }
    });
  }, 3000);

  // Initialize Tracking Service (runs only in the production build)
  setTimeout(() => {
    try {
      TrackingService.getInstance().start();
    } catch (err: any) {
      console.error('[main] TrackingService init error:', err.message);
    }
  }, 5000);

  }
  // ─── Media cleanup scheduler (automatically deletes old media) ─────────────────────
  // Runs every day at 3:00 AM and checks all accounts that have auto-delete configured
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

  // Check for updates: wait for the renderer to be ready first
  if (!isDev && !WEB_MODE) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    // Wait for the renderer to finish loading before checking for updates (avoids a race condition)
    // IPC: the renderer reports it is ready to receive update events
    ipcMain.once('update:renderer-ready', () => {
      console.log('[AutoUpdate] Renderer ready — checking for updates');
      autoUpdater.checkForUpdates();
    });
    // Fallback: if the renderer does not report back after 10s, check on its own
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

  // IPC from the renderer: trigger check for update
  ipcMain.on('update:check', () => {
    if (!isDev) autoUpdater.checkForUpdates();
  });

  // IPC from the renderer: trigger download (user confirmed)
  ipcMain.on('update:download', () => {
    if (!isDev) autoUpdater.downloadUpdate();
  });

  // IPC from the renderer: install and restart
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
  if (WEB_MODE) return;
  if (mainWindow === null) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
});

app.on('before-quit', (event) => {
  // Cloudflare: stop the tunnel / R2 queue / DB sync first (≤ ~3 s), then quit again and run the rest below as before.
  if (deferQuitForCloudShutdown(event)) return;
  isQuitting = true;
  void browserServer?.close();

  // Stop the plugin processes (deactivate ≤ 5 s in the background; the utilityProcess closes by itself when the app quits).
  try {
    const PluginsPlatform = require('../src/services/plugins/PluginsPlatform').default;
    void PluginsPlatform.getInstance().stop();
  } catch {}

  // ── Clean up background services that keep the event loop alive ──────────────────────
  // If they are not cleaned up, CRM timers / cron / the webhook server keep the process alive,
  // the app "quits" but keeps running in the background in Task Manager.
  try {
    // Stop all CRM queue timers
    const crmTimers = CRMQueueService.getInstance() as any;
    if (crmTimers?.timers) {
      for (const [zaloId, timer] of crmTimers.timers) {
        clearInterval(timer);
      }
      crmTimers.timers.clear();
    }
  } catch {}

  try {
    // Stop all workflow cron jobs
    const wfe = WorkflowEngineService.getInstance() as any;
    if (wfe?.cronJobs) {
      for (const [, job] of wfe.cronJobs) {
        try { job.stop(); } catch {}
      }
      wfe.cronJobs.clear();
    }
  } catch {}

  try {
    // Stop the webhook HTTP server
    IntegrationRegistry.stopWebhookServer();
  } catch {}

  try {
    // Stop the webhook gateway
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
// With no handlers → an unhandled error in the main process = a silent hang,
// the app keeps running in the background while the renderer has died → the user sees a blank window / nothing displayed.
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error);
  // Do not crash the app - log it and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});
