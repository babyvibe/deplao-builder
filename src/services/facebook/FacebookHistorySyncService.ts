/**
 * Đồng bộ tin nhắn Facebook theo khoảng thời gian cho cả tài khoản (popup "Đồng bộ tin nhắn Facebook", giống đồng bộ
 * từ điện thoại của Zalo). Chạy nền trên máy giữ kết nối Facebook, báo tiến độ qua `event:fbHistorySync`:
 *  1. Lấy danh sách hội thoại: trang hộp thư của bridge + danh sách GraphQL theo trang (đi tới hết khoảng thời gian,
 *     trước đây chỉ 50 hội thoại mới nhất).
 *  2. Từng hội thoại có hoạt động trong khoảng (mới nhất trước): tải lịch sử lùi từng trang qua bridge
 *     (FacebookService.syncThreadHistory) tới khi phủ hết khoảng — không giới hạn số tin, mỗi trang lưu ngay.
 *  Hội thoại mã hoá đầu cuối bỏ qua (Facebook không cho thiết bị mới đọc tin cũ). Huỷ được giữa chừng.
 *  Mọi yêu cầu đi theo nhịp người dùng thật (FacebookHumanPacer của tài khoản: nghỉ ngẫu nhiên, nghỉ giải lao, trần
 *  theo phút / giờ, giãn thêm khi Facebook chậm); dấu hiệu bị chặn / phiên hết hạn → dừng hẳn để bảo vệ tài khoản.
 */
import EventBroadcaster from '../event/EventBroadcaster';
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import type { FacebookService } from './FacebookService';
import { isFacebookRiskError, sleepUnlessStopped, type PacerWait } from './FacebookHumanPacer';
import {
  FB_HISTORY_SYNC_EVENT,
  activityMs,
  emptyFbHistorySyncStatus,
  isFbHistorySyncActive,
  threadActiveInRange,
  type FbHistorySyncRange,
  type FbHistorySyncStatus,
} from '../../shared/facebookHistorySync';

interface SyncThread {
  id: string;
  name: string;
  lastActivityMs: number;
  isE2EE: boolean;
}

interface Job {
  status: FbHistorySyncStatus;
  cancelled: boolean;
  /** Facebook có dấu hiệu hạn chế khi lấy danh sách hội thoại → dừng trước khi tải tin. */
  riskError?: string;
}

/** Trang danh sách hội thoại tối đa khi đồng bộ "toàn bộ" (50 hội thoại / trang) — chặn vòng lặp nếu Facebook lặp trang. */
const MAX_THREAD_PAGES = 400;
const LIGHTSPEED_DOWN_MESSAGE = 'Kết nối Messenger thường của bridge (dùng để tải lịch sử, khác kết nối E2EE) không lên được — Facebook không trả lời bước đồng bộ ban đầu. Tin nhắn và E2EE vẫn hoạt động; cần cập nhật bridge để tải lịch sử.';
const EMIT_INTERVAL_MS = 400;
/** Nghỉ ngắn hơn mức này không hiện lên popup (chỉ là nhịp giữa hai trang). */
const SHOW_PAUSE_FROM_MS = 4_000;
/** Chờ socket LightSpeed của bridge kết nối lại (messagix tự thử lại 2 s, 4 s, 8 s…) trước khi báo lỗi. */
const LIGHTSPEED_WAIT_MS = 3 * 60_000;
const LIGHTSPEED_POLL_MS = 10_000;
/** Lỗi cần dừng cả lượt đồng bộ (không hội thoại nào tải tiếp được / phải bảo vệ tài khoản). */
const STOP_CODES = new Set(['BRIDGE_DOWN', 'BRIDGE_OLD', 'RISK', 'COOLDOWN']);

export default class FacebookHistorySyncService {
  private static instance: FacebookHistorySyncService | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly lastEmit = new Map<string, number>();

  static getInstance(): FacebookHistorySyncService {
    if (!this.instance) this.instance = new FacebookHistorySyncService();
    return this.instance;
  }

  getStatus(accountId: string): FbHistorySyncStatus | null {
    return this.jobs.get(accountId)?.status ?? null;
  }

