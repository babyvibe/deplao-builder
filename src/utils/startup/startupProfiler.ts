/**
 * CPU profile when the app opens: diagnostics when Logs reports "[Hiệu năng] Luồng chính bị chặn" (main thread blocked) or "Giao diện bận" (UI busy) without naming
 * a function (the log only has the time). Runs only when requested, once:
 *  - a flag file `<appData>/Deplao/diagnostics/profile-next-startup` exists (read and deleted right away), or
 *  - the environment variable DEPLAO_PROFILE_STARTUP=1.
 * Writes a CPU sample every 1 ms of the main process (from bootstrap) and of the UI for the first 120 s → `<appData>/Deplao/diagnostics/
 * {main,renderer}-startup-<time>.cpuprofile` + `.meta.json` (a time marker to match Logs). Open it with Chrome DevTools
 * (Performance → Load profile) or analyze it with a script. Keeps the 6 newest profiles.
 *
 * DO NOT call app.getPath() here: startMainStartupProfile runs in bootstrap, and asking for getPath('userData') before the app has the name "Deplao"
 * makes Electron lock the folder "%APPDATA%/Electron" for the whole session → the app opens a new, empty DB and looks like all data was lost (incident of 22/10/2026).
 * The folder is computed from the OS appData = Deplao's userData.
 */
import { app, type WebContents } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as inspector from 'inspector';

/** Logger loaded late: startMainStartupProfile runs in bootstrap, before main.ts is loaded (it also measures the module loading). */
const log = (level: 'log' | 'warn', message: string) => {
  try { require('../Logger').default[level](message); } catch { console[level](message); }
};

const PROFILE_MS = 120_000;
const SAMPLING_US = 1_000;
const KEEP_PROFILES = 6;
const FLAG_FILE = 'profile-next-startup';

let enabled: boolean | null = null;

/** Electron's appData for the OS (does not ask Electron, see the top of the file). */
function appDataDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** = Deplao's `<userData>/diagnostics` (userData = appData/Deplao after app.setName('Deplao')). */
export function diagnosticsDir(): string {
  return path.join(appDataDir(), 'Deplao', 'diagnostics');
}

/** Whether this app launch writes a profile (reads and deletes the flag file exactly once). */
export function startupProfilingEnabled(): boolean {
  if (enabled !== null) return enabled;
  enabled = process.env.DEPLAO_PROFILE_STARTUP === '1';
  try {
    const flag = path.join(diagnosticsDir(), FLAG_FILE);
    if (fs.existsSync(flag)) {
      enabled = true;
      fs.rmSync(flag, { force: true });
    }
  } catch { /* folder cannot be read → treat as not enabled */ }
  return enabled;
}

const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');

function pruneOldProfiles(dir: string): void {
  const profiles = fs.readdirSync(dir)
    .filter(name => name.endsWith('.cpuprofile'))
    .map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of profiles.slice(KEEP_PROFILES)) {
    fs.rmSync(path.join(dir, name), { force: true });
    fs.rmSync(path.join(dir, name.replace(/\.cpuprofile$/, '.meta.json')), { force: true });
  }
}

async function saveProfile(kind: 'main' | 'renderer', profile: unknown, meta: Record<string, unknown>): Promise<void> {
  const dir = diagnosticsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const base = path.join(dir, `${kind}-startup-${stampOf(Number(meta.wallStartMs) || Date.now())}`);
  await fs.promises.writeFile(`${base}.cpuprofile`, JSON.stringify(profile));
  await fs.promises.writeFile(`${base}.meta.json`, JSON.stringify(meta, null, 2));
  log('log', `[Hiệu năng] Đã ghi hồ sơ CPU ${kind === 'main' ? 'main process' : 'giao diện'}: ${base}.cpuprofile`);
  try { pruneOldProfiles(dir); } catch { /* ignore */ }
}

/** Main process: called in electron/bootstrap.ts BEFORE main.ts is loaded; the profile covers the module loading and the wait for app ready. */
export function startMainStartupProfile(): void {
  if (!startupProfilingEnabled()) return;
  let readyAtWallMs: number | null = null;
  app.once('ready', () => { readyAtWallMs = Date.now(); });
  const session = new inspector.Session();
  const post = <T = any>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result as T)));
  });
  void (async () => {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: SAMPLING_US });
    await post('Profiler.start');
    const wallStartMs = Date.now();
    const uptimeAtStartSec = process.uptime();
    log('log', `[Hiệu năng] Đang ghi hồ sơ CPU main process ${PROFILE_MS / 1000} s đầu (diagnostics)`);
    const timer = setTimeout(() => {
      post<{ profile: any }>('Profiler.stop')
        .then(({ profile }) => saveProfile('main', profile, {
          kind: 'main', wallStartMs, uptimeAtStartSec, readyAtWallMs, profileStartTimeUs: profile?.startTime, samplingUs: SAMPLING_US,
        }))
        .catch(err => log('warn', `[Hiệu năng] Không lưu được hồ sơ CPU main: ${err?.message || err}`))
        .finally(() => { try { session.disconnect(); } catch { /* ignore */ } });
    }, PROFILE_MS);
    timer.unref?.();
  })().catch(err => log('warn', `[Hiệu năng] Không ghi được hồ sơ CPU main: ${err?.message || err}`));
}

/** UI: called right after the main window is created; starts recording when the page has loaded for the first time. */
export function startRendererStartupProfile(contents: WebContents): void {
  if (!startupProfilingEnabled()) return;
  contents.once('did-finish-load', () => {
    void (async () => {
      const dbg = contents.debugger;
      dbg.attach('1.3');
      await dbg.sendCommand('Profiler.enable');
      await dbg.sendCommand('Profiler.setSamplingInterval', { interval: SAMPLING_US });
      await dbg.sendCommand('Profiler.start');
      const wallStartMs = Date.now();
      // The "N s sau khi tải giao diện" (N s after the UI loaded) marker in Logs is measured from the page's performance.timeOrigin
      const origin: any = await dbg.sendCommand('Runtime.evaluate', { expression: 'performance.timeOrigin', returnByValue: true })
        .catch(() => null);
      log('log', `[Hiệu năng] Đang ghi hồ sơ CPU giao diện ${PROFILE_MS / 1000} s đầu (diagnostics)`);
      setTimeout(() => {
        if (contents.isDestroyed() || !dbg.isAttached()) return;
        dbg.sendCommand('Profiler.stop')
          .then(({ profile }: any) => saveProfile('renderer', profile, {
            kind: 'renderer', wallStartMs, pageTimeOrigin: origin?.result?.value ?? null,
            profileStartTimeUs: profile?.startTime, samplingUs: SAMPLING_US,
          }))
          .catch(err => log('warn', `[Hiệu năng] Không lưu được hồ sơ CPU giao diện: ${err?.message || err}`))
          .finally(() => { try { dbg.detach(); } catch { /* ignore */ } });
      }, PROFILE_MS);
    })().catch(err => log('warn', `[Hiệu năng] Không ghi được hồ sơ CPU giao diện: ${err?.message || err}`));
  });
}
