/**
 * Syncs Facebook messages over a time range for the whole account (popup "Đồng bộ tin nhắn Facebook", similar to syncing from the Zalo phone
 * app). Runs in the background on the machine that keeps the Facebook connection and reports progress via `event:fbHistorySync`:
 *  1. Get the conversation list: the bridge inbox page + the GraphQL list page by page (keeps going until the whole time range is covered,
 *     previously only the 50 most recent conversations).
 *  2. For each conversation with activity in the range (newest first): load its history backwards page by page through the bridge
 *     (FacebookService.syncThreadHistory) until the whole range is covered; no message limit, each page is saved immediately.
 *  End-to-end encrypted conversations are skipped (Facebook does not let a new device read old messages). Can be cancelled midway.
 *  All requests follow a real user's pace (the account's FacebookHumanPacer: random pauses, break time, per-minute / per-hour caps,
 *  slowing down when Facebook is slow); signs of blocking / an expired session stop everything to protect the account.
 */
import EventBroadcaster from '../../event/EventBroadcaster';
import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';
import type { FacebookService } from '../FacebookService';
import { isFacebookRiskError, sleepUnlessStopped, type PacerWait } from '../send/FacebookHumanPacer';
import {
  FB_HISTORY_SYNC_EVENT,
  activityMs,
  emptyFbHistorySyncStatus,
  isFbHistorySyncActive,
  threadActiveInRange,
  type FbHistorySyncRange,
  type FbHistorySyncStatus,
} from '../../../shared/facebook/facebookHistorySync';
import { tr, appLocale } from '../../../shared/i18n';
import type { MessagesSyncedEvent } from '../../../shared/chat/messagesSynced';

interface SyncThread {
  id: string;
  name: string;
  lastActivityMs: number;
  isE2EE: boolean;
}

interface Job {
  status: FbHistorySyncStatus;
  cancelled: boolean;
  /** Facebook shows signs of restriction when listing conversations → stop before loading messages. */
  riskError?: string;
}