  /**
   * Bắt đầu đồng bộ. `accountId` = facebook_id (khoá phía renderer); `getService` trả phiên Facebook đã kết nối.
   * Đang chạy → trả trạng thái hiện tại.
   */
  start(
    accountId: string,
    range: FbHistorySyncRange,
    getService: () => Promise<FacebookService | null>,
  ): { success: boolean; status: FbHistorySyncStatus; error?: string } {
    const running = this.jobs.get(accountId);
    if (running && isFbHistorySyncActive(running.status)) {
      return { success: false, status: running.status, error: 'Đang đồng bộ tài khoản này' };
    }
    const normalized: FbHistorySyncRange = {
      fromTs: range?.fromTs != null && Number(range.fromTs) > 0 ? Number(range.fromTs) : null,
      toTs: range?.toTs != null && Number(range.toTs) > 0 ? Number(range.toTs) : null,
    };
    const job: Job = {
      cancelled: false,
      status: {
        ...emptyFbHistorySyncStatus(accountId, normalized),
        stage: 'listing',
        message: 'Đang lấy danh sách hội thoại…',
        startedAt: Date.now(),
      },
    };
    this.jobs.set(accountId, job);
    this.emit(job, true);
    void this.run(job, getService).catch(err => {
      this.finish(job, 'failed', err?.message || String(err));
    });
    return { success: true, status: job.status };
  }

  cancel(accountId: string): { success: boolean; status: FbHistorySyncStatus | null } {
    const job = this.jobs.get(accountId);
    if (!job || !isFbHistorySyncActive(job.status)) return { success: false, status: job?.status ?? null };
    job.cancelled = true;
    job.status.message = 'Đang dừng…';
    this.emit(job, true);
    return { success: true, status: job.status };
  }

  private emit(job: Job, force = false): void {
    const now = Date.now();
    const last = this.lastEmit.get(job.status.accountId) || 0;
    if (!force && now - last < EMIT_INTERVAL_MS) return;
    this.lastEmit.set(job.status.accountId, now);
    EventBroadcaster.emit(FB_HISTORY_SYNC_EVENT, { ...job.status });
  }

  /** Đang nghỉ theo nhịp người dùng thật: hiện trên popup khi đủ lâu. */
  private pause(job: Job, wait: PacerWait): void {
    if (wait.ms < SHOW_PAUSE_FROM_MS) return;
    job.status.pausedUntil = Date.now() + wait.ms;
    job.status.pauseReason = wait.reason;
    this.emit(job, true);
  }

  private resume(job: Job): void {
    if (!job.status.pausedUntil) return;
    job.status.pausedUntil = undefined;
    job.status.pauseReason = undefined;
    this.emit(job, true);
  }

  /**
   * Đợi socket LightSpeed (Messenger thường) của bridge sẵn sàng — tải lịch sử cần nó, E2EE thì không. true = sẵn sàng.
   */
  private async waitForLightSpeed(job: Job, service: FacebookService): Promise<boolean> {
    if (typeof service.isBridgeLightSpeedReady !== 'function') return true;
    const deadline = Date.now() + LIGHTSPEED_WAIT_MS;
    let first = true;
    while (!job.cancelled) {
      if (await service.isBridgeLightSpeedReady()) {
        if (!first) this.resume(job);
        return true;
      }
      if (Date.now() >= deadline) return false;
      if (first) {
        job.status.message = 'Đang chờ kết nối Messenger của bridge (Facebook chưa trả lời bước đồng bộ ban đầu)…';
        first = false;
      }
      this.pause(job, { ms: Math.min(LIGHTSPEED_POLL_MS, Math.max(0, deadline - Date.now())), reason: 'bridge' as any });
      if (!(await sleepUnlessStopped(LIGHTSPEED_POLL_MS, () => job.cancelled))) return false;
    }
    return false;
  }

  /** Phiên Facebook còn dùng được: hết hạn / cần xác minh / mất kết nối → lý do dừng. */
  private healthProblem(service: FacebookService): string | null {
    const state = typeof service.getStatus === 'function' ? service.getStatus() : 'connected';
    if (state === 'cookie_expired') return 'Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản';
    if (!service.isConnected()) return 'Tài khoản Facebook mất kết nối — đã dừng đồng bộ';
    return null;
  }

