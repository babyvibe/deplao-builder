/**
 * Installing a new build while the old one still runs in the background (the X button only hides Deplao to the tray): when the new build is launched,
 * the single-instance lock hands it to the old build and the new one exits right away, so the user sees "cài lại không chạy" (reinstalled, but it does not start)
 * (Ubuntu: install the new .deb / download a new AppImage; macOS: drag over Deplao.app). The new build sends its version + run path via requestSingleInstanceLock;
 * the old build, seeing a newer one, quits and opens the new build. Same build or an older one: only show the window as before. Windows: the installer closes the app first.
 */
export interface LaunchInfo {
  version: string;
  /** Packaged build (not npm run dev) */
  packaged: boolean;
  /** Path to relaunch: for an AppImage, the .AppImage file itself, not its temporary mount folder */
  execPath: string;
}

/** Compares versions such as 26.10.3 number by number (26.10.10 > 26.10.9). */
export function compareAppVersions(a: string, b: string): number {
  const parts = (value: string) => String(value || '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** If the build just launched is newer than the running one → return where to relaunch; otherwise null (only show the window). */
export function newerInstallToRelaunch(running: LaunchInfo, incoming: unknown): LaunchInfo | null {
  const info = (incoming && typeof incoming === 'object' ? incoming : null) as Partial<LaunchInfo> | null;
  if (!info || typeof info.version !== 'string' || typeof info.execPath !== 'string' || !info.execPath) return null;
  // npm run dev shares the data folder with the installed build: never quit / relaunch because of it
  if (!running.packaged || info.packaged !== true) return null;
  if (compareAppVersions(info.version, running.version) <= 0) return null;
  return { version: info.version, packaged: true, execPath: info.execPath };
}
