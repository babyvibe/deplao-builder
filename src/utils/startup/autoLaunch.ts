/**
 * Tự mở Deplao khi bật máy (đăng nhập hệ điều hành). Nhiều khách khởi động lại máy rồi quên mở app → lỡ tin, trang coi
 * như không dùng. Bật mặc định (cả máy cập nhật từ bản cũ), tắt / đổi ở Cài đặt → Thông báo → Khởi động cùng máy.
 *
 * - Windows / macOS: app.setLoginItemSettings. Windows ghi khoá Run (HKCU) kèm `--autostart`; không đè lựa chọn "Tắt"
 *   của Task Manager khi tự đồng bộ lúc mở app (chỉ khi người dùng bật lại trong Deplao).
 * - Linux: Electron không hỗ trợ → file XDG `~/.config/autostart/deplao.desktop` (AppImage: đường dẫn file .AppImage).
 * - Lựa chọn lưu theo máy (userData/deplao-config.json: autoLaunch, autoLaunchHidden), không theo workspace / DB.
 * - Linux / macOS: mục do Deplao tạo bị gỡ ở hệ điều hành (Ứng dụng khởi động, Mục đăng nhập) → coi như tắt, không tự
 *   tạo lại. Windows luôn tạo lại khi thiếu (đổi thư mục cài làm khoá cũ không còn khớp, không phân biệt được).
 * - Bản dev (chưa đóng gói) không bao giờ đăng ký: sẽ đăng ký electron.exe của node_modules.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Tham số dòng lệnh khi hệ điều hành tự mở Deplao (Windows / Linux). */
export const AUTOSTART_ARG = '--autostart';
const LINUX_DESKTOP_FILE = 'deplao.desktop';

export interface AutoLaunchStatus {
  /** Bản cài đặt trên Windows / macOS / Linux (bản dev: false) */
  supported: boolean;
  /** Lựa chọn của người dùng (mặc định bật) */
  enabled: boolean;
  /** Tự mở thì chạy ngầm ở khay (mặc định bật) */
  hidden: boolean;
  /** Hệ điều hành đang chặn: Task Manager tắt (Windows), chờ cho phép (macOS), tắt trong Ứng dụng khởi động (Linux) */
  blocked: boolean;
  platform: NodeJS.Platform;
}

type FsLike = Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'unlinkSync'>;

export interface AutoLaunchEnv {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** Lệnh mở app: AppImage = file .AppImage (process.execPath nằm trong thư mục mount tạm) */
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
  /** Deplao đã tạo mục tự mở (để biết người dùng gỡ nó ở hệ điều hành) */
  autoLaunchApplied?: boolean;
}

/** Dòng Exec của file .desktop: đường dẫn trong ngoặc kép, thoát " ` $ \ theo chuẩn Desktop Entry. */
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
    'Comment=Tự mở Deplao khi bật máy để không lỡ tin nhắn',
    `Exec=${desktopExecLine(launchPath)}`,
    'Icon=deplao',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Mục tự mở bị tắt trong công cụ của hệ điều hành mà vẫn giữ file (Hidden / X-GNOME-Autostart-enabled=false). */
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
    // Giữ các khoá khác của deplao-config.json (dbFolder…)
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

  /** Mục tự mở đang có ở hệ điều hành (kể cả bị tắt trong công cụ của hệ điều hành) */
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

  /** explicit = người dùng vừa bật trong Deplao: được bật lại cả khi hệ điều hành đang tắt mục này. */
  const register = (explicit: boolean) => {
    if (env.platform === 'linux') {
      const content = readDesktopEntry();
      // Đang bị tắt ở hệ điều hành, không phải người dùng bật lại → giữ nguyên lựa chọn đó
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

    /** Mỗi lần mở app: bật mặc định, giữ đúng đường dẫn, tôn trọng việc người dùng gỡ ở hệ điều hành. */
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

    /** Cài đặt → Khởi động cùng máy. */
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

    /** Hệ điều hành tự mở app (đăng nhập) và người dùng muốn chạy ngầm → không hiện cửa sổ lúc mở. */
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