  private finish(job: Job, stage: 'completed' | 'failed' | 'cancelled', error?: string): void {
    const s = job.status;
    s.stage = stage;
    s.finishedAt = Date.now();
    s.currentThreadName = undefined;
    s.pausedUntil = undefined;
    s.pauseReason = undefined;
    if (error) s.error = error;
    const saved = s.messagesSaved.toLocaleString('vi-VN');
    s.message = stage === 'completed'
      ? `Đã đồng bộ ${s.threadsDone.toLocaleString('vi-VN')} hội thoại, ${saved} tin mới`
      : stage === 'cancelled'
        ? `Đã dừng — đã lưu ${saved} tin mới`
        : error || 'Đồng bộ thất bại';
    Logger.log(`[FBHistorySync:${s.accountId}] ${stage}: threads=${s.threadsDone}/${s.threadsTotal} received=${s.messagesReceived} saved=${s.messagesSaved} e2ee=${s.skippedE2EE} failed=${s.failedThreads}${error ? ` error=${error}` : ''}`);
    this.emit(job, true);
  }

  private async run(job: Job, getService: () => Promise<FacebookService | null>): Promise<void> {
    const status = job.status;
    const service = await getService();
    if (!service || !service.isConnected()) {
      this.finish(job, 'failed', 'Tài khoản Facebook chưa kết nối — kết nối lại rồi đồng bộ');
      return;
    }

    // 1. Danh sách hội thoại trong khoảng thời gian
    const threads = await this.listThreads(job, service);
    if (job.cancelled) {
      this.finish(job, 'cancelled');
      return;
    }
    if (job.riskError) {
      this.finish(job, 'failed', 'Facebook có dấu hiệu hạn chế / yêu cầu xác minh — đã dừng đồng bộ để bảo vệ tài khoản');
      return;
    }
    status.threadsTotal = threads.length;
    status.stage = 'syncing';
    status.message = threads.length
      ? `Đang tải tin nhắn ${threads.length.toLocaleString('vi-VN')} hội thoại…`
      : 'Không có hội thoại nào trong khoảng thời gian này';
    this.emit(job, true);

    // 2. Lịch sử từng hội thoại (nghỉ như người mở hội thoại khác giữa hai hội thoại)
    if (threads.length && !(await this.waitForLightSpeed(job, service))) {
      if (job.cancelled) this.finish(job, 'cancelled');
      else this.finish(job, 'failed', LIGHTSPEED_DOWN_MESSAGE);
      return;
    }
    const pacer = service.historyPacing();
    let first = true;
    for (const thread of threads) {
      if (job.cancelled) break;
      const problem = this.healthProblem(service);
      if (problem) {
        this.finish(job, 'failed', problem);
        return;
      }
      if (thread.isE2EE || service.isE2EEThread(thread.id)) {
        status.skippedE2EE += 1;
        status.threadsDone += 1;
        continue;
      }
      if (!first) {
        const wait = pacer.planThreadSwitch();
        this.pause(job, wait);
        if (!(await sleepUnlessStopped(wait.ms, () => job.cancelled))) break;
        this.resume(job);
      }
      first = false;
      status.currentThreadName = thread.name || thread.id;
      this.emit(job, true);
      const syncThread = () => service.syncThreadHistory(thread.id, status.range, {
        shouldStop: () => job.cancelled,
        // Hoạt động mới nhất theo danh sách hội thoại: máy thiếu tin ở đầu hội thoại thì trang đầu lấy qua GraphQL
        latestKnownMs: thread.lastActivityMs,
        onWait: wait => this.pause(job, wait),
        onPage: page => {
          status.messagesSaved += page.saved;
          status.messagesReceived += page.received;
          if (status.pausedUntil) this.resume(job);
          else this.emit(job);
        },
      });
      let result = await syncThread();
      // Socket LightSpeed rớt giữa chừng: đợi nó kết nối lại rồi thử lại hội thoại này một lần
      if (result.code === 'BRIDGE_DOWN' && await this.waitForLightSpeed(job, service)) {
        status.message = `Đang tải tin nhắn ${status.threadsTotal.toLocaleString('vi-VN')} hội thoại…`;
        result = await syncThread();
      }
      this.resume(job);
      Logger.log(`[FBHistorySync:${status.accountId}] thread ${thread.id}: pages=${result.pages} received=${result.received} saved=${result.saved}${result.code ? ` code=${result.code}` : ''}`);
      if (result.code && STOP_CODES.has(result.code)) {
        // Bridge không chạy / có dấu hiệu Facebook hạn chế: dừng cả lượt, báo lý do
        this.finish(job, 'failed', result.error);
        return;
      }
      if (result.code === 'E2EE') status.skippedE2EE += 1;
      else if (result.error) {
        status.failedThreads += 1;
        Logger.warn(`[FBHistorySync:${status.accountId}] thread ${thread.id}: ${result.error}`);
      }
      if (!job.cancelled) status.threadsDone += 1;
    }
    this.finish(job, job.cancelled ? 'cancelled' : 'completed');
  }

