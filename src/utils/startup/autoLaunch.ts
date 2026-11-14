/**
 * Launch Deplao automatically when the computer starts (OS login). Many users restart the computer and forget to open the app → they miss messages, and they look
 * like they have stopped using it. On by default (including machines updated from an older version); turn it off / change it in Settings → Notifications → Launch at startup.
 *
 * - Windows / macOS: app.setLoginItemSettings. Windows writes the Run key (HKCU) with `--autostart`; it does not override a "Tắt" (Off) choice made in
 *   Task Manager when syncing at app start (only when the user turns it on again in Deplao).
 * - Linux: Electron does not support it → an XDG file `~/.config/autostart/deplao.desktop` (AppImage: the path of the .AppImage file).
 * - The choice is saved per machine (userData/deplao-config.json: autoLaunch, autoLaunchHidden), not per workspace / DB.
 * - Linux / macOS: an entry created by Deplao that was removed in the OS (Startup Applications, Login Items) → treated as off, not recreated automatically.
 *   Windows always recreates it when missing (a changed install folder makes the old key no longer match, and the two cases cannot be told apart).
 * - Dev builds (not packaged) never register: they would register node_modules' electron.exe.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tr } from '../../shared/i18n';

/** Command-line arguments when the OS launches Deplao automatically (Windows / Linux). */
export const AUTOSTART_ARG = '--autostart';
const LINUX_DESKTOP_FILE = 'deplao.desktop';

export interface AutoLaunchStatus {
  /** Installed build on Windows / macOS / Linux (dev build: false) */
  supported: boolean;
  /** The user's choice (on by default) */
  enabled: boolean;
  /** When launched automatically, run in the background in the tray (on by default) */
  hidden: boolean;
  /** The OS is blocking it: disabled in Task Manager (Windows), waiting for permission (macOS), turned off in Startup Applications (Linux) */
  blocked: boolean;
  platform: NodeJS.Platform;
}

type FsLike = Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'unlinkSync'>;

export interface AutoLaunchEnv {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** Launch command: AppImage = the .AppImage file (process.execPath is inside the temporary mount folder) */
  launchPath: string;
  homeDir: string;
  xdgConfigHome?: string;
  /** app.setLoginItemSettings / app.getLoginItemSettings */
  loginItems: { set(settings: Record<string, unknown>): void; get(options?: Record<string, unknown>): any };
  /** userData/deplao-config.json */
  configPath: string;
  fs?: FsLike;
}

interface StoredChoice {
  autoLaunch?: boolean;
  autoLaunchHidden?: boolean;
  /** Deplao created the auto-launch entry (so it can tell whether the user removed it in the OS) */
  autoLaunchApplied?: boolean;
}