/** Maximum number of conversation-list pages for a sync of "toàn bộ" (all) (50 conversations per page): stops a loop if Facebook keeps returning the same page. */
const MAX_THREAD_PAGES = 400;
const LIGHTSPEED_DOWN_MESSAGE = tr('Kết nối Messenger thường của bridge (dùng để tải lịch sử, khác kết nối E2EE) không lên được — Facebook không trả lời bước đồng bộ ban đầu. Tin nhắn và E2EE vẫn hoạt động; cần cập nhật bridge để tải lịch sử.');
const EMIT_INTERVAL_MS = 400;
/** Pauses shorter than this are not shown in the popup (just the rhythm between two pages). */
const SHOW_PAUSE_FROM_MS = 4_000;
/** Wait for the bridge's LightSpeed socket to reconnect (messagix retries after 2 s, 4 s, 8 s…) before reporting an error. */
const LIGHTSPEED_WAIT_MS = 3 * 60_000;
const LIGHTSPEED_POLL_MS = 10_000;
/** Errors that stop the whole sync run (no conversation can load further / the account must be protected). */
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
   * Start the sync. `accountId` = facebook_id (the key on the renderer side); `getService` returns the connected Facebook session.
   * If already running → returns the current status.
   */
  start(
    accountId: string,
    range: FbHistorySyncRange,
    getService: () => Promise<FacebookService | null>,
  ): { success: boolean; status: FbHistorySyncStatus; error?: string } {
    const running = this.jobs.get(accountId);
    if (running && isFbHistorySyncActive(running.status)) {
      return { success: false, status: running.status, error: tr('Đang đồng bộ tài khoản này') };
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
        message: tr('Đang lấy danh sách hội thoại…'),
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
    job.status.message = tr('Đang dừng…');
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

  /** Pausing at the user's pace: shown in the popup when long enough. */
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
   * Wait for the bridge's LightSpeed socket (regular Messenger) to be ready: loading history needs it, E2EE does not. true = ready.
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
        job.status.message = tr('Đang chờ kết nối Messenger của bridge (Facebook chưa trả lời bước đồng bộ ban đầu)…');
        first = false;
      }
      this.pause(job, { ms: Math.min(LIGHTSPEED_POLL_MS, Math.max(0, deadline - Date.now())), reason: 'bridge' as any });
      if (!(await sleepUnlessStopped(LIGHTSPEED_POLL_MS, () => job.cancelled))) return false;
    }
    return false;
  }

  /** Whether the Facebook session is still usable: expired / needs verification / connection lost → the reason for stopping. */
  private healthProblem(service: FacebookService): string | null {
    const state = typeof service.getStatus === 'function' ? service.getStatus() : 'connected';
    if (state === 'cookie_expired') return tr('Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản');
    if (!service.isConnected()) return tr('Tài khoản Facebook mất kết nối — đã dừng đồng bộ');
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
    const saved = s.messagesSaved.toLocaleString(appLocale());
    s.message = stage === 'completed'
      ? tr('Đã đồng bộ {{v1}} hội thoại, {{saved}} tin mới', { v1: s.threadsDone.toLocaleString(appLocale()), saved })
      : stage === 'cancelled'
        ? tr('Đã dừng — đã lưu {{saved}} tin mới', { saved })
        : error || tr('Đồng bộ thất bại');
    Logger.log(`[FBHistorySync:${s.accountId}] ${stage}: threads=${s.threadsDone}/${s.threadsTotal} received=${s.messagesReceived} saved=${s.messagesSaved} e2ee=${s.skippedE2EE} failed=${s.failedThreads}${error ? ` error=${error}` : ''}`);
    this.emit(job, true);
    // Pages were saved one after another without an event per message: employees reload what they show (also after a stop / an error midway)
    if (s.messagesSaved > 0) {
      EventBroadcaster.emit('event:messagesSynced', { zaloId: s.accountId, source: 'facebook_history', inserted: s.messagesSaved } satisfies MessagesSyncedEvent);
    }
  }

  private async run(job: Job, getService: () => Promise<FacebookService | null>): Promise<void> {
    const status = job.status;
    const service = await getService();
    if (!service || !service.isConnected()) {
      this.finish(job, 'failed', tr('Tài khoản Facebook chưa kết nối — kết nối lại rồi đồng bộ'));
      return;
    }

    // 1. Conversation list within the time range
    const threads = await this.listThreads(job, service);
    if (job.cancelled) {
      this.finish(job, 'cancelled');
      return;
    }
    if (job.riskError) {
      this.finish(job, 'failed', tr('Facebook có dấu hiệu hạn chế / yêu cầu xác minh — đã dừng đồng bộ để bảo vệ tài khoản'));
      return;
    }
    status.threadsTotal = threads.length;
    status.stage = 'syncing';
    status.message = threads.length
      ? tr('Đang tải tin nhắn {{v1}} hội thoại…', { v1: threads.length.toLocaleString(appLocale()) })
      : tr('Không có hội thoại nào trong khoảng thời gian này');
    this.emit(job, true);

    // 2. History of each conversation (pause as if opening another conversation between two conversations)
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
        // The latest activity from the conversation list: if the machine is missing messages at the start of a conversation, the first page is fetched via GraphQL
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
      // The LightSpeed socket dropped midway: wait for it to reconnect, then retry this conversation once
      if (result.code === 'BRIDGE_DOWN' && await this.waitForLightSpeed(job, service)) {
        status.message = tr('Đang tải tin nhắn {{v1}} hội thoại…', { v1: status.threadsTotal.toLocaleString(appLocale()) });
        result = await syncThread();
      }
      this.resume(job);
      Logger.log(`[FBHistorySync:${status.accountId}] thread ${thread.id}: pages=${result.pages} received=${result.received} saved=${result.saved}${result.code ? ` code=${result.code}` : ''}`);
      if (result.code && STOP_CODES.has(result.code)) {
        // The bridge is not running / signs that Facebook is restricting: stop the whole run and report the reason
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

  /** Conversations with activity in the range, newest first: bridge + GraphQL page by page + conversations already on this machine. */
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

    // The bridge inbox page: includes E2EE / private conversations that GraphQL does not return
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
      status.message = tr('Đang lấy danh sách hội thoại… ({{v1}})', { v1: byId.size.toLocaleString(appLocale()) });
      this.emit(job);
      const oldest = result.threads.length ? Math.min(...result.threads.map(t => t.lastActivityMs || Infinity)) : 0;
      if (!result.nextBefore || (range.fromTs != null && oldest > 0 && oldest < range.fromTs)) break;
      before = result.nextBefore;
    }

    // Conversations already known on this machine (bridge, realtime), including end-to-end encrypted ones
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
