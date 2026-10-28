/**
 * Hồ sơ CPU lúc mở app — chẩn đoán khi Nhật ký báo "[Hiệu năng] Luồng chính bị chặn" / "Giao diện bận" mà không chỉ ra
 * được hàm nào (log chỉ có thời gian). Chỉ chạy khi được yêu cầu, một lần:
 *  - có file cờ `<appData>/Deplao/diagnostics/profile-next-startup` (đọc xong xoá ngay), hoặc
 *  - biến môi trường DEPLAO_PROFILE_STARTUP=1.
 * Ghi mẫu CPU mỗi 1 ms của main process (từ bootstrap) và của giao diện trong 120 s đầu → `<appData>/Deplao/diagnostics/
 * {main,renderer}-startup-<giờ>.cpuprofile` + `.meta.json` (mốc giờ để khớp với Nhật ký). Mở bằng Chrome DevTools
 * (Performance → Load profile) hoặc phân tích bằng script. Giữ 6 hồ sơ mới nhất.
 *
 * KHÔNG gọi app.getPath() ở đây: startMainStartupProfile chạy trong bootstrap — hỏi getPath('userData') trước khi app có
 * tên "Deplao" làm Electron chốt thư mục "%APPDATA%/Electron" cho cả phiên → app mở một DB trống mới, tưởng mất hết dữ
 * liệu (sự cố 22/10/2026). Thư mục tự tính từ appData của hệ điều hành = userData của Deplao.
 */
import { app, type WebContents } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as inspector from 'inspector';

/** Logger nạp muộn: startMainStartupProfile chạy trong bootstrap, trước khi nạp main.ts (đo cả lúc nạp module). */
const log = (level: 'log' | 'warn', message: string) => {
  try { require('./Logger').default[level](message); } catch { console[level](message); }
};

const PROFILE_MS = 120_000;
const SAMPLING_US = 1_000;
const KEEP_PROFILES = 6;
const FLAG_FILE = 'profile-next-startup';

let enabled: boolean | null = null;

/** appData của Electron theo hệ điều hành (không hỏi Electron — xem đầu file). */
function appDataDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** = `<userData>/diagnostics` của Deplao (userData = appData/Deplao sau app.setName('Deplao')). */
export function diagnosticsDir(): string {
  return path.join(appDataDir(), 'Deplao', 'diagnostics');
}

/** Lần mở app này có ghi hồ sơ không (đọc + xoá file cờ đúng một lần). */
export function startupProfilingEnabled(): boolean {
  if (enabled !== null) return enabled;
  enabled = process.env.DEPLAO_PROFILE_STARTUP === '1';
  try {
    const flag = path.join(diagnosticsDir(), FLAG_FILE);
    if (fs.existsSync(flag)) {
      enabled = true;
      fs.rmSync(flag, { force: true });
    }
  } catch { /* không đọc được thư mục → coi như không bật */ }
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
  try { pruneOldProfiles(dir); } catch { /* bỏ qua */ }
}

/** Main process: gọi trong electron/bootstrap.ts TRƯỚC khi nạp main.ts — hồ sơ gồm cả lúc nạp module + chờ app ready. */
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
        .finally(() => { try { session.disconnect(); } catch { /* bỏ qua */ } });
    }, PROFILE_MS);
    timer.unref?.();
  })().catch(err => log('warn', `[Hiệu năng] Không ghi được hồ sơ CPU main: ${err?.message || err}`));
}

/** Giao diện: gọi ngay sau khi tạo cửa sổ chính; bắt đầu ghi khi trang tải xong lần đầu. */
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
      // Mốc "N s sau khi tải giao diện" trong Nhật ký tính từ performance.timeOrigin của trang
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
          .finally(() => { try { dbg.detach(); } catch { /* bỏ qua */ } });
      }, PROFILE_MS);
    })().catch(err => log('warn', `[Hiệu năng] Không ghi được hồ sơ CPU giao diện: ${err?.message || err}`));
  });
}