/** Exec line of the .desktop file: the path in double quotes, escaping " ` $ \ per the Desktop Entry standard. */
export function desktopExecLine(launchPath: string): string {
  const escaped = launchPath.replace(/(["`$\\])/g, '\\$1');
  return `"${escaped}" ${AUTOSTART_ARG}`;
}

export function linuxDesktopEntry(launchPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Deplao',
    tr('Comment=Tự mở Deplao khi bật máy để không lỡ tin nhắn'),
    `Exec=${desktopExecLine(launchPath)}`,
    'Icon=deplao',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** An autostart entry that was disabled in the OS tool but still has its file (Hidden / X-GNOME-Autostart-enabled=false). */
function desktopEntryDisabled(content: string): boolean {
  return /^\s*Hidden\s*=\s*true\s*$/mi.test(content) || /^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/mi.test(content);
}

export function createAutoLaunch(env: AutoLaunchEnv) {
  const files = env.fs || fs;
  const supported = env.packaged && ['win32', 'darwin', 'linux'].includes(env.platform);
  const windowsOptions = { path: env.launchPath, args: [AUTOSTART_ARG] };
  const autostartDir = path.join(env.xdgConfigHome || path.join(env.homeDir, '.config'), 'autostart');
  const desktopPath = path.join(autostartDir, LINUX_DESKTOP_FILE);

  const readChoice = (): StoredChoice => {
    try {
      return files.existsSync(env.configPath) ? JSON.parse(String(files.readFileSync(env.configPath, 'utf-8')) || '{}') : {};
    } catch {
      return {};
    }
  };
  const writeChoice = (patch: StoredChoice) => {
    // Keep the other keys of deplao-config.json (dbFolder…)
    let current: Record<string, unknown> = {};
    try {
      if (files.existsSync(env.configPath)) current = JSON.parse(String(files.readFileSync(env.configPath, 'utf-8')) || '{}');
    } catch { current = {}; }
    files.writeFileSync(env.configPath, JSON.stringify({ ...current, ...patch }, null, 2), 'utf-8');
  };
  const choiceOf = (stored: StoredChoice) => ({
    enabled: stored.autoLaunch !== false,
    hidden: stored.autoLaunchHidden !== false,
  });

  const readDesktopEntry = (): string | null => {
    try {
      return files.existsSync(desktopPath) ? String(files.readFileSync(desktopPath, 'utf-8')) : null;
    } catch {
      return null;
    }
  };

  /** An autostart entry that exists in the OS (including one disabled in the OS tool) */
  const registered = (): boolean => {
    if (env.platform === 'linux') return readDesktopEntry() !== null;
    try {
      return !!env.loginItems.get(env.platform === 'win32' ? windowsOptions : undefined)?.openAtLogin;
    } catch {
      return false;
    }
  };

  const blocked = (): boolean => {
    try {
      if (env.platform === 'linux') {
        const content = readDesktopEntry();
        return content !== null && desktopEntryDisabled(content);
      }
      const settings = env.loginItems.get(env.platform === 'win32' ? windowsOptions : undefined);
      if (env.platform === 'win32') return !!settings?.openAtLogin && settings?.executableWillLaunchAtLogin === false;
      return settings?.status === 'requires-approval';
    } catch {
      return false;
    }
  };

  /** explicit = the user just turned it on in Deplao: it is turned on again even if the OS has this entry disabled. */
  const register = (explicit: boolean) => {
    if (env.platform === 'linux') {
      const content = readDesktopEntry();
      // Disabled in the OS, and the user did not just turn it on again → keep that choice
      if (!explicit && content !== null && desktopEntryDisabled(content)) return;
      const next = linuxDesktopEntry(env.launchPath);
      if (content === next) return;
      files.mkdirSync(autostartDir, { recursive: true });
      files.writeFileSync(desktopPath, next, 'utf-8');
      return;
    }
    if (env.platform === 'win32') {
      env.loginItems.set({ openAtLogin: true, ...windowsOptions, ...(explicit ? { enabled: true } : {}) });
      return;
    }
    env.loginItems.set({ openAtLogin: true });
  };

  const unregister = () => {
    if (env.platform === 'linux') {
      try { if (files.existsSync(desktopPath)) files.unlinkSync(desktopPath); } catch {}
      return;
    }
    env.loginItems.set({ openAtLogin: false, ...(env.platform === 'win32' ? windowsOptions : {}) });
  };

  const status = (): AutoLaunchStatus => {
    const choice = choiceOf(readChoice());
    return {
      supported,
      enabled: choice.enabled,
      hidden: choice.hidden,
      blocked: supported && choice.enabled ? blocked() : false,
      platform: env.platform,
    };
  };

  return {
    status,

    /** Every time the app opens: on by default, keeps the correct path, respects the user removing it in the OS. */
    syncAtStartup(): AutoLaunchStatus {
      if (!supported) return status();
      const stored = readChoice();
      const { enabled } = choiceOf(stored);
      const present = registered();
      if (enabled) {
        if (stored.autoLaunchApplied === true && !present && env.platform !== 'win32') {
          writeChoice({ autoLaunch: false, autoLaunchApplied: false });
          return status();
        }
        if (env.platform === 'win32' ? !present : true) register(false);
        if (stored.autoLaunch !== true || stored.autoLaunchApplied !== true) writeChoice({ autoLaunch: true, autoLaunchApplied: true });
      } else if (present) {
        unregister();
      }
      return status();
    },

    /** Settings → Notifications → Launch at startup. */
    update(patch: { enabled?: boolean; hidden?: boolean }): AutoLaunchStatus {
      const next: StoredChoice = {};
      if (typeof patch.hidden === 'boolean') next.autoLaunchHidden = patch.hidden;
      if (typeof patch.enabled === 'boolean') {
        next.autoLaunch = patch.enabled;
        if (supported) {
          if (patch.enabled) register(true);
          else unregister();
          next.autoLaunchApplied = patch.enabled;
        }
      }
      if (Object.keys(next).length) writeChoice(next);
      return status();
    },

    /** The OS auto-opens the app (login) and the user wants it to run in the background → do not show the window on open. */
    startHidden(argv: readonly string[]): boolean {
      if (!supported || !choiceOf(readChoice()).hidden) return false;
      if (argv.includes(AUTOSTART_ARG)) return true;
      if (env.platform !== 'darwin') return false;
      try {
        return !!env.loginItems.get()?.wasOpenedAtLogin;
      } catch {
        return false;
      }
    },
  };
}

export type AutoLaunch = ReturnType<typeof createAutoLaunch>;