  /** Hội thoại có hoạt động trong khoảng, mới nhất trước: bridge + GraphQL theo trang + hội thoại đã có trong máy. */
  private async listThreads(job: Job, service: FacebookService): Promise<SyncThread[]> {
    const status = job.status;
    const range = status.range;
    const byId = new Map<string, SyncThread>();
    const add = (id: unknown, name: unknown, lastActivity: unknown, isE2EE = false) => {
      const key = String(id ?? '').replace(/@.*$/, '');
      if (!/^\d+$/.test(key)) return;
      const ms = activityMs(lastActivity);
      const prev = byId.get(key);
      byId.set(key, {
        id: key,
        name: String(name || prev?.name || ''),
        lastActivityMs: Math.max(ms, prev?.lastActivityMs || 0),
        isE2EE: isE2EE || !!prev?.isE2EE,
      });
    };

    // Trang hộp thư của bridge: có cả hội thoại mã hoá / riêng tư mà GraphQL không trả
    await service.syncBridgeHistory().catch(() => ({ threads: 0, messages: 0 }));

    const db = DatabaseService.getInstance();
    const pacer = service.historyPacing();
    let before: number | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES && !job.cancelled; page += 1) {
      if (page > 0) {
        const wait = pacer.planListPage();
        this.pause(job, wait);
        if (!(await sleepUnlessStopped(wait.ms, () => job.cancelled))) break;
        this.resume(job);
      }
      let result: Awaited<ReturnType<FacebookService['getThreadListPage']>>;
      pacer.recordRequest(false);
      const startedAt = Date.now();
      try {
        result = await service.getThreadListPage(before);
      } catch (err: any) {
        if (pacer.recordResult(false, Date.now() - startedAt, err?.message) === 'risk') job.riskError = err?.message;
        Logger.warn(`[FBHistorySync:${status.accountId}] thread list page ${page}: ${err.message}`);
        break;
      }
      if (result.error) {
        if (pacer.recordResult(false, Date.now() - startedAt, result.error) === 'risk' || isFacebookRiskError(result.error)) {
          job.riskError = result.error;
        }
        Logger.warn(`[FBHistorySync:${status.accountId}] thread list page ${page}: ${result.error}`);
        break;
      }
      pacer.recordResult(true, Date.now() - startedAt);
      if (result.threads.length) {
        try {
          db.saveFBThreads(service.getAccountId(), result.threads.map(({ lastActivityMs: _ms, ...thread }) => thread), { preserveUnread: true });
        } catch (err: any) {
          Logger.warn(`[FBHistorySync:${status.accountId}] saveFBThreads: ${err.message}`);
        }
      }
      for (const thread of result.threads) add(thread.id, thread.name, thread.lastActivityMs);
      status.message = `Đang lấy danh sách hội thoại… (${byId.size.toLocaleString('vi-VN')})`;
      this.emit(job);
      const oldest = result.threads.length ? Math.min(...result.threads.map(t => t.lastActivityMs || Infinity)) : 0;
      if (!result.nextBefore || (range.fromTs != null && oldest > 0 && oldest < range.fromTs)) break;
      before = result.nextBefore;
    }

    // Hội thoại đã biết trong máy (bridge, realtime) — gồm mã hoá đầu cuối
    try {
      const internalId = service.getAccountId();
      const rows = db.query<any>(`SELECT id, name, last_message_at, is_e2ee FROM fb_threads WHERE account_id = ?`, [internalId]);
      for (const row of rows) add(row.id, row.name, row.last_message_at, Number(row.is_e2ee) === 1);
      const owner = status.accountId;
      const contacts = db.query<any>(
        `SELECT contact_id, display_name, last_message_time FROM contacts WHERE owner_zalo_id = ? AND channel = 'facebook'`,
        [owner],
      );
      for (const row of contacts) add(row.contact_id, row.display_name, row.last_message_time);
    } catch (err: any) {
      Logger.warn(`[FBHistorySync:${status.accountId}] local threads: ${err.message}`);
    }

    return [...byId.values()]
      .filter(thread => threadActiveInRange(thread.lastActivityMs, range))
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }
}
